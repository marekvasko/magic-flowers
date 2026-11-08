// Ekonomika: živý trh (zásoby + ceny podľa ponuky a dopytu), NPC obchodníci, sviatky, zákazky a vylepšenia.
// Všetko, čo sa deje v čase, je udalosť v plánovači (engine.js) a celý stav je v world.market / world.contracts.
// Funkcie nedostávajú svet, ale výrezy (slices), s ktorými pracujú: m = trh (world.market alebo jeho kópia z návrhu),
// c = nástenka zákaziek (world.contracts), sv = uloženie hráča, tick = herný čas; náhoda a plánovanie cez ctx (engine.js).
const D = require('../shared/data.js');
const E = require('./engine.js');
const I = require('./items.js');

const TPD = D.TICKS_PER_DAY, DPS = D.DAYS_PER_SEASON, YEAR_DAYS = 4 * DPS;
const PLANTABLE = Object.keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
const SEED_TARGET = 10, COMPOST_TARGET = 15, HIST_LEN = 16;
const SEED_CAP = 40, COMPOST_CAP = 30;
// Koeficienty cien (exportované aj pre ladiacu stránku, aby vysvetlenie sedelo s hrou)
const PRICING = {
  seedDemand: { now: 1.35, next: 1.0, off: 0.8 }, // dopyt po semienkach podľa toho, kedy sa druh sadí
  seedScarcity: [0.75, 3], seedMin: 2,              // vzácnosť sqrt(SEED_TARGET / zásoba) v medziach, najnižšia cena
  seedSellBack: 0.4,                                // výkup semienok = 40 % predajnej ceny
  compostBase: 15, compostScarcity: [0.7, 3], compostMin: 5, compostSellBack: 0.5,
  flowerOffSeason: 1.6,                             // kvet mimo svojej sezóny je vzácnejší
  flowerSat: { start: 1.3, perUnit: 0.06, min: 0.35 }, // nasýtenie trhu: 1,3 − 0,06 × zásoba, najmenej 0,35
  flowerMin: 1, flowerCap: 99,
  flowerOvernight: 0.6, seedOffSeasonDecay: 0.9     // každé ráno: zostane 60 % kvetov, 90 % semienok mimo sezóny
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const day = tick => D.dayOfTick(tick);
const season = tick => D.seasonOf(day(tick));
const dayInSeason = tick => (day(tick) - 1) % DPS + 1;
// Kedy sa druh sadí vzhľadom na aktuálne obdobie: teraz / v ďalšom období / mimo
function phase(sp, se) {
  const s = D.SPECIES[sp].seasons;
  if (s.includes(se)) return 'now';
  if (s.includes((se + 1) % 4)) return 'next';
  return 'off';
}
// Krok, ktorým začína obdobie posunuté o `offset` období od aktuálneho
function seasonStartTick(tick, offset) { return (Math.floor((day(tick) - 1) / DPS) + offset) * DPS * TPD; }

// Správa na trhovisku (najnovšia prvá, najviac 14)
function news(m, tick, text) {
  m.news.unshift({ tick, text });
  if (m.news.length > 14) m.news.length = 14;
}

// ---------- Ceny ----------
// Každá cena sa skladá z činiteľov; *PriceParts vrátia všetky (pre ladiacu stránku) aj výslednú cenu,
// takže vysvetlenie sa nemôže rozísť s hrou. Funkcie len čítajú stav, nič nemenia.
function seedPriceParts(m, tick, sp) {
  const P = PRICING, base = D.SPECIES[sp].seed, stock = m.seeds[sp].stock;
  const se = season(tick), ph = phase(sp, se);
  const demand = P.seedDemand[ph];
  const scarcityRaw = Math.sqrt(SEED_TARGET / Math.max(1, stock));
  const scarcity = clamp(scarcityRaw, P.seedScarcity[0], P.seedScarcity[1]);
  const raw = base * demand * scarcity;
  return { base, stock, season: se, phase: ph, demand, scarcityRaw, scarcity, raw, min: P.seedMin, price: Math.max(P.seedMin, Math.round(raw)) };
}
function seedPrice(m, tick, sp) { return seedPriceParts(m, tick, sp).price; }
function compostPriceParts(m) {
  const P = PRICING, base = P.compostBase, stock = m.compost.stock;
  const scarcityRaw = Math.sqrt(COMPOST_TARGET / Math.max(1, stock));
  const scarcity = clamp(scarcityRaw, P.compostScarcity[0], P.compostScarcity[1]);
  const raw = base * scarcity;
  return { base, stock, scarcityRaw, scarcity, raw, min: P.compostMin, price: Math.max(P.compostMin, Math.round(raw)) };
}
function compostPrice(m) { return compostPriceParts(m).price; }
// Výkupná cena kvetu: mimo sezóny vzácnejší, počas sviatku vyšší dopyt, plný trh cenu tlačí dole.
// Sviatočný násobok je v položke kvetu (m.flowers[sp].fest, píšu ho festStart/festEnd), takže predaj kvetu
// potrebuje len výrez 'market:fl_<sp>'; m.festival je iba súhrn pre klienta (id, meno, ikona, násobky, dokedy).
function flowerPriceParts(m, tick, sp) {
  const P = PRICING, s = D.SPECIES[sp], base = s.sell, f = m.flowers[sp], stock = f.stock, se = season(tick);
  const inSeason = s.seasons.includes(se);
  const rare = inSeason ? 1 : P.flowerOffSeason;
  const fest = f.fest || 1;
  const satRaw = P.flowerSat.start - P.flowerSat.perUnit * stock;
  const sat = Math.max(P.flowerSat.min, satRaw);
  const raw = base * rare * fest * sat;
  return { base, stock, season: se, inSeason, rare, fest, festival: fest !== 1 && m.festival ? m.festival.id : null, satRaw, sat, raw, min: P.flowerMin, price: Math.max(P.flowerMin, Math.round(raw)) };
}
// Sviatok v položkách kvetov: zmaže staré násobky a zapíše násobky sviatku f (null = žiadny sviatok).
function setFestival(m, f) {
  for (const sp in m.flowers) delete m.flowers[sp].fest;
  if (f) for (const sp in f.mult) if (m.flowers[sp]) m.flowers[sp].fest = f.mult[sp];
}
// Pri načítaní: násobky v položkách kvetov sa odvodia zo súhrnu (staršie uloženia ich nemajú; bez zmeny verzie uloženia).
function syncFestival(m) { if (m) setFestival(m, m.festival); }
function flowerPrice(m, tick, sp) { return flowerPriceParts(m, tick, sp).price; }
// Cena, za ktorú trh od hráča vykúpi 1 kus (null = nevykupuje)
function sellQuote(m, tick, id) {
  if (id.startsWith('fl_')) { const sp = id.slice(3); return m.flowers && m.flowers[sp] ? flowerPrice(m, tick, sp) : null; }
  if (id.startsWith('seed_')) { const sp = id.slice(5); return m.seeds && m.seeds[sp] ? Math.max(1, Math.round(seedPrice(m, tick, sp) * PRICING.seedSellBack)) : D.sellPrice(id); }
  if (id === 'compost') return Math.max(1, Math.round(compostPrice(m) * PRICING.compostSellBack));
  if (id.startsWith('po_') || id === 'wilted') return D.sellPrice(id);
  if (id === 'ice') return D.ICE_PRICE[season(tick)]; // v lete drahý, v zime takmer zadarmo
  return null;
}
function buyQuote(m, tick, id) {
  if (id === 'compost') return { price: compostPrice(m), stock: m.compost.stock };
  if (id.startsWith('seed_') && m.seeds[id.slice(5)]) { const sp = id.slice(5); return { price: seedPrice(m, tick, sp), stock: m.seeds[sp].stock }; }
  return null;
}
function stockOf(m, id) {
  if (id === 'compost') return m.compost;
  if (id.startsWith('seed_')) return m.seeds[id.slice(5)];
  if (id.startsWith('fl_')) return m.flowers[id.slice(3)];
  return null;
}
// Kľúč výrezu trhu, ktorý nákup či predaj tovaru id potrebuje ('market:seed_mak', 'market:fl_mak', 'market:compost'),
// alebo null – elixíry, zvädnuté kvety a ľad majú pevné ceny a trh sa nemení.
function marketKey(id) {
  if (id === 'compost') return 'market:compost';
  if (id.startsWith('seed_') && PLANTABLE.includes(id.slice(5))) return 'market:seed_' + id.slice(5);
  if (id.startsWith('fl_') && PLANTABLE.includes(id.slice(3))) return 'market:fl_' + id.slice(3);
  return null;
}
// Čiastočný trh z výrezov návrhu: len položka tovaru id (buy/sell/sellQuote sa jej držia), ostatné kolekcie prázdne.
function marketSlice(slices, id) {
  const m = { seeds: {}, flowers: {}, compost: null }, key = marketKey(id);
  if (key) {
    const v = slices[key];
    if (id === 'compost') m.compost = v; else if (id.startsWith('seed_')) m.seeds[id.slice(5)] = v; else m.flowers[id.slice(3)] = v;
  }
  return m;
}

// Nákup po kusoch – každý kus zvýši cenu ďalšieho (ubúda zásoba).
function buy(m, tick, sv, id, n) {
  const q = buyQuote(m, tick, id);
  if (!q) return { n: 0, msg: 'Toto sa na trhu nepredáva.' };
  const sp = id.startsWith('seed_') ? id.slice(5) : null;
  if (sp && D.MIN_SEED_REP[sp] && D.repLevel(sv.rep || 0) < D.MIN_SEED_REP[sp]) return { n: 0, msg: `Veľkoobchodník predáva ${D.SPECIES[sp].name} len záhradníkom s reputáciou ${D.MIN_SEED_REP[sp]}.` };
  let got = 0, cost = 0;
  while (got < n) {
    const cur = buyQuote(m, tick, id);
    if (cur.stock <= 0) break;
    if (sv.coins < cur.price) break;
    sv.coins -= cur.price; cost += cur.price; stockOf(m, id).stock--; got++;
  }
  if (got) I.addItems(I.playerC(sv), id, got, tick);
  const msg = got ? `Kúpené: ${got}× ${D.itemName(id)} za ${cost} 🪙` : (q.stock <= 0 ? 'Vypredané. Veľkoobchodník príde o pár dní.' : 'Nemáš dosť mincí. 🪙');
  return { n: got, cost, msg };
}

// Predaj po kusoch – každý predaný kus zníži cenu ďalšieho (trh sa nasycuje).
// Kvety sa predávajú od najstarších a cena sa násobí ich čerstvosťou.
function sell(m, tick, sv, id, n) {
  if (sellQuote(m, tick, id) == null || D.isTool(id)) return { n: 0, msg: 'Toto trh nevykupuje.' };
  n = Math.min(n, sv.inv[id] || 0);
  if (!n) return { n: 0, msg: 'Nemáš čo predať.' };
  const batches = I.removeItems(I.playerC(sv), id, n, tick);
  const sp = I.isFlower(id) ? id.slice(3) : null;
  let earned = 0, fresh = 0;
  for (const b of batches) for (let i = 0; i < b.n; i++) {
    const f = sp ? D.freshness(sp, b.age) : 1;
    earned += Math.max(1, Math.round(sellQuote(m, tick, id) * f)); fresh += f;
    const st = stockOf(m, id);
    if (st) st.stock = Math.min(sp ? PRICING.flowerCap : SEED_CAP, st.stock + 1);
  }
  sv.coins += earned;
  const fr = sp && fresh / n < 0.97 ? ` (čerstvosť ${Math.round(fresh / n * 100)} %)` : '';
  return { n, earned, msg: `Predané: ${n}× ${D.itemName(id)} za ${earned} 🪙${fr}` };
}

// ---------- Inicializácia ----------
// Založí trh a nástenku v novom (alebo starom) svete. ctx: kontext nad živým svetom (E.liveCtx), pre náhodu zákaziek.
function initEconomy(world, ctx) {
  ctx = ctx || E.liveCtx(world, 'ekonomika');
  if (!world.market) {
    const se = season(world.tick);
    const m = { seeds: {}, flowers: {}, compost: { stock: 15 }, hist: {}, news: [], festival: null, npcs: { jano: { coins: 300 }, fero: { coins: 400, hold: {} } } };
    for (const sp of PLANTABLE) {
      const ph = phase(sp, se);
      m.seeds[sp] = { stock: D.SPECIES[sp].strict ? 0 : ph === 'now' ? 10 : ph === 'next' ? 6 : 2 };
      m.flowers[sp] = { stock: 0 };
    }
    world.market = m;
    recordHistory(m, world.tick);
  }
  if (!world.contracts) { world.contracts = { list: [], nextId: 1 }; fillBoard(world.contracts, world.tick, maxRepOf(world.saves || {}), ctx); }
}

function recordHistory(m, tick) {
  const push = (id, v) => { const h = m.hist[id] || (m.hist[id] = []); h.push(v); if (h.length > HIST_LEN) h.shift(); };
  for (const sp of PLANTABLE) { push('seed_' + sp, seedPrice(m, tick, sp)); push('fl_' + sp, flowerPrice(m, tick, sp)); }
  push('compost', compostPrice(m));
}

// Ráno na trhu (6:00): zákazníci počas noci rozkúpili časť kvetov; staré semienka mimo sezóny sa kazia; zápis cien.
function dawnMarket(m, tick) {
  const se = season(tick);
  for (const sp of PLANTABLE) {
    m.flowers[sp].stock = Math.floor(m.flowers[sp].stock * PRICING.flowerOvernight);
    if (phase(sp, se) === 'off') m.seeds[sp].stock = Math.floor(m.seeds[sp].stock * PRICING.seedOffSeasonDecay);
  }
  recordHistory(m, tick);
}
// Ráno v kompostéroch hráčov (aj offline): každý dostane kompost podľa úrovne. Vráti kľúče hráčov, ktorým pribudol.
function composters(saves, tick) {
  const got = [];
  for (const key in saves) {
    const sv = saves[key], lvl = (sv.up && sv.up.composter) || 0;
    const n = D.UPGRADES.composter.levels[lvl].v;
    if (n) { I.addItems(I.playerC(sv), 'compost', n, tick); got.push(key); }
  }
  return got;
}
// Ranná časť ekonomiky ako samostatný návrh (server ju volá zo svojho rána, testy a ladenie priamo).
const DAWN = {
  keys: () => ({ writes: ['market:*', 'save:*', 'contracts'], reads: ['maxRep'] }),
  run(s, d, ctx) {
    dawnMarket(s['market:*'], ctx.tick);
    composters(s['save:*'], ctx.tick);
    fillBoard(s.contracts, ctx.tick, s.maxRep || 0, ctx);
  }
};

// ---------- Udalosti: veľkoobchodník, NPC, sviatky ----------
// Periodické udalosti ekonomiky. Plánuje ich engine (E.reconcile), návrhy sa samy znova neplánujú.
// NPC prídu raz za deň medzi 8:00 a 18:00, najskôr pol dňa po predchádzajúcej návšteve.
const npcVisit = (from, g) => E.nextDailyTick(from + TPD / 2, 8 * D.TICKS_PER_HOUR + g.int(10 * D.TICKS_PER_HOUR));
// Sviatok začína o 6:00 svojho dňa v roku; ohlásenie je 2 dni vopred, koniec po f.len dňoch.
const festStartTick = f => (f.season * DPS + f.day - 1) * TPD + D.DAWN_TICK;
const yearly = at => E.every(YEAR_DAYS * TPD, at);
const PERIODIC = [
  { key: 'delivery', type: 'delivery', next: E.every(2 * TPD, 7 * D.TICKS_PER_HOUR) }, // každé 2 dni o 7:00
  ...['jano', 'fero', 'zuzka'].map(n => ({ key: 'npc_' + n, type: 'npc_' + n, next: npcVisit })),
  ...D.FESTIVALS.flatMap(f => [
    { key: 'festAnnounce:' + f.id, type: 'festAnnounce', data: { id: f.id }, next: yearly(festStartTick(f) - 2 * TPD) },
    { key: 'festStart:' + f.id, type: 'festStart', data: { id: f.id }, next: yearly(festStartTick(f)) },
    { key: 'festEnd:' + f.id, type: 'festEnd', data: { id: f.id }, next: yearly(festStartTick(f) + f.len * TPD) }
  ])
];

// Návrhy udalostí ekonomiky: { keys, run } (pozri engine.js). Udalosti trhu deklarujú celý trh ('market:*'):
// sú to jednotky za deň; akcie hráčov (actions.js) deklarujú len položku tovaru (marketKey: market:seed_mak…).
// Správy hráčom idú cez ctx.emit – server ich pošle až po vykonaní návrhu; obnovu trhu a nástenky odvodí zo zapísaných kľúčov.
const market = { keys: () => ({ writes: ['market:*'] }) };
const PROPOSERS = {
  delivery: Object.assign({}, market, {
    run(s, d, ctx) {
      const m = s['market:*'], tick = ctx.tick, se = season(tick), dis = dayInSeason(tick), g = ctx.rng;
      let total = 0;
      for (const sp of PLANTABLE) {
        const ph = phase(sp, se);
        let q;
        if (D.SPECIES[sp].strict) q = ph === 'off' ? 0 : g.int(3);
        else if (ph === 'next') q = dis >= DPS - 1 ? 8 + g.int(6) : 4 + g.int(4);
        else if (ph === 'now') q = dis <= 1 ? 4 + g.int(4) : g.int(3);
        else q = g.int(2);
        m.seeds[sp].stock = Math.min(SEED_CAP, m.seeds[sp].stock + q);
        total += q;
      }
      m.compost.stock = Math.min(COMPOST_CAP, m.compost.stock + 6 + g.int(5));
      news(m, tick, `🚚 Veľkoobchodník priviezol ${total} vrecúšok semienok – hlavne na ďalšie obdobie.`);
    }
  }),

  // Záhradník Jano: kúpi semienka s najlepším očakávaným ziskom za deň, vypestuje ich a kvety predá na trhu.
  npc_jano: Object.assign({}, market, {
    run(s, d, ctx) {
      const m = s['market:*'], tick = ctx.tick, se = season(tick), jano = m.npcs.jano, g = ctx.rng;
      const cands = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && m.seeds[sp].stock >= 3 && phase(sp, se) !== 'off')
        .map(sp => { const sc = D.SPECIES[sp], p = seedPrice(m, tick, sp); return { sp, p, score: (sc.sell * 2 - p) / sc.days, cheap: p <= sc.seed * 1.25 }; })
        .filter(c => c.cheap && c.score > 0).sort((a, b) => b.score - a.score);
      const c = cands[0];
      if (c) {
        const k = Math.min(m.seeds[c.sp].stock - 1, 2 + g.int(5), Math.floor(jano.coins / c.p));
        if (k > 0) {
          m.seeds[c.sp].stock -= k; jano.coins -= k * c.p;
          const start = phase(c.sp, se) === 'now' ? tick : seasonStartTick(tick, 1);
          ctx.schedule(start + D.SPECIES[c.sp].days * TPD + g.int(TPD / 2), 'jano_sell', { sp: c.sp, n: k * 2 });
          news(m, tick, `🧑‍🌾 Záhradník Jano nakúpil ${k}× semienka ${D.SPECIES[c.sp].name}.`);
        }
      }
    }
  }),
  jano_sell: Object.assign({}, market, {
    run(s, d, ctx) {
      const m = s['market:*'];
      const price = flowerPrice(m, ctx.tick, d.sp);
      m.flowers[d.sp].stock += d.n; m.npcs.jano.coins += Math.round(d.n * price * 0.8);
      news(m, ctx.tick, `🧑‍🌾 Jano priniesol na trh ${d.n}× ${D.SPECIES[d.sp].name} – výkupná cena klesla.`);
    }
  }),

  // Špekulant Fero: skupuje lacné semienka pred sezónou, v sezóne ich predá, keď je ich málo a sú drahé.
  npc_fero: Object.assign({}, market, {
    run(s, d, ctx) {
      const m = s['market:*'], tick = ctx.tick, se = season(tick), fero = m.npcs.fero, g = ctx.rng;
      for (const sp of Object.keys(fero.hold)) {
        const base = D.SPECIES[sp].seed, p = seedPrice(m, tick, sp);
        if (p >= base * 1.5 || phase(sp, se) === 'off') {
          const n = fero.hold[sp];
          m.seeds[sp].stock = Math.min(SEED_CAP, m.seeds[sp].stock + n); fero.coins += n * p; delete fero.hold[sp];
          news(m, tick, `🎩 Špekulant Fero predal ${n}× semienka ${D.SPECIES[sp].name} – keď boli najdrahšie.`);
        }
      }
      const held = Object.values(fero.hold).reduce((a, b) => a + b, 0);
      if (held < 20) {
        const c = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && phase(sp, se) === 'next' && m.seeds[sp].stock >= 8 && seedPrice(m, tick, sp) <= D.SPECIES[sp].seed * 1.05);
        if (c.length) {
          const sp = g.pick(c), p = seedPrice(m, tick, sp);
          const k = Math.min(3 + g.int(4), m.seeds[sp].stock - 3, Math.floor(fero.coins / p));
          if (k > 0) {
            m.seeds[sp].stock -= k; fero.coins -= k * p; fero.hold[sp] = (fero.hold[sp] || 0) + k;
            news(m, tick, `🎩 Špekulant Fero skúpil ${k}× semienka ${D.SPECIES[sp].name}. Tuší, že budú drahé…`);
          }
        }
      }
    }
  }),

  // Kvetinárka Zuzka: vykupuje kvety z trhu (viac počas sviatkov) – trh sa tým uvoľňuje a ceny rastú.
  npc_zuzka: Object.assign({}, market, {
    run(s, d, ctx) {
      const m = s['market:*'];
      let best = null, bought = 0;
      for (const sp of PLANTABLE) {
        const st = m.flowers[sp].stock;
        if (!st) continue;
        const fest = m.flowers[sp].fest ? 3 : 0;
        const k = Math.min(st, Math.ceil(st * 0.3) + fest);
        m.flowers[sp].stock -= k; bought += k;
        if (!best || k > best.k) best = { sp, k };
      }
      if (best && best.k >= 3) news(m, ctx.tick, `💐 Kvetinárka Zuzka vykúpila z trhu ${bought} kvetov (najviac ${D.SPECIES[best.sp].name}).`);
    }
  }),

  festAnnounce: Object.assign({}, market, {
    run(s, d, ctx) {
      const f = D.FESTIVALS.find(x => x.id === d.id);
      const list = Object.entries(f.mult).map(([sp, x]) => `${D.SPECIES[sp].name} ×${String(x).replace('.', ',')}`).join(', ');
      news(s['market:*'], ctx.tick, `📅 O 2 dni: ${f.icon} ${f.name}! Výkupné ceny: ${list}.`);
      ctx.emit({ to: E.ALL, t: 'toast', text: `📅 O 2 dni bude ${f.icon} ${f.name} – kvetinárka bude platiť viac za: ${list}. Stihneš to vypestovať?`, kind: 'day' });
    }
  }),
  // Sviatok: násobky do položiek kvetov (cena) a súhrn pre klienta (m.festival); naraz je najviac jeden sviatok.
  festStart: Object.assign({}, market, {
    run(s, d, ctx) {
      const f = D.FESTIVALS.find(x => x.id === d.id), m = s['market:*'];
      m.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: ctx.tick + f.len * TPD };
      setFestival(m, f);
      news(m, ctx.tick, `${f.icon} Začína ${f.name}!`);
      ctx.emit({ to: E.ALL, t: 'toast', text: `${f.icon} Začína ${f.name}! Výkupné ceny vybraných kvetov sú vyššie.`, kind: 'magic' });
    }
  }),
  festEnd: Object.assign({}, market, {
    run(s, d) { const m = s['market:*']; if (m.festival && m.festival.id === d.id) { m.festival = null; setFestival(m, null); } }
  }),

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
      const who = c && c.takenBy && world.saves && Object.prototype.hasOwnProperty.call(world.saves, c.takenBy) ? c.takenBy : null;
      return who ? { writes: ['contracts', 'save:*', 'maxRep'] } : { writes: ['contracts'] };
    },
    run(s, d, ctx) {
      const c = s.contracts.list.find(x => x.id === d.id);
      if (!c) return;
      s.contracts.list = s.contracts.list.filter(x => x !== c);
      const sv = c.takenBy && s['save:*'] && s['save:*'][c.takenBy];
      if (!sv) return;
      const part = Math.round(c.got * D.SPECIES[c.sp].sell * 0.5);
      sv.coins += part; sv.rep = Math.max(0, (sv.rep || 0) - 5);
      s.maxRep = maxRepOf(s['save:*']);
      ctx.emit({ to: c.takenBy, t: 'toast', text: `⌛ Zákazka pre ${D.GIVERS[c.giver]} (${c.n}× ${D.SPECIES[c.sp].name}) prepadla. −5 reputácie` + (part ? `, za ${c.got} odovzdaných dostávaš ${part} 🪙.` : '.'), kind: 'info' });
    }
  }
};

