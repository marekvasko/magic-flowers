const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const W = require('../shared/world3d.js');

const tiles = D.buildMap().map(g => ({ g }));

test('svet z kociek je deterministický a má správne výšky', () => {
  const a = W.buildGrid(tiles, 1), b = W.buildGrid(tiles, 1);
  assert.deepStrictEqual(a.m, b.m);
  const water = tiles.findIndex(t => t.g === 'water'), rock = tiles.findIndex(t => t.g === 'rock'), grass = tiles.findIndex(t => t.g === 'grass');
  assert.strictEqual(W.surfaceY(a, water % D.W, Math.floor(water / D.W)), 0.875);
  assert.strictEqual(W.surfaceY(a, rock % D.W, Math.floor(rock / D.W)), 1.5);
  assert.strictEqual(W.surfaceY(a, grass % D.W, Math.floor(grass / D.W)), 1);
  // budovy sú jemné modely; v hrubej mriežke majú neviditeľnú náhradu (chalupa babky stojí na (14,2))
  assert.deepStrictEqual(a.fine.filter(f => f.type !== 'tree' && f.type !== 'rock').map(f => f.type).sort(), ['cauldron', 'house', 'hut', 'stall', 'well']);
  assert.strictEqual(W.get(a, 30, 3, 5), W.M.INVIS);
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

test('domček z minikociek (1/8 bloku): detaily, neviditeľná náhrada a tieň', () => {
  const g = W.buildGrid(tiles, 1);
  const f = g.fine.find(m => m.type === 'house'), has = m => f.data.includes(m);
  assert.strictEqual(W.FINE, 8);
  for (const m of [W.M.LOG, W.M.ORN, W.M.WINDOW, W.M.SHUTTER, W.M.SHINGLE, W.M.HANDLE, W.M.LANTERN]) assert.ok(has(m), 'chýba materiál ' + m);
  assert.ok(g.m.includes(W.M.INVIS), 'neviditeľná náhrada v hrubej mriežke');
  assert.ok(!W.buildGrid(tiles, 1).m.includes(W.M.ROOF_RED), 'hrubý domček sa už nestavia');
  assert.ok(W.sunHours(g, 3, 26, 1) < W.sunHours(g, 12, 15, 1) - 5, 'domček vrhá tieň na sever');
  const winter = W.buildGrid(tiles, 3).fine.find(m => m.type === 'house');
  assert.ok(winter.data.includes(W.M.SNOW) && !f.data.includes(W.M.SNOW), 'v zime sneh na streche');
});

test('chalupa, kotlík, trh a studňa z minikociek majú svoje detaily', () => {
  const g = W.buildGrid(tiles, 1), by = t => g.fine.find(f => f.type === t), has = (t, m) => by(t).data.includes(m);
  for (const m of [W.M.PLASTER, W.M.BAND_BLUE, W.M.STRAW, W.M.LAVENDER, W.M.CLAY, W.M.WINDOW]) assert.ok(has('hut', m), 'chalupa: ' + m);
  for (const m of [W.M.POT, W.M.BREW, W.M.FIRE, W.M.LOG_DARK]) assert.ok(has('cauldron', m), 'kotlík: ' + m);
  for (const m of [W.M.AWN_RED, W.M.AWN_WHITE, W.M.SIGN, W.M.ORN, W.M.SACK, W.M.LANTERN]) assert.ok(has('stall', m), 'trh: ' + m);
  for (const m of [W.M.WATER_DEEP, W.M.ROPE, W.M.HANDLE, W.M.SHINGLE]) assert.ok(has('well', m), 'studňa: ' + m);
  // ťuknutie na model vyberie rovnaké políčko ako v 2D
  for (const f of g.fine) assert.strictEqual(tiles[f.tile.y * D.W + f.tile.x].g, f.type === 'rock' ? 'boulder' : f.type);
  // babkina chalupa vrhá tieň na sever (na les)
  assert.ok(W.sunHours(g, 15, 1, 1) < W.sunHours(g, 12, 15, 1) - 4);
  // v zime sneh na slamenej streche
  assert.ok(W.buildGrid(tiles, 3).fine.find(f => f.type === 'hut').data.includes(W.M.SNOW));
});

test('stromy z minikociek: 6 druhov, ročné obdobia a otáčanie', () => {
  const sum = W.buildGrid(tiles, 1), win = W.buildGrid(tiles, 3);
  const trees = sum.fine.filter(f => f.type === 'tree');
  assert.strictEqual(trees.length, tiles.filter(t => t.g === 'tree').length, 'každý strom na mape má model');
  assert.deepStrictEqual([...new Set(trees.map(t => t.kind))].sort(), [...W.TREE_KINDS].sort(), 'na mape sú všetky druhy');
  const filled = f => f.data.reduce((n, v) => n + (v ? 1 : 0), 0);
  const of = (g, kind) => g.fine.find(f => f.type === 'tree' && f.kind === kind);
  // listnaté stromy sú v zime holé (oveľa menej minikociek), ihličnany nie
  for (const k of ['buk', 'dub', 'breza', 'jablon']) assert.ok(filled(of(win, k)) < filled(of(sum, k)) * 0.4, k + ' v zime bez lístia');
  assert.ok(filled(of(win, 'smrek')) >= filled(of(sum, 'smrek')), 'smrek má v zime ihličie aj sneh');
  assert.ok(of(win, 'smrek').data.includes(W.M.SNOW));
  // jabloň na jar kvitne, v lete má jablká
  assert.ok(of(W.buildGrid(tiles, 0), 'jablon').data.includes(W.M.BLOSSOM_W));
  assert.ok(of(sum, 'jablon').data.includes(W.M.APPLE));
  // otočené varianty majú rovnaký počet minikociek, ale iné rozloženie
  const rots = new Map();
  for (const t of trees) { const key = t.kind; if (!rots.has(key)) rots.set(key, new Set()); rots.get(key).add(t.data); }
  assert.ok([...rots.values()].some(s => s.size > 1), 'rovnaký druh sa vyskytuje v rôznych otočeniach');
});

test('kamene z minikociek: všetky tvary, mach mimo zimy, sneh v zime, tieň v hrubej mriežke', () => {
  const sum = W.buildGrid(tiles, 1), win = W.buildGrid(tiles, 3);
  const rocks = sum.fine.filter(f => f.type === 'rock');
  assert.strictEqual(rocks.length, tiles.filter(t => t.g === 'boulder').length);
  assert.deepStrictEqual([...new Set(rocks.map(r => r.kind))].sort(), ['balvan', 'kopa', 'plocha']);
  assert.ok(rocks.every(r => r.data.includes(W.M.MOSS) && !r.data.includes(W.M.SNOW)));
  assert.ok(win.fine.filter(f => f.type === 'rock').every(r => r.data.includes(W.M.SNOW)));
  assert.ok(!sum.m.includes(W.M.DARKSTONE), 'hrubé balvany sa už nestavajú');
});

test('voda: hladina 1/8 bloku pod zemou, maska, lekná a najbližšia voda', () => {
  assert.strictEqual(W.WATER_Y, 0.875);
  const q = W.waterQuads(tiles), mask = W.waterMask(tiles);
  assert.strictEqual(q.length, tiles.filter(t => t.g === 'water').length);
  for (const w of q) assert.strictEqual(mask[w.y * D.W + w.x], 255);
  assert.strictEqual(mask.filter(v => v).length, q.length);
  // lekná len na vode a v zime žiadne
  for (const p of W.lilyPads(tiles, 1)) assert.strictEqual(tiles[p.y * D.W + p.x].g, 'water');
  assert.strictEqual(W.lilyPads(tiles, 3).length, 0);
  // z piesku vedľa vody je voda blízko, z lúky ďaleko nie
  const shore = q.find(w => tiles[w.y * D.W + w.x + 1].g === 'sand');
  const n = W.nearestWater(tiles, shore.x + 1.3, shore.y + 0.5, 0.6);
  assert.ok(n && Math.abs(n.x - (shore.x + 1)) < 1e-9 && n.d < 0.31);
  assert.strictEqual(W.nearestWater(tiles, 20.5, 5.5, 0.6), null);
});
