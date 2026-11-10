// Doprava (#158): fúrik a sane v Dielni – kúpa, obdobia, chytanie (naraz len jeden), tlačenie a ťahanie, plochy,
// náklad ľadu (najviac 6, do ľadovne), spolujazdec, odchod hráča, načítanie starého uloženia a cheaty.
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
import type { ServerMessage } from '../src/shared/protocol.ts';
import type { PlayerSave, SaveFile, Vehicle, VehicleId } from '../src/shared/save.ts';
import * as V from '../src/shared/vehicles.ts';
import * as Shape from '../src/shared/vehicleshape.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as Cheats from '../src/server/cheats.ts';
import * as Ice from '../src/server/ice.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Vehicles from '../src/server/vehicles.ts';
import type { VehicleInputs } from '../src/server/vehicles.ts';
import type { GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { must, parseMsg, partial, portOf, readJson, rethrow, testWorld } from './helpers.ts';

const TPD = D.TICKS_PER_DAY;
const SUMMER = D.DAWN_TICK + 6 + D.DAYS_PER_SEASON * TPD, WINTER = D.DAWN_TICK + 6 + 3 * D.DAYS_PER_SEASON * TPD;
const L = D.DIELNA.lot, DIELNA_AT = { x: L.x0 + 1, y: L.y1 + 1.5 };
type W = GameWorld & { presence: Presence[] };
// Svet ako na serveri po načítaní: postavená Dielňa a ľadovňa, ana a bob stoja pred Dielňou (leto)
function makeWorld(tick = SUMMER): W {
  const w = testWorld({
    tick, wall: 0, daySeconds: 1200, seed: 'doprava', step: 0, seq: 0, events: [],
    weather: 'sun' as const, saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: true, ice: 10, bl: 0 }, dielna: { ...Dielna.newDielna(), built: true }, redeem: {}, up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null), vehicles: V.newVehicles()
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Dielna.applyDielna(w.dielna, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob', 'cyril']) w.saves[key] = partial<PlayerSave>({ coins: 1000, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: must(D.REP_LEVELS[2]), up: { can: 0, composter: 0 }, area: 'garden', ...DIELNA_AT });
  return Object.assign(w, { presence: ['ana', 'bob', 'cyril'].map(key => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1), area: 'garden' as const, ...DIELNA_AT, scav: null })) });
}
const SPEC: E.Spec<W, Presence, Msg> = { proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS, ...Vehicles.PROPOSERS, ...Vehicles.EVENTS, ...Cheats.PROPOSERS }, periodic: Events.PERIODIC.concat(Vehicles.PERIODIC), presence: w => w.presence, onError: rethrow };
type Out = E.BatchOut<Presence, Msg>;
type AllInputs = Actions.ActionInputs & VehicleInputs;
let seq = 0;
const act = <T extends keyof AllInputs>(type: T, key: string, data?: Partial<Omit<AllInputs[T], 'key'>>): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + String(++seq), actor: key });
const run = (w: W, ...inputs: E.Input[]): Out => E.commitBatch(w, inputs, SPEC);
const rejected = (r: Out): (string | null | undefined)[] => r.rejected.map(x => x.reject);
const reason = (r: Out): string => rejected(r)[0] ?? '';
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const veh = (w: W, id: VehicleId): Vehicle => w.vehicles[id];
// Hráč key stojí na (x, y) – v uložení aj v prítomnosti (ako po potvrdenom pohybe)
function place(w: W, key: string, x: number, y: number, area: D.AreaId = 'garden'): void {
  Object.assign(save(w, key), { x, y, area });
  Object.assign(must(w.presence.find(p => p.key === key)), { x, y, area });
}
// Pohyb hráča ako ho skladá server: najprv prítomnosť, potom vstup pos (a po ňom prítomnosť z uloženia)
function move(w: W, key: string, x: number, y: number): Out {
  Object.assign(must(w.presence.find(p => p.key === key)), { x, y });
  const r = run(w, act('pos', key, { x, y }));
  const sv = save(w, key);
  Object.assign(must(w.presence.find(p => p.key === key)), { x: sv.x, y: sv.y, area: sv.area });
  return r;
}
// Nové obdobie: čas sveta a udalosť vehSeason (ako ju na začiatku obdobia spustí plánovač)
function season(w: W, tick: number): Out { w.tick = tick; return run(w, { type: 'vehSeason', data: {}, id: 'e#' + String(++seq) }); }
const buy = (w: W, id: VehicleId): void => { assert.deepStrictEqual(rejected(run(w, act('vehBuy', 'ana', { id }))), []); };

