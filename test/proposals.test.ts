// Engine v2 (#105, #107, #109): návrhy deklarujú kľúče a bežia na výrezoch; kolá, atomickosť, náhoda bez zdieľaného
// prúdu, odvodené počítadlá, denník dávok a jeho prehranie.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { ItemId } from '../src/shared/data.ts';
import type { Contracts, Icehouse, Market, PlayerSave } from '../src/shared/save.ts';
import { isRecord } from '../src/shared/util.ts';
import type { JsonRecord } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import * as Events from '../src/server/events.ts';
import * as I from '../src/server/items.ts';
import * as Ice from '../src/server/ice.ts';
import { sl } from '../src/server/game.ts';
import type { GameSlices, GameWorld } from '../src/server/game.ts';
import type { Container, Presence, Tile } from '../src/server/world.ts';
import { must, parseJson, parseMsg, partial, rethrow, testWorld } from './helpers.ts';
const TPD = D.TICKS_PER_DAY;
const SP = must(Econ.PLANTABLE.find(k => !D.SPECIES[k].strict)); // bežný kvet
const json = (v: unknown): string => JSON.stringify(v);

// Svet testov: svet hry s trhom a nástenkou; návrh roll si zapisuje vlastné kľúče roll:<id> priamo do sveta
type W = GameWorld & { market: Market; contracts: Contracts; [roll: `roll:${string}`]: number | undefined };
type Spec = E.Spec<W, Presence, unknown>;
type Out = E.BatchOut<Presence, unknown>;
// Návrh testu: dáta podľa návrhu, správy ľubovoľné (test overuje engine, nie protokol)
type Prop<Dt> = E.Proposer<Dt, W, Presence, unknown, GameSlices>;
const prop = <Dt,>(p: Prop<Dt>): Prop<Dt> => p;
const ready = (w: GameWorld): w is W => !!w.market && !!w.contracts;
// Svet ako na serveri po načítaní: záhrada, hory, trh, nástenka, dvaja hráči (bez socketov).
function makeWorld(seed: number, tick?: number): W {
  const w = testWorld<Partial<GameWorld>>({
    tick: tick == null ? D.DAWN_TICK + 6 : tick, wall: 0, daySeconds: 1200, seed: 'test-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: partial<Icehouse>({ built: true, ice: 0 }), up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  });
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = partial<PlayerSave>({ coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, x: 5, y: 5, area: 'garden' });
  if (!ready(w)) throw new Error('trh a nástenka chýbajú');
  return w;
}
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
const at = (w: GameWorld, i: number): Tile => must(w.tiles[i]);
// Výrezy v návrhoch testu (deklarované – inak by chýbali)
const sv = (s: GameSlices, key: string): PlayerSave => must(sl(s, `save:${key}`));
const tl = (s: GameSlices, i: number): Tile => must(sl(s, `tile:garden:${i}`));
// Polia správ a dát vstupov (test ich má ako obyčajný JSON)
const field = (v: unknown, k: string): unknown => (isRecord(v) ? v[k] : undefined);
const textOf = (m: unknown): string => { const t = field(m, 'text'); return typeof t === 'string' ? t : ''; };
const errText = (e: unknown): string => (e instanceof Error ? String(e) : '');
// Políčka záhrady, na ktorých sa dá kopať
function tillable(w: GameWorld): number[] { return w.tiles.map((t, i) => i).filter(i => D.TILLABLE[at(w, i).g] && at(w, i).g !== 'ring'); }
function plant(w: GameWorld, i: number, key: string, ripe: boolean): void {
  at(w, i).s = { k: must(D.TILLABLE[at(w, i).g]), w: 1, r: 0, o: key, p: { sp: SP, prog: ripe ? D.SPECIES[SP].days : 1, q: 3, dry: 0 } };
  w.plotsUsed = Econ.plotsUsedOf(w.tiles);
}
function give(sv: PlayerSave, id: ItemId, n: number, tick: number): void { I.addItems(I.playerC(sv), id, n, tick); }
function flowers(w: GameWorld, key: string): number { return (save(w, key).inv[`fl_${SP}`] || 0); }

// Akcie hráčov ako deklarované návrhy (tak budú v spec.proposers po fáze 3): keys povie, čo čítajú a menia,
// run dostane kópie práve týchto výrezov; správy cez ctx.emit, odmietnutie cez ctx.reject.
type KI = { key: string; i: number };
type Trade = { key: string; id: string; n: number };
const PROPOSERS = {
  water: prop<KI>({
    keys: ({ key, i }) => ({ writes: ['save:' + key, 'tile:garden:' + i] }),
    run(s, { key, i }, ctx) {
      const v = sv(s, key), t = tl(s, i);
      if (!t.s) ctx.reject('Tu nie je záhon.');
      if (v.water <= 0) ctx.reject('Krhla je prázdna.');
      v.water--; must(t.s ?? undefined).w = 1;
      ctx.emit({ to: key, t: 'fx', k: 'drops', i });
    }
  }),
  till: prop<KI>({
    keys: ({ i }) => ({ writes: ['tile:garden:' + i, 'plotsUsed'], reads: ['up'] }),
    run(s, { key, i }, ctx) {
      const t = tl(s, i);
      if (t.s) ctx.reject('Tu už je záhon.');
      if (s.plotsUsed >= Econ.plotLimit(s.up)) ctx.reject('Povolenie je vyčerpané.');
      t.s = { k: must(D.TILLABLE[t.g]), w: 0, r: 0, p: null, o: key };
      s.plotsUsed++;
    }
  }),
  level: prop<{ i: number }>({
    keys: ({ i }) => ({ writes: ['tile:garden:' + i, 'plotsUsed'] }),
    run(s, { i }, ctx) { const t = tl(s, i); if (!t.s || t.s.p) ctx.reject('Tu nie je prázdny záhon.'); t.s = null; s.plotsUsed--; }
  }),
  pick: prop<KI>({
    keys: ({ key, i }) => ({ writes: ['save:' + key, 'tile:garden:' + i] }),
    run(s, { key, i }, ctx) {
      const t = tl(s, i), p = t.s && t.s.p;
      if (!t.s || !p || p.d || p.prog < D.SPECIES[p.sp].days) { ctx.reject('Tu nič nekvitne.'); return; }
      const n = Math.min(4, p.q + (t.s.r ? 1 : 0));
      I.addItems(I.playerC(sv(s, key)), `fl_${p.sp}`, n, ctx.tick);
      t.s.r = 0; t.s.p = null;
      ctx.emit({ to: key, t: 'toast', text: `+${n}× ${D.SPECIES[p.sp].name}` });
    }
  }),
  // udalosť sveta: kvet na políčku zvädne (ako ranný rast / mráz / hodinové vädnutie)
  wilt: prop<{ i: number }>({ keys: ({ i }) => ({ writes: ['tile:garden:' + i] }), run(s, { i }) { const p = tl(s, i).s && tl(s, i).s?.p; if (p) { p.d = 1; p.why = 'mráz'; } } }),
  buy: prop<Trade>({
    keys: ({ key }) => ({ writes: ['market:*', 'save:' + key] }),
    run(s, { key, id, n }, ctx) {
      const r = Econ.buy(sl(s, 'market:*'), ctx.tick, sv(s, key), id, n);
      if (!r.n) ctx.reject(r.msg);
      ctx.emit({ to: key, t: 'toast', text: r.msg });
    }
  }),
  sell: prop<Trade>({
    keys: ({ key }) => ({ writes: ['market:*', 'save:' + key] }),
    run(s, { key, id, n }, ctx) {
      const r = Econ.sell(sl(s, 'market:*'), ctx.tick, sv(s, key), id, n);
      if (!r.n) ctx.reject(r.msg);
      ctx.emit({ to: key, t: 'toast', text: r.msg });
    }
  }),
  ctake: prop<{ key: string; id: number }>({
    keys: ({ key }) => ({ writes: ['contracts'], reads: ['save:' + key] }),
    run(s, { key, id }, ctx) { const err = Econ.takeContract(s.contracts, ctx.tick, sv(s, key), key, id); if (err) ctx.reject(err); }
  }),
  cdeliver: prop<{ key: string; id: number }>({
    keys: ({ key }) => ({ writes: ['contracts', 'save:' + key, 'maxRep'] }),
    run(s, { key, id }, ctx) {
      const r = Econ.deliverContract(s.contracts, ctx.tick, sv(s, key), key, id, s.maxRep, ctx);
      s.maxRep = r.maxRep;
      if (!r.done && !/Odovzdané/.test(r.msg)) ctx.reject(r.msg);
      ctx.emit({ to: key, t: 'toast', text: r.msg });
    }
  }),
  gift: prop<{ from: string; to: string; id: ItemId; n: number }>({
    keys: ({ from, to }) => ({ writes: ['save:' + from, 'save:' + to] }),
    run(s, { from, to, id, n }, ctx) {
      const b = I.removeItems(I.playerC(sv(s, from)), id, n, ctx.tick);
      if (!b) { ctx.reject('Toto nemáš.'); return; }
      I.addItems(I.playerC(sv(s, to)), id, n, ctx.tick, b);
    }
  }),
  store: prop<{ key: string; id: ItemId; n: number }>({
    keys: ({ key }) => ({ writes: ['save:' + key, 'storage'], reads: ['icehouse'] }),
    run(s, { key, id, n }, ctx) {
      const b = I.removeItems(I.playerC(sv(s, key)), id, n, ctx.tick);
      if (!b) { ctx.reject('Toto nemáš.'); return; }
      I.addItems(I.storageC(s.storage, s.icehouse), id, n, ctx.tick, b);
    }
  }),
  roll: prop<{ id: string }>({ keys: ({ id }) => ({ writes: ['roll:' + id] }), run(s, { id }, ctx) { const v = ctx.rng.int(1000); s['roll:' + id] = v; ctx.emit({ id, v }); } }) // každý hod píše vlastný kľúč
};
const SPEC: Spec = { proposers: { ...Events.PROPOSERS, ...PROPOSERS }, periodic: Events.PERIODIC, onError: rethrow };
const input = (type: string, data: unknown, id?: string): E.Input => ({ type, data, id: id || type + ':' + json(data) });
function shuffle<T>(list: readonly T[], seed: number): T[] {
  const g = E.generator(seed), out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = g.int(i + 1); [out[i], out[j]] = [must(out[j]), must(out[i])]; }
  return out;
}
function deepFreeze<T>(o: T): T { if (isRecord(o) && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; }
// Spec s denníkom: entries dostane záznam každej dávky
const withJournal = (spec: Spec, entries: E.JournalEntry<Presence, unknown>[]): Spec => ({ ...spec, onBatch: (w, out) => { entries.push(out.entry); } });
// Udalosť fronty ako vstup dávky (test zadá len poradové číslo a typ)
const evOf = (ev: Partial<E.EngineEvent>): E.EngineEvent => partial<E.EngineEvent>(ev);

// ---- Výrezy ----

test('výrez: návrh dostane kópie práve deklarovaných výrezov; nedeklarovaný výrez v slices nie je a siahnutie naň zlyhá nahlas', () => {
  const w = makeWorld(1);
  const spec: Spec = {
    proposers: {
      ok: prop({ keys: () => ({ writes: ['save:ana'], reads: ['weather', 'tile:garden:5'] }), run(s) { assert.deepStrictEqual(Object.keys(s).sort(), ['save:ana', 'tile:garden:5', 'weather']); assert.ok(sl(s, 'save:ana') !== save(w, 'ana'), 'kópia, nie živý objekt'); sv(s, 'ana').coins = 1; } }),
      // zámerne siahne na výrez, ktorý nedeklaroval (v slices nie je) – musí zlyhať TypeError
      bad: prop({ keys: () => ({ writes: ['save:ana'] }), run(s) { (sl(s, 'save:bob') as PlayerSave).coins = 0; } }),
      badTiles: prop({ keys: () => ({ writes: ['save:ana'] }), run(s) { (s['tiles'] as { 0: Tile })[0].s = null; } })
    }, onError: rethrow
  };
  const before = json(w);
  assert.strictEqual(E.evaluate(w, input('ok', null), spec).error, undefined);
  assert.match(errText(E.evaluate(w, input('bad', null), spec).error), /TypeError/);
  assert.match(errText(E.evaluate(w, input('badTiles', null), spec).error), /TypeError/);
  assert.strictEqual(json(w), before, 'vyhodnotenie svet nemení');
  const errors: string[] = [];
  E.commitBatch(w, [input('bad', null), input('ok', null)], { ...spec, onError: e => { errors.push(e instanceof Error ? e.message : ''); } });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(save(w, 'ana').coins, 1, 'ostatné návrhy dávky prešli');
});

test('výrez deklarovaný len na čítanie sa nesmie zmeniť – zápis doň je chyba návrhu, nič sa nevykoná', () => {
  const w = makeWorld(2);
  const spec: Spec = {
    proposers: {
      scalar: prop({ keys: () => ({ reads: ['weather'], writes: ['save:ana'] }), run(s) { sv(s, 'ana').coins--; s.weather = 'rain'; } }),
      object: prop({ keys: () => ({ reads: ['save:bob'], writes: ['save:ana'] }), run(s) { sv(s, 'ana').coins--; sv(s, 'bob').coins--; } }),
      fine: prop({ keys: () => ({ reads: ['save:bob'], writes: ['save:ana'] }), run(s) { sv(s, 'ana').coins -= sv(s, 'bob').coins; } })
    }, onError: rethrow
  };
  const before = json(w);
  for (const t of ['scalar', 'object']) assert.match(errText(E.evaluate(w, input(t, null), spec).error), /len na čítanie/, t);
  assert.strictEqual(json(w), before);
  E.commitBatch(w, [input('fine', null)], spec);
  assert.strictEqual(save(w, 'ana').coins, 0);
});

test('výrezy sa zapíšu späť na mieste: uloženie hráča, políčko aj trh si zachovajú identitu, kolekcie sa menia zvnútra', () => {
  const w = makeWorld(3);
  const i = must(tillable(w)[0]);
  plant(w, i, 'ana', true);
  const sv = save(w, 'ana'), t = at(w, i), tiles = w.tiles, market = w.market, contracts = w.contracts, saves = w.saves;
  const r = E.commitBatch(w, [input('pick', { key: 'ana', i }), { type: 'dawn', data: null, ev: evOf({ seq: 1 }) }], SPEC);
  assert.strictEqual(r.applied.length, 2);
  assert.ok(w.saves['ana'] === sv && w.tiles[i] === t && w.tiles === tiles && w.market === market && w.contracts === contracts && w.saves === saves);
  assert.strictEqual(sv.inv[`fl_${SP}`], 3, 'kvet je v tom istom objekte uloženia');
  assert.strictEqual(t.s?.p, null);
  assert.strictEqual(sv.inv.compost, must(D.UPGRADES.composter.levels[1]).v, 'ráno pridalo kompost do toho istého batoha');
  assert.ok(must(w.market.hist[`seed_${SP}`]).length >= 2, 'ráno zapísalo ceny');
});

test('zmrazený snímok: vyhodnotenie dávky nič do sveta nezapíše (každý zápis do snímku by zlyhal)', () => {
  const w = makeWorld(4);
  const ti = tillable(w);
  plant(w, must(ti[0]), 'ana', true); plant(w, must(ti[1]), 'ana', false);
  give(save(w, 'ana'), `fl_${SP}`, 3, w.tick);
  E.reconcile(w, SPEC);
  w.tick = D.DAWN_TICK + TPD; // ráno: dawn aj hourly, NPC, zákazky
  deepFreeze(w);
  const inputs = [...w.events.filter(e => e.at <= w.tick + TPD).map(ev => ({ type: ev.type, data: ev.data, ev })),
    input('pick', { key: 'ana', i: ti[0] }), input('water', { key: 'ana', i: ti[1] }), input('buy', { key: 'bob', id: `seed_${SP}`, n: 2 }), input('roll', { id: 'r' })];
  assert.ok(inputs.length > 6);
  for (const inp of inputs) {
    const r = E.evaluate(w, inp, SPEC);
    assert.strictEqual(r.error, undefined, inp.type + ': ' + String(r.error instanceof Error ? r.error.stack : r.error));
    assert.ok(r.reads.size + r.writes.size > 0, inp.type);
  }
});

// ---- Paralelná vyhodnotiteľnosť ----

test('zmiešaná dávka v ľubovoľnom poradí: rovnaké návrhy; vykonaná v pevnom poradí: rovnaký svet a správy', () => {
  const mk = () => {
    const w = makeWorld(5);
    const ti = tillable(w);
    plant(w, must(ti[0]), 'ana', true); plant(w, must(ti[1]), 'bob', true); plant(w, must(ti[2]), 'ana', false);
    give(save(w, 'ana'), `fl_${SP}`, 4, w.tick); give(save(w, 'bob'), `seed_${SP}`, 2, w.tick);
    const c = must(w.contracts.list.find(x => !x.takenBy));
    Econ.takeContract(w.contracts, w.tick, save(w, 'ana'), 'ana', c.id); give(save(w, 'ana'), `fl_${c.sp}`, c.n, w.tick);
    E.reconcile(w, SPEC);
    w.tick = D.DAWN_TICK + TPD;
    must(w.market.seeds[SP]).stock = 2;
    const events = w.events.filter(e => e.at <= w.tick + 1).map(ev => ({ type: ev.type, data: ev.data, ev }));
    const inputs = [...events,
      input('pick', { key: 'ana', i: ti[0] }), input('pick', { key: 'bob', i: ti[0] }), input('wilt', { i: ti[1] }), input('pick', { key: 'bob', i: ti[1] }),
      input('water', { key: 'ana', i: ti[2] }), input('till', { key: 'bob', i: ti[3] }), input('till', { key: 'ana', i: ti[4] }),
      input('buy', { key: 'ana', id: `seed_${SP}`, n: 2 }), input('buy', { key: 'bob', id: `seed_${SP}`, n: 1 }), input('sell', { key: 'bob', id: `seed_${SP}`, n: 2 }),
      input('cdeliver', { key: 'ana', id: c.id }), input('ctake', { key: 'bob', id: must(w.contracts.list.find(x => !x.takenBy)).id }),
      input('gift', { from: 'ana', to: 'bob', id: `fl_${SP}`, n: 2 }), input('store', { key: 'bob', id: `fl_${SP}`, n: 1 }),
      input('roll', { id: 'a' }), input('roll', { id: 'b' })];
    return { w, inputs };
  };
  const view = (r: E.Result<unknown>): string => json({ id: r.id, reads: [...r.reads].sort(), writes: [...r.writes].sort(), slices: r.slices, ops: r.ops, outbox: r.outbox, reject: r.reject });
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
  const run = (ids: string[]): unknown[] => { const w = makeWorld(6); return E.commitBatch(w, ids.map(id => input('roll', { id }, 'roll:' + id)), SPEC).outbox; };
  const abc = run(['a', 'b', 'c']), ac = run(['a', 'c']), cba = run(['c', 'b', 'a']);
  const byId = (out: unknown[]): JsonRecord => Object.fromEntries(out.map(m => [String(field(m, 'id')), field(m, 'v')]));
  assert.deepStrictEqual(byId(ac), { a: byId(abc)['a'], c: byId(abc)['c'] });
  assert.deepStrictEqual(byId(cba), byId(abc));
  assert.ok(new Set(Object.values(byId(abc))).size === 3, 'rôzne vstupy, rôzne hodnoty');
  // iné semienko sveta → iné hodnoty; to isté semienko → stále tie isté
  const w2 = makeWorld(7);
  assert.notDeepStrictEqual(byId(E.commitBatch(w2, ['a', 'b', 'c'].map(id => input('roll', { id }, 'roll:' + id)), SPEC).outbox), byId(abc));
  assert.deepStrictEqual(byId(run(['a', 'b', 'c'])), byId(abc));
});

// ---- Kolá: súčasné návrhy na tom istom kľúči ----

test('ten istý tovar: posledné semienko kúpi práve jeden, druhý dostane „Vypredané“; kto nemá mince, nekúpi', () => {
  const w = makeWorld(8);
  must(w.market.seeds[SP]).stock = 1;
  save(w, 'bob').coins = 0;
  w.saves['cyril'] = Object.assign(parseJson<PlayerSave>(json(save(w, 'ana'))), { coins: 500 });
  const price = Econ.seedPrice(w.market, w.tick, SP);
  const r = E.commitBatch(w, [input('buy', { key: 'ana', id: `seed_${SP}`, n: 1 }), input('buy', { key: 'cyril', id: `seed_${SP}`, n: 1 }), input('buy', { key: 'bob', id: `seed_${SP}`, n: 1 })], SPEC);
  assert.strictEqual(r.rounds, 2, 'obaja ďalší deklarovali trh, ktorý ana zmenila – vyhodnotia sa znova v druhom kole');
  assert.deepStrictEqual(r.applied.map(x => field(x.input.data, 'key')), ['ana']);
  assert.deepStrictEqual(r.rejected.map(x => [field(x.input.data, 'key'), x.reject]), [['cyril', 'Vypredané. Veľkoobchodník príde o pár dní.'], ['bob', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  // bez konfliktu dostane chudobný hráč svoju správu hneď v prvom kole
  const w2 = makeWorld(8); save(w2, 'bob').coins = 0;
  assert.deepStrictEqual(E.commitBatch(w2, [input('buy', { key: 'bob', id: `seed_${SP}`, n: 1 })], SPEC).rejected.map(x => x.reject), ['Nemáš dosť mincí. 🪙']);
  assert.strictEqual(must(w.market.seeds[SP]).stock, 0);
  assert.strictEqual(save(w, 'ana').coins, 500 - price);
  assert.strictEqual(save(w, 'ana').inv[`seed_${SP}`], 1);
  assert.strictEqual(save(w, 'cyril').inv[`seed_${SP}`], undefined);
  assert.strictEqual(save(w, 'cyril').coins, 500);
});

test('ten istý tovar: nákupy a predaje v jednom kroku – zásoba, mince a batohy sedia, každý kus za cenu platnú pri predaji', () => {
  for (const order of [0, 1, 2]) {
    const w = makeWorld(9);
    must(w.market.seeds[SP]).stock = 3;
    give(save(w, 'bob'), `seed_${SP}`, 5, w.tick);
    const coins0 = save(w, 'ana').coins + save(w, 'bob').coins, seeds0 = 3 + 5;
    const inputs = [input('buy', { key: 'ana', id: `seed_${SP}`, n: 4 }), input('sell', { key: 'bob', id: `seed_${SP}`, n: 3 }), input('buy', { key: 'bob', id: `seed_${SP}`, n: 1 })];
    const r = E.commitBatch(w, shuffle(inputs, order), SPEC);
    assert.strictEqual(r.rejected.length, 0);
    const st = must(w.market.seeds[SP]).stock, inv = (save(w, 'ana').inv[`seed_${SP}`] || 0) + (save(w, 'bob').inv[`seed_${SP}`] || 0);
    assert.strictEqual(st + inv, seeds0, 'semienka sa nestratili ani nezdvojili');
    // každý krok prepočíta ceny podľa vtedajšej zásoby: mince hráčov klesli presne o rozdiel nákupov a predajov podľa správ
    let paid = 0;
    for (const m of r.outbox) { const t = textOf(m), mt = must(/za (\d+) 🪙/.exec(t) ?? undefined); paid += (/Kúpené/.test(t) ? 1 : -1) * +must(mt[1]); }
    assert.strictEqual(coins0 - (save(w, 'ana').coins + save(w, 'bob').coins), paid);
  }
});

test('to isté políčko: dvaja trhajú ten istý kvet – dostane ho práve jeden; trhanie v kroku, keď kvet hynie – práve jeden výsledok', () => {
  for (const order of [0, 1]) {
    const w = makeWorld(10);
    const i = must(tillable(w)[0]);
    plant(w, i, 'ana', true);
    const inputs = [input('pick', { key: 'ana', i }), input('pick', { key: 'bob', i })];
    const r = E.commitBatch(w, order ? inputs.reverse() : inputs, SPEC);
    assert.strictEqual(r.rounds, 2);
    assert.strictEqual(flowers(w, 'ana') + flowers(w, 'bob'), 3, 'kvet dostal práve jeden');
    assert.strictEqual(r.rejected.length, 1);
    assert.strictEqual(must(r.rejected[0]).reject, 'Tu nič nekvitne.');
    assert.strictEqual(at(w, i).s?.p, null);
  }
  for (const order of [0, 1]) {
    const w = makeWorld(11);
    const i = must(tillable(w)[0]);
    plant(w, i, 'ana', true);
    const inputs = [input('pick', { key: 'ana', i }), input('wilt', { i })];
    E.commitBatch(w, order ? inputs.reverse() : inputs, SPEC);
    const p = at(w, i).s?.p;
    const inBag = flowers(w, 'ana') === 3, dead = !!(p && p.d);
    assert.ok(inBag !== dead, `kvet je buď v batohu, alebo zhynul: batoh ${inBag}, zhynul ${dead}`);
  }
});

test('to isté políčko: dvaja kopú alebo polievajú to isté políčko – jeden stav políčka a jedno počítadlo záhonov; rôzne políčka sa nebrzdia', () => {
  const w = makeWorld(12);
  const ti = tillable(w);
  let r = E.commitBatch(w, [input('till', { key: 'ana', i: ti[0] }), input('till', { key: 'bob', i: ti[0] })], SPEC);
  assert.strictEqual(r.applied.length, 1);
  assert.deepStrictEqual(r.rejected.map(x => x.reject), ['Tu už je záhon.']);
  assert.strictEqual(w.plotsUsed, 1);
  r = E.commitBatch(w, [input('till', { key: 'ana', i: ti[5] }), input('till', { key: 'bob', i: ti[6] })], SPEC);
  assert.strictEqual(r.rounds, 2, 'obaja menia počítadlo záhonov – druhý počká na ďalšie kolo');
  assert.strictEqual(w.plotsUsed, 3);
  plant(w, must(ti[1]), 'ana', false); plant(w, must(ti[2]), 'bob', false);
  r = E.commitBatch(w, [input('water', { key: 'ana', i: ti[1] }), input('water', { key: 'bob', i: ti[2] })], SPEC);
  assert.strictEqual(r.rounds, 1, 'rôzne políčka a rôzni hráči: jedno kolo');
  assert.strictEqual(r.applied.length, 2);
  must(at(w, must(ti[1])).s ?? undefined).w = 0;
  r = E.commitBatch(w, [input('water', { key: 'ana', i: ti[1] }), input('water', { key: 'bob', i: ti[1] })], SPEC);
  assert.strictEqual(r.rounds, 2, 'to isté políčko: druhé kolo');
  assert.deepStrictEqual([save(w, 'ana').water, save(w, 'bob').water, at(w, must(ti[1])).s?.w], [3, 3, 1]);
});

test('tá istá zákazka u babky: dvaja ju berú, alebo odovzdanie a termín v jednom kroku – práve jeden výsledok', () => {
  const w = makeWorld(13);
  const c = must(w.contracts.list.find(x => !x.takenBy));
  const r = E.commitBatch(w, [input('ctake', { key: 'ana', id: c.id }), input('ctake', { key: 'bob', id: c.id })], SPEC);
  assert.deepStrictEqual([r.applied.length, r.rejected.map(x => x.reject)], [1, ['Túto zákazku už niekto zobral.']]);
  assert.strictEqual(c.takenBy, 'ana');
  for (const order of [0, 1]) {
    const w2 = makeWorld(14);
    // zákazku si zapamätáme ako hodnoty: zoznam na nástenke sa po dávke zapíše späť po indexoch, objekt prvku nie je stabilná identita
    const c2 = Object.assign({}, must(w2.contracts.list.find(x => !x.takenBy)));
    Econ.takeContract(w2.contracts, w2.tick, save(w2, 'ana'), 'ana', c2.id);
    give(save(w2, 'ana'), `fl_${c2.sp}`, c2.n, w2.tick);
    const coins = save(w2, 'ana').coins, rep = save(w2, 'ana').rep;
    w2.tick = c2.due;
    const due = must(w2.events.find(e => e.key === 'cDue:' + c2.id));
    w2.events = w2.events.filter(e => e !== due);
    const inputs = [input('cdeliver', { key: 'ana', id: c2.id }), { type: 'cDue', data: due.data, ev: due }];
    const res = E.commitBatch(w2, order ? inputs.reverse() : inputs, SPEC);
    const sv = save(w2, 'ana'), delivered = sv.coins === coins + c2.reward && sv.rep === rep + c2.rep && !(sv.inv[`fl_${c2.sp}`]);
    const expired = sv.coins === coins && sv.rep === Math.max(0, rep - 5) && sv.inv[`fl_${c2.sp}`] === c2.n;
    assert.ok(delivered !== expired, `poradie ${order}: odovzdané ${delivered}, prepadnuté ${expired} (${json(sv)})`);
    assert.ok(!w2.contracts.list.some(x => x.id === c2.id), 'zákazka zmizla z nástenky');
    assert.ok(!E.pending(w2, 'cDue:' + c2.id));
    assert.strictEqual(w2.maxRep, Econ.maxRepOf(w2.saves), 'najvyššia reputácia sedí');
    if (order === 0) assert.ok(delivered && res.applied.length === 2, 'odovzdanie prvé v poradí: cDue potom už nič nenájde');
  }
});

test('ten istý batoh: dar hráčovi, ktorý si práve ukladá do skladu; ranný kompostér do batohu, z ktorého sa práve predáva', () => {
  const w = makeWorld(15);
  give(save(w, 'ana'), `fl_${SP}`, 3, w.tick - TPD); give(save(w, 'bob'), `fl_${SP}`, 2, w.tick);
  const total = (): number => flowers(w, 'ana') + flowers(w, 'bob') + (w.storage[`fl_${SP}`] || 0);
  const sum = (c: Container): number => Object.values(c.fb).flat().reduce((s, b) => s + b.n, 0);
  const r = E.commitBatch(w, [input('gift', { from: 'ana', to: 'bob', id: `fl_${SP}`, n: 2 }), input('store', { key: 'bob', id: `fl_${SP}`, n: 2 })], SPEC);
  assert.strictEqual(r.rounds, 2);
  assert.strictEqual(total(), 5);
  assert.deepStrictEqual([flowers(w, 'ana'), flowers(w, 'bob'), w.storage[`fl_${SP}`]], [1, 2, 2]);
  for (const c of [I.playerC(save(w, 'ana')), I.playerC(save(w, 'bob')), I.storageC({ inv: w.storage, fb: w.storageFb }, w.icehouse)]) assert.strictEqual(sum(c), c.inv[`fl_${SP}`] || 0, 'várky sedia s počtom');
  // ráno (píše všetkým hráčom) + predaj kompostu v tom istom kroku
  give(save(w, 'ana'), 'compost', 2, w.tick);
  const r2 = E.commitBatch(w, [input('sell', { key: 'ana', id: 'compost', n: 2 }), { type: 'dawn', data: null, ev: evOf({ type: 'dawn', seq: 999 }) }], SPEC);
  assert.strictEqual(r2.applied.length, 2);
  assert.strictEqual(r2.rounds, 2);
  assert.strictEqual(save(w, 'ana').inv.compost, must(D.UPGRADES.composter.levels[1]).v, 'predané 2, kompostér pridal svoje');
});

test('udalosti sveta: ráno a hodinová o 6:00 bežia obe v tom istom kroku (aj pri dobiehaní), každá práve raz, v kolách', () => {
  const w = makeWorld(16, 0), log: string[] = [];
  const spec: Spec = {
    proposers: {
      dawn: prop({ keys: () => ({ writes: ['weather'] }), run(s, d, ctx) { log.push('dawn@' + ctx.tick); s.weather = 'rain'; } }),
      hourly: prop({ keys: () => ({ reads: ['weather'] }), run(s, d, ctx) { log.push('hourly@' + ctx.tick + ':' + s.weather); } })
    },
    periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) }, { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) }], onError: rethrow
  };
  E.advanceTo(w, 2 * TPD, spec);
  assert.ok(log.includes('dawn@' + D.DAWN_TICK) && log.includes('hourly@' + D.DAWN_TICK + ':rain'), log.join(' '));
  assert.strictEqual(log.filter(x => x.startsWith('dawn')).length, 2);
  assert.strictEqual(log.filter(x => x.startsWith('hourly')).length, 48);
  assert.ok((w.step ?? 0) >= 50, 'každé kolo zvýši počítadlo: ' + String(w.step));
});

test('koniec hľadania v tráve: podľa prítomnosti hráča, semienko do uloženia, políčko je do konca hodiny prázdne', () => {
  const w = makeWorld(17);
  const i = w.tiles.findIndex(t => t.g === 'grass' && !t.s);
  // n = značka hľadania (na serveri id vstupu – reťazec)
  let presence: Presence[] = [partial<Presence>({ key: 'ana', area: 'garden', x: i % D.W + 0.5, y: Math.floor(i / D.W) + 0.5, scav: partial<NonNullable<Presence['scav']>>({ i, n: '1' }) })];
  const spec: Spec = { ...SPEC, presence: () => presence };
  E.scheduleUnique(w, 'scavDone:ana', w.tick + D.SCAVENGE.ticks, 'scavDone', { key: 'ana', n: '1', i, seeds: false });
  E.advanceTo(w, w.tick + D.SCAVENGE.ticks, spec);
  const window = Math.floor(w.tick / D.SCAVENGE.window);
  assert.strictEqual(w.scav[i], window, 'prehľadané políčko');
  const found = Object.keys(save(w, 'ana').inv).some(id => id.startsWith('wild_'));
  // iné číslo hľadania (hráč medzitým začal hľadať inde): udalosť nič neurobí
  const w2 = makeWorld(17);
  presence = [partial<Presence>({ key: 'ana', area: 'garden', x: 0, y: 0, scav: partial<NonNullable<Presence['scav']>>({ i, n: '2' }) })];
  E.scheduleUnique(w2, 'scavDone:ana', w2.tick + D.SCAVENGE.ticks, 'scavDone', { key: 'ana', n: '1', i, seeds: false });
  const entries: Out[] = [];
  E.advanceTo(w2, w2.tick + D.SCAVENGE.ticks, { ...spec, onBatch: (x, out) => { entries.push(out); } });
  assert.deepStrictEqual(w2.scav, {});
  assert.ok(entries.every(o => o.outbox.length === 0));
  assert.strictEqual(typeof found, 'boolean');
});

test('kľúč hráča smie obsahovať dvojbodku: výrez save:<kľúč> aj adresa správy ho nesú celý; hviezdička je len kolekcia', () => {
  const w = makeWorld(25);
  w.saves['mia:)'] = parseJson<PlayerSave>(json(save(w, 'ana')));
  const spec: Spec = { proposers: { pay: prop<{ key: string }>({ keys: ({ key }) => ({ writes: ['save:' + key] }), run(s, { key }, ctx) { sv(s, key).coins -= 7; ctx.emit({ to: key, t: 'toast', text: 'ok' }); } }) }, onError: rethrow };
  const r = E.commitBatch(w, [input('pay', { key: 'mia:)' })], spec);
  assert.deepStrictEqual([save(w, 'mia:)').coins, save(w, 'ana').coins], [493, 500]);
  assert.deepStrictEqual(r.outbox, [{ to: 'mia:)', t: 'toast', text: 'ok' }]);
  assert.deepStrictEqual([E.ALL, E.area('hory')], [{ all: true }, { area: 'hory' }]);
  assert.ok(E.meets('save:*', 'save:mia:)') && !E.meets('save:mia:)', 'save:mia'));
});

test('deklarácie: prekrývajúce sa kľúče, zápis do nedeklarovaného výrezu a kolekcia pod menom vlastnosti sú chyby návrhu', () => {
  const w = makeWorld(26);
  const spec: Spec = {
    proposers: {
      overlap: prop({ keys: () => ({ writes: ['save:ana'], reads: ['save:*'] }), run() {} }),
      undeclared: prop({ keys: () => ({ writes: ['weather'] }), run(s) { s.weather = 'rain'; s.eternal = true; } }),
      // kolekcia pod menom vlastnosti nie je výrez – v slices nie je a siahnutie zlyhá TypeError
      alias: prop({ keys: () => ({ writes: ['saves'] }), run(s) { (s['saves'] as { ana: PlayerSave }).ana.coins = 0; } })
    }, onError: rethrow
  };
  const before = json(w);
  assert.match(errText(E.evaluate(w, input('overlap', null), spec).error), /prekrývajúce/);
  assert.match(errText(E.evaluate(w, input('undeclared', null), spec).error), /nedeklarovaného výrezu eternal/);
  assert.match(errText(E.evaluate(w, input('alias', null), spec).error), /TypeError/);
  assert.strictEqual(json(w), before);
});

test('ráno: ľadovec zo zrážok dorastie najviac raz za deň – dážď z elixíru pred ránom sa ráta', () => {
  // nájdeme semienko, pri ktorom ráno prší
  for (let seed = 100; seed < 200; seed++) {
    const mk = (fed: number): W => { const w = makeWorld(seed, 0); for (const t of w.hory) if (t.ice != null) t.ice = 0; w.glacierFed = fed; return w; };
    const a = mk(-1);
    E.advanceTo(a, D.DAWN_TICK, SPEC);
    if (a.weather !== 'rain') continue;
    assert.strictEqual(Ice.glacierTotal(a.hory), D.GLACIER_GROW.rain, 'nekŕmený ľadovec ráno dorastie');
    assert.strictEqual(a.glacierFed, D.dayOfTick(D.DAWN_TICK));
    const b = mk(D.dayOfTick(D.DAWN_TICK)); // dnes už kŕmený (dážď zo studne o 5:00)
    E.advanceTo(b, D.DAWN_TICK, SPEC);
    assert.strictEqual(b.weather, 'rain');
    assert.strictEqual(Ice.glacierTotal(b.hory), 0, 'druhýkrát v ten istý deň nedorastie');
    return;
  }
  assert.fail('ani jedno semienko nedalo daždivé ráno');
});

// ---- Atomickosť ----

test('návrh, ktorý zapíše mince a potom zlyhá, nezanechá nič', () => {
  const w = makeWorld(18);
  const before = json(w);
  const errors: string[] = [];
  const spec: Spec = {
    proposers: {
      pay: prop({ keys: () => ({ writes: ['save:ana', 'tile:garden:0'] }), run(s, d, ctx) { sv(s, 'ana').coins -= 100; Object.assign(tl(s, 0), { s: { k: 'soil' } }); ctx.scheduleUnique('x', ctx.tick + 1, 'pay'); throw new Error('bum'); } }),
      pay2: prop({ keys: () => ({ writes: ['save:bob', 'market:*'] }), run(s) { sv(s, 'bob').coins -= 100; sl(s, 'market:*').compost.stock = 0; throw new Error('bum2'); } })
    },
    onError(err) { errors.push(err instanceof Error ? err.message : ''); }
  };
  const r = E.commitBatch(w, [input('pay', null), input('pay2', null)], spec);
  assert.deepStrictEqual(errors, ['bum', 'bum2']);
  const after = parseJson<W>(json(w));
  assert.strictEqual(after.step, 1, 'kolo prebehlo');
  after.step = 0;
  assert.strictEqual(json(after), before, 'svet je nezmenený');
  assert.deepStrictEqual([r.applied.length, r.rejected.length], [0, 0]);
});

test('odmietnutý návrh nič nevykoná, ale má deklarované kľúče (aj on sa dá vyhodnotiť paralelne)', () => {
  const w = makeWorld(19);
  const i = must(tillable(w)[0]);
  const before = json(w);
  const r = E.evaluate(w, input('pick', { key: 'ana', i }), SPEC);
  assert.strictEqual(r.reject, 'Tu nič nekvitne.');
  assert.ok(r.writes.has(`tile:garden:${i}`) && r.writes.has('save:ana'));
  assert.strictEqual(json(w), before);
});

// ---- Odvodené počítadlá ----

test('odvodené počítadlá (plotsUsed, maxRep) sa rovnajú prepočtu po každej dávke – aj keď reputácia klesne', () => {
  const w = makeWorld(20, 0);
  save(w, 'ana').rep = must(D.REP_LEVELS[2]); w.maxRep = Econ.maxRepOf(w.saves);
  const ti = tillable(w);
  let batches = 0;
  const check = (x: W): void => { batches++; assert.strictEqual(x.plotsUsed, Econ.plotsUsedOf(x.tiles), 'záhony v kroku ' + x.tick); assert.strictEqual(x.maxRep, Econ.maxRepOf(x.saves), 'reputácia v kroku ' + x.tick); };
  const spec: Spec = { ...SPEC, onBatch: check };
  const c = must(w.contracts.list.find(x => !x.takenBy)); // ana zoberie zákazku a nechá ju prepadnúť: −5 reputácie, maxRep klesne
  E.commitBatch(w, [input('ctake', { key: 'ana', id: c.id }), input('till', { key: 'ana', i: ti[0] }), input('till', { key: 'bob', i: ti[1] }), input('till', { key: 'bob', i: ti[2] })], spec);
  E.commitBatch(w, [input('level', { i: ti[1] }), input('till', { key: 'ana', i: ti[3] })], spec);
  assert.strictEqual(w.plotsUsed, 3);
  E.advanceTo(w, c.due + 1, spec);
  assert.strictEqual(save(w, 'ana').rep, must(D.REP_LEVELS[2]) - 5);
  assert.strictEqual(w.maxRep, must(D.REP_LEVELS[2]) - 5, 'najvyššia reputácia klesla s jedinou hráčkou na vrchole');
  // odovzdanie zvýši reputáciu aj maxRep
  const c2 = Object.assign({}, must(w.contracts.list.find(x => !x.takenBy && x.kind === 'short') || w.contracts.list.find(x => !x.takenBy)));
  give(save(w, 'bob'), `fl_${c2.sp}`, c2.n, w.tick);
  save(w, 'bob').rep = must(D.REP_LEVELS[3]); w.maxRep = Econ.maxRepOf(w.saves);
  E.commitBatch(w, [input('ctake', { key: 'bob', id: c2.id })], spec);
  E.commitBatch(w, [input('cdeliver', { key: 'bob', id: c2.id })], spec);
  assert.strictEqual(w.maxRep, must(D.REP_LEVELS[3]) + c2.rep);
  assert.ok(batches > 20);
});

// ---- Denník a prehranie ----

test('denník: každá dávka je záznam so vstupmi, kľúčmi a osudom každého návrhu v každom kole, zmenami podľa kľúča a správami', () => {
  const w = makeWorld(21);
  const i = must(tillable(w)[0]);
  plant(w, i, 'ana', true);
  const entries: E.JournalEntry<Presence, unknown>[] = [];
  E.commitBatch(w, [input('pick', { key: 'ana', i }), input('pick', { key: 'bob', i }), input('roll', { id: 'x' })], withJournal(SPEC, entries));
  assert.strictEqual(entries.length, 1);
  const e = must(entries[0]);
  assert.deepStrictEqual([e.tick, e.step, e.inputs.map(x => x.type)], [w.tick, 0, ['pick', 'pick', 'roll']]);
  const by = (id: string | number | undefined, round: number): E.ProposalRecord => must(e.proposals.find(p => p.id === id && p.round === round));
  const changes = (id: string | number | undefined, key: string): E.Change[] => must(must(by(id, 1).changes)[key]);
  const ana = input('pick', { key: 'ana', i }).id, bob = input('pick', { key: 'bob', i }).id;
  assert.strictEqual(by(ana, 1).outcome, 'applied');
  assert.deepStrictEqual(by(ana, 1).writes.sort(), ['save:ana', `tile:garden:${i}`]);
  assert.ok(changes(ana, 'save:ana').some(ch => ch.p.join('.') === `inv.fl_${SP}` && ch.to === 3), json(changes(ana, 'save:ana')));
  assert.ok(changes(ana, `tile:garden:${i}`).some(ch => ch.p.join('.') === 's.p' && ch.to === null));
  assert.strictEqual(by(bob, 1).outcome, 'held');
  assert.deepStrictEqual([by(bob, 2).outcome, by(bob, 2).msg], ['rejected', 'Tu nič nekvitne.']);
  assert.strictEqual(by(input('roll', { id: 'x' }).id, 1).outcome, 'applied');
  assert.ok(e.outbox.some(m => field(m, 'to') === 'ana' && /×/.test(textOf(m))));
  assert.ok(json(e).length < 5000, 'záznam je malý: len zmenené listy, nie celé kolekcie');
});

test('uložený svet + denník (alebo zaznamenané dávky akcií) dajú ten istý svet a ten istý denník ako nepretržitý beh', () => {
  type Step = { at: number; inputs: E.Input[] };
  const script = (w: W, ti: number[]): Step[] => [
    { at: D.DAWN_TICK + 10, inputs: [input('till', { key: 'ana', i: ti[0] }), input('buy', { key: 'ana', id: `seed_${SP}`, n: 2 })] },
    { at: D.DAWN_TICK + 40, inputs: [input('till', { key: 'bob', i: ti[1] }), input('water', { key: 'ana', i: ti[0] })] },
    { at: TPD + D.DAWN_TICK + 5, inputs: [input('roll', { id: 'x' }), input('buy', { key: 'bob', id: 'compost', n: 1 })] },
    { at: 3 * TPD, inputs: [input('sell', { key: 'ana', id: `seed_${SP}`, n: 1 }), input('roll', { id: 'y' })] }
  ];
  type Journal = E.JournalEntry<Presence, unknown>[];
  const run = (w: W, steps: Step[], spec: Spec): W => { for (const s of steps) { E.advanceTo(w, s.at, spec); E.commitBatch(w, s.inputs, spec); } E.advanceTo(w, 4 * TPD, spec); return w; };
  const a = makeWorld(22, 0), steps = script(a, tillable(a)), ja: Journal = [];
  run(a, steps, withJournal(SPEC, ja));
  // 1. uloženie a načítanie po druhej dávke, zvyšok akcií znova
  const b = makeWorld(22, 0), jb: Journal = [];
  for (const s of steps.slice(0, 2)) { E.advanceTo(b, s.at, withJournal(SPEC, jb)); E.commitBatch(b, s.inputs, withJournal(SPEC, jb)); }
  const restored = parseJson<W>(json(b));
  run(restored, steps.slice(2), withJournal(SPEC, jb));
  assert.strictEqual(json(restored), json(a));
  assert.strictEqual(json(jb), json(ja), 'denník je rovnaký');
  assert.ok((a['roll:x'] ?? -1) >= 0 && (a['roll:y'] ?? -1) >= 0 && at(a, Number(field(must(must(steps[0]).inputs[0]).data, 'i'))).s);
  // 2. prehranie samotného denníka od začiatku: udalosti vzniknú z fronty, akcie zo záznamov
  const c = makeWorld(22, 0), jc: Journal = [];
  const n = E.replay(c, parseJson<Journal>(json(ja)), withJournal(SPEC, jc));
  E.advanceTo(c, 4 * TPD, withJournal(SPEC, jc));
  assert.strictEqual(n, ja.length);
  assert.strictEqual(json(c), json(a));
  assert.strictEqual(json(jc), json(ja));
});

type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number, env?: Partial<Record<string, string>>): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir }, env || {}), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }

