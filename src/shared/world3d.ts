// 3D svet z kociek: mriežka podkociek (1 blok = 2×2×2 podkocky), terén, generované low-poly modely,
// poloha slnka a mäkké tiene. Zdieľa ho klient (3D vykresľovanie) aj server (neskôr: hodiny slnka pre rastliny).
import * as D from './data.ts';
import type { Ground } from './data.ts';
import { keys, lookup, must } from './util.ts';

// Materiál podkocky či minikocky (číslo z M; 0 = vzduch)
export type MatId = number;
// Model z minikociek: rozmery a materiál každej minikocky (data[(z * sy + y) * sx + x])
export interface FineModel { sx: number; sy: number; sz: number; data: Uint8Array }
// Materiál bodu modelu: číslo alebo podľa polohy (kresba, odtiene)
export type MatFn = (x: number, y: number, z: number, n: number) => MatId;
type Shade = MatId | ((x: number, y: number, z: number) => MatId);
// Plátno modelu s pôdorysom tw × td polí: minikocky, kváder, čiara, sneh na vrchu
export interface FineCanvas extends FineModel {
  W2: number; D2: number;
  put: (x: number, y: number, z: number, m: MatId) => void;
  getf: (x: number, y: number, z: number) => MatId;
  fbox: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Shade) => void;
  line: (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: MatId) => void;
  snow: (mats: readonly MatId[], minY?: number) => void;
  done: () => FineModel;
}
// Jemný model na mape: dáta, druh, poloha v blokoch (ox, oy, oz), políčko na výber a podiel plných minikociek pre náhradu
export interface FineInfo extends FineModel { type: string; kind?: string | number; ox: number; oy: number; oz: number; tile: { x: number; y: number }; invis?: number }
// Mriežka plochy: materiál podkociek, výška políčok; po buildGrid aj plocha, jemné modely a vlastník každej podkocky
export interface Grid {
  W: number; H: number; NX: number; NY: number; NZ: number; R: number; m: Uint8Array; heights: Uint8Array;
  area: string; fine: FineInfo[]; owner: Int16Array;
}
// Políčko, ako ho dáva volajúci: druh zeme
type GroundTile = { readonly g: Ground };
// Stav budov mimo políčok: úroveň izolácie ľadovne a krosná v Dielni
export interface BuildingState { ins?: number; loom?: boolean }
// Smer k slnku
export interface SunDir { x: number; y: number; z: number }
export const R = 2;                   // podkocky na blok
// rozmery mriežky záhrady; každá mriežka (plocha) má vlastné g.NX, g.NZ podľa veľkosti plochy
export const NX = D.W * R, NZ = D.H * R, NY = 12;

// ---- Materiály (id < 16 = terén, ich vrchná plocha nesie textúru zeme) ----
export const M = {
  AIR: 0, DIRT: 1, TOPSOIL: 2, PATH: 3, SAND: 4, STONE: 5, WATER: 6, SNOWFIELD: 7, SCREE: 8, ICE: 9, CLIFF: 10, ALP: 11,
  TRUNK: 16, LEAF: 17, LEAF2: 18, BLOSSOM: 19, SPRUCE: 20, SNOW: 21,
  PLANK: 22, PLANK_DARK: 23, THATCH: 24, ROOF_RED: 25, WALL_WHITE: 26, BAND_BLUE: 27, DOOR: 28,
  WINDOW: 29, AWN_RED: 30, AWN_WHITE: 31, COUNTER: 32, POT: 33, BREW: 34, DARKSTONE: 35,
  FL_RED: 36, FL_YELLOW: 37, FL_BLUE: 38, FL_PINK: 39,
  LOG: 40, LOG_DARK: 41, ORN: 42, SHINGLE: 43, SHINGLE_DARK: 44, RIDGE: 45, SHUTTER: 46, HANDLE: 47, LANTERN: 48,
  PLASTER: 49, STRAW: 50, STRAW_DARK: 51, CLAY: 52, LAVENDER: 53, CHAMOMILE: 54, FIRE: 55, FLAME: 56, WATER_DEEP: 57,
  ROPE: 58, SACK: 59, BREW_LIGHT: 60, HERB_GREEN: 61, SIGN: 62,
  // stromy z minikociek
  LEAF_SPRING: 64, LEAF_SPRING2: 65, LEAF_SUMMER: 66, LEAF_SUMMER2: 67, LEAF_AUT_OR: 68, LEAF_AUT_RED: 69, LEAF_AUT_YEL: 70,
  LEAF_BROWN: 71, LEAF_LIME: 72, BIRCH: 73, BIRCH_MARK: 74, BARK: 75, BARK_DARK: 76, PINE_BARK: 77, NEEDLE: 78, NEEDLE2: 79,
  APPLE: 80, BLOSSOM_W: 81, BLOSSOM_P: 82, MOSS: 83, LICHEN: 84, STONE_LIGHT: 85,
  LEAF_DARK: 86, LEAF_DARK2: 87, WOOD_END: 88, ROTWOOD: 89, SAP: 90, // Les divov: tmavé lístie obrov, čelo a práchnivé drevo kmeňa, svietiaca živica
  SILK: 91, SILK_DARK: 92, // hodvábne prikrývky (izolácia ľadovne, krosná v Dielni)
  INVIS: 63 // neviditeľná náhrada jemného modelu v hrubej mriežke (tieň, zatienenie, výber)
};
// Farby podľa ročného obdobia [jar, leto, jeseň, zima]; emis = svieti v noci
export const PALETTE: Readonly<Partial<Record<MatId, readonly string[]>>> = {
  [M.DIRT]: ['#7a5634'], [M.TOPSOIL]: ['#6f9a3c', '#5f8f34', '#8f8a3a', '#dfe7ea'], [M.PATH]: ['#b89a62', '#b89a62', '#b89a62', '#d8d4c6'],
  [M.SAND]: ['#d8c48a', '#d8c48a', '#d8c48a', '#e8e6dc'], [M.SNOWFIELD]: ['#e6eef3'], [M.SCREE]: ['#a8a39a', '#a8a39a', '#a8a39a', '#cfd4d7'],
  [M.ICE]: ['#9fd0ec'], [M.CLIFF]: ['#7d776f'], [M.ALP]: ['#7fae55', '#6f9f4a', '#9a9446', '#dfe7ea'], [M.STONE]: ['#9a958d', '#9a958d', '#9a958d', '#c9ccce'], [M.WATER]: ['#3d8fcf', '#3d8fcf', '#3d8fcf', '#a9d4ec'],
  [M.TRUNK]: ['#6d4c2f'], [M.LEAF]: ['#5cb34a', '#3f8f3a', '#d9822b', '#3f8f3a'], [M.LEAF2]: ['#4a9a3c', '#347a30', '#e6b42b', '#347a30'],
  [M.BLOSSOM]: ['#ffc8de', '#e53935', '#c4621e', '#ffffff'], [M.SPRUCE]: ['#2e6b3a', '#2a6235', '#2e6b3a', '#2f5d3a'], [M.SNOW]: ['#f4f7f9'],
  [M.PLANK]: ['#c9a77a'], [M.PLANK_DARK]: ['#8b6a45'], [M.THATCH]: ['#b5884a', '#b5884a', '#a8783e', '#f2f6f8'],
  [M.ROOF_RED]: ['#c0533a', '#c0533a', '#c0533a', '#f2f6f8'], [M.WALL_WHITE]: ['#f5efe0'], [M.BAND_BLUE]: ['#3a6ea5'], [M.DOOR]: ['#5a3d24'],
  [M.WINDOW]: ['#9fd3f0'], [M.AWN_RED]: ['#e53935'], [M.AWN_WHITE]: ['#ffffff'], [M.COUNTER]: ['#b07840'], [M.POT]: ['#2b2b33'],
  [M.BREW]: ['#7cfc9a'], [M.DARKSTONE]: ['#7d7872'],
  [M.FL_RED]: ['#e53935'], [M.FL_YELLOW]: ['#ffc107'], [M.FL_BLUE]: ['#3f6fd8'], [M.FL_PINK]: ['#ec5c8d'],
  [M.LOG]: ['#6b4528'], [M.LOG_DARK]: ['#3e2716'], [M.ORN]: ['#f3efe6'], [M.SHINGLE]: ['#7a6450'], [M.SHINGLE_DARK]: ['#5e4c3d'],
  [M.RIDGE]: ['#4a3b30'], [M.SHUTTER]: ['#2f6f8f'], [M.HANDLE]: ['#e0b040'], [M.LANTERN]: ['#ffe9a8'],
  [M.PLASTER]: ['#efe9dc'], [M.STRAW]: ['#c99a52'], [M.STRAW_DARK]: ['#9c7238'], [M.CLAY]: ['#b5652a'], [M.LAVENDER]: ['#8e7cc3'],
  [M.CHAMOMILE]: ['#f5f0d0'], [M.FIRE]: ['#ff7a1a'], [M.FLAME]: ['#ffd23a'], [M.WATER_DEEP]: ['#245a80', '#245a80', '#245a80', '#9cc7e0'],
  [M.ROPE]: ['#d8c08a'], [M.SACK]: ['#c9a46a'], [M.BREW_LIGHT]: ['#c9ffd9'], [M.HERB_GREEN]: ['#6b8f3a'], [M.SIGN]: ['#4a3324'],
  [M.LEAF_SPRING]: ['#7cc456'], [M.LEAF_SPRING2]: ['#62b04a'], [M.LEAF_SUMMER]: ['#3f8f3a'], [M.LEAF_SUMMER2]: ['#2f7a30'],
  [M.LEAF_AUT_OR]: ['#e07b24'], [M.LEAF_AUT_RED]: ['#c0392b'], [M.LEAF_AUT_YEL]: ['#e6c229'], [M.LEAF_BROWN]: ['#a0612a'], [M.LEAF_LIME]: ['#a7d65a'],
  [M.BIRCH]: ['#eeeae0'], [M.BIRCH_MARK]: ['#3a3a3a'], [M.BARK]: ['#5d4029'], [M.BARK_DARK]: ['#43301f'], [M.PINE_BARK]: ['#a0522d'],
  [M.NEEDLE]: ['#2e6b3a'], [M.NEEDLE2]: ['#24572f'], [M.APPLE]: ['#d62828'], [M.BLOSSOM_W]: ['#fbe7ef'], [M.BLOSSOM_P]: ['#f5a9c8'],
  [M.MOSS]: ['#6f9a3c', '#5f8a34', '#7d7a36', '#6f9a3c'], [M.LICHEN]: ['#c9c27a'], [M.STONE_LIGHT]: ['#b3aea6'],
  [M.LEAF_DARK]: ['#2f5a2c', '#24482a', '#7a4a22', '#24482a'], [M.LEAF_DARK2]: ['#26502a', '#1d3d23', '#5e3a1c', '#1d3d23'],
  [M.WOOD_END]: ['#a8865a'], [M.ROTWOOD]: ['#4a3826'], [M.SAP]: ['#ffcf3a'],
  [M.SILK]: ['#f3e9d2'], [M.SILK_DARK]: ['#c9b48e']
};
export const EMISSIVE: Readonly<Partial<Record<MatId, string>>> = { [M.WINDOW]: '#ffd27a', [M.BREW]: '#9dffb8', [M.LANTERN]: '#ffe9a8', [M.FIRE]: '#ff9a3a', [M.FLAME]: '#ffe07a', [M.BREW_LIGHT]: '#d8ffe4', [M.SAP]: '#ffd84a' };
export function colorOf(mat: MatId, season: number): string { const p = PALETTE[mat] || ['#ff00ff']; return (p[Math.min(season, p.length - 1)] || p[0]) ?? '#ff00ff'; }

