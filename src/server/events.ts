// Udalosti sveta ako návrhy (engine.js): ráno, hodina, koniec hľadania v tráve, koniec elixíru víl.
// Každý návrh deklaruje, čo číta a čo mení (keys), a beží na kópiách práve týchto výrezov (run) – pozri docs/engine.md.
// Správy hráčom idú cez ctx.emit (server ich pošle po vykonaní dávky: to = E.ALL všetkým, E.area(plocha) hráčom na ploche,
// inak kľúč hráča); obnovu políčok, batohov, trhu, nástenky a skladu si server odvodí zo zapísaných kľúčov.
// Prítomnosť pripojených hráčov (kde stoja, či hľadajú v tráve) dostane návrh ako ctx.presence – nie je to stav sveta.
import * as D from '../shared/data.ts';
import type { Season } from '../shared/data.ts';
import type { ToastKind } from '../shared/protocol.ts';
import type { PlayerKey, PlayerSave, Weather } from '../shared/save.ts';
import { entries, lookup, must } from '../shared/util.ts';
import * as E from './engine.ts';
import * as Econ from './economy.ts';
import type { EconInputs } from './economy.ts';
import { sl } from './game.ts';
import type { GamePeriodic, GameProposer, Msg, To } from './game.ts';
import * as I from './items.ts';
import * as Ice from './ice.ts';
import * as Scav from './scavenge.ts';
import * as Dielna from './dielna.ts';
import type { Tile } from './world.ts';

const TPD = D.TICKS_PER_DAY;

