// Ekonomika: živý trh (zásoby + ceny podľa ponuky a dopytu), NPC obchodníci, sviatky, zákazky a vylepšenia.
// Všetko, čo sa deje v čase, je udalosť v plánovači (engine.js) a celý stav je v world.market / world.contracts.
// Funkcie nedostávajú svet, ale výrezy (slices), s ktorými pracujú: m = trh (world.market alebo jeho kópia z návrhu),
// c = nástenka zákaziek (world.contracts), sv = uloženie hráča, tick = herný čas; náhoda a plánovanie cez ctx (engine.js).
import * as D from '../shared/data.ts';
import type { Festival, FestivalId, GiverId, ItemId, SpeciesId, UpgradeId } from '../shared/data.ts';
import type { MarketItemView, ServerMessage, UpcomingFestival } from '../shared/protocol.ts';
import type { Contract, ContractKind, Contracts, Market, PlayerKey, PlayerSave } from '../shared/save.ts';
import { entries, isRecord, keys, must } from '../shared/util.ts';
import * as E from './engine.ts';
import type { EngineEvent } from './engine.ts';
import { maybe, savesOf, sl } from './game.ts';
import type { GameCtx, GamePeriodic, GameProposer, GameSlices, GameWorld } from './game.ts';
import * as I from './items.ts';
import * as Book from './orderbook.ts';
import type { Rng, Tile } from './world.ts';

