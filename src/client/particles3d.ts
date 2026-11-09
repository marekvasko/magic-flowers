// 3D častice: dážď (kvapky s čľapnutím a kruhmi na vode), sneh (vločky dopadnú na konkrétne miesto a roztopia sa), oheň pod kotlíkom (plamene, iskry, dym),
// víly s trblietavou stopou, padajúce lístie zo stromov a hlinka pri hľadaní semienok v tráve. Všetko je vo svete (nie na obrazovke),
// takže častice sa hýbu s kamerou, zakrývajú ich budovy a padajú na zem.
import * as THREE from 'three';
import * as W from '../shared/world3d.ts';
import type { FineInfo, Grid } from '../shared/world3d.ts';
import { must } from '../shared/util.ts';
import type { FxFairy, ViewState } from './state.ts';

export type RGB = readonly [number, number, number];
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]): T => must(a[(Math.random() * a.length) | 0]);
const hex = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// tvar bodu: 0 = žiara (mäkký kruh), 1 = štvorček (lístok, kvapka), 2 = mäkký disk (dym)
const GLOW = 0, PIXEL = 1, SOFT = 2;
type Shape = typeof GLOW | typeof PIXEL | typeof SOFT;
const PTS_VERT = `
attribute vec3 color; attribute float size; attribute float alpha; attribute float shape;
uniform float pxPerUnit;
varying vec3 vColor; varying float vAlpha; varying float vShape;
void main() {
  vColor = color; vAlpha = alpha; vShape = shape;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.5, size * pxPerUnit);
}`;
const PTS_FRAG = `
precision mediump float;
varying vec3 vColor; varying float vAlpha; varying float vShape;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0, a;
  if (vShape < 0.5) a = pow(max(0.0, 1.0 - d), 1.7);
  else if (vShape < 1.5) a = 1.0;
  else a = smoothstep(1.0, 0.35, d);
  if (a * vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;
const RAIN_VERT = `
attribute float alpha; attribute vec3 color;
varying float vAlpha; varying vec3 vColor;
void main() { vAlpha = alpha; vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RAIN_FRAG = `
precision mediump float;
varying float vAlpha; varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, vAlpha); }`;

// Zásobník bodových častíc s jedným spôsobom miešania (žiara sa sčítava, dym a lístie sa prekrývajú)
interface PointPool {
  mat: THREE.ShaderMaterial; cap: number; toCam: THREE.Vector3;
  begin: () => void;
  put: (x: number, y: number, z: number, c: RGB, s: number, a: number, sh: Shape, bias?: number) => void;
  end: () => void;
}
function pointPool(scene: THREE.Scene, cap: number, blending: THREE.Blending): PointPool {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 3), size = new Float32Array(cap), alpha = new Float32Array(cap), shape = new Float32Array(cap);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('shape', new THREE.BufferAttribute(shape, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({ vertexShader: PTS_VERT, fragmentShader: PTS_FRAG, uniforms: { pxPerUnit: { value: 50 } }, transparent: true, depthWrite: false, blending });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; pts.layers.set(1); pts.renderOrder = 20;
  scene.add(pts);
  let n = 0;
  const toCam = new THREE.Vector3();
  return {
    mat, cap, toCam,
    begin() { n = 0; },
    // bias: posun ku kamere – pri ortogonálnej kamere mení len hĺbku, nie miesto na obrazovke
    // (veľký bod má jednu hĺbku, bez posunu by ho celý zakryla zem pred ním alebo hrniec)
    put(x, y, z, c, s, a, sh, bias) {
      if (n >= cap || a <= 0) return;
      if (bias) { x += toCam.x * bias; y += toCam.y * bias; z += toCam.z * bias; }
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
      size[n] = s; alpha[n] = Math.min(1, a); shape[n] = sh; n++;
    },
    end() {
      for (const k of ['position', 'color', 'size', 'alpha', 'shape']) must(geo.attributes[k]).needsUpdate = true;
      geo.setDrawRange(0, n);
    }
  };
}

// Častice stoja na zemi (výška z mriežky sveta), poloha a rozmer kamery, cieľ kamery (okolo hráča) a ovzdušie
export interface ParticleCtx {
  // fineBox(i) = obal i-teho jemného modelu vo svete (lístie padá z koruny stromu)
  grid: Grid | null; fine: FineInfo[] | null; fineBox: (i: number) => THREE.Box3 | undefined; target: THREE.Vector3; viewW: number; viewH: number;
  se: number; min: number; lit: RGB; cauldron: { x: number; y: number; z: number } | null; lantern: { x: number; y: number; z: number } | null;
}
export interface ParticlesInit { scene: THREE.Scene; camera: THREE.OrthographicCamera; renderer: THREE.WebGLRenderer; S: ViewState; ripple: (x: number, z: number, k: number) => void }
export interface Particles {
  update: (dt: number, t: number, ctx: ParticleCtx) => void;
  fairyLights: (grid: Grid | null, t: number, add: (x: number, y: number, z: number, r: number) => void) => void;
  setQuality: (q: string) => void;
  readonly quality: string;
}
interface Flame { x: number; y: number; z: number; vx: number; vz: number; vy: number; life: number; max: number; s: number; ph: number }
interface Ember { x: number; y: number; z: number; vx: number; vz: number; vy: number; life: number; max: number; ph: number }
interface Smoke { x: number; y: number; z: number; vy: number; life: number; max: number }
interface Spark { x: number; y: number; z: number; vy: number; life: number; max: number; c: RGB; ph: number }
interface Leaf { x: number; y: number; z: number; vy: number; ph: number; sw: number; life: number; rest: number; c: RGB; s: number }
interface Splash { x: number; y: number; z: number; vx: number; vz: number; vy: number; life: number; max: number }
interface Dig { x: number; y: number; z: number; vx: number; vz: number; vy: number; life: number; rest: number; c: RGB; s: number }
interface Fly { x: number; y: number; z: number; r: number; w: RGB; ph: RGB; blink: number; bp: number; a: number; out: boolean }
interface Drop { x: number; y: number; z: number; v: number }
interface Flake { x: number; y: number; z: number; v: number; ph: number; sw: number; s: number; rest: number; out: boolean }
export function createParticles({ scene, camera, renderer, S, ripple }: ParticlesInit): Particles {
  const glow = pointPool(scene, 1400, THREE.AdditiveBlending);
  const soft = pointPool(scene, 900, THREE.NormalBlending);
  const snowPool = pointPool(scene, 700, THREE.NormalBlending);

  // ---------- Kvalita (nastavenie zariadenia): na telefóne predvolene menej častíc ----------
  const QUALITY = ['low', 'high'];
  let quality = matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
  try { const q = localStorage.getItem('mfParticles'); if (q && QUALITY.includes(q)) quality = q; } catch { /* súkromné okno bez úložiska */ }
  function setQuality(q: string): void { if (!QUALITY.includes(q)) return; quality = q; try { localStorage.setItem('mfParticles', q); } catch { /* súkromné okno bez úložiska */ } }
  const k = () => (quality === 'high' ? 1 : 0.45);

  // ---------- Dážď: pásiky orientované ku kamere (čiary vo WebGL majú len 1 px) ----------
  const RAIN_MAX = 800;
  const rainGeo = new THREE.BufferGeometry();
  const rPos = new Float32Array(RAIN_MAX * 4 * 3), rAlpha = new Float32Array(RAIN_MAX * 4), rCol = new Float32Array(RAIN_MAX * 4 * 3);
  const rIdx: number[] = [];
  for (let i = 0; i < RAIN_MAX; i++) { const v = i * 4; rIdx.push(v, v + 1, v + 2, v, v + 2, v + 3); }
  rainGeo.setIndex(rIdx);
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3).setUsage(THREE.DynamicDrawUsage));
  rainGeo.setAttribute('alpha', new THREE.BufferAttribute(rAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  rainGeo.setAttribute('color', new THREE.BufferAttribute(rCol, 3).setUsage(THREE.DynamicDrawUsage));
  const rainMesh = new THREE.Mesh(rainGeo, new THREE.ShaderMaterial({ vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  rainMesh.frustumCulled = false; rainMesh.layers.set(1); rainMesh.renderOrder = 21;
  scene.add(rainMesh);
  const drops: Drop[] = [];
  const WIND = 1.6, FALL = 13, TOP = 8;
  let lastRipple = 0;

  // ---------- Sneh: vločky padajú pomaly, kolíšu sa, dopadnú na zem a chvíľu na nej ležia ----------
  const SNOW_MAX = 520, SNOW_FALL = 1.1, SNOW_WIND = 0.35, SNOW_TOP = 9, SNOW_REST = 2.5;
  const SNOW_COL: RGB = [0.97, 0.98, 1];
  let flakes: Flake[] = [];

  // ---------- Stav častíc ----------
  let flames: Flame[] = [], embers: Ember[] = [], smoke: Smoke[] = [], sparks: Spark[] = [], leaves: Leaf[] = [], splashes: Splash[] = [], digs: Dig[] = [];
  const DIG_COLS = ['#7a4a20', '#5b3a1a', '#74b84a', '#9b7b45'].map(hex);
  let fireAcc = 0, emberAcc = 0, smokeAcc = 0;
  // svetlušky: domovy pri stromoch, jazierku a hubovom kruhu (prepočítajú sa, keď sa zmení mapa)
  let flies: Fly[] = [], homes: { x: number; z: number; water: boolean }[] = [], homesSig = '';
  const FLY_COL: RGB = [0.78, 1, 0.32], FLY_HOME = new Set(['tree', 'water', 'shroom']);
  function flyHomes(): void {
    const sig = (S.tilesGen || 0) + ':' + S.tiles.length + ':' + S.tiles.reduce((n, t) => n + (FLY_HOME.has(t.g) ? 1 : 0), 0);
    if (sig === homesSig) return;
    homesSig = sig; homes = [];
    S.tiles.forEach((t, i) => { if (FLY_HOME.has(t.g)) homes.push({ x: i % S.W + 0.5, z: ((i / S.W) | 0) + 0.5, water: t.g === 'water' }); });
  }
  const FLAME_HOT: RGB = [1, 0.95, 0.62], FLAME_MID: RGB = [1, 0.55, 0.14], FLAME_END: RGB = [0.75, 0.16, 0.05];
  const RAIN_COL: RGB = [0.72, 0.82, 0.98], SMOKE_COL: RGB = [0.55, 0.55, 0.58], SPLASH_COL: RGB = [0.75, 0.86, 1];
  const fairyCol = new Map<string, RGB>();
  const colOf = (c: string): RGB => { let v = fairyCol.get(c); if (!v) { v = hex(c); fairyCol.set(c, v); } return v; };

  // kvapky živice v modeli obrovského stromu (vrch každého pramienka, v blokoch od rohu modelu) – raz pre každý tvar
  const sapCache = new WeakMap<Uint8Array, [number, number, number, number][]>();
  function sapDrops(f: FineInfo): [number, number, number, number][] {
    let out = sapCache.get(f.data);
    if (out) return out;
    out = [];
    const { sx, sy, sz, data } = f, SAP = W.M.SAP, F = W.FINE, at = (x: number, y: number, z: number): number | undefined => data[(z * sy + y) * sx + x];
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy - 1; y++) for (let x = 0; x < sx; x++)
      if (at(x, y, z) === SAP && at(x, y + 1, z) !== SAP) out.push([(x + 0.5) / F, (y + 0.5) / F, (z + 0.5) / F, (x * 7 + z * 13 + y) % 6.28]);
    sapCache.set(f.data, out);
    return out;
  }
  const camRight = new THREE.Vector3();
  const tileAt = (x: number, z: number): number => { const tx = Math.floor(x), tz = Math.floor(z); return tx >= 0 && tz >= 0 && tx < S.W && tz < S.H ? tz * S.W + tx : -1; };
  const groundAt = (grid: Grid | null, x: number, z: number): number => { const i = tileAt(x, z); return i < 0 || !grid ? 0 : W.surfaceY(grid, i % S.W, (i / S.W) | 0); };

  // poloha víly (obieha okolo stredu z S.fx, len v teréne a s výškou)
  function fairyPos(grid: Grid | null, p: FxFairy): { x: number; y: number; z: number } {
    const ang = p.a + p.life * 1.6;
    const x = p.cx + Math.cos(ang) * p.rad, z = p.cy + Math.sin(ang * 1.3) * p.rad * 0.8;
    const y = groundAt(grid, p.cx, p.cy) + 0.85 + Math.sin(ang * 2.1 + p.a) * 0.3;
    return { x, y, z };
  }

  // Víly ako svetlá v noci (volá sa pri skladaní zoznamu svetiel)
  function fairyLights(grid: Grid | null, _t: number, add: (x: number, y: number, z: number, r: number) => void): void {
    for (const p of S.fx) if (p.fairy) { const f = fairyPos(grid, p); add(f.x, f.y, f.z, 1.5 * Math.min(1, p.life * 2, (p.max - p.life) * 2)); }
  }

  // ctx: { grid, fine, fineMeshes, target, viewW, viewH, se, lit, cauldron }
  function update(dt: number, t: number, ctx: ParticleCtx): void {
    const { grid, target, se, lit } = ctx;
    const q = k();
    const span = Math.max(ctx.viewW, ctx.viewH * 1.75) / 2 + 1.5; // polovica štvorca okolo hráča, kde sa častice oplatí počítať
    const near = (x: number, z: number, m = 0): boolean => Math.abs(x - target.x) < span + m && Math.abs(z - target.z) < span + m;
    const litC = (c: RGB): RGB => [c[0] * lit[0], c[1] * lit[1], c[2] * lit[2]];
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = buf.y / (camera.top - camera.bottom);
    for (const pool of [glow, soft, snowPool]) must(pool.mat.uniforms['pxPerUnit']).value = px;
    glow.toCam.copy(camera.position).sub(target).normalize(); soft.toCam.copy(glow.toCam);
    glow.begin(); soft.begin(); snowPool.begin();

    // ---- oheň pod kotlíkom: plamene (krátke, olizujú hrniec zospodu), iskry, dym ----
    const fc = ctx.cauldron;
    if (fc && near(fc.x, fc.z, 2)) {
      // žiara ohniska – pulzuje spolu so svetlom
      const pulse = 0.8 + 0.2 * Math.sin(t * 9.1) * Math.sin(t * 5.3 + 1);
      glow.put(fc.x, fc.y + 0.08, fc.z, [1, 0.5, 0.15], 1.1, 0.28 * pulse, GLOW, 0.7);
      fireAcc += dt * 45 * q;
      while (fireAcc > 1) {
        fireAcc--;
        // časť plameňov horí pod hrncom, časť olizuje jeho boky (hrniec má polomer ~0,45)
        const a = Math.random() * 6.283, r = Math.random() < 0.45 ? rnd(0, 0.25) : rnd(0.32, 0.5);
        flames.push({ x: fc.x + Math.cos(a) * r, y: fc.y + rnd(0, 0.05), z: fc.z + Math.sin(a) * r, vx: Math.cos(a) * 0.1, vz: Math.sin(a) * 0.1, vy: rnd(0.5, 0.9), life: 0, max: rnd(0.4, 0.75), s: rnd(0.1, 0.14), ph: Math.random() * 9 });
      }
      emberAcc += dt * 4 * q;
      while (emberAcc > 1) {
        emberAcc--;
        const a = Math.random() * 6.283;
        embers.push({ x: fc.x + Math.cos(a) * 0.45, y: fc.y + 0.1, z: fc.z + Math.sin(a) * 0.45, vx: Math.cos(a) * 0.15 + rnd(-0.1, 0.1), vz: Math.sin(a) * 0.15 + rnd(-0.1, 0.1), vy: rnd(0.6, 1.1), life: 0, max: rnd(1, 1.9), ph: Math.random() * 9 });
      }
      smokeAcc += dt * 1.6 * q;
      while (smokeAcc > 1) {
        smokeAcc--;
        const a = Math.random() * 6.283;
        smoke.push({ x: fc.x + Math.cos(a) * 0.4, y: fc.y + 0.35, z: fc.z + Math.sin(a) * 0.4, vy: rnd(0.3, 0.45), life: 0, max: rnd(2.2, 3.2) });
      }
    }
    // ---- plamienok v lampáši na trhu: blčí vo vnútri, občas z neho vyletí iskra ----
    const lt = ctx.lantern;
    if (lt && near(lt.x, lt.z, 2)) {
      const fl = 0.75 + 0.25 * Math.sin(t * 11.3) * Math.sin(t * 6.7 + 2) + 0.1 * Math.sin(t * 29);
      glow.put(lt.x, lt.y, lt.z, [1, 0.6, 0.2], 0.8, 0.45 * fl, GLOW, 0.4);
      glow.put(lt.x, lt.y + 0.01, lt.z, [1, 0.85, 0.45], 0.24, 0.9 * fl, GLOW, 0.4);
      // jazýček plameňa z dvoch minikociek: spodná oranžová, vrchná žltá (kmitá do strán a do výšky)
      const sway = Math.sin(t * 9.7) * 0.012;
      soft.put(lt.x, lt.y - 0.02, lt.z, FLAME_MID, 0.09, 1, PIXEL, 0.4);
      soft.put(lt.x + sway, lt.y + 0.045 + 0.015 * fl, lt.z, FLAME_HOT, 0.06 * fl + 0.015, 1, PIXEL, 0.42);
      if (Math.random() < dt * 1.2 * q) embers.push({ x: lt.x, y: lt.y + 0.12, z: lt.z, vx: rnd(-0.08, 0.08), vz: rnd(-0.08, 0.08), vy: rnd(0.35, 0.6), life: 0, max: rnd(0.7, 1.2), ph: Math.random() * 9 });
    }
    flames = flames.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      const u = p.life / p.max;
      p.x += (p.vx + Math.sin(p.life * 14 + p.ph) * 0.15) * dt; p.z += p.vz * dt; p.y += p.vy * dt; p.vy += dt * 0.6;
      const c = u < 0.4 ? mixc(FLAME_HOT, FLAME_MID, u / 0.4) : mixc(FLAME_MID, FLAME_END, (u - 0.4) / 0.6);
      // plameň = svietiaca minikocka (ako v modeli ohniska), ktorá stúpa a zmenšuje sa, okolo nej jemná žiara
      soft.put(p.x, p.y, p.z, c, p.s * (1 - u * 0.6), u < 0.75 ? 1 : (1 - u) * 4, PIXEL, 0.3);
      glow.put(p.x, p.y, p.z, c, p.s * 2.4, 0.35 * (1 - u), GLOW, 0.3);
      return true;
    });
    embers = embers.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      const u = p.life / p.max;
      p.x += (p.vx + Math.sin(p.life * 5 + p.ph) * 0.25) * dt; p.z += (p.vz + Math.cos(p.life * 4 + p.ph) * 0.25) * dt; p.y += p.vy * dt; p.vy *= 1 - dt * 0.6;
      glow.put(p.x, p.y, p.z, mixc([1, 0.8, 0.35], [1, 0.3, 0.05], u), 0.05, (1 - u) * (0.7 + 0.3 * Math.sin(p.life * 25 + p.ph)), GLOW);
      return true;
    });
    smoke = smoke.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      const u = p.life / p.max;
      p.y += p.vy * dt; p.x += 0.12 * dt; // jemný vietor
      soft.put(p.x, p.y, p.z, litC(SMOKE_COL), 0.15 + u * 0.4, 0.22 * Math.min(1, u * 5) * (1 - u), SOFT);
      return true;
    });

    // ---- víly: žiara, biele jadro, mihajúce sa krídelká a trblietavá stopa ----
    for (const p of S.fx) {
      if (!p.fairy) continue;
      const f = fairyPos(grid, p), c = colOf(p.color);
      const a = Math.min(1, p.life * 2, (p.max - p.life) * 2);
      glow.put(f.x, f.y, f.z, c, 0.6, 0.6 * a, GLOW);
      glow.put(f.x, f.y, f.z, [1, 1, 1], 0.16, a, GLOW);
      const wing = 0.08 + 0.05 * Math.abs(Math.sin(t * 28 + p.a * 5));
      for (const sd of [-1, 1]) glow.put(f.x + camRight.x * sd * 0.07, f.y + 0.04, f.z + camRight.z * sd * 0.07, [0.85, 0.95, 1], wing, 0.7 * a, GLOW);
      if (Math.random() < dt * 22 * q) sparks.push({ x: f.x + rnd(-0.05, 0.05), y: f.y + rnd(-0.05, 0.05), z: f.z + rnd(-0.05, 0.05), vy: -rnd(0.1, 0.3), life: 0, max: rnd(0.6, 1.1), c: mixc(c, [1, 1, 1], Math.random() * 0.6), ph: Math.random() * 9 });
    }
    sparks = sparks.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      const u = p.life / p.max;
      p.y += p.vy * dt;
      glow.put(p.x, p.y, p.z, p.c, 0.07 * (1 - u * 0.5), (1 - u) * (0.55 + 0.45 * Math.sin(p.life * 22 + p.ph)), GLOW);
      return true;
    });

    // ---- Les divov: svietiaca živica na obrovských stromoch – jemná žltá žiara okolo každej kvapky, pomaly pulzuje ----
    if (ctx.fine) for (const f of ctx.fine) {
      if (f.type !== 'giant' || !near(f.ox + 1.5, f.oz + 1.5, 1)) continue;
      for (const [x, y, z, ph] of sapDrops(f)) {
        const pulse = 0.65 + 0.35 * Math.sin(t * 1.3 + ph);
        glow.put(f.ox + x, f.oy + y, f.oz + z, [1, 0.78, 0.22], 0.8, 0.6 * pulse, GLOW, 0.35);
      }
    }

    // ---- lístie: na jeseň veľa, v lete občas, na jar okvetné lístky z jabloní, v zime nič ----
    if (se !== 3 && ctx.fine) {
      ctx.fine.forEach((f, i) => {
        if (f.type !== 'tree') return;
        const mats = W.leafMats(String(f.kind), se), b = ctx.fineBox(i);
        if (!mats || !b || !near(f.ox + 1, f.oz + 1, 1)) return;
        const rate = (se === 2 ? 0.9 : se === 0 && f.kind === 'jablon' ? 0.4 : 0.06) * q;
        if (Math.random() >= dt * rate) return;
        const w = b.max.x - b.min.x, d = b.max.z - b.min.z, h = b.max.y - b.min.y;

        const mat = pick(mats);
        leaves.push({
          x: rnd(b.min.x + w * 0.2, b.max.x - w * 0.2), y: rnd(b.min.y + h * 0.5, b.max.y - h * 0.15), z: rnd(b.min.z + d * 0.2, b.max.z - d * 0.2),
          vy: -rnd(0.3, 0.5), ph: Math.random() * 9, sw: rnd(0.3, 0.6), life: 0, rest: -1, c: hex(W.colorOf(mat, se)), s: rnd(0.13, 0.17)
        });
      });
    }
    leaves = leaves.filter(p => {
      p.life += dt;
      if (p.rest < 0) {
        p.x += (0.2 + Math.sin(p.life * 1.7 + p.ph) * p.sw) * dt;
        p.z += Math.cos(p.life * 1.3 + p.ph) * p.sw * 0.6 * dt;
        p.y += p.vy * (0.75 + 0.35 * Math.sin(p.life * 3.4 + p.ph)) * dt;
        const g = groundAt(grid, p.x, p.z);
        if (p.y <= g + 0.01) { p.y = g + 0.01; p.rest = 0; }
        if (p.life > 25) return false;
      } else if ((p.rest += dt) > 4) return false;
      // lístok sa pri páde preklápa – striedavo svieti a tmavne jeho plocha
      const flip = p.rest < 0 ? 0.7 + 0.3 * Math.sin(p.life * 6 + p.ph) : 0.8;
      const a = p.rest < 0 ? Math.min(1, p.life * 3) : Math.min(1, 4 - p.rest);
      soft.put(p.x, p.y, p.z, mixc([0, 0, 0], litC(p.c), flip), p.s * (p.rest < 0 ? 0.7 + 0.3 * Math.abs(Math.sin(p.life * 3 + p.ph)) : 1), a, PIXEL);
      return true;
    });

    // ---- svetlušky: len v noci, najviac v lete, v zime žiadne; blikajú a pomaly krúžia ----
    const dark = Math.max(0, 1 - W.daylight(ctx.min) / 0.35);
    const flyWant = se === 3 || S.weather === 'rain' ? 0 : Math.round((se === 1 ? 45 : 18) * dark * q);
    if (flyWant) flyHomes();
    if (flies.length < flyWant && homes.length) {
      const cand = homes.filter(h => near(h.x, h.z));
      if (cand.length) {
        const h = pick(cand), x = h.x + rnd(-1.2, 1.2), z = h.z + rnd(-1.2, 1.2);
        flies.push({ x, z, y: (h.water ? W.WATER_Y : groundAt(grid, x, z)) + rnd(0.3, 1.3), r: rnd(0.3, 0.8), w: [rnd(0.2, 0.5), rnd(0.3, 0.7), rnd(0.2, 0.5)], ph: [rnd(0, 9), rnd(0, 9), rnd(0, 9)], blink: rnd(1.3, 2.6), bp: rnd(0, 9), a: 0, out: false });
      }
    }
    for (const f of flies.slice(flyWant)) f.out = true;
    flies = flies.filter(f => {
      f.a = Math.max(0, Math.min(1, f.a + (f.out || !near(f.x, f.z, 1) ? -dt : dt * 0.5)));
      if (f.out && f.a <= 0) return false;
      if (!near(f.x, f.z, 1) && f.a <= 0) return false;
      const x = f.x + Math.sin(t * f.w[0] + f.ph[0]) * f.r, y = f.y + Math.sin(t * f.w[1] + f.ph[1]) * 0.18, z = f.z + Math.cos(t * f.w[2] + f.ph[2]) * f.r;
      // blik: krátke rozsvietenie, potom tma (zostane slabý odlesk, aby svetluška nezmizla úplne)
      const b = Math.pow(Math.max(0, Math.sin(t * 6.283 / f.blink + f.bp)), 3);
      glow.put(x, y, z, FLY_COL, 0.6, f.a * (0.1 + 0.9 * b), GLOW);
      glow.put(x, y, z, [1, 1, 0.75], 0.1, f.a * (0.3 + 0.7 * b), GLOW);
      return true;
    });

    // ---- dážď ----
    const raining = S.weather === 'rain';
    const want = raining ? Math.round(RAIN_MAX * q) : 0;
    while (drops.length < want) drops.push({ x: target.x + rnd(-span, span), z: target.z + rnd(-span, span), y: rnd(0, TOP) + target.y, v: rnd(0.85, 1.15) });
    if (drops.length > want) drops.length = want;
    const now = performance.now();
    let n = 0;
    const rc = litC(RAIN_COL), hw = 0.013; // polovica šírky pásika vo svete (~1–2 px)
    for (const p of drops) {
      p.y -= FALL * p.v * dt; p.x += WIND * p.v * dt;
      // prúžok štvorca okolo hráča – kvapky, ktoré z neho vyjdú, sa objavia na druhej strane
      if (p.x - target.x > span) p.x -= 2 * span; else if (p.x - target.x < -span) p.x += 2 * span;
      if (p.z - target.z > span) p.z -= 2 * span; else if (p.z - target.z < -span) p.z += 2 * span;
      const g = groundAt(grid, p.x, p.z);
      if (p.y <= g) {
        const ti = tileAt(p.x, p.z);
        if (ti >= 0 && S.tiles[ti]?.g === 'water') {
          if (now - lastRipple > 280) { lastRipple = now; ripple(p.x, p.z, 0.3); }
        } else if (Math.random() < 0.35 * q) {
          for (let j = 0; j < 2; j++) splashes.push({ x: p.x, y: g + 0.02, z: p.z, vx: rnd(-0.5, 0.5), vz: rnd(-0.5, 0.5), vy: rnd(0.7, 1.2), life: 0, max: 0.28 });
        }
        p.y = g + TOP + rnd(0, 2); p.x = target.x + rnd(-span, span); p.z = target.z + rnd(-span, span);
      }
      // kvapka = pásik od hlavy dozadu po smere pádu
      const tx = p.x - WIND * 0.035, ty = p.y + FALL * 0.035, o = n * 12, ox = camRight.x * hw, oz = camRight.z * hw;
      rPos[o] = p.x - ox; rPos[o + 1] = p.y; rPos[o + 2] = p.z - oz;
      rPos[o + 3] = p.x + ox; rPos[o + 4] = p.y; rPos[o + 5] = p.z + oz;
      rPos[o + 6] = tx + ox; rPos[o + 7] = ty; rPos[o + 8] = p.z + oz;
      rPos[o + 9] = tx - ox; rPos[o + 10] = ty; rPos[o + 11] = p.z - oz;
      for (let j = 0; j < 4; j++) { rAlpha[n * 4 + j] = j < 2 ? 0.55 : 0.05; rCol.set(rc, (n * 4 + j) * 3); }
      n++;
    }
    for (const k2 of ['position', 'alpha', 'color']) must(rainGeo.attributes[k2]).needsUpdate = true;
    rainGeo.setDrawRange(0, n * 6);
    rainMesh.visible = n > 0;
    splashes = splashes.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      p.vy -= 9 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;
      soft.put(p.x, p.y, p.z, litC(SPLASH_COL), 0.04, 0.7 * (1 - p.life / p.max), PIXEL);
      return true;
    });

    // ---- sneh: počasie „sneh“ alebo v zime občasné sneženie (nie počas dažďa) ----
    const snowing = !raining && (S.weather === 'snow' || (se === 3 && Math.sin(t * 0.1) > 0.5));
    const snowWant = snowing ? Math.round(SNOW_MAX * q) : 0;
    // nové vločky sa objavia v rôznej výške, aby sneženie nezačalo naraz celou vrstvou
    while (flakes.length < snowWant) flakes.push(newFlake(rnd(0, SNOW_TOP)));
    function newFlake(h: number): Flake {
      const x = target.x + rnd(-span, span), z = target.z + rnd(-span, span);
      return { x, z, y: groundAt(grid, x, z) + h, v: rnd(0.7, 1.3), ph: Math.random() * 9, sw: rnd(0.15, 0.4), s: rnd(0.09, 0.14), rest: -1, out: false };
    }
    // keď prestane snežiť, vločky dopadajú ďalej, len sa už nevracajú hore
    for (const f of flakes.slice(snowWant)) f.out = true;
    const sc = litC(SNOW_COL);
    flakes = flakes.filter(p => {
      if (p.rest < 0) {
        p.y -= SNOW_FALL * p.v * dt;
        p.x += (SNOW_WIND + Math.sin(t * 1.3 + p.ph) * p.sw) * dt;
        p.z += Math.cos(t * 0.9 + p.ph * 1.7) * p.sw * 0.7 * dt;
        // vločka mimo štvorca okolo hráča sa objaví na druhej strane
        if (p.x - target.x > span) p.x -= 2 * span; else if (p.x - target.x < -span) p.x += 2 * span;
        if (p.z - target.z > span) p.z -= 2 * span; else if (p.z - target.z < -span) p.z += 2 * span;
        const ti = tileAt(p.x, p.z), water = ti >= 0 && S.tiles[ti]?.g === 'water';
        const g = water ? W.WATER_Y : groundAt(grid, p.x, p.z);
        // za okrajom ostrova niet kam dopadnúť – vločka padá ďalej dolu a potom sa vráti hore
        if (ti < 0) { if (p.y < target.y - 8) p.rest = SNOW_REST; }
        else if (p.y <= g + 0.01) {
          p.y = g + 0.01;
          p.rest = water ? SNOW_REST - 0.3 : 0; // na vode sa roztopí hneď
        }
      } else p.rest += dt;
      if (p.rest >= SNOW_REST) {
        if (p.out) return false;
        Object.assign(p, newFlake(SNOW_TOP + rnd(0, 2)));
      }
      const a = p.rest < 0 ? 0.95 : 0.95 * Math.min(1, (SNOW_REST - p.rest) / 1.2);
      snowPool.put(p.x, p.y, p.z, sc, p.rest < 0 ? p.s : p.s * 1.15, a, SOFT);
      return true;
    });

    // ---- hľadanie semienok: zo stredu hľadaného políčka jemne odletuje hlinka a tráva sprava doľava (na obrazovke) ----
    const diggers = [S.mySi, ...[...S.others.values()].map(o => o.si)].filter((si): si is number => si != null && si >= 0);

    for (const si of diggers) {
      const x = si % S.W + 0.5, z = ((si / S.W) | 0) + 0.5;
      if (!near(x, z) || Math.random() >= dt * 12 * q) continue;
      const v = rnd(0.4, 1);
      digs.push({ x, z, y: groundAt(grid, x, z) + 0.03, vx: -camRight.x * v + rnd(-0.1, 0.1), vz: -camRight.z * v + rnd(-0.1, 0.1), vy: rnd(0.5, 0.9), life: 0, rest: -1, c: pick(DIG_COLS), s: rnd(0.03, 0.045) });
    }
    digs = digs.filter(p => {
      p.life += dt;
      if (p.rest < 0) {
        p.vy -= 5 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;
        const g = groundAt(grid, p.x, p.z);
        if (p.y <= g + 0.01) { p.y = g + 0.01; p.rest = 0; }
      } else if ((p.rest += dt) > 0.6) return false;
      soft.put(p.x, p.y, p.z, litC(p.c), p.s, p.rest < 0 ? 1 : 1 - p.rest / 0.6, PIXEL);
      return true;
    });

    glow.end(); soft.end(); snowPool.end();
  }

  return { update, fairyLights, setQuality, get quality() { return quality; } };
}
