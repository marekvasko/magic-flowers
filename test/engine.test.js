const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/server/engine.js');
const D = require('../src/shared/data.js');
const TPD = E.TICKS_PER_DAY;

function world(extra) { return Object.assign({ tick: 0, wall: 0, daySeconds: 300, seed: "test-12345", step: 0, seq: 0, events: [] }, extra); }
// V testoch chyba v návrhu nesmie prejsť potichu, ak ju test nečaká.
const rethrow = err => { throw err; };
// Návrh bez deklarovaných kľúčov (nič zo sveta nečíta), len s vedľajším účinkom do testu – stačí mu ctx
const fx = run => ({ keys: () => ({}), run: (s, d, ctx) => run(ctx, d) });
// Návrh nad jednou vlastnosťou sveta
const on = (key, run) => ({ keys: () => ({ writes: [key] }), run: (s, d, ctx) => run(s, d, ctx) });

test('každý deň má presne TICKS_PER_DAY krokov, aj pri nepravidelnom časovači', () => {
  const w = world();
  const dayTicks = [];
  let last = 0;
  const spec = {
    proposers: { dawn: fx(ctx => { dayTicks.push(ctx.tick - last); last = ctx.tick; }) },
    periodic: [{ key: 'dawn', type: 'dawn', next: E.daily(0) }], onError: rethrow
  };
  let now = 0;
  // časovač s rozptylom 0–2500 ms a občasnými veľkými výpadkami
  while (dayTicks.length < 100) {
    now += Math.floor(Math.random() * 2500) + (Math.random() < 0.01 ? 60000 : 0);
    E.advance(w, now, spec);
  }
  assert.ok(dayTicks.every(n => n === TPD), 'počty krokov: ' + [...new Set(dayTicks)].join(','));
  // reálny čas a herný čas sa nerozchádzajú o viac než jeden krok
  assert.ok(now - w.wall < E.tickMs(w) && now - w.wall >= 0);
  assert.strictEqual(w.tick, Math.floor(now / E.tickMs(w)));
});

test('udalosti sa spracujú v poradí (at, seq) a môžu plánovať ďalšie', () => {
  const w = world(), log = [];
  const spec = {
    proposers: {
      a: fx((ctx, d) => { log.push('a' + d); if (d === 1) ctx.scheduleIn(2, 'a', 3); }),
      b: fx((ctx, d) => { log.push('b' + d); })
    }, onError: rethrow
  };
  E.schedule(w, 5, 'b', 1);
  E.schedule(w, 5, 'a', 2);
  E.schedule(w, 1, 'a', 1);
  E.schedule(w, 0, 'b', 0); // minulosť → najbližší krok
  E.advanceTo(w, 6, spec);
  assert.deepStrictEqual(log, ['a1', 'b0', 'a3', 'b1', 'a2']);
  assert.strictEqual(w.tick, 6);
});

test('dávka v jednom kroku je uzavretá: čo naplánuje „teraz“, príde až v ďalšom kroku', () => {
  const w = world(), log = [];
  const spec = {
    proposers: { a: fx(ctx => { log.push('a@' + ctx.tick); ctx.schedule(ctx.tick, 'b'); }), b: fx(ctx => { log.push('b@' + ctx.tick); }) },
    onError: rethrow
  };
  E.schedule(w, 3, 'a');
  E.advanceTo(w, 10, spec);
  assert.deepStrictEqual(log, ['a@3', 'b@4']);
});

test('skok na ďalšiu udalosť dá ten istý svet ako posun po jednom kroku', () => {
  const mk = () => world({ seed: "skok-99" });
  const spec = {
    proposers: {
      roll: on('sum', (s, d, ctx) => { s.sum = (s.sum || 0) + ctx.rng.int(1000); if (ctx.rng.rand() < 0.5) ctx.scheduleIn(1 + ctx.rng.int(40), 'one'); }),
      one: on('ones', s => { s.ones = (s.ones || 0) + 1; })
    },
    periodic: [{ key: 'roll', type: 'roll', next: (from, g) => from + g.int(30) }], onError: rethrow
  };
  const a = mk(); E.advanceTo(a, 20 * TPD, spec);
  const b = mk(); while (b.tick < 20 * TPD) E.advanceTo(b, b.tick + 1, spec);
  assert.deepStrictEqual(b, a);
  assert.ok(a.ones > 0);
});

test('uloženie do JSON a pokračovanie dá rovnaký výsledok ako nepretržitý beh', () => {
  const mk = () => world({ seed: "ulozenie-777" });
  const spec = {
    proposers: { roll: on('sum', (s, d, ctx) => { s.sum = (s.sum || 0) + ctx.rng.int(1000); }) },
    periodic: [{ key: 'roll', type: 'roll', next: (from, g) => from + g.int(50) }], onError: rethrow
  };
  const a = mk();
  E.advance(a, 10 * TPD * E.tickMs(a), spec);
  const b = mk();
  E.advance(b, 4 * TPD * E.tickMs(b) + 123, spec);
  const restored = JSON.parse(JSON.stringify(b)); // ako uloženie na disk a načítanie
  E.advance(restored, 10 * TPD * E.tickMs(restored), spec);
  assert.strictEqual(restored.tick, a.tick);
  assert.strictEqual(restored.sum, a.sum);
  assert.strictEqual(restored.step, a.step);
  assert.deepStrictEqual(restored.events, a.events);
});

