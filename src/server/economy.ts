// Ekonomika: živý trh (zásoby + ceny podľa ponuky a dopytu), NPC obchodníci, sviatky, zákazky a vylepšenia.
// Všetko, čo sa deje v čase, je udalosť v plánovači (engine.js) a celý stav je v world.market / world.contracts.
// Funkcie nedostávajú svet, ale výrezy (slices), s ktorými pracujú: m = trh (world.market alebo jeho kópia z návrhu),
// c = nástenka zákaziek (world.contracts), sv = uloženie hráča, tick = herný čas; náhoda a plánovanie cez ctx (engine.js).
import * as D from '../shared/data.ts';
import type { Festival, FestivalId, GiverId, ItemId, Season, SpeciesId, UpgradeId } from '../shared/data.ts';
import type { MarketItemView, ServerMessage, UpcomingFestival } from '../shared/protocol.ts';
import type { ActiveFestival, Contract, ContractKind, Contracts, Market, PlayerKey, PlayerSave } from '../shared/save.ts';
import { entries, isRecord, keys, must } from '../shared/util.ts';
import * as E from './engine.ts';
import type { EngineEvent, Slices } from './engine.ts';
import { sl } from './game.ts';
import type { GameCtx, GamePeriodic, GameProposer, GameSlices, GameWorld } from './game.ts';
import * as I from './items.ts';
import type { Rng, Tile } from './world.ts';

