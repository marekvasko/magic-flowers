// 3D pavúky a pavučiny (#57): pavučiny medzi kmeňmi v Lese divov (v tme ich vidno len v dohľade, s lampášom sa lesknú
// kúsok ďalej), nory vlčiakov, kútové pavučiny krížiaka v záhrade a v horách a samotné pavúky (sprity s krokom nôh).
// V tme sú z pavúkov za dohľadom vidno len lesknúce sa oči (kreslia sa do prekrytia).
// render3d.ts volá update() každú snímku a overlay() pri kreslení prekrytia.
// THREE sa odovzdáva (nie import): ladiaca stránka /debug kreslí pavučiny vlastnou kópiou Three.js (do fázy 5c, #137).
import type * as THREE from 'three';
import * as D from '../shared/data.ts';
import * as SM from '../shared/spidermodel.ts';
import type { Layout } from '../shared/spidermodel.ts';
import * as Webs from '../shared/webs.ts';
import type { CornerOpts, CornerWeb, LayoutOpts, Threads, Vec3, WebParams } from '../shared/webs.ts';
import type { FineInfo } from '../shared/world3d.ts';
import type { CornerView, SpiderKind, WebView } from '../shared/protocol.ts';
import { must } from '../shared/util.ts';
import type { ClientState, Spider } from './state.ts';

type Three = typeof THREE;
// Uniformy svetla sveta (render3d.ts – rovnaké objekty ako v shaderi sveta), ktoré číta aj hodváb
// (typ, nie rozhranie: ShaderMaterial berie uniformy ako tabuľku { [meno]: IUniform })
export type SilkWorld = {
  ambient: THREE.IUniform<THREE.Vector3>; sunColor: THREE.IUniform<THREE.Vector3>; sunDir: THREE.IUniform<THREE.Vector3>;
  lampColor: THREE.IUniform<THREE.Vector3>; lights: THREE.IUniform<THREE.Vector4[]>; lightCount: THREE.IUniform<number>;
  darkOn: THREE.IUniform<number>; eye: THREE.IUniform<THREE.Vector4>; eyeLit: THREE.IUniform<THREE.Vector2>;
};
export type ViewUniform = THREE.IUniform<THREE.Vector3>;
export interface LineFrame { res: THREE.IUniform<THREE.Vector2>; time: THREE.IUniform<number> }
// Popis pavučiny pre /debug → Cobwebs (material.userData.info)
interface WebInfo { hubs: number; moor: [number, number]; fill: number; render: 'shader' | 'lines'; segments?: number; copies?: number; hub?: Vec3 | null | undefined; anchors?: Vec3[] | undefined }

