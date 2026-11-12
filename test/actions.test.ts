// Engine v2, fáza 3 (#111): akcie hráčov ako návrhy (actions.js) – rozklad správy act, kľúče po položkách trhu,
// kolá pri tom istom tovare / políčku / zákazke / batohu, odmietnutia, prítomnosť v denníku a prehranie, server.
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
import type { ItemId, SpeciesId } from '../src/shared/data.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import type { ActiveFestival, Contracts, Icehouse, Market, PlayerSave, SaveFile, Soil } from '../src/shared/save.ts';
import { entries, isRecord, keys } from '../src/shared/util.ts';
import type { JsonRecord } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as Actions from '../src/server/actions.ts';
import * as I from '../src/server/items.ts';
import * as Ice from '../src/server/ice.ts';
import * as Areas from '../src/server/areas.ts';
import * as Spiders from '../src/server/spiders.ts';
import * as Vehicles from '../src/server/vehicles.ts';
import * as Dielna from '../src/server/dielna.ts';
import * as Dock from '../src/server/dock.ts';
import type { GameCtx, GameWorld, Msg } from '../src/server/game.ts';
import type { Presence, Tile } from '../src/server/world.ts';
import { isMsg, must, parseJson, parseMsg, partial, portOf, readJson, rethrow, testWorld } from './helpers.ts';
import type { MsgOf, MsgType } from './helpers.ts';
const TPD = D.TICKS_PER_DAY;
const json = (v: unknown): string => JSON.stringify(v);
const SP = must(Econ.PLANTABLE.find(k => !D.SPECIES[k].strict)), SP2 = must(Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict)[1]);
// Hodnota, ktorá v tomto kroku testu musí existovať (aj null znamená chybu testu)
const nn = <T,>(v: T | null | undefined): T => must(v ?? undefined);
// Predmet podľa mena (recepty, výsledky trhu)
const item = (id: string): ItemId => { if (!D.isItemId(id)) throw new Error('neznámy predmet ' + id); return id; };

// Svet ako na serveri po načítaní; prítomnosť: ana a bob stoja v záhrade pri domčeku
type W = GameWorld & { market: Market; contracts: Contracts; presence?: Presence[] | undefined };
const ready = (w: GameWorld): w is W => !!w.market && !!w.contracts;
function makeWorld(seed: number, tick?: number): W {
  const w = testWorld<Partial<GameWorld> & { presence?: Presence[] }>({
    tick: tick == null ? D.DAWN_TICK + 6 : tick, wall: 0, daySeconds: 1200, seed: 'akcie-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: partial<Icehouse>({ built: true, ice: 0 }), up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = partial<PlayerSave>({ coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, area: 'garden' });
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.HOUSE.x, y: Actions.HOUSE.y, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: Actions.HOUSE.x + 1, y: Actions.HOUSE.y, scav: null }];
  if (!ready(w)) throw new Error('trh a nástenka chýbajú');
  return w;
}
type Spec = E.Spec<W, Presence, Msg>;
type Journal = E.JournalEntry<Presence, Msg>[];
const SPEC: Spec = { proposers: { ...Events.PROPOSERS, ...Actions.PROPOSERS }, periodic: Events.PERIODIC, presence: w => w.presence, onError: rethrow };
const withJournal = (spec: Spec, entries: Journal): Spec => ({ ...spec, onBatch: (w, out) => { entries.push(out.entry); } });
let seq = 0;
// Vstup ako ho skladá server: data.key aj actor sú kľúč hráča, id podľa poradia; dáta podľa typu akcie (actions.ts ActionInputs)
const act = <T extends keyof Actions.ActionInputs>(type: T, key: string, data?: Partial<Omit<Actions.ActionInputs[T], 'key'>>): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const at = (w: GameWorld, i: number): Tile => must(w.tiles[i]);
const soil = (w: GameWorld, i: number): Soil => nn(at(w, i).s);
const pr = (w: W, n: number): Presence => must(must(w.presence)[n]);
const seedOf = (w: W, sp: SpeciesId): { stock: number } => must(w.market.seeds[sp]);
// Polia dát vstupov a udalostí (test ich má ako obyčajný JSON)
const field = (v: unknown, k: string): unknown => (isRecord(v) ? v[k] : undefined);
const textOf = (m: Msg | ServerMessage): string => ('text' in m ? m.text : '');
// Políčka záhrady, na ktorých sa dá kopať (testy ich potrebujú aspoň päť)
type Tillable = [number, number, number, number, number, ...number[]];
const enough = (list: number[]): list is Tillable => list.length >= 5;
function tillable(w: GameWorld): Tillable {
  const list = w.tiles.map((t, i) => i).filter(i => D.TILLABLE[at(w, i).g] && at(w, i).g !== 'ring');
  if (!enough(list)) throw new Error('málo políčok na kopanie');
  return list;
}
function plant(w: GameWorld, i: number, key: string, ripe: boolean, sp?: SpeciesId): void {
  sp = sp || SP;
  at(w, i).s = { k: must(D.TILLABLE[at(w, i).g]), w: 1, r: 0, o: key, p: { sp, prog: ripe ? D.SPECIES[sp].days : 1, q: 3, dry: 0 } };
  w.plotsUsed = Econ.plotsUsedOf(w.tiles);
}
function give(sv: PlayerSave, id: ItemId, n: number, tick: number): void { I.addItems(I.playerC(sv), id, n, tick); }
const flowers = (w: GameWorld, key: string, sp?: SpeciesId): number => save(w, key).inv[`fl_${sp || SP}`] || 0;
// hráč stojí pri políčku i (na jeho okraji) – potrebné pre resolveAct
function standAt(w: W, key: string, i: number, exact?: boolean): Presence { const p = must(must(w.presence).find(x => x.key === key)); p.area = 'garden'; p.x = i % D.W + 0.5 + (exact ? 0 : 1); p.y = Math.floor(i / D.W) + 0.5; return p; }
function shuffle<T>(list: T[], s: number): T[] { const g = E.generator(s), out = list.slice(); for (let i = out.length - 1; i > 0; i--) { const j = g.int(i + 1); [out[i], out[j]] = [must(out[j]), must(out[i])]; } return out; }

// ---- Rozklad správy act ----

type Resolved = ReturnType<typeof Actions.resolveAct>;
const typeOf = (v: Resolved): string | undefined => (v && 'type' in v ? v.type : undefined);
const dataOf = (v: Resolved): unknown => (v && 'data' in v ? v.data : undefined);
const toastOf = (v: Resolved): string => (v && 'toast' in v ? v.toast : '');

