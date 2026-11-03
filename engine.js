// Jadro simulácie: diskrétny čas, plánovač udalostí a náhoda so semienkom.
// Celý stav (tick, wall, rng, seq, events) je obyčajný JSON, ukladá sa spolu so svetom.
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

// ---- Plánovač udalostí ----
// events je zoradené podľa (at, seq); seq zaručuje stabilné poradie udalostí v tom istom kroku.
function schedule(world, at, type, data) {
  world.seq = (world.seq || 0) + 1;
  const ev = { at: Math.max(at, world.tick + 1), seq: world.seq, type, data: data === undefined ? null : data };
  const ev2 = world.events;
  let lo = 0, hi = ev2.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = ev2[mid];
    if (m.at < ev.at || (m.at === ev.at && m.seq < ev.seq)) lo = mid + 1; else hi = mid;
  }
  ev2.splice(lo, 0, ev);
  return ev;
}
function scheduleIn(world, ticks, type, data) { return schedule(world, world.tick + Math.max(1, ticks), type, data); }
function cancel(world, pred) { world.events = world.events.filter(e => !pred(e)); }
function nextOf(world, type) { return world.events.find(e => e.type === type) || null; }

// Jeden krok simulácie: posun času a spracovanie všetkých udalostí, ktoré naň pripadajú.
function step(world, handlers) {
  world.tick++;
  while (world.events.length && world.events[0].at <= world.tick) {
    const ev = world.events.shift();
    const h = handlers[ev.type];
    if (h) h(world, ev.data, ev);
  }
}

// Dobehne reálny čas: urobí presne toľko krokov, koľko celých krokov ubehlo od world.wall.
function advance(world, nowMs, handlers, maxSteps) {
  const ms = tickMs(world);
  let n = 0;
  while (nowMs - world.wall >= ms && n < (maxSteps || Infinity)) {
    step(world, handlers);
    world.wall += ms;
    n++;
  }
  return n;
}

// Najbližší krok >= from, ktorý padne na danú dennú hodinu (v krokoch od polnoci).
function nextDailyTick(from, tickOfDay) {
  let t = Math.floor(from / TICKS_PER_DAY) * TICKS_PER_DAY + tickOfDay;
  if (t < from) t += TICKS_PER_DAY;
  return t;
}

module.exports = {
  TICKS_PER_DAY, MIN_PER_TICK, DAWN_TICK, dayOfTick, minOfTick,
  tickMs, rand, randInt, pick, schedule, scheduleIn, cancel, nextOf, step, advance, nextDailyTick
};
