// Jediná cesta vykonania obchodov. Každý vklad má svoj výrez; vyrovnanie píše iba dve objednávky a účty.
import * as D from '../shared/data.ts';
import type { ItemId } from '../shared/data.ts';
import { instantQuote, older, ORDER_DAYS, orderLimit, priority } from '../shared/market.ts';
import type { BookLevel } from '../shared/market.ts';
import type { Market, MarketAccount, MarketOrder, MarketOwner, MarketSide, NpcId, OrderBook, PlayerSave } from '../shared/save.ts';
import { entries, keys, must } from '../shared/util.ts';
import * as Econ from './pricing.ts';
import * as E from './engine.ts';
import type { Input } from './engine.ts';
import { put, sl } from './game.ts';
import type { GameCtx, GameProposer, GameSlices, GameWorld } from './game.ts';
import * as I from './items.ts';
import type { Container } from './world.ts';

export const NPC_NAMES: Record<NpcId, string> = { wholesale: 'Veľkoobchodník', jano: 'Jano', fero: 'Fero', zuzka: 'Zuzka' };
export const WHOLESALE_DAILY = 2000, WHOLESALE_BUDGET_CAP = 4000, ZUZKA_DAILY = 150, ZUZKA_BUDGET_CAP = 300;
const account = (coins: number): MarketAccount => ({ coins, inv: {}, fb: {} });
export const ownerId = (o: MarketOwner): string => `${o.kind}:${o.key}`;
const ownerKey = (o: MarketOwner): string => o.kind === 'player' ? `save:${o.key}` : `market:account:${o.key}`;
const orderKey = (id: string): `market:order:${string}` => `market:order:${id}`;
const container = (a: MarketAccount | MarketOrder): Container => ({ inv: a.inv, fb: a.fb, rate: 1 });
const ownerAccount = (s: GameSlices, o: MarketOwner): PlayerSave | MarketAccount => o.kind === 'player' ? must(sl(s, `save:${o.key}`)) : sl(s, `market:account:${o.key}`);
const ownerContainer = (s: GameSlices, o: MarketOwner): Container => o.kind === 'player' ? I.playerC(must(sl(s, `save:${o.key}`))) : container(sl(s, `market:account:${o.key}`));
export function roomFor(sv: Pick<PlayerSave, 'inv'>, id: ItemId): number { return id === 'ice' ? Math.max(0, D.ICE_CARRY - (sv.inv.ice || 0)) : Number.MAX_SAFE_INTEGER; }
export function tradable(id: string): id is ItemId { return D.isItemId(id) && !D.isTool(id) && !id.startsWith('wild_'); }
export function fresh(o: MarketOrder, tick: number): number {
  const sp = o.item.startsWith('fl_') ? D.speciesOfItem(o.item) : null;
  if (!sp || !o.remaining || o.side === 'buy') return 1;
  return (o.fb[o.item] || []).reduce((v, b) => v + b.n * D.freshness(sp, D.batchAge(b, tick, 1)), 0) / o.remaining;
}
const level = (o: MarketOrder, tick: number): BookLevel => ({ id: o.id, item: o.item, side: o.side, price: o.price, remaining: o.remaining, owner: ownerId(o.owner), name: o.name, tick: o.tick, sequence: o.sequence, fresh: fresh(o, tick) });
export function levels(m: Market, tick: number): BookLevel[] { return Object.values(m.book?.orders || {}).filter((o): o is MarketOrder => !!o && o.active && o.remaining > 0 && o.expires > tick).map(o => level(o, tick)); }
export function init(m: Market, tick: number): void {
  if (m.book) return;
  const b: OrderBook = { orders: {}, accounts: { wholesale: account(WHOLESALE_BUDGET_CAP), jano: account(m.npcs.jano.coins), fero: account(m.npcs.fero.coins), zuzka: account(ZUZKA_BUDGET_CAP) }, trades: {} };
  for (const [sp, st] of entries(m.seeds)) b.accounts.wholesale.inv[`seed_${sp}`] = st.stock;
  for (const [sp, st] of entries(m.flowers)) I.addItems(container(b.accounts.wholesale), `fl_${sp}`, st.stock, tick);
  b.accounts.wholesale.inv.compost = m.compost.stock;
  for (const [sp, n] of entries(m.npcs.fero.hold)) b.accounts.fero.inv[`seed_${sp}`] = n;
  m.npcs.fero.hold = {}; // vlastníctvo prešlo do účtu, nesmie zostať druhá zásoba
  m.book = b;
}
// Pri založení sveta publikujeme objednávky cez tie isté návrhy ako pri neskoršej dodávke.
export function bootstrap(world: GameWorld): void {
  const m = world.market;
  if (!m) return;
  init(m, world.tick);
  E.commitBatch(world, [], { proposers: PROPOSERS });
}
const active = (m: Market): MarketOrder[] => Object.values(m.book?.orders || {}).filter((o): o is MarketOrder => !!o && o.active && o.remaining > 0);
const WHOLESALE_ITEMS: ItemId[] = ['compost', ...Econ.PLANTABLE.flatMap(sp => [`seed_${sp}`, `fl_${sp}`] as const), 'ice', 'wilted', ...keys(D.POTIONS).map(k => `po_${k}` as const)];
const allItems = (m: Market): ItemId[] => [...new Set([...WHOLESALE_ITEMS, ...keys(m.book?.accounts.wholesale.inv || {})])];
const wholesale = (o: MarketOrder): boolean => o.owner.kind === 'npc' && o.owner.key === 'wholesale';
export function owned(m: Market, id: ItemId): number { return (m.book?.accounts.wholesale.inv[id] || 0) + active(m).filter(o => wholesale(o) && o.side === 'sell' && o.item === id).reduce((n, o) => n + o.remaining, 0); }
export function reserved(m: Market, npc: NpcId): number { return active(m).filter(o => o.owner.kind === 'npc' && o.owner.key === npc).reduce((n, o) => n + o.coins, 0); }
export function fund(m: Market): void {
  const b = m.book;
  if (!b) return;
  for (const [id, income, cap] of [['wholesale', WHOLESALE_DAILY, WHOLESALE_BUDGET_CAP], ['zuzka', ZUZKA_DAILY, ZUZKA_BUDGET_CAP]] as const) {
    const a = b.accounts[id];
    a.coins += Math.max(0, Math.min(income, cap - a.coins - reserved(m, id)));
  }
}
// Zásoby v starých cenových vzorcoch sú iba projekcia vlastníctva veľkoobchodníka vrátane rezervácií.
function pricing(m: Market, id: ItemId, stock: number): Econ.MarketPart {
  const sp = D.speciesOfItem(id);
  return { seeds: sp ? { [sp]: { stock } } : {}, flowers: sp ? { [sp]: { stock, fest: m.flowers[sp]?.fest || 1 } } : {}, compost: { stock }, festival: m.festival };
}
interface Target { side: MarketSide; price: number; n: number }
function targets(m: Market, tick: number, id: ItemId, existing = active(m).filter(o => wholesale(o) && o.item === id), stock = owned(m, id)): Target[] {
  const b = m.book;
  if (!b) return [];
  const out: Target[] = [];
  const budget = Math.min(100, b.accounts.wholesale.coins + existing.reduce((n, o) => n + o.coins, 0));
  const p = pricing(m, id, stock), ask = Econ.buyQuote(p, tick, id), bid = Econ.sellQuote(p, tick, id);
  if (stock && (ask || bid)) out.push({ side: 'sell', price: ask?.price ?? Math.max(1, Math.ceil((bid || 1) * 1.25)), n: Math.min(stock, 40) });
  if (bid && budget >= bid) out.push({ side: 'buy', price: bid, n: Math.min(8, Math.floor(budget / bid)) });
  return out;
}
const sameQuotes = (expected: Target[], actual: MarketOrder[]): boolean => expected.length === actual.length && expected.every(t => actual.some(o => o.side === t.side && o.price === t.price && o.remaining === t.n));
const newId = (tick: number, step: number, id: string): string => `${tick}-${step}-${id}`;
function create(a: PlayerSave | MarketAccount, owner: MarketOwner, name: string, id: string, item: ItemId, side: MarketSide, price: number, n: number, ctx: GameCtx, offset = 0, ioc = false): MarketOrder {
  const o: MarketOrder = { id, item, owner, name, side, price, quantity: n, remaining: n, filled: 0, value: 0, tick: ctx.tick, sequence: [ctx.step, ctx.ordinal * 1000 + offset], expires: ctx.tick + ORDER_DAYS * D.TICKS_PER_DAY, active: true, ioc, coins: 0, inv: {}, fb: {} };
  if (side === 'buy') { a.coins -= n * price; o.coins = n * price; }
  else {
    const c = owner.kind === 'player' ? I.playerC(a as PlayerSave) : container(a as MarketAccount); // owner určuje tvar účtu
    const batches = I.removeItems(c, item, n, ctx.tick);
    if (!batches) throw new Error('chýba krytie ponuky');
    I.addItems(container(o), item, n, ctx.tick, batches);
  }
  if (owner.kind === 'player') { const sv = a as PlayerSave; (sv.marketOrders ??= []).push(id); } // účet hráča má zoznam objednávok
  ctx.scheduleUnique(`marketExpire:${id}`, o.expires, 'marketExpire', { id });
  return o;
}
function finish(s: GameSlices, o: MarketOrder, ctx: GameCtx): void {
  if (o.ioc && o.owner.kind === 'player') ctx.emit({ to: o.owner.key, t: 'toast', text: o.filled ? `${o.side === 'buy' ? 'Kúpené' : 'Predané'}: ${o.filled}× ${D.itemName(o.item)} za ${o.value} 🪙${o.counterparties?.length ? ` · ${o.counterparties.join(', ')}` : ''}` : 'Vypredané. V knihe objednávok nie je dosť kusov.', kind: 'info' });
  ctx.cancel(`marketExpire:${o.id}`);
  if (o.owner.kind === 'player') {
    const sv = must(sl(s, `save:${o.owner.key}`));
    sv.marketOrders = (sv.marketOrders || []).filter(id => id !== o.id);
    sv.marketClaims = (sv.marketClaims || []).filter(id => id !== o.id);
  }
  put(s, orderKey(o.id), undefined);
}
function refund(s: GameSlices, o: MarketOrder, ctx: GameCtx, expire: boolean): void {
  const a = ownerAccount(s, o.owner), c = ownerContainer(s, o.owner);
  a.coins += o.coins; o.coins = 0;
  // Kvety zvädnú a ľad sa roztopí aj v rezerve. Zvyšky zaberajú pôvodné vlastníctvo.
  I.wiltSweep(container(o), ctx.tick); I.meltSweep(container(o), ctx.tick);
  for (const id of keys(o.inv)) {
    const n = Math.min(o.inv[id] || 0, o.owner.kind === 'player' ? roomFor(a, id) : Number.MAX_SAFE_INTEGER);
    if (n) I.addItems(c, id, n, ctx.tick, I.removeItems(container(o), id, n, ctx.tick));
  }
  o.remaining = Object.values(o.inv).reduce((n, k) => n + (k || 0), 0);
  if (expire) {
    o.active = false;
    if (o.remaining && o.owner.kind === 'player') {
      const sv = must(sl(s, `save:${o.owner.key}`));
      sv.marketOrders = (sv.marketOrders || []).filter(id => id !== o.id);
      if (!(sv.marketClaims || []).includes(o.id)) (sv.marketClaims ??= []).push(o.id);
    }
  }
  if (!o.remaining || o.side === 'buy') finish(s, o, ctx);
}
function canReceive(w: GameWorld, buy: MarketOrder): boolean {
  if (buy.owner.kind !== 'player') return true;
  const sv = w.saves[buy.owner.key], sp = buy.item.startsWith('seed_') ? D.speciesOfItem(buy.item) : null;
  return !!sv && roomFor(sv, buy.item) > 0 && (!sp || D.repLevel(sv.rep) >= (D.MIN_SEED_REP[sp] || 0));
}
function pair(w: GameWorld, item: ItemId, candidatesForItem?: MarketOrder[]): [MarketOrder, MarketOrder] | null {
  const m = w.market;
  if (!m) return null;
  const orders = (candidatesForItem || active(m).filter(o => o.item === item)).filter(o => o.expires > w.tick);
  if (orders.every(o => wholesale(o))) return null;
  for (const taker of orders.sort(older)) {
    const candidates = orders.filter(o => !o.ioc && o.side !== taker.side && ownerId(o.owner) !== ownerId(taker.owner) && older(o, taker) < 0 && (taker.side === 'buy' ? taker.price >= o.price : o.price >= taker.price) && (taker.side === 'buy' ? taker.coins : o.coins) >= o.price && canReceive(w, taker.side === 'buy' ? taker : o));
    candidates.sort((a, b) => priority(level(a, w.tick), level(b, w.tick), w.tick));
    const maker = candidates[0];
    if (maker && (taker.side === 'buy' ? taker.coins : maker.coins) >= maker.price) return taker.side === 'buy' ? [taker, maker] : [maker, taker];
  }
  return null;
}
// Čisto čítajúca koordinácia: po každom kole návrhov znovu odvodí prácu zo skutočne prijatého stavu.
export function expiredAssets(w: GameWorld): Input[] {
  return Object.values(w.market?.book?.orders || {}).filter((o): o is MarketOrder => !!o && o.active && (o.expires <= w.tick || (o.side === 'sell' && staleAssets(o, w.tick)))).map(o => ({ type: 'marketExpire', data: { id: o.id }, id: `expire:${o.id}:${w.step || 0}` }));
}
export function hourlySettlement(w: GameWorld): Input[] {
  const stale = expiredAssets(w);
  if (stale.length) return stale;
  return Object.values(w.market?.book?.orders || {}).some(o => o?.active && o.item === 'ice' && o.side === 'buy' && o.owner.kind === 'player') ? settle(w) : [];
}
export function settle(w: GameWorld): Input[] {
  const m = w.market;
  if (!m?.book) return [];
  const orders = Object.values(m.book.orders).filter((o): o is MarketOrder => !!o);
  const stale = expiredAssets(w);
  if (stale.length) return stale;
  const perItem = new Map<ItemId, MarketOrder[]>(), wholesaleOrders = new Map<ItemId, MarketOrder[]>(), assets = { ...m.book.accounts.wholesale.inv };
  for (const o of orders) if (o.active && o.remaining) {
    const group = perItem.get(o.item) || []; group.push(o); perItem.set(o.item, group);
    if (wholesale(o)) { const own = wholesaleOrders.get(o.item) || []; own.push(o); wholesaleOrders.set(o.item, own); if (o.side === 'sell') assets[o.item] = (assets[o.item] || 0) + o.remaining; }
  }
  const items = allItems(m);
  const stocks = items.filter(id => {
    const sp = D.speciesOfItem(id), actual = assets[id] || 0;
    return id === 'compost' ? m.compost.stock !== actual : sp && id.startsWith('seed_') ? m.seeds[sp]?.stock !== actual : sp && id.startsWith('fl_') ? m.flowers[sp]?.stock !== actual : false;
  });
  const quotes = items.filter(id => { const own = wholesaleOrders.get(id) || []; return !sameQuotes(targets(m, w.tick, id, own, assets[id] || 0), own); });
  if (quotes.length) return [{ type: 'marketQuotes', data: { items: quotes }, id: `quotes:${w.step || 0}` }];
  if (stocks.length) return stocks.map(item => ({ type: 'marketStock', data: { item }, id: `stock:${item}:${w.step || 0}` }));
  const fills = [...perItem.keys()].filter(id => pair(w, id, perItem.get(id)));
  if (fills.length) return fills.map(item => ({ type: 'marketFill', data: { item }, id: `fill:${item}:${w.step || 0}` }));
  return orders.filter(o => o.ioc && o.active).map(o => ({ type: 'marketExpire', data: { id: o.id }, id: `ioc:${o.id}:${w.step || 0}` }));
}
function staleAssets(o: MarketOrder, tick: number): boolean {
  const sp = o.item.startsWith('fl_') ? D.speciesOfItem(o.item) : null;
  return (o.fb[o.item] || []).some(b => D.batchAge(b, tick, 1) >= (sp ? D.SPECIES[sp].life * D.TICKS_PER_DAY : o.item === 'ice' ? D.ICE_LIFE : Infinity));
}
export interface Place { key: string; id: string; n: number; side: MarketSide; price?: number; instant?: boolean }
export function placement(side?: MarketSide): GameProposer<Place> {
  return {
    settle,
    keys(d, w, pr, inputId = '', batch = w.step || 0) { return { writes: [`save:${d.key}`, orderKey(newId(w.tick, batch, inputId))], reads: d.instant || side ? active(must(w.market ?? undefined)).filter(o => o.item === d.id && o.side !== (side || d.side)).map(o => orderKey(o.id)).filter(k => k !== orderKey(newId(w.tick, batch, inputId))) : [] }; },
    run(s, d, ctx) {
      const sv = sl(s, `save:${d.key}`) || ctx.reject(null), item = d.id, kind = side || d.side;
      if (!tradable(item)) return ctx.reject(kind === 'buy' ? 'Toto sa na trhu nepredáva.' : 'Toto trh nevykupuje.');
      const id = newId(ctx.tick, ctx.batch, ctx.id);
      if (sl(s, orderKey(id))) ctx.reject('Objednávka s týmto číslom už existuje.');
      if (!Number.isSafeInteger(d.n) || d.n < 1 || d.n > 999) ctx.reject('Neplatný počet kusov.');
      const sp = item.startsWith('seed_') ? D.speciesOfItem(item) : null;
      if (kind === 'buy' && sp && D.repLevel(sv.rep || 0) < (D.MIN_SEED_REP[sp] || 0)) ctx.reject('Na tieto semienka potrebuješ vyššiu reputáciu.');
      let price = d.price, reserve: number | undefined;
      const instant = !!(d.instant || side);
      if (instant) {
        // Kolekcia je len na čítanie. Nový výrez objednávky sa preto deklaruje samostatne až pri limitnom vklade.
        const os = orderCollection(s);
        const q = instantQuote(os.map(o => level(o, ctx.tick)), kind, item, d.n, ctx.tick, `player:${d.key}`);
        if (q.n < d.n) ctx.reject(kind === 'buy' ? 'Vypredané. V knihe objednávok nie je dosť kusov.' : 'V knihe objednávok nie je dosť kusov.');
        price = q.limit; reserve = q.total;
      }
      if (!Number.isSafeInteger(price) || !price || price < 1 || price > 1000000) return ctx.reject('Neplatná cena.');
      if (!instant && (sv.marketOrders || []).length >= orderLimit(D.repLevel(sv.rep))) ctx.reject('Dosiahol(a) si limit otvorených objednávok.');
      if (kind === 'buy' && sv.coins < (instant ? reserve || 0 : price * d.n)) ctx.reject('Nemáš dosť mincí. 🪙');
      if (kind === 'buy' && roomFor(sv, item) < d.n) ctx.reject('Viac ľadu neunesieš.');
      if (kind === 'sell' && (sv.inv[item] || 0) < d.n) ctx.reject('Nemáš čo predať.');
      const order = create(sv, { kind: 'player', key: d.key }, sv.name || ctx.actor?.name || d.key, id, item, kind, price, d.n, ctx, 0, instant);
      if (instant && kind === 'buy' && reserve != null) { sv.coins += order.coins - reserve; order.coins = reserve; }
      put(s, orderKey(id), order);
      if (!instant) ctx.emit({ to: d.key, t: 'toast', text: kind === 'buy' ? 'Dopyt je na trhu. Mince sú rezervované.' : 'Ponuka je na trhu. Predmety sú rezervované.', kind: 'info' });
    }
  };
}
// Kolekcia čítaná pri okamžitom obchode; nový kľúč je mimo nej, engine kontroluje prekryv iba medzi výrezmi.
function orderCollection(s: GameSlices): MarketOrder[] { return Object.keys(s).filter(k => k.startsWith('market:order:')).map(k => sl(s, orderKey(k.slice(13)))).filter((o): o is MarketOrder => !!o && o.active); }
function expiring(w: GameWorld, id: string): MarketOrder[] {
  const first = w.market?.book?.orders[id];
  if (!first) return [];
  if (first.owner.kind === 'player') return [first];
  return Object.values(w.market?.book?.orders || {}).filter((o): o is MarketOrder => !!o && (o.id === id || (o.active && o.owner.kind === 'npc' && o.owner.key === first.owner.key && (o.expires <= w.tick || staleAssets(o, w.tick)))));
}
export const PROPOSERS: {
  marketQuotes: GameProposer<{ items: ItemId[] }>;
  marketStock: GameProposer<{ item: ItemId }>;
  marketQuote: GameProposer<{ item: ItemId }>;
  marketFill: GameProposer<{ item: ItemId }>;
  marketExpire: GameProposer<{ id: string }>;
  marketCancel: GameProposer<{ key: string; id: string }>;
} = {
  marketQuotes: {
    settle,
    keys(d, w, pr, identity = '') { return E.mergeKeys(...d.items.map(item => PROPOSERS.marketQuote.keys?.({ item }, w, pr, identity) || {})); },
    run(s, d, ctx) { for (const item of d.items) PROPOSERS.marketQuote.run(s, { item }, ctx); }
  },
  marketStock: {
    settle,
    keys(d, w) { return { writes: [Econ.marketKey(d.item)].filter((k): k is NonNullable<typeof k> => !!k), reads: ['market:account:wholesale', ...active(must(w.market ?? undefined)).filter(o => wholesale(o) && o.item === d.item && o.side === 'sell').map(o => orderKey(o.id))] }; },
    run(s, d) {
      const stock = (sl(s, 'market:account:wholesale').inv[d.item] || 0) + orderCollection(s).reduce((n, o) => n + o.remaining, 0), part = Econ.marketSlice(s, d.item), sp = D.speciesOfItem(d.item);
      if (d.item === 'compost' && part.compost) part.compost.stock = stock;
      else if (sp && d.item.startsWith('seed_') && part.seeds[sp]) must(part.seeds[sp]).stock = stock;
      else if (sp && d.item.startsWith('fl_') && part.flowers[sp]) must(part.flowers[sp]).stock = stock;
    }
  },
  marketQuote: {
    settle,
    keys(d, w, pr, identity = '') {
      const m = must(w.market ?? undefined), old = active(m).filter(o => wholesale(o) && o.item === d.item);
      const ids = [0, 1].map(i => newId(w.tick, w.step || 0, `${identity}:${d.item}:${i}`));
      return { writes: [`market:account:wholesale`, ...old.map(o => orderKey(o.id)), ...ids.map(orderKey), ...[Econ.marketKey(d.item)].filter((k): k is NonNullable<typeof k> => !!k)], reads: ['market:festival'] };
    },
    run(s, d, ctx) {
      const a = sl(s, 'market:account:wholesale'), os = Object.keys(s).filter(k => k.startsWith('market:order:')).map(k => sl(s, orderKey(k.slice(13)))).filter((o): o is MarketOrder => !!o && o.item === d.item);
      for (const o of os) { refund(s, o, ctx, true); }
      const stock = a.inv[d.item] || 0, part = Econ.marketSlice(s, d.item), sp = D.speciesOfItem(d.item);
      if (sp && d.item.startsWith('seed_') && part.seeds[sp]) must(part.seeds[sp]).stock = stock;
      if (sp && d.item.startsWith('fl_') && part.flowers[sp]) must(part.flowers[sp]).stock = stock;
      if (d.item === 'compost' && part.compost) part.compost.stock = stock;
      const m: Market = { ...part, compost: part.compost || { stock: 0 }, festival: null, hist: {}, news: [], npcs: { jano: { coins: 0 }, fero: { coins: 0, hold: {} } }, book: { orders: {}, accounts: { wholesale: a, jano: account(0), fero: account(0), zuzka: account(0) }, trades: {} } };
      for (const [i, t] of targets(m, ctx.tick, d.item).entries()) {
        const id = newId(ctx.tick, ctx.step, `${ctx.id}:${d.item}:${i}`);
        put(s, orderKey(id), create(a, { kind: 'npc', key: 'wholesale' }, NPC_NAMES.wholesale, id, d.item, t.side, t.price, t.n, ctx, i));
      }
    }
  },
  marketFill: {
    settle,
    keys(d, w) {
      const p = pair(w, d.item);
      return { writes: p ? [...new Set([`market:match:${d.item}`, ...p.map(o => orderKey(o.id)), ...p.map(o => ownerKey(o.owner)), ...(p.some(wholesale) ? [Econ.marketKey(d.item)].filter((k): k is NonNullable<typeof k> => !!k) : []), `market:trades:${d.item}`])] : [] };
    },
    run(s, d, ctx) {
      const orders = Object.keys(s).filter(k => k.startsWith('market:order:')).map(k => sl(s, orderKey(k.slice(13)))).filter((o): o is MarketOrder => !!o);
      const buy = orders.find(o => o.side === 'buy'), sell = orders.find(o => o.side === 'sell');
      if (!buy || !sell) return;
      const ba = ownerAccount(s, buy.owner), sa = ownerAccount(s, sell.owner), maker = older(buy, sell) < 0 ? buy : sell;
      const price = maker.price, n = Math.min(buy.remaining, sell.remaining, Math.floor(buy.coins / price), buy.owner.kind === 'player' ? roomFor(ba, d.item) : Infinity);
      if (!n || buy.price < sell.price) return;
      const batches = I.removeItems(container(sell), d.item, n, ctx.tick);
      if (!batches) throw new Error('nekrytá ponuka');
      buy.coins -= n * (buy.ioc ? price : buy.price); ba.coins += buy.ioc ? 0 : n * (buy.price - price); sa.coins += n * price;
      I.addItems(ownerContainer(s, buy.owner), d.item, n, ctx.tick, batches);
      if (wholesale(buy) || wholesale(sell)) {
        const delta = wholesale(buy) ? n : -n, part = Econ.marketSlice(s, d.item), sp = D.speciesOfItem(d.item);
        if (d.item === 'compost' && part.compost) part.compost.stock += delta;
        else if (sp && d.item.startsWith('seed_') && part.seeds[sp]) must(part.seeds[sp]).stock += delta;
        else if (sp && d.item.startsWith('fl_') && part.flowers[sp]) must(part.flowers[sp]).stock += delta;
      }
      for (const [o, counterparty] of [[buy, sell.name], [sell, buy.name]] as const) {
        o.remaining -= n; o.filled += n; o.value += n * price;
        if (!(o.counterparties || []).includes(counterparty)) (o.counterparties ??= []).push(counterparty);
      }
      // Jano sadí iba skutočne kúpené semienka. Zuzka ich predáva mimo záhrady (zdroj denného rozpočtu).
      if (buy.owner.kind === 'npc' && buy.owner.key === 'jano') {
        const sp = d.item.startsWith('seed_') ? D.speciesOfItem(d.item) : null;
        if (sp) { I.removeItems(ownerContainer(s, buy.owner), d.item, n, ctx.tick); const start = D.SPECIES[sp].seasons.includes(D.seasonOf(D.dayOfTick(ctx.tick))) ? ctx.tick : (Math.floor((D.dayOfTick(ctx.tick) - 1) / D.DAYS_PER_SEASON) + 1) * D.DAYS_PER_SEASON * D.TICKS_PER_DAY; ctx.schedule(start + D.SPECIES[sp].days * D.TICKS_PER_DAY + ctx.rng.int(D.TICKS_PER_DAY / 2), 'jano_sell', { sp, n: n * 2 }); }
      }
      if (buy.owner.kind === 'npc' && buy.owner.key === 'zuzka') I.removeItems(ownerContainer(s, buy.owner), d.item, n, ctx.tick);
      const text = `🏷️ ${sell.name}: ${n}× ${D.itemName(d.item)} → ${buy.name} · ${price} 🪙/ks.`;
      const history = sl(s, `market:trades:${d.item}`) || []; history.unshift({ tick: ctx.tick, text }); history.length = Math.min(14, history.length); put(s, `market:trades:${d.item}`, history);
      for (const [o, bought] of [[buy, true], [sell, false]] as const) {
        if (o.owner.kind === 'player') {
          const sv = must(sl(s, `save:${o.owner.key}`));
          if (ctx.presence?.some(p => p.key === o.owner.key)) { if (!o.ioc) ctx.emit({ to: o.owner.key, t: 'toast', text: `${bought ? 'Kúpené' : 'Predané'}: ${n}× ${D.itemName(d.item)} za ${n * price} 🪙 · ${bought ? sell.name : buy.name}`, kind: 'info' }); }
          else { const summary = sv.marketOffline ??= { bought: 0, sold: 0, spent: 0, earned: 0 }; if (bought) { summary.bought += n; summary.spent += n * price; } else { summary.sold += n; summary.earned += n * price; } }
        }
        if (!o.remaining) finish(s, o, ctx);
      }
    }
  },
  marketExpire: {
    settle,
    keys(d, w) { const orders = expiring(w, d.id); return { writes: [...new Set(orders.flatMap(o => [orderKey(o.id), ownerKey(o.owner)]))] }; },
    run(s, d, ctx) {
      // Kotácie jedného NPC často končia naraz. Vrátime všetky splatné rezervácie účtu v jednom návrhu,
      // aby sa medzi jednotlivými expiráciami nevytvárali a hneď nerušili rovnaké náhradné kotácie.
      for (const key of Object.keys(s).filter(k => k.startsWith('market:order:'))) { const o = sl(s, orderKey(key.slice(13))); if (o) refund(s, o, ctx, true); }
    }
  },
  marketCancel: {
    settle,
    keys(d, w) { const o = w.market?.book?.orders[d.id]; return { writes: o?.owner.kind === 'player' && o.owner.key === d.key ? [orderKey(d.id), `save:${d.key}`] : [] }; },
    run(s, d, ctx) { const o = sl(s, orderKey(d.id)); if (!o || o.owner.kind !== 'player' || o.owner.key !== d.key) return ctx.reject('Táto objednávka nie je tvoja.'); refund(s, o, ctx, !o.active); ctx.emit({ to: d.key, t: 'toast', text: 'Rezervácia je vrátená. Čo sa nezmestilo, zostáva na trhu.', kind: 'info' }); }
  }
};

