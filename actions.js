// Akcie hráčov ako návrhy (engine.js): každá správa klienta, ktorá mení herný stav, je vstup enginu
// { type, data: { key, … }, id: 'a#<n>', actor: key } a tu má svoj návrh { keys, run } – pozri docs/engine.md.
// Návrh deklaruje len to, čo akcia naozaj mení (políčko, uloženie hráča, položka trhu…), beží na kópiách týchto výrezov,
// odmieta cez ctx.reject (hráč dostane správu; null = potichu) a správy posiela cez ctx.emit. Obnovu políčok, batohov,
// trhu, nástenky a skladu si server odvodí zo zapísaných kľúčov, takže tu nie je žiadne sendMe ani tileMsg.
// Prítomnosť (kde hráči stoja, či hľadajú v tráve) je ctx.presence a ctx.actor (záznam konajúceho hráča) – nie je to stav.
// Správa 'act' (klik na políčko s predmetom v ruke) sa najprv rozloží (resolveAct) na konkrétnu akciu podľa políčka,
// predmetu a prítomnosti; server to urobí pri skladaní dávky, aby v denníku bolo, čo hráč naozaj urobil (pick, till…).
const D = require('./shared/data.js');
const E = require('./engine.js');
const Econ = require('./economy.js');
const I = require('./items.js');
const Ice = require('./ice.js');
const Scav = require('./scavenge.js');
const Areas = require('./areas.js');
const Events = require('./events.js');
const Spiders = require('./spiders.js');
const Dielna = require('./dielna.js');

const TPD = D.TICKS_PER_DAY;
const HOUSE = { x: 3.5, y: 28.5 };
const DANCE_MS = 6500; // ako dlho po emócii „tanec“ sa hráč ráta za tancujúceho
const SCAV_MOVE = 0.35; // o koľko sa smie hľadajúci hráč pohnúť, kým hľadanie preruší
const season = tick => D.seasonOf(D.dayOfTick(tick));
const toast$ = (to, text, kind) => ({ to, t: 'toast', text, kind: kind || 'info' });
const fx$ = (area, k, x, y, extra) => Object.assign({ to: E.area(area), t: 'fx', k, x, y }, extra || {});
const input = (type, data) => ({ type, data });

// ---------- Prítomnosť ----------
// Záznam prítomnosti: { key, name, area, x, y, scav: { i, n, px, py } | null, emote, emoteAt } – snímka pripojeného hráča (server: presenceOf)
function inRing(p) { if (!p || p.area !== 'garden') return false; const x = Math.floor(p.x), y = Math.floor(p.y); return x >= D.RING.x0 && x <= D.RING.x1 && y >= D.RING.y0 && y <= D.RING.y1; }
function nearHouse(p) { return !!p && p.area === 'garden' && Math.hypot(p.x - HOUSE.x, p.y - HOUSE.y) <= 3.5; }
function nearIcehouse(p) {
  const L = D.ICEHOUSE.lot;
  return !!p && p.area === 'garden' && Math.hypot(p.x - (L.x0 + L.x1 + 1) / 2, p.y - (L.y0 + L.y1 + 1) / 2) <= 3;
}
// Iný hráč stojaci na políčku (x, y) tej istej plochy
function playerAt(presence, me, x, y) {
  for (const o of presence || []) if (o.key !== me.key && o.area === me.area && Math.hypot(o.x - (x + 0.5), o.y - (y + 0.5)) < 0.8) return o;
  return null;
}
const byKey = (presence, key) => (presence || []).find(p => p.key === key) || null;
// Konajúci hráč musí byť prítomný (odpojil sa medzi správou a dávkou → akcia potichu neprejde)
const who = ctx => ctx.actor || ctx.reject(null);
const nameOf = (ctx, key) => (ctx.actor ? ctx.actor.name : key);

// ---------- Pomocníci nad výrezmi ----------
const saveOf = (s, key, ctx) => s['save:' + key] || ctx.reject(null);
function give(sv, id, n, tick, batches) { I.addItems(I.playerC(sv), id, n, tick, batches); }
function take(sv, id, n, tick) { return I.removeItems(I.playerC(sv), id, n, tick); }
// Políčka záhrady okolo (x, y) v polomere r: indexy
function around(x, y, r) {
  const out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < D.W && ny < D.H) out.push(ny * D.W + nx);
  }
  return out;
}
const tileKeys = idx => idx.map(i => 'tile:garden:' + i);
// Políčka z výrezov ako „pole“ indexované políčkom (pre revealWild a spol.)
function tilesFrom(s, idx) { const t = {}; for (const i of idx) t[i] = s['tile:garden:' + i]; return t; }
// Dážď (elixír, studňa): počasie, polievanie záhrady; živí aj ľadovec, najviac raz za deň (glacierFed)
const RAIN_KEYS = ['weather', 'tile:garden:*', 'tile:hory:*', 'glacierFed'];
function rain(s, ctx) {
  s.weather = 'rain';
  for (const t of s['tile:garden:*']) if (t.s) t.s.w = 1;
  const day = D.dayOfTick(ctx.tick);
  if (s.glacierFed === day) return;
  s.glacierFed = day;
  Ice.feedGlacier(s['tile:hory:*'], 'rain', Ice.occupied(ctx.presence));
}
// Hľadá sa s čímkoľvek okrem motyky (kope) a elixírov (dajú sa použiť kdekoľvek)
function searchesWith(item) { return item !== 'hoe' && !item.startsWith('po_'); }
// Rohy tela hráča na (x, y): indexy políčok plochy, na ktorých telo leží (roh tesne za okrajom plochy sa ráta k okrajovému políčku –
// stred je v ploche vďaka clampPos a klient sa k okraju dostane rovnako blízko)
function bodyTiles(area, x, y) {
  const { w, h } = D.areaSize(area), out = new Set();
  for (const dy of [-D.BODY.ry, D.BODY.ry]) for (const dx of [-D.BODY.rx, D.BODY.rx]) {
    const tx = Math.max(0, Math.min(w - 1, Math.floor(x + dx))), ty = Math.max(0, Math.min(h - 1, Math.floor(y + dy)));
    out.add(ty * w + tx);
  }
  return out;
}

// ---------- Uloženie hráča ----------
// Nový hráč začína chudobne: pár semienok sezónneho kvetu a malá krhla (povolenie na pole je spoločné pre záhradu).
// start = { coins, rep } zo serverového prostredia (v náhľadoch viac), aby bol záznam v denníku úplný.
function newSave(tick, start) {
  const se = season(tick);
  const sp = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict && D.SPECIES[k].seasons.includes(se))
    .sort((a, b) => D.SPECIES[a].seed - D.SPECIES[b].seed)[0];
  return {
    coins: start.coins, water: 5, inv: { hoe: 1, can: 1, ['seed_' + sp]: 4 },
    recipes: [], seen: [sp], vily: 0, look: null, talked: false, rep: start.rep, up: { can: 0, composter: 0 },
    x: D.SPAWN.x, y: D.SPAWN.y, area: 'garden'
  };
}
// Hráči zo starších verzií hry: nezoberieme im to, čo mali (krhla na 25; pole prešlo na záhradu v migrate).
function migrateSave(sv, tick) {
  if (!sv.up) sv.up = { can: 2, composter: 0 };
  if (sv.rep == null) sv.rep = 0;
  sv.water = Math.min(sv.water || 0, Econ.canCap(sv));
  I.syncAll(I.playerC(sv), tick); // kvety bez várok dostanú vek 0 (čerstvo odrezané)
}