export function hash(x: number, y: number, k?: number): number { let h = (x * 374761393 + y * 668265263 + (k || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

// Výška terénu v podkockách pre typ zeme (D.TERRAIN_H); ľad ľadovca nad zemou kreslí render3d (po 1/4 bloku)
export const groundHeight = D.terrainH;
// skalné steny majú rôznu výšku podľa políčka (zubaté hrebene)
function tileHeight(g: Ground, tx: number, ty: number): number { return g === 'cliff' ? 7 + Math.floor(hash(tx, ty, 5) * 4) : groundHeight(g); }
function topMaterial(g: Ground): MatId {
  if (g === 'water') return M.WATER;
  if (g === 'path' || g === 'gate' || g === 'lot' || g === 'majster') return M.PATH; // majster: udupané miesto majstra hodvábu pri trhu
  if (g === 'sand') return M.SAND;
  if (g === 'rock' || g === 'boulder') return M.STONE;
  if (g === 'snow') return M.SNOWFIELD;
  if (g === 'scree') return M.SCREE;
  if (g === 'glacier') return M.ICE;
  if (g === 'cliff') return M.CLIFF;
  if (g === 'alp' || g === 'spruce') return M.ALP;
  return M.TOPSOIL;
}
// materiál pod vrchnou vrstvou: skaly, sutina a dno ľadovca kameň (v stene striedavo tmavší a svetlejší)
function subMaterial(g: Ground, x: number, y: number, z: number): MatId {
  if (g === 'cliff') { const h = hash(x, y, z + 77); return h < 0.3 ? M.DARKSTONE : h < 0.45 ? M.STONE_LIGHT : M.STONE; }
  if (g === 'rock' || g === 'boulder' || g === 'scree' || g === 'snow') return M.STONE;
  return M.DIRT;
}

// Mriežka plochy w × h políčok: materiál na každú podkocku. x ∈ [0,NX), y ∈ [0,NY), z ∈ [0,NZ)
function makeGrid(w: number, h: number): Grid { const nx = w * R, nz = h * R; return { W: w, H: h, NX: nx, NY, NZ: nz, R, m: new Uint8Array(nx * NY * nz), heights: new Uint8Array(w * h), area: '', fine: [], owner: new Int16Array(0) }; }
const idx = (g: Pick<Grid, 'NX'>, x: number, y: number, z: number): number => (z * NY + y) * g.NX + x;
export function get(g: Pick<Grid, 'NX' | 'NZ' | 'm'>, x: number, y: number, z: number): MatId { return (x < 0 || y < 0 || z < 0 || x >= g.NX || y >= NY || z >= g.NZ) ? 0 : g.m[idx(g, x, y, z)] ?? 0; }
function set(g: Grid, x: number, y: number, z: number, v: MatId): void { if (x < 0 || y < 0 || z < 0 || x >= g.NX || y >= NY || z >= g.NZ) return; g.m[idx(g, x, y, z)] = v; }

// ---- Jemné modely z minikociek: 1 blok = FINE × FINE × FINE ----
export const FINE = 8;
export const FM = 4; // okraj modelu v minikockách (= pol bloku), aby sedel s hrubou mriežkou
// Domček v štýle Čičmian: zrub s bielymi ornamentmi, šindľová strecha, okná s okenicami a truhlíkmi.
// Súradnice fx, fy, fz sú v minikockách od rohu pôdorysu (3×2 polia = 24×16) a od vrchu zeme.
// Plátno z minikociek pre model s pôdorysom tw × td polí: pomocníci na kocku, kváder, čiaru a sneh.
function fineCanvas(tw: number, td: number, sy: number): FineCanvas {
  const W2 = tw * FINE, D2 = td * FINE, sx = W2 + 2 * FM, sz = D2 + 2 * FM;
  const data = new Uint8Array(sx * sy * sz);
  const at = (x: number, y: number, z: number): number => ((z + FM) * sy + y) * sx + (x + FM);
  const ok = (x: number, y: number, z: number): boolean => x >= -FM && x < W2 + FM && y >= 0 && y < sy && z >= -FM && z < D2 + FM;
  const put = (x: number, y: number, z: number, m: MatId): void => { if (ok(x, y, z)) data[at(x, y, z)] = m; };
  const getf = (x: number, y: number, z: number): MatId => ok(x, y, z) ? data[at(x, y, z)] ?? 0 : 0;
  const fbox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Shade): void => { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, z, typeof m === 'function' ? m(x, y, z) : m); };
  const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: MatId): void => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 1);
    for (let i = 0; i <= n; i++) put(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), Math.round(z0 + (z1 - z0) * i / n), m);
  };
  // v zime: najvyššia minikocka vybraných materiálov v každom stĺpci sa zmení na sneh
  const snow = (mats: readonly MatId[], minY?: number): void => {
    for (let z = -FM; z < D2 + FM; z++) for (let x = -FM; x < W2 + FM; x++) for (let y = sy - 1; y >= (minY || 0); y--) {
      const m = getf(x, y, z);
      if (!m) continue;
      if (mats.includes(m)) put(x, y, z, M.SNOW);
      break;
    }
  };
  return { sx, sy, sz, data, W2, D2, put, getf, fbox, line, snow, done: () => ({ sx, sy, sz, data }) };
}

function cicmanyHouse(season: number): FineModel {
  const C = fineCanvas(3, 2, 36), { put, getf, fbox } = C;
  const outer = (x: number, z: number): boolean => x === 1 || x === 22 || z === 1 || z === 14;
  // sokel z kameňa
  fbox(0, 0, 0, 23, 2, 15, (x, y, z) => hash(x, y, z + 99) < 0.3 ? M.DARKSTONE : M.STONE);
  // zrubové steny: trámy po 3 minikockách, medzi nimi tmavá drážka
  fbox(1, 3, 1, 22, 18, 14, (x, y, z) => outer(x, z) && (y - 3) % 3 === 2 ? M.LOG_DARK : M.LOG);
  // na rohoch prečnievajú konce trámov (striedavo)
  for (let y = 3; y <= 18; y++) {
    if (((y - 3) / 3 | 0) % 2 || (y - 3) % 3 === 2) continue;
    for (const [cx, cz, dx, dz] of [[1, 1, -1, -1], [22, 1, 1, -1], [1, 14, -1, 1], [22, 14, 1, 1]] as const) { put(cx + dx, y, cz, M.LOG); put(cx, y, cz + dz, M.LOG); }
  }
  // čičmanské ornamenty na vonkajšej vrstve stien
  const paint = (x: number, y: number, z: number): void => { if (getf(x, y, z) === M.LOG || getf(x, y, z) === M.LOG_DARK) put(x, y, z, M.ORN); };
  for (let y = 15; y <= 17; y++) for (let i = 1; i <= 22; i++) {
    const lattice = (i + y) % 4 === 0 || ((i - y) % 4 + 4) % 4 === 0;
    if (lattice) { paint(i, y, 14); paint(i, y, 1); }
    if (i <= 14 && lattice) { paint(1, y, i); paint(22, y, i); }
  }
  for (let y = 4; y <= 13; y += 2) for (const x of [2, 21, 8, 15]) paint(x, y, 14);
  for (const [cx, cy] of [[4.5, 5], [18.5, 5]] as const) for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) { paint(Math.floor(cx) + dx, cy + dy, 14); paint(Math.ceil(cx) + dx, cy + dy, 14); }
  // okno: zapustené sklo s priečkami, biely rám, okenice a truhlík s kvetmi
  function frontWindow(x0: number): void {
    fbox(x0, 8, 14, x0 + 3, 12, 14, 0);
    fbox(x0, 8, 13, x0 + 3, 12, 13, (x, y) => (x === x0 + 1 || y === 10) ? M.ORN : M.WINDOW);
    for (let y = 7; y <= 13; y++) for (let x = x0 - 1; x <= x0 + 4; x++) if (y === 7 || y === 13 || x === x0 - 1 || x === x0 + 4) put(x, y, 14, M.ORN);
    fbox(x0 - 3, 8, 15, x0 - 2, 12, 15, (x, y) => y === 10 ? M.LOG_DARK : M.SHUTTER);
    fbox(x0 + 5, 8, 15, x0 + 6, 12, 15, (x, y) => y === 10 ? M.LOG_DARK : M.SHUTTER);
    fbox(x0 - 1, 6, 15, x0 + 4, 7, 16, M.PLANK_DARK);
    for (let x = x0 - 1; x <= x0 + 4; x++) for (const z of [15, 16]) { const hv = hash(x, 8, z); put(x, 8, z, hv < 0.35 ? M.FL_RED : hv < 0.6 ? M.FL_PINK : M.LEAF); if (hv < 0.25) put(x, 9, z, M.FL_RED); }
  }
  frontWindow(3); frontWindow(17);
  // bočné okná
  for (const [xs, xg] of [[22, 21], [1, 2]] as const) {
    fbox(xs, 8, 6, xs, 12, 9, 0);
    fbox(xg, 8, 6, xg, 12, 9, (x, y, z) => (z === 7 || y === 10) ? M.ORN : M.WINDOW);
    for (let y = 7; y <= 13; y++) for (let z = 5; z <= 10; z++) if (y === 7 || y === 13 || z === 5 || z === 10) put(xs, y, z, M.ORN);
  }
  // dvere s rámom, kľučkou a schodíkom
  fbox(10, 3, 14, 13, 13, 14, 0);
  fbox(10, 3, 13, 13, 13, 13, (x) => x % 2 ? M.PLANK_DARK : M.DOOR);
  for (let y = 3; y <= 14; y++) for (let x = 9; x <= 14; x++) if (y === 14 || x === 9 || x === 14) put(x, y, 14, M.ORN);
  put(12, 8, 14, M.HANDLE);
  fbox(9, 0, 16, 14, 2, 17, M.STONE);
  // lampáš pri dverách
  put(16, 11, 15, M.LANTERN); put(16, 12, 15, M.LOG_DARK); put(16, 12, 14, M.LOG_DARK);
  // strecha: sedlová so šindľami, presah 3 na bokoch a 2 vpredu/vzadu, zapustený štít
  for (let k = 0; k < 10; k++) {
    const y = 19 + k, za = -2 + k, zb = 17 - k;
    for (let z = za; z <= zb; z++) for (let x = -3; x <= 26; x++) {
      const shell = z <= za + 1 || z >= zb - 1 || k === 9;
      const end = x <= -2 || x >= 25;
      if (shell) put(x, y, z, k === 9 ? M.RIDGE : end ? M.PLANK_DARK : ((x + (k % 2) * 2) % 4 < 2 ? M.SHINGLE : M.SHINGLE_DARK));
      else if (x >= 1 && x <= 22 && z >= 1 && z <= 14) put(x, y, z, x === 1 || x === 22 ? M.PLANK : M.LOG);
    }
  }
  // ornament a okrúhle okienko v štíte
  for (const xs of [1, 22]) {
    for (let y = 20; y <= 26; y++) for (let z = 3; z <= 12; z++) if (getf(xs, y, z) === M.PLANK && ((y + z) % 3 === 0)) put(xs, y, z, M.ORN);
    for (const [dz, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [2, 0], [0, -1], [1, -1], [0, 2], [1, 2]] as const) put(xs, 23 + dy, 7 + dz, Math.abs(dz - 0.5) + Math.abs(dy - 0.5) < 1.5 ? M.WINDOW : M.ORN);
  }
  // komín
  fbox(16, 19, 4, 18, 31, 6, (x, y, z) => y === 31 ? M.DARKSTONE : hash(x, y, z) < 0.4 ? M.DARKSTONE : M.STONE);
  // v zime sneh na všetkom, čo je navrchu strechy
  if (season === 3) C.snow([M.SHINGLE, M.SHINGLE_DARK, M.RIDGE, M.PLANK_DARK], 19);
  return C.done();
}

const stoneVar = (x: number, y: number, z: number): MatId => hash(x, y, z + 99) < 0.3 ? M.DARKSTONE : M.STONE;
const strawVar = (x: number, y: number, z: number): MatId => { const h = hash(x, y, z + 7); return (y % 2 === 0 && h < 0.7) || h < 0.2 ? M.STRAW_DARK : M.STRAW; };