// ---------- Zákazky ----------
// Odvodené počítadlá sveta (aby návrhy nemuseli čítať všetky uloženia či políčka):
//   world.maxRep    – najvyššia reputácia medzi hráčmi (veľké zákazky od úrovne 2); udržiava každá zmena reputácie
//   world.plotsUsed – počet obrobených políčok záhrady; udržiava kopanie a zarovnanie (server.js)
function maxRepOf(saves) { let m = 0; for (const k in saves) m = Math.max(m, saves[k].rep || 0); return m; }
function plotsUsedOf(tiles) { let n = 0; for (const t of tiles) if (t.s) n++; return n; }

// Nová zákazka na nástenke c. Náhoda a plánovanie termínov cez ctx.
function genContract(c, tick, kind, ctx) {
  const se = season(tick), g = ctx.rng;
  const ok = sp => !D.SPECIES[sp].strict;
  // krátka zákazka len na kvet, ktorý sa stihne zasadiť teraz a vypestovať ešte v tomto období
  const daysLeft = DPS - dayInSeason(tick);
  const nowPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes(se) && D.SPECIES[sp].days <= daysLeft + 1);
  const nextPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes((se + 1) % 4));
  let sp, n, due, mult, rep, item = null;
  if (kind === 'long' && nextPool.length) {
    sp = g.pick(nextPool); n = 5 + g.int(5);
    due = seasonStartTick(tick, 1) + (D.SPECIES[sp].days + 1 + g.int(2)) * TPD;
    mult = 1.8; rep = 10 + n;
  } else if (kind === 'big') {
    sp = g.pick(nowPool.length ? nowPool : nextPool); n = 10 + g.int(6);
    due = tick + (Math.max(5, D.SPECIES[sp].days + 2) + g.int(3)) * TPD;
    mult = 2.3; rep = 25; item = g.pick([{ id: 'seed_plesnivec', n: 2 }, { id: 'compost', n: 5 }, { id: 'seed_ruza', n: 3 }]);
  } else if (!nowPool.length) {
    return genContract(c, tick, 'long', ctx);
  } else {
    kind = 'short';
    sp = g.pick(nowPool); n = 2 + g.int(3);
    due = tick + (D.SPECIES[sp].days + 1 + g.int(2)) * TPD;
    mult = 1.5; rep = 4 + n;
  }
  const giver = g.pick(Object.keys(D.GIVERS));
  const k = {
    id: c.nextId++, kind, giver, sp, n, got: 0, reward: Math.round(n * D.SPECIES[sp].sell * mult), item, rep,
    posted: tick, openUntil: Math.min(due - TPD, tick + 2 * TPD), due, takenBy: null
  };
  c.list.push(k);
  ctx.scheduleUnique('cExpire:' + k.id, k.openUntil, 'cExpire', { id: k.id });
  ctx.scheduleUnique('cDue:' + k.id, k.due, 'cDue', { id: k.id });
  return k;
}

