// 3D tráva (#192): na neprekopanej tráve a lúke stoja ploché trsy stebiel (jedna sieť s inštanciami), ktoré sa kývu vo vetre
// a rozostupujú sa pred postavičkami. Trs je zvislá plocha natočená ku kamere a celý má hĺbku svojho koreňa – rovnako
// ako sprity (postavička má hĺbku chodidiel). Obyčajný z-buffer tak zakryje nohy postavičky trsmi, ktoré rastú pred ňou,
// a trsy za ňou ostanú za ňou – bez triedenia, pre všetkých hráčov, kvety aj zvieratá naraz.
// Svetlo (okolie, slnko s mapou tieňov, lampáše, šero lesa) počíta ten istý fragment shader ako svet (render3d.ts, GRASS).
// Hustota podľa nastavenia zariadenia (menu → Tráva): vypnutá / menej / viac.
import type * as THREE from 'three';
import type { Ground } from '../shared/data.ts';
import type { Grid } from '../shared/world3d.ts';
import type { TileView } from '../shared/protocol.ts';
import { must } from '../shared/util.ts';

type Three = typeof THREE;
export type GrassQuality = 'off' | 'low' | 'high';
const QUALITY: readonly GrassQuality[] = ['off', 'low', 'high'];
const isQuality = (q: string | null): q is GrassQuality => q != null && (QUALITY as readonly string[]).includes(q);

export const STENCIL_GRASS = 0x80; // bit v stencile: tu je tráva (röntgen postavičky sa cez trávu nekreslí)
const MAX_PUSH = 8;                // koľko postavičiek naraz rozhŕňa trávu
const SEG = 3;                     // úseky trsu na výšku (ohyb stebiel)
const CELL = 64, COLS = 4, ROWS = 2; // obrázok trsov: 4 podoby, riadok 0 = tráva, 1 = lúka

// Druhy zeme s trávou: trsov na políčko (menej / viac) a výška trsu v blokoch (postavička má ~1,28, kolená ~0,35)
interface Kind { n: Readonly<Record<'low' | 'high', number>>; h: number; row: number }
const KINDS: Readonly<Partial<Record<Ground, Kind>>> = {
  grass: { n: { low: 9, high: 18 }, h: 0.42, row: 0 }, // hustá ako lúka
  meadow: { n: { low: 9, high: 18 }, h: 0.5, row: 1 },
};
const TRAMPLED = 0.65;              // pri ceste je tráva udupaná (nižšia)

