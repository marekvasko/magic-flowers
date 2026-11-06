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
    send(p, msg) { log.push(['send', p.id, room.tick, msg]); }
  });
  const spec = { handlers: Moves.HANDLERS, onError(err) { throw err; } };
  return { room, a, b, log, step: n => E.advanceTo(room, room.tick + (n || 1), spec) };
}
const WALK_TICK = room => Moves.WALK * E.tickMs(room) / 1000;
const moveEvents = (room, p) => room.events.filter(e => e.key === 'move:' + p.key);

test('pohyb: poloha ide ostatným hneď, plánovač ju vyhodnotí až v najbližšom kroku', () => {
  const { room, a, log, step } = setup();
  Moves.arrive(room, a, 11, 20.5, 0);
  assert.deepStrictEqual(log, [['forward', 1, 1000, 11, 20.5]], 'prepošle sa hneď, ešte bez vyhodnotenia');
  assert.deepStrictEqual([a.x, a.y], [11, 20.5], 'poloha platí hneď (bez overenia vopred)');
  const ev = moveEvents(room, a);
  assert.deepStrictEqual(ev.map(e => [e.type, e.data.t, e.at]), [['arrivedFrom', 1000, 1001]], 'udalosť s aktuálnym krokom servera, vyhodnotí sa v najbližšom');
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
  Moves.goTo(room, a, 3, 20, 1);
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
  assert.strictEqual(Moves.goTo(room, a, 13, 20, 7), true);
  assert.deepStrictEqual([a.x, a.y], [10.5, 20.5], 'hráč sa pohne až v najbližšom kroku');
  let n = 0;
  while (moveEvents(room, a).length && n < 100) { step(); n++; }
  assert.deepStrictEqual([a.x, a.y], [13.5, 20.5], 'došiel do stredu cieľového políčka');
  assert.strictEqual(n, Math.ceil(3 / (Moves.WALK * E.tickMs(room) / 1000)), '3 políčka po 0,475');
  assert.strictEqual(log.filter(l => l[0] === 'evaluate').length, n);
  assert.strictEqual(log.filter(l => l[0] === 'forward').length, n);
  const sent = log.filter(l => l[0] === 'send').map(l => l[3]);
  assert.strictEqual(sent.filter(m => m.t === 'goStep').length, n, 'hráč dostane každý krok');
  assert.deepStrictEqual(sent[sent.length - 1], { t: 'goToEnd', n: 7, x: 13.5, y: 20.5 });
});

test('pohyb: goTo má údaje ako arrivedFrom (odkiaľ → kam v najbližšom kroku) plus cieľ a na konci sa naplánuje znova', () => {
  const { room, a, log, step } = setup();
  Moves.goTo(room, a, 13, 20, 1);
  const s = WALK_TICK(room);
  let [e] = moveEvents(room, a);
  assert.strictEqual(e.at, 1001);
  assert.deepStrictEqual([e.data.t, e.data.fx, e.data.fy, e.data.x, e.data.y, e.data.vx, e.data.vy, e.data.gx, e.data.gy],
    [1000, 10.5, 20.5, +(10.5 + s).toFixed(4), 20.5, +s.toFixed(4), 0, 13, 20]);
  step();
  assert.deepStrictEqual(log.find(l => l[0] === 'evaluate'), ['evaluate', 1, 1001, 10.5, 20.5, e.data.x, 20.5], 'vyhodnotí sa úsek odkiaľ → kam');
  [e] = moveEvents(room, a);
  assert.strictEqual(e.at, 1002, 'ďalší krok je naplánovaný na najbližší krok');
  assert.deepStrictEqual([e.data.fx, e.data.x], [a.x, +(a.x + s).toFixed(4)], 'ďalší úsek začína tam, kde hráč je');
  assert.deepStrictEqual([a.mv.vx, a.mv.vy], [+s.toFixed(4), 0], 'rýchlosť pre predpoveď pavúkov je presná');
});

