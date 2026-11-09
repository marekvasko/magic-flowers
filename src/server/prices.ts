// Ceny živého trhu (#112: vyčlenené z economy.ts): zásoba veľkoobchodníka určuje jeho ceny predaja a výkupu.
// Funkcie len čítajú stav, nič nemenia. Kniha objednávok (market.ts) z nich skladá ponuky a dopyty veľkoobchodníka.
import * as D from '../shared/data.ts';
import type { Festival, FestivalId, ItemId, Season, SpeciesId } from '../shared/data.ts';
import type { ActiveFestival, Market, PlayerSave } from '../shared/save.ts';
import { entries, keys, must } from '../shared/util.ts';
import * as I from './items.ts';

const TPD = D.TICKS_PER_DAY;
export const DPS = D.DAYS_PER_SEASON;
export const YEAR_DAYS = 4 * DPS;
export const PLANTABLE: readonly SpeciesId[] = keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
export const SEED_TARGET = 10, COMPOST_TARGET = 15, HIST_LEN = 16;
export const SEED_CAP = 40, COMPOST_CAP = 30;
// Koeficienty cien (exportované aj pre ladiacu stránku, aby vysvetlenie sedelo s hrou)
export const PRICING = {
  seedDemand: { now: 1.35, next: 1.0, off: 0.8 }, // dopyt po semienkach podľa toho, kedy sa druh sadí
  seedScarcity: [0.75, 3], seedMin: 2,              // vzácnosť sqrt(SEED_TARGET / zásoba) v medziach, najnižšia cena
  seedSellBack: D.SEED_SELL_BACK,                   // výkup semienok = 40 % predajnej ceny
  compostBase: 15, compostScarcity: [0.7, 3], compostMin: 5, compostSellBack: 0.5,
  flowerOffSeason: 1.6,                             // kvet mimo svojej sezóny je vzácnejší
  flowerSat: { start: 1.3, perUnit: 0.06, min: 0.35 }, // nasýtenie trhu: 1,3 − 0,06 × zásoba, najmenej 0,35
  flowerMin: 1, flowerCap: 99,
  flowerOvernight: 0.6, seedOffSeasonDecay: 0.9     // každé ráno: zostane 60 % kvetov, 90 % semienok mimo sezóny
} as const;

// Trh, s ktorým pracujú ceny, nákup a predaj: celý trh, alebo čiastočný z výrezov návrhu (marketSlice – bez kompostu,
// sviatku a histórie, ak ich tovar nepotrebuje)
export interface MarketPart {
  seeds: Market['seeds'];
  flowers: Market['flowers'];
  compost: Market['compost'] | null;
  festival?: ActiveFestival | null;
}
export type Phase = 'now' | 'next' | 'off';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const day = (tick: number): number => D.dayOfTick(tick);
export const season = (tick: number): Season => D.seasonOf(day(tick));
export const dayInSeason = (tick: number): number => (day(tick) - 1) % DPS + 1;
export const nextSeason = (se: Season, k: number): Season => ((se + k) % 4) as Season;
const seedOf = (m: MarketPart, sp: SpeciesId): { stock: number } => must(m.seeds[sp]);
const flowerOf = (m: Pick<MarketPart, 'flowers'>, sp: SpeciesId): { stock: number; fest?: number } => must(m.flowers[sp]);
const compostOf = (m: MarketPart): { stock: number } => must(m.compost ?? undefined);
// Kedy sa druh sadí vzhľadom na aktuálne obdobie: teraz / v ďalšom období / mimo
export function phase(sp: SpeciesId, se: Season): Phase {
  const s = D.SPECIES[sp].seasons;
  if (s.includes(se)) return 'now';
  if (s.includes(nextSeason(se, 1))) return 'next';
  return 'off';
}
// Krok, ktorým začína obdobie posunuté o `offset` období od aktuálneho
export function seasonStartTick(tick: number, offset: number): number { return (Math.floor((day(tick) - 1) / DPS) + offset) * DPS * TPD; }