// Doplní nástenku na 4 voľné zákazky; veľké zákazky od chvíle, keď má niekto v záhrade reputáciu úrovne 2.
function fillBoard(c, tick, maxRep, ctx) {
  const open = () => c.list.filter(x => !x.takenBy);
  const hasKind = k => open().some(x => x.kind === k);
  let guard = 0;
  while (open().length < 4 && guard++ < 8) {
    const kind = !hasKind('long') ? 'long' : (D.repLevel(maxRep || 0) >= 2 && !hasKind('big')) ? 'big' : 'short';
    genContract(c, tick, kind, ctx);
  }
}

function maxActive(sv) { return 1 + D.repLevel(sv.rep || 0); }

// Hráč key (uloženie sv) si berie zákazku id z nástenky c. Vráti chybu alebo null.
function takeContract(c, tick, sv, key, id) {
  const k = c.list.find(x => x.id === id);
  if (!k || k.takenBy) return 'Túto zákazku už niekto zobral.';
  if (tick >= k.openUntil) return 'Na túto zákazku je už neskoro.';
  const active = c.list.filter(x => x.takenBy === key).length;
  if (active >= maxActive(sv)) return `Naraz môžeš mať len ${maxActive(sv)} ${maxActive(sv) === 1 ? 'zákazku' : 'zákazky'}. Vyššia reputácia ti dovolí viac.`;
  k.takenBy = key;
  return null;
}

