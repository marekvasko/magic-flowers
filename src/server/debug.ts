// Ladiaca stránka /debug (#64, #74): statické súbory z debug/ a API len na čítanie, prístupné priamo (bez kľúča).
// Nič sa tu nedá zmeniť: čítanie sveta ho nikdy nenačíta do servera, neposúva čas ani neukladá.
// Kľúče hráčov (ich identita, s ňou by sa dalo prihlásiť za hráča) sa nikdy neukážu.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AreaId } from '../shared/data.ts';
import type { Icehouse, PlayerKey, SavedTile, Weather } from '../shared/save.ts';
import { isRecord } from '../shared/util.ts';
import * as E from './engine.ts';
import type { BatchOut, EngineEvent, JournalEntry, PeriodicDef } from './engine.ts';
import * as Econ from './economy.ts';
import type { GameSpec, GameWorld, Msg } from './game.ts';
import type { Presence } from './world.ts';

export const ROOM_RE = /^[a-z0-9-]{1,16}$/; // rovnaké mená svetov ako pri pripojení hráča
const MIME: Readonly<Partial<Record<string, string>>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
// Kľúč hráča (jeho identita v ukladaní) sa nikdy neukáže – nahradí ho krátky odtlačok
export const keyId = (k: string): string => 'p-' + sha('mf-player:' + k).slice(0, 8);

// Kľúče hráčov v hodnote nahradí odtlačkom (vráti kópiu): celé reťazce aj kľúče vnútri iných reťazcov ('save:<k>',
// 'event:scavDone:<k>', chybové hlásenie návrhu…) a mená vlastností (zmeny v 'save:*', uloženia). Kľúč hráča je meno
// malými písmenami, preto sa nahrádza len ako celé slovo: na začiatku alebo za ':', medzerou či úvodzovkou.
// Hodnota je ľubovoľný JSON (odpoveď ladiacej stránky) – prechádza sa bez znalosti tvaru.
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function redactor(keys: Iterable<unknown>): (v: unknown) => unknown {
  const list = [...keys].filter((k): k is string => typeof k === 'string' && !!k).sort((a, b) => b.length - a.length);
  if (!list.length) return v => v;
  const re = new RegExp('(^|[:\\s"\'(])(' + list.map(reEsc).join('|') + ')(?=$|[:\\s"\',.;!?)])', 'g');
  const str = (x: string): string => x.replace(re, (m, pre: string, k: string) => pre + keyId(k));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return str(v);
    if (!isRecord(v)) return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: { [key: string]: unknown } = {};
    for (const k in v) out[str(k)] = walk(v[k]);
    return out;
  };
  return walk;
}

