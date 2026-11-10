// #159: stopy v snehu – pravidlo snehu, generátor stôp (krok, striedanie nôh, skok), strop na plochu, miznutie,
// zasypanie čerstvým snehom, cheaty a skutočný server (všetci vidia tie isté stopy, aj kto príde neskôr).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { AreaId, Ground } from '../src/shared/data.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import * as T from '../src/shared/tracks.ts';
import type { TrackMark, Walker } from '../src/shared/tracks.ts';
import * as Tracks from '../src/server/tracks.ts';
import type { TrackWorld } from '../src/server/tracks.ts';
import * as Cheats from '../src/server/cheats.ts';
import * as E from '../src/server/engine.ts';
import tracksApi from '../src/server/debug-api/tracks.ts';
import type { TracksView } from '../src/server/debug-api/tracks.ts';
import { ROOM_RE } from '../src/server/debug.ts';
import type { Tile } from '../src/server/world.ts';
import { SPEC, makeWorld } from './game-world.ts';
import { isMsg, must, parseJson, parseMsg, portOf } from './helpers.ts';
import type { MsgOf, MsgType } from './helpers.ts';

const WINTER = 3, SUMMER = 1;
const tile = (g: Ground, s?: unknown): { g: Ground; s?: unknown } => (s === undefined ? { g } : { g, s });

test('sneh: záhrada len v zime (tráva, chodník, piesok…), nie voda, budovy ani záhony; hory snehové pole vždy, lúka v zime; lesy nikdy', () => {
  for (const g of ['grass', 'path', 'sand', 'gate', 'ring'] as const) {
    assert.ok(T.isSnowSurface('garden', WINTER, tile(g)), g);
    assert.ok(!T.isSnowSurface('garden', SUMMER, tile(g)), g + ' v lete');
  }
  for (const g of ['water', 'house', 'hut', 'stall', 'well', 'cauldron', 'icehouse', 'dielna', 'rock', 'tree', 'forest'] as const) assert.ok(!T.isSnowSurface('garden', WINTER, tile(g)), g);
  assert.ok(!T.isSnowSurface('garden', WINTER, tile('grass', { k: 'normal' })), 'obrobený záhon');
  assert.ok(T.isSnowSurface('hory', SUMMER, tile('snow')) && T.isSnowSurface('hory', WINTER, tile('snow')));
  assert.ok(T.isSnowSurface('hory', WINTER, tile('alp')) && !T.isSnowSurface('hory', SUMMER, tile('alp')));
  for (const g of ['glacier', 'water', 'cliff', 'spruce'] as const) assert.ok(!T.isSnowSurface('hory', WINTER, tile(g)), g);
  for (const a of ['pomedzie', 'les'] as const) for (const g of ['meadow', 'grass', 'path', 'moss', 'snow'] as const) assert.ok(!T.isSnowSurface(a, WINTER, tile(g)), a + ' ' + g);
  assert.ok(!T.isSnowSurface('garden', WINTER, null));
  // bod na ploche: políčko pod bodom, mimo plochy nič
  const at = T.snowAt('garden', WINTER, [tile('grass'), tile('water')], 2, 1);
  assert.ok(at(0.5, 0.5) && !at(1.5, 0.5) && !at(-0.1, 0.5) && !at(0.5, 1.2));
});

// tvor kráča po priamke z (x0, y) po (x1, y) v krokoch d
function stroll(k: T.TrackKind, x0: number, x1: number, y: number, d: number, snow: (x: number, y: number) => boolean, tick = 1000): TrackMark[] {
  let w: Walker | undefined;
  const out: TrackMark[] = [];
  for (let i = 0, n = Math.round((x1 - x0) / d); i <= n; i++) { const x = x0 + i * d, r = T.walk(w, k, 'garden', x, y, snow, tick, T.TRACKS.life); w = r.w; out.push(...r.marks); }
  return out;
}

