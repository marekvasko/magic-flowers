// Engine v2 (#105, #107): návrhy nad zmrazeným svetom, zdroje, kolá, atomickosť a náhoda bez zdieľaného prúdu.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const D = require('../shared/data.js');
const E = require('../engine.js');
const Econ = require('../economy.js');
const I = require('../items.js');
const Ice = require('../ice.js');
const Scav = require('../scavenge.js');
const TPD = D.TICKS_PER_DAY;
const rethrow = err => { throw err; };
const SP = Econ.PLANTABLE.find(k => !D.SPECIES[k].strict); // bežný kvet
const json = v => JSON.stringify(v);

// Svet ako na serveri po načítaní: záhrada, hory, trh, nástenka, dvaja hráči (bez socketov).
function makeWorld(seed, tick) {
  const w = {
    tick: tick == null ? D.DAWN_TICK + 6 : tick, wall: 0, daySeconds: 1200, seed: 'test-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: true, ice: 0 }, up: { plots: 1 },
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  };
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = { coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, x: 5, y: 5, area: 'garden' };
  return w;
}
// Políčka záhrady, na ktorých sa dá kopať
function tillable(w) { return w.tiles.map((t, i) => i).filter(i => D.TILLABLE[w.tiles[i].g] && w.tiles[i].g !== 'ring'); }
function plant(w, i, key, ripe) {
  w.tiles[i].s = { k: D.TILLABLE[w.tiles[i].g], w: 1, r: 0, o: key, p: { sp: SP, prog: ripe ? D.SPECIES[SP].days : 1, q: 3, dry: 0 } };
}
function give(sv, id, n, tick) { I.addItems(I.playerC(sv), id, n, tick); }
function flowers(w, key) { return (w.saves[key].inv['fl_' + SP] || 0); }