// Správa na trhovisku (najnovšia prvá, najviac 14)
export function news(m: Pick<Market, 'news'>, tick: number, text: string): void {
  m.news.unshift({ tick, text });
  if (m.news.length > 14) m.news.length = 14;
}

// ---------- Ceny ----------
// Každá cena sa skladá z činiteľov; *PriceParts vrátia všetky (pre ladiacu stránku) aj výslednú cenu,
// takže vysvetlenie sa nemôže rozísť s hrou. Funkcie len čítajú stav, nič nemenia.
export function seedPriceParts(m: MarketPart, tick: number, sp: SpeciesId): {
  base: number; stock: number; season: Season; phase: Phase; demand: number; scarcityRaw: number; scarcity: number; raw: number; min: number; price: number;
} {
  const P = PRICING, base = D.SPECIES[sp].seed, stock = seedOf(m, sp).stock;
  const se = season(tick), ph = phase(sp, se);
  const demand = P.seedDemand[ph];
  const scarcityRaw = Math.sqrt(SEED_TARGET / Math.max(1, stock));
  const scarcity = clamp(scarcityRaw, P.seedScarcity[0], P.seedScarcity[1]);
  const raw = base * demand * scarcity;
  return { base, stock, season: se, phase: ph, demand, scarcityRaw, scarcity, raw, min: P.seedMin, price: Math.max(P.seedMin, Math.round(raw)) };
}
export function seedPrice(m: MarketPart, tick: number, sp: SpeciesId): number { return seedPriceParts(m, tick, sp).price; }
export function compostPriceParts(m: MarketPart): { base: number; stock: number; scarcityRaw: number; scarcity: number; raw: number; min: number; price: number } {
  const P = PRICING, base = P.compostBase, stock = compostOf(m).stock;
  const scarcityRaw = Math.sqrt(COMPOST_TARGET / Math.max(1, stock));
  const scarcity = clamp(scarcityRaw, P.compostScarcity[0], P.compostScarcity[1]);
  const raw = base * scarcity;
  return { base, stock, scarcityRaw, scarcity, raw, min: P.compostMin, price: Math.max(P.compostMin, Math.round(raw)) };
}
export function compostPrice(m: MarketPart): number { return compostPriceParts(m).price; }
// Výkupná cena kvetu: mimo sezóny vzácnejší, počas sviatku vyšší dopyt, plný trh cenu tlačí dole.
// Sviatočný násobok je v položke kvetu (m.flowers[sp].fest, píšu ho festStart/festEnd), takže predaj kvetu
// potrebuje len výrez 'market:fl_<sp>'; m.festival je iba súhrn pre klienta (id, meno, ikona, násobky, dokedy).
export function flowerPriceParts(m: Pick<MarketPart, 'flowers' | 'festival'>, tick: number, sp: SpeciesId): {
  base: number; stock: number; season: Season; inSeason: boolean; rare: number; fest: number; festival: FestivalId | null;
  satRaw: number; sat: number; raw: number; min: number; price: number;
} {
  const P = PRICING, s = D.SPECIES[sp], base = s.sell, f = flowerOf(m, sp), stock = f.stock, se = season(tick);
  const inSeason = s.seasons.includes(se);
  const rare = inSeason ? 1 : P.flowerOffSeason;
  const fest = f.fest || 1;
  const satRaw = P.flowerSat.start - P.flowerSat.perUnit * stock;
  const sat = Math.max(P.flowerSat.min, satRaw);
  const raw = base * rare * fest * sat;
  return { base, stock, season: se, inSeason, rare, fest, festival: fest !== 1 && m.festival ? m.festival.id : null, satRaw, sat, raw, min: P.flowerMin, price: Math.max(P.flowerMin, Math.round(raw)) };
}
// Sviatok v položkách kvetov: zmaže staré násobky a zapíše násobky sviatku f (null = žiadny sviatok).
export function setFestival(m: Pick<MarketPart, 'flowers'>, f: Pick<Festival, 'mult'> | null | undefined): void {
  for (const sp of keys(m.flowers)) delete flowerOf(m, sp).fest;
  if (f) for (const [sp, x] of entries(f.mult)) { const it = m.flowers[sp]; if (it) it.fest = x; }
}
// Pri načítaní: násobky v položkách kvetov sa odvodia zo súhrnu (staršie uloženia ich nemajú; bez zmeny verzie uloženia).
export function syncFestival(m: Pick<MarketPart, 'flowers' | 'festival'> | null | undefined): void { if (m) setFestival(m, m.festival); }
export function flowerPrice(m: Pick<MarketPart, 'flowers' | 'festival'>, tick: number, sp: SpeciesId): number { return flowerPriceParts(m, tick, sp).price; }
// Cena, za ktorú trh od hráča vykúpi 1 kus (null = nevykupuje)
export function sellQuote(m: MarketPart, tick: number, id: string): number | null {
  if (id.startsWith('fl_')) { const sp = id.slice(3); return D.isSpeciesId(sp) && m.flowers[sp] ? flowerPrice(m, tick, sp) : null; }
  if (id.startsWith('seed_')) { const sp = id.slice(5); return D.isSpeciesId(sp) && m.seeds[sp] ? Math.max(1, Math.round(D.seedSellBase(sp, seedPrice(m, tick, sp)) * PRICING.seedSellBack)) : D.sellPrice(id); }
  if (id === 'compost') return Math.max(1, Math.round(compostPrice(m) * PRICING.compostSellBack));
  if (id.startsWith('po_') || id === 'wilted') return D.sellPrice(id);
  if (id === 'ice') return must(D.ICE_PRICE[season(tick)]); // v lete drahý, v zime takmer zadarmo
  return null;
}
export function buyQuote(m: MarketPart, tick: number, id: string): { price: number; stock: number } | null {
  if (id === 'compost') return { price: compostPrice(m), stock: compostOf(m).stock };
  const sp = id.startsWith('seed_') ? id.slice(5) : '';
  if (D.isSpeciesId(sp) && m.seeds[sp]) return { price: seedPrice(m, tick, sp), stock: seedOf(m, sp).stock };
  return null;
}
export function stockOf(m: MarketPart, id: string): { stock: number } | null | undefined {
  if (id === 'compost') return m.compost;
  const sp = D.speciesOfItem(id);
  if (id.startsWith('seed_')) return sp ? m.seeds[sp] : undefined;
  if (id.startsWith('fl_')) return sp ? m.flowers[sp] : undefined;
  return null;
}

