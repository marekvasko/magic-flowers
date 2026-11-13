// Ladiaca stránka (#106): záložka Engine – kruhová pamäť dávok, časová os, dávka do hĺbky (kolá, vinníci, skupiny,
// zmeny pred / po), fronta s pôvodom, odstránenie kľúčov hráčov a server (filter správ, dobiehanie po načítaní).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as Obj from '../src/shared/objects.ts';
import * as D from '../src/shared/data.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import type { Contracts, Icehouse, Market, PlayerSave } from '../src/shared/save.ts';
import type { JsonRecord } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as Ice from '../src/server/ice.ts';
import * as Debug from '../src/server/debug.ts';
import type { FilterDecision, Loaded, TraceRing, Tools } from '../src/server/debug.ts';
import api, { groupsOf } from '../src/server/debug-api/engine.ts';
import type { DetailReply, QueueReply, Row, TimelineReply } from '../src/server/debug-api/engine.ts';
import journalApi from '../src/server/debug-api/journal.ts';
import type { JournalList, JournalLoadReply, JournalOne } from '../src/server/debug-api/journal.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { isMsg, must, parseJson, parseMsg, partial, portOf, rethrow, testWorld } from './helpers.ts';
import { setStock, toStall } from './game-world.ts';
import type { MsgOf, MsgType } from './helpers.ts';
const TPD = D.TICKS_PER_DAY;
const json = (v: unknown): string => JSON.stringify(v);
const SP = must(Econ.PLANTABLE.find(k => !D.SPECIES[k].strict)), SP2 = must(Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict)[1]);

// Svet ako na serveri (ako v actions.test.ts): ana a bob pri domčeku; trace = kruhová pamäť, source = kto posúva čas
type W = GameWorld & { market: Market; contracts: Contracts; presence?: Presence[] | undefined; trace: TraceRing; source?: string };
const ready = (w: GameWorld): w is W => !!w.market && !!w.contracts;
function makeWorld(seed: number): W {
  const w = testWorld<Partial<GameWorld> & { presence?: Presence[]; trace?: TraceRing }>({
    tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'ladenie-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: partial<Icehouse>({ built: true, ice: 0 }), up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  w.objects = Obj.defaultLots(); Ice.applyIcehouse(w.icehouse, w.tiles, w.objects);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = partial<PlayerSave>({ coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, area: 'garden' });
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.HOUSE.x, y: Actions.HOUSE.y, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: Actions.HOUSE.x + 1, y: Actions.HOUSE.y, scav: null }];
  w.trace = Debug.traceRing(600);
  if (!ready(w)) throw new Error('trh a nástenka chýbajú');
  return w;
}
type Spec = E.Spec<W, Presence, Msg>;
// Špecifikácia ako na serveri: po každej dávke záznam do kruhovej pamäte (s časmi častí z hodín)
function traced(w: W, max?: number): Spec {
  w.trace = Debug.traceRing(max || 600);
  let t = 0;
  return {
    proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS }, periodic: Events.PERIODIC, presence: x => x.presence, clock: () => (t += 0.25),
    onBatch: (x, out) => { Debug.traceBatch(x.trace, out, { source: x.source || 'live', timing: out.timing ?? null }); },
    onError: rethrow
  };
}
let seq = 0;
const act = <T extends keyof Actions.ActionInputs>(type: T, key: string, data?: Partial<Omit<Actions.ActionInputs[T], 'key'>>): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const tillable = (w: GameWorld): number[] => w.tiles.map((t, i) => i).filter(i => D.TILLABLE[must(w.tiles[i]).g] && must(w.tiles[i]).g !== 'ring');
const grassOf = (w: GameWorld): number[] => w.tiles.map((t, i) => i).filter(i => must(w.tiles[i]).g === 'grass' && !must(w.tiles[i]).s);
const tools = (w: Pick<W, 'trace'>): Pick<Tools, 'ROOM_RE' | 'trace' | 'load'> => ({
  ROOM_RE: /^[a-z0-9-]{1,16}$/, trace: () => ({ max: w.trace.max, n: w.trace.n, records: Debug.traceList(w.trace), origins: w.trace.origins }),
  load: () => partial<Loaded>({ state: parseJson<Loaded['state']>(json(Object.assign({}, w, { trace: undefined }))) })
});
// Odpoveď ako JSON (tak ju dostane stránka); typ podľa druhu požiadavky
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- tvar odpovede určuje volajúci podľa druhu požiadavky (ako parseJson)
function get<T>(w: Pick<W, 'trace'>, params: Record<string, string | number>): T {
  const p = new URLSearchParams({ room: 'x' });
  for (const [k, v] of Object.entries(params)) p.set(k, String(v));
  return parseJson<T>(json(api(p, tools(w))));
}
const rowsOf = (list: TimelineReply): Row[] => list.rows.filter((r): r is Row => !('gap' in r));