// Čisté návrhy akcií hráčov (ako budú v spec.proposers po fáze 3): čítajú a píšu návrh, správy cez ctx.emit, chyby cez ctx.reject.
const PROPOSERS = {
  water(d, { key, i }, ctx) {
    const sv = d.saves[key], t = d.tiles[i];
    if (!t.s) return ctx.reject('Tu nie je záhon.');
    if (sv.water <= 0) return ctx.reject('Krhla je prázdna.');
    sv.water--; t.s.w = 1;
    ctx.emit({ to: key, t: 'fx', k: 'drops', i });
  },
  till(d, { key, i }, ctx) {
    const t = d.tiles[i];
    if (t.s) return ctx.reject('Tu už je záhon.');
    if (Econ.plotsUsed(d) >= Econ.plotLimit(d)) return ctx.reject('Povolenie je vyčerpané.');
    t.s = { k: D.TILLABLE[t.g], w: 0, r: 0, p: null, o: key };
  },
  pick(d, { key, i }, ctx) {
    const t = d.tiles[i], p = t.s && t.s.p;
    if (!p || p.d || p.prog < D.SPECIES[p.sp].days) return ctx.reject('Tu nič nekvitne.');
    const n = Math.min(4, p.q + (t.s.r ? 1 : 0));
    I.addItems(I.playerC(d.saves[key]), 'fl_' + p.sp, n, ctx.tick);
    t.s.r = 0; t.s.p = null;
    ctx.emit({ to: key, t: 'toast', text: `+${n}× ${D.SPECIES[p.sp].name}` });
  },
  // udalosť sveta: kvet na políčku zvädne (ako ranný rast / mráz / hodinové vädnutie)
  wilt(d, { i }) { const p = d.tiles[i].s && d.tiles[i].s.p; if (p) { p.d = 1; p.why = 'mráz'; } },
  buy(d, { key, id, n }, ctx) {
    const r = Econ.buy(d, d.saves[key], id, n);
    if (!r.n) return ctx.reject(r.msg);
    ctx.emit({ to: key, t: 'toast', text: r.msg });
  },
  sell(d, { key, id, n }, ctx) {
    const r = Econ.sell(d, d.saves[key], id, n);
    if (!r.n) return ctx.reject(r.msg);
    ctx.emit({ to: key, t: 'toast', text: r.msg });
  },
  ctake(d, { key, id }, ctx) { const err = Econ.takeContract(d, key, id); if (err) return ctx.reject(err); },
  cdeliver(d, { key, id }, ctx) {
    const r = Econ.deliverContract(d, key, id);
    if (!r.done && !/Odovzdané/.test(r.msg)) return ctx.reject(r.msg);
    ctx.emit({ to: key, t: 'toast', text: r.msg });
  },
  gift(d, { from, to, id, n }, ctx) {
    const b = I.removeItems(I.playerC(d.saves[from]), id, n, ctx.tick);
    if (!b) return ctx.reject('Toto nemáš.');
    I.addItems(I.playerC(d.saves[to]), id, n, ctx.tick, b);
  },
  store(d, { key, id, n }, ctx) {
    const b = I.removeItems(I.playerC(d.saves[key]), id, n, ctx.tick);
    if (!b) return ctx.reject('Toto nemáš.');
    I.addItems(I.storageC(d), id, n, ctx.tick, b);
  },
  roll(d, { id }, ctx) { const v = ctx.rng.int(1000); d['roll:' + id] = v; ctx.emit({ id, v }); } // každý hod píše vlastný zdroj
};
const SPEC = {
  proposers: PROPOSERS,
  handlers: Object.assign({ dawn: Econ.onDawn, cDue: Econ.HANDLERS.cDue, cExpire: Econ.HANDLERS.cExpire }, Econ.HANDLERS),
  periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) }, ...Econ.PERIODIC],
  onError: rethrow
};
const input = (type, data, id) => ({ type, data, id: id || type + ':' + json(data) });
function shuffle(list, seed) {
  const g = E.generator(seed), out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = g.int(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; }

// ---- Návrh (draft) ----

test('draft: výsledok cez návrh sa rovná priamej zmene kópie – pre každú funkciu, ktorá mení svet', () => {
  const base = makeWorld(1);
  base.saves.ana.rep = D.REP_LEVELS[2];
  const open = base.contracts.list.find(c => !c.takenBy);
  Econ.takeContract(base, 'ana', open.id);
  const ti = tillable(base);
  plant(base, ti[0], 'ana', true); plant(base, ti[1], 'bob', false);
  give(base.saves.ana, 'fl_' + SP, 5, base.tick - 3 * TPD); give(base.saves.ana, 'fl_' + open.sp, open.n, base.tick);
  give(base.saves.bob, 'ice', 2, base.tick);
  const glacier = base.hory.findIndex(t => t.g === 'glacier' && t.ice > 0);
  const fest = D.FESTIVALS[0];
  const cases = {
    'Econ.onDawn': w => Econ.onDawn(w),
    'Econ.buy': w => Econ.buy(w, w.saves.ana, 'seed_' + SP, 3),
    'Econ.buy kompost': w => Econ.buy(w, w.saves.bob, 'compost', 2),
    'Econ.sell': w => Econ.sell(w, w.saves.ana, 'fl_' + SP, 4),
    'Econ.takeContract': w => Econ.takeContract(w, 'bob', w.contracts.list.find(c => !c.takenBy).id),
    'Econ.deliverContract': w => Econ.deliverContract(w, 'ana', open.id),
    'Econ.upgrade': w => Econ.upgrade(w, w.saves.ana, 'can'),
    'Econ.upgrade spoločné': w => Econ.upgrade(w, w.saves.ana, 'plots'),
    'delivery': w => Econ.HANDLERS.delivery(w),
    'npc_jano': w => Econ.HANDLERS.npc_jano(w),
    'npc_fero': w => Econ.HANDLERS.npc_fero(w),
    'npc_zuzka': w => Econ.HANDLERS.npc_zuzka(w),
    'jano_sell': w => Econ.HANDLERS.jano_sell(w, { sp: SP, n: 4 }),
    'festAnnounce': w => Econ.HANDLERS.festAnnounce(w, { id: fest.id }),
    'festStart': w => Econ.HANDLERS.festStart(w, { id: fest.id }),
    'festEnd': w => { w.market.festival = { id: fest.id, mult: fest.mult }; Econ.HANDLERS.festEnd(w, { id: fest.id }); },
    'cExpire': w => Econ.HANDLERS.cExpire(w, { id: w.contracts.list.find(c => !c.takenBy).id }),
    'cDue': w => Econ.HANDLERS.cDue(w, { id: open.id }),
    'I.addItems': w => give(w.saves.bob, 'fl_' + SP, 2, w.tick),
    'I.removeItems': w => I.removeItems(I.playerC(w.saves.ana), 'fl_' + SP, 2, w.tick),
    'I.wiltSweep': w => I.wiltSweep(I.playerC(w.saves.ana), w.tick + 30 * TPD),
    'I.meltSweep': w => I.meltSweep(I.playerC(w.saves.bob), w.tick + TPD),
    'Ice.digIce': w => Ice.digIce(w, w.hory, glacier, 1),
    'Ice.dawnIce': w => Ice.dawnIce(w, 3, 'snow'),
    'Ice.fillIcehouse': w => Ice.fillIcehouse(w, 3),
    'Ice.meltHourly': w => { w.icehouse.ice = 2; Ice.meltHourly(w, 1); },
    'Scav.roll': w => Scav.roll(w, w.tiles.findIndex(t => t.g === 'grass' && !t.s)),
    'Scav.pickWild': w => { w.tiles[ti[2]].s = { k: 'soil', w: 0, r: 0, o: 'ana', p: { sp: Scav.pickWild(w, 1, sp => Econ.flowerPrice(w, sp)), prog: 0, q: 3, dry: 0, wild: 1 } }; },
    'Scav.prune': w => { w.scav = { 5: 1, 6: Math.floor(w.tick / D.SCAVENGE.window) }; Scav.prune(w); },
    'schedule + unique + cancel': w => { E.schedule(w, w.tick + 5, 'jano_sell', { sp: SP, n: 1 }); E.scheduleUnique(w, 'vilyEnd:ana', w.tick + TPD, 'vilyEnd', { key: 'ana' }); E.cancel(w, 'cDue:' + open.id); }
  };
  for (const [name, f] of Object.entries(cases)) {
    const S = JSON.parse(json(base));
    S.rng = 777;
    const before = json(S);
    const expected = JSON.parse(json(S)); f(expected);
    const d = E.createDraft(S, { rng: 777 });
    f(d.proxy);
    assert.strictEqual(json(S), before, name + ': návrh zmenil snímok');
    const got = JSON.parse(json(S));
    E.applyResult(got, d);
    delete expected.rng; delete got.rng;
    assert.deepStrictEqual(got, expected, name);
    assert.ok(d.reads.size + d.ops.length > 0, name + ': nezaznamenalo čítanie');
  }
});

test('draft: zdroje – čo návrh čítal a písal, na úrovni políčka, uloženia, položky trhu', () => {
  const w = makeWorld(2);
  const ti = tillable(w);
  plant(w, ti[0], 'ana', true);
  const d = E.createDraft(w, { rng: 1 });
  PROPOSERS.pick(d.proxy, { key: 'ana', i: ti[0] }, { tick: w.tick, emit() {}, reject: m => { throw new Error(m); } });
  assert.deepStrictEqual([...d.writes].sort(), ['save:ana', `tile:garden:${ti[0]}`]);
  assert.ok(d.reads.has(`tile:garden:${ti[0]}`) && d.reads.has('save:ana'));
  assert.ok(!d.reads.has('tile:garden:*') && ![...d.reads].some(r => r.startsWith('tile:garden:') && r !== `tile:garden:${ti[0]}`), 'číta len svoje políčko: ' + [...d.reads]);
  const d2 = E.createDraft(w, { rng: 1 });
  Econ.buy(d2.proxy, d2.proxy.saves.bob, 'seed_' + SP, 1);
  assert.deepStrictEqual([...d2.writes].sort(), [`market:seed_${SP}`, 'save:bob']);
  // poloha hráča je vlastný zdroj (píše sa 10× za sekundu), iterovanie uložení je kolekcia
  const d3 = E.createDraft(w, { rng: 1 });
  d3.proxy.saves.ana.x = 7; let n = 0; for (const k in d3.proxy.saves) n += d3.proxy.saves[k].coins;
  assert.deepStrictEqual([...d3.writes], ['pos:ana']);
  assert.ok(d3.reads.has('save:*') && d3.reads.has('save:bob') && n > 0);
  assert.ok(E.conflicts(new Set(['save:*']), ['save:bob']) && E.conflicts(new Set(['tile:garden:5']), ['*']) && !E.conflicts(new Set(['tile:garden:5']), ['tile:garden:6', 'save:ana']));
});

test('zmrazený snímok: vyhodnotenie dávky nič do sveta nezapíše (každý zápis do snímku by zlyhal)', () => {
  const w = makeWorld(3);
  const ti = tillable(w);
  plant(w, ti[0], 'ana', true); plant(w, ti[1], 'ana', false);
  give(w.saves.ana, 'fl_' + SP, 3, w.tick);
  E.reconcile(w, SPEC);
  w.tick = D.DAWN_TICK + TPD; // ráno: dawn aj hourly, NPC, zákazky
  deepFreeze(w);
  const inputs = [...w.events.filter(e => e.at <= w.tick + TPD).map(ev => ({ type: ev.type, data: ev.data, ev })),
    input('pick', { key: 'ana', i: ti[0] }), input('water', { key: 'ana', i: ti[1] }), input('buy', { key: 'bob', id: 'seed_' + SP, n: 2 }), input('roll', { id: 'r' })];
  assert.ok(inputs.length > 6);
  for (const inp of inputs) {
    const r = E.evaluate(w, inp, SPEC);
    assert.strictEqual(r.error, undefined, inp.type + ': ' + (r.error && r.error.stack));
    assert.ok(r.reads.size + r.writes.size > 0, inp.type);
  }
});

// ---- Paralelná vyhodnotiteľnosť ----

test('zmiešaná dávka v ľubovoľnom poradí: rovnaké návrhy; vykonaná v pevnom poradí: rovnaký svet a správy', () => {
  const mk = () => {
    const w = makeWorld(4);
    const ti = tillable(w);
    plant(w, ti[0], 'ana', true); plant(w, ti[1], 'bob', true); plant(w, ti[2], 'ana', false);
    give(w.saves.ana, 'fl_' + SP, 4, w.tick); give(w.saves.bob, 'seed_' + SP, 2, w.tick);
    const c = w.contracts.list.find(x => !x.takenBy);
    Econ.takeContract(w, 'ana', c.id); give(w.saves.ana, 'fl_' + c.sp, c.n, w.tick);
    E.reconcile(w, SPEC);
    w.tick = D.DAWN_TICK + TPD;
    w.market.seeds[SP].stock = 2;
    const events = w.events.filter(e => e.at <= w.tick + 1).map(ev => ({ type: ev.type, data: ev.data, ev }));
    const inputs = [...events,
      input('pick', { key: 'ana', i: ti[0] }), input('pick', { key: 'bob', i: ti[0] }), input('wilt', { i: ti[1] }), input('pick', { key: 'bob', i: ti[1] }),
      input('water', { key: 'ana', i: ti[2] }), input('till', { key: 'bob', i: ti[3] }), input('till', { key: 'ana', i: ti[4] }),
      input('buy', { key: 'ana', id: 'seed_' + SP, n: 2 }), input('buy', { key: 'bob', id: 'seed_' + SP, n: 1 }), input('sell', { key: 'bob', id: 'seed_' + SP, n: 2 }),
      input('cdeliver', { key: 'ana', id: c.id }), input('ctake', { key: 'bob', id: w.contracts.list.find(x => !x.takenBy).id }),
      input('gift', { from: 'ana', to: 'bob', id: 'fl_' + SP, n: 2 }), input('store', { key: 'bob', id: 'fl_' + SP, n: 1 }),
      input('roll', { id: 'a' }), input('roll', { id: 'b' })];
    return { w, inputs };
  };
  const view = r => json({ id: r.id, reads: [...r.reads].sort(), writes: [...r.writes].sort(), patches: r.patches, ops: r.ops, outbox: r.outbox, reject: r.reject });
  const { w, inputs } = mk();
  const ref = new Map(inputs.map(inp => [inp, view(E.evaluate(w, inp, SPEC))]));
  for (let s = 1; s <= 5; s++) for (const inp of shuffle(inputs, s)) assert.strictEqual(view(E.evaluate(w, inp, SPEC)), ref.get(inp), inp.type);
  // commit v pevnom poradí dávky je deterministický (dva nezávislé svety)
  const a = mk(), b = mk();
  const ra = E.commitBatch(a.w, a.inputs, SPEC), rb = E.commitBatch(b.w, b.inputs, SPEC);
  assert.strictEqual(json(a.w), json(b.w));
  assert.deepStrictEqual(ra.outbox, rb.outbox);
  assert.deepStrictEqual(ra.rejected.map(r => r.id), rb.rejected.map(r => r.id));
  assert.ok(ra.rounds >= 2 && ra.applied.length > 8 && ra.rejected.length >= 2, `kolá ${ra.rounds}, vykonané ${ra.applied.length}, odmietnuté ${ra.rejected.length}`);
});

test('náhoda návrhu závisí len od semienka, kola a identity vstupu – ubratie iného vstupu ju nezmení', () => {
  const run = ids => { const w = makeWorld(5); return E.commitBatch(w, ids.map(id => input('roll', { id }, 'roll:' + id)), SPEC).outbox; };
  const abc = run(['a', 'b', 'c']), ac = run(['a', 'c']), cba = run(['c', 'b', 'a']);
  const byId = out => Object.fromEntries(out.map(m => [m.id, m.v]));
  assert.deepStrictEqual(byId(ac), { a: byId(abc).a, c: byId(abc).c });
  assert.deepStrictEqual(byId(cba), byId(abc));
  assert.ok(new Set(Object.values(byId(abc))).size === 3, 'rôzne vstupy, rôzne hodnoty');
  // iné semienko sveta → iné hodnoty; to isté semienko → stále tie isté
  const w2 = makeWorld(6);
  assert.notDeepStrictEqual(byId(E.commitBatch(w2, ['a', 'b', 'c'].map(id => input('roll', { id }, 'roll:' + id)), SPEC).outbox), byId(abc));
  assert.deepStrictEqual(byId(run(['a', 'b', 'c'])), byId(abc));
});

// ---- Kolá: súčasné návrhy na tom istom zdroji ----

test('ten istý tovar: posledné semienko kúpi práve jeden, druhý dostane „Vypredané“; kto nemá mince, nekúpi', () => {
  const w = makeWorld(7);
  w.market.seeds[SP].stock = 1;
  w.saves.bob.coins = 0;
  w.saves.cyril = Object.assign(JSON.parse(json(w.saves.ana)), { coins: 500 });
  const price = Econ.seedPrice(w, SP);
  const r = E.commitBatch(w, [input('buy', { key: 'ana', id: 'seed_' + SP, n: 1 }), input('buy', { key: 'cyril', id: 'seed_' + SP, n: 1 }), input('buy', { key: 'bob', id: 'seed_' + SP, n: 1 })], SPEC);
  assert.strictEqual(r.rounds, 2, 'obaja ďalší čítali zásobu, ktorú ana zmenila – vyhodnotia sa znova v druhom kole');
  assert.deepStrictEqual(r.applied.map(x => x.input.data.key), ['ana']);
  assert.deepStrictEqual(r.rejected.map(x => [x.input.data.key, x.reject]), [['cyril', 'Vypredané. Veľkoobchodník príde o pár dní.'], ['bob', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  // bez konfliktu dostane chudobný hráč svoju správu hneď v prvom kole
  const w2 = makeWorld(7); w2.saves.bob.coins = 0;
  assert.deepStrictEqual(E.commitBatch(w2, [input('buy', { key: 'bob', id: 'seed_' + SP, n: 1 })], SPEC).rejected.map(x => x.reject), ['Nemáš dosť mincí. 🪙']);
  assert.strictEqual(w.market.seeds[SP].stock, 0);
  assert.strictEqual(w.saves.ana.coins, 500 - price);
  assert.strictEqual(w.saves.ana.inv['seed_' + SP], 1);
  assert.strictEqual(w.saves.cyril.inv['seed_' + SP], undefined);
  assert.strictEqual(w.saves.cyril.coins, 500);
});

test('ten istý tovar: nákupy a predaje v jednom kroku – zásoba, mince a batohy sedia, každý kus za cenu platnú pri predaji', () => {
  for (const order of [0, 1, 2]) {
    const w = makeWorld(8);
    w.market.seeds[SP].stock = 3;
    give(w.saves.bob, 'seed_' + SP, 5, w.tick);
    const coins0 = w.saves.ana.coins + w.saves.bob.coins, seeds0 = 3 + 5;
    const inputs = [input('buy', { key: 'ana', id: 'seed_' + SP, n: 4 }), input('sell', { key: 'bob', id: 'seed_' + SP, n: 3 }), input('buy', { key: 'bob', id: 'seed_' + SP, n: 1 })];
    const r = E.commitBatch(w, shuffle(inputs, order), SPEC);
    assert.strictEqual(r.rejected.length, 0);
    const st = w.market.seeds[SP].stock, inv = (w.saves.ana.inv['seed_' + SP] || 0) + (w.saves.bob.inv['seed_' + SP] || 0);
    assert.strictEqual(st + inv, seeds0, 'semienka sa nestratili ani nezdvojili');
    // každý krok prepočíta ceny podľa vtedajšej zásoby: mince hráčov klesli presne o rozdiel nákupov a predajov podľa správ
    let paid = 0;
    for (const m of r.outbox) { const mt = /za (\d+) 🪙/.exec(m.text); paid += (/Kúpené/.test(m.text) ? 1 : -1) * +mt[1]; }
    assert.strictEqual(coins0 - (w.saves.ana.coins + w.saves.bob.coins), paid);
    for (const key of ['ana', 'bob']) assert.strictEqual(Object.values(w.saves[key].fb).flat().reduce((s, b) => s + b.n, 0), Object.keys(w.saves[key].inv).filter(I.isFlower).length ? NaN : 0);
  }
});

test('to isté políčko: dvaja trhajú ten istý kvet – dostane ho práve jeden; trhanie v kroku, keď kvet hynie – práve jeden výsledok', () => {
  for (const order of [0, 1]) {
    const w = makeWorld(9);
    const i = tillable(w)[0];
    plant(w, i, 'ana', true);
    const inputs = [input('pick', { key: 'ana', i }), input('pick', { key: 'bob', i })];
    const r = E.commitBatch(w, order ? inputs.reverse() : inputs, SPEC);
    assert.strictEqual(r.rounds, 2);
    assert.strictEqual(flowers(w, 'ana') + flowers(w, 'bob'), 3, 'kvet dostal práve jeden');
    assert.strictEqual(r.rejected.length, 1);
    assert.strictEqual(r.rejected[0].reject, 'Tu nič nekvitne.');
    assert.strictEqual(w.tiles[i].s.p, null);
  }
  for (const order of [0, 1]) {
    const w = makeWorld(10);
    const i = tillable(w)[0];
    plant(w, i, 'ana', true);
    const inputs = [input('pick', { key: 'ana', i }), input('wilt', { i })];
    E.commitBatch(w, order ? inputs.reverse() : inputs, SPEC);
    const p = w.tiles[i].s.p;
    const inBag = flowers(w, 'ana') === 3, dead = !!(p && p.d);
    assert.ok(inBag !== dead, `kvet je buď v batohu, alebo zhynul: batoh ${inBag}, zhynul ${dead}`);
  }
});

test('to isté políčko: dvaja kopú alebo polievajú to isté políčko – jeden stav políčka; rôzne políčka sa nebrzdia', () => {
  const w = makeWorld(11);
  const ti = tillable(w);
  let r = E.commitBatch(w, [input('till', { key: 'ana', i: ti[0] }), input('till', { key: 'bob', i: ti[0] })], SPEC);
  assert.strictEqual(r.applied.length, 1);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Tu už je záhon.']);
  assert.strictEqual(Econ.plotsUsed(w), 1);
  plant(w, ti[1], 'ana', false); plant(w, ti[2], 'bob', false);
  r = E.commitBatch(w, [input('water', { key: 'ana', i: ti[1] }), input('water', { key: 'bob', i: ti[2] })], SPEC);
  assert.strictEqual(r.rounds, 1, 'rôzne políčka a rôzni hráči: jedno kolo');
  assert.strictEqual(r.applied.length, 2);
  w.tiles[ti[1]].s.w = 0;
  r = E.commitBatch(w, [input('water', { key: 'ana', i: ti[1] }), input('water', { key: 'bob', i: ti[1] })], SPEC);
  assert.strictEqual(r.rounds, 2, 'to isté políčko: druhé kolo');
  assert.deepStrictEqual([w.saves.ana.water, w.saves.bob.water, w.tiles[ti[1]].s.w], [3, 3, 1]);
});

test('tá istá zákazka u babky: dvaja ju berú, alebo odovzdanie a termín v jednom kroku – práve jeden výsledok', () => {
  const w = makeWorld(12);
  const c = w.contracts.list.find(x => !x.takenBy);
  let r = E.commitBatch(w, [input('ctake', { key: 'ana', id: c.id }), input('ctake', { key: 'bob', id: c.id })], SPEC);
  assert.deepStrictEqual([r.applied.length, r.rejected.map(x => x.reject)], [1, ['Túto zákazku už niekto zobral.']]);
  assert.strictEqual(c.takenBy, 'ana');
  for (const order of [0, 1]) {
    const w2 = makeWorld(13);
    const c2 = w2.contracts.list.find(x => !x.takenBy);
    Econ.takeContract(w2, 'ana', c2.id);
    give(w2.saves.ana, 'fl_' + c2.sp, c2.n, w2.tick);
    const coins = w2.saves.ana.coins, rep = w2.saves.ana.rep;
    w2.tick = c2.due;
    const due = w2.events.find(e => e.key === 'cDue:' + c2.id);
    w2.events = w2.events.filter(e => e !== due);
    const inputs = [input('cdeliver', { key: 'ana', id: c2.id }), { type: 'cDue', data: due.data, ev: due }];
    const res = E.commitBatch(w2, order ? inputs.reverse() : inputs, SPEC);
    const sv = w2.saves.ana, delivered = sv.coins === coins + c2.reward && sv.rep === rep + c2.rep && !(sv.inv['fl_' + c2.sp]);
    const expired = sv.coins === coins && sv.rep === Math.max(0, rep - 5) && sv.inv['fl_' + c2.sp] === c2.n;
    assert.ok(delivered !== expired, `poradie ${order}: odovzdané ${delivered}, prepadnuté ${expired} (${json(sv)})`);
    assert.ok(!w2.contracts.list.some(x => x.id === c2.id), 'zákazka zmizla z nástenky');
    assert.ok(!E.pending(w2, 'cDue:' + c2.id));
    if (order === 0) assert.ok(delivered && res.applied.length === 2, 'odovzdanie prvé v poradí: cDue potom už nič nenájde');
  }
});

test('ten istý batoh: dar hráčovi, ktorý si práve ukladá do skladu; ranný kompostér do batohu, z ktorého sa práve predáva', () => {
  const w = makeWorld(14);
  give(w.saves.ana, 'fl_' + SP, 3, w.tick - TPD); give(w.saves.bob, 'fl_' + SP, 2, w.tick);
  const total = () => flowers(w, 'ana') + flowers(w, 'bob') + (w.storage['fl_' + SP] || 0);
  const sum = c => Object.values(c.fb).flat().reduce((s, b) => s + b.n, 0);
  const r = E.commitBatch(w, [input('gift', { from: 'ana', to: 'bob', id: 'fl_' + SP, n: 2 }), input('store', { key: 'bob', id: 'fl_' + SP, n: 2 })], SPEC);
  assert.strictEqual(r.rounds, 2);
  assert.strictEqual(total(), 5);
  assert.deepStrictEqual([flowers(w, 'ana'), flowers(w, 'bob'), w.storage['fl_' + SP]], [1, 2, 2]);
  for (const c of [I.playerC(w.saves.ana), I.playerC(w.saves.bob), I.storageC(w)]) assert.strictEqual(sum(c), c.inv['fl_' + SP] || 0, 'várky sedia s počtom');
  // ráno (legacy handler, píše všetkým) + predaj kompostu v tom istom kroku
  give(w.saves.ana, 'compost', 2, w.tick);
  const r2 = E.commitBatch(w, [input('sell', { key: 'ana', id: 'compost', n: 2 }), { type: 'dawn', data: null, ev: { type: 'dawn', seq: 999 } }], SPEC);
  assert.strictEqual(r2.applied.length, 2);
  assert.strictEqual(w.saves.ana.inv.compost, D.UPGRADES.composter.levels[1].v, 'predané 2, kompostér pridal svoje');
});

test('udalosti sveta: ráno a hodinová o 6:00 bežia obe v tom istom kroku (aj pri dobiehaní), každá práve raz, v kolách', () => {
  const w = makeWorld(15, 0), log = [];
  const spec = {
    handlers: { dawn(w) { log.push('dawn@' + w.tick); w.weather = 'rain'; }, hourly(w) { log.push('hourly@' + w.tick + ':' + w.weather); } },
    periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) }, { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) }], onError: rethrow
  };
  E.advanceTo(w, 2 * TPD, spec);
  assert.ok(log.includes('dawn@' + D.DAWN_TICK) && log.includes('hourly@' + D.DAWN_TICK + ':rain'), log.join(' '));
  assert.strictEqual(log.filter(x => x.startsWith('dawn')).length, 2);
  assert.strictEqual(log.filter(x => x.startsWith('hourly')).length, 48);
  assert.ok(w.step >= 50, 'každé kolo zvýši počítadlo: ' + w.step);
});

