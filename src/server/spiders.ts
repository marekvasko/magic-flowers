// Pavúky a pavučiny (#57) na engine v2 (docs/engine.md): Les divov (vlčiaky, stará pradlena a ich pavučiny s hodvábom)
// a kútové pavučiny krížiaka v záhrade a v horách. Nič tu nemení svet priamo – všetko sú návrhy nad výrezmi.
//
// Stav sveta (obyčajný JSON):
//   world.webs    = { list: [{ id, x, y, ax, n, silk, o }], nid, pend: { [o]: [krok, …] } }   (ukladá sa)
//                   pavučina zaberá n políčok od (x, y): ax 0 = vodorovne, ax 1 = zvisle; o = majiteľ (index pavúka);
//                   pend = kedy majiteľ znova utká roztrhnutú pavučinu (udalosť weave:<o> na najbližší termín)
//   world.corners = { garden: [kľúč kúta], hory: […] }                                           (ukladá sa)
//   world.sps     = { s0: { … }, … }  pavúky v lese; world.kz = { garden, hory }  krížiak na ceste do kúta
//                   (neukladajú sa – po načítaní sú pavúky doma a spia, Spiders.load)
// Výrezy: 'webs', 'corners' (vlastnosti sveta), 'spider:<id>' / 'spider:*' a 'kz:<plocha>' (Spiders.slice).
//
// Plánovanie: každý pavúk má vlastnú periodickú udalosť 'spider:<id>' a krížiak 'kz:<plocha>'. Plánuje ich len engine
// (reconcile) podľa stavu pavúka: s.next = krok, keď chce znova konať (hýbe sa → ďalší krok; nečinný → svoj termín, najviac
// o WATCH_MS, aby si všimol hráča; nikto v lese → spí, kontrola raz za deň). Kto stav pavúka zmení zvonka (vbehnutie do
// pavučiny, ťahanie hodvábu, príchod hráča do lesa), nastaví mu next a zruší jeho udalosť – reconcile ju hneď naplánuje znova.
// Hráčov (kde stoja, lampáš, kam idú, ťahanie hodvábu) vidia návrhy len cez ctx.presence; náhoda len ctx.rng.
// Rýchlosti sú v políčkach za sekundu reálneho času, časy v D.SPIDERS / D.WEB v ms – na kroky ich prepočíta daySeconds.
import * as D from '../shared/data.ts';
import type { AreaId, Ground } from '../shared/data.ts';
import type { CornerView, ServerMessage, SpiderView, ToastKind, WebView } from '../shared/protocol.ts';
import type { CornerArea, PlayerKey, PlayerSave, Web, Webs as WebState } from '../shared/save.ts';
import { entries, isRecord, must } from '../shared/util.ts';
import Webs from '../shared/webs.ts';
import type { Analysis, CornerSpot, Home } from '../shared/webs.ts';
import * as E from './engine.ts';
import type { Keys, Slice } from './engine.ts';
import { maybe, put, savesOf, sl } from './game.ts';
import type { GameCtx, GamePeriodic, GameProposer, GameSlices, GameWorld, Kriziak, Mover, Msg, SpiderState, To, TreeSpot } from './game.ts';
import * as I from './items.ts';
import { areaTiles, clampPos } from './areas.ts';
import type { AreaTilesWorld, Presence, Rng, Tile } from './world.ts';

export const analyze = Webs.analyze, cornerSpots = Webs.cornerSpots;
const { bfs } = Webs;

const SP = D.SPIDERS, WEB = D.WEB, V = SP.vlciak, PR = SP.pradlena, KZ = SP.kriziak;
const LW = D.LES_W, LH = D.LES_H, TPD = D.TICKS_PER_DAY;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
export const IDS: readonly string[] = Array.from({ length: SP.vlciak.n + 1 }, (_, i) => `s${i}`); // 6 vlčiakov a pradlena
const IDLE_MS = 3000; // nečinný pavúk bez vlastného termínu sa rozhliadne najneskôr takto (hráča inak ohlási pohyb, posKeys)
export const STEP_MS = 200; // hýbuci sa pavúk koná ~5× za sekundu reálneho času (klient polohu plynulo dopočíta)
const KZ_STEP_MS = 100; // krížiak je rýchly – koná ~10× za sekundu
const WAKE_R = Math.max(D.SPIDERS.vlciak.sense, D.SPIDERS.lamp + 0.5) + 0.5; // hráč takto blízko zobudí nečinného pavúka
const ACTIVE_R = 16; // pavúk ďalej od všetkých hráčov (v tme ho nikto nevidí) je doma a spí – žije len les okolo hráčov
const PULL_MOVE = 0.35; // o koľko sa ťahajúci hráč smie pohnúť
const CLIMB: Readonly<Partial<Record<Ground, 1>>> = { tree: 1, giant: 1, trunk: 1 };
const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const season = (tick: number): D.Season => D.seasonOf(D.dayOfTick(tick));
export const tickSec = (ds: number): number => ds / TPD;
export const ticksOf = (ms: number, ds: number): number => Math.max(1, Math.round(ms / 1000 / tickSec(ds)));
const isCornerArea = (a: string): a is CornerArea => (D.CORNER_AREAS as readonly string[]).includes(a);
// Prepočet ms reálneho času na kroky (podľa dĺžky dňa sveta)
type Ticks = (ms: number) => number;
// Kontext pavúka: návrh si k nemu pripne pavučiny sveta (výrez webs), aby ich nemusel podávať každej funkcii
type SpiderCtx = GameCtx & { webs: WebState };
type Where = { x: number; y: number };

// ---------- Rozbor lesa (nory, územia, miesta na pavučiny, priechodnosť, miesta na kmeňoch) ----------
// Čistá funkcia rozloženia Lesa divov. Počíta sa pri keys() nad živým svetom (len číta) a pamätá podľa semienka lesa;
// návrh si ho v run vezme cez výrez 'lesSeed' (kópie výrezov by vyrovnávaciu pamäť podľa identity poľa minuli).
export type Forest = Analysis & { pass: number[]; les: Tile[]; spots: Record<string, TreeSpot | null> };
const forests = new Map<number, { les: Tile[]; f: Forest }>(); // lesSeed → { les (pole políčok), f }
export function forestOf(world: Pick<GameWorld, 'lesSeed' | 'les'>): Forest {
  const c = forests.get(world.lesSeed);
  if (c && c.les === world.les) return c.f;
  const f: Forest = Object.assign(analyze(world.les, world.lesSeed >>> 0), { pass: world.les.map(t => (D.BLOCK[t.g] ? 0 : 1)), les: world.les, spots: {} });
  forests.set(world.lesSeed, { les: world.les, f });
  return f;
}
function forestBy(seed: number): Forest {
  const c = forests.get(seed);
  if (!c) throw new Error('rozbor lesa chýba (keys ho nepripravil)');
  return c.f;
}
export function webTiles(wb: Pick<Web, 'x' | 'y' | 'ax' | 'n'>): number[] { const out: number[] = []; for (let k = 0; k < wb.n; k++) out.push((wb.y + (wb.ax ? k : 0)) * LW + wb.x + (wb.ax ? 0 : k)); return out; }
export function webAt(webs: WebState | null | undefined, i: number): Web | null { for (const wb of (webs && webs.list) || []) if (webTiles(wb).includes(i)) return wb; return null; }
const kindOf = (f: Forest, o: number): Home['k'] | null => { const h = f.homes[o]; return h ? h.k : null; };
const target = (f: Forest, o: number, tick: number): number => { const k = kindOf(f, o); return k ? must(WEB.count[k === 'p' ? 'pradlena' : 'vlciak'][season(tick)]) : 0; };
const nameOf = (f: Forest, o: number): string => (kindOf(f, o) === 'p' ? 'Stará pradlena' : 'Vlčiak');

// ---------- Výrezy ----------
// 'spider:<id>' jeden pavúk, 'spider:*' všetky (príchod hráča do lesa ich budí), 'kz:<plocha>' krížiak na ceste.
// Ostatné kľúče rieši predvolené E.sliceOf (webs, corners sú obyčajné vlastnosti sveta).
function at(parent: unknown, prop: string): Slice | null { return isRecord(parent) ? { get: () => parent[prop], set: (v, ch) => { E.sync(parent, prop, v, [], ch); } } : null; }
export function slice(world: GameWorld, key: string): Slice | null | undefined {
  if (key === 'spider:*') return at(world, 'sps');
  if (key.startsWith('spider:')) return at(world.sps, key.slice(7));
  if (key.startsWith('kz:')) return at(world.kz, key.slice(3));
  return undefined;
}

