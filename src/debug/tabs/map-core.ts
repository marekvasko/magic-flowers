// Záložka Mapa (#77): čisté výpočty bez DOM – políčka plochy (zo semienka alebo zo sveta), druh políčka,
// výška, priechodnosť, štatistiky plochy a hráči. Všetko z herných generátorov v src/shared/data.ts (D),
// aby mapa vždy sedela s hrou. D sa odovzdáva ako parameter (stránka aj test ho importujú).
import type * as Data from '../../shared/data.ts';
import type { AreaId, Ground } from '../../shared/data.ts';
import type { Soil } from '../../shared/save.ts';
import { isRecord, lookup } from '../../shared/util.ts';
import type { JsonRecord } from '../../shared/util.ts';
import type { DebugState, RoomSnapshot } from '../../server/debug.ts';

type D = typeof Data;
// Druh kreslenia políčka (pozri KINDS)
export type Kind = 'ground' | 'path' | 'clearing' | 'water' | 'glacier' | 'tree' | 'giant' | 'trunk' | 'bush' | 'shroom' | 'rock' | 'log' | 'building' | 'lot' | 'gate' | 'dock';
// Políčko mapy: zem, na ľadovci ľad a jeho pôvodná výška (top), otvor vo vode, pôda a rastlina (len záhrada)
export interface MapTile { g: Ground; ice?: number; top?: number; cut?: 1; s?: Soil }
// boat = loďka (#160) zo sveta: poloha, smer, kto v nej sedí, prevrátená (zima); deep = políčka vody, kam sa z brehu nedočiahne
export interface MapBoat { x: number; y: number; a: number; seats: string[]; flip: boolean }
export interface AreaMap { area: string; w: number; h: number; seed: number | null; seeded: boolean; source: 'seed' | 'room'; tiles: MapTile[]; maxIce: number; boat: MapBoat | null; deep: Set<number>; error?: undefined }
export interface MapError { area: string; w: number; h: number; seeded: boolean; error: 'no-room-seed' | 'no-seed' }
// Stav sveta, ako ho mapa číta (snapshot z /api/debug/room); test podstrčí len časť
export type MapState = Partial<DebugState>;

// Ako sa ktorý typ zeme kreslí. cls: ground (len zem), path (chodník, aj korene), clearing (čistina),
// water, glacier, tree / giant / bush / shroom (bodky), rock / log / building (štvorce), lot (pozemok), gate.
// Typ, ktorý tu chýba, sa kreslí ako zem (alebo štvorec, ak je neprechodný) – test stráži, aby tu bol každý.
export const KINDS: Readonly<Partial<Record<Ground, Kind>>> = {
  grass: 'ground', forest: 'ground', meadow: 'ground', fern: 'ground', moss: 'ground', fungi: 'ground', sand: 'ground',
  alp: 'ground', snow: 'ground', scree: 'ground', rock: 'ground', cliff: 'ground',
  path: 'path', roots: 'path',
  ring: 'clearing', glade: 'clearing',
  water: 'water', glacier: 'glacier',
  tree: 'tree', spruce: 'tree', giant: 'giant', trunk: 'trunk', bush: 'bush', shroom: 'shroom',
  boulder: 'rock', log: 'log',
  hut: 'building', house: 'building', stall: 'building', well: 'building', cauldron: 'building', babka: 'building', icehouse: 'building', dielna: 'building', majster: 'lot',
  lot: 'lot', gate: 'gate', dock: 'dock'
};
export function kindOf(D: D, g: Ground): Kind { return KINDS[g] || (D.BLOCK[g] ? 'building' : 'ground'); }
// stromy do štatistiky: obrovský strom (2 × 2) je jeden strom, jeho ďalšie tri políčka ('trunk') sa nerátajú
const TREES = new Set<Ground>(['tree', 'spruce', 'giant']);

// Kde je uložený stav políčok plochy vo svete (server: room.tiles = záhrada, inak room[area])
const SAVED_KEY: Readonly<Partial<Record<string, string>>> = { garden: 'tiles' };
export const seedKey = (area: string): string => area + 'Seed';

