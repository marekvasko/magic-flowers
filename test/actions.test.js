// Engine v2, fáza 3 (#111): akcie hráčov ako návrhy (actions.js) – rozklad správy act, kľúče po položkách trhu,
// kolá pri tom istom tovare / políčku / zákazke / batohu, odmietnutia, prítomnosť v denníku a prehranie, server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const E = require('../engine.js');
const Econ = require('../economy.js');
const Events = require('../events.js');
const Actions = require('../actions.js');
const I = require('../items.js');
const Ice = require('../ice.js');
const TPD = D.TICKS_PER_DAY;
const rethrow = err => { throw err; };
const json = v => JSON.stringify(v);
const SP = Econ.PLANTABLE.find(k => !D.SPECIES[k].strict), SP2 = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict)[1];

// Svet ako na serveri po načítaní; prítomnosť: ana a bob stoja v záhrade pri domčeku
function makeWorld(seed, tick) {
  const w = {
    tick: tick == null ? D.DAWN_TICK + 6 : tick, wall: 0, daySeconds: 1200, seed: 'akcie-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: true, ice: 0 }, up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  };
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = { coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, area: 'garden' };
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.HOUSE.x, y: Actions.HOUSE.y, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: Actions.HOUSE.x + 1, y: Actions.HOUSE.y, scav: null }];
  return w;
}
const SPEC = { proposers: Object.assign({}, Events.PROPOSERS, Actions.PROPOSERS), periodic: Events.PERIODIC, presence: w => w.presence, onError: rethrow };
const withJournal = (spec, entries) => Object.assign({}, spec, { onBatch: (w, out) => entries.push(out.entry) });
let seq = 0;
// Vstup ako ho skladá server: data.key aj actor sú kľúč hráča, id podľa poradia
const act = (type, key, data) => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
function tillable(w) { return w.tiles.map((t, i) => i).filter(i => D.TILLABLE[w.tiles[i].g] && w.tiles[i].g !== 'ring'); }
function plant(w, i, key, ripe, sp) {
  sp = sp || SP;
  w.tiles[i].s = { k: D.TILLABLE[w.tiles[i].g], w: 1, r: 0, o: key, p: { sp, prog: ripe ? D.SPECIES[sp].days : 1, q: 3, dry: 0 } };
  w.plotsUsed = Econ.plotsUsedOf(w.tiles);
}
function give(sv, id, n, tick) { I.addItems(I.playerC(sv), id, n, tick); }
const flowers = (w, key, sp) => w.saves[key].inv['fl_' + (sp || SP)] || 0;
// hráč stojí pri políčku i (na jeho okraji) – potrebné pre resolveAct
function standAt(w, key, i, exact) { const p = w.presence.find(x => x.key === key); p.area = 'garden'; p.x = i % D.W + 0.5 + (exact ? 0 : 1); p.y = Math.floor(i / D.W) + 0.5; return p; }
function shuffle(list, s) { const g = E.generator(s), out = list.slice(); for (let i = out.length - 1; i > 0; i--) { const j = g.int(i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; }

// ---- Rozklad správy act ----

test('act: kliknutie sa rozloží na konkrétnu akciu podľa políčka, predmetu a prítomnosti; vzdialenosť a plocha sa riešia hneď', () => {
  const w = makeWorld(1);
  const ti = tillable(w), grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
  const m = (i, item) => ({ x: i % D.W, y: Math.floor(i / D.W), item });
  const me = standAt(w, 'ana', ti[0]);
  const r = (i, item, who) => Actions.resolveAct(w, w.presence, who || me, m(i, item));
  assert.deepStrictEqual(r(ti[0], 'hoe'), { type: 'till', data: { key: 'ana', i: ti[0] } });
  assert.strictEqual(r(ti[0], 'can'), null, 'krhla na tráve nič nerobí');
  assert.strictEqual(r(ti[0], 'compost'), null);
  plant(w, ti[0], 'ana', false);
  assert.strictEqual(r(ti[0], 'hoe'), null, 'motyka pri rastúcej rastline nič nerobí');
  assert.deepStrictEqual(r(ti[0], 'can').type, 'water');
  w.saves.ana.inv.compost = 1; w.saves.ana.inv['seed_' + SP] = 1; w.saves.ana.inv.wild_0 = 1; w.saves.ana.inv.po_rast = 1;
  assert.deepStrictEqual(r(ti[0], 'compost').type, 'compost');
  w.tiles[ti[0]].s.p = null;
  assert.deepStrictEqual(r(ti[0], 'hoe').type, 'level');
  assert.deepStrictEqual(r(ti[0], 'seed_' + SP), { type: 'plant', data: { key: 'ana', i: ti[0], item: 'seed_' + SP } });
  assert.deepStrictEqual(r(ti[0], 'wild_0').type, 'plantWild');
  assert.deepStrictEqual(r(ti[0], 'po_rast'), { type: 'potion', data: { key: 'ana', kind: 'rast', area: 'garden', x: ti[0] % D.W, y: Math.floor(ti[0] / D.W) } });
  plant(w, ti[0], 'ana', true);
  assert.deepStrictEqual(r(ti[0], ''), { type: 'pick', data: { key: 'ana', i: ti[0] } });
  w.tiles[ti[0]].s.p.d = 1;
  assert.deepStrictEqual(r(ti[0], 'hoe').type, 'clear');
  assert.strictEqual(r(ti[0], 'seed_xyz'), null, 'predmet, ktorý hráč nemá');
  // hľadanie v tráve: treba stáť priamo na políčku
  standAt(w, 'ana', grass);
  assert.deepStrictEqual(r(grass, ''), { toast: 'Postav sa priamo na to políčko trávy. 🔍' });
  standAt(w, 'ana', grass, true);
  assert.deepStrictEqual(r(grass, ''), { type: 'scavStart', data: { key: 'ana', i: grass, seeds: false } });
  assert.deepStrictEqual(r(grass, 'seed_' + SP).data.seeds, true);
  // ďaleko
  const far = me.x = 0.5; me.y = 0.5;
  assert.deepStrictEqual(r(w.tiles.length - 1, 'hoe'), { toast: 'Si príliš ďaleko.' });
  assert.ok(far);
  // iný hráč na políčku: dar, láska alebo zamávanie
  const bob = w.presence.find(p => p.key === 'bob');
  bob.x = 5.5; bob.y = 5.5; me.x = 5.5; me.y = 6.5;
  w.saves.ana.inv.po_laska = 1;
  assert.deepStrictEqual(r(5 + 5 * D.W, 'seed_' + SP), { type: 'gift', data: { key: 'ana', to: 'bob', item: 'seed_' + SP } });
  assert.deepStrictEqual(r(5 + 5 * D.W, 'po_laska').type, 'love');
  assert.deepStrictEqual(r(5 + 5 * D.W, 'hoe').type, 'wave');
  // studňa, voda
  const well = w.tiles.findIndex(t => t.g === 'well'), water = w.tiles.findIndex(t => t.g === 'water');
  standAt(w, 'ana', well);
  assert.deepStrictEqual(r(well, ''), { type: 'well', data: { key: 'ana' } });
  assert.deepStrictEqual(r(well, 'can').type, 'drawWater');
  standAt(w, 'ana', water);
  assert.deepStrictEqual(r(water, 'can'), { type: 'drawWater', data: { key: 'ana', area: 'garden', i: water } });
  // hory: krompáč na ľadovci, motyka nič
  const gl = w.hory.findIndex(t => t.g === 'glacier');
  w.saves.ana.inv.pick = 1;
  Object.assign(me, { area: 'hory', x: gl % D.W + 0.5, y: Math.floor(gl / D.W) + 1.5 });
  assert.deepStrictEqual(r(gl, 'pick'), { type: 'digIce', data: { key: 'ana', area: 'hory', i: gl } });
  assert.match(r(gl, '').toast, /krompáč/);
  const ground = w.hory.findIndex(t => t.g !== 'glacier' && t.g !== 'water' && D.passable(t)); // zem v horách (hráč na nej stojí)
  Object.assign(me, { area: 'hory', x: ground % D.W + 0.5, y: Math.floor(ground / D.W) + 0.5 });
  assert.match(r(ground, 'hoe').toast, /V horách/);
  assert.match(r(ground, 'seed_' + SP).toast, /V horách/);
  assert.match(r(ground, 'po_rast').toast, /záhony/);
  assert.deepStrictEqual(r(ground, 'po_vily'), null, 'elixír, ktorý hráč nemá');
  w.saves.ana.inv.po_vily = 1;
  assert.deepStrictEqual(r(ground, 'po_vily'), { type: 'potion', data: { key: 'ana', kind: 'vily', area: 'hory', x: ground % D.W, y: Math.floor(ground / D.W) } });
});

// ---- Ten istý tovar: kľúče po položkách ----

test('trh: kľúče po položkách – nákupy rôznych semienok v jednom kroku sa nebrzdia, posledný kus toho istého kúpi práve jeden', () => {
  const w = makeWorld(2);
  w.market.seeds[SP].stock = 1; w.market.seeds[SP2].stock = 5;
  const r = E.commitBatch(w, [act('buy', 'ana', { id: 'seed_' + SP, n: 1 }), act('buy', 'bob', { id: 'seed_' + SP2, n: 2 }), act('buy', 'bob', { id: 'seed_' + SP, n: 1 })], SPEC);
  assert.strictEqual(r.rounds, 2, 'len tretí nákup (to isté semienko) čaká na druhé kolo');
  assert.deepStrictEqual(r.applied.map(x => x.input.data.id), ['seed_' + SP, 'seed_' + SP2]);
  assert.deepStrictEqual(r.rejected.map(x => [x.input.actor, x.reject]), [['bob', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  assert.deepStrictEqual(r.applied[0].writes.has('market:seed_' + SP) && !r.applied[0].writes.has('market:*'), true, 'nákup deklaruje len svoju položku');
  assert.deepStrictEqual([w.market.seeds[SP].stock, w.market.seeds[SP2].stock, w.saves.ana.inv['seed_' + SP], w.saves.bob.inv['seed_' + SP2]], [0, 3, 1, 2]);
  // predaj kvetu číta sviatočný násobok z položky kvetu, nie zo súhrnu trhu
  const w2 = makeWorld(3);
  give(w2.saves.ana, 'fl_' + SP, 2, w2.tick);
  const f = { id: 'x', name: 'Skúška', icon: '✨', mult: { [SP]: 2 }, until: w2.tick + TPD };
  w2.market.festival = f; Econ.setFestival(w2.market, f);
  const price = Econ.flowerPrice(w2.market, w2.tick, SP);
  assert.strictEqual(w2.market.flowers[SP].fest, 2);
  const r2 = E.commitBatch(w2, [act('sell', 'ana', { id: 'fl_' + SP, n: 1 })], SPEC);
  assert.deepStrictEqual([...r2.applied[0].writes].sort(), ['market:fl_' + SP, 'save:ana']);
  assert.strictEqual(w2.saves.ana.coins, 500 + price);
  // predaj bez položky trhu (elixír) deklaruje len uloženie
  give(w2.saves.ana, 'po_sliz', 1, w2.tick);
  const r3 = E.commitBatch(w2, [act('sell', 'ana', { id: 'po_sliz', n: 1 })], SPEC);
  assert.deepStrictEqual([...r3.applied[0].writes], ['save:ana']);
  // chudobný hráč a neznámy tovar
  w2.saves.bob.coins = 0;
  const r4 = E.commitBatch(w2, [act('buy', 'bob', { id: 'seed_' + SP, n: 1 }), act('buy', 'ana', { id: 'lopata', n: 1 })], SPEC);
  assert.deepStrictEqual(r4.rejected.map(x => x.reject), ['Nemáš dosť mincí. 🪙', 'Toto sa na trhu nepredáva.']);
});

test('sviatok: festStart zapíše násobky do položiek kvetov a súhrn pre klienta, festEnd ich zmaže; staré uloženie sa dorovná pri načítaní', () => {
  const w = makeWorld(4, 0);
  const f = D.FESTIVALS[0];
  E.advanceTo(w, Econ.festStartTick(f) + 1, SPEC);
  for (const sp in f.mult) assert.strictEqual(w.market.flowers[sp].fest, f.mult[sp], sp);
  assert.strictEqual(w.market.festival.id, f.id);
  assert.deepStrictEqual(w.market.festival.mult, f.mult, 'klient dostáva násobky v súhrne');
  assert.ok(Econ.marketView(w.market, w.tick, w.events).festival.mult);
  E.advanceTo(w, Econ.festStartTick(f) + f.len * TPD + 1, SPEC);
  assert.strictEqual(w.market.festival, null);
  assert.ok(Object.values(w.market.flowers).every(x => x.fest === undefined));
  // staré uloženie: len súhrn
  const old = makeWorld(5);
  old.market.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: old.tick + TPD };
  Econ.syncFestival(old.market);
  for (const sp in f.mult) assert.strictEqual(old.market.flowers[sp].fest, f.mult[sp]);
  assert.strictEqual(Econ.flowerPriceParts(old.market, old.tick, Object.keys(f.mult)[0]).festival, f.id);
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
  assert.strictEqual(w.tiles[ti[1]].s.o, 'ana');
  // zarovnanie a kopanie: počítadlo sedí, povolenie sa stráži
  w.up.plots = 0; w.plotsUsed = Econ.plotsUsedOf(w.tiles);
  const lim = Econ.plotLimit(w.up);
  for (let k = 3; k < lim; k++) plant(w, ti[k], 'ana', false);
  r = E.commitBatch(w, [act('level', 'bob', { i: ti[2] }), act('till', 'ana', { i: ti[lim] }), act('till', 'bob', { i: ti[lim + 1] })], SPEC);
  assert.strictEqual(w.plotsUsed, Econ.plotsUsedOf(w.tiles));
  assert.strictEqual(w.plotsUsed, lim, 'uvoľnené miesto zaplnil práve jeden');
  assert.strictEqual(r.rejected.length, 1);
  assert.match(r.rejected[0].reject, /povolenie/);
});

test('zákazka: dvaja ju berú; odovzdanie zvýši maxRep; dar hráčovi, ktorý si práve ukladá; polievanie z prázdnej krhly', () => {
  const w = makeWorld(7);
  const c = Object.assign({}, w.contracts.list.find(x => !x.takenBy));
  let r = E.commitBatch(w, [act('ctake', 'ana', { id: c.id }), act('ctake', 'bob', { id: c.id })], SPEC);
  assert.deepStrictEqual([r.applied.length, r.rejected.map(x => x.reject)], [1, ['Túto zákazku už niekto zobral.']]);
  assert.strictEqual(w.contracts.list.find(x => x.id === c.id).takenBy, 'ana');
  give(w.saves.ana, 'fl_' + c.sp, c.n, w.tick);
  r = E.commitBatch(w, [act('cdeliver', 'ana', { id: c.id }), act('cdeliver', 'bob', { id: c.id })], SPEC);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Táto zákazka nie je tvoja.']);
  assert.strictEqual(w.saves.ana.rep, c.rep);
  assert.strictEqual(w.maxRep, Econ.maxRepOf(w.saves));
  assert.ok(r.outbox.some(m => m.t === 'fx' && m.k === 'hearts'));
  // batoh: dar + sklad v jednom kroku
  give(w.saves.ana, 'fl_' + SP, 3, w.tick - TPD); give(w.saves.bob, 'fl_' + SP, 2, w.tick);
  r = E.commitBatch(w, [act('gift', 'ana', { to: 'bob', item: 'fl_' + SP }), act('store', 'bob', { id: 'fl_' + SP, n: 2 })], SPEC);
  assert.strictEqual(r.rounds, 2);
  assert.deepStrictEqual([flowers(w, 'ana'), flowers(w, 'bob'), w.storage['fl_' + SP]], [2, 1, 2]);
  assert.ok(r.outbox.some(m => m.to === 'bob' && /daroval/.test(m.text)) && r.outbox.some(m => m.to === 'ana' && /Daroval/.test(m.text)));
  // sklad ďaleko od domčeka
  w.presence[1].x = 20;
  r = E.commitBatch(w, [act('unstore', 'bob', { id: 'fl_' + SP, n: 1 })], SPEC);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Sklad je v domčeku – podíď bližšie.']);
  // polievanie
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); w.tiles[ti[0]].s.w = 0;
  w.saves.ana.water = 0;
  r = E.commitBatch(w, [act('water', 'ana', { i: ti[0] }), act('water', 'bob', { i: ti[0] })], SPEC);
  assert.deepStrictEqual([r.rejected.length, w.tiles[ti[0]].s.w, w.saves.bob.water], [1, 1, 4]);
  assert.match(r.rejected[0].reject, /Krhla je prázdna/);
});

test('zmiešaná dávka akcií v ľubovoľnom poradí dáva rovnaké návrhy; vykonanie je deterministické', () => {
  const mk = () => {
    seq = 100;
    const w = makeWorld(8);
    const ti = tillable(w);
    plant(w, ti[0], 'ana', true); plant(w, ti[1], 'bob', true); plant(w, ti[2], 'ana', false);
    give(w.saves.ana, 'fl_' + SP, 4, w.tick); give(w.saves.bob, 'seed_' + SP, 2, w.tick); give(w.saves.ana, 'po_rast', 1, w.tick); give(w.saves.bob, 'fl_papradie', 1, w.tick);
    w.market.seeds[SP].stock = 2;
    const c = w.contracts.list.find(x => !x.takenBy);
    const inputs = [
      act('pick', 'ana', { i: ti[0] }), act('pick', 'bob', { i: ti[0] }), act('pick', 'bob', { i: ti[1] }), act('water', 'ana', { i: ti[2] }),
      act('till', 'bob', { i: ti[3] }), act('till', 'ana', { i: ti[4] }), act('buy', 'ana', { id: 'seed_' + SP, n: 2 }), act('buy', 'bob', { id: 'seed_' + SP, n: 1 }),
      act('sell', 'bob', { id: 'seed_' + SP, n: 2 }), act('ctake', 'bob', { id: c.id }), act('gift', 'ana', { to: 'bob', item: 'fl_' + SP }),
      act('store', 'bob', { id: 'fl_' + SP, n: 1 }), act('potion', 'ana', { kind: 'rast', area: 'garden', x: ti[2] % D.W, y: Math.floor(ti[2] / D.W) }),
      act('well', 'ana', {}), act('wish', 'bob', { kind: 'zlato' }), act('upgrade', 'ana', { kind: 'plots' }), act('compostWilted', 'bob', {})
    ];
    return { w, inputs };
  };
  const view = r => json({ id: r.id, reads: [...r.reads].sort(), writes: [...r.writes].sort(), slices: r.slices, ops: r.ops, outbox: r.outbox, reject: r.reject, error: r.error && String(r.error) });
  const { w, inputs } = mk();
  const ref = new Map(inputs.map(inp => [inp, view(E.evaluate(w, inp, SPEC, w.presence))]));
  for (const inp of inputs) assert.strictEqual(ref.get(inp).includes('"error"'), false, inp.type + ' ' + ref.get(inp));
  for (let s = 1; s <= 5; s++) for (const inp of shuffle(inputs, s)) assert.strictEqual(view(E.evaluate(w, inp, SPEC, w.presence)), ref.get(inp), inp.type);
  const a = mk(), b = mk();
  const ra = E.commitBatch(a.w, a.inputs, SPEC), rb = E.commitBatch(b.w, b.inputs, SPEC);
  assert.strictEqual(json(a.w), json(b.w));
  assert.deepStrictEqual(ra.outbox, rb.outbox);
  assert.ok(ra.rounds >= 2 && ra.applied.length >= 10 && ra.rejected.length >= 2, `kolá ${ra.rounds}, vykonané ${ra.applied.length}, odmietnuté ${ra.rejected.length}`);
  assert.strictEqual(a.w.plotsUsed, Econ.plotsUsedOf(a.w.tiles));
  assert.strictEqual(a.w.saves.ana.coins + a.w.saves.bob.coins > 1000 + 800 - 400, true, 'zlatý dážď zaplatil obom prítomným');
});

// ---- Odmietnutie, chyba, prítomnosť ----

test('odmietnutie je potichu (null) alebo so správou; chyba v akcii nezanechá nič a je v denníku ako error', () => {
  const w = makeWorld(9);
  const ti = tillable(w);
  const entries = [], errors = [];
  const spec = Object.assign({}, withJournal(SPEC, entries), { onError: e => errors.push(e.message) });
  // compost na tráve (nič sa nedeje, bez správy), sadenie bez záhonu (správa), akcia neprítomného hráča (potichu), chyba (neexistujúce uloženie → TypeError? nie: potichu)
  give(w.saves.ana, 'compost', 1, w.tick); give(w.saves.ana, 'seed_' + SP, 1, w.tick);
  const r = E.commitBatch(w, [act('compost', 'ana', { i: ti[0] }), act('plant', 'ana', { i: ti[0], item: 'seed_' + SP }), act('scavStart', 'cyril', { i: ti[0], seeds: false }), act('buy', 'cyril', { id: 'compost', n: 1 }),
    Object.assign(act('fillIce', 'ana', { n: 1 }), { data: null })], spec);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), [null, 'Najprv zem prekopaj motykou.', null, null]);
  assert.strictEqual(errors.length, 1, 'akcia bez dát spadne – ako chyba, nie ako pád servera');
  assert.deepStrictEqual(entries[0].proposals.map(p => p.outcome), ['rejected', 'rejected', 'rejected', 'rejected', 'error']);
  assert.deepStrictEqual([w.saves.ana.inv.compost, w.saves.ana.inv['seed_' + SP], w.tiles[ti[0]].s], [1, 1, null]);
  assert.deepStrictEqual(entries[0].presence, w.presence, 'záznam dávky nesie snímku prítomnosti');
  assert.strictEqual(entries[0].inputs[0].actor, 'ana');
});

test('hľadanie v tráve: scavStart naplánuje scavDone a pošle pokyn prítomnosti; scavStop ju zruší; divé semienko sa sadí podľa cien trhu', () => {
  const w = makeWorld(10);
  const grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
  let r = E.commitBatch(w, [act('scavStart', 'ana', { i: grass, seeds: true })], SPEC);
  const ev = E.pending(w, 'scavDone:ana');
  assert.ok(ev && ev.at === w.tick + D.SCAVENGE.ticks && ev.data.i === grass && ev.data.seeds === true);
  assert.deepStrictEqual(r.outbox, [{ to: 'ana', t: 'scavStart', i: grass, n: ev.data.n, seeds: true }]);
  assert.ok(r.applied[0].writes.has('event:scavDone:ana'));
  r = E.commitBatch(w, [act('scavStop', 'ana', {})], SPEC);
  assert.strictEqual(E.pending(w, 'scavDone:ana'), null);
  // koniec hľadania podľa prítomnosti (events.js) – n z id vstupu
  E.commitBatch(w, [act('scavStart', 'ana', { i: grass, seeds: false })], SPEC);
  w.presence[0].scav = { i: grass, n: E.pending(w, 'scavDone:ana').data.n };
  const before = json(w.saves.ana.inv);
  E.advanceTo(w, w.tick + D.SCAVENGE.ticks, SPEC);
  assert.strictEqual(w.scav[grass], Math.floor(w.tick / D.SCAVENGE.window), 'políčko je prehľadané');
  assert.ok(json(w.saves.ana.inv) === before || Object.keys(w.saves.ana.inv).some(id => id.startsWith('wild_')));
  // divé semienko: druh podľa cien kvetov, len na čítanie
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); w.tiles[ti[0]].s.p = null;
  const se = D.seasonOf(D.dayOfTick(w.tick));
  give(w.saves.ana, 'wild_' + se, 1, w.tick);
  r = E.commitBatch(w, [act('plantWild', 'ana', { i: ti[0], item: 'wild_' + se })], SPEC);
  assert.ok(r.applied[0].reads.has('market:fl_*') && r.applied[0].reads.has('eternal'));
  assert.ok(w.tiles[ti[0]].s.p.wild === 1 && D.SPECIES[w.tiles[ti[0]].s.p.sp]);
  assert.strictEqual(w.saves.ana.inv['wild_' + se], undefined);
});

