// Ekonomika: živý trh (zásoby + ceny podľa ponuky a dopytu), NPC obchodníci, sviatky, zákazky a vylepšenia.
// Všetko, čo sa deje v čase, je udalosť v plánovači (engine.js) a celý stav je v room.market / room.contracts.
const D = require('./shared/data.js');
const E = require('./engine.js');
const I = require('./items.js');

const TPD = D.TICKS_PER_DAY, DPS = D.DAYS_PER_SEASON, YEAR_DAYS = 4 * DPS;
const PLANTABLE = Object.keys(D.SPECIES).filter(k => !D.SPECIES[k].magic);
const SEED_TARGET = 10, COMPOST_TARGET = 15, HIST_LEN = 16;
const SEED_CAP = 40, COMPOST_CAP = 30;

// Server dodá funkcie na komunikáciu s hráčmi; v testoch zostanú prázdne.
let hooks = {
  market() {}, board() {}, toastAll() {}, toastKey() {}, me() {}
};
function setHooks(h) { hooks = Object.assign({}, hooks, h); }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const day = room => D.dayOfTick(room.tick);
const season = room => D.seasonOf(day(room));
const dayInSeason = room => (day(room) - 1) % DPS + 1;
// Kedy sa druh sadí vzhľadom na aktuálne obdobie: teraz / v ďalšom období / mimo
function phase(sp, se) {
  const s = D.SPECIES[sp].seasons;
  if (s.includes(se)) return 'now';
  if (s.includes((se + 1) % 4)) return 'next';
  return 'off';
}
// Krok, ktorým začína obdobie posunuté o `offset` období od aktuálneho
function seasonStartTick(room, offset) { return (Math.floor((day(room) - 1) / DPS) + offset) * DPS * TPD; }

function news(room, text) {
  const m = room.market;
  m.news.unshift({ tick: room.tick, text });
  if (m.news.length > 14) m.news.length = 14;
  hooks.market(room);
}

// ---------- Ceny ----------
function seedPrice(room, sp) {
  const st = room.market.seeds[sp].stock;
  const ph = phase(sp, season(room));
  const demand = ph === 'now' ? 1.35 : ph === 'next' ? 1.0 : 0.8;
  const scarcity = clamp(Math.sqrt(SEED_TARGET / Math.max(1, st)), 0.75, 3);
  return Math.max(2, Math.round(D.SPECIES[sp].seed * demand * scarcity));
}
function compostPrice(room) {
  return Math.max(5, Math.round(15 * clamp(Math.sqrt(COMPOST_TARGET / Math.max(1, room.market.compost.stock)), 0.7, 3)));
}
// Výkupná cena kvetu: mimo sezóny vzácnejší, počas sviatku vyšší dopyt, plný trh cenu tlačí dole.
function flowerPrice(room, sp) {
  const s = D.SPECIES[sp], st = room.market.flowers[sp].stock;
  const rare = s.seasons.includes(season(room)) ? 1 : 1.6;
  const fest = (room.market.festival && room.market.festival.mult[sp]) || 1;
  const sat = Math.max(0.35, 1.3 - 0.06 * st);
  return Math.max(1, Math.round(s.sell * rare * fest * sat));
}
// Cena, za ktorú trh od hráča vykúpi 1 kus (null = nevykupuje)
function sellQuote(room, id) {
  if (id.startsWith('fl_')) { const sp = id.slice(3); return room.market.flowers[sp] ? flowerPrice(room, sp) : null; }
  if (id.startsWith('seed_')) { const sp = id.slice(5); return room.market.seeds[sp] ? Math.max(1, Math.round(seedPrice(room, sp) * 0.4)) : D.sellPrice(id); }
  if (id === 'compost') return Math.max(1, Math.round(compostPrice(room) * 0.5));
  if (id.startsWith('po_') || id === 'wilted') return D.sellPrice(id);
  if (id === 'ice') return D.ICE_PRICE[season(room)]; // v lete drahý, v zime takmer zadarmo
  return null;
}
function buyQuote(room, id) {
  if (id === 'compost') return { price: compostPrice(room), stock: room.market.compost.stock };
  if (id.startsWith('seed_') && room.market.seeds[id.slice(5)]) { const sp = id.slice(5); return { price: seedPrice(room, sp), stock: room.market.seeds[sp].stock }; }
  return null;
}
function stockOf(room, id) {
  if (id === 'compost') return room.market.compost;
  if (id.startsWith('seed_')) return room.market.seeds[id.slice(5)];
  if (id.startsWith('fl_')) return room.market.flowers[id.slice(3)];
  return null;
}