test('act: kliknutie sa rozloží na konkrétnu akciu podľa políčka, predmetu a prítomnosti; vzdialenosť a plocha sa riešia hneď', () => {
  const w = makeWorld(1);
  const ti = tillable(w), grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
  const m = (i: number, item: string): { x: number; y: number; item: string } => ({ x: i % D.W, y: Math.floor(i / D.W), item });
  const me = standAt(w, 'ana', ti[0]);
  const r = (i: number, item: string, who?: Presence): Resolved => Actions.resolveAct(w, w.presence, who || me, m(i, item));
  assert.deepStrictEqual(r(ti[0], 'hoe'), { type: 'till', data: { key: 'ana', i: ti[0] } });
  assert.strictEqual(r(ti[0], 'can'), null, 'krhla na tráve nič nerobí');
  assert.strictEqual(r(ti[0], 'compost'), null);
  plant(w, ti[0], 'ana', false);
  assert.strictEqual(r(ti[0], 'hoe'), null, 'motyka pri rastúcej rastline nič nerobí');
  assert.deepStrictEqual(typeOf(r(ti[0], 'can')), 'water');
  save(w, 'ana').inv.compost = 1; save(w, 'ana').inv[`seed_${SP}`] = 1; save(w, 'ana').inv.wild_0 = 1; save(w, 'ana').inv.po_rast = 1;
  assert.deepStrictEqual(typeOf(r(ti[0], 'compost')), 'compost');
  soil(w, ti[0]).p = null;
  assert.deepStrictEqual(typeOf(r(ti[0], 'hoe')), 'level');
  assert.deepStrictEqual(r(ti[0], `seed_${SP}`), { type: 'plant', data: { key: 'ana', i: ti[0], item: `seed_${SP}` } });
  assert.deepStrictEqual(typeOf(r(ti[0], 'wild_0')), 'plantWild');
  assert.deepStrictEqual(r(ti[0], 'po_rast'), { type: 'potion', data: { key: 'ana', kind: 'rast', area: 'garden', x: ti[0] % D.W, y: Math.floor(ti[0] / D.W) } });
  plant(w, ti[0], 'ana', true);
  assert.deepStrictEqual(r(ti[0], ''), { type: 'pick', data: { key: 'ana', i: ti[0] } });
  nn(soil(w, ti[0]).p).d = 1;
  assert.deepStrictEqual(typeOf(r(ti[0], 'hoe')), 'clear');
  assert.strictEqual(r(ti[0], 'seed_xyz'), null, 'predmet, ktorý hráč nemá');
  // hľadanie v tráve: treba stáť priamo na políčku
  standAt(w, 'ana', grass);
  assert.deepStrictEqual(r(grass, ''), { toast: 'Postav sa priamo na to políčko trávy. 🔍' });
  standAt(w, 'ana', grass, true);
  assert.deepStrictEqual(r(grass, ''), { type: 'scavStart', data: { key: 'ana', i: grass, seeds: false } });
  assert.deepStrictEqual(field(dataOf(r(grass, `seed_${SP}`)), 'seeds'), true);
  // ďaleko
  const far = me.x = 0.5; me.y = 0.5;
  assert.deepStrictEqual(r(w.tiles.length - 1, 'hoe'), { toast: 'Si príliš ďaleko.' });
  assert.ok(far);
  // iný hráč na políčku: dar, láska alebo zamávanie
  const bob = must(must(w.presence).find(p => p.key === 'bob'));
  bob.x = 5.5; bob.y = 5.5; me.x = 5.5; me.y = 6.5;
  save(w, 'ana').inv.po_laska = 1;
  assert.deepStrictEqual(r(5 + 5 * D.W, `seed_${SP}`), { type: 'gift', data: { key: 'ana', to: 'bob', item: `seed_${SP}` } });
  assert.deepStrictEqual(typeOf(r(5 + 5 * D.W, 'po_laska')), 'love');
  assert.deepStrictEqual(typeOf(r(5 + 5 * D.W, 'hoe')), 'wave');
  // studňa, voda
  const well = w.tiles.findIndex(t => t.g === 'well'), water = w.tiles.findIndex(t => t.g === 'water');
  standAt(w, 'ana', well);
  assert.deepStrictEqual(r(well, ''), { type: 'well', data: { key: 'ana' } });
  assert.deepStrictEqual(typeOf(r(well, 'can')), 'drawWater');
  standAt(w, 'ana', water);
  assert.deepStrictEqual(r(water, 'can'), { type: 'drawWater', data: { key: 'ana', area: 'garden', i: water } });
  // hory: krompáč na ľadovci, motyka nič
  const gl = w.hory.findIndex(t => t.g === 'glacier');
  save(w, 'ana').inv.pick = 1;
  Object.assign(me, { area: 'hory', x: gl % D.W + 0.5, y: Math.floor(gl / D.W) + 1.5 });
  assert.deepStrictEqual(r(gl, 'pick'), { type: 'digIce', data: { key: 'ana', area: 'hory', i: gl } });
  assert.match(toastOf(r(gl, '')), /krompáč/);
  const ground = w.hory.findIndex(t => t.g !== 'glacier' && t.g !== 'water' && D.passable(t)); // zem v horách (hráč na nej stojí)
  Object.assign(me, { area: 'hory', x: ground % D.W + 0.5, y: Math.floor(ground / D.W) + 0.5 });
  assert.match(toastOf(r(ground, 'hoe')), /V horách/);
  assert.match(toastOf(r(ground, `seed_${SP}`)), /V horách/);
  assert.match(toastOf(r(ground, 'po_rast')), /záhony/);
  assert.deepStrictEqual(r(ground, 'po_vily'), null, 'elixír, ktorý hráč nemá');
  save(w, 'ana').inv.po_vily = 1;
  assert.deepStrictEqual(r(ground, 'po_vily'), { type: 'potion', data: { key: 'ana', kind: 'vily', area: 'hory', x: ground % D.W, y: Math.floor(ground / D.W) } });
});

// ---- Ten istý tovar: kľúče po položkách ----