// Babkina chalupa: vybielená drevenica s modrým soklom, doškovo-slamená valbová strecha,
// malé okná s muškátmi, dvere s pántami, komín, zväzky sušených bylín pod odkvapom a lavička.
function babkaHut(season: number): FineModel {
  const C = fineCanvas(3, 2, 34), { put, fbox } = C;
  fbox(0, 0, 0, 23, 1, 15, stoneVar);                                   // kamenný základ
  const outer = (x: number, z: number): boolean => x === 1 || x === 22 || z === 1 || z === 14;
  fbox(1, 2, 1, 22, 16, 14, (x, y, z) => outer(x, z) && y <= 3 ? M.BAND_BLUE : M.PLASTER); // biele steny, modrý sokel
  for (const x of [1, 22]) for (const z of [1, 14]) fbox(x, 2, z, x, 16, z, M.LOG_DARK);   // nárožné trámy
  for (let x = 1; x <= 22; x++) { put(x, 16, 1, M.LOG_DARK); put(x, 16, 14, M.LOG_DARK); }  // väznica pod strechou
  for (let z = 1; z <= 14; z++) { put(1, 16, z, M.LOG_DARK); put(22, 16, z, M.LOG_DARK); }
  // predné okná: zapustené sklo, tmavý rám a priečky, kvetináč s muškátom na parapete
  for (const x0 of [3, 18]) {
    fbox(x0, 7, 14, x0 + 2, 10, 14, 0);
    fbox(x0, 7, 13, x0 + 2, 10, 13, (x, y) => (x === x0 + 1 || y === 9) ? M.PLANK_DARK : M.WINDOW);
    for (let y = 6; y <= 11; y++) for (let x = x0 - 1; x <= x0 + 3; x++) if (y === 6 || y === 11 || x === x0 - 1 || x === x0 + 3) put(x, y, 14, M.PLANK_DARK);
    for (const px of [x0, x0 + 2]) { put(px, 7, 15, M.CLAY); put(px, 8, 15, M.HERB_GREEN); put(px, 9, 15, M.FL_RED); }
  }
  // bočné okná
  for (const [xs, xg] of [[22, 21], [1, 2]] as const) {
    fbox(xs, 7, 6, xs, 10, 8, 0);
    fbox(xg, 7, 6, xg, 10, 8, (x, y, z) => (z === 7 || y === 9) ? M.PLANK_DARK : M.WINDOW);
    for (let y = 6; y <= 11; y++) for (let z = 5; z <= 9; z++) if (y === 6 || y === 11 || z === 5 || z === 9) put(xs, y, z, M.PLANK_DARK);
  }
  // dvere s pántami a prahom
  fbox(10, 2, 14, 13, 12, 14, 0);
  fbox(10, 2, 13, 13, 12, 13, (x) => x === 11 ? M.PLANK_DARK : M.PLANK);
  for (const y of [4, 10]) { put(10, y, 14, M.DARKSTONE); put(11, y, 14, M.DARKSTONE); }
  put(13, 7, 14, M.HANDLE);
  for (let y = 2; y <= 13; y++) for (let x = 9; x <= 14; x++) if (y === 13 || x === 9 || x === 14) put(x, y, 14, M.LOG_DARK);
  fbox(9, 0, 16, 14, 1, 17, stoneVar);
  // valbová strecha zo slamy: sklon 1:1 na všetky strany, hrubý presah
  for (let k = 0; k < 12; k++) {
    const x0 = -3 + k, x1 = 26 - k, z0 = -3 + k, z1 = 18 - k;
    if (z0 > z1) break;
    fbox(x0, 17 + k, z0, x1, 17 + k, z1, (x, y, z) => (z0 === z1 || z0 + 1 === z1) ? M.STRAW_DARK : strawVar(x, y, z));
  }
  // komín
  fbox(17, 17, 5, 19, 30, 7, (x, y) => y >= 29 ? M.DARKSTONE : M.PLASTER);
  // zväzky sušených bylín pod odkvapom
  const herbs = [M.LAVENDER, M.CHAMOMILE, M.FL_RED, M.HERB_GREEN];
  let hi = 0;
  for (const x of [2, 5, 7, 16, 19, 21]) {
    const col = must(herbs[hi++ % herbs.length]);
    put(x, 16, 16, M.ROPE);
    fbox(x, 13, 16, x, 15, 16, col);
    if (col === M.CHAMOMILE) put(x, 14, 16, M.FL_YELLOW);
  }
  // lavička pri dverách
  fbox(15, 0, 16, 15, 1, 16, M.PLANK_DARK); fbox(19, 0, 16, 19, 1, 16, M.PLANK_DARK);
  fbox(15, 2, 16, 19, 2, 17, M.PLANK);
  if (season === 3) C.snow([M.STRAW, M.STRAW_DARK, M.DARKSTONE], 17);
  return C.done();
}

// Čarovný kotlík: liatinový hrniec na trojnožke s reťazou nad ohniskom, svietiaci elixír s bublinkami, varecha.
function cauldronModel(season: number): FineModel {
  const C = fineCanvas(1, 1, 20), { put, line } = C;
  const cx = 3.5, cz = 3.5;
  // ohnisko: kruh kameňov, polená, žeravé uhlíky a plamene
  for (let z = -1; z <= 8; z++) for (let x = -1; x <= 8; x++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d > 3.4 && d < 4.6) put(x, 0, z, stoneVar(x, 0, z));
  }
  line(1, 0, 1, 6, 1, 6, M.LOG); line(6, 0, 1, 1, 1, 6, M.LOG);
  for (const [x, z] of [[3, 3], [4, 4], [3, 4], [4, 3], [2, 4], [5, 3]] as const) { put(x, 1, z, M.FIRE); if (hash(x, 2, z) < 0.6) put(x, 2, z, M.FLAME); }
  // okrúhly hrniec
  for (let y = 3; y <= 9; y++) for (let z = 0; z <= 7; z++) for (let x = 0; x <= 7; x++) {
    const d = Math.hypot(x - cx, (y - 6.2) * 1.05, z - cz);
    if (d <= 3.6) put(x, y, z, M.POT);
  }
  // elixír navrchu a bublinky
  for (let z = 0; z <= 7; z++) for (let x = 0; x <= 7; x++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d < 2.3) put(x, 9, z, M.BREW);
    else if (d < 3.3) put(x, 10, z, M.POT); // okraj
  }
  put(3, 10, 3, M.BREW_LIGHT); put(5, 10, 4, M.BREW_LIGHT); put(2, 11, 4, M.BREW_LIGHT);
  // trojnožka a reťaz
  const top = [3.5, 18, 3.5] as const;
  for (const [x, z] of [[-2, -1], [9, 1], [3, 9]] as const) line(x, 0, z, top[0], top[1], top[2], M.LOG_DARK);
  for (let y = 12; y <= 17; y++) put(3, y, 3, y % 2 ? M.DARKSTONE : M.STONE);
  // varecha opretá o okraj
  line(6, 10, 2, 9, 15, -1, M.PLANK);
  if (season === 3) C.snow([M.LOG_DARK], 0);
  return C.done();
}

// Trh: pult z dosiek s debničkami kvetov, vrecia so semienkami, šikmá pásikavá markíza so zúbkami,
// tabuľa s nápisom TRH z minikociek a lampáš.
const FONT: Readonly<Record<'T' | 'R' | 'H', readonly string[]>> = { T: ['111', '010', '010', '010', '010'], R: ['110', '101', '110', '101', '101'], H: ['101', '101', '111', '101', '101'] };
function marketStall(season: number): FineModel {
  const C = fineCanvas(3, 1, 30), { put, fbox } = C;
  // stĺpiky
  for (const x of [1, 21]) for (const z of [0, 6]) fbox(x, 0, z, x + 1, 16, z + 1, M.LOG_DARK);
  // zadná polica a predný pult
  fbox(2, 0, 0, 21, 9, 1, M.PLANK_DARK);
  fbox(2, 0, 4, 21, 6, 7, (x, y, z) => z === 7 && y < 6 ? ((x % 3) ? M.PLANK : M.PLANK_DARK) : M.COUNTER);
  // debničky s kvetmi na pulte
  const fl = [M.FL_RED, M.FL_YELLOW, M.FL_BLUE, M.FL_PINK, M.LAVENDER, M.CHAMOMILE];
  for (let i = 0; i < 5; i++) {
    const x0 = 3 + i * 4;
    fbox(x0, 7, 4, x0 + 2, 8, 6, M.PLANK_DARK);
    for (let x = x0; x <= x0 + 2; x++) for (let z = 4; z <= 6; z++) { const hv = hash(x, i, z); put(x, 9, z, hv < 0.65 ? must(fl[i]) : M.HERB_GREEN); if (hv < 0.3) put(x, 10, z, must(fl[i])); }
  }
  // kvety a črepníky na zadnej polici
  for (let x = 3; x <= 20; x += 3) { put(x, 10, 0, M.CLAY); put(x, 11, 0, must(fl[(x / 3) % fl.length | 0])); }
  // vrecia so semienkami pri stánku
  for (const [x, z] of [[-3, 5], [-2, 2], [24, 5]] as const) { fbox(x, 0, z, x + 1, 2, z + 1, M.SACK); put(x, 3, z, M.ROPE); }
  // šikmá markíza: vzadu vyššie, vpredu nižšie, pásy po 3 minikockách, zúbkovaný okraj
  for (let z = -3; z <= 10; z++) {
    const y = 21 - Math.floor((z + 3) / 2);
    for (let x = 0; x <= 23; x++) put(x, y, z, Math.floor(x / 3) % 2 ? M.AWN_WHITE : M.AWN_RED);
  }
  for (let x = 0; x <= 23; x++) if (x % 3 !== 2) put(x, 21 - Math.floor(13 / 2) - 1, 10, Math.floor(x / 3) % 2 ? M.AWN_WHITE : M.AWN_RED);
  // tabuľa s nápisom TRH nad markízou
  fbox(6, 21, -3, 17, 28, -3, M.SIGN);
  fbox(7, 20, -3, 7, 21, -3, M.LOG_DARK); fbox(16, 20, -3, 16, 21, -3, M.LOG_DARK);
  // písmená na prednej (južnej) strane tabule – tú vidno z predvoleného pohľadu
  (['T', 'R', 'H'] as const).forEach((ch, i) => { FONT[ch].forEach((row, ry) => { row.split('').forEach((bit, rx) => { if (bit === '1') put(7 + i * 4 + rx, 27 - ry, -2, M.ORN); }); }); });
  // lampáš na prednom stĺpiku
  put(23, 12, 7, M.LANTERN); put(23, 13, 7, M.LOG_DARK); put(22, 13, 7, M.LOG_DARK);
  if (season === 3) C.snow([M.AWN_RED, M.AWN_WHITE, M.SIGN], 15);
  return C.done();
}

// Studňa: okrúhla kamenná obruba s vodou, rumpál s kľukou, lano s vedrom a šindľová strieška.
function wellModel(season: number): FineModel {
  const C = fineCanvas(1, 1, 20), { put, fbox } = C;
  const cx = 3.5, cz = 3.5;
  for (let y = 0; y <= 5; y++) for (let z = -1; z <= 8; z++) for (let x = -1; x <= 8; x++) {
    const d = Math.hypot(x - cx, z - cz);
    if (d <= 4.4 && d >= 2.4) put(x, y, z, y === 5 ? M.STONE : stoneVar(x, y, z));
    else if (d < 2.4 && y <= 2) put(x, y, z, y === 2 ? M.WATER_DEEP : M.DARKSTONE);
  }
  // stĺpy a hriadeľ rumpálu
  fbox(-1, 6, 3, -1, 13, 4, M.LOG_DARK); fbox(8, 6, 3, 8, 13, 4, M.LOG_DARK);
  fbox(0, 11, 3, 7, 11, 4, M.LOG);
  fbox(1, 11, 3, 6, 11, 3, (x) => x % 2 ? M.ROPE : M.LOG); // navinuté lano
  // kľuka
  put(9, 11, 3, M.HANDLE); put(10, 11, 3, M.HANDLE); put(10, 10, 3, M.HANDLE); put(10, 9, 3, M.HANDLE);
  // lano s vedrom nad vodou
  for (let y = 7; y <= 10; y++) put(4, y, 4, M.ROPE);
  fbox(3, 5, 3, 5, 6, 5, (x, y, z) => (x === 4 && z === 4 && y === 6) ? 0 : y === 6 ? M.DARKSTONE : M.PLANK_DARK);
  // sedlová strieška
  for (let k = 0; k < 5; k++) fbox(-2, 14 + k, -1 + k, 9, 14 + k, 8 - k, (x, y, z) => k === 4 ? M.RIDGE : (z === -1 + k || z === 8 - k) ? ((x % 2) ? M.SHINGLE : M.SHINGLE_DARK) : M.PLANK_DARK);
  if (season === 3) C.snow([M.SHINGLE, M.SHINGLE_DARK, M.RIDGE, M.PLANK_DARK], 14);
  return C.done();
}