test('pohyb: goTo, kam sa nedá dôjsť, sa odmietne a hráč sa to dozvie (goToNo)', () => {
  const { room, a, log } = setup();
  const sent = () => log.filter(l => l[0] === 'send').map(l => l[3]);
  const { w, h } = D.areaSize('garden');
  assert.strictEqual(Moves.goTo(room, a, w + 3, 2, 4), false, 'mimo plochy');
  assert.strictEqual(Moves.goTo(room, a, 1.5, 2, 5), false, 'nie je to políčko');
  const block = room.tiles.findIndex(t => !D.passable(t));
  assert.ok(block >= 0);
  assert.strictEqual(Moves.goTo(room, a, block % w, (block / w) | 0, 6), false, 'neprechodné políčko');
  assert.deepStrictEqual(sent(), [{ t: 'goToNo', n: 4, why: 'far' }, { t: 'goToNo', n: 5, why: 'far' }, { t: 'goToNo', n: 6, why: 'far' }]);
  assert.strictEqual(moveEvents(room, a).length, 0, 'nič sa nenaplánovalo');
});

test('pohyb: zatarasená cesta sa obíde; keď sa obísť nedá, vedenie sa zastaví s goToNo', () => {
  const { room, a, log, step } = setup();
  const { w } = D.areaSize('garden');
  Moves.goTo(room, a, 14, 20, 2);
  step();
  const wall = Object.keys(D.BLOCK).find(g => g !== 'glacier');
  room.tiles[20 * w + 12] = { g: wall };
  let n = 0;
  while (moveEvents(room, a).length && n < 200) { step(); n++; }
  assert.deepStrictEqual([a.x, a.y], [14.5, 20.5], 'obišiel prekážku a došiel');
  assert.ok(!log.some(l => l[0] === 'evaluate' && Math.floor(l[5]) === 12 && Math.floor(l[6]) === 20), 'cez prekážku nešiel');
  // teraz ho zamurujeme úplne
  Moves.goTo(room, a, 10, 20, 3);
  step();
  const px = Math.floor(a.x), py = Math.floor(a.y);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) room.tiles[(py + dy) * w + px + dx] = { g: wall };
  for (let k = 0; k < 20 && moveEvents(room, a).length; k++) step();
  assert.deepStrictEqual(log.filter(l => l[0] === 'send').map(l => l[3]).pop(), { t: 'goToNo', n: 3, why: 'blocked' });
});

test('pohyb: najkratšia cesta sa pamätá a zmena sveta ju zneplatní', () => {
  const { room } = setup();
  const { w } = D.areaSize('garden');
  const p1 = Moves.route(room, 'garden', { x: 10.5, y: 20.5 }, { x: 14.5, y: 20.5 });
  const p2 = Moves.route(room, 'garden', { x: 10.2, y: 20.9 }, { x: 14.5, y: 20.5 });
  assert.deepStrictEqual(p1, p2);
  p2.push(999); // vrátená cesta je kópia – zapamätaná ostane celá
  assert.deepStrictEqual(Moves.route(room, 'garden', { x: 10.5, y: 20.5 }, { x: 14.5, y: 20.5 }), p1);
  room.tiles[20 * w + 12] = { g: Object.keys(D.BLOCK).find(g => g !== 'glacier') };
  const p3 = Moves.route(room, 'garden', { x: 10.5, y: 20.5 }, { x: 14.5, y: 20.5 });
  assert.ok(!p3.includes(20 * w + 12) && p3.length > p1.length, 'nová cesta obchádza prekážku');
});

test('pohyb: pohyb od klienta (joystick) zruší vedenie; stop() zruší len vedenie', () => {
  const { room, a, step } = setup();
  Moves.goTo(room, a, 14, 20, 1);
  step();
  Moves.arrive(room, a, a.x, 21.2, 100);
  assert.deepStrictEqual(moveEvents(room, a).map(e => e.type), ['arrivedFrom']);
  Moves.stop(room, a);
  assert.deepStrictEqual(moveEvents(room, a).map(e => e.type), ['arrivedFrom'], 'nevyhodnotený pohyb od klienta ostane');
  Moves.goTo(room, a, 14, 20, 2);
  Moves.stop(room, a);
  assert.strictEqual(moveEvents(room, a).length, 0);
});

test('pohyb: udalosť hráča, ktorý medzitým odišiel alebo prešiel na inú plochu, sa zahodí', () => {
  const { room, a, log, step } = setup();
  Moves.arrive(room, a, 11, 20.5, 0);
  a.areaSeq++; // prešiel na inú plochu
  step();
  assert.ok(!log.some(l => l[0] === 'evaluate'));
  assert.ok(Moves.isRuntime({ type: 'arrivedFrom', data: {} }) && Moves.isRuntime({ type: 'goTo', data: { pk: 'x' } }) && !Moves.isRuntime({ type: 'goTo', data: { sp: 's0' } }));
});