test('kúpa v Dielni: 400 🪙, reputácia 2, len pri Dielni a raz; fúrik je spoločný pre celú záhradu', () => {
  const w = makeWorld(), sv = save(w, 'ana');
  w.dielna.built = false;
  assert.match(reason(run(w, act('vehBuy', 'ana', { id: 'furik' }))), /Najprv treba postaviť Dielňu/);
  w.dielna.built = true;
  sv.rep = must(D.REP_LEVELS[1]);
  assert.match(reason(run(w, act('vehBuy', 'ana', { id: 'furik' }))), /reputáciu úrovne 2/);
  sv.rep = must(D.REP_LEVELS[2]); sv.coins = 399;
  assert.match(reason(run(w, act('vehBuy', 'ana', { id: 'furik' }))), /Nemáš dosť mincí/);
  sv.coins = 1000;
  place(w, 'ana', 3, 10);
  assert.deepStrictEqual(rejected(run(w, act('vehBuy', 'ana', { id: 'furik' }))), ['Podíď bližšie k Dielni.']);
  place(w, 'ana', DIELNA_AT.x, DIELNA_AT.y);
  const r = run(w, act('vehBuy', 'ana', { id: 'furik' }), act('vehBuy', 'bob', { id: 'furik' }));
  assert.deepStrictEqual(rejected(r), ['Fúrik už v Dielni je.'], 'dvaja naraz – kúpi len prvý');
  assert.strictEqual(sv.coins, 600); assert.strictEqual(save(w, 'bob').coins, 1000);
  assert.ok(veh(w, 'furik').bought && !veh(w, 'sane').bought);
  assert.deepStrictEqual([veh(w, 'furik').x, veh(w, 'furik').y, veh(w, 'furik').area], [V.VEHICLE_HOME.furik.x, V.VEHICLE_HOME.furik.y, 'garden'], 'stojí pred Dielňou');
  assert.ok(r.applied[0]?.outbox.some(m => m.t === 'toast' && /kúpil\(a\) do Dielne fúrik/.test(m.text) && m.icon === 'furik' && typeof m.to === 'object'), 'hlásenie všetkým s obrázkom');
  run(w, act('vehBuy', 'bob', { id: 'sane' }));
  assert.ok(veh(w, 'sane').bought); assert.strictEqual(save(w, 'bob').coins, 600);
  for (const id of V.VEHICLE_IDS) assert.ok(D.passable(must(w.tiles[V.tileIndex('garden', V.VEHICLE_HOME[id].x, V.VEHICLE_HOME[id].y)])), 'miesto pred Dielňou je priechodné');
});

test('obdobia: fúrik na jar, v lete a na jeseň, sane len v zime – mimo obdobia sa nedajú chytiť', () => {
  const w = makeWorld();
  buy(w, 'furik'); buy(w, 'sane');
  place(w, 'ana', 16, 29.6);
  assert.match(reason(run(w, act('vehGrab', 'ana', { id: 'sane' }))), /jazdia len v zime/);
  assert.deepStrictEqual(rejected(run(w, act('vehGrab', 'ana', { id: 'furik' }))), []);
  run(w, act('vehDrop', 'ana'));
  season(w, WINTER);
  assert.deepStrictEqual([veh(w, 'furik').usable, veh(w, 'sane').usable], [false, true], 'príznak prepla udalosť');
  assert.match(reason(run(w, act('vehGrab', 'ana', { id: 'furik' }))), /V zime vezmi radšej sane/);
  assert.deepStrictEqual(rejected(run(w, act('vehGrab', 'ana', { id: 'sane' }))), []);
  assert.strictEqual(veh(w, 'sane').driver, 'ana');
  for (const se of [0, 1, 2, 3] as const) assert.strictEqual(V.inSeason('furik', se), se !== 3);
});

test('chytenie je atómové: dvaja naraz → drží ho len prvý; naraz len jedno vozidlo; kto nie je blízko, nechytí', () => {
  const w = makeWorld();
  buy(w, 'furik');
  place(w, 'ana', 15.5, 30.4); place(w, 'bob', 15.5, 30.4);
  const r = run(w, act('vehGrab', 'ana', { id: 'furik' }), act('vehGrab', 'bob', { id: 'furik' }));
  assert.strictEqual(r.applied.length, 1);
  assert.deepStrictEqual(rejected(r), ['Fúrik práve tlačí niekto iný.']);
  assert.strictEqual(veh(w, 'furik').driver, 'ana');
  assert.match(reason(run(w, act('vehGrab', 'ana', { id: 'furik' }))), /už tlačíš/);
  place(w, 'cyril', 3, 10);
  assert.match(reason(run(w, act('vehGrab', 'cyril', { id: 'sane' }))), /ešte v Dielni nie sú/);
  w.tick = WINTER; buy(w, 'sane'); // bez udalosti obdobia – ana stále drží fúrik
  place(w, 'ana', 16.6, 30.4);
  assert.match(reason(run(w, act('vehGrab', 'ana', { id: 'sane' }))), /Najprv pusti fúrik/);
  assert.deepStrictEqual(rejected(run(w, act('vehGrab', 'cyril', { id: 'sane' }))), ['Podíď bližšie k saniam.']);
});