// Je rozloženie plochy podľa semienka? (záhrada a hory sú pevné) – zistí sa z generátora, takže nová plocha sa ukáže sama
const seededCache = new WeakMap<D, Map<string, boolean>>();
export function isSeeded(D: D, area: string): boolean {
  let m = seededCache.get(D);
  if (!m) seededCache.set(D, m = new Map<string, boolean>());
  let v = m.get(area);
  if (v === undefined) {
    const a = D.buildArea(area, 1).join(), b = D.buildArea(area, 2).join(), c = D.buildArea(area, 0xdeadbeef).join();
    m.set(area, v = a !== b || a !== c);
  }
  return v;
}
export function randomSeed(): number { return Math.floor(Math.random() * 4294967296) >>> 0; }
export function parseSeed(v: unknown): number | null {
  const s = (typeof v === 'string' || typeof v === 'number' ? String(v) : '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= 4294967295 ? n : null;
}

// Políčka plochy ako v hre: { area, w, h, seed, seeded, source: 'seed' | 'room', tiles: [{ g, ice?, cut?, s? }], maxIce }
// opt.state = uložený svet (snapshot z /api/debug/room) → skutočná plocha sveta (jeho semienko, pôda a rastliny, ľad);
// bez neho rozloženie zo semienka opt.seed (pre pevné plochy sa semienko ignoruje) a čerstvý ľadovec.
// Vráti { error } , ak svet pre plochu so semienkom ešte semienko nemá.
export function buildTiles(D: D, area: string, opt?: { state?: MapState | null; seed?: number | null }): AreaMap | MapError {
  opt = opt || {};
  const { w, h } = D.areaSize(area), seeded = isSeeded(D, area), st = opt.state || null;
  const field = (k: string): unknown => st ? lookup(st, k) : undefined; // uložené polia sveta (JSON)
  let seed: number | null = null;
  if (seeded) {
    const s = st ? field(seedKey(area)) : opt.seed;
    if (typeof s !== 'number' || !Number.isInteger(s)) return { area, w, h, seeded, error: st ? 'no-room-seed' : 'no-seed' };
    seed = s >>> 0;
  }
  // Les divov má vo svete uložené celé rozloženie (reťazec znakov) – to má prednosť pred semienkom, ako v hre
  const savedLes = area === 'les' && st ? D.decodeLes(st.les) : null;
  const base = savedLes || D.buildArea(area, seed == null ? 0 : seed);
  const saved = st && area !== 'les' ? field(SAVED_KEY[area] || area) : null;
  const sv: unknown[] | null = Array.isArray(saved) && saved.length === base.length ? saved : null;
  const soils = area === 'garden' && sv ? st?.tiles : null; // záhrada: uložená pôda a rastliny (SavedTile)
  // pôvodná výška ľadovca (ako ice.ts LEVELS) – glacierLevels počíta s rozmermi záhrady
  const levels = base.includes('glacier') && base.length === D.W * D.H ? D.glacierLevels(base) : null;
  // záhrada: pozemok ľadovne, kým nie je postavená ľadovňa (ice.ts applyIcehouse)
  const lot = new Set<number>();
  if (area === 'garden') {
    const L = D.ICEHOUSE.lot;
    for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) lot.add(y * w + x);
  }
  // pozemok Dielne vedľa trhu (dielna.ts applyDielna)
  const dlot = new Set<number>();
  if (area === 'garden') {
    const L = D.DIELNA.lot;
    for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) dlot.add(y * w + x);
  }
  const builtOf = (v: unknown): boolean => isRecord(v) && !!v['built'];
  const built = builtOf(field('icehouse')), dbuilt = builtOf(field('dielna'));
  // mólo a loďka (dock.ts applyDock): políčka móla sú voda, kým mólo nestojí
  const dock = field('dock'), kbuilt = area === 'garden' && builtOf(dock);
  const klot = new Set<number>(area === 'garden' ? D.DOCK.tiles.map(p => p.y * w + p.x) : []);
  let maxIce = 0;
  const tiles = base.map((g0, i): MapTile => {
    let g = g0;
    if (lot.has(i)) g = built ? 'icehouse' : 'lot';
    else if (dlot.has(i)) g = dbuilt ? 'dielna' : 'lot';
    else if (klot.has(i) && kbuilt) g = 'dock';
    const t: MapTile = { g }, raw = sv?.[i], s: JsonRecord = isRecord(raw) ? raw : {};
    if (g === 'glacier') {
      const top = levels?.[i] ?? 0, ice = s['ice'];
      t.ice = typeof ice !== 'number' ? top : Math.max(0, Math.min(top, ice | 0));
      t.top = top;
      maxIce = Math.max(maxIce, top);
    }
    if (g === 'water' && s['cut']) t.cut = 1;
    const hs = area === 'hory' && g === 'water' ? s['s'] : undefined; // vodný kvet v plese (#38, ako Ice.loadHory)
    const soil = soils?.[i]?.s ?? (D.isWaterSoil(hs) ? hs : undefined);
    if (soil) t.s = soil; // pôda a rastlina (záhrada, vodné kvety v plese)
    return t;
  });
  return { area, w, h, seed, seeded, source: st ? 'room' : 'seed', tiles, maxIce, boat: kbuilt ? boatOf(dock) : null, deep: area === 'garden' ? new Set(D.deepWater(tiles, w)) : new Set() };
}
// Loďka z uloženého móla (JSON zo sveta)
function boatOf(dock: unknown): MapBoat | null {
  if (!isRecord(dock) || !isRecord(dock['boat'])) return null;
  const b = dock['boat'], x = b['x'], y = b['y'], a = b['a'], seats = dock['seats'];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x, y, a: typeof a === 'number' ? a : 0, seats: Array.isArray(seats) ? seats.filter((k): k is string => typeof k === 'string') : [], flip: !!dock['flip'] };
}

