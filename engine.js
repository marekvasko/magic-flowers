// Jadro simulácie: diskrétny čas, fronta udalostí a náhoda so semienkom.
//
// Modul nemá vlastný stav. Všetko, čo sa mení, je vo svete (world) ako obyčajný JSON a ukladá sa s ním:
//   world.tick    – herný čas v krokoch (D.TICKS_PER_DAY krokov na deň)
//   world.wall    – reálny čas (ms), ktorému zodpovedá world.tick
//   world.rng     – stav generátora náhody (uint32)
//   world.seq     – počítadlo naplánovaných udalostí (stabilné poradie v rámci jedného kroku)
//   world.events  – fronta udalostí zoradená podľa (at, seq)
// Správanie dodáva volajúci v „špecifikácii“ (spec), ktorá sa neukladá:
//   spec.handlers – { typ: (world, data, ev) => void }   obyčajné callbacky, samy sa znova neplánujú
//   spec.periodic – [{ key, type, data?, next(world, from) }]   periodické udalosti (pozri reconcile)
//   spec.onError  – (err, ev, world) => void   voliteľné, inak console.error
//
// Udalosť vo fronte: { at, seq, type, data, key?, periodic? }
//   bežná      – bez kľúča; plánuje ju handler alebo akcia hráča (schedule / scheduleIn)
//   unikátna   – s kľúčom; s rovnakým kľúčom je vo fronte najviac jedna (scheduleUnique, zrušenie cez cancel)
//   periodická – s kľúčom a periodic: true; plánuje ju len reconcile podľa spec.periodic
//
// Čas sa neposúva po krokoch, ale skokom na najbližšiu udalosť (advanceTo). Podrobný popis: docs/engine.md.
const { TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick } = require('./shared/data.js');

// Reálne milisekundy na jeden krok
function tickMs(world) { return world.daySeconds * 1000 / TICKS_PER_DAY; }