test('tlačenie: fúrik ide pred hráčom a natáča sa za ním; kam neprejde (trh), tam sa hráč nepohne', () => {
  const w = makeWorld();
  buy(w, 'furik');
  const f = veh(w, 'furik');
  Object.assign(f, { x: 12.5, y: 29.4 });
  place(w, 'ana', 12.5, 30.4);
  run(w, act('vehGrab', 'ana', { id: 'furik' }));
  assert.ok(Math.abs(f.a + Math.PI / 2) < 1e-3, 'smeruje na sever (od hráča)');
  assert.deepStrictEqual(rejected(move(w, 'ana', 12.5, 30.2)), []);
  assert.ok(Math.abs(f.y - (30.2 - V.PUSH_L)) < 1e-3 && Math.abs(f.x - 12.5) < 1e-3, `pred hráčom: ${f.x}, ${f.y}`);
  const r = move(w, 'ana', 12.5, 29.3); // fúrik by vošiel do stánku trhu (12, 28)
  assert.strictEqual(r.rejected.length, 1, 'pohyb odmietnutý');
  assert.strictEqual(save(w, 'ana').y, 30.2, 'hráč ostal');
  // na východ: fúrik sa natočí za smerom chôdze (postupne, nie naraz)
  move(w, 'ana', 12.9, 30.2);
  assert.ok(f.a > -Math.PI / 2 && f.a < 0, `natáča sa: ${f.a}`);
  for (let x = 13.2; x < 15; x += 0.3) move(w, 'ana', x, 30.2);
  assert.ok(Math.abs(f.a) < 0.05, `po pár krokoch smeruje na východ: ${f.a}`);
  // cúvanie: fúrik sa nenatočí, ide späť s hráčom
  const a0 = f.a;
  move(w, 'ana', 14.4, 30.2);
  assert.strictEqual(f.a, a0);
  assert.ok(Math.abs(f.x - (14.4 + V.PUSH_L)) < 1e-3);
});

test('ťahanie: sane stoja, kým je lano voľné, potom idú za hráčom', () => {
  const w = makeWorld(WINTER);
  buy(w, 'sane');
  const s = veh(w, 'sane');
  Object.assign(s, { x: 8.5, y: 20.5 });
  place(w, 'ana', 8.5, 21.2);
  run(w, act('vehGrab', 'ana', { id: 'sane' }));
  move(w, 'ana', 8.5, 21.4);
  assert.deepStrictEqual([s.x, s.y], [8.5, 20.5], 'lano je voľné');
  move(w, 'ana', 8.5, 22.4);
  assert.ok(Math.abs(Math.hypot(s.x - 8.5, s.y - 22.4) - V.TOW_L) < 1e-3, 'za hráčom na lane');
  assert.ok(s.y < 22.4, 'za hráčom (sever)');
});

