// Väčšie jazierko, mólo a loďka pre dvoch (#160): mapa, migrácia v12, kúpa móla, nastupovanie a vystupovanie,
// dve miesta, veslovanie len po vode, dosah z loďky na hlbokú vodu a zima (loďka prevrátená na móle).
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
import type { Ground } from '../src/shared/data.ts';
import type { PlayerSave, SaveFile, SavedTile } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as Ice from '../src/server/ice.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Dock from '../src/server/dock.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { SAVE_V11 } from './save-v11.fixture.ts';
import { SAVE_V12 } from './save-v12.fixture.ts';
import * as MapCore from '../src/debug/tabs/map-core.ts';
import { BOAT2D, boatNear, boatScreen } from '../src/shared/boat2d.ts';
import * as V from '../src/shared/vehicles.ts';
import * as Vehicles from '../src/server/vehicles.ts';
import { must, parseJson, parseMsg, partial, portOf, readJson, rethrow, testWorld } from './helpers.ts';

const K = D.DOCK, TPD = D.TICKS_PER_DAY;
const tile = (x: number, y: number): number => y * D.W + x;
const DOCK_END = { x: K.tiles[0]?.x ?? 0, y: K.tiles[0]?.y ?? 0 }; // koniec móla (pri loďke)
const ON_DOCK = { x: DOCK_END.x + 0.5, y: DOCK_END.y + 0.5 };
type W = GameWorld & { presence: Presence[] };
function makeWorld(built = true, tick = D.DAWN_TICK + 6): W {
  const w = testWorld({
    tick, wall: 0, daySeconds: 1200, seed: 'dock', step: 0, seq: 0, events: [],
    weather: 'sun' as const, saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: false, ice: 0, bl: 0 }, dielna: Dielna.newDielna(), dock: Dock.newDock(), redeem: {}, up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Dielna.applyDielna(w.dielna, w.tiles);
  w.dock.built = built;
  Dock.applyDock(w.dock, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob', 'cyril']) w.saves[key] = partial<PlayerSave>({ coins: 2000, water: 1, inv: { hoe: 1, can: 1, fl_mak: 2 }, fb: {}, recipes: [], seen: [], vily: 0, rep: must(D.REP_LEVELS[2]), up: { can: 0, composter: 0 }, area: 'garden', ...ON_DOCK });
  const pr = (key: string, name: string): Presence => ({ key, name, area: 'garden', ...ON_DOCK, scav: null });
  return Object.assign(w, { presence: [pr('ana', 'Ana'), pr('bob', 'Bob'), pr('cyril', 'Cyril')] });
}
const SPEC: E.Spec<W, Presence, Msg> = { proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS, ...Dock.PROPOSERS }, periodic: Events.PERIODIC.concat(Dock.PERIODIC), presence: w => w.presence, onError: rethrow };
type Out = E.BatchOut<Presence, Msg>;
let seq = 0;
const act = (type: string, key: string, data?: { [field: string]: unknown } | null): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
const run = (w: W, ...inputs: E.Input[]): Out => E.commitBatch(w, inputs, SPEC);
const reason = (r: Out): string => r.rejected[0]?.reject ?? '';
const applied = (r: Out): boolean => r.applied.length > 0 && !r.rejected.length;
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const at = (w: W, key: string, p: Partial<Presence>): Presence => Object.assign(must(w.presence.find(x => x.key === key)), p);
// Ťuknutie hráča na políčko (x, y) s predmetom – ako server: rozklad (resolveAct) a vstup enginu
function tap(w: W, key: string, x: number, y: number, item = ''): Out | { toast: string } | null {
  const me = must(w.presence.find(p => p.key === key)), r = Actions.resolveAct(w, w.presence, me, { x, y, item });
  if (!r || 'toast' in r) return r;
  return run(w, act(r.type, key, r.data));
}
// Pohyb hráča (ako rámec servera: prítomnosť hneď, potom vstup pos); spolujazdec sa nehýbe (server.ts ho zahodí)
function move(w: W, key: string, x: number, y: number): Out {
  at(w, key, { x, y });
  return run(w, act('pos', key, { x, y }));
}
const textOf = (m: Msg): string => ('text' in m ? m.text : '');
const toastOf = (r: ReturnType<typeof Actions.resolveAct>): string => (r && 'toast' in r ? r.toast : '');

test('mapa: väčšie jazierko pri domčeku siaha k západnému okraju, budovy, chodníky a prechody ostali; hlboká voda je', () => {
  const g = D.buildMap(), at0 = (x: number, y: number): Ground => must(g[tile(x, y)]);
  // nič z dedinky sa nepohlo
  for (const [x, y, v] of [[2, 27, 'house'], [4, 28, 'house'], [7, 28, 'well'], [11, 28, 'stall'], [13, 28, 'stall'], [14, 28, 'majster'], [15, 27, 'lot'], [0, 30, 'lot'], [1, 31, 'lot'], [15, 5, 'babka'], [17, 5, 'cauldron'], [16, 0, 'gate'], [19, 25, 'gate']] as const) assert.strictEqual(at0(x, y), v, `${x},${y}`);
  for (let y = 4; y < D.H; y++) assert.strictEqual(at0(10, y), 'path', 'chodník x = 10');
  for (let x = 3; x <= 18; x++) assert.strictEqual(at0(x, 26), 'path', 'chodník y = 26');
  for (let x = 3; x <= 9; x++) assert.strictEqual(at0(x, 29), 'path', 'chodník y = 29');
  // príchodové miesta a štart nie sú vo vode
  for (const i of D.arrivalTiles('garden')) assert.ok(D.isLand({ g: must(g[i]) }), 'príchod ' + i);
  assert.ok(D.isLand({ g: must(g[tile(Math.floor(D.SPAWN.x), Math.floor(D.SPAWN.y))]) }));
  // nová voda je len vľavo od chodníka a siaha k okraju mapy; pôvodné jazierko je s ňou spojené
  assert.ok(D.NEW_POND.length > 40 && D.NEW_POND.every(i => i % D.W <= 9 && g[i] === 'water'));
  assert.ok(D.POND_EDGE.length >= 5 && D.POND_EDGE.every(p => p.x === 0 && g[tile(0, p.y)] === 'water'));
  assert.strictEqual(at0(3, 17), 'water', 'prieliv do pôvodného jazierka');
  // mólo stojí na vode novej časti, loďka pri ňom kotví na vode; aj s postaveným mólom ostáva hlboká voda
  for (const p of K.tiles) assert.ok(D.NEW_POND.includes(tile(p.x, p.y)));
  const tiles = g.map(v => ({ g: v }));
  assert.ok(D.boatFits(tiles, K.moor.x, K.moor.y));
  for (const p of K.tiles) must(tiles[tile(p.x, p.y)]).g = 'dock';
  const deep = D.deepWater(tiles);
  assert.ok(deep.length >= 10, 'hlboká voda: ' + deep.length);
  assert.ok(deep.every(i => D.NEW_POND.includes(i) || i === tile(3, 14)), 'hlboká voda je v novej časti (a stred pôvodného jazierka)');
  // mólo je pevná zem (dá sa po ňom chodiť), loďka na ňom nestojí
  assert.ok(D.isLand({ g: 'dock' }) && D.passable({ g: 'dock' }) && !D.boatFits(tiles, ON_DOCK.x, ON_DOCK.y));
});

test('migrácia v12: čo stálo na novej vode, ide do redeem (pridá sa k tomu z v11), hráči na vode sú na brehu', () => {
  const saved: SavedTile[] = D.buildMap().map(() => ({ s: null }));
  const [a, b, c] = [must(D.NEW_POND[3]), must(D.NEW_POND[20]), must(D.NEW_POND[40])], keep = tile(12, 30);
  const sp = 'ruza', S = D.SPECIES[sp];
  must(saved[a]).s = { k: 'normal', w: 1, r: 1, p: { sp, prog: S.days, q: 2, dry: 0 }, o: 'ana' };   // kvitne, pohnojená → 3 kvety
  must(saved[b]).s = { k: 'normal', w: 0, r: 0, p: { sp: 'mak', prog: 1, q: 3, dry: 0 }, o: 'ana' };  // rastie → semienko
  must(saved[c]).s = { k: 'normal', w: 0, r: 1, p: null, o: 'bob' };                                  // pohnojená zem → kompost
  must(saved[keep]).s = { k: 'normal', w: 0, r: 0, p: null, o: 'bob' };
  const ana = partial<PlayerSave>({ x: a % D.W + 0.5, y: Math.floor(a / D.W) + 0.5, area: 'garden' });
  const bob = partial<PlayerSave>({ x: 12.5, y: 30.5, area: 'garden' }), eva = partial<PlayerSave>({ x: 1.5, y: 20.5, area: 'hory' });
  const out = { tiles: saved, saves: { ana, bob, eva }, redeem: { compost: 2 }, dock: Dock.newDock() };
  out.dock.built = true; // mólo z migrácie ešte nie je
  Dock.migrate(out);
  assert.deepStrictEqual(out.redeem, { compost: 3, fl_ruza: 3, seed_mak: 1 });
  for (const i of D.NEW_POND) assert.strictEqual(must(saved[i]).s, null);
  assert.ok(must(saved[keep]).s, 'iné políčka ostanú');
  const g = D.buildMap();
  assert.ok(D.isLand({ g: must(g[tile(Math.floor(ana.x), Math.floor(ana.y))]) }), 'ana je na brehu');
  assert.ok(Math.hypot(ana.x - (a % D.W + 0.5), ana.y - (Math.floor(a / D.W) + 0.5)) < 6, 'neďaleko');
  assert.deepStrictEqual([bob.x, bob.y, eva.x, eva.y], [12.5, 30.5, 1.5, 20.5], 'bob na suchu a eva v horách ostali');
  assert.strictEqual(out.dock.built, false);
  const none = { tiles: undefined, saves: {}, redeem: {}, dock: Dock.newDock() };
  Dock.migrate(none);
  assert.deepStrictEqual(none.redeem, {}, 'svet bez uložených políčok');
});

test('mólo: kúpa na trhu (800 🪙, reputácia 2) pre celú záhradu, s loďkou pri móle; políčka móla sú potom drevené mólo', () => {
  const w = makeWorld(false);
  save(w, 'ana').rep = must(D.REP_LEVELS[1]);
  assert.match(reason(run(w, act('buildDock', 'ana'))), /reputáciu úrovne 2/);
  save(w, 'ana').rep = must(D.REP_LEVELS[2]); save(w, 'ana').coins = 799;
  assert.match(reason(run(w, act('buildDock', 'ana'))), /Nemáš dosť mincí/);
  save(w, 'ana').coins = 1000;
  const r = run(w, act('buildDock', 'ana'));
  assert.ok(applied(r));
  assert.strictEqual(save(w, 'ana').coins, 200);
  assert.ok(w.dock.built && !w.dock.flip && !w.dock.seats.length);
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y]);
  for (const p of K.tiles) assert.strictEqual(must(w.tiles[tile(p.x, p.y)]).g, 'dock');
  assert.ok(r.outbox.some(m => m.to === E.ALL && /postavil\(a\) pri jazierku mólo/.test(textOf(m))));
  assert.match(reason(run(w, act('buildDock', 'bob'))), /už pri jazierku stojí/);
});