test('elixíry a studňa: dážď mení počasie, polieva a kŕmi ľadovec raz za deň; dúha platí len prítomným; víly naplánujú koniec', () => {
  const w = makeWorld(11);
  const ti = tillable(w);
  plant(w, ti[0], 'ana', false); w.tiles[ti[0]].s.w = 0;
  for (const t of w.hory) if (t.ice != null) t.ice = 0;
  give(w.saves.ana, 'po_dazd', 1, w.tick); give(w.saves.ana, 'po_duha', 1, w.tick); give(w.saves.bob, 'po_vily', 1, w.tick);
  w.saves.cyril = JSON.parse(json(w.saves.ana)); // offline hráč
  let r = E.commitBatch(w, [act('potion', 'ana', { kind: 'dazd', area: 'garden', x: 5, y: 5 })], SPEC);
  assert.deepStrictEqual([w.weather, w.tiles[ti[0]].s.w, w.glacierFed], ['rain', 1, D.dayOfTick(w.tick)]);
  assert.strictEqual(Ice.glacierTotal(w.hory), D.GLACIER_GROW.rain);
  assert.ok(r.outbox.some(m => m.to === E.ALL && /dážď/.test(m.text)));
  r = E.commitBatch(w, [act('potion', 'ana', { kind: 'duha', area: 'garden', x: 5, y: 5 }), act('potion', 'bob', { kind: 'vily', area: 'garden', x: 5, y: 5 })], SPEC);
  assert.deepStrictEqual([w.saves.ana.coins, w.saves.bob.coins, w.saves.cyril.coins], [800, 800, 500], 'dúha platí len pripojeným');
  assert.ok(r.applied.find(x => x.input.data.kind === 'duha').writes.has('save:bob'));
  assert.ok(E.pending(w, 'vilyEnd:bob') && w.saves.bob.vily === w.tick + TPD);
  // studňa: 5 mincí, náhoda z enginu; rovnaké semienko → rovnaký výsledok
  const run = () => { const x = makeWorld(12); E.commitBatch(x, [{ type: 'well', data: { key: 'ana' }, id: 'a#7', actor: 'ana' }], SPEC); return x; };
  const a = run(), b = run();
  assert.strictEqual(a.saves.ana.coins, 495);
  assert.strictEqual(json(a), json(b));
  const poor = makeWorld(13); poor.saves.ana.coins = 3;
  assert.deepStrictEqual(E.commitBatch(poor, [act('well', 'ana', {})], SPEC).rejected.map(x => x.reject), ['Na prianie potrebuješ hodiť do studne 5 🪙.']);
});