// Predaj za pevnú cenu mimo knihy objednávok (elixíry, zvädnuté kvety, ľad, čarovné semienka – tovar, ktorý nemá knihu):
// trh vykúpi všetko za sellQuote, zásoby sa nemenia.
export function sellFixed(m: MarketPart, tick: number, sv: PlayerSave, id: string, n: number): { n: number; earned?: number; msg: string } {
  const q = sellQuote(m, tick, id);
  if (q == null || D.isTool(id)) return { n: 0, msg: 'Toto trh nevykupuje.' };
  if (!D.isItemId(id)) return { n: 0, msg: 'Nemáš čo predať.' };
  n = Math.min(n, sv.inv[id] || 0);
  if (!n || !I.removeItems(I.playerC(sv), id, n, tick)) return { n: 0, msg: 'Nemáš čo predať.' };
  const earned = n * q;
  sv.coins += earned;
  return { n, earned, msg: `Predané: ${String(n)}× ${D.itemName(id)} za ${String(earned)} 🪙` };
}

// Zápis cien do histórie (graf a šípky trendu na trhu)
export function recordHistory(m: Market, tick: number): void {
  const push = (id: ItemId, v: number): void => { const h = m.hist[id] || (m.hist[id] = []); h.push(v); if (h.length > HIST_LEN) h.shift(); };
  for (const sp of PLANTABLE) { push(`seed_${sp}`, seedPrice(m, tick, sp)); push(`fl_${sp}`, flowerPrice(m, tick, sp)); }
  push('compost', compostPrice(m));
}