test('loďka: nastupuje sa na móle (dvaja), tretí sa nezmestí; veslár ňou ide len po vode, spolujazdec sa vezie', () => {
  const w = makeWorld();
  // ďaleko od loďky sa nenastúpi
  at(w, 'cyril', { x: 12.5, y: 30.5 });
  const far = run(w, act('board', 'cyril'));
  assert.match(reason(far), /Podíď bližšie k loďke/);
  // ťuknutie na loďku z móla: nastúpi ana (vesluje), potom bob (vezie sa)
  const r1 = tap(w, 'ana', Math.floor(K.moor.x), Math.floor(K.moor.y));
  assert.ok(r1 && !('toast' in r1) && applied(r1));
  assert.deepStrictEqual(w.dock.seats, ['ana']);
  assert.deepStrictEqual([save(w, 'ana').x, save(w, 'ana').y], [K.moor.x, K.moor.y], 'sedí v loďke');
  const r1b = tap(w, 'bob', Math.floor(K.moor.x), Math.floor(K.moor.y), 'can');
  assert.ok(r1b && !('toast' in r1b) && applied(r1b), 's náradím v ruke tiež nastúpi');
  assert.deepStrictEqual(w.dock.seats, ['ana', 'bob']);
  at(w, 'cyril', ON_DOCK);
  assert.match(reason(run(w, act('board', 'cyril'))), /už sedia dvaja/);
  // ana vesluje na sever po vode; bob ide s ňou
  at(w, 'bob', { x: K.moor.x, y: K.moor.y });
  const r2 = move(w, 'ana', K.moor.x, K.moor.y - 1);
  assert.ok(applied(r2));
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y - 1]);
  assert.deepStrictEqual([save(w, 'bob').x, save(w, 'bob').y], [K.moor.x, K.moor.y - 1], 'spolujazdec sa vezie');
  assert.ok(r2.outbox.some(m => m.to === 'bob' && m.t === 'aboard'), 'prítomnosť spolujazdca ide s loďkou');
  // na breh ani na mólo loďka nevojde (oprava polohy), spolujazdec nevesluje
  const shore = move(w, 'ana', 9.5, K.moor.y - 1);
  assert.strictEqual(shore.rejected[0]?.input.type, 'pos');
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y - 1]);
  assert.strictEqual(move(w, 'ana', ON_DOCK.x, ON_DOCK.y).rejected.length, 1, 'na mólo nie');
  assert.strictEqual(move(w, 'bob', K.moor.x - 1, K.moor.y - 1).rejected.length, 1, 'spolujazdec nevesluje');
  // pešo na vodu stále nie
  at(w, 'cyril', ON_DOCK);
  assert.strictEqual(move(w, 'cyril', K.moor.x - 2, K.moor.y - 2).rejected.length, 1, 'voda pešo neprejde');
});