// ---------- Shader pavučiny ----------
// Pavučina sa nekreslí z obrázka – vlákna sa počítajú v každom pixeli z polohy na ploche pavučiny (v políčkach).
// Plocha siaha od kmeňa po kmeň (Webs.webGeom), ľavý a pravý okraj sú teda povrchy opôr: lúče končia na kmeňoch,
// kotviace vlákna (moor) idú z bodov na kmeňoch k okraju pavučiny a hore aj dole sa medzi kmeňmi prehýba nosné vlákno.
// Stavba: lúče zo stredu (ohnuté Perlinovým šumom), hustý stred, voľná zóna a výplň – jedna špirála („helical“) alebo
// sústredné kruhy; medzi lúčmi sú závity rovné (mnohouholník), ako v skutočnosti. Všetky čísla sú v Webs.WEB_PARAMS
// (ladí sa v /debug → Generators → Cobwebs). Vlákna sú tenké a vyhladené cez fwidth – tenšie než pixel slabnú, nehrubnú.
// Svetlo zo sveta (rovnaké uniformy ako svet): okolie, slnko, lampáše (guľa okolo zdroja) a slabé svetlo pri hráčovi.
// Hodváb je vlákno, nie plocha: rozptyl aj odlesk podľa smeru vlákna (Kajiya–Kay), odlesk jemne dúhový.
// V tme za dohľadom zmizne ako svet, lampášom osvetlené vlákna sa lesknú o kúsok ďalej.
export const WEB_VERT = `
varying vec2 vP; varying vec3 vPos; varying vec3 vAx; varying vec3 vAy;
uniform vec2 uSize; uniform vec4 uPush;
// naťahovanie: hráč sa do pavučiny zaboril (uPush = poloha pozdĺž, výška, hĺbka za rovinou, polomer; w = 0 → nič);
// vydutie okolo hráča a celá pavučina sa trochu prehne, kotvy na kmeňoch (s = 0 a 1) stoja
float pushAt(vec3 p, vec2 size) {
  if (uPush.w <= 0.0) return 0.0;
  float s = clamp(p.x / size.x + 0.5, 0.0, 1.0), t = clamp(p.y / size.y + 0.5, 0.0, 1.0);
  vec2 q = vec2(p.x - uPush.x, (p.y - uPush.y) * 0.8);
  float g = exp(-dot(q, q) / (uPush.w * uPush.w));
  float env = sin(3.14159 * s) * (0.4 + 0.6 * sin(3.14159 * t));
  return uPush.z * mix(env, 1.0, g) * env;
}
void main() {
  vec3 p = position;
  p.z += pushAt(p, uSize);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPos = wp.xyz; vP = uv * uSize;
  vAx = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0)); vAy = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
// Svetlo na hodvábe (spoločné pre shader na rovine aj pre čiary): okolie, slnko, lampáše (guľa okolo zdroja), slabé svetlo
// pri hráčovi; vlákno, nie plocha – rozptyl aj odlesk podľa smeru vlákna T (Kajiya–Kay), odlesk jemne dúhový.
// V tme za dohľadom vlákna zmiznú ako svet, lampášom osvetlené ostanú (aj o kúsok ďalej sa lesknú).
const SILK_GLSL = (MAX: number): string => `
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 sunDir; uniform vec3 lampColor;
uniform vec4 lights[${MAX}]; uniform int lightCount;
uniform float darkOn; uniform vec4 eye; uniform vec2 eyeLit;
uniform vec3 uView; uniform float uSeed;
uniform vec4 uC;    // hrúbka vlákna, lesk, dúha, priehľadnosť v šere
vec4 silkShade(vec3 T, vec3 P, float mask, float veil) {
  vec3 V = normalize(uView);
  float lamp = 0.0, spec = 0.0, diff = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= lightCount) break;
    vec3 L = lights[i].xyz - P; float d = length(L); L /= d;
    float att = 1.0 - smoothstep(0.0, lights[i].w, d), attG = 1.0 - smoothstep(0.0, lights[i].w * 1.3, d);
    float tl2 = dot(T, L), th = dot(T, normalize(L + V));
    lamp += att; diff += att * sqrt(max(0.0, 1.0 - tl2 * tl2));
    spec += attG * pow(sqrt(max(0.0, 1.0 - th * th)), uC.y);
  }
  float sl = dot(T, sunDir), sh = dot(T, normalize(sunDir + V));
  float sunK = 1.0 - darkOn * 0.85; // v Lese divov sa slnko cez koruny skoro nedostane
  vec3 silk = vec3(0.86, 0.9, 0.95);
  vec3 col = silk * (ambient * 0.9 + sunColor * sunK * sqrt(max(0.0, 1.0 - sl * sl)) + lampColor * diff * 1.1);
  col += silk * vec3(0.8, 0.85, 1.0) * eyeLit.y * darkOn * (1.0 - smoothstep(0.0, eyeLit.x, distance(P, eye.xyz)));
  vec3 iri = (1.0 - uC.z) + uC.z * cos(vec3(0.0, 2.1, 4.2) + dot(T, V) * 6.0 + uSeed); // jemná dúha v odlesku
  col += (lampColor * spec * 2.2 + sunColor * sunK * pow(sqrt(max(0.0, 1.0 - sh * sh)), uC.y) * 1.5) * iri;
  // závoj kútovej pavučiny: zaprášený, rozptyľuje svetlo zo všetkých strán
  vec3 dust = vec3(0.78, 0.76, 0.72) * (ambient + sunColor * sunK * 0.6 + lampColor * lamp * 0.6);
  float fogK = 0.0;
  if (darkOn > 0.0) fogK = darkOn * smoothstep(eye.w * 0.6, eye.w * 1.15, distance(P.xz, eye.xz)) * (1.0 - clamp(lamp * 1.6 + spec * 4.0, 0.0, 1.0));
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  float aT = mask * clamp(uC.w + lum * 1.3, 0.0, 1.0);
  float a = aT + veil * (1.0 - aT);
  return vec4(min(mix(dust, col, aT / max(a, 1e-3)), vec3(1.6)), a * (1.0 - fogK));
}`;
export const WEB_FRAG = (MAX: number): string => `
precision highp float;
#define TAU 6.28318530718
uniform vec2 uSize; uniform float uKeep;
uniform vec4 uMode; // x výplň (0 špirála, 1 kruhy), z počet lúčov, w rozostup závitov
uniform vec4 uA;    // ohnutie lúčov, jeho frekvencia, zvlnenie závitov, jeho frekvencia
uniform vec4 uB;    // stred, voľná zóna, polomer, šum okraja
uniform vec4 uD;    // šum rozostupu, prehnutie nosných vlákien
uniform vec4 uE;    // rozptyl počtu lúčov, počet stredov, kotviace vlákna na ľavom a pravom kmeni
uniform vec4 uHX; uniform vec4 uHY; // stredy (najviac 4)
${SILK_GLSL(MAX)}
varying vec2 vP; varying vec3 vPos; varying vec3 vAx; varying vec3 vAy;
float gSeed;
float h11(float n) { return fract(sin(n * 127.1 + gSeed * 311.7) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + gSeed * 17.13) * 43758.5453); }
// Perlinov (gradientový) šum
vec2 grad(vec2 i) { float a = TAU * h21(i); return vec2(cos(a), sin(a)); }
float perlin(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f), b = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), d = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// pokrytie pixelu vláknom vo vzdialenosti d (vyhladené, tenšie než pixel slabne)
float thread(float d, float w) {
  float fw = max(fwidth(d), 1e-5), ww = max(w, fw * 0.8);
  return (1.0 - smoothstep(ww * 0.5, ww * 0.5 + fw, d)) * min(1.0, w / ww * 1.8);
}
float segDist(vec2 p, vec2 a, vec2 b) { vec2 ab = b - a; float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0); return length(p - a - ab * t); }
vec2 hub(int i) { return vec2(uHX[i], uHY[i]); }

// Kruhová (orb) pavučina okolo stredu c (jeden z viacerých stredov veľkej pavučiny)
float orb(vec2 p, vec2 c, float cellW, bool inside, out vec2 tl) {
  vec2 q = p - c;
  float r = length(q), a = atan(q.y, q.x);
  float rays = uMode.z + floor(h11(5.0) * (uE.x + 1.0)), W = uC.x;
  float bend = perlin(vec2(r * uA.y, gSeed * 7.1)) * uA.x / max(r * 2.0, 0.6);
  float ab = a + bend;
  float k = floor(ab / (TAU / rays) + 0.5);
  float ar = k * TAU / rays + (h11(k) - 0.5) * (TAU / rays) * 0.35;
  float dt = ab - ar;
  float rMax = (uB.z * min(cellW, uSize.y) + 0.12 * max(cellW - uSize.y, 0.0)) * (1.0 + uB.w * perlin(vec2(a * 1.3, gSeed * 3.7)));
  float mR = inside && r > uB.x * 0.5 && h11(k + 40.0) < uKeep + 0.15 ? thread(r * abs(sin(dt)), W) : 0.0;
  float rp = r * cos(dt) * (1.0 + uA.z * perlin(vec2(ab * uA.w, r * 6.0)));
  float pitch = uMode.w * (1.0 + (h11(9.0) - 0.5) * 0.3) * (1.0 + uD.x * perlin(vec2(r * 3.0, gSeed)));
  float t = uMode.x < 0.5 ? (rp - uB.y) / pitch - (a + 3.14159265) / TAU : (rp - uB.y) / pitch; // špirála / kruhy
  float dS = abs(fract(t + 0.5) - 0.5) * pitch;
  float mS = inside && rp > uB.y && r < rMax && h21(vec2(floor(t + 0.5), k)) < uKeep ? thread(dS, W) : 0.0;
  float mH = r < uB.x ? thread(abs(fract(r / (pitch * 0.3) + 0.5) - 0.5) * pitch * 0.3, W) : 0.0;
  tl = mR >= mS ? vec2(cos(ar), sin(ar)) : vec2(-sin(ar), cos(ar));
  return max(max(mR, mS), mH);
}

