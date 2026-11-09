import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/shared/data.ts';
import { AGING_TICKS, instantQuote } from '../src/shared/market.ts';
import type { ItemId } from '../src/shared/data.ts';
import type { MarketOrder, PlayerSave } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Book from '../src/server/orderbook.ts';
import * as Econ from '../src/server/economy.ts';
import * as Actions from '../src/server/actions.ts';
import { sl } from '../src/server/game.ts';
import type { GameSpec, GameWorld, Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { must, partial, rethrow, testWorld } from './helpers.ts';

const spec: GameSpec = { proposers: { ...Econ.PROPOSERS, ...Actions.PROPOSERS }, onError: rethrow };
function world(): GameWorld {
  const w = testWorld<Partial<GameWorld>>({ tick: 100, wall: 0, daySeconds: 1200, seed: 'book-112', events: [], saves: {}, market: null, contracts: null, step: 0, maxRep: 0 });
  Econ.initEconomy(w);
  const m = must(w.market ?? undefined), b = must(m.book);
  b.orders = {}; b.accounts.wholesale = { coins: 0, inv: {}, fb: {} }; w.events = []; // trh bez NPC likvidity na presné testy párovania
  for (const key of ['ana', 'bob', 'eva']) w.saves[key] = partial<PlayerSave>({ name: key, coins: 10000, inv: {}, fb: {}, rep: 300, marketOrders: [] });
  return w;
}
let sequence = 0;
function place(w: GameWorld, key: string, side: 'buy' | 'sell', price: number, n = 1, id: ItemId = 'seed_mak'): E.BatchOut<Presence, Msg> {
  return E.commitBatch(w, [{ type: 'marketOrder', data: { key, side, price, n, id }, id: `test:${++sequence}`, actor: key }], spec);
}
const orders = (w: GameWorld): MarketOrder[] => Object.values(must(w.market?.book).orders).filter((o): o is MarketOrder => !!o);
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);

test('maker cena v oboch poradiach: 100 dopyt / 90 ponuka, refundácia zlepšenia', () => {
  for (const bidFirst of [true, false]) {
    const w = world(); save(w, 'bob').inv.seed_mak = 2;
    if (bidFirst) { place(w, 'ana', 'buy', 100, 2); place(w, 'bob', 'sell', 90, 2); }
    else { place(w, 'bob', 'sell', 90, 2); place(w, 'ana', 'buy', 100, 2); }
    const cost = bidFirst ? 200 : 180;
    assert.equal(save(w, 'ana').coins, 10000 - cost); assert.equal(save(w, 'bob').coins, 10000 + cost);
    assert.equal(save(w, 'ana').inv.seed_mak, 2); assert.equal(orders(w).length, 0);
  }
});

test('čiastočné plnenie, zostatok rezervy a zrušenie bez dvojitého vyplatenia', () => {
  const w = world(); save(w, 'bob').inv.seed_mak = 2;
  place(w, 'bob', 'sell', 9, 2); place(w, 'ana', 'buy', 10, 5);
  const o = must(orders(w)[0]); assert.equal(o.remaining, 3); assert.equal(o.coins, 30); assert.equal(o.filled, 2);
  assert.equal(save(w, 'ana').coins, 10000 - 18 - 30);
  const cancel = { type: 'marketCancel', data: { key: 'ana', id: o.id }, id: 'cancel', actor: 'ana' };
  E.commitBatch(w, [cancel, cancel], spec);
  assert.equal(save(w, 'ana').coins, 9982); assert.equal(orders(w).length, 0);
});

test('nezávislé vklady v jednom kole a súbežné výdavky toho istého účtu', () => {
  const w = world(); save(w, 'ana').coins = 10;
  const out = E.commitBatch(w, [
    { type: 'marketOrder', id: 'a', data: { key: 'ana', id: 'seed_mak', side: 'buy', n: 1, price: 8 } },
    { type: 'marketOrder', id: 'b', data: { key: 'bob', id: 'seed_ruza', side: 'buy', n: 1, price: 8 } },
    { type: 'marketOrder', id: 'c', data: { key: 'ana', id: 'seed_mak', side: 'buy', n: 1, price: 8 } }
  ], spec);
  assert.equal(out.rounds, 2); assert.equal(out.rejected.length, 1); assert.equal(save(w, 'ana').coins, 2);
  assert.equal(out.entry.proposals.filter(p => p.round === 1 && p.outcome === 'applied').length, 2);
});