test('periodická udalosť: návrh sa neplánuje sám, engine ju naplánuje znova po každom vykonaní', () => {
  const w = world(), at = [];
  const spec = { proposers: { hour: fx(ctx => { at.push(ctx.tick); }) }, periodic: [{ key: 'hour', type: 'hour', next: E.every(12, 5) }], onError: rethrow };
  E.advanceTo(w, 60, spec);
  assert.deepStrictEqual(at, [5, 17, 29, 41, 53]);
  assert.strictEqual(w.events.length, 1);
  assert.strictEqual(E.pending(w, 'hour').at, 65);
});

test('chyba v návrhu nezastaví periodickú udalosť ani simuláciu', () => {
  const w = world(), errors = [];
  let ok = 0;
  const spec = {
    proposers: { boom: fx(() => { throw new Error('bum'); }), fine: fx(() => { ok++; }) },
    periodic: [{ key: 'boom', type: 'boom', next: E.every(10) }, { key: 'fine', type: 'fine', next: E.every(10) }],
    onError(err, ev) { errors.push(ev.key + ':' + err.message); }
  };
  E.advanceTo(w, 35, spec);
  assert.deepStrictEqual(errors, ['boom:bum', 'boom:bum', 'boom:bum']);
  assert.strictEqual(ok, 3);
  assert.ok(E.pending(w, 'boom'), 'periodická udalosť je stále naplánovaná');
});

test('reconcile: doplní chýbajúce, zahodí duplicity, nedeklarované a neznáme udalosti', () => {
  const w = world({ tick: 100 });
  w.events = [ // ako staré uloženie
    { at: 110, seq: 1, type: 'dawn', data: null, key: 'dawn', periodic: true },
    { at: 120, seq: 2, type: 'dawn', data: null, key: 'dawn', periodic: true },
    { at: 130, seq: 3, type: 'fest', data: { id: 'zruseny' }, key: 'fest:zruseny', periodic: true },
    { at: 140, seq: 4, type: 'odstraneny', data: null },
    { at: 150, seq: 5, type: 'fest', data: { id: 'x' }, key: 'cExpire:7' } // unikátna, nie periodická – ostane
  ];
  w.seq = 5;
  const spec = {
    proposers: { dawn: fx(() => {}), fest: fx(() => {}), novy: fx(() => {}) },
    periodic: [
      { key: 'dawn', type: 'dawn', next: E.daily(D.DAWN_TICK) },
      { key: 'novy', type: 'novy', data: { a: 1 }, next: E.daily(84) }
    ]
  };
  // plán ukáže presne to, čo reconcile urobí, a svet nezmení
  const before = JSON.stringify(w), plan = E.reconcilePlan(w, spec);
  assert.strictEqual(JSON.stringify(w), before);
  assert.deepStrictEqual(plan.drop.map(d => [d.ev.key || d.ev.type, d.ev.at, d.why]), [['dawn', 120, 'duplicita'], ['fest:zruseny', 130, 'nedeklarovaná periodická'], ['odstraneny', 140, 'neznámy typ']]);
  assert.deepStrictEqual(plan.missing.map(d => d.key), ['novy']);
  assert.deepStrictEqual(plan.ok.map(o => [o.def.key, o.ev.at]), [['dawn', 110]]);
  const warn = console.warn; console.warn = () => {};
  try { E.reconcile(w, spec); } finally { console.warn = warn; }
  assert.deepStrictEqual(w.events.map(e => [e.key || e.type, e.at]), [['dawn', 110], ['cExpire:7', 150], ['novy', 84 + TPD]]);
  assert.deepStrictEqual(E.pending(w, 'novy').data, { a: 1 });
  E.reconcile(w, spec); // druhý reconcile už nič nemení
  assert.strictEqual(w.events.length, 3);
  const after = E.reconcilePlan(w, spec);
  assert.deepStrictEqual([after.drop.length, after.missing.length, after.ok.length], [0, 0, 2]);
});

test('unikátna udalosť: nová nahradí čakajúcu s rovnakým kľúčom, cancel ruší podľa kľúča', () => {
  const w = world(), log = [];
  const spec = { proposers: { end: fx((ctx, d) => { log.push(d.who + '@' + ctx.tick); }) }, onError: rethrow };
  E.scheduleUnique(w, 'end:ana', 10, 'end', { who: 'ana' });
  E.scheduleUnique(w, 'end:ana', 20, 'end', { who: 'ana' });
  E.scheduleUnique(w, 'end:bob', 15, 'end', { who: 'bob' });
  E.scheduleUnique(w, 'end:cyril', 12, 'end', { who: 'cyril' });
  assert.strictEqual(E.cancel(w, 'end:cyril'), 1);
  assert.strictEqual(E.cancel(w, 'end:nikto'), 0);
  E.advanceTo(w, 30, spec);
  assert.deepStrictEqual(log, ['bob@15', 'ana@20']);
});

test('nextEvery a nextDailyTick nájdu najbližší vhodný krok', () => {
  assert.strictEqual(E.nextDailyTick(0, 72), 72);
  assert.strictEqual(E.nextDailyTick(72, 72), 72);
  assert.strictEqual(E.nextDailyTick(73, 72), TPD + 72); // ľubovoľný krok dňa
  assert.strictEqual(E.nextEvery(0, 12), 0);
  assert.strictEqual(E.nextEvery(1, 12), 12);
  assert.strictEqual(E.nextEvery(100, 1000, -2), 998); // záporný posun (napr. ohlásenie 2 dni pred začiatkom roka)
});
