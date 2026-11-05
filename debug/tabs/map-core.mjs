// Záložka Mapa (#77): čisté výpočty bez DOM – políčka plochy (zo semienka alebo zo sveta), druh políčka,
// výška, priechodnosť, štatistiky plochy a hráči. Všetko z herných generátorov v shared/data.js (D),
// aby mapa vždy sedela s hrou. D sa odovzdáva ako parameter (v prehliadači window.GameData, v teste require).

// Ako sa ktorý typ zeme kreslí. cls: ground (len zem), path (chodník, aj korene), clearing (čistina),
// water, glacier, tree / giant / bush / shroom (bodky), rock / log / building (štvorce), lot (pozemok), gate.
// Typ, ktorý tu chýba, sa kreslí ako zem (alebo štvorec, ak je neprechodný) – test stráži, aby tu bol každý.
export const KINDS = {
  grass: 'ground', forest: 'ground', meadow: 'ground', fern: 'ground', moss: 'ground', fungi: 'ground', sand: 'ground',
  alp: 'ground', snow: 'ground', scree: 'ground', rock: 'ground', cliff: 'ground',
  path: 'path', roots: 'path',
  ring: 'clearing', glade: 'clearing',
  water: 'water', glacier: 'glacier',
  tree: 'tree', spruce: 'tree', giant: 'giant', trunk: 'trunk', bush: 'bush', shroom: 'shroom',
  boulder: 'rock', log: 'log',
  hut: 'building', house: 'building', stall: 'building', well: 'building', cauldron: 'building', babka: 'building', icehouse: 'building',
  lot: 'lot', gate: 'gate'
};
export function kindOf(D, g) { return KINDS[g] || (D.BLOCK[g] ? 'building' : 'ground'); }
// stromy do štatistiky: obrovský strom (2 × 2) je jeden strom, jeho ďalšie tri políčka ('trunk') sa nerátajú
const TREES = new Set(['tree', 'spruce', 'giant']);

// Kde je uložený stav políčok plochy vo svete (server: room.tiles = záhrada, inak room[area])
const SAVED_KEY = { garden: 'tiles' };
export const seedKey = area => area + 'Seed';

// Je rozloženie plochy podľa semienka? (záhrada a hory sú pevné) – zistí sa z generátora, takže nová plocha sa ukáže sama
const seededCache = new WeakMap();
export function isSeeded(D, area) {
  let m = seededCache.get(D);
  if (!m) seededCache.set(D, m = {});
  if (!(area in m)) {
    const a = D.buildArea(area, 1).join(), b = D.buildArea(area, 2).join(), c = D.buildArea(area, 0xdeadbeef).join();
    m[area] = a !== b || a !== c;
  }
  return m[area];
}
export function randomSeed() { return Math.floor(Math.random() * 4294967296) >>> 0; }
export function parseSeed(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= 4294967295 ? n : null;
}

// Políčka plochy ako v hre: { area, w, h, seed, seeded, source: 'seed' | 'room', tiles: [{ g, ice?, cut?, s? }], maxIce }
// opt.state = uložený svet (snapshot z /api/debug/room) → skutočná plocha sveta (jeho semienko, pôda a rastliny, ľad);
// bez neho rozloženie zo semienka opt.seed (pre pevné plochy sa semienko ignoruje) a čerstvý ľadovec.
// Vráti { error } , ak svet pre plochu so semienkom ešte semienko nemá.
export function buildTiles(D, area, opt) {
  opt = opt || {};
  const { w, h } = D.areaSize(area), seeded = isSeeded(D, area), st = opt.state || null;
  let seed = null;
  if (seeded) {
    seed = st ? st[seedKey(area)] : opt.seed;
    if (!Number.isInteger(seed)) return { area, w, h, seeded, error: st ? 'no-room-seed' : 'no-seed' };
    seed >>>= 0;
  }
  const base = D.buildArea(area, seed == null ? 0 : seed);
  const saved = st ? st[SAVED_KEY[area] || area] : null;
  const sv = Array.isArray(saved) && saved.length === base.length ? saved : null;
  // pôvodná výška ľadovca (ako ice.js LEVELS) – glacierLevels počíta s rozmermi záhrady
  const levels = base.includes('glacier') && base.length === D.W * D.H ? D.glacierLevels(base) : null;
  // záhrada: pozemok ľadovne, kým nie je postavená ľadovňa (ice.js applyIcehouse)
  const lot = new Set();
  if (area === 'garden' && D.ICEHOUSE && D.ICEHOUSE.lot) {
    const L = D.ICEHOUSE.lot;
    for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) lot.add(y * w + x);
  }
  const built = !!(st && st.icehouse && st.icehouse.built);
  let maxIce = 0;
  const tiles = base.map((g, i) => {
    if (lot.has(i)) g = built ? 'icehouse' : 'lot';
    const t = { g }, s = (sv && sv[i]) || {};
    if (g === 'glacier') {
      const top = levels ? levels[i] : 0;
      t.ice = s.ice == null ? top : Math.max(0, Math.min(top, s.ice | 0));
      t.top = top;
      maxIce = Math.max(maxIce, top);
    }
    if (g === 'water' && s.cut) t.cut = 1;
    if (s.s) t.s = s.s; // pôda a rastlina (len záhrada)
    return t;
  });
  return { area, w, h, seed, seeded, source: st ? 'room' : 'seed', tiles, maxIce };
}