// ---- Stromy z minikociek: 6 druhov, farby podľa obdobia, v zime holé konáre so snehom ----
const L = M;
const LEAVES: Readonly<Record<'buk' | 'dub' | 'breza' | 'jablon', readonly (readonly MatId[])[]>> = { // [jar, leto, jeseň]
  buk: [[L.LEAF_SPRING, L.LEAF_SPRING2], [L.LEAF_SUMMER, L.LEAF_SUMMER2], [L.LEAF_AUT_OR, L.LEAF_AUT_RED, L.LEAF_AUT_YEL]],
  dub: [[L.LEAF_SPRING2, L.LEAF_SUMMER], [L.LEAF_SUMMER2, L.LEAF_SUMMER], [L.LEAF_BROWN, L.LEAF_AUT_OR]],
  breza: [[L.LEAF_LIME, L.LEAF_SPRING], [L.LEAF_SPRING, L.LEAF_SUMMER], [L.LEAF_AUT_YEL, L.LEAF_AUT_YEL, L.LEAF_LIME]],
  jablon: [[L.BLOSSOM_W, L.BLOSSOM_P, L.BLOSSOM_W, L.LEAF_SPRING], [L.LEAF_SUMMER, L.LEAF_SUMMER2], [L.LEAF_AUT_YEL, L.LEAF_SUMMER, L.LEAF_LIME]]
};
// Elipsoid s nerovným okrajom (a voliteľnými dierami) – základ korún
function blob(C: FineCanvas, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, mat: MatFn, holes: number, seed: number, rough?: number): void {
  const rg = rough == null ? 0.45 : rough; // nerovnosť okraja (koruny hrubšie, kamene hladšie)
  for (let z = Math.floor(cz - rz - 1); z <= Math.ceil(cz + rz + 1); z++) for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
    const n = hash(x, y, z + (seed || 0));
    const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 + ((z + 0.5 - cz) / rz) ** 2;
    if (d <= 1 + (n - 0.5) * rg && !(holes && n < holes && d > 0.45)) { if (!C.getf(x, y, z)) C.put(x, y, z, mat(x, y, z, n)); }
  }
}
const pickOf = (list: readonly MatId[]): MatFn => (x, y, z) => list[Math.floor(hash(x, y, z + 3) * list.length)] ?? 0;
// sneh na vrchu konárov / ihličia (každá vrstva, nielen najvyššia)
function snowOn(C: FineCanvas, mats: readonly MatId[], prob: number, minY?: number): void {
  for (let z = -FM; z < C.D2 + FM; z++) for (let y = C.sy - 2; y >= (minY || 0); y--) for (let x = -FM; x < C.W2 + FM; x++) {
    if (mats.includes(C.getf(x, y, z)) && !C.getf(x, y + 1, z) && hash(x, y, z + 5) < prob) C.put(x, y + 1, z, M.SNOW);
  }
}
const CX = 3.5, CZ = 3.5; // stred políčka v minikockách
function roots(C: FineCanvas, mat: MatId): void { for (const [x, z] of [[2, 3], [2, 4], [5, 3], [5, 4], [3, 2], [4, 2], [3, 5], [4, 5]] as const) C.put(x, 0, z, mat); }
function branches(C: FineCanvas, y0: number, count: number, radius: number, yEnd: number, mat: MatId, seed: number): [number, number, number][] {
  const ends: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + hash(i, seed, 1) * 0.8;
    const e: [number, number, number] = [CX + Math.cos(a) * radius, yEnd + (i % 2) * 2, CZ + Math.sin(a) * radius];
    C.line(Math.round(CX), y0, Math.round(CZ), Math.round(e[0]), e[1], Math.round(e[2]), mat);
    ends.push(e);
  }
  return ends;
}
// Parametre stromov: každé číslo tvaru má meno, predvolenú hodnotu a rozsah (pre editor generátorov v /debug, #64).
// S predvolenými hodnotami vyjde strom presne taký ako predtým (test/trees.test.js to stráži).
interface Range { def: number; min: number; max: number; step: number }
const P = (def: number, min: number, max: number, step: number): Range => ({ def, min, max, step });
const COMMON = { seed: P(0, 0, 999, 1) }; // posun semienka všetkých náhodných častí
// každý druh má navyše seed (spoločný posun semienka) – ako prvý parameter
const withSeed = <T extends Readonly<Record<string, Range>>>(t: T): typeof COMMON & T => Object.assign({}, COMMON, t);
export const TREE_PARAMS = {
  buk: withSeed({ trunkH: P(14, 4, 30, 1), branchY: P(10, 2, 30, 1), branches: P(5, 0, 12, 1), branchR: P(4.5, 1, 8, 0.1), branchTop: P(17, 4, 36, 1),
    leaderTop: P(23, 4, 40, 1), crownY: P(21, 6, 38, 0.5), crownR: P(6.5, 1, 9, 0.1), crownH: P(5.5, 1, 9, 0.1), clumpLift: P(2, 0, 6, 0.5),
    clumpR: P(3.4, 0, 6, 0.1), clumpH: P(3, 0, 6, 0.1), holes: P(0.05, 0, 0.6, 0.01), clumpHoles: P(0.08, 0, 0.6, 0.01), rough: P(0.45, 0, 1.5, 0.05), snow: P(0.6, 0, 1, 0.05) }),
  dub: withSeed({ trunkH: P(11, 4, 30, 1), flareH: P(2, 0, 6, 1), branchY: P(8, 2, 30, 1), branches: P(6, 0, 12, 1), branchR: P(6.2, 1, 8, 0.1), branchTop: P(13, 4, 36, 1),
    crownY: P(17, 6, 38, 0.5), crownR: P(7.3, 1, 9, 0.1), crownH: P(4.2, 1, 9, 0.1), clumpLift: P(2.5, 0, 6, 0.5), clumpR: P(3.2, 0, 6, 0.1), clumpH: P(2.6, 0, 6, 0.1),
    holes: P(0.05, 0, 0.6, 0.01), clumpHoles: P(0.06, 0, 0.6, 0.01), rough: P(0.45, 0, 1.5, 0.05), snow: P(0.6, 0, 1, 0.05) }),
  breza: withSeed({ trunkH: P(26, 4, 40, 1), marks: P(0.22, 0, 1, 0.01), twigs: P(6, 0, 12, 1), twigY: P(13, 2, 36, 1), twigStep: P(2, 0, 5, 1), twigTurn: P(1.1, 0, 6.3, 0.1),
    twigLen: P(3, 0, 6, 1), twigRise: P(4, 0, 8, 1), clumps: P(6, 0, 12, 1), clumpY: P(15, 4, 38, 0.5), clumpStep: P(2.4, 0, 5, 0.1), clumpTurn: P(2.1, 0, 6.3, 0.1),
    clumpSpread: P(2.4, 0, 6, 0.1), clumpR: P(2.8, 0, 6, 0.1), clumpH: P(2.3, 0, 6, 0.1), holes: P(0.22, 0, 0.6, 0.01),
    topY: P(29, 4, 42, 0.5), topR: P(2.4, 0, 6, 0.1), topH: P(2.2, 0, 6, 0.1), topHoles: P(0.15, 0, 0.6, 0.01), rough: P(0.45, 0, 1.5, 0.05), snow: P(0.4, 0, 1, 0.05) }),
  jablon: withSeed({ trunkH: P(6, 2, 20, 1), branchY: P(5, 1, 20, 1), branches: P(4, 0, 12, 1), branchR: P(3.2, 1, 8, 0.1), branchTop: P(9, 2, 30, 1),
    crownY: P(11, 4, 36, 0.5), crownR: P(5.4, 1, 9, 0.1), crownH: P(4.3, 1, 9, 0.1), holes: P(0.05, 0, 0.6, 0.01), rough: P(0.45, 0, 1.5, 0.05),
    applesSummer: P(0.09, 0, 1, 0.01), applesAutumn: P(0.14, 0, 1, 0.01), snow: P(0.6, 0, 1, 0.05) }),
  smrek: withSeed({ trunkH: P(28, 4, 40, 1), base: P(4, 0, 20, 1), top: P(36, 8, 40, 1), spire: P(3, 0, 6, 1), baseR: P(7.2, 1, 9, 0.1), tipR: P(0.7, 0, 3, 0.1),
    minR: P(1.3, 0, 4, 0.1), tier: P(4, 1, 8, 1), droop: P(0.13, 0, 0.5, 0.01), rough: P(0.9, 0, 2, 0.05), dark: P(0.5, 0, 1, 0.05), snow: P(0.75, 0, 1, 0.05) }),
  borovica: withSeed({ trunkH: P(30, 4, 40, 1), crownY: P(31.5, 8, 40, 0.5), crownR: P(5.8, 1, 9, 0.1), crownH: P(2.8, 1, 6, 0.1), sides: P(1, 0, 2, 0.05),
    holes: P(0.08, 0, 0.6, 0.01), rough: P(0.45, 0, 1.5, 0.05), snow: P(0.8, 0, 1, 0.05) }),
  // obrovský strom Lesa divov (kmeň na 2 × 2 políčkach, giantBuild) – nie je medzi TREE_KINDS (nerastie v záhrade)
  obor: withSeed({ shape: P(0, 0, 2, 1), trunkR: P(4.4, 2, 7, 0.1), trunkH: P(36, 10, 40, 1), crook: P(0.7, 0, 2, 0.05), roots: P(5, 0, 10, 1),
    rootLen: P(9, 4, 12, 0.5), branches: P(3, 0, 8, 1), branchY: P(25, 10, 36, 1), branchR: P(7, 2, 10, 0.1), branchTop: P(35, 15, 40, 1),
    clumpR: P(3.6, 0, 6, 0.1), clumpH: P(2.4, 0, 6, 0.1), crownY: P(39, 20, 42, 0.5), crownR: P(5, 0, 8, 0.1), crownH: P(3, 0, 6, 0.1),
    holes: P(0.12, 0, 0.6, 0.01), moss: P(0.6, 0, 1, 0.05), lichen: P(0.1, 0, 0.5, 0.01), sap: P(0.012, 0, 0.06, 0.001), snow: P(0.55, 0, 1, 0.05) })
};
// Druhy stromov (aj obor Lesa divov), mená ich parametrov a hodnoty parametrov druhu
export type TreeKindAll = keyof typeof TREE_PARAMS;
export type TreeKind = Exclude<TreeKindAll, 'obor'>;
export type TreeParamsOf<K extends TreeKindAll> = Record<keyof (typeof TREE_PARAMS)[K], number>;
type TreeParamName = { [K in TreeKindAll]: keyof (typeof TREE_PARAMS)[K] }[TreeKindAll];
// prepísané parametre z editora generátorov: čísla alebo text z formulára
export type TreeOverrides = Readonly<Partial<Record<TreeParamName, unknown>>>;
// Predvolené parametre druhu stromu prepísané zadanými (orezané na rozsah a krok)
export function treeParams<K extends TreeKindAll>(kind: K, over?: TreeOverrides | null): TreeParamsOf<K> {
  const ranges: Readonly<Partial<Record<TreeParamName, Range>>> = TREE_PARAMS[kind];
  const out: Partial<Record<TreeParamName, number>> = {};
  for (const k of keys(ranges)) {
    const d = must(ranges[k]), o: unknown = over ? over[k] : undefined;
    const v = over && Number.isFinite(Number(o)) && o !== '' && o != null ? Number(o) : d.def;
    out[k] = Math.max(d.min, Math.min(d.max, d.step >= 1 ? Math.round(v) : v));
  }
  return out as TreeParamsOf<K>; // kľúče sú presne parametre druhu kind (prešli sme ich všetky)
}
type TreeBuild<K extends TreeKindAll> = (C: FineCanvas, se: number, p: TreeParamsOf<K>) => void;
const TREE_BUILD: { [K in TreeKind]: TreeBuild<K> } = {
  buk(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, M.BARK); roots(C, M.BARK);
    const ends = branches(C, p.branchY, p.branches, p.branchR, p.branchTop, M.BARK, 1 + p.seed);
    C.line(4, p.trunkH - 2, 4, 4, p.leaderTop, 3, M.BARK);
    if (se === 3) { snowOn(C, [M.BARK], p.snow, p.branchY); return; }
    const mat = pickOf(must(LEAVES.buk[se]));
    blob(C, CX, p.crownY, CZ, p.crownR, p.crownH, p.crownR, mat, p.holes, 1 + p.seed, p.rough);
    for (const e of ends) blob(C, e[0], e[1] + p.clumpLift, e[2], p.clumpR, p.clumpH, p.clumpR, mat, p.clumpHoles, 2 + p.seed, p.rough);
  },
  dub(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, M.BARK_DARK);
    if (p.flareH > 0) { C.fbox(2, 0, 3, 5, p.flareH, 4, M.BARK_DARK); C.fbox(3, 0, 2, 4, p.flareH, 5, M.BARK_DARK); }
    const ends = branches(C, p.branchY, p.branches, p.branchR, p.branchTop, M.BARK_DARK, 2 + p.seed);
    if (se === 3) { snowOn(C, [M.BARK_DARK], p.snow, p.branchY); return; }
    const mat = pickOf(must(LEAVES.dub[se]));
    blob(C, CX, p.crownY, CZ, p.crownR, p.crownH, p.crownR, mat, p.holes, 3 + p.seed, p.rough);
    for (const e of ends) blob(C, e[0], e[1] + p.clumpLift, e[2], p.clumpR, p.clumpH, p.clumpR, mat, p.clumpHoles, 4 + p.seed, p.rough);
  },
  breza(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, (x, y, z) => hash(x, y, z + 21 + p.seed) < p.marks ? M.BIRCH_MARK : M.BIRCH);
    // tenké vetvičky smerom hore
    for (let i = 0; i < p.twigs; i++) { const a = i * p.twigTurn, y = p.twigY + i * p.twigStep; C.line(Math.round(CX), y, Math.round(CZ), Math.round(CX + Math.cos(a) * p.twigLen), y + p.twigRise, Math.round(CZ + Math.sin(a) * p.twigLen), M.BARK_DARK); }
    if (se === 3) { snowOn(C, [M.BARK_DARK, M.BIRCH, M.BIRCH_MARK], p.snow, p.twigY - 1); return; }
    const mat = pickOf(must(LEAVES.breza[se]));
    for (let k = 0; k < p.clumps; k++) { const a = k * p.clumpTurn; blob(C, CX + Math.cos(a) * p.clumpSpread, p.clumpY + k * p.clumpStep, CZ + Math.sin(a) * p.clumpSpread, p.clumpR, p.clumpH, p.clumpR, mat, p.holes, 10 + k + p.seed, p.rough); }
    blob(C, CX, p.topY, CZ, p.topR, p.topH, p.topR, mat, p.topHoles, 17 + p.seed, p.rough);
  },
  jablon(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, M.BARK); roots(C, M.BARK);
    branches(C, p.branchY, p.branches, p.branchR, p.branchTop, M.BARK, 3 + p.seed);
    if (se === 3) { snowOn(C, [M.BARK], p.snow, p.trunkH); return; }
    blob(C, CX, p.crownY, CZ, p.crownR, p.crownH, p.crownR, pickOf(must(LEAVES.jablon[se])), p.holes, 5 + p.seed, p.rough);
    // v lete a na jeseň jablká na povrchu koruny (zboku aj zospodu)
    const apples = se === 1 ? p.applesSummer : p.applesAutumn;
    if (se >= 1) for (let z = -FM; z < C.D2 + FM; z++) for (let y = 0; y < C.sy; y++) for (let x = -FM; x < C.W2 + FM; x++) {
      const m = C.getf(x, y, z);
      if (!m || m === M.BARK || m === M.APPLE) continue;
      const exposed = !C.getf(x + 1, y, z) || !C.getf(x - 1, y, z) || !C.getf(x, y, z + 1) || !C.getf(x, y, z - 1) || !C.getf(x, y - 1, z);
      if (exposed && hash(x, y, z + 31 + p.seed) < apples) C.put(x, y, z, M.APPLE);
    }
  },
  smrek(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, M.BARK_DARK); // kmeň končí pod vrcholom, aby cez riedke ihličie nepresvital
    for (let y = p.base; y <= p.top; y++) {
      const t = (y - p.base) / Math.max(1, p.top - p.base), layer = (y - p.base) % p.tier;
      const r = Math.max(p.minR, (p.baseR * (1 - t) + p.tipR) * (1 - p.droop * layer)); // ovisnuté poschodia
      for (let z = -FM; z < 12; z++) for (let x = -FM; x < 12; x++) {
        const d = Math.hypot(x + 0.5 - CX, z + 0.5 - CZ), n = hash(x, y, z + 41 + p.seed);
        if (d <= r + (n - 0.5) * p.rough && C.getf(x, y, z) !== M.BARK_DARK) C.put(x, y, z, n < p.dark ? M.NEEDLE : M.NEEDLE2);
      }
    }
    if (p.spire > 0) C.fbox(3, p.top + 1, 3, 4, p.top + p.spire, 4, M.NEEDLE);
    if (se === 3) snowOn(C, [M.NEEDLE, M.NEEDLE2], p.snow, p.base);
  },
  borovica(C, se, p) {
    C.fbox(3, 0, 3, 4, p.trunkH, 4, M.PINE_BARK);
    for (const [y, dx, dz] of [[12, 1, 0], [17, 0, -1], [22, -1, 1]] as const) if (y < p.trunkH) C.line(Math.round(CX), y, Math.round(CZ), Math.round(CX + dx * 3), y + 1, Math.round(CZ + dz * 3), M.PINE_BARK);
    const mat: MatFn = (x, y, z, n) => n < 0.5 ? M.NEEDLE : M.NEEDLE2;
    blob(C, CX, p.crownY, CZ, p.crownR, p.crownH, p.crownR, mat, p.holes, 51 + p.seed, p.rough);
    // dva bočné chumáče trochu nižšie (sides = ich veľkosť voči pôvodnej)
    if (p.sides > 0) {
      blob(C, 1, p.crownY - 3, 6, 3.4 * p.sides, 2.2 * p.sides, 3.4 * p.sides, mat, p.holes, 52 + p.seed, p.rough);
      blob(C, 6.5, p.crownY - 2, 1.5, 3.2 * p.sides, 2.2 * p.sides, 3.2 * p.sides, mat, p.holes, 53 + p.seed, p.rough);
    }
    if (se === 3) snowOn(C, [M.NEEDLE, M.NEEDLE2], p.snow, p.crownY - 7.5);
  }
};
export const TREE_KINDS: TreeKind[] = keys(TREE_BUILD);
// Ľadovňa (2×2 polia = 16×16 minikociek): kamenná pivnica zapustená do zeme, strmá šindľová strecha až po zem,
// drevené dvere vpredu a nad nimi okienko s modrým svetlom ľadu. V zime sneh na streche.
// ins = úroveň izolácie (0–3): hodvábne prikrývky – 1 nad dverami, 2 aj prehodené cez spodok strechy, 3 prešitá cez celú strechu.
function icehouseModel(season: number, ins?: number): FineModel {
  const C = fineCanvas(2, 2, 26), { put, fbox } = C;
  fbox(1, 0, 2, 14, 5, 14, (x, y, z) => (x === 1 || x === 14 || z === 2 || z === 14) ? stoneVar(x, y, z) : M.DARKSTONE);
  // strecha: sedlová, hrebeň v smere z, schody po 1 minikocke, presah
  for (let k = 0; k <= 8; k++) {
    const y = 5 + k * 2;
    fbox(-1 + k, y, 0, 16 - k, y + 1, 16, (x, yy, z) => (x === -1 + k || x === 16 - k) ? (z % 2 ? M.SHINGLE : M.SHINGLE_DARK) : M.PLANK_DARK);
  }
  fbox(7, 21, 0, 8, 22, 16, M.RIDGE);
  // štít vpredu (z = 16) a vzadu: drevo
  for (let k = 0; k < 8; k++) fbox(k + 1, 6 + k * 2, 15, 14 - k, 7 + k * 2, 15, M.PLANK);
  // dvere a okienko
  fbox(5, 0, 15, 10, 8, 15, (x) => x === 5 || x === 10 ? M.PLANK_DARK : M.DOOR);
  put(9, 4, 16, M.HANDLE);
  fbox(6, 11, 16, 9, 12, 16, M.ICE);
  // kamenné schodíky dolu do pivnice
  fbox(5, 0, 16, 10, 0, 18, M.STONE_LIGHT);
  // izolácia: prešívané hodvábne prikrývky (svetlé pruhy s tmavším stehom)
  const quilt = (x: number, y: number, z: number): MatId => ((x + y + z) % 4 === 0 ? M.SILK_DARK : M.SILK);
  if ((ins ?? 0) >= 1) { fbox(3, 9, 16, 12, 10, 16, quilt); fbox(3, 8, 16, 3, 8, 16, M.SILK); fbox(12, 8, 16, 12, 8, 16, M.SILK); } // nad dverami, okraje visia
  const roofTo = (ins ?? 0) >= 3 ? 7 : (ins ?? 0) >= 2 ? 2 : -1; // po ktorý schod strechy siahajú prikrývky
  for (let k = 0; k <= roofTo; k++) {
    const y = 5 + k * 2 + 2;
    for (const x of [-1 + k, 16 - k]) fbox(x, y, 1, x, y, 15, (xx, yy, z) => quilt(xx, yy, z));
  }
  if ((ins ?? 0) >= 3) fbox(7, 22, 1, 8, 22, 15, M.SILK); // aj cez hrebeň
  if (season === 3) C.snow([M.SHINGLE, M.SHINGLE_DARK, M.RIDGE, M.PLANK_DARK, M.SILK, M.SILK_DARK], 5);
  return C.done();
}