// Nákup po kusoch – každý kus zvýši cenu ďalšieho (ubúda zásoba).
function buy(room, sv, id, n) {
  const q = buyQuote(room, id);
  if (!q) return { n: 0, msg: 'Toto sa na trhu nepredáva.' };
  const sp = id.startsWith('seed_') ? id.slice(5) : null;
  if (sp && D.MIN_SEED_REP[sp] && D.repLevel(sv.rep || 0) < D.MIN_SEED_REP[sp]) return { n: 0, msg: `Veľkoobchodník predáva ${D.SPECIES[sp].name} len záhradníkom s reputáciou ${D.MIN_SEED_REP[sp]}.` };
  let got = 0, cost = 0;
  while (got < n) {
    const cur = buyQuote(room, id);
    if (cur.stock <= 0) break;
    if (sv.coins < cur.price) break;
    sv.coins -= cur.price; cost += cur.price; stockOf(room, id).stock--; got++;
  }
  if (got) { I.addItems(I.playerC(sv), id, got, room.tick); hooks.market(room); }
  const msg = got ? `Kúpené: ${got}× ${D.itemName(id)} za ${cost} 🪙` : (q.stock <= 0 ? 'Vypredané. Veľkoobchodník príde o pár dní.' : 'Nemáš dosť mincí. 🪙');
  return { n: got, cost, msg };
}

// Predaj po kusoch – každý predaný kus zníži cenu ďalšieho (trh sa nasycuje).
// Kvety sa predávajú od najstarších a cena sa násobí ich čerstvosťou.
function sell(room, sv, id, n) {
  if (sellQuote(room, id) == null || D.isTool(id)) return { n: 0, msg: 'Toto trh nevykupuje.' };
  n = Math.min(n, sv.inv[id] || 0);
  if (!n) return { n: 0, msg: 'Nemáš čo predať.' };
  const batches = I.removeItems(I.playerC(sv), id, n, room.tick);
  const sp = I.isFlower(id) ? id.slice(3) : null;
  let earned = 0, fresh = 0;
  for (const b of batches) for (let i = 0; i < b.n; i++) {
    const f = sp ? D.freshness(sp, b.age) : 1;
    earned += Math.max(1, Math.round(sellQuote(room, id) * f)); fresh += f;
    const st = stockOf(room, id);
    if (st) st.stock = Math.min(sp ? 99 : SEED_CAP, st.stock + 1);
  }
  sv.coins += earned;
  hooks.market(room);
  const fr = sp && fresh / n < 0.97 ? ` (čerstvosť ${Math.round(fresh / n * 100)} %)` : '';
  return { n, earned, msg: `Predané: ${n}× ${D.itemName(id)} za ${earned} 🪙${fr}` };
}

// ---------- Inicializácia ----------
function initEconomy(room) {
  if (!room.market) {
    const se = season(room);
    const m = { seeds: {}, flowers: {}, compost: { stock: 15 }, hist: {}, news: [], festival: null, npcs: { jano: { coins: 300 }, fero: { coins: 400, hold: {} } } };
    for (const sp of PLANTABLE) {
      const ph = phase(sp, se);
      m.seeds[sp] = { stock: D.SPECIES[sp].strict ? 0 : ph === 'now' ? 10 : ph === 'next' ? 6 : 2 };
      m.flowers[sp] = { stock: 0 };
    }
    room.market = m;
    E.schedule(room, E.nextDailyTick(room.tick + 1, 84), 'delivery'); // 7:00
    for (const n of ['jano', 'fero', 'zuzka']) E.schedule(room, E.nextDailyTick(room.tick + 1, 96 + E.randInt(room, 120)), 'npc_' + n);
    for (const f of D.FESTIVALS) scheduleFestival(room, f);
    recordHistory(room);
  }
  if (!room.contracts) { room.contracts = { list: [], nextId: 1 }; fillBoard(room); }
}

function recordHistory(room) {
  const m = room.market;
  const push = (id, v) => { const h = m.hist[id] || (m.hist[id] = []); h.push(v); if (h.length > HIST_LEN) h.shift(); };
  for (const sp of PLANTABLE) { push('seed_' + sp, seedPrice(room, sp)); push('fl_' + sp, flowerPrice(room, sp)); }
  push('compost', compostPrice(room));
}