test('dvaja kupujúci posledného kusu: jeden dostane tovar, mince a predmety sa zachovajú', () => {
  const w = world(); save(w, 'bob').inv.seed_mak = 1; place(w, 'bob', 'sell', 9);
  E.commitBatch(w, ['ana', 'eva'].map(key => ({ type: 'buy', id: key, actor: key, data: { key, id: 'seed_mak', n: 1 } })), spec);
  assert.equal((save(w, 'ana').inv.seed_mak || 0) + (save(w, 'eva').inv.seed_mak || 0), 1);
  assert.equal(['ana', 'eva', 'bob'].reduce((n, key) => n + save(w, key).coins, 0), 30000);
});

test('aging vyberie staršiu kompatibilnú ponuku, nikdy neprekročí limit', () => {
  const w = world(); save(w, 'bob').inv.seed_mak = 1; save(w, 'eva').inv.seed_mak = 1;
  place(w, 'bob', 'sell', 10); w.tick += AGING_TICKS * 3; place(w, 'eva', 'sell', 9);
  place(w, 'ana', 'buy', 9); assert.equal(save(w, 'eva').coins, 10009); assert.equal(orders(w)[0]?.price, 10);
  save(w, 'eva').inv.seed_mak = 1; place(w, 'eva', 'sell', 9); place(w, 'ana', 'buy', 10);
  assert.equal(save(w, 'bob').coins, 10010); assert.equal(orders(w)[0]?.price, 9);
});

test('rovnaký krok zachová FIFO a deterministický denník sa prehrá', () => {
  const a = world(), b = E.clone(a), log: E.JournalEntry<Presence, Msg>[] = [], replay: E.JournalEntry<Presence, Msg>[] = [];
  save(a, 'bob').inv.seed_mak = 2; save(b, 'bob').inv.seed_mak = 2;
  const recording: GameSpec = { ...spec, onBatch(w, out) { log.push(out.entry); } };
  for (const [id, key, side, n] of [['first', 'ana', 'buy', 1], ['second', 'eva', 'buy', 1], ['third', 'bob', 'sell', 2]] as const) E.commitBatch(a, [{ type: 'marketOrder', id, actor: key, data: { key, id: 'seed_mak', n, side, price: 9 } }], recording);
  E.replay(b, E.clone(log), { ...spec, onBatch(w, out) { replay.push(out.entry); } });
  assert.deepEqual(a, b); assert.deepEqual(log, replay);
});

test('expirácia vracia mince a plný batoh ponechá ľad na vyzdvihnutie bez ďalšieho párovania', () => {
  const w = world(); place(w, 'ana', 'buy', 5, 2);
  save(w, 'bob').inv.ice = 2; place(w, 'bob', 'sell', 7, 2, 'ice'); save(w, 'bob').inv.ice = D.ICE_CARRY;
  const o = must(orders(w).find(o => o.side === 'sell'));
  E.commitBatch(w, [{ type: 'marketExpire', id: 'expire', data: { id: o.id } }], spec);
  assert.equal(must(must(w.market?.book).orders[o.id]).active, false); assert.equal(save(w, 'bob').marketClaims?.length, 1);
  delete save(w, 'bob').inv.ice;
  E.commitBatch(w, [{ type: 'marketCancel', id: 'claim', data: { key: 'bob', id: o.id } }], spec);
  assert.equal(save(w, 'bob').inv.ice, 2);
  w.tick += 3 * D.TICKS_PER_DAY;
  E.commitBatch(w, [], spec); assert.equal(save(w, 'ana').coins, 10000);
});

test('limity reputácie, cudzie zrušenie, expirácia a starnutie rezervovaných kvetov', () => {
  const w = world(); save(w, 'ana').rep = 0;
  place(w, 'ana', 'buy', 1); place(w, 'ana', 'buy', 1);
  assert.equal(place(w, 'ana', 'buy', 1).rejected.length, 1);
  assert.equal(place(w, 'ana', 'buy', 1, 1, 'seed_plesnivec').rejected.length, 1);
  const o = must(orders(w)[0]);
  assert.equal(E.commitBatch(w, [{ type: 'marketCancel', id: 'thief', data: { key: 'bob', id: o.id } }], spec).rejected.length, 1);
  save(w, 'bob').inv.fl_mak = 2; place(w, 'bob', 'sell', 20, 2, 'fl_mak');
  w.tick += D.TICKS_PER_DAY;
  const offer = must(orders(w).find(o => o.item === 'fl_mak')); assert.ok(Book.fresh(offer, w.tick) < 1);
  place(w, 'eva', 'buy', 20, 1, 'fl_mak');
  const batch = must(save(w, 'eva').fb?.fl_mak?.[0]); assert.equal(D.batchAge(batch, w.tick, 1), D.TICKS_PER_DAY);
});