test('ľadovňa a sklad: stavba, naplnenie ľadom pri ľadovni, vylepšenia (spoločné povolenie mení up), kotlík', () => {
  const w = makeWorld(14);
  w.icehouse = { built: false, ice: 0 }; Ice.applyIcehouse(w.icehouse, w.tiles);
  w.saves.ana.rep = D.REP_LEVELS[D.ICEHOUSE.rep]; w.saves.ana.coins = 5000;
  let r = E.commitBatch(w, [act('build', 'ana', {}), act('build', 'bob', {})], SPEC);
  assert.deepStrictEqual([w.icehouse.built, r.rejected.map(x => x.reject)], [true, ['Ľadovňa už v záhrade stojí.']]);
  assert.ok(Ice.lotIdx().every(i => w.tiles[i].g === 'icehouse'));
  give(w.saves.ana, 'ice', 3, w.tick);
  const L = D.ICEHOUSE.lot; w.presence[0].x = L.x0 + 1; w.presence[0].y = L.y0 + 1;
  r = E.commitBatch(w, [act('fillIce', 'ana', { n: 2 })], SPEC);
  assert.deepStrictEqual([w.icehouse.ice, w.saves.ana.inv.ice], [2, 1]);
  r = E.commitBatch(w, [act('upgrade', 'ana', { kind: 'plots' }), act('upgrade', 'bob', { kind: 'can' })], SPEC);
  assert.deepStrictEqual([w.up.plots, w.saves.bob.up.can], [2, 1]);
  assert.ok(r.applied[0].writes.has('up') && !r.applied[1].writes.has('up'));
  assert.ok(r.outbox.some(m => m.to === E.ALL && /pre celú záhradu/.test(m.text)));
  const recipe = Object.keys(D.RECIPES)[0], fls = recipe.split('+').map(x => 'fl_' + x);
  for (const id of fls) give(w.saves.ana, id, 1, w.tick);
  r = E.commitBatch(w, [act('brew', 'ana', { items: fls })], SPEC);
  assert.strictEqual(w.saves.ana.inv['po_' + D.RECIPES[recipe]], 1);
  assert.ok(w.saves.ana.recipes.includes(recipe) && r.outbox.some(m => m.t === 'brewed'));
  assert.deepStrictEqual(E.commitBatch(w, [act('brew', 'ana', { items: fls })], SPEC).rejected.map(x => x.reject), ['Tieto kvety nemáš.']);
});