// ---- Náhoda (mulberry32, stav je jedno uint32 číslo vo svete) ----
function rand(world) {
  let a = (world.rng = (world.rng + 0x6D2B79F5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(world, n) { return Math.floor(rand(world) * n); }
function pick(world, list) { return list[randInt(world, list.length)]; }

// ---- Fronta udalostí ----

// Vloží udalosť na správne miesto (binárne hľadanie podľa (at, seq)).
// Udalosť nikdy nepadne do minulosti ani do práve spracúvaného kroku: najskôr world.tick + 1.
function insert(world, at, type, data, key, periodic) {
  world.seq = (world.seq || 0) + 1;
  const ev = { at: Math.max(at, world.tick + 1), seq: world.seq, type, data: data === undefined ? null : data };
  if (key != null) ev.key = key;
  if (periodic) ev.periodic = true;
  const q = world.events;
  let lo = 0, hi = q.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = q[mid];
    if (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq)) lo = mid + 1; else hi = mid;
  }
  q.splice(lo, 0, ev);
  return ev;
}

// Bežná udalosť v kroku `at`.
function schedule(world, at, type, data) { return insert(world, at, type, data); }
// Bežná udalosť o `ticks` krokov (najmenej o 1).
function scheduleIn(world, ticks, type, data) { return insert(world, world.tick + Math.max(1, ticks), type, data); }
// Unikátna udalosť: zruší čakajúcu udalosť s rovnakým kľúčom a naplánuje novú.
function scheduleUnique(world, key, at, type, data) {
  cancel(world, key);
  return insert(world, at, type, data, key);
}
// Zruší všetky čakajúce udalosti s daným kľúčom. Vráti, koľko ich zrušil.
function cancel(world, key) {
  const before = world.events.length;
  world.events = world.events.filter(e => e.key !== key);
  return before - world.events.length;
}
// Najskoršia čakajúca udalosť s daným kľúčom alebo null.
function pending(world, key) { return world.events.find(e => e.key === key) || null; }
// Krok najbližšej udalosti alebo null, keď je fronta prázdna.
function nextAt(world) { return world.events.length ? world.events[0].at : null; }

// ---- Periodické udalosti: reconciler ----
// Periodické udalosti nikto neplánuje ručne. spec.periodic ich len deklaruje a reconcile zaručí,
// že každý deklarovaný kľúč má vo fronte práve jednu udalosť:
//   1. zahodí udalosti, ktorých typ už nemá handler (obsah odstránený z hry),
//   2. zahodí periodické udalosti, ktorých kľúč už nie je deklarovaný,
//   3. pri duplicitách nechá len najskoršiu,
//   4. chýbajúce naplánuje na def.next(world, world.tick + 1).
// Keď sa periodická udalosť vykoná, z fronty zmizne a najbližší reconcile naplánuje ďalšiu.
// Tak isto sa nové periodické udalosti dostanú aj do starých uložených svetov.
function reconcile(world, spec) {
  const defs = spec.periodic || [];
  const declared = new Set(defs.map(d => d.key));
  const seen = new Set();
  world.events = world.events.filter(e => {
    let why = null;
    if (!spec.handlers[e.type]) why = 'neznámy typ';
    else if (e.periodic && !declared.has(e.key)) why = 'nedeklarovaná periodická';
    else if (e.periodic && seen.has(e.key)) why = 'duplicita';
    if (why) { console.warn(`[engine] zahodená udalosť ${e.key || e.type} (${why})`); return false; }
    if (e.periodic) seen.add(e.key);
    return true;
  });
  for (const def of defs) {
    if (!seen.has(def.key)) insert(world, def.next(world, world.tick + 1), def.type, def.data, def.key, true);
  }
}

// ---- Vykonávanie ----

// Vykoná všetky udalosti, ktoré pripadajú na world.tick, ako jednu dávku.
// Čo dávka naplánuje, padne najskôr na world.tick + 1, takže dávka je vopred uzavretá.
// Chyba v handleri sa zachytí a zapíše; udalosť sa tým spotrebuje a simulácia beží ďalej.
function runBatch(world, spec) {
  let n = 0;
  while (world.events.length && world.events[0].at <= world.tick) {
    const ev = world.events.shift();
    try { spec.handlers[ev.type](world, ev.data, ev); } catch (err) { (spec.onError || logError)(err, ev, world); }
    n++;
  }
  return n;
}
function logError(err, ev, world) {
  console.error(`[engine] chyba v udalosti ${ev.key || ev.type} (krok ${world.tick}, data ${JSON.stringify(ev.data)}):`, err);
}

// Posunie čas na krok `target` skokmi z udalosti na udalosť:
//   reconcile → najbližšia udalosť → ak je až po `target`, koniec → hodiny na ňu → dávka → znova.
// Kroky bez udalostí sa vôbec nesimulujú, takže posun o 1 krok aj o 30 dní je ten istý cyklus.
// Vráti počet vykonaných udalostí.
function advanceTo(world, target, spec) {
  let n = 0;
  for (;;) {
    reconcile(world, spec);
    const at = nextAt(world);
    if (at === null || at > target) break;
    world.tick = Math.max(world.tick, at);
    n += runBatch(world, spec);
  }
  if (target > world.tick) world.tick = target;
  return n;
}

// Dobehne reálny čas: posunie svet o toľko celých krokov, koľko ubehlo od world.wall (najviac maxTicks).
// Vráti, o koľko krokov sa čas posunul.
function advance(world, nowMs, spec, maxTicks) {
  const ms = tickMs(world);
  // tickMs nie je celé číslo – malá tolerancia, aby zaokrúhlenie wall nestratilo celý krok
  const due = Math.min(Math.floor((nowMs - world.wall) / ms + 1e-9), maxTicks || Infinity);
  if (!(due > 0)) return 0;
  advanceTo(world, world.tick + due, spec);
  world.wall += due * ms;
  return due;
}

// ---- Výpočet času periodických udalostí (pre def.next) ----

// Najbližší krok >= from tvaru offset + k * period (každú hodinu, každé 2 dni o 7:00, raz za rok…).
function nextEvery(from, period, offset) {
  const o = ((offset || 0) % period + period) % period;
  return Math.ceil((from - o) / period) * period + o;
}
// Najbližší krok >= from, ktorý padne na danú dennú hodinu (v krokoch od polnoci).
function nextDailyTick(from, tickOfDay) { return nextEvery(from, TICKS_PER_DAY, tickOfDay); }
// Hotové funkcie next pre spec.periodic.
function daily(tickOfDay) { return (world, from) => nextDailyTick(from, tickOfDay); }
function every(period, offset) { return (world, from) => nextEvery(from, period, offset); }

module.exports = {
  TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick,
  tickMs, rand, randInt, pick,
  schedule, scheduleIn, scheduleUnique, cancel, pending, nextAt,
  reconcile, runBatch, advanceTo, advance,
  nextEvery, nextDailyTick, daily, every
};
