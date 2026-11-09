// Ladiaca stránka (#76): GET /api/debug/market?id=… – trh sveta s rozkladom cien.
// Počíta sa len na kópii stavu (tools.load); funkcie ekonomiky len čítajú, svet sa nikdy nezmení.
import * as D from '../../shared/data.ts';
import type { SpeciesId } from '../../shared/data.ts';
import type { Market } from '../../shared/save.ts';
import { isRecord } from '../../shared/util.ts';
import type { JsonRecord } from '../../shared/util.ts';
import * as Econ from '../economy.ts';
import type { EngineEvent } from '../engine.ts';
import type { Tools } from '../debug.ts';

const DPS = D.DAYS_PER_SEASON;
const MARKET_EVENTS = new Set(['delivery', 'npc_jano', 'npc_fero', 'npc_zuzka', 'jano_sell', 'festAnnounce', 'festStart', 'festEnd', 'cExpire', 'cDue']);
const spName = (sp: SpeciesId): string => D.SPECIES[sp].name;
// meno druhu z dát udalosti (neznámy druh ostane, ako je)
const nameOf = (sp: unknown): unknown => (typeof sp === 'string' && D.isSpeciesId(sp) ? D.SPECIES[sp].name : sp);
const festOf = (id: unknown): D.Festival | undefined => D.FESTIVALS.find(f => f.id === id);
const dataOf = (e: EngineEvent): JsonRecord => (isRecord(e.data) ? e.data : {});