const TPD = D.TICKS_PER_DAY, DPS = D.DAYS_PER_SEASON;
export const YEAR_DAYS = 4 * DPS;
export const PLANTABLE: readonly SpeciesId[] = keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
export const SEED_TARGET = 10, COMPOST_TARGET = 15, HIST_LEN = 16;
export const SEED_CAP = 40, COMPOST_CAP = 30;
// Koeficienty cien (exportované aj pre ladiacu stránku, aby vysvetlenie sedelo s hrou)
export const PRICING = {
  seedDemand: { now: 1.35, next: 1.0, off: 0.8 }, // dopyt po semienkach podľa toho, kedy sa druh sadí
  seedScarcity: [0.75, 3], seedMin: 2,              // vzácnosť sqrt(SEED_TARGET / zásoba) v medziach, najnižšia cena
  seedSellBack: 0.4,                                // výkup semienok = 40 % predajnej ceny
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
const day = (tick: number): number => D.dayOfTick(tick);
const season = (tick: number): Season => D.seasonOf(day(tick));
const dayInSeason = (tick: number): number => (day(tick) - 1) % DPS + 1;
const nextSeason = (se: Season, k: number): Season => ((se + k) % 4) as Season;
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
function seasonStartTick(tick: number, offset: number): number { return (Math.floor((day(tick) - 1) / DPS) + offset) * DPS * TPD; }

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
export function flowerPriceParts(m: MarketPart, tick: number, sp: SpeciesId): {
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
export function setFestival(m: Pick<MarketPart, 'flowers'>, f: Pick<Festival, 'mult'> | null): void {
  for (const sp of keys(m.flowers)) delete flowerOf(m, sp).fest;
  if (f) for (const [sp, x] of entries(f.mult)) { const it = m.flowers[sp]; if (it) it.fest = x; }
}
// Pri načítaní: násobky v položkách kvetov sa odvodia zo súhrnu (staršie uloženia ich nemajú; bez zmeny verzie uloženia).
export function syncFestival(m: Market | null | undefined): void { if (m) setFestival(m, m.festival); }
export function flowerPrice(m: MarketPart, tick: number, sp: SpeciesId): number { return flowerPriceParts(m, tick, sp).price; }
// Cena, za ktorú trh od hráča vykúpi 1 kus (null = nevykupuje)
export function sellQuote(m: MarketPart, tick: number, id: string): number | null {
  if (id.startsWith('fl_')) { const sp = id.slice(3); return D.isSpeciesId(sp) && m.flowers[sp] ? flowerPrice(m, tick, sp) : null; }
  if (id.startsWith('seed_')) { const sp = id.slice(5); return D.isSpeciesId(sp) && m.seeds[sp] ? Math.max(1, Math.round(seedPrice(m, tick, sp) * PRICING.seedSellBack)) : D.sellPrice(id); }
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
function stockOf(m: MarketPart, id: string): { stock: number } | null | undefined {
  if (id === 'compost') return m.compost;
  const sp = D.speciesOfItem(id);
  if (id.startsWith('seed_')) return sp ? m.seeds[sp] : undefined;
  if (id.startsWith('fl_')) return sp ? m.flowers[sp] : undefined;
  return null;
}
// Kľúč výrezu trhu, ktorý nákup či predaj tovaru id potrebuje ('market:seed_mak', 'market:fl_mak', 'market:compost'),
// alebo null – elixíry, zvädnuté kvety a ľad majú pevné ceny a trh sa nemení.
export type MarketKey = 'market:compost' | `market:seed_${SpeciesId}` | `market:fl_${SpeciesId}`;
export function marketKey(id: string): MarketKey | null {
  if (id === 'compost') return 'market:compost';
  const sp = D.speciesOfItem(id);
  if (sp && id.startsWith('seed_') && PLANTABLE.includes(sp)) return `market:seed_${sp}`;
  if (sp && id.startsWith('fl_') && PLANTABLE.includes(sp)) return `market:fl_${sp}`;
  return null;
}
// Čiastočný trh z výrezov návrhu: len položka tovaru id (buy/sell/sellQuote sa jej držia), ostatné kolekcie prázdne.
export function marketSlice(slices: Slices, id: string): MarketPart {
  const m: MarketPart = { seeds: {}, flowers: {}, compost: null }, key = marketKey(id), sp = D.speciesOfItem(id);
  if (key) {
    if (id === 'compost') m.compost = sl(slices, 'market:compost');
    else if (sp && id.startsWith('seed_')) { const v = sl(slices, `market:seed_${sp}`); if (v) m.seeds[sp] = v; }
    else if (sp) { const v = sl(slices, `market:fl_${sp}`); if (v) m.flowers[sp] = v; }
  }
  return m;
}

// Nákup po kusoch – každý kus zvýši cenu ďalšieho (ubúda zásoba).
export function buy(m: MarketPart, tick: number, sv: PlayerSave, id: string, n: number): { n: number; cost?: number; msg: string } {
  const q = buyQuote(m, tick, id);
  if (!q) return { n: 0, msg: 'Toto sa na trhu nepredáva.' };
  const sp = id.startsWith('seed_') ? D.speciesOfItem(id) : null;
  const minRep = sp ? D.MIN_SEED_REP[sp] : undefined;
  if (sp && minRep && D.repLevel(sv.rep || 0) < minRep) return { n: 0, msg: `Veľkoobchodník predáva ${D.SPECIES[sp].name} len záhradníkom s reputáciou ${String(minRep)}.` };
  let got = 0, cost = 0;
  while (got < n) {
    const cur = buyQuote(m, tick, id), st = stockOf(m, id);
    if (!cur || !st || cur.stock <= 0) break;
    if (sv.coins < cur.price) break;
    sv.coins -= cur.price; cost += cur.price; st.stock--; got++;
  }
  if (got && D.isItemId(id)) I.addItems(I.playerC(sv), id, got, tick);
  const msg = got ? `Kúpené: ${String(got)}× ${D.itemName(id)} za ${String(cost)} 🪙` : (q.stock <= 0 ? 'Vypredané. Veľkoobchodník príde o pár dní.' : 'Nemáš dosť mincí. 🪙');
  return { n: got, cost, msg };
}

// Predaj po kusoch – každý predaný kus zníži cenu ďalšieho (trh sa nasycuje).
// Kvety sa predávajú od najstarších a cena sa násobí ich čerstvosťou.
export function sell(m: MarketPart, tick: number, sv: PlayerSave, id: string, n: number): { n: number; earned?: number; msg: string } {
  if (sellQuote(m, tick, id) == null || D.isTool(id)) return { n: 0, msg: 'Toto trh nevykupuje.' };
  if (!D.isItemId(id)) return { n: 0, msg: 'Nemáš čo predať.' };
  n = Math.min(n, sv.inv[id] || 0);
  if (!n) return { n: 0, msg: 'Nemáš čo predať.' };
  const batches = I.removeItems(I.playerC(sv), id, n, tick) || [];
  const sp = I.isFlower(id) ? D.speciesOfItem(id) : null;
  let earned = 0, fresh = 0;
  for (const b of batches) for (let i = 0; i < b.n; i++) {
    const f = sp ? D.freshness(sp, b.age) : 1;
    earned += Math.max(1, Math.round((sellQuote(m, tick, id) ?? 0) * f)); fresh += f;
    const st = stockOf(m, id);
    if (st) st.stock = Math.min(sp ? PRICING.flowerCap : SEED_CAP, st.stock + 1);
  }
  sv.coins += earned;
  const fr = sp && fresh / n < 0.97 ? ` (čerstvosť ${String(Math.round(fresh / n * 100))} %)` : '';
  return { n, earned, msg: `Predané: ${String(n)}× ${D.itemName(id)} za ${String(earned)} 🪙${fr}` };
}

// ---------- Inicializácia ----------
// Založí trh a nástenku v novom (alebo starom) svete. ctx: kontext nad živým svetom (E.liveCtx), pre náhodu zákaziek.
export function initEconomy(world: GameWorld, ctx?: GameCtx): void {
  const live = ctx || E.liveCtx(world, 'ekonomika');
  if (!world.market) {
    const se = season(world.tick);
    const m: Market = { seeds: {}, flowers: {}, compost: { stock: 15 }, hist: {}, news: [], festival: null, npcs: { jano: { coins: 300 }, fero: { coins: 400, hold: {} } } };
    for (const sp of PLANTABLE) {
      const ph = phase(sp, se);
      m.seeds[sp] = { stock: D.SPECIES[sp].strict ? 0 : ph === 'now' ? 10 : ph === 'next' ? 6 : 2 };
      m.flowers[sp] = { stock: 0 };
    }
    world.market = m;
    recordHistory(m, world.tick);
  }
  if (!world.contracts) { world.contracts = { list: [], nextId: 1 }; fillBoard(world.contracts, world.tick, maxRepOf(world.saves), live); }
}

function recordHistory(m: Market, tick: number): void {
  const push = (id: ItemId, v: number): void => { const h = m.hist[id] || (m.hist[id] = []); h.push(v); if (h.length > HIST_LEN) h.shift(); };
  for (const sp of PLANTABLE) { push(`seed_${sp}`, seedPrice(m, tick, sp)); push(`fl_${sp}`, flowerPrice(m, tick, sp)); }
  push('compost', compostPrice(m));
}

// Ráno na trhu (6:00): zákazníci počas noci rozkúpili časť kvetov; staré semienka mimo sezóny sa kazia; zápis cien.
export function dawnMarket(m: Market, tick: number): void {
  const se = season(tick);
  for (const sp of PLANTABLE) {
    const f = flowerOf(m, sp), s = seedOf(m, sp);
    f.stock = Math.floor(f.stock * PRICING.flowerOvernight);
    if (phase(sp, se) === 'off') s.stock = Math.floor(s.stock * PRICING.seedOffSeasonDecay);
  }
  recordHistory(m, tick);
}
// Ráno v kompostéroch hráčov (aj offline): každý dostane kompost podľa úrovne. Vráti kľúče hráčov, ktorým pribudol.
export function composters(saves: Partial<Record<PlayerKey, PlayerSave>>, tick: number): PlayerKey[] {
  const got: PlayerKey[] = [];
  for (const [key, sv] of entries(saves)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia spred vylepšení nemajú up
    const lvl = (sv.up && sv.up.composter) || 0;
    const n = must(D.UPGRADES.composter.levels[lvl]).v;
    if (n) { I.addItems(I.playerC(sv), 'compost', n, tick); got.push(key); }
  }
  return got;
}
// Ranná časť ekonomiky ako samostatný návrh (server ju volá zo svojho rána, testy a ladenie priamo).
export const DAWN: GameProposer<unknown> = {
  keys: () => ({ writes: ['market:*', 'save:*', 'contracts'], reads: ['maxRep'] }),
  run(s, d, ctx) {
    dawnMarket(sl(s, 'market:*'), ctx.tick);
    composters(sl(s, 'save:*'), ctx.tick);
    fillBoard(s.contracts, ctx.tick, s.maxRep || 0, ctx);
  }
};

// ---------- Udalosti: veľkoobchodník, NPC, sviatky ----------
// Periodické udalosti ekonomiky. Plánuje ich engine (E.reconcile), návrhy sa samy znova neplánujú.
// NPC prídu raz za deň medzi 8:00 a 18:00, najskôr pol dňa po predchádzajúcej návšteve.
const npcVisit = (from: number, g: Rng): number => E.nextDailyTick(from + TPD / 2, 8 * D.TICKS_PER_HOUR + g.int(10 * D.TICKS_PER_HOUR));
// Sviatok začína o 6:00 svojho dňa v roku; ohlásenie je 2 dni vopred, koniec po f.len dňoch.
export const festStartTick = (f: Pick<Festival, 'season' | 'day'>): number => (f.season * DPS + f.day - 1) * TPD + D.DAWN_TICK;
const yearly = (at: number): ((from: number) => number) => E.every(YEAR_DAYS * TPD, at);
export const PERIODIC: GamePeriodic[] = [
  { key: 'delivery', type: 'delivery', next: E.every(2 * TPD, 7 * D.TICKS_PER_HOUR) }, // každé 2 dni o 7:00
  ...['jano', 'fero', 'zuzka'].map(n => ({ key: 'npc_' + n, type: 'npc_' + n, next: npcVisit })),
  ...D.FESTIVALS.flatMap(f => [
    { key: 'festAnnounce:' + f.id, type: 'festAnnounce', data: { id: f.id }, next: yearly(festStartTick(f) - 2 * TPD) },
    { key: 'festStart:' + f.id, type: 'festStart', data: { id: f.id }, next: yearly(festStartTick(f)) },
    { key: 'festEnd:' + f.id, type: 'festEnd', data: { id: f.id }, next: yearly(festStartTick(f) + f.len * TPD) }
  ])
];

// Dáta udalostí ekonomiky (save.ts SavedEvent)
export interface EconInputs {
  delivery: null;
  npc_jano: null;
  jano_sell: { sp: SpeciesId; n: number };
  npc_fero: null;
  npc_zuzka: null;
  festAnnounce: { id: FestivalId };
  festStart: { id: FestivalId };
  festEnd: { id: FestivalId };
  cExpire: { id: number };
  cDue: { id: number };
}
const festival = (id: FestivalId): Festival => must(D.FESTIVALS.find(x => x.id === id));

// Návrhy udalostí ekonomiky: { keys, run } (pozri engine.js). Udalosti trhu deklarujú celý trh ('market:*'):
// sú to jednotky za deň; akcie hráčov (actions.js) deklarujú len položku tovaru (marketKey: market:seed_mak…).
// Správy hráčom idú cez ctx.emit – server ich pošle až po vykonaní návrhu; obnovu trhu a nástenky odvodí zo zapísaných kľúčov.
const market = { keys: () => ({ writes: ['market:*'] }) };
export const PROPOSERS: { [T in keyof EconInputs]: GameProposer<EconInputs[T]> } = {
  delivery: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), tick = ctx.tick, se = season(tick), dis = dayInSeason(tick), g = ctx.rng;
      let total = 0;
      for (const sp of PLANTABLE) {
        const ph = phase(sp, se);
        let q;
        if (D.SPECIES[sp].strict) q = ph === 'off' ? 0 : g.int(3);
        else if (ph === 'next') q = dis >= DPS - 1 ? 8 + g.int(6) : 4 + g.int(4);
        else if (ph === 'now') q = dis <= 1 ? 4 + g.int(4) : g.int(3);
        else q = g.int(2);
        const it = seedOf(m, sp);
        it.stock = Math.min(SEED_CAP, it.stock + q);
        total += q;
      }
      m.compost.stock = Math.min(COMPOST_CAP, m.compost.stock + 6 + g.int(5));
      news(m, tick, `🚚 Veľkoobchodník priviezol ${String(total)} vrecúšok semienok – hlavne na ďalšie obdobie.`);
    }
  },

  // Záhradník Jano: kúpi semienka s najlepším očakávaným ziskom za deň, vypestuje ich a kvety predá na trhu.
  npc_jano: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), tick = ctx.tick, se = season(tick), jano = m.npcs.jano, g = ctx.rng;
      const cands = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && seedOf(m, sp).stock >= 3 && phase(sp, se) !== 'off')
        .map(sp => { const sc = D.SPECIES[sp], p = seedPrice(m, tick, sp); return { sp, p, score: (sc.sell * 2 - p) / sc.days, cheap: p <= sc.seed * 1.25 }; })
        .filter(c => c.cheap && c.score > 0).sort((a, b) => b.score - a.score);
      const c = cands[0];
      if (c) {
        const k = Math.min(seedOf(m, c.sp).stock - 1, 2 + g.int(5), Math.floor(jano.coins / c.p));
        if (k > 0) {
          seedOf(m, c.sp).stock -= k; jano.coins -= k * c.p;
          const start = phase(c.sp, se) === 'now' ? tick : seasonStartTick(tick, 1);
          ctx.schedule(start + D.SPECIES[c.sp].days * TPD + g.int(TPD / 2), 'jano_sell', { sp: c.sp, n: k * 2 });
          news(m, tick, `🧑‍🌾 Záhradník Jano nakúpil ${String(k)}× semienka ${D.SPECIES[c.sp].name}.`);
        }
      }
    }
  },
  jano_sell: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*');
      const price = flowerPrice(m, ctx.tick, d.sp);
      flowerOf(m, d.sp).stock += d.n; m.npcs.jano.coins += Math.round(d.n * price * 0.8);
      news(m, ctx.tick, `🧑‍🌾 Jano priniesol na trh ${String(d.n)}× ${D.SPECIES[d.sp].name} – výkupná cena klesla.`);
    }
  },

  // Špekulant Fero: skupuje lacné semienka pred sezónou, v sezóne ich predá, keď je ich málo a sú drahé.
  npc_fero: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), tick = ctx.tick, se = season(tick), fero = m.npcs.fero, g = ctx.rng;
      for (const sp of keys(fero.hold)) {
        const base = D.SPECIES[sp].seed, p = seedPrice(m, tick, sp);
        if (p >= base * 1.5 || phase(sp, se) === 'off') {
          const n = fero.hold[sp] ?? 0, it = seedOf(m, sp);
          it.stock = Math.min(SEED_CAP, it.stock + n); fero.coins += n * p; delete fero.hold[sp];
          news(m, tick, `🎩 Špekulant Fero predal ${String(n)}× semienka ${D.SPECIES[sp].name} – keď boli najdrahšie.`);
        }
      }
      const held = entries(fero.hold).reduce((a, [, b]) => a + b, 0);
      if (held < 20) {
        const c = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && phase(sp, se) === 'next' && seedOf(m, sp).stock >= 8 && seedPrice(m, tick, sp) <= D.SPECIES[sp].seed * 1.05);
        if (c.length) {
          const sp = must(g.pick(c)), p = seedPrice(m, tick, sp);
          const k = Math.min(3 + g.int(4), seedOf(m, sp).stock - 3, Math.floor(fero.coins / p));
          if (k > 0) {
            seedOf(m, sp).stock -= k; fero.coins -= k * p; fero.hold[sp] = (fero.hold[sp] || 0) + k;
            news(m, tick, `🎩 Špekulant Fero skúpil ${String(k)}× semienka ${D.SPECIES[sp].name}. Tuší, že budú drahé…`);
          }
        }
      }
    }
  },

  // Kvetinárka Zuzka: vykupuje kvety z trhu (viac počas sviatkov) – trh sa tým uvoľňuje a ceny rastú.
  npc_zuzka: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*');
      let best: { sp: SpeciesId; k: number } | null = null, bought = 0;
      for (const sp of PLANTABLE) {
        const f = flowerOf(m, sp), st = f.stock;
        if (!st) continue;
        const fest = f.fest ? 3 : 0;
        const k = Math.min(st, Math.ceil(st * 0.3) + fest);
        f.stock -= k; bought += k;
        if (!best || k > best.k) best = { sp, k };
      }
      if (best && best.k >= 3) news(m, ctx.tick, `💐 Kvetinárka Zuzka vykúpila z trhu ${String(bought)} kvetov (najviac ${D.SPECIES[best.sp].name}).`);
    }
  },

  festAnnounce: {
    ...market,
    run(s, d, ctx) {
      const f = festival(d.id);
      const list = entries(f.mult).map(([sp, x]) => `${D.SPECIES[sp].name} ×${String(x).replace('.', ',')}`).join(', ');
      news(sl(s, 'market:*'), ctx.tick, `📅 O 2 dni: ${f.icon} ${f.name}! Výkupné ceny: ${list}.`);
      ctx.emit({ to: E.ALL, t: 'toast', text: `📅 O 2 dni bude ${f.icon} ${f.name} – kvetinárka bude platiť viac za: ${list}. Stihneš to vypestovať?`, kind: 'day' });
    }
  },
  // Sviatok: násobky do položiek kvetov (cena) a súhrn pre klienta (m.festival); naraz je najviac jeden sviatok.
  festStart: {
    ...market,
    run(s, d, ctx) {
      const f = festival(d.id), m = sl(s, 'market:*');
      m.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: ctx.tick + f.len * TPD };
      setFestival(m, f);
      news(m, ctx.tick, `${f.icon} Začína ${f.name}!`);
      ctx.emit({ to: E.ALL, t: 'toast', text: `${f.icon} Začína ${f.name}! Výkupné ceny vybraných kvetov sú vyššie.`, kind: 'magic' });
    }
  },
  festEnd: {
    ...market,
    run(s, d) { const m = sl(s, 'market:*'); if (m.festival && m.festival.id === d.id) { m.festival = null; setFestival(m, null); } }
  },

  // Zákazka, ktorú nikto nezobral, zmizne z nástenky
  cExpire: {
    keys: () => ({ writes: ['contracts'] }),
    run(s, d) {
      const c = s.contracts.list.find(x => x.id === d.id);
      if (c && !c.takenBy) s.contracts.list = s.contracts.list.filter(x => x !== c);
    }
  },
  // Termín zákazky: prepadne; kto ju mal, príde o reputáciu (a dostane časť za odovzdané kvety).
  // Reputácia klesá, preto sa najvyššia reputácia záhrady (maxRep) musí prepočítať zo všetkých uložení – návrh
  // preto deklaruje celú kolekciu uložení (kľúče sa nesmú prekrývať: 'save:*' a 'save:ana' naraz nejde).
  cDue: {
    keys(d, world) {
      const c = world.contracts && world.contracts.list.find(x => x.id === d.id);
      const who = c && c.takenBy && Object.hasOwn(world.saves, c.takenBy) ? c.takenBy : null;
      return who ? { writes: ['contracts', 'save:*', 'maxRep'] } : { writes: ['contracts'] };
    },
    run(s, d, ctx) {
      const c = s.contracts.list.find(x => x.id === d.id);
      if (!c) return;
      s.contracts.list = s.contracts.list.filter(x => x !== c);
      const saves = takenSaves(s, c), sv = saves && c.takenBy ? saves[c.takenBy] : undefined;
      if (!saves || !sv || !c.takenBy) return;
      const part = Math.round(c.got * D.SPECIES[c.sp].sell * 0.5);
      sv.coins += part; sv.rep = Math.max(0, (sv.rep || 0) - 5);
      s.maxRep = maxRepOf(saves);
      ctx.emit({ to: c.takenBy, t: 'toast', text: `⌛ Zákazka pre ${D.GIVERS[c.giver]} (${String(c.n)}× ${D.SPECIES[c.sp].name}) prepadla. −5 reputácie` + (part ? `, za ${String(c.got)} odovzdaných dostávaš ${String(part)} 🪙.` : '.'), kind: 'info' });
    }
  }
};
// Uloženia v návrhu cDue: deklaruje ich, len keď zákazku niekto mal (inak výrez v slices nie je)
function takenSaves(s: GameSlices, c: Contract): Partial<Record<PlayerKey, PlayerSave>> | undefined {
  return c.takenBy && 'save:*' in s ? sl(s, 'save:*') : undefined;
}