// ---- Prítomnosť v denníku a prehranie ----

test('denník s akciami a prítomnosťou sa prehrá na ten istý svet a ten istý denník (udalosti z fronty, akcie zo záznamov)', () => {
  const run = (w, journal) => {
    const spec = withJournal(SPEC, journal), ti = tillable(w), grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
    seq = 500;
    E.advanceTo(w, w.tick + 3, spec);
    E.commitBatch(w, [act('till', 'ana', { i: ti[0] }), act('buy', 'ana', { id: 'seed_' + SP, n: 2 }), act('scavStart', 'bob', { i: grass, seeds: false })], spec);
    w.presence[1].scav = { i: grass, n: 'a#503' };
    E.advanceTo(w, w.tick + 5, spec);
    E.commitBatch(w, [act('plant', 'ana', { i: ti[0], item: 'seed_' + SP }), act('gift', 'ana', { to: 'bob', item: 'seed_' + SP }), act('well', 'bob', {})], spec);
    w.presence[1].scav = null;
    E.advanceTo(w, w.tick + 2 * TPD, spec);
    E.commitBatch(w, [act('water', 'ana', { i: ti[0] }), act('sell', 'bob', { id: 'seed_' + SP, n: 1 })], spec);
    E.advanceTo(w, w.tick + TPD, spec);
  };
  const a = makeWorld(15, 0), ja = [];
  run(a, ja);
  assert.ok(ja.some(e => e.inputs.some(i => i.actor === 'ana')) && ja.every(e => Array.isArray(e.presence)));
  const b = makeWorld(15, 0), jb = [];
  delete b.presence; // prehranie dostane prítomnosť z denníka, nie zo sveta
  const spec = Object.assign({}, withJournal(SPEC, jb), { presence: () => { throw new Error('prehranie nesmie siahať na živú prítomnosť'); } });
  const n = E.replay(b, JSON.parse(json(ja)), spec);
  E.advanceTo(b, a.tick, spec);
  b.presence = a.presence;
  assert.strictEqual(n, ja.length);
  assert.strictEqual(json(b), json(a));
  assert.strictEqual(json(jb), json(ja));
});