test('plochy: do Lesa na pomedzí s fúrikom nie (treba ho pustiť); do hôr ide fúrik aj so spolujazdcom', () => {
  const w = makeWorld(WINTER);
  buy(w, 'sane');
  const s = veh(w, 'sane');
  Object.assign(s, { x: 17.2, y: 25.5 });
  place(w, 'ana', 18.4, 25.5);
  run(w, act('vehGrab', 'ana', { id: 'sane' }));
  const r = move(w, 'ana', 19.4, 25.5);
  assert.match(reason(r), /do Lesa na pomedzí neprejdú.*Najprv ich pusti/);
  assert.strictEqual(save(w, 'ana').area, 'garden');
  run(w, act('vehDrop', 'ana'));
  assert.deepStrictEqual(rejected(move(w, 'ana', 19.4, 25.5)), [], 'bez saní prejde');
  assert.strictEqual(save(w, 'ana').area, 'pomedzie');
  assert.strictEqual(s.area, 'garden', 'sane ostali v záhrade');

  // do hôr: vodič aj spolujazdec prejdú, sane sú v horách
  Object.assign(s, { x: 16.5, y: 2.9 });
  place(w, 'ana', 16.5, 1.6); place(w, 'bob', 16.5, 2.4);
  run(w, act('vehGrab', 'ana', { id: 'sane' }));
  assert.deepStrictEqual(rejected(run(w, act('vehIn', 'bob', { id: 'sane' }))), []);
  assert.deepStrictEqual([save(w, 'bob').x, save(w, 'bob').y], [16.5, 2.9], 'spolujazdec sedí v saniach');
  const t = move(w, 'ana', 16.5, 0.5);
  assert.deepStrictEqual(rejected(t), []);
  const a = must(D.arrival('garden', 'hory') ?? undefined);
  assert.deepStrictEqual([save(w, 'ana').area, s.area, save(w, 'bob').area], ['hory', 'hory', 'hory']);
  assert.deepStrictEqual([s.x, s.y, save(w, 'bob').x, save(w, 'bob').y], [a.x, a.y, a.x, a.y]);
  const out = must(t.applied[0]).outbox;
  assert.ok(out.some(m => m.to === 'ana' && m.t === 'travel'), 'vodič prešiel');
  assert.ok(out.some(m => m.to === 'bob' && m.t === 'travel' && m.area === 'hory'), 'spolujazdec prešiel s ním');
});

test('náklad: len ľad, najviac 6 kusov; vyložiť do batohu (koľko unesieš) a do ľadovne (len pri nej)', () => {
  const w = makeWorld();
  buy(w, 'furik');
  const f = veh(w, 'furik'), sv = save(w, 'ana');
  place(w, 'ana', 15.5, 30.4);
  assert.match(reason(run(w, act('vehLoad', 'ana', { id: 'furik', n: 0 }))), /Nemáš ľad.*len ľad/);
  sv.inv.ice = 4; sv.fb = { ice: [{ n: 4, a: w.tick, at: w.tick }] };
  run(w, act('vehLoad', 'ana', { id: 'furik', n: 0 }));
  assert.deepStrictEqual([f.ice, sv.inv.ice ?? 0], [4, 0]);
  sv.inv.ice = 4; sv.fb = { ice: [{ n: 4, a: w.tick, at: w.tick }] };
  run(w, act('vehLoad', 'ana', { id: 'furik', n: 0 }));
  assert.deepStrictEqual([f.ice, sv.inv.ice], [6, 2], 'viac ako 6 sa nezmestí');
  assert.match(reason(run(w, act('vehLoad', 'ana', { id: 'furik', n: 1 }))), /viac sa nezmestí/);
  run(w, act('vehUnload', 'ana', { id: 'furik', n: 0 }));
  assert.deepStrictEqual([f.ice, sv.inv.ice], [2, 6], 'do batohu len do 6');
  assert.match(reason(run(w, act('vehUnload', 'ana', { id: 'furik', n: 1 }))), /neunesieš/);
  // do ľadovne: fúrik ďaleko → nie
  assert.match(reason(run(w, act('vehIcehouse', 'ana', { id: 'furik' }))), /bližšie k ľadovni/);
  const IL = D.ICEHOUSE.lot;
  Object.assign(f, { x: IL.x1 + 1.6, y: IL.y0 + 1 }); place(w, 'ana', IL.x1 + 2.6, IL.y0 + 1);
  const ice0 = w.icehouse.ice;
  assert.deepStrictEqual(rejected(run(w, act('vehIcehouse', 'ana', { id: 'furik' }))), []);
  assert.deepStrictEqual([f.ice, w.icehouse.ice], [0, ice0 + 2]);
  assert.match(reason(run(w, act('vehIcehouse', 'ana', { id: 'furik' }))), /nie je žiadny ľad/);
  // plná ľadovňa: zostane, čo sa nezmestí
  f.ice = 5; w.icehouse.ice = D.ICEHOUSE.cap - 3;
  run(w, act('vehIcehouse', 'ana', { id: 'furik' }));
  assert.deepStrictEqual([f.ice, w.icehouse.ice], [2, D.ICEHOUSE.cap]);
  assert.match(reason(run(w, act('vehIcehouse', 'ana', { id: 'furik' }))), /Ľadovňa je plná/);
});