// Dielňa (2×2 polia): zrub na kamennom sokli, otvorený predok so širokým vchodom, sedlová šindľová strecha
// s presahom nad vchodom a tabuľa s pílou. Vnútri pracovný stôl; loom = krosná s napnutými niťami a rolkou hodvábu.
// Pri stene kopa dreva a koza na rezanie. V zime sneh na streche.
function dielnaModel(season: number, loom?: number | boolean): FineModel {
  const C = fineCanvas(2, 2, 28), { put, fbox } = C;
  fbox(0, 0, 1, 15, 0, 14, stoneVar);                                                            // sokel
  // zrubové steny: zadná, bočné a predná s otvorom (x 4–11)
  const log = (x: number, y: number): MatId => (y % 3 === 2 ? M.LOG_DARK : M.LOG);
  fbox(1, 1, 2, 14, 12, 2, log); fbox(1, 1, 2, 1, 12, 13, log); fbox(14, 1, 2, 14, 12, 13, log);
  fbox(1, 1, 13, 3, 12, 13, log); fbox(12, 1, 13, 14, 12, 13, log); fbox(4, 11, 13, 11, 12, 13, M.LOG_DARK); // preklad nad vchodom
  fbox(1, 1, 3, 13, 1, 12, M.PLANK_DARK);                                                         // dlážka
  put(1, 7, 7, M.WINDOW); put(1, 7, 8, M.WINDOW); put(14, 7, 7, M.WINDOW); put(14, 7, 8, M.WINDOW); // okienka v bokoch
  // strecha: hrebeň v smere x, schody po 1 minikocke, vpredu presah nad vchod
  for (let k = 0; k <= 8; k++) {
    const y = 13 + k;
    fbox(-1, y, -1 + k, 16, y, 17 - k, (x, yy, z) => (z === -1 + k || z === 17 - k) ? (x % 2 ? M.SHINGLE : M.SHINGLE_DARK) : M.PLANK_DARK);
  }
  fbox(-1, 22, 7, 16, 22, 9, M.RIDGE);
  // tabuľa s pílou nad vchodom
  fbox(5, 14, 17, 10, 16, 17, M.SIGN);
  fbox(6, 15, 18, 9, 15, 18, M.STONE_LIGHT); put(10, 15, 18, M.PLANK); put(6, 14, 18, M.STONE_LIGHT); put(8, 14, 18, M.STONE_LIGHT);
  if (loom) {
    // krosná: dva stojany, horné a dolné brvno, napnuté nite a navinutý hodváb
    fbox(4, 2, 7, 4, 10, 7, M.PLANK_DARK); fbox(11, 2, 7, 11, 10, 7, M.PLANK_DARK);
    fbox(4, 10, 7, 11, 10, 7, M.LOG_DARK); fbox(4, 3, 8, 11, 3, 8, M.LOG_DARK);
    for (let x = 5; x <= 10; x++) fbox(x, 4, 7, x, 9, 7, x % 2 ? M.SILK : M.SILK_DARK);           // osnova
    fbox(5, 4, 7, 10, 5, 7, M.SILK);                                                                 // utkaný kúsok
    fbox(5, 2, 9, 10, 3, 9, M.SILK); put(4, 2, 9, M.PLANK_DARK); put(11, 2, 9, M.PLANK_DARK);        // rolka hotovej látky
    fbox(7, 2, 10, 8, 2, 11, M.PLANK);                                                               // lavička tkáča
  } else {
    fbox(4, 2, 5, 11, 5, 7, (x, y) => (y === 5 ? M.COUNTER : x === 4 || x === 11 ? M.PLANK_DARK : 0)); // pracovný stôl
    put(6, 6, 6, M.LOG); put(9, 6, 6, M.STONE_LIGHT);
  }
  // kopa dreva pri ľavej stene a koza na rezanie vpravo vpredu
  for (let z = 4; z <= 11; z++) for (let y = 0; y <= 3 - (z % 2); y++) put(-2, y, z, (y + z) % 3 ? M.LOG : M.WOOD_END);
  fbox(15, 0, 15, 15, 3, 15, M.PLANK_DARK); fbox(12, 0, 15, 12, 3, 15, M.PLANK_DARK); fbox(11, 4, 15, 16, 4, 15, M.LOG);
  if (season === 3) C.snow([M.SHINGLE, M.SHINGLE_DARK, M.RIDGE, M.PLANK_DARK, M.LOG, M.WOOD_END], 12);
  return C.done();
}

