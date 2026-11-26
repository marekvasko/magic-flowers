// 3D tráva (#192): na neprekopanej tráve a lúke stoja ploché trsy stebiel (jedna sieť s inštanciami), ktoré sa kývu vo vetre
// a rozostupujú sa pred postavičkami. Trs je zvislá plocha natočená ku kamere a celý má hĺbku svojho koreňa – rovnako
// ako sprity (postavička má hĺbku chodidiel). Obyčajný z-buffer tak zakryje nohy postavičky trsmi, ktoré rastú pred ňou,
// a trsy za ňou ostanú za ňou – bez triedenia, pre všetkých hráčov, kvety aj zvieratá naraz.
// Svetlo (okolie, slnko s mapou tieňov, lampáše, šero lesa) je to isté ako na svete (render3d.ts, LIGHT_GLSL).
// Výkon (#196) – izometrická kamera (ortogonálna, pevný sklon) a trs s jednou hĺbkou dovoľujú tri skratky:
//  1. svetlo sa počíta vo vrcholoch trsu, nie v každom pixeli – fragment shader je len obrázok × svetlo;
//  2. trsy sú zoradené spredu dozadu podľa smeru pohľadu – z-buffer zahodí zakryté vrstvy skôr, než sa vyfarbia;
//  3. tráva je rozdelená na kusy (CHUNK × CHUNK políčok) – kreslia sa len tie na obrazovke a v zrkadle vody len tie pri vode.
// Hustota podľa nastavenia zariadenia (menu → Tráva): vypnutá / menej / viac.
import type * as THREE from 'three';
import type { Ground } from '../shared/data.ts';
import { frontToBack } from '../shared/world3d.ts';
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
const CELL = 64, COLS = 8, ROWS = 2; // obrázok trsov: 8 podôb, riadok 0 = tráva, 1 = lúka
const CHUNK = 8;                   // kus trávy (políčok na stranu) – jedna sieť, ktorá sa kreslí len vtedy, keď je na obrazovke
const REACH = 1.2;                 // o koľko blokov trs najviac presiahne svoj koreň (šírka, ohyb vo vetre a pred postavičkou)
const RESORT_COS = 0.9;            // o koľko sa môže pohľad otočiť (kosínus uhla), kým sa trsy zoradia nanovo

// Druhy zeme s trávou: najviac trsov na políčko (menej / viac; koľko z nich vyrastie, určuje šum hustoty)
// a výška trsu v blokoch (postavička má ~1,28, kolená ~0,35)
interface Kind { n: Readonly<Record<'low' | 'high', number>>; h: number; row: number }
const KINDS: Readonly<Partial<Record<Ground, Kind>>> = {
  grass: { n: { low: 36, high: 72 }, h: 0.42, row: 0 }, // hustá ako lúka
  meadow: { n: { low: 36, high: 72 }, h: 0.5, row: 1 },
};
const TRAMPLED = 0.65;              // pri ceste je tráva udupaná (nižšia)

// Farba stebiel podľa obdobia (jar, leto, jeseň; v zime je tráva pod snehom – žiadne trsy): pri zemi je steblo farby
// zeme pod ním (art.ts, GRASS), takže trsy splývajú so zemou ako jeden koberec; ku špičke svetlejšie a do žltozelena.
const GROUND: readonly string[] = ['#86c95b', '#74b84a', '#aab24e'];
const TIP_MIX = '#d4ec6e', TIP_K = 0.42, BASE_K = 0.8; // BASE_K = GRASS_GROUND_K (zem pod trávou je o toľko tmavšia)
// Veľké mäkké fľaky farby (tmavšie modrozelené a slnečné žltozelené) – rovnaká funkcia farbí trsy (vo vrcholoch)
// aj zem pod trávou (render3d.ts, FRAG s maskou grassMask), takže fľak ide cez zem aj steblá naraz.
export const GRASS_TINT_GLSL = `
const float GRASS_GROUND_K = ${BASE_K.toFixed(2)};
float gHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 grassTint(vec2 p) {
  float n = gNoise(p * 0.14) * 0.65 + gNoise(p * 0.41 + 11.0) * 0.35;
  n = smoothstep(0.28, 0.72, n);
  return mix(vec3(0.66, 0.8, 0.76), vec3(1.1, 1.08, 0.8), n);
}`;
// kvietky na lúke (jar, leto, jeseň) – ako na kresbe lúky (art.ts)
const FLOWERS: readonly (readonly string[])[] = [['#fff', '#ffe14d', '#fff', '#b39ddb'], ['#e8261f', '#3f6fd8', '#fff', '#ffe14d'], ['#8a63d2', '#d58cd6', '#ffcc33', '#fff']];

