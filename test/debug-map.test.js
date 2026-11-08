// Záložka Mapa na ladiacej stránke (#77): políčka a štatistiky musia sedieť s hrou (shared/data.js, ice.js, areas.js)
const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const Ice = require('../ice.js');
const Areas = require('../areas.js');

const load = () => import('../debug/tabs/map-core.mjs');
const SEEDS = [0, 1, 7, 12345, 4294967295, 2654435761];
const seedsFor = (M, a) => M.isSeeded(D, a) ? SEEDS : [null];

test('mapa: plocha zo semienka je presne plocha z generátora hry', async () => {
  const M = await load();
  for (const a of D.AREAS) for (const seed of seedsFor(M, a)) {
    const map = M.buildTiles(D, a, { seed });
    const base = D.buildArea(a, seed);
    const { w, h } = D.areaSize(a);
    assert.strictEqual(map.w, w); assert.strictEqual(map.h, h);
    assert.strictEqual(map.tiles.length, w * h);
    assert.strictEqual(map.source, 'seed');
    // v záhrade je namiesto ľadovne pozemok (kým sa nepostaví), inak všetko rovnako
    assert.deepStrictEqual(map.tiles.map(t => t.g), base, `${a} ${seed}`);
  }
});

test('mapa: záhrada a hory sú pevné, Les na pomedzí je podľa semienka', async () => {
  const M = await load();
  assert.strictEqual(M.isSeeded(D, 'garden'), false);
  assert.strictEqual(M.isSeeded(D, 'hory'), false);
  assert.strictEqual(M.isSeeded(D, 'pomedzie'), true);
  assert.ok(M.buildTiles(D, 'pomedzie', {}).error, 'bez semienka nič');
  assert.ok(!M.buildTiles(D, 'garden', {}).error, 'pevná plocha semienko nepotrebuje');
  assert.strictEqual(M.parseSeed('42'), 42);
  assert.strictEqual(M.parseSeed(' 4294967295 '), 4294967295);
  for (const bad of ['', '-1', '4294967296', '1e3', 'abc', null]) assert.strictEqual(M.parseSeed(bad), null, String(bad));
  for (let i = 0; i < 20; i++) { const s = M.randomSeed(); assert.ok(Number.isInteger(s) && s >= 0 && s <= 4294967295); }
});

test('mapa: každý typ zeme z generátorov má svoj spôsob kreslenia', async () => {
  const M = await load();
  for (const a of D.AREAS) for (const seed of seedsFor(M, a)) {
    for (const g of new Set(D.buildArea(a, seed))) assert.ok(g in M.KINDS, `${a}: typ ${g} chýba v KINDS`);
  }
  for (const g of ['icehouse', 'lot']) assert.ok(g in M.KINDS);
  // neprechodné typy sa nekreslia ako chodník, čistina ani holá zem (skalnú stenu ukáže výška, 4 bloky)
  for (const g of Object.keys(D.BLOCK)) if (!['glacier', 'water', 'cliff'].includes(g)) assert.ok(!['path', 'clearing', 'ground'].includes(M.kindOf(D, g)), g);
});

test('mapa: štatistiky plochy sedia s hrou', async () => {
  const M = await load();
  for (const a of D.AREAS) for (const seed of seedsFor(M, a)) {
    const map = M.buildTiles(D, a, { seed }), s = M.areaStats(D, map), tiles = map.tiles;
    const walk = tiles.filter(t => D.passable(t)).length;
    assert.strictEqual(s.walkable, walk);
    assert.strictEqual(s.walkablePct, Math.round(100 * walk / tiles.length));
    assert.strictEqual(s.paths, tiles.filter(t => t.g === 'path' || t.g === 'roots').length);
    assert.strictEqual(s.trees, tiles.filter(t => ['tree', 'spruce', 'giant'].includes(t.g)).length);
    assert.strictEqual(s.bushes, tiles.filter(t => t.g === 'bush').length);
    // prechody: všetky z D.GATES, zoskupené podľa cieľa, každý na políčku 'gate'
    assert.strictEqual(s.gates.reduce((n, g) => n + g.tiles.length, 0), D.GATES[a].length);
    for (const g of s.gates) {
      assert.strictEqual(g.name, D.AREA_NAMES[g.to]);
      for (const t of g.tiles) {
        assert.strictEqual(D.gateAt(a, t.x, t.y).to, g.to);
        assert.strictEqual(tiles[t.y * map.w + t.x].g, 'gate', `${a} prechod ${t.x},${t.y}`);
      }
    }
  }
  // známe čísla: záhrada má prechod do hôr aj do Lesa na pomedzí, hory len do záhrady
  const g = M.areaStats(D, M.buildTiles(D, 'garden', {}));
  assert.deepStrictEqual(g.gates.map(x => x.to).sort(), ['hory', 'pomedzie']);
  assert.deepStrictEqual(M.areaStats(D, M.buildTiles(D, 'hory', {})).gates.map(x => x.to), ['garden']);
  assert.ok(M.areaStats(D, M.buildTiles(D, 'hory', {})).trees > 0, 'smreky sú stromy');
});