// Odovzdanie aj po častiach; po splnení vyplatí odmenu a reputáciu a doplní nástenku.
// maxRep: doterajšia najvyššia reputácia záhrady; vráti { n: odovzdané kusy (0 = nič sa nestalo), msg, done, maxRep }.
function deliverContract(c, tick, sv, key, id, maxRep, ctx) {
  const k = c.list.find(x => x.id === id);
  if (!k || k.takenBy !== key) return { n: 0, msg: 'Táto zákazka nie je tvoja.', maxRep };
  const have = sv.inv['fl_' + k.sp] || 0;
  const n = Math.min(have, k.n - k.got);
  if (!n) return { n: 0, msg: `Nemáš žiadny ${D.SPECIES[k.sp].name}.`, maxRep };
  I.removeItems(I.playerC(sv), 'fl_' + k.sp, n, tick);
  k.got += n;
  let msg = `Odovzdané ${n}× ${D.SPECIES[k.sp].name} (${k.got}/${k.n}).`, done = false;
  if (k.got >= k.n) {
    const lvlBefore = D.repLevel(sv.rep || 0);
    sv.coins += k.reward; sv.rep = (sv.rep || 0) + k.rep;
    maxRep = Math.max(maxRep || 0, sv.rep);
    if (k.item) I.addItems(I.playerC(sv), k.item.id, k.item.n, tick);
    c.list = c.list.filter(x => x !== k);
    ctx.cancel('cExpire:' + k.id); ctx.cancel('cDue:' + k.id);
    msg = `✅ ${D.GIVERS[k.giver]}: „Ďakujem!“ Dostávaš ${k.reward} 🪙` + (k.item ? ` a ${k.item.n}× ${D.itemName(k.item.id)}` : '') + ` · +${k.rep} reputácie.`;
    const lvl = D.repLevel(sv.rep);
    if (lvl > lvlBefore) msg += ` 🎉 Reputácia úroveň ${lvl}!`;
    done = true;
    fillBoard(c, tick, maxRep, ctx);
  }
  return { n, msg, done, maxRep };
}