// Otočenie dát modelu o 90° okolo zvislej osi (pôdorys je štvorcový)
function rotate90(f: FineModel): FineModel {
  const { sx, sy, sz, data } = f, out = new Uint8Array(data.length);
  for (let j = 0; j < sz; j++) for (let y = 0; y < sy; y++) for (let i = 0; i < sx; i++) out[(j * sy + y) * sx + i] = data[((sx - 1 - i) * sy + y) * sx + j] ?? 0;
  return { sx, sy, sz, data: out };
}
const treeCache = new Map<string, FineModel>();
// over = vlastné parametre (editor generátorov): model sa vtedy postaví nanovo a neukladá sa do cache
// plátno a stavba podľa druhu: bežné stromy na 1 políčku, obor (Les divov) na 2 × 2
const treeCanvas = (kind: TreeKindAll): FineCanvas => kind === 'obor' ? fineCanvas(2, 2, GIANT_SY) : fineCanvas(1, 1, 44);
const ALL_BUILD: { [K in TreeKindAll]: TreeBuild<K> } = { ...TREE_BUILD, obor: (C, se, p) => { giantBuild(C, se, p); } };
const treeBuild = <K extends TreeKindAll>(kind: K, C: FineCanvas, se: number, p: TreeParamsOf<K>): void => { ALL_BUILD[kind](C, se, p); };
export function treeModel(kind: TreeKindAll, season: number, rot: number, over?: TreeOverrides | null): FineModel {
  if (over) {
    const C = treeCanvas(kind); treeBuild(kind, C, season, treeParams(kind, over));
    let f = C.done();
    for (let i = 0; i < rot; i++) f = rotate90(f);
    return f;
  }
  const key = kind + '|' + season + '|' + rot;
  const known = treeCache.get(key);
  if (known) return known;
  let f: FineModel;
  if (rot === 0) { const C = treeCanvas(kind); treeBuild(kind, C, season, treeParams(kind)); f = C.done(); }
  else f = rotate90(treeModel(kind, season, rot - 1));
  treeCache.set(key, f);
  return f;
}
// Ker (Les na pomedzí): nízka hustá guľa lístia na pár konárikoch, niektoré s bobuľami; v zime holé prútie so snehom
const BUSH_LEAVES = [[L.LEAF_SPRING, L.LEAF_SPRING2], [L.LEAF_SUMMER, L.LEAF_SUMMER2], [L.LEAF_AUT_RED, L.LEAF_AUT_OR, L.LEAF_BROWN]];
const bushCache = new Map<string, FineModel>();
function bushModel(season: number, rot: number, berries: boolean): FineModel {
  const key = season + '|' + rot + '|' + (berries ? 1 : 0);
  const known = bushCache.get(key);
  if (known) return known;
  let f: FineModel;
  if (rot === 0) {
    const C = fineCanvas(1, 1, 12);
    for (const [dx, dz] of [[-2, -1], [2, 1], [0, 2], [1, -2]] as const) C.line(Math.round(CX), 0, Math.round(CZ), Math.round(CX + dx), 4, Math.round(CZ + dz), M.BARK_DARK);
    if (season === 3) snowOn(C, [M.BARK_DARK], 0.7, 2);
    else {
      const mat = pickOf(must(BUSH_LEAVES[season]));
      blob(C, CX, 3.6, CZ, 4.6, 3.4, 4.6, mat, 0.04, 81);
      blob(C, CX + 1.5, 5.2, CZ - 1, 2.6, 2.2, 2.6, mat, 0.06, 82);
      if (berries && season >= 1) for (let z = -FM; z < 12; z++) for (let y = 1; y < 10; y++) for (let x = -FM; x < 12; x++) {
        const m = C.getf(x, y, z);
        if (!m || m === M.BARK_DARK) continue;
        const exposed = !C.getf(x + 1, y, z) || !C.getf(x - 1, y, z) || !C.getf(x, y, z + 1) || !C.getf(x, y, z - 1) || !C.getf(x, y + 1, z);
        if (exposed && hash(x, y, z + 83) < 0.07) C.put(x, y, z, season === 1 ? M.FL_BLUE : M.APPLE); // čučoriedky v lete, šípky na jeseň
      }
    }
    f = C.done();
  } else f = rotate90(bushModel(season, rot - 1, berries));
  bushCache.set(key, f);
  return f;
}
// ---- Les divov: obrovský strom (kmeň na 2 × 2 políčkach) a spadnutý kmeň ----
// Hrubý, mierne krivý kmeň s machom (hlavne na severnej strane a pri zemi) a lišajníkom, oporné korene do strán,
// hore pár hrubých konárov a nad nimi len malá tmavá koruna – v tme ju pohltí tma (render3d ju vôbec nekreslí),
// nesmie zakryť pohľad zhora na chodníky. 3 tvary (v), v zime holé konáre so snehom.
const GIANT_SY = 44, GIANT_KINDS = 3;
const GIANT_LEAVES = [[L.LEAF_DARK, L.LEAF_DARK2, L.LEAF_SUMMER2], [L.LEAF_DARK, L.LEAF_DARK2], [L.LEAF_DARK, L.LEAF_DARK2, L.LEAF_BROWN]];
// p = parametre (TREE_PARAMS.obor); shape = jeden z 3 tvarov, seed = posun náhodných častí
function giantBuild(C: FineCanvas, se: number, p: TreeParamsOf<'obor'>): void {
  const v = p.shape, k = v + 3 * p.seed, cx = 7.5, cz = 7.5, r0 = p.trunkR + v * 0.35;
  const bark = (x: number, y: number, z: number): MatId => {
    const h = hash(x, y, z + 91 + k);
    if ((z + 0.5 < cz - 2.5 && h < p.moss) || (y < 5 && h < p.moss * 0.67)) return se === 3 && y > 30 ? M.BARK_DARK : M.MOSS;
    return h < p.lichen ? M.LICHEN : h < 0.6 ? M.BARK_DARK : M.BARK;
  };
  for (let y = 0; y < p.trunkH; y++) {
    const r = r0 * (1 - y / 110) + (y < 5 ? (5 - y) * 0.5 : 0); // dolu sa kmeň rozširuje do koreňov
    const ox = Math.sin(y * 0.1 + k * 1.7) * p.crook, oz = Math.cos(y * 0.08 + k * 2.3) * p.crook * 6 / 7; // mierne krivý
    for (let z = -FM; z < 16 + FM; z++) for (let x = -FM; x < 16 + FM; x++) {
      const d = Math.hypot(x + 0.5 - cx - ox, z + 0.5 - cz - oz);
      if (d <= r + (hash(x, y, z + 93) - 0.5) * 0.7) C.put(x, y, z, bark(x, y, z));
    }
  }
  // oporné korene: od kmeňa šikmo dolu do strán
  const nr = p.roots + v;
  for (let i = 0; i < nr; i++) {
    const a = i / nr * Math.PI * 2 + hash(i, k, 95) * 0.7, len = p.rootLen + hash(i, k, 96) * 2.5;
    for (let t = 0; t <= 1; t += 0.06) {
      const rr = r0 - 0.5 + t * (len - r0), x = Math.round(cx + Math.cos(a) * rr - 0.5), z = Math.round(cz + Math.sin(a) * rr - 0.5);
      const top = Math.round(5 * (1 - t) * (1 - t));
      for (let y = 0; y <= top; y++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1]] as const) C.put(x + dx, y, z + dz, y === top && hash(x, y, z + 97) < 0.5 ? M.MOSS : M.BARK_DARK);
    }
  }
  // hrubé konáre (2 minikocky) a na ich koncoch tmavé chumáče lístia
  const ends: [number, number, number][] = [], nb = p.branches + v;
  for (let i = 0; i < nb; i++) {
    const a = i / nb * Math.PI * 2 + 0.6 + hash(i, k, 98) * 0.8, y0 = p.branchY + i * 2, R = p.branchR + hash(i, k, 99) * 2;
    const e: [number, number, number] = [cx + Math.cos(a) * R, p.branchTop + (i % 2) * 3, cz + Math.sin(a) * R];
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]] as const) C.line(Math.round(cx - 0.5) + dx, y0 + dy, Math.round(cz - 0.5), Math.round(e[0]) + dx, e[1] + dy, Math.round(e[2]), M.BARK_DARK);
    ends.push(e);
  }
  // svietiaca živica: sem-tam na povrchu kmeňa kvapka a pod ňou krátky stekajúci pramienok (svieti aj v tme, aj v zime)
  for (let z = -FM; z < 16 + FM; z++) for (let y = 4; y < 32; y++) for (let x = -FM; x < 16 + FM; x++) {
    const m = C.getf(x, y, z);
    if (!m || m === M.SAP || hash(x, y, z + 131 + k) > p.sap) continue;
    const out = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).find(([dx, dz]) => !C.getf(x + dx, y, z + dz));
    if (!out) continue;
    const len = 1 + Math.floor(hash(x, y, z + 133) * 3);
    for (let j = 0; j <= len; j++) if (C.getf(x, y - j, z)) C.put(x, y - j, z, M.SAP);
  }
  if (se === 3) { snowOn(C, [M.BARK_DARK, M.BARK, M.MOSS], p.snow, 6); return; }
  const mat = pickOf(must(GIANT_LEAVES[se]));
  for (const e of ends) blob(C, e[0], e[1] + 2, e[2], p.clumpR, p.clumpH, p.clumpR, mat, p.holes, 100 + k);
  blob(C, cx, p.crownY, cz, p.crownR, p.crownH, p.crownR, mat, p.holes * 5 / 6, 104 + k);
}
const giantCache = new Map<string, FineModel>();
function giantModel(season: number, rot: number, v: number): FineModel {
  const key = season + '|' + rot + '|' + v;
  const known = giantCache.get(key);
  if (known) return known;
  let f: FineModel;
  if (rot === 0) { const C = fineCanvas(2, 2, GIANT_SY); giantBuild(C, season, treeParams('obor', { shape: v })); f = C.done(); }
  else f = rotate90(giantModel(season, rot - 1, v));
  giantCache.set(key, f);
  return f;
}
// Spadnutý kmeň: leží naprieč políčkom (trochu presahuje), mach na vrchu, svetlé čelá, na niektorých huby
const logCache = new Map<string, FineModel>();
function logModel(season: number, rot: number, shrooms: boolean): FineModel {
  const key = season + '|' + rot + '|' + (shrooms ? 1 : 0);
  const known = logCache.get(key);
  if (known) return known;
  let f: FineModel;
  if (rot === 0) {
    const C = fineCanvas(1, 1, 10), cy = 2.6, cz = 3.5, r = 2.6;
    for (let x = -3; x <= 10; x++) for (let y = 0; y < 6; y++) for (let z = -FM; z < 12; z++) {
      const d = Math.hypot(y + 0.5 - cy, z + 0.5 - cz);
      if (d > r + (hash(x, y, z + 111) - 0.5) * 0.5) continue;
      const end = x === -3 || x === 10, top = y + 0.5 > cy + r * 0.45;
      C.put(x, y, z, end ? (d < r - 1 ? M.WOOD_END : M.BARK_DARK) : top && hash(x, y, z + 113) < 0.75 ? (season === 3 ? M.SNOW : M.MOSS) : hash(x, y, z + 115) < 0.25 ? M.ROTWOOD : M.BARK_DARK);
    }
    if (shrooms && season !== 3) for (const [x, z] of [[1, 1], [2, 1], [6, 6], [7, 1]] as const) { C.put(x, 4, z, M.ORN); C.put(x, 5, z, M.FL_RED); C.put(x + 1, 5, z, M.FL_RED); }
    f = C.done();
  } else f = rotate90(logModel(season, rot - 1, shrooms));
  logCache.set(key, f);
  return f;
}

