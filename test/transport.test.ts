// Doprava (#161): prepojenie fúrika a saní (#158), móla a loďky (#160) a vodných kvetov (#38) – pravidlá medzi nimi,
// spoločná polnoc (vehSeason + boatDay), odpojenie pri móle, cheaty a prehľad dopravy pre ladiacu stránku.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as D from '../src/shared/data.ts';
import * as V from '../src/shared/vehicles.ts';
import type { PlayerSave, SavedTile, VehicleId } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as Cheats from '../src/server/cheats.ts';
import * as Ice from '../src/server/ice.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Dock from '../src/server/dock.ts';
import * as Vehicles from '../src/server/vehicles.ts';
import * as Transport from '../src/server/transport.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { SAVE_V12 } from './save-v12.fixture.ts';
import type { TransportApi } from '../src/server/debug-api/transport.ts';
import { must, parseJson, partial, portOf, rethrow, testWorld } from './helpers.ts';

const TPD = D.TICKS_PER_DAY, SEASON = D.DAYS_PER_SEASON * TPD, K = D.DOCK;
const SUMMER = SEASON + D.DAWN_TICK, END_OF_AUTUMN = 3 * SEASON - 200;
const DOCK_END = must(K.tiles[0]), ON_DOCK = { x: DOCK_END.x + 0.5, y: DOCK_END.y + 0.4 };
const tile = (x: number, y: number): number => y * D.W + x;
type W = GameWorld & { presence: Presence[] };
// Záhrada s Dielňou, mólom (loďka pri ňom), kúpeným fúrikom aj saňami; ana, bob a cyril stoja na móle
function makeWorld(tick = SUMMER): W {
  const w = testWorld({
    tick, wall: 0, daySeconds: 1200, seed: 'doprava-161', step: 0, seq: 0, events: [],
    weather: 'sun' as const, saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 7,
    icehouse: { built: true, ice: 0, bl: 0 }, dielna: { ...Dielna.newDielna(), built: true }, dock: { ...Dock.newDock(), built: true }, redeem: {}, up: { plots: 3 },
    glacierFed: -1, plotsUsed: 0, maxRep: 0, tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null), vehicles: V.newVehicles()
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Dielna.applyDielna(w.dielna, w.tiles);
  Dock.applyDock(w.dock, w.tiles);
  Econ.initEconomy(w);
  const se = D.seasonOf(D.dayOfTick(tick));
  for (const id of V.VEHICLE_IDS) Object.assign(w.vehicles[id], { bought: true, usable: V.inSeason(id, se) });
  for (const key of ['ana', 'bob', 'cyril']) w.saves[key] = partial<PlayerSave>({ coins: 2000, water: 1, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: must(D.REP_LEVELS[2]), up: { can: 0, composter: 0 }, area: 'garden', ...ON_DOCK });
  return Object.assign(w, { presence: ['ana', 'bob', 'cyril'].map(key => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1), area: 'garden' as const, ...ON_DOCK, scav: null })) });
}
const SPEC: E.Spec<W, Presence, Msg> = {
  proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS, ...Dock.PROPOSERS, ...Vehicles.PROPOSERS, ...Vehicles.EVENTS, ...Cheats.PROPOSERS },
  periodic: Events.PERIODIC.concat(Dock.PERIODIC, Vehicles.PERIODIC), presence: w => w.presence, onError: rethrow
};
type Out = E.BatchOut<Presence, Msg>;
let seq = 0;
const act = (type: string, key: string, data?: { [field: string]: unknown }): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + String(++seq), actor: key });
const cheat = (data: Cheats.CheatData): E.Input => ({ type: 'cheat', data, id: 'cheat#' + String(++seq) });
const run = (w: W, ...inputs: E.Input[]): Out => E.commitBatch(w, inputs, SPEC);
const reason = (r: Out): string => r.rejected[0]?.reject ?? '';
const applied = (r: Out): boolean => r.applied.length > 0 && !r.rejected.length;
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const at = (w: W, key: string, p: { x: number; y: number }): void => { Object.assign(must(w.presence.find(x => x.key === key)), p); Object.assign(save(w, key), p); };
const isLandAt = (w: W, x: number, y: number): boolean => D.isLand(w.tiles[tile(Math.floor(x), Math.floor(y))]);
const grab = (w: W, key: string, id: VehicleId): void => { const v = w.vehicles[id]; at(w, key, { x: v.x, y: v.y + 0.8 }); assert.ok(applied(run(w, act('vehGrab', key, { id }))), 'chytí ' + id); };