// ---------- Zákazky ----------
// Odvodené počítadlá sveta (aby návrhy nemuseli čítať všetky uloženia či políčka):
//   world.maxRep    – najvyššia reputácia medzi hráčmi (veľké zákazky od úrovne 2); udržiava každá zmena reputácie
//   world.plotsUsed – počet obrobených políčok záhrady; udržiava kopanie a zarovnanie (server.js)
export function maxRepOf(saves: Partial<Record<PlayerKey, PlayerSave>>): number { let m = 0; for (const [, sv] of entries(saves)) m = Math.max(m, sv.rep || 0); return m; }
export function plotsUsedOf(tiles: readonly Tile[]): number { let n = 0; for (const t of tiles) if (t.s) n++; return n; }

// Nová zákazka na nástenke c. Náhoda a plánovanie termínov cez ctx.
function genContract(c: Contracts, tick: number, kind: ContractKind, ctx: GameCtx): Contract {
  const se = season(tick), g = ctx.rng;
  const ok = (sp: SpeciesId): boolean => !D.SPECIES[sp].strict;
  // krátka zákazka len na kvet, ktorý sa stihne zasadiť teraz a vypestovať ešte v tomto období
  const daysLeft = DPS - dayInSeason(tick);
  const nowPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes(se) && D.SPECIES[sp].days <= daysLeft + 1);
  const nextPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes(nextSeason(se, 1)));
  let sp: SpeciesId, n: number, due: number, mult: number, rep: number, item: Contract['item'] = null;
  if (kind === 'long' && nextPool.length) {
    sp = must(g.pick(nextPool)); n = 5 + g.int(5);
    due = seasonStartTick(tick, 1) + (D.SPECIES[sp].days + 1 + g.int(2)) * TPD;
    mult = 1.8; rep = 10 + n;
  } else if (kind === 'big') {
    sp = must(g.pick(nowPool.length ? nowPool : nextPool)); n = 10 + g.int(6);
    due = tick + (Math.max(5, D.SPECIES[sp].days + 2) + g.int(3)) * TPD;
    mult = 2.3; rep = 25; item = must(g.pick<NonNullable<Contract['item']>>([{ id: 'seed_plesnivec', n: 2 }, { id: 'compost', n: 5 }, { id: 'seed_ruza', n: 3 }]));
  } else if (!nowPool.length) {
    return genContract(c, tick, 'long', ctx);
  } else {
    kind = 'short';
    sp = must(g.pick(nowPool)); n = 2 + g.int(3);
    due = tick + (D.SPECIES[sp].days + 1 + g.int(2)) * TPD;
    mult = 1.5; rep = 4 + n;
  }
  const giver: GiverId = must(g.pick(keys(D.GIVERS)));
  const k: Contract = {
    id: c.nextId++, kind, giver, sp, n, got: 0, reward: Math.round(n * D.SPECIES[sp].sell * mult), item, rep,
    posted: tick, openUntil: Math.min(due - TPD, tick + 2 * TPD), due, takenBy: null
  };
  c.list.push(k);
  ctx.scheduleUnique('cExpire:' + String(k.id), k.openUntil, 'cExpire', { id: k.id });
  ctx.scheduleUnique('cDue:' + String(k.id), k.due, 'cDue', { id: k.id });
  return k;
}