// ---- Kamene z minikociek: 3 tvary, viac odtieňov kameňa, mach a lišajník, v zime sneh ----
const rockMat = (x: number, y: number, z: number): MatId => { const h = hash(x, y, z + 61); return h < 0.25 ? M.DARKSTONE : h < 0.45 ? M.STONE_LIGHT : M.STONE; };
function mossTop(C: FineCanvas, se: number): void {
  for (let z = -FM; z < C.D2 + FM; z++) for (let x = -FM; x < C.W2 + FM; x++) for (let y = C.sy - 1; y >= 0; y--) {
    const m = C.getf(x, y, z);
    if (!m) continue;
    const h = hash(x, y, z + 71);
    if (se === 3) { if (h < 0.5 && y >= 2) C.put(x, y + 1, z, M.SNOW); }
    else if (h < 0.3) C.put(x, y, z, M.MOSS); else if (h < 0.38) C.put(x, y, z, M.LICHEN);
    break;
  }
}
type RockKind = 'balvan' | 'kopa' | 'plocha';
const ROCK_BUILD: Readonly<Record<RockKind, (C: FineCanvas) => void>> = {
  balvan(C) {
    blob(C, 3.5, 2.6, 3.8, 3.9, 3.1, 3.4, rockMat, 0, 61, 0.18);
    blob(C, 6, 1.6, 1.4, 2.3, 1.8, 2.1, rockMat, 0, 62, 0.18);
  },
  kopa(C) {
    blob(C, 2.2, 1.8, 2.6, 2.6, 2.2, 2.3, rockMat, 0, 63, 0.18);
    blob(C, 5.6, 1.5, 4.6, 2.4, 1.8, 2.1, rockMat, 0, 64, 0.18);
    blob(C, 3.2, 1.1, 6.2, 1.8, 1.4, 1.6, rockMat, 0, 65, 0.18);
  },
  plocha(C) {
    blob(C, 3.6, 1.2, 3.6, 4.4, 1.5, 3.6, rockMat, 0, 66, 0.12);
    blob(C, 2.6, 3.1, 3.0, 1.9, 1.6, 1.8, rockMat, 0, 67, 0.15);
  }
};
const rockCache = new Map<string, FineModel>();
function rockModel(kind: RockKind, season: number, rot: number): FineModel {
  const key = kind + '|' + season + '|' + rot;
  const known = rockCache.get(key);
  if (known) return known;
  let f: FineModel;
  if (rot === 0) { const C = fineCanvas(1, 1, 12); ROCK_BUILD[kind](C); mossTop(C, season); f = C.done(); }
  else f = rotate90(rockModel(kind, season, rot - 1));
  rockCache.set(key, f);
  return f;
}

// Otočenie o 90° okolo zvislej osi pre ľubovoľný pôdorys (sx a sz sa vymenia); pri štvorci je to isté ako rotate90
export function rotateY(f: FineModel): FineModel {
  const { sx, sy, sz, data } = f, out = new Uint8Array(data.length);
  for (let j = 0; j < sx; j++) for (let y = 0; y < sy; y++) for (let i = 0; i < sz; i++) out[(j * sy + y) * sz + i] = data[((sz - 1 - i) * sy + y) * sx + j] ?? 0;
  return { sx: sz, sy, sz: sx, data: out };
}
// Zoznam všetkých jemných modelov pre prehliadač modelov v /debug (#79). Hra ho nepoužíva.
// build(season, rot) → { sx, sy, sz, data }; stromy, kry a kamene sa otáčajú ako v hre, budovy cez rotateY.
export const TREE_NAMES: Readonly<Record<TreeKindAll, string>> = { buk: 'Buk', dub: 'Dub', breza: 'Breza', jablon: 'Jabloň', smrek: 'Smrek', borovica: 'Borovica', obor: 'Obor (Les divov)' };
const ROCK_NAMES: Readonly<Record<RockKind, string>> = { balvan: 'Balvan', kopa: 'Kopa kameňov', plocha: 'Plochý kameň' };
const turned = (build: (season: number) => FineModel) => (season: number, rot?: number): FineModel => { let f = build(season); for (let i = 0; i < (rot || 0); i++) f = rotateY(f); return f; };
// Model v prehliadači /debug: id, meno, skupina, ako sa volá v kóde, pôdorys v poliach, druh a stavba (obdobie, otočenie)
export interface FineModelEntry { id: string; name: string; group: string; fn: string; tiles: [number, number]; kind?: string | number; build: (season: number, rot?: number) => FineModel }
export const FINE_MODELS: FineModelEntry[] = [
  { id: 'house', name: 'Čičmanský domček', group: 'Buildings', fn: 'cicmanyHouse', tiles: [3, 2], build: turned(cicmanyHouse) },
  { id: 'hut', name: 'Babkina chalupa', group: 'Buildings', fn: 'babkaHut', tiles: [3, 2], build: turned(babkaHut) },
  { id: 'icehouse', name: 'Ľadovňa', group: 'Buildings', fn: 'icehouseModel', tiles: [2, 2], build: turned(icehouseModel) },
  ...[1, 2, 3].map((l): FineModelEntry => ({ id: 'icehouse-' + l, name: `Ľadovňa, izolácia ${l}`, group: 'Buildings', fn: `icehouseModel(ins = ${l})`, tiles: [2, 2], build: turned(se => icehouseModel(se, l)) })),
  { id: 'dielna', name: 'Dielňa', group: 'Buildings', fn: 'dielnaModel', tiles: [2, 2], build: turned(se => dielnaModel(se, false)) },
  { id: 'dielna-loom', name: 'Dielňa s krosnami', group: 'Buildings', fn: 'dielnaModel(loom = true)', tiles: [2, 2], build: turned(se => dielnaModel(se, true)) },
  { id: 'stall', name: 'Trh', group: 'Objects', fn: 'marketStall', tiles: [3, 1], build: turned(marketStall) },
  { id: 'well', name: 'Studňa', group: 'Objects', fn: 'wellModel', tiles: [1, 1], build: turned(wellModel) },
  { id: 'cauldron', name: 'Čarovný kotlík', group: 'Objects', fn: 'cauldronModel', tiles: [1, 1], build: turned(cauldronModel) },
  ...TREE_KINDS.map((k): FineModelEntry => ({ id: 'tree-' + k, name: TREE_NAMES[k] || k, group: 'Trees', fn: `treeModel('${k}')`, tiles: [1, 1], kind: k, build: (se, rot) => treeModel(k, se, rot || 0) })),
  { id: 'bush', name: 'Ker', group: 'Bushes', fn: 'bushModel(berries = false)', tiles: [1, 1], build: (se, rot) => bushModel(se, rot || 0, false) },
  { id: 'bush-berries', name: 'Ker s bobuľami', group: 'Bushes', fn: 'bushModel(berries = true)', tiles: [1, 1], build: (se, rot) => bushModel(se, rot || 0, true) },
  ...keys(ROCK_BUILD).map((k): FineModelEntry => ({ id: 'rock-' + k, name: ROCK_NAMES[k] || k, group: 'Rocks', fn: `rockModel('${k}')`, tiles: [1, 1], kind: k, build: (se, rot) => rockModel(k, se, rot || 0) })),
  // Les divov: obrovské stromy (3 tvary, kmeň na 2 × 2 políčkach) a spadnuté kmene
  ...[0, 1, 2].map((v): FineModelEntry => ({ id: 'giant-' + v, name: `Obor, tvar ${v + 1}`, group: 'Les divov', fn: `giantModel(shape = ${v})`, tiles: [2, 2], kind: 'obor', build: (se, rot) => giantModel(se, rot || 0, v) })),
  { id: 'log', name: 'Spadnutý kmeň', group: 'Les divov', fn: 'logModel(shrooms = false)', tiles: [1, 1], build: (se, rot) => logModel(se, rot || 0, false) },
  { id: 'log-shrooms', name: 'Spadnutý kmeň s hubami', group: 'Les divov', fn: 'logModel(shrooms = true)', tiles: [1, 1], build: (se, rot) => logModel(se, rot || 0, true) }
];

// Ktorý druh stromu rastie na políčku (deterministicky); pri babkinej chalúpke je ovocný sad.
// V Lese na pomedzí ihličnanov smerom na sever pribúda (sever je tmavší a hustejší).
export function treeKind(tx: number, ty: number, area: string | undefined): TreeKind {
  if (area === 'les') { // Les divov: hlavne smreky a staré buky a duby, žiadne brezy
    const h = hash(tx, ty, 3);
    return h < 0.45 ? 'smrek' : h < 0.55 ? 'borovica' : h < 0.78 ? 'buk' : 'dub';
  }
  if (area === 'pomedzie') {
    const conifer = 0.2 + 0.55 * Math.max(0, Math.min(1, (D.MEADOW_Y - ty) / D.MEADOW_Y));
    if (hash(tx, ty, 3) < conifer) return hash(tx, ty, 11) < 0.75 ? 'smrek' : 'borovica';
  } else {
    if (tx >= 13 && ty <= 7) return 'jablon';
    if (hash(tx, ty, 3) > 0.55) return hash(tx, ty, 11) < 0.7 ? 'smrek' : 'borovica';
  }
  const h = hash(tx, ty, 12);
  return h < 0.34 ? 'buk' : h < 0.67 ? 'dub' : 'breza';
}