test('stopy: krok podľa druhu, šľapaje sa striedajú vľavo a vpravo, smer pohybu; mimo snehu nič', () => {
  const all = (): boolean => true;
  const feet = stroll('foot', 1, 6.5, 3, 0.1, all);
  assert.ok(Math.abs(feet.length - 5.5 / T.TRACKS.stride.foot) <= 1, String(feet.length));
  feet.forEach((m, i) => {
    assert.strictEqual(m.k, 'foot');
    assert.strictEqual(m.s === 1, i % 2 === 1, 'striedanie nôh');
    assert.ok(Math.abs(Math.abs(m.y - 3) - T.TRACKS.side) < 0.011, 'šľapaj vedľa stredu chôdze');
    assert.strictEqual(m.a, 0, 'smer na východ');
    assert.strictEqual(m.e - m.t, T.TRACKS.life);
  });
  for (let i = 1; i < feet.length; i++) assert.ok(Math.abs(must(feet[i]).x - must(feet[i - 1]).x - T.TRACKS.stride.foot) < 0.02);
  const sp = stroll('spider', 1, 6.5, 3, 0.1, all);
  assert.ok(sp.length > feet.length && sp.every(m => m.y === 3 && m.s === undefined), 'pavúk: hustejšie, v strede');
  // sneh len na x < 3: stopy len tam
  const part = stroll('foot', 1, 6.5, 3, 0.1, x => x < 3);
  assert.ok(part.length > 0 && part.every(m => m.x < 3));
  // na sever (y klesá): smer -π/2
  let w: Walker | undefined;
  const north: TrackMark[] = [];
  for (let y = 10; y >= 7; y -= 0.2) { const r = T.walk(w, 'runner', 'hory', 4, y, all, 5, 10); w = r.w; north.push(...r.marks); }
  assert.ok(north.length >= 6 && north.every(m => Math.abs(m.a + Math.PI / 2) < 0.01 && m.k === 'runner'));
});

test('stopy: prvá poloha, iná plocha a veľký skok (prechod, oprava polohy) stopu nenechajú', () => {
  const all = (): boolean => true;
  let r = T.walk(undefined, 'foot', 'garden', 5, 5, all, 1, 10);
  assert.strictEqual(r.marks.length, 0);
  r = T.walk(r.w, 'foot', 'garden', 5 + T.TRACKS.jump + 0.5, 5, all, 1, 10);
  assert.strictEqual(r.marks.length, 0, 'skok');
  assert.strictEqual(r.w.acc, 0);
  r = T.walk(r.w, 'foot', 'hory', r.w.x + 1, 5, all, 1, 10);
  assert.strictEqual(r.marks.length, 0, 'iná plocha');
  r = T.walk(r.w, 'foot', 'hory', r.w.x + 1.2, 5, all, 1, 10);
  assert.strictEqual(r.marks.length, 2, 'potom zase normálne');
  const same = T.walk(r.w, 'foot', 'hory', r.w.x, 5, all, 1, 10);
  assert.strictEqual(same.w, r.w, 'státie nič nemení');
});

test('strop na plochu vyhodí najstaršie; miznutie podľa kroku; zmiznuté stopy von; kódovanie do správy', () => {
  const list: TrackMark[] = [];
  const mk = (i: number): TrackMark => ({ k: 'foot', x: i, y: 0, a: 0, t: i, e: i + 100 });
  T.addMarks(list, Array.from({ length: 10 }, (_, i) => mk(i)), 4);
  assert.deepStrictEqual(list.map(m => m.x), [6, 7, 8, 9]);
  T.addMarks(list, Array.from({ length: T.TRACKS.cap + 50 }, (_, i) => mk(i)));
  assert.strictEqual(list.length, T.TRACKS.cap);
  const m = mk(0);
  assert.strictEqual(T.markFade(m, 0), 1);
  assert.strictEqual(T.markFade(m, 50), 0.5);
  assert.strictEqual(T.markFade(m, 100), 0);
  assert.strictEqual(T.markFade(m, 1e6), 0);
  const few = [mk(0), mk(50), mk(200)];
  assert.strictEqual(T.pruneMarks(few, 150), 2);
  assert.deepStrictEqual(few.map(x => x.x), [200]);
  for (const k of T.TRACK_KINDS) for (const s of [undefined, 1] as const) {
    if (s && k !== 'foot') continue;
    const o: TrackMark = { k, x: 1.25, y: 2.5, a: -1.57, t: 7, e: 99, ...(s ? { s } : {}) };
    assert.deepStrictEqual(T.decode(T.encode(o)), o);
  }
  assert.strictEqual(T.decode([1, 2, 3, 9, 4, 5]), null);
  assert.strictEqual(T.decode([1, 2]), null);
  // kým sneží, stopa vydrží kratšie
  assert.ok(T.lifeFor('snow') < T.lifeFor('sun') && T.lifeFor('rain') === T.lifeFor('sun'));
  assert.ok(T.TRACKS.life >= 2 * D.TICKS_PER_HOUR, 'mizne niekoľko herných hodín');
  // ukážka: každý druh, rovná cesta
  for (const k of T.TRACK_KINDS) assert.ok(T.demoTrail(k, 5, 10, -Math.PI / 2, 8, 0).length >= 7);
});