test('trh: kľúče po položkách – nákupy rôznych semienok v jednom kroku sa nebrzdia, posledný kus toho istého kúpi práve jeden', () => {
  const w = makeWorld(2);
  seedOf(w, SP).stock = 1; seedOf(w, SP2).stock = 5;
  const r = E.commitBatch(w, [act('buy', 'ana', { id: `seed_${SP}`, n: 1 }), act('buy', 'bob', { id: `seed_${SP2}`, n: 2 }), act('buy', 'bob', { id: `seed_${SP}`, n: 1 })], SPEC);
  assert.strictEqual(r.rounds, 2, 'len tretí nákup (to isté semienko) čaká na druhé kolo');
  assert.deepStrictEqual(r.applied.map(x => field(x.input.data, 'id')), [`seed_${SP}`, `seed_${SP2}`]);
  assert.deepStrictEqual(r.rejected.map(x => [x.input.actor, x.reject]), [['bob', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  const first = must(r.applied[0]);
  assert.deepStrictEqual(first.writes.has(`market:seed_${SP}`) && !first.writes.has('market:*'), true, 'nákup deklaruje len svoju položku');
  assert.deepStrictEqual([seedOf(w, SP).stock, seedOf(w, SP2).stock, save(w, 'ana').inv[`seed_${SP}`], save(w, 'bob').inv[`seed_${SP2}`]], [0, 3, 1, 2]);
  // predaj kvetu číta sviatočný násobok z položky kvetu, nie zo súhrnu trhu
  const w2 = makeWorld(3);
  give(save(w2, 'ana'), `fl_${SP}`, 2, w2.tick);
  // skúšobný sviatok s id skutočného sviatku (test na id nič neoveruje; festEnd tu nenastane)
  const f: ActiveFestival = { id: must(D.FESTIVALS[0]).id, name: 'Skúška', icon: '✨', mult: { [SP]: 2 }, until: w2.tick + TPD };
  w2.market.festival = f; Econ.setFestival(w2.market, f);
  const price = Econ.flowerPrice(w2.market, w2.tick, SP);
  assert.strictEqual(must(w2.market.flowers[SP]).fest, 2);
  const r2 = E.commitBatch(w2, [act('sell', 'ana', { id: `fl_${SP}`, n: 1 })], SPEC);
  assert.deepStrictEqual([...must(r2.applied[0]).writes].sort(), [`market:fl_${SP}`, 'save:ana']);
  assert.strictEqual(save(w2, 'ana').coins, 500 + price);
  // predaj bez položky trhu (elixír) deklaruje len uloženie
  give(save(w2, 'ana'), 'po_sliz', 1, w2.tick);
  const r3 = E.commitBatch(w2, [act('sell', 'ana', { id: 'po_sliz', n: 1 })], SPEC);
  assert.deepStrictEqual([...must(r3.applied[0]).writes], ['save:ana']);
  // chudobný hráč a neznámy tovar
  save(w2, 'bob').coins = 0;
  const r4 = E.commitBatch(w2, [act('buy', 'bob', { id: `seed_${SP}`, n: 1 }), act('buy', 'ana', { id: 'lopata', n: 1 })], SPEC);
  assert.deepStrictEqual(r4.rejected.map(x => x.reject), ['Nemáš dosť mincí. 🪙', 'Toto sa na trhu nepredáva.']);
});

test('sviatok: festStart zapíše násobky do položiek kvetov a súhrn pre klienta, festEnd ich zmaže; staré uloženie sa dorovná pri načítaní', () => {
  const w = makeWorld(4, 0);
  const f = must(D.FESTIVALS[0]);
  E.advanceTo(w, Econ.festStartTick(f) + 1, SPEC);
  for (const [sp, k] of entries(f.mult)) assert.strictEqual(must(w.market.flowers[sp]).fest, k, sp);
  assert.strictEqual(nn(w.market.festival).id, f.id);
  assert.deepStrictEqual(nn(w.market.festival).mult, f.mult, 'klient dostáva násobky v súhrne');
  assert.ok(nn(Econ.marketView(w.market, w.tick, w.events).festival).mult);
  E.advanceTo(w, Econ.festStartTick(f) + f.len * TPD + 1, SPEC);
  assert.strictEqual(w.market.festival, null);
  assert.ok(Object.values(w.market.flowers).every(x => x.fest === undefined));
  // staré uloženie: len súhrn
  const old = makeWorld(5);
  old.market.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: old.tick + TPD };
  Econ.syncFestival(old.market);
  for (const [sp, k] of entries(f.mult)) assert.strictEqual(must(old.market.flowers[sp]).fest, k);
  assert.strictEqual(Econ.flowerPriceParts(old.market, old.tick, must(keys(f.mult)[0])).festival, f.id);
});

// ---- To isté políčko, zákazka, batoh ----

test('políčko: dvaja trhajú ten istý kvet / kopú to isté políčko – práve jeden výsledok a jedno odmietnutie s toastom', () => {
  const w = makeWorld(6);
  const ti = tillable(w);
  plant(w, ti[0], 'ana', true);
  let r = E.commitBatch(w, [act('pick', 'bob', { i: ti[0] }), act('pick', 'ana', { i: ti[0] })], SPEC);
  assert.deepStrictEqual([r.rounds, flowers(w, 'bob'), flowers(w, 'ana')], [2, 3, 0]);
  assert.deepStrictEqual(r.rejected.map(x => [x.input.actor, x.reject]), [['ana', 'Tu nič nekvitne.']]);
  r = E.commitBatch(w, [act('till', 'ana', { i: ti[1] }), act('till', 'bob', { i: ti[1] }), act('till', 'bob', { i: ti[2] })], SPEC);
  assert.deepStrictEqual([w.plotsUsed, Econ.plotsUsedOf(w.tiles)], [3, 3]);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Tu už je záhon.']);
  assert.strictEqual(soil(w, ti[1]).o, 'ana');
  // zarovnanie a kopanie: počítadlo sedí, povolenie sa stráži
  w.up.plots = 0; w.plotsUsed = Econ.plotsUsedOf(w.tiles);
  const lim = Econ.plotLimit(w.up);
  for (let k = 3; k < lim; k++) plant(w, must(ti[k]), 'ana', false);
  r = E.commitBatch(w, [act('level', 'bob', { i: ti[2] }), act('till', 'ana', { i: must(ti[lim]) }), act('till', 'bob', { i: must(ti[lim + 1]) })], SPEC);
  assert.strictEqual(w.plotsUsed, Econ.plotsUsedOf(w.tiles));
  assert.strictEqual(w.plotsUsed, lim, 'uvoľnené miesto zaplnil práve jeden');
  assert.strictEqual(r.rejected.length, 1);
  assert.match(must(r.rejected[0]).reject ?? '', /povolenie/);
});

test('zákazka: dvaja ju berú; odovzdanie zvýši maxRep; dar hráčovi, ktorý si práve ukladá; polievanie z prázdnej krhly', () => {
  const w = makeWorld(7);
  const c = Object.assign({}, must(w.contracts.list.find(x => !x.takenBy)));
  let r = E.commitBatch(w, [act('ctake', 'ana', { id: c.id }), act('ctake', 'bob', { id: c.id })], SPEC);
  assert.deepStrictEqual([r.applied.length, r.rejected.map(x => x.reject)], [1, ['Túto zákazku už niekto zobral.']]);
  assert.strictEqual(must(w.contracts.list.find(x => x.id === c.id)).takenBy, 'ana');
  give(save(w, 'ana'), `fl_${c.sp}`, c.n, w.tick);
  r = E.commitBatch(w, [act('cdeliver', 'ana', { id: c.id }), act('cdeliver', 'bob', { id: c.id })], SPEC);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Táto zákazka nie je tvoja.']);
  assert.strictEqual(save(w, 'ana').rep, c.rep);
  assert.strictEqual(w.maxRep, Econ.maxRepOf(w.saves));
  assert.ok(r.outbox.some(m => m.t === 'fx' && m.k === 'hearts'));
  // batoh: dar + sklad v jednom kroku
  give(save(w, 'ana'), `fl_${SP}`, 3, w.tick - TPD); give(save(w, 'bob'), `fl_${SP}`, 2, w.tick);
  r = E.commitBatch(w, [act('gift', 'ana', { to: 'bob', item: `fl_${SP}` }), act('store', 'bob', { id: `fl_${SP}`, n: 2 })], SPEC);
  assert.strictEqual(r.rounds, 2);
  assert.deepStrictEqual([flowers(w, 'ana'), flowers(w, 'bob'), w.storage[`fl_${SP}`]], [2, 1, 2]);
  assert.ok(r.outbox.some(m => m.to === 'bob' && /daroval/.test(textOf(m))) && r.outbox.some(m => m.to === 'ana' && /Daroval/.test(textOf(m))));
  // sklad ďaleko od domčeka
  pr(w, 1).x = 20;
  r = E.commitBatch(w, [act('unstore', 'bob', { id: `fl_${SP}`, n: 1 })], SPEC);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Sklad je v domčeku – podíď bližšie.']);
  // polievanie
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); soil(w, ti[0]).w = 0;
  save(w, 'ana').water = 0;
  r = E.commitBatch(w, [act('water', 'ana', { i: ti[0] }), act('water', 'bob', { i: ti[0] })], SPEC);
  assert.deepStrictEqual([r.rejected.length, soil(w, ti[0]).w, save(w, 'bob').water], [1, 1, 4]);
  assert.match(must(r.rejected[0]).reject ?? '', /Krhla je prázdna/);
});

test('zmiešaná dávka akcií v ľubovoľnom poradí dáva rovnaké návrhy; vykonanie je deterministické', () => {
  const mk = (): { w: W; inputs: E.Input[] } => {
    seq = 100;
    const w = makeWorld(8);
    const ti = tillable(w);
    plant(w, ti[0], 'ana', true); plant(w, ti[1], 'bob', true); plant(w, ti[2], 'ana', false);
    give(save(w, 'ana'), `fl_${SP}`, 4, w.tick); give(save(w, 'bob'), `seed_${SP}`, 2, w.tick); give(save(w, 'ana'), 'po_rast', 1, w.tick); give(save(w, 'bob'), 'fl_papradie', 1, w.tick);
    seedOf(w, SP).stock = 2;
    const c = must(w.contracts.list.find(x => !x.takenBy));
    const inputs = [
      act('pick', 'ana', { i: ti[0] }), act('pick', 'bob', { i: ti[0] }), act('pick', 'bob', { i: ti[1] }), act('water', 'ana', { i: ti[2] }),
      act('till', 'bob', { i: ti[3] }), act('till', 'ana', { i: ti[4] }), act('buy', 'ana', { id: `seed_${SP}`, n: 2 }), act('buy', 'bob', { id: `seed_${SP}`, n: 1 }),
      act('sell', 'bob', { id: `seed_${SP}`, n: 2 }), act('ctake', 'bob', { id: c.id }), act('gift', 'ana', { to: 'bob', item: `fl_${SP}` }),
      act('store', 'bob', { id: `fl_${SP}`, n: 1 }), act('potion', 'ana', { kind: 'rast', area: 'garden', x: ti[2] % D.W, y: Math.floor(ti[2] / D.W) }),
      act('well', 'ana', {}), act('wish', 'bob', { kind: 'zlato' }), act('upgrade', 'ana', { kind: 'plots' }), act('compostWilted', 'bob', {})
    ];
    return { w, inputs };
  };
  const view = (r: E.Result<Msg>): string => json({ id: r.id, reads: [...r.reads].sort(), writes: [...r.writes].sort(), slices: r.slices, ops: r.ops, outbox: r.outbox, reject: r.reject, error: r.error === undefined ? undefined : r.error instanceof Error ? String(r.error) : json(r.error) });
  const { w, inputs } = mk();
  const ref = new Map(inputs.map(inp => [inp, view(E.evaluate(w, inp, SPEC, w.presence))]));
  for (const inp of inputs) assert.strictEqual(must(ref.get(inp)).includes('"error"'), false, inp.type + ' ' + String(ref.get(inp)));
  for (let s = 1; s <= 5; s++) for (const inp of shuffle(inputs, s)) assert.strictEqual(view(E.evaluate(w, inp, SPEC, w.presence)), ref.get(inp), inp.type);
  const a = mk(), b = mk();
  const ra = E.commitBatch(a.w, a.inputs, SPEC), rb = E.commitBatch(b.w, b.inputs, SPEC);
  assert.strictEqual(json(a.w), json(b.w));
  assert.deepStrictEqual(ra.outbox, rb.outbox);
  assert.ok(ra.rounds >= 2 && ra.applied.length >= 10 && ra.rejected.length >= 2, `kolá ${ra.rounds}, vykonané ${ra.applied.length}, odmietnuté ${ra.rejected.length}`);
  assert.strictEqual(a.w.plotsUsed, Econ.plotsUsedOf(a.w.tiles));
  assert.strictEqual(save(a.w, 'ana').coins + save(a.w, 'bob').coins > 1000 + 800 - 400, true, 'zlatý dážď zaplatil obom prítomným');
});

// ---- Odmietnutie, chyba, prítomnosť ----

test('odmietnutie je potichu (null) alebo so správou; chyba v akcii nezanechá nič a je v denníku ako error', () => {
  const w = makeWorld(9);
  const ti = tillable(w);
  const entries: Journal = [], errors: string[] = [];
  const spec: Spec = { ...withJournal(SPEC, entries), onError: e => { errors.push(e instanceof Error ? e.message : ''); } };
  // compost na tráve (nič sa nedeje, bez správy), sadenie bez záhonu (správa), akcia neprítomného hráča (potichu), chyba (neexistujúce uloženie → TypeError? nie: potichu)
  give(save(w, 'ana'), 'compost', 1, w.tick); give(save(w, 'ana'), `seed_${SP}`, 1, w.tick);
  const r = E.commitBatch(w, [act('compost', 'ana', { i: ti[0] }), act('plant', 'ana', { i: ti[0], item: `seed_${SP}` }), act('scavStart', 'cyril', { i: ti[0], seeds: false }), act('buy', 'cyril', { id: 'compost', n: 1 }),
    Object.assign(act('fillIce', 'ana', { n: 1 }), { data: null })], spec);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), [null, 'Najprv zem prekopaj motykou.', null, null]);
  assert.strictEqual(errors.length, 1, 'akcia bez dát spadne – ako chyba, nie ako pád servera');
  const e0 = must(entries[0]);
  assert.deepStrictEqual(e0.proposals.map(p => p.outcome), ['rejected', 'rejected', 'rejected', 'rejected', 'error']);
  assert.deepStrictEqual([save(w, 'ana').inv.compost, save(w, 'ana').inv[`seed_${SP}`], at(w, ti[0]).s], [1, 1, null]);
  assert.deepStrictEqual(e0.presence, w.presence, 'záznam dávky nesie snímku prítomnosti');
  assert.strictEqual(must(e0.inputs[0]).actor, 'ana');
});