// ---- Kruhová pamäť dávok pre záložku Engine (#106) ----
// Svet v pamäti si drží posledných `max` záznamov: každá vykonaná dávka (entry z denníka + čo k nej denník nemá:
// správy a operácie s frontou každého návrhu, časy častí, rozhodnutia filtra správ hráčov, kto dávku spustil)
// a rámce, v ktorých filter niečo rozhodol, no do enginu nič nešlo. Nikdy sa neukladá a nemení svet.
// origins: seq udalosti → kto ju naplánoval (návrh, krok, kolo) – pre frontu; drží sa len pre udalosti, čo ešte čakajú.
// Rozhodnutie filtra správ hráčov (server.ts): poradie správy, hráč, typ správy, čo sa s ňou stalo a podľa akého pravidla
export interface FilterDecision { seq: number | null; actor: PlayerKey | null; t: string; what: string; rule: string; id?: string | number | undefined; into?: number }
// Časy častí dávky a rámca v ms (engine: schedule, evaluate, resolve, commit; server: filter, journal, notify)
export type TraceTiming = Partial<Record<string, number>>;
export interface TraceOp { op: 'cancel' | 'insert'; key?: string | undefined; seq?: number | undefined; at?: number; type?: string }
export interface TraceRecord {
  n?: number;
  tick: number;
  source: string;
  entry: JournalEntry<Presence, Msg> | null;
  results: Partial<Record<string, { outbox: Msg[]; ops: TraceOp[] }>>;
  filter: FilterDecision[] | null;
  timing: TraceTiming | null;
}
export interface TraceOrigin { by: string; type: string; tick: number; step: number; round: number }
export interface TraceRing { max: number; n: number; buf: TraceRecord[]; origins: Map<number, TraceOrigin> }
const ORIGINS_MAX = 20000;
export function traceRing(max: number): TraceRing { return { max: Math.max(1, max | 0), n: 0, buf: [], origins: new Map() }; }
export function tracePush(ring: TraceRing, rec: TraceRecord): TraceRecord {
  rec.n = ++ring.n;
  ring.buf[(rec.n - 1) % ring.max] = rec; // O(1): najstarší záznam sa prepíše
  return rec;
}
// Záznamy od najstaršieho po najnovší
export function traceList(ring: TraceRing | null | undefined): TraceRecord[] {
  if (!ring) return [];
  const b = ring.buf, n = ring.n, len = b.length;
  return n <= ring.max ? b.slice() : b.slice(n % ring.max).concat(b.slice(0, n % ring.max)).slice(0, len);
}
// Zaznamená dávku z commitBatch (out). meta: { source, filter, timing, tick }. Výsledky návrhov (kópie výrezov) sa
// nedržia – len ich správy a operácie s frontou; entry je ten istý objekt, ktorý ide do denníka (nekopíruje sa).
export function traceBatch(ring: TraceRing, out: BatchOut<Presence, Msg>, meta: { source?: string; filter?: FilterDecision[] | null | undefined; timing?: TraceTiming | null }): TraceRecord {
  const results: TraceRecord['results'] = {};
  for (const r of out.applied.concat(out.rejected)) {
    const ops = r.ops.map((o): TraceOp => o.op === 'cancel' ? { op: 'cancel', key: o.key } : { op: 'insert', seq: o.seq, at: o.ev.at, type: o.ev.type, key: o.ev.key });
    if (r.outbox.length || ops.length) results[r.id] = { outbox: r.reject === undefined ? r.outbox : [], ops: r.reject === undefined ? ops : [] };
  }
  const entry = out.entry;
  for (const p of entry.proposals) {
    const res = results[p.id];
    if (p.outcome !== 'applied' || !res) continue;
    for (const o of res.ops) if (o.op === 'insert' && o.seq != null) ring.origins.set(o.seq, { by: p.id, type: p.type, tick: entry.tick, step: entry.step + p.round - 1, round: p.round });
  }
  for (let first = ring.origins.keys().next(); ring.origins.size > ORIGINS_MAX && !first.done; first = ring.origins.keys().next()) ring.origins.delete(first.value);
  return tracePush(ring, { tick: entry.tick, source: meta.source || 'live', entry, results, filter: meta.filter || null, timing: meta.timing || out.timing || null });
}
// Rámec bez dávky: filter správ niečo rozhodol (zlúčil, odložil, zahodil…), ale do enginu nič nešlo
export function traceFilter(ring: TraceRing, tick: number, filter: FilterDecision[], timing?: TraceTiming | null): TraceRecord {
  return tracePush(ring, { tick, source: 'frame', entry: null, results: {}, filter, timing: timing || null });
}