// ---- Server: stopy v pamäti (server/tracks.ts) ----
let roomN = 0;
function trackWorld(tick: number, garden: Ground = 'grass'): TrackWorld {
  const n = D.W * D.H;
  const tiles: Tile[] = Array.from({ length: n }, () => ({ g: garden }));
  tiles[5 * D.W + 5] = { g: 'water' };
  return { id: 'tr' + String(++roomN), tick, weather: 'sun', tiles, hory: Array.from({ length: n }, () => ({ g: 'snow' })), pomedzie: Array.from({ length: n }, () => ({ g: 'meadow' })), les: [] };
}
const WINTER_TICK = 12 * D.TICKS_PER_DAY + D.DAWN_TICK, SUMMER_TICK = 4 * D.TICKS_PER_DAY + D.DAWN_TICK;
// hráč kráča po riadku y z x0 do x1 (rámec = 0,3 políčka); vráti správy všetkých rámcov
function walkRoom(w: TrackWorld, id: string, area: AreaId, x0: number, x1: number, y: number): [AreaId, Tracks.TracksMsg][] {
  const out: [AreaId, Tracks.TracksMsg][] = [];
  for (let x = x0; x <= x1; x += 0.3) out.push(...Tracks.frame(w, [{ id, k: 'foot', area, x, y }]));
  return out;
}

test('server: stopy len na snehu (zima v záhrade, hory celý rok), správy len s novými stopami', () => {
  const w = trackWorld(WINTER_TICK);
  const msgs = walkRoom(w, 'p1', 'garden', 1, 9, 5.5);
  const marks = msgs.flatMap(([, m]) => m.add.map(T.decode).filter((t): t is TrackMark => !!t));
  assert.ok(marks.length > 8);
  assert.ok(msgs.every(([a, m]) => a === 'garden' && !m.full));
  assert.ok(!marks.some(m => Math.floor(m.x) === 5 && Math.floor(m.y) === 5), 'cez zamrznutú vodu bez stôp');
  assert.strictEqual(Tracks.counts(w.id).garden, marks.length);
  assert.strictEqual(Tracks.view(w.id, 'garden').add.length, marks.length);
  assert.strictEqual(Tracks.view(w.id, 'garden').full, 1);
  // v lete v záhrade nič, v horách áno (snehové pole), v Lese na pomedzí nikdy
  const s = trackWorld(SUMMER_TICK);
  assert.strictEqual(walkRoom(s, 'p1', 'garden', 1, 9, 2.5).length, 0);
  assert.ok(walkRoom(s, 'p1', 'hory', 1, 9, 2.5).length > 0);
  assert.strictEqual(walkRoom(s, 'p1', 'pomedzie', 1, 9, 2.5).length, 0);
});