test('spolujazdec: naskočí, len keď fúrik niekto tlačí; jedno miesto; vezie sa; po pustení sedí ďalej, kým nevystúpi', () => {
  const w = makeWorld();
  buy(w, 'furik');
  const f = veh(w, 'furik');
  Object.assign(f, { x: 8.5, y: 20.5 });
  place(w, 'ana', 8.5, 21.4); place(w, 'bob', 9.2, 20.5); place(w, 'cyril', 7.8, 20.5);
  assert.match(reason(run(w, act('vehIn', 'bob', { id: 'furik' }))), /len keď fúrik niekto tlačí/);
  run(w, act('vehGrab', 'ana', { id: 'furik' }));
  assert.match(reason(run(w, act('vehIn', 'ana', { id: 'furik' }))), /Najprv pusti fúrik/);
  const r = run(w, act('vehIn', 'bob', { id: 'furik' }), act('vehIn', 'cyril', { id: 'furik' }));
  assert.deepStrictEqual(rejected(r), ['Vo fúriku už niekto sedí. Zmestí sa len jeden.']);
  assert.strictEqual(f.passenger, 'bob');
  assert.ok(must(r.applied[0]).outbox.some(m => m.to === 'ana' && m.t === 'toast' && /naskočil\(a\)/.test(m.text)), 'vodič sa to dozvie');
  // vezie sa: poloha spolujazdca je poloha fúrika; sám chodiť nemôže
  const t = move(w, 'ana', 8.5, 22.0);
  assert.deepStrictEqual([save(w, 'bob').x, save(w, 'bob').y], [f.x, f.y]);
  assert.ok(must(t.applied[0]).outbox.some(m => m.to === 'bob' && m.t === 'pos' && m.x === f.x && m.y === f.y), 'spolujazdec dostane polohu');
  assert.strictEqual(move(w, 'bob', 3, 3).rejected.length, 1, 'spolujazdec sám nechodí');
  assert.match(reason(run(w, act('vehGrab', 'bob', { id: 'furik' }))), /Najprv vystúp|tlačí niekto iný/);
  // vodič pustí: spolujazdec sedí ďalej; iný hráč môže fúrik chytiť aj so spolujazdcom
  const d = run(w, act('vehDrop', 'ana'));
  assert.ok(must(d.applied[0]).outbox.some(m => m.to === 'bob' && m.t === 'toast' && /Sedíš ďalej/.test(m.text)));
  assert.deepStrictEqual([f.driver, f.passenger], [null, 'bob']);
  place(w, 'cyril', f.x, f.y + 0.9);
  run(w, act('vehGrab', 'cyril', { id: 'furik' }));
  assert.deepStrictEqual([f.driver, f.passenger], ['cyril', 'bob']);
  run(w, act('vehOut', 'bob'));
  assert.strictEqual(f.passenger, null);
  assert.deepStrictEqual(rejected(move(w, 'bob', f.x + 0.6, f.y)), [], 'po vystúpení zase chodí');
});

test('odchod hráča: fúrik ostane stáť, kde ho pustil; spolujazdec vystúpi; ktokoľvek ho potom chytí', () => {
  const w = makeWorld();
  buy(w, 'furik');
  const f = veh(w, 'furik');
  Object.assign(f, { x: 8.5, y: 20.5 });
  place(w, 'ana', 8.5, 21.4); place(w, 'bob', 9.2, 20.5);
  run(w, act('vehGrab', 'ana', { id: 'furik' }));
  run(w, act('vehIn', 'bob', { id: 'furik' }));
  move(w, 'ana', 8.5, 23.0);
  const at = { x: f.x, y: f.y };
  run(w, act('leave', 'ana'), act('leave', 'bob'));
  assert.deepStrictEqual([f.driver, f.passenger, f.x, f.y], [null, null, at.x, at.y]);
  place(w, 'cyril', f.x, f.y + 1);
  assert.deepStrictEqual(rejected(run(w, act('vehGrab', 'cyril', { id: 'furik' }))), []);
});

test('načítanie: staré uloženie bez fúrikov → predvolené; kto ich držal a kto v nich sedel, sa zabudne; zlé hodnoty sa opravia', () => {
  const summer = { ...V.newVehicles(), sane: { ...V.newVehicle('sane'), usable: false } }; // príznak podľa obdobia (leto)
  assert.deepStrictEqual(Vehicles.loadVehicles(undefined, SUMMER), summer);
  assert.deepStrictEqual(Vehicles.loadVehicles('zlé', SUMMER), summer);
  assert.deepStrictEqual([Vehicles.loadVehicles(undefined, WINTER).furik.usable, Vehicles.loadVehicles(undefined, WINTER).sane.usable], [false, true]);
  const v = Vehicles.loadVehicles({ furik: { bought: true, area: 'hory', x: 5.25, y: 7.5, a: 1, ice: 4, usable: false, driver: 'ana', passenger: 'bob' }, sane: { bought: 1, area: 'les', x: 'x', ice: 99 } }, SUMMER);
  assert.deepStrictEqual(v.furik, { bought: true, area: 'hory', x: 5.25, y: 7.5, a: 1, ice: 4, fb: [{ n: 4, a: 0, at: SUMMER }], usable: false, driver: null, passenger: null }, 'uložený príznak platí, várky sa doplnia');
  assert.deepStrictEqual([v.sane.bought, v.sane.area, v.sane.x, v.sane.ice, v.sane.driver], [true, 'garden', V.VEHICLE_HOME.sane.x, 6, null]);
});