// Volá server každé ráno o 6:00 (po raste rastlín).
function onDawn(room) {
  const m = room.market, se = season(room);
  // zákazníci počas noci rozkúpili časť kvetov; staré semienka mimo sezóny sa kazia
  for (const sp of PLANTABLE) {
    m.flowers[sp].stock = Math.floor(m.flowers[sp].stock * 0.6);
    if (phase(sp, se) === 'off') m.seeds[sp].stock = Math.floor(m.seeds[sp].stock * 0.9);
  }
  // kompostéry hráčov (aj offline hráčov)
  for (const key in room.saves) {
    const sv = room.saves[key], lvl = (sv.up && sv.up.composter) || 0;
    const n = D.UPGRADES.composter.levels[lvl].v;
    if (n) { I.addItems(I.playerC(sv), 'compost', n, room.tick); hooks.me(room, key); }
  }
  recordHistory(room);
  fillBoard(room);
  hooks.market(room);
}

// ---------- Udalosti: veľkoobchodník, NPC, sviatky ----------
function scheduleFestival(room, f) {
  // najbližší začiatok sviatku (6:00 jeho dňa), ktorého ohlásenie (2 dni vopred) je ešte v budúcnosti
  const yearStart = Math.floor((day(room) - 1) / YEAR_DAYS) * YEAR_DAYS;
  let start = (yearStart + f.season * DPS + f.day - 1) * TPD + D.DAWN_TICK;
  while (start - 2 * TPD <= room.tick) start += YEAR_DAYS * TPD;
  E.schedule(room, start - 2 * TPD, 'festAnnounce', { id: f.id, start });
}

