const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/shared/data.js');
const I = require('../src/server/items.js');
const Ice = require('../src/server/ice.js');
const Areas = require('../src/server/areas.js');
const TPD = D.TICKS_PER_DAY;

// Minimálny svet: záhrada z generátora, hory, sklad
function room(tick) {
  const r = { tick: tick || 0, storage: { inv: {}, fb: {} }, tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null), icehouse: { built: false, ice: 0 }, glacierFed: -1 };
  Ice.applyIcehouse(r.icehouse, r.tiles);
  return r;
}
const dawnIce = (r, se, weather) => Ice.dawnIce(r.tiles, r.hory, se, weather);
// kŕmenie ľadovca zrážkami najviac raz za deň – tak ako to robí server (rainFeedsGlacier) a ráno (dawn)
function feed(r, weather) {
  const day = D.dayOfTick(r.tick);
  if (!D.GLACIER_GROW[weather] || r.glacierFed === day) return 0;
  r.glacierFed = day;
  return Ice.feedGlacier(r.hory, weather);
}
const fill = (r, n) => Ice.fillIcehouse(r.icehouse, r.storage, r.tick, n);
const melt = (r, se) => Ice.meltHourly(r.icehouse, r.storage, r.tick, se);
const storage = r => I.storageC(r.storage, r.icehouse);
const find = (tiles, g) => tiles.findIndex(t => t.g === g);

test('hory majú rovnakú veľkosť ako záhrada, prechody a príchody sedia', () => {
  const h = D.buildMountains(), g = D.buildMap();
  assert.strictEqual(h.length, D.W * D.H);
  for (const area of D.AREAS) {
    const tiles = D.buildArea(area, 1);
    for (const { x, y } of D.GATES[area]) assert.strictEqual(tiles[y * D.areaSize(area).w + x], 'gate', `${area} ${x},${y}`);
  }
  assert.ok(h.includes('glacier') && h.includes('water'));
  assert.strictEqual(g.filter(t => t === 'lot').length, 8); // ľadovňa a Dielňa
});

test('z príchodu v horách sa dá dôjsť k ľadovcu aj späť k prechodu', () => {
  const tiles = D.buildMountains(), W = D.W, H = D.H;
  const a = D.arrival('garden', 'hory'), start = Math.floor(a.y) * W + Math.floor(a.x);
  const seen = new Set([start]), q = [start];
  while (q.length) {
    const i = q.shift(), x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(n) || D.BLOCK[tiles[n]]) continue;
      seen.add(n); q.push(n);
    }
  }
  const gates = D.GATES.hory.map(({ x, y }) => y * W + x);
  assert.ok(gates.some(i => seen.has(i)), 'prechod do záhrady');
  const nextToGlacier = [...seen].some(i => [1, -1, W, -W].some(d => tiles[i + d] === 'glacier'));
  assert.ok(nextToGlacier, 'k ľadovcu sa dá podísť');
});

test('prechod: na políčku gate vráti cieľovú plochu', () => {
  const r = room();
  const { x: gx, y: gy } = D.GATES.garden[0], { x: hx, y: hy } = D.GATES.hory[0];
  assert.strictEqual(Areas.gateTarget(r.tiles, 'garden', gx + 0.5, gy + 0.3), 'hory');
  assert.strictEqual(Areas.gateTarget(r.hory, 'hory', hx + 0.5, hy + 0.7), 'garden');
  assert.strictEqual(Areas.gateTarget(r.tiles, 'garden', D.SPAWN.x, D.SPAWN.y), null);
});

test('ľadovec: úrovne od pol bloku na okraji po 2 bloky v strede', () => {
  const g = D.buildMountains(), L = D.glacierLevels(g);
  g.forEach((t, i) => assert.strictEqual(L[i] > 0, t === 'glacier'));
  const edge = g.findIndex((t, i) => t === 'glacier' && g[i + D.W] !== 'glacier');
  assert.strictEqual(L[edge], 2, 'okraj = pol bloku = 2 vrstvy');
  assert.ok(Math.max(...L) >= 6 && Math.max(...L) <= D.GLACIER_TOP, 'stred má aspoň 3 úrovne, najviac 2 bloky');
  // susedné políčka sa líšia najviac o jednu úroveň (pol bloku)
  g.forEach((t, i) => { if (t === 'glacier' && g[i + 1] === 'glacier') assert.ok(Math.abs(L[i] - L[i + 1]) <= 2); });
});

test('ľadovec: krompáč berie vrchnú vrstvu až po dno', () => {
  const r = room(), i = find(r.hory, 'glacier'), max = Ice.LEVELS[i];
  assert.strictEqual(r.hory[i].ice, max);
  for (let k = 0; k < max; k++) assert.ok(Ice.digIce(r.hory, i, 1).ok);
  assert.strictEqual(Ice.digIce(r.hory, i, 1).ok, false);
});