test('hľadanie v tráve: scavStart naplánuje scavDone a pošle pokyn prítomnosti; scavStop ju zruší; divé semienko sa sadí podľa cien trhu', () => {
  const w = makeWorld(10);
  const grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
  let r = E.commitBatch(w, [act('scavStart', 'ana', { i: grass, seeds: true })], SPEC);
  const ev = E.pending(w, 'scavDone:ana');
  assert.ok(ev && ev.at === w.tick + D.SCAVENGE.ticks && field(ev.data, 'i') === grass && field(ev.data, 'seeds') === true);
  assert.deepStrictEqual(r.outbox, [{ to: 'ana', t: 'scavStart', i: grass, n: field(ev.data, 'n'), seeds: true }]);
  assert.ok(must(r.applied[0]).writes.has('event:scavDone:ana'));
  r = E.commitBatch(w, [act('scavStop', 'ana', {})], SPEC);
  assert.strictEqual(E.pending(w, 'scavDone:ana'), null);
  // koniec hľadania podľa prítomnosti (events.js) – n z id vstupu
  E.commitBatch(w, [act('scavStart', 'ana', { i: grass, seeds: false })], SPEC);
  pr(w, 0).scav = partial<NonNullable<Presence['scav']>>({ i: grass, n: String(field(nn(E.pending(w, 'scavDone:ana')).data, 'n')) });
  const before = json(save(w, 'ana').inv);
  E.advanceTo(w, w.tick + D.SCAVENGE.ticks, SPEC);
  assert.strictEqual(w.scav[grass], Math.floor(w.tick / D.SCAVENGE.window), 'políčko je prehľadané');
  assert.ok(json(save(w, 'ana').inv) === before || Object.keys(save(w, 'ana').inv).some(id => id.startsWith('wild_')));
  // divé semienko: druh podľa cien kvetov, len na čítanie
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); soil(w, ti[0]).p = null;
  const se = D.seasonOf(D.dayOfTick(w.tick));
  give(save(w, 'ana'), `wild_${se}`, 1, w.tick);
  r = E.commitBatch(w, [act('plantWild', 'ana', { i: ti[0], item: `wild_${se}` })], SPEC);
  assert.ok(must(r.applied[0]).reads.has('market:fl_*') && must(r.applied[0]).reads.has('eternal'));
  const p = nn(soil(w, ti[0]).p);
  assert.ok(p.wild === 1 && D.SPECIES[p.sp]);
  assert.strictEqual(save(w, 'ana').inv[`wild_${se}`], undefined);
});

test('elixíry a studňa: dážď mení počasie, polieva a kŕmi ľadovec raz za deň; dúha platí len prítomným; víly naplánujú koniec', () => {
  const w = makeWorld(11);
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); soil(w, ti[0]).w = 0;
  for (const t of w.hory) if (t.ice != null) t.ice = 0;
  give(save(w, 'ana'), 'po_dazd', 1, w.tick); give(save(w, 'ana'), 'po_duha', 1, w.tick); give(save(w, 'bob'), 'po_vily', 1, w.tick);
  w.saves['cyril'] = parseJson<PlayerSave>(json(save(w, 'ana'))); // offline hráč
  let r = E.commitBatch(w, [act('potion', 'ana', { kind: 'dazd', area: 'garden', x: 5, y: 5 })], SPEC);
  assert.deepStrictEqual([w.weather, soil(w, ti[0]).w, w.glacierFed], ['rain', 1, D.dayOfTick(w.tick)]);
  assert.strictEqual(Ice.glacierTotal(w.hory), D.GLACIER_GROW.rain);
  assert.ok(r.outbox.some(m => m.to === E.ALL && /dážď/.test(textOf(m))));
  r = E.commitBatch(w, [act('potion', 'ana', { kind: 'duha', area: 'garden', x: 5, y: 5 }), act('potion', 'bob', { kind: 'vily', area: 'garden', x: 5, y: 5 })], SPEC);
  assert.deepStrictEqual([save(w, 'ana').coins, save(w, 'bob').coins, save(w, 'cyril').coins], [800, 800, 500], 'dúha platí len pripojeným');
  assert.ok(must(r.applied.find(x => field(x.input.data, 'kind') === 'duha')).writes.has('save:bob'));
  assert.ok(E.pending(w, 'vilyEnd:bob') && save(w, 'bob').vily === w.tick + TPD);
  // studňa: 5 mincí, náhoda z enginu; rovnaké semienko → rovnaký výsledok
  const run = (): W => { const x = makeWorld(12); E.commitBatch(x, [{ type: 'well', data: { key: 'ana' }, id: 'a#7', actor: 'ana' }], SPEC); return x; };
  const a = run(), b = run();
  assert.strictEqual(save(a, 'ana').coins, 495);
  assert.strictEqual(json(a), json(b));
  const poor = makeWorld(13); save(poor, 'ana').coins = 3;
  assert.deepStrictEqual(E.commitBatch(poor, [act('well', 'ana', {})], SPEC).rejected.map(x => x.reject), ['Na prianie potrebuješ hodiť do studne 5 🪙.']);
});

test('krhla v zime (#87): zamrznuté jazierko a pleso len cez vysekaný otvor, studňa vždy, v lete ako doteraz', () => {
  const dayOf = (se: number): number => se * D.DAYS_PER_SEASON + 1; // prvý deň obdobia se
  const draw = (se: number, area: 'garden' | 'hory', g: 'water' | 'well', cut: boolean): { water: number; reject: string | null | undefined; splash: boolean } => {
    const w = makeWorld(87, (dayOf(se) - 1) * TPD + D.DAWN_TICK + 6);
    assert.strictEqual(D.seasonOf(D.dayOfTick(w.tick)), se);
    const list = area === 'garden' ? w.tiles : w.hory, i = list.findIndex(t => t.g === g);
    assert.ok(i >= 0, `${area} má políčko ${g}`);
    if (cut) must(list[i]).cut = 1;
    save(w, 'ana').water = 0;
    let r = E.commitBatch(w, [act('drawWater', 'ana', { area, i })], SPEC);
    if (cut && !r.rejected.length) { save(w, 'ana').water = 0; r = E.commitBatch(w, [act('drawWater', 'ana', { area, i })], SPEC); } // z jedného otvoru aj opakovane
    return { water: save(w, 'ana').water, reject: r.rejected[0]?.reject, splash: r.outbox.some(m => json(m).includes('splash')) };
  };
  const cap = Econ.canCap(save(makeWorld(87), 'ana'));
  // zima bez otvoru: žiadna voda, žiadne špliechnutie, hláška podľa plochy
  assert.deepStrictEqual(draw(3, 'garden', 'water', false), { water: 0, reject: D.frozenWaterText('garden'), splash: false });
  assert.deepStrictEqual(draw(3, 'hory', 'water', false), { water: 0, reject: D.frozenWaterText('hory'), splash: false });
  assert.match(D.frozenWaterText('garden'), /^Jazierko je zamrznuté/);
  assert.match(D.frozenWaterText('hory'), /^Pleso je zamrznuté/);
  // zima s otvorom: naberie ako vždy
  assert.deepStrictEqual(draw(3, 'garden', 'water', true), { water: cap, reject: undefined, splash: true });
  assert.deepStrictEqual(draw(3, 'hory', 'water', true), { water: cap, reject: undefined, splash: true });
  // ráno otvor zamrzne – krhla znova nič nenaberie
  {
    const w = makeWorld(87, (dayOf(3) - 1) * TPD + D.DAWN_TICK + 6), i = w.tiles.findIndex(t => t.g === 'water');
    must(w.tiles[i]).cut = 1;
    save(w, 'ana').water = 0;
    assert.strictEqual(E.commitBatch(w, [act('drawWater', 'ana', { area: 'garden', i })], SPEC).rejected.length, 0);
    Ice.dawnIce(w.tiles, w.hory, 3, null);
    assert.strictEqual(w.tiles[i]?.cut, undefined);
    save(w, 'ana').water = 0;
    const r = E.commitBatch(w, [act('drawWater', 'ana', { area: 'garden', i })], SPEC);
    assert.deepStrictEqual([save(w, 'ana').water, r.rejected.map(x => x.reject)], [0, [D.frozenWaterText('garden')]]);
  }
  // studňa nezamŕza
  assert.deepStrictEqual(draw(3, 'garden', 'well', false), { water: cap, reject: undefined, splash: true });
  // ostatné obdobia bez zmeny
  for (const se of [0, 1, 2]) {
    assert.deepStrictEqual(draw(se, 'garden', 'water', false), { water: cap, reject: undefined, splash: true });
    assert.deepStrictEqual(draw(se, 'hory', 'water', false), { water: cap, reject: undefined, splash: true });
  }
});