const HANDLERS = {
  delivery(room) {
    const m = room.market, se = season(room), dis = dayInSeason(room);
    let total = 0;
    for (const sp of PLANTABLE) {
      const ph = phase(sp, se);
      let q;
      if (D.SPECIES[sp].strict) q = ph === 'off' ? 0 : E.randInt(room, 3);
      else if (ph === 'next') q = dis >= DPS - 1 ? 8 + E.randInt(room, 6) : 4 + E.randInt(room, 4);
      else if (ph === 'now') q = dis <= 1 ? 4 + E.randInt(room, 4) : E.randInt(room, 3);
      else q = E.randInt(room, 2);
      m.seeds[sp].stock = Math.min(SEED_CAP, m.seeds[sp].stock + q);
      total += q;
    }
    m.compost.stock = Math.min(COMPOST_CAP, m.compost.stock + 6 + E.randInt(room, 5));
    news(room, `🚚 Veľkoobchodník priviezol ${total} vrecúšok semienok – hlavne na ďalšie obdobie.`);
    E.schedule(room, room.tick + 2 * TPD, 'delivery');
  },

  // Záhradník Jano: kúpi semienka s najlepším očakávaným ziskom za deň, vypestuje ich a kvety predá na trhu.
  npc_jano(room) {
    const m = room.market, se = season(room), jano = m.npcs.jano;
    const cands = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && m.seeds[sp].stock >= 3 && phase(sp, se) !== 'off')
      .map(sp => { const s = D.SPECIES[sp], p = seedPrice(room, sp); return { sp, p, score: (s.sell * 2 - p) / s.days, cheap: p <= s.seed * 1.25 }; })
      .filter(c => c.cheap && c.score > 0).sort((a, b) => b.score - a.score);
    const c = cands[0];
    if (c) {
      const k = Math.min(m.seeds[c.sp].stock - 1, 2 + E.randInt(room, 5), Math.floor(jano.coins / c.p));
      if (k > 0) {
        m.seeds[c.sp].stock -= k; jano.coins -= k * c.p;
        const start = phase(c.sp, se) === 'now' ? room.tick : seasonStartTick(room, 1);
        E.schedule(room, start + D.SPECIES[c.sp].days * TPD + E.randInt(room, TPD / 2), 'jano_sell', { sp: c.sp, n: k * 2 });
        news(room, `🧑‍🌾 Záhradník Jano nakúpil ${k}× semienka ${D.SPECIES[c.sp].name}.`);
      }
    }
    E.schedule(room, E.nextDailyTick(room.tick + TPD / 2, 96 + E.randInt(room, 120)), 'npc_jano');
  },
  jano_sell(room, d) {
    const m = room.market;
    const price = flowerPrice(room, d.sp);
    m.flowers[d.sp].stock += d.n; m.npcs.jano.coins += Math.round(d.n * price * 0.8);
    news(room, `🧑‍🌾 Jano priniesol na trh ${d.n}× ${D.SPECIES[d.sp].name} – výkupná cena klesla.`);
  },

  // Špekulant Fero: skupuje lacné semienka pred sezónou, v sezóne ich predá, keď je ich málo a sú drahé.
  npc_fero(room) {
    const m = room.market, se = season(room), fero = m.npcs.fero;
    for (const sp of Object.keys(fero.hold)) {
      const base = D.SPECIES[sp].seed, p = seedPrice(room, sp);
      if (p >= base * 1.5 || phase(sp, se) === 'off') {
        const n = fero.hold[sp];
        m.seeds[sp].stock = Math.min(SEED_CAP, m.seeds[sp].stock + n); fero.coins += n * p; delete fero.hold[sp];
        news(room, `🎩 Špekulant Fero predal ${n}× semienka ${D.SPECIES[sp].name} – keď boli najdrahšie.`);
      }
    }
    const held = Object.values(fero.hold).reduce((a, b) => a + b, 0);
    if (held < 20) {
      const c = PLANTABLE.filter(sp => !D.SPECIES[sp].strict && phase(sp, se) === 'next' && m.seeds[sp].stock >= 8 && seedPrice(room, sp) <= D.SPECIES[sp].seed * 1.05);
      if (c.length) {
        const sp = E.pick(room, c), p = seedPrice(room, sp);
        const k = Math.min(3 + E.randInt(room, 4), m.seeds[sp].stock - 3, Math.floor(fero.coins / p));
        if (k > 0) {
          m.seeds[sp].stock -= k; fero.coins -= k * p; fero.hold[sp] = (fero.hold[sp] || 0) + k;
          news(room, `🎩 Špekulant Fero skúpil ${k}× semienka ${D.SPECIES[sp].name}. Tuší, že budú drahé…`);
        }
      }
    }
    E.schedule(room, E.nextDailyTick(room.tick + TPD / 2, 96 + E.randInt(room, 120)), 'npc_fero');
  },

  // Kvetinárka Zuzka: vykupuje kvety z trhu (viac počas sviatkov) – trh sa tým uvoľňuje a ceny rastú.
  npc_zuzka(room) {
    const m = room.market;
    let best = null, bought = 0;
    for (const sp of PLANTABLE) {
      const st = m.flowers[sp].stock;
      if (!st) continue;
      const fest = m.festival && m.festival.mult[sp] ? 3 : 0;
      const k = Math.min(st, Math.ceil(st * 0.3) + fest);
      m.flowers[sp].stock -= k; bought += k;
      if (!best || k > best.k) best = { sp, k };
    }
    if (best && best.k >= 3) news(room, `💐 Kvetinárka Zuzka vykúpila z trhu ${bought} kvetov (najviac ${D.SPECIES[best.sp].name}).`);
    else hooks.market(room);
    E.schedule(room, E.nextDailyTick(room.tick + TPD / 2, 96 + E.randInt(room, 120)), 'npc_zuzka');
  },

  festAnnounce(room, d) {
    const f = D.FESTIVALS.find(x => x.id === d.id);
    const list = Object.entries(f.mult).map(([sp, x]) => `${D.SPECIES[sp].name} ×${String(x).replace('.', ',')}`).join(', ');
    news(room, `📅 O 2 dni: ${f.icon} ${f.name}! Výkupné ceny: ${list}.`);
    hooks.toastAll(room, `📅 O 2 dni bude ${f.icon} ${f.name} – kvetinárka bude platiť viac za: ${list}. Stihneš to vypestovať?`, 'day');
    E.schedule(room, d.start, 'festStart', { id: f.id });
    E.schedule(room, d.start + f.len * TPD, 'festEnd', { id: f.id });
    E.schedule(room, d.start + YEAR_DAYS * TPD - 2 * TPD, 'festAnnounce', { id: f.id, start: d.start + YEAR_DAYS * TPD });
  },
  festStart(room, d) {
    const f = D.FESTIVALS.find(x => x.id === d.id);
    room.market.festival = { id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: room.tick + f.len * TPD };
    news(room, `${f.icon} Začína ${f.name}!`);
    hooks.toastAll(room, `${f.icon} Začína ${f.name}! Výkupné ceny vybraných kvetov sú vyššie.`, 'magic');
  },
  festEnd(room, d) {
    if (room.market.festival && room.market.festival.id === d.id) room.market.festival = null;
    hooks.market(room);
  },

  cExpire(room, d) {
    const c = room.contracts.list.find(x => x.id === d.id);
    if (c && !c.takenBy) { room.contracts.list = room.contracts.list.filter(x => x !== c); hooks.board(room); }
  },
  cDue(room, d) {
    const c = room.contracts.list.find(x => x.id === d.id);
    if (!c) return;
    room.contracts.list = room.contracts.list.filter(x => x !== c);
    if (c.takenBy) {
      const sv = room.saves[c.takenBy];
      if (sv) {
        const part = Math.round(c.got * D.SPECIES[c.sp].sell * 0.5);
        sv.coins += part; sv.rep = Math.max(0, (sv.rep || 0) - 5);
        hooks.toastKey(room, c.takenBy, `⌛ Zákazka pre ${D.GIVERS[c.giver]} (${c.n}× ${D.SPECIES[c.sp].name}) prepadla. −5 reputácie` + (part ? `, za ${c.got} odovzdaných dostávaš ${part} 🪙.` : '.'), 'info');
        hooks.me(room, c.takenBy);
      }
    }
    hooks.board(room);
  }
};

