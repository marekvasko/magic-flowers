// 3D vykresľovanie (Three.js): ortogonálna kamera pod 45°, svet z podkociek, flat shading
// s tieňom stien podľa strany, ambientným zatienením rohov a tieňom od slnka z mapy tieňov (GPU).
// Herná logika, sieť aj ovládanie zostávajú v game.ts – toto je len iný pohľad na ten istý svet.
// Hra ho načíta až po štarte ako samostatný kúsok balíka (import('./render3d.ts'), aj s Three.js).
import * as THREE from 'three';
import * as D from '../shared/data.ts';
import * as W from '../shared/world3d.ts';
import type { FineInfo, FineModel, Grid, SunDir } from '../shared/world3d.ts';
import * as MS from '../shared/mesher.ts';
import type { Baked, Quad } from '../shared/mesher.ts';
import type { Look } from '../shared/data.ts';
import type { PlantView } from '../shared/protocol.ts';
import { must } from '../shared/util.ts';
import { Art } from './art.ts';
import { AO_CURVE, FACE_SHADE, bakeFine } from './finebake.ts';
import type { CharOpts } from './art.ts';
import { createParticles } from './particles3d.ts';
import { createSpiders3d } from './spiders3d.ts';
import { createVehicles3d } from './vehicles3d.ts';
import { createBoat3d } from './boat3d.ts';
import * as Z from '../shared/zorder.ts';
import type { SurfaceKind } from '../shared/zorder.ts';
import type { CtxAction, Pt, ViewState } from './state.ts';

type V3 = [number, number, number];
const uni = <T>(value: T): THREE.IUniform<T> => ({ value });
const R = W.R;
const PITCH = Math.atan(1 / Math.SQRT2);       // klasická izometria ~35,26°
const GT = 32;                                   // px na políčko v textúre zeme
const MAX_LIGHTS = 16;
// blčanie svetiel (pomerná zmena dosahu): oheň, lampáš, okno, ostatné (hráči, kvety, víly)
const FL_FIRE = 0.16, FL_LANTERN = 0.08, FL_WINDOW = 0.035, FL_SOFT = 0.03;
const LAMP_R = 6.5; // dosah svetla lampáša v ruke (políčka)
const LAMP_COL: V3 = [1, 0.78, 0.45]; // farba (a sila) svetla lampášov
// Obrovský strom (Les divov) sa kreslí ako dve samostatné siete: kmeň s koreňmi (minikocky do polomeru TRUNK_KEEP_R od osi
// a všetko do výšky CROWN_FROM nad zemou) je vždy plný, koruna (konáre a lístie nad tým) je zoslabená stále – inak by sa
// vzdialené koruny zjavovali a mizli ako diery v mape. Každá časť má všetky svoje steny, aj tie, ktoré inak zakrýva druhá.
const TRUNK_KEEP_R = 0.8, CROWN_FROM = 3;
const LAMP_DUSK = 0.8; // lampáš (aj okná, oheň…) horí, keď je svetla menej než toto (deň × stmavnutie lesa)
// plynulý „plameňový“ šum zo súčtu sínusov s nesúdeliteľnými frekvenciami
function flicker(t: number, seed: number, amt: number): number {
  const n = 0.5 * Math.sin(t * 7.3 + seed) + 0.3 * Math.sin(t * 13.7 + seed * 2.1) + 0.2 * Math.sin(t * 23.9 + seed * 3.7);
  return 1 + amt * n;
}

// ---------- Shader: plochý, bez rozptylu a odrazov ----------
// Svetlo = okolie + slnko × (viditeľnosť slnka z mapy tieňov) + lampy. Zatienenie rohov (AO) je vo vrcholoch.
const SHADOW_SIZE = 2048;
// mäkký tieň z mapy tieňov – spoločný pre svet aj vodu (potrebuje varyings vShadow a vPos)
const SHADOW_GLSL = `
// 16 vzoriek v disku (Poissonovo rozloženie) – vyhladzovacie jadro mapy tieňov
const vec2 PD[16] = vec2[16](
  vec2(-0.942, -0.399), vec2(0.946, -0.769), vec2(-0.094, -0.929), vec2(0.345, 0.294),
  vec2(-0.916, 0.458), vec2(-0.815, -0.879), vec2(-0.383, 0.277), vec2(0.975, 0.756),
  vec2(0.443, -0.975), vec2(0.537, -0.474), vec2(-0.265, -0.419), vec2(0.792, 0.191),
  vec2(-0.242, 0.997), vec2(-0.814, 0.914), vec2(0.200, 0.786), vec2(0.144, -0.141));
float sunVisibility(float facing) {
  if (shadowOn < 0.5 || facing <= 0.02) return 0.0;           // noc alebo stena odvrátená od slnka
  vec3 sc = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  // disk natočený podľa miesta vo svete – namiesto pásov jemný, stabilný prechod
  float a = fract(sin(dot(floor(vPos.xz * 64.0), vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  float lit = 0.0;
  for (int i = 0; i < SHADOW_TAPS; i++) {
    float d = texture2D(shadowMap, sc.xy + rot * PD[i] * shadowRadius * shadowTexel).r;
    lit += sc.z - 0.0008 <= d ? 1.0 : 0.0;
  }
  return lit / float(SHADOW_TAPS);
}`;
// Stmievanie smerom na sever (Les na pomedzí, D.gloomAt): gloom = (od ktorého z, najviac, exponent); max 0 = vypnuté.
// Ubúda okolité svetlo aj slnko, svetlo lampášov nie.
const GLOOM_GLSL = `
float gloomAt(float z) {
  if (gloom.y <= 0.0) return 0.0;
  return gloom.y * pow(clamp((gloom.x - z) / gloom.x, 0.0, 1.0), gloom.z);
}`;
// Temná plocha (Les divov, D.DARK): slnko len v škvrnách cez koruny a na čistinách (canopy = otvorenosť korún podľa políčka),
// okolo hráča (eye = bod oka, w = dohľad) slabé svetlo a za dohľadom tma (darkFog). Miesta osvetlené lampášom (aj cudzím)
// ostanú vidno. Stromy sa kreslia celé (aj koruny v tme); čo zakrýva hráča alebo zem pred ním, sa zoslabí ako v tmavom lese.
// Slnko na zemi v Lese divov tlmené (1 = jas ako v záhrade); viditeľnosť za dohľadom ostáva plná
const LES_SUN_K = 0.3;
const DARK_GLSL = `
#define LES_SUN_K ${LES_SUN_K.toFixed(2)}
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float forestSun() {
  if (vFacing <= 0.02) return 0.0;
  vec2 p = floor(vPos.xz * 8.0) / 8.0; // po pixeloch ako textúra zeme
  float n = vnoise(p * 1.3) * 0.6 + vnoise(p * 3.1 + 17.0) * 0.4;
  float spots = smoothstep(0.7, 0.76, n) * step(0.5, vUp);
  float open = texture2D(canopy, vPos.xz / areaSize).r;
  return max(spots * 0.8, open * (0.5 + 0.5 * spots));
}`;

// VOX (jemné modely): sieť nesie len polohu, normálu a súradnice do dvoch vypečených obrázkov modelu (Mesher.bakeModel):
// farba steny každej minikocky (bez interpolácie, alfa = žiarenie) a zatienenie rohov (s lineárnou interpoláciou).
// Steny sa tak zlučujú bez ohľadu na materiál a tieň.
const VERT = `
#ifdef VOX
attribute vec2 aoUv;
#else
attribute vec3 color;
attribute float ao;
attribute float emis;
attribute float tex;
#endif
uniform mat4 shadowMatrix; uniform vec3 sunDir; uniform float shadowNormalBias;
varying vec3 vColor; varying float vAo; varying float vEmis; varying float vTex; varying float vFacing; varying float vUp;
varying vec2 vUv; varying vec3 vPos; varying vec4 vShadow; varying vec2 vUv2;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef VOX
  vUv = uv; vUv2 = aoUv;
#else
  vColor = color; vAo = ao; vEmis = emis; vTex = tex; vUv = uv;
#endif
  vPos = wp.xyz;
  vFacing = dot(normal, sunDir); vUp = normal.y;
  // bod do mapy tieňov mierne posunutý po normále (proti „tieňovým pruhom“ na povrchu)
  vShadow = shadowMatrix * vec4(wp.xyz + normal * shadowNormalBias, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const VOX_GLSL = `