test('loďka: z loďky dočiahneš na hlbokú vodu, z brehu nie; vystupuje sa na mólo či breh vedľa loďky, loďka ostane', () => {
  const w = makeWorld();
  const deep = D.deepWater(w.tiles), di = must(deep.find(i => D.NEW_POND.includes(i))), dx = di % D.W, dy = Math.floor(di / D.W);
  // z brehu (najbližšia zem) je hlboké políčko príliš ďaleko
  const shore = Dock.nearestLand(w.tiles, dx + 0.5, dy + 0.5);
  at(w, 'ana', shore);
  assert.deepStrictEqual(Actions.resolveAct(w, w.presence, must(w.presence[0]), { x: dx, y: dy, item: 'can' }), { toast: 'Si príliš ďaleko.' });
  // z loďky áno: krhlou nabrať vodu z hlbokého políčka
  at(w, 'ana', ON_DOCK);
  const on = tap(w, 'ana', Math.floor(K.moor.x), Math.floor(K.moor.y));
  assert.ok(on && !('toast' in on) && applied(on));
  let x = K.moor.x, y = K.moor.y;
  // veslovanie k hlbokému políčku po malých krokoch (ako klient)
  for (let k = 0; k < 200 && Math.hypot(x - dx - 0.5, y - dy - 0.5) > 0.2; k++) {
    const nx = x + Math.sign(dx + 0.5 - x) * Math.min(0.25, Math.abs(dx + 0.5 - x)), ny = y + Math.sign(dy + 0.5 - y) * Math.min(0.25, Math.abs(dy + 0.5 - y));
    if (applied(move(w, 'ana', nx, y))) x = nx;
    if (applied(move(w, 'ana', x, ny))) y = ny;
  }
  assert.ok(Math.hypot(x - dx - 0.5, y - dy - 0.5) <= 0.2, `loďka dopláva nad hlbokú vodu (${x}, ${y})`);
  const r = tap(w, 'ana', dx, dy, 'can');
  assert.ok(r && !('toast' in r) && applied(r));
  assert.strictEqual(save(w, 'ana').water, Econ.canCap(save(w, 'ana')), 'krhla plná');
  // vystúpiť ďaleko od brehu sa nedá
  assert.match(toastOf(Actions.resolveAct(w, w.presence, must(w.presence[0]), { x: shore.x | 0, y: shore.y | 0, item: '' })), /Priveslujte bližšie|Si príliš ďaleko/);
  // späť k mólu a vystúpiť na mólo
  for (let k = 0; k < 200 && Math.hypot(x - K.moor.x, y - K.moor.y) > 0.01; k++) {
    const nx = x + Math.sign(K.moor.x - x) * Math.min(0.25, Math.abs(K.moor.x - x)), ny = y + Math.sign(K.moor.y - y) * Math.min(0.25, Math.abs(K.moor.y - y));
    if (applied(move(w, 'ana', nx, y))) x = nx;
    if (applied(move(w, 'ana', x, ny))) y = ny;
  }
  const off = tap(w, 'ana', DOCK_END.x, DOCK_END.y);
  assert.ok(off && !('toast' in off) && applied(off));
  assert.deepStrictEqual(w.dock.seats, []);
  assert.strictEqual(Math.floor(save(w, 'ana').y), DOCK_END.y, 'stojí na móle');
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [x, y], 'loďka ostala, kde bola');
});