test('polnoc začiatku zimy: loďka sa prevráti na mólo (posádka na breh), fúrik sa pustí, sane sa dajú používať – v jednej dávke', () => {
  const w = makeWorld(END_OF_AUTUMN);
  // fúrik tlačí cyril pri brehu, ana vesluje s bobom
  Object.assign(w.vehicles.furik, { x: 8.5, y: 26.6 });
  grab(w, 'cyril', 'furik');
  at(w, 'ana', ON_DOCK); at(w, 'bob', ON_DOCK);
  assert.ok(applied(run(w, act('board', 'ana'))) && applied(run(w, act('board', 'bob'))));
  E.advanceTo(w, 3 * SEASON + 10, SPEC);
  assert.ok(w.dock.flip && !w.dock.seats.length, 'loďka prevrátená, posádka vystúpila');
  for (const k of ['ana', 'bob']) assert.ok(isLandAt(w, save(w, k).x, save(w, k).y), k + ' na brehu');
  assert.strictEqual(w.vehicles.furik.driver, null, 'fúrik sa v zime nedá tlačiť – pustený');
  assert.ok(!w.vehicles.furik.usable && w.vehicles.sane.usable);
  assert.deepStrictEqual([w.vehicles.furik.x, w.vehicles.furik.y], [8.5, 26.6], 'fúrik ostal stáť pri jazierku');
});

test('sane v zime na zamrznutom jazierku nie (voda ostáva pre vozidlá neprejazdná); fúrik nevtlačíš do vody ani na mólo', () => {
  const w = makeWorld(3 * SEASON + D.DAWN_TICK);
  const frozen = must(D.NEW_POND.find(i => w.tiles[i]?.g === 'water'));
  const r = run(w, cheat({ op: 'vehicle', id: 'sane', act: 'tp', area: 'garden', x: frozen % D.W + 0.5, y: Math.floor(frozen / D.W) + 0.5 }));
  assert.match(reason(r), /stay on land/);
  assert.match(reason(run(w, cheat({ op: 'vehicle', id: 'sane', act: 'tp', area: 'garden', x: ON_DOCK.x, y: ON_DOCK.y }))), /stay on land/, 'ani na mólo');
  // fúrik v lete: tlačiť ho na sever do vody (pred hráčom 0,62 políčka) sa nedá – hráč ostane stáť
  const s = makeWorld();
  Object.assign(s.vehicles.furik, { x: 4.5, y: 25.3 - V.PUSH_L, a: -Math.PI / 2 });
  at(s, 'ana', { x: 4.5, y: 26.0 });
  assert.ok(applied(run(s, act('vehGrab', 'ana', { id: 'furik' }))));
  let stopped = false;
  for (let k = 1; k <= 8 && !stopped; k++) { at(s, 'ana', { x: 4.5, y: 26.0 - 0.1 * k }); stopped = run(s, act('pos', 'ana', { x: 4.5, y: 26.0 - 0.1 * k })).rejected.length > 0; }
  assert.ok(stopped, 'fúrik sa zastaví na brehu');
  assert.ok(isLandAt(s, s.vehicles.furik.x, s.vehicles.furik.y), 'fúrik je stále na zemi');
});