test('ľadovňa a sklad: stavba, naplnenie ľadom pri ľadovni, vylepšenia (spoločné povolenie mení up), kotlík', () => {
  const w = makeWorld(14);
  w.icehouse = partial<Icehouse>({ built: false, ice: 0 }); Ice.applyIcehouse(w.icehouse, w.tiles);
  save(w, 'ana').rep = must(D.REP_LEVELS[D.ICEHOUSE.rep]); save(w, 'ana').coins = 5000;
  let r = E.commitBatch(w, [act('build', 'ana', {}), act('build', 'bob', {})], SPEC);
  assert.deepStrictEqual([w.icehouse.built, r.rejected.map(x => x.reject)], [true, ['Ľadovňa už v záhrade stojí.']]);
  assert.ok(Ice.lotIdx().every(i => at(w, i).g === 'icehouse'));
  give(save(w, 'ana'), 'ice', 3, w.tick);
  const L = D.ICEHOUSE.lot; pr(w, 0).x = L.x0 + 1; pr(w, 0).y = L.y0 + 1;
  r = E.commitBatch(w, [act('fillIce', 'ana', { n: 2 })], SPEC);
  assert.deepStrictEqual([w.icehouse.ice, save(w, 'ana').inv.ice], [2, 1]);
  r = E.commitBatch(w, [act('upgrade', 'ana', { kind: 'plots' }), act('upgrade', 'bob', { kind: 'can' })], SPEC);
  assert.deepStrictEqual([w.up.plots, save(w, 'bob').up.can], [2, 1]);
  assert.ok(must(r.applied[0]).writes.has('up') && !must(r.applied[1]).writes.has('up'));
  assert.ok(r.outbox.some(m => m.to === E.ALL && /pre celú záhradu/.test(textOf(m))));
  const recipe = must(Object.keys(D.RECIPES)[0]), fls = recipe.split('+').map(x => 'fl_' + x);
  for (const id of fls) give(save(w, 'ana'), item(id), 1, w.tick);
  r = E.commitBatch(w, [act('brew', 'ana', { items: fls })], SPEC);
  assert.strictEqual(save(w, 'ana').inv[item('po_' + must(D.RECIPES[recipe]))], 1);
  assert.ok(save(w, 'ana').recipes.includes(recipe) && r.outbox.some(m => m.t === 'brewed' && !('hint' in m)));
  // sliz: správa brewed nesie radu kotlíka (#84) – známy recept rastu sa pri zhode s hojnosťou neuprednostní
  const slime = ['fl_levandula', 'fl_harmancek', 'fl_mak'].map(item);
  for (const id of slime) give(save(w, 'ana'), id, 1, w.tick);
  r = E.commitBatch(w, [act('brew', 'ana', { items: slime })], SPEC);
  assert.strictEqual(save(w, 'ana').inv.po_sliz, 1);
  const brewed = r.outbox.find(m => m.t === 'brewed');
  assert.deepStrictEqual(brewed && 'hint' in brewed ? brewed.hint : null, { fit: 2, hit: ['levandula', 'mak'], clue: { seasons: [1], magic: false, other: true }, known: null });
  assert.deepStrictEqual(E.commitBatch(w, [act('brew', 'ana', { items: fls })], SPEC).rejected.map(x => x.reject), ['Tieto kvety nemáš.']);
});

// ---- Prítomnosť v denníku a prehranie ----

test('denník s akciami a prítomnosťou sa prehrá na ten istý svet a ten istý denník (udalosti z fronty, akcie zo záznamov)', () => {
  const run = (w: W, journal: Journal): void => {
    const spec = withJournal(SPEC, journal), ti = tillable(w), grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
    seq = 500;
    E.advanceTo(w, w.tick + 3, spec);
    E.commitBatch(w, [act('till', 'ana', { i: ti[0] }), act('buy', 'ana', { id: `seed_${SP}`, n: 2 }), act('scavStart', 'bob', { i: grass, seeds: false })], spec);
    pr(w, 1).scav = partial<NonNullable<Presence['scav']>>({ i: grass, n: 'a#503' });
    E.advanceTo(w, w.tick + 5, spec);
    E.commitBatch(w, [act('plant', 'ana', { i: ti[0], item: `seed_${SP}` }), act('gift', 'ana', { to: 'bob', item: `seed_${SP}` }), act('well', 'bob', {})], spec);
    pr(w, 1).scav = null;
    E.advanceTo(w, w.tick + 2 * TPD, spec);
    E.commitBatch(w, [act('water', 'ana', { i: ti[0] }), act('sell', 'bob', { id: `seed_${SP}`, n: 1 })], spec);
    E.advanceTo(w, w.tick + TPD, spec);
  };
  const a = makeWorld(15, 0), ja: Journal = [];
  run(a, ja);
  assert.ok(ja.some(e => e.inputs.some(i => i.actor === 'ana')) && ja.every(e => Array.isArray(e.presence)));
  const b = makeWorld(15, 0), jb: Journal = [];
  delete b.presence; // prehranie dostane prítomnosť z denníka, nie zo sveta
  const spec: Spec = { ...withJournal(SPEC, jb), presence: () => { throw new Error('prehranie nesmie siahať na živú prítomnosť'); } };
  const n = E.replay(b, parseJson<Journal>(json(ja)), spec);
  E.advanceTo(b, a.tick, spec);
  b.presence = a.presence;
  assert.strictEqual(n, ja.length);
  assert.strictEqual(json(b), json(a));
  assert.strictEqual(json(jb), json(ja));
});

// ---- Server: skutočné správy ----

// Voľný port od systému (náhodné porty z rozsahov sa občas zrazia medzi testami)
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = portOf(srv); srv.close(() => { r(p); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number, env?: Partial<Record<string, string>>): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000' }, env || {}), stdio: ['ignore', 'pipe', 'pipe']
  });
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
  got: ServerMessage[];
  wait<T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number): Promise<MsgOf<T>>;
  send(m: ClientMessage): void;
}
// Prvá prijatá správa daného typu
const gotOf = <T extends MsgType>(c: Client, t: T): MsgOf<T> => must(c.got.find((m): m is MsgOf<T> => isMsg(m, t)));
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
  return new Promise(r => ws.on('open', () => { void (async () => { ws.send(json({ t: 'join', room, name })); await wait('welcome'); r({ ws, got, wait, send: m => { ws.send(json(m)); } }); })(); }));
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