test('loďka: kto sa odpojí, vystúpi na breh; ďalší vesluje; prázdna loďka ďaleko od brehu sa v noci vráti k mólu', () => {
  const w = makeWorld();
  run(w, act('board', 'ana'));
  run(w, act('board', 'bob'));
  at(w, 'bob', { x: K.moor.x, y: K.moor.y });
  for (let k = 1; k <= 8; k++) move(w, 'ana', K.moor.x - 0.25 * k, K.moor.y - 0.1 * k);
  const bx = w.dock.boat.x;
  assert.ok(bx < K.moor.x - 1.5);
  const r = run(w, act('leave', 'ana'));
  assert.ok(applied(r));
  assert.deepStrictEqual(w.dock.seats, ['bob'], 'bob vesluje');
  assert.ok(r.outbox.some(m => m.to === 'bob' && /vesluješ ty/.test(textOf(m))));
  assert.ok(D.isLand(w.tiles[tile(Math.floor(save(w, 'ana').x), Math.floor(save(w, 'ana').y))]), 'ana stojí na zemi');
  assert.ok(applied(run(w, act('leave', 'bob'))));
  assert.strictEqual(w.dock.boat.x, bx, 'loďka ostane, kde bola');
  // uprostred hlbokej vody (z brehu sa k nej nedá dostať) ju v noci pritiahne vietor k mólu
  const di = must(D.deepWater(w.tiles)[0]);
  w.dock.boat.x = di % D.W + 0.5; w.dock.boat.y = Math.floor(di / D.W) + 0.5;
  run(w, { type: 'boatDay', data: null, id: 'ev#1' });
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y]);
});

test('zima: na začiatku zimy loďku vytiahnu na mólo a prevrátia (posádka vystúpi), v zime sa do nej nenastúpi, na jar je zase na vode', () => {
  const winter = 3 * D.DAYS_PER_SEASON * TPD; // polnoc prvého zimného dňa
  const w = makeWorld(true, winter - 100);
  run(w, act('board', 'ana'));
  move(w, 'ana', K.moor.x - 1, K.moor.y - 1);
  E.advanceTo(w, winter + 10, SPEC);
  assert.ok(w.dock.flip);
  assert.deepStrictEqual(w.dock.seats, []);
  assert.deepStrictEqual([w.dock.boat.x, w.dock.boat.y], [K.moor.x, K.moor.y], 'loďka je pri móle');
  assert.deepStrictEqual([save(w, 'ana').x, save(w, 'ana').y], [K.land.x, K.land.y], 'ana stojí na móle');
  at(w, 'bob', ON_DOCK);
  save(w, 'bob').inv.pick = 1;
  assert.match(reason(run(w, act('board', 'bob'))), /V zime leží loďka prevrátená/);
  assert.match(toastOf(Actions.resolveAct(w, w.presence, must(w.presence[1]), { x: DOCK_END.x, y: DOCK_END.y, item: '' })), /prevrátená na móle/);
  // krompáčom na vode pri móle sa v zime seká ľad (ťuknutie na loďku nenastupuje)
  const ice = Actions.resolveAct(w, w.presence, must(w.presence[1]), { x: Math.floor(K.moor.x), y: Math.floor(K.moor.y), item: 'pick' });
  assert.ok(ice && 'type' in ice && ice.type === 'digIce');
  E.advanceTo(w, winter + D.DAYS_PER_SEASON * TPD + 10, SPEC);
  assert.ok(!w.dock.flip, 'na jar je loďka na vode');
  assert.ok(applied(run(w, act('board', 'bob'))));
});

