// #153: cheaty z ladiacej stránky – mince, reputácia, predmety v batohu a sklade, ľad v ľadovni (vstup enginu 'cheat'),
// tajný kľúč, skok v čase a rýchlosť času na skutočnom serveri.
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
import * as D from '../src/shared/data.ts';
import type { SaveFile } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Cheats from '../src/server/cheats.ts';
import * as Areas from '../src/server/areas.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Ice from '../src/server/ice.ts';
import type { Tile } from '../src/server/world.ts';
import type { CheatData } from '../src/server/cheats.ts';
import { keyId } from '../src/server/debug.ts';
import type { Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { SPEC, TPD, makeWorld, save } from './game-world.ts';
import type { W } from './game-world.ts';
import { SAVE_V11 } from './save-v11.fixture.ts';
import { must, parseJson, portOf, readJson, rethrow } from './helpers.ts';

type Spec = E.Spec<W, Presence, Msg>;
const spec: Spec = { ...SPEC, proposers: { ...SPEC.proposers, ...Cheats.PROPOSERS } };
let seq = 0;
const cheat = (data: CheatData): E.Input => ({ type: 'cheat', data, id: 'cheat#' + String(++seq) });
const run = (w: W, data: CheatData, sp: Spec = spec): E.BatchOut<Presence, Msg> => E.commitBatch(w, [cheat(data)], sp);

test('cheat: mince a reputácia sa pridajú alebo nastavia, nikdy pod nulu; najvyššia reputácia záhrady sa prepočíta', () => {
  const w = makeWorld(1);
  run(w, { op: 'coins', key: 'ana', n: 250, set: false });
  assert.strictEqual(save(w, 'ana').coins, 750);
  run(w, { op: 'coins', key: 'ana', n: -1000, set: false });
  assert.strictEqual(save(w, 'ana').coins, 0);
  run(w, { op: 'coins', key: 'bob', n: 42, set: true });
  assert.strictEqual(save(w, 'bob').coins, 42);
  run(w, { op: 'rep', key: 'bob', n: 120, set: true });
  assert.strictEqual(save(w, 'bob').rep, 120);
  assert.strictEqual(w.maxRep, 120);
  run(w, { op: 'rep', key: 'bob', n: 0, set: true });
  assert.strictEqual(w.maxRep, 0);
  const out = run(w, { op: 'coins', key: 'cyril', n: 5, set: false });
  assert.deepStrictEqual(out.entry.proposals.map(p => p.outcome), ['rejected']);
});

test('cheat: predmety v batohu a v sklade – kvety dostanú várku, odoberajú sa najstaršie; hráčom nejde žiadna správa', () => {
  const w = makeWorld(2);
  let out = run(w, { op: 'item', key: 'ana', id: 'fl_mak', n: 5, set: false });
  assert.strictEqual(save(w, 'ana').inv.fl_mak, 5);
  assert.deepStrictEqual(must(save(w, 'ana').fb).fl_mak?.map(b => b.n), [5]);
  assert.deepStrictEqual(out.outbox, []);
  run(w, { op: 'item', key: 'ana', id: 'fl_mak', n: 2, set: true });
  assert.strictEqual(save(w, 'ana').inv.fl_mak, 2);
  assert.deepStrictEqual(must(save(w, 'ana').fb).fl_mak?.map(b => b.n), [2]);
  run(w, { op: 'item', key: 'ana', id: 'fl_mak', n: 0, set: true });
  assert.strictEqual(save(w, 'ana').inv.fl_mak, undefined);
  assert.ok(save(w, 'ana').seen.includes('mak'), 'herbár: kvet je objavený');
  out = run(w, { op: 'item', key: null, id: 'seed_mak', n: 7, set: false });
  assert.strictEqual(w.storage.seed_mak, 7);
  assert.ok(out.entry.proposals.every(p => p.outcome === 'applied'));
});

test('cheat: ľad v ľadovni sa nastaví najviac po kapacitu; sklad začne chladiť bez skoku vo veku kvetov', () => {
  const w = makeWorld(3);
  run(w, { op: 'item', key: null, id: 'fl_mak', n: 3, set: false });
  E.advanceTo(w, w.tick + 100, spec);
  const age = (): number => D.batchAge(must(w.storageFb.fl_mak?.[0]), w.tick, D.STORAGE_AGE_RATE);
  const before = age();
  run(w, { op: 'ice', n: 999, set: true });
  assert.strictEqual(w.icehouse.ice, D.ICEHOUSE.cap);
  assert.strictEqual(must(w.storageFb.fl_mak?.[0]).a, before, 'vek várky je prepočítaný k času zmeny');
});

test('cheat: denník s cheatmi sa prehrá na ten istý svet', () => {
  type Journal = E.JournalEntry<Presence, Msg>[];
  const journal = (j: Journal): Spec => ({ ...spec, onError: rethrow, onBatch: (_w, out) => { j.push(out.entry); } });
  const a = world(4), ja: Journal = [];
  a.tick = 0;
  E.advanceTo(a, a.tick + 10, journal(ja));
  run(a, { op: 'coins', key: 'ana', n: 999, set: false }, journal(ja));
  run(a, { op: 'item', key: 'bob', id: 'fl_ruza', n: 4, set: false }, journal(ja));
  E.advanceTo(a, a.tick + TPD, journal(ja));
  run(a, { op: 'rep', key: 'bob', n: 50, set: false }, journal(ja));
  run(a, { op: 'plot', is: [grassAt(a)], plot: { w: true, r: false, o: 'ana', plant: { sp: 'mak', stage: 'seed', q: 3, dry: 0, dead: false } } }, journal(ja));
  run(a, { op: 'ground', area: 'garden', is: [grassAt(a)], g: 'bush' }, journal(ja));
  E.advanceTo(a, a.tick + TPD, journal(ja));
  const b = world(4);
  b.tick = 0;
  E.replay(b, parseJson<Journal>(JSON.stringify(ja)), spec);
  E.advanceTo(b, a.tick, spec);
  assert.strictEqual(JSON.stringify(b), JSON.stringify(a));
});

test('cheat: kľúč sa musí zhodovať; bez tajomstva na serveri nejde nič', () => {
  assert.strictEqual(Cheats.keyOk('tajne', 'tajne'), true);
  assert.strictEqual(Cheats.keyOk('tajn', 'tajne'), false);
  assert.strictEqual(Cheats.keyOk('', 'tajne'), false);
  assert.strictEqual(Cheats.keyOk(undefined, 'tajne'), false);
  assert.strictEqual(Cheats.keyOk('tajne', undefined), false);
  assert.strictEqual(Cheats.keyOk('', ''), false);
});

// ---- Záhony, zem a budovy ----
// Testovací svet s Dielňou a vrstvou zmenenej zeme (makeWorld ich nemá)
function world(seed: number): W { const w = makeWorld(seed); w.ground = {}; w.dielna = Dielna.newDielna(); w.plotsUsed = 0; return w; }
const grassAt = (w: W, from = 0): number => w.tiles.findIndex((t, i) => i >= from && t.g === 'grass' && !t.s);

test('cheat: záhon s rastlinou v ľubovoľnom štádiu – kvitnúca kvitne od tohto kroku, zarovnanie uvoľní povolenie', () => {
  const w = world(5), i = grassAt(w), sp = D.SPECIES.mak;
  run(w, { op: 'plot', is: [i], plot: { w: true, r: true, o: 'ana', plant: { sp: 'mak', stage: 'bloom', q: 2, dry: 0, dead: false } } });
  const t = must(w.tiles[i]);
  assert.deepStrictEqual(t.s, { k: 'normal', w: 1, r: 1, o: 'ana', p: { sp: 'mak', prog: sp.days, q: 2, dry: 0, bt: w.tick } });
  assert.strictEqual(w.plotsUsed, 1);
  run(w, { op: 'plot', is: [i], plot: { w: false, r: false, o: 'bob', plant: { sp: 'mak', stage: 'grow', q: 3, dry: 1, dead: true } } });
  assert.deepStrictEqual(must(t.s).p, { sp: 'mak', prog: sp.days * 0.5, q: 3, dry: 1, d: 1, why: 'sucho' });
  assert.strictEqual(w.plotsUsed, 1, 'prepísaný záhon sa nepočíta dvakrát');
  run(w, { op: 'plot', is: [i], plot: null });
  assert.strictEqual(t.s, null);
  assert.strictEqual(w.plotsUsed, 0);
  const water = w.tiles.findIndex(x => x.g === 'water');
  assert.deepStrictEqual(run(w, { op: 'plot', is: [water], plot: { w: false, r: false, o: 'ana', plant: null } }).rejected.map(r => r.reject), ['water cannot be tilled']);
});

test('cheat: objekt na políčku – záhon pod ním zmizne, zmena sa dá vrátiť; budovy a prechody sa meniť nedajú', () => {
  const w = world(6), i = grassAt(w);
  run(w, { op: 'plot', is: [i], plot: { w: false, r: false, o: 'ana', plant: null } });
  run(w, { op: 'ground', area: 'garden', is: [i], g: 'sand' });
  assert.strictEqual(must(must(w.tiles[i]).s ?? undefined).k, 'sand', 'záhon ostane, pôda podľa novej zeme');
  assert.strictEqual(w.plotsUsed, 1);
  run(w, { op: 'ground', area: 'garden', is: [i], g: 'tree' });
  assert.strictEqual(must(w.tiles[i]).g, 'tree');
  assert.strictEqual(must(w.tiles[i]).s, null);
  assert.strictEqual(w.plotsUsed, 0);
  assert.deepStrictEqual(w.ground, { garden: { [String(i)]: { g: 'tree', was: 'grass' } } });
  run(w, { op: 'ground', area: 'garden', is: [i], g: 'boulder' });
  assert.deepStrictEqual(w.ground, { garden: { [String(i)]: { g: 'boulder', was: 'grass' } } }, 'pôvodná zem ostáva z generátora');
  run(w, { op: 'ground', area: 'garden', is: [i], g: null });
  assert.strictEqual(must(w.tiles[i]).g, 'grass');
  assert.deepStrictEqual(w.ground, {});
  const house = w.tiles.findIndex(x => x.g === 'house'), gate = w.tiles.findIndex(x => x.g === 'gate');
  for (const j of [house, gate]) assert.deepStrictEqual(run(w, { op: 'ground', area: 'garden', is: [j], g: 'grass' }).entry.proposals.map(p => p.outcome), ['rejected']);
  const rock = w.hory.findIndex(x => x.g === 'scree');
  run(w, { op: 'ground', area: 'hory', is: [rock], g: 'spruce' });
  assert.strictEqual(must(w.hory[rock]).g, 'spruce');
});

test('cheat: zmenená zem v Lese divov sa uloží zvlášť – po uložení a načítaní ostane a dá sa vrátiť na zem z generátora', () => {
  const les = Areas.loadLes(null, 77), i = les.findIndex(t => t.g === 'moss'), base = Areas.saveLes({ les });
  const room = { tiles: [] as Tile[], hory: [] as Tile[], pomedzie: [] as Tile[], les, ground: { les: { [String(i)]: { g: 'log' as const, was: 'moss' as const } } } };
  Areas.applyGround(room, room.ground);
  assert.strictEqual(must(les[i]).g, 'log');
  assert.strictEqual(Areas.saveLes(room), base, 'rozloženie sa uloží bez zmeny');
  const again = { ...room, les: Areas.loadLes(Areas.saveLes(room), 77) };
  Areas.applyGround(again, room.ground);
  assert.strictEqual(must(again.les[i]).g, 'log');
});

test('cheat: budovy – ľadovňa, Dielňa a krosná sa postavia aj zbúrajú; pôda na pozemku sa zarovná, tkanie sa zruší', () => {
  const w = world(7);
  w.icehouse = { built: false, ice: 0, bl: 0 }; Ice.applyIcehouse(w.icehouse, w.tiles);
  const lot = must(Ice.lotIdx()[0]);
  must(w.tiles[lot]).g = 'grass';
  run(w, { op: 'plot', is: [lot], plot: { w: false, r: false, o: 'ana', plant: null } });
  run(w, { op: 'building', what: 'icehouse', on: true });
  assert.ok(w.icehouse.built);
  assert.strictEqual(must(w.tiles[lot]).g, 'icehouse');
  assert.strictEqual(must(w.tiles[lot]).s, null);
  assert.strictEqual(w.plotsUsed, 0);
  run(w, { op: 'ice', n: 5, set: true });
  run(w, { op: 'building', what: 'icehouse', on: false });
  assert.deepStrictEqual([w.icehouse.built, w.icehouse.ice, must(w.tiles[lot]).g], [false, 0, 'lot']);
  run(w, { op: 'building', what: 'loom', on: true });
  assert.deepStrictEqual([w.dielna.built, w.dielna.loom, must(w.tiles[must(Dielna.lotIdx()[0])]).g], [true, true, 'dielna']);
  w.dielna.job = { key: 'ana', at: w.tick + 100 };
  E.commitBatch(w, [], spec);
  const ev = (): boolean => w.events.some(e => e.key === 'loomDone:ana');
  run(w, { op: 'building', what: 'dielna', on: false });
  assert.deepStrictEqual([w.dielna.built, w.dielna.loom, w.dielna.job, ev()], [false, false, null, false]);
});

// ---- Skutočný server ----
const freePort = (): Promise<number> => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = portOf(s); s.close(() => { r(p); }); }); });
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number, key: string): Promise<Server> {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused', DEBUG_CHEATS_KEY: key }), stdio: ['ignore', 'pipe', 'pipe']
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
interface Reply { code: number; body: { error?: string; tick?: number; speed?: number; jump?: number | null } }
function request(port: number, method: string, urlPath: string, body?: unknown, key?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
    if (key !== undefined) headers['X-Cheat-Key'] = key;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let text = '';
      res.on('data', (d: Buffer) => { text += String(d); });
      res.on('end', () => { resolve({ code: res.statusCode ?? 0, body: text ? parseJson<Reply['body']>(text) : {} }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('cheat na serveri: kľúč, mince hráčovi podľa odtlačku, skok v čase, rýchlosť; zmena sa uloží', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-cheat-')), port = await freePort(), KEY = 'tajny-kluc';
  fs.writeFileSync(path.join(dir, 'room-test.json'), JSON.stringify(SAVE_V11));
  const srv = await startServer(dir, port, KEY);
  const post = (body: unknown, key = KEY): Promise<Reply> => request(port, 'POST', '/api/debug/cheat', body, key);
  try {
    assert.strictEqual((await post({ room: 'test', op: 'status' }, 'zly')).code, 403);
    assert.strictEqual((await post({ room: 'test', op: 'status' }, '')).code, 403);
    assert.strictEqual((await request(port, 'GET', '/api/debug/cheat', undefined, KEY)).code, 405);
    assert.strictEqual((await post({ room: 'nikto', op: 'status' })).code, 404);
    assert.strictEqual((await post({ room: 'test', op: 'coins', player: 'p-00000000', n: 1 })).code, 404);
    assert.strictEqual((await post({ room: 'test', op: 'item', player: 'storage', id: 'nic', n: 1 })).code, 400);
    const coins = SAVE_V11.saves.ana.coins;
    const r = await post({ room: 'test', op: 'coins', player: keyId('ana'), n: 100 });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const snap = await request(port, 'GET', '/api/debug/room?id=test');
    assert.strictEqual(snap.code, 200);
    const tick = must(r.body.tick);
    assert.strictEqual((await post({ room: 'test', op: 'jump', tick: tick - 1 })).code, 400);
    const until = tick + 2 * TPD;
    assert.strictEqual((await post({ room: 'test', op: 'jump', tick: until })).body.jump, until);
    let st = (await post({ room: 'test', op: 'status' })).body;
    for (let i = 0; i < 100 && st.jump != null; i++) { await new Promise(res => setTimeout(res, 100)); st = (await post({ room: 'test', op: 'status' })).body; }
    assert.strictEqual(st.jump, null);
    assert.strictEqual(st.tick, until);
    assert.strictEqual((await post({ room: 'test', op: 'speed', x: 3 })).code, 400);
    assert.strictEqual((await post({ room: 'test', op: 'speed', x: 2 })).body.speed, 2);
    // zem a záhon: uložia sa (verzia 12) a po reštarte servera ostanú
    const map = D.buildMap(), grass = map.findIndex((g, i) => g === 'grass' && !SAVE_V11.tiles[i]?.s), grass2 = map.findIndex((g, i) => i > grass && g === 'grass' && !SAVE_V11.tiles[i]?.s);
    assert.strictEqual((await post({ room: 'test', op: 'ground', area: 'garden', i: [grass], g: 'boulder' })).code, 200);
    assert.strictEqual((await post({ room: 'test', op: 'ground', area: 'garden', i: grass, g: 'house' })).code, 400);
    assert.strictEqual((await post({ room: 'test', op: 'plot', i: grass2, w: true, sp: 'mak', stage: 'bloom' })).code, 200);
    await stopServer(srv);
    const saved = readJson<SaveFile>(path.join(dir, 'room-test.json'));
    assert.strictEqual(saved.saves['ana']?.coins, coins + 100);
    assert.ok(saved.tick >= until);
    assert.strictEqual(saved.v, 14);
    assert.deepStrictEqual(saved.ground, { garden: { [String(grass)]: { g: 'boulder', was: 'grass' } } });
    assert.strictEqual(saved.tiles[grass2]?.s?.p?.sp, 'mak');
    const srv2 = await startServer(dir, port, KEY);
    try {
      const w = await new Promise<{ tiles: { g: string }[] }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/debug/world?room=test&area=garden' }, res => { let t = ''; res.on('data', (d: Buffer) => { t += String(d); }); res.on('end', () => { resolve(parseJson(t)); }); }).on('error', reject);
      });
      assert.strictEqual(w.tiles[grass]?.g, 'boulder', 'mapa ukáže zem zmenenú cheatom');
      assert.strictEqual((await post({ room: 'test', op: 'ground', area: 'garden', i: grass, g: null })).code, 200);
    } finally { await stopServer(srv2); }
    assert.deepStrictEqual(readJson<SaveFile>(path.join(dir, 'room-test.json')).ground, {});
    const lines = fs.readFileSync(path.join(dir, 'journal-test.jsonl'), 'utf8').trim().split('\n').map(l => parseJson<{ inputs?: { type: string }[] }>(l));
    assert.ok(lines.some(l => l.inputs?.some(i => i.type === 'cheat')), 'cheat je v denníku');
  } finally { await stopServer(srv); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cheat na serveri: bez DEBUG_CHEATS_KEY sú cheaty vypnuté', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-cheat-')), port = await freePort();
  const srv = await startServer(dir, port, '');
  try {
    assert.strictEqual((await request(port, 'POST', '/api/debug/cheat', { room: 'test', op: 'status' }, '')).code, 404);
  } finally { await stopServer(srv); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cheat: viac políčok naraz – chránené sa preskočia, zlyhá len keď sa nedá zmeniť žiadne', () => {
  const w = world(8), a = grassAt(w), b = grassAt(w, a + 1), house = w.tiles.findIndex(x => x.g === 'house');
  run(w, { op: 'ground', area: 'garden', is: [a, house, b], g: 'bush' });
  assert.deepStrictEqual([must(w.tiles[a]).g, must(w.tiles[house]).g, must(w.tiles[b]).g], ['bush', 'house', 'bush']);
  run(w, { op: 'ground', area: 'garden', is: [a, b], g: null });
  assert.deepStrictEqual(w.ground, {});
  run(w, { op: 'plot', is: [a, b, house], plot: { w: true, r: false, o: 'ana', plant: { sp: 'mak', stage: 'grow', q: 3, dry: 0, dead: false } } });
  assert.strictEqual(w.plotsUsed, 2);
  assert.deepStrictEqual(run(w, { op: 'ground', area: 'garden', is: [house], g: 'grass' }).rejected.map(r => r.reject), ['house cannot be changed']);
});