// Svet v pamäti, ako ho vidí ladiaca stránka: hráči, krok, kruhová pamäť, uloženia
export interface DebugRoom {
  players: Map<number, { name: string; area: AreaId; key: PlayerKey }>;
  tick: number;
  trace?: TraceRing | null;
  saves?: GameWorld['saves'];
}
// Stav sveta ako JSON (serialize alebo prečítaný a prevedený súbor): uložené polia, nič navyše nepredpokladá
export interface DebugState {
  tick: number;
  events?: EngineEvent[];
  saves?: GameWorld['saves'];
  market?: GameWorld['market'];
  contracts?: GameWorld['contracts'];
  seed?: string;
  scavSalt?: number;
  weather?: Weather;
  // políčka a plochy, ako sú v uložení (záhrada len pôda, hory a Les divov zakódované)
  tiles?: SavedTile[] | null;
  hory?: unknown;
  les?: unknown;
  pomedzieSeed?: number;
  lesSeed?: number;
  icehouse?: Icehouse | null;
  [key: string]: unknown;
}
export interface Loaded { id: string; source: 'memory' | 'file'; file: { size: number; saved: number } | null; online: { name: string; area: AreaId; player: string }[]; state: DebugState }
// Nástroje pre rozšírenia API (src/server/debug-api/<meno>.ts)
export interface Tools {
  ROOM_RE: RegExp;
  rooms: () => RoomInfo[];
  sim: DebugSim | null | undefined;
  load: (id: unknown) => Loaded | null;
  trace: (id: unknown) => { max: number; n: number; records: TraceRecord[]; origins: Map<number, TraceOrigin> } | null;
  journalFiles: (id: unknown) => { path: string; name: string }[];
  redactKeys: (list: unknown[] | null | undefined) => void;
}
// Rozšírenie API: (query, tools) → objekt na odpoveď (null = 404)
export type DebugApi = (query: URLSearchParams, tools: Tools) => unknown;
// Zo špecifikácie simulácie stačia návrhy a periodické udalosti (stav reconcilera); server ju má nad svojím typom sveta
export type DebugSim = Pick<GameSpec, 'proposers' | 'periodic'>;
// Stav reconcilera pre záložku Room: periodické udalosti (naplánovaná / chýba a kedy by bola) a čo by zahodil
export interface ReconcilerView {
  declared: number; proposers: number; counts: { periodic: number; unique: number; plain: number };
  periodic: { key: string; type: string; status: 'scheduled' | 'missing'; at: number | null }[];
  drop: { key: string | null; type: string; at: number; why: string }[];
}
// Odpoveď /api/debug/room?id=… (kľúče hráčov nahradené odtlačkom, bez tajomstiev sveta)
export type RoomSnapshot = Loaded & { reconciler: ReconcilerView | null };
export interface RoomInfo { id: string; size: number | null; saved: number | null; loaded: boolean; online: Loaded['online']; tick?: number }
// ctx: { dataDir, debugDir (stránka: index.html, debug.css), buildDir (zbalené skripty stránky, hľadajú sa najprv tam), rooms (Map id → svet v pamäti), serialize(room) → JSON, migrate(stav) → stav,
//        sim() → špecifikácia simulácie { proposers, periodic } pre stav reconcilera, apis: meno → rozšírenie API }
export interface DebugCtx<R extends DebugRoom> {
  dataDir: string;
  debugDir: string;
  buildDir?: string;
  rooms: Map<string, R>;
  serialize: (room: R) => string;
  migrate: (state: DebugState) => DebugState;
  sim?: () => DebugSim | null | undefined;
  apis?: Readonly<Partial<Record<string, DebugApi>>>;
}