// Doplní nástenku na 4 voľné zákazky; veľké zákazky od chvíle, keď má niekto v záhrade reputáciu úrovne 2.
export function fillBoard(c: Contracts, tick: number, maxRep: number, ctx: GameCtx): void {
  const open = (): Contract[] => c.list.filter(x => !x.takenBy);
  const hasKind = (k: ContractKind): boolean => open().some(x => x.kind === k);
  let guard = 0;
  while (open().length < 4 && guard++ < 8) {
    const kind = !hasKind('long') ? 'long' : (D.repLevel(maxRep || 0) >= 2 && !hasKind('big')) ? 'big' : 'short';
    genContract(c, tick, kind, ctx);
  }
}

export function maxActive(sv: PlayerSave): number { return 1 + D.repLevel(sv.rep || 0); }

// Hráč key (uloženie sv) si berie zákazku id z nástenky c. Vráti chybu alebo null.
export function takeContract(c: Contracts, tick: number, sv: PlayerSave, key: PlayerKey, id: number): string | null {
  const k = c.list.find(x => x.id === id);
  if (!k || k.takenBy) return 'Túto zákazku už niekto zobral.';
  if (tick >= k.openUntil) return 'Na túto zákazku je už neskoro.';
  const active = c.list.filter(x => x.takenBy === key).length;
  if (active >= maxActive(sv)) return `Naraz môžeš mať len ${String(maxActive(sv))} ${maxActive(sv) === 1 ? 'zákazku' : 'zákazky'}. Vyššia reputácia ti dovolí viac.`;
  k.takenBy = key;
  return null;
}