test('odpojenie pri móle: vodič fúrika ho pustí, veslár vystúpi na breh, loďka aj fúrik ostanú, kde boli', () => {
  const w = makeWorld();
  Object.assign(w.vehicles.furik, { x: 8.5, y: 26.6 });
  grab(w, 'cyril', 'furik');
  assert.ok(applied(run(w, act('board', 'ana'))));
  for (let k = 1; k <= 6; k++) { at(w, 'ana', { x: K.moor.x - 0.2 * k, y: K.moor.y }); run(w, act('pos', 'ana', { x: K.moor.x - 0.2 * k, y: K.moor.y })); }
  const boat = { ...w.dock.boat };
  const r = run(w, act('leave', 'ana'), act('leave', 'cyril'));
  assert.strictEqual(r.rejected.length, 0);
  assert.strictEqual(w.vehicles.furik.driver, null);
  assert.deepStrictEqual(w.dock.seats, []);
  assert.ok(isLandAt(w, save(w, 'ana').x, save(w, 'ana').y), 'ana je na brehu');
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [boat.x, boat.y], 'loďka ostala');
  assert.deepStrictEqual([w.vehicles.furik.x, w.vehicles.furik.y], [8.5, 26.6], 'fúrik ostal');
});

test('spolujazdec v loďke: ťuknutie s semienkom na vodu pod loďkou zasadí vodný kvet (nedaruje ho spolujazdcovi)', () => {
  const w = makeWorld();
  assert.ok(applied(run(w, act('board', 'ana'))) && applied(run(w, act('board', 'bob'))));
  // loďka pri hlbokej vode jazierka (#38: lekno rastie v hĺbke, v lete)
  const deep = must(D.deepWater(w.tiles).find(i => i % D.W > 1 && D.waterSpot('garden', i)?.zone === 'deep'));
  const x = deep % D.W + 0.5, y = Math.floor(deep / D.W) + 0.5;
  assert.ok(applied(run(w, cheat({ op: 'boat', x, y }))));
  for (const k of ['ana', 'bob']) at(w, k, { x, y });
  save(w, 'ana').inv.seed_lekno = 1;
  const me = must(w.presence.find(p => p.key === 'ana'));
  const r = Actions.resolveAct(w, w.presence, me, { x: deep % D.W, y: Math.floor(deep / D.W), item: 'seed_lekno' });
  assert.ok(r && 'type' in r && r.type === 'plant', 'sadí, nedaruje: ' + JSON.stringify(r));
  assert.ok(applied(run(w, act(r.type, 'ana', r.data))));
  assert.strictEqual(w.tiles[deep]?.s?.p?.sp, 'lekno');
  // mimo loďky sa hráč na tom istom políčku stále obdarúva (zamávanie, dar)
  const other = makeWorld();
  at(other, 'bob', { x: 12.5, y: 30.5 }); at(other, 'ana', { x: 12.5, y: 30.5 });
  const g = Actions.resolveAct(other, other.presence, must(other.presence.find(p => p.key === 'ana')), { x: 12, y: 30, item: '' });
  assert.ok(g && 'type' in g && g.type === 'wave');
});

test('kto drží fúrik či sa vo fúriku vezie, do loďky nesadne (ani cheatom); v loďke fúrik nechytí', () => {
  const w = makeWorld();
  Object.assign(w.vehicles.furik, { x: 7.5, y: 25.6 });
  grab(w, 'cyril', 'furik');
  assert.match(reason(run(w, cheat({ op: 'seat', key: 'cyril', on: true }))), /holds or rides a vehicle/);
  at(w, 'ana', { x: 7.5, y: 26.3 });
  assert.ok(applied(run(w, act('vehIn', 'ana', { id: 'furik' }))));
  at(w, 'ana', ON_DOCK);
  assert.match(reason(run(w, act('board', 'ana'))), /Najprv pusti fúrik/);
  assert.ok(applied(run(w, act('board', 'bob'))));
  assert.match(reason(run(w, act('vehIn', 'bob', { id: 'sane' }))), /Z loďky/);
});