// ---- Server: skutočné správy ----

function startServer(dataDir, port, env) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000' }, env || {}), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.stderr.on('data', d => process.stderr.write(String(d)));
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
// Klient: zbiera správy, čaká na konkrétnu
function client(port, room, name) {
  const ws = new WebSocket('ws://127.0.0.1:' + port), got = [];
  const waiters = [];
  ws.on('message', raw => { const m = JSON.parse(raw); got.push(m); for (const wt of waiters.slice()) if (wt.pred(m)) { waiters.splice(waiters.indexOf(wt), 1); wt.res(m); } });
  const wait = (pred, ms) => new Promise((res, rej) => { const f = got.find(pred); if (f) return res(f); const t = setTimeout(() => rej(new Error('nedošlo: ' + pred)), ms || 3000); waiters.push({ pred, res: m => { clearTimeout(t); res(m); } }); });
  return new Promise(r => ws.on('open', async () => { ws.send(json({ t: 'join', room, name })); await wait(m => m.t === 'welcome'); r({ ws, got, wait, send: m => ws.send(json(m)) }); }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('server: správy hráčov idú cez schránku a dávku akcií – stav, toasty, obnova klientov, denník s prítomnosťou, prehranie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-akcie-'));
  const port = 45000 + Math.floor(Math.random() * 2000);
  const w = makeWorld(16);
  delete w.presence;
  const ti = tillable(w);
  // ana a bob pri políčku ti[0] (uložená poloha), s predmetmi; ľadovňa postavená
  const px = ti[0] % D.W + 1.5, py = Math.floor(ti[0] / D.W) + 0.5;
  for (const k of ['ana', 'bob']) Object.assign(w.saves[k], { x: px, y: py, area: 'garden', look: { shirt: '#000', hair: '#000', hat: false }, talked: true });
  give(w.saves.ana, 'seed_' + SP, 3, w.tick); give(w.saves.ana, 'fl_' + SP, 2, w.tick);
  w.icehouse = { built: false, ice: 0 }; Ice.applyIcehouse(w.icehouse, w.tiles);
  w.saves.bob.rep = D.REP_LEVELS[D.ICEHOUSE.rep]; w.saves.bob.coins = D.ICEHOUSE.price + 10;
  w.market.seeds[SP].stock = 1;
  const save = Object.assign(JSON.parse(json(w)), { v: 9, mode: 'paused', wall: Date.now(), tiles: w.tiles.map(t => ({ s: t.s })), hory: Ice.saveHory(w.hory), les: null, pomedzieSeed: 1, lesSeed: 1 });
  fs.writeFileSync(path.join(dir, 'room-akcie.json'), json(save));
  const proc = await startServer(dir, port);
  let ana, bob;
  try {
    ana = await client(port, 'akcie', 'Ana'); bob = await client(port, 'akcie', 'Bob');
    const x = ti[0] % D.W, y = Math.floor(ti[0] / D.W);
    // obaja kopú to isté políčko v jednom rámci: jeden záhon, druhý dostane toast; plots príde obom
    ana.send({ t: 'act', x, y, item: 'hoe' }); bob.send({ t: 'act', x, y, item: 'hoe' });
    const tile = await ana.wait(m => m.t === 'tile' && m.i === ti[0] && m.v.s);
    assert.ok(tile.v.s.o === 'ana' || tile.v.s.o === 'bob');
    const loser = tile.v.s.o === 'ana' ? bob : ana;
    await loser.wait(m => m.t === 'toast' && m.text === 'Tu už je záhon.');
    await bob.wait(m => m.t === 'plots' && m.used === 1);
    // sadenie + polievanie od jednej hráčky v jednom rámci: druhá akcia na políčku počká na ďalší rámec, obe prejdú
    ana.send({ t: 'act', x, y, item: 'seed_' + SP }); ana.send({ t: 'act', x, y, item: 'can' });
    await ana.wait(m => m.t === 'tile' && m.i === ti[0] && m.v.s.p && m.v.s.p.sp === SP && m.v.s.w === 1);
    const me1 = await ana.wait(m => m.t === 'me' && m.inv['seed_' + SP] === 2 && m.water === 4);
    assert.ok(me1);
    // posledné semienko kúpi práve jeden; druhý dostane „Vypredané“
    ana.send({ t: 'buy', id: 'seed_' + SP, n: 1 }); bob.send({ t: 'buy', id: 'seed_' + SP, n: 1 });
    const t1 = await ana.wait(m => m.t === 'toast' && /Kúpené|Vypredané/.test(m.text)), t2 = await bob.wait(m => m.t === 'toast' && /Kúpené|Vypredané/.test(m.text));
    assert.ok([t1.text, t2.text].filter(t => /Kúpené/.test(t)).length === 1, t1.text + ' / ' + t2.text);
    await ana.wait(m => m.t === 'market' && m.seeds[SP].st === 0);
    // predaj kvetu, dar, sklad (pri domčeku nie sú → toast), ľadovňa bez ľadu, zákazka
    ana.send({ t: 'sell', id: 'fl_' + SP, n: 1 });
    await ana.wait(m => m.t === 'toast' && /Predané: 1×/.test(m.text));
    ana.send({ t: 'store', id: 'fl_' + SP, n: 1 });
    await ana.wait(m => m.t === 'toast' && /Sklad je v domčeku/.test(m.text));
    bob.send({ t: 'icehouse', n: 1 });
    await bob.wait(m => m.t === 'toast' && /nie je postavená/.test(m.text));
    // stavba ľadovne mení typ zeme: klient dostane celú plochu (prestavia 3D svet) a room s ľadovňou
    bob.send({ t: 'build', id: 'icehouse' });
    const all = await ana.wait(m => m.t === 'tiles' && m.tiles[Ice.lotIdx()[0]].g === 'icehouse');
    assert.ok(all && Ice.lotIdx().every(i => all.tiles[i].g === 'icehouse'));
    await bob.wait(m => m.t === 'room' && m.icehouse.built);
    await ana.wait(m => m.t === 'toast' && /postavil\(a\) pri domčeku ľadovňu/.test(m.text));
    const board = bob.got.find(m => m.t === 'board');
    bob.send({ t: 'ctake', id: board.list[0].id });
    await bob.wait(m => m.t === 'toast' && /Zákazka je tvoja/.test(m.text));
    await ana.wait(m => m.t === 'board' && m.list.find(c => c.id === board.list[0].id).takenBy);
    // hľadanie v tráve: klik príliš ďaleko hľadanie nepreruší (ako pôvodný handler), ten istý klik = „stále hľadáš“, iná akcia preruší
    const grass = w.tiles.findIndex(t => t.g === 'grass' && !t.s), gx = grass % D.W, gy = Math.floor(grass / D.W);
    const seqA = ana.got.find(m => m.t === 'welcome').seq;
    ana.send({ t: 'move', x: gx + 0.5, y: gy + 0.5, dir: 0, ar: seqA });
    await ana.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Ana' && p.x === gx + 0.5));
    ana.send({ t: 'act', x: gx, y: gy, item: '' });
    await ana.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Ana' && p.si === grass));
    const n0 = ana.got.length;
    ana.send({ t: 'act', x: gx >= 10 ? gx - 10 : gx + 10, y: gy, item: '' }); // vnútri plochy, ale ďaleko
    await ana.wait(m => m.t === 'toast' && m.text === 'Si príliš ďaleko.');
    ana.send({ t: 'act', x: gx, y: gy, item: '' });
    await ana.wait(m => m.t === 'toast' && /Ešte stále hľadáš/.test(m.text));
    assert.ok(!ana.got.slice(n0).some(m => m.t === 'toast' && /Prestal/.test(m.text)), 'ďaleký klik hľadanie neprerušil');
    ana.send({ t: 'act', x: gx, y: gy, item: 'hoe' });
    await ana.wait(m => m.t === 'toast' && /Prestal\(a\) si hľadať/.test(m.text));
    await ana.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Ana' && p.si === -1));
    // záplava akcií jedného hráča nezablokuje správy ostatných
    for (let k = 0; k < 300; k++) bob.send({ t: 'act', x, y, item: 'hoe' });
    ana.send({ t: 'buy', id: 'compost', n: 1 });
    await ana.wait(m => m.t === 'toast' && /Kúpené: 1× Kompost/.test(m.text), 1500);
    await sleep(250);
  } finally {
    if (ana) ana.ws.close(); if (bob) bob.ws.close();
    await sleep(150);
    await stopServer(proc);
  }
  // denník: záznamy akcií s id a#, actor a prítomnosťou; prehranie zo začiatočného uloženia dá ten istý svet
  const lines = fs.readFileSync(path.join(dir, 'journal-akcie.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const entries = lines.filter(e => !e.load);
  assert.ok(entries.length >= 5 && entries.every(e => e.inputs.every(i => /^a#\d+$/.test(i.id) && typeof i.actor === 'string') && Array.isArray(e.presence) && e.presence.length === 2), 'denník: ' + entries.length);
  assert.ok(entries.every(e => !e.inputs.some(i => i.ev)), 'akcie a udalosti nikdy v jednej dávke');
  const types = entries.flatMap(e => e.inputs.map(i => i.type));
  for (const t of ['till', 'plant', 'water', 'buy', 'sell', 'store', 'fillIce', 'build', 'ctake']) assert.ok(types.includes(t), t);
  const final = JSON.parse(fs.readFileSync(path.join(dir, 'room-akcie.json'), 'utf8'));
  const start = JSON.parse(json(save));
  const room = Object.assign(start, { tiles: D.buildMap().map((g, i) => ({ g, s: start.tiles[i].s })), hory: Ice.loadHory(start.hory) });
  Ice.applyIcehouse(room.icehouse, room.tiles);
  room.plotsUsed = Econ.plotsUsedOf(room.tiles); room.maxRep = Econ.maxRepOf(room.saves); // ako getRoom: odvodené počítadlá sa pri načítaní prepočítajú
  E.replay(room, entries, { proposers: SPEC.proposers, periodic: SPEC.periodic, onError: rethrow });
  // mimo denníka sú len prítomnosť a polohy (join/move): porovnáme svet bez nich
  const strip = st => { const o = JSON.parse(json(st)); delete o.wall; delete o.v; delete o.migratedFrom; delete o.daySeconds; delete o.hory; delete o.les; delete o.tiles; for (const k in o.saves) for (const f of ['lastTick', 'x', 'y', 'area', 'look', 'talked']) delete o.saves[k][f]; return o; };
  assert.deepStrictEqual(strip(room), strip(final));
  assert.deepStrictEqual(room.tiles.map(t => t.s), final.tiles.map(t => t.s));
});

test('hygiena: server už nemení svet priamo – liveCtx len pri založení sveta, žiadne sendMe/tileMsg v akciách', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/liveCtx/g) || []).length, 1);
  assert.ok(!/actionCtx|Econ\.buy\(|Econ\.sell\(|Econ\.upgrade\(|deliverContract|takeContract|Ice\.digIce|Ice\.fillIcehouse|Ice\.buildIcehouse|Ice\.buyTool|pickWild/.test(src));
  const ws = src.slice(src.indexOf("ws.on('message'"), src.indexOf("ws.on('close'"));
  assert.ok(!/case '/.test(ws), 'handler správ len overí a vloží do schránky');
  assert.ok(Object.keys(Actions.PROPOSERS).length >= 28);
});

test('uloženie v8 (288 krokov za deň) sa prevedie na v9: každý krok ×40 – ten istý deň a hodina, udalosti, várky, rastliny, zákazky, sviatok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-v9-'));
  const port = 46000 + Math.floor(Math.random() * 2000);
  const K = D.TICKS_PER_DAY / 288;
  const f = D.FESTIVALS[1];
  const old = { // svet vo verzii 8: deň 3, 7:30 (tick 2*288 + 90)
    v: 8, tick: 2 * 288 + 90, wall: Date.now(), mode: 'paused', daySeconds: 1200, seed: E.newSeed(), step: 5, seq: 20, weather: 'sun',
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1, ['fl_' + SP]: 2 }, fb: { ['fl_' + SP]: [{ n: 2, a: 30, at: 600 }] }, recipes: [], seen: [], vily: 700, lastTick: 650, rep: 0, up: { can: 0, composter: 0 }, x: 5, y: 5, area: 'garden', talked: true } },
    storage: { ['fl_' + SP]: 1 }, storageFb: { ['fl_' + SP]: [{ n: 1, a: 10, at: 500 }] }, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 1, lesSeed: 1, les: null, scav: { 5: 55 }, scavSalt: 3, up: { plots: 0 }, glacierFed: 2, eternal: false, fairyNight: -1, plotsUsed: 1, maxRep: 0,
    market: { seeds: {}, flowers: {}, compost: { stock: 5 }, hist: {}, news: [{ tick: 640, text: 'x' }], festival: { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: 900 }, npcs: { jano: { coins: 1 }, fero: { coins: 1, hold: {} } } },
    contracts: { list: [{ id: 1, kind: 'short', giver: 'babka', sp: SP, n: 2, got: 0, reward: 10, item: null, rep: 4, posted: 600, openUntil: 800, due: 1000, takenBy: null }], nextId: 2 },
    events: [{ at: 666, seq: 1, type: 'hourly', data: null, key: 'hourly', periodic: true }, { at: 1000, seq: 2, type: 'cDue', data: { id: 1 }, key: 'cDue:1' }, { at: 700, seq: 3, type: 'vilyEnd', data: { key: 'eva' }, key: 'vilyEnd:eva' }],
    tiles: D.buildMap().map((g, i) => ({ s: i === 5 && D.TILLABLE[g] ? { k: 'normal', w: 1, r: 0, o: 'eva', p: { sp: SP, prog: D.SPECIES[SP].days, q: 3, dry: 0, bt: 650 } } : null }))
  };
  for (const sp of Econ.PLANTABLE) { old.market.seeds[sp] = { stock: 3 }; old.market.flowers[sp] = { stock: 1 }; }
  const tilled = old.tiles.findIndex(t => t.s);
  if (tilled < 0) { old.tiles[D.buildMap().findIndex(g => g === 'grass')].s = { k: 'normal', w: 1, r: 0, o: 'eva', p: { sp: SP, prog: 1, q: 3, dry: 0, bt: 650 } }; }
  fs.writeFileSync(path.join(dir, 'room-stary.json'), json(old));
  const proc = await startServer(dir, port);
  try { const c = await client(port, 'stary', 'Eva'); c.ws.close(); await sleep(100); } finally { await stopServer(proc); }
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'room-stary.json'), 'utf8'));
  assert.strictEqual(s.v, 9);
  assert.strictEqual(s.tick, old.tick * K);
  assert.deepStrictEqual([D.dayOfTick(s.tick), D.minOfTick(s.tick)], [3, 450], 'deň 3, 7:30 ako predtým');
  assert.deepStrictEqual(s.events.filter(e => e.key !== 'dawn' && !/^(delivery|npc_|fest)/.test(e.key)).map(e => [e.key, e.at]).sort(), [['cDue:1', 1000 * K], ['hourly', 666 * K], ['vilyEnd:eva', 700 * K]]);
  const eva = s.saves.eva;
  assert.deepStrictEqual([eva.vily, eva.fb['fl_' + SP][0].a, eva.fb['fl_' + SP][0].at], [700 * K, 30 * K, 600 * K]);
  assert.ok(eva.lastTick >= 650 * K, 'lastTick preškálovaný (a pri odchode obnovený)');
  assert.deepStrictEqual(s.storageFb['fl_' + SP][0], { n: 1, a: 10 * K, at: 500 * K });
  assert.strictEqual(s.tiles.find(t => t.s && t.s.p).s.p.bt, 650 * K);
  assert.deepStrictEqual([s.contracts.list[0].posted, s.contracts.list[0].openUntil, s.contracts.list[0].due], [600 * K, 800 * K, 1000 * K]);
  assert.strictEqual(s.market.festival.until, 900 * K);
  assert.strictEqual(s.market.news[0].tick, 640 * K);
  assert.deepStrictEqual(s.scav, {});
  assert.strictEqual(s.glacierFed, 2, 'deň sa neškáluje');
  for (const sp in f.mult) assert.strictEqual(s.market.flowers[sp].fest, f.mult[sp], 'sviatok v položkách kvetov');
});