// Vráti handle(req, res) → true, ak požiadavku vybavil (inak ju server spracuje ako obyčajný súbor).
export function create<R extends DebugRoom>(ctx: DebugCtx<R>): (req: Pick<IncomingMessage, 'url' | 'method'>, res: Pick<ServerResponse, 'writeHead' | 'end'>) => boolean {
  type Res = Pick<ServerResponse, 'writeHead' | 'end'>;
  const notFound = (res: Res): true => { res.writeHead(404); res.end('Not found'); return true; };
  const json = (res: Res, code: number, obj: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(JSON.stringify(obj));
    return true;
  };
  const roomFile = (id: string): string => path.join(ctx.dataDir, 'room-' + id + '.json');
  const online = (room: DebugRoom): Loaded['online'] => [...room.players.values()].map(p => ({ name: p.name, area: p.area, player: keyId(p.key) }));

  function listRooms(): RoomInfo[] {
    const out = new Map<string, RoomInfo>();
    let files: string[] = [];
    try { files = fs.readdirSync(ctx.dataDir); } catch { /* zatiaľ žiadne uložené svety */ }
    for (const f of files) {
      const m = /^room-([a-z0-9-]{1,16})\.json$/.exec(f), id = m ? m[1] : undefined;
      if (!id) continue;
      try { const st = fs.statSync(path.join(ctx.dataDir, f)); out.set(id, { id, size: st.size, saved: st.mtimeMs, loaded: false, online: [] }); } catch { /* zmazaný medzitým */ }
    }
    for (const [id, room] of ctx.rooms) {
      const e = out.get(id) || { id, size: null, saved: null, loaded: false, online: [] };
      Object.assign(e, { loaded: true, online: online(room), tick: room.tick });
      out.set(id, e);
    }
    return [...out.values()].sort((a, b) => b.online.length - a.online.length || (b.saved || 0) - (a.saved || 0) || a.id.localeCompare(b.id));
  }

  // Stav reconcilera (engine.js): čo je naplánované, čo chýba a čo by zahodil – len plán, svet sa nemení.
  // Kedy by sa chýbajúca udalosť naplánovala, sa počíta na kópii (next môže ťahať náhodu zo sveta).
  // Stav zo súboru je svet v tvare uloženia: periodické udalosti z neho čítajú len uložené polia (pavučiny) – preto ho
  // reconciler a plán dostanú ako svet hry (jediné pretypovanie; tvar sveta sa tu nemení ani nekontroluje).
  const asWorld = (state: DebugState): GameWorld => state as unknown as GameWorld;
  const WHY: Readonly<Partial<Record<string, string>>> = { 'neznámy typ': 'unknown type (no proposer)', 'nedeklarovaná periodická': 'periodic, no longer declared', 'duplicita': 'duplicate' };
  function reconcilerView(state: DebugState): ReconcilerView | null {
    const sim = ctx.sim && ctx.sim();
    if (!sim) return null;
    const plan = E.reconcilePlan(asWorld({ tick: state.tick, events: state.events || [] }), sim);
    const wouldAt = (def: PeriodicDef<GameWorld>): number | null => { try { return E.planAt(asWorld({ ...state }), def, state.tick + 1); } catch { return null; } };
    const evs = state.events || [];
    const periodic: ReconcilerView['periodic'] = [...plan.ok.map(o => ({ key: o.def.key, type: o.def.type, status: 'scheduled' as const, at: o.ev.at })),
      ...plan.missing.map(d => ({ key: d.key, type: d.type, status: 'missing' as const, at: wouldAt(d) }))];
    return {
      declared: (sim.periodic || []).length, proposers: Object.keys(sim.proposers || {}).length,
      counts: { periodic: evs.filter(e => e.periodic).length, unique: evs.filter(e => e.key != null && !e.periodic).length, plain: evs.filter(e => e.key == null).length },
      periodic: periodic.sort((a, b) => Number(a.at == null) - Number(b.at == null) || (a.at ?? 0) - (b.at ?? 0)),
      drop: plan.drop.map(d => ({ key: d.ev.key || null, type: d.ev.type, at: d.ev.at, why: WHY[d.why] || d.why }))
    };
  }

  // Kópia stavu sveta: z pamäte, ak je načítaný (rovnaký serialize ako pri ukladaní); inak len prečítaný súbor
  // (migrate na kópii). Svet v serveri sa nikdy nedostane von – rozšírenia dostanú len túto kópiu.
  // Tajomstvá sveta (semienko náhody, soľ divých semienok) von nejdú – z nich by sa dali predvídať výsledky.
  // Odstraňujú sa až pred odpoveďou: reconcilerView potrebuje semienko, aby ukázal ten istý čas, aký naplánuje engine.
  function secretless<T extends { state: DebugState } | null>(r: T): T { if (r) { delete r.state.seed; delete r.state.scavSalt; } return r; }
  function loadState(id: string): Loaded | null {
    if (!ROOM_RE.test(id)) return null;
    const room = ctx.rooms.get(id);
    if (room) return { id, source: 'memory', file: null, online: online(room), state: parseState(ctx.serialize(room)) };
    let text;
    try { text = fs.readFileSync(roomFile(id), 'utf8'); } catch { return null; }
    // Poškodený súbor (zlý JSON, nie objekt, migrate zlyhá) je chyba len tejto požiadavky – nikdy nie pád servera (#134).
    // Hra s ním zaobchádza po svojom; /debug ho len ohlási ako „corrupt save“ (podrobnosti sú v príčine, v logu).
    try {
      const st = fs.statSync(roomFile(id));
      const state = ctx.migrate(parseState(text));
      if (state.market) Econ.syncFestival(state.market); // ako pri načítaní na serveri: sviatočné násobky v položkách kvetov
      return { id, source: 'file', file: { size: st.size, saved: st.mtimeMs }, online: [], state };
    } catch (e) { throw new Error('corrupt save', { cause: e }); }
  }
  // Uložený svet (JSON zapísaný serverom): objekt s krokom; tvar ďalších polí sa tu neoveruje
  function parseState(text: string): DebugState {
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) throw new Error('uložený svet nie je objekt');
    return v as DebugState;
  }
  // Kľúče hráčov (z načítaných svetov) nahradí v celej odpovedi odtlačkom
  function redact(obj: unknown, keys: Iterable<unknown>): unknown { return redactor(keys)(JSON.parse(JSON.stringify(obj))); }
  function roomSnapshot(id: string): unknown {
    const r = loadState(id);
    if (!r) return null;
    return redact(secretless(Object.assign({}, r, { reconciler: reconcilerView(r.state) })), Object.keys(r.state.saves || {}));
  }

  // Rozšírenia API pre záložky: ctx.apis[name] (src/server/debug-api/<name>.ts) je (query, tools) → objekt na odpoveď (null = 404).
  //   tools.load(id) → { id, source, file, online, state } kópia sveta (alebo null), tools.rooms() → zoznam svetov,
  //   tools.sim → špecifikácia simulácie, tools.trace(id) → { max, n, records, origins } kruhová pamäť dávok sveta
  //   v pamäti (alebo null), tools.journalFiles(id) → [{ path, name }] denník sveta na disku (najprv starší .1),
  //   tools.redactKeys(zoznam) → ďalšie kľúče hráčov na odstránenie (napr. z denníka). Kľúče hráčov z načítaných svetov
  //   sa z odpovede odstránia samy.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- id prichádza z adresy (reťazec) alebo od rozšírenia; String() ako doteraz
  const idOf = (id: unknown): string => String(id || '');
  function extension(res: Res, name: string, query: URLSearchParams): boolean {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return notFound(res);
    const api = ctx.apis && Object.hasOwn(ctx.apis, name) ? ctx.apis[name] : undefined; // len vlastné mená tabuľky (nie toString…)
    if (!api) return notFound(res);
    const keys = new Set<string>();
    const tools: Tools = {
      ROOM_RE, rooms: listRooms, sim: ctx.sim && ctx.sim(),
      load: id => { const r = loadState(idOf(id)); if (r) for (const k of Object.keys(r.state.saves || {})) keys.add(k); return secretless(r); },
      trace: id => {
        const room = ctx.rooms.get(idOf(id));
        if (!room || !room.trace) return null;
        for (const k of Object.keys(room.saves || {})) keys.add(k);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- svety v testoch hráčov nemajú
        for (const p of room.players ? room.players.values() : []) if (p.key) keys.add(p.key);
        return { max: room.trace.max, n: room.trace.n, records: traceList(room.trace), origins: room.trace.origins };
      },
      journalFiles: id => {
        if (!ROOM_RE.test(idOf(id))) return [];
        const base = path.join(ctx.dataDir, 'journal-' + idOf(id) + '.jsonl');
        return [base + '.1', base].filter(f => fs.existsSync(f)).map(f => ({ path: f, name: path.basename(f) }));
      },
      redactKeys: list => { for (const k of list || []) if (typeof k === 'string' && k) keys.add(k); }
    };
    let body: unknown;
    try { body = api(query, tools); } catch (e) { console.error('[debug]', name, e); return json(res, 500, { error: e instanceof Error ? e.message : undefined }); }
    return body == null ? json(res, 404, { error: 'not found' }) : json(res, 200, redact(body, keys));
  }

  function serveFile(res: Res, rel: string): boolean {
    // zbalené skripty (build/debug/, npm run build) majú prednosť pred statickými súbormi stránky (debug/)
    const inDir = (dir: string): string | null => { const f = path.normalize(path.join(dir, rel)); return f.startsWith(dir + path.sep) ? f : null; };
    const built = ctx.buildDir ? inDir(ctx.buildDir) : null, file = built && fs.existsSync(built) ? built : inDir(ctx.debugDir);
    if (!file) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) { notFound(res); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
      res.end(buf);
    });
    return true;
  }

  // Chyba v ladiacej požiadavke odpovie 500 – nikdy nevyletí do HTTP servera (to by zhodilo celý proces so všetkými svetmi)
  return function handle(req, res) {
    const reqUrl = req.url || '/', q = reqUrl.indexOf('?');
    const url = (q >= 0 ? reqUrl.slice(0, q) : reqUrl) || '/';
    if (url !== '/debug' && !url.startsWith('/debug/') && !url.startsWith('/api/debug/')) return false;
    try { return route(req, res, url, new URLSearchParams(q >= 0 ? reqUrl.slice(q + 1) : '')); } catch (e) { console.error('[debug]', reqUrl, e); return json(res, 500, { error: 'internal error' }); }
  };
  function route(req: Pick<IncomingMessage, 'method'>, res: Res, url: string, query: URLSearchParams): boolean {
    if (req.method !== 'GET') return notFound(res); // len na čítanie
    if (url === '/api/debug/rooms') return json(res, 200, { rooms: listRooms(), now: Date.now() });
    if (url === '/api/debug/room') {
      const id = query.get('id') || '';
      if (!ROOM_RE.test(id)) return json(res, 400, { error: 'bad room id' });
      let snap;
      try { snap = roomSnapshot(id); } catch (e) { console.error('[debug] room', id, e); return json(res, 500, { error: e instanceof Error ? e.message : undefined }); }
      return snap ? json(res, 200, snap) : json(res, 404, { error: 'no such room' });
    }
    if (url.startsWith('/api/debug/')) return extension(res, url.slice(11), query);
    if (url === '/debug' || url === '/debug/') return serveFile(res, 'index.html');
    let rel;
    try { rel = decodeURIComponent(url.slice(7)); } catch { return notFound(res); }
    return serveFile(res, rel);
  }
}