void main() {
  gSeed = uSeed;
  vec2 tl = vec2(1.0, 0.0);
  float mask = 0.0, veil = 0.0, W = uC.x;
  {
    float nH = uE.y;
    // najbližší stred (každý stred je samostatná kruhová pavučina, susedné zdieľajú deliace vlákno)
    float d1 = 1e9, d2 = 1e9; int bi = 0; vec2 c1 = hub(0), c2 = hub(0);
    for (int i = 0; i < 4; i++) {
      if (float(i) >= nH) break;
      vec2 ci = hub(i); float d = distance(vP, ci);
      if (d < d1) { d2 = d1; c2 = c1; d1 = d; c1 = ci; bi = i; } else if (d < d2) { d2 = d; c2 = ci; }
    }
    // nosné vlákna hore a dole: medzi kmeňmi (x = 0 a x = šírka), prehnuté
    float s = clamp(vP.x / uSize.x, 0.0, 1.0), sagK = uD.y * 4.0 * s * (1.0 - s);
    float yTop = uSize.y * 0.96 - sagK, yBot = uSize.y * 0.06 + sagK * 0.5;
    bool inside = vP.y < yTop && vP.y > yBot;
    float kf = step(0.5, h21(floor(vP * 2.0)) + uKeep);
    float mF = max(thread(abs(vP.y - yTop), W * 1.3), thread(abs(vP.y - yBot), W)) * kf;
    if (mF > mask) { mask = mF; tl = vec2(1.0, 0.0); }
    // deliace vlákno medzi susednými stredmi (vzdialenosť k osi úsečky medzi nimi)
    if (nH > 1.5 && inside) {
      float mB = thread((d2 * d2 - d1 * d1) / (2.0 * max(distance(c1, c2), 1e-3)), W) * kf;
      if (mB > mask) { mask = mB; vec2 n = normalize(c2 - c1); tl = vec2(-n.y, n.x); }
    }
    gSeed = uSeed + float(bi) * 13.7;
    vec2 to;
    float mO = orb(vP, c1, uSize.x / nH, inside, to);
    if (mO > mask) { mask = mO; tl = to; }
    // kotviace vlákna: náhodne veľa z bodov na ľavom a pravom kmeni k okraju krajného stredu
    gSeed = uSeed;
    for (int sd = 0; sd < 2; sd++) {
      float cnt = sd == 0 ? uE.z : uE.w;
      vec2 c = sd == 0 ? hub(0) : hub(int(nH) - 1);
      float rim = uB.z * min(uSize.x / nH, uSize.y) * 0.92;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= cnt) break;
        float fi = float(i * 2 + sd);
        float fy = (float(i) + 0.5 + (h11(fi + 9.0) - 0.5) * 0.8) / cnt;
        vec2 A = vec2(sd == 0 ? 0.0 : uSize.x, mix(yBot, yTop, fy));
        vec2 B = c + normalize(A - c + vec2(0.0, (h11(fi + 3.0) - 0.5) * 0.4)) * rim;
        float m = thread(segDist(vP, A, B), W);
        if (m > mask) { mask = m; tl = normalize(B - A); }
      }
    }
  }
  if (max(mask, veil) < 0.003) discard;
  gl_FragColor = silkShade(normalize(vAx * tl.x + vAy * tl.y), vPos, mask, veil);
}`;
// Materiál jednej pavučiny: P = Webs.webParams(...), opts = { w, h, seed, keep (0–1 koľko vlákien ostalo) }.
// Veľká pavučina má náhodne veľa stredov (1 … P.hubs, na každý aspoň P.hubSpan políčka šírky) a na každom kmeni
// náhodne veľa kotviacich vlákien (P.moorMin … P.moor).
// world = uniformy svetla (svet v hre, vlastné v ladiacej stránke), view = { value: Vector3 } smer ku kamere.
export function webMaterial(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, opts: LayoutOpts, maxLights: number): THREE.ShaderMaterial {
  return webMaterialParts(THREE, world, view, P, opts, maxLights).mat;
}
function webMaterialParts(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, opts: LayoutOpts, maxLights: number): { mat: THREE.ShaderMaterial; push: THREE.IUniform<THREE.Vector4> } {
  const { w, h } = opts, L = Webs.webLayout(P, opts);
  const hx: [number, number, number, number] = [0, 0, 0, 0], hy: [number, number, number, number] = [0, 0, 0, 0];
  L.hubs.forEach((c, i) => { hx[i] = c.x; hy[i] = c.y; });
  const silk = silkUniforms(THREE, world, view, P, L.seed);
  const mat = new THREE.ShaderMaterial({
    vertexShader: WEB_VERT, fragmentShader: WEB_FRAG(maxLights), transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: Object.assign(silk, {
      uSize: { value: new THREE.Vector2(w, h) }, uKeep: { value: opts.keep ?? 1 },
      uMode: { value: new THREE.Vector4(L.fill, 0, P.rays, L.pitch) },
      uA: { value: new THREE.Vector4(P.bend, P.bendFreq, P.wobble, P.wobbleFreq) },
      uB: { value: new THREE.Vector4(P.hub, P.free, P.radius, P.edgeNoise) },
      uD: { value: new THREE.Vector4(P.pitchNoise, P.sag, 0, 0) },
      uE: { value: new THREE.Vector4(P.raysVar, L.nH, L.moor[0], L.moor[1]) },
      uHX: { value: new THREE.Vector4(...hx) }, uHY: { value: new THREE.Vector4(...hy) }
    })
  });
  mat.userData['info'] = { hubs: L.nH, moor: L.moor, fill: L.fill, render: 'shader' } satisfies WebInfo;
  return { mat, push: silk.uPush };
}
function silkUniforms(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, seed: number): SilkWorld & { uView: ViewUniform; uSeed: THREE.IUniform<number>; uC: THREE.IUniform<THREE.Vector4>; uPush: THREE.IUniform<THREE.Vector4> } {
  return {
    ambient: world.ambient, sunColor: world.sunColor, sunDir: world.sunDir, lampColor: world.lampColor, lights: world.lights, lightCount: world.lightCount,
    darkOn: world.darkOn, eye: world.eye, eyeLit: world.eyeLit, uView: view, uSeed: { value: seed % 97 },
    uC: { value: new THREE.Vector4(P.width, P.glint, P.iri, P.alpha) },
    uPush: { value: new THREE.Vector4(0, 0, 0, 0) } // naťahovanie hráčom (pushAt)
  };
}

// ---------- Pavučina z čiar ----------
// Skutočné 3D vlákna (Webs.webThreads: tie isté parametre, vydutie z roviny) ako úsečky (gl.LINES, 1 pixel).
// Hrúbka: každá úsečka sa nakreslí v copies kópiách (inštancie), vertex shader ich posunie na obrazovke o pixel
// (až po premietnutí, takže svetlo počíta každá kópia z polohy skutočného vlákna); krajné kópie sú slabšie (mäkký okraj).
// Vietor: stred pavučiny sa kýve ako celok (jedno pole posunutia, kotvy na kmeňoch stoja). Svetlo: ten istý silkShade ako shader na rovine.
const LINE_VERT = `
attribute vec3 aT; attribute vec3 aOff;
uniform vec2 uSize; uniform vec2 uRes; uniform float uTime; uniform float uSway; uniform float uPhase; uniform vec4 uPush;
varying vec3 vPos; varying vec3 vT; varying float vEdge;
// naťahovanie: hráč sa do pavučiny zaboril (uPush = poloha pozdĺž, výška, hĺbka za rovinou, polomer; w = 0 → nič);
// vydutie okolo hráča a celá pavučina sa trochu prehne, kotvy na kmeňoch (s = 0 a 1) stoja
float pushAt(vec3 p, vec2 size) {
  if (uPush.w <= 0.0) return 0.0;
  float s = clamp(p.x / size.x + 0.5, 0.0, 1.0), t = clamp(p.y / size.y + 0.5, 0.0, 1.0);
  vec2 q = vec2(p.x - uPush.x, (p.y - uPush.y) * 0.8);
  float g = exp(-dot(q, q) / (uPush.w * uPush.w));
  float env = sin(3.14159 * s) * (0.4 + 0.6 * sin(3.14159 * t));
  return uPush.z * mix(env, 1.0, g) * env;
}
void main() {
  vec3 p = position;
  p.z += pushAt(p, uSize);
  float s = clamp(p.x / uSize.x + 0.5, 0.0, 1.0), t = clamp(p.y / uSize.y + 0.5, 0.0, 1.0);
  // vietor: jedno hladké pole posunutia pre celú pavučinu (len z polohy a fázy pavučiny) – vlákna, ktoré sa stretávajú,
  // sa hýbu spolu a kotvy na kmeňoch (s = 0 a 1) stoja; mierne sa mení aj smer kývania (dve vlny)
  float wind = sin(uTime * 1.7 + uPhase + p.x * 1.1) + 0.45 * sin(uTime * 2.9 + uPhase * 1.7 - p.y * 2.3 + p.x * 0.6);
  p.z += uSway * wind * sin(3.14159 * s) * (0.35 + 0.65 * t);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPos = wp.xyz; vT = normalize(mat3(modelMatrix) * aT); vEdge = aOff.z;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.xy += aOff.xy * 2.0 / uRes * gl_Position.w; // kópia posunutá o pixel na obrazovke
}`;
const LINE_FRAG = (MAX: number): string => `
precision highp float;
${SILK_GLSL(MAX)}
varying vec3 vPos; varying vec3 vT; varying float vEdge;
void main() {
  vec4 c = silkShade(normalize(vT), vPos, vEdge, 0.0);
  if (c.a < 0.003) discard;
  gl_FragColor = c;
}`;
// posuny kópií v pixeloch (z = sila kópie): 1 = len vlákno, 2–4 = hrubšie
const COPIES: readonly (readonly [number, number, number])[] = [[0, 0, 1], [1, 0, 0.6], [0, 1, 0.6], [1, 1, 0.35]];
export function webLines(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, opts: LayoutOpts, maxLights: number, frame: LineFrame): THREE.LineSegments {
  return linesMesh(THREE, world, view, P, Webs.webThreads(P, opts), { w: opts.w, h: opts.h, sway: P.sway }, maxLights, frame).m;
}
// Kútová pavučina (krížiak): 3D trojuholník v kúte (Webs.cornerThreads) – vždy z čiar; súradnice kúta (pozri webs.ts)
export function cornerLines(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, opts: CornerOpts, maxLights: number, frame: LineFrame): THREE.LineSegments {
  return threadLines(THREE, world, view, P, must(Webs.cornerThreads(P, opts) ?? undefined), maxLights, frame);
}
// hotové vlákna (napr. Webs.voxelWeb) ako čiary bez kývania
export function threadLines(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, th: Threads | CornerWeb, maxLights: number, frame: LineFrame): THREE.LineSegments {
  return linesMesh(THREE, world, view, P, th, { w: 1, h: 1, sway: 0 }, maxLights, frame).m;
}
function linesMesh(THREE: Three, world: SilkWorld, view: ViewUniform, P: WebParams, th: Threads | CornerWeb, o: { w: number; h: number; sway: number }, maxLights: number, frame: LineFrame): { m: THREE.LineSegments; push: THREE.IUniform<THREE.Vector4> } {
  const L = th.layout, g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(th.pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(th.tan, 3));
  const n = P.copies, off = COPIES.slice(0, n), cx = off.reduce((s, q) => s + q[0], 0) / n, cy = off.reduce((s, q) => s + q[1], 0) / n;
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(off.flatMap(q => [q[0] - cx, q[1] - cy, q[2]])), 3));
  g.instanceCount = n;
  const silk = silkUniforms(THREE, world, view, P, L.seed);
  const mat = new THREE.ShaderMaterial({
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG(maxLights), transparent: true, depthWrite: false,
    uniforms: Object.assign(silk, {
      uSize: { value: new THREE.Vector2(o.w, o.h) }, uRes: frame.res, uTime: frame.time, uSway: { value: o.sway }, uPhase: { value: (L.seed % 97) * 0.6 }
    })
  });
  const corner = 'hub' in th ? th : null;
  mat.userData['info'] = { hubs: L.nH, moor: L.moor, fill: L.fill, render: 'lines', segments: th.count / 2, copies: n, hub: corner?.hub, anchors: corner?.anchors } satisfies WebInfo;
  const m = new THREE.LineSegments(g, mat);
  m.frustumCulled = false; // vydutie a kývanie mení tvar mimo pôvodnej rovinky
  return { m, push: silk.uPush };
}

// Čo spiders3d potrebuje od 3D pohľadu (render3d.ts)
export interface Spiders3dInit {
  THREE: Three; scene: THREE.Scene; S: ClientState;
  groundY: (x: number, y: number) => number;
  // svetlo v bode (r, g, b) z okolia, slnka a lámp; out.seen = viditeľnosť v tme (0–1)
  lightAt: (x: number, y: number, z: number, lights: readonly THREE.Vector4[], n: number, out: { seen: number }) => [number, number, number];
  spriteTex: (key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => THREE.Texture;
  makeSprite: (w: number, h: number) => THREE.Sprite;
  project: (x: number, y: number, z: number) => { x: number; y: number };
  camera: THREE.Camera; camTarget: THREE.Vector3; renderer: THREE.WebGLRenderer | null; world: SilkWorld; maxLights: number;
  fine: () => readonly FineInfo[] | null;
}
export interface Spiders3d {
  update: (dt: number, t: number, lights: readonly THREE.Vector4[]) => void;
  overlay: (c: CanvasRenderingContext2D, ppb: number, t: number) => void;
  dispose: () => void;
}
// Pavučina vo svete: sieť, uniforma naťahovania a kde visí (stred, výška)
interface WebMesh { m: THREE.Mesh | THREE.LineSegments; push: THREE.IUniform<THREE.Vector4>; wb: WebView; cx: number; cz: number; hgt: number }
// Krížiak v kútovej pavučine: sprite v strede prvej oblasti, normála pavučiny (strana chrbta) a veľkosť
interface CornerSpider { sp: SpiderSprite; at: THREE.Vector3; nrm: THREE.Vector3 | null; ks: number }
// Sprite pavúka: aktuálna snímka (key), miesto očí pre svit v tme, či sa kreslí navrch (pavúk na chrbte hráča)
interface SpriteEye { L: Layout; f: number; s: number; x: number; y: number; z: number }
interface SpiderSprite { sp: THREE.Sprite; key: string; eye: SpriteEye | null; top: boolean }
interface Seen { k: SpiderKind; eye: SpriteEye | null; b: number; hide?: boolean; seen: number; d: number }

export function createSpiders3d({ THREE, scene, S, groundY, lightAt, spriteTex, makeSprite, project, camera, camTarget, renderer, world, maxLights, fine }: Spiders3dInit): Spiders3d {
  const SPI = D.SPIDERS;
  const webMeshes = new Map<number, WebMesh>(), cornerMeshes: THREE.LineSegments[] = [], cornerSpiders: CornerSpider[] = [], burrowMeshes: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[] = [], sprites = new Map<string, SpiderSprite>();
  let builtWebs = -1, builtCorner = -1, builtArea: string | null = null, builtTiles = -1;
  const holeGeo = new THREE.CircleGeometry(0.26, 18);

  function add<O extends THREE.Object3D>(o: O): O { o.layers.set(1); scene.add(o); return o; }
  function drop(o: THREE.Mesh | THREE.LineSegments | THREE.Sprite): void {
    scene.remove(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m.dispose();
    if (o.geometry !== holeGeo && !(o instanceof THREE.Sprite)) o.geometry.dispose(); // geometria spritov je spoločná
  }
  // Pavučina so shaderom; parametre z Webs.webParams (v hre sa dajú skúsiť cez window.MF_WEB = { rays: 20, … })
  const view: ViewUniform = { value: new THREE.Vector3(0, 1, 0) };
  const params = (): WebParams => Webs.webParams(window.MF_WEB);
  const frame: LineFrame = { res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 } }; // pre pavučiny z čiar
  function webPlane(w: number, h: number, seed: number, keep: number): { m: THREE.Mesh | THREE.LineSegments; push: THREE.IUniform<THREE.Vector4> } {
    const P = params(), opts = { w, h, seed, keep };
    let r: { m: THREE.Mesh | THREE.LineSegments; push: THREE.IUniform<THREE.Vector4> };
    if (P.render === 1) r = linesMesh(THREE, world, view, P, Webs.webThreads(P, opts), { w, h, sway: P.sway }, maxLights, frame);
    else { const wm = webMaterialParts(THREE, world, view, P, opts, maxLights); r = { m: new THREE.Mesh(new THREE.PlaneGeometry(w, h, 32, 16), wm.mat), push: wm.push }; } // delená, aby sa dala natiahnuť
    r.m.renderOrder = 2;
    add(r.m);
    return r;
  }

  // ---- pavučiny a nory (Les divov) ----
  function buildWebs(): void {
    for (const w of webMeshes.values()) drop(w.m);
    webMeshes.clear();
    for (const m of burrowMeshes) drop(m);
    burrowMeshes.length = 0;
    if (S.area !== 'les') return;
    for (const wb of S.webs) {
      // od kmeňa po kmeň (vlákna začínajú na oporách), pri nízkom kríku či spadnutom kmeni nižšia
      const g = Webs.webGeom(S.tiles, S.W, S.H, wb, window.MF_WEB);
      const { m, push } = webPlane(g.len, g.hgt, wb.id, wb.silk >= 3 ? 1 : wb.silk === 2 ? 0.72 : 0.42);
      const mid = (g.u0 + g.u1) / 2, cx = wb.ax ? g.line : mid, cz = wb.ax ? mid : g.line;
      m.position.set(cx, groundY(Math.floor(cx), Math.floor(cz)) + g.hgt / 2 + 0.02, cz);
      if (wb.ax) m.rotation.y = Math.PI / 2;
      webMeshes.set(wb.id, { m, push, wb, cx, cz, hgt: g.hgt });
    }
    for (const h of S.homes) {
      if (h.k !== 'v') continue;
      const m = add(new THREE.Mesh(holeGeo, new THREE.MeshBasicMaterial({ color: 0x0d0906, transparent: true, depthWrite: false })));
      m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.7, 1);
      m.position.set(h.x + 0.5, groundY(h.x, h.y) + 0.02, h.y + 0.5);
      burrowMeshes.push(m);
    }
  }
  // ---- kútové pavučiny krížiaka: vejár na hrane steny pri zemi, kolmo na stenu ----
  // Súradnice kúta (Webs.cornerThreads) → svet: počiatok na zemi v kúte, X von zo steny d, Y hore, Z pozdĺž steny
  // (pri konci steny od jej konca dozadu, pri vnútornom kúte von zo steny e)
  function cornerMatrix(k: CornerView): THREE.Matrix4 {
    const gy = groundY(k.x, k.y);
    const ox = k.x + 0.5 + k.dx * 0.5 + k.ex * 0.5, oz = k.y + 0.5 + k.dy * 0.5 + k.ey * 0.5;
    return new THREE.Matrix4().makeBasis(new THREE.Vector3(-k.dx, 0, -k.dy), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-k.ex, 0, -k.ey)).setPosition(ox, gy + 0.005, oz);
  }
  // Kút pri budove z minikociek: skutočný vnútorný kút modelu (pod strechou, v okne, pri schode, pri zemi) na strane
  // políčka, kde krížiak tká – Webs.voxelCorners. Veľkosť po osiach náhodne v rámci voľného miesta (najmenej 2 minikocky),
  // takže pavučiny sú rôzne a nesúmerné (napr. 2 × 6). null = pri stene nie je model (skala) → kút pri zemi.
  const FINE = 8;
  function voxelCorner(k: CornerView, seed: number): { M: THREE.Matrix4; size: Vec3; faces: 2 | 3; th: CornerWeb } | null {
    const list = fine();
    if (!list) return null;
    const wx = k.x + k.dx + 0.5, wz = k.y + k.dy + 0.5;
    const f = list.find(m => wx >= m.ox && wx < m.ox + m.sx / FINE && wz >= m.oz && wz < m.oz + m.sz / FINE);
    if (!f) return null;
    // oblasť hľadania: polovica políčka pred stenou (aj pod presahom strechy) a kúsok do steny (výklenky), celá výška
    const px = k.x + 0.5, pz = k.y + 0.5, pts = ([[0, -0.5], [0, 0.5], [0.85, -0.5], [0.85, 0.5]] as const).map(([s, t]) => [px + k.dx * s + k.ex * t, pz + k.dy * s + k.ey * t] as const);
    const vx = pts.map(p => (p[0] - f.ox) * FINE), vz = pts.map(p => (p[1] - f.oz) * FINE);
    const box = { x0: Math.floor(Math.min(...vx)), x1: Math.ceil(Math.max(...vx)) - 1, z0: Math.floor(Math.min(...vz)), z1: Math.ceil(Math.max(...vz)) - 1, y0: 0, y1: f.sy - 1 };
    // len kúty otvorené k políčku krížiaka (jedna z osí pavučiny smeruje od steny)
    const c = Webs.voxelCorners(f, box).filter(q => [q.X, q.Y, q.Z].some(a => a[0] === -k.dx && a[1] === 0 && a[2] === -k.dy));
    const r = Webs.voxelWeb(f, c, seed, window.MF_WEB); // kotvy sa musia navzájom vidieť
    if (!r) return null;
    const q = r.q;
    const M = new THREE.Matrix4().makeBasis(new THREE.Vector3(...q.X), new THREE.Vector3(...q.Y), new THREE.Vector3(...q.Z))
      .setPosition(f.ox + q.o[0] / FINE, f.oy + q.o[1] / FINE, f.oz + q.o[2] / FINE);
    return { M, size: q.size, faces: q.faces, th: r.th };
  }
  function buildCorners(): void {
    for (const m of cornerMeshes) drop(m);
    for (const c of cornerSpiders) drop(c.sp.sp);
    cornerMeshes.length = cornerSpiders.length = 0;
    const P = params();
    for (const k of S.corner) {
      const seed = k.x * 31 + k.y * 7 + k.dx * 3 + k.ey;
      const vc = voxelCorner(k, seed);
      const M = vc ? vc.M : cornerMatrix(k);
      const th = vc ? vc.th : must(Webs.cornerThreads(P, { seed, faces: k.f }) ?? undefined);
      const m = add(threadLines(THREE, world, view, P, th, maxLights, frame));
      m.renderOrder = 2; m.matrixAutoUpdate = false; m.matrix.copy(M); m.matrixWorldNeedsUpdate = true;
      cornerMeshes.push(m);
      // krížiak visí v strede prvej oblasti pavučiny hlavou dole; chrbtom alebo bruchom ku kamere podľa strany
      // (strana chrbta je daná semienkom); v malej pavučine budovy je menší
      const at = new THREE.Vector3(...must(th.hub ?? undefined)).applyMatrix4(M), ks = vc ? Math.min(1, Math.max(...vc.size) * 1.6) : 1;
      let nrm: THREE.Vector3 | null = null;
      const world3 = (a: Vec3): THREE.Vector3 => new THREE.Vector3(...a).applyMatrix4(M);
      const A0 = world3(th.anchors[0]), A1 = world3(th.anchors[1]), A2 = world3(th.anchors[2]);

      nrm = A1.clone().sub(A0).cross(A2.clone().sub(A0)).normalize();
      if (seed % 2) nrm.negate();
      const sp = makeSprite(1, 1); sp.layers.set(1);
      cornerSpiders.push({ sp: { sp, key: '', eye: null, top: false }, at, nrm, ks });
    }
  }

  // ---- pavúky ----
  // Sprity z modelu (shared/spidermodel.ts): na zemi 8 pohľadov podľa smeru hlavy voči kamere, na zvislej ploche
  // (pavučina, chrbát hráča) hlavou hore/dole chrbtom alebo bruchom ku kamere; 4 snímky chôdze. Pravá veľkosť:
  // krížiak 1/4 políčka, vlčiak 1, pradlena 1,5 a výška hráča.
  const sinP = Math.sin(SM.PITCH);
  function spriteFor(o: Spider): SpiderSprite {
    let sp = sprites.get(o.id);
    if (!sp) { sp = { sp: makeSprite(1, 1), key: '', eye: null, top: false }; sprites.set(o.id, sp); }
    return sp;
  }
  // nastaví snímku a umiestni sprite: na zemi je spodok obrázka na zemi bližšie ku kamere (inak by predné nohy
  // zapadli pod zem), na ploche je počiatok modelu presne v bode (x, y, z)
  const toCam = new THREE.Vector3();
  function pose(s: SpiderSprite, k: SpiderKind, view: string, f: number, x: number, y: number, z: number, ks?: number): void {
    const sp = s.sp, L = SM.layout(k, view), key = k + view + f;
    if (s.key !== key) { sp.material.map = spriteTex(`spider:${k}:${view}:${f}`, L.w, L.h, c => SM.sprite(c, k, view, f)); sp.material.needsUpdate = true; s.key = key; }
    const sc = ks || 1;
    s.eye = { L, f, s: sc, x, y, z }; // pre svit očí v tme (počiatok modelu)
    sp.scale.set(L.w / L.ppu * sc, L.h / L.ppu * sc, 1);
    if (SM.isSurface(view)) { sp.center.set(L.ox / L.w, 1 - L.oy / L.h); sp.position.set(x, y, z); return; }
    const t = (L.h - L.oy) / L.ppu * sc / sinP;
    sp.center.set(L.ox / L.w, 0);
    sp.position.set(x + toCam.x * t, y, z + toCam.z * t);
  }

  const lastSeen = new Map<string, Seen>(); // id → { k, eye (počiatok a snímka), b (jas), hide, seen, d } pre svit očí v prekrytí
  function update(_dt: number, t: number, lights: readonly THREE.Vector4[]): void {
    if (builtArea !== S.area || builtTiles !== S.tilesGen) { builtArea = S.area; builtTiles = S.tilesGen; builtWebs = builtCorner = -1; } // nová plocha (výška zeme)
    if (builtWebs !== S.websGen) { builtWebs = S.websGen; buildWebs(); }
    if (builtCorner !== S.cornerGen) { builtCorner = S.cornerGen; buildCorners(); }
    const me = S.me, lo = { seen: 1 };
    // pavučiny: v tme len v dohľade (a v svetle lampášov); s lampášom v ruke sa lesknú ešte kúsok ďalej
    // pavučiny svieti shader (svetlo zo sveta); smer ku kamere pre odlesk
    view.value.copy(camera.position).sub(camTarget).normalize();
    frame.time.value = t;
    if (renderer) renderer.getDrawingBufferSize(frame.res.value);
    toCam.copy(camera.position).sub(camTarget).setY(0).normalize();
    lastSeen.clear();
    for (const w of cornerSpiders) {
      const n = w.nrm;
      const view = !n || Math.abs(n.y) > 0.8 ? SM.planarView(0, 1, toCam.x, toCam.z) : n.dot(toCam) >= 0 ? 'down' : 'down-b';
      pose(w.sp, 'k', view, 0, w.at.x, w.at.y, w.at.z, w.ks);
      const c = lightAt(w.at.x, w.at.y, w.at.z, lights, lights.length, lo);
      w.sp.sp.material.color.setRGB(...c);
      lastSeen.set(w.sp.sp.uuid, { k: 'k', eye: w.sp.eye, b: Math.max(...c), seen: lo.seen, d: Math.hypot(w.at.x - me.x, w.at.z - me.y) });
    }
    // pavučiny, do ktorých sa niekto zaboril: vydujú sa k nemu (miestne súradnice: x pozdĺž, z naprieč – pri ax 1 otočená)
    for (const w of webMeshes.values()) {
      const u = w.push;
      const keys = w.wb.in ? Object.keys(w.wb.in) : [];
      let who: { x: number; y: number } | undefined;
      for (const k of keys) { who = k === S.name.toLowerCase() ? me : [...S.others.values()].find(o => o.name.toLowerCase() === k); if (who) break; }
      if (!who) { u.value.set(0, 0, 0, 0); continue; }
      const dx = who.x - w.cx, dz = who.y - w.cz, lx = w.wb.ax ? -dz : dx, lz = w.wb.ax ? dx : dz;
      u.value.set(lx, 0.6 - w.hgt / 2 - 0.02, Math.max(-1.1, Math.min(1.1, lz)), 0.45);
    }
    for (const m of burrowMeshes) { const p = m.position; lightAt(p.x, p.y, p.z, lights, lights.length, lo); m.material.opacity = 0.85 * lo.seen; m.visible = lo.seen > 0.02; }
    const alive = new Set<string>();
    for (const o of S.spiders.values()) {
      alive.add(o.id);
      const s = spriteFor(o), sp = s.sp;
      let x = o.x, z = o.y, lift = 0;
      if (o.c) { // na chrbte hráča
        if (Math.hypot(o.x - me.x, o.y - me.y) < 1.2) { x = me.x; z = me.y; }
        lift = 0.45;
      }
      const f = o.m ? SM.frameOf(o.phase) : 0;
      const y = groundY(x, z) + lift;
      // na kmeni: chrbtom von zo stromu, hlavou dole (čaká) alebo hore (lezie); zo strany od kamery ho kmeň zakryje
      if (o.n) { x += o.n[0] * 0.05; z += o.n[1] * 0.05; }
      // na chrbte hráča lezie hore (chrbtom ku kamere), inak podľa smeru hlavy
      const tv = o.n ? SM.trunkView(o.n[0], o.n[1], toCam.x, toCam.z, o.u) : null; // na kmeni: podľa strany kmeňa voči kamere
      const view = o.n ? tv || 't0d' : o.c ? 'up' : SM.planarView(Math.cos(o.a || 0), Math.sin(o.a || 0), toCam.x, toCam.z);
      pose(s, o.k, view, f, x, o.c ? y + 0.25 : o.n ? y + (o.z || 0) : y, z, o.c ? 0.6 : 1); // na hráčovi menší, nech ho nezakryje celého
      const c = lightAt(x, y + 0.2 + (o.n ? o.z || 0 : 0), z, lights, lights.length, lo), bright = Math.max(...c);
      if (o.c) for (let i = 0; i < 3; i++) c[i] = Math.max(c[i] ?? 0, 0.8); // na sebe ho vidíš aj v tme
      sp.material.color.setRGB(...c);
      // pavúk na chrbte hráča sa kreslí navrch (inak by ho zakryla postavička)
      if (s.top !== o.c) { const m = sp.material; s.top = o.c; m.depthTest = !o.c; m.transparent = o.c; sp.renderOrder = o.c ? 1e6 + 1 : 0; m.needsUpdate = true; } // až po siluete hráča
      const inBurrow = o.k === 'v' && o.h;
      sp.visible = lo.seen > 0.02 && !inBurrow && !(o.n && !tv); // za kmeňom ho nevidno
      lastSeen.set(o.id, { k: o.k, eye: s.eye, b: bright, hide: !!(o.n && !tv), seen: inBurrow ? 0 : lo.seen, d: Math.hypot(x - me.x, z - me.y) });
    }
    for (const [id, s] of sprites) if (!alive.has(id)) { scene.remove(s.sp); s.sp.material.dispose(); sprites.delete(id); }
  }

  // Oči sa v tme lesknú (všetky pavúky): na skutočných miestach očí v snímke (SpiderModel.layout().eyes), tým silnejšie,
  // čím je pri pavúkovi tmavšie. Aj za dohľadom – vlčiak a pradlena do SPI.*.eyes políčok, krížiak do 2,5 –
  // kto si dá pozor, uvidí ich skôr. Občas žmurknú.
  const KEYE = 2.5;
  function overlay(c: CanvasRenderingContext2D, ppb: number, t: number): void {
    for (const [id, e] of lastSeen) {
      const E = e.eye;
      if (e.hide || !E) continue;
      const eyes = E.L.eyes[E.f];
      if (!eyes || !eyes.length) continue;
      const dark = Math.max(0, Math.min(1, (0.85 - e.b) / 0.45));
      if (dark <= 0.02) continue;
      const range = e.k === 'k' ? KEYE : (e.k === 'p' ? SPI.pradlena : SPI.vlciak).eyes;
      const far = e.seen > 0.05 ? 1 : Math.max(0, Math.min(1, (range + 0.5 - e.d) / 1)); // do range naplno, potom rýchlo zhasne
      const h = ((id.charCodeAt(1) || 0) + id.length * 7) * 1.7;
      if (Math.sin(t * 0.9 + h) < -0.9) continue; // žmurknutie
      const a = dark * far * (0.75 + 0.25 * Math.sin(t * 3 + h));
      if (a <= 0.02) continue;
      const P = project(E.x, E.y, E.z);
      SM.glow(c, e.k, eyes, P.x, P.y, ppb * E.s, a);
    }
  }
  function dispose(): void {
    for (const w of webMeshes.values()) drop(w.m);
    for (const m of [...cornerMeshes, ...burrowMeshes]) drop(m);
    for (const c of cornerSpiders) drop(c.sp.sp);
    for (const s of sprites.values()) { scene.remove(s.sp); s.sp.material.dispose(); }
    holeGeo.dispose();
  }
  return { update, overlay, dispose };
}