// farby stebiel podľa obdobia (jar, leto, jeseň; v zime je tráva pod snehom – žiadne trsy): pri zemi, uprostred, na špičke
const BLADES: readonly (readonly [string, string, string])[] = [
  ['#3f7f2c', '#6fb34a', '#a6dc78'],
  ['#356f26', '#5fa23d', '#93cd5f'],
  ['#6f6a2a', '#a39a42', '#d6c56a'],
];
// kvietky na lúke (jar, leto, jeseň) – ako na kresbe lúky (art.ts)
const FLOWERS: readonly (readonly string[])[] = [['#fff', '#ffe14d', '#fff', '#b39ddb'], ['#e8261f', '#3f6fd8', '#fff', '#ffe14d'], ['#8a63d2', '#d58cd6', '#ffcc33', '#fff']];

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRASS_VERT = `
attribute vec4 aRoot;   // koreň trsu (xyz) a náhodné číslo trsu
attribute vec4 aShape;  // šírka, výška, ľavý dolný roh podoby v obrázku (u, v)
uniform mat4 shadowMatrix; uniform vec3 sunDir; uniform float shadowNormalBias;
uniform float time; uniform vec2 wind; uniform vec2 cell; uniform float depthBias;
uniform vec4 pushers[${MAX_PUSH}]; uniform int pusherCount;
varying vec3 vColor; varying float vAo; varying float vEmis; varying float vTex; varying float vFacing; varying float vUp;
varying vec2 vUv; varying vec3 vPos; varying vec4 vShadow; varying vec2 vUv2;
void main() {
  vec3 root = aRoot.xyz;
  float t = position.y, seed = aRoot.w;
  // trs je zvislý a natočený ku kamere len okolo zvislej osi (v zrkadle pod hladinou je tak správne prevrátený)
  vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  // vietor: vlna, ktorá ide cez záhradu, a pomalé nárazy; každý trs má vlastnú fázu
  float gust = 0.55 + 0.45 * sin(dot(root.xz, vec2(0.13, 0.09)) - time * 0.7);
  float wave = sin(dot(root.xz, wind) * 4.0 - time * 2.1 + seed * 6.2832);
  vec2 bend = normalize(wind) * (0.12 + 0.22 * gust) * (0.55 + 0.45 * wave);
  bend += vec2(sin(time * 3.3 + seed * 40.0), cos(time * 2.9 + seed * 23.0)) * 0.035; // drobné chvenie
  // postavičky rozhŕňajú trávu: trs sa ohne od nich a trochu prikrčí
  float squash = 0.0;
  for (int i = 0; i < ${MAX_PUSH}; i++) {
    if (i >= pusherCount) break;
    vec4 p = pushers[i];
    vec2 d = root.xz - p.xz;
    float dist = length(d);
    float f = (1.0 - smoothstep(0.08, p.w, dist)) * step(abs(root.y - p.y), 0.6);
    bend += d / max(dist, 0.001) * f * 0.55;
    squash = max(squash, f);
  }
  float h = aShape.y * (1.0 - 0.2 * squash), k = t * t;
  vec3 wp = root + right * position.x * aShape.x;
  wp.xz += bend * h * k;
  wp.y += h * t * (1.0 - 0.45 * min(1.0, dot(bend, bend)) * k); // ohnuté steblo je nižšie
  vUv = aShape.zw + vec2(position.x + 0.5, t) * cell;
  vColor = vec3(0.86 + 0.26 * fract(seed * 7.13));
  vAo = mix(0.62, 1.0, t); vEmis = 0.0; vTex = 1.0;
  vPos = wp; vFacing = sunDir.y; vUp = mix(0.2, 0.75, t); vUv2 = vec2(0.0);
  vShadow = shadowMatrix * vec4(wp + vec3(0.0, shadowNormalBias, 0.0), 1.0);
  // celý trs má hĺbku koreňa (ako sprity) – trochu bližšie ku kamere, aby sa spodok nebil so zemou
  vec4 cp = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vec4 rp = projectionMatrix * viewMatrix * vec4(root, 1.0);
  cp.z = (rp.z / rp.w - depthBias) * cp.w;
  gl_Position = cp;
}`;

export interface GrassPusher { x: number; y: number; z: number; r: number }
export interface Grass3d {
  build: (grid: Grid, tiles: readonly TileView[], w: number, h: number, se: number, groundY: (x: number, y: number) => number) => void;
  update: (t: number, pushers: readonly GrassPusher[], center: { x: number; z: number }) => void;
  setQuality: (q: string) => void;
  readonly quality: GrassQuality;
  readonly mesh: THREE.Mesh;
  dispose: () => void;
}

