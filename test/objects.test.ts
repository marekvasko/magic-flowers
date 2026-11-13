// Umiestnené objekty (#178): pozemky ľadovne a Dielne ako objekty – pôvodné miesta, načítanie uloženia, kam sa pozemok
// smie premiestniť (cheat z ladiacej stránky), zem pod pozemkom, stavba na premiestnenom pozemku, migrácia v14 → v15.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import * as Obj from '../src/shared/objects.ts';
import * as V from '../src/shared/vehicles.ts';
import type { SaveFile } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Cheats from '../src/server/cheats.ts';
import * as Ice from '../src/server/ice.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Actions from '../src/server/actions.ts';
import type { CheatData } from '../src/server/cheats.ts';
import type { Msg } from '../src/server/game.ts';
import type { Presence, Tile } from '../src/server/world.ts';
import { SPEC, makeWorld, save } from './game-world.ts';
import type { W } from './game-world.ts';
import { SAVE_V14 } from './save-v14.fixture.ts';
import { SAVE_V15 } from './save-v15.fixture.ts';
import { isMsg, must, parseMsg, portOf, readJson } from './helpers.ts';
import type { MsgOf } from './helpers.ts';

type Spec = E.Spec<W, Presence, Msg>;
const spec: Spec = { ...SPEC, proposers: { ...SPEC.proposers, ...Cheats.PROPOSERS } };
let seq = 0;
const run = (w: W, data: CheatData): E.BatchOut<Presence, Msg> => E.commitBatch(w, [{ type: 'cheat', data, id: 'cheat#' + String(++seq) }], spec);
const rejects = (w: W, data: CheatData): string[] => run(w, data).rejected.map(r => r.reject ?? '');
const idx = (x: number, y: number): number => y * D.W + x;
const garden = (): Tile[] => D.buildMap().map(g => ({ g, s: null }));
// Svet s Dielňou (makeWorld ju nemá) a pozemkami na pôvodných miestach; ľadovňa ešte nestojí
function world(): W {
  const w = makeWorld(178);
  w.icehouse = { built: false, ice: 0, bl: 0 };
  w.dielna = Dielna.newDielna();
  w.ground = {}; // zem zmenená cheatom (#153) – na serveri je vždy
  w.objects = Obj.defaultLots();
  Ice.applyIcehouse(w.icehouse, w.tiles, w.objects);
  Dielna.applyDielna(w.dielna, w.tiles, w.objects);
  return w;
}
// Voľné miesto 2×2 na tráve (ako ho hľadá cheat), prvé zľava hore v riadkoch od y0
function freeSpot(w: W, y0 = 0): { x: number; y: number } {
  for (let y = y0; y < D.H - 1; y++) for (let x = 0; x < D.W - 1; x++) if (!Obj.lotPlaceError(i => w.tiles[i], w.objects, 'icehouse', x, y, new Set())) return { x, y };
  throw new Error('v záhrade nie je voľné miesto');
}

test('objekty: pozemky na pôvodných miestach – zem záhrady sa nezmení', () => {
  const o = Obj.defaultLots();
  assert.deepStrictEqual(Obj.lotRect(o, 'icehouse'), D.ICEHOUSE.lot);
  assert.deepStrictEqual(Obj.lotRect(o, 'dielna'), D.DIELNA.lot);
  assert.strictEqual(o.nid, 3);
  const tiles = garden(), before = tiles.map(t => t.g);
  Ice.applyIcehouse({ built: false }, tiles, o);
  Dielna.applyDielna({ built: false }, tiles, o);
  assert.deepStrictEqual(tiles.map(t => t.g), before, 'generátor mapy má pozemky na tých istých miestach');
});

test('objekty: načítanie uloženia – chýbajúce dá pôvodné miesta, neplatné vynechá, jeden pozemok na budovu', () => {
  assert.deepStrictEqual(Obj.loadObjects(undefined), Obj.defaultLots());
  assert.deepStrictEqual(Obj.loadObjects({ list: 'nie' }), Obj.defaultLots());
  const o = Obj.loadObjects({
    list: [
      { id: 4, area: 'garden', x: 5, y: 5, kind: 'lot', v: 'icehouse', o: 'ana' },
      { id: 5, area: 'garden', x: 8, y: 8, kind: 'lot', v: 'icehouse' }, // druhý pozemok tej istej budovy
      { id: 6, area: 'garden', x: D.W - 1, y: 3, kind: 'lot', v: 'dielna' }, // presahuje okraj
      { id: 7, area: 'hory', x: 1, y: 1, kind: 'lot', v: 'dielna' },
      { id: 8, area: 'garden', x: 1, y: 1, kind: 'lavicka', v: 'dielna' },
      null
    ],
    nid: 2
  });
  assert.deepStrictEqual(o.list, [{ id: 4, area: 'garden', x: 5, y: 5, kind: 'lot', v: 'icehouse', o: 'ana' }]);
  assert.strictEqual(o.nid, 5, 'nové id je väčšie ako všetky uložené');
  assert.strictEqual(Obj.lotRect(o, 'dielna'), null, 'Dielňa nemá pozemok');
});