// Odovzdanie aj po častiach; po splnení vyplatí odmenu a reputáciu a doplní nástenku.
// maxRep: doterajšia najvyššia reputácia záhrady; vráti { n: odovzdané kusy (0 = nič sa nestalo), msg, done, maxRep }.
export function deliverContract(c: Contracts, tick: number, sv: PlayerSave, key: PlayerKey, id: number, maxRep: number, ctx: GameCtx): { n: number; msg: string; done?: boolean; maxRep: number } {
  const k = c.list.find(x => x.id === id);
  if (!k || k.takenBy !== key) return { n: 0, msg: 'Táto zákazka nie je tvoja.', maxRep };
  const fl = `fl_${k.sp}` as const;
  const have = sv.inv[fl] || 0;
  const n = Math.min(have, k.n - k.got);
  if (!n) return { n: 0, msg: `Nemáš žiadny ${D.SPECIES[k.sp].name}.`, maxRep };
  I.removeItems(I.playerC(sv), fl, n, tick);
  k.got += n;
  let msg = `Odovzdané ${String(n)}× ${D.SPECIES[k.sp].name} (${String(k.got)}/${String(k.n)}).`, done = false;
  if (k.got >= k.n) {
    const lvlBefore = D.repLevel(sv.rep || 0);
    sv.coins += k.reward; sv.rep = (sv.rep || 0) + k.rep;
    maxRep = Math.max(maxRep || 0, sv.rep);
    if (k.item) I.addItems(I.playerC(sv), k.item.id, k.item.n, tick);
    c.list = c.list.filter(x => x !== k);
    ctx.cancel('cExpire:' + String(k.id)); ctx.cancel('cDue:' + String(k.id));
    msg = `✅ ${D.GIVERS[k.giver]}: „Ďakujem!“ Dostávaš ${String(k.reward)} 🪙` + (k.item ? ` a ${String(k.item.n)}× ${D.itemName(k.item.id)}` : '') + ` · +${String(k.rep)} reputácie.`;
    const lvl = D.repLevel(sv.rep);
    if (lvl > lvlBefore) msg += ` 🎉 Reputácia úroveň ${String(lvl)}!`;
    done = true;
    fillBoard(c, tick, maxRep, ctx);
  }
  return { n, msg, done, maxRep };
}