test('server: stopy miznú s časom, strop na plochu, kto zmizne, začne odznova', () => {
  const w = trackWorld(WINTER_TICK);
  walkRoom(w, 'p1', 'garden', 1, 9, 3.5);
  const n = Tracks.counts(w.id).garden;
  assert.ok(n > 0);
  w.tick += T.TRACKS.life - 1;
  Tracks.frame(w, []);
  assert.strictEqual(Tracks.counts(w.id).garden, n, 'ešte tam sú');
  w.tick += 2;
  Tracks.frame(w, []);
  assert.strictEqual(Tracks.counts(w.id).garden, 0, 'zmizli');
  assert.strictEqual(Tracks.storeOf(w.id).walkers.size, 0, 'hráč bez polohy sa zabudne');
  // strop: veľa chodenia hore-dole
  for (let i = 0; i < 40; i++) walkRoom(w, 'p1', 'garden', 1, 18, 1.5 + (i % 30));
  assert.strictEqual(Tracks.counts(w.id).garden, T.TRACKS.cap);
});

test('server: keď začne snežiť, čerstvý sneh zasype všetky stopy; kým sneží, nové stopy vydržia kratšie', () => {
  const w = trackWorld(WINTER_TICK);
  walkRoom(w, 'p1', 'garden', 1, 9, 3.5);
  walkRoom(w, 'p1', 'hory', 1, 9, 3.5);
  assert.ok(Tracks.counts(w.id).garden > 0 && Tracks.counts(w.id).hory > 0);
  w.weather = 'snow';
  const out = Tracks.frame(w, []);
  assert.deepStrictEqual(out.map(([a, m]) => [a, m.full, m.add.length]).sort(), [['garden', 1, 0], ['hory', 1, 0]]);
  assert.deepStrictEqual(Object.values(Tracks.counts(w.id)), [0, 0, 0, 0]);
  const fresh = walkRoom(w, 'p2', 'garden', 1, 9, 7.5).flatMap(([, m]) => m.add);
  assert.ok(fresh.length > 0, 'aj počas sneženia sa šliape');
  assert.ok(fresh.every(t => t[5] - t[4] === T.TRACKS.snowLife));
  Tracks.frame(w, []);
  assert.ok(Tracks.counts(w.id).garden > 0, 'sneží ďalej – nové stopy sa už nezasypú naraz');
  // svet, ktorý sa načítal, keď už snežilo, nič nezasype (stopy po reštarte aj tak nie sú)
  const w2 = trackWorld(WINTER_TICK);
  w2.weather = 'snow';
  assert.deepStrictEqual(Tracks.frame(w2, []), []);
});

test('server: vyčistenie a ukážka (ladiaca stránka); /api/debug/tracks ukáže počty a stopy plochy', () => {
  const w = trackWorld(WINTER_TICK);
  walkRoom(w, 'p1', 'garden', 1, 9, 3.5);
  const demo = Tracks.demo(w, 'hory', 10, 20);
  const kinds = new Set(must(demo[0])[1].add.map(t => must(T.decode(t) ?? undefined).k));
  assert.deepStrictEqual([...kinds].sort(), ['foot', 'runner', 'spider']);
  const q = (s: string): TracksView => must(tracksApi(new URLSearchParams(s), { ROOM_RE }) ?? undefined);
  const v = q(`room=${w.id}&area=hory`);
  assert.strictEqual(v.loaded, true);
  assert.ok(v.counts.garden > 0 && v.counts.hory === v.list.length && v.list.length > 0);
  assert.strictEqual(v.cap, T.TRACKS.cap);
  assert.strictEqual(q('room=nikto').loaded, false);
  assert.strictEqual(tracksApi(new URLSearchParams('room=ZLE!'), { ROOM_RE }), null);
  assert.deepStrictEqual(Tracks.clear(w.id, 'garden').map(([a]) => a), ['garden']);
  assert.strictEqual(Tracks.counts(w.id).garden, 0);
  assert.ok(Tracks.counts(w.id).hory > 0);
  assert.deepStrictEqual(Tracks.clear(w.id, null).map(([a]) => a), ['hory']);
  assert.deepStrictEqual(Tracks.clear(w.id, null), []);
});