// ---------- Vylepšenia ----------
// Spoločné vylepšenia (shared – povolenie na pole) patria záhrade (world.up), platí ich hráč, ktorý ich kúpi.
function upgradeLevels(up, sv, kind) {
  if (D.UPGRADES[kind].shared) return up;
  return (sv.up = sv.up || { can: 0, composter: 0 });
}
// up = spoločné vylepšenia záhrady (world.up), sv = uloženie hráča. Vráti chybu alebo null.
function upgrade(up, sv, kind) {
  const u = D.UPGRADES[kind];
  if (!u) return 'Neznáme vylepšenie.';
  const lv = upgradeLevels(up, sv, kind);
  const next = u.levels[(lv[kind] || 0) + 1];
  if (!next) return u.shared ? 'Záhrada už má najvyššiu úroveň.' : 'Už máš najvyššiu úroveň.';
  if (D.repLevel(sv.rep || 0) < next.rep) return `Potrebuješ reputáciu úrovne ${next.rep}.`;
  if (sv.coins < next.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= next.price;
  lv[kind] = (lv[kind] || 0) + 1;
  return null;
}
function canCap(sv) { return D.UPGRADES.can.levels[(sv.up && sv.up.can) || 0].v; }
// Povolenie na pole celej záhrady (up = world.up); koľko je obrobené, drží počítadlo world.plotsUsed
function plotLimit(up) { return D.UPGRADES.plots.levels[(up && up.plots) || 0].v; }

// Najbližší sviatok, ktorý ešte nezačal (#86): začiatok podľa naplánovanej udalosti festStart vo fronte events,
// inak vypočítaný z definície sviatku (ohlásenie festAnnounce nesie len id).
function upcomingFestival(events, tick) {
  let best = null;
  for (const f of D.FESTIVALS) {
    const ev = (events || []).find(e => e.type === 'festStart' && e.data && e.data.id === f.id);
    const start = ev ? ev.at : E.nextEvery(tick + 1, YEAR_DAYS * TPD, festStartTick(f));
    if (!best || start < best.start) best = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, len: f.len, start, end: start + f.len * TPD, announce: start - 2 * TPD };
  }
  if (best) best.announced = tick >= best.announce;
  return best;
}

