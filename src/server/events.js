// Udalosti sveta ako návrhy (engine.js): ráno, hodina, koniec hľadania v tráve, koniec elixíru víl.
// Každý návrh deklaruje, čo číta a čo mení (keys), a beží na kópiách práve týchto výrezov (run) – pozri docs/engine.md.
// Správy hráčom idú cez ctx.emit (server ich pošle po vykonaní dávky: to = E.ALL všetkým, E.area(plocha) hráčom na ploche,
// inak kľúč hráča); obnovu políčok, batohov, trhu, nástenky a skladu si server odvodí zo zapísaných kľúčov.
// Prítomnosť pripojených hráčov (kde stoja, či hľadajú v tráve) dostane návrh ako ctx.presence – nie je to stav sveta.
const D = require('../shared/data.ts');
const E = require('./engine.js');
const Econ = require('./economy.js');
const I = require('./items.js');
const Ice = require('./ice.js');
const Scav = require('./scavenge.js');
const Dielna = require('./dielna.js');

const TPD = D.TICKS_PER_DAY;

// ---------- Rast ----------
// Ranný rast rastliny na políčku i (tiles = políčka záhrady, se = obdobie, eternal = večná jar)
function growPlant(tiles, i, tick, se, eternal) {
  const t = tiles[i], s = t.s, p = s && s.p;
  if (!p || p.d) return;
  const sp = D.SPECIES[p.sp];
  const x = i % D.W, y = Math.floor(i / D.W);
  const inSeason = sp.seasons.includes(se) || p.b || eternal;
  if (!inSeason) {
    // Mráz zničí všetko nezimné; inak má rastlina 2 dni milosti a kvitnúca vydrží.
    if (se === 3) { p.d = 1; p.why = 'mráz'; return; }
    p.oos = (p.oos || 0) + 1;
    if (p.prog < sp.days && p.oos > 2) { p.d = 1; p.why = 'nesprávne obdobie'; return; }
  }
  const watered = !!s.w || eternal;
  p.dry = watered ? 0 : (p.dry || 0) + 1;
  const tol = sp.water === 1 ? 2 : sp.water === 2 ? 1 : 0;
  const deathAt = sp.water === 1 ? 5 : sp.water === 2 ? 3 : 2;
  if (p.dry >= deathAt) { p.d = 1; p.why = 'sucho'; return; }
  if (p.prog >= sp.days) { // už kvitne – po čase odkvitne (trvalka zakvitne znova)
    if (p.bt == null) p.bt = tick;
    if (tick - p.bt >= sp.life * TPD) {
      if (sp.perennial) { p.prog = sp.days * 0.5; p.bt = null; }
      else { p.d = 1; p.why = 'odkvitla'; }
    }
    return;
  }
  let g = (watered || p.dry < tol) ? 1 : 0;
  let bad = g === 0;
  if (!inSeason) { g *= 0.5; bad = true; }
  const shade = D.isShade(tiles, x, y);
  const lightOk = sp.light === 'any' || (sp.light === 'shade') === shade;
  if (!lightOk) { g *= 0.5; bad = true; }
  const soilOk = !sp.soil || sp.soil === s.k || (sp.soil === 'sand' && s.k === 'rock') || (sp.soil === 'rich' && s.r);
  if (!soilOk) { g = sp.strict ? 0 : g * 0.5; bad = true; }
  if (s.r) g *= 1.5;
  p.prog = Math.min(sp.days, p.prog + g);
  if (p.prog >= sp.days) p.bt = tick;
  if (bad) p.q = Math.max(1, p.q - 1);
}

// Divá rastlina vyklíčila – hráč sa konečne dozvie, čo z nej bude (saves = uloženia hráčov, kvôli herbáru)
function revealWild(tiles, saves, i) {
  const s = tiles[i].s, p = s && s.p;
  if (!p || !p.wild || p.d || !(p.prog > 0)) return;
  delete p.wild;
  // do herbára pribudne tomu, kto políčko prekopal (pole je spoločné, preto už bez osobnej správy)
  const sv = s.o && saves[s.o];
  if (sv && sv.seen && !sv.seen.includes(p.sp)) sv.seen.push(p.sp);
}