test('cheaty: kúpiť, premiestniť, nastaviť náklad, pustiť a odstrániť (vstup cheat v engine)', () => {
  const w = makeWorld();
  const cheat = (d: Cheats.CheatData): Out => run(w, { type: 'cheat', data: d, id: 'cheat#' + String(++seq) });
  const b: Cheats.CheatRoom = { id: 'x', players: new Map(), saves: {}, tick: 0 };
  const parse = (o: { [k: string]: unknown }): Cheats.CheatData | null => Cheats.parseCheat(b, o, k => k);
  assert.throws(() => parse({ op: 'vehicle', id: 'auto', act: 'buy' }), /unknown vehicle/);
  assert.throws(() => parse({ op: 'vehicle', id: 'furik', act: 'tp', area: 'les', x: 1, y: 1 }), /garden and the mountains/);
  cheat(must(parse({ op: 'vehicle', id: 'furik', act: 'buy' }) ?? undefined));
  assert.ok(veh(w, 'furik').bought);
  cheat(must(parse({ op: 'vehicle', id: 'furik', act: 'tp', area: 'hory', x: 6.5, y: 9.5 }) ?? undefined));
  assert.deepStrictEqual([veh(w, 'furik').area, veh(w, 'furik').x, veh(w, 'furik').y], ['hory', 6.5, 9.5]);
  cheat(must(parse({ op: 'vehicle', id: 'furik', act: 'ice', n: 9, set: true }) ?? undefined));
  assert.strictEqual(veh(w, 'furik').ice, 6);
  veh(w, 'furik').driver = 'ana'; veh(w, 'furik').passenger = 'bob';
  cheat(must(parse({ op: 'vehicle', id: 'furik', act: 'release' }) ?? undefined));
  assert.deepStrictEqual([veh(w, 'furik').driver, veh(w, 'furik').passenger], [null, null]);
  cheat(must(parse({ op: 'vehicle', id: 'furik', act: 'remove' }) ?? undefined));
  assert.deepStrictEqual(veh(w, 'furik'), V.newVehicle('furik'));
  assert.strictEqual(reason(cheat({ op: 'vehicle', id: 'sane', act: 'ice', n: 1, set: false })), 'not bought');
});

test('pohyb: predpoveď klienta a server počítajú to isté (zdieľaný výpočet follow)', () => {
  let p: V.Pose = { x: 5, y: 5, a: 0 };
  const steps = [[5.2, 5], [5.4, 5.1], [5.5, 5.4], [5.5, 5.8]] as const;
  let from = { x: 4.05, y: 5 };
  for (const [x, y] of steps) { p = V.follow('furik', p, from, { x, y }); from = { x, y }; }
  assert.ok(Math.abs(Math.hypot(p.x - 5.5, p.y - 5.8) - V.PUSH_L) < 1e-9, 'vždy PUSH_L pred hráčom');
  assert.ok(p.a > 0 && p.a < Math.PI / 2 + 1e-9, 'natočil sa smerom na juh');
});

test('tvar: fúrik a sane sú najviac takí dlhí ako hráč; náklad ľadu sú kocky (0–6), nie voxely', () => {
  for (const id of V.VEHICLE_IDS) {
    const e = Shape.extent(Shape.vehicleParts(id, 6));
    assert.ok(e.len <= Shape.VEHICLE_LEN + 1e-9 && e.len > 0.7, `${id}: dĺžka ${e.len.toFixed(2)}`);
    assert.ok(e.wid < e.len && e.top < 0.6, `${id}: šírka ${e.wid.toFixed(2)}, výška ${e.top.toFixed(2)}`);
    const iceFaces = (n: number): number => Shape.vehicleParts(id, n).filter(p => p.k === 'poly' && p.layer === 'ice').length;
    for (const n of [0, 1, 3, 6]) assert.strictEqual(iceFaces(n), n * 6, `${id}: ${n} kociek ľadu`);
    assert.strictEqual(iceFaces(9), 36, 'najviac 6');
    assert.ok(Shape.SEAT_Y[id] > 0 && Shape.SEAT_Y[id] < e.top);
  }
  assert.ok(V.PUSH_L - Shape.VEHICLE_LEN / 2 < 0.3, 'rúčky fúrika sú pri hráčovi');
});