// NPC rozhodnutia menia len ich vlastné účty / rezervácie. Prenos medzi vlastníkmi robí až marketFill.
export function cancelNpc(m: Market, npc: NpcId, ctx: GameCtx): void {
  const b = m.book;
  if (!b) return;
  for (const o of active(m).filter(o => o.owner.kind === 'npc' && o.owner.key === npc)) {
    const a = b.accounts[npc]; a.coins += o.coins;
    I.wiltSweep(container(o), ctx.tick); I.meltSweep(container(o), ctx.tick);
    for (const id of keys(o.inv)) { const n = o.inv[id] || 0; if (n) I.addItems(container(a), id, n, ctx.tick, I.removeItems(container(o), id, n, ctx.tick)); }
    delete b.orders[o.id]; ctx.cancel(`marketExpire:${o.id}`);
  }
}
export const npcOrderId = (tick: number, step: number, identity: string, npc: NpcId, item: ItemId, side: MarketSide, offset: number): string => newId(tick, step, `${identity}:${npc}:${item}:${side}:${offset}`);
export function npcOrder(m: Market, npc: NpcId, item: ItemId, side: MarketSide, price: number, n: number, ctx: GameCtx, offset = 0): void {
  const b = must(m.book), a = b.accounts[npc];
  n = Math.min(n, side === 'buy' ? Math.floor(a.coins / price) : a.inv[item] || 0);
  if (n < 1) return;
  const id = npcOrderId(ctx.tick, ctx.step, ctx.id, npc, item, side, offset);
  if (b.orders[id]) throw new Error('kolízia čísla NPC objednávky');
  b.orders[id] = create(a, { kind: 'npc', key: npc }, NPC_NAMES[npc], id, item, side, price, n, ctx, offset);
}
export function deliver(m: Market, id: ItemId, n: number, tick: number): void {
  const b = must(m.book); I.addItems(container(b.accounts.wholesale), id, n, tick);
}

