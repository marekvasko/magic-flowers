const test = require('node:test');
const assert = require('node:assert');
const P = require('../presence.js');

test('awayDays: celé dni od odchodu, bez záznamu 0', () => {
  assert.strictEqual(P.awayDays(null, 1000, 100), 0);
  assert.strictEqual(P.awayDays(undefined, 1000, 100), 0);
  assert.strictEqual(P.awayDays(950, 1000, 100), 0);
  assert.strictEqual(P.awayDays(900, 1000, 100), 1);
  assert.strictEqual(P.awayDays(250, 1000, 100), 7);
  assert.strictEqual(P.awayDays(1200, 1000, 100), 0); // budúci záznam (napr. po obnove zálohy) nedá záporné dni
});

function fakeTimers() {
  let id = 0;
  const q = new Map();
  return {
    setTimeout(fn) { q.set(++id, fn); return id; },
    clearTimeout(h) { q.delete(h); },
    flush() { const fns = [...q.values()]; q.clear(); fns.forEach(f => f()); },
    get size() { return q.size; }
  };
}

test('createLeaving: odchod sa ohlási až po odklade', () => {
  const t = fakeTimers(), L = P.createLeaving(10000, t), said = [];
  L.leave('zahrada:eva', () => said.push('eva'));
  assert.deepStrictEqual(said, []);
  assert.ok(L.has('zahrada:eva'));
  t.flush();
  assert.deepStrictEqual(said, ['eva']);
  assert.strictEqual(L.back('zahrada:eva'), false); // po odklade už nejde o rýchly návrat
});

test('createLeaving: rýchly návrat zruší hlásenie o odchode', () => {
  const t = fakeTimers(), L = P.createLeaving(10000, t), said = [];
  L.leave('zahrada:eva', () => said.push('eva'));
  assert.strictEqual(L.back('zahrada:eva'), true);
  t.flush();
  assert.deepStrictEqual(said, []);
  assert.strictEqual(L.back('zahrada:eva'), false);
});

test('createLeaving: opakovaný odchod nechá len jedno hlásenie', () => {
  const t = fakeTimers(), L = P.createLeaving(10000, t), said = [];
  L.leave('zahrada:eva', () => said.push(1));
  L.leave('zahrada:eva', () => said.push(2));
  assert.strictEqual(t.size, 1);
  t.flush();
  assert.deepStrictEqual(said, [2]);
});

test('heartbeat: kto neodpovie na ping, je odpojený', () => {
  const mk = () => {
    const h = {};
    return { pings: 0, dead: false, on(ev, fn) { h[ev] = fn; }, ping() { this.pings++; }, terminate() { this.dead = true; }, pong() { h.pong(); } };
  };
  const a = mk(), b = mk();
  P.watch(a); P.watch(b);
  P.heartbeat([a, b]);
  assert.strictEqual(a.pings, 1); assert.strictEqual(b.pings, 1);
  a.pong(); // b mlčí – polootvorené spojenie
  P.heartbeat([a, b]);
  assert.strictEqual(a.dead, false);
  assert.strictEqual(b.dead, true);
  assert.strictEqual(a.pings, 2);
});