test('kruhová pamäť: nikdy nepresiahne N, drží posledných N v poradí, počíta prepísané', () => {
  const ring = Debug.traceRing(5);
  for (let i = 0; i < 3; i++) Debug.traceFilter(ring, 10 + i, [partial<FilterDecision>({ what: 'dropped' })]);
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.n), [1, 2, 3]);
  for (let i = 3; i < 23; i++) { Debug.traceFilter(ring, 10 + i, []); assert.ok(ring.buf.length <= 5); }
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.n), [19, 20, 21, 22, 23]);
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.tick), [28, 29, 30, 31, 32]);
  const w = { trace: ring, events: [], tick: 0 };
  const j = get<TimelineReply>(w, {});
  assert.deepStrictEqual([j.max, j.total, j.kept, j.overwritten], [5, 23, 5, 18]);
  // 30 dní dobiehania: pamäť ostane na N
  const w2 = makeWorld(1), spec = traced(w2, 50);
  E.advanceTo(w2, w2.tick + 30 * TPD, spec);
  assert.ok(w2.trace.n > 700, String(w2.trace.n));
  assert.strictEqual(Debug.traceList(w2.trace).length, 50);
  assert.ok(w2.trace.buf.length === 50);
});

test('dávka: dve kúpy posledného semienka – poradie, odloženie s vinníkom a kľúčom, odmietnutie, skupiny, zmeny pred / po', () => {
  const w = makeWorld(2), spec = traced(w);
  toStall(w, 'ana', 'bob');
  setStock(w, `seed_${SP}`, 1); setStock(w, `seed_${SP2}`, 5);
  const a = act('buy', 'ana', { id: `seed_${SP}`, n: 1 }), b = act('buy', 'bob', { id: `seed_${SP2}`, n: 2 }), c = act('buy', 'bob', { id: `seed_${SP}`, n: 1 });
  E.commitBatch(w, [a, b, c], spec);
  const list = get<TimelineReply>(w, {});
  assert.strictEqual(list.rows.length, 1);
  const row = must(rowsOf(list)[0]);
  assert.deepStrictEqual([row.kind, row.inputs, row.requests, row.events, row.proposals, row.applied, row.held, row.rejected, row.rounds], ['actions', 3, 3, 0, 4, 2, 1, 1, 2]);
  const timing = row.timing || {};
  assert.ok((timing['evaluate'] ?? 0) > 0 && (timing['resolve'] ?? 0) > 0 && (timing['commit'] ?? 0) > 0, 'časy častí z hodín');
  const d = get<DetailReply>(w, { n: must(row.n) });
  assert.deepStrictEqual(must(d.inputs).map(i => [i.pos, i.id, i.stage, i.actor.kind, 'key' in i.actor ? i.actor.key : undefined, 'name' in i.actor ? i.actor.name : undefined]), [[1, a.id, 'act', 'player', 'ana', 'Ana'], [2, b.id, 'act', 'player', 'bob', 'Bob'], [3, c.id, 'act', 'player', 'bob', 'Bob']]);
  const rounds = must(d.rounds);
  assert.strictEqual(rounds.length, 2);
  const r1 = must(rounds[0]), r2 = must(rounds[1]);
  assert.deepStrictEqual(r1.proposals.map(p => [p.id, p.outcome]), [[a.id, 'applied'], [b.id, 'applied'], [c.id, 'held']]);
  // vinníci: ana už kúpila to isté semienko, bob už zapísal svoje vlastné uloženie
  assert.deepStrictEqual(must(r1.proposals[2]).blockedBy, [{ id: a.id, type: 'buy', keys: [`market:book:seed_${SP}:*`, `market:seed_${SP}`] }, { id: b.id, type: 'buy', keys: ['save:bob'] }]);
  assert.deepStrictEqual(r1.groups.shared, [[a.id, b.id, c.id]], 'riešili sa spolu cez spoločné kľúče');
  assert.deepStrictEqual(r1.groups.independent, []);
  assert.deepStrictEqual(groupsOf([{ id: 'x', reads: [], writes: ['save:ana'] }, { id: 'y', reads: [], writes: ['save:bob'] }, { id: 'z', reads: ['save:*'], writes: [] }]), { shared: [['x', 'y', 'z']], independent: [] });
  assert.deepStrictEqual(groupsOf([{ id: 'x', reads: [], writes: ['save:ana'] }, { id: 'y', reads: [], writes: ['save:bob'] }]), { shared: [], independent: ['x', 'y'] });
  assert.deepStrictEqual(r2.proposals.map(p => [p.id, p.outcome, p.msg]), [[c.id, 'rejected', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  assert.deepStrictEqual([r1.step, r2.step, must(r2.proposals[0]).rng], [0, 1, { step: 1, id: c.id }], 'náhoda: len krok a id, nikdy semienko');
  const changes = must(d.changes);
  const stock = must(changes.find(x => x.key === `market:seed_${SP}`));
  assert.deepStrictEqual(stock.writes.map(x => x.id), [a.id]);
  assert.deepStrictEqual(must(stock.writes[0]).leaves.find(l => l.p[0] === 'stock'), { p: ['stock'], from: 1, to: 0 });
  assert.deepStrictEqual(stock.contenders.map(x => [x.id, x.round, x.outcome]), [[c.id, 1, 'held'], [c.id, 2, 'rejected']]);
  assert.ok(must(changes[0]).key.startsWith(`market:book:seed_${SP}:`) || must(changes[0]).key === `market:seed_${SP}`, 'kľúče, o ktoré sa súperilo, idú prvé');
  assert.ok(changes.some(x => x.key === 'save:ana' && must(x.writes[0]).leaves.some(l => l.p.join('.') === 'coins')));
  assert.ok(!JSON.stringify(d).includes(must(w.seed ?? undefined)), 'semienko sveta sa nikdy neukáže');
});

test('políčko a zákazka: dvaja trhajú ten istý kvet, dvaja berú tú istú zákazku – víťaz, odmietnutý a jeho dôvod', () => {
  const w = makeWorld(3), spec = traced(w);
  const ti = tillable(w), t0 = must(ti[0]);
  must(w.tiles[t0]).s = { k: must(D.TILLABLE[must(w.tiles[t0]).g]), w: 1, r: 0, o: 'ana', p: { sp: SP, prog: D.SPECIES[SP].days, q: 3, dry: 0 } };
  const c = must(w.contracts.list.find(x => !x.takenBy));
  const p1 = act('pick', 'bob', { i: t0 }), p2 = act('pick', 'ana', { i: t0 }), k1 = act('ctake', 'ana', { id: c.id }), k2 = act('ctake', 'bob', { id: c.id });
  E.commitBatch(w, [p1, p2, k1, k2], spec);
  const d = get<DetailReply>(w, { n: w.trace.n });
  const tile = must(must(d.changes).find(x => x.key === `tile:garden:${t0}`));
  assert.deepStrictEqual(tile.writes.map(x => x.id), [p1.id]);
  assert.deepStrictEqual(tile.contenders.filter(x => x.outcome === 'rejected').map(x => [x.id, x.msg]), [[p2.id, 'Tu nič nekvitne.']]);
  const board = must(must(d.changes).find(x => x.key === 'contracts'));
  assert.deepStrictEqual(board.writes.map(x => x.id), [k1.id]);
  assert.deepStrictEqual(board.contenders.filter(x => x.outcome === 'rejected').map(x => x.msg), ['Túto zákazku už niekto zobral.']);
  const held = must(must(d.rounds)[0]).proposals.filter(p => p.outcome === 'held');
  assert.deepStrictEqual(held.map(p => [p.id, must(p.blockedBy).map(b => b.id)]), [[p2.id, [p1.id]], [k2.id, [p1.id, k1.id]]], 'bob už zapísal svoje uloženie, ana zákazku');
});

test('časová os: udalosti aj akcie, prázdne kroky zbalené, zdroj (dobiehanie, pretočenie noci), fronta s pôvodom a náhodou', () => {
  const w = makeWorld(4), spec = traced(w);
  const ti = grassOf(w), g0 = must(ti[0]);
  w.source = 'catchup';
  E.advanceTo(w, w.tick + 2 * TPD, spec);
  w.source = 'ff';
  E.advanceTo(w, w.tick + 600, spec);
  w.source = 'frame';
  const me = must(must(w.presence)[0]);
  me.x = g0 % D.W + 0.5; me.y = Math.floor(g0 / D.W) + 0.5;
  const s = act('scavStart', 'ana', { i: g0 });
  E.commitBatch(w, [s], spec);
  const list = get<TimelineReply>(w, {});
  const rows = rowsOf(list), gaps = list.rows.flatMap(r => ('gap' in r ? [r] : []));
  assert.strictEqual(must(rows[0]).kind, 'actions', 'najnovšia hore');
  assert.ok(rows.some(r => r.source === 'catchup' && r.kind === 'events' && 'types' in r && r.types.includes('dawn')));
  assert.ok(rows.some(r => r.source === 'ff'));
  assert.ok(gaps.length && gaps.every(g => g.gap > 0 && g.to - g.from + 1 === g.gap));
  // medzera = presne kroky medzi susednými riadkami
  const tickOf = (r: TimelineReply['rows'][number] | undefined): number => (r && 'tick' in r ? r.tick : NaN);
  for (let i = 1; i < list.rows.length - 1; i++) { const r = must(list.rows[i]); if ('gap' in r) assert.strictEqual(tickOf(list.rows[i - 1]) - tickOf(list.rows[i + 1]) - 1, r.gap); }
  assert.ok(rows.every((r, i) => i === 0 || must(rows[i - 1]).tick >= r.tick));
  // udalosť z fronty: aktér plánovač / NPC, fáza world, id ev#<seq>
  const ev = get<DetailReply>(w, { n: must(must(rows.find(r => 'types' in r && r.types.includes('dawn'))).n) });
  assert.ok(must(ev.inputs).every(i => i.stage === 'world' && /^ev#\d+$/.test(i.id) && 'ev' in i));
  assert.strictEqual(must(must(ev.inputs).find(i => i.kind === 'dawn')).actor.kind, 'scheduler');
  // scavStart naplánoval scavDone: fronta vie, ktorý návrh, v ktorom kroku a z čoho bude náhoda
  const det = get<DetailReply>(w, { n: must(must(rows[0]).n) });
  assert.deepStrictEqual(must(must(det.rounds)[0]?.proposals[0]).ops.map(o => [o.op, o.type, o.key]), [['cancel', undefined, 'scavDone:ana'], ['insert', 'scavDone', 'scavDone:ana']], 'scheduleUnique = zruš + naplánuj');
  const q = get<QueueReply>(w, { view: 'queue' });
  const done = must(q.queue.find(e => e.type === 'scavDone'));
  const origin = done.origin;
  assert.deepStrictEqual([origin.kind, 'by' in origin ? origin.by : undefined, 'tick' in origin ? origin.tick : undefined, done.rng], ['proposal', s.id, w.tick, 'ev#' + done.seq]);
  assert.ok(q.queue.filter(e => e.kind === 'periodic').every(e => e.origin.kind === 'reconciler'));
  assert.ok(q.queue.every((e, i) => i === 0 || must(q.queue[i - 1]).at <= e.at));
});

// Odpoveď http (stav a telo)
type Reply = { status: number | undefined; body: string };
const httpGet = (port: number, p: string): Promise<Reply> => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => {
  let b = ''; res.on('data', (c: Buffer) => { b += c.toString(); }); res.on('end', () => { resolve({ status: res.statusCode, body: b }); });
}).on('error', reject));

test('kľúče hráčov: odtlačok v celej odpovedi – actor, data.key, save:/pos:/event: kľúče, cesty zmien, správy, prítomnosť, filter', async () => {
  const w = makeWorld(5), spec = traced(w);
  Object.assign(save(w, 'ana'), { x: 10.5, y: 10.5 });
  const ti = grassOf(w), g0 = must(ti[0]);
  const me = must(must(w.presence)[0]);
  me.x = g0 % D.W + 0.5; me.y = Math.floor(g0 / D.W) + 0.5;
  E.commitBatch(w, [act('scavStart', 'ana', { i: g0 }), act('buy', 'bob', { id: `seed_${SP}`, n: 1 }), act('gift', 'bob', { to: 'ana', item: `seed_${SP}` })], spec);
  E.advanceTo(w, w.tick + TPD, spec); // dawn mení save:* (cesty zmien začínajú kľúčom hráča)
  Debug.traceFilter(w.trace, w.tick, [{ seq: 4, actor: 'ana', t: 'act', what: 'deferred', rule: 'one tile action per player per frame' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-engine-'));
  const room = Object.assign(w, { players: new Map<number, { key: string; name: string; area: D.AreaId }>([[1, { key: 'ana', name: 'Ana', area: 'garden' }]]) });
  const handle = Debug.create({ dataDir: dir, debugDir: path.join(import.meta.dirname, '..', 'debug'), rooms: new Map([['ladenie', room]]), serialize: r => json(Object.assign({}, r, { trace: undefined, players: undefined })), migrate: s => s, sim: () => spec, apis: { engine: api } });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const fetchJ = (p: string): Promise<Reply> => httpGet(portOf(srv), p);
  try {
    const leak = /(^|[:"\s#])(ana|bob)(?=$|[:"\s,.])/;
    const list = await fetchJ('/api/debug/engine?room=ladenie');
    assert.strictEqual(list.status, 200);
    const rows = rowsOf(parseJson<TimelineReply>(list.body));
    for (const r of rows) {
      const d = await fetchJ('/api/debug/engine?room=ladenie&n=' + String(r.n));
      assert.strictEqual(d.status, 200);
      assert.ok(!leak.test(d.body), `kľúč hráča v dávke #${String(r.n)}: ${(new RegExp('.{40}' + leak.source + '.{40}').exec(d.body) || [])[0] ?? ''}`);
      assert.ok(!d.body.includes(must(w.seed ?? undefined)));
    }
    const all = (await Promise.all(rows.map(r => fetchJ('/api/debug/engine?room=ladenie&n=' + String(r.n))))).map(x => x.body).join('');
    assert.ok(all.includes('save:' + Debug.keyId('ana')) && all.includes('save:' + Debug.keyId('bob')), 'kľúče výrezov');
    assert.ok(all.includes('event:scavDone:' + Debug.keyId('ana')), 'kľúč vo vnútri kľúča udalosti');
    assert.ok(all.includes('"Ana"'), 'meno ostáva (je verejné ako v zozname online)');
    const q = await fetchJ('/api/debug/engine?room=ladenie&view=queue');
    assert.ok(!leak.test(q.body) && parseJson<QueueReply>(q.body).queue.length);
    assert.strictEqual((await fetchJ('/api/debug/engine?room=nikto')).body, json({ room: 'nikto', loaded: false, rows: [] }));
  } finally { srv.close(); }
});

// ---- server ----
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = portOf(srv); srv.close(() => { r(p); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000', DEBUG_TRACE: '300' }), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(String(d)));
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }
// Klient: zbiera správy, čaká na konkrétnu – wait(typ, podmienka) vráti prvú takú (už prijatú alebo budúcu)
interface Client {
  ws: WebSocket;
  wait<T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number): Promise<MsgOf<T>>;
  send(m: ClientMessage): void;
}
function client(port: number, room: string, name: string): Promise<Client> {
  const ws = new WebSocket('ws://127.0.0.1:' + port), got: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => unknown; res: (m: ServerMessage) => void }[] = [];
  ws.on('message', raw => { const m = parseMsg(raw); got.push(m); for (const wt of waiters.slice()) if (wt.pred(m)) { waiters.splice(waiters.indexOf(wt), 1); wt.res(m); } });
  const wait = <T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number): Promise<MsgOf<T>> => new Promise((res, rej) => {
    const pred = (m: ServerMessage): m is MsgOf<T> => isMsg(m, t) && (!test || !!test(m));
    const f = got.find(pred); if (f) { res(f); return; }
    const tm = setTimeout(() => { rej(new Error('nedošlo: ' + t + ' ' + String(test))); }, ms || 3000);
    waiters.push({ pred, res: m => { clearTimeout(tm); if (pred(m)) res(m); } });
  });
  return new Promise(r => ws.on('open', () => { void (async () => { ws.send(json({ t: 'join', room, name })); await wait('welcome'); r({ ws, wait, send: m => { ws.send(json(m)); } }); })(); }));
}
// JSON odpoveď servera (tvar podľa požiadavky)
const httpJ = async <T,>(port: number, p: string): Promise<T> => parseJson<T>((await httpGet(port, p)).body);

test('server: dobiehanie po načítaní je v pamäti, filter správ (odložená druhá akcia, zlúčené pohyby) a súboj o políčko sú vidieť', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-srv-'));
  const port = await freePort();
  const w = makeWorld(6);
  delete w.presence;
  const ti = tillable(w), t0 = must(ti[0]);
  const px = t0 % D.W + 1.5, py = Math.floor(t0 / D.W) + 0.5;
  for (const k of ['ana', 'bob']) Object.assign(save(w, k), { x: px, y: py, area: 'garden', look: { shirt: '#000', hair: '#000', hat: false }, talked: true });
  save(w, 'ana').inv[`seed_${SP}`] = 2;
  // svet beží a server bol pol dňa vypnutý: načítanie dobehne čas (DAY_SECONDS je veľký – wall posunieme o pol dňa podľa uloženej dĺžky)
  const save9 = Object.assign(parseJson<JsonRecord>(json(Object.assign({}, w, { trace: undefined }))), { v: 9, mode: 'running', daySeconds: 100000, wall: Date.now() - 0.5 * 100000 * 1000, tiles: w.tiles.map(t => ({ s: t.s })), hory: Ice.saveHory(w.hory), les: null, pomedzieSeed: 1, lesSeed: 1 });
  fs.writeFileSync(path.join(dir, 'room-ladenie.json'), json(save9));
  const proc = await startServer(dir, port);
  let ana: Client | undefined, bob: Client | undefined;
  try {
    ana = await client(port, 'ladenie', 'Ana'); bob = await client(port, 'ladenie', 'Bob');
    const A = ana, B = bob;
    const x = t0 % D.W, y = Math.floor(t0 / D.W);
    A.send({ t: 'act', x, y, item: 'hoe' }); B.send({ t: 'act', x, y, item: 'hoe' });
    await A.wait('tile', m => m.i === t0 && m.v.s);
    await Promise.race([A.wait('toast', m => m.text === 'Tu už je záhon.'), B.wait('toast', m => m.text === 'Tu už je záhon.')]);
    // dve akcie na políčku od jednej hráčky v jednom rámci + dva pohyby: druhá akcia počká, starší pohyb sa zlúči
    // (dávka správ naraz, aby aspoň dve padli do jedného rámca aj na vyťaženom stroji)
    for (let i = 0; i < 6; i++) A.send({ t: 'move', x: px, y: py + i * 0.01, dir: 0, ar: 0 });
    A.send({ t: 'act', x, y, item: `seed_${SP}` }); A.send({ t: 'act', x, y, item: 'can' }); A.send({ t: 'act', x, y, item: 'can' });
    await A.wait('tile', m => m.i === t0 && m.v.s?.p && m.v.s.w === 1);
    const list = await httpJ<TimelineReply>(port, '/api/debug/engine?room=ladenie');
    assert.strictEqual(list.loaded, true);
    assert.ok(list.kept <= 300);
    const rows = rowsOf(list);
    assert.ok(rows.some(r => r.source === 'catchup' && r.kind === 'events'), 'dávky z dobiehania');
    const clash = rows.find(r => r.source === 'frame' && r.held === 1 && r.rejected === 1 && 'types' in r && r.types.includes('till'));
    assert.ok(clash, 'súboj o políčko');
    const d = await httpJ<DetailReply>(port, '/api/debug/engine?room=ladenie&n=' + String(clash.n));
    const till = must(must(must(d.rounds)[1]).proposals[0]);
    assert.deepStrictEqual([till.type, till.outcome, till.msg], ['till', 'rejected', 'Tu už je záhon.']);
    const tm = d.row.timing || {};
    assert.ok((tm['filter'] ?? -1) >= 0 && (tm['evaluate'] ?? -1) >= 0 && (tm['notify'] ?? -1) >= 0 && (tm['journal'] ?? -1) >= 0);
    let deferred: DetailReply['filter'][number] | undefined, coalesced: DetailReply['filter'][number] | undefined;
    for (const r of rows.filter(v => v.source === 'frame')) {
      const dd = await httpJ<DetailReply>(port, '/api/debug/engine?room=ladenie&n=' + String(r.n));
      deferred = deferred || dd.filter.find(f => f.what === 'deferred' && f.t === 'act');
      coalesced = coalesced || dd.filter.find(f => f.what === 'coalesced' && f.t === 'move');
    }
    assert.ok(deferred, 'odložená akcia na políčku');
    assert.ok(coalesced, 'zlúčený pohyb');
    assert.match(deferred.rule, /one tile action per player per frame/);
    assert.strictEqual(deferred.actor?.key, Debug.keyId('ana'));
    assert.match(coalesced.rule, /latest move/);
    // ten istý súboj v denníku na disku (záložka Journal), kľúče hráčov odstránené
    const httpRaw = async (p: string): Promise<string> => (await httpGet(port, p)).body;
    const leak = /(^|[:"\s#])(ana|bob)(?=$|[:"\s,.])/;
    const jl = await httpRaw('/api/debug/journal?room=ladenie&type=till');
    assert.ok(!leak.test(jl), jl.slice(0, 300));
    const jt = parseJson<JournalList>(jl);
    assert.ok(jt.rows.length && jt.players.some(p => p.id === Debug.keyId('ana') && p.name === 'Ana'), json(jt.players));
    const one = await httpRaw('/api/debug/journal?room=ladenie&g=' + String(must(jt.rows.find(r => r.rejected)).g));
    assert.ok(!leak.test(one));
    assert.ok(must(parseJson<JournalOne>(one).rounds?.[1]).proposals.some(p => p.msg === 'Tu už je záhon.'));
    assert.ok(parseJson<JournalList>(await httpRaw('/api/debug/journal?room=ladenie&kind=load')).matched >= 1);
  } finally {
    for (const c of [ana, bob]) if (c) c.ws.close();
    await stopServer(proc);
  }
});

// ---- záložka Journal: denník na disku ----

test('denník: riadky od najnovšieho, filtre (druh, typ, hráč odtlačkom, osud, kľúč, kroky, pohyby), strany, dočítanie a otočenie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-journal-'));
  const file = path.join(dir, 'journal-x.jsonl');
  const w = makeWorld(7);
  toStall(w, 'ana', 'bob'); // obchoduje sa pri stánku
  setStock(w, `seed_${SP}`, 1);
  const spec: Spec = { ...traced(w), onBatch: (x, out) => { fs.appendFileSync(file, json(Object.assign({ wall: 1700000000000 }, out.entry)) + '\n'); } };
  fs.writeFileSync(file, json({ wall: 1700000000000, load: true, tick: w.tick, step: 0, seq: 0, migratedFrom: null }) + '\n');
  E.commitBatch(w, [act('pos', 'ana', { x: 10.5, y: 10.5 })], spec);
  E.commitBatch(w, [act('buy', 'ana', { id: `seed_${SP}`, n: 1 }), act('buy', 'bob', { id: `seed_${SP}`, n: 1 })], spec);
  E.advanceTo(w, w.tick + TPD, spec);
  const keys = new Set<unknown>();
  const tl: Pick<Tools, 'ROOM_RE' | 'journalFiles' | 'load' | 'redactKeys'> = {
    ROOM_RE: /^[a-z0-9-]{1,16}$/, journalFiles: () => [file + '.1', file].filter(f => fs.existsSync(f)).map(f => ({ path: f, name: path.basename(f) })),
    load: () => partial<Loaded>({ state: partial<Loaded['state']>({ saves: { ana: partial<PlayerSave>({}), bob: partial<PlayerSave>({}) } }) }), redactKeys: l => { (l || []).forEach(k => keys.add(k)); }
  };
  // odpoveď ako JSON (tak ju dostane stránka)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- tvar odpovede určuje volajúci podľa druhu požiadavky (ako parseJson)
  const q = <T = JournalList,>(p: Record<string, string | number>): T => {
    const params = new URLSearchParams({ room: 'x' });
    for (const [k, v] of Object.entries(p)) params.set(k, String(v));
    return parseJson<T>(json(journalApi(params, tl)));
  };
  const all = q({});
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  assert.strictEqual(all.total, lines);
  assert.ok(all.rows.every((r, i) => i === 0 || must(all.rows[i - 1]).g > r.g), 'od najnovšieho');
  assert.strictEqual(must(all.rows[all.rows.length - 1]).kind, 'load');
  assert.deepStrictEqual([...keys].map(String).sort(), ['ana', 'bob'], 'kľúče hráčov idú na odstránenie');
  assert.ok(all.types.includes('dawn') && all.types.includes('buy'));
  assert.strictEqual(q({ kind: 'load' }).matched, 1);
  assert.ok(q({ kind: 'events' }).rows.every(r => r.kind === 'events'));
  const buys = q({ type: 'buy' }), buy0 = must(buys.rows[0]);
  assert.strictEqual(buys.matched, 1);
  assert.deepStrictEqual([buy0.applied, buy0.held, buy0.rejected], [1, 1, 1]);
  assert.strictEqual(q({ outcome: 'held' }).rows.filter(r => r.types.includes('buy')).length, 1);
  assert.strictEqual(q({ actor: Debug.keyId('bob') }).matched, 1, 'hráč podľa odtlačku');
  assert.strictEqual(q({ actor: 'Ana' }).matched, 2, 'alebo podľa mena');
  assert.strictEqual(q({ key: 'save:' + Debug.keyId('bob') }).matched, 1, 'kľúč s odtlačkom hráča');
  assert.strictEqual(q({ moves: '0', kind: 'actions' }).matched, 1, 'samotný pohyb bez sporu sa dá skryť');
  const dawnTick = must(q({ type: 'dawn' }).rows[0]).tick;
  assert.ok(q({ from: dawnTick, to: dawnTick }).rows.every(r => r.tick === dawnTick));
  // vylúčenie typu, viac osudov naraz, voľný text bez diakritiky, počty pre čipy
  assert.ok(q({ type: '-pos,-dawn' }).rows.every(r => !r.types.includes('pos') && !r.types.includes('dawn')));
  assert.ok(q({ type: '-pos' }).rows.some(r => r.kind === 'load'), 'vylúčenie nechá aj značky načítania');
  assert.strictEqual(q({ type: 'buy,pos' }).matched, 2);
  assert.strictEqual(q({ outcome: 'rejected,error' }).rows.filter(r => r.types.includes('buy')).length, 1);
  assert.strictEqual(q({ q: 'vypredane' }).matched, 1, 'hlásenie odmietnutia, bez diakritiky');
  assert.strictEqual(q({ q: `VYPREDANÉ seed_${SP}` }).matched, 1, 'všetky slová');
  assert.strictEqual(q({ q: 'vypredane dawn' }).matched, 0);
  assert.strictEqual(q({ q: 'save:' + Debug.keyId('bob') }).matched, 1, 'odtlačok hráča aj v texte');
  const f = q({ type: 'buy' }).facets;
  assert.strictEqual(f.type['buy'], 1);
  assert.ok((f.type['dawn'] ?? 0) >= 1, 'počet typu ráta s ostatnými filtrami, nie so samotným filtrom typu');
  assert.deepStrictEqual([f.actor['ana'], f.actor['bob']], [1, 1]);
  assert.strictEqual(f.outcome.held, 1);
  assert.deepStrictEqual(q({ outcome: 'held' }).facets.kind.actions, 1);
  assert.strictEqual(q({ moves: '0' }).rows.filter(r => r.types.length === 1 && r.types[0] === 'pos').length, 0);
  // strany: limit + kurzor
  const p1 = q({ limit: 5 }), p2 = q({ limit: 5, before: must(p1.next ?? undefined) });
  assert.strictEqual(p1.rows.length, 5);
  assert.strictEqual(must(p2.rows[0]).g, must(p1.rows[4]).g - 1);
  // jeden záznam: rozobraný ako v záložke Engine
  const d = q<JournalOne>({ g: buy0.g });
  assert.deepStrictEqual(must(d.rounds).map(r => r.proposals.map(p => p.outcome)), [['applied', 'held'], ['rejected']]);
  assert.strictEqual(d.row.source, 'journal');
  assert.ok(q<JournalLoadReply>({ g: must(all.rows[all.rows.length - 1]).g }).load.load);
  // dočítanie: pribudne riadok (aj neúplný koniec počká), potom otočenie na .1
  const before = q({}).total;
  fs.appendFileSync(file, json({ wall: 1, load: true, tick: w.tick, step: w.step, seq: w.seq }) + '\n{"wall":2,"load":tr');
  assert.strictEqual(q({}).total, before + 1);
  fs.appendFileSync(file, 'ue,"tick":5}\n');
  assert.strictEqual(q({}).total, before + 2);
  fs.renameSync(file, file + '.1');
  fs.writeFileSync(file, json({ wall: 3, load: true, tick: 9, step: 0, seq: 0 }) + '\n');
  const rot = q({});
  assert.strictEqual(rot.total, before + 3);
  assert.deepStrictEqual(rot.files.map(x => x.name), ['journal-x.jsonl.1', 'journal-x.jsonl']);
  assert.strictEqual(must(rot.rows[0]).tick, 9);
});