// ---- Atomickosť ----

test('návrh, ktorý zapíše mince a potom zlyhá, nezanechá nič – ani v starom handleri, ani v čistom návrhu', () => {
  const w = makeWorld(16);
  const before = json(w);
  const errors = [];
  const spec = {
    proposers: { pay(d) { d.saves.ana.coins -= 100; d.tiles[0].s = { k: 'soil' }; E.scheduleUnique(d, 'x', d.tick + 1, 'pay'); throw new Error('bum'); } },
    handlers: { legacyPay(w) { w.saves.bob.coins -= 100; w.market.compost.stock = 0; throw new Error('bum2'); } },
    onError(err) { errors.push(err.message); }
  };
  const r = E.commitBatch(w, [input('pay', null), input('legacyPay', null)], spec);
  assert.deepStrictEqual(errors, ['bum', 'bum2']);
  const after = JSON.parse(json(w));
  assert.strictEqual(after.step, 1, 'kolo prebehlo');
  after.step = 0;
  assert.strictEqual(json(after), before, 'svet je nezmenený');
  assert.deepStrictEqual([r.applied.length, r.rejected.length], [0, 0]);
});

test('odmietnutý návrh nič nevykoná, ale má zaznamenané zdroje (aj on sa dá vyhodnotiť paralelne)', () => {
  const w = makeWorld(17);
  const i = tillable(w)[0];
  const before = json(w);
  const r = E.evaluate(w, input('pick', { key: 'ana', i }), SPEC);
  assert.strictEqual(r.reject, 'Tu nič nekvitne.');
  assert.ok(r.reads.has(`tile:garden:${i}`));
  assert.strictEqual(json(w), before);
});