test('ľadu je málo: menší ľadovec, sám nedorastá, topí sa od okrajov', () => {
  const r = room(), total = () => Ice.glacierTotal(r.hory);
  assert.ok(Ice.glacierMax() <= 140, `ľadovec má len ${Ice.glacierMax()} vrstiev`);
  assert.deepStrictEqual(dawnIce(r, 3, 'sun'), [], 'v zime bez snehu sa nič nemení');
  r.tick += D.TICKS_PER_DAY;
  dawnIce(r, 1, 'sun');                      // slnečný letný deň
  assert.strictEqual(total(), Ice.glacierMax() - D.GLACIER_MELT[1]);
  const edges = r.hory.map((t, i) => i).filter(i => Ice.LEVELS[i] === 2);
  assert.ok(r.hory.every((t, i) => t.ice == null || Ice.LEVELS[i] === 2 || t.ice === Ice.LEVELS[i]), 'topí sa len okraj');
  assert.ok(edges.some(i => r.hory[i].ice < 2));
  // leto bez dažďa: po čase sa minie úplne
  for (let d = 0; d < 40; d++) { r.tick += D.TICKS_PER_DAY; dawnIce(r, 1, 'sun'); }
  assert.strictEqual(total(), 0, 'ľadovec sa môže minúť');
});

test('ľadovec dorastá len v daždi a snehu, raz za deň, od skál nadol', () => {
  const r = room();
  for (const t of r.hory) if (t.ice != null) t.ice = 0;
  r.tick = 5 * D.TICKS_PER_DAY;
  dawnIce(r, 0, 'rain'); r.glacierFed = D.dayOfTick(r.tick);
  assert.strictEqual(Ice.glacierTotal(r.hory), D.GLACIER_GROW.rain, 'prázdny ľadovec sa netopí, dážď pridá vrstvy');
  const top = r.hory.map((t, i) => i).filter(i => Ice.LEVELS[i] === Math.max(...Ice.LEVELS));
  assert.ok(top.every(i => r.hory[i].ice > 0), 'najprv pod skalami');
  assert.strictEqual(feed(r, 'rain'), 0, 'v ten istý deň druhý dážď nepridá');
  r.tick += D.TICKS_PER_DAY;
  assert.strictEqual(feed(r, 'snow'), D.GLACIER_GROW.snow);
  assert.strictEqual(feed(r, 'sun'), 0);
  for (let d = 0; d < 50; d++) { r.tick += D.TICKS_PER_DAY; feed(r, 'snow'); }
  assert.strictEqual(Ice.glacierTotal(r.hory), Ice.glacierMax(), 'nedorastie nad pôvodnú výšku');
});

test('ľad v batohu sa do pol dňa roztopí, od najstaršieho', () => {
  const sv = { inv: {} }, c = I.playerC(sv);
  I.addItems(c, 'ice', 2, 0);
  I.addItems(c, 'ice', 1, 100);
  assert.strictEqual(I.meltSweep(c, D.ICE_LIFE - 1), 0);
  assert.strictEqual(I.meltSweep(c, D.ICE_LIFE), 2);
  assert.strictEqual(sv.inv.ice, 1);
  assert.strictEqual(I.meltSweep(c, D.ICE_LIFE + 100), 1);
  assert.ok(!sv.inv.ice && !sv.fb.ice);
  assert.deepStrictEqual(I.wiltSweep(c, 10 * D.TICKS_PER_DAY), {}, 'ľad nevädne na zvädnuté kvety');
});

test('jazierko: ľad len v zime, z políčka raz za deň, cez noc zamrzne', () => {
  const r = room(), i = find(r.tiles, 'water');
  assert.strictEqual(Ice.digIce(r.tiles, i, 1).ok, false, 'v lete nie je zamrznuté');
  assert.ok(Ice.digIce(r.tiles, i, 3).ok);
  assert.strictEqual(Ice.digIce(r.tiles, i, 3).ok, false, 'druhý raz v ten istý deň nie');
  assert.ok(dawnIce(r, 3, 'sun').includes('garden'));
  assert.ok(!r.tiles[i].cut);
  assert.ok(Ice.digIce(r.tiles, i, 3).ok);
  assert.strictEqual(Ice.digIce(r.tiles, find(r.tiles, 'grass'), 3).ok, false);
});