uniform sampler2D voxColor; uniform sampler2D voxAo;`;
const FRAG = `
precision highp float;
#ifndef SHADOW_TAPS
#define SHADOW_TAPS 16
#endif
uniform sampler2D map; uniform sampler2D shadowMap;
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 lampColor; uniform vec3 emisColor;
uniform vec4 lights[${MAX_LIGHTS}]; uniform int lightCount; uniform float opacity;
uniform float shadowOn; uniform vec2 shadowTexel; uniform float shadowRadius;
uniform vec3 gloom; uniform vec3 gloomFog;
uniform float darkOn; uniform float sunMode; uniform vec3 sunFill; uniform vec4 eye; uniform vec2 eyeLit; uniform vec3 darkFog; uniform sampler2D canopy; uniform vec2 areaSize; uniform vec4 sunZone;
varying vec3 vColor; varying float vAo; varying float vEmis; varying float vTex; varying float vFacing; varying float vUp;
varying vec2 vUv; varying vec3 vPos; varying vec4 vShadow; varying vec2 vUv2;
${SHADOW_GLSL}
${GLOOM_GLSL}
${DARK_GLSL}
#ifdef VOX
${VOX_GLSL}
#endif
void main() {
#ifdef VOX
  vec4 tc = texture2D(voxColor, vUv);
  vec3 base = tc.rgb; float em = tc.a, ao = texture2D(voxAo, vUv2).r, tx = 0.0; // modely nie sú zem
#else
  vec3 base = vTex > 0.5 ? texture2D(map, vUv).rgb * vColor : vColor;
  float em = vEmis, ao = vAo, tx = vTex;
#endif
  float gm = gloomAt(vPos.z);
  // darkOn 0–1: koľko tmy Lesa divov (pri severnom okraji Lesa na pomedzí postupne pribúda, opar Lesa na pomedzí ubúda)
  // slnko v tme: sunMode 1 = skutočný tieň (mapa tieňov cez stromy), ale svieti len na zem; 0 = škvrny z šumu (forestSun)
  float groundSun = sunMode > 0.5 && tx > 0.5 && darkOn > 0.0 ? sunVisibility(vFacing) : 0.0;
  // slnko len v srdci lesa a kúsok okolo (sunZone: stred a polosi elipsy; z = 0 → všade), na okraji postupne zhasne
  if (sunZone.z > 0.0) groundSun *= 1.0 - smoothstep(0.8, 1.0, length((vPos.xz - sunZone.xy) / sunZone.zw));
  float darkSun = sunMode > 0.5 ? groundSun * LES_SUN_K : forestSun();
  float sunV = darkOn >= 1.0 ? darkSun : darkOn > 0.0 ? mix(sunVisibility(vFacing), darkSun, darkOn) : sunVisibility(vFacing);
  // osvetlená zem v tme (pokus): okrem slnka aj denné svetlo záhrady (sunFill) – v slnku je zem jasná ako v záhrade
  vec3 light = (ambient + sunColor * sunV + sunFill * groundSun * LES_SUN_K) * (1.0 - gm * (1.0 - darkOn));
  // Svetlo lampášov (aj slabé svetlo okolo hráča) je guľa okolo zdroja – na vrchy obrovských stromov nedosiahne.
  // Dohľad v tme (kde začína tma) sa však meria po zemi: vrchy kmeňov pri hráčovi sú tmavé drevo, nie čierne diery.
  float lamp = 0.0;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    float d = distance(vPos, lights[i].xyz);
    lamp += 1.0 - smoothstep(0.0, lights[i].w, d);
  }
  light += lampColor * lamp;
  float fogK = 0.0;
  if (darkOn > 0.0) {
    float d = mix(distance(vPos, eye.xyz), distance(vPos.xz, eye.xz), darkOn);
    light += vec3(0.8, 0.85, 1.0) * eyeLit.y * darkOn * (1.0 - smoothstep(0.0, eyeLit.x, distance(vPos, eye.xyz))); // slabé svetlo okolo hráča
    fogK = darkOn * smoothstep(eye.w * 0.6, eye.w * 1.15, d) * (1.0 - clamp(lamp * 1.6, 0.0, 1.0));
    fogK *= 1.0 - groundSun; // zem v slnku vidno aj za dohľadom (pokus)
  }
  vec3 col = base * ao * light;
  col = mix(col, gloomFog, gm * 0.3 * (1.0 - darkOn)); // v hustom lese visí opar
  col = mix(col, darkFog, fogK);
  col = max(col, base * emisColor * em); // svietiace veci (okná, oheň, živica) vidno aj v tme za dohľadom
  // zoslabený objekt: časť do výšky hráča (pne, kmene na zemi, kry) ostane plná, priehľadné je len to nad ňou
  gl_FragColor = vec4(col, opacity);
}`;

// ---------- Shader vody: odraz zo zrkadlovej kamery, Fresnel, odlesk slnka, hĺbka k brehu ----------
// Vlny sú procedurálne, ale po krokoch: poloha zaokrúhlená na pixely (WATER_PIX na blok) a čas na WATER_FPS krokov
// za sekundu – hladina sa hýbe ako v pixelovej hre. Ľad (zima) je bez vĺn, s rozmazaným „brúseným“ odrazom.
const WATER_PIX = 16, WATER_FPS = 8, RIPPLES = 10;
const WATER_VERT = `
uniform mat4 shadowMatrix; uniform float shadowNormalBias;
varying vec3 vPos; varying vec4 vShadow;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vShadow = shadowMatrix * vec4(wp.xyz + vec3(0.0, shadowNormalBias, 0.0), 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const WATER_FRAG = `
precision highp float;
#define SHADOW_TAPS 8
uniform sampler2D shadowMap; uniform float shadowOn; uniform vec2 shadowTexel; uniform float shadowRadius;
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 lampColor; uniform vec3 sunDir;
uniform vec4 lights[${MAX_LIGHTS}]; uniform int lightCount;
uniform sampler2D reflMap; uniform mat4 reflMatrix; uniform float reflOn;
uniform vec3 skyColor; uniform vec3 viewDir; uniform float time; uniform float ice; uniform float reflStrength;
uniform vec4 ripples[${RIPPLES}];   // x, z, vek (s, po krokoch), sila
uniform sampler2D waterMask; uniform vec2 mapSize;
varying vec3 vPos; varying vec4 vShadow;
${SHADOW_GLSL}
const float PIX = ${WATER_PIX}.0;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
// výška hladiny: tri smerové vlny + pomalý šum + kruhy po ťuknutí/krokoch
float height(vec2 p, float t) {
  float h = sin(dot(p, vec2(0.8, 0.6)) * 3.1 + t * 1.7) * 0.45
          + sin(dot(p, vec2(-0.55, 0.83)) * 4.7 + t * 2.3) * 0.3
          + sin(dot(p, vec2(0.96, -0.28)) * 6.9 - t * 2.9) * 0.18
          + (vnoise(p * 2.3 + vec2(t * 0.35, -t * 0.25)) - 0.5) * 0.7;
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = ripples[i];
    if (r.w <= 0.0) continue;
    float x = distance(p, r.xy) - r.z * 1.3;
    h += r.w * exp(-r.z * 1.4) * cos(x * 14.0) * exp(-x * x * 18.0);
  }
  return h;
}
// vzdialenosť k brehu (najbližšie políčko bez vody v okolí 5×5) – okrúhle pásy hĺbky aj pena
float shoreDist(vec2 p) {
  vec2 c = floor(p);
  float d = 2.5;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 t = c + vec2(float(i), float(j));
    if (texture2D(waterMask, (t + 0.5) / mapSize).r < 0.5) d = min(d, distance(p, clamp(p, t, t + 1.0)));
  }
  return d;
}
vec2 reflUv(vec3 p) { vec4 c = reflMatrix * vec4(p, 1.0); return c.xy / c.w; }
void main() {
  vec2 p = (floor(vPos.xz * PIX) + 0.5) / PIX;   // stred pixelu hladiny
  float e = 1.0 / PIX, t = floor(time * ${WATER_FPS}.0) / ${WATER_FPS}.0;
  float h = 0.0, stripe = 0.0;
  vec3 N;
  if (ice < 0.5) {
    h = height(p, t);
    vec2 g = vec2(height(p + vec2(e, 0.0), t) - h, height(p + vec2(0.0, e), t) - h) / e;
    g = floor(g * 0.06 / 0.05 + 0.5) * 0.05;     // sklon po krokoch – pixelové vlny
    N = normalize(vec3(-g.x, 1.0, -g.y));
  } else {
    // ľad: pásy brúsenia pozdĺž osi x
    stripe = floor(vnoise(vec2(p.x * 1.2, p.y * 13.0)) * 4.0) / 3.0;
    N = normalize(vec3(0.0, 1.0, (stripe - 0.5) * 0.1));
  }
  vec3 V = normalize(viewDir);
  float vis = sunVisibility(sunDir.y);

  // svetlo na hladine (rovnaké ako na svete) + odlesky lámp
  vec3 light = ambient + sunColor * vis, lampSpec = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    float f = 1.0 - smoothstep(0.0, lights[i].w, distance(vPos, lights[i].xyz));
    light += lampColor * f;
    vec3 Hl = normalize(normalize(lights[i].xyz - vPos) + V);
    lampSpec += lampColor * f * floor(pow(max(dot(N, Hl), 0.0), 40.0) * 3.0) / 3.0 * 0.6;
  }

  // prechod svetla vodou: plytčina pri brehu → hĺbka, po pásoch
  float sd = shoreDist(p), depth = clamp(sd / 1.8, 0.0, 1.0);
  float dq = floor(depth * 3.0 + 0.5) / 3.0;
  // zóny po políčkach (#38): breh je vždy plytčina, hĺbka vždy tmavá – hráč vidí, kam ktorý vodný kvet patrí
  float deep = step(0.8, texture2D(waterMask, (floor(p) + 0.5) / mapSize).r);
  dq = mix(min(dq, 1.0 / 3.0), max(dq, 2.0 / 3.0), deep);
  vec3 body;
  if (ice < 0.5) {
    body = mix(vec3(0.33, 0.66, 0.80), vec3(0.12, 0.34, 0.54), dq);
    body *= 0.93 + 0.05 * floor(clamp(h, -1.0, 1.0) * 2.0 + 0.5); // svetlejšie a tmavšie pásy vĺn
    if (h > 0.8) body = mix(body, vec3(0.85, 0.94, 1.0), 0.35);   // hrebene vĺn
    float foam = step(sd, 0.09 + 0.05 * h);                   // pena pri brehu
    body = mix(body, vec3(0.9, 0.95, 1.0), foam * 0.6);
  } else {
    body = mix(vec3(0.74, 0.87, 0.94), vec3(0.6, 0.77, 0.88), dq * 0.6) * (0.94 + stripe * 0.08);
    body += step(0.985, hash2(floor(p * 0.5 * PIX))) * 0.15;  // iskričky námrazy
  }
  vec3 trans = body * light;

  // odraz: zrkadlová kamera (alebo len farba oblohy)
  vec3 refl = skyColor;
  if (reflOn > 0.5) {
    vec2 uv = reflUv(vPos);
    if (ice < 0.5) refl = texture2D(reflMap, uv + N.xz * 0.035).rgb;
    else {
      // brúsený kov: odraz rozmazaný pozdĺž pásov (os x) a trochu naprieč
      vec2 du = reflUv(vPos + vec3(0.5, 0.0, 0.0)) - uv, dv = reflUv(vPos + vec3(0.0, 0.0, 0.06)) - uv;
      vec3 acc = vec3(0.0);
      for (int i = -3; i <= 3; i++) acc += texture2D(reflMap, uv + du * float(i) / 3.0 + dv * (stripe - 0.5)).rgb;
      refl = acc / 7.0;
    }
  }

  // Fresnel (Schlick) so štylizovaným základom – z tejto kamery by fyzikálne 2 % odrazu nebolo vidno
  float F = reflStrength + (1.0 - reflStrength) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 H = normalize(sunDir + V);
  vec3 spec;
  if (ice < 0.5) spec = sunColor * vis * floor(pow(max(dot(N, H), 0.0), 140.0) * 2.0) / 2.0 * 1.2;
  else {
    // anizotropný odlesk (Ward): široký pozdĺž brúsenia, úzky naprieč
    float ht = H.x / 0.6, hb = (H.z - N.z) / 0.25, hn = max(dot(H, N), 0.05);
    spec = sunColor * vis * exp(-(ht * ht + hb * hb) / (hn * hn)) * (0.5 + 0.5 * stripe) * 0.9;
  }
  gl_FragColor = vec4(mix(trans, refl, F) + spec + lampSpec, 1.0);
}`;

// ---------- Shader ľadovca: ten istý ľad ako na zamrznutom jazierku, ale na každej stene ----------
// Farba ľadu, pásy brúsenia, iskričky námrazy, Fresnel s odrazom oblohy a anizotropný odlesk (Ward).
// Pásy idú vodorovne pozdĺž steny (na vrchu pozdĺž osi x ako na jazierku); zrkadlo tu nie je – odráža sa obloha.
const GLACIER_VERT = `
attribute float shade;
uniform mat4 shadowMatrix; uniform float shadowNormalBias;
varying vec3 vPos; varying vec3 vN; varying float vShade; varying vec4 vShadow;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz; vN = normal; vShade = shade;
  vShadow = shadowMatrix * vec4(wp.xyz + normal * shadowNormalBias, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const GLACIER_FRAG = `
precision highp float;
#define SHADOW_TAPS 8
uniform sampler2D shadowMap; uniform float shadowOn; uniform vec2 shadowTexel; uniform float shadowRadius;
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 lampColor; uniform vec3 sunDir;
uniform vec4 lights[${MAX_LIGHTS}]; uniform int lightCount;
uniform vec3 skyColor; uniform vec3 viewDir;
varying vec3 vPos; varying vec3 vN; varying float vShade; varying vec4 vShadow;
${SHADOW_GLSL}
const float PIX = ${WATER_PIX}.0;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 N0 = normalize(vN);
  // súradnice na stene: T = pozdĺž pásov (vodorovne), B = naprieč
  vec3 T = abs(N0.x) > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 B = abs(N0.y) > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec2 q = vec2(dot(vPos, T), dot(vPos, B));
  vec2 p = (floor(q * PIX) + 0.5) / PIX;          // pixel ľadu
  float stripe = floor(vnoise(vec2(p.x * 1.2, p.y * 13.0)) * 4.0) / 3.0;
  vec3 N = normalize(N0 + B * (stripe - 0.5) * 0.1);
  vec3 V = normalize(viewDir);
  vec3 light = ambient + sunColor * sunVisibility(dot(N0, sunDir));
  vec3 lampSpec = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    float f = 1.0 - smoothstep(0.0, lights[i].w, distance(vPos, lights[i].xyz));
    light += lampColor * f;
    vec3 Hl = normalize(normalize(lights[i].xyz - vPos) + V);
    lampSpec += lampColor * f * floor(pow(max(dot(N, Hl), 0.0), 40.0) * 3.0) / 3.0 * 0.6;
  }
  // telo ľadu ako na jazierku: svetlé pásy, hlbšia modrá v tieni stien, iskričky námrazy
  vec3 body = mix(vec3(0.74, 0.87, 0.94), vec3(0.6, 0.77, 0.88), 0.3 + 0.3 * hash2(floor(p * 0.25))) * (0.94 + stripe * 0.08);
  body += step(0.985, hash2(floor(p * 0.5 * PIX))) * 0.15;
  vec3 trans = body * light * vShade;
  float F = 0.28 + 0.72 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 H = normalize(sunDir + V);
  float ht = dot(H, T) / 0.6, hb = (dot(H, B) - dot(N, B)) / 0.25, hn = max(dot(H, N), 0.05);
  vec3 spec = sunColor * sunVisibility(dot(N0, sunDir)) * exp(-(ht * ht + hb * hb) / (hn * hn)) * (0.5 + 0.5 * stripe) * 0.9;
  gl_FragColor = vec4(mix(trans, skyColor * vShade, F) + spec + lampSpec, 1.0);
}`;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: Readonly<V3>, b: Readonly<V3>, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a: Readonly<V3>, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const zip3 = (a: Readonly<V3>, b: Readonly<V3>, f: (x: number, y: number) => number): V3 => [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
const smooth = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hex = (h: string): V3 => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const toLin = (c: V3): V3 => c; // pracujeme priamo v sRGB ako kresby z art.ts (bez prevodu farieb)
THREE.ColorManagement.enabled = false;

// Čo 3D pohľad dostane od hry (game.ts) alebo od ladiacej stránky (/debug → World)
export interface Render3DApi {
  S: ViewState; glCanvas: HTMLCanvasElement; ov: HTMLCanvasElement; ovCtx: CanvasRenderingContext2D;
  EMOJI: Readonly<Partial<Record<string, string>>>;
  curMin: () => number; season: () => number;
  searching: (o: { si?: number | undefined } | null | undefined) => boolean;
  ctxAction: (x: number, y: number) => CtxAction | null; frontTile: () => Pt;
  placeCamera?: (camera: THREE.OrthographicCamera, target: THREE.Vector3, dt: number) => void;
  noPlayer?: boolean;
  layers?: Partial<Record<'shadows' | 'lights' | 'particles', boolean>>;
  beforeRender?: () => void;
}
// Zoslabovanie objektov pred hráčom (pozri FADE_DEFAULTS); v konzole window.MF_FADE prepíše len uvedené hodnoty
export interface FadeBase {
  darkFrom: number; dir: 'facing' | 'camera'; min: number; edge: number; near: number; reach: number; width: number; spread: number;
  step: number; hold: number; speed: number; outline: number; outlineRamp: number; solid: string[]; fan: boolean;
}
export type FadeConfig = FadeBase & { dark: Partial<FadeBase>; les: Partial<FadeBase> };
export type FadeOverrides = Partial<FadeBase> & { dark?: Partial<FadeBase>; les?: Partial<FadeBase> };
// Sieť alebo sprite, na ktorý sa dá ťuknúť: políčko, ku ktorému patrí (kmeň obra, rastlina, postavička)
export class TileMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
  tile: Pt | null = null;
}
// Jemný model (minikocky) vo svete: zoslabenie (fade 0–1, kam smeruje a do kedy), obal vo svete, hĺbkové dvojča a plný kmeň obra
export class FineMesh extends TileMesh {
  fineType = ''; // druh modelu (tree, giant, house…)
  fade = 1; want = 1; wantUntil = 0;
  box = new THREE.Box3();
  depthTwin: THREE.Mesh | null = null;
  solidPart: TileMesh | null = null;
  base: THREE.Material | null = null; // plný materiál modelu (s prioritou plochy, #160); null = fineMats.main
}
// Sprite (rastlina, postavička, pavúk): políčko, kľúč aktuálnej kresby a naposledy spočítané svetlo
export class TileSprite extends THREE.Sprite {
  tile: Pt | null = null;
  key = '';
  lit: V3 | null = null; litAt = 0;
}
// Postavička: plátno s kresbou, sprite, „duch“ (vidno ju aj za stenou) a tieň; výška pri chôdzi po schodoch (h, vh),
// viditeľnosť pri príchode a odchode (vis) a v tme (seen)
export interface CharObj {
  c: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; sp: TileSprite; ghost: THREE.Sprite;
  shadow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  h: number | null; vh: number; vis: number; seenArea: string; alive?: boolean; seen?: number;
  lastT?: number; wasWalking?: boolean; wx?: number; wz?: number; rippleAt?: number;
  pose?: { dir: number; phase: number; o: CharOpts };   // posledná kresba (smer, fáza chôdze, póza) – ruka pre lano saní (#158)
}
type CharId = number | string; // id hráča (na ladiacej stránke odtlačok kľúča) alebo 'me', 'babka', 'master'
// Lúč slnka nad čistinou: sieť, jej jas a kde stojí (k = sila)
interface Shaft { m: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>; op: THREE.IUniform<number>; base: { x: number; z: number; k: number } }
export interface Stats { calls: number; triangles: number; geometries: number; textures: number; w: number; h: number; pr: number; shadow: number; refl: number; scene: number }
export type WaterQuality = 'none' | 'medium' | 'real';
// Vnútro 3D pohľadu pre ladiacu stránku (/debug → World)
export interface DebugView {
  THREE: typeof THREE; scene: THREE.Scene; camera: THREE.OrthographicCamera; camTarget: THREE.Vector3; lightCam: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer; grid: Grid | null; mesh: THREE.Mesh | null; fineMeshes: FineMesh[]; waterMesh: THREE.Mesh | null;
  lilyMesh: THREE.Mesh | null; glacierMesh: THREE.Mesh | null; plantSprites: Map<number, TileSprite>; chars: Map<CharId, CharObj>;
  particleObjs: THREE.Object3D[]; lights: THREE.Vector4[]; materials: THREE.ShaderMaterial[]; groundY: (x: number, y: number) => number;
}
export interface Render3D {
  frame: (t: number) => void; resize: () => void; pick: (x: number, y: number) => Pt | null; seenAt: (x: number, z: number) => number;
  screenToWorld: (vx: number, vy: number) => [number, number]; rotate: (k: number) => void; sunHoursAt: (x: number, y: number) => number | null;
  dir8: (a: number) => number; debugFades: () => { type: string; fade: number; want: number | null }[]; ripple: (x: number, z: number, amp?: number) => void;
  setWaterQuality: (q: string) => void; readonly waterQuality: WaterQuality; setParticleQuality: (q: string) => void; readonly particleQuality: string;
  setStats: (on: boolean) => void; stats: () => Stats; readonly yaw: number; debugView: () => DebugView; invalidateShadows: () => void; dispose: () => void;
}

// Voliteľné háčiky pre ladiacu stránku /debug (hra ich nepoužíva, bez nich sa nič nemení):
//   api.placeCamera(camera, camTarget, dt) – vlastná kamera (poloha, smer aj výrez) namiesto kamery za hráčom
//   api.noPlayer – bez vlastnej postavičky (S.me ostáva len bod, podľa ktorého sa ráta šero lesa)
//   api.layers – { shadows, lights, particles }: false vypne tiene, svetlá lámp a častice
//   api.beforeRender() – po príprave snímky, tesne pred vykreslením (viditeľnosť vrstiev, ladiace pomôcky)
export function create(api: Render3DApi): Render3D {
  const { S } = api;
  const layerOn = (k: 'shadows' | 'lights' | 'particles'): boolean => !api.layers || api.layers[k] !== false;
  const renderer = new THREE.WebGLRenderer({ canvas: api.glCanvas, antialias: true, stencil: true }); // stencil – obrys zoslabených objektov
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  // Počítadlo snímok (menu → FPS): čas jednotlivých prechodov a súčet kreslení za celý snímok (všetky prechody)
  let statsOn = false;
  const passMs = { shadow: 0, refl: 0, scene: 0 };
  function setStats(on: boolean): void { statsOn = on; renderer.info.autoReset = !statsOn; renderer.info.reset(); }
  function stats(): Stats {
    const i = renderer.info, size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures,
      w: size.x, h: size.y, pr: renderer.getPixelRatio(), shadow: passMs.shadow, refl: passMs.refl, scene: passMs.scene };
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  camera.layers.enable(1); // hlavná kamera vidí svet (0) aj sprity a pomocné objekty (1)
  camera.layers.enable(3); // … aj hladinu a lekná (3) – tie nevrhajú tieň a v zrkadle nie sú; sprity v zrkadle sú na vrstve 2
  let yaw = Math.PI / 4, yawTarget = yaw;

  // ---------- Textúra zeme (kresba z art.js) ----------
  const gcv = document.createElement('canvas');
  gcv.width = S.W * GT; gcv.height = S.H * GT;
  const gctx = must(gcv.getContext('2d') ?? undefined);
  const groundTex = new THREE.CanvasTexture(gcv);
  groundTex.colorSpace = THREE.NoColorSpace;
  groundTex.magFilter = THREE.LinearFilter;
  groundTex.minFilter = THREE.LinearFilter;
  groundTex.generateMipmaps = false;
  const tileSig: string[] = [];
  // plátno zeme má veľkosť aktuálnej plochy – pri prechode do inak veľkej plochy sa zmení
  function sizeGround(): void {
    if (gcv.width === S.W * GT && gcv.height === S.H * GT) return;
    gcv.width = S.W * GT; gcv.height = S.H * GT;
    groundTex.dispose(); tileSig.length = 0;
  }
  // prechod na okraji plochy: šípky smerom von a smerovník s ikonou cieľovej plochy
  function gateInfo(x: number, y: number): { side: 'n' | 's' | 'w' | 'e'; icon: string } | null {
    const gt = D.gateAt(S.area, x, y);
    return gt ? { side: D.gateSide(S.area, gt), icon: D.AREA_FX[gt.to].icon || '✨' } : null;
  }
  function drawTile(i: number, se: number, t: number): void {
    const tl = must(S.tiles[i]), x = i % S.W, y = (i / S.W) | 0;
    Art.ground(gctx, tl.g, x * GT, y * GT, GT, se, t, x, y, tl.g === 'gate' ? gateInfo(x, y) : null, S.area);
    if (tl.s) Art.soil(gctx, tl.s, x * GT, y * GT, GT, se);
  }
  function refreshGround(se: number, t: number, force: boolean): void {
    let changed = false, holes = '';
    for (let i = 0; i < S.tiles.length; i++) {
      const tl = must(S.tiles[i]);
      if (tl.cut) holes += i + ',';
      const lp = lilyPlant(tl);
      if (lp) holes += `${i}:${lp.st}${lp.dead ? 'd' : ''},`; // plávajúce listy vodných kvetov sú v tej istej sieti
      else if (tl.s) holes += i + 's,'; // ozdobné lekno pod iným kvetom zmizne
      const sig = tl.g + '|' + (tl.s ? tl.s.k + String(tl.s.w) + String(tl.s.r) : '') + '|' + (tl.ice == null ? '' : tl.ice);
      if (force || sig !== tileSig[i]) { drawTile(i, se, t); tileSig[i] = sig; changed = true; } // vlny vody sú na GPU
    }
    if (changed) groundTex.needsUpdate = true;
    if (grid && S.tiles.some(t => t.ice != null) && S.tiles.map(t => t.ice == null ? '' : t.ice).join(',') !== glacierSig) { buildGlacier(); shadowDirty = true; }
    if (holes !== holesSig) { holesSig = holes; if (lilyMesh) { scene.remove(lilyMesh); lilyMesh.geometry.dispose(); } lilyMesh = buildPads(se, W.WATER_Y); }
  }
  let holesSig: string | null = '';

  // ---------- Sieť sveta z podkociek ----------
  const worldU = {
    map: uni(groundTex), ambient: uni(new THREE.Vector3()), sunColor: uni(new THREE.Vector3()),
    lampColor: uni(new THREE.Vector3(...LAMP_COL)), emisColor: uni(new THREE.Vector3(1, 1, 1)),
    lights: uni(Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4())), lightCount: uni(0), opacity: uni(1),
    shadowMap: uni<THREE.Texture | null>(null), shadowMatrix: uni(new THREE.Matrix4()), sunDir: uni(new THREE.Vector3(0, 1, 0)),
    shadowOn: uni(0), shadowTexel: uni(new THREE.Vector2(1 / SHADOW_SIZE, 1 / SHADOW_SIZE)), shadowRadius: uni(3.5),
    shadowNormalBias: uni(0.03), gloom: uni(new THREE.Vector3()), gloomFog: uni(new THREE.Vector3()),
    darkOn: uni(0), sunMode: uni(1), sunFill: uni(new THREE.Vector3()), eye: uni(new THREE.Vector4(0, 0, 0, 3)), eyeLit: uni(new THREE.Vector2(3, 0)),
    darkFog: uni(new THREE.Vector3()), canopy: uni<THREE.Texture | null>(null), areaSize: uni(new THREE.Vector2(S.W, S.H)), sunZone: uni(new THREE.Vector4())
  };
  const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: worldU });
  // svet v zrkadle pod hladinou: rovnaký shader, stačia 4 vzorky tieňa
  const reflMaterial = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, defines: { SHADOW_TAPS: 4 }, uniforms: material.uniforms });
  // Jemné modely: shader s VOX – vypečené obrázky modelu sa nastavia pred vykreslením každého modelu. Svetlo zdieľajú so svetom.
  const voxUniforms = { ...worldU, voxColor: uni<THREE.Texture | null>(null), voxAo: uni<THREE.Texture | null>(null) };
  const fadeU = { ...voxUniforms, opacity: uni(1) };
  const fineMats = {
    main: new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, defines: { VOX: 1 }, uniforms: voxUniforms }),
    // Objekt, ktorý práve mizne (hráč zašiel zaň): priehľadný, bez zápisu do hĺbky. Priehľadnosť má vlastnú
    // (nastaví sa pre každý objekt tesne pred vykreslením) – hlavný materiál ostáva úplne nepriehľadný.
    // Stačia 4 vzorky tieňa (pri ~30 % priehľadnosti rozdiel nevidno).
    fade: new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, defines: { VOX: 1, SHADOW_TAPS: 4 }, uniforms: fadeU, transparent: true, depthWrite: false }),
    // hĺbkový prechod: rovnaký vertex shader (rovnaká hĺbka – bez bodkovania), ale prázdny fragment shader;
    // malý posun dozadu, aby predná plocha zoslabeného objektu vždy spoľahlivo prešla testom hĺbky (žiadne kmitanie na mobiloch)
    depth: new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }', defines: { VOX: 1 }, uniforms: voxUniforms, transparent: true, depthWrite: true, colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }),
    refl: new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, defines: { VOX: 1, SHADOW_TAPS: 4 }, uniforms: voxUniforms })
  };
  // Priorita plôch (#160, src/shared/zorder.ts): plochy v jednej rovine rozhodne druh plochy cez posun hĺbky
  // (polygonOffset), nie posun geometrie. Zem je bez posunu, hladina a jemné modely s druhom (mólo, kolíky) majú
  // vlastný plný materiál so zdieľanými uniformami. window.MF_ZPRIO = false priority vypne (porovnanie na ladenie).
  const zprio = (): boolean => window.MF_ZPRIO !== false;
  const biasedMats: [THREE.Material, SurfaceKind][] = [];
  function biased<M extends THREE.Material>(m: M, kind: SurfaceKind): M {
    const b = Z.depthBias(kind);
    m.polygonOffsetFactor = b.factor; m.polygonOffsetUnits = b.units;
    biasedMats.push([m, kind]);
    applyZPrio();
    return m;
  }
  // zapne / vypne posun hĺbky podľa window.MF_ZPRIO (volá sa aj každú snímku – prepínač z konzoly platí hneď)
  function applyZPrio(): void {
    for (const [m, kind] of biasedMats) { const b = Z.depthBias(kind), on = zprio() && (b.factor !== 0 || b.units !== 0); if (m.polygonOffset !== on) { m.polygonOffset = on; m.needsUpdate = true; } }
  }
  const fineByKind = new Map<SurfaceKind, THREE.ShaderMaterial>();
  function fineMain(type: string): THREE.ShaderMaterial {
    const kind = Z.fineSurface(type);
    if (!kind) return fineMats.main;
    let m = fineByKind.get(kind);
    if (!m) { m = biased(new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, defines: { VOX: 1 }, uniforms: voxUniforms }), kind); fineByKind.set(kind, m); voxMats.add(m); }
    return m;
  }
  // materiály jemných modelov (define VOX) – pred ich vykreslením treba nastaviť vypečené obrázky modelu
  const voxMats = new Set<THREE.Material>(Object.values(fineMats));
  const isVox = (m: THREE.Material): m is THREE.ShaderMaterial => voxMats.has(m);
  // Zoslabovanie objektov: všade sa zoslabí objekt, za ktorým stojí hráč (zakrýva ho). V tmavom lese (od miesta, kde les
  // berie toľko svetla, že sa aj cez deň rozsvieti lampáš) navyše tak, aby bolo vidno zem v smere pohľadu: vejár bodov na zemi pred hráčom (do reach blokov, rozširuje sa) – z každého bodu
  // sa vedie lúč ku kamere a objekty, ktoré ho zakrývajú, sa zoslabia: pri hráčovi najviac, ďalej menej.
  // Objekty vedľa a za touto zemou nič nezakrývajú, ostanú plné. Obrys majú všetky zoslabené.
  // Ladí sa za behu v konzole: window.MF_FADE = { min: 0.25, dark: { reach: 3 } } prepíše len uvedené hodnoty
  // (predvolené sú v window.MF_FADE_DEFAULTS); window.MF_NOFADE = true zoslabovanie vypne.
  const FADE_DEFAULTS: FadeConfig = {
    darkFrom: 1 - LAMP_DUSK, // od akého stmavnutia (D.gloomAt) je les tmavý – tam, kde sa cez deň rozsvieti lampáš
    dir: 'facing',     // smer pohľadu: 'facing' = kam sa pozerá postavička, 'camera' = smerom ku kamere (dolu na obrazovke)
    min: 0.3,          // viditeľnosť objektu, ktorý zakrýva zem pri hráčovi alebo samého hráča (0 = neviditeľný, 1 = plný)
    edge: 0.8,         // viditeľnosť objektu, ktorý zakrýva zem na konci vejára (vo vzdialenosti reach)
    near: 1.5,         // do tejto vzdialenosti od hráča (bloky) je zoslabenie najväčšie (min)
    reach: 4,          // ako ďaleko pred hráčom má byť zem vidno (bloky)
    width: 1,          // polovičná šírka vejára pri hráčovi (bloky)
    spread: 0.5,       // o koľko sa vejár rozšíri na každý blok pred hráčom
    step: 0.5,         // hustota bodov na zemi (bloky medzi bodmi)
    hold: 400,         // ms – ako dlho ostane objekt zoslabený, keď už nič nezakrýva (pri otáčaní nebliká)
    speed: 4,          // rýchlosť prechodu (zmena viditeľnosti za sekundu)
    outline: 0.7,      // nepriehľadnosť obrysu
    outlineRamp: 0.15, // obrys je naplno už pri takomto zoslabení – aj slabo zoslabené objekty majú zreteľný obrys
    fan: false,        // zoslabovať aj zem pred hráčom v smere pohľadu (len v tme, pozri dark)
    // Čo sa nezoslabí nikdy (typy jemných modelov): všetko do výšky hráča – kamene, kry, spadnuté kmene.
    // Zoslabujú sa budovy (domček, chalúpka, trh, studňa, kotlík, ľadovňa) a stromy; obrovský strom len korunou (kmeň ostane).
    solid: ['rock', 'bush', 'log', 'dock', 'edge'], // aj mólo a kolíky na okraji jazierka (#160)
    // v tmavom lese (aj v celom Lese divov): zoslabenie rovnaké ako všade (min, rýchlosť), len fan = zoslabovať aj zem
    // pred hráčom v smere pohľadu (vypnuté – všade sa zoslabí len to, čo zakrýva hráča; skúsiť: MF_FADE = { dark: { fan: true } })
    dark: { fan: false },
    les: { outline: 0 } // Les divov: zoslabené stromy bez obrysu, nech hráča v tme nerozptyľuje
  };
  window.MF_FADE_DEFAULTS = FADE_DEFAULTS;
  function fadeCfg(): FadeConfig & { inDark: boolean } {
    const u = window.MF_FADE || {}, c = Object.assign({ inDark: false }, FADE_DEFAULTS, u);
    c.inDark = D.isDark(S.area) || D.gloomAt(S.area, S.me.y) >= c.darkFrom;
    if (c.inDark) Object.assign(c, FADE_DEFAULTS.dark, u.dark || {});
    if (D.isDark(S.area)) Object.assign(c, FADE_DEFAULTS.les, u.les || {});
    else c.outline *= 1 - D.darkAt(S.area, S.me.y); // cestou do Lesa divov obrys postupne mizne
    return c;
  }
  let mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null, grid: Grid | null = null, builtSeason = -1, builtGen = -1;
  const G = (): Grid => must(grid ?? undefined); // svet je postavený (volá sa až po buildMesh)

  // Sieť zo zlúčených stien (Mesher.greedy): bunka má veľkosť 1/scale bloku; look(q) → { col, em, tex } pre materiál steny,
  // top = výška horného okraja steny v blokoch, ak má byť iná než mriežka (stena vody siaha až k hladine, #173)
  function quadsGeometry(quads: readonly Quad[], scale: number, look: (q: Quad) => { col: Readonly<V3>; em: number; tex: boolean; top?: number | undefined }): THREE.BufferGeometry {
    const n = quads.length;
    const P = new Float32Array(n * 12), C = new Float32Array(n * 12), A = new Float32Array(n * 4), E = new Float32Array(n * 4),
      T = new Float32Array(n * 4), U = new Float32Array(n * 8), N = new Float32Array(n * 12);
    const I = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
    quads.forEach((q, k) => {
      const { col, em, tex, top } = look(q), shade = must(FACE_SHADE[MS.faceIndex(q)]), corners = MS.quadCorners(q);
      const yMax = Math.max(...corners.map(p => p[1]));
      corners.forEach((p, j) => {
        const i = k * 4 + j;
        P.set([p[0] / scale, top != null && p[1] === yMax ? top : p[1] / scale, p[2] / scale], i * 3);
        C.set([col[0] * shade, col[1] * shade, col[2] * shade], i * 3);
        N[i * 3 + q.ax] = q.sg;
        A[i] = must(AO_CURVE[must(q.ao[j])]); E[i] = em; T[i] = tex ? 1 : 0;
        if (tex) { U[i * 2] = p[0] / scale / S.W; U[i * 2 + 1] = 1 - p[2] / scale / S.H; }
      });
      I.set(MS.quadIndices(q.ao, k * 4), k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setAttribute('ao', new THREE.BufferAttribute(A, 1));
    geo.setAttribute('emis', new THREE.BufferAttribute(E, 1));
    geo.setAttribute('tex', new THREE.BufferAttribute(T, 1));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setIndex(new THREE.BufferAttribute(I, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  function buildMesh(se: number): void {
    sizeGround();
    const g = grid = W.buildGrid(S.tiles, se, S.W, S.area, buildingState());
    sizeWorld();
    const I = W.M.INVIS;
    const quads = MS.greedy([g.NX, W.NY, g.NZ], (x, y, z) => W.get(g, x, y, z),
      // ľad má vlastnú sieť a shader (buildGlacier); skrytá stena sa nekreslí (zem pod budovou ostáva – keď budova zmizne,
      // nesmie tam byť diera); vrch vody kreslí samostatná hladina
      (m, nb, ax, sg) => m !== I && m !== W.M.ICE && !(nb && nb !== I) && !(m === W.M.WATER && ax === 1 && sg > 0),
      // plocha priamo pod jemným modelom: jeho neviditeľnú náhradu do zatienenia nerátame (keď model zmizne, zem nemá byť čierna)
      (v, front) => !!v && !(front === I && v === I));
    const cols = new Map<number, V3>();
    const colOf = (m: number): V3 => { let c = cols.get(m); if (!c) { c = toLin(hex(W.colorOf(m, se))); cols.set(m, c); } return c; };
    const geo = quadsGeometry(quads, R, q => {
      const textured = q.m < 16 && q.ax === 1 && q.sg > 0; // vrch terénu nesie kresbu zeme
      // bočná stena vody je len na okraji mapy (voda je najnižší terén) – siaha až k hladine, inak by pod ňou presvitala obloha (#173)
      const top = q.m === W.M.WATER && q.ax !== 1 ? W.WATER_Y : undefined;
      return { col: textured ? [1, 1, 1] : colOf(q.m), em: W.EMISSIVE[q.m] ? 1 : 0, tex: textured, top };
    });
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);
    for (const fm of fineMeshes) { scene.remove(fm); if (fm.depthTwin) scene.remove(fm.depthTwin); if (fm.solidPart) scene.remove(fm.solidPart); }
    const oldGeos = fineGeos;
    fineGeos = new Map();
    fineMeshes = g.fine.map(f => buildFine(f, se, oldGeos));
    for (const [data, e] of oldGeos) if (fineGeos.get(data) !== e) { e.geo.dispose(); e.color.dispose(); e.ao.dispose(); }
    buildCanopy();
    buildShafts();
    buildWater(se);
    buildGlacier();
    shadowDirty = true;
    builtSeason = se;
  }

  // ---------- Jemné modely z minikociek (1 blok = 8×8×8) ----------
  // Rovnaké modely (strom rovnakého druhu a natočenia…) zdieľajú jednu geometriu, každý má vlastnú polohu –
  // v Lese divov sú ich stovky a stavba aj pamäť by inak rástli s počtom stromov.
  let fineMeshes: FineMesh[] = [];
  // Obrovský strom rozdelený na kmeň (plný) a korunu (stále zoslabená) – dáta oboch častí, každé vo vlastnom modeli
  function giantParts(f: FineModel): { trunk: FineModel; crown: FineModel } {
    const { sx, sy, sz, data } = f, F = W.FINE, R2 = (TRUNK_KEEP_R * F) ** 2, top = CROWN_FROM * F;
    const trunk = new Uint8Array(data.length), crown = new Uint8Array(data.length);
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
      const i = (z * sy + y) * sx + x, m = data[i] ?? 0;
      if (!m) continue;
      const keep = y + 0.5 < top || (x + 0.5 - sx / 2) ** 2 + (z + 0.5 - sz / 2) ** 2 < R2;
      (keep ? trunk : crown)[i] = m;
    }
    return { trunk: { sx, sy, sz, data: trunk }, crown: { sx, sy, sz, data: crown } };
  }
  const giantSplit = new Map<Uint8Array, { trunk: FineModel; crown: FineModel }>(); // dáta modelu obra → { trunk, crown }
  // Model s vypečenou textúrou (Mesher.bakeModel): sieť je len povrch zlúčený bez ohľadu na materiál a zatienenie,
  // farby stien minikociek (materiál × tieňovanie strany × jemná variácia – drevo, kameň, šindle) a zatienenie rohov
  // sú v dvoch obrázkoch modelu. Optimalizácia beží pre každý model len raz: world3d.js modely vyrába raz (stromy,
  // kríky, skaly aj budovy sú v pamäti podľa druhu, obdobia a otočenia) a výsledok sa pamätá pri dátach modelu.
  const fineMeshData = new WeakMap<Uint8Array, { se: number; bake: Baked }>(); // dáta modelu → { se, bake } (polia v pamäti, prežijú aj prestavbu sveta)
  function meshFine(f: FineModel, se: number): Baked {
    const r = fineMeshData.get(f.data);
    if (r && r.se === se) return r.bake;
    const bake = bakeFine(f, se);
    const F = W.FINE;
    for (let i = 0; i < bake.P.length; i++) bake.P[i] = (bake.P[i] ?? 0) / F; // minikocky → bloky
    fineMeshData.set(f.data, { se, bake });
    return bake;
  }
  // Na GPU: mesh sa posunie na políčko, takže rovnaké modely (napr. stromy rovnakého druhu, obdobia a otočenia)
  // majú jednu spoločnú sieť aj obrázky; tie, ktoré sa pri prestavbe sveta nepoužili, sa uvoľnia.
  interface FineGeo { se: number; geo: THREE.BufferGeometry; color: THREE.DataTexture; ao: THREE.DataTexture }
  let fineGeos = new Map<Uint8Array, FineGeo>(); // dáta modelu → { se, geo, color, ao }
  function bakedTex(img: Baked['color'], format: THREE.PixelFormat): THREE.DataTexture {
    const t = new THREE.DataTexture(img.data, img.W, img.H, format, THREE.UnsignedByteType);
    t.unpackAlignment = 1; t.flipY = false; t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }
  function fineGeometry(f: FineModel, se: number, old: Map<Uint8Array, FineGeo>): FineGeo {
    let e = fineGeos.get(f.data) || old.get(f.data);
    if (e && e.se === se) { fineGeos.set(f.data, e); return e; }
    e = makeFineGeo(f, se);
    fineGeos.set(f.data, e);
    return e;
  }
  // Sieť a vypečené obrázky jemného modelu (bez zdieľanej pamäte sveta – tú pri prestavbe uvoľní buildMesh)
  function makeFineGeo(f: FineModel, se: number): FineGeo {
    const b = meshFine(f, se);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.N, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(b.UV, 2));
    geo.setAttribute('aoUv', new THREE.BufferAttribute(b.UV2, 2));
    geo.setIndex(new THREE.BufferAttribute(b.I, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const color = bakedTex(b.color, THREE.RGBAFormat);
    color.magFilter = color.minFilter = THREE.NearestFilter; // farby stien bez interpolácie
    const ao = bakedTex(b.ao, THREE.RedFormat);
    ao.magFilter = ao.minFilter = THREE.LinearFilter; // zatienenie plynulo medzi rohmi
    return { se, geo, color, ao };
  }

  function buildFine(f: FineInfo, se: number, old: Map<Uint8Array, FineGeo>): FineMesh {
    let solidPart: TileMesh | null = null;
    if (f.type === 'giant') {
      let parts = giantSplit.get(f.data);
      if (!parts) { parts = giantParts(f); giantSplit.set(f.data, parts); }
      // kmeň: obyčajná plná sieť (nezoslabuje sa), ťuká sa naň ako na políčko stromu
      const t = fineGeometry(parts.trunk, se, old);
      solidPart = new TileMesh(t.geo, fineMats.main);
      solidPart.position.set(f.ox, f.oy, f.oz);
      solidPart.tile = f.tile;
      solidPart.onBeforeRender = (_r, _sc, _cam, _g, mat) => { if (isVox(mat)) { voxUniforms.voxColor.value = t.color; voxUniforms.voxAo.value = t.ao; mat.uniformsNeedUpdate = true; } };
      scene.add(solidPart);
      f = Object.assign({}, f, { data: parts.crown.data }); // ďalej sa stavia (a zoslabuje) len koruna
    }
    const { geo, color, ao } = fineGeometry(f, se, old);
    const base = fineMain(f.type), fmesh = new FineMesh(geo, base);
    fmesh.base = base === fineMats.main ? null : base;
    fmesh.solidPart = solidPart;
    fmesh.position.set(f.ox, f.oy, f.oz);
    fmesh.updateMatrixWorld();
    fmesh.box = must(geo.boundingBox ?? undefined).clone().translate(fmesh.position); // vo svete (poradie zoslabených, lístie)
    fmesh.fade = f.type === 'giant' ? fadeCfg().min : 1; // koruna obra je zoslabená od začiatku
    // obrázky tohto modelu do zdieľaných uniform tesne pred vykreslením (hlavný, priehľadný, hĺbkový aj zrkadlový materiál)
    const useVox = (mat: THREE.Material, fade?: boolean): void => {
      if (!isVox(mat)) return;
      voxUniforms.voxColor.value = color; voxUniforms.voxAo.value = ao;
      if (fade) fadeU.opacity.value = fmesh.fade;
      mat.uniformsNeedUpdate = true;
    };
    // pri zoslabení: najprv len hĺbka (aby bolo vidno iba prednú plochu modelu), potom model priehľadne
    fmesh.renderOrder = 2;
    const depthTwin = new THREE.Mesh(geo, fineMats.depth);
    depthTwin.position.copy(fmesh.position);
    depthTwin.renderOrder = 1; depthTwin.visible = false; depthTwin.layers.set(1); // do mapy tieňov nepatrí
    depthTwin.onBeforeRender = (_r, _sc, _cam, _g, mat) => { useVox(mat); };
    scene.add(depthTwin);
    fmesh.depthTwin = depthTwin;
    fmesh.onBeforeRender = (_r, _sc, _cam, _g, mat) => { useVox(mat, mat === fineMats.fade); };
    fmesh.tile = f.tile;
    fmesh.fineType = f.type;

    scene.add(fmesh);
    return fmesh;
  }

  // ---------- Les divov: otvorenosť korún (slnko na čistinách) a lúče slnka ----------
  // canopy: 1 = otvorené nebo (čistina), na susedných políčkach polovica, inde zavreté koruny; lineárne filtrovaná textúra
  const noCanopy = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  noCanopy.needsUpdate = true;
  worldU.canopy.value = noCanopy;
  let canopyTex: THREE.DataTexture | null = null;
  function buildCanopy(): void {
    if (canopyTex) { canopyTex.dispose(); canopyTex = null; }
    worldU.canopy.value = noCanopy;
    worldU.areaSize.value.set(S.W, S.H);
    if (!D.isDark(S.area)) return;
    const a = new Uint8Array(S.W * S.H), open = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < S.W && y < S.H && S.tiles[y * S.W + x]?.g === 'glade';
    for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) {
      if (open(x, y)) { a[y * S.W + x] = 255; continue; }
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (open(x + dx, y + dy)) n++;
      a[y * S.W + x] = Math.min(140, n * 40);
    }
    canopyTex = new THREE.DataTexture(a, S.W, S.H, THREE.RedFormat, THREE.UnsignedByteType);
    canopyTex.flipY = false; canopyTex.magFilter = canopyTex.minFilter = THREE.LinearFilter; // riadok = z, stĺpec = x
    canopyTex.needsUpdate = true;
    worldU.canopy.value = canopyTex;
  }
  // Lúče slnka: priesvitné valce od zeme smerom k slnku (aditívne), cez deň na čistinách a sem-tam nad chodníkom.
  // Na nízkej kvalite častíc len jeden nad každou čistinou. Svietia len do kúsku za dohľad hráča.
  const SHAFT_VERT = `