// ---------- Pavučiny ----------
// Utká novú pavučinu na náhodnom voľnom mieste v území majiteľa (nie cez inú pavučinu ani cez hráča).
function weave(webs: WebState, f: Forest, o: number, ctx: GameCtx): Web | null {
  const used = new Set<number>(), occ = new Set<number>();
  for (const wb of webs.list) for (const i of webTiles(wb)) used.add(i);
  for (const p of ctx.presence || []) if (p.area === 'les') occ.add(Math.floor(p.y) * LW + Math.floor(p.x));
  const free = (f.cands[o] || []).filter(c => c.tiles.every(i => !used.has(i) && !occ.has(i)));
  if (!free.length) return null;
  const c = must(free[ctx.rng.int(free.length)]);
  const wb: Web = { id: ++webs.nid, x: c.x, y: c.y, ax: c.ax, n: c.n, silk: WEB.silk, o };
  webs.list.push(wb);
  return wb;
}
// Termíny tkania sa zmenili: zruší periodickú udalosť weave:<o>, engine (reconcile) ju naplánuje znova na najbližší
// termín z webs.pend[o] (PERIODIC) – návrh nikdy nič neplánuje sám
function planWeave(webs: WebState, o: number, ctx: GameCtx): void { ctx.cancel(`weave:${o}`); }
// Pavučina zmizla (roztrhnutá, vyťahaná) – majiteľ ju o deň utká inde.
function tear(webs: WebState, wb: Web, ctx: GameCtx): void {
  webs.list = webs.list.filter(x => x.id !== wb.id);
  (webs.pend[wb.o] = webs.pend[wb.o] || []).push(ctx.tick + WEB.reweave);
  planWeave(webs, wb.o, ctx);
}
// Počet pavučín podľa obdobia: chýbajúce hneď dotkáme, nadbytočné (príchod zimy) pavúky zjedia, zbytočné tkanie sa zruší.
function balance(webs: WebState, f: Forest, ctx: GameCtx): void {
  webs.list = webs.list.filter(wb => f.homes[wb.o]);
  f.homes.forEach((h, o) => {
    const want = target(f, o, ctx.tick), have = webs.list.filter(wb => wb.o === o);
    for (let k = have.length; k > want; k--) { const gone = must(have[k - 1]).id; webs.list = webs.list.filter(wb => wb.id !== gone); }
    const n = Math.min(have.length, want), pend = (webs.pend[o] || []).sort((a, b) => a - b);
    pend.length = Math.max(0, Math.min(pend.length, want - n));
    for (let k = n + pend.length; k < want; k++) weave(webs, f, o, ctx);
    if (pend.length) webs.pend[o] = pend; else delete webs.pend[o];
    planWeave(webs, o, ctx);
  });
}

// ---------- Kúty pre krížiaka (záhrada, hory) ----------
// Kľúč kúta 'i:d:e' (alebo 'i:d:e:3') začína indexom políčka, takže odstránenie pavučiny nepotrebuje políčka.
const spotCache = new WeakMap<readonly Tile[], CornerSpot[]>();
export function spotsOf(tiles: readonly Tile[], area: string): CornerSpot[] {
  let c = spotCache.get(tiles);
  if (!c) { c = cornerSpots(tiles, D.areaSize(area).w, D.areaSize(area).h); spotCache.set(tiles, c); }
  return c;
}
const tileOfKey = (k: string): number => parseInt(k, 10);
export function cornerList(world: AreaTilesWorld & Pick<GameWorld, 'corners'>, area: AreaId): CornerSpot[] {
  const byKey = new Map(spotsOf(areaTiles(world, area), area).map(s => [s.k, s]));
  return ((world.corners && world.corners[area]) || []).map(k => byKey.get(k)).filter((s): s is CornerSpot => !!s);
}
// kúty, ktoré už neexistujú (napr. na pozemku postavili ľadovňu), zahodíme
export function pruneCorners(corners: Partial<Record<AreaId, string[]>>, tiles: readonly Tile[], area: AreaId): void {
  const ok = new Set(spotsOf(tiles, area).map(s => s.k));
  corners[area] = (corners[area] || []).filter(k => ok.has(k));
}
function addCorner(corners: Partial<Record<AreaId, string[]>>, area: AreaId, key: string): boolean {
  const list = corners[area] || (corners[area] = []);
  if (list.length >= KZ.max || list.includes(key)) return false;
  list.push(key);
  return true;
}
// Stromy v okolí cesty krížiaka (kam vybehne, keď sa zľakne): stred kmeňa a polomer pre každý strom v dosahu
function treesNear(tiles: readonly Tile[], area: string, pts: readonly (readonly [number, number])[]): [number, number, number][] {
  const { w, h } = D.areaSize(area), out: [number, number, number][] = [], seen = new Set<string>();
  for (const [px, py] of pts) {
    for (let y = Math.max(0, Math.floor(py - KZ.tree)); y <= Math.min(h - 1, Math.floor(py + KZ.tree)); y++) {
      for (let x = Math.max(0, Math.floor(px - KZ.tree)); x <= Math.min(w - 1, Math.floor(px + KZ.tree)); x++) {
        const a = Webs.anchorAt(tiles, w, h, x, y);
        if (!a || !CLIMB[a.g] || seen.has(`${a.cx},${a.cz}`)) continue;
        seen.add(`${a.cx},${a.cz}`);
        out.push([a.cx, a.cz, a.r]);
      }
    }
  }
  return out;
}
// Krížiak vybehne z miesta 8–14 krokov od kúta (spoza budovy, kríka…) a beží k nemu po priechodných políčkach.
function startKriziak(tiles: readonly Tile[], area: AreaId, spot: CornerSpot, ctx: GameCtx): Kriziak | null {
  const { w, h } = D.areaSize(area);
  const { dist } = bfs(w, h, [spot.i], n => D.passable(tiles[n]) && must(tiles[n]).g !== 'gate', 14);
  const far: number[] = [];
  for (let i = 0; i < dist.length; i++) if ((dist[i] ?? -1) >= 8) far.push(i);
  if (!far.length) return null;
  const start = must(far[ctx.rng.int(far.length)]), path: number[] = [];
  for (let i = start; i !== spot.i;) { // po klesajúcej vzdialenosti až ku kútu
    const x = i % w, y = (i / w) | 0;
    let nxt = -1;
    for (const [dx, dy] of DIRS) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && dist[n] === must(dist[i]) - 1) { nxt = n; break; } }
    if (nxt < 0) return null;
    path.push(nxt); i = nxt;
  }
  const pts = [start, ...path].map((i): [number, number] => [i % w + 0.5, ((i / w) | 0) + 0.5]), p0 = must(pts[0]);
  return { id: 'k' + area, k: 'k', x: p0[0], y: p0[1], a: 0, path, w, spot: spot.k, trees: treesNear(tiles, area, pts),
    st: 'go', until: 0, left: 2, moving: false, next: ctx.tick + 1 };
}
// Strom, na ktorý krížiak vybehne: z vopred zistených stromov okolo cesty, radšej ďalej od toho, kto ho vyľakal
function treeFor(z: Kriziak, from: Where): TreeSpot | null {
  let best: [number, number, number] | null = null, bs = Infinity;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- krížiak zo staršieho behu stromy nemusí mať
  for (const [cx, cz, r] of z.trees || []) {
    const d = Math.hypot(cx - z.x, cz - z.y);
    if (d > KZ.tree) continue;
    const sc = d - 0.6 * (Math.hypot(cx - from.x, cz - from.y) - Math.hypot(z.x - from.x, z.y - from.y));
    if (sc < bs) { bs = sc; best = [cx, cz, r]; }
  }
  if (!best) return null;
  let nx = z.x - best[0], ny = z.y - best[1];
  const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
  return { x: best[0] + nx * (best[2] + 0.03), y: best[1] + ny * (best[2] + 0.03), nx, ny };
}

