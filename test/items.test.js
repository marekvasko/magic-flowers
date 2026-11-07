const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const I = require('../items.js');
const TPD = D.TICKS_PER_DAY;

const sum = c => id => (c.fb[id] || []).reduce((s, b) => s + b.n, 0);

test('kvety sa odoberajú od najstarších a inv vždy sedí so súčtom várok', () => {
  const sv = { inv: {}, seen: [] }, c = I.playerC(sv);
  I.addItems(c, 'fl_tulipan', 3, 0);
  I.addItems(c, 'fl_tulipan', 2, TPD);          // o deň neskôr
  const out = I.removeItems(c, 'fl_tulipan', 4, 2 * TPD);
  assert.deepStrictEqual(out, [{ n: 3, age: 2 * TPD }, { n: 1, age: TPD }]);
  assert.strictEqual(sv.inv.fl_tulipan, 1);
  assert.strictEqual(sum(c)('fl_tulipan'), 1);
  assert.ok(sv.seen.includes('tulipan'));
  assert.strictEqual(I.removeItems(c, 'fl_tulipan', 2, 2 * TPD), null, 'viac než mám sa odobrať nedá');
});

test('kvety vädnú podľa životnosti druhu; v sklade 2× pomalšie', () => {
  const sv = { inv: {} }, c = I.playerC(sv);
  const st = I.storageC({ inv: {}, fb: {} });
  I.addItems(c, 'fl_mak', 5, 0);         // mak vydrží 2 dni
  I.addItems(st, 'fl_mak', 5, 0);
  assert.deepStrictEqual(I.wiltSweep(c, 2 * TPD - 1), {});
  assert.deepStrictEqual(I.wiltSweep(c, 2 * TPD), { 'Mak vlčí': 5 });
  assert.strictEqual(sv.inv.wilted, 5);
  assert.ok(!sv.inv.fl_mak && !sv.fb.fl_mak);
  assert.deepStrictEqual(I.wiltSweep(st, 2 * TPD), {}, 'v sklade ešte nie');
  assert.deepStrictEqual(I.wiltSweep(st, 4 * TPD), { 'Mak vlčí': 5 });
});

test('presun do skladu a späť zachová vek kvetov', () => {
  const sv = { inv: {} }, c = I.playerC(sv), st = I.storageC({ inv: {}, fb: {} });
  I.addItems(c, 'fl_ruza', 2, 0);
  const b = I.removeItems(c, 'fl_ruza', 2, TPD);       // vek 1 deň
  I.addItems(st, 'fl_ruza', 2, TPD, b);
  const back = I.removeItems(st, 'fl_ruza', 2, 3 * TPD); // +2 dni v sklade = +1 deň veku
  assert.deepStrictEqual(back, [{ n: 2, age: 2 * TPD }]);
});

test('čerstvosť: plná na začiatku, polovica na konci životnosti', () => {
  assert.strictEqual(D.freshness('tulipan', 0), 1);
  assert.strictEqual(D.freshness('tulipan', 0.4 * 4 * TPD), 1);
  assert.ok(Math.abs(D.freshness('tulipan', 0.7 * 4 * TPD) - 0.75) < 1e-9);
  assert.strictEqual(D.freshness('tulipan', 4 * TPD), 0.5);
});