test('okamžitá cena kráča celou knihou, rezervuje presný súčet aj keď maximálny limit je drahší', () => {
  const w = world(); save(w, 'bob').inv.seed_mak = 1; save(w, 'eva').inv.seed_mak = 1;
  place(w, 'bob', 'sell', 5); place(w, 'eva', 'sell', 10);
  save(w, 'ana').coins = 15;
  const q = instantQuote(Book.levels(must(w.market ?? undefined), w.tick), 'buy', 'seed_mak', 2, w.tick, 'player:ana'); assert.equal(q.total, 15);
  E.commitBatch(w, [{ type: 'buy', id: 'instant', data: { key: 'ana', id: 'seed_mak', n: 2 } }], spec);
  assert.equal(save(w, 'ana').coins, 0); assert.equal(save(w, 'ana').inv.seed_mak, 2); assert.equal(orders(w).length, 0);
});

test('Jano kúpi cez knihu aj medzi návštevami; iba naplnené semienka vedú k úrode', () => {
  const w = world();
  E.commitBatch(w, [{ type: 'npc_jano', id: 'visit', data: null }], spec);
  const bid = must(orders(w).find(o => o.owner.kind === 'npc' && o.owner.key === 'jano' && o.side === 'buy'));
  assert.equal(w.events.filter(e => e.type === 'jano_sell').length, 0);
  w.tick += 10; save(w, 'ana').inv[bid.item] = 1;
  place(w, 'ana', 'sell', bid.price, 1, bid.item);
  const harvest = w.events.filter(e => e.type === 'jano_sell'); assert.equal(harvest.length, 1);
  assert.deepEqual(harvest[0]?.data, { sp: D.speciesOfItem(bid.item), n: 2 });
  assert.equal(must(w.market?.book).accounts.jano.inv[bid.item] || 0, 0);
  assert.equal(must(w.market?.book).orders[bid.id]?.filled, 1);
  E.advanceTo(w, must(harvest[0]).at, spec);
  assert.ok(orders(w).some(o => o.owner.kind === 'npc' && o.owner.key === 'jano' && o.side === 'sell' && o.quantity === 2));
});

test('NPC ↔ NPC a NPC ↔ hráč majú rovnaké plnenie a krytie, Zuzka nemôže minúť viac než rozpočet', () => {
  const w = world(), b = must(w.market?.book); b.accounts.jano.inv.fl_mak = 3; b.accounts.zuzka.coins = 18;
  const setup: GameSpec = { ...spec, proposers: { ...spec.proposers, setup: { settle: Book.settle, keys: () => ({ writes: ['market:*'] }), run(s, d, ctx) { const m = sl(s, 'market:*'); Book.npcOrder(m, 'jano', 'fl_mak', 'sell', 9, 3, ctx); Book.npcOrder(m, 'zuzka', 'fl_mak', 'buy', 9, 9, ctx, 1); } } } }; // market:* zaručuje typ celého trhu
  E.commitBatch(w, [{ type: 'setup', id: 'setup', data: null }], setup);
  assert.equal(b.accounts.zuzka.coins, 0); assert.equal(b.accounts.jano.coins, 318); assert.equal(b.accounts.zuzka.inv.fl_mak || 0, 0);
  assert.equal(orders(w).find(o => o.owner.key === 'jano')?.remaining, 1);
  place(w, 'ana', 'buy', 9, 1, 'fl_mak'); assert.equal(save(w, 'ana').inv.fl_mak, 1);
  assert.equal(b.accounts.jano.coins, 327);
});