// ---------- Pavúky v lese ----------
function homeState(h: Home, o: number): SpiderState {
  return { id: `s${o}`, k: h.k, o, hx: h.x + 0.5, hy: h.y + 0.5, x: h.x + 0.5, y: h.y + 0.5, a: Math.PI / 2, st: 'home', until: 0,
    cool: 0, scared: 0, path: null, tgt: null, z: 0, tr: null, web: null, moving: false, up: false, next: null };
}
const tileOf = (x: number, y: number): number => Math.floor(y) * LW + Math.floor(x);
const dist = (a: Where, b: Where): number => Math.hypot(a.x - b.x, a.y - b.y);
// Cesta po políčkach vlastného územia k prvému políčku, ktoré spĺňa goal (bez štartu). null = nedá sa.
function pathTo(f: Forest, s: SpiderState, goal: (i: number) => boolean): number[] | null {
  const start = tileOf(s.x, s.y);
  const prev = new Map([[start, -1]]), q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const i = must(q[qi]);
    if (goal(i)) { const out: number[] = []; for (let k = i; k !== start; k = must(prev.get(k))) out.unshift(k); return out; }
    const x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy, n = ny * LW + nx;
      if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || prev.has(n) || f.owner[n] !== s.o) continue;
      prev.set(n, i); q.push(n);
    }
  }
  return null;
}
function stepTo(s: Mover, x: number, y: number, sp: number, dt: number): boolean {
  const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const k = Math.min(1, sp * dt / d);
  s.x += dx * k; s.y += dy * k; s.a = Math.atan2(dy, dx); s.moving = true;
  return k >= 1;
}
// cesta sa neskracuje (v denníku by bola každý krok celá znova) – pi = koľko políčok už prešiel
function setPath(s: SpiderState, p: number[] | null): void { s.path = p || []; s.pi = 0; }
const pathLeft = (s: SpiderState): number => (s.path ? s.path.length - (s.pi || 0) : 0);
function walkPath(s: SpiderState, sp: number, dt: number): boolean {
  if (!s.path || !pathLeft(s)) return true;
  const i = must(s.path[s.pi || 0]);
  if (stepTo(s, i % LW + 0.5, ((i / LW) | 0) + 0.5, sp, dt)) s.pi = (s.pi || 0) + 1;
  return !pathLeft(s);
}
function goHome(f: Forest, s: SpiderState, now: number): void { s.z = 0; s.tr = null; s.st = 'return'; s.tgt = null; setPath(s, pathTo(f, s, i => i === tileOf(s.hx, s.hy))); s.until = now; }
const inTerr = (f: Forest, s: SpiderState, x: number, y: number): boolean => f.owner[tileOf(x, y)] === s.o;
// Krok preč od bodu (x, y) po vlastnom území (na susedné políčko najďalej od neho).
function away(f: Forest, s: SpiderState, x: number, y: number, sp: number, dt: number): void {
  const cx = Math.floor(s.x), cy = Math.floor(s.y);
  let best: [number, number] | null = null, bd = Math.hypot(s.x - x, s.y - y);
  for (const [dx, dy] of NEAR8) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || f.owner[ny * LW + nx] !== s.o) continue;
    if (dx && dy && (f.owner[cy * LW + nx] !== s.o || f.owner[ny * LW + cx] !== s.o)) continue;
    const d = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
    if (d > bd) { bd = d; best = [nx + 0.5, ny + 0.5]; }
  }
  if (best) stepTo(s, best[0], best[1], sp, dt);
}
// Kde bude hráč o krok: z jeho posledného pohybu (prítomnosť vx, vy v políčkach/s)
const ahead = (p: Presence, dt: number): Where => ({ x: p.x + (p.vx || 0) * dt, y: p.y + (p.vy || 0) * dt });
function nearest<T extends Where>(s: Where, list: readonly T[]): T | null { let b: T | null = null; for (const l of list) if (!b || dist(s, l) < dist(s, b)) b = l; return b; }
// Miesto na kmeni, ku ktorému pavúk práve kráča alebo na ktorom čaká (stav totree / climb ho vždy má)
const treeOf = (s: { tr?: TreeSpot | null }): TreeSpot => must(s.tr ?? undefined);

// ---------- Na strome ----------
// Pavúk čaká na kmeni, ktorý drží jednu z jeho pavučín (strana kmeňa k pavučine, nx, ny = smer od kmeňa k nej),
// hlavou dole. Ker ani spadnutý kmeň nie sú strom – vtedy pavúk počká na chodníku.
export function trunkSpot(les: readonly Tile[], wb: Pick<Web, 'x' | 'y' | 'ax' | 'n' | 'id'>): TreeSpot | null {
  const out: TreeSpot[] = [];
  const ends: [number, number, number, number][] = wb.ax ? [[wb.x, wb.y - 1, wb.x, wb.y], [wb.x, wb.y + wb.n, wb.x, wb.y + wb.n - 1]]
    : [[wb.x - 1, wb.y, wb.x, wb.y], [wb.x + wb.n, wb.y, wb.x + wb.n - 1, wb.y]];
  for (const [x, y, wx, wy] of ends) {
    const a = Webs.anchorAt(les, LW, LH, x, y);
    if (!a || !CLIMB[a.g]) continue;
    let nx = wx + 0.5 - a.cx, ny = wy + 0.5 - a.cz;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    out.push({ x: a.cx + nx * (a.r + 0.04), y: a.cz + ny * (a.r + 0.04), nx, ny });
  }
  return out.length ? must(out[wb.id % out.length]) : null;
}
// miesto na kmeni pri pavučine (rozloženie lesa sa nemení – pamätá sa v rozbore)
function spotOf(f: Forest, wb: Web): TreeSpot | null { const k = [wb.x, wb.y, wb.ax, wb.n, wb.id].join(':'); if (!(k in f.spots)) f.spots[k] = trunkSpot(f.les, wb); return f.spots[k] ?? null; }
const between = (rng: Rng, r: readonly number[]): number => { const a = must(r[0]), b = must(r[1]); return a + rng.rand() * (b - a); };
const r3 = (v: number): number => Math.round(v * 1000) / 1000; // poloha a výška na tisíciny políčka (kratší denník)
// Parametre pavúka (D.SPIDERS.vlciak / .pradlena)
type SpiderParams = typeof V | typeof PR;
function startGuard(s: SpiderState, P: SpiderParams, now: number, rng: Rng, T: Ticks): void { s.st = 'guard'; s.gz = r3(between(rng, P.guard)); s.until = now + T(between(rng, P.guardMs)); }
// Čaká na kmeni: vylezie do svojej výšky (pri zdvihnutom lampáši až na P.high a pavučinu nechá tak), po čase zlezie a ide domov.
function guard(f: Forest, s: SpiderState, P: SpiderParams, lamps: readonly Presence[], now: number, dt: number, T: Ticks): void {
  if (lamps.some(l => dist(s, l) < SP.lamp + 0.5)) s.scared = now + T(('backMs' in P ? P.backMs : 0) || 2000);
  const want = now < s.scared ? P.high : now < s.until ? (s.gz ?? NaN) : 0, dz = want - s.z, step = P.climb * dt;
  if (Math.abs(dz) > 5e-4) { s.z = Math.abs(dz) <= step ? want : s.z + Math.sign(dz) * step; s.moving = true; s.up = dz > 0; } // výšky sú na tisíciny
  else if (!want) goHome(f, s, now);
}
const hiding = (s: SpiderState, wb: Web, now: number): boolean => s.st === 'guard' && s.web === wb.id && now < s.scared;
function chase(s: SpiderState, key: PlayerKey, now: number): void { s.z = 0; s.tr = null; s.st = 'chase'; s.tgt = key; setPath(s, null); s.repath = 0; s.seen = now; s.border = 0; }
// Pavučinu niekto potiahol alebo do nej vbehol – majiteľ sa rozbehne k nej (pradlena rovno k hráčovi). Mení výrez pavúka
// (spider:<id>) z iného návrhu; ten mu potom zruší udalosť, aby ho engine naplánoval hneď. false = nechá to tak.
export function alert(f: Forest, s: SpiderState | null | undefined, wb: Web, key: PlayerKey, now: number): boolean {
  if (!s || hiding(s, wb, now)) return false;
  s.z = 0; s.tr = null; // z kmeňa zoskočí
  if (s.k === 'p') { if (s.st !== 'chase') chase(s, key, now); }
  else if (s.st === 'guard' && s.web === wb.id) chase(s, key, now); // čakal priamo pri nej
  else if (s.st !== 'chase') { const t = webTiles(wb), mid = must(t[Math.floor(t.length / 2)]); s.st = 'alert'; s.tgt = key; setPath(s, pathTo(f, s, i => i === mid)); s.until = now; }
  s.next = now + 1;
  return true;
}