// ---------- Rozklad správy 'act' ----------
// Z kliknutia na políčko (x, y) s predmetom item urobí konkrétny vstup { type, data }, alebo { toast } (odmietnutie
// podľa prítomnosti či plochy, nič sa nemení), alebo null (nič sa nedeje). world = svet (len číta), me = záznam
// prítomnosti konajúceho hráča, presence = snímka všetkých. Stav políčka si návrh overí znova sám (kolá enginu).
function resolveAct(world, presence, me, m) {
  const x = m.x | 0, y = m.y | 0, item = String(m.item || '');
  const area = me.area, tiles = Areas.areaTiles(world, area), key = me.key;
  if (!Areas.inside(area, x, y)) return null;
  const dist = Math.hypot(me.x - (x + 0.5), me.y - (y + 0.5));
  if (dist > 2.4) return { toast: 'Si príliš ďaleko.' };
  const sv = world.saves[key];
  if (!sv || (item && !sv.inv[item])) return null;
  const i = y * D.areaSize(area).w + x, t = tiles[i];

  // Iný hráč – darovanie (alebo len zamávanie)
  const other = playerAt(presence, me, x, y);
  if (other) {
    if (item === 'po_laska') return input('love', { key, to: other.key });
    if (D.isTool(item) || !item) return input('wave', { key, to: other.key });
    return input('gift', { key, to: other.key, item });
  }
  // Pavučina: v Lese divov ťahať hodváb; kútovú (záhrada, hory) odstráni prázdna ruka či predmet, ktorý na políčku nič nerobí –
  // nástroj (motyka, krhla, semienka…) najprv urobí svoje a pavučinu odstráni, len keď tu nemá čo robiť
  const web = Spiders.resolveAct(world, me, area, i);
  if (web && (web.toast || area === 'les' || !onTile(item))) return web.toast ? web : input(web.type, web.data);
  const none = () => (web ? input(web.type, web.data) : null);
  // Ľad: krompáčom na ľadovci alebo (v zime) na zamrznutej vode
  if (item === 'pick' && (t.g === 'glacier' || t.g === 'water')) return input('digIce', { key, area, i });
  // Ľadovňa: ľad sa vkladá, prikrývka ju izoluje; s čímkoľvek iným hráč dostane vysvetlenie, na čo ľadovňa je (#63)
  if (t.g === 'icehouse') {
    if (item === 'ice') return input('fillIce', { key, n: sv.inv.ice });
    if (item === 'blanket') return input('insulate', { key });
    return { toast: ICEHOUSE_ONLY };
  }
  if (area !== 'garden') {
    if (t.g === 'water' && item === 'can') return input('drawWater', { key, area, i });
    if (t.g === 'glacier') return { toast: 'Na ľad potrebuješ krompáč – kúpiš ho na trhu (záložka Vylepšiť). ⛏️' };
    if (item === 'hoe' || item.startsWith('seed_') || D.isWild(item) || item === 'compost') {
      return { toast: area === 'hory'
        ? 'V horách je pôda kamenistá a studená. Pestuj radšej v záhrade. 🏔️'
        : area === 'les' ? 'V Lese divov je príliš tma – nič by tu nevyrástlo. Pestuj v záhrade. 🌲'
          : 'Les na pomedzí je divý – tu sa nepestuje. Pestuj v záhrade. 🌳' };
    }
    if (item.startsWith('po_')) {
      if (['rast', 'jar', 'hojnost'].includes(item.slice(3))) return { toast: 'Tento elixír pôsobí na záhony – použi ho v záhrade. 🌱' };
      return input('potion', { key, kind: item.slice(3), area, x, y });
    }
    return none();
  }
  // Studňa prianí a voda do krhly
  if (t.g === 'well' && item !== 'can') return input('well', { key });
  if ((t.g === 'water' || t.g === 'well') && item === 'can') return input('drawWater', { key, area, i });
  // Zber
  const p = t.s && t.s.p;
  if (p && !p.d && p.prog >= D.SPECIES[p.sp].days) return input('pick', { key, i });
  // Neprekopaná tráva a v ruke nič, čo by tu niečo robilo → hľadanie divých semienok
  if (Scav.canSearch(t) && searchesWith(item)) {
    if (dist > 0.45) return { toast: 'Postav sa priamo na to políčko trávy. 🔍' };
    return input('scavStart', { key, i, seeds: !!item && (item.startsWith('seed_') || D.isWild(item)) });
  }
  if (item === 'hoe') {
    if (p && p.d) return input('clear', { key, i });
    if (!t.s && D.TILLABLE[t.g]) return input('till', { key, i });
    if (D.canLevel(t)) return input('level', { key, i });
    if (t.g === 'ring' || t.g === 'shroom') return { toast: 'Kruh z húb radšej nechaj tak… niekto tu v noci tancuje. 🍄' };
    return none();
  }
  if (item === 'can') return t.s ? input('water', { key, i }) : none();
  if (item === 'compost') return t.s && !t.s.r ? input('compost', { key, i }) : none();
  if (item.startsWith('seed_')) return input('plant', { key, i, item });
  if (D.isWild(item)) return input('plantWild', { key, i, item });
  if (item.startsWith('po_')) return input('potion', { key, kind: item.slice(3), area, x, y });
  return none();
}
const ICEHOUSE_ONLY = 'Do ľadovne patrí len ľad 🧊 (a hodvábne prikrývky na izoláciu). Kvety ulož do skladu v domčeku – ľad v ľadovni ho chladí, takže v ňom vädnú 4× pomalšie.';
// Predmet, ktorý na políčku niečo robí (kope, polieva, sadí, seká ľad, elixír)
function onTile(item) { return item === 'hoe' || item === 'can' || item === 'pick' || item === 'compost' || item === 'ice' || item.startsWith('seed_') || D.isWild(item) || item.startsWith('po_'); }