test('server: denník sa píše do data/journal-<svet>.jsonl – značka načítania, záznam po každej dávke, veľký sa otočí', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-journal-'));
  const port = 43000 + Math.floor(Math.random() * 2000);
  // bežiaci svet, ktorý bol 2 dni vypnutý: pri načítaní dobehne ~60 dávok
  const w = makeWorld(23, D.DAWN_TICK + 6);
  // uloženie starého formátu (v9) – migrácia na serveri ho doplní
  const save = Object.assign(parseJson<JsonRecord>(json(w)), { tick: w.tick, v: 9, mode: 'running', wall: Date.now() - 2 * TPD * (1200 * 1000 / TPD), seed: E.newSeed(), scavSalt: 7, pomedzieSeed: 1, lesSeed: 1, les: null, hory: null, tiles: w.tiles.map(t => ({ s: t.s })) });
  fs.writeFileSync(path.join(dir, 'room-dennik.json'), JSON.stringify(save));
  const proc = await startServer(dir, port, { JOURNAL_MAX_MB: '0.02' });
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', room: 'dennik', name: 'Eva' }));
    await new Promise<void>(r => ws.on('message', raw => { if (parseMsg(raw).t === 'welcome') r(); }));
    ws.close();
    await new Promise(r => setTimeout(r, 300));
  } finally { await stopServer(proc); }
  const file = path.join(dir, 'journal-dennik.jsonl');
  assert.ok(fs.existsSync(file + '.1'), 'denník sa po prekročení veľkosti otočil');
  type Line = E.JournalEntry<Presence, unknown> & { load?: boolean; wall: number };
  const read = (f: string): Line[] => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => parseJson<Line>(l));
  const all = [...read(file + '.1'), ...read(file)]; // starší otočený súbor, potom aktuálny
  const first = must(all[0]);
  assert.ok(first.load === true && first.tick === save.tick && first.step === 0, 'prvý riadok je značka načítania: ' + json(first));
  const lines = all.filter(e => !e.load);
  assert.ok(lines.length > 40, 'záznamov: ' + lines.length);
  for (const e of lines) {
    assert.ok(Number.isInteger(e.tick) && Number.isInteger(e.step) && Number.isInteger(e.wall));
    assert.ok(e.inputs.length && e.proposals.length && Array.isArray(e.outbox));
    for (const p of e.proposals) assert.ok(['applied', 'held', 'rejected', 'error'].includes(p.outcome) && Array.isArray(p.writes), json(p));
  }
  assert.ok(lines.some(e => e.inputs.some(i => i.type === 'dawn')), 'ráno je v denníku');
  assert.ok(fs.statSync(file).size < 0.02 * 1024 * 1024 * 1.5, 'aktuálny súbor je malý');
  // dva po sebe idúce záznamy sú po krokoch a kolách súvislé
  for (let k = 1; k < lines.length; k++) { const cur = must(lines[k]), prev = must(lines[k - 1]); assert.ok(cur.tick >= prev.tick && cur.step > prev.step, String(k)); }
});