const ROAMING: readonly SpiderState['st'][] = ['home', 'walk', 'pause', 'return', 'search', 'totree', 'guard'];
function vlciak(f: Forest, s: SpiderState, ps: readonly Presence[], sv: PlayerSave | null | undefined, ctx: SpiderCtx, dt: number, T: Ticks): void {
  const now = ctx.tick, lamps = ps.filter(p => p.lp), byKey = (k: PlayerKey | null): Presence | undefined => ps.find(p => p.key === k);
  const lamp = nearest(s, lamps);
  if (lamp && dist(s, lamp) < SP.lamp + 0.3) s.scared = now + T(V.backMs);
  // kým nikoho nenaháňa, všimne si hráča, ktorý príde blízko (bez lampáša)
  if (ROAMING.includes(s.st) && now >= s.cool && now >= s.scared) {
    const p = ps.find(p => !p.lp && dist(s, p) <= V.sense && inTerr(f, s, p.x, p.y));
    if (p) chase(s, p.key, now);
  }
  switch (s.st) {
    case 'home':
      if (now >= s.until) {
        const own = ctx.webs.list.filter(wb => wb.o === s.o);
        const wb = own.length && ctx.rng.rand() < 0.6 ? must(own[ctx.rng.int(own.length)]) : null;
        s.web = wb ? wb.id : null;
        let g: number | undefined;
        if (wb) g = webTiles(wb)[0];
        else { const all: number[] = []; for (let i = 0; i < f.owner.length; i++) if (f.owner[i] === s.o) all.push(i); g = all[ctx.rng.int(all.length)]; }
        setPath(s, pathTo(f, s, i => i === g));
        s.st = 'walk';
      }
      break;
    case 'walk':
      if (walkPath(s, V.walk, dt)) {
        const wb = s.web != null ? ctx.webs.list.find(w => w.id === s.web) : undefined, spot = wb ? spotOf(f, wb) : null;
        if (spot) { s.st = 'totree'; s.tr = spot; s.z = 0; }
        else { s.st = 'pause'; s.until = now + T(2000 + ctx.rng.rand() * 2000); }
      }
      break;
    case 'totree': if (stepTo(s, treeOf(s).x, treeOf(s).y, V.walk, dt)) startGuard(s, V, now, ctx.rng, T); break;
    case 'guard': guard(f, s, V, lamps, now, dt, T); break;
    case 'pause': if (now >= s.until) goHome(f, s, now); break;
    case 'return': { // po zabalení hráča uteká (fast)
      const sp = s.fast ? V.run : V.walk * 1.5;
      if (walkPath(s, sp, dt) && stepTo(s, s.hx, s.hy, sp, dt)) { s.st = 'home'; s.fast = false; s.until = now + T(3000 + ctx.rng.rand() * 5000); }
      break;
    }
    case 'alert': {
      const p = byKey(s.tgt);
      if (p && dist(s, p) <= WEB.alert && inTerr(f, s, p.x, p.y)) { chase(s, p.key, now); break; }
      if (walkPath(s, V.run, dt)) {
        const q = ps.filter(o => dist(s, o) <= WEB.alert && inTerr(f, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) chase(s, q.key, now); else { s.st = 'search'; s.until = now + T(V.lostMs); }
      }
      break;
    }
    case 'search': if (now >= s.until) goHome(f, s, now); break;
    case 'chase': {
      let p = byKey(s.tgt);
      if (p && dist(s, p) <= V.lose) s.seen = now;
      if (!p || now - (s.seen ?? NaN) > T(V.lostMs)) {
        // stratil ho – skúsi najbližšieho iného hráča vo svojom území, inak to vzdá
        const q = ps.filter(o => o !== p && dist(s, o) <= V.lose && inTerr(f, s, o.x, o.y)).sort((a, b) => dist(s, a) - dist(s, b))[0];
        if (q) { chase(s, q.key, now); p = q; } else { goHome(f, s, now); break; }
      }
      if (!inTerr(f, s, p.x, p.y)) { // za hranicou územia ďalej nejde
        if (!s.border) s.border = now;
        if (now - s.border > T(V.borderMs)) goHome(f, s, now);
        break;
      }
      s.border = 0;
      if (p.lp && dist(s, p) < SP.lamp + 0.5) s.scared = now + T(V.backMs);
      if (now < s.scared) { // lampáš: drží sa na kraji svetla, kým ho hráč nesklopí
        const l = nearest(s, lamps);
        if (l && dist(s, l) < SP.lamp) away(f, s, l.x, l.y, V.run, dt);
        break;
      }
      const d = dist(s, p);
      if (d < 0.55) { // dobehol ho: zabalí ho do pavučiny, vezme hodváb a uteká (uloženie obete návrh deklaroval, kým ho naháňal)
        if (!sv) break;
        const k = wrap(f, s, p, sv, V, ctx, T);
        ctx.emit(toast$(p.key, k ? `🕸️ Vlčiak ťa zabalil do pavučiny, vzal ti ${k}× hodváb a ušiel! Počkaj, kým sa pavučina zoderie.` : '🕸️ Vlčiak ťa zabalil do pavučiny a ušiel. Počkaj, kým sa pavučina zoderie.'));
        break;
      }
      const t = ahead(p, dt); // kam hráč o krok dobehne (cieľ cesty z diaľky)
      if (d < 1.2) stepTo(s, p.x, p.y, V.run, dt); // na blízko rovno na hráča (stojaci hráč nemá kam „dobehnúť“)
      else {
        const pi = inTerr(f, s, t.x, t.y) ? tileOf(t.x, t.y) : tileOf(p.x, p.y);
        if (!pathLeft(s) || now >= (s.repath ?? Infinity) || s.goal !== pi) { setPath(s, pathTo(f, s, i => i === pi)); s.goal = pi; s.repath = now + T(400); }
        walkPath(s, V.run, dt);
      }
      break;
    }
  }
}

function pradlena(f: Forest, s: SpiderState, ps: readonly Presence[], sv: PlayerSave | null | undefined, ctx: SpiderCtx, dt: number, T: Ticks): void {
  const now = ctx.tick, lamps = ps.filter(p => p.lp);
  switch (s.st) {
    case 'home': { // občas zájde k jednej zo svojich pavučín a počká na jej kmeni
      if (!s.until) s.until = now + T(between(ctx.rng, PR.idleMs));
      if (now < s.until) return;
      const own = ctx.webs.list.filter(wb => wb.o === s.o && spotOf(f, wb)), wb = own.length ? must(own[ctx.rng.int(own.length)]) : null;
      s.until = 0;
      if (!wb) return;
      const t = new Set(webTiles(wb));
      s.web = wb.id; setPath(s, pathTo(f, s, i => t.has(i))); s.st = 'walk';
      return;
    }
    case 'walk': {
      if (!walkPath(s, PR.walk, dt)) return;
      const wb = ctx.webs.list.find(w => w.id === s.web), spot = wb ? spotOf(f, wb) : null;
      if (spot) { s.st = 'totree'; s.tr = spot; s.z = 0; } else goHome(f, s, now);
      return;
    }
    case 'totree': if (stepTo(s, treeOf(s).x, treeOf(s).y, PR.walk, dt)) startGuard(s, PR, now, ctx.rng, T); return;
    case 'guard': guard(f, s, PR, lamps, now, dt, T); return;
    case 'return': { const sp = s.fast ? PR.walk * 1.6 : PR.walk; if (walkPath(s, sp, dt) && stepTo(s, s.hx, s.hy, sp, dt)) { s.st = 'home'; s.fast = false; s.until = 0; } return; }
    case 'pause': case 'search': case 'alert': case 'chase': break;
  }
  // naháňa toho, kto jej siahol na pavučinu – len po svojej čistine
  const p = ps.find(o => o.key === s.tgt);
  if (!p || !inTerr(f, s, p.x, p.y) || now < s.cool) { goHome(f, s, now); return; }
  const near = lamps.filter(l => dist(s, l) < SP.lamp);
  if (near.length) { const l = nearest(s, near); if (l) away(f, s, l.x, l.y, PR.push * near.length, dt); return; } // lampáše ju len pomaly odtláčajú
  const d = dist(s, p);
  if (d < 0.9) { if (sv) bite(f, s, p, sv, ctx, T); return; }
  const t = ahead(p, dt);
  if (d < 1.5) stepTo(s, p.x, p.y, PR.walk, dt);
  else {
    const pi = inTerr(f, s, t.x, t.y) ? tileOf(t.x, t.y) : tileOf(p.x, p.y);
    if (!pathLeft(s) || now >= (s.repath ?? Infinity) || s.goal !== pi) { setPath(s, pathTo(f, s, i => i === pi)); s.goal = pi; s.repath = now + T(400); }
    walkPath(s, PR.walk, dt);
  }
}
// Zabalenie do pavučiny: pavúk vezme hodváb (P.take), hráča zabalí – hráč chvíľu stojí, potom sa pavučina zodiera
// (pokyn webbed: server ho pridá do prítomnosti, aby to videli aj ostatní) – a pavúk hneď uteká domov.
function wrap(f: Forest, s: SpiderState, p: Presence, sv: PlayerSave, P: SpiderParams, ctx: GameCtx, T: Ticks): number {
  const n = Math.min(P.take, sv.inv.silk || 0); // vezme, koľko má (removeItems pri nedostatku nevezme nič)
  const k = n > 0 && I.removeItems(I.playerC(sv), 'silk', n, ctx.tick) ? n : 0; // removeItems vráti várky, nie počet
  ctx.emit({ to: p.key, t: 'webbed', stuck: P.webStuckMs, ms: P.webMs, k: P.webSlow, sp: s.k });
  goHome(f, s, ctx.tick); s.fast = true; s.cool = ctx.tick + T(P.coolMs);
  return k;
}
// Pradlena: zabalí, vezme hodváb a odhodí hráča za okraj čistiny (hráč si polohu posúva sám – pokyn shove).
function bite(f: Forest, s: SpiderState, p: Presence, sv: PlayerSave, ctx: SpiderCtx, T: Ticks): void {
  const start = tileOf(p.x, p.y), webs = new Set(ctx.webs.list.flatMap(webTiles));
  const { dist: dd } = bfs(LW, LH, [start], n => !!f.pass[n], 12);
  let out = -1;
  for (let i = 0; i < dd.length; i++) if ((dd[i] ?? 0) > 0 && f.owner[i] !== s.o && !webs.has(i) && (out < 0 || must(dd[i]) < must(dd[out]))) out = i;
  if (out >= 0) ctx.emit({ to: p.key, t: 'shove', x: out % LW + 0.5, y: ((out / LW) | 0) + 0.5 });
  const k = wrap(f, s, p, sv, PR, ctx, T);
  ctx.emit(toast$(p.key, k ? `🕸️ Stará pradlena ťa zabalila do pavučiny, vzala ti ${k}× hodváb a odhodila ťa zo svojej čistiny! Bez lampáša a kamaráta sa k nej nepribližuj.` : '🕸️ Stará pradlena ťa zabalila do pavučiny a odhodila zo svojej čistiny!'));
}
// Kedy chce pavúk znova konať: hýbe sa (alebo naháňa, drží sa) → o STEP krokov; nečinný → svoj termín (najneskôr IDLE_MS).
// Hráča, ktorý sa k nečinnému pavúkovi priblíži (alebo pri ňom zdvihne lampáš), ohlási pohyb – posKeys / onPos ho zobudia.
const BUSY: readonly SpiderState['st'][] = ['chase', 'alert', 'walk', 'return', 'totree'];
const busy = (s: SpiderState): boolean => s.moving || BUSY.includes(s.st);
function plan(s: SpiderState, now: number, T: Ticks): number {
  if (busy(s)) return now + T(STEP_MS);
  const due = [s.until, s.scared, s.cool].filter(t => t > now);
  return Math.min(now + T(IDLE_MS), ...due);
}

// ---------- Návrhy ----------
// Kľúče pavúka: vlastný výrez, pavučiny (čítanie), rozbor lesa cez lesSeed; uloženie obete, keď ju naháňa či sa jej drží.
function spiderKeys(d: { id: string }, w: GameWorld): Keys {
  const s = w.sps && w.sps[d.id];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- svety v testoch Les divov nemajú
  if (w.les) forestOf(w);
  const writes = [`spider:${d.id}`];
  if (s && s.tgt && s.st === 'chase' && savesOf(w)[s.tgt]) writes.push(`save:${s.tgt}`); // zabalí ho a vezme hodváb
  return { writes, reads: ['webs', 'daySeconds', 'lesSeed'] };
}
// Les divov je vo svetoch testov voliteľný – rozbor sa pripraví, len keď je
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- svety v testoch Les divov nemajú
const prepare = (w: GameWorld): void => { if (w.les) forestOf(w); };

// Dáta udalostí a akcií pavúkov (save.ts SavedEvent, actions.ts)
export interface SpiderInputs {
  spider: { id: string };
  kriziak: { area: AreaId };
  weave: { o: number };
  webDawn: null;
  kriziakTrip: null;
  pullStart: { key: PlayerKey; id: number };
  pullStop: { key: PlayerKey };
  pullDone: { key: PlayerKey; id: number; n: string };
  clearWeb: { key: PlayerKey; area: AreaId; i: number };
}
export const PROPOSERS: { [T in keyof SpiderInputs]: GameProposer<SpiderInputs[T]> } = {
  // Jeden krok pavúka v lese (d: { id }). Nikto v lese → domov a spí.
  spider: {
    keys: spiderKeys,
    run(s, d, ctx) {
      const sp = sl(s, `spider:${d.id}`);
      if (!sp) return;
      const ps = (ctx.presence || []).filter(p => p.area === 'les');
      const wasBusy = busy(sp);
      sp.moving = false;
      const near = ps.some(p => Math.hypot(p.x - sp.x, p.y - sp.y) <= ACTIVE_R || Math.hypot(p.x - sp.hx, p.y - sp.hy) <= ACTIVE_R);
      if (!ps.length || (!near && sp.st !== 'chase')) { // nikto nablízku – domov a spí
        Object.assign(sp, { x: sp.hx, y: sp.hy, st: 'home', tgt: null, path: null, pi: 0, fast: false, until: 0, z: 0, tr: null, web: null, next: null });
        return;
      }
      const f = forestBy(s.lesSeed), ds = s.daySeconds, T: Ticks = ms => ticksOf(ms, ds);
      const dt = (wasBusy ? T(STEP_MS) : 1) * tickSec(ds); // hýbuci sa pavúk koná každých STEP_MS
      const sctx: SpiderCtx = Object.assign(ctx, { webs: s.webs });
      const sv = sp.tgt ? sl(s, `save:${sp.tgt}`) : null;
      if (sp.k === 'v') vlciak(f, sp, ps, sv, sctx, dt, T); else pradlena(f, sp, ps, sv, sctx, dt, T);
      sp.x = r3(sp.x); sp.y = r3(sp.y); sp.a = r3(sp.a); sp.z = r3(sp.z || 0);
      sp.next = plan(sp, ctx.tick, T);
    }
  },
  // Krížiak na ceste do kúta (d: { area }): beží trhane, pri hráčovi (alebo lampáši) ujde – radšej na strom; nikto sa nepozerá → utká.
  kriziak: {
    keys: d => ({ writes: [`kz:${d.area}`, 'corners'], reads: ['daySeconds'] }),
    run(s, d, ctx) {
      const z = sl(s, `kz:${d.area}`);
      if (!z) return;
      const ds = s.daySeconds;
      const now = ctx.tick, T: Ticks = ms => ticksOf(ms, ds), dt = T(KZ_STEP_MS) * tickSec(ds);
      const ps = (ctx.presence || []).filter(p => p.area === d.area);
      if (!ps.length) { addCorner(s.corners, d.area, z.spot); put(s, `kz:${d.area}`, null); return; } // nikto sa nepozerá – rovno dobehne
      z.moving = false;
      z.next = now + T(KZ_STEP_MS);
      const scare = ps.find(p => dist(z, p) < KZ.near || (p.lp && dist(z, p) < SP.lamp));
      if (scare && z.st !== 'flee' && z.st !== 'climb') {
        z.st = 'flee'; z.until = now + T(700);
        const a = Math.atan2(z.y - scare.y, z.x - scare.x); z.fx = Math.cos(a); z.fy = Math.sin(a);
        z.tree = treeFor(z, scare);
      }
      if (z.st === 'flee' && z.tree) { if (stepTo(z, z.tree.x, z.tree.y, KZ.flee, dt)) { z.st = 'climb'; z.tr = z.tree; z.z = 0; } return; } // na najbližší strom
      if (z.st === 'climb') { z.z = (z.z || 0) + KZ.climb * dt; z.moving = true; z.up = true; if (z.z >= KZ.gone) put(s, `kz:${d.area}`, null); return; }
      if (z.st === 'flee') {
        const fx = must(z.fx), fy = must(z.fy);
        z.x += fx * KZ.flee * dt; z.y += fy * KZ.flee * dt; z.a = Math.atan2(fy, fx); z.moving = true;
        if (now >= z.until) put(s, `kz:${d.area}`, null); // schoval sa – pavučinu tentoraz neutká
        return;
      }
      if (z.st === 'pause') { if (now >= z.until) { z.st = 'go'; z.left = 1.5 + ctx.rng.rand() * 1.5; } else z.next = z.until; return; }
      if (!z.path.length) { addCorner(s.corners, d.area, z.spot); put(s, `kz:${d.area}`, null); return; }
      const i = must(z.path[0]), before = { x: z.x, y: z.y };
      if (stepTo(z, i % z.w + 0.5, ((i / z.w) | 0) + 0.5, KZ.run, dt)) z.path.shift();
      z.left -= dist(z, before);
      if (z.left <= 0) { z.st = 'pause'; z.until = now + T(400 + ctx.rng.rand() * 600); }
    }
  },
  // Opätovné tkanie (d: { o }): všetky termíny z webs.pend[o], ktoré už nastali (ďalší naplánuje engine podľa pend)
  weave: {
    keys: (d, w) => { prepare(w); return { writes: ['webs'], reads: ['lesSeed'] }; },
    run(s, d, ctx) {
      const f = forestBy(s.lesSeed), webs = s.webs, pend = webs.pend[d.o] || [];
      const due = pend.filter(t => t <= ctx.tick).length;
      const left = pend.filter(t => t > ctx.tick);
      webs.pend[d.o] = left;
      if (!left.length) delete webs.pend[d.o];
      for (let k = 0; k < due; k++) if (webs.list.filter(wb => wb.o === d.o).length < target(f, d.o, ctx.tick)) weave(webs, f, d.o, ctx);
    }
  },
  // Ráno: počet pavučín podľa obdobia
  webDawn: {
    keys: (d, w) => { prepare(w); return { writes: ['webs'], reads: ['lesSeed'] }; },
    run(s, d, ctx) { balance(s.webs, forestBy(s.lesSeed), ctx); }
  },
  // Krížiak sa vydá do voľného kúta (udalosť kriziakTrip v náhodnom čase, v priemere KZ.perDay-krát za deň, v jeseni
  // dvakrát častejšie – pozri PERIODIC). Keď je na ploche hráč, uvidí ho bežať; inak sa pavučina rovno objaví.
  kriziakTrip: {
    keys: () => ({ writes: ['corners', ...D.CORNER_AREAS.map(a => `kz:${a}`)], reads: D.CORNER_AREAS.map(a => `tile:${a}:*`) }),
    run(s, d, ctx) {
      for (const area of D.CORNER_AREAS) {
        const list = s.corners[area] || (s.corners[area] = []);
        if (list.length >= KZ.max || sl(s, `kz:${area}`)) continue;
        const tiles = sl(s, `tile:${area}:*`), busySpots = new Set(list.map(tileOfKey));
        const free = spotsOf(tiles, area).filter(p => !list.includes(p.k) && !busySpots.has(p.i));
        if (!free.length) continue;
        const spot = must(free[ctx.rng.int(free.length)]);
        const z = (ctx.presence || []).some(p => p.area === area) ? startKriziak(tiles, area, spot, ctx) : null;
        if (z) { put(s, `kz:${area}`, z); ctx.cancel(`kz:${area}`); } else addCorner(s.corners, area, spot.k);
      }
    }
  },
  // --- akcie hráča ---
  // Ťahanie hodvábu (d: { key, id }): hráč ťahá WEB.pullMs, potom udalosť pullDone; prítomnosť (pl.pull) nastaví server podľa pokynu
  pullStart: {
    keys: () => ({ reads: ['webs', 'daySeconds'] }),
    run(s, d, ctx) {
      const me = ctx.actor || ctx.reject(null);
      if (me.lp) ctx.reject('S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮');
      if (me.pull) ctx.reject('Ešte ťaháš… 🕸️');
      if (!s.webs.list.some(wb => wb.id === d.id)) ctx.reject(null);
      ctx.emit({ to: d.key, t: 'pullStart', id: d.id, n: ctx.id });
      ctx.scheduleUnique(`pull:${d.key}`, ctx.tick + ticksOf(WEB.pullMs, s.daySeconds), 'pullDone', { key: d.key, id: d.id, n: ctx.id });
    }
  },
  // Hráč prestal ťahať (zdvihol lampáš)
  pullStop: { keys: () => ({}), run(s, d, ctx) { ctx.cancel(`pull:${d.key}`); } },
  // Koniec ťahania (d: { key, id, n }): +1 hodváb; majiteľ si to všimne s rastúcou šancou, posledné potiahnutie pavučinu roztrhne.
  pullDone: {
    keys(d, w) {
      prepare(w);
      const wb = w.webs && w.webs.list.find(x => x.id === d.id);
      return { writes: ['webs', `save:${d.key}`, ...(wb && w.sps && w.sps[`s${wb.o}`] ? [`spider:s${wb.o}`] : [])], reads: ['lesSeed'] };
    },
    run(s, d, ctx) {
      const p = (ctx.presence || []).find(x => x.key === d.key);
      if (!p || !p.pull || p.pull.n !== d.n) return; // medzitým prestal ťahať
      ctx.emit({ to: d.key, t: 'pullDone' }); // server: prítomnosť prestane ťahať
      const webs = s.webs, wb = webs.list.find(x => x.id === d.id), sv = sl(s, `save:${d.key}`);
      if (!wb) { ctx.emit(toast$(d.key, 'Pavučina je preč – niekto ju roztrhol. 🕸️')); return; }
      if (!sv) return;
      const f = forestBy(s.lesSeed), k = WEB.silk - wb.silk; // koľké potiahnutie (0 = prvé)
      wb.silk--;
      I.addItems(I.playerC(sv), 'silk', 1, ctx.tick);
      const torn = wb.silk <= 0;
      if (torn) tear(webs, wb, ctx);
      const noticed = ctx.rng.rand() < must(WEB.notice[Math.min(k, WEB.notice.length - 1)]);
      const who = nameOf(f, wb.o), sp = sl(s, `spider:s${wb.o}`);
      if (noticed && sp && alert(f, sp, wb, d.key, ctx.tick)) ctx.cancel(`spider:s${wb.o}`);
      ctx.emit(toast$(d.key, torn
        ? `+1 🕸️ Pavúčí hodváb. Pavučina sa roztrhla${noticed ? ` – ${who} to zacítil(a)! Uteč! 🕷️` : '.'}`
        : `+1 🕸️ Pavúčí hodváb (v pavučine ešte ${wb.silk}).${noticed ? ` Pavučina sa zachvela – ${who.toLowerCase()} to zacítil(a)! 🕷️` : ''}`));
    }
  },
  // Odstránenie kútovej pavučiny (d: { key, area, i }) – nič z nej nie je
  clearWeb: {
    keys: () => ({ writes: ['corners'] }),
    run(s, d, ctx) {
      const list = s.corners[d.area] || [], k = list.find(c => tileOfKey(c) === d.i);
      if (!k) ctx.reject(null);
      s.corners[d.area] = list.filter(c => c !== k);
      const { w } = D.areaSize(d.area);
      ctx.emit({ to: E.area(d.area), t: 'fx', k: 'cobweb', x: d.i % w + 0.5, y: Math.floor(d.i / w) + 0.5 });
      ctx.emit(toast$(d.key, '🕸️ Odstránil(a) si pavučinu z kúta. Krížiak si nájde iný kút…'));
    }
  }
};

// Periodické udalosti: každý pavúk a krížiak podľa svojho stavu (next), ranné pavučiny, hodinové kúty
const far = (from: number): number => from + 7 * TPD; // spiaci pavúk: zobudí ho príchod hráča (kontrola raz za týždeň len pre istotu)
// čas ďalšej výpravy krížiaka: v priemere TPD / perDay (v jeseni polovica), rovnomerne 0,5–1,5× priemeru
const tripAt = (from: number, rng: Rng): number => { const mean = TPD / KZ.perDay / (season(from) === 2 ? 2 : 1); return from + Math.round(mean * (0.5 + rng.rand())); };
export const PERIODIC: GamePeriodic[] = [
  ...IDS.map(id => ({ key: `spider:${id}`, type: 'spider', data: { id }, next: (from: number, rng: Rng, w: GameWorld) => { const s = w.sps && w.sps[id]; return s && s.next != null ? Math.max(from, s.next) : far(from); } })),
  ...D.CORNER_AREAS.map(area => ({ key: `kz:${area}`, type: 'kriziak', data: { area }, next: (from: number, rng: Rng, w: GameWorld) => { const z = w.kz && w.kz[area]; return z ? Math.max(from, z.next) : far(from); } })),
  ...IDS.map((id, o) => ({ key: `weave:${o}`, type: 'weave', data: { o }, next: (from: number, rng: Rng, w: GameWorld) => { const p = w.webs && w.webs.pend[o]; return p && p.length ? Math.max(from, Math.min(...p)) : far(from); } })),
  { key: 'webDawn', type: 'webDawn', next: E.daily(D.DAWN_TICK) },
  { key: 'kriziakTrip', type: 'kriziakTrip', next: tripAt }
];

// ---------- Prepojenie s pohybom a pripojením (actions.js) ----------
// Úsek pohybu (x0, y0) → (x1, y1) v lese: pavučiny, cez ktoré prešiel. Bežný pohyb za rámec je pod pol políčka;
// dlhší skok (oprava polohy, presun) sa nepočíta ako beh cez les – rozhoduje len cieľové políčko.
const SWEEP_MAX = 1.5;
export function crossed(webs: WebState | null | undefined, x0: number, y0: number, x1: number, y1: number): Web[] {
  if (!(Math.hypot(x1 - x0, y1 - y0) <= SWEEP_MAX)) { x0 = x1; y0 = y1; }
  const out = new Map<number, Web>(), n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.2));
  for (let k = 0; k <= n; k++) {
    const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n, wb = webAt(webs, tileOf(x, y));
    if (wb && !out.has(wb.id)) out.set(wb.id, wb);
  }
  return [...out.values()];
}
// Prechod cez pavučinu: rovina pavučiny je stred jej radu políčok (ax 0: y = wb.y + 0,5, hráč ide naprieč po y; ax 1 po x).
// d = vzdialenosť od roviny (znamienko podľa strany), u = poloha pozdĺž pavučiny (v rozpätí lo … hi?)
export function across(wb: Pick<Web, 'x' | 'y' | 'ax' | 'n'>, x: number, y: number): { d: number; u: number; lo: number; hi: number } {
  return wb.ax ? { d: x - (wb.x + 0.5), u: y, lo: wb.y, hi: wb.y + wb.n } : { d: y - (wb.y + 0.5), u: x, lo: wb.x, hi: wb.x + wb.n };
}
// Pavučiny, do ktorých hráč key vošiel alebo v nich je (wb.in[key] = strana, z ktorej prišiel: ±1)
function pushing(webs: WebState, key: PlayerKey, x0: number, y0: number, x1: number, y1: number): Web[] {
  const out = new Map<number, Web>();
  for (const wb of crossed(webs, x0, y0, x1, y1)) out.set(wb.id, wb);
  for (const wb of webs.list) if (wb.in && wb.in[key] != null) out.set(wb.id, wb);
  return [...out.values()];
}
const wakeKeys = (w: GameWorld): string[] => (w.sps ? ['spider:*'] : []);
// Kľúče navyše pre pohyb (d: { key, x, y }): vbehnutie do pavučiny (pavučiny a ich majitelia) alebo príchod do lesa (budí pavúky)
export function posKeys(d: { key: PlayerKey; x: number; y: number }, w: GameWorld): Keys {
  const sv = savesOf(w)[d.key];
  if (!sv || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return {};
  const area = sv.area && D.AREAS.includes(sv.area) ? sv.area : 'garden', p = clampPos(area, d.x, d.y);
  if (area !== 'les') {
    const g = D.gateAt(area, Math.floor(p.x), Math.floor(p.y));
    return g && g.to === 'les' ? { writes: wakeKeys(w) } : {};
  }
  const writes = new Set(nearIdle(w, p).map(id => `spider:${id}`));
  if (!w.webs || !Number.isFinite(sv.x) || !Number.isFinite(sv.y)) return { writes: [...writes] };
  // pavučina, v ktorej hráč je alebo do ktorej vchádza: zápis do pavučín (+ majiteľ, keby sa roztrhla)
  const hit = pushing(w.webs, d.key, sv.x, sv.y, p.x, p.y);
  if (!hit.length) return { writes: [...writes] };
  prepare(w);
  for (const wb of hit) if (w.sps && w.sps[`s${wb.o}`]) writes.add(`spider:s${wb.o}`);
  return { writes: ['webs', ...writes], reads: ['lesSeed'] };
}
// Pavúky, ktoré pohyb hráča do bodu p zobudí v ďalšom kroku: nečinné do WAKE_R (všimnú si ho, zľaknú sa lampáša)
// a spiace, ktorých nora je do ACTIVE_R (les okolo hráča ožije)
function nearIdle(w: GameWorld, p: Where): string[] {
  const out: string[] = [];
  for (const [id, s] of entries(w.sps || {})) {
    if (s.next == null ? Math.hypot(s.hx - p.x, s.hy - p.y) <= ACTIVE_R : s.next > w.tick + 1 && !busy(s) && Math.hypot(s.x - p.x, s.y - p.y) <= WAKE_R) out.push(id);
  }
  return out;
}
// Po pohybe (from = poloha pred pohybom, pos = po ňom): ťahajúci, ktorý sa pohol, prestane ťahať; vbehnutie do pavučiny;
// príchod do lesa zobudí pavúky.
type Pos = { x: number; y: number; area?: AreaId | undefined };
export function onPos(s: GameSlices, d: { key: PlayerKey }, ctx: GameCtx, from: Pos, pos: Pos): void {
  const me = ctx.actor;
  if (me && me.pull && Math.hypot(pos.x - me.pull.px, pos.y - me.pull.py) > PULL_MOVE) {
    ctx.cancel(`pull:${d.key}`);
    ctx.emit({ to: d.key, t: 'pullDone' });
    ctx.emit(toast$(d.key, 'Prestal(a) si ťahať hodváb.'));
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pavučiny sú v slices, len keď ich pohyb deklaroval
  if (from.area === 'les' && pos.area === 'les' && s.webs) {
    // Hráč sa do pavučiny zaborí (klient ho v nej spomalí na WEB.drag a pavučina sa za ním naťahuje); roztrhne sa, až keď
    // je políčko (WEB.through) za ňou – hodváb z nej nedostane a majiteľ vie, kde je. Kto cúvne späť, pavučina sa pustí celá.
    for (const wb of pushing(s.webs, d.key, from.x, from.y, pos.x, pos.y)) {
      const a = across(wb, pos.x, pos.y), b = across(wb, from.x, from.y);
      const was = wb.in ? wb.in[d.key] : undefined;
      if (was == null) { // vošiel
        wb.in = { ...wb.in, [d.key]: (b.d || a.d) < 0 ? -1 : 1 };
        ctx.emit(toast$(d.key, '🕸️ Zaboril(a) si sa do pavučiny… lepí sa a naťahuje.'));
        continue;
      }
      const side = was, past = -side * a.d; // ako ďaleko je za rovinou (na druhej strane)
      const away = a.u < a.lo - 0.4 || a.u > a.hi + 0.4 || Math.abs(a.d) > WEB.through + 1.5; // vyšiel bokom, skok, starý záznam
      if (past >= WEB.through && !away) {
        const f = forestBy(s.lesSeed);
        tear(s.webs, wb, ctx);
        const sp = sl(s, `spider:s${wb.o}`);
        if (sp && alert(f, sp, wb, d.key, ctx.tick)) ctx.cancel(`spider:s${wb.o}`);
        ctx.emit({ to: E.area('les'), t: 'fx', k: 'cobweb', x: pos.x, y: pos.y });
        ctx.emit(toast$(d.key, `🕸️ Prerazil(a) si pavučinu – roztrhla sa a ${nameOf(f, wb.o).toLowerCase()} vie, kde si! 🕷️`));
      } else if (side * a.d >= WEB.through || away) { // cúvol späť alebo vyšiel bokom
        const rest = { ...wb.in }; delete rest[d.key];
        wb.in = Object.keys(rest).length ? rest : undefined;
      }
    }
  }
  if (pos.area === 'les' && from.area !== 'les') wake(s, ctx);
  for (const k of Object.keys(s)) { // nečinné pavúky pri hráčovi (posKeys) – rozhliadnu sa v ďalšom kroku
    if (!k.startsWith('spider:') || k === 'spider:*') continue;
    const sp = sl(s, `spider:${k.slice(7)}`);
    if (sp && (sp.next == null || (sp.next > ctx.tick + 1 && !busy(sp)))) { sp.next = ctx.tick + 1; ctx.cancel(k); }
  }
}
// Hráč prišiel do lesa (prechodom alebo pripojením): spiace pavúky sa zobudia
function wake(s: GameSlices, ctx: GameCtx): void {
  const all = maybe(s, 'spider:*'); // len keď pohyb či pripojenie deklaroval 'spider:*'
  if (!all) return;
  for (const [id, sp] of entries(all)) if (sp.next == null) { sp.next = ctx.tick + 1; ctx.cancel(`spider:${id}`); }
}
export const joinKeys = (d: { key: PlayerKey }, w: GameWorld): Keys => (savesOf(w)[d.key]?.area === 'les' ? { writes: wakeKeys(w) } : {});
export function onJoin(s: GameSlices, d: unknown, ctx: GameCtx, area: AreaId): void { if (area === 'les') wake(s, ctx); }

// Klik na políčko (Actions.resolveAct): pavučina v lese → ťahať hodváb; kútová pavučina → odstrániť. null = nie je tu pavučina.
export type SpiderAct = { toast: string } | { type: 'pullStart'; data: SpiderInputs['pullStart'] } | { type: 'clearWeb'; data: SpiderInputs['clearWeb'] };
export function resolveAct(world: GameWorld, me: Presence, area: AreaId, i: number): SpiderAct | null {
  if (area === 'les') {
    const wb = webAt(world.webs, i);
    if (!wb) return null;
    if (me.lp) return { toast: 'S lampášom v ruke hodváb neutrhneš. Vyber si v lište niečo iné alebo prázdnu ruku. 🏮' };
    return { type: 'pullStart', data: { key: me.key, id: wb.id } };
  }
  if (D.CORNER_AREAS.includes(area) && world.corners && (world.corners[area] || []).some(k => tileOfKey(k) === i)) return { type: 'clearWeb', data: { key: me.key, area, i } };
  return null;
}

// ---------- Správy pre klientov (server nad živým svetom, mimo enginu) ----------
export function websView(world: GameWorld): Extract<ServerMessage, { t: 'webs' }> {
  const f = forestOf(world);
  return { t: 'webs', webs: ((world.webs && world.webs.list) || []).map((wb): WebView => ({ id: wb.id, x: wb.x, y: wb.y, ax: wb.ax, n: wb.n, silk: wb.silk, ...(wb.in ? { in: wb.in } : {}) })), homes: f.homes.map(h => ({ k: h.k, x: h.x, y: h.y })) };
}
export function cornerView(world: GameWorld, area: CornerArea): Extract<ServerMessage, { t: 'corner' }> {
  return { t: 'corner', area, list: cornerList(world, area).map((s): CornerView => ({ x: s.x, y: s.y, dx: s.dx, dy: s.dy, ex: s.ex, ey: s.ey, f: s.faces })) };
}
export function areaViews(world: GameWorld, area: AreaId): ServerMessage[] {
  if (area === 'les') return [websView(world)];
  if (isCornerArea(area)) return [cornerView(world, area)];
  return [];
}
// Pavúky a krížiak na ploche (vysielanie polôh): na kmeni aj výška z, strana kmeňa n a či lezie hore u
export function entities(world: GameWorld, area: AreaId): SpiderView[] {
  const out: SpiderView[] = [], r = (v: number): number => +v.toFixed(2);
  const tree = (o: SpiderView, s: SpiderState | Kriziak): SpiderView => {
    if (s.tr && s.st !== 'totree' && s.st !== 'flee') Object.assign(o, { z: r(s.z || 0), n: [r(s.tr.nx), r(s.tr.ny)], u: s.moving && s.up ? 1 : 0 });
    return o;
  };
  if (area === 'les' && world.sps) for (const [, s] of entries(world.sps)) out.push(tree({ id: s.id, k: s.k, x: r(s.x), y: r(s.y), a: r(s.a), m: s.moving ? 1 : 0, h: s.st === 'home' ? 1 : 0 }, s));
  const z = world.kz && world.kz[area];
  if (z) out.push(tree({ id: z.id, k: 'k', x: r(z.x), y: r(z.y), a: r(z.a), m: z.moving ? 1 : 0 }, z));
  return out;
}

// ---------- Načítanie a uloženie ----------
// Pri načítaní: pavučiny a kúty z uloženia (neplatné sa zahodia), pavúky doma a spia, krížiaky nikde, ťahanie z minulého
// behu zmizne. Prvé tkanie nového sveta (a jeden kút na plochu) cez živý kontext – ako založenie trhu (E.liveCtx).
// Pavučiny a kúty prichádzajú z uloženia – kontroly nižšie platia pre poškodené či staré súbory, nie pre typ.
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- uloženie môže byť staršie alebo poškodené (overenie vstupu) */
export function load(world: GameWorld, ctx: GameCtx): void {
  const f = forestOf(world);
  const fresh = !(world.webs && Array.isArray(world.webs.list));
  const w: WebState = fresh || !world.webs ? { list: [], nid: 0, pend: {} } : world.webs;
  for (const wb of w.list) if (wb) delete wb.in; // kto bol v pavučine, už tam po načítaní nie je
  w.list = w.list.filter(wb => wb && f.cands[wb.o] && f.cands[wb.o]?.some(c => c.x === wb.x && c.y === wb.y && c.ax === wb.ax && c.n === wb.n) && wb.silk >= 1);
  w.nid = Math.max(w.nid | 0, ...w.list.map(wb => wb.id));
  w.pend = isRecord(w.pend) ? w.pend : {};
  world.webs = w;
  const freshCorners = !isRecord(world.corners);
  const corners: Partial<Record<AreaId, string[]>> = freshCorners || !world.corners ? {} : world.corners;
  world.corners = corners;
  for (const area of D.CORNER_AREAS) {
    const list = corners[area];
    corners[area] = Array.isArray(list) ? list.map(String) : [];
    pruneCorners(corners, areaTiles(world, area), area);
  }
  const sps: Partial<Record<string, SpiderState>> = {};
  f.homes.forEach((h, o) => { sps[`s${o}`] = homeState(h, o); });
  world.sps = sps;
  const kz: Partial<Record<AreaId, Kriziak | null>> = {};
  for (const area of D.CORNER_AREAS) kz[area] = null;
  world.kz = kz;
  world.events = world.events.filter(e => e.type !== 'pullDone');
  if (fresh) balance(w, f, ctx);
  if (freshCorners) for (const area of D.CORNER_AREAS) {
    const all = spotsOf(areaTiles(world, area), area);
    if (all.length) addCorner(corners, area, must(all[ctx.rng.int(all.length)]).k);
  }
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition -- koniec overenia uloženia */
// do uloženia len pavučiny a kúty (pavúky a krížiaky sú po načítaní vždy doma)
export const save = (world: GameWorld): { webs: GameWorld['webs']; corners: GameWorld['corners'] } => ({ webs: world.webs, corners: world.corners });