// Popis udalosti po anglicky (mená kvetov zostanú slovenské ako v hre)
function describe(e: EngineEvent): string {
  const d = dataOf(e), f = d['id'] != null ? festOf(d['id']) : null;
  switch (e.type) {
    case 'delivery': return 'Wholesaler delivers seeds and compost';
    case 'npc_jano': return 'Jano may buy seeds to grow';
    case 'npc_fero': return 'Fero sells his hoard when prices are high, may buy cheap seeds';
    case 'npc_zuzka': return 'Zuzka buys flowers off the market';
    case 'jano_sell': return `Jano brings ${String(d['n'])}× ${String(nameOf(d['sp']))} to the market`;
    case 'festAnnounce': return f ? `${f.icon} ${f.name} announced (starts in 2 days)` : 'Festival announced';
    case 'festStart': return f ? `${f.icon} ${f.name} starts` : 'Festival starts';
    case 'festEnd': return f ? `${f.icon} ${f.name} ends` : 'Festival ends';
    case 'cExpire': return `Contract #${String(d['id'])} leaves the board if nobody took it`;
    case 'cDue': return `Contract #${String(d['id'])} is due`;
    default: return e.type;
  }
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- stav zo súboru (aj staré svety): časti trhu môžu chýbať */
// Rozklad cien trhu (typ odpovede sa odvodí odtiaľto)
function view(market: Market, w: { events?: EngineEvent[]; contracts?: Parameters<typeof Econ.boardView>[0] | null }, tick: number, events: EngineEvent[]) {
  const m = market, hist = m.hist || {}, contracts = w.contracts || { list: [] };
  const has = (sp: SpeciesId): boolean => !!(m.seeds[sp] && m.flowers[sp]);
  const seeds = Econ.PLANTABLE.filter(has).map(sp => {
    const parts = Econ.seedPriceParts(m, tick, sp);
    return {
      sp, name: spName(sp), seasons: D.SPECIES[sp].seasons, strict: !!D.SPECIES[sp].strict, days: D.SPECIES[sp].days,
      minRep: D.MIN_SEED_REP[sp] || 0, parts, price: parts.price, sellBack: Econ.sellQuote(m, tick, `seed_${sp}`), stock: parts.stock, hist: hist[`seed_${sp}`] || []
    };
  });
  const flowers = Econ.PLANTABLE.filter(has).map(sp => {
    const parts = Econ.flowerPriceParts(m, tick, sp);
    return { sp, name: spName(sp), seasons: D.SPECIES[sp].seasons, parts, price: parts.price, sellBack: Econ.sellQuote(m, tick, `fl_${sp}`), stock: parts.stock, hist: hist[`fl_${sp}`] || [] };
  });
  const cp = Econ.compostPriceParts(m);
  const compost = { parts: cp, price: cp.price, sellBack: Econ.sellQuote(m, tick, 'compost'), stock: cp.stock, hist: hist.compost || [] };

  // NPC: Jano (mince, čo pestuje), Fero (mince a zásoba semienok v dnešných cenách)
  const npcs: Partial<Market['npcs']> = m.npcs || {}, jano: Partial<Market['npcs']['jano']> = npcs.jano || {}, fero: Partial<Market['npcs']['fero']> = npcs.fero || {};
  const nextOf = (type: string): number | null => { const e = events.find(x => x.type === type); return e ? e.at : null; };
  const npcView = {
    jano: { coins: jano.coins, next: nextOf('npc_jano'), growing: events.filter(e => e.type === 'jano_sell').map(e => ({ at: e.at, sp: dataOf(e)['sp'], name: nameOf(dataOf(e)['sp']), n: dataOf(e)['n'] })) },
    fero: {
      coins: fero.coins, next: nextOf('npc_fero'),
      // zásoba podľa druhu (neznámy druh v starom uložení sa preskočí – v JS by výpočet ceny spadol)
      hold: Object.entries(fero.hold || {}).flatMap(([sp, n]) => {
        if (!D.isSpeciesId(sp) || n === undefined) return [];
        const p = m.seeds[sp] ? Econ.seedPrice(m, tick, sp) : null;
        return [{ sp, name: spName(sp), n, price: p, value: p == null ? null : p * n, sellsAt: D.SPECIES[sp].seed * 1.5 }];
      })
    },
    zuzka: { next: nextOf('npc_zuzka') }
  };
  const fest = m.festival;
  return {
    seeds, flowers, compost, npcs: npcView, nextDelivery: nextOf('delivery'),
    festival: fest ? { id: fest.id, name: fest.name, icon: fest.icon, mult: fest.mult, until: fest.until } : null,
    upcoming: Econ.upcomingFestival(w.events || [], tick),
    news: (m.news || []).slice(),
    events: events.map(e => ({ at: e.at, type: e.type, data: e.data, text: describe(e) })),
    contracts: (contracts.list || []).map(c => Object.assign({}, c, { name: spName(c.sp), giverName: D.GIVERS[c.giver] || c.giver, itemName: c.item ? D.itemName(c.item.id) : null }))
  };
}
export type MarketView = {
  id: string; source: 'memory' | 'file'; file: { size: number; saved: number } | null; online: number;
  tick: number; day: number; season: number; dayInSeason: number; daysPerSeason: number; constants: JsonRecord; market: boolean;
} & Partial<ReturnType<typeof view>>;

export default function market(query: URLSearchParams, tools: Pick<Tools, 'load'>): MarketView | null {
  const r = tools.load(query.get('id'));
  if (!r) return null;
  const w = r.state, tick = w.tick || 0, day = D.dayOfTick(tick), se = D.seasonOf(day);
  const events = (w.events || []).filter(e => MARKET_EVENTS.has(e.type)).sort((a, b) => a.at - b.at || a.seq - b.seq);
  const out: MarketView = {
    id: r.id, source: r.source, file: r.file, online: r.online.length,
    tick, day, season: se, dayInSeason: (day - 1) % DPS + 1, daysPerSeason: DPS,
    constants: Object.assign({}, Econ.PRICING, {
      SEED_TARGET: Econ.SEED_TARGET, COMPOST_TARGET: Econ.COMPOST_TARGET, SEED_CAP: Econ.SEED_CAP, COMPOST_CAP: Econ.COMPOST_CAP,
      HIST_LEN: Econ.HIST_LEN, MIN_SEED_REP: D.MIN_SEED_REP, REP_LEVELS: D.REP_LEVELS
    }),
    market: !!w.market
  };
  if (!w.market) return out; // starý svet, kde sa trh ešte nezaložil (založí sa pri načítaní)
  // Ekonomika číta len trh a čas. Stav je kópia, no aj tak sa nič nezapisuje.
  return Object.assign(out, view(w.market, w, tick, events));
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition -- koniec trhu zo súboru */