test('mapa: výška, priechodnosť a inšpektor políčka', async () => {
  const M = await load();
  for (const a of D.AREAS) {
    const map = M.buildTiles(D, a, { seed: 7 });
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      const t = map.tiles[y * map.w + x], i = M.tileInfo(D, map, x, y);
      assert.strictEqual(i.g, t.g);
      assert.strictEqual(i.walkable, D.passable(t));
      assert.strictEqual(i.height, D.level(t) / D.GLACIER_LAYERS);
      if (t.g !== 'glacier') assert.strictEqual(i.height, D.terrainH(t.g) / 2);
      assert.strictEqual(i.gateTo || null, (D.gateAt(a, x, y) || {}).to || null);
    }
    assert.strictEqual(M.tileInfo(D, map, -1, 0), null);
    assert.strictEqual(M.tileInfo(D, map, map.w, 0), null);
  }
  // tráva je 1 blok nad nulou, voda pol bloku, skalná stena 4 bloky
  assert.strictEqual(M.heightBlocks(D, { g: 'grass' }), 1);
  assert.strictEqual(M.heightBlocks(D, { g: 'water' }), 0.5);
  assert.strictEqual(M.heightBlocks(D, { g: 'cliff' }), 4);
});

test('mapa: svet – jeho semienko, pôda a rastliny, ľadovňa, ľad a otvory ako v hre', async () => {
  const M = await load();
  const garden = D.buildMap(), hory = D.buildMountains();
  const bed = garden.indexOf('grass'), pond = garden.indexOf('water'), glacier = hory.indexOf('glacier'), lake = hory.indexOf('water');
  const tiles = garden.map(() => ({ s: null }));
  tiles[bed] = { s: { k: 'normal', w: 1, r: 0, p: { sp: 'snezienka', prog: 9 }, o: 'p-1234abcd' } };
  tiles[pond] = { s: null, cut: 1 };
  const savedHory = hory.map(() => 0);
  savedHory[glacier] = { ice: 1 }; savedHory[lake] = { cut: 1 };
  const state = { tiles, hory: savedHory, pomedzieSeed: 991, icehouse: { built: true, ice: 3 }, saves: {} };

  // záhrada ako getRoom v server.js + applyIcehouse
  const room = { tiles: garden.map((g, i) => { const t = { g, s: tiles[i].s || null }; if (g === 'water' && tiles[i].cut) t.cut = 1; return t; }), icehouse: state.icehouse };
  Ice.applyIcehouse(room.icehouse, room.tiles);
  const gm = M.buildTiles(D, 'garden', { state });
  assert.strictEqual(gm.source, 'room');
  assert.deepStrictEqual(gm.tiles.map(t => t.g), room.tiles.map(t => t.g));
  assert.ok(gm.tiles.some(t => t.g === 'icehouse') && gm.tiles.filter(t => t.g === 'lot').length === 4, 'ľadovňa stojí, pozemok Dielne je voľný');
  assert.deepStrictEqual(gm.tiles[bed].s, tiles[bed].s);
  assert.strictEqual(gm.tiles[pond].cut, 1);
  const st = M.areaStats(D, gm);
  assert.strictEqual(st.tilled, 1); assert.strictEqual(st.planted, 1); assert.strictEqual(st.holes, 1);
  const info = M.tileInfo(D, gm, bed % D.W, (bed / D.W) | 0);
  assert.strictEqual(info.plant.name, D.SPECIES.snezienka.name);
  assert.strictEqual(info.plant.stage, D.stageOf({ sp: 'snezienka', prog: 9 }));
  assert.ok(info.wet);

  // hory ako Ice.loadHory
  const hm = M.buildTiles(D, 'hory', { state }), real = Ice.loadHory(savedHory);
  assert.deepStrictEqual(hm.tiles.map(t => [t.g, t.ice, t.cut]), real.map(t => [t.g, t.ice, t.cut]));
  assert.strictEqual(hm.tiles[glacier].ice, 1);
  // bez uloženia je ľadovec celý
  const fresh = M.buildTiles(D, 'hory', {});
  assert.deepStrictEqual(fresh.tiles.map(t => t.ice), Ice.loadHory(null).map(t => t.ice));

  // Les na pomedzí zo semienka sveta, nie zo zadaného
  const pm = M.buildTiles(D, 'pomedzie', { state, seed: 5 });
  assert.strictEqual(pm.seed, 991);
  assert.deepStrictEqual(pm.tiles.map(t => t.g), Areas.loadPomedzie(991).map(t => t.g));
  assert.strictEqual(M.buildTiles(D, 'pomedzie', { state: { tiles } }).error, 'no-room-seed');
});

test('mapa: hráči sveta na ploche, online podľa odtlačku kľúča', async () => {
  const M = await load();
  const snap = {
    online: [{ name: 'Anka', area: 'hory', player: 'p-aaaa' }],
    state: { saves: { 'p-aaaa': { x: 3.5, y: 4.5, area: 'garden' }, 'p-bbbb': { x: 7.2, y: 8.9, area: 'garden' }, 'p-cccc': {} } }
  };
  const g = M.playersOn(D, 'garden', snap);
  // Anka je online v horách (živá plocha má prednosť pred uložením), v záhrade ostanú dvaja offline
  assert.deepStrictEqual(g.map(p => [p.id, p.online, p.x, p.y]), [['p-bbbb', false, 7.2, 8.9], ['p-cccc', false, D.SPAWN.x, D.SPAWN.y]]);
  const h = M.playersOn(D, 'hory', snap);
  assert.deepStrictEqual(h.map(p => [p.id, p.name, p.online]), [['p-aaaa', 'Anka', true]]);
  assert.deepStrictEqual(M.playersOn(D, 'garden', null), []);
});