// Výška povrchu v blokoch nad nulovou zemou (D.level je vo vrstvách po 1/4 bloku, aj s ľadom)
export function heightBlocks(D: D, t: Pick<MapTile, 'g' | 'ice'>): number { return D.level(t) / D.GLACIER_LAYERS; }

// Prechody plochy zoskupené podľa cieľa: [{ to, name, tiles: [{x, y}] }]
export interface GateGroup { to: AreaId; name: string; tiles: { x: number; y: number }[] }
export function gateGroups(D: D, area: string): GateGroup[] {
  const out: GateGroup[] = [];
  for (const g of lookup(D.GATES, area) || []) {
    let e = out.find(o => o.to === g.to);
    if (!e) out.push(e = { to: g.to, name: D.AREA_NAMES[g.to] || g.to, tiles: [] });
    e.tiles.push({ x: g.x, y: g.y });
  }
  return out;
}
// Príchodové miesta na tejto ploche: [{ from, x, y }]
export function arrivals(D: D, area: string): { from: string; x: number; y: number }[] {
  return Object.entries(D.ARRIVE).flatMap(([k, p]) => k.split('>')[1] === area ? [{ from: k.split('>')[0] ?? '', x: p.x, y: p.y }] : []);
}

// Hráči sveta na ploche: poloha z uloženia (x, y, area), online podľa snap.online (rovnaké odtlačky kľúčov)
export interface MapPlayer { id: string; name: string | null; online: boolean; x: number; y: number; known: boolean }
export type PlayersSnap = { online?: RoomSnapshot['online']; state?: { saves?: JsonRecord } } | null | undefined;
export function playersOn(D: D, area: string, snap: PlayersSnap): MapPlayer[] {
  if (!snap || !snap.state) return [];
  const online = new Map((snap.online || []).map(o => [o.player, o]));
  const out: MapPlayer[] = [];
  for (const [id, raw] of Object.entries(snap.state.saves || {})) {
    const o = online.get(id), sv: JsonRecord = isRecord(raw) ? raw : {};
    const a = o ? o.area : D.AREAS.find(x => x === sv['area']) ?? 'garden';
    if (a !== area) continue;
    const sx = sv['x'], sy = sv['y'];
    const x = typeof sx === 'number' ? sx : D.SPAWN.x, y = typeof sy === 'number' ? sy : D.SPAWN.y;
    out.push({ id, name: o ? o.name : null, online: !!o, x, y, known: typeof sx === 'number' });
  }
  return out.sort((a, b) => Number(a.online) - Number(b.online));
}

// Štatistiky plochy (pre panel Area)
export interface AreaStats {
  w: number; h: number; tiles: number; walkable: number; walkablePct: number; paths: number; trees: number; bushes: number;
  byType: Partial<Record<Ground, number>>; tilled: number; planted: number; ice: number; iceTop: number; holes: number; gates: GateGroup[];
}
export function areaStats(D: D, map: AreaMap): AreaStats {
  const n = map.tiles.length, by: Partial<Record<Ground, number>> = {};
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
export interface TileInfo {
  x: number; y: number; g: Ground; kind: Kind; height: number; level: number; walkable: boolean;
  giantAt?: { x: number; y: number }; gateTo?: AreaId; ice?: number | undefined; iceTop?: number | undefined; cut?: boolean;
  soil?: string; wet?: boolean; plant?: { sp: string; name: string; wild: boolean; stage: number; dead: boolean };
  deep?: boolean; boat?: boolean;
}
export function tileInfo(D: D, map: AreaMap, x: number, y: number): TileInfo | null {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return null;
  const t = map.tiles[y * map.w + x];
  if (!t) return null;
  const kind = kindOf(D, t.g);
  const info: TileInfo = { x, y, g: t.g, kind, height: heightBlocks(D, t), level: D.level(t), walkable: D.passable(t) };
  if (t.g === 'trunk') {
    for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && map.tiles[ny * map.w + nx]?.g === 'giant') { info.giantAt = { x: nx, y: ny }; break; }
    }
  }
  const gate = D.gateAt(map.area, x, y);
  if (gate) info.gateTo = gate.to;
  if (t.g === 'glacier') { info.ice = t.ice; info.iceTop = t.top; }
  if (t.cut) info.cut = true;
  if (map.deep.has(y * map.w + x)) info.deep = true; // hlboká voda – len z loďky (#160)
  if (map.boat && Math.floor(map.boat.x) === x && Math.floor(map.boat.y) === y) info.boat = true;
  if (t.s) {
    info.soil = t.s.k;
    info.wet = !!t.s.w;
    const p = t.s.p;
    if (p) {
      const sp = D.isSpeciesId(p.sp) ? D.SPECIES[p.sp] : null;
      info.plant = { sp: p.sp, name: p.wild && !sp ? 'wild plant' : sp ? sp.name : p.sp, wild: !!p.wild, stage: D.stageOf(p), dead: !!p.d };
    }
  }
  return info;
}