test('cheat transport reset: všetci pustia vozidlá, posádka loďky je na brehu, loďka pri móle', () => {
  const w = makeWorld();
  grab(w, 'cyril', 'furik');
  at(w, 'ana', ON_DOCK); at(w, 'bob', ON_DOCK);
  assert.ok(applied(run(w, act('board', 'ana'))) && applied(run(w, act('board', 'bob'))));
  assert.ok(applied(run(w, cheat({ op: 'boat', x: 3.5, y: 21.5 }))));
  const r = run(w, cheat({ op: 'transport', act: 'reset' }));
  assert.ok(applied(r));
  assert.strictEqual(w.vehicles.furik.driver, null);
  assert.deepStrictEqual(w.dock.seats, []);
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y]);
  for (const k of ['ana', 'bob']) assert.ok(isLandAt(w, save(w, k).x, save(w, k).y), k + ' na brehu');
  assert.ok(r.outbox.some(m => m.to === 'ana' && m.t === 'aboard'), 'klient dostane novú polohu');
});

test('prehľad dopravy (ladiaca stránka) z konečnej fixtúry: vozidlá, loďka s posádkou, ďalšie udalosti a role hráčov', () => {
  const tick = SAVE_V12.tick, view = Transport.overview(SAVE_V12, Vehicles.parseVehicles(SAVE_V12.vehicles, true, tick));
  const furik = must(view.vehicles.find(v => v.id === 'furik')), sane = must(view.vehicles.find(v => v.id === 'sane'));
  assert.ok(furik.bought && furik.usable && furik.ice > 0, 'fúrik kúpený, v lete použiteľný, naložený ľadom');
  assert.ok(sane.bought && !sane.usable, 'sane v lete stoja');
  assert.ok(view.dock.built && view.dock.seats.length === 2);
  assert.deepStrictEqual(view.players.filter(p => p.role).map(p => p.role).sort(), ['rides in the boat', 'rows the boat']);
  assert.deepStrictEqual(view.events.map(e => e.type).sort(), ['boatDay', 'vehSeason']);
  assert.ok(view.events.every(e => e.at > tick));
  assert.ok(view.deep >= 10);
  // fixtúra má všetok nový stav: vodné kvety v jazierku (pri brehu aj v hĺbke)
  const tiles: readonly SavedTile[] = SAVE_V12.tiles; // typ uloženia (fixtúra má zúžené literály)
  const water = tiles.flatMap((t, i) => (t.s && t.s.k === 'water' ? [{ i, sp: t.s.p?.sp, zone: D.waterSpot('garden', i)?.zone }] : []));
  assert.deepStrictEqual(water.map(x => x.zone).sort(), ['deep', 'shore']);
});

// ---- Server: záložka Transport na ladiacej stránke ----
const freePort = (): Promise<number> => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = portOf(s); s.close(() => { r(p); }); }); });
test('server: /api/debug/transport ukáže fúrik, sane, mólo s loďkou a udalosti; kľúče hráčov sú len odtlačky', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-doprava-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'room-doprava.json'), JSON.stringify({ ...SAVE_V12, mode: 'paused' }));
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
      proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(); } });
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/debug/transport?room=doprava`);
    assert.strictEqual(res.status, 200);
    const text = await res.text(), j = parseJson<TransportApi>(text);
    assert.deepStrictEqual(j.vehicles.map(v => [v.id, v.bought]), [['furik', true], ['sane', true]]);
    assert.ok(j.dock.built && j.dock.seats.length === 2 && j.dock.seats.every(k => /^p-/.test(k)), 'posádka ako odtlačky');
    assert.ok(!/"ana"|"bob"/.test(text), 'kľúče hráčov sa neukážu');
    assert.strictEqual(j.source, 'file');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/debug/transport?room=nie-je`)).status, 404);
  } finally {
    await new Promise<void>(r => { proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