varying float vY; varying float vEdge;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal), v = normalize(cameraPosition - wp.xyz);
  vY = uv.y; vEdge = abs(dot(n, v));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
  const SHAFT_FRAG = `
uniform float op; uniform vec3 col;
varying float vY; varying float vEdge;
void main() {
  float a = op * pow(vEdge, 1.5) * smoothstep(0.0, 0.08, vY) * (1.0 - vY);
  gl_FragColor = vec4(col * a, 1.0);
}`;
  const RAY_OP = 0.12; // jas stien lúčov z mapy tieňov (na skúšanie násobok window.MF_RAY_K)
  const shaftGeo = new THREE.CylinderGeometry(0.42, 0.3, 1, 12, 1, true);
  let shafts: Shaft[] = [];
  const UP = new THREE.Vector3(0, 1, 0);
  function buildShafts(): void {
    for (const { m } of shafts) { scene.remove(m); m.material.dispose(); }
    shafts = [];
    if (!D.isDark(S.area)) return;
    const high = particles.quality === 'high', seenGlade = new Set<number>();
    for (let i = 0; i < S.tiles.length; i++) {
      const tl = must(S.tiles[i]), g = tl.g, x = i % S.W, y = (i / S.W) | 0;
      if (!D.passable(tl) || g === 'gate') continue;
      let want = false;
      if (g === 'glade') {
        // jeden lúč na čistinu (prvé políčko, na ktoré narazíme), na vysokej kvalite ešte zopár ďalších
        const nearSeen = [...seenGlade].some(j => Math.hypot(j % S.W - x, ((j / S.W) | 0) - y) < 3.5);
        want = !nearSeen || (high && W.hash(x, y, 141) < 0.12);
        if (!nearSeen) seenGlade.add(i);
      } else if (high) want = W.hash(x, y, 143) < 0.03;
      if (!want) continue;
      const op = uni(0);
      const m = new THREE.Mesh(shaftGeo, new THREE.ShaderMaterial({
        vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        uniforms: { op, col: uni(new THREE.Vector3(1, 0.93, 0.7)) }
      }));
      const base = { x: x + 0.3 + 0.4 * W.hash(x, y, 145), z: y + 0.3 + 0.4 * W.hash(x, y, 147), k: g === 'glade' ? 1 : 0.6 };
      m.layers.set(1); m.renderOrder = 5e5; m.frustumCulled = false; m.visible = false; // po zoslabených objektoch
      scene.add(m);
      shafts.push({ m, op, base });
    }
  }
  // poloha a jas lúčov podľa slnka (dir), dňa (dl) a vzdialenosti od hráča
  function updateShafts(dir: SunDir | null, dl: number, eyeR: number): void {
    const rain = S.weather === 'rain' ? 0.3 : S.weather === 'snow' ? 0.5 : 1;
    sunRaysU.op.value = dir && dir.y > 0.05 ? RAY_OP * (window.MF_RAY_K || 1) * Math.min(1, dir.y * 3) * dl * rain : 0;
    for (const { m, op: opU, base: b } of shafts) {
      if (lesSunMode()) { m.visible = false; continue; } // lúče sú z mapy tieňov (sunRays)
      if (!dir || dir.y < 0.08 || dl <= 0) { m.visible = false; continue; }
      const dist = Math.hypot(b.x - S.me.x, b.z - S.me.y), near = 1 - smooth(eyeR * 0.6, eyeR + 2, dist);
      const op = 0.13 * b.k * Math.min(1, dir.y * 3) * dl * rain * near;
      m.visible = op > 0.004;
      if (!m.visible) continue;
      const L = Math.min(9, 4.5 / dir.y), d = v3.set(dir.x, dir.y, dir.z);
      m.quaternion.setFromUnitVectors(UP, d);
      m.scale.set(1, L, 1);
      m.position.set(b.x + d.x * L / 2, W.surfaceY(G(), Math.floor(b.x), Math.floor(b.z)) + d.y * L / 2, b.z + d.z * L / 2);
      opU.value = op;
    }
  }


  // ---------- Voda: hladina, lekná, zrkadlová kamera pod hladinou, kruhy na vode ----------
  const waterU = {
    ...worldU, // svetlo a mapa tieňov – tie isté objekty ako svet
    reflMap: uni<THREE.Texture | null>(null), reflMatrix: uni(new THREE.Matrix4()), reflOn: uni(0),
    skyColor: uni(new THREE.Vector3()), viewDir: uni(new THREE.Vector3(0, 1, 0)), time: uni(0),
    ice: uni(0), reflStrength: uni(0.42),
    ripples: uni(Array.from({ length: RIPPLES }, () => new THREE.Vector4())),
    waterMask: uni<THREE.Texture | null>(null), mapSize: uni(new THREE.Vector2(S.W, S.H))
  };
  const waterMaterial = biased(new THREE.ShaderMaterial({ vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: waterU }), 'water'); // priorita plochy (#160)
  let maskTex: THREE.DataTexture | null = null;
  // maska vody má veľkosť plochy – pri inak veľkej ploche sa vytvorí nová
  function sizeMask(): THREE.DataTexture {
    if (maskTex && maskTex.image.width === S.W && maskTex.image.height === S.H) return maskTex;
    if (maskTex) maskTex.dispose();
    const t = maskTex = new THREE.DataTexture(new Uint8Array(S.W * S.H), S.W, S.H, THREE.RedFormat, THREE.UnsignedByteType);
    t.flipY = false; t.magFilter = t.minFilter = THREE.NearestFilter; // riadok = z, stĺpec = x
    waterU.waterMask.value = t;
    waterU.mapSize.value.set(S.W, S.H);
    return t;
  }
  let waterMesh: THREE.Mesh | null = null, lilyMesh: THREE.Mesh | null = null;

  // ---------- Ľadovec: steny ľadových podkociek + kocky ľadu, ktoré sa ešte dajú vysekať ----------
  const glacierMaterial = new THREE.ShaderMaterial({
    vertexShader: GLACIER_VERT, fragmentShader: GLACIER_FRAG,
    uniforms: { ...worldU, skyColor: waterU.skyColor, viewDir: waterU.viewDir }
  });
  let glacierMesh: THREE.Mesh | null = null, glacierSig = '';
  function buildGlacier(): void {
    if (glacierMesh) { scene.remove(glacierMesh); glacierMesh.geometry.dispose(); glacierMesh = null; }
    glacierSig = S.tiles.map(t => t.ice == null ? '' : t.ice).join(',');
    const grid = G();
    const P: number[] = [], Nn: number[] = [], Sh: number[] = [], I: number[] = [];
    const quad = (pts: readonly V3[], n: Readonly<V3>, fi: number): void => {
      const v = P.length / 3;
      for (const p of pts) { P.push(...p); Nn.push(...n); Sh.push(must(FACE_SHADE[fi])); }
      I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    // kváder (x0..x1, y0..y1, z0..z1) v blokoch; stena sa vynechá, ak ju zakryje plná podkocka (skip)
    const cuboid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip: (f: number) => boolean): void => {
      if (!skip(0)) quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], 0);
      if (!skip(1)) quad([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [-1, 0, 0], 1);
      if (!skip(2)) quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], 2);
      if (!skip(3)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], 3);
      if (!skip(4)) quad([[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [0, 0, 1], 4);
      if (!skip(5)) quad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1], 5);
    };
    const DIRS: readonly V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let z = 0; z < grid.NZ; z++) for (let y = 0; y < W.NY; y++) for (let x = 0; x < grid.NX; x++) {
      if (W.get(grid, x, y, z) !== W.M.ICE) continue;
      cuboid(x / R, y / R, z / R, (x + 1) / R, (y + 1) / R, (z + 1) / R, f => {
        const d = must(DIRS[f]), nb = W.get(grid, x + d[0], y + d[1], z + d[2]);
        return !!nb && nb !== W.M.INVIS;
      });
    }
    // ľad nad dnom: na každom políčku stĺpec z vrstiev po 1/4 bloku (koľko vrstiev, toľko sa tu ešte dá vysekať);
    // bočná stena sa kreslí len tam, kde sused nesiaha rovnako vysoko
    const L = D.GLACIER_LAYERS, base = W.groundHeight('glacier') / R;
    const iceTop = (x: number, y: number): number => { const t = x >= 0 && y >= 0 && x < S.W && y < S.H ? S.tiles[y * S.W + x] : null; return t && t.g === 'glacier' ? base + (t.ice || 0) / L : -1; };
    for (let i = 0; i < S.tiles.length; i++) {
      const n = S.tiles[i]?.ice;
      if (!n) continue;
      const x = i % S.W, z = (i / S.W) | 0, top = base + n / L;
      quad([[x, top, z], [x, top, z + 1], [x + 1, top, z + 1], [x + 1, top, z]], [0, 1, 0], 2);
      const side = (nx: number, nz: number, pts: (y0: number) => V3[], nrm: V3, fi: number): void => { const y0 = Math.max(base, iceTop(nx, nz)); if (y0 < top) quad(pts(y0), nrm, fi); };
      side(x + 1, z, y0 => [[x + 1, y0, z], [x + 1, top, z], [x + 1, top, z + 1], [x + 1, y0, z + 1]], [1, 0, 0], 0);
      side(x - 1, z, y0 => [[x, y0, z + 1], [x, top, z + 1], [x, top, z], [x, y0, z]], [-1, 0, 0], 1);
      side(x, z + 1, y0 => [[x + 1, y0, z + 1], [x + 1, top, z + 1], [x, top, z + 1], [x, y0, z + 1]], [0, 0, 1], 4);
      side(x, z - 1, y0 => [[x, y0, z], [x, top, z], [x + 1, top, z], [x + 1, y0, z]], [0, 0, -1], 5);
    }
    if (!P.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
    geo.setAttribute('shade', new THREE.Float32BufferAttribute(Sh, 1));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    glacierMesh = new THREE.Mesh(geo, glacierMaterial); // vrstva 0: vrhá tieň a odráža sa vo vode
    scene.add(glacierMesh);
  }
  const waterBox = new THREE.Box3();
  function buildWater(se: number): void {
    for (const m of [waterMesh, lilyMesh]) if (m) { scene.remove(m); m.geometry.dispose(); }
    waterMesh = lilyMesh = null;
    const quads = W.waterQuads(S.tiles, S.W), y = W.WATER_Y;
    const mask = sizeMask();
    must(mask.image.data ?? undefined).set(W.waterMask(S.tiles, S.W)); mask.needsUpdate = true;
    if (!quads.length) return;
    const P: number[] = [], I: number[] = [];
    for (const q of quads) {
      const v = P.length / 3;
      // poradie rohov: (x,z) (x,z+1) (x+1,z+1) (x+1,z) – proti smeru hodín zhora, normála hore
      P.push(q.x, y, q.y, q.x, y, q.y + 1, q.x + 1, y, q.y + 1, q.x + 1, y, q.y);
      I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setIndex(I);
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    waterBox.copy(must(geo.boundingBox ?? undefined)).expandByScalar(0.5);
    waterMesh = new THREE.Mesh(geo, waterMaterial);
    waterMesh.layers.set(3);
    scene.add(waterMesh);
    lilyMesh = buildPads(se, y);
  }
  // Zasadený vodný kvet z hĺbky (tvar lily, #38) na políčku: štádium a či uhynul – jeho listy plávajú na hladine
  function lilyPlant(tl: (typeof S.tiles)[number]): { st: number; dead: boolean } | null {
    const p = tl.g === 'water' ? tl.s?.p : null, sp = p && p.sp !== 'wild' ? D.SPECIES[p.sp] : null;
    return p && sp && sp.shape === 'lily' ? { st: D.stageOf(p), dead: !!p.d } : null;
  }
  // lekná z pixelov hladiny (WATER_PIX na blok) – list s výrezom a ružový kvietok, osvetlené ako svet;
  // v zime namiesto nich otvory vysekané do ľadu (tmavá voda s bielym okrajom).
  // Zasadené vodné kvety z hĺbky (#38) tu majú svoje listy (viac a väčších s rastom); kvet nad nimi je sprite.
  function buildPads(se: number, y: number): THREE.Mesh | null {
    // ozdobné lekná len na voľnej vode plesa v horách (v záhrade nie sú, #160); zasadené vodné kvety (#38) všade
    const pads = W.lilyPads(S.tiles, se, S.W, S.area).filter(p => !S.tiles[p.y * S.W + p.x]?.s);
    const planted = se === 3 ? [] : S.tiles.flatMap((t, i) => { const lp = lilyPlant(t); return lp ? [{ x: i % S.W, y: (i / S.W) | 0, ...lp }] : []; });
    const holes = se === 3 ? S.tiles.flatMap((t, i) => t.cut && t.g === 'water' ? [{ x: i % S.W, y: (i / S.W) | 0 }] : []) : [];
    if (!pads.length && !holes.length && !planted.length) return null;
    const P: number[] = [], C: number[] = [], A: number[] = [], E: number[] = [], T: number[] = [], U: number[] = [], N: number[] = [], I: number[] = [];
    const px = 1 / WATER_PIX;
    const quad = (pts: readonly V3[], n: Readonly<V3>, col: Readonly<V3>): void => {
      const v = P.length / 3;
      for (const p of pts) { P.push(...p); C.push(...col); A.push(1); E.push(0); T.push(0); U.push(0, 0); N.push(...n); }
      I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };
    const top = (x0: number, z0: number, x1: number, z1: number, h: number, col: Readonly<V3>): void => { quad([[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]], [0, 1, 0], col); };
    const box = (x0: number, z0: number, x1: number, z1: number, h0: number, h1: number, col: Readonly<V3>): void => {
      top(x0, z0, x1, z1, h1, col);
      const s = mul3(col, 0.8);
      quad([[x0, h0, z1], [x1, h0, z1], [x1, h1, z1], [x0, h1, z1]], [0, 0, 1], s);
      quad([[x1, h0, z0], [x0, h0, z0], [x0, h1, z0], [x1, h1, z0]], [0, 0, -1], s);
      quad([[x1, h0, z1], [x1, h0, z0], [x1, h1, z0], [x1, h1, z1]], [1, 0, 0], s);
      quad([[x0, h0, z0], [x0, h0, z1], [x0, h1, z1], [x0, h1, z0]], [-1, 0, 0], s);
    };
    const green = hex('#5fae4a'), dark = hex('#4a9a3c');
    for (const { x, y: z } of pads) {
      const cx = 0.5, cz = 0.5, rx = 0.22, rz = 0.16, notch = W.hash(x, z, 3) * Math.PI * 2;
      for (let j = 0; j < WATER_PIX; j++) for (let i = 0; i < WATER_PIX; i++) {
        const u = (i + 0.5) * px - cx, w = (j + 0.5) * px - cz;
        if ((u / rx) ** 2 + (w / rz) ** 2 > 1) continue;
        let da = Math.atan2(w, u) - notch; da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) < 0.35) continue; // výrez listu
        top(x + i * px, z + j * px, x + (i + 1) * px, z + (j + 1) * px, y + 0.01, W.hash(x * 16 + i, z * 16 + j) < 0.3 ? dark : green);
      }
      const fx = x + Math.floor(0.55 * WATER_PIX) * px, fz = z + Math.floor(0.42 * WATER_PIX) * px;
      box(fx - px, fz - px, fx + px, fz + px, y + 0.01, y + 0.01 + 1.5 * px, hex('#ffb6d9'));
      top(fx - px * 0.5, fz - px * 0.5, fx + px * 0.5, fz + px * 0.5, y + 0.012 + 1.5 * px, hex('#ffe066'));
    }
    // list s výrezom: stred (cx, cz) v políčku, polosi rx, rz, výrez smerom notch; pixely mimo políčka sa vynechajú
    const leaf = (x: number, z: number, cx: number, cz: number, rx: number, rz: number, notch: number, a: Readonly<V3>, b: Readonly<V3>, h: number): void => {
      for (let j = 0; j < WATER_PIX; j++) for (let i = 0; i < WATER_PIX; i++) {
        const u = (i + 0.5) * px - cx, w = (j + 0.5) * px - cz;
        if ((u / rx) ** 2 + (w / rz) ** 2 > 1) continue;
        let da = Math.atan2(w, u) - notch; da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) < 0.35) continue;
        top(x + i * px, z + j * px, x + (i + 1) * px, z + (j + 1) * px, h, W.hash(x * 16 + i, z * 16 + j) < 0.3 ? b : a);
      }
    };
    const live = [hex('#4fa63e'), hex('#3d8f32')] as const, dry = [hex('#8a6a3a'), hex('#76582e')] as const;
    for (const { x, y: z, st, dead } of planted) {
      const [a, b] = dead ? dry : live, n = W.hash(x, z, 5) * Math.PI * 2;
      leaf(x, z, 0.5, 0.5, st === 0 ? 0.12 : st === 1 ? 0.2 : 0.27, st === 0 ? 0.1 : st === 1 ? 0.17 : 0.23, n, a, b, y + 0.012);
      if (st >= 1) leaf(x, z, 0.24, 0.74, 0.14, 0.12, n + 2.1, b, a, y + 0.011);
      if (st >= 2) leaf(x, z, 0.78, 0.24, 0.15, 0.13, n + 4.2, a, b, y + 0.011);
    }
    const rim = hex('#f4f9fc'), deep = hex('#1f5f8a');
    for (const { x, y: z } of holes) for (let j = 0; j < WATER_PIX; j++) for (let i = 0; i < WATER_PIX; i++) {
      const u = (i + 0.5) / WATER_PIX - 0.5, w = (j + 0.5) / WATER_PIX - 0.5, d = (u / 0.32) ** 2 + (w / 0.26) ** 2;
      if (d > 1) continue;
      top(x + i * px, z + j * px, x + (i + 1) * px, z + (j + 1) * px, y + 0.01, d > 0.6 ? rim : deep);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setAttribute('ao', new THREE.Float32BufferAttribute(A, 1));
    geo.setAttribute('emis', new THREE.Float32BufferAttribute(E, 1));
    geo.setAttribute('tex', new THREE.Float32BufferAttribute(T, 1));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, material);
    m.layers.set(3);
    scene.add(m);
    return m;
  }

  // Kvalita odrazov (nastavenie na zariadení): none = len obloha, medium = polovičné rozlíšenie bez spritov,
  // real = plné rozlíšenie so všetkým (hráči, kvety, babka)
  const WATER_Q: readonly WaterQuality[] = ['none', 'medium', 'real'];
  const isWaterQ = (q: string | null): q is WaterQuality => WATER_Q.some(w => w === q);
  let waterQuality: WaterQuality = 'real';
  try { const q = localStorage.getItem('mfWater'); if (isWaterQ(q)) waterQuality = q; } catch { /* súkromné okno bez úložiska */ }
  function setWaterQuality(q: string): void {
    if (!isWaterQ(q)) return;
    waterQuality = q;
    try { localStorage.setItem('mfWater', q); } catch { /* súkromné okno bez úložiska */ }
  }
  let reflRT: THREE.WebGLRenderTarget | null = null;
  const reflCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), bufSize = new THREE.Vector2();
  const clipPlane = new THREE.Plane(), clipV = new THREE.Vector4(), clipQ = new THREE.Vector4(), invProj = new THREE.Matrix4();
  const mirrorUp = new THREE.Vector3(), mirrorTarget = new THREE.Vector3();
  // Šikmá blízka rovina (Lengyel): zrkadlová kamera oreže všetko pod hladinou bez zásahu do shaderov sveta.
  // Funguje pre ortogonálnu aj perspektívnu projekciu – 3. riadok matice nahradíme rovinou hladiny.
  function obliqueClip(cam: THREE.OrthographicCamera, y: number): void {
    clipPlane.set(new THREE.Vector3(0, 1, 0), -(y - 0.01)).applyMatrix4(cam.matrixWorldInverse);
    clipV.set(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    const e = cam.projectionMatrix.elements;
    invProj.copy(cam.projectionMatrix).invert();
    clipQ.set(Math.sign(clipV.x), Math.sign(clipV.y), 1, 1).applyMatrix4(invProj);
    const r4: [number, number, number, number] = [e[3], e[7], e[11], e[15]];
    const a = 2 * (r4[0] * clipQ.x + r4[1] * clipQ.y + r4[2] * clipQ.z + r4[3] * clipQ.w) / clipV.dot(clipQ);
    e[2] = a * clipV.x - r4[0]; e[6] = a * clipV.y - r4[1]; e[10] = a * clipV.z - r4[2]; e[14] = a * clipV.w - r4[3];
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
  function renderReflection(): void {
    const u = waterU;
    u.reflOn.value = 0;
    if (!waterMesh || !mesh || waterQuality === 'none') return;
    const worldMesh = mesh;
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    if (!frustum.intersectsBox(waterBox)) return; // jazierko nie je na obrazovke
    renderer.getDrawingBufferSize(bufSize);
    const k = waterQuality === 'real' ? 1 : 0.5, w = Math.max(1, Math.round(bufSize.x * k)), h = Math.max(1, Math.round(bufSize.y * k));
    if (!reflRT) { reflRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true }); u.reflMap.value = reflRT.texture; }
    else if (reflRT.width !== w || reflRT.height !== h) reflRT.setSize(w, h);
    // kamera zrkadlená cez rovinu hladiny: poloha, cieľ aj „hore“ s opačným y
    const y = W.WATER_Y;
    mirrorUp.setFromMatrixColumn(camera.matrixWorld, 1); mirrorUp.y = -mirrorUp.y;
    mirrorTarget.set(camTarget.x, 2 * y - camTarget.y, camTarget.z);
    reflCam.position.set(camera.position.x, 2 * y - camera.position.y, camera.position.z);
    reflCam.up.copy(mirrorUp);
    reflCam.lookAt(mirrorTarget);
    reflCam.left = camera.left; reflCam.right = camera.right; reflCam.top = camera.top; reflCam.bottom = camera.bottom;
    reflCam.near = camera.near; reflCam.far = camera.far;
    reflCam.updateMatrixWorld();
    reflCam.updateProjectionMatrix();
    u.reflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
    obliqueClip(reflCam, y);
    reflCam.layers.set(0);
    const sprites = waterQuality === 'real';
    if (sprites) reflCam.layers.enable(2);
    // svet v zrkadle: lacnejší materiál, zoslabené budovy plné (odraz nemá byť priesvitný)
    const oldMats = fineMeshes.map(m => m.material);
    worldMesh.material = reflMaterial;
    for (const m of fineMeshes) m.material = fineMats.refl;
    // Sprite rastie vždy po osi „hore“ kamery a záporná mierka nepomôže (shader berie dĺžku), ale „hore“ zrkadlovej
    // kamery smeruje do zeme. Preto ukotvenie preklopíme na druhý koniec a obrázok prevrátime zvisle.
    const flip = sprites ? [...plantSprites.values(), ...[...chars.values()].map(o => o.sp)] : [];
    const flipTex = new Set(flip.flatMap(sp => sp.material.map ? [sp.material.map] : []));
    const flipAll = () => {
      for (const sp of flip) sp.center.y = 1 - sp.center.y;
      for (const t of flipTex) { t.repeat.y = -t.repeat.y; t.offset.y = 1 - t.offset.y; }
    };
    flipAll();
    renderer.setRenderTarget(reflRT);
    renderer.clear();
    renderer.render(scene, reflCam);
    renderer.setRenderTarget(null);
    flipAll();
    worldMesh.material = material;
    fineMeshes.forEach((m, i) => { m.material = must(oldMats[i]); });

    u.reflOn.value = 1;
  }

  // kruhy na vode: kruhový zásobník (najstarší sa prepíše)
  const ripples = Array.from({ length: RIPPLES }, () => ({ x: 0, z: 0, t0: -1e9, amp: 0 }));
  let rippleNext = 0;
  function ripple(x: number, z: number, amp?: number): void {
    if (api.season() === 3) return; // ľad
    const n = W.nearestWater(S.tiles, x, z, 0.6, S.W);
    if (!n) return;
    const r = must(ripples[rippleNext]); rippleNext = (rippleNext + 1) % RIPPLES;
    r.x = n.x; r.z = n.z; r.t0 = performance.now(); r.amp = amp == null ? 1 : amp;
  }
  function updateWater(t: number, now: number): void {
    const u = waterU;
    u.time.value = t % 3600;
    u.viewDir.value.copy(camera.position).sub(camTarget).normalize();
    ripples.forEach((r, i) => {
      const age = (now - r.t0) / 1000;
      must(u.ripples.value[i]).set(r.x, r.z, Math.floor(age * WATER_FPS) / WATER_FPS, age < 3 ? r.amp : 0);
    });
    // kroky po brehu: postavička, ktorá sa hýbe tesne pri vode, rozčerí hladinu
    for (const [id, o] of chars) {
      if (id === 'babka' || id === 'master') continue;
      const p = o.sp.position, moved = o.wx != null && o.wz != null && Math.hypot(p.x - o.wx, p.z - o.wz) > 0.004;
      o.wx = p.x; o.wz = p.z;
      if (moved && now - (o.rippleAt || 0) > 450 && W.nearestWater(S.tiles, p.x, p.z, 0.45, S.W)) { o.rippleAt = now; ripple(p.x, p.z, 0.45); }
    }
  }

  // ---------- Mapa tieňov od slnka (GPU) ----------
  // Svet sa z pohľadu slnka nakreslí len do hĺbky. Ortogonálna kamera slnka presne obopína celú mapu.
  // Prekresľuje sa raz za herný krok (5 herných minút) alebo po prestavbe sveta – vždy na začiatku snímky.
  const shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthBuffer: true });
  shadowRT.depthTexture = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE);
  worldU.shadowMap.value = shadowRT.depthTexture;
  const lightCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  lightCam.layers.set(0); // len svet a modely – nie sprity, tiene pod postavičkami ani hĺbkové dvojčatá
  // do mapy kreslíme zadné strany (svet je z uzavretých kociek) – povrchy samy seba nezatieňujú
  const shadowDepthMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, colorWrite: false });
  const worldCorners: THREE.Vector3[] = [];
  // rohy sveta (pre kameru slnka) podľa veľkosti aktuálnej plochy
  function sizeWorld(): void {
    worldCorners.length = 0;
    // v Lese divov počíta mapa tieňov len zónu slnka (srdce lesa) – vyššie stromy, preto do výšky 12
    const zone = D.sunZone(S.area);
    if (zone) worldU.sunZone.value.set(zone.cx, zone.cz, zone.rx, zone.rz); else worldU.sunZone.value.set(0, 0, 0, 0);
    const xs = zone ? [zone.cx - zone.rx, zone.cx + zone.rx] : [0, S.W], zs = zone ? [zone.cz - zone.rz, zone.cz + zone.rz] : [0, S.H];
    for (const x of xs) for (const y of [0, zone ? 12 : 7]) for (const z of zs) worldCorners.push(new THREE.Vector3(x, y, z));
    shadowDirty = true;
  }
  // Pokus (Les divov): slnko ako skutočný tieň stromov, len na zemi (1), alebo pôvodné škvrny zo šumu (0, MF_LES_SUN = 'dapple')
  const lesSunMode = (): number => window.MF_LES_SUN === 'dapple' ? 0 : 1;
  let shadowDirty = true, lastShadowKey = '';
  const SUN_STEP_MIN = 5;
  function updateShadowMap(min: number, se: number): void {
    const u = worldU;
    const stepMin = Math.floor(min / SUN_STEP_MIN) * SUN_STEP_MIN; // slnko po 5 herných minútach (nie každý krok – mapa tieňov je drahá)
    const key = se + ':' + stepMin + (layerOn('shadows') ? '' : ':off') + ':' + lesSunMode();
    if (!shadowDirty && key === lastShadowKey) return;
    shadowDirty = false; lastShadowKey = key;
    clearSunRays();
    const dir = W.sunDir(stepMin, se);
    if (!dir || !layerOn('shadows')) { u.shadowOn.value = 0; return; }
    u.sunDir.value.set(dir.x, dir.y, dir.z); // rovnaké slnko ako mapa – odvrátené steny sedia s tieňom
    // temná plocha: slnko len v škvrnách cez koruny (shader), mapa tieňov netreba – stovky stromov by ju aj tak rozmazali
    // temná plocha: so škvrnami zo šumu (MF_LES_SUN = 'dapple') mapu tieňov netreba; inak skutočný tieň stromov na zemi
    if (D.isDark(S.area) && !lesSunMode()) { u.shadowOn.value = 0; shadowDirty = true; return; }
    u.shadowOn.value = 1;
    const zone = D.sunZone(S.area), center = zone ? new THREE.Vector3(zone.cx, 3, zone.cz) : new THREE.Vector3(S.W / 2, 3, S.H / 2);
    lightCam.position.copy(center).addScaledVector(new THREE.Vector3(dir.x, dir.y, dir.z), 80);
    lightCam.up.set(0, 1, 0);
    lightCam.lookAt(center);
    lightCam.updateMatrixWorld();
    // obopni rohy sveta v priestore svetla
    const inv = lightCam.matrixWorldInverse, b = new THREE.Box3();
    for (const c of worldCorners) b.expandByPoint(c.clone().applyMatrix4(inv));
    lightCam.left = b.min.x - 0.5; lightCam.right = b.max.x + 0.5; lightCam.bottom = b.min.y - 0.5; lightCam.top = b.max.y + 0.5;
    lightCam.near = Math.max(0.1, -b.max.z - 1); lightCam.far = -b.min.z + 1;
    lightCam.updateProjectionMatrix();
    u.shadowMatrix.value.multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse);
    // posun po normále ~1 pixel mapy
    u.shadowNormalBias.value = Math.max(lightCam.right - lightCam.left, lightCam.top - lightCam.bottom) / SHADOW_SIZE * 1.5;
    const oldOverride = scene.overrideMaterial, oldClear = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha();
    scene.overrideMaterial = shadowDepthMat;
    renderer.setRenderTarget(shadowRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, lightCam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(oldClear, oldAlpha);
    scene.overrideMaterial = oldOverride;
    if (zone && D.isDark(S.area)) buildSunRays(zone, dir);
  }

  // ---------- Lúče slnka z mapy tieňov (Les divov, MF_LES_SUN ≠ 'dapple') ----------
  // Mapu tieňov premietneme na zem zóny slnka do malej masky (RAY_RES vzoriek na políčko) a prečítame ju späť.
  // Na hranách osvetlených škvŕn (svetlo / tieň) postavíme pruhy smerom k slnku: steny lúča od miesta, kde tieň
  // dopadá na zem, po hranu koruny (či kmeňa), ktorá ho vrhá – dĺžku berieme z mapy tieňov (vzdialenosť tieniaceho
  // povrchu od zeme pozdĺž lúča, kanál G masky). Aditívne, na okraji zóny slabnú.
  // Lúč vidno len tam, kde je malá škvrna svetla obklopená tieňom (svetlo cez medzeru v korunách). Veľká slnečná plocha
  // (čistina) lúče nemá – vzduch nad ňou je svietený všade a tieň stromu na nej by inak vyzeral ako svetelná stena.
  const RAY_RES = 2, RAY_MAX = 32; // vzoriek na políčko; najdlhší lúč (bloky), zároveň mierka kanála G
  const RAY_PATCH = 6; // najväčšia škvrna svetla (políčka²), z ktorej ešte idú lúče
  const rayMaskU = { shadowMap: worldU.shadowMap, shadowMatrix: worldU.shadowMatrix, box: uni(new THREE.Vector4()), gy: uni(1), depthRange: uni(1) };
  const rayMaskMat = new THREE.ShaderMaterial({
    uniforms: rayMaskU,
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D shadowMap; uniform mat4 shadowMatrix; uniform vec4 box; uniform float gy; uniform float depthRange; varying vec2 vUv;
void main() {
  vec4 s = shadowMatrix * vec4(mix(box.x, box.z, vUv.x), gy + 0.05, mix(box.y, box.w, vUv.y), 1.0);
  vec3 sc = s.xyz / s.w * 0.5 + 0.5;
  float d = texture2D(shadowMap, sc.xy).r;
  // R = slnko, G = ako ďaleko pozdĺž lúča k slnku je to, čo zem zatieňuje (mapa tieňov je ortografická – hĺbka je lineárna)
  gl_FragColor = vec4(sc.z - 0.0008 <= d ? 1.0 : 0.0, clamp((sc.z - d) * depthRange / ${RAY_MAX.toFixed(1)}, 0.0, 1.0), 0.0, 1.0);
}`, depthTest: false, depthWrite: false
  });
  const rayMaskScene = new THREE.Scene(), rayMaskQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rayMaskMat);
  rayMaskQuad.frustumCulled = false; rayMaskScene.add(rayMaskQuad);
  let rayMaskRT: THREE.WebGLRenderTarget | null = null;
  const RAY_VERT = `
attribute float rayY; attribute float rayW;
varying float vY; varying float vW;
void main() { vY = rayY; vW = rayW; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;
  const RAY_FRAG = `
uniform float op; uniform vec3 col;
varying float vY; varying float vW;
void main() {
  // vY 0 = zem, 1 = hrana, ktorá tieň vrhá: najjasnejší pri zemi, smerom hore plynulo slabne až do straty
  float a = op * 1.5 * vW * pow(1.0 - vY, 2.2);
  gl_FragColor = vec4(col * a, 1.0);
}`;
  const sunRaysU = { op: uni(0), col: uni(new THREE.Vector3(1, 0.93, 0.7)) };
  const sunRays = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    vertexShader: RAY_VERT, fragmentShader: RAY_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: sunRaysU
  }));
  sunRays.layers.set(1); sunRays.renderOrder = 5e5; sunRays.frustumCulled = false; sunRays.visible = false;
  scene.add(sunRays);
  function clearSunRays(): void { sunRays.visible = false; }
  function buildSunRays(zone: { cx: number; cz: number; rx: number; rz: number }, dir: SunDir): void {
    const x0 = zone.cx - zone.rx, z0 = zone.cz - zone.rz, nx = Math.round(zone.rx * 2 * RAY_RES), nz = Math.round(zone.rz * 2 * RAY_RES), c = 1 / RAY_RES;
    if (!rayMaskRT || rayMaskRT.width !== nx || rayMaskRT.height !== nz) {
      if (rayMaskRT) rayMaskRT.dispose();
      rayMaskRT = new THREE.WebGLRenderTarget(nx, nz, { depthBuffer: false });
    }
    const gy = W.surfaceY(G(), Math.floor(zone.cx), Math.floor(zone.cz));
    rayMaskU.box.value.set(x0, z0, x0 + nx * c, z0 + nz * c);
    rayMaskU.gy.value = gy;
    rayMaskU.depthRange.value = lightCam.far - lightCam.near;
    const buf = new Uint8Array(nx * nz * 4);
    renderer.setRenderTarget(rayMaskRT);
    renderer.render(rayMaskScene, camera);
    renderer.readRenderTargetPixels(rayMaskRT, 0, 0, nx, nz, buf);
    renderer.setRenderTarget(null);
    const px = (i: number, j: number, ch: number): number => buf[(j * nx + i) * 4 + ch] ?? 0;
    const sun = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < nz && px(i, j, 0) > 127;
    // súvislé škvrny svetla; lúče len z malých
    const patch = new Int32Array(nx * nz).fill(-1), small: boolean[] = [];
    const patchAt = (i: number): number => patch[i] ?? -1;
    for (let s0 = 0; s0 < nx * nz; s0++) {
      if (patchAt(s0) >= 0 || !sun(s0 % nx, (s0 / nx) | 0)) continue;
      const id = small.length, q = [s0];
      patch[s0] = id;
      for (let k = 0; k < q.length; k++) {
        const qk = must(q[k]), qi = qk % nx, qj = (qk / nx) | 0;
        for (const [a, b] of [[qi + 1, qj], [qi - 1, qj], [qi, qj + 1], [qi, qj - 1]] as const) {
          if (!sun(a, b) || patchAt(b * nx + a) >= 0) continue;
          patch[b * nx + a] = id; q.push(b * nx + a);
        }
      }
      small.push(q.length <= RAY_PATCH * RAY_RES * RAY_RES);
    }
    const lit = (i: number, j: number): boolean => sun(i, j) && !!small[patchAt(j * nx + i)];
    // špička tieňa: úzky koniec tieňa vybiehajúci do slnka (tieň s najviac 3 tienistými susedmi z 8) – lúč od nej ide
    // po vrchol stromu, ktorý ju vrhá (posledný lúč, čo ho ešte obíde)
    const inMask = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < nz;
    const tip = (i: number, j: number): boolean => {
      if (!inMask(i, j) || sun(i, j)) return false;
      let n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if ((a || b) && inMask(i + a, j + b) && !sun(i + a, j + b)) n++;
      return n <= 3;
    };
    // hrana medzi bunkami (ai, aj) a (bi, bj) má lúč: svetlo / tieň a buď malá škvrna svetla, alebo špička tieňa
    const ray = (ai: number, aj: number, bi: number, bj: number): boolean => sun(ai, aj) !== sun(bi, bj) && (lit(ai, aj) || lit(bi, bj) || tip(ai, aj) || tip(bi, bj));
    // vzdialenosť od zeme po to, čo tieň vrhá (len v tieni; mimo masky nič)
    const casterAt = (i: number, j: number): number => i >= 0 && j >= 0 && i < nx && j < nz ? px(i, j, 1) / 255 * RAY_MAX : 0;
    // váha okraja zóny – rovnaká ako stmavnutie slnka v shaderi
    const zw = (x: number, z: number): number => 1 - smooth(0.8, 1, Math.hypot((x - zone.cx) / zone.rx, (z - zone.cz) / zone.rz));
    const P: number[] = [], Y: number[] = [], Wt: number[] = [];
    const quad = (ax: number, az: number, bx: number, bz: number, L: number): void => {
      const wa = zw(ax, az), wb = zw(bx, bz);
      if ((wa < 0.01 && wb < 0.01) || L < 0.4) return;
      L *= 0.95; // končí tesne pred tým, čo tieň vrhá (cez neho neprejde; hĺbkový test lúč za ním skryje)
      const dx = dir.x * L, dy = dir.y * L, dz = dir.z * L;
      P.push(ax, gy, az, bx, gy, bz, bx + dx, gy + dy, bz + dz, ax, gy, az, bx + dx, gy + dy, bz + dz, ax + dx, gy + dy, az + dz);
      Y.push(0, 0, 1, 0, 1, 1); Wt.push(wa, wb, wb, wa, wb, wa);
    };
    // hrany medzi svetlom a tieňom, zlúčené do úsekov najviac jedného políčka (váha okraja sa medzi koncami len lineárne mieša);
    // dĺžka lúča = vzdialenosť tieniacej hrany nad tienistou stranou (úsek sa rozdelí, keď sa výrazne zmení)
    for (let i = 0; i <= nx; i++) for (let j = 0; j < nz;) {
      if (!ray(i - 1, j, i, j)) { j++; continue; }
      const k = sun(i, j), sh = k ? i - 1 : i, L0 = casterAt(sh, j), j0 = j;
      let sum = 0;
      while (j < nz && j - j0 < RAY_RES && ray(i - 1, j, i, j) && sun(i, j) === k && Math.abs(casterAt(sh, j) - L0) < 1) sum += casterAt(sh, j++);
      quad(x0 + i * c, z0 + j0 * c, x0 + i * c, z0 + j * c, sum / (j - j0));
    }
    for (let j = 0; j <= nz; j++) for (let i = 0; i < nx;) {
      if (!ray(i, j - 1, i, j)) { i++; continue; }
      const k = sun(i, j), sh = k ? j - 1 : j, L0 = casterAt(i, sh), i0 = i;
      let sum = 0;
      while (i < nx && i - i0 < RAY_RES && ray(i, j - 1, i, j) && sun(i, j) === k && Math.abs(casterAt(i, sh) - L0) < 1) sum += casterAt(i++, sh);
      quad(x0 + i0 * c, z0 + j * c, x0 + i * c, z0 + j * c, sum / (i - i0));
    }
    sunRays.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('rayY', new THREE.Float32BufferAttribute(Y, 1));
    geo.setAttribute('rayW', new THREE.Float32BufferAttribute(Wt, 1));
    sunRays.geometry = geo;
    sunRays.visible = P.length > 0;
  }

  // ---------- Sprity: kvety, huby, babka, hráči ----------
  const texCache = new Map<string, THREE.CanvasTexture>();
  function spriteTex(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
    let t = texCache.get(key);
    if (t) return t;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(must(c.getContext('2d') ?? undefined));
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
    texCache.set(key, t);
    return t;
  }
  function makeSprite(w: number, h: number): TileSprite {
    const sp = new TileSprite(new THREE.SpriteMaterial({ alphaTest: 0.4, transparent: false }));
    sp.center.set(0.5, 0.03); sp.scale.set(w, h, 1);
    sp.layers.set(1); // sprity nevrhajú tieň do mapy tieňov
    sp.layers.enable(2); // … ale odrážajú sa vo vode
    scene.add(sp);
    return sp;
  }
  const plantSprites = new Map<number, TileSprite>();
  function plantKey(p: PlantView & { sp: D.SpeciesId }, night: boolean): { key: string; st: number; wil: boolean } {
    const st = D.stageOf(p), wil = st === 3 && !p.d && p.bt != null && (S.tick - p.bt) > 0.6 * D.SPECIES[p.sp].life * D.TICKS_PER_DAY;
    return { key: `${p.sp}|${st}|${p.d ? 1 : 0}|${night && p.sp === 'papradie' ? 1 : 0}|${wil ? 1 : 0}`, st, wil };
  }
  const shadowGeo = new THREE.CircleGeometry(0.3, 20);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  function blobShadow(): THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> { const m = new THREE.Mesh(shadowGeo, shadowMat); m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.75, 1); m.layers.set(1); scene.add(m); return m; }

  function syncPlants(night: boolean): void {
    const seen = new Set<number>();
    for (let i = 0; i < S.tiles.length; i++) {
      const tl = must(S.tiles[i]);
      const x = i % S.W, y = (i / S.W) | 0;
      let key: string | null = null, draw: ((c: CanvasRenderingContext2D) => void) | null = null, h = 1.5;
      const pl = tl.s?.p;
      if (pl && pl.sp !== 'wild') {
        const p = { ...pl, sp: pl.sp }, k = plantKey(p, night), wet = tl.g === 'water';
        // vodný kvet z hĺbky bez púčika (alebo uhynutý) – len listy na hladine (buildPads), sprite nemá
        if (wet && D.SPECIES[p.sp].shape === 'lily' && (k.st < 2 || p.d)) continue;
        // vo vode báza stonky (y − 0,1 s) presne na ukotvení spritu (3 % výšky od spodku): rastlina vyrastá z hladiny
        // a dotýka sa svojho odrazu; na súši ostáva o kúsok vyššie ako doteraz
        key = 'p:' + (wet ? 'w' : '') + k.key;
        draw = c => { Art.plant(c, p.sp, k.st, 32, wet ? 99.1 : 92, 60, 0, { dead: !!p.d, night, ready: false, wilting: k.wil }); };
      } else if (tl.g === 'shroom') {
        key = 's:' + (night ? 1 : 0); h = 1;
        draw = c => { Art.shroom(c, 32, 58, 60, night, 0); };
      }
      if (!key || !draw) continue;
      seen.add(i);
      let sp = plantSprites.get(i);
      if (!sp) { sp = makeSprite(1, h); sp.tile = { x, y }; plantSprites.set(i, sp); }
      if (sp.key !== key) {
        sp.material.map = spriteTex(key, 64, h === 1 ? 64 : 96, draw); sp.material.needsUpdate = true; sp.key = key;
        sp.scale.set(1, h, 1);
      }
      sp.position.set(x + 0.5, W.surfaceY(G(), x, y), y + 0.5);
    }
    for (const [i, sp] of plantSprites) if (!seen.has(i)) { scene.remove(sp); plantSprites.delete(i); }
  }

  // postavičky – 2D sprite s tieňom pod sebou, kreslený každú snímku (animácia chôdze)
  const chars = new Map<CharId, CharObj>();
  function charObj(id: CharId): CharObj {
    let o = chars.get(id);
    if (o) return o;
    const c = document.createElement('canvas'); c.width = 96; c.height = 128;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace;
    const sp = makeSprite(0.96, 1.28); sp.material.map = tex;
    // „röntgen“: polopriehľadná silueta postavičky viditeľná aj cez budovy a stromy
    const ghost = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }));
    ghost.center.copy(sp.center); ghost.scale.copy(sp.scale); ghost.renderOrder = 1e6; ghost.layers.set(1); // až po všetkých zoslabených objektoch (aj stále zoslabených korunách obrov)
    scene.add(ghost);
    const shadow = blobShadow(); shadow.material = shadowMat.clone(); // vlastný materiál – tieň sa prelína s postavičkou
    // vis: viditeľnosť 0–1; iní hráči sa pri príchode/odchode z plochy plynulo objavia a zmiznú
    o = { c, ctx: must(c.getContext('2d') ?? undefined), tex, sp, ghost, shadow, h: null, vh: 0, vis: id === 'me' || id === 'babka' || id === 'master' ? 1 : 0, seenArea: S.area };
    setCharVis(o, o.vis);
    chars.set(id, o);
    return o;
  }
  const CHAR_FADE = 0.3; // s
  function setCharVis(o: CharObj, v: number): void {
    o.vis = v;
    const m = o.sp.material, see = v < 1;
    if (m.transparent !== see) { m.transparent = see; m.alphaTest = see ? 0.02 : 0.4; m.depthWrite = !see; m.needsUpdate = true; }
    m.opacity = v;
    o.ghost.material.opacity = 0.35 * v;
    o.shadow.material.opacity = shadowMat.opacity * v;
  }
  function removeChar(id: CharId, o: CharObj): void { scene.remove(o.sp); scene.remove(o.ghost); scene.remove(o.shadow); o.shadow.material.dispose(); chars.delete(id); }
  // smer pohybu vo svete → jeden z 8 smerov spritu vzhľadom na natočenie kamery
  function dir8(a: number): number {
    const dx = Math.cos(a), dz = Math.sin(a);
    const sx = dx * Math.cos(yaw) - dz * Math.sin(yaw), sy = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const oct = ((Math.round(Math.atan2(sy, sx) / (Math.PI / 4)) % 8) + 8) % 8;
    return [2, 5, 0, 4, 1, 6, 3, 7][oct] ?? 0;
  }
  const DIR_ANGLE: readonly number[] = [Math.PI / 2, Math.PI, 0, -Math.PI / 2];
  const dirAngle = (dir: number): number => DIR_ANGLE[dir] ?? 0;
  // výška zeme na políčku – na ľadovci stojí postava na vrchu ľadu (po 1/4 bloku)
  function groundY(x: number, y: number): number {
    if (!grid) return 1;
    x = Math.max(0, Math.min(S.W - 1, Math.floor(x))); y = Math.max(0, Math.min(S.H - 1, Math.floor(y)));
    const t = S.tiles[y * S.W + x];
    return t && t.g === 'glacier' ? W.groundHeight('glacier') / R + (t.ice || 0) / D.GLACIER_LAYERS : W.surfaceY(grid, x, y);
  }
  // Výška postavy pri zmene terénu (schod na skalku, ľad…): hore rýchly krok (~0,1 s), dolu pád so zrýchlením
  // ako pri skoku. Na porovnanie (ladenie): window.MF_STEP = 'snap' (hneď) | 'lerp' (pôvodný plynulý prechod).
  const STEP_UP_RATE = 28, STEP_FALL_G = 23;
  function stepHeight(o: CharObj, target: number, dt: number): void {
    const mode = window.MF_STEP;
    if (o.h == null || mode === 'snap' || Math.abs(target - o.h) > 2.5) { o.h = target; o.vh = 0; return; } // prvý snímok, prechod plochy
    if (mode === 'lerp') { o.h = lerp(o.h, target, Math.min(1, dt * 10)); return; }
    if (target > o.h) {
      o.vh = 0;
      o.h = lerp(o.h, target, Math.min(1, dt * STEP_UP_RATE));
      if (target - o.h < 0.01) o.h = target;
    } else if (target < o.h) {
      o.vh -= STEP_FALL_G * dt;
      o.h = Math.max(target, o.h + o.vh * dt);
      if (o.h === target) o.vh = 0;
    } else o.vh = 0;
  }
  // opts.jz: výška skoku (políčka), opts.crawl: plazenie
  // opts.seat: hráč sedí v loďke (#160) – stojí na lavičke (seat.y), po pás ho zakryje bok loďky
  function drawChar(id: CharId, x: number, z: number, look: Partial<Look> | null, a: number, phase: number, opts: CharOpts & { jz?: number; web?: number; seat?: { x: number; z: number; y: number } | null }, dt: number): CharObj {
    const o = charObj(id);
    if (opts.seat) { x = opts.seat.x; z = opts.seat.z; }
    stepHeight(o, opts.seat ? opts.seat.y : groundY(x, z), dt);
    const jz = opts.jz || 0;
    o.ctx.clearRect(0, 0, 96, 128);
    const pose = { dir: opts.dance ? 0 : dir8(a), phase, o: Object.assign({ noShadow: true }, opts, { jz: 0 }) };
    o.pose = pose;
    Art.char(o.ctx, 48, 124, 100, look || {}, pose.dir, pose.phase, pose.o);
    if (opts.web && opts.web > 0) Art.cocoon(o.ctx, 48, 124, 100, opts.web, typeof id === 'number' ? id : 7); // zabalený do pavučiny – zodiera sa
    o.tex.needsUpdate = true;
    const h = o.h ?? 0;
    o.sp.position.set(x, h + jz, z);
    o.ghost.position.copy(o.sp.position);
    o.shadow.position.set(x, h + 0.01, z);
    const sk = Math.max(0.45, 1 - jz); o.shadow.scale.set(sk, 0.75 * sk, 1); // vo výskoku je tieň menší
    o.sp.tile = { x: Math.floor(x), y: Math.floor(z) };
    o.alive = true;
    o.seenArea = S.area;
    return o;
  }

  // ---------- Svetlo ----------
  const NIGHT_AMB = toLin([0.22, 0.25, 0.42]), DAY_AMB = toLin([0.62, 0.64, 0.72]);
  const SUN_DAY = toLin([0.55, 0.52, 0.44]), SUN_LOW = toLin([0.62, 0.38, 0.2]);
  const SKY_DAY: V3 = [0.62, 0.82, 0.96], SKY_NIGHT: V3 = [0.05, 0.07, 0.16], SKY_DUSK: V3 = [0.98, 0.62, 0.42];
  const GLOOM_FOG: V3 = [0.16, 0.24, 0.2]; // tmavozelený opar hustého lesa
  // Les divov: tma za dohľadom (aj pozadie) – cez deň temne zelená, v noci takmer čierna; okolie a slnko len zlomok
  const DARK_DAY: V3 = [0.03, 0.05, 0.04], DARK_NIGHT: V3 = [0.008, 0.011, 0.02];
  const DARK_AMB = 0.12, DARK_AMB_NIGHT = 0.08, DARK_SUN = 0.65, EYE_LIT = { day: 0.24, night: 0.16 }; // slabé svetlo okolo hráča
  let curAmb = DAY_AMB, curSun = SUN_DAY, curSunDir: SunDir | null = null, curDark: { k: number; eyeLit: THREE.Vector2; eye: THREE.Vector4 } | null = null;
  function lighting(min: number, se: number): number {
    const dl = W.daylight(min), dir = W.sunDir(min, se);
    curSunDir = dir;
    const elev = dir ? Math.min(1, dir.y * 3) : 0;
    const rain = S.weather === 'rain' ? 0.75 : S.weather === 'snow' ? 0.9 : 1;
    curAmb = mul3(mix3(NIGHT_AMB, DAY_AMB, dl), rain < 1 ? 0.92 : 1);
    curSun = mul3(mix3(SUN_LOW, SUN_DAY, Math.min(1, elev * 1.4)), elev * dl * rain);
    worldU.ambient.value.set(...curAmb);
    worldU.sunColor.value.set(...curSun);
    const emis: V3 = dl < 0.6 ? toLin([1, 0.85, 0.55]) : [0, 0, 0];
    worldU.emisColor.value.set(...emis);
    const dusk = dir ? Math.max(0, 1 - dir.y * 4) * dl : 0;
    // Les na pomedzí: smerom na sever ubúda svetla (shader podľa miesta, obloha podľa toho, kde stojí hráč)
    const Gl = D.GLOOM[S.area], gm = D.gloomAt(S.area, S.me.y);
    worldU.gloom.value.set(Gl ? Gl.from : 1, Gl ? Gl.max : 0, Gl ? Gl.pow : 1);
    const fog = mul3(GLOOM_FOG, 0.35 + 0.65 * dl);
    worldU.gloomFog.value.set(...fog);
    let sky = mix3(mix3(mix3(SKY_NIGHT, SKY_DAY, dl), SKY_DUSK, dusk * 0.6), fog, gm);
    // Les divov (k = 1) a cesta k nemu na severe Lesa na pomedzí (k 0 → 1): málo svetla, slnko len cez koruny, za dohľadom tma (aj obloha)
    const k = D.darkAt(S.area, S.me.y), dark = D.DARK.les;
    worldU.darkOn.value = k;
    worldU.sunMode.value = lesSunMode();
    if (k > 0) worldU.emisColor.value.set(1, 0.95, 0.8); // v Lese divov svieti živica aj cez deň
    worldU.lampColor.value.set(...mul3(LAMP_COL, lerp(1, dark.lampK, k)));
    curDark = null;
    const gardenAmb = curAmb;
    worldU.sunFill.value.set(0, 0, 0);
    if (k > 0) {
      curAmb = mix3(curAmb, mix3(mul3(NIGHT_AMB, DARK_AMB_NIGHT), mul3(DAY_AMB, DARK_AMB), dl), k);
      // skutočný tieň na zemi (pokus): slnko v plnej sile ako v záhrade; škvrny zo šumu slabšie (DARK_SUN)
      curSun = mul3(curSun, lerp(1, lesSunMode() ? 1 : DARK_SUN, k));
      const amb = curAmb;
      if (lesSunMode()) worldU.sunFill.value.set(...zip3(gardenAmb, amb, (v, a) => Math.max(0, v - a))); // zem v slnku ako v záhrade
      worldU.ambient.value.set(...curAmb);
      worldU.sunColor.value.set(...curSun);
      const night = mix3(DARK_NIGHT, DARK_DAY, dl);
      sky = mix3(sky, night, k);
      worldU.darkFog.value.set(...night);
      worldU.eyeLit.value.set(dark.sight * 1.2, lerp(EYE_LIT.night, EYE_LIT.day, dl));
      curDark = { k, eyeLit: worldU.eyeLit.value, eye: worldU.eye.value };
    }
    renderer.setClearColor(new THREE.Color(sky[0], sky[1], sky[2]));
    waterU.skyColor.value.set(sky[0], sky[1], sky[2]);
    waterU.ice.value = se === 3 ? 1 : 0;
    waterU.reflStrength.value = se === 3 ? 0.28 : 0.42;
    return dl;
  }
  // svetlo v bode pre sprity (CPU verzia shaderu)
  // V temnej ploche navyše: slnko len na čistinách, slabé svetlo okolo hráča a za dohľadom tma; vis = nakoľko ho vidno (0–1).
  function lightAt(x: number, y: number, z: number, lights: readonly THREE.Vector4[], n: number, out?: { seen: number }): V3 {
    const cd = curDark;
    const dk = cd ? cd.k : 0;
    const vis = !curSunDir ? 0 : lerp(dk < 1 ? W.sunVisibility(G(), x, y + 0.3, z, curSunDir, 3) : 0, 0.5 * canopyAt(x, z), dk), k = 1 - D.gloomAt(S.area, z) * (1 - dk);
    let r = (curAmb[0] + curSun[0] * vis) * k, g = (curAmb[1] + curSun[1] * vis) * k, b = (curAmb[2] + curSun[2] * vis) * k;
    const lc = worldU.lampColor.value;
    let lamp = 0;
    for (let i = 0; i < n; i++) {
      const L = must(lights[i]), d = Math.hypot(L.x - x, L.y - y, L.z - z); // guľa okolo lampáša (ako shader)
      const f = 1 - Math.min(1, Math.max(0, d / L.w)); const s = f * f * (3 - 2 * f);
      r += lc.x * s; g += lc.y * s; b += lc.z * s; lamp += s;
    }
    let seen = 1;
    if (cd) {
      const d3 = Math.hypot(cd.eye.x - x, cd.eye.y - y, cd.eye.z - z), d = lerp(d3, Math.hypot(cd.eye.x - x, cd.eye.z - z), dk), e = dk * cd.eyeLit.y * (1 - smooth(0, cd.eyeLit.x, d3));
      r += 0.8 * e; g += 0.85 * e; b += e;
      seen = 1 - dk * smooth(cd.eye.w * 0.6, cd.eye.w * 1.15, d) * (1 - Math.min(1, lamp * 1.6));
      r *= seen; g *= seen; b *= seen; // do tmy (tá je takmer čierna)
    }
    if (out) out.seen = seen;
    return [Math.min(1.4, r), Math.min(1.4, g), Math.min(1.4, b)];
  }
  function canopyAt(x: number, z: number): number {
    const tx = Math.floor(x), tz = Math.floor(z), t = tx >= 0 && tz >= 0 && tx < S.W && tz < S.H ? S.tiles[tz * S.W + tx] : null;
    return t && t.g === 'glade' ? 1 : 0;
  }

  // ---------- Kamera ----------
  let viewTop = 1, viewW = 11;
  // ---------- Objekty, za ktorými stojí hráč: zmiznú a ostane z nich len jemný obrys ----------
  let fadeWant = new Map<FineMesh, number>(), occAt = 0;
  function computeOccluders(meH: number): Set<FineMesh> {
    // pochod cez hrubú mriežku: neviditeľná náhrada každého modelu vie, ku ktorému modelu patrí (bez testov trojuholníkov)
    const toCam = camera.position.clone().sub(camTarget).normalize(), idx = new Set<number>();
    for (const yOff of [0.2, 0.65, 1.15]) W.modelsOnRay(G(), S.me.x, meH + yOff, S.me.y, toCam.x, toCam.y, toCam.z, 25, idx);
    const set = new Set<FineMesh>();
    for (const i of idx) { const m = fineMeshes[i]; if (m) set.add(m); }
    return set;
  }
  // Ktoré objekty zoslabiť a nakoľko (mesh → viditeľnosť): tie, ktoré kamere zakrývajú zem vo vejári pred hráčom.
  // Body na zemi sú len na priechodných políčkach (zem pod kmeňom stromu či pod budovou nie je cesta).
  function fadeTargets(cfg: FadeConfig & { inDark: boolean }, meH: number): Map<FineMesh, number> {
    const out = new Map<FineMesh, number>();
    if (window.MF_NOFADE || !grid) return out;
    const g = grid;
    const toCam = camera.position.clone().sub(camTarget).normalize(), hits = new Set<number>();
    const solid = cfg.solid;
    const lower = (m: FineMesh | undefined, v: number): void => { const cur = m && out.get(m); if (m && !solid.includes(m.fineType) && !(cur != null && cur <= v)) out.set(m, v); };
    let fx, fz;
    if (cfg.dir === 'camera') { const hl = Math.hypot(toCam.x, toCam.z) || 1; fx = toCam.x / hl; fz = toCam.z / hl; }
    else { const a = S.me.a != null ? S.me.a : dirAngle(S.me.dir || 0); fx = Math.cos(a); fz = Math.sin(a); }
    const px = S.me.x, pz = S.me.y, step = Math.max(0.1, cfg.step);
    if (cfg.inDark && cfg.fan) for (let d = 0; d <= cfg.reach + 1e-6; d += step) {
      const hw = cfg.width + cfg.spread * d;
      const vis = cfg.min + (cfg.edge - cfg.min) * Math.max(0, Math.min(1, (d - cfg.near) / Math.max(0.01, cfg.reach - cfg.near)));
      for (let k = -hw; k <= hw + 1e-6; k += step) {
        const x = px + fx * d - fz * k, z = pz + fz * d + fx * k, tx = Math.floor(x), tz = Math.floor(z);
        if (tx < 0 || tz < 0 || tx >= S.W || tz >= S.H || !D.passable(S.tiles[tz * S.W + tx])) continue;
        hits.clear();
        W.modelsOnRay(g, x, W.surfaceY(g, tx, tz) + 0.05, z, toCam.x, toCam.y, toCam.z, 25, hits);
        for (const i of hits) lower(fineMeshes[i], vis);
      }
    }
    for (const m of computeOccluders(meH)) lower(m, cfg.min); // objekty, za ktorými hráč stojí – všade
    return out;
  }
  function updateFades(dt: number, meH: number): boolean {
    const now = performance.now(), cfg = fadeCfg();
    if (now - occAt > 100) {
      fadeWant = fadeTargets(cfg, meH); occAt = now;
      for (const [m, v] of fadeWant) { m.want = v; m.wantUntil = now + cfg.hold; }
    }
    let any = false;
    const fadingList: FineMesh[] = [];
    for (const m of fineMeshes) {
      // zoslabený ostane ešte chvíľu po tom, čo z oblasti vypadol – na hrane oblasti tak nebliká
      // koruna obrovského stromu je zoslabená stále (kmeň ostáva plný v shaderi), ostatné len keď zakrývajú hráča
      const target = m.fineType === 'giant' ? cfg.min : now < m.wantUntil ? m.want : 1;
      // priblíž sa k cieľu najviac o dt × speed – keď je cieľ dosiahnutý, hodnota ostane stáť (žiadne kmitanie)
      const step = dt * cfg.speed, cur = m.fade;
      const f = m.fade = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
      const fading = f < 0.98;
      m.material = fading ? fineMats.fade : m.base ?? fineMats.main;
      if (m.depthTwin) m.depthTwin.visible = fading && m.visible;
      if (fading) { any = true; fadingList.push(m); }
    }
    // Zoslabené objekty kreslíme odzadu dopredu a každý celý naraz (najprv jeho hĺbka, potom priesvitná plocha).
    // Pri prekrytí dvoch zoslabených objektov tak vidno oba a poradie sa medzi snímkami nemení.
    if (fadingList.length) {
      const toCam = camera.position.clone().sub(camTarget).normalize(), c = new THREE.Vector3();
      const depthOf = (m: FineMesh): number => m.box.getCenter(c).dot(toCam);
      fadingList.sort((a, b) => depthOf(a) - depthOf(b) || a.id - b.id);
      fadingList.forEach((m, i) => { if (m.depthTwin) m.depthTwin.renderOrder = 2 + i * 2; m.renderOrder = 3 + i * 2; });
    }
    return any;
  }
  // Je postavička celá za stromom (z pohľadu kamery)? Lúče od nôh, pása aj hlavy ku kamere narazia na model.
  function hiddenByTree(o: CharObj): boolean {
    const toCam = camera.position.clone().sub(camTarget).normalize(), hit = new Set<number>();
    for (const yOff of [0.15, 0.6, 1.1]) {
      hit.clear();
      W.modelsOnRay(G(), o.sp.position.x, o.sp.position.y + yOff, o.sp.position.z, toCam.x, toCam.y, toCam.z, 6, hit);
      // cez zoslabený strom vidno; obor je dolu (kmeň, korene – kam lúče od postavy siahajú) vždy plný
      if (![...hit].some(i => { const m = fineMeshes[i]; return m && m.visible && (m.fade > 0.5 || m.fineType === 'giant'); })) return false;
    }
    return true;
  }
  // Obrys zoslabených objektov cez stencil buffer – v tom istom snímku, bez pomocného obrázka a bez prepínania
  // cieľa vykresľovania (to na mobilných GPU spôsobovalo blikanie celej obrazovky):
  // 1) všetky zoslabené objekty sa označia v stencile, 2) každý sa nakreslí niekoľkokrát posunutý o ~1,5 px do strán
  // len mimo označenia. Prekryté objekty (napr. stromy v hustom lese) tak majú jeden spoločný obrys bez hrán medzi sebou;
  // obrys zapisuje do stencilu, takže sa ani na prekrytí nekreslí dvakrát.
  const stencilMark = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp
  });
  const outlineDraw = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1, 0.97, 0.9), transparent: true, opacity: 0.7, depthWrite: false, depthTest: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp
  });
  const OUTLINE_DIRS = ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).map(([x, y]) => [x * 0.85, y * 0.85] as const); // 4 posuny stačia na obrys ~1,5 px
  const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  function drawOutlines(): void {
    const cfg = fadeCfg();
    if (cfg.outline <= 0) return; // obrys vypnutý (Les divov, alebo MF_FADE = { outline: 0 })
    const cssW = api.glCanvas.getBoundingClientRect().width || 1;
    const px = (camera.right - camera.left) / cssW * 1.5; // ~1,5 CSS px vo svetových jednotkách
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    renderer.autoClear = false;
    const list = fineMeshes.filter(m => m.fade <= 0.98);
    for (const m of list) {
      const old = m.material;
      m.material = stencilMark;
      renderer.render(m, camera);
      m.material = old;
    }
    for (const m of list) {
      const old = m.material, pos = m.position.clone();
      outlineDraw.opacity = cfg.outline * Math.min(1, (1 - m.fade) / Math.max(0.01, cfg.outlineRamp));
      m.material = outlineDraw;
      for (const [dx, dy] of OUTLINE_DIRS) {
        m.position.copy(pos).addScaledVector(camRight, dx * px).addScaledVector(camUp, dy * px);
        renderer.render(m, camera);
      }
      m.position.copy(pos);
      m.material = old;
      m.updateMatrixWorld();
    }
    renderer.autoClear = true;
  }

  let viewDiag = D.VIEW_DIAG;
  function resize(): void {
    const r = api.glCanvas.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    // uhlopriečka zobrazovacej plochy má vždy viewDiag blokov (D.VIEW_DIAG, v Lese divov menej), hráč v strede
    viewW = D.viewSize(r.width, r.height, viewDiag).w;
    const vh = D.viewSize(r.width, r.height, viewDiag).h;
    viewTop = vh / 2;
    camera.left = -viewW / 2; camera.right = viewW / 2; camera.top = viewTop; camera.bottom = viewTop - vh;
    camera.updateProjectionMatrix();
  }
  const camTarget = new THREE.Vector3();
  function placeCamera(dt: number): void {
    if (api.placeCamera) {
      api.placeCamera(camera, camTarget, dt);
      viewW = camera.right - camera.left; viewTop = (camera.top - camera.bottom) / 2; // výrez pre častice a prekrytie
      return;
    }
    yaw = lerp(yaw, yawTarget, Math.min(1, dt * 8));
    if (Math.abs(yaw - yawTarget) < 0.001) yaw = yawTarget;
    const me = S.me, h = groundY(me.x, me.y);
    camTarget.set(me.x, lerp(camTarget.y || h, h, Math.min(1, dt * 6)), me.y);
    const dist = 60;
    camera.position.set(camTarget.x + Math.sin(yaw) * Math.cos(PITCH) * dist, camTarget.y + Math.sin(PITCH) * dist, camTarget.z + Math.cos(yaw) * Math.cos(PITCH) * dist);
    camera.lookAt(camTarget);
  }
  function rotate(k: number): void { yawTarget += k * Math.PI / 2; }
  // vektor z joysticku (obrazovka: x vpravo, y dole) → smer vo svete
  function screenToWorld(vx: number, vy: number): [number, number] {
    return [vx * Math.cos(yaw) + vy * Math.sin(yaw), -vx * Math.sin(yaw) + vy * Math.cos(yaw)];
  }

  // ---------- Výber objektu ťuknutím (lúč do scény) ----------
  const ray = new THREE.Raycaster();
  ray.layers.enableAll();
  function pick(clientX: number, clientY: number): Pt | null {
    const r = api.glCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // kvety a huby sa nevyberajú podľa obrázka – platí len políčko zeme pod nimi
    // vlastná postavička je pre ťuknutie priehľadná – zakrýva políčko za sebou, to hráč myslí
    const sprites: THREE.Object3D[] = [...chars.entries()].filter(([id, o]) => o.alive && id !== 'me').map(([, o]) => o.sp);
    if (babka) sprites.push(babka.sp);
    if (master) sprites.push(master.sp);
    // Les divov (temná plocha): ťuknutie prechádza cez všetky objekty (stromy, kmene, kry…) na zem pod prstom –
    // ťukať sa bude len na vyslovene hracie objekty (a na hráčov), premietnutie na stromy by prekáželo
    const objects: THREE.Object3D[] = D.isDark(S.area) ? [] : [...fineMeshes.filter(m => m.visible && m.fade > 0.5), ...fineMeshes.flatMap(m => m.solidPart ? [m.solidPart] : [])];
    sprites.push(...vehicles3d.pickables()); // fúrik a sane (#158): ťuknutie na obrázok = ich políčko
    const hits = ray.intersectObjects([...sprites, ...(mesh ? [mesh] : []), ...(glacierMesh ? [glacierMesh] : []), ...(waterMesh ? [waterMesh] : []), ...objects], false);
    for (const h of hits) {
      const o = h.object;
      if (o instanceof TileSprite || o instanceof THREE.Sprite) return o instanceof TileSprite && o.tile ? { ...o.tile } : null; // sprite bez políčka (pavúk) nič nevyberie
      if (o instanceof TileMesh && o.tile) return { ...o.tile };
      if (!h.face) continue;
      const q = h.point.clone().addScaledVector(h.face.normal, -0.01);
      const x = Math.floor(q.x), y = Math.floor(q.z);
      if (x >= 0 && y >= 0 && x < S.W && y < S.H) return { x, y };
    }
    return null;
  }

  // ---------- Prekrytie: mená, bubliny, efekty, počasie ----------
  const ov = api.ovCtx;
  const v3 = new THREE.Vector3();
  function project(x: number, y: number, z: number): Pt {
    v3.set(x, y, z).project(camera);
    const c = api.ov;
    return { x: (v3.x + 1) / 2 * c.width, y: (1 - v3.y) / 2 * c.height };
  }
  function pxPerBlock(): number { return api.ov.width / viewW; }

  // stav budov, ktorý nie je v políčkach (izolácia ľadovne, krosná v Dielni) – keď sa zmení, svet sa prestavia
  const buildingState = (): { ins: number; loom: boolean } => ({ ins: D.insulLevel(S.icehouse?.bl), loom: S.dielna?.loom ?? false });
  const stateSig = (): string => { const b = buildingState(); return b.ins + '|' + (b.loom ? 1 : 0); };
  let builtState: string | null = null;
  let babka: CharObj | null = null, master: CharObj | null = null, last = performance.now(), lastGround = 0;
  function frame(t: number): void {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (statsOn) renderer.info.reset();
    const min = api.curMin(), se = api.season(), night = D.isNight(min);
    applyZPrio();
    // prestavba sveta: nové obdobie, iná plocha (záhrada / hory) alebo nová stavba
    if (builtSeason !== se || builtGen !== S.tilesGen || builtState !== stateSig()) { builtGen = S.tilesGen; builtState = stateSig(); buildMesh(se); holesSig = null; refreshGround(se, t, true); }
    S.worldGen = builtGen; // svet tejto verzie políčok je postavený (prechod medzi plochami čaká, kým je, a až potom ukáže meno)
    if (now - lastGround > 600) { refreshGround(se, t, false); lastGround = now; }
    // v Lese divov (a cestou k nemu) je pohľad bližšie na hráča
    const vd = D.viewDiagAt(S.area, S.me.y);
    if (Math.abs(vd - viewDiag) > 0.01) { viewDiag = vd; resize(); }
    lighting(min, se);
    let tp = statsOn ? performance.now() : 0;
    updateShadowMap(min, se);
    if (statsOn) passMs.shadow = performance.now() - tp;
    placeCamera(dt);

    // svetelné zdroje (okná, kotlík, lampáše, hráči, víly, svietiace kvety) – len keď je šero
    // každé svetlo blčí ako plameň: oheň najviac, lampáše menej, okná a ostatné len jemne
    const lights: THREE.Vector4[] = [];
    // v tmavom lese je šero aj cez deň – lampáše svietia podľa svetla tam, kde stojí hráč
    // v Lese divov (temná plocha) je tma aj cez deň – lampáš svieti vždy
    const dark = D.DARK[S.area], kd = D.darkAt(S.area, S.me.y), DL = D.DARK.les;
    const dl = W.daylight(min) * (1 - D.gloomAt(S.area, S.me.y)) * (1 - kd);
    const lampState = dl < LAMP_DUSK ? 'lit' : 'on'; // lampáš v ruke horí, len keď je šero
    if (dl < LAMP_DUSK && layerOn('lights')) {
      const A = api.S.anchors;
      const add = (x: number, y: number, z: number, r: number, fl?: number): void => { if (lights.length < MAX_LIGHTS) lights.push(new THREE.Vector4(x, y, z, r * flicker(t, x * 7.1 + z * 3.3, fl || FL_SOFT))); };
      // hráč svieti, len keď drží lampáš (svetlo pri ruke, blčí ako plameň); bez lampáša je potme
      const lampR = lerp(LAMP_R, DL.lampR, kd); // v Lese divov (a cestou k nemu) lampáš svieti slabšie a na kratšiu vzdialenosť
      if (S.sel === 'lamp') add(S.me.x, 1.1, S.me.y, lampR, FL_LANTERN);
      for (const o of S.others.values()) if (o.lp) add(o.x, 1.1, o.y, lampR, FL_LANTERN);
      if (A.hut) { add(A.hut.x + 0.5, 2.05, A.hut.y + 2.2, 2.2, FL_WINDOW); add(A.hut.x + 2.4, 2.05, A.hut.y + 2.2, 2.2, FL_WINDOW); }
      if (A.house) { add(A.house.x + 0.62, 2.2, A.house.y + 2.3, 2.2, FL_WINDOW); add(A.house.x + 2.37, 2.2, A.house.y + 2.3, 2.2, FL_WINDOW); add(A.house.x + 2.06, 2.4, A.house.y + 2.06, 1.8, FL_LANTERN); }
      if (A.cauldron) add(A.cauldron.x + 0.5, 1.3, A.cauldron.y + 0.5, 2.6, FL_FIRE);   // oheň pod kotlíkom
      if (A.stall) add(A.stall.x + 2.94, 2.56, A.stall.y + 0.94, 2.4, FL_FIRE);              // lampáš na trhu (horí v ňom plamienok)
      particles.fairyLights(grid, t, add);
      for (let i = 0; i < S.tiles.length && lights.length < MAX_LIGHTS; i++) {
        const p = S.tiles[i]?.s?.p;
        if (p && !p.d && (p.sp === 'papradie' || p.sp === 'duhova') && D.stageOf(p) === 3) add(i % S.W + 0.5, 1.6, ((i / S.W) | 0) + 0.5, 2.2);
      }
    }
    const lu = worldU.lights.value;
    lights.forEach((l, i) => { must(lu[i]).copy(l); });
    worldU.lightCount.value = lights.length;
    lastLights = lights;
    // temná plocha: oko hráča (odkiaľ vidí) a dohľad – s lampášom v ruke ďalej
    const eyeR = kd > 0 ? (S.sel === 'lamp' ? DL.lamp : DL.sight) : 0;
    if (kd > 0) worldU.eye.value.set(S.me.x, groundY(S.me.x, S.me.y) + 0.9, S.me.y, eyeR);
    if (dark) updateShafts(curSunDir, W.daylight(min), eyeR);

    // sprity
    syncPlants(night);
    for (const sp of plantSprites.values()) {
      let lit = sp.lit;
      if (!lit || now - sp.litAt > 400) {
        lit = sp.lit = lightAt(sp.position.x, sp.position.y, sp.position.z, lights, lights.length);
        sp.litAt = now + Math.random() * 200;
      }
      sp.material.color.setRGB(...lit);
    }
    for (const o of chars.values()) o.alive = false;
    const me = S.me;
    vehicles3d.update(dt, lights); // fúrik a sane (#158); spolujazdec je nakreslený v nich (jeho postavička sa skryje, meno ostane)
    boat3d.update(dt, t); // loďka (#160) – pred postavičkami, ktoré v nej sedia (sú nakreslené v jej obrázku)
    const seatMe = vehicles3d.seat('me');
    const meSeat = api.noPlayer ? null : boat3d.seat(null), seated = new Set<CharId>(meSeat ? ['me'] : []);
    const meO = api.noPlayer ? null : drawChar('me', me.x, me.y, S.look, me.a != null ? me.a : dirAngle(me.dir), seatMe || meSeat ? 0 : S.myEmote === 'dance' ? t * 4 : me.phase, { dance: S.myEmote === 'dance', jz: me.jz + seatMe, crawl: me.crawl || seatMe > 0, dig: api.searching({ si: S.mySi }) ? t : 0, lamp: S.sel === 'lamp' && lampState, web: S.webLeft ? S.webLeft() : 0, seat: meSeat }, dt);
    for (const o of S.others.values()) { const seat = vehicles3d.seat(o.id), os = boat3d.seat(o); if (os) seated.add(o.id); drawChar(o.id, o.x, o.y, o.look, o.a != null ? o.a : dirAngle(o.dir || 0), seat || os ? 0 : o.e === 'dance' ? t * 4 : o.phase, { dance: o.e === 'dance', jz: o.jz + seat, crawl: o.cr || seat > 0, dig: api.searching(o) ? t : 0, lamp: o.lp && lampState, web: o.wb || 0, seat: os }, dt); }
    if (S.area !== 'garden') babka = null; // babka býva v záhrade (bez alive ju upratovanie nižšie odstráni)
    else if (!babka) babka = drawChar('babka', D.BABKA.x + 0.5, D.BABKA.y + 0.75, { shirt: '#7b4a9e', hair: '#eee' }, Math.PI / 2, 0, { babka: true }, 1);
    else { babka.alive = true; if (Math.floor(t) !== babka.lastT) { babka.lastT = Math.floor(t); drawChar('babka', D.BABKA.x + 0.5, D.BABKA.y + 0.75, { shirt: '#7b4a9e', hair: '#eee' }, Math.PI / 2, Math.sin(t) * 0.3, { babka: true }, 1); } }
    // majster hodvábu (len na jar a na jeseň): cez deň stojí pri trhu, na noc ide k babke do chalúpky (D.masterAt – ako na serveri);
    // keď kráča, kreslí sa každý snímok, keď stojí, len občas (prekreslenie postavičky nie je zadarmo)
    const ma = S.area === 'garden' ? D.masterAt(S.day, min, S.dielna?.loom) : null; // po kúpe krosien už nechodí
    if (!ma) master = null;
    else if (!master || !ma.still || master.wasWalking || Math.floor(t * 0.7) !== master.lastT) {
      master = drawChar('master', ma.x, ma.y + (ma.still ? 0.1 : 0), D.MASTER_LOOK, ma.a, ma.still ? Math.sin(t * 0.7) * 0.25 : t * 9, {}, dt || 1);
      master.lastT = Math.floor(t * 0.7); master.wasWalking = !ma.still;
    } else master.alive = true;
    for (const [id, o] of chars) {
      // po vlastnom prechode do inej plochy hráči zo starej plochy hneď zmiznú (je to za čiernou clonou)
      if (!o.alive && (o.vis <= 0 || o.seenArea !== S.area || id === 'babka' || id === 'master' || id === 'me')) { removeChar(id, o); continue; }
      if (o.vis < 1 || !o.alive) setCharVis(o, Math.max(0, Math.min(1, o.vis + (o.alive ? dt : -dt) / CHAR_FADE)));
      const lo = { seen: 1 };
      o.sp.material.color.setRGB(...lightAt(o.sp.position.x, o.sp.position.y, o.sp.position.z, lights, lights.length, lo));
      // v tme: kto je za dohľadom (a nesvieti mu lampáš), toho nevidno; cez stromy presvitá len vlastná postavička
      o.seen = id === 'me' ? 1 : lo.seen;
      if (dark && id !== 'me' && o.seen > 0.02 && hiddenByTree(o)) o.seen = 0; // za kmeňom nevidno ani meno
      o.sp.visible = o.shadow.visible = o.seen > 0.02;
      o.ghost.visible = !dark || id === 'me';
      if (vehicles3d.seat(id)) o.sp.visible = o.ghost.visible = o.shadow.visible = false; // spolujazdec je nakreslený vo fúriku (#158)
      o.sp.renderOrder = vehicles3d.tows(id) ? 1 : 0; // kto ťahá sane, kreslí sa až po lane – lano je vždy za ním (#158)
    }
    vehicles3d.ropes(); // lano saní do ruky ťahajúceho – až po nakreslení postavičiek (ich poloha a póza z tejto snímky)
    // kto sedí v loďke, je nakreslený v jej obrázku – vlastná postavička, tieň aj röntgen sa skryjú (meno ostane)
    for (const id of seated) { const o = chars.get(id); if (o) o.sp.visible = o.shadow.visible = o.ghost.visible = false; }
    spiders3d.update(dt, t, lights); // pavučiny, nory a pavúky (#57)

    const fading = updateFades(dt, meO ? meO.h ?? 1 : 1);
    const lit = zip3(curAmb, curSun, (a, s) => Math.min(1.2, a + s * 0.7));
    if (layerOn('particles')) particles.update(dt, t, { grid, fine: grid && grid.fine, fineBox: i => fineMeshes[i]?.box, target: camTarget, viewW, viewH: viewTop * 2, se, min, lit, cauldron: fireCenter(), lantern: lanternCenter() });
    updateWater(t, now);
    if (api.beforeRender) api.beforeRender();
    if (statsOn) tp = performance.now();
    renderReflection();
    if (statsOn) { const q = performance.now(); passMs.refl = q - tp; tp = q; }
    renderer.render(scene, camera);
    if (fading) drawOutlines();
    if (statsOn) passMs.scene = performance.now() - tp;
    drawOverlay(t);
  }

  function drawOverlay(t: number): void {
    const c = ov, cw = api.ov.width, ch = api.ov.height, ppb = pxPerBlock();
    c.clearRect(0, 0, cw, ch);
    // značka ťuknutia a cieľové políčko (klávesnica)
    const ring = (x: number, y: number, color: string, r: number): void => {
      const h = groundY(x, y);
      const pts = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([a, b]) => project(x + 0.5 + (a - 0.5) * r, h + 0.01, y + 0.5 + (b - 0.5) * r));
      c.strokeStyle = color; c.lineWidth = Math.max(2, ppb * 0.05);
      c.beginPath(); pts.forEach((p, i) => { if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }); c.closePath(); c.stroke();
    };
    if (S.tapMark) {
      const age = (performance.now() - S.tapMark.t) / 600;
      // v temnej ploche sa nič nezvýrazňuje (ani to, na čo sa dá ťuknúť)
      if (age < 1) ring(S.tapMark.x, S.tapMark.y, S.tapMark.act && !D.isDark(S.area) ? `rgba(255,230,90,${1 - age})` : `rgba(255,255,255,${0.8 - age * 0.8})`, 0.5 + age * 0.4);
      else S.tapMark = null;
    }
    if (S.kbd) { const f = api.frontTile(); if (f.x >= 0 && f.y >= 0 && f.x < S.W && f.y < S.H) ring(f.x, f.y, api.ctxAction(f.x, f.y) && !D.isDark(S.area) ? 'rgba(255,230,90,0.8)' : 'rgba(255,255,255,0.3)', 0.9); }

    // efekty (častice z S.fx sa hýbu po rovine sveta – ukotvíme ich do bodu vo svete)
    for (const p of S.fx) {
      if (p.fairy) continue; // víly sú 3D častice (particles3d.ts)
      const a = 1 - p.life / p.max;
      const ox = p.ox ??= p.x, oy = p.oy ??= p.y; // kde efekt vznikol (pohyb sa kreslí na obrazovke od tohto bodu)
      const gy = grid ? W.surfaceY(grid, Math.max(0, Math.min(S.W - 1, Math.floor(ox))), Math.max(0, Math.min(S.H - 1, Math.floor(oy)))) : 1;
      const o = project(ox, gy + 0.5, oy);
      const X = o.x + (p.x - ox) * ppb, Y = o.y + (p.y - oy) * ppb;
      c.globalAlpha = Math.max(0, a);
      if (p.text) { c.font = (ppb * 0.4 | 0) + 'px serif'; c.textAlign = 'center'; c.fillText(p.text, X, Y); }
      else if (p.star) { const s = ppb * p.size * (0.6 + 0.4 * Math.sin(p.life * 12)); c.fillStyle = p.color ?? '#fff'; c.fillRect(X - s / 2, Y - s * 1.5, s, s * 3); c.fillRect(X - s * 1.5, Y - s / 2, s * 3, s); }
      else Art.circ(c, X, Y, ppb * p.size, p.color ?? '#fff');
      c.globalAlpha = 1;
    }

    // počasie
    const ts = ppb;
    // mená, emócie, bubliny
    const label = (o: CharObj, name: string, e: string | null, bubble: { text: string; until: number } | null | undefined): void => {
      c.globalAlpha = o.vis * (o.seen == null ? 1 : o.seen); // meno sa prelína s postavičkou (v tme zmizne s ňou)
      if (c.globalAlpha < 0.02) return;
      const P = project(o.sp.position.x, o.sp.position.y + 1.35, o.sp.position.z);
      c.font = 'bold ' + (ts * 0.24 | 0) + 'px system-ui, sans-serif'; c.textAlign = 'center';
      const w = c.measureText(name).width + ts * 0.2;
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(P.x - w / 2, P.y - ts * 0.22, w, ts * 0.3);
      c.fillStyle = '#fff'; c.fillText(name, P.x, P.y);
      if (e) { c.font = (ts * 0.42 | 0) + 'px serif'; c.fillText(e === 'dance' ? (Math.floor(t * 3) % 2 ? '🎵' : '🎶') : api.EMOJI[e] ?? '', P.x + ts * 0.45, P.y - ts * 0.25 + Math.sin(t * 6) * ts * 0.05); }
      if (bubble && bubble.until > performance.now()) Art.bubble(c, bubble.text, P.x, P.y, ts);
      c.globalAlpha = 1;
    };
    spiders3d.overlay(c, ppb, t); // oči pavúkov v tme
    for (const o of S.others.values()) { const co = chars.get(o.id); if (co) label(co, o.name, o.e, typeof o.id === 'number' ? S.bubbles[o.id] : undefined); }
    const mo = chars.get('me'); if (mo) label(mo, S.name, S.myEmote, S.bubbles[S.id]);
    if (babka) label(babka, 'Babka', null, null);
    if (master) label(master, 'Majster hodvábu', null, null);

    // dúha a zlatý dážď
    for (const fx of S.screenFx) {
      const a = Math.min(1, fx.life, fx.max - fx.life);
      if (fx.k === 'rainbow') {
        const cols = ['#ff5252', '#ffb74d', '#fff176', '#81c784', '#64b5f6', '#7986cb', '#ba68c8'];
        c.globalAlpha = a * 0.45; c.lineWidth = cw * 0.035;
        cols.forEach((col, i) => { c.strokeStyle = col; c.beginPath(); c.arc(cw / 2, ch * 0.75, cw * (0.75 - i * 0.035), Math.PI, 0); c.stroke(); });
        c.globalAlpha = 1;
      } else {
        c.font = (ts * 0.45 | 0) + 'px serif'; c.textAlign = 'center';
        for (const k of fx.coins ?? []) c.fillText('🪙', k.x * cw, (k.y + fx.life * k.v) * ch);
      }
    }
  }

  // hodiny priameho slnka pre políčko (zatiaľ len informácia; neskôr pre rast rastlín)
  function sunHoursAt(x: number, y: number): number | null { return grid ? W.sunHours(grid, x, y, api.season()) : null; }

  // ---------- Častice a blčanie svetiel ----------
  const sceneBefore = new Set(scene.children);
  const particles = createParticles({ scene, camera, renderer, S, ripple });
  const particleObjs = scene.children.filter(o => !sceneBefore.has(o)); // objekty častíc (ladiaca stránka ich vie skryť)
  const boat3d = createBoat3d({ THREE, scene, camera, S, dir8, yaw: () => yaw, light: (x, y, z) => lightAt(x, y, z, lastLights, lastLights.length) });
  const spiders3d = createSpiders3d({ THREE, scene, S, groundY, lightAt, spriteTex, makeSprite, project, camera, camTarget, renderer, world: worldU, maxLights: MAX_LIGHTS, fine: () => grid && grid.fine });
  // Ruka postavičky vo svete (lano saní, #158): bod, ktorý Art.handAt vráti pre jej poslednú kresbu, na rovine spritu
  // (sprite: 100 px = 1 blok, chodidlá v (48, 124) plátna 96 × 128, kotva 3 % od spodku)
  const handRight = new THREE.Vector3(), handUp = new THREE.Vector3();
  function handOf(charId: CharId): THREE.Vector3 | null {
    const o = chars.get(charId);
    if (!o || !o.pose || !o.alive) return null;
    const h = Art.handAt(48, 124, 100, o.pose.dir, o.pose.phase, o.pose.o);
    handRight.setFromMatrixColumn(camera.matrixWorld, 0); handUp.setFromMatrixColumn(camera.matrixWorld, 1);
    return o.sp.position.clone().addScaledVector(handRight, (h.x - 48) / 100).addScaledVector(handUp, (128 * 0.97 - h.y) / 100);
  }
  const vehicles3d = createVehicles3d({ THREE, scene, S, groundY, makeSprite, spriteTex, lightAt, shadow: blobShadow, dir8, yaw: () => yaw, hand: handOf }); // fúrik a sane (#158)
  // stred ohniska pod kotlíkom (model má okraj FM minikociek, ohnisko je v strede políčka nad zemou)
  function fireCenter(): { x: number; y: number; z: number } | null {

    const f = grid && grid.fine.find(m => m.type === 'cauldron');
    return f ? { x: f.ox + 1, y: f.oy + 1.5 / W.FINE, z: f.oz + 1 } : null;
  }
  // lampáš na trhu: minikocka (23, 12, 7) modelu stánku, k tomu okraj modelu 4 minikocky
  function lanternCenter(): { x: number; y: number; z: number } | null {
    const f = grid && grid.fine.find(m => m.type === 'stall');
    return f ? { x: f.ox + 27.5 / W.FINE, y: f.oy + 12.5 / W.FINE, z: f.oz + 11.5 / W.FINE } : null;
  }

  // ---------- Ladiaca stránka: pohľad dovnútra a uvoľnenie ----------
  let lastLights: THREE.Vector4[] = [];
  function debugView(): DebugView {
    return { THREE, scene, camera, camTarget, lightCam, renderer, grid, mesh, fineMeshes, waterMesh, lilyMesh, glacierMesh, plantSprites, chars, particleObjs,
      lights: lastLights, materials: [material, reflMaterial, waterMaterial, glacierMaterial, ...Object.values(fineMats)], groundY };
  }
  function invalidateShadows(): void { shadowDirty = true; }
  function dispose(): void {
    spiders3d.dispose();
    vehicles3d.dispose();
    boat3d.dispose();
    scene.traverse(o => {
      const g: unknown = 'geometry' in o ? o.geometry : null, mat: unknown = 'material' in o ? o.material : null;
      if (g instanceof THREE.BufferGeometry) g.dispose();
      for (const m of [mat].flat()) if (m instanceof THREE.Material) m.dispose();
    });
    for (const t of texCache.values()) t.dispose();
    groundTex.dispose(); shadowRT.dispose(); if (reflRT) reflRT.dispose(); if (maskTex) maskTex.dispose();
    renderer.dispose(); renderer.forceContextLoss();
  }

  resize();
  // ladenie: priehľadnosť jemných modelov (1 = plne viditeľný)
  const debugFades = (): { type: string; fade: number; want: number | null }[] => fineMeshes.map(m => { const w = fadeWant.get(m); return { type: m.fineType, fade: +m.fade.toFixed(2), want: w != null ? +w.toFixed(2) : null }; });
  // Nakoľko je bod (x, z) na zemi vidno (0 = tma, 1 = celý) – v temnej ploche podľa dohľadu a svetla lampášov, inde 1
  function seenAt(x: number, z: number): number {
    if (!curDark || !grid) return 1;
    const o = { seen: 1 };
    lightAt(x, groundY(x, z), z, lastLights, lastLights.length, o);
    return o.seen;
  }
  return { frame, resize, pick, seenAt, screenToWorld, rotate, sunHoursAt, dir8, debugFades, ripple, setWaterQuality, get waterQuality() { return waterQuality; }, setParticleQuality: particles.setQuality, get particleQuality() { return particles.quality; }, setStats, stats, get yaw() { return yaw; }, debugView, invalidateShadows, dispose };
}