test('server: správy hráčov idú cez schránku a dávku akcií – stav, toasty, obnova klientov, denník s prítomnosťou, prehranie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-akcie-'));
  const port = await freePort();
  const w = makeWorld(16);
  delete w.presence;
  const ti = tillable(w);
  // ana a bob pri políčku ti[0] (uložená poloha), s predmetmi; ľadovňa postavená
  const px = ti[0] % D.W + 1.5, py = Math.floor(ti[0] / D.W) + 0.5;
  for (const k of ['ana', 'bob']) Object.assign(save(w, k), { x: px, y: py, area: 'garden', look: { shirt: '#000', hair: '#000', hat: false }, talked: true });
  give(save(w, 'ana'), `seed_${SP}`, 3, w.tick); give(save(w, 'ana'), `fl_${SP}`, 2, w.tick);
  w.icehouse = partial<Icehouse>({ built: false, ice: 0 }); Ice.applyIcehouse(w.icehouse, w.tiles);
  save(w, 'bob').rep = must(D.REP_LEVELS[D.ICEHOUSE.rep]); save(w, 'bob').coins = D.ICEHOUSE.price + 10;
  seedOf(w, SP).stock = 1;
  save(w, 'ana').wellFern = 3; // voliteľné pole uloženia (studňa, #100): prežije prevod, načítanie aj uloženie
  // uloženie starého formátu (v9) – migrácia na serveri ho doplní
  const save9 = Object.assign(parseJson<JsonRecord>(json(w)), { v: 9, mode: 'paused', wall: Date.now(), tiles: w.tiles.map(t => ({ s: t.s })), hory: Ice.saveHory(w.hory), les: null, pomedzieSeed: 1, lesSeed: 1 });
  fs.writeFileSync(path.join(dir, 'room-akcie.json'), json(save9));
  const proc = await startServer(dir, port);
  let ana: Client | undefined, bob: Client | undefined;
  try {
    ana = await client(port, 'akcie', 'Ana'); bob = await client(port, 'akcie', 'Bob');
    const A = ana, B = bob;
    const x = ti[0] % D.W, y = Math.floor(ti[0] / D.W);
    // obaja kopú to isté políčko v jednom rámci: jeden záhon, druhý dostane toast; plots príde obom
    A.send({ t: 'act', x, y, item: 'hoe' }); B.send({ t: 'act', x, y, item: 'hoe' });
    const tile = await A.wait('tile', m => m.i === ti[0] && m.v.s);
    const owner = nn(tile.v.s).o;
    assert.ok(owner === 'ana' || owner === 'bob');
    const loser = owner === 'ana' ? B : A;
    await loser.wait('toast', m => m.text === 'Tu už je záhon.');
    await B.wait('plots', m => m.used === 1);
    // sadenie + polievanie od jednej hráčky v jednom rámci: druhá akcia na políčku počká na ďalší rámec, obe prejdú
    A.send({ t: 'act', x, y, item: `seed_${SP}` }); A.send({ t: 'act', x, y, item: 'can' });
    await A.wait('tile', m => m.i === ti[0] && m.v.s?.p && m.v.s.p.sp === SP && m.v.s.w === 1);
    const me1 = await A.wait('me', m => m.inv[`seed_${SP}`] === 2 && m.water === 4);
    assert.ok(me1);
    // posledné semienko kúpi práve jeden; druhý dostane „Vypredané“
    A.send({ t: 'buy', id: `seed_${SP}`, n: 1 }); B.send({ t: 'buy', id: `seed_${SP}`, n: 1 });
    const t1 = await A.wait('toast', m => /Kúpené|Vypredané/.test(m.text)), t2 = await B.wait('toast', m => /Kúpené|Vypredané/.test(m.text));
    assert.ok([t1.text, t2.text].filter(t => /Kúpené/.test(t)).length === 1, t1.text + ' / ' + t2.text);
    await A.wait('market', m => m.seeds[SP]?.st === 0);
    // predaj kvetu, dar, sklad (pri domčeku nie sú → toast), ľadovňa bez ľadu, zákazka
    A.send({ t: 'sell', id: `fl_${SP}`, n: 1 });
    await A.wait('toast', m => /Predané: 1×/.test(m.text));
    A.send({ t: 'store', id: `fl_${SP}`, n: 1 });
    await A.wait('toast', m => /Sklad je v domčeku/.test(m.text));
    B.send({ t: 'icehouse', n: 1 });
    await B.wait('toast', m => /nie je postavená/.test(m.text));
    // stavba ľadovne mení typ zeme: klient dostane celú plochu (prestavia 3D svet) a room s ľadovňou
    B.send({ t: 'build', id: 'icehouse' });
    const all = await A.wait('tiles', m => m.tiles[must(Ice.lotIdx()[0])]?.g === 'icehouse');
    assert.ok(Ice.lotIdx().every(i => all.tiles[i]?.g === 'icehouse'));
    await B.wait('room', m => m.icehouse.built);
    await A.wait('toast', m => /postavil\(a\) pri domčeku ľadovňu/.test(m.text));
    const board = gotOf(B, 'board'), c0 = must(board.list[0]);
    B.send({ t: 'ctake', id: c0.id });
    await B.wait('toast', m => /Zákazka je tvoja/.test(m.text));
    await A.wait('board', m => m.list.find(c => c.id === c0.id)?.takenBy);
    // hľadanie v tráve: klik príliš ďaleko hľadanie nepreruší (ako pôvodný handler), ten istý klik = „stále hľadáš“, iná akcia preruší
    const grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s), gx = grass % D.W, gy = Math.floor(grass / D.W);
    const seqA = gotOf(A, 'welcome').seq;
    A.send({ t: 'move', x: gx + 0.5, y: gy + 0.5, dir: 0, ar: seqA });
    await A.wait('pl', m => m.list.some(p => p.name === 'Ana' && p.x === gx + 0.5));
    A.send({ t: 'act', x: gx, y: gy, item: '' });
    await A.wait('pl', m => m.list.some(p => p.name === 'Ana' && p.si === grass));
    const n0 = A.got.length;
    A.send({ t: 'act', x: gx >= 10 ? gx - 10 : gx + 10, y: gy, item: '' }); // vnútri plochy, ale ďaleko
    await A.wait('toast', m => m.text === 'Si príliš ďaleko.');
    A.send({ t: 'act', x: gx, y: gy, item: '' });
    await A.wait('toast', m => /Ešte stále hľadáš/.test(m.text));
    assert.ok(!A.got.slice(n0).some(m => m.t === 'toast' && /Prestal/.test(m.text)), 'ďaleký klik hľadanie neprerušil');
    A.send({ t: 'act', x: gx, y: gy, item: 'hoe' });
    await A.wait('toast', m => /Prestal\(a\) si hľadať/.test(m.text));
    await A.wait('pl', m => m.list.some(p => p.name === 'Ana' && p.si === -1));
    // záplava akcií jedného hráča nezablokuje správy ostatných
    for (let k = 0; k < 300; k++) B.send({ t: 'act', x, y, item: 'hoe' });
    A.send({ t: 'buy', id: 'compost', n: 1 });
    await A.wait('toast', m => /Kúpené: 1× Kompost/.test(m.text), 1500);
    await sleep(250);
  } finally {
    if (ana) ana.ws.close(); if (bob) bob.ws.close();
    await sleep(150);
    await stopServer(proc);
  }
  // denník: záznamy akcií s id a#, actor a prítomnosťou; prehranie zo začiatočného uloženia dá ten istý svet
  type Line = E.JournalEntry<Presence, Msg> & { load?: boolean };
  const lines = fs.readFileSync(path.join(dir, 'journal-akcie.jsonl'), 'utf8').trim().split('\n').map(l => parseJson<Line>(l));
  const entries = lines.filter(e => !e.load);
  assert.ok(entries.length >= 5 && entries.every(e => e.inputs.every(i => /^a#\d+$/.test(i.id) && typeof i.actor === 'string') && Array.isArray(e.presence)), 'denník: ' + entries.length);
  assert.ok(entries.some(e => e.presence?.length === 2 && e.inputs.some(i => i.type === 'pos')), 'pohyb je v denníku');
  assert.ok(entries.every(e => !e.inputs.some(i => i.ev)), 'akcie a udalosti nikdy v jednej dávke');
  const types = entries.flatMap(e => e.inputs.map(i => i.type));
  for (const t of ['join', 'pos', 'till', 'plant', 'water', 'buy', 'sell', 'store', 'fillIce', 'build', 'ctake', 'leave']) assert.ok(types.includes(t), t);
  const final = readJson<SaveFile>(path.join(dir, 'room-akcie.json'));
  assert.strictEqual(must(final.saves['ana']).wellFern, 3, 'wellFern sa uloží a načíta bez zmeny verzie uloženia');
  const start = parseJson<SaveFile>(json(save9));
  Dock.migrate(start); // ako migrácia na v12 (#160): nová voda jazierka, mólo ešte nie je
  const { tiles: savedTiles, hory: savedHory, les: savedLes, ...rest } = start;
  const room = testWorld({ ...rest, tiles: D.buildMap().map((g, i) => ({ g, s: must(savedTiles[i]).s })), hory: Ice.loadHory(savedHory) });
  Ice.applyIcehouse(room.icehouse, room.tiles);
  room.icehouse.bl = 0; room.dielna = Dielna.newDielna(); room.redeem = start.redeem; // ako migrácia z verzie 10 (#23)
  room.plotsUsed = Econ.plotsUsedOf(room.tiles); room.maxRep = Econ.maxRepOf(room.saves); // ako getRoom: odvodené počítadlá sa pri načítaní prepočítajú
  room.vehicles = Vehicles.loadVehicles(start.vehicles, start.tick); // ako getRoom: fúrik a sane (#158), staršie uloženie ich nemá
  const les = Areas.loadLes(savedLes, start.lesSeed); // ako getRoom: Les divov, trh a nástenka, pavučiny (jeden živý kontext)
  const world = Object.assign(room, { les });
  const live: GameCtx = E.liveCtx(world, 'ekonomika');
  Econ.initEconomy(world, live); Spiders.load(world, live);
  E.replay(world, entries, { proposers: { ...SPEC.proposers, ...Spiders.PROPOSERS, ...Vehicles.PROPOSERS, ...Vehicles.EVENTS, ...Dock.PROPOSERS }, periodic: must(SPEC.periodic).concat(Spiders.PERIODIC, Vehicles.PERIODIC, Dock.PERIODIC), onError: rethrow,
    slice: (w, k) => { const sl = Spiders.slice(w, k); return sl === undefined ? E.sliceOf(w, k) : sl; } });
  // mimo denníka sú len prítomnosť a polohy (join/move): porovnáme svet bez nich
  const strip = (st: unknown): JsonRecord => {
    const o = parseJson<JsonRecord>(json(st));
    for (const f of ['wall', 'v', 'migratedFrom', 'daySeconds', 'hory', 'les', 'tiles', 'sps', 'kz']) delete o[f];
    const saves = o['saves'];
    if (isRecord(saves)) for (const k in saves) { const sv = saves[k]; if (isRecord(sv)) for (const f of ['lastTick', 'x', 'y', 'area', 'look', 'talked']) delete sv[f]; }
    return o;
  };
  assert.deepStrictEqual(strip(world), strip(final));
  assert.deepStrictEqual(world.tiles.map(t => t.s), final.tiles.map(t => t.s));
});

test('hygiena: server už nemení svet priamo – liveCtx len pri založení sveta; sendMe a políčka len z notify, uloženia nikde', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts'), 'utf8');
  assert.strictEqual((src.match(/liveCtx/g) || []).length, 1);
  assert.ok(!/actionCtx|Econ\.buy\(|Econ\.sell\(|Econ\.upgrade\(|deliverContract|takeContract|Ice\.digIce|Ice\.fillIcehouse|Ice\.buildIcehouse|Ice\.buyTool|pickWild|checkFairies|newSave|migrateSave/.test(src));
  const ws = src.slice(src.indexOf("ws.on('message'"), src.indexOf("ws.on('close'"));
  assert.ok(!/case '/.test(ws), 'handler správ len overí a vloží do schránky');
  assert.ok(!/\.save\.\w+ =|\.save\.lastTick|room\.saves\[\w+\] =/.test(src), 'uloženia hráčov nemení server, len návrhy');
  // obnova klientov sa odvodzuje: sendMe a políčka sa posielajú len z notify (a políčka plochy pri príchode / pripojení)
  const fnBody = (name: string): string => { const i = src.indexOf('function ' + name + '('); return src.slice(i, src.indexOf('\n}\n', i)); };
  const calls = (re: RegExp): number => (src.match(re) || []).length, inNotify = (re: RegExp): number => (fnBody('notify').match(re) || []).length;
  assert.strictEqual(calls(/sendMe\(/g) - 1, inNotify(/sendMe\(/g), 'sendMe len v notify');
  assert.strictEqual(calls(/tileMsg\(/g) - 1, inNotify(/tileMsg\(/g), 'tileMsg len v notify');
  assert.ok(Object.keys(Actions.PROPOSERS).length >= 33);
});

test('uloženie v8 (288 krokov za deň) sa prevedie na v9: každý krok ×40 – ten istý deň a hodina, udalosti, várky, rastliny, zákazky, sviatok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-v9-'));
  const port = await freePort();
  const K = D.TICKS_PER_DAY / 288;
  const f = must(D.FESTIVALS[1]);
  type OldSoil = { k: string; w: number; r: number; o: string; p: { sp: SpeciesId; prog: number; q: number; dry: number; bt: number } };
  const seeds: Partial<Record<SpeciesId, { stock: number }>> = {}, fls: Partial<Record<SpeciesId, { stock: number }>> = {};
  const old = { // svet vo verzii 8: deň 3, 7:30 (tick 2*288 + 90)
    v: 8, tick: 2 * 288 + 90, wall: Date.now(), mode: 'paused', daySeconds: 1200, seed: E.newSeed(), step: 5, seq: 20, weather: 'sun',
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1, [`fl_${SP}`]: 2 }, fb: { [`fl_${SP}`]: [{ n: 2, a: 30, at: 600 }] }, recipes: [], seen: [], vily: 700, lastTick: 650, rep: 0, up: { can: 0, composter: 0 }, x: 5, y: 5, area: 'garden', talked: true } },
    storage: { [`fl_${SP}`]: 1 }, storageFb: { [`fl_${SP}`]: [{ n: 1, a: 10, at: 500 }] }, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 1, lesSeed: 1, les: null, scav: { 5: 55 }, scavSalt: 3, up: { plots: 0 }, glacierFed: 2, eternal: false, fairyNight: -1, plotsUsed: 1, maxRep: 0,
    market: { seeds, flowers: fls, compost: { stock: 5 }, hist: {}, news: [{ tick: 640, text: 'x' }], festival: { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: 900 }, npcs: { jano: { coins: 1 }, fero: { coins: 1, hold: {} } } },
    contracts: { list: [{ id: 1, kind: 'short', giver: 'babka', sp: SP, n: 2, got: 0, reward: 10, item: null, rep: 4, posted: 600, openUntil: 800, due: 1000, takenBy: null }], nextId: 2 },
    events: [{ at: 666, seq: 1, type: 'hourly', data: null, key: 'hourly', periodic: true }, { at: 1000, seq: 2, type: 'cDue', data: { id: 1 }, key: 'cDue:1' }, { at: 700, seq: 3, type: 'vilyEnd', data: { key: 'eva' }, key: 'vilyEnd:eva' }],
    tiles: D.buildMap().map((g, i): { s: OldSoil | null } => ({ s: i === 5 && D.TILLABLE[g] ? { k: 'normal', w: 1, r: 0, o: 'eva', p: { sp: SP, prog: D.SPECIES[SP].days, q: 3, dry: 0, bt: 650 } } : null }))
  };
  for (const sp of Econ.PLANTABLE) { seeds[sp] = { stock: 3 }; fls[sp] = { stock: 1 }; }
  const tilled = old.tiles.findIndex(t => t.s);
  if (tilled < 0) { must(old.tiles[D.buildMap().findIndex(g => g === 'grass')]).s = { k: 'normal', w: 1, r: 0, o: 'eva', p: { sp: SP, prog: 1, q: 3, dry: 0, bt: 650 } }; }
  fs.writeFileSync(path.join(dir, 'room-stary.json'), json(old));
  const proc = await startServer(dir, port);
  try { const c = await client(port, 'stary', 'Eva'); c.ws.close(); await sleep(100); } finally { await stopServer(proc); }
  const s = readJson<SaveFile>(path.join(dir, 'room-stary.json'));
  assert.strictEqual(s.v, 12);
  assert.strictEqual(s.tick, old.tick * K);
  assert.deepStrictEqual([D.dayOfTick(s.tick), D.minOfTick(s.tick)], [3, 450], 'deň 3, 7:30 ako predtým');
  assert.deepStrictEqual(s.events.filter(e => e.key !== 'dawn' && !/^(delivery|npc_|fest|spider:|kz:|kriziakTrip|webDawn|weave:|vehSeason|boatDay)/.test(e.key ?? '')).map(e => [e.key, e.at]).sort(), [['cDue:1', 1000 * K], ['hourly', 666 * K], ['vilyEnd:eva', 700 * K]]);
  const eva = must(s.saves['eva']), fb = must(must(eva.fb?.[`fl_${SP}`])[0]);
  assert.deepStrictEqual([eva.vily, fb.a, fb.at], [700 * K, 30 * K, 600 * K]);
  assert.ok((eva.lastTick ?? 0) >= 650 * K, 'lastTick preškálovaný (a pri odchode obnovený)');
  assert.deepStrictEqual(must(s.storageFb[`fl_${SP}`])[0], { n: 1, a: 10 * K, at: 500 * K });
  assert.strictEqual(nn(nn(must(s.tiles.find(t => t.s?.p)).s).p).bt, 650 * K);
  const c1 = must(s.contracts.list[0]);
  assert.deepStrictEqual([c1.posted, c1.openUntil, c1.due], [600 * K, 800 * K, 1000 * K]);
  assert.strictEqual(nn(s.market.festival).until, 900 * K);
  assert.strictEqual(must(s.market.news[0]).tick, 640 * K);
  assert.deepStrictEqual(s.scav, {});
  assert.strictEqual(s.glacierFed, 2, 'deň sa neškáluje');
  for (const [sp, k] of entries(f.mult)) assert.strictEqual(must(s.market.flowers[sp]).fest, k, 'sviatok v položkách kvetov');
});

// ---- Fáza 4: pohyb ako stav, prítomnosť ako vstupy ----

test('pohyb: poloha je stav (pos:<kľúč>), dvaja na jednom políčku prejdú, mimo plochy sa oreže, do vody sa nedá (oprava), brána prenesie, pohyb preruší hľadanie', () => {
  const w = makeWorld(17);
  const grass = w.tiles.findIndex(t => t.g === 'grass'), gx = grass % D.W + 0.5, gy = Math.floor(grass / D.W) + 0.5;
  let r = E.commitBatch(w, [act('pos', 'ana', { x: gx, y: gy }), act('pos', 'bob', { x: gx, y: gy })], SPEC);
  assert.strictEqual(r.rounds, 1, 'rôzni hráči: nezávislé návrhy');
  assert.deepStrictEqual([save(w, 'ana').x, save(w, 'ana').y, save(w, 'bob').x, save(w, 'bob').y, save(w, 'ana').lastTick], [gx, gy, gx, gy, w.tick]);
  assert.ok(must(r.applied[0]).writes.has('pos:ana') && !must(r.applied[0]).writes.has('save:ana'));
  // mimo plochy: orezané na okraj (ak je tam priechodná zem)
  r = E.commitBatch(w, [act('pos', 'ana', { x: -5, y: gy })], SPEC);
  if (r.applied.length) assert.strictEqual(save(w, 'ana').x, 0.2); else assert.strictEqual(must(r.rejected[0]).reject, null);
  // do vody sa nedá: odmietnuté potichu, poloha ostáva (server pošle opravu)
  const water = w.tiles.findIndex(t => t.g === 'water');
  const before: [number, number] = [save(w, 'bob').x, save(w, 'bob').y];
  r = E.commitBatch(w, [act('pos', 'bob', { x: water % D.W + 0.5, y: Math.floor(water / D.W) + 0.5 })], SPEC);
  assert.deepStrictEqual([r.rejected.length, must(r.rejected[0]).input.type, save(w, 'bob').x, save(w, 'bob').y], [1, 'pos', before[0], before[1]]);
  // nečíselná poloha – vstup s dátami, aké by poslal zlý klient (mimo typu akcie)
  const bad: E.Input = { ...act('pos', 'bob', { y: 1 }), data: { key: 'bob', x: 'x', y: 1 } };
  assert.ok(!Number.isFinite(E.commitBatch(w, [bad], SPEC).applied.length - 0) || save(w, 'bob').x === before[0], 'nečíselná poloha sa odmietne');
  // brána: príchodové miesto v cieľovej ploche a pokyn travel
  const g = must(D.GATES.garden.find(x => x.to === 'pomedzie')), arr = nn(D.arrival('garden', 'pomedzie'));
  r = E.commitBatch(w, [act('pos', 'ana', { x: g.x + 0.5, y: g.y + 0.5 })], SPEC);
  assert.deepStrictEqual([save(w, 'ana').area, save(w, 'ana').x, save(w, 'ana').y], ['pomedzie', arr.x, arr.y]);
  assert.deepStrictEqual(r.outbox, [{ to: 'ana', t: 'travel', from: 'garden', area: 'pomedzie' }]);
  // hľadanie v tráve: pohyb o viac než 0,35 ho preruší (prítomnosť nesie, odkiaľ sa hľadá)
  must(w.presence)[1] = { key: 'bob', name: 'Bob', area: 'garden', x: before[0], y: before[1], scav: { i: grass, n: 'a#1', px: before[0], py: before[1] } };
  E.scheduleUnique(w, 'scavDone:bob', w.tick + D.SCAVENGE.ticks, 'scavDone', { key: 'bob', n: 'a#1', i: grass, seeds: false });
  r = E.commitBatch(w, [act('pos', 'bob', { x: before[0] + 0.2, y: before[1] })], SPEC);
  assert.ok(E.pending(w, 'scavDone:bob'), 'malý pohyb hľadanie nepreruší');
  r = E.commitBatch(w, [act('pos', 'bob', { x: before[0] + 1, y: before[1] })], SPEC);
  assert.strictEqual(E.pending(w, 'scavDone:bob'), null);
  assert.ok(r.outbox.some(m => m.t === 'scavDone') && r.outbox.some(m => /Pohol/.test(textOf(m))));
});

test('pohyb a nákup v jednom rámci: uloženie (save:) polohu neprepíše, poloha (pos:) mince neprepíše; ráno (save:*) tiež nie', () => {
  const w = makeWorld(18);
  const price = Econ.seedPrice(w.market, w.tick, SP);
  const r = E.commitBatch(w, [act('buy', 'ana', { id: `seed_${SP}`, n: 1 }), act('pos', 'ana', { x: 7.5, y: 7.5 }), act('pos', 'bob', { x: 8.5, y: 7.5 }), act('sell', 'bob', { id: 'hoe', n: 1 })], SPEC);
  assert.strictEqual(r.rounds, 1, 'pos a save sú nezávislé výrezy');
  assert.deepStrictEqual([save(w, 'ana').coins, save(w, 'ana').x, save(w, 'ana').y, save(w, 'ana').inv[`seed_${SP}`]], [500 - price, 7.5, 7.5, 1]);
  assert.deepStrictEqual([save(w, 'bob').x, save(w, 'bob').coins], [8.5, 500]);
  // ráno píše všetky uloženia (save:*) – poloha sa nemení ani nezmizne
  const sv = parseJson<PlayerSave>(json(save(w, 'ana')));
  E.advanceTo(w, E.nextDailyTick(w.tick + 1, D.DAWN_TICK) + 1, SPEC);
  assert.deepStrictEqual([save(w, 'ana').x, save(w, 'ana').y, save(w, 'ana').area, save(w, 'ana').lastTick], [sv.x, sv.y, sv.area, sv.lastTick]);
  assert.ok((save(w, 'ana').inv.compost ?? 0) >= 1, 'kompostér pridal');
  // pos pre neexistujúce uloženie sa odmietne potichu
  assert.deepStrictEqual(E.commitBatch(w, [act('pos', 'nikto', { x: 1, y: 1 })], SPEC).rejected.map(x => x.reject), [null]);
});

test('tanec v kruhu z húb: v noci dvaja tancujúci (podľa prítomnosti a času správy) dostanú semienka, raz za noc; cez deň huby spia', () => {
  const w = makeWorld(19, 22 * D.TICKS_PER_HOUR); // 22:00
  const cx = D.RING.x0 + 0.5, cy = D.RING.y0 + 0.5, now = 1000000;
  const inRing = (key: string, name: string, at: number): Presence => ({ key, name, area: 'garden', x: cx, y: cy, scav: null, emote: 'dance', emoteAt: at });
  w.presence = [inRing('ana', 'Ana', now - 100), { key: 'bob', name: 'Bob', area: 'garden', x: cx, y: cy, scav: null, emote: 'wave', emoteAt: now }];
  let r = E.commitBatch(w, [act('dance', 'ana', { now })], SPEC);
  assert.ok(r.outbox.some(m => /čakali/.test(textOf(m))) && r.outbox.some(m => m.t === 'fx' && m.k === 'glimmer'), 'sama netancuje víly');
  w.presence[1] = inRing('bob', 'Bob', now - 3000);
  r = E.commitBatch(w, [act('dance', 'ana', { now })], SPEC);
  assert.ok(must(r.applied[0]).writes.has('save:bob') && must(r.applied[0]).writes.has('fairyNight'));
  assert.deepStrictEqual([save(w, 'ana').inv.seed_papradie, save(w, 'bob').inv.seed_duhova, w.fairyNight], [1, 1, D.dayOfTick(w.tick)]);
  assert.ok(r.outbox.some(m => m.to === E.ALL && /víly/.test(textOf(m))));
  r = E.commitBatch(w, [act('dance', 'bob', { now: now + 500 })], SPEC);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Víly už dnes v noci odleteli. Príď zajtra. 🧚']);
  // starý tanec (viac než 6,5 s) sa neráta; cez deň huby spia; mimo kruhu nič
  w.fairyNight = -1; pr(w, 1).emoteAt = now - 10000;
  assert.ok(E.commitBatch(w, [act('dance', 'ana', { now })], SPEC).outbox.some(m => /čakali/.test(textOf(m))));
  const day = makeWorld(19, 12 * D.TICKS_PER_HOUR); day.presence = [inRing('ana', 'Ana', now)];
  assert.deepStrictEqual(E.commitBatch(day, [act('dance', 'ana', { now })], SPEC).rejected.map(x => x.reject), ['Huby pokojne spia. Možno v noci… 🌙']);
  pr(w, 0).x = 10;
  assert.deepStrictEqual(E.commitBatch(w, [act('dance', 'ana', { now })], SPEC).rejected.map(x => x.reject), [null]);
});

test('pripojenie, odchod a „naposledy videný“ ako vstupy: nové uloženie so štartom zo záznamu, prevod starého, lastTick; denník sa prehrá', () => {
  const w = makeWorld(20);
  delete w.saves['bob']; w.maxRep = 0;
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: 5, y: 5, scav: null }, { key: 'cyril', name: 'Cyril', area: 'garden', x: 5, y: 5, scav: null }];
  w.saves['ana'] = partial<PlayerSave>({ coins: 1, water: 9, inv: { hoe: 1 }, recipes: [], seen: [], vily: 0, rep: 0, x: 5, y: 5, area: 'garden', lastTick: w.tick - 3 * TPD }); // staré uloženie bez up/fb
  const entries: Journal = [], spec = withJournal(SPEC, entries);
  let r = E.commitBatch(w, [act('join', 'cyril', { name: 'Cyril', look: { shirt: '#123', hair: '#456', hat: true }, start: { coins: 70, rep: 40 }, quick: false }), act('join', 'ana', { name: 'Ana', look: null, start: { coins: 70, rep: 40 }, quick: false })], spec);
  const c = save(w, 'cyril');
  assert.deepStrictEqual([c.coins, c.rep, c.look, c.talked, c.x, c.y, c.area, w.maxRep], [70, 40, { shirt: '#123', hair: '#456', hat: true }, true, D.SPAWN.x, D.SPAWN.y, 'garden', 40]);
  assert.ok(Object.keys(c.inv).some(id => id.startsWith('seed_')) && c.inv.hoe === 1);
  assert.deepStrictEqual([save(w, 'ana').up, save(w, 'ana').water, save(w, 'ana').talked], [{ can: 2, composter: 0 }, Math.min(9, Econ.canCap(save(w, 'ana'))), true], 'prevod starého uloženia: krhla, vylepšenia, uvítanie');
  const toasts = r.outbox.filter(m => m.t === 'toast').map(textOf);
  assert.ok(toasts.some(t => /Cyril prišiel/.test(t)) && toasts.some(t => /Vitaj/.test(t)) && toasts.some(t => /ubehlo 3 dni/.test(t)), json(toasts));
  assert.deepStrictEqual(r.outbox.filter(m => m.t === 'joined').map(m => m.to), ['cyril', 'ana']);
  // rýchle znovupripojenie: bez hlásení
  r = E.commitBatch(w, [act('join', 'ana', { name: 'Ana', look: null, start: { coins: 70, rep: 40 }, quick: true })], spec);
  assert.deepStrictEqual(r.outbox.map(m => m.t), ['joined']);
  E.advanceTo(w, w.tick + 10, spec);
  r = E.commitBatch(w, [act('seen', 'ana', {}), act('leave', 'cyril', {})], spec);
  assert.deepStrictEqual([save(w, 'ana').lastTick, save(w, 'cyril').lastTick, r.applied.every(x => [...x.writes].join() === `pos:${x.input.actor ?? ''}`)], [w.tick, w.tick, true]);
  // prehranie denníka (s prítomnosťou zo záznamov) dá ten istý svet
  const b = makeWorld(20); delete b.saves['bob']; b.maxRep = 0; delete b.presence;
  b.saves['ana'] = partial<PlayerSave>({ coins: 1, water: 9, inv: { hoe: 1 }, recipes: [], seen: [], vily: 0, rep: 0, x: 5, y: 5, area: 'garden', lastTick: b.tick - 3 * TPD });
  E.replay(b, parseJson<Journal>(json(entries)), { proposers: must(SPEC.proposers), periodic: must(SPEC.periodic), onError: rethrow });
  b.presence = w.presence;
  assert.strictEqual(json(b), json(w));
});