test('objekty: pozemok sa smie dať len na voľnú trávu v záhrade', () => {
  const w = world(), none = new Set<number>();
  const err = (x: number, y: number, changed = none): string | null => Obj.lotPlaceError(i => w.tiles[i], w.objects, 'icehouse', x, y, changed);
  const { x, y } = freeSpot(w);
  assert.strictEqual(err(x, y), null);
  assert.strictEqual(err(D.ICEHOUSE.lot.x0 + 1, D.ICEHOUSE.lot.y0), null, 'presah cez vlastný pozemok je v poriadku');
  assert.strictEqual(err(D.W - 1, 5), 'the lot must be inside the garden');
  assert.strictEqual(err(0.5, 5), 'bad position');
  assert.strictEqual(err(D.DIELNA.lot.x0 - 1, D.DIELNA.lot.y0), 'another object is there');
  assert.match(must(err(2, 27) ?? undefined), /house is not plain grass/);
  must(w.tiles[idx(x, y)]).s = { k: 'normal', w: 0, r: 0, p: null, o: 'ana' };
  assert.strictEqual(err(x, y), 'the ground is tilled');
  must(w.tiles[idx(x, y)]).s = null;
  assert.strictEqual(err(x, y, new Set([idx(x + 1, y + 1)])), 'the ground was changed by a cheat');
  // fúrik a sane parkujú pred Dielňou (V.VEHICLE_HOME) – tam pozemok nesmie byť ani na samej tráve
  const home = V.VEHICLE_HOME.furik, grass = (): { g: string } => ({ g: 'grass' });
  assert.strictEqual(Obj.lotPlaceError(grass, { list: [], nid: 1 }, 'dielna', Math.floor(home.x), Math.floor(home.y), none), 'the cart and sledge park there');
});

test('cheat: pozemok ľadovne sa premiestni, pôvodné miesto je tráva; ľadovňa sa postaví na novom mieste a hráč ju nájde tam', () => {
  const w = world(), old = Obj.rectIdx(D.ICEHOUSE.lot), to = freeSpot(w, 10);
  run(w, { op: 'lot', v: 'icehouse', at: to });
  assert.deepStrictEqual(Obj.lotRect(w.objects, 'icehouse'), Obj.rectAt(to.x, to.y));
  assert.ok(Ice.lotIdx(w.objects).every(i => must(w.tiles[i]).g === 'lot'));
  assert.ok(old.every(i => must(w.tiles[i]).g === 'grass'), 'pôvodný pozemok je znova tráva');
  // hráč postaví ľadovňu – stojí na novom pozemku; pri domčeku už „blízko ľadovne“ nie je
  save(w, 'ana').coins = 1000; save(w, 'ana').rep = 1000;
  const out = E.commitBatch(w, [{ type: 'build', data: { key: 'ana', id: 'icehouse' }, id: 'b1' }], spec);
  assert.deepStrictEqual(out.rejected, []);
  assert.ok(w.icehouse.built);
  assert.ok(Ice.lotIdx(w.objects).every(i => must(w.tiles[i]).g === 'icehouse'));
  assert.ok(old.every(i => must(w.tiles[i]).g === 'grass'));
  const c = Obj.center(must(Obj.lotRect(w.objects, 'icehouse') ?? undefined));
  assert.ok(Actions.nearIcehouse({ area: 'garden', x: c.x, y: c.y + 1.5 }, w.objects));
  assert.ok(!Actions.nearIcehouse({ area: 'garden', x: 1, y: 30 }, w.objects));
  // postavená budova sa nepresúva ani neodstraňuje
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'icehouse', at: { x: 0, y: 30 } }), ['the building stands on its lot; tear it down first']);
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'icehouse', at: null }), ['the building stands on its lot; tear it down first']);
});

