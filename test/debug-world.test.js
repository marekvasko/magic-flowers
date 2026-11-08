// Ladiaca stránka, záložka World (#78): políčka plochy z kópie sveta rovnako ako v hre, hráči na ploche
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/shared/data.ts');
const Ice = require('../src/server/ice.ts');
const { keyId } = require('../src/server/debug.ts');
const world = require('../debug/api/world.js');

const q = o => new URLSearchParams(o);
const KEY = 'tajny-kluc-hraca';

function tools(state, online) {
  return { load: id => id === 'svet' ? { id, source: 'file', online: online || [], state: JSON.parse(JSON.stringify(state)) } : null };
}

test('world: svet zo semienka bez uloženia – každá plocha má svoje políčka', () => {
  for (const area of D.AREAS) {
    const r = world(q({ seed: '42', area }), tools({}));
    const { w, h } = D.areaSize(area);
    assert.strictEqual(r.room, null);
    assert.strictEqual(r.area, area);
    assert.strictEqual(r.tiles.length, w * h);
    assert.deepStrictEqual(r.players, []);
  }
  const a = world(q({ seed: '42', area: 'pomedzie' }), tools({})), b = world(q({ seed: '43', area: 'pomedzie' }), tools({}));
  assert.deepStrictEqual(a.tiles.map(t => t.g), D.buildPomedzie(42));
  assert.notDeepStrictEqual(a.tiles.map(t => t.g), b.tiles.map(t => t.g));
  // neznáma plocha = záhrada
  assert.strictEqual(world(q({ seed: '1', area: 'nic' }), tools({})).area, 'garden');
});

test('world: záhrada = generátor + uložená pôda, otvor v ľade, ľadovňa a skrytá divá rastlina', () => {
  const base = D.buildMap(), tiles = base.map(() => ({ s: null }));
  const soil = base.indexOf('grass'), wild = base.lastIndexOf('grass'), water = base.indexOf('water');
  tiles[soil] = { s: { k: 'tilled', w: 1, p: { sp: 'ruza', pt: 0 } } };
  tiles[wild] = { s: { k: 'tilled', w: 0, p: { sp: 'wild_1', wild: 1, pt: 0 } } };
  tiles[water] = { s: null, cut: 1 };
  const state = { tick: 500, weather: 'rain', tiles, icehouse: { built: true, ice: 3 }, pomedzieSeed: 7, saves: {} };
  const r = world(q({ room: 'svet', area: 'garden' }), tools(state));
  assert.strictEqual(r.tick, 500);
  assert.strictEqual(r.weather, 'rain');
  assert.deepStrictEqual(r.tiles[soil].s, tiles[soil].s);
  assert.strictEqual(r.tiles[wild].s.p.sp, 'wild'); // druh divej rastliny ostane skrytý ako v hre
  assert.strictEqual(r.tiles[water].cut, 1);
  const L = D.ICEHOUSE.lot;
  assert.strictEqual(r.tiles[L.y0 * D.W + L.x0].g, 'icehouse');
  assert.strictEqual(world(q({ room: 'nie', area: 'garden' }), tools(state)), null);
});

test('world: hory s vysekaným ľadom a Les na pomedzí zo semienka sveta', () => {
  const hory = Ice.loadHory(null);
  const gi = hory.findIndex(t => t.g === 'glacier');
  hory[gi].ice = 0;
  const state = { tick: 0, hory: Ice.saveHory(hory), pomedzieSeed: 99, saves: {} };
  assert.strictEqual(world(q({ room: 'svet', area: 'hory' }), tools(state)).tiles[gi].ice, 0);
  assert.deepStrictEqual(world(q({ room: 'svet', area: 'pomedzie' }), tools(state)).tiles.map(t => t.g), D.buildPomedzie(99));
});

test('world: hráči na ploche – online s menom, ostatní na poslednom mieste', () => {
  const state = { tick: 0, saves: { [KEY]: { x: 3.5, y: 4.5, area: 'garden', look: { shirt: '#fff' } }, iny: { x: 1, y: 1, area: 'hory' }, bezPolohy: {} } };
  const online = [{ name: 'Anka', area: 'garden', player: keyId(KEY) }];
  const g = world(q({ room: 'svet', area: 'garden' }), tools(state, online));
  assert.deepStrictEqual(g.players, [{ id: KEY, name: 'Anka', online: true, x: 3.5, y: 4.5, look: { shirt: '#fff' } }]);
  const h = world(q({ room: 'svet', area: 'hory' }), tools(state, online));
  assert.deepStrictEqual(h.players.map(p => [p.id, p.online]), [['iny', false]]);
});