// ---------- Vylepšenia ----------
// Spoločné vylepšenia (shared – povolenie na pole) patria záhrade (world.up), platí ich hráč, ktorý ich kúpi.
type Levels = Partial<Record<UpgradeId, number>>;
function upgradeLevels(up: Levels, sv: PlayerSave, kind: UpgradeId): Levels {
  if (D.UPGRADES[kind].shared) return up;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia spred vylepšení nemajú up
  return (sv.up = sv.up || { can: 0, composter: 0 });
}
const isUpgradeId = (k: string): k is UpgradeId => k === 'can' || k === 'plots' || k === 'composter';
// up = spoločné vylepšenia záhrady (world.up), sv = uloženie hráča. Vráti chybu alebo null.
export function upgrade(up: { plots: number }, sv: PlayerSave, kind: string): string | null {
  if (!isUpgradeId(kind)) return 'Neznáme vylepšenie.';
  const u = D.UPGRADES[kind];
  const lv = upgradeLevels(up, sv, kind);
  const next = u.levels[(lv[kind] || 0) + 1];
  if (!next) return u.shared ? 'Záhrada už má najvyššiu úroveň.' : 'Už máš najvyššiu úroveň.';
  const rep = next.rep ?? 0, price = next.price ?? 0; // úrovne nad prvou majú cenu aj reputáciu vždy
  if (D.repLevel(sv.rep || 0) < rep) return `Potrebuješ reputáciu úrovne ${String(rep)}.`;
  if (sv.coins < price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= price;
  lv[kind] = (lv[kind] || 0) + 1;
  return null;
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia spred vylepšení nemajú up
export function canCap(sv: PlayerSave): number { return must(D.UPGRADES.can.levels[(sv.up && sv.up.can) || 0]).v; }
// Povolenie na pole celej záhrady (up = world.up); koľko je obrobené, drží počítadlo world.plotsUsed
export function plotLimit(up: { plots?: number } | null | undefined): number { return must(D.UPGRADES.plots.levels[(up && up.plots) || 0]).v; }

// Najbližší sviatok, ktorý ešte nezačal (#86): začiatok podľa naplánovanej udalosti festStart vo fronte events,
// inak vypočítaný z definície sviatku (ohlásenie festAnnounce nesie len id).
export function upcomingFestival(events: readonly EngineEvent[] | null | undefined, tick: number): UpcomingFestival | null {
  let best: UpcomingFestival | null = null;
  for (const f of D.FESTIVALS) {
    const ev = (events || []).find(e => e.type === 'festStart' && isRecord(e.data) && e.data['id'] === f.id);
    const start = ev ? ev.at : E.nextEvery(tick + 1, YEAR_DAYS * TPD, festStartTick(f));
    if (!best || start < best.start) best = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, len: f.len, start, end: start + f.len * TPD, announce: start - 2 * TPD, announced: false };
  }
  if (best) best.announced = tick >= best.announce;
  return best;
}

// ---------- Pohľad pre klienta ----------
export function marketView(m: Market, tick: number, events: readonly EngineEvent[] | null | undefined): Extract<ServerMessage, { t: 'market' }> {
  const seeds: Partial<Record<SpeciesId, MarketItemView>> = {}, flowers: Partial<Record<SpeciesId, MarketItemView>> = {};
  for (const sp of PLANTABLE) {
    seeds[sp] = { p: seedPrice(m, tick, sp), st: seedOf(m, sp).stock, h: m.hist[`seed_${sp}`] || [] };
    flowers[sp] = { p: flowerPrice(m, tick, sp), st: flowerOf(m, sp).stock, h: m.hist[`fl_${sp}`] || [] };
  }
  return {
    t: 'market', seeds, flowers, compost: { p: compostPrice(m), st: m.compost.stock, h: m.hist.compost || [] },
    festival: m.festival, upcoming: upcomingFestival(events, tick), news: m.news
  };
}
export function boardView(c: Contracts): Extract<ServerMessage, { t: 'board' }> { return { t: 'board', list: c.list }; }

// Počiatočné mince a reputácia nového hráča. V testovacích prostrediach (PR náhľady, dev) ich nastaví
// scripts/deploy.sh cez START_COINS a START_REP (úroveň reputácie); v produkcii platí chudobný začiatok.
export function startCapital(env: Readonly<Partial<Record<string, string>>>): { coins: number; rep: number } {
  const coins = Number.parseInt(env['START_COINS'] ?? '', 10), lvl = Number.parseInt(env['START_REP'] ?? '', 10);
  return {
    coins: coins >= 0 ? coins : 30,
    rep: lvl > 0 ? must(D.REP_LEVELS[Math.min(lvl, D.REP_LEVELS.length - 1)]) : 0
  };
}