// ---- Hygiena ----

test('v hre už nie je zapisovač cez Proxy, návrh (draft) ani náhoda zo sveta; v jadre simulácie nie je Math.random ani Date.now', () => {
  const root = path.join(import.meta.dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'src', 'server')).filter(f => f.endsWith('.js') || f.endsWith('.ts')).map(f => 'src/server/' + f), ...fs.readdirSync(path.join(root, 'test')).map(f => 'test/' + f), ...fs.readdirSync(path.join(root, 'debug', 'api')).map(f => 'debug/api/' + f)];
  assert.ok(!fs.existsSync(path.join(root, 'src', 'server', 'draft.js')) && !fs.existsSync(path.join(root, 'src', 'server', 'draft.ts')));
  for (const f of files) {
    if (f === 'test/proposals.test.ts') continue; // tento súbor obsahuje samotný vzor
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/new Proxy|createDraft|applyPatches|rand\(room|rand\(w\)|randInt\(|E\.pick\(|\.handlers\b/.test(src), f);
  }
  for (const f of ['engine.ts', 'events.ts', 'actions.ts', 'economy.ts', 'items.ts', 'ice.ts', 'scavenge.ts', 'spiders.ts']) {
    assert.ok(!/Math\.random|Date\.now/.test(fs.readFileSync(path.join(root, 'src', 'server', f), 'utf8')), f);
  }
});

