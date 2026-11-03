const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const W = require('../shared/world3d.js');

const tiles = D.buildMap().map(g => ({ g }));

test('svet z kociek je deterministický a má správne výšky', () => {
  const a = W.buildGrid(tiles, 1), b = W.buildGrid(tiles, 1);
  assert.deepStrictEqual(a.m, b.m);
  const water = tiles.findIndex(t => t.g === 'water'), rock = tiles.findIndex(t => t.g === 'rock'), grass = tiles.findIndex(t => t.g === 'grass');
  assert.strictEqual(W.surfaceY(a, water % D.W, Math.floor(water / D.W)), 0.5);
  assert.strictEqual(W.surfaceY(a, rock % D.W, Math.floor(rock / D.W)), 1.5);
  assert.strictEqual(W.surfaceY(a, grass % D.W, Math.floor(grass / D.W)), 1);
  // chalupa babky má steny aj strechu nad zemou
  assert.strictEqual(W.get(a, 30, 3, 5), W.M.PLANK);
  assert.ok([...Array(W.NY).keys()].some(y => W.get(a, 30, y, 5) === W.M.THATCH));
});

test('slnko vychádza na východe, na poludnie je na juhu a v zime nižšie', () => {
  assert.strictEqual(W.sunDir(200, 1), null);
  const morning = W.sunDir(7 * 60, 1), noon = W.sunDir(13 * 60, 1);
  assert.ok(morning.x > 0.5 && morning.y > 0);
  assert.ok(Math.abs(noon.x) < 0.05 && noon.z > 0);
  assert.ok(W.sunDir(13 * 60, 3).y < noon.y * 0.6);
});

test('tiene: políčko severne od stromu má menej slnka než otvorené pole', () => {
  const g = W.buildGrid(tiles, 1);
  // osamelý strom pri babkinej chalúpke (18,2) – políčko na sever je v tieni pri poludní
  const field = W.sunHours(g, 12, 15, 1);
  assert.ok(field > 14, 'otvorené pole má skoro celý deň slnko: ' + field.toFixed(1));
  // políčka, ktoré majú strom hneď na juhu (slnko je cez deň na juhu)
  const north = [];
  for (let ty = 0; ty < D.H - 1; ty++) for (let tx = 0; tx < D.W; tx++)
    if (tiles[ty * D.W + tx].g === 'forest' && tiles[(ty + 1) * D.W + tx].g === 'tree') north.push(W.sunHours(g, tx, ty, 1));
  const avg = north.reduce((a, b) => a + b, 0) / north.length;
  assert.ok(north.length >= 1 && avg < field - 3, `severne od stromov ${avg.toFixed(1)} h (${north.length} políčok) vs pole ${field.toFixed(1)} h`);
  const behindHut = W.sunHours(g, 15, 1, 1);
  assert.ok(behindHut < field - 3, `za chalupou ${behindHut.toFixed(1)} h`);
});

test('v zime majú listnaté stromy holé konáre – pod nimi je viac slnka (relatívne k poľu)', () => {
  const sum = W.buildGrid(tiles, 1), win = W.buildGrid(tiles, 3);
  let cnt = 0, leafS = 0, leafW = 0;
  for (let ty = 2; ty < 8; ty++) for (let tx = 0; tx < 20; tx++) {
    if (tiles[ty * 20 + tx].g !== 'forest') continue;
    leafS += W.sunHours(sum, tx, ty, 1) / W.sunHours(sum, 12, 15, 1);
    leafW += W.sunHours(win, tx, ty, 3) / W.sunHours(win, 12, 15, 3);
    cnt++;
  }
  assert.ok(cnt > 5 && leafW / cnt > leafS / cnt, `podiel slnka v lese leto ${(leafS / cnt).toFixed(2)} vs zima ${(leafW / cnt).toFixed(2)}`);
});