// ---- Prehranie ----

test('uložený svet + zaznamenané dávky akcií dajú ten istý svet ako nepretržitý beh', () => {
  const script = (w, ti) => [
    { at: D.DAWN_TICK + 10, inputs: [input('till', { key: 'ana', i: ti[0] }), input('buy', { key: 'ana', id: 'seed_' + SP, n: 2 })] },
    { at: D.DAWN_TICK + 40, inputs: [input('till', { key: 'bob', i: ti[1] }), input('water', { key: 'ana', i: ti[0] })] },
    { at: TPD + D.DAWN_TICK + 5, inputs: [input('roll', { id: 'x' }), input('buy', { key: 'bob', id: 'compost', n: 1 })] },
    { at: 3 * TPD, inputs: [input('sell', { key: 'ana', id: 'seed_' + SP, n: 1 }), input('roll', { id: 'y' })] }
  ];
  const run = (w, steps) => { for (const s of steps) { E.advanceTo(w, s.at, SPEC); E.commitBatch(w, s.inputs, SPEC); } E.advanceTo(w, 4 * TPD, SPEC); return w; };
  const a = makeWorld(18, 0), steps = script(a, tillable(a));
  run(a, steps);
  const b = makeWorld(18, 0);
  for (const s of steps.slice(0, 2)) { E.advanceTo(b, s.at, SPEC); E.commitBatch(b, s.inputs, SPEC); }
  const restored = JSON.parse(json(b)); // uloženie a načítanie po druhej dávke
  run(restored, steps.slice(2));
  assert.strictEqual(json(restored), json(a));
  assert.ok(a['roll:x'] >= 0 && a['roll:y'] >= 0 && a.tiles[steps[0].inputs[0].data.i].s);
});

test('draft: zápis cez proxy prvku, ktorého rodiča handler nahradil, je chyba návrhu (čítanie nie)', () => {
  const w = makeWorld(19);
  const spec = {
    proposers: {
      readOnly(d) { const c = d.contracts.list[0]; d.contracts.list = d.contracts.list.filter(x => x !== c); d.weather = c.takenBy ? 'rain' : 'sun'; },
      stale(d) { const c = d.contracts.list[0]; d.contracts.list = d.contracts.list.filter(x => x !== c); c.got = 5; }
    }, onError: rethrow
  };
  assert.strictEqual(E.evaluate(w, input('readOnly', null), spec).error, undefined);
  assert.match(String(E.evaluate(w, input('stale', null), spec).error), /odpojenú proxy/);
});

// ---- Hygiena ----

test('v jadre simulácie nie je Math.random ani Date.now', () => {
  for (const f of ['engine.js', 'draft.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/Math\.random|Date\.now/.test(src), f);
  }
});