// Výška povrchu v blokoch nad nulovou zemou (D.level je vo vrstvách po 1/4 bloku, aj s ľadom)
export function heightBlocks(D, t) { return D.level(t) / D.GLACIER_LAYERS; }

// Prechody plochy zoskupené podľa cieľa: [{ to, name, tiles: [{x, y}] }]
export function gateGroups(D, area) {
  const out = [];
  for (const g of D.GATES[area] || []) {
    let e = out.find(o => o.to === g.to);
    if (!e) out.push(e = { to: g.to, name: D.AREA_NAMES[g.to] || g.to, tiles: [] });
    e.tiles.push({ x: g.x, y: g.y });
  }
  return out;
}
// Príchodové miesta na tejto ploche: [{ from, x, y }]
export function arrivals(D, area) {
  return Object.entries(D.ARRIVE || {}).filter(([k]) => k.split('>')[1] === area).map(([k, p]) => ({ from: k.split('>')[0], x: p.x, y: p.y }));
}

// Hráči sveta na ploche: poloha z uloženia (x, y, area), online podľa snap.online (rovnaké odtlačky kľúčov)
export function playersOn(D, area, snap) {
  if (!snap || !snap.state) return [];
  const online = new Map((snap.online || []).map(o => [o.player, o]));
  const out = [];
  for (const [id, sv] of Object.entries(snap.state.saves || {})) {
    const o = online.get(id);
    const a = o ? o.area : D.AREAS.includes(sv.area) ? sv.area : 'garden';
    if (a !== area) continue;
    const x = typeof sv.x === 'number' ? sv.x : D.SPAWN.x, y = typeof sv.y === 'number' ? sv.y : D.SPAWN.y;
    out.push({ id, name: o ? o.name : null, online: !!o, x, y, known: typeof sv.x === 'number' });
  }
  return out.sort((a, b) => a.online - b.online);
}

// Štatistiky plochy (pre panel Area)
export function areaStats(D, map) {
  const n = map.tiles.length, by = {};
  let walk = 0, paths = 0, trees = 0, tilled = 0, planted = 0, ice = 0, iceTop = 0, holes = 0;
  for (const t of map.tiles) {
    by[t.g] = (by[t.g] || 0) + 1;
    if (D.passable(t)) walk++;
    if (kindOf(D, t.g) === 'path') paths++;
    if (TREES.has(t.g)) trees++;
    if (t.s) { tilled++; if (t.s.p) planted++; }
    if (t.g === 'glacier') { ice += t.ice || 0; iceTop += t.top || 0; }
    if (t.cut) holes++;
  }
  return {
    w: map.w, h: map.h, tiles: n, walkable: walk, walkablePct: n ? Math.round(100 * walk / n) : 0,
    paths, trees, bushes: by.bush || 0, byType: by, tilled, planted, ice, iceTop, holes, gates: gateGroups(D, map.area)
  };
}

// Údaje do inšpektora políčka (x, y); trunk ukáže na svoj obrovský strom
export function tileInfo(D, map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return null;
  const t = map.tiles[y * map.w + x], kind = kindOf(D, t.g);
  const info = { x, y, g: t.g, kind, height: heightBlocks(D, t), level: D.level(t), walkable: D.passable(t) };
  if (t.g === 'trunk') {
    for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && map.tiles[ny * map.w + nx].g === 'giant') { info.giantAt = { x: nx, y: ny }; break; }
    }
  }
  const gate = D.gateAt(map.area, x, y);
  if (gate) info.gateTo = gate.to;
  if (t.g === 'glacier') { info.ice = t.ice; info.iceTop = t.top; }
  if (t.cut) info.cut = true;
  if (t.s) {
    info.soil = t.s.k || 'normal';
    info.wet = !!t.s.w;
    const p = t.s.p;
    if (p) info.plant = { sp: p.sp, name: p.wild && !D.SPECIES[p.sp] ? 'wild plant' : D.SPECIES[p.sp] ? D.SPECIES[p.sp].name : String(p.sp), wild: !!p.wild, stage: D.stageOf(p), dead: !!p.d };
  }
  return info;
}