// ---------- Rast ----------
// Ranný rast rastliny na políčku i (tiles = políčka záhrady alebo hôr, se = obdobie, eternal = večná jar)
export function growPlant(tiles: readonly Tile[], i: number, tick: number, se: Season, eternal: boolean): void {
  const t = must(tiles[i]), s = t.s, p = s && s.p;
  if (!s || !p || p.d) return;
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
export function revealWild(tiles: readonly Tile[], saves: Partial<Record<PlayerKey, PlayerSave>>, i: number): void {
  const s = must(tiles[i]).s, p = s && s.p;
  if (!s || !p || !p.wild || p.d || !(p.prog > 0)) return;
  delete p.wild;
  // do herbára pribudne tomu, kto políčko prekopal (pole je spoločné, preto už bez osobnej správy)
  const sv = s.o ? saves[s.o] : undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- uloženia spred herbára pole seen nemajú
  if (sv && sv.seen && !sv.seen.includes(p.sp)) sv.seen.push(p.sp);
}

// ---------- Udalosti ----------
// Adresát správy: kľúč hráča (reťazec), E.ALL = všetkým, E.area('hory') = hráčom na ploche
const toast$ = (to: To, text: string, kind?: ToastKind): Msg => ({ to, t: 'toast', text, kind: kind || 'info' });
const ALL = E.ALL;
const WEATHER_TEXT: Readonly<Record<Weather, string>> = { rain: 'Prší – záhrada sa poleje sama. 🌧️', snow: 'Sneží. ❄️', sun: 'Slnečno. ☀️' };

// Dáta udalostí sveta (save.ts SavedEvent)
export interface EventInputs {
  dawn: null;
  hourly: null;
  scavDone: { key: PlayerKey; n: string; i: number; seeds: boolean };
  loomDone: { key: PlayerKey };
  vilyEnd: { key: PlayerKey };
}
const OWN: { [T in keyof EventInputs]: GameProposer<EventInputs[T]> } = {
  // Ráno o 6:00: rastliny rastú, počasie, ľad, trh, kompostéry a nástenka.
  dawn: {
    keys: (d, w) => E.mergeKeys({ writes: ['tile:garden:*', 'tile:hory:*', 'save:*', 'scav', 'weather', 'glacierFed'], reads: ['eternal'] }, Econ.DAWN.keys(d, w)),
    run(s, d, ctx) {
      const tick = ctx.tick, day = D.dayOfTick(tick), se = D.seasonOf(day), tiles = sl(s, 'tile:garden:*');
      for (let i = 0; i < tiles.length; i++) { growPlant(tiles, i, tick, se, s.eternal); revealWild(tiles, sl(s, 'save:*'), i); }
      const hory = sl(s, 'tile:hory:*'); // vodné kvety v plese (#38)
      for (let i = 0; i < hory.length; i++) growPlant(hory, i, tick, se, s.eternal);
      Scav.prune(s.scav, tick);
      const r = ctx.rng.rand();
      s.weather = se === 3 ? (r < 0.4 ? 'snow' : 'sun') : (r < (se === 0 ? 0.35 : 0.25) ? 'rain' : 'sun');
      for (const t of tiles) if (t.s) t.s.w = s.weather === 'rain' || t.s.k === 'water' ? 1 : 0; // vodné kvety sú vždy poliate
      // otvory vo vode zamrznú, ľadovec sa topí a v daždi/snehu dorastie – najviac raz za deň (dážď z elixíru pred ránom sa ráta)
      Ice.dawnIce(tiles, sl(s, 'tile:hory:*'), se, s.glacierFed === day ? null : s.weather, Ice.occupied(ctx.presence));
      if (lookup(D.GLACIER_GROW, s.weather)) s.glacierFed = day;
      Econ.DAWN.run(s, d, ctx);
      if ((day - 1) % D.DAYS_PER_SEASON === 0 && day > 1) ctx.emit(toast$(ALL, `Nastáva ${must(D.SEASONS[se]).toLowerCase()} ${must(D.SEASON_ICONS[se])}`, 'day'));
      ctx.emit(toast$(ALL, `Deň ${String(day)} · ${must(D.SEASONS[se])}. ${WEATHER_TEXT[s.weather]}`, 'day'));
    }
  },
  // Každú hernú hodinu: kvety staršie než ich životnosť zvädnú (v batohoch aj v sklade, aj u offline hráčov), ľad sa topí.
  hourly: {
    keys: () => ({ writes: ['save:*', 'storage', 'icehouse'] }),
    run(s, d, ctx) {
      const tick = ctx.tick, saves = sl(s, 'save:*');
      for (const [key, sv] of entries(saves)) {
        const w = I.wiltSweep(I.playerC(sv), tick);
        const names = Object.entries(w);
        if (names.length) ctx.emit(toast$(key, '🥀 Zvädlo: ' + names.map(([n, k]) => `${String(k)}× ${n}`).join(', ') + '. Zvädnuté kvety sa dajú skompostovať v sklade.'));
        // ľad v batohu sa do pol dňa roztopí
        const k = I.meltSweep(I.playerC(sv), tick);
        if (k) ctx.emit(toast$(key, `💧 V batohu sa ti roztopil ľad (${String(k)}×). Ľad treba rýchlo odniesť do ľadovne.`));
      }
      I.wiltSweep(I.storageC(s.storage, s.icehouse), tick);
      if (Ice.meltHourly(s.icehouse, s.storage, tick, D.seasonOf(D.dayOfTick(tick)))) ctx.emit(toast$(ALL, '💧 Ľad v ľadovni sa roztopil. Sklad už nechladí tak dobre – doplň ľad z hôr alebo v zime z jazierka. 🧊'));
    }
  },
  // Koniec hľadania v tráve (d: { key, n, i, seeds }); hráč musí podľa prítomnosti stále hľadať to isté (n) – inak už udalosť nič neurobí.
  scavDone: {
    keys: d => ({ reads: ['tile:garden:*', 'scavSalt'], writes: ['scav', `save:${d.key}`] }),
    run(s, d, ctx) {
      const p = (ctx.presence || []).find(x => x.key === d.key);
      if (!p || !p.scav || p.scav.n !== d.n) return;
      ctx.emit({ to: d.key, t: 'scavDone' }); // server: hráč prestal hľadať
      const tiles = sl(s, 'tile:garden:*'), t = tiles[d.i], tick = ctx.tick;
      if (!Scav.canSearch(t)) { ctx.emit(toast$(d.key, 'Kým si hľadal(a), niekto tu trávu prekopal.')); return; }
      if (!Scav.roll(s.scavSalt, s.scav, tiles, tick, d.i, ctx.rng)) { ctx.emit(toast$(d.key, 'Nič tu nie je… skús vedľa. 🌾' + (d.seeds ? ' (Na sadenie najprv prekopaj zem motykou.)' : ''))); return; }
      const id = D.wildId(D.seasonOf(D.dayOfTick(tick))), sv = sl(s, `save:${d.key}`);
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
      if (!Dielna.loomDone(s.dielna, d.key)) ctx.reject(null);
      ctx.emit(toast$(d.key, '🧶 Krosná v Dielni dotkali tvoju hodvábnu prikrývku. Vyzdvihni si ju v Dielni pri trhu.', 'gift'));
    }
  },
  vilyEnd: {
    keys: () => ({}),
    run(s, d, ctx) { ctx.emit(toast$(d.key, 'Trblietky okolo teba vyprchali. Víly ťa už nevidia. 🧚')); ctx.emit({ to: d.key, t: 'me' }); }
  }
};

export const PROPOSERS: { [T in keyof (EventInputs & EconInputs)]: GameProposer<(EventInputs & EconInputs)[T]> } = { ...OWN, ...Econ.PROPOSERS };
// Periodické udalosti plánuje engine sám (E.reconcile): ráno o 6:00 a každú celú hodinu, plus ekonomika.
export const PERIODIC: GamePeriodic[] = [
  { key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) },
  { key: 'hourly', type: 'hourly', next: E.every(TPD / 24) },
  ...Econ.PERIODIC
];