test('mólo postavené v zime: loďka leží prevrátená hneď', () => {
  const w = makeWorld(false, 3 * D.DAYS_PER_SEASON * TPD + D.DAWN_TICK);
  const r = run(w, act('buildDock', 'ana'));
  assert.ok(applied(r) && w.dock.flip);
  assert.ok(r.outbox.some(m => /prevrátená na móle/.test(textOf(m))));
});

test('loadDock / load: poškodené uloženie dá platný stav; kto sedel v loďke pred reštartom, je na brehu', () => {
  assert.deepStrictEqual(Dock.loadDock(null), Dock.newDock());
  assert.deepStrictEqual(Dock.loadDock({ built: false, seats: ['ana'], flip: true }).seats, []);
  const d = Dock.loadDock({ built: true, boat: { x: 3.5, y: 20.5, a: 1 }, seats: ['ana', 'bob', 'cyril', 5], flip: false });
  assert.deepStrictEqual([d.boat, d.seats], [{ x: 3.5, y: 20.5, a: 1 }, ['ana', 'bob']]);
  const w = makeWorld();
  w.dock = d;
  save(w, 'ana').x = 3.5; save(w, 'ana').y = 20.5;
  Dock.load(w);
  assert.deepStrictEqual(w.dock.seats, []);
  assert.ok(D.isLand(w.tiles[tile(Math.floor(save(w, 'ana').x), Math.floor(save(w, 'ana').y))]));
});