// ---------- Zákazky ----------
function maxRepLevel(room) { let l = 0; for (const k in room.saves) l = Math.max(l, D.repLevel(room.saves[k].rep || 0)); return l; }

function genContract(room, kind) {
  const se = season(room);
  const ok = sp => !D.SPECIES[sp].strict;
  // krátka zákazka len na kvet, ktorý sa stihne zasadiť teraz a vypestovať ešte v tomto období
  const daysLeft = DPS - dayInSeason(room);
  const nowPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes(se) && D.SPECIES[sp].days <= daysLeft + 1);
  const nextPool = PLANTABLE.filter(sp => ok(sp) && D.SPECIES[sp].seasons.includes((se + 1) % 4));
  let sp, n, due, mult, rep, item = null;
  if (kind === 'long' && nextPool.length) {
    sp = E.pick(room, nextPool); n = 5 + E.randInt(room, 5);
    due = seasonStartTick(room, 1) + (D.SPECIES[sp].days + 1 + E.randInt(room, 2)) * TPD;
    mult = 1.8; rep = 10 + n;
  } else if (kind === 'big') {
    sp = E.pick(room, nowPool.length ? nowPool : nextPool); n = 10 + E.randInt(room, 6);
    due = room.tick + (Math.max(5, D.SPECIES[sp].days + 2) + E.randInt(room, 3)) * TPD;
    mult = 2.3; rep = 25; item = E.pick(room, [{ id: 'seed_plesnivec', n: 2 }, { id: 'compost', n: 5 }, { id: 'seed_ruza', n: 3 }]);
  } else if (!nowPool.length) {
    return genContract(room, 'long');
  } else {
    kind = 'short';
    sp = E.pick(room, nowPool); n = 2 + E.randInt(room, 3);
    due = room.tick + (D.SPECIES[sp].days + 1 + E.randInt(room, 2)) * TPD;
    mult = 1.5; rep = 4 + n;
  }
  const giver = E.pick(room, Object.keys(D.GIVERS));
  const c = {
    id: room.contracts.nextId++, kind, giver, sp, n, got: 0, reward: Math.round(n * D.SPECIES[sp].sell * mult), item, rep,
    posted: room.tick, openUntil: Math.min(due - TPD, room.tick + 2 * TPD), due, takenBy: null
  };
  room.contracts.list.push(c);
  E.schedule(room, c.openUntil, 'cExpire', { id: c.id });
  E.schedule(room, c.due, 'cDue', { id: c.id });
  return c;
}

function fillBoard(room) {
  const open = () => room.contracts.list.filter(c => !c.takenBy);
  const hasKind = k => open().some(c => c.kind === k);
  let guard = 0;
  while (open().length < 4 && guard++ < 8) {
    const kind = !hasKind('long') ? 'long' : (maxRepLevel(room) >= 2 && !hasKind('big')) ? 'big' : 'short';
    genContract(room, kind);
  }
  hooks.board(room);
}

function maxActive(sv) { return 1 + D.repLevel(sv.rep || 0); }

function takeContract(room, key, id) {
  const sv = room.saves[key], c = room.contracts.list.find(x => x.id === id);
  if (!c || c.takenBy) return 'Túto zákazku už niekto zobral.';
  if (room.tick >= c.openUntil) return 'Na túto zákazku je už neskoro.';
  const active = room.contracts.list.filter(x => x.takenBy === key).length;
  if (active >= maxActive(sv)) return `Naraz môžeš mať len ${maxActive(sv)} ${maxActive(sv) === 1 ? 'zákazku' : 'zákazky'}. Vyššia reputácia ti dovolí viac.`;
  c.takenBy = key;
  hooks.board(room);
  return null;
}