test('cheat: počasie (vstup enginu, len slnko a sneh) a požiadavky na stopy', () => {
  const w = makeWorld(3);
  const spec = { ...SPEC, proposers: { ...SPEC.proposers, ...Cheats.PROPOSERS } };
  const out = E.commitBatch(w, [{ type: 'cheat', data: { op: 'weather', w: 'snow' }, id: 'cheat#1' }], spec);
  assert.deepStrictEqual(out.entry.proposals.map(p => p.outcome), ['applied']);
  assert.strictEqual(w.weather, 'snow');
  assert.deepStrictEqual(out.entry.proposals[0]?.writes, ['weather'], 'v denníku: cheat zapisuje počasie');
  const room = { id: 'x', tick: 0, saves: {}, players: new Map<number, { key: string; name: string }>() };
  assert.deepStrictEqual(Cheats.parseCheat(room, { op: 'weather', w: 'sun' }, k => k), { op: 'weather', w: 'sun' });
  assert.throws(() => Cheats.parseCheat(room, { op: 'weather', w: 'rain' }, k => k));
  assert.strictEqual(Cheats.parseCheat(room, { op: 'tracks', do: 'clear' }, k => k), null);
  assert.deepStrictEqual(Cheats.parseTracks({ do: 'clear' }), { do: 'clear', area: null });
  assert.deepStrictEqual(Cheats.parseTracks({ do: 'clear', area: 'hory' }), { do: 'clear', area: 'hory' });
  assert.deepStrictEqual(Cheats.parseTracks({ do: 'demo', area: 'garden', x: 99, y: 3 }), { do: 'demo', area: 'garden', x: D.W, y: 3 });
  assert.throws(() => Cheats.parseTracks({ do: 'demo', x: 1, y: 1 }));
  assert.throws(() => Cheats.parseTracks({ do: 'clear', area: 'mesiac' }));
  assert.throws(() => Cheats.parseTracks({ do: 'zmaz' }));
});