function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// plynulý šum (hodnotový, s vyhladením) 0–1 – tráva rastie v chumáčoch a plochách, nie v rovnakom vzore na každom políčku
function vnoise(x: number, z: number, k: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz, k), b = hash(ix + 1, iz, k), c = hash(ix, iz + 1, k), d = hash(ix + 1, iz + 1, k);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}
const fbm = (x: number, z: number, k: number): number => vnoise(x * 0.22, z * 0.22, k) * 0.65 + vnoise(x * 0.7, z * 0.7, k + 7) * 0.35;

// light = LIGHT_GLSL z render3d.ts (svetlo sveta v bode vPos)
const grassVert = (light: string): string => `
precision highp sampler2D; // mapa tieňov sa číta vo vrcholoch
attribute vec4 aRoot;   // koreň trsu (xyz); w = odtieň × 100 (celá časť) + náhodné číslo trsu (desatinná časť)
attribute vec4 aShape;  // šírka, výška, ľavý dolný roh podoby v obrázku (u, v)
uniform mat4 shadowMatrix; uniform vec3 sunDir; uniform float shadowNormalBias;
uniform float time; uniform vec2 wind; uniform vec2 cell; uniform float depthBias;
uniform vec4 pushers[${MAX_PUSH}]; uniform int pusherCount;
varying vec2 vUv; varying vec3 vMul; varying vec3 vAdd; // farba pixelu = obrázok trsu × vMul + vAdd
${light}
${GRASS_TINT_GLSL}
void main() {
  vec3 root = aRoot.xyz;
  float t = position.y, seed = fract(aRoot.w), tint = floor(aRoot.w) / 100.0;
  // trs je zvislý a natočený ku kamere len okolo zvislej osi (v zrkadle pod hladinou je tak správne prevrátený)
  vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
  // vietor: nárazy sú šum, ktorý sa sťahuje cez záhradu po vetre – kde práve fúka, tráva sa ohne viac a jej špičky
  // sa zalesknú (svetlé pruhy, ktoré sa prevaľujú cez lúku); každý trs sa navyše trochu kýve vo vlastnej fáze
  vec2 wd = normalize(wind);
  float gust = gNoise(root.xz * 0.28 - wd * time * 0.9) * 0.7 + gNoise(root.xz * 0.7 - wd * time * 1.6 + 5.0) * 0.3;
  float wave = sin(dot(root.xz, wind) * 4.0 - time * 2.1 + seed * 6.2832);
  float sheen = smoothstep(0.5, 0.85, gust);
  vec2 bend = wd * (0.06 + 0.34 * gust) * (0.8 + 0.2 * wave);
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
  wp.xz = clamp(wp.xz, vec2(0.01), areaSize - 0.01); // nič nepresahuje cez okraj mapy (trs pri okraji sa zúži)
  vUv = aShape.zw + vec2(position.x + 0.5, t) * cell;
  vPos = wp; vFacing = sunDir.y; vUp = mix(0.75, 1.0, t); // svieti takmer ako zem – spodok s ňou splynie
  vShadow = shadowMatrix * vec4(wp + vec3(0.0, shadowNormalBias, 0.0), 1.0);
  // svetlo, opar a tma tu vo vrchole (ten istý výpočet ako pixel zeme) – cez trs sa len interpolujú
  vec3 light; float haze, fogK;
  lighting(1.0, light, haze, fogK);
  vec3 color = grassTint(root.xz) * tint * (1.0 + 0.22 * sheen * t) * mix(0.86, 1.0, t); // pri zemi o kúsok tmavší
  vMul = color * light * (1.0 - haze) * (1.0 - fogK);
  vAdd = gloomFog * haze * (1.0 - fogK) + darkFog * fogK;
  // celý trs má hĺbku koreňa (ako sprity). Len spodok je o kúsok bližšie ku kamere, aby sa nebil so zemou – posun
  // musí byť malý a len pri zemi, inak by trsy tesne za postavičkou presvitali cez jej telo.
  vec4 cp = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vec4 rp = projectionMatrix * viewMatrix * vec4(root, 1.0);
  cp.z = (rp.z / rp.w - depthBias * step(t, 0.01)) * cp.w;
  gl_Position = cp;
}`;
// steblá sú v obrázku sivé (jas = od farby zeme po farbu špičky), farebné sú len kvietky
const GRASS_FRAG = `
precision highp float;
uniform sampler2D grassMap; uniform vec3 grassBase; uniform vec3 grassTip;
varying vec2 vUv; varying vec3 vMul; varying vec3 vAdd;
void main() {
  vec4 gc = texture2D(grassMap, vUv);
  if (gc.a < 0.5) discard;
  float sat = max(gc.r, max(gc.g, gc.b)) - min(gc.r, min(gc.g, gc.b));
  gl_FragColor = vec4((sat > 0.12 ? gc.rgb : mix(grassBase, grassTip, gc.r)) * vMul + vAdd, 1.0);
}`;