// Zoznam jemných modelov na mape (pozícia v blokoch, rozmery a minikocky)
// tile = políčko, ktoré sa vyberie po ťuknutí na model (napr. pri budove jej dvere)
interface FineType { g: Ground; build: (season: number, v: number) => FineModel; tile: [number, number]; v?: (o: BuildingState) => number }
const FINE_TYPES: FineType[] = [
  { g: 'house', build: cicmanyHouse, tile: [1, 1] },
  { g: 'hut', build: babkaHut, tile: [1, 1] },
  { g: 'stall', build: marketStall, tile: [1, 0] },
  { g: 'well', build: wellModel, tile: [0, 0] },
  { g: 'cauldron', build: cauldronModel, tile: [0, 0] },
  { g: 'icehouse', build: icehouseModel, tile: [0, 1], v: o => Number(o.ins) | 0 },  // úroveň izolácie
  { g: 'dielna', build: dielnaModel, tile: [0, 1], v: o => (o.loom ? 1 : 0) } // s krosnami / bez
];
// budovy závisia len od obdobia a stavu (v) – postavia sa raz (aj ich sieť v render3d sa tak počíta len raz)
const buildingCache = new Map<string, FineModel>();
function buildingModel(ft: FineType, season: number, v: number): FineModel {
  const key = ft.g + '|' + season + '|' + (v || 0);
  let m = buildingCache.get(key);
  if (!m) { m = ft.build(season, v || 0); buildingCache.set(key, m); }
  return m;
}
// state = stav budov, ktorý nie je v políčkach: { ins: úroveň izolácie ľadovne, loom: krosná v Dielni }
function fineModels(tiles: readonly GroundTile[], season: number, w: number, area: string, state: BuildingState | null | undefined): FineInfo[] {
  const out: FineInfo[] = [], st = state || {};
  for (const ft of FINE_TYPES) {
    const i = tiles.findIndex(t => t.g === ft.g);
    if (i < 0) continue;
    const tx = i % w, ty = (i / w) | 0;
    const m = buildingModel(ft, season, ft.v ? ft.v(st) : 0);
    out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: ft.g, ox: tx - FM / FINE, oy: groundHeight('grass') / R, oz: ty - FM / FINE, tile: { x: tx + ft.tile[0], y: ty + ft.tile[1] } });
  }
  for (let i = 0; i < tiles.length; i++) {
    const g = must(tiles[i]).g;
    if (g !== 'tree' && g !== 'spruce') continue;
    // v horách rastú len ihličnany
    const tx = i % w, ty = (i / w) | 0, kind = g === 'spruce' ? (hash(tx, ty, 11) < 0.75 ? 'smrek' : 'borovica') : treeKind(tx, ty, area);
    const m = treeModel(kind, season, Math.floor(hash(tx, ty, 13) * 4));
    // dáta modelu sú zdieľané medzi rovnakými stromami – vlastný je len obal s pozíciou
    out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: 'tree', kind, ox: tx - FM / FINE, oy: groundHeight(g) / R, oz: ty - FM / FINE, tile: { x: tx, y: ty }, invis: 0.25 });
  }
  const ROCK_KINDS = keys(ROCK_BUILD);
  let rockN = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (must(tiles[i]).g !== 'boulder') continue;
    const tx = i % w, ty = (i / w) | 0, kind = must(ROCK_KINDS[rockN++ % ROCK_KINDS.length]); // striedame tvary, nech je vidno všetky
    const m = rockModel(kind, season, Math.floor(hash(tx, ty, 15) * 4));
    out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: 'rock', kind, ox: tx - FM / FINE, oy: groundHeight('boulder') / R, oz: ty - FM / FINE, tile: { x: tx, y: ty } });
  }
  for (let i = 0; i < tiles.length; i++) {
    const g = must(tiles[i]).g;
    if (g !== 'giant' && g !== 'log') continue;
    const tx = i % w, ty = (i / w) | 0, rot = Math.floor(hash(tx, ty, 21) * 4);
    if (g === 'giant') {
      const kind = Math.floor(hash(tx, ty, 23) * GIANT_KINDS), m = giantModel(season, rot, kind);
      out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: 'giant', kind, ox: tx - FM / FINE, oy: groundHeight(g) / R, oz: ty - FM / FINE, tile: { x: tx, y: ty }, invis: 0.3 });
    } else {
      const m = logModel(season, rot, hash(tx, ty, 25) < 0.35);
      out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: 'log', ox: tx - FM / FINE, oy: groundHeight(g) / R, oz: ty - FM / FINE, tile: { x: tx, y: ty }, invis: 0.3 });
    }
  }
  for (let i = 0; i < tiles.length; i++) {
    if (must(tiles[i]).g !== 'bush') continue;
    const tx = i % w, ty = (i / w) | 0, m = bushModel(season, Math.floor(hash(tx, ty, 17) * 4), hash(tx, ty, 19) < 0.4);
    out.push({ sx: m.sx, sy: m.sy, sz: m.sz, data: m.data, type: 'bush', ox: tx - FM / FINE, oy: groundHeight('bush') / R, oz: ty - FM / FINE, tile: { x: tx, y: ty }, invis: 0.3 });
  }
  return out;
}
// Neviditeľná náhrada jemného modelu v hrubej mriežke: podkocka je plná, ak je aspoň ~40 % jej minikociek plných.
// g.owner: pre každú podkocku index jemného modelu, ktorému patrí jeho neviditeľná náhrada (-1 = žiadny)
function stampInvisible(g: Grid, fm: FineInfo, index: number): void {
  const k = FINE / R; // minikociek na podkocku
  const cx0 = Math.round(fm.ox * R), cy0 = Math.round(fm.oy * R), cz0 = Math.round(fm.oz * R);
  for (let cz = 0; cz < fm.sz / k; cz++) for (let cy = 0; cy < Math.ceil(fm.sy / k); cy++) for (let cx = 0; cx < fm.sx / k; cx++) {
    let n = 0;
    for (let z = 0; z < k; z++) for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
      const fy = cy * k + y;
      if (fy < fm.sy && fm.data[((cz * k + z) * fm.sy + fy) * fm.sx + cx * k + x]) n++;
    }
    const x = cx0 + cx, y = cy0 + cy, z = cz0 + cz;
    // vlastníka zapíšeme pre každú podkocku s aspoň jednou minikockou (aj riedke koruny), náhradu len pre plné
    if (n && x >= 0 && y >= 0 && z >= 0 && x < g.NX && y < NY && z < g.NZ) g.owner[idx(g, x, y, z)] = index;
    if (n >= k * k * k * (fm.invis || 0.4)) set(g, x, y, z, M.INVIS);
  }
}

// Celý svet z mapy (typy zeme) – deterministický, závisí len od mapy, ročného obdobia a plochy.
// w = šírka plochy v políčkach (výška = tiles.length / w), area = ktorá plocha (druhy stromov)
// state = stav budov mimo políčok (fineModels): { ins, loom }
export function buildGrid(tiles: readonly GroundTile[], season: number, w?: number, area?: string, state?: BuildingState | null): Grid {
  w = w || D.W;
  const h = tiles.length / w, g = makeGrid(w, h);
  g.area = area || 'garden';
  for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
    const gt = must(tiles[ty * w + tx]).g, th = tileHeight(gt, tx, ty);
    g.heights[ty * w + tx] = th;
    for (let y = 0; y < th; y++) for (let z = ty * R; z <= ty * R + 1; z++) for (let x = tx * R; x <= tx * R + 1; x++) set(g, x, y, z, y === th - 1 ? topMaterial(gt) : subMaterial(gt, x, y, z));
  }
  g.fine = fineModels(tiles, season, w, g.area, state);
  g.owner = new Int16Array(g.NX * NY * g.NZ).fill(-1);
  g.fine.forEach((fm, i) => { stampInvisible(g, fm, i); });
  return g;
}
// Výška povrchu políčka v blokoch (na tú postavíme rastliny a postavičky)
// Ktoré jemné modely pretína úsečka (pochod po 0,1 bloku cez hrubú mriežku) – rýchle hľadanie zakrývajúcich objektov
export function modelsOnRay(g: Grid, px: number, py: number, pz: number, dx: number, dy: number, dz: number, maxDist: number, out: Set<number>): Set<number> {
  for (let s = 0.15; s < maxDist; s += 0.1) {
    const x = Math.floor((px + dx * s) * R), y = Math.floor((py + dy * s) * R), z = Math.floor((pz + dz * s) * R);
    if (y >= NY) break;
    if (x < 0 || y < 0 || z < 0 || x >= g.NX || z >= g.NZ) continue;
    const o = g.owner[idx(g, x, y, z)] ?? -1;
    if (o >= 0) out.add(o);
  }
  return out;
}
// vrch políčka; voda má hladinu vyššie než svoje podkocky (dno je pod hladinou)
export function surfaceY(g: Pick<Grid, 'heights' | 'W'>, tx: number, ty: number): number { const h = g.heights[ty * g.W + tx] || 2; return h === groundHeight('water') ? WATER_Y : h / R; }

// ---- Slnko ----
const MAX_ELEV = [50, 62, 40, 22]; // najvyššia výška slnka v stupňoch podľa obdobia
// Smer k slnku (jednotkový vektor) alebo null v noci. Východ 5:00 na východe (+x), poludnie na juhu (+z), západ 21:00.
export function sunDir(minuteOfDay: number, season: number): SunDir | null {
  const t = (minuteOfDay - 300) / 960;
  if (t <= 0 || t >= 1) return null;
  const e = (MAX_ELEV[season] ?? NaN) * Math.PI / 180 * Math.sin(Math.PI * t);
  const ce = Math.cos(e);
  return { x: Math.cos(Math.PI * t) * ce, y: Math.sin(e), z: Math.sin(Math.PI * t) * ce };
}
// Intenzita denného svetla 0..1 (súmrak je plynulý)
export function daylight(minuteOfDay: number): number {
  const h = minuteOfDay / 60;
  if (h < 4 || h >= 22) return 0;
  if (h < 6) return (h - 4) / 2;
  if (h >= 20) return 1 - (h - 20) / 2;
  return 1;
}

// Je bod (vo svetových súradniciach blokov) osvetlený slnkom? Pochod lúča cez mriežku podkociek.
function rayFree(g: Grid, px: number, py: number, pz: number, d: SunDir, maxDist: number, start?: number): boolean {
  const step = 0.2;
  for (let s = start || 0.05; s < maxDist; s += step) {
    const x = Math.floor((px + d.x * s) * R), y = Math.floor((py + d.y * s) * R), z = Math.floor((pz + d.z * s) * R);
    if (y >= NY) return true;
    if (get(g, x, y, z)) return false;
  }
  return true;
}
// Mäkký tieň: priemer viacerých lúčov v malom kuželi okolo smeru slnka (0 = tieň, 1 = plné slnko)
const SOFT: readonly (readonly [number, number])[] = [[0, 0], [0.07, 0], [-0.07, 0], [0, 0.07], [0, -0.07], [0.05, 0.05], [-0.05, -0.05], [0.05, -0.05], [-0.05, 0.05]];
export function sunVisibility(g: Grid, px: number, py: number, pz: number, dir: SunDir | null, samples?: number, start?: number): number {
  if (!dir) return 0;
  const n = Math.min(samples || SOFT.length, SOFT.length);
  // dve kolmice na smer slnka
  const ux = -dir.z, uz = dir.x, ul = Math.hypot(ux, uz) || 1;
  const vx = -dir.x * dir.y, vy = dir.x * dir.x + dir.z * dir.z, vz = -dir.z * dir.y;
  let lit = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = must(SOFT[i]);
    const d = { x: dir.x + ux / ul * a + vx * b, y: dir.y + vy * b, z: dir.z + uz / ul * a + vz * b };
    const l = Math.hypot(d.x, d.y, d.z); d.x /= l; d.y /= l; d.z /= l;
    if (d.y > 0 && rayFree(g, px, py, pz, d, 14, start)) lit++;
  }
  return lit / n;
}

// Koľko hodín priameho slnka denne dostane vrch políčka (pre hernú logiku: slnkomilné vs. tieňomilné kvety)
export function sunHours(g: Grid, tx: number, ty: number, season: number): number {
  const py = surfaceY(g, tx, ty) + 0.02;
  let hours = 0;
  for (let m = 300 + 15; m < 1260; m += 30) hours += 0.5 * sunVisibility(g, tx + 0.5, py, ty + 0.5, sunDir(m, season), 5);
  return hours;
}

// ---- Voda (jazierko): hladina, hĺbka k brehu, lekná, najbližší bod vody ----
export const WATER_Y = groundHeight('grass') / R - 1 / 8;  // hladina je 1/8 bloku pod okolitou zemou (podkocky vody sú dno)
// w = šírka plochy v políčkach (predvolene záhrada); výška = tiles.length / w
const isWater = (tiles: readonly GroundTile[], x: number, y: number, w: number): boolean => x >= 0 && y >= 0 && x < w && y < tiles.length / w && tiles[y * w + x]?.g === 'water';
// Maska vody pre shader (1 = voda) – z nej sa v každom pixeli hladiny počíta vzdialenosť k brehu
export function waterMask(tiles: readonly GroundTile[]): Uint8Array {
  const m = new Uint8Array(tiles.length);
  for (let i = 0; i < tiles.length; i++) m[i] = must(tiles[i]).g === 'water' ? 255 : 0;
  return m;
}
// Štvorce hladiny: jeden na každé políčko vody
export function waterQuads(tiles: readonly GroundTile[], w?: number): { x: number; y: number }[] {
  w = w || D.W;
  const out = [];
  for (let y = 0; y < tiles.length / w; y++) for (let x = 0; x < w; x++) if (isWater(tiles, x, y, w)) out.push({ x, y });
  return out;
}
// Lekná – rovnaké políčka ako lekná v textúre zeme z art.js (hash < 0,12), v zime nie sú
export function lilyPads(tiles: readonly GroundTile[], season: number, w?: number): { x: number; y: number }[] {
  if (season === 3) return [];
  w = w || D.W;
  const out = [];
  for (let y = 0; y < tiles.length / w; y++) for (let x = 0; x < w; x++) if (isWater(tiles, x, y, w) && hash(x, y) < 0.12) out.push({ x, y });
  return out;
}
// Najbližší bod hladiny k bodu (px, pz) do vzdialenosti maxD, inak null
export function nearestWater(tiles: readonly GroundTile[], px: number, pz: number, maxD: number, w?: number): { x: number; z: number; d: number } | null {
  w = w || D.W;
  let best = null, bd = maxD;
  const tx = Math.floor(px), tz = Math.floor(pz), r = Math.ceil(maxD);
  for (let y = tz - r; y <= tz + r; y++) for (let x = tx - r; x <= tx + r; x++) {
    if (!isWater(tiles, x, y, w)) continue;
    const qx = Math.min(x + 1, Math.max(x, px)), qz = Math.min(y + 1, Math.max(y, pz)), d = Math.hypot(qx - px, qz - pz);
    if (d <= bd) { bd = d; best = { x: qx, z: qz, d }; }
  }
  return best;
}

// farby lístia stromu v danom období (pre padajúce lístie); ihličnany a zima → null
export const leafMats = (kind: string, se: number): readonly MatId[] | null => lookup(LEAVES, kind)?.[se] || null;