// ---- Skutočný server: hráč šliape po snehu, druhý to vidí, tretí po príchode dostane celý zoznam, sneh ich zasype ----
const freePort = (): Promise<number> => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = portOf(s); s.close(() => { r(p); }); }); });
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number, key: string): Promise<Server> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused', DEBUG_CHEATS_KEY: key, JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.on('data', (d: Buffer) => { err += String(d); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server sa nespustil\n' + err)); }, 8000);
    child.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(child); } });
    child.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c) + '\n' + err)); });
  });
}
function stopServer(proc: Server): Promise<void> {
  return new Promise(r => {
    proc.removeAllListeners('exit');
    if (proc.exitCode !== null || proc.signalCode !== null) { r(); return; }
    proc.on('exit', () => { r(); }); proc.kill('SIGTERM');
  });
}
function request(port: number, method: string, urlPath: string, body?: unknown, key?: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
    if (key !== undefined) headers['X-Cheat-Key'] = key;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let text = '';
      res.on('data', (d: Buffer) => { text += String(d); });
      res.on('end', () => { resolve({ code: res.statusCode ?? 0, text }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
interface Client { ws: WebSocket; msgs: ServerMessage[]; open: () => Promise<void>; send: (m: ClientMessage) => void; wait: <K extends MsgType>(t: K, pred?: (m: MsgOf<K>) => unknown, ms?: number) => Promise<MsgOf<K>> }
function client(port: number): Client {
  const ws = new WebSocket('ws://127.0.0.1:' + port), msgs: ServerMessage[] = [];
  ws.on('message', raw => { msgs.push(parseMsg(raw)); });
  const wait = async <K extends MsgType>(t: K, pred?: (m: MsgOf<K>) => unknown, ms = 5000): Promise<MsgOf<K>> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = msgs.findIndex(m => isMsg(m, t) && (!pred || !!pred(m)));
      const m = i >= 0 ? msgs.splice(i, 1)[0] : undefined;
      if (m && isMsg(m, t)) return m;
      if (Date.now() > end) throw new Error('správa ' + t + ' neprišla');
      await new Promise(r => setTimeout(r, 20));
    }
  };
  return { ws, msgs, open: () => new Promise(r => ws.on('open', () => { r(); })), send: m => { ws.send(JSON.stringify(m)); }, wait };
}

test('server: stopy hráča vidia všetci na ploche, kto príde neskôr, dostane celý zoznam; sneh z cheatu ich zasype', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-tracks-')), port = await freePort(), KEY = 'kluc';
  // starý svet (v3, krok sa pri prevode násobí 40×): zima, deň 13, poludnie, slnečno; Eva stojí na tráve
  const save = {
    v: 3, tick: 3600, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun',
    saves: { eva: { coins: 5, water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, plots: 0, composter: 0 }, x: 2.5, y: 20.5, area: 'garden' } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, tiles: D.buildMap().map(() => ({ s: null }))
  };
  assert.strictEqual(D.seasonOf(D.dayOfTick(3600 * 40)), 3);
  fs.writeFileSync(path.join(dir, 'room-snih.json'), JSON.stringify(save));
  const srv = await startServer(dir, port, KEY);
  const all: Client[] = [];
  try {
    const join = async (name: string): Promise<Client> => {
      const c = client(port); all.push(c);
      await c.open();
      c.send({ t: 'join', room: 'snih', name });
      await c.wait('welcome');
      return c;
    };
    const eva = await join('Eva'), bob = await join('Bob');
    assert.deepStrictEqual((await bob.wait('tracks', m => m.full)).add, [], 'zatiaľ žiadne stopy');
    for (let x = 2.5; x <= 8.5; x += 0.3) { eva.send({ t: 'move', x, y: 20.5, dir: 0, ar: 0 }); await new Promise(r => setTimeout(r, 110)); }
    await new Promise(r => setTimeout(r, 300));
    const seen = bob.msgs.filter((m): m is MsgOf<'tracks'> => isMsg(m, 'tracks') && !m.full).flatMap(m => m.add);
    assert.ok(seen.length >= 6, 'Bob vidí Evine stopy: ' + String(seen.length));
    assert.ok(seen.every(t => t[0] >= 2.4 && t[0] <= 8.6 && Math.abs(t[1] - 20.5) < 0.2));
    const cyril = await join('Cyril');
    const full = await cyril.wait('tracks', m => m.full);
    assert.ok(full.add.length >= seen.length, 'neskorší hráč dostane všetky stopy');
    const api = parseJson<TracksView>((await request(port, 'GET', '/api/debug/tracks?room=snih&area=garden')).text);
    assert.strictEqual(api.counts.garden, full.add.length);
    // let it snow: vstup enginu, všetkým na ploche prázdny zoznam
    const r = await request(port, 'POST', '/api/debug/cheat', { room: 'snih', op: 'weather', w: 'snow' }, KEY);
    assert.strictEqual(r.code, 200, r.text);
    assert.deepStrictEqual((await bob.wait('tracks', m => m.full)).add, []);
    assert.strictEqual((await bob.wait('time', m => m.weather === 'snow')).weather, 'snow');
    // ukážka a vyčistenie z ladiacej stránky
    assert.strictEqual((await request(port, 'POST', '/api/debug/cheat', { room: 'snih', op: 'tracks', do: 'demo', area: 'garden', x: 5, y: 20 }, KEY)).code, 200);
    const demo = await bob.wait('tracks', m => !m.full && m.add.some(t => t[3] === 3));
    assert.ok(demo.add.some(t => t[3] === 2) && demo.add.some(t => t[3] <= 1), 'šľapaje, pavúk aj sane');
    assert.strictEqual((await request(port, 'POST', '/api/debug/cheat', { room: 'snih', op: 'tracks', do: 'clear' }, KEY)).code, 200);
    assert.deepStrictEqual((await cyril.wait('tracks', m => m.full && !m.add.length)).add, []);
    const after = parseJson<TracksView>((await request(port, 'GET', '/api/debug/tracks?room=snih&area=garden')).text);
    assert.strictEqual(after.counts.garden, 0, 'vyčistené aj ukážkové stopy');
    assert.strictEqual((await request(port, 'POST', '/api/debug/cheat', { room: 'snih', op: 'tracks', do: 'nic' }, KEY)).code, 400);
  } finally {
    for (const c of all) c.ws.close();
    await stopServer(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