// ---------- Udalosti ----------
// Adresát správy: kľúč hráča (reťazec), E.ALL = všetkým, E.area('hory') = hráčom na ploche
const toast$ = (to, text, kind) => ({ to, t: 'toast', text, kind: kind || 'info' });
const ALL = E.ALL;
const PROPOSERS = {
  // Ráno o 6:00: rastliny rastú, počasie, ľad, trh, kompostéry a nástenka.
  dawn: {
    keys: (d, w) => E.mergeKeys({ writes: ['tile:garden:*', 'tile:hory:*', 'save:*', 'scav', 'weather', 'glacierFed'], reads: ['eternal'] }, Econ.DAWN.keys(d, w)),
    run(s, d, ctx) {
      const tick = ctx.tick, day = D.dayOfTick(tick), se = D.seasonOf(day), tiles = s['tile:garden:*'];
      for (let i = 0; i < tiles.length; i++) { growPlant(tiles, i, tick, se, s.eternal); revealWild(tiles, s['save:*'], i); }
      Scav.prune(s.scav, tick);
      const r = ctx.rng.rand();
      s.weather = se === 3 ? (r < 0.4 ? 'snow' : 'sun') : (r < (se === 0 ? 0.35 : 0.25) ? 'rain' : 'sun');
      for (const t of tiles) if (t.s) t.s.w = s.weather === 'rain' ? 1 : 0;
      // otvory vo vode zamrznú, ľadovec sa topí a v daždi/snehu dorastie – najviac raz za deň (dážď z elixíru pred ránom sa ráta)
      Ice.dawnIce(tiles, s['tile:hory:*'], se, s.glacierFed === day ? null : s.weather, Ice.occupied(ctx.presence));
      if (D.GLACIER_GROW[s.weather]) s.glacierFed = day;
      Econ.DAWN.run(s, d, ctx);
      if ((day - 1) % D.DAYS_PER_SEASON === 0 && day > 1) ctx.emit(toast$(ALL, `Nastáva ${D.SEASONS[se].toLowerCase()} ${D.SEASON_ICONS[se]}`, 'day'));
      const wtxt = { rain: 'Prší – záhrada sa poleje sama. 🌧️', snow: 'Sneží. ❄️', sun: 'Slnečno. ☀️' }[s.weather];
      ctx.emit(toast$(ALL, `Deň ${day} · ${D.SEASONS[se]}. ${wtxt}`, 'day'));
    }
  },
  // Každú hernú hodinu: kvety staršie než ich životnosť zvädnú (v batohoch aj v sklade, aj u offline hráčov), ľad sa topí.
  hourly: {
    keys: () => ({ writes: ['save:*', 'storage', 'icehouse'] }),
    run(s, d, ctx) {
      const tick = ctx.tick, saves = s['save:*'];
      for (const key in saves) {
        const w = I.wiltSweep(I.playerC(saves[key]), tick);
        const names = Object.entries(w);
        if (names.length) ctx.emit(toast$(key, '🥀 Zvädlo: ' + names.map(([n, k]) => `${k}× ${n}`).join(', ') + '. Zvädnuté kvety sa dajú skompostovať v sklade.'));
        // ľad v batohu sa do pol dňa roztopí
        const k = I.meltSweep(I.playerC(saves[key]), tick);
        if (k) ctx.emit(toast$(key, `💧 V batohu sa ti roztopil ľad (${k}×). Ľad treba rýchlo odniesť do ľadovne.`));
      }
      I.wiltSweep(I.storageC(s.storage, s.icehouse), tick);
      if (Ice.meltHourly(s.icehouse, s.storage, tick, D.seasonOf(D.dayOfTick(tick)))) ctx.emit(toast$(ALL, '💧 Ľad v ľadovni sa roztopil. Sklad už nechladí tak dobre – doplň ľad z hôr alebo v zime z jazierka. 🧊'));
    }
  },
  // Koniec hľadania v tráve (d: { key, n, i, seeds }); hráč musí podľa prítomnosti stále hľadať to isté (n) – inak už udalosť nič neurobí.
  scavDone: {
    keys: d => ({ reads: ['tile:garden:*', 'scavSalt'], writes: ['scav', 'save:' + d.key] }),
    run(s, d, ctx) {
      const p = (ctx.presence || []).find(x => x.key === d.key);
      if (!p || !p.scav || p.scav.n !== d.n) return;
      ctx.emit({ to: d.key, t: 'scavDone' }); // server: hráč prestal hľadať
      const tiles = s['tile:garden:*'], t = tiles[d.i], tick = ctx.tick;
      if (!Scav.canSearch(t)) return ctx.emit(toast$(d.key, 'Kým si hľadal(a), niekto tu trávu prekopal.'));
      if (!Scav.roll(s.scavSalt, s.scav, tiles, tick, d.i, ctx.rng)) return ctx.emit(toast$(d.key, 'Nič tu nie je… skús vedľa. 🌾' + (d.seeds ? ' (Na sadenie najprv prekopaj zem motykou.)' : '')));
      const id = 'wild_' + D.seasonOf(D.dayOfTick(tick)), sv = s['save:' + d.key];
      if (!sv) return;
      I.addItems(I.playerC(sv), id, 1, tick);
      ctx.emit(toast$(d.key, `🌾 Našiel(a) si ${D.itemName(id).toLowerCase()}!`, 'gift'));
      ctx.emit({ to: E.area('garden'), t: 'fx', k: 'pop', x: d.i % D.W + 0.5, y: Math.floor(d.i / D.W) + 0.5, c: '#9ccc65' });
    }
  },
  // Elixír víl vyprchal: nič sa nemení (sv.vily je čas), hráč sa to len dozvie a klient si obnoví stav
  // krosná v Dielni dotkali prikrývku (#23): čaká v Dielni, kým si ju tkáč (d.key) vezme
  loomDone: {
    keys: () => ({ writes: ['dielna'] }),
    run(s, d, ctx) {
      if (!Dielna.loomDone(s.dielna, d.key)) return ctx.reject(null);
      ctx.emit(toast$(d.key, '🧶 Krosná v Dielni dotkali tvoju hodvábnu prikrývku. Vyzdvihni si ju v Dielni pri trhu.', 'gift'));
    }
  },
  vilyEnd: {
    keys: () => ({}),
    run(s, d, ctx) { ctx.emit(toast$(d.key, 'Trblietky okolo teba vyprchali. Víly ťa už nevidia. 🧚')); ctx.emit({ to: d.key, t: 'me' }); }
  }
};

Object.assign(PROPOSERS, Econ.PROPOSERS);
// Periodické udalosti plánuje engine sám (E.reconcile): ráno o 6:00 a každú celú hodinu, plus ekonomika.
const PERIODIC = [
  { key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) },
  { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) },
  ...Econ.PERIODIC
];

module.exports = { PROPOSERS, PERIODIC, growPlant, revealWild };