test('ladiaca stránka: World dostane kúpené fúriky plochy aj s vodičom a spolujazdcom (načítanie hry ich maže)', () => {
  const saved = { furik: { ...V.newVehicle('furik'), bought: true, driver: 'ana', passenger: 'bob', ice: 2 }, sane: { ...V.newVehicle('sane'), bought: true, area: 'hory' } };
  assert.deepStrictEqual(Vehicles.debugView(saved, 'garden', SUMMER).map(v => [v.id, v.d, v.r, v.ice, v.u]), [['furik', 'ana', 'bob', 2, true]]);
  assert.deepStrictEqual(Vehicles.debugView(saved, 'hory', SUMMER).map(v => v.id), ['sane']);
  assert.deepStrictEqual(Vehicles.debugView(undefined, 'garden', SUMMER), [], 'staré uloženie: nič');
  assert.strictEqual(Vehicles.loadVehicles(saved, SUMMER).furik.driver, null);
});

test('topenie: ľad vo fúriku sa topí ako v batohu – nesie si vek pri nakladaní aj vykladaní, po ICE_LIFE zmizne', () => {
  const w = makeWorld();
  buy(w, 'furik');
  const f = veh(w, 'furik'), sv = save(w, 'ana');
  place(w, 'ana', 15.5, 30.4);
  run(w, act('vehGrab', 'ana', { id: 'furik' }));
  const old = w.tick - D.ICE_LIFE / 2; // polovicu života už má za sebou
  sv.inv.ice = 2; sv.fb = { ice: [{ n: 2, a: 0, at: old }] };
  run(w, act('vehLoad', 'ana', { id: 'furik', n: 0 }));
  assert.strictEqual(f.ice, 2);
  assert.strictEqual(Vehicles.meltAt(f), old + D.ICE_LIFE, 'vek ľadu sa preniesol do fúrika');
  const t1 = w.tick;
  sv.inv.ice = 1; sv.fb = { ice: [{ n: 1, a: 0, at: t1 }] };
  run(w, act('vehLoad', 'ana', { id: 'furik', n: 0 }));
  assert.strictEqual(f.ice, 3);
  // hodinová udalosť: kým nie je čas, nič; po polovici dňa sa staré kusy roztopia, vodič dostane hlásenie
  const hourly = (tick: number): Out => { w.tick = tick; return run(w, { type: 'hourly', data: {}, id: 'e#' + String(++seq) }); };
  hourly(old + D.ICE_LIFE - 1);
  assert.strictEqual(f.ice, 3);
  const r = hourly(old + D.ICE_LIFE);
  assert.deepStrictEqual([f.ice, f.fb.reduce((n, b) => n + b.n, 0)], [1, 1], 'počet sedí s várkami');
  assert.ok(must(r.applied[0]).outbox.some(m => m.to === 'ana' && m.t === 'toast' && /Vo fúriku sa roztopil ľad \(2×\)/.test(m.text)));
  // vyloženie do batohu: ľad si nesie vek (nie je zase čerstvý)
  run(w, act('vehUnload', 'ana', { id: 'furik', n: 0 }));
  assert.deepStrictEqual([f.ice, sv.inv.ice], [0, 1]);
  const b = must(must(sv.fb.ice)[0]);
  assert.strictEqual(D.batchAge(b, w.tick, 1), w.tick - t1, 'kus má svoj vek z fúrika, nie je zase čerstvý');
});

test('obdobie: udalosť vehSeason na začiatku obdobia vypne fúrik a pustí vodiča aj spolujazdca s hlásením; sane zapne', () => {
  const w = makeWorld();
  buy(w, 'furik'); buy(w, 'sane');
  const f = veh(w, 'furik');
  Object.assign(f, { x: 8.5, y: 20.5 });
  place(w, 'ana', 8.5, 21.4); place(w, 'bob', 9.2, 20.5);
  run(w, act('vehGrab', 'ana', { id: 'furik' }));
  run(w, act('vehIn', 'bob', { id: 'furik' }));
  const r = season(w, WINTER);
  assert.deepStrictEqual([f.usable, f.driver, f.passenger, veh(w, 'sane').usable], [false, null, null, true]);
  const out = must(r.applied[0]).outbox;
  for (const k of ['ana', 'bob']) assert.ok(out.some(m => m.to === k && m.t === 'toast' && /koliesko fúrika zaborilo.*Fúrik ostal stáť/.test(m.text)), k);
  assert.match(reason(run(w, act('vehGrab', 'ana', { id: 'furik' }))), /V zime vezmi radšej sane/);
  // cheat prepne príznak (a pustí vodiča)
  run(w, { type: 'cheat', data: { op: 'vehicle', id: 'furik', act: 'usable' }, id: 'cheat#' + String(++seq) });
  assert.strictEqual(f.usable, true);
  assert.deepStrictEqual(rejected(run(w, act('vehGrab', 'ana', { id: 'furik' }))), [], 'po cheate sa dá chytiť aj v zime');
});