// ---- Server: migrácia skutočného uloženia v11 ----
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = portOf(srv); srv.close(() => { r(p); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }

test('server: uloženie v11 sa prevedie na v12 – záhon na novej vode dostane prvý hráč, hráč z vody je na brehu, nič iné sa nestratí', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dock-'));
  const port = await freePort();
  const old = parseJson<Omit<SaveFile, 'v' | 'dock'> & { v: 11 }>(JSON.stringify(SAVE_V11));
  const wet = must(D.NEW_POND[25]), sp = 'tulipan';
  must(old.tiles[wet]).s = { k: 'normal', w: 1, r: 0, p: { sp, prog: D.SPECIES[sp].days, q: 3, dry: 0 }, o: 'ana' };
  Object.assign(must(old.saves['bob']), { x: wet % D.W + 0.5, y: Math.floor(wet / D.W) + 0.5, area: 'garden' });
  const others = old.tiles.map((t, i) => (D.NEW_POND.includes(i) ? null : t.s));
  fs.writeFileSync(path.join(dir, 'room-dock.json'), JSON.stringify(old));
  const proc = await startServer(dir, port);
  const got: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port), t = setTimeout(() => { reject(new Error('bez odpovede')); }, 5000);
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: 'dock', name: 'Ana' })); });
      ws.on('message', raw => {
        const m = parseMsg(raw);
        if (m.t === 'toast') got.push(m.text);
        if (m.t === 'dock') { assert.strictEqual(m.built, false); }
        if (m.t === 'toast' && /jazierko pri domčeku sa zväčšilo/.test(m.text)) { clearTimeout(t); ws.close(); resolve(); }
      });
    });
    await new Promise(r => setTimeout(r, 300));
  } finally { await stopServer(proc); }
  const s = readJson<SaveFile>(path.join(dir, 'room-dock.json'));
  assert.strictEqual(s.v, 13);
  assert.strictEqual(s.migratedFrom, 11);
  assert.deepStrictEqual(s.redeem, {}, 'odovzdané');
  assert.ok(got.some(t => /2|3× Tulipán|Tulipán/.test(t)), got.join(' | '));
  assert.ok((must(s.saves['ana']).inv[`fl_${sp}`] ?? 0) >= 3, 'ana dostala tulipány');
  assert.strictEqual(must(s.tiles[wet]).s, null);
  assert.deepStrictEqual(s.tiles.map((t, i) => (D.NEW_POND.includes(i) ? null : t.s)), others, 'ostatné záhony bez zmeny');
  const bob = must(s.saves['bob']), g = D.buildMap();
  assert.ok(D.isLand({ g: must(g[tile(Math.floor(bob.x), Math.floor(bob.y))]) }), 'bob je na brehu');
  assert.strictEqual(s.dock.built, false);
  assert.strictEqual(s.dielna.built, SAVE_V11.dielna.built);
  assert.strictEqual(s.icehouse.ice <= SAVE_V11.icehouse.ice, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server: uloženie v12 s posádkou v loďke (server sa vypol) – po načítaní sú obaja na brehu, loďka ostala, kde bola', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dock12-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'room-lodka.json'), JSON.stringify({ ...SAVE_V12, mode: 'paused' })); // bez dobiehania času (polnoc by prázdnu loďku z hlbokej vody vrátila k mólu)
  const proc = await startServer(dir, port);
  try {
    const got = await new Promise<{ x: number; y: number; seats: string[]; bx: number }>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port), t = setTimeout(() => { reject(new Error('bez odpovede')); }, 5000);
      let pos: { x: number; y: number } | null = null;
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: 'lodka', name: 'Ana' })); });
      ws.on('message', raw => {
        const m = parseMsg(raw);
        if (m.t === 'welcome') pos = { x: m.x, y: m.y };
        if (m.t === 'dock' && pos) { clearTimeout(t); ws.close(); resolve({ ...pos, seats: m.seats, bx: m.boat.x }); }
      });
    });
    assert.deepStrictEqual(got.seats, []);
    assert.strictEqual(got.bx, SAVE_V12.dock.boat.x);
    assert.ok(D.isLand({ g: must(D.buildMap()[tile(Math.floor(got.x), Math.floor(got.y))]) }) || K.tiles.some(p => p.x === Math.floor(got.x) && p.y === Math.floor(got.y)), `ana je na zemi (${got.x}, ${got.y})`);
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server + ladiaca stránka: mólo, nastúpenie a veslovanie sú v Engine a Journal; World a Room ukážu mólo a loďku; cheaty ovládajú loďku', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dockdbg-'));
  const port = await freePort(), KEY = 'tajne';
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, DAY_SECONDS: '100000', START_COINS: '5000', START_REP: '3', DEBUG_CHEATS_KEY: KEY }), stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(); } });
  });
  const api = async (p: string): Promise<string> => (await fetch(`http://127.0.0.1:${port}${p}`)).text();
  const cheat = async (b: { [field: string]: unknown }): Promise<number> => (await fetch(`http://127.0.0.1:${port}/api/debug/cheat`, { method: 'POST', headers: { 'X-Cheat-Key': KEY }, body: JSON.stringify({ room: 'dbg', ...b }) })).status;
  const ws = new WebSocket('ws://127.0.0.1:' + port), got: ReturnType<typeof parseMsg>[] = [];
  const wait = (f: (m: ReturnType<typeof parseMsg>) => boolean): Promise<void> => new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('nečakaná odpoveď: ' + JSON.stringify(got.slice(-3)))); }, 4000);
    const tick = (): void => { if (got.some(f)) { clearTimeout(t); resolve(); } else setTimeout(tick, 20); };
    tick();
  });
  try {
    ws.on('message', raw => { got.push(parseMsg(raw)); });
    await new Promise<void>(r => { ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: 'dbg', name: 'Ana' })); r(); }); });
    await wait(m => m.t === 'welcome');
    const seq = got.find((m): m is Extract<typeof m, { t: 'welcome' }> => m.t === 'welcome')?.seq ?? 0;
    ws.send(JSON.stringify({ t: 'build', id: 'dock' }));
    await wait(m => m.t === 'dock' && m.built);
    await wait(m => m.t === 'tiles' && m.tiles[tile(DOCK_END.x, DOCK_END.y)]?.g === 'dock');
    ws.send(JSON.stringify({ t: 'move', x: ON_DOCK.x, y: ON_DOCK.y, dir: 0, ar: seq }));
    await new Promise(r => setTimeout(r, 250));
    ws.send(JSON.stringify({ t: 'act', x: Math.floor(K.moor.x), y: Math.floor(K.moor.y), item: '' }));
    await wait(m => m.t === 'dock' && m.seats.includes('ana'));
    await wait(m => m.t === 'pos' && m.x === K.moor.x);
    ws.send(JSON.stringify({ t: 'move', x: K.moor.x - 0.5, y: K.moor.y - 0.5, dir: 0, ar: seq }));
    await wait(m => m.t === 'dock' && m.boat.x === K.moor.x - 0.5);
    // cheaty: loďku inam (s posádkou), zima (posádka na móle), späť na vodu
    assert.strictEqual(await cheat({ op: 'boat', x: 3.5, y: 21.5 }), 200);
    await wait(m => m.t === 'dock' && m.boat.x === 3.5);
    assert.strictEqual(await cheat({ op: 'boat', x: ON_DOCK.x, y: ON_DOCK.y }), 409, 'na mólo loďka nesmie');
    assert.strictEqual(await cheat({ op: 'boatFlip', flip: true }), 200);
    await wait(m => m.t === 'dock' && m.flip && !m.seats.length);
    assert.strictEqual(await cheat({ op: 'boatFlip', flip: false }), 200);
    assert.strictEqual(await cheat({ op: 'seat', player: 'Ana', on: true }), 200);
    await wait(m => m.t === 'dock' && !m.flip && m.seats.length === 1);
    await new Promise(r => setTimeout(r, 300));
    // ladiaca stránka
    const journal = await api('/api/debug/journal?room=dbg&type=buildDock,board,cheat&limit=50');
    for (const t of ['buildDock', 'board', 'cheat']) assert.ok(journal.includes(`"${t}"`), 'Journal: ' + t);
    const engine = await api('/api/debug/engine?room=dbg');
    assert.ok(engine.includes('"board"') && engine.includes('"buildDock"'), 'Engine');
    const world = await api('/api/debug/world?room=dbg&area=garden');
    assert.ok(/"dock":\{"built":true/.test(world) && world.includes('"g":"dock"'), 'World: mólo a loďka');
    const room = await api('/api/debug/room?id=dbg');
    assert.ok(/"dock":\{"built":true/.test(room), 'Room: mólo v stave sveta');
    assert.ok(room.includes('boatDay'), 'Room: periodická udalosť boatDay v reconcileri');
    assert.strictEqual(await cheat({ op: 'dock', built: false }), 200);
    await wait(m => m.t === 'dock' && !m.built);
  } finally {
    ws.close();
    await new Promise<void>(r => { proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ladiaca stránka, Mapa: väčšie jazierko s hlbokou vodou, postavené mólo a loďka so posádkou zo sveta', () => {
  const seedMap = MapCore.buildTiles(D, 'garden', { seed: 1 });
  assert.ok(!seedMap.error);
  assert.ok(seedMap.deep.size >= 10 && [...seedMap.deep].every(i => seedMap.tiles[i]?.g === 'water'));
  assert.strictEqual(seedMap.boat, null);
  assert.ok(K.tiles.every(p => seedMap.tiles[tile(p.x, p.y)]?.g === 'water'), 'bez móla voda');
  const state = { tick: 1, saves: {}, dock: { built: true, boat: { x: 3.5, y: 21.5, a: 0.5 }, seats: ['p-ana'], flip: false } };
  const m = MapCore.buildTiles(D, 'garden', { state });
  assert.ok(!m.error);
  assert.ok(K.tiles.every(p => m.tiles[tile(p.x, p.y)]?.g === 'dock'));
  assert.deepStrictEqual(m.boat, { x: 3.5, y: 21.5, a: 0.5, seats: ['p-ana'], flip: false });
  const info = MapCore.tileInfo(D, m, 3, 21);
  assert.ok(info && info.boat && info.deep);
  assert.strictEqual(MapCore.kindOf(D, 'dock'), 'dock');
});

test('loďka v 2D (shared/boat2d.ts): 8 smerov ako postavička, prova mieri tam, kam loďka; 2–3× väčšia ako postavička', () => {
  // smer na obrazovke ako render3d dir8: uhol vo svete + natočenie kamery → oktant → pohľad
  const dir8 = (a: number, yaw: number): number => {
    const sx = Math.cos(a) * Math.cos(yaw) - Math.sin(a) * Math.sin(yaw), sy = Math.cos(a) * Math.sin(yaw) + Math.sin(a) * Math.cos(yaw);
    return must([2, 5, 0, 4, 1, 6, 3, 7][((Math.round(Math.atan2(sy, sx) / (Math.PI / 4)) % 8) + 8) % 8]);
  };
  for (const yaw of [0, Math.PI / 4, Math.PI / 2, 2]) for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4 + 0.1, dir = dir8(a, yaw), [px, py] = boatScreen(dir, 1, 0, 0);
    // prova nakresleného pohľadu mieri na obrazovke tam, kam loďka vo svete (do 22,5°)
    const want = a + yaw, got = Math.atan2(py / Math.sin(BOAT2D.pitch), px);
    const diff = Math.abs(Math.atan2(Math.sin(want - got), Math.cos(want - got)));
    assert.ok(diff <= Math.PI / 8 + 1e-6, `yaw ${yaw}, a ${a}: ${diff}`);
  }
  for (let d = 0; d < 8; d++) assert.ok(boatNear(d) > 0.2 && boatNear(d) < BOAT2D.L, 'najbližší bod loďky pred stredom');
  assert.ok(2 * BOAT2D.L >= 2 && 2 * BOAT2D.L <= 3, 'loďka je 2–3× väčšia ako postavička (blok)');
  // samotné kreslenie (16 pohľadov, posádka) ukazuje /debug → Assets → Loďka a Playwright (art.ts potrebuje DOM)
});

test('vodné kvety (#38) a loďka: nová časť jazierka je jazierko s hĺbkou; lekno sa na hlbokú vodu ďaleko od brehu zasadí z loďky, z brehu nie', () => {
  const w = makeWorld(true, D.DAYS_PER_SEASON * TPD + D.DAWN_TICK); // leto – obdobie lekna
  // každé políčko, kam z brehu nikto nedočiahne (okrem okraja mapy – ten sa pre kvety ráta ako breh), je hĺbka jazierka
  const boatOnly = D.deepWater(w.tiles);
  for (const i of boatOnly) if (i % D.W !== 0) assert.deepStrictEqual(D.waterSpot('garden', i), { body: 'jazierko', zone: 'deep' }, 'políčko ' + i);
  for (const i of D.NEW_POND) assert.strictEqual(D.waterSpot('garden', i)?.body, 'jazierko', 'nová voda je jazierko');
  const di = must(boatOnly.find(i => i % D.W > 1 && D.NEW_POND.includes(i))), dx = di % D.W, dy = Math.floor(di / D.W);
  save(w, 'ana').inv.seed_lekno = 2;
  // z brehu príliš ďaleko
  at(w, 'ana', Dock.nearestLand(w.tiles, dx + 0.5, dy + 0.5));
  assert.deepStrictEqual(Actions.resolveAct(w, w.presence, must(w.presence[0]), { x: dx, y: dy, item: 'seed_lekno' }), { toast: 'Si príliš ďaleko.' });
  // z loďky áno
  at(w, 'ana', ON_DOCK);
  assert.ok(applied(run(w, act('board', 'ana'))));
  let x = K.moor.x, y = K.moor.y;
  for (let k = 0; k < 300 && Math.hypot(x - dx - 0.5, y - dy - 0.5) > 0.2; k++) {
    const nx = x + Math.sign(dx + 0.5 - x) * Math.min(0.25, Math.abs(dx + 0.5 - x)), ny = y + Math.sign(dy + 0.5 - y) * Math.min(0.25, Math.abs(dy + 0.5 - y));
    if (applied(move(w, 'ana', nx, y))) x = nx;
    if (applied(move(w, 'ana', x, ny))) y = ny;
  }
  const r = tap(w, 'ana', dx, dy, 'seed_lekno');
  assert.ok(r && !('toast' in r) && applied(r), 'zasadené z loďky');
  assert.strictEqual(must(w.tiles[di]).s?.p?.sp, 'lekno');
  assert.strictEqual(must(w.tiles[di]).s?.k, 'water');
  // na mieste móla vodný kvet: mólo sa nepostaví (zakrylo by ho)
  const w2 = makeWorld(false, D.DAYS_PER_SEASON * TPD + D.DAWN_TICK), p0 = must(K.tiles[0]);
  must(w2.tiles[tile(p0.x, p0.y)]).s = { k: 'water', w: 1, r: 0, p: { sp: 'kosatec', prog: 1, q: 3, dry: 0 }, o: 'ana' };
  assert.match(reason(run(w2, act('buildDock', 'ana'))), /rastie vodný kvet/);
});

test('fúrik a sane (#158) a väčšie jazierko: migrácia v12 ich z novej vody presunie na breh; na mólo ani na vodu nevojdú', () => {
  const i = must(D.NEW_POND[20]), x = i % D.W + 0.5, y = Math.floor(i / D.W) + 0.5;
  const vehicles = { furik: { ...V.newVehicle('furik'), bought: true, area: 'garden', x, y }, sane: { ...V.newVehicle('sane'), bought: true, area: 'hory', x, y } };
  const out = { tiles: D.buildMap().map(() => ({ s: null })), saves: {}, redeem: {}, dock: Dock.newDock(), vehicles };
  Dock.migrate(out);
  const g = D.buildMap();
  assert.ok(D.isLand({ g: must(g[tile(Math.floor(vehicles.furik.x), Math.floor(vehicles.furik.y))]) }), 'fúrik je na brehu');
  assert.deepStrictEqual([vehicles.sane.x, vehicles.sane.y], [x, y], 'sane v horách ostali');
  // tlačiť fúrik na mólo sa nedá (server odmietne pohyb, pri ktorom by fúrik vošiel na mólo)
  const w = makeWorld(true, D.DAYS_PER_SEASON * TPD + D.DAWN_TICK);
  const vw = Object.assign(w, { vehicles: V.newVehicles() });
  Object.assign(vw.vehicles.furik, { bought: true, area: 'garden', x: 6.5, y: 26.6, a: -Math.PI / 2, usable: true });
  at(w, 'ana', { x: 6.5, y: 27.5 }); save(w, 'ana').x = 6.5; save(w, 'ana').y = 27.5;
  const spec: E.Spec<W, Presence, Msg> = { ...SPEC, proposers: { ...SPEC.proposers, ...Vehicles.PROPOSERS } };
  const r0 = E.commitBatch(w, [act('vehGrab', 'ana', { id: 'furik' })], spec);
  assert.ok(applied(r0), reason(r0));
  let blocked = false;
  for (let k = 1; k <= 12 && !blocked; k++) { at(w, 'ana', { x: 6.5, y: 27.5 - 0.2 * k }); blocked = E.commitBatch(w, [act('pos', 'ana', { x: 6.5, y: 27.5 - 0.2 * k })], spec).rejected.length > 0; }
  assert.ok(blocked, 'fúrik sa zastaví pred mólom');
  assert.ok(Math.floor(vw.vehicles.furik.y) >= 25, `fúrik nie je na móle (${vw.vehicles.furik.y})`);
  // s fúrikom v rukách sa do loďky nenastupuje
  assert.match(reason(run(w, act('board', 'ana'))), /Najprv pusti fúrik/);
  // v loďke fúrik nechytíš
  at(w, 'bob', ON_DOCK);
  assert.ok(applied(run(w, act('board', 'bob'))));
  Object.assign(vw.vehicles.furik, { x: 6.5, y: 24.3 });
  assert.match(reason(E.commitBatch(w, [act('vehGrab', 'bob', { id: 'furik' })], spec)), /Z loďky/);
});