test('veľkoobchod: vykonateľné stupne cien, zmena zásoby po obchode a stabilné kotácie bez slučiek', () => {
  const w = world(), b = must(w.market?.book); b.accounts.wholesale.inv.seed_mak = 5; b.accounts.wholesale.coins = 100;
  E.commitBatch(w, [], spec);
  const quote = instantQuote(Book.levels(must(w.market ?? undefined), w.tick), 'buy', 'seed_mak', 3, w.tick);
  E.commitBatch(w, [{ type: 'buy', id: 'buy', data: { key: 'ana', id: 'seed_mak', n: 3 } }], spec);
  assert.equal(save(w, 'ana').coins, 10000 - quote.total); assert.equal(Book.owned(must(w.market ?? undefined), 'seed_mak'), 2);
  assert.equal(must(w.market?.seeds.mak).stock, 2);
  const step = w.step, stable = E.clone(b.orders); E.commitBatch(w, [], spec); assert.equal(w.step, step); assert.deepEqual(b.orders, stable);
  const total = b.accounts.wholesale.coins + Book.reserved(must(w.market ?? undefined), 'wholesale');
  assert.equal(total, 100 + quote.total);
});

test('likvidita hráčov nemení zásoby veľkoobchodníka a offline súhrn sa odošle len raz', () => {
  const w = world(); save(w, 'bob').inv.seed_mak = 2; place(w, 'bob', 'sell', 9, 2); place(w, 'ana', 'buy', 9, 2);
  assert.equal(Book.owned(must(w.market ?? undefined), 'seed_mak'), 0); assert.equal(save(w, 'bob').marketOffline?.sold, 2);
  // Pripojenie je ten istý návrh ako na serveri; pre tento test nepotrebujeme ostatné vetvy sveta.
  w.redeem = {}; w.tiles = []; w.maxRep = 300;
  const input = { type: 'join', id: 'join', actor: 'bob', data: { key: 'bob', name: 'Bob', look: null, quick: false, start: { coins: 0, rep: 0 } } };
  const out = E.commitBatch(w, [input], spec); assert.equal(out.outbox.filter(m => m.t === 'toast' && m.text.startsWith('Kým si bol(a) preč:')).length, 1);
  const again = E.commitBatch(w, [{ ...input, id: 'join-again' }], spec); assert.equal(again.outbox.filter(m => m.t === 'toast' && m.text.startsWith('Kým si bol(a) preč:')).length, 0);
});

test('číslo vkladu je stabilné v konfliktných kolách, kolízia nikdy neprepíše rezerváciu', () => {
  const w = world(); const out = E.commitBatch(w, [
    { type: 'marketOrder', id: 'same-id', data: { key: 'ana', id: 'seed_mak', side: 'buy', price: 3, n: 2 } },
    { type: 'marketOrder', id: 'same-id', data: { key: 'bob', id: 'seed_mak', side: 'buy', price: 9, n: 2 } }
  ], spec);
  assert.equal(out.rejected.length, 1); assert.match(out.rejected[0]?.reject || '', /už existuje/);
  assert.equal(orders(w).length, 1); assert.equal(orders(w)[0]?.coins, 6); assert.equal(save(w, 'bob').coins, 10000);
});

test('plnenia rôznych položiek s rôznymi účtami sa vykonajú v tom istom kole', () => {
  const w = world(); w.saves['dora'] = partial<PlayerSave>({ coins: 10000, inv: {}, rep: 300 });
  save(w, 'bob').inv.seed_mak = 2; save(w, 'eva').inv.seed_ruza = 2;
  place(w, 'bob', 'sell', 7, 2); place(w, 'eva', 'sell', 9, 2, 'seed_ruza');
  const out = E.commitBatch(w, [
    { type: 'marketOrder', id: 'mak', data: { key: 'ana', id: 'seed_mak', side: 'buy', price: 7, n: 2 } },
    { type: 'marketOrder', id: 'ruza', data: { key: 'dora', id: 'seed_ruza', side: 'buy', price: 9, n: 2 } }
  ], spec);
  const fills = out.entry.proposals.filter(p => p.type === 'marketFill' && p.outcome === 'applied');
  assert.equal(fills.length, 2); assert.equal(fills[0]?.round, fills[1]?.round);
  assert.ok(fills.every(p => !p.writes.includes('market:*') && !p.writes.includes('save:*')));
  assert.equal(orders(w).length, 0);
});

test('denné rozpočty majú explicitný strop vrátane mincí v rezerváciách', () => {
  const w = world(), m = must(w.market ?? undefined), b = must(m.book);
  b.accounts.zuzka.coins = 12; b.accounts.wholesale.coins = 12;
  for (let i = 0; i < 100; i++) { Book.fund(m); E.commitBatch(w, [], spec); }
  assert.equal(b.accounts.wholesale.coins + Book.reserved(m, 'wholesale'), Book.WHOLESALE_BUDGET_CAP);
  assert.equal(b.accounts.zuzka.coins + Book.reserved(m, 'zuzka'), Book.ZUZKA_BUDGET_CAP);
});