test('uloženie hôr zachová zásobu ľadu a otvory, nové hory majú plný ľadovec', () => {
  const r = room(), i = find(r.hory, 'glacier'), w = find(r.hory, 'water');
  Ice.digIce(r.hory, i, 3); Ice.digIce(r.hory, w, 3);
  const back = Ice.loadHory(JSON.parse(JSON.stringify(Ice.saveHory(r.hory))));
  assert.strictEqual(back[i].ice, Ice.LEVELS[i] - 1);
  assert.strictEqual(back[w].cut, 1);
  assert.strictEqual(Ice.loadHory(undefined)[i].ice, Ice.LEVELS[i]);
  const big = Ice.loadHory(r.hory.map(t => ({ ice: 99 })));
  assert.strictEqual(big[i].ice, Ice.LEVELS[i], 'uložená výška sa oreže na pôvodnú');
});

test('krompáč sa kupuje raz, s dostatkom mincí', () => {
  const sv = { coins: 10, rep: 0, inv: {} };
  assert.ok(Ice.buyTool(sv, 'pick'));
  sv.coins = 100;
  assert.strictEqual(Ice.buyTool(sv, 'pick'), null);
  assert.strictEqual(sv.coins, 100 - D.TOOLS.pick.price);
  assert.strictEqual(sv.inv.pick, 1);
  assert.ok(Ice.buyTool(sv, 'pick'), 'druhý krompáč nie');
  assert.ok(Ice.buyTool(sv, 'nic'));
});

test('ľadovňa: stavba na pozemku, reputácia, prekopaná zem', () => {
  const r = room(), sv = { coins: 1000, rep: 0, inv: {} };
  const build = () => Ice.buildIcehouse(r.icehouse, r.tiles, sv);
  assert.ok(build(), 'bez reputácie nie');
  sv.rep = D.REP_LEVELS[D.ICEHOUSE.rep];
  const lot = Ice.lotIdx();
  r.tiles[lot[0]].s = { k: 'normal' };
  assert.ok(build(), 'na prekopanej zemi nie');
  r.tiles[lot[0]].s = null;
  assert.strictEqual(build(), null);
  assert.strictEqual(sv.coins, 1000 - D.ICEHOUSE.price);
  assert.ok(lot.every(i => r.tiles[i].g === 'icehouse'));
  assert.ok(build(), 'druhá ľadovňa nie');
});

test('ľadovňa sa plní do kapacity a topí sa podľa obdobia (v zime nie)', () => {
  const r = room();
  assert.strictEqual(fill(r, 5), 0, 'nepostavená');
  r.icehouse = { built: true, ice: 0 };
  assert.strictEqual(fill(r, 100), D.ICEHOUSE.cap);
  assert.strictEqual(fill(r, 1), 0, 'plná');
  assert.strictEqual(melt(r, 3), false);
  assert.strictEqual(r.icehouse.ice, D.ICEHOUSE.cap, 'v zime sa netopí');
  let hours = 0, emptied = false;
  while (!emptied && hours < 1000) { emptied = melt(r, 1); hours++; }
  assert.strictEqual(hours, Math.round(D.ICEHOUSE.cap / D.ICEHOUSE.melt[1]), 'v lete sa roztopí za cap / melt hodín');
  assert.strictEqual(r.icehouse.ice, 0);
  assert.strictEqual(melt(r, 1), false, 'prázdna sa už nevyprázdni znova');
});

test('s ľadom v ľadovni kvety v sklade starnú pomalšie, vek sa pri zmene neskočí', () => {
  const r = room();
  r.icehouse = { built: true, ice: 0 };
  I.addItems(storage(r), 'fl_tulipan', 2, 0);
  const age = () => I.batchesView(storage(r), r.tick).fl_tulipan[0].age;
  r.tick = 100;
  assert.strictEqual(age(), 100 * D.STORAGE_AGE_RATE);
  fill(r, 2);
  assert.strictEqual(I.storageRate(r.icehouse), D.ICEHOUSE.rate);
  assert.strictEqual(age(), 50, 'pri naplnení sa vek nezmení');
  r.tick = 200;
  assert.strictEqual(age(), 50 + 100 * D.ICEHOUSE.rate);
  Ice.setIce(r.icehouse, r.storage, r.tick, 0); // roztopí sa
  assert.strictEqual(age(), 75, 'pri roztopení sa vek nezmení');
  r.tick = 300;
  assert.strictEqual(age(), 75 + 100 * D.STORAGE_AGE_RATE);
  // tulipán (4 dni) v chladenom sklade vydrží 4 / 0,25 = 16 dní
  const r2 = room(); r2.icehouse = { built: true, ice: D.ICEHOUSE.cap };
  I.addItems(storage(r2), 'fl_tulipan', 1, 0);
  assert.deepStrictEqual(I.wiltSweep(storage(r2), 16 * TPD - 1), {});
  assert.deepStrictEqual(I.wiltSweep(storage(r2), 16 * TPD), { 'Tulipán': 1 });
});