export function createGrass3d(o: {
  THREE: Three; scene: THREE.Scene; frag: string;
  world: { [name: string]: THREE.IUniform };
  onChange?: () => void;
}): Grass3d {
  const { THREE: T3 } = o;
  let quality: GrassQuality = matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
  try { const q = localStorage.getItem('mfGrass'); if (isQuality(q)) quality = q; } catch { /* súkromné okno bez úložiska */ }

  // ---- obrázok trsov (podľa obdobia) ----
  const canvas = document.createElement('canvas'); canvas.width = CELL * COLS; canvas.height = CELL * ROWS;
  const ctx = must(canvas.getContext('2d') ?? undefined);
  const tex = new T3.CanvasTexture(canvas);
  tex.colorSpace = T3.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = T3.LinearFilter; tex.magFilter = T3.LinearFilter;
  tex.flipY = false; // riadok 0 obrázka (hore) = spodok trsu: v = 0 pri koreni
  let texSeason = -1;
  function blade(x: number, y0: number, w: number, h: number, lean: number, cols: readonly [string, string, string]): void {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, cols[0]); g.addColorStop(0.55, cols[1]); g.addColorStop(1, cols[2]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y0);
    ctx.quadraticCurveTo(x - w / 2 + lean * 0.25, y0 + h * 0.6, x + lean, y0 + h);
    ctx.quadraticCurveTo(x + w / 2 + lean * 0.35, y0 + h * 0.55, x + w / 2, y0);
    ctx.closePath(); ctx.fill();
  }
  function drawAtlas(se: number): void {
    texSeason = se;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cols = must(BLADES[se]);
    for (let row = 0; row < ROWS; row++) for (let v = 0; v < COLS; v++) {
      const x0 = v * CELL, y0 = row * CELL, n = row ? 9 : 7;
      const tips: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const r = (k: number): number => hash(v * 31 + row, i, k);
        const x = x0 + CELL * (0.18 + 0.64 * (i + r(1)) / n), h = CELL * (0.55 + 0.42 * r(2)), w = CELL * (0.06 + 0.04 * r(3));
        const want = (r(4) - 0.5) * CELL * 0.45 + (x - x0 - CELL / 2) * 0.35;
        const lean = Math.max(x0 + 4, Math.min(x0 + CELL - 4, x + want)) - x; // špička ostane v políčku obrázka
        // o odtieň svetlejšie a tmavšie steblá – trs nie je jednoliata plocha
        const sh = r(5) < 0.35 ? -1 : 0;
        blade(x, y0 + 1, w, h - 2, lean, sh ? [cols[0], cols[0], cols[1]] : cols);
        tips.push([x + lean, y0 + h - 3]);
      }
      // lúka: kvietky na niektorých steblách (v zime nie)
      if (row === 1) {
        const fc = must(FLOWERS[se]);
        for (let i = 0; i < 2; i++) {
          const tp = tips[(hash(v, i, 9) * tips.length) | 0];
          if (!tp || hash(v, i, 10) < 0.3) continue;
          ctx.fillStyle = must(fc[(hash(v, i, 11) * fc.length) | 0]);
          ctx.beginPath(); ctx.arc(tp[0], tp[1], CELL * 0.055, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#ffd54a';
          ctx.beginPath(); ctx.arc(tp[0], tp[1], CELL * 0.02, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    tex.needsUpdate = true;
  }

  // ---- sieť: jeden pás (2 × (SEG + 1) vrcholov), opakovaný pre každý trs ----
  const geo = new T3.InstancedBufferGeometry();
  const P: number[] = [], I: number[] = [];
  for (let s = 0; s <= SEG; s++) P.push(-0.5, s / SEG, 0, 0.5, s / SEG, 0);
  for (let s = 0; s < SEG; s++) { const a = s * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setAttribute('position', new T3.Float32BufferAttribute(P, 3));
  geo.setIndex(I);
  let rootAttr = new T3.InstancedBufferAttribute(new Float32Array(4), 4), shapeAttr = new T3.InstancedBufferAttribute(new Float32Array(4), 4);
  geo.setAttribute('aRoot', rootAttr); geo.setAttribute('aShape', shapeAttr);
  geo.instanceCount = 0;

  const u = {
    ...o.world,
    grassMap: { value: tex }, time: { value: 0 }, wind: { value: new T3.Vector2(0.8, 0.35) },
    cell: { value: new T3.Vector2(1 / COLS, 1 / ROWS) }, depthBias: { value: 0.0004 },
    pushers: { value: Array.from({ length: MAX_PUSH }, () => new T3.Vector4()) }, pusherCount: { value: 0 },
  };
  const material = new T3.ShaderMaterial({
    vertexShader: GRASS_VERT, fragmentShader: o.frag, defines: { GRASS: 1, SHADOW_TAPS: 4 }, uniforms: u, side: T3.DoubleSide,
    // označí v stencile, kde je tráva – röntgen postavičky (render3d.ts) sa tam nekreslí, nohy v tráve ostanú skryté
    stencilWrite: true, stencilRef: STENCIL_GRASS, stencilWriteMask: STENCIL_GRASS, stencilFunc: T3.AlwaysStencilFunc, stencilZPass: T3.ReplaceStencilOp,
  });
  const mesh = new T3.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.layers.set(1);    // hlavná kamera…
  mesh.layers.enable(2); // … a skutočné odrazy vo vode; do mapy tieňov nepatrí
  o.scene.add(mesh);

  let last: { grid: Grid; tiles: readonly TileView[]; w: number; h: number; se: number; groundY: (x: number, y: number) => number } | null = null;
  function build(grid: Grid, tiles: readonly TileView[], w: number, h: number, se: number, groundY: (x: number, y: number) => number): void {
    last = { grid, tiles, w, h, se, groundY };
    if (texSeason !== se && se !== 3) drawAtlas(se); // v zime trsy nie sú
    const R: number[] = [], S: number[] = [];
    if (quality !== 'off' && se !== 3) { // v zime je tráva pod snehom
      const isPath = (x: number, y: number): boolean => { const g = x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x]?.g : undefined; return g === 'path' || g === 'majster' || g === 'gate'; };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const tl = tiles[y * w + x];
        const kind = tl && !tl.s ? KINDS[tl.g] : undefined;
        if (!kind) continue;
        const trampled = isPath(x - 1, y) || isPath(x + 1, y) || isPath(x, y - 1) || isPath(x, y + 1) ? TRAMPLED : 1;
        const n = kind.n[quality];
        const side = Math.ceil(Math.sqrt(n)), gy = groundY(x, y);
        for (let k = 0; k < n; k++) {
          const r = (j: number): number => hash(x * 97 + y, k, j);
          // rovnomerne po políčku (mriežka s náhodným posunom), kúsok aj cez okraj – hranice políčok nevidno
          const px = x + ((k % side) + r(1)) / side * 1.1 - 0.05, pz = y + (((k / side) | 0) + r(2)) / side * 1.1 - 0.05;
          const th = kind.h * (0.7 + 0.6 * r(3)) * trampled;
          R.push(px, gy, pz, r(4));
          S.push(th * (0.95 + 0.4 * r(5)), th, ((r(6) * COLS) | 0) / COLS, kind.row / ROWS);
        }
      }
    }
    const n = R.length / 4;
    if (n > rootAttr.count) {
      rootAttr = new T3.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      shapeAttr = new T3.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      geo.setAttribute('aRoot', rootAttr); geo.setAttribute('aShape', shapeAttr);
    }
    rootAttr.array.set(R); shapeAttr.array.set(S);
    rootAttr.needsUpdate = shapeAttr.needsUpdate = true;
    geo.instanceCount = n;
    mesh.visible = n > 0;
  }

  // každú snímku: čas vetra a postavičky, ktoré trávu rozhŕňajú (najbližšie k stredu pohľadu)
  function update(t: number, pushers: readonly GrassPusher[], center: { x: number; z: number }): void {
    u.time.value = t % 3600;
    const list = pushers.length > MAX_PUSH
      ? [...pushers].sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z)).slice(0, MAX_PUSH)
      : pushers;
    list.forEach((p, i) => { must(u.pushers.value[i]).set(p.x, p.y, p.z, p.r); });
    u.pusherCount.value = list.length;
  }

  function setQuality(q: string): void {
    if (!isQuality(q)) return;
    quality = q;
    try { localStorage.setItem('mfGrass', q); } catch { /* súkromné okno bez úložiska */ }
    if (last) build(last.grid, last.tiles, last.w, last.h, last.se, last.groundY);
    if (o.onChange) o.onChange();
  }

  function dispose(): void { o.scene.remove(mesh); geo.dispose(); material.dispose(); tex.dispose(); }

  return { build, update, setQuality, get quality() { return quality; }, mesh, dispose };
}
