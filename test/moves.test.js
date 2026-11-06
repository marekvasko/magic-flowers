const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const E = require('../engine.js');
const Moves = require('../moves.js');

// Malý svet v záhrade s dvoma hráčmi; hooks zapisujú, čo sa kedy stalo
function setup() {
  const log = [];
  const room = { tick: 1000, daySeconds: D.BASE_DAY_SECONDS, rng: 1, seq: 0, events: [], players: new Map(), tiles: D.buildMap().map(g => ({ g, s: null })) };
  const pl = (id, x, y) => { const p = { id, key: 'h' + id, area: 'garden', areaSeq: 0, x, y }; room.players.set(id, p); return p; };
  const a = pl(1, 10.5, 20.5), b = pl(2, 12.5, 20.5);
  Moves.setHooks({
    forward(p) { log.push(['forward', p.id, room.tick, p.x, p.y]); },
    evaluate(r, p, from) { log.push(['evaluate', p.id, r.tick, from.x, from.y, p.x, p.y]); },
    send() {}
  });
  const spec = { handlers: Moves.HANDLERS, onError(err) { throw err; } };
  return { room, a, b, log, step: n => E.advanceTo(room, room.tick + (n || 1), spec) };
}
const moveEvents = (room, p) => room.events.filter(e => e.key === 'move:' + p.key);

test('pohyb: poloha ide ostatným hneď, plánovač ju vyhodnotí až v najbližšom kroku', () => {
  const { room, a, log, step } = setup();
  Moves.arrive(room, a, 11, 20.5, 0);
  assert.deepStrictEqual(log, [['forward', 1, 1000, 11, 20.5]], 'prepošle sa hneď, ešte bez vyhodnotenia');
  assert.deepStrictEqual([a.x, a.y], [11, 20.5], 'poloha platí hneď (bez overenia vopred)');
  const ev = moveEvents(room, a);
  assert.deepStrictEqual(ev.map(e => [e.type, e.at]), [['arrivedFrom', 1001]], 'udalosť s aktuálnym krokom servera');
  step();
  assert.deepStrictEqual(log[1], ['evaluate', 1, 1001, 10.5, 20.5, 11, 20.5], 'vyhodnotí sa až potom: odkiaľ → kam');
  assert.strictEqual(moveEvents(room, a).length, 0);
});

test('pohyb: hráč má najviac jednu udalosť pohybu – novšia nahradí staršiu, cesta od posledného vyhodnotenia ostane', () => {
  const { room, a, b, log, step } = setup();
  Moves.arrive(room, a, 11, 20.5, 0);
  Moves.arrive(room, a, 11.5, 20.5, 60);
  Moves.arrive(room, b, 12.5, 21, 60);
  assert.strictEqual(moveEvents(room, a).length, 1, 'jedna udalosť hráča A');
  assert.strictEqual(moveEvents(room, b).length, 1, 'iný hráč má svoju');
  assert.deepStrictEqual([moveEvents(room, a)[0].data.fx, moveEvents(room, a)[0].data.x], [10.5, 11.5], 'odkiaľ zo staršej, kam z novšej');
  // goTo zdieľa ten istý kľúč: nahradí nevyhodnotený pohyb…
  Moves.goTo(room, a, 3.5, 20.5);
  assert.deepStrictEqual(moveEvents(room, a).map(e => e.type), ['goTo']);
  // …a nový pohyb od klienta nahradí vedenie
  Moves.arrive(room, a, 11.6, 20.5, 120);
  assert.deepStrictEqual(moveEvents(room, a).map(e => e.type), ['arrivedFrom']);
  step();
  assert.deepStrictEqual(log.filter(l => l[0] === 'evaluate').map(l => l[1]).sort(), [1, 2], 'každý hráč sa vyhodnotí raz');
});

test('pohyb: rýchlosť z posledného pohybu (políčka za krok) pre predpoveď polohy; po prestávke hráč stojí', () => {
  const { room, a, step } = setup();
  const ms = E.tickMs(room);
  Moves.arrive(room, a, 10.5, 20.5, 0);
  Moves.arrive(room, a, 10.5 + 0.475, 20.5, ms); // 3,8 políčka/s × 0,125 s
  step();
  assert.ok(Math.abs(a.mv.vx - 0.475) < 1e-9 && a.mv.vy === 0 && a.mv.t === room.tick);
  Moves.arrive(room, a, 11.5, 20.5, ms + 2000);
  step();
  assert.deepStrictEqual([a.mv.vx, a.mv.vy], [0, 0], 'po 2 s bez pohybu sa rýchlosť nepočíta');
});

test('pohyb: goTo vedie hráča po ceste krok za krokom rýchlosťou chôdze a každý krok vyhodnotí', () => {
  const { room, a, log, step } = setup();
  Moves.goTo(room, a, 13.5, 20.5);
  let n = 0;
  while (moveEvents(room, a).length && n < 100) { step(); n++; }
  assert.deepStrictEqual([a.x, a.y], [13.5, 20.5], 'došiel do cieľa');
  assert.strictEqual(n, Math.ceil(3 / (Moves.WALK * E.tickMs(room) / 1000)), '3 políčka po 0,475');
  assert.strictEqual(log.filter(l => l[0] === 'evaluate').length, n);
  assert.strictEqual(log.filter(l => l[0] === 'forward').length, n);
});

test('pohyb: udalosť hráča, ktorý medzitým odišiel alebo prešiel na inú plochu, sa zahodí', () => {
  const { room, a, log, step } = setup();
  Moves.arrive(room, a, 11, 20.5, 0);
  a.areaSeq++; // prešiel na inú plochu
  step();
  assert.ok(!log.some(l => l[0] === 'evaluate'));
  assert.ok(Moves.isRuntime({ type: 'arrivedFrom', data: {} }) && Moves.isRuntime({ type: 'goTo', data: { pk: 'x' } }) && !Moves.isRuntime({ type: 'goTo', data: { sp: 's0' } }));
});