test('dobiehanie: 30 dní s plnou záhradou (rýchlosť sa vypíše; stráž proti regresii: pod 150 µs na udalosť, zapisovač fázy 1 mal ≈200)', () => {
  const w = makeWorld(24, D.DAWN_TICK + 6);
  w.up.plots = 4;
  const sp = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict);
  tillable(w).slice(0, 96).forEach((i, n) => { at(w, i).s = { k: must(D.TILLABLE[at(w, i).g]), w: 1, r: 0, o: 'ana', p: { sp: must(sp[n % sp.length]), prog: 0, q: 3, dry: 0 } }; });
  w.plotsUsed = Econ.plotsUsedOf(w.tiles);
  give(save(w, 'ana'), `fl_${SP}`, 3, w.tick); give(save(w, 'bob'), `fl_${SP}`, 3, w.tick);
  const spec: Spec = { ...SPEC, onBatch() {} }; // ako na serveri: so zmenami pre denník
  E.advanceTo(w, w.tick + 2 * TPD, spec);
  const t0 = process.hrtime.bigint();
  const n = E.advanceTo(w, w.tick + 30 * TPD, spec);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  dobiehanie 30 dní: ${n} udalostí za ${ms.toFixed(1)} ms (${(ms / n * 1000).toFixed(1)} µs/udalosť)`);
  assert.ok(n > 900 && ms / n * 1000 < 150, `${(ms / n * 1000).toFixed(1)} µs/udalosť`);
});