test('ľad a krompáč: názvy, krompáč je náradie', () => {
  assert.strictEqual(D.itemName('ice'), 'Ľad');
  assert.strictEqual(D.itemName('pick'), 'Krompáč');
  assert.ok(D.isTool('pick') && D.isTool('hoe') && !D.isTool('ice'));
  assert.strictEqual(D.sellPrice('ice'), 0);
});

test('po ľadovci sa chodí: hore najviac pol bloku (skokom blok), dolu hocikoľko', () => {
  const snow = { g: 'snow' }, ice = n => ({ g: 'glacier', ice: n });
  assert.ok(D.passable(ice(0)) && D.passable(ice(8)) && !D.passable({ g: 'cliff' }));
  assert.ok(D.canStep(snow, ice(0)), 'vysekané po dno');
  assert.ok(D.canStep(snow, ice(2)), 'pol bloku hore');
  assert.ok(!D.canStep(snow, ice(3)), 'vyššie nie');
  assert.ok(D.canStep(snow, ice(4), 2), 'so skokom o blok');
  assert.ok(D.canStep(ice(8), snow) && D.canStep(ice(8), ice(0)), 'dolu hocikoľko');
  assert.ok(!D.canStep(ice(0), { g: 'cliff' }));
  assert.ok(D.canStep(ice(2), ice(2), 0, true), 'plazením po rovine áno');
  assert.ok(!D.canStep(snow, ice(1), 0, true) && !D.canStep(ice(2), snow, 0, true), 'plazením cez schod ani hore, ani dolu');
  assert.ok(D.canStep({ g: 'grass' }, { g: 'rock' }), 'na skalku sa vyjde (pol bloku)');
  assert.ok(!D.canStep({ g: 'grass' }, { g: 'rock' }, 0, true) && !D.canStep({ g: 'rock' }, { g: 'path' }, 0, true), 'plazením ani na skalku, ani z nej');
  assert.ok(D.canStep(snow, { g: 'rock' }, 0, true), 'po rovine sa plazí aj mimo ľadovca');
  // plný ľadovec je schodisko: z okraja hôr sa dá dôjsť na každé jeho políčko
  const r = room(), tiles = r.hory, start = tiles.findIndex((t, i) => t.g === 'snow' && tiles[i + D.W] && tiles[i + D.W].g === 'glacier');
  const seen = new Set([start]), q = [start];
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % D.W, y = (i / D.W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * D.W + nx;
      if (nx < 0 || ny < 0 || nx >= D.W || ny >= D.H || seen.has(n) || !D.canStep(tiles[i], tiles[n])) continue;
      seen.add(n); q.push(n);
    }
  }
  assert.ok(start >= 0);
  tiles.forEach((t, i) => { if (t.g === 'glacier') assert.ok(seen.has(i), `políčko ľadovca ${i} je dostupné`); });
});

test('ľad nedorastá pod hráčom a nikdy nie viac ako pol bloku nad suseda', () => {
  const r = room();
  for (const t of r.hory) if (t.ice != null) t.ice = 0;
  const top = r.hory.findIndex((t, i) => Ice.LEVELS[i] === Math.max(...Ice.LEVELS));
  r.players = [{ area: 'hory', x: top % D.W + 0.5, y: ((top / D.W) | 0) + 0.5 }, { area: 'garden', x: 0.5, y: 0.5 }]; // snímka prítomnosti
  for (let d = 0; d < 30; d++) {
    Ice.growGlacier(r.hory, D.GLACIER_GROW.snow, Ice.occupied(r.players));
    r.hory.forEach((t, i) => { if (t.g === 'glacier') assert.ok(t.ice <= Ice.LEVELS[i]); });
    // nikto nezostane zamurovaný: z každého políčka sa dá vyjsť na suseda
    r.hory.forEach((t, i) => {
      if (t.g !== 'glacier') return;
      const x = i % D.W, y = (i / D.W) | 0;
      const out = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const n = r.hory[(y + dy) * D.W + x + dx]; return D.passable(n) && D.canStep(t, n) && D.canStep(n, t); });
      assert.ok(out, `z políčka ${i} sa dá vyjsť aj vrátiť`);
    });
  }
  assert.strictEqual(r.hory[top].ice, 0, 'kde hráč stojí, ľad nedorastie');
  r.players = [];
  for (let d = 0; d < 30; d++) Ice.growGlacier(r.hory, D.GLACIER_GROW.snow, Ice.occupied(r.players));
  assert.strictEqual(Ice.glacierTotal(r.hory), Ice.glacierMax(), 'keď odíde, ľadovec dorastie do pôvodnej výšky');
});