import { news, PLANTABLE, SEED_CAP, COMPOST_CAP, HIST_LEN, PRICING, YEAR_DAYS, phase, seedOf, flowerOf, seedPrice, compostPrice, flowerPrice, setFestival, season, nextSeason, dayInSeason, seasonStartTick } from './pricing.ts';
export * from './pricing.ts';
const TPD = D.TICKS_PER_DAY, DPS = D.DAYS_PER_SEASON;
// Priame rozhranie pre simulácie a ladenie používa ten istý návrh a vyrovnanie ako hráčske akcie.
export function buy(m: Market, tick: number, sv: PlayerSave, id: string, n: number): { n: number; cost: number; msg: string } {
  const r = Book.trade(m, tick, sv, id, n, 'buy'); return { n: r.n, cost: r.coins, msg: r.msg };
}
export function sell(m: Market, tick: number, sv: PlayerSave, id: string, n: number): { n: number; earned: number; msg: string } {
  const r = Book.trade(m, tick, sv, id, n, 'sell'); return { n: r.n, earned: r.coins, msg: r.msg };
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
  Book.init(world.market, world.tick);
  Book.bootstrap(world);
  if (!world.contracts) { world.contracts = { list: [], nextId: 1 }; fillBoard(world.contracts, world.tick, maxRepOf(savesOf(world)), live); }
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
export const DAWN: Required<GameProposer<unknown>> = {
  settle: Book.settle,
  keys: () => ({ writes: ['market:*', 'save:*', 'contracts'], reads: ['maxRep'] }),
  run(s, d, ctx) {
    const m = sl(s, 'market:*');
    const a = m.book?.accounts.wholesale;
    dawnMarket(m, ctx.tick);
    if (a) for (const sp of PLANTABLE) {
      const flower = `fl_${sp}` as const, seed = `seed_${sp}` as const;
      const c = { inv: a.inv, fb: a.fb, rate: 1 };
      const flowers = Book.owned(m, flower), seeds = Book.owned(m, seed);
      const consumed = flowers - Math.floor(flowers * PRICING.flowerOvernight);
      if (consumed) Book.consume(m, flower, consumed, ctx);
      if (phase(sp, season(ctx.tick)) === 'off') { const spoiled = seeds - Math.floor(seeds * PRICING.seedOffSeasonDecay); if (spoiled) Book.consume(m, seed, spoiled, ctx); }
      I.wiltSweep(c, ctx.tick); I.meltSweep(c, ctx.tick);
    }
    Book.fund(m);
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
const market = { settle: Book.settle, keys: () => ({ writes: ['market:*'] }) };
export const PROPOSERS: { [T in keyof EconInputs]: GameProposer<EconInputs[T]> } & typeof Book.PROPOSERS = {
  ...Book.PROPOSERS,
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
        Book.deliver(m, `seed_${sp}`, Math.max(0, Math.min(q, SEED_CAP - Book.owned(m, `seed_${sp}`))), tick);
        total += q;
      }
      Book.deliver(m, 'compost', Math.max(0, Math.min(6 + g.int(5), COMPOST_CAP - Book.owned(m, 'compost'))), tick);
      news(m, tick, `🚚 Veľkoobchodník priviezol ${String(total)} vrecúšok semienok – hlavne na ďalšie obdobie.`);
    }
  },

  // Záhradník Jano: kúpi semienka s najlepším očakávaným ziskom za deň, vypestuje ich a kvety predá na trhu.
  npc_jano: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), tick = ctx.tick, se = season(tick);
      Book.cancelNpc(m, 'jano', ctx);
      const cands = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && phase(sp, se) !== 'off')
        .map(sp => { const sc = D.SPECIES[sp], p = Math.min(seedPrice(m, tick, sp), Math.floor(sc.seed * 1.25)); return { sp, p, score: (sc.sell * 2 - p) / sc.days }; })
        .filter(c => c.p <= D.SPECIES[c.sp].seed * 1.25 && c.score > 0).sort((a, b) => b.score - a.score);
      const c = cands[0];
      if (c) Book.npcOrder(m, 'jano', `seed_${c.sp}`, 'buy', c.p, 2 + ctx.rng.int(5), ctx);
      for (const sp of PLANTABLE) { const n = m.book?.accounts.jano.inv[`fl_${sp}`] || 0; if (n) Book.npcOrder(m, 'jano', `fl_${sp}`, 'sell', Math.max(1, Math.round(flowerPrice(m, tick, sp) * 0.8)), n, ctx, 20 + PLANTABLE.indexOf(sp)); }

    }
  },
  jano_sell: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), a = must(m.book).accounts.jano, id = `fl_${d.sp}` as const;
      I.addItems({ inv: a.inv, fb: a.fb, rate: 1 }, id, d.n, ctx.tick);
      Book.npcOrder(m, 'jano', id, 'sell', Math.max(1, Math.round(flowerPrice(m, ctx.tick, d.sp) * 0.8)), d.n, ctx);
      news(m, ctx.tick, `🧑‍🌾 Jano ponúka ${d.n}× ${D.SPECIES[d.sp].name}.`);
    }
  },

  // Špekulant Fero: skupuje lacné semienka pred sezónou, v sezóne ich predá, keď je ich málo a sú drahé.
  npc_fero: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*'), tick = ctx.tick, se = season(tick);
      Book.cancelNpc(m, 'fero', ctx);
      const a = must(m.book).accounts.fero;
      for (const sp of PLANTABLE) {
        const n = a.inv[`seed_${sp}`] || 0, p = seedPrice(m, tick, sp);
        if (n && (p >= D.SPECIES[sp].seed * 1.5 || phase(sp, se) === 'off')) Book.npcOrder(m, 'fero', `seed_${sp}`, 'sell', p, n, ctx, PLANTABLE.indexOf(sp));
      }
      const held = Object.values(a.inv).reduce((n, k) => n + (k || 0), 0);
      if (held < 20) {
        const c = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && phase(sp, se) === 'next' && seedPrice(m, tick, sp) <= D.SPECIES[sp].seed * 1.05);
        const sp = ctx.rng.pick(c);
        if (sp) Book.npcOrder(m, 'fero', `seed_${sp}`, 'buy', seedPrice(m, tick, sp), Math.min(20 - held, 3 + ctx.rng.int(4)), ctx, 30);
      }
    }
  },

  // Kvetinárka Zuzka: vykupuje kvety z trhu (viac počas sviatkov) – trh sa tým uvoľňuje a ceny rastú.
  npc_zuzka: {
    ...market,
    run(s, d, ctx) {
      const m = sl(s, 'market:*');
      Book.cancelNpc(m, 'zuzka', ctx);
      const demand = zuzkaDemand(m, ctx.tick);
      for (const [i, { sp, stock, fest }] of demand.entries()) {
        const n = Math.max(1, Math.ceil(stock * 0.3)) + (fest ? 3 : 0);
        Book.npcOrder(m, 'zuzka', `fl_${sp}`, 'buy', Math.ceil(flowerPrice(m, ctx.tick, sp) * 1.25), n, ctx, i);
      }
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
      const who = c && c.takenBy && Object.hasOwn(savesOf(world), c.takenBy) ? c.takenBy : null;
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
  return c.takenBy ? maybe(s, 'save:*') : undefined;
}

function zuzkaDemand(m: Market, tick: number): { sp: SpeciesId; stock: number; fest: number }[] {
  const book = Book.levels(m, tick);
  return PLANTABLE.map(sp => ({ sp, stock: book.filter(o => o.item === `fl_${sp}` && o.side === 'sell').reduce((n, o) => n + o.remaining, 0), fest: m.flowers[sp]?.fest || 0 }))
    .sort((a, b) => b.fest - a.fest || b.stock - a.stock || PLANTABLE.indexOf(a.sp) - PLANTABLE.indexOf(b.sp));
}

// ---------- Zákazky ----------
// Odvodené počítadlá sveta (aby návrhy nemuseli čítať všetky uloženia či políčka):
//   world.maxRep    – najvyššia reputácia medzi hráčmi (veľké zákazky od úrovne 2); udržiava každá zmena reputácie
//   world.plotsUsed – počet obrobených políčok záhrady; udržiava kopanie a zarovnanie (server.ts)
export function maxRepOf(saves: Partial<Record<PlayerKey, PlayerSave>>): number { let m = 0; for (const [, sv] of entries(saves)) m = Math.max(m, sv.rep || 0); return m; }
export function plotsUsedOf(tiles: readonly Tile[]): number { let n = 0; for (const t of tiles) if (t.s) n++; return n; }

// Nová zákazka na nástenke c. Náhoda a plánovanie termínov cez ctx.
function genContract(c: Contracts, tick: number, kind: ContractKind, ctx: E.Scheduler): Contract {
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
export function fillBoard(c: Contracts, tick: number, maxRep: number, ctx: E.Scheduler): void {
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
export function deliverContract(c: Contracts, tick: number, sv: PlayerSave, key: PlayerKey, id: number, maxRep: number, ctx: E.Scheduler): { n: number; msg: string; done?: boolean; maxRep: number } {
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
export const isUpgradeId = (k: string): k is UpgradeId => k === 'can' || k === 'plots' || k === 'composter';
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
    t: 'market', book: Book.levels(m, tick), seeds, flowers, compost: { p: compostPrice(m), st: m.compost.stock, h: m.hist.compost || [] },
    festival: m.festival, upcoming: upcomingFestival(events, tick), news: [...m.news, ...Object.values(m.book?.trades || {}).flatMap(list => list)].sort((a, b) => b.tick - a.tick).slice(0, 14)
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