export interface GrassPusher { x: number; y: number; z: number; r: number }
export interface Grass3d {
  build: (grid: Grid, tiles: readonly TileView[], w: number, h: number, se: number, groundY: (x: number, y: number) => number) => void;
  update: (t: number, pushers: readonly GrassPusher[], center: { x: number; z: number }, camera: THREE.Camera) => void;
  sync: (tiles: readonly TileView[]) => void;
  setQuality: (q: string) => void;
  readonly quality: GrassQuality;
  readonly stats: { chunks: number; tufts: number }; // koľko kusov a trsov je postavených (ladenie)
  dispose: () => void;
}

export function createGrass3d(o: {
  THREE: Three; scene: THREE.Scene;
  light: string;                      // LIGHT_GLSL (render3d.ts)
  water: { y: number; tan: number };  // výška hladiny a tangens sklonu kamery – ktoré kusy trávy sa môžu zrkadliť vo vode
  world: { [name: string]: THREE.IUniform };
  mask: THREE.IUniform<THREE.Texture | null>; maskOn: THREE.IUniform<number>; // maska políčok s trávou pre zem (render3d.ts)
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
  // Steblá sú v obrázku sivé (jas = poloha od farby zeme po farbu špičky, shader ich zafarbí), kvietky farebné.
  function blade(x: number, y0: number, w: number, h: number, lean: number, hi: number): void {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h), v = (k: number): string => { const c = Math.round(k * 255); return `rgb(${c},${c},${c})`; };
    g.addColorStop(0, v(0)); g.addColorStop(0.35, v(hi * 0.3)); g.addColorStop(1, v(hi));
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
    const gc = new T3.Color(must(GROUND[se])), base = gc.clone().multiplyScalar(BASE_K), tip = gc.clone().lerp(new T3.Color(TIP_MIX), TIP_K);
    u.grassBase.value.set(base.r, base.g, base.b); u.grassTip.value.set(tip.r, tip.g, tip.b);
    for (let row = 0; row < ROWS; row++) for (let v = 0; v < COLS; v++) {
      const x0 = v * CELL, y0 = row * CELL, n = row ? 15 : 14;
      const tips: [number, number][] = [];
      // široké mäkké steblá, väčšinou sklonené na jednu stranu (ako učesané vetrom); zadné tmavšie, predné svetlejšie
      for (let i = 0; i < n; i++) {
        const r = (k: number): number => hash(v * 31 + row, i, k);
        const x = x0 + CELL * (0.16 + 0.68 * r(1)), h = CELL * (0.5 + 0.47 * r(2)), w = CELL * (0.08 + 0.06 * r(3));
        const want = CELL * (0.1 + 0.22 * r(4)) * (r(6) < 0.2 ? -1 : 1) + (x - x0 - CELL / 2) * 0.25;
        const lean = Math.max(x0 + 4, Math.min(x0 + CELL - 4, x + want)) - x; // špička ostane v políčku obrázka
        blade(x, y0 + 1, w, h - 2, lean, 0.25 + 0.75 * (i / (n - 1)) * (0.6 + 0.4 * r(5)));
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

  // ---- sieť: jeden pás (2 × (SEG + 1) vrcholov), opakovaný pre každý trs; kusy ho zdieľajú ----
  const P: number[] = [], I: number[] = [];
  for (let s = 0; s <= SEG; s++) P.push(-0.5, s / SEG, 0, 0.5, s / SEG, 0);
  for (let s = 0; s < SEG; s++) { const a = s * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const stripPos = new T3.Float32BufferAttribute(P, 3), stripIndex = new T3.Uint16BufferAttribute(I, 1);

  const u = {
    ...o.world,
    grassBase: { value: new T3.Vector3() }, grassTip: { value: new T3.Vector3() },
    grassMap: { value: tex }, time: { value: 0 }, wind: { value: new T3.Vector2(0.8, 0.35) },
    cell: { value: new T3.Vector2(1 / COLS, 1 / ROWS) }, depthBias: { value: 0.00004 },
    pushers: { value: Array.from({ length: MAX_PUSH }, () => new T3.Vector4()) }, pusherCount: { value: 0 },
  };
  const material = new T3.ShaderMaterial({
    vertexShader: grassVert(o.light), fragmentShader: GRASS_FRAG, defines: { SHADOW_TAPS: 4 }, uniforms: u, side: T3.DoubleSide,
    // označí v stencile, kde je tráva – röntgen postavičky (render3d.ts) sa tam nekreslí, nohy v tráve ostanú skryté
    stencilWrite: true, stencilRef: STENCIL_GRASS, stencilWriteMask: STENCIL_GRASS, stencilFunc: T3.AlwaysStencilFunc, stencilZPass: T3.ReplaceStencilOp,
  });

  // ---- kusy trávy: každý má vlastné inštancie (v poradí spredu dozadu) a guľu, podľa ktorej sa oreže mimo obrazovky ----
  // Kusy medzi sebou radí three.js (nepriehľadné siete s rovnakým materiálom kreslí od najbližšej).
  interface Chunk { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; root: Float32Array; shape: Float32Array; rootAttr: THREE.InstancedBufferAttribute; shapeAttr: THREE.InstancedBufferAttribute }
  let chunks: Chunk[] = [], tufts = 0;
  const viewDir = new T3.Vector3(), sortedDir = new T3.Vector3(); // kam sa díva kamera; pre aký smer sú trsy zoradené
  function clearChunks(): void {
    for (const c of chunks) { o.scene.remove(c.mesh); c.geo.dispose(); }
    chunks = []; tufts = 0;
  }
  function addChunk(R: readonly number[], S: readonly number[], x0: number, y0: number, x1: number, y1: number, gyMin: number, gyMax: number, mirrored: boolean): void {
    const n = R.length / 4;
    const geo = new T3.InstancedBufferGeometry();
    geo.setAttribute('position', stripPos); geo.setIndex(stripIndex);
    const c: Chunk = {
      geo, mesh: new T3.Mesh(geo, material), root: new Float32Array(R), shape: new Float32Array(S),
      rootAttr: new T3.InstancedBufferAttribute(new Float32Array(n * 4), 4), shapeAttr: new T3.InstancedBufferAttribute(new Float32Array(n * 4), 4),
    };
    geo.setAttribute('aRoot', c.rootAttr); geo.setAttribute('aShape', c.shapeAttr);
    geo.instanceCount = n;
    // guľa okolo všetkého, čo kus môže nakresliť: korene siahajú kúsok cez okraj políčok, trsy sa ohýbajú a majú výšku
    const hx = (x1 - x0) / 2 + REACH, hz = (y1 - y0) / 2 + REACH, hy = (gyMax - gyMin) / 2 + REACH;
    geo.boundingSphere = new T3.Sphere(new T3.Vector3((x0 + x1) / 2, (gyMin + gyMax) / 2 + REACH / 2, (y0 + y1) / 2), Math.hypot(hx, hy, hz));
    c.mesh.layers.set(1);                  // hlavná kamera; do mapy tieňov tráva nepatrí
    if (mirrored) c.mesh.layers.enable(2); // … a skutočné odrazy vo vode
    o.scene.add(c.mesh);
    chunks.push(c); tufts += n;
    sortChunk(c);
  }
  function sortChunk(c: Chunk): void {
    const order = frontToBack(c.root, sortedDir), ra = c.rootAttr.array, sa = c.shapeAttr.array;
    order.forEach((src, dst) => { ra.set(c.root.subarray(src * 4, src * 4 + 4), dst * 4); sa.set(c.shape.subarray(src * 4, src * 4 + 4), dst * 4); });
    c.rootAttr.needsUpdate = c.shapeAttr.needsUpdate = true;
  }

  let maskTex: THREE.DataTexture | null = null;
  let last: { grid: Grid; tiles: readonly TileView[]; w: number; h: number; se: number; groundY: (x: number, y: number) => number } | null = null;
  // Ktoré políčka majú trávu – zmena jedného políčka (správa tile, napr. prekopanie motykou) svet neprestavia,
  // tráva sa preto prestaví sama, keď sa podpis zmení (sync).
  const growSig = (tiles: readonly TileView[]): string => tiles.map(t => (!t.s && KINDS[t.g] ? '1' : '0')).join('');
  let builtSig = '';
  function sync(tiles: readonly TileView[]): void {
    if (!last || tiles.length !== last.w * last.h) return;
    if (growSig(tiles) !== builtSig) build(last.grid, tiles, last.w, last.h, last.se, last.groundY);
  }
  function build(grid: Grid, tiles: readonly TileView[], w: number, h: number, se: number, groundY: (x: number, y: number) => number): void {
    last = { grid, tiles, w, h, se, groundY };
    builtSig = growSig(tiles);
    if (texSeason !== se && se !== 3) drawAtlas(se); // v zime trsy nie sú
    clearChunks();
    if (!maskTex || maskTex.image.width !== w || maskTex.image.height !== h) {
      if (maskTex) maskTex.dispose();
      maskTex = new T3.DataTexture(new Uint8Array(w * h * 4), w, h);
      maskTex.magFilter = maskTex.minFilter = T3.LinearFilter;
      o.mask.value = maskTex;
    }
    const md = maskTex.image.data;
    if (md) md.fill(0);
    if (quality !== 'off' && se !== 3) { // v zime je tráva pod snehom
      const grows = (x: number, y: number): boolean => { const t = x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x] : undefined; return !!t && !t.s && !!KINDS[t.g]; };
      // ako ďaleko je bod od najbližšieho susedného políčka bez trávy (prekopaná pôda, cesta, voda…; okraj mapy sa nepočíta)
      const bareDist = (px: number, pz: number, x: number, y: number): number => {
        let d = 9;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h || grows(nx, ny)) continue;
          d = Math.min(d, Math.hypot(Math.max(nx - px, 0, px - nx - 1), Math.max(ny - pz, 0, pz - ny - 1)));
        }
        return d;
      };
      const isPath = (x: number, y: number): boolean => { const g = x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x]?.g : undefined; return g === 'path' || g === 'majster' || g === 'gate'; };
      const isWater = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && tiles[y * w + x]?.g === 'water';
      for (let cy = 0; cy < h; cy += CHUNK) for (let cx = 0; cx < w; cx += CHUNK) {
        const R: number[] = [], S: number[] = [], x1 = Math.min(w, cx + CHUNK), y1 = Math.min(h, cy + CHUNK);
        let gyMin = Infinity, gyMax = -Infinity;
        for (let y = cy; y < y1; y++) for (let x = cx; x < x1; x++) {
          const tl = tiles[y * w + x];
          const kind = tl && !tl.s ? KINDS[tl.g] : undefined;
          if (!kind) continue;
          if (md) md[(y * w + x) * 4] = 255;
          const trampled = isPath(x - 1, y) || isPath(x + 1, y) || isPath(x, y - 1) || isPath(x, y + 1) ? TRAMPLED : 1;
          const n = kind.n[quality], gy = groundY(x, y);
          gyMin = Math.min(gyMin, gy); gyMax = Math.max(gyMax, gy);
          for (let k = 0; k < n; k++) {
            const r = (j: number): number => hash(x * 97 + y, k, j);
            // náhodne po políčku, kúsok aj cez okraj; či trs vyrastie, rozhodne šum hustoty (chumáče a riedke miesta)
            // korene ostanú na mape (cez okraj mapy nič nevisí)
            const px = Math.max(0.04, Math.min(w - 0.04, x - 0.05 + r(1) * 1.1)), pz = Math.max(0.04, Math.min(h - 0.04, y - 0.05 + r(2) * 1.1));
            // pri holom susedovi (napr. práve prekopanom políčku) tráva nepresahuje cez okraj a ku kraju sa zníži – políčko
            // bez trávy je pekne vykrojené a vidno ho celé
            const bd = bareDist(px, pz, x, y);
            if (bd < 0.06) continue;
            const edge = Math.min(1, bd / 0.45);
            const dn = fbm(px, pz, 11), dk = Math.max(0, Math.min(1, (dn - 0.25) / 0.45));
            if (r(0) > 0.5 + 0.5 * dk * dk * (3 - 2 * dk)) continue;
            // výška aj odtieň sa menia plynulo po ploche (iný šum) – vyššie a tmavšie fľaky, nižšie a svetlejšie
            const hn = fbm(px, pz, 23);
            const th = kind.h * (0.55 + 0.55 * hn + 0.3 * r(3)) * trampled * (0.3 + 0.7 * edge * edge * (3 - 2 * edge));
            R.push(px, gy, pz, Math.round((0.94 + 0.12 * r(7)) * 100) + Math.min(0.999, r(4))); // farebné fľaky robí shader (grassTint)
            S.push(Math.min(th * (1.2 + 0.5 * r(5)), 2 * bd + 0.1), th, ((r(6) * COLS) | 0) / COLS, kind.row / ROWS);
          }
        }
        if (!R.length) continue;
        // V zrkadle hladiny vidno len to, čo je pri vode: bod vo výške v nad hladinou sa zrkadlí najviac v / tan(sklon) blokov
        // od seba. Kusy ďalej od vody sa do zrkadla nekreslia.
        const reach = Math.ceil((gyMax + REACH - o.water.y) / o.water.tan + REACH);
        let mirrored = false;
        for (let y = cy - reach; y < y1 + reach && !mirrored; y++) for (let x = cx - reach; x < x1 + reach; x++) if (isWater(x, y)) { mirrored = true; break; }
        addChunk(R, S, cx, cy, x1, y1, gyMin, gyMax, mirrored);
      }
    }
    maskTex.needsUpdate = true;
    o.maskOn.value = tufts > 0 ? 1 : 0;
  }

  // každú snímku: čas vetra a postavičky, ktoré trávu rozhŕňajú (najbližšie k stredu pohľadu)
  function update(t: number, pushers: readonly GrassPusher[], center: { x: number; z: number }, camera: THREE.Camera): void {
    u.time.value = t % 3600;
    // pohľad sa otočil (štyri strany izometrie) → trsy zoradiť spredu dozadu pre nový smer; počas otáčania stačí staré poradie
    camera.getWorldDirection(viewDir);
    if (viewDir.dot(sortedDir) < RESORT_COS) { sortedDir.copy(viewDir); chunks.forEach(sortChunk); }
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

  function dispose(): void { clearChunks(); material.dispose(); tex.dispose(); if (maskTex) maskTex.dispose(); }

  return { build, update, sync, setQuality, get quality() { return quality; }, get stats() { return { chunks: chunks.length, tufts }; }, dispose };
}