test('Jano, Fero a Zuzka rozhodujú denne medzi 08:00–18:00; dodávka zostáva každý druhý deň o 07:00', () => {
  const w = world(), visits = new Map<string, number[]>(), delivery: number[] = [];
  E.advanceTo(w, w.tick + 8 * D.TICKS_PER_DAY, { ...spec, periodic: Econ.PERIODIC, onBatch(w, out) {
    for (const i of out.entry.inputs) {
      if (i.type.startsWith('npc_')) { const times = visits.get(i.type) || []; times.push(w.tick); visits.set(i.type, times); }
      if (i.type === 'delivery') delivery.push(w.tick);
    }
  } });
  for (const npc of ['jano', 'fero', 'zuzka']) {
    const times = visits.get(`npc_${npc}`) || []; assert.ok(times.length >= 7);
    for (const [i, tick] of times.entries()) { const hour = tick % D.TICKS_PER_DAY / D.TICKS_PER_HOUR; assert.ok(hour >= 8 && hour < 18); if (i) assert.ok(tick - must(times[i - 1]) >= D.TICKS_PER_DAY / 2); }
  }
  assert.equal(delivery.length, 4); assert.ok(delivery.every(t => t % (2 * D.TICKS_PER_DAY) === 7 * D.TICKS_PER_HOUR));
});

test('Zuzkina denná stratégia vykúpi skutočné sviatočné ponuky pred menej žiadanými kvetmi', () => {
  const w = world(), m = must(w.market ?? undefined), b = must(m.book);
  b.accounts.wholesale.inv.fl_ruza = 4; b.accounts.wholesale.coins = 0;
  must(m.flowers.ruza).fest = 2; b.accounts.zuzka.coins = 300;
  E.commitBatch(w, [], spec); const before = Book.owned(m, 'fl_ruza');
  E.commitBatch(w, [{ type: 'npc_zuzka', id: 'festival-visit', data: null }], spec);
  assert.ok(Book.owned(m, 'fl_ruza') < before); assert.ok(b.accounts.zuzka.coins >= 0);
});

test('po roztopení neseného ľadu sa čakajúci dopyt vyplní v tej istej hodinovej dávke', async () => {
  const Events = await import('../src/server/events.ts');
  const I = await import('../src/server/items.ts');
  const w = world(); w.storage = {}; w.storageFb = {}; w.icehouse = { built: false, ice: 0, bl: 0 };
  place(w, 'ana', 'buy', 10, 1, 'ice');
  I.addItems(I.playerC(save(w, 'ana')), 'ice', D.ICE_CARRY, w.tick - D.ICE_LIFE + 1);
  I.addItems(I.playerC(save(w, 'bob')), 'ice', 1, w.tick);
  place(w, 'bob', 'sell', 9, 1, 'ice'); assert.equal(orders(w).length, 2);
  w.tick += 2;
  E.commitBatch(w, [{ type: 'hourly', id: 'hourly', data: null }], { ...spec, proposers: { ...spec.proposers, hourly: Events.PROPOSERS.hourly } });
  assert.equal(save(w, 'ana').inv.ice, 1); assert.equal(orders(w).length, 0);
});

test('súčasné expirácie kotácií jedného NPC sa vrátia spolu a nahradia jednou údržbou', () => {
  const w = world(), m = must(w.market ?? undefined), b = must(m.book);
  b.accounts.wholesale.coins = 1000; b.accounts.wholesale.inv.seed_mak = 5; b.accounts.wholesale.inv.seed_ruza = 5;
  E.commitBatch(w, [], spec); const count = orders(w).length; assert.ok(count > 3);
  const cash = b.accounts.wholesale.coins + Book.reserved(m, 'wholesale'), stock = Book.owned(m, 'seed_mak');
  let refreshes = 0;
  E.advanceTo(w, w.tick + 3 * D.TICKS_PER_DAY, { ...spec, onBatch(w, out) { refreshes += out.entry.proposals.filter(p => p.type === 'marketQuotes' && p.outcome === 'applied').length; } });
  assert.equal(refreshes, 1); assert.equal(Book.owned(m, 'seed_mak'), stock);
  assert.equal(b.accounts.wholesale.coins + Book.reserved(m, 'wholesale'), cash);
});
