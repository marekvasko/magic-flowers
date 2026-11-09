// Spoločné poradie a náhľad ceny; limity sú vždy skutočné ceny, bonus mení iba výber.
import type { ItemId } from './data.ts';
import { TICKS_PER_DAY } from './data.ts';
import type { MarketSide } from './save.ts';
export const ORDER_DAYS = 3;
export const AGING_TICKS = TICKS_PER_DAY / 2;
export const AGING_COINS = 1;
export const ORDER_STEPS = [0.8, 0.9, 1.1, 1.2] as const;
export interface BookLevel {
  id: string; item: ItemId; side: MarketSide; price: number; remaining: number;
  owner: string; name: string; tick: number; sequence: [number, number]; fresh: number;
}
export const orderLimit = (level: number): number => 2 + Math.min(4, Math.max(0, level));
export const older = (a: Pick<BookLevel, 'sequence' | 'id'>, b: Pick<BookLevel, 'sequence' | 'id'>): number => a.sequence[0] - b.sequence[0] || a.sequence[1] - b.sequence[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function priority(a: BookLevel, b: BookLevel, tick: number): number {
  const bonus = (o: BookLevel): number => Math.floor(Math.max(0, tick - o.tick) / AGING_TICKS) * AGING_COINS;
  return (a.side === 'sell' ? a.price - bonus(a) - (b.price - bonus(b)) : b.price + bonus(b) - (a.price + bonus(a))) || older(a, b);
}
export function instantQuote(levels: readonly BookLevel[], side: MarketSide, item: ItemId, n: number, tick: number, owner = ''): { n: number; total: number; mean: number; name: string; limit: number; fresh: number } {
  let left = n, total = 0, freshness = 0, limit = side === 'buy' ? 0 : Number.MAX_SAFE_INTEGER, name = '';
  for (const o of levels.filter(o => o.item === item && o.side !== side && o.owner !== owner).sort((a, b) => priority(a, b, tick))) {
    const k = Math.min(left, o.remaining);
    if (!k) break;
    if (!name) name = o.name;
    total += k * o.price; freshness += k * o.fresh; left -= k;
    limit = side === 'buy' ? Math.max(limit, o.price) : Math.min(limit, o.price);
  }
  return { n: n - left, total, mean: n > left ? total / (n - left) : 0, name, limit, fresh: n > left ? freshness / (n - left) : 1 };
}