// Odovzdanie aj po častiach; po splnení vyplatí odmenu a reputáciu.
function deliverContract(room, key, id) {
  const sv = room.saves[key], c = room.contracts.list.find(x => x.id === id);
  if (!c || c.takenBy !== key) return { msg: 'Táto zákazka nie je tvoja.' };
  const have = sv.inv['fl_' + c.sp] || 0;
  const k = Math.min(have, c.n - c.got);
  if (!k) return { msg: `Nemáš žiadny ${D.SPECIES[c.sp].name}.` };
  I.removeItems(I.playerC(sv), 'fl_' + c.sp, k, room.tick);
  c.got += k;
  let msg = `Odovzdané ${k}× ${D.SPECIES[c.sp].name} (${c.got}/${c.n}).`, done = false;
  if (c.got >= c.n) {
    const lvlBefore = D.repLevel(sv.rep || 0);
    sv.coins += c.reward; sv.rep = (sv.rep || 0) + c.rep;
    if (c.item) I.addItems(I.playerC(sv), c.item.id, c.item.n, room.tick);
    room.contracts.list = room.contracts.list.filter(x => x !== c);
    E.cancel(room, e => (e.type === 'cDue' || e.type === 'cExpire') && e.data.id === c.id);
    msg = `✅ ${D.GIVERS[c.giver]}: „Ďakujem!“ Dostávaš ${c.reward} 🪙` + (c.item ? ` a ${c.item.n}× ${D.itemName(c.item.id)}` : '') + ` · +${c.rep} reputácie.`;
    const lvl = D.repLevel(sv.rep);
    if (lvl > lvlBefore) msg += ` 🎉 Reputácia úroveň ${lvl}!`;
    done = true;
    fillBoard(room);
  }
  hooks.board(room);
  return { msg, done };
}

// ---------- Vylepšenia ----------
function upgrade(room, sv, kind) {
  const u = D.UPGRADES[kind];
  if (!u) return 'Neznáme vylepšenie.';
  sv.up = sv.up || { can: 0, plots: 0, composter: 0 };
  const next = u.levels[(sv.up[kind] || 0) + 1];
  if (!next) return 'Už máš najvyššiu úroveň.';
  if (D.repLevel(sv.rep || 0) < next.rep) return `Potrebuješ reputáciu úrovne ${next.rep}.`;
  if (sv.coins < next.price) return 'Nemáš dosť mincí. 🪙';
  sv.coins -= next.price;
  sv.up[kind] = (sv.up[kind] || 0) + 1;
  return null;
}
function canCap(sv) { return D.UPGRADES.can.levels[(sv.up && sv.up.can) || 0].v; }
function plotLimit(sv) { return D.UPGRADES.plots.levels[(sv.up && sv.up.plots) || 0].v; }

// ---------- Pohľad pre klienta ----------
function marketView(room) {
  const m = room.market, seeds = {}, flowers = {};
  for (const sp of PLANTABLE) {
    seeds[sp] = { p: seedPrice(room, sp), st: m.seeds[sp].stock, h: m.hist['seed_' + sp] || [] };
    flowers[sp] = { p: flowerPrice(room, sp), st: m.flowers[sp].stock, h: m.hist['fl_' + sp] || [] };
  }
  const nextFest = room.events.filter(e => e.type === 'festAnnounce' || e.type === 'festStart').sort((a, b) => a.at - b.at)[0];
  let upcoming = null;
  if (nextFest) {
    const f = D.FESTIVALS.find(x => x.id === nextFest.data.id);
    const start = nextFest.type === 'festStart' ? nextFest.at : nextFest.data.start;
    upcoming = { name: f.name, icon: f.icon, start, mult: f.mult };
  }
  return {
    t: 'market', seeds, flowers, compost: { p: compostPrice(room), st: m.compost.stock, h: m.hist.compost || [] },
    festival: m.festival, upcoming, news: m.news
  };
}
function boardView(room) { return { t: 'board', list: room.contracts.list }; }

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
  startCapital, setHooks, initEconomy, onDawn, HANDLERS, buy, sell, sellQuote, buyQuote, seedPrice, flowerPrice,
  takeContract, deliverContract, upgrade, canCap, plotLimit, maxActive, marketView, boardView, phase, PLANTABLE
};
