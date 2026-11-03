const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');
const TPD = E.TICKS_PER_DAY;

function world(extra) { return Object.assign({ tick: 0, wall: 0, daySeconds: 300, rng: 12345, seq: 0, events: [] }, extra); }

test('každý deň má presne TICKS_PER_DAY krokov, aj pri nepravidelnom časovači', () => {
  const w = world();
  const dayTicks = [];
  let last = 0;
  const handlers = { dawn(w) { dayTicks.push(w.tick - last); last = w.tick; E.schedule(w, w.tick + TPD, 'dawn'); } };
  E.schedule(w, TPD, 'dawn');
  last = 0;
  let now = 0;
  // časovač s rozptylom 0–2500 ms a občasnými veľkými výpadkami
  while (dayTicks.length < 100) {
    now += Math.floor(Math.random() * 2500) + (Math.random() < 0.01 ? 60000 : 0);
    E.advance(w, now, handlers);
  }
  assert.ok(dayTicks.every(n => n === TPD), 'počty krokov: ' + [...new Set(dayTicks)].join(','));
  // reálny čas a herný čas sa nerozchádzajú o viac než jeden krok
  assert.ok(now - w.wall < E.tickMs(w) && now - w.wall >= 0);
  assert.strictEqual(w.tick, Math.floor(now / E.tickMs(w)));
});

test('udalosti sa spracujú v poradí (at, seq) a môžu plánovať ďalšie', () => {
  const w = world(), log = [];
  const h = {
    a(w, d) { log.push('a' + d); if (d === 1) E.scheduleIn(w, 2, 'a', 3); },
    b(w, d) { log.push('b' + d); }
  };
  E.schedule(w, 5, 'b', 1);
  E.schedule(w, 5, 'a', 2);
  E.schedule(w, 1, 'a', 1);
  E.schedule(w, 0, 'b', 0); // minulosť → najbližší krok
  for (let i = 0; i < 6; i++) E.step(w, h);
  assert.deepStrictEqual(log, ['a1', 'b0', 'a3', 'b1', 'a2']);
});

test('uloženie do JSON a pokračovanie dá rovnaký výsledok ako nepretržitý beh', () => {
  const mk = () => world({ rng: 777 });
  const handlers = {
    roll(w) { w.sum = (w.sum || 0) + E.randInt(w, 1000); E.scheduleIn(w, 1 + E.randInt(w, 50), 'roll'); }
  };
  const a = mk(); E.schedule(a, 1, 'roll');
  E.advance(a, 10 * TPD * E.tickMs(a), handlers);
  const b = mk(); E.schedule(b, 1, 'roll');
  E.advance(b, 4 * TPD * E.tickMs(b) + 123, handlers);
  const restored = JSON.parse(JSON.stringify(b)); // ako uloženie na disk a načítanie
  E.advance(restored, 10 * TPD * E.tickMs(restored), handlers);
  assert.strictEqual(restored.tick, a.tick);
  assert.strictEqual(restored.sum, a.sum);
  assert.strictEqual(restored.rng, a.rng);
  assert.deepStrictEqual(restored.events, a.events);
});

test('nextDailyTick nájde najbližšiu dennú hodinu', () => {
  assert.strictEqual(E.nextDailyTick(0, 72), 72);
  assert.strictEqual(E.nextDailyTick(72, 72), 72);
  assert.strictEqual(E.nextDailyTick(73, 72), TPD + 72);
});