// ---------- Návrhy ----------
const PROPOSERS = {
  // --- pohyb (d: { key, x, y }): poloha je stav sveta (pos:<kľúč>); prítomnosť ju už má, tu sa overí a zapíše ---
  // Overenie: v ploche, celé telo na priechodnej zemi (rovnaké pravidlo ako klient, bez výšky skoku, ktorú server nepozná);
  // dvaja hráči smú stáť na jednom políčku. Odmietnutý pohyb server vráti hráčovi ako opravu polohy (správa pos).
  // Brána: prechod do inej plochy zapíše príchodové miesto a pošle pokyn travel. Hľadajúci hráč, ktorý sa pohol, prestane hľadať.
  pos: {
    keys(d, w) {
      const sv = w.saves && w.saves[d.key], area = sv && D.AREAS.includes(sv.area) ? sv.area : 'garden';
      const reads = new Set(), { w: aw } = D.areaSize(area);
      if (Number.isFinite(+d.x) && Number.isFinite(+d.y)) {
        const p = Areas.clampPos(area, +d.x, +d.y);
        for (const i of bodyTiles(area, p.x, p.y)) reads.add('tile:' + area + ':' + i);
        reads.add('tile:' + area + ':' + (Math.floor(p.y) * aw + Math.floor(p.x)));
      }
      return E.mergeKeys({ writes: ['pos:' + d.key], reads: [...reads] }, Spiders.posKeys(d, w)); // pavučiny v lese, pavúky
    },
    run(s, d, ctx) {
      const pos = s['pos:' + d.key];
      if (!pos) return ctx.reject(null);
      const area = D.AREAS.includes(pos.area) ? pos.area : 'garden';
      const from = { area, x: pos.x, y: pos.y };
      if (!(Number.isFinite(+d.x) && Number.isFinite(+d.y))) return ctx.reject(null);
      const p = Areas.clampPos(area, +d.x, +d.y);
      const body = bodyTiles(area, p.x, p.y);
      for (const i of body) if (!D.passable(s['tile:' + area + ':' + i])) return ctx.reject(null);
      pos.x = p.x; pos.y = p.y; pos.lastTick = ctx.tick;
      const me = ctx.actor;
      if (me && me.scav && Math.hypot(p.x - me.scav.px, p.y - me.scav.py) > SCAV_MOVE) {
        ctx.cancel('scavDone:' + d.key);
        ctx.emit({ to: d.key, t: 'scavDone' });
        ctx.emit(toast$(d.key, 'Pohol(a) si sa skôr, než si dohľadal(a).'));
      }
      const { w: aw } = D.areaSize(area), under = s['tile:' + area + ':' + (Math.floor(p.y) * aw + Math.floor(p.x))];
      if (under && under.g === 'gate') {
        const g = D.gateAt(area, Math.floor(p.x), Math.floor(p.y)), a = g && D.arrival(area, g.to);
        if (a) {
          if (me && me.scav) { ctx.cancel('scavDone:' + d.key); ctx.emit({ to: d.key, t: 'scavDone' }); }
          pos.area = g.to; pos.x = a.x; pos.y = a.y;
          ctx.emit({ to: d.key, t: 'travel', from: area, area: g.to });
        }
      }
      Spiders.onPos(s, d, ctx, from, pos); // vbehnutie do pavučiny, koniec ťahania hodvábu, príchod do Lesa divov
    }
  },
  // hráč je pripojený (každých 15 s) / odišiel: „naposledy videný“ (d: { key })
  seen: { keys: d => ({ writes: ['pos:' + d.key] }), run(s, d, ctx) { const pos = s['pos:' + d.key]; if (!pos) return ctx.reject(null); pos.lastTick = ctx.tick; } },
  leave: { keys: d => ({ writes: ['pos:' + d.key] }), run(s, d, ctx) { const pos = s['pos:' + d.key]; if (!pos) return ctx.reject(null); pos.lastTick = ctx.tick; } },
  // pripojenie (d: { key, name, look, start: { coins, rep }, quick }): nové alebo prevedené uloženie, vzhľad, uvítanie;
  // server po vykonaní pošle hráčovi svet (pokyn joined). quick = rýchle znovupripojenie (bez hlásení)
  join: {
    keys: (d, w) => E.mergeKeys({ writes: ['save:' + d.key, 'maxRep'].concat(w.redeem && Object.keys(w.redeem).length ? ['redeem'] : []), reads: w.saves && w.saves[d.key] ? ['pos:' + d.key] : [] }, Spiders.joinKeys(d, w)),
    run(s, d, ctx) {
      let sv = s['save:' + d.key];
      const fresh = !sv;
      if (fresh) { sv = s['save:' + d.key] = newSave(ctx.tick, d.start || { coins: 30, rep: 0 }); s.maxRep = Math.max(s.maxRep || 0, sv.rep); }
      else migrateSave(sv, ctx.tick);
      sv.look = d.look && typeof d.look === 'object' ? { shirt: String(d.look.shirt || '#4a90d9').slice(0, 9), hair: String(d.look.hair || '#5b3a1a').slice(0, 9), hat: !!d.look.hat } : sv.look;
      const pos = s['pos:' + d.key], area = pos && D.AREAS.includes(pos.area) ? pos.area : 'garden';
      ctx.emit({ to: d.key, t: 'joined' });
      if (!d.quick) ctx.emit(toast$(E.ALL, area === 'garden' ? `${d.name} prišiel(a) do záhrady 🌼` : `${d.name} prišiel(a) – je ${D.AREA_IN[area]} ${D.AREA_FX[area].icon}`));
      const days = d.quick || !pos || pos.lastTick == null ? 0 : Math.max(0, Math.floor((ctx.tick - pos.lastTick) / TPD));
      if (days) ctx.emit(toast$(d.key, `Kým si bol(a) preč, ubehlo ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}. Pozri sa, čo sa v záhrade zmenilo. 🌱`, 'day'));
      Spiders.onJoin(s, d, ctx, area); // pripojil sa priamo v Lese divov – pavúky sa zobudia
      if (s.redeem) { // to, čo v záhrade stálo na pozemku Dielne pred jej príchodom (#23), dostane prvý hráč, ktorý príde
        const got = Dielna.handRedeem(s.redeem, sv, ctx.tick);
        if (got.length) ctx.emit(toast$(d.key, `🪚 Na mieste pri trhu je teraz pozemok pre Dielňu a stojí tam majster hodvábu. Čo tam rástlo, dostávaš ty: ${got.map(([id, n]) => n + '× ' + D.itemName(id)).join(', ')}. 🎁`, 'gift'));
      }
      if (!sv.talked) { sv.talked = true; ctx.emit(toast$(d.key, 'Vitaj! Začínaš s pár semienkami a prázdnym vreckom. Pri babke na severe je nástenka so zákazkami. 👵', 'gift')); }
    }
  },
  // tanec v kruhu z húb (d: { key, now }): v noci sa k dvom tancujúcim (alebo jednému, ktorý vidí víly) zlietnu víly,
  // raz za noc; now = reálny čas správy (prítomnosť má emoteAt v ms), aby záznam v denníku bol úplný
  dance: {
    keys(d, w, presence) {
      const dancers = (presence || []).filter(p => inRing(p) && p.emote === 'dance' && d.now - p.emoteAt < DANCE_MS);
      return { writes: ['fairyNight', ...new Set(dancers.map(p => 'save:' + p.key))] };
    },
    run(s, d, ctx) {
      const me = who(ctx), tick = ctx.tick, min = D.minOfTick(tick);
      if (!inRing(me)) return ctx.reject(null);
      if (!D.isNight(min)) return ctx.reject('Huby pokojne spia. Možno v noci… 🌙');
      const day = D.dayOfTick(tick), nightId = min / 60 >= 12 ? day : day - 1;
      if (s.fairyNight === nightId) return ctx.reject('Víly už dnes v noci odleteli. Príď zajtra. 🧚');
      const dancers = (ctx.presence || []).filter(p => inRing(p) && p.emote === 'dance' && d.now - p.emoteAt < DANCE_MS && s['save:' + p.key]);
      const seeFairies = dancers.some(p => s['save:' + p.key].vily > tick);
      if (dancers.length >= 2 || (dancers.length >= 1 && seeFairies)) {
        s.fairyNight = nightId;
        for (const p of dancers) { give(s['save:' + p.key], 'seed_papradie', 1, tick); give(s['save:' + p.key], 'seed_duhova', 1, tick); }
        ctx.emit(fx$('garden', 'fairies', 3.5, 3.5));
        ctx.emit(toast$(E.ALL, '🧚✨ Z húb sa vzniesli víly a roztancovali sa s ' + dancers.map(p => p.name).join(' a ') + '! Každému darovali papraďové semienko a dúhové semienko.', 'magic'));
      } else {
        ctx.emit(fx$('garden', 'glimmer', 3.5, 3.5));
        ctx.emit(toast$(d.key, 'Huby sa jemne rozžiarili… akoby čakali, kým sa k tancu pridá ešte niekto. ✨', 'magic'));
      }
    }
  },

  // --- políčka záhrady (d: { key, i }) ---
  till: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'plotsUsed'], reads: ['up', 'weather'] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i];
      if (t.s) return ctx.reject('Tu už je záhon.');
      if (!D.TILLABLE[t.g] || t.g === 'ring') return ctx.reject(null);
      const lim = Econ.plotLimit(s.up);
      if (s.plotsUsed >= lim) return ctx.reject(`Spoločné povolenie záhrady je na ${lim} políčok a všetky sú obrobené. Väčšie pole môže pre všetkých kúpiť ktokoľvek na trhu (záložka Vylepšiť), alebo motykou zarovnaj niektoré prázdne políčko.`);
      t.s = { k: D.TILLABLE[t.g], w: s.weather === 'rain' ? 1 : 0, r: 0, p: null, o: d.key };
      s.plotsUsed++;
      ctx.emit(fx$('garden', 'dirt', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5));
    }
  },
  // zarovnať prázdne políčko (ktorýkoľvek hráč) – uvoľní miesto v spoločnom povolení; čerstvo zarovnaná zem semienka nemá
  level: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'plotsUsed', 'scav'] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i];
      if (!D.canLevel(t)) return ctx.reject(null);
      t.s = null; s.plotsUsed--;
      Scav.empty(s.scav, ctx.tick, d.i);
    }
  },
  // motykou odstrániť uhynutú rastlinu (záhon ostáva)
  clear: {
    keys: d => ({ writes: ['tile:garden:' + d.i] }),
    run(s, d, ctx) { const t = s['tile:garden:' + d.i], p = t.s && t.s.p; if (!p || !p.d) return ctx.reject(null); t.s.p = null; }
  },
  water: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'save:' + d.key] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i], sv = saveOf(s, d.key, ctx);
      if (!t.s) return ctx.reject(null);
      if (sv.water <= 0) return ctx.reject('Krhla je prázdna – načri vodu v jazierku alebo v studni. 💧');
      sv.water--; t.s.w = 1;
      ctx.emit(fx$('garden', 'drops', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5));
    }
  },
  compost: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'save:' + d.key] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i], sv = saveOf(s, d.key, ctx);
      if (!t.s || t.s.r) return ctx.reject(null);
      if (!take(sv, 'compost', 1, ctx.tick)) return ctx.reject(null);
      t.s.r = 1;
    }
  },
  // d: { key, i, item: 'seed_<druh>' }
  plant: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'save:' + d.key], reads: ['eternal'] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i], sv = saveOf(s, d.key, ctx), sp = D.SPECIES[String(d.item).slice(5)];
      if (!sp) return ctx.reject(null);
      if (!t.s) return ctx.reject('Najprv zem prekopaj motykou.');
      if (t.s.p) return ctx.reject(null);
      if (!sp.seasons.includes(season(ctx.tick)) && !s.eternal) return ctx.reject(`${sp.name} sa sadí v období: ${sp.seasons.map(x => D.SEASONS[x]).join(', ')}.`);
      if (!take(sv, d.item, 1, ctx.tick)) return ctx.reject(null);
      t.s.p = { sp: d.item.slice(5), prog: 0, q: 3, dry: 0 };
      if (sp.strict && t.s.k !== sp.soil) ctx.emit(toast$(d.key, `Hmm, ${sp.name} tu asi nebude rásť…`));
    }
  },
  // divé semienko (d.item = 'wild_<obdobie>'): druh sa určí teraz podľa cien kvetov a už sa nezmení; hráč ho uvidí, až keď vyklíči
  plantWild: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'save:' + d.key], reads: ['eternal', 'market:fl_*'] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i], sv = saveOf(s, d.key, ctx), item = String(d.item);
      if (!D.isWild(item)) return ctx.reject(null);
      if (!t.s) return ctx.reject('Najprv zem prekopaj motykou.');
      if (t.s.p) return ctx.reject(null);
      const ws = +item.slice(5);
      if (ws !== season(ctx.tick) && !s.eternal) return ctx.reject(`Toto divé semienko je z obdobia ${D.SEASONS[ws].toLowerCase()} – vtedy ho aj zasaď.`);
      if (!take(sv, item, 1, ctx.tick)) return ctx.reject(null);
      const m = { flowers: s['market:fl_*'] };
      t.s.p = { sp: Scav.pickWild(ctx.rng, ws, sp => Econ.flowerPrice(m, ctx.tick, sp)), prog: 0, q: 3, dry: 0, wild: 1 };
      ctx.emit(toast$(d.key, 'Zasadil(a) si divé semienko. Čo z neho vyrastie? 🤔'));
    }
  },
  pick: {
    keys: d => ({ writes: ['tile:garden:' + d.i, 'save:' + d.key] }),
    run(s, d, ctx) {
      const t = s['tile:garden:' + d.i], sv = saveOf(s, d.key, ctx), p = t.s && t.s.p;
      if (!p || p.d || p.prog < D.SPECIES[p.sp].days) return ctx.reject('Tu nič nekvitne.');
      const sp = D.SPECIES[p.sp];
      if (p.sp === 'papradie' && !D.isNight(D.minOfTick(ctx.tick))) return ctx.reject('Papraď drží púčik pevne zatvorený… vraj sa otvára len v noci. 🌙');
      const n = Math.min(4, p.q + (t.s.r ? 1 : 0));
      give(sv, 'fl_' + p.sp, n, ctx.tick);
      t.s.r = 0;
      if (sp.perennial) { p.prog = sp.days * 0.5; p.q = 3; p.bt = null; } else t.s.p = null;
      ctx.emit(toast$(d.key, `+${n}× ${sp.name}` + (n >= 3 ? ' ⭐ výborná kvalita!' : '')));
      if (p.sp === 'papradie') ctx.emit(toast$(E.ALL, `✨ ${nameOf(ctx, d.key)} našiel(a) papraďový kvet! Môže si niečo priať…`, 'magic'));
      ctx.emit(fx$('garden', p.sp === 'papradie' ? 'sparkle' : 'pop', d.i % D.W + 0.5, Math.floor(d.i / D.W) + 0.5, { c: sp.color }));
    }
  },

  // --- hľadanie divých semienok v tráve: hráč sa prikrčí na D.SCAVENGE.ticks krokov (udalosť scavDone, events.js) ---
  // d: { key, i, seeds }; server po vykonaní nastaví prítomnosť (pl.scav) podľa správy scavStart; značka n = id vstupu
  scavStart: {
    keys: d => ({ reads: ['tile:garden:' + d.i] }),
    run(s, d, ctx) {
      who(ctx);
      if (!Scav.canSearch(s['tile:garden:' + d.i])) return ctx.reject(null);
      ctx.emit({ to: d.key, t: 'scavStart', i: d.i, n: ctx.id, seeds: !!d.seeds });
      ctx.scheduleUnique('scavDone:' + d.key, ctx.tick + D.SCAVENGE.ticks, 'scavDone', { key: d.key, n: ctx.id, i: d.i, seeds: !!d.seeds });
    }
  },
  // hráč prestal hľadať (pohol sa, urobil niečo iné, ide spať, odišiel z plochy): zruší čakajúcu udalosť
  scavStop: {
    keys: () => ({}),
    run(s, d, ctx) { ctx.cancel('scavDone:' + d.key); }
  },

  // --- ľad a voda (d: { key, area, i }) ---
  digIce: {
    keys: d => ({ writes: ['tile:' + d.area + ':' + d.i, 'save:' + d.key] }),
    run(s, d, ctx) {
      const t = s['tile:' + d.area + ':' + d.i], sv = saveOf(s, d.key, ctx);
      if (!t) return ctx.reject(null);
      if ((sv.inv.ice || 0) >= D.ICE_CARRY) return ctx.reject(`Viac ľadu neunesieš (najviac ${D.ICE_CARRY}). Odnes ho do ľadovne – kým sa neroztopí. 🧊`);
      const r = Ice.digIce([t], 0, season(ctx.tick));
      if (!r.ok) return ctx.reject(r.msg);
      give(sv, 'ice', 1, ctx.tick);
      const w = D.areaSize(d.area).w;
      ctx.emit(toast$(d.key, r.msg));
      ctx.emit(fx$(d.area, 'ice', d.i % w + 0.5, Math.floor(d.i / w) + 0.5));
    }
  },
  // Ľadovňa: hráč do nej vloží ľad z batohu (najviac toľko, koľko sa zmestí). d: { key, n }
  fillIce: {
    keys: d => ({ writes: ['icehouse', 'storage', 'save:' + d.key] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!s.icehouse.built) return ctx.reject('Ľadovňa ešte nie je postavená. Kúpiš ju na trhu (záložka Vylepšiť). 🧊');
      if (!nearIcehouse(me)) return ctx.reject('Podíď bližšie k ľadovni.');
      const n = Math.min(d.n | 0, sv.inv.ice || 0);
      if (n <= 0) return ctx.reject('Nemáš ľad. Vysekáš ho krompáčom na ľadovci v horách, v zime aj na jazierku. ⛏️');
      const k = Ice.fillIcehouse(s.icehouse, s.storage, ctx.tick, n);
      if (!k) return ctx.reject('Ľadovňa je plná. 🧊');
      take(sv, 'ice', k, ctx.tick);
      ctx.emit(toast$(d.key, `🧊 Vložil(a) si ${k}× ľad. V ľadovni je ${Math.ceil(s.icehouse.ice)}/${D.ICEHOUSE.cap}.`));
      ctx.emit(fx$('garden', 'ice', D.ICEHOUSE.lot.x0 + 1, D.ICEHOUSE.lot.y0 + 1));
    }
  },
  // Izolácia ľadovne (#23): hráč vloží 1 hodvábnu prikrývku. d: { key }
  insulate: {
    keys: d => ({ writes: ['icehouse', 'save:' + d.key] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!nearIcehouse(me)) return ctx.reject('Podíď bližšie k ľadovni.');
      const before = D.insulLevel(s.icehouse.bl);
      const err = Ice.insulate(s.icehouse, sv);
      if (err) return ctx.reject(err);
      const B = D.ICEHOUSE, bl = s.icehouse.bl, lvl = D.insulLevel(bl), next = B.blankets[lvl + 1];
      const pct = Math.round(B.insul[lvl] * 100);
      if (lvl > before) ctx.emit(toast$(E.ALL, `🧶 ${nameOf(ctx, d.key)} izoloval(a) ľadovňu hodvábnymi prikrývkami – izolácia úrovne ${lvl}! Ľad sa v nej topí už len na ${pct} %.`, 'gift'));
      else ctx.emit(toast$(d.key, `🧶 Vložil(a) si prikrývku do ľadovne (${bl}/${next}). Pri ${next} prikrývkach bude izolácia úrovne ${lvl + 1}.`));
      ctx.emit(fx$('garden', 'ice', B.lot.x0 + 1, B.lot.y0 + 1));
    }
  },
  // krhla do vody (jazierko, studňa)
  drawWater: {
    keys: d => ({ writes: ['save:' + d.key], reads: ['tile:' + d.area + ':' + d.i] }),
    run(s, d, ctx) {
      const t = s['tile:' + d.area + ':' + d.i], sv = saveOf(s, d.key, ctx);
      if (!t || (t.g !== 'water' && t.g !== 'well')) return ctx.reject(null);
      sv.water = Econ.canCap(sv);
      const w = D.areaSize(d.area).w;
      ctx.emit(fx$(d.area, 'splash', d.i % w + 0.5, Math.floor(d.i / w) + 0.5));
    }
  },

  // --- studňa prianí (d: { key }): 5 mincí za náhodu; dážď mení počasie a záhradu, preto ich deklaruje vždy ---
  well: {
    keys: d => ({ writes: ['save:' + d.key, ...RAIN_KEYS] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), g = ctx.rng;
      if (sv.coins < 5) return ctx.reject('Na prianie potrebuješ hodiť do studne 5 🪙.');
      sv.coins -= 5;
      const r = g.rand();
      if (r < 0.45) ctx.emit(toast$(d.key, '🪙 Žbluňk… Zo studne zašepkal hlas: „' + g.pick(D.TIPS) + '“', 'magic'));
      else if (r < 0.65) {
        const sp = g.pick(Object.keys(D.SPECIES).filter(k => !D.SPECIES[k].magic));
        give(sv, 'seed_' + sp, 2, ctx.tick);
        ctx.emit(toast$(d.key, `🪙 Žbluňk… Z hĺbky vyletelo vrecúško: 2× semienka ${D.SPECIES[sp].name}!`, 'gift'));
      } else if (r < 0.75 && s.weather !== 'rain' && season(ctx.tick) !== 3) {
        rain(s, ctx);
        ctx.emit(toast$(E.ALL, '🪙 Studňa zahučala a z neba sa spustil dážď!', 'magic'));
      } else if (r < 0.77) {
        give(sv, 'seed_papradie', 1, ctx.tick);
        ctx.emit(toast$(d.key, '🪙 Na dne studne sa niečo zalesklo… Papraďové semienko!', 'magic'));
      } else ctx.emit(toast$(d.key, '🪙 Žbluňk. Nič sa nestalo. Možno nabudúce.'));
      ctx.emit(fx$('garden', 'splash', 7.5, 28.5));
    }
  },

  // --- elixíry (d: { key, kind, area, x, y }); kľúče podľa druhu: okolité záhony, dážď, všetci prítomní (dúha)… ---
  potion: {
    keys(d, w, presence) {
      const sv = 'save:' + d.key;
      switch (d.kind) {
        case 'rast': { // okrem záhonov aj herbár vlastníkov divých rastlín, ktoré vyklíčia (revealWild)
          const idx = around(d.x, d.y, 1), writes = new Set([sv, ...tileKeys(idx)]);
          for (const i of idx) { const t = w.tiles && w.tiles[i], p = t && t.s && t.s.p; if (p && p.wild && t.s.o && w.saves && Object.prototype.hasOwnProperty.call(w.saves, t.s.o)) writes.add('save:' + t.s.o); }
          return { writes: [...writes] };
        }
        case 'jar': return { writes: [sv, ...tileKeys(around(d.x, d.y, 1))] };
        case 'hojnost': return { writes: [sv, ...tileKeys(around(d.x, d.y, 2))] };
        case 'dazd': return { writes: [sv, ...RAIN_KEYS] };
        case 'duha': return { writes: [...new Set([sv, ...(presence || []).map(p => 'save:' + p.key)]), 'tile:garden:*'] };
        default: return { writes: [sv] };
      }
    },
    run(s, d, ctx) {
      const k = String(d.kind), sv = saveOf(s, d.key, ctx), name = nameOf(ctx, d.key);
      if (k === 'laska') return ctx.reject('Tento elixír treba darovať niekomu milému – postav sa k inému hráčovi. 💕');
      if (!D.POTIONS[k] || !take(sv, 'po_' + k, 1, ctx.tick)) return ctx.reject(null);
      const cx = d.x + 0.5, cy = d.y + 0.5;
      if (k === 'rast') {
        const idx = around(d.x, d.y, 1), tiles = tilesFrom(s, idx), saves = {};
        for (const key in s) if (key.startsWith('save:')) saves[key.slice(5)] = s[key];
        for (const i of idx) {
          const t = tiles[i];
          if (t.s && t.s.p && !t.s.p.d) { const sp = D.SPECIES[t.s.p.sp]; t.s.p.prog = Math.min(sp.days, t.s.p.prog + 1); t.s.w = 1; Events.revealWild(tiles, saves, i); }
        }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#7ed957' }));
      } else if (k === 'dazd') {
        rain(s, ctx);
        ctx.emit(toast$(E.ALL, `🌧️ ${name} privolal(a) dážď!`, 'magic'));
      } else if (k === 'jar') {
        for (const i of around(d.x, d.y, 1)) { const t = s['tile:garden:' + i]; if (t.s && t.s.p && !t.s.p.d) t.s.p.b = 1; }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#f48fb1' }));
        ctx.emit(toast$(d.key, 'Tieto kvety teraz rastú v každom ročnom období. 🌸'));
      } else if (k === 'hojnost') {
        for (const i of around(d.x, d.y, 2)) { const t = s['tile:garden:' + i]; if (t.s) { t.s.r = 1; if (t.s.p && !t.s.p.d) t.s.p.q = 3; } }
        ctx.emit(fx$('garden', 'sparkle', cx, cy, { c: '#ffd54f' }));
      } else if (k === 'vily') {
        sv.vily = ctx.tick + TPD;
        ctx.scheduleUnique('vilyEnd:' + d.key, sv.vily, 'vilyEnd', { key: d.key });
        ctx.emit(toast$(d.key, 'Svet sa zatrblietal… Teraz vidíš víly. Možno by si v noci mal(a) zájsť do lesa ku kruhu z húb. 🧚', 'magic'));
      } else if (k === 'duha') { // všetci pripojení hráči dostanú mince, kvety v záhrade najvyššiu kvalitu
        for (const p of ctx.presence || []) { const o = s['save:' + p.key]; if (o) o.coins += 300; }
        for (const t of s['tile:garden:*']) if (t.s && t.s.p && !t.s.p.d) t.s.p.q = 3;
        ctx.emit({ to: E.ALL, t: 'fx', k: 'rainbow' });
        ctx.emit(toast$(E.ALL, `🌈 ${name} uvaril(a) Dúhový elixír! Nad záhradou sa klenie dúha. Všetci dostávajú 300 🪙 a kvety najvyššiu kvalitu!`, 'magic'));
      } else if (k === 'sliz') {
        const me = who(ctx);
        ctx.emit(toast$(d.key, 'Vypil(a) si čudný sliz. Chvíľu si videl(a) farby, ktoré neexistujú. 🫠'));
        ctx.emit(fx$(me.area, 'burp', me.x, me.y));
      }
    }
  },

  // --- iný hráč (d: { key, to, item? }) ---
  gift: {
    keys: d => ({ writes: ['save:' + d.key, 'save:' + d.to] }),
    run(s, d, ctx) {
      const me = who(ctx), other = byKey(ctx.presence, d.to), sv = saveOf(s, d.key, ctx), osv = saveOf(s, d.to, ctx), item = String(d.item);
      if (!other) return ctx.reject(null);
      if (item === 'ice' && (osv.inv.ice || 0) >= D.ICE_CARRY) return ctx.reject(`${other.name} už viac ľadu neunesie (najviac ${D.ICE_CARRY}).`);
      const b = take(sv, item, 1, ctx.tick);
      if (!b) return ctx.reject(null);
      give(osv, item, 1, ctx.tick, b);
      ctx.emit(toast$(d.key, `Daroval(a) si ${other.name}: ${D.itemName(item)} 🎁`));
      ctx.emit(toast$(d.to, `${me.name} ti daroval(a): ${D.itemName(item)} 🎁`, 'gift'));
      ctx.emit(fx$(me.area, 'gift', other.x, other.y));
    }
  },
  love: {
    keys: d => ({ writes: ['save:' + d.key, 'save:' + d.to] }),
    run(s, d, ctx) {
      const me = who(ctx), other = byKey(ctx.presence, d.to), sv = saveOf(s, d.key, ctx), osv = saveOf(s, d.to, ctx);
      if (!other || !take(sv, 'po_laska', 1, ctx.tick)) return ctx.reject(null);
      give(sv, 'seed_duhova', 2, ctx.tick); give(osv, 'seed_duhova', 2, ctx.tick);
      sv.coins += 50; osv.coins += 50;
      ctx.emit(fx$(me.area, 'hearts', (me.x + other.x) / 2, (me.y + other.y) / 2));
      ctx.emit(toast$(E.ALL, `💕 ${me.name} daroval(a) ${other.name} Elixír lásky! Obaja dostávajú dúhové semienka.`, 'magic'));
    }
  },
  // zamávanie (náradie alebo prázdna ruka pri inom hráčovi) – nič sa nemení, len efekt
  wave: {
    keys: () => ({}),
    run(s, d, ctx) { const me = who(ctx), other = byKey(ctx.presence, d.to); if (!other) return ctx.reject(null); ctx.emit(fx$(me.area, 'wave', other.x, other.y)); }
  },

  // --- trh (d: { key, id, n }): len položka tovaru a batoh hráča ---
  buy: {
    keys: d => ({ writes: [Econ.marketKey(String(d.id)), 'save:' + d.key].filter(Boolean) }),
    run(s, d, ctx) {
      const id = String(d.id), sv = saveOf(s, d.key, ctx);
      const r = Econ.buy(Econ.marketSlice(s, id), ctx.tick, sv, id, d.n);
      if (!r.n) return ctx.reject(r.msg);
      ctx.emit(toast$(d.key, r.msg));
    }
  },
  sell: {
    keys: d => ({ writes: [Econ.marketKey(String(d.id)), 'save:' + d.key].filter(Boolean) }),
    run(s, d, ctx) {
      const id = String(d.id), sv = saveOf(s, d.key, ctx);
      const r = Econ.sell(Econ.marketSlice(s, id), ctx.tick, sv, id, d.n);
      if (!r.n) return ctx.reject(r.msg);
      ctx.emit(toast$(d.key, r.msg));
    }
  },
  // vylepšenie (d: { key, kind }); spoločné (povolenie na pole) patrí záhrade – kľúč 'up'
  upgrade: {
    keys: d => { const u = D.UPGRADES[d.kind]; return { writes: u && u.shared ? ['save:' + d.key, 'up'] : ['save:' + d.key] }; },
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), kind = String(d.kind), u = D.UPGRADES[kind];
      const err = Econ.upgrade(s.up, sv, kind);
      if (err) return ctx.reject(err);
      if (u.shared) ctx.emit(toast$(E.ALL, `${u.icon} ${nameOf(ctx, d.key)} kúpil(a) pre celú záhradu ${u.name}: ${u.levels[s.up[kind]].v} ${u.unit} pre všetkých!`, 'gift'));
      else ctx.emit(toast$(d.key, `${u.icon} ${u.name}: úroveň ${sv.up[kind]} (${u.levels[sv.up[kind]].v} ${u.unit})`, 'gift'));
    }
  },
  buyTool: {
    keys: d => ({ writes: ['save:' + d.key] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = String(d.id);
      const err = Ice.buyTool(sv, id);
      if (err) return ctx.reject(err);
      const T = D.TOOLS[id];
      ctx.emit(toast$(d.key, `${T.icon} Kúpil(a) si: ${T.name}. ${T.desc}`, 'gift'));
    }
  },
  // stavba (d: { key, id: 'icehouse' | 'dielna' }): spoločná stavba, platí ju hráč; pozemok v záhrade dostane budovu
  build: {
    keys: d => ({ writes: [d.id === 'dielna' ? 'dielna' : 'icehouse', 'tile:garden:*', 'save:' + d.key, 'corners'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), dielna = d.id === 'dielna';
      const err = dielna ? Dielna.buildDielna(s.dielna, s['tile:garden:*'], sv) : Ice.buildIcehouse(s.icehouse, s['tile:garden:*'], sv);
      if (err) return ctx.reject(err);
      if (s.corners) Spiders.pruneCorners(s.corners, s['tile:garden:*'], 'garden'); // kúty, ktoré budova zakryla
      ctx.emit(toast$(E.ALL, dielna
        ? `🪚 ${nameOf(ctx, d.key)} postavil(a) pri trhu Dielňu! Kúp do nej krosná – utkajú prikrývky z hodvábu lacnejšie než majster.`
        : `🧊 ${nameOf(ctx, d.key)} postavil(a) pri domčeku ľadovňu! Naplň ju ľadom – kým v nej je, kvety v sklade vädnú 4× pomalšie.`, 'gift'));
    }
  },
  // --- pavúčí hodváb (#23): majster hodvábu a krosná v Dielni (d: { key }) ---
  buyLoom: {
    keys: d => ({ writes: ['dielna', 'save:' + d.key] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) return ctx.reject('Podíď bližšie k Dielni.');
      const err = Dielna.buyLoom(s.dielna, sv);
      if (err) return ctx.reject(err);
      ctx.emit(toast$(E.ALL, `🧶 ${nameOf(ctx, d.key)} kúpil(a) do Dielne krosná! Utkajú prikrývku zo ${D.BLANKET_SILK} hodvábu – bez platenia, len to chvíľu trvá. Majster hodvábu sa s dedinkou rozlúčil – už ho tu netreba.`, 'gift'));
    }
  },
  masterWeave: {
    keys: d => ({ writes: ['save:' + d.key], reads: ['dielna'] }), // keď sú v Dielni krosná, majster nechodí
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      const why = Dielna.masterCheck(me, ctx.tick, s.dielna);
      if (why) return ctx.reject(why);
      const err = Dielna.masterWeave(sv);
      if (err) return ctx.reject(err);
      ctx.emit(toast$(d.key, '🧶 Majster ti utkal hodvábnu prikrývku. Vlož ju do ľadovne – ťukni na ňu s prikrývkou v ruke.', 'gift'));
      const m = D.masterAt(D.dayOfTick(ctx.tick), D.minOfTick(ctx.tick));
      ctx.emit(fx$('garden', 'sparkle', m.x, m.y, { c: '#f3efe6' }));
    }
  },
  loomStart: {
    keys: d => ({ writes: ['dielna', 'save:' + d.key] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) return ctx.reject('Podíď bližšie k Dielni.');
      const r = Dielna.loomStart(s.dielna, sv, d.key, ctx.tick, ctx.rng.rand());
      if (r.err) return ctx.reject(r.err);
      ctx.scheduleUnique('loomDone:' + d.key, r.at, 'loomDone', { key: d.key });
      ctx.emit(toast$(d.key, `🧶 Krosná tkajú tvoju prikrývku. Hotová bude asi o ${Math.round((r.at - ctx.tick) / D.TICKS_PER_HOUR)} h herného času.`));
    }
  },
  loomTake: {
    keys: d => ({ writes: ['dielna', 'save:' + d.key] }),
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!Dielna.nearDielna(me)) return ctx.reject('Podíď bližšie k Dielni.');
      const n = Dielna.loomTake(s.dielna, sv, d.key);
      if (!n) return ctx.reject('V Dielni na teba nečaká žiadna prikrývka.');
      ctx.emit(toast$(d.key, `🧶 Vzal(a) si si ${n}× hodvábnu prikrývku. Vlož ju do ľadovne – ťukni na ňu s prikrývkou v ruke.`, 'gift'));
    }
  },

  // --- zákazky u babky (d: { key, id }) ---
  ctake: {
    keys: d => ({ writes: ['contracts'], reads: ['save:' + d.key] }),
    run(s, d, ctx) {
      const err = Econ.takeContract(s.contracts, ctx.tick, saveOf(s, d.key, ctx), d.key, d.id | 0);
      if (err) return ctx.reject(err);
      ctx.emit(toast$(d.key, '📋 Zákazka je tvoja. Termín platí – nezabudni!'));
    }
  },
  cdeliver: {
    keys: d => ({ writes: ['contracts', 'save:' + d.key, 'maxRep'] }),
    run(s, d, ctx) {
      const r = Econ.deliverContract(s.contracts, ctx.tick, saveOf(s, d.key, ctx), d.key, d.id | 0, s.maxRep, ctx);
      if (!r.n) return ctx.reject(r.msg);
      s.maxRep = r.maxRep;
      ctx.emit(toast$(d.key, r.msg, r.done ? 'gift' : 'info'));
      if (r.done) ctx.emit(fx$('garden', 'hearts', D.BABKA.x + 0.5, D.BABKA.y + 0.5));
    }
  },

  // --- kotlík (d: { key, items: [3× 'fl_…'] }) ---
  brew: {
    keys: d => ({ writes: ['save:' + d.key] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx);
      const items = Array.isArray(d.items) ? d.items.map(String).slice(0, 3) : [];
      if (items.length !== 3 || !items.every(id => id.startsWith('fl_'))) return ctx.reject(null);
      const need = {};
      for (const id of items) need[id] = (need[id] || 0) + 1;
      for (const id in need) if ((sv.inv[id] || 0) < need[id]) return ctx.reject('Tieto kvety nemáš.');
      for (const id in need) take(sv, id, need[id], ctx.tick);
      const recipe = items.map(id => id.slice(3)).sort().join('+');
      const k = D.RECIPES[recipe] || 'sliz';
      give(sv, 'po_' + k, 1, ctx.tick);
      if (k !== 'sliz' && !sv.recipes.includes(recipe)) sv.recipes.push(recipe);
      ctx.emit(fx$('garden', 'brew', 17.5, 5.5, { c: D.POTIONS[k].color }));
      ctx.emit({ to: d.key, t: 'brewed', k });
      if (k === 'duha') ctx.emit(toast$(E.ALL, `🌈 V kotlíku babky sa niečo dúhovo rozžiarilo… ${nameOf(ctx, d.key)} uvaril(a) niečo, čo tu ešte nebolo!`, 'magic'));
    }
  },
  // prianie za papraďový kvet (d: { key, kind }): zlato platí len pripojeným hráčom (podľa prítomnosti)
  wish: {
    keys(d, w, presence) {
      const sv = 'save:' + d.key;
      if (d.kind === 'zlato') return { writes: [...new Set([sv, ...(presence || []).map(p => 'save:' + p.key)])] };
      if (d.kind === 'jar') return { writes: [sv, 'eternal', 'tile:garden:*'] };
      return { writes: [sv] };
    },
    run(s, d, ctx) {
      const me = who(ctx), sv = saveOf(s, d.key, ctx);
      if (!take(sv, 'fl_papradie', 1, ctx.tick)) return ctx.reject(null);
      if (d.kind === 'zlato') {
        for (const p of ctx.presence || []) { const o = s['save:' + p.key]; if (o) o.coins += 400; }
        ctx.emit({ to: E.ALL, t: 'fx', k: 'gold' });
        ctx.emit(toast$(E.ALL, `✨ ${me.name} si prial(a) zlatý dážď! Každý dostáva 400 🪙.`, 'magic'));
      } else if (d.kind === 'jar') {
        s.eternal = true;
        for (const t of s['tile:garden:*']) if (t.s) t.s.w = 1;
        ctx.emit({ to: E.ALL, t: 'fx', k: 'rainbow' });
        ctx.emit(toast$(E.ALL, `✨ ${me.name} si prial(a) večnú jar! Záhrada sa odteraz polieva sama a kvetom nevadí ročné obdobie.`, 'magic'));
      } else {
        give(sv, 'seed_duhova', 3, ctx.tick); give(sv, 'seed_plesnivec', 3, ctx.tick); give(sv, 'seed_papradie', 1, ctx.tick);
        ctx.emit(toast$(E.ALL, `✨ ${me.name} si prial(a) poklad! Zo zeme vyrástla truhlica plná vzácnych semienok.`, 'magic'));
        ctx.emit(fx$(me.area, 'sparkle', me.x, me.y, { c: '#ffd700' }));
      }
    }
  },

  // --- sklad v domčeku (d: { key, id, n }); kvety si pri presune nesú svoj vek, v sklade starnú pomalšie ---
  store: {
    keys: d => ({ writes: ['storage', 'save:' + d.key], reads: ['icehouse'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = String(d.id), n = d.n | 0;
      storeCheck(id, ctx);
      const b = take(sv, id, n, ctx.tick);
      if (!b) return ctx.reject(null);
      I.addItems(I.storageC(s.storage, s.icehouse), id, n, ctx.tick, b);
    }
  },
  unstore: {
    keys: d => ({ writes: ['storage', 'save:' + d.key], reads: ['icehouse'] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx), id = String(d.id), n = d.n | 0;
      storeCheck(id, ctx);
      const b = I.removeItems(I.storageC(s.storage, s.icehouse), id, n, ctx.tick);
      if (!b) return ctx.reject(null);
      give(sv, id, n, ctx.tick, b);
    }
  },
  compostWilted: {
    keys: d => ({ writes: ['save:' + d.key] }),
    run(s, d, ctx) {
      const sv = saveOf(s, d.key, ctx);
      const k = Math.floor((sv.inv.wilted || 0) / D.WILTED_PER_COMPOST);
      if (!k) return ctx.reject(`Na 1 kompost treba ${D.WILTED_PER_COMPOST} zvädnuté kvety.`);
      take(sv, 'wilted', k * D.WILTED_PER_COMPOST, ctx.tick); give(sv, 'compost', k, ctx.tick);
      ctx.emit(toast$(d.key, `♻️ Zo zvädnutých kvetov vznikol ${k}× kompost.`, 'gift'));
    }
  }
};
// Spoločné podmienky skladu: náradie sa neukladá, ľad patrí do ľadovne, hráč musí stáť pri domčeku
function storeCheck(id, ctx) {
  if (D.isTool(id)) ctx.reject(null);
  if (id === 'ice') ctx.reject('Ľad patrí do ľadovne – v sklade by sa roztopil. 🧊');
  if (!nearHouse(who(ctx))) ctx.reject('Sklad je v domčeku – podíď bližšie.');
}

module.exports = { PROPOSERS, resolveAct, searchesWith, nearHouse, nearIcehouse, playerAt, inRing, bodyTiles, newSave, migrateSave, HOUSE };