export function trade(m: Market, tick: number, sv: PlayerSave, id: string, n: number, side: MarketSide): { n: number; coins: number; msg: string } {
  const w: GameWorld = { tick, wall: 0, daySeconds: 1200, events: [], step: 0, market: m, saves: { simulation: sv }, contracts: null, tiles: [], hory: [], les: [], pomedzie: [], weather: 'sun', storage: {}, storageFb: {}, fairyNight: -1, eternal: false, scav: {}, scavSalt: 0, icehouse: { built: false, ice: 0, bl: 0 }, dielna: { built: false, loom: false, job: null, ready: {} }, redeem: {}, pomedzieSeed: 0, up: { plots: 0 }, lesSeed: 0, glacierFed: -1, plotsUsed: 0, maxRep: 0 };
  // Počítadlo simulácie je odvodené z pretrvávajúcich objednávok, aby opakované volania nemenili poradie.
  w.step = Math.max(0, ...active(m).map(o => o.sequence[0])) + 1;
  const before = D.isItemId(id) ? sv.inv[id] || 0 : 0, coins = sv.coins;
  const out = E.commitBatch(w, [{ type: side, data: { key: 'simulation', id, n }, id: `simulation:${side}:${w.step}` }], { proposers: { ...PROPOSERS, [side]: placement(side) }, onError(err) { throw err; } });
  const got = D.isItemId(id) ? Math.abs((sv.inv[id] || 0) - before) : 0;
  return { n: got, coins: Math.abs(sv.coins - coins), msg: out.rejected[0]?.reject || (got ? `${side === 'buy' ? 'Kúpené' : 'Predané'}: ${got}× ${D.itemName(id)} za ${Math.abs(sv.coins - coins)} 🪙` : 'V knihe objednávok nie je dosť kusov.') };
}

// Nočný odbyt a kazenie odoberajú vlastnenú zásobu aj z rezervácie. Samotné zníženie nemení FIFO.
export function consume(m: Market, id: ItemId, n: number, ctx: GameCtx): void {
  const b = must(m.book), a = b.accounts.wholesale, available = Math.min(n, a.inv[id] || 0);
  if (available) I.removeItems(container(a), id, available, ctx.tick);
  let left = n - available;
  for (const o of active(m).filter(o => wholesale(o) && o.side === 'sell' && o.item === id)) {
    const k = Math.min(left, o.remaining);
    if (k) { I.removeItems(container(o), id, k, ctx.tick); o.remaining -= k; o.quantity -= k; left -= k; }
    if (!o.remaining) { delete b.orders[o.id]; ctx.cancel(`marketExpire:${o.id}`); }
    if (!left) break;
  }
  if (left) throw new Error('spotreba presahuje vlastnenú zásobu');
}