// ---------- Pohľad pre klienta ----------
function marketView(m, tick, events) {
  const seeds = {}, flowers = {};
  for (const sp of PLANTABLE) {
    seeds[sp] = { p: seedPrice(m, tick, sp), st: m.seeds[sp].stock, h: m.hist['seed_' + sp] || [] };
    flowers[sp] = { p: flowerPrice(m, tick, sp), st: m.flowers[sp].stock, h: m.hist['fl_' + sp] || [] };
  }
  return {
    t: 'market', seeds, flowers, compost: { p: compostPrice(m), st: m.compost.stock, h: m.hist.compost || [] },
    festival: m.festival, upcoming: upcomingFestival(events, tick), news: m.news
  };
}
function boardView(c) { return { t: 'board', list: c.list }; }

// Počiatočné mince a reputácia nového hráča. V testovacích prostrediach (PR náhľady, dev) ich nastaví
// scripts/deploy.sh cez START_COINS a START_REP (úroveň reputácie); v produkcii platí chudobný začiatok.
function startCapital(env) {
  const coins = Number.parseInt(env.START_COINS, 10), lvl = Number.parseInt(env.START_REP, 10);
  return {
    coins: coins >= 0 ? coins : 30,
    rep: lvl > 0 ? D.REP_LEVELS[Math.min(lvl, D.REP_LEVELS.length - 1)] : 0
  };
}

module.exports = {
  startCapital, initEconomy, dawnMarket, composters, DAWN, PROPOSERS, PERIODIC, news, buy, sell, sellQuote, buyQuote, seedPrice, flowerPrice, compostPrice,
  seedPriceParts, flowerPriceParts, compostPriceParts, festStartTick, upcomingFestival, setFestival, syncFestival, marketKey, marketSlice,
  fillBoard, takeContract, deliverContract, upgrade, canCap, plotLimit, maxRepOf, plotsUsedOf, maxActive, marketView, boardView, phase, PLANTABLE,
  PRICING, SEED_TARGET, COMPOST_TARGET, HIST_LEN, SEED_CAP, COMPOST_CAP, YEAR_DAYS
};