test('obdobie: plánovač naplánuje vehSeason na začiatok každého obdobia a prehranie denníka dá ten istý svet', () => {
  const start = makeWorld(SUMMER - 6), journal: E.JournalEntry<Presence, Msg>[] = [];
  buy(start, 'furik'); buy(start, 'sane');
  const copy = E.clone({ ...start, presence: start.presence });
  const spec: E.Spec<W, Presence, Msg> = { ...SPEC, onBatch: (_w, out) => { journal.push(E.clone(out.entry)); } };
  E.reconcile(start, spec);
  const ev = must(E.pending(start, 'vehSeason') ?? undefined);
  const SEASON = D.DAYS_PER_SEASON * D.TICKS_PER_DAY;
  assert.strictEqual(ev.at % SEASON, 0, 'na začiatku obdobia');
  assert.ok(ev.at > start.tick && ev.at - start.tick <= SEASON);
  const autumn = 2 * SEASON;
  E.advanceTo(start, autumn + 10, spec);
  assert.deepStrictEqual([veh(start, 'furik').usable, veh(start, 'sane').usable], [true, false], 'jeseň');
  E.advanceTo(start, 3 * SEASON + 10, spec);
  assert.deepStrictEqual([veh(start, 'furik').usable, veh(start, 'sane').usable], [false, true], 'zima');
  assert.ok(journal.some(e => e.inputs.some(i => i.type === 'vehSeason')), 'udalosť je v denníku');
  E.reconcile(copy, SPEC);
  E.replay(copy, journal, SPEC);
  assert.deepStrictEqual(copy.vehicles, start.vehicles, 'prehranie: rovnaké fúriky');
});

// ---------- Server: staré uloženie, správa vehicles ----------
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
// Pripojí sa a počká na prvú správu vehicles
function joinFor(port: number, room: string, name: string): Promise<Extract<ServerMessage, { t: 'vehicles' }>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const t = setTimeout(() => { ws.close(); reject(new Error('bez správy vehicles')); }, 5000);
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room, name })); });
    ws.on('message', raw => { const m = parseMsg(raw); if (m.t === 'vehicles') { clearTimeout(t); ws.close(); resolve(m); } });
  });
}

test('server: uloženie bez fúrikov sa načíta bez zmeny verzie, kúpený fúrik ostane, kde bol, bez vodiča; klient dostane správu vehicles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-doprava-'));
  const port = await freePort();
  let proc = await startServer(dir, port);
  try {
    const m = await joinFor(port, 'doprava', 'Ana');
    assert.deepStrictEqual(m.list.map(v => [v.id, v.bought]), [['furik', false], ['sane', false]]);
    await new Promise(r => setTimeout(r, 300));
  } finally { await stopServer(proc); }
  const file = path.join(dir, 'room-doprava.json');
  const saved = readJson<SaveFile & { v: number }>(file);
  assert.strictEqual(saved.v, 11, 'verzia uloženia sa nemení');
  assert.ok(saved.vehicles && !saved.vehicles.furik.bought, 'nový svet ich má nekúpené');
  // staré uloženie bez poľa vehicles a uloženie s kúpeným fúrikom, ktorý niekto držal
  delete saved.vehicles;
  fs.writeFileSync(file, JSON.stringify(saved));
  fs.writeFileSync(path.join(dir, 'room-druhy.json'), JSON.stringify({ ...saved, vehicles: { ...V.newVehicles(), furik: { ...V.newVehicle('furik'), bought: true, area: 'hory', x: 8.5, y: 9.5, ice: 3, driver: 'ana', passenger: 'bob' } } }));
  proc = await startServer(dir, port);
  try {
    const a = await joinFor(port, 'doprava', 'Ana');
    assert.ok(a.list.every(v => !v.bought), 'staré uloženie: predvolené');
    const b = await joinFor(port, 'druhy', 'Ana');
    const f = must(b.list.find(v => v.id === 'furik'));
    assert.deepStrictEqual([f.bought, f.area, f.x, f.y, f.ice, f.d, f.r], [true, 'hory', 8.5, 9.5, 3, null, null]);
    await new Promise(r => setTimeout(r, 300));
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