test('cheat: pozemok sa vráti na pôvodné miesto aj odstráni; bez pozemku sa budova nepostaví', () => {
  const w = world(), to = freeSpot(w, 10);
  run(w, { op: 'lot', v: 'dielna', at: to });
  assert.ok(Dielna.lotIdx(w.objects).every(i => must(w.tiles[i]).g === 'lot'));
  assert.ok(Obj.rectIdx(D.DIELNA.lot).every(i => must(w.tiles[i]).g === 'grass'));
  run(w, { op: 'lot', v: 'dielna', at: { x: D.DIELNA.lot.x0, y: D.DIELNA.lot.y0 } });
  assert.ok(Obj.rectIdx(Obj.rectAt(to.x, to.y)).every(i => must(w.tiles[i]).g === 'grass'), 'z dočasného miesta ostane tráva');
  assert.ok(Obj.rectIdx(D.DIELNA.lot).every(i => must(w.tiles[i]).g === 'lot'));
  run(w, { op: 'lot', v: 'dielna', at: null });
  assert.strictEqual(Obj.lotOf(w.objects, 'dielna'), null);
  assert.ok(Obj.rectIdx(D.DIELNA.lot).every(i => must(w.tiles[i]).g === 'grass'));
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'dielna', at: null }), ['the building has no lot']);
  for (const what of ['dielna', 'loom'] as const) assert.deepStrictEqual(rejects(w, { op: 'building', what, on: true }), ['the building has no lot; place one first']);
  save(w, 'ana').coins = 1000; save(w, 'ana').rep = 1000;
  assert.strictEqual(Dielna.buildDielna(w.dielna, w.tiles, save(w, 'ana'), w.objects), 'Pre Dielňu zatiaľ nie je vymeraný pozemok.');
  assert.ok(!Dielna.nearDielna({ area: 'garden', x: 16, y: 28 }, w.objects));
  // nový pozemok dostane nové id
  run(w, { op: 'lot', v: 'dielna', at: to });
  assert.strictEqual(must(Obj.lotOf(w.objects, 'dielna') ?? undefined).id, 3);
  assert.strictEqual(w.objects.nid, 4);
  // nedá sa na zem zmenenú cheatom ani na prekopanú zem
  const g = freeSpot(w, 0);
  run(w, { op: 'ground', area: 'garden', is: [idx(g.x, g.y)], g: 'boulder' });
  run(w, { op: 'ground', area: 'garden', is: [idx(g.x, g.y)], g: null }); // vrátená zem už zmenená nie je
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'icehouse', at: g }), []);
  const h = freeSpot(w, g.y + 3); // mimo pozemku ľadovne na g
  run(w, { op: 'ground', area: 'garden', is: [idx(h.x + 1, h.y)], g: 'sand' });
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'icehouse', at: h }), ['sand is not plain grass']);
  run(w, { op: 'plot', is: [idx(h.x + 1, h.y + 1)], plot: { w: false, r: false, o: 'ana', plant: null } });
  run(w, { op: 'ground', area: 'garden', is: [idx(h.x + 1, h.y)], g: null });
  assert.deepStrictEqual(rejects(w, { op: 'lot', v: 'icehouse', at: h }), ['the ground is tilled']);
});

test('objekty: uloženie v15 zo servera – pozemok Dielne premiestnený cheatom sa načíta na novom mieste', () => {
  const o = Obj.loadObjects(SAVE_V15.objects);
  assert.deepStrictEqual(o, SAVE_V15.objects);
  const tiles = garden();
  Ice.applyIcehouse(SAVE_V15.icehouse, tiles, o);
  Dielna.applyDielna(SAVE_V15.dielna, tiles, o);
  assert.ok(Obj.rectIdx(Obj.rectAt(4, 8)).every(i => must(tiles[i]).g === 'lot'));
  assert.ok(Obj.rectIdx(D.DIELNA.lot).every(i => must(tiles[i]).g === 'grass'), 'pôvodný pozemok Dielne je tráva');
  assert.ok(Obj.rectIdx(D.ICEHOUSE.lot).every(i => must(tiles[i]).g === 'lot'));
});

// ---------- Server: migrácia v14 → v15, správa objects ----------
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = portOf(srv); srv.close(() => { r(p); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000', JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }
// Pripojí sa a počká na správu objects (príde pri pripojení) a dlaždice záhrady (welcome)
function joinFor(port: number, room: string, name: string): Promise<{ objects: MsgOf<'objects'>; tiles: MsgOf<'welcome'>['tiles'] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    let tiles: MsgOf<'welcome'>['tiles'] | null = null;
    const t = setTimeout(() => { ws.close(); reject(new Error('bez správy objects')); }, 5000);
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room, name })); });
    ws.on('message', raw => {
      const m = parseMsg(raw);
      if (isMsg(m, 'welcome')) tiles = m.tiles;
      if (isMsg(m, 'objects') && tiles) { clearTimeout(t); ws.close(); resolve({ objects: m, tiles }); }
    });
  });
}

test('server: uloženie v14 (fixtúra zo servera) sa prevedie na v15 – pozemky na pôvodných miestach, záhrada sa nezmení; klient dostane objects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-objekty-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'room-stary.json'), JSON.stringify(SAVE_V14));
  const proc = await startServer(dir, port);
  try {
    const { objects, tiles } = await joinFor(port, 'stary', 'Eva');
    assert.deepStrictEqual(objects.list, Obj.defaultLots().list);
    assert.ok(Obj.rectIdx(D.DIELNA.lot).every(i => tiles[i]?.g === 'lot')); // vo fixtúre ešte nestojí ani Dielňa, ani ľadovňa
    assert.ok(Obj.rectIdx(D.ICEHOUSE.lot).every(i => tiles[i]?.g === 'lot'));
    await new Promise(r => setTimeout(r, 300));
  } finally { await stopServer(proc); }
  try {
    const saved = readJson<SaveFile>(path.join(dir, 'room-stary.json'));
    assert.strictEqual(saved.v, 15);
    assert.strictEqual(saved.migratedFrom, 14);
    assert.deepStrictEqual(saved.objects, Obj.defaultLots());
    assert.deepStrictEqual(saved.tiles.map(t => t.s), SAVE_V14.tiles.map(t => t.s), 'pôda a rastliny ostali');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
