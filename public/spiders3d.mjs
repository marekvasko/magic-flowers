// 3D pavúky a pavučiny (#57): pavučiny medzi kmeňmi v Lese divov (v tme ich vidno len v dohľade, s lampášom sa lesknú
// kúsok ďalej), nory vlčiakov, kútové pavučiny krížiaka v záhrade a v horách a samotné pavúky (sprity s krokom nôh).
// V tme sú z pavúkov za dohľadom vidno len lesknúce sa oči (kreslia sa do prekrytia).
// render3d.mjs volá update() každú snímku a overlay() pri kreslení prekrytia.

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
uniform vec2 uSize;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz; vP = uv * uSize;
  vAx = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0)); vAy = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
// Svetlo na hodvábe (spoločné pre shader na rovine aj pre čiary): okolie, slnko, lampáše (guľa okolo zdroja), slabé svetlo
// pri hráčovi; vlákno, nie plocha – rozptyl aj odlesk podľa smeru vlákna T (Kajiya–Kay), odlesk jemne dúhový.
// V tme za dohľadom vlákna zmiznú ako svet, lampášom osvetlené ostanú (aj o kúsok ďalej sa lesknú).
const SILK_GLSL = (MAX) => `
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
export const WEB_FRAG = (MAX) => `
precision highp float;
#define TAU 6.28318530718
uniform vec2 uSize; uniform float uKeep;
uniform vec4 uMode; // x výplň (0 špirála, 1 kruhy), y kútová (spleť), z počet lúčov, w rozostup závitov
uniform vec4 uA;    // ohnutie lúčov, jeho frekvencia, zvlnenie závitov, jeho frekvencia
uniform vec4 uB;    // stred, voľná zóna, polomer, šum okraja
uniform vec4 uD;    // šum rozostupu, prehnutie nosných vlákien, závoj kútovej pavučiny
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

// Kútová pavučina (krížiak, zaprášený kút): šikmá plocha od steny (hore, y = výška) k zemi (dole) pri päte steny;
// x = šírka je koniec steny. Pavučina je trojuholníková blana vtlačená do kúta pri konci steny: veľa krátkych vlákien
// krížom-krážom, pár dlhých nosných a zaprášený závoj (Perlinov šum), najhustejší pri samom kúte.
float tangle(vec2 p, out vec2 tl, out float veil) {
  vec2 S = uSize, q = p / S; float m = 0.0, w = uC.x * 0.55; tl = vec2(0.0, 1.0);
  float tri = q.x + q.y; // trojuholník pri konci steny: q.x + q.y ≥ 1
  if (tri < 0.85) { veil = 0.0; return 0.0; }
  for (int i = 0; i < 36; i++) { // krátke vlákna krížom-krážom
    float fi = float(i);
    vec2 u = vec2(h11(fi), h11(fi + 7.0)); if (u.x + u.y < 1.0) u = 1.0 - u; // náhodný bod v trojuholníku
    float an = h11(fi + 13.0) * TAU, ln = (0.12 + 0.3 * h11(fi + 19.0)) * S.x;
    vec2 a = u * S, b = a + vec2(cos(an), sin(an)) * ln;
    float t = thread(segDist(p, a, b), w) * (0.4 + 0.5 * h11(fi + 23.0));
    if (t > m) { m = t; tl = normalize(b - a); }
  }
  for (int i = 0; i < 7; i++) { // nosné: z konca steny (x = šírka) na stenu (y = výška), mierne prehnuté
    float fi = float(i) + 90.0;
    vec2 a = vec2(S.x, h11(fi) * S.y), b = vec2((0.05 + 0.9 * h11(fi + 5.0)) * S.x, S.y);
    vec2 c = mix(a, b, 0.5) - vec2(0.06, 0.06) * S * h11(fi + 9.0);
    float t = thread(min(segDist(p, a, c), segDist(p, c, b)), w * 1.2);
    if (t > m) { m = t; tl = normalize(b - a); }
  }
  m *= smoothstep(0.85, 1.0, tri);
  float n = perlin(p * 14.0 + gSeed) * 0.6 + perlin(p * 37.0) * 0.4;
  veil = uD.z * smoothstep(0.9, 1.45, tri) * smoothstep(-0.3, 0.3, n);
  return m;
}

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
  if (uMode.y > 0.5) {
    mask = tangle(vP, tl, veil);
  } else {
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
// Materiál jednej pavučiny: P = Webs.webParams(...), opts = { w, h, seed, keep (0–1 koľko vlákien ostalo), corner }.
// Veľká pavučina má náhodne veľa stredov (1 … P.hubs, na každý aspoň P.hubSpan políčka šírky) a na každom kmeni
// náhodne veľa kotviacich vlákien (P.moorMin … P.moor).
// world = uniformy svetla (svet v hre, vlastné v ladiacej stránke), view = { value: Vector3 } smer ku kamere.
export function webMaterial(THREE, world, view, P, opts, maxLights) {
  const { w, h, corner } = opts, L = window.Webs.webLayout(P, opts);
  const hx = [0, 0, 0, 0], hy = [0, 0, 0, 0];
  L.hubs.forEach((c, i) => { hx[i] = c.x; hy[i] = c.y; });
  const mat = new THREE.ShaderMaterial({
    vertexShader: WEB_VERT, fragmentShader: WEB_FRAG(maxLights), transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: Object.assign(silkUniforms(THREE, world, view, P, L.seed, corner), {
      uSize: { value: new THREE.Vector2(w, h) }, uKeep: { value: opts.keep == null ? 1 : opts.keep },
      uMode: { value: new THREE.Vector4(L.fill, corner ? 1 : 0, P.rays, L.pitch) },
      uA: { value: new THREE.Vector4(P.bend, P.bendFreq, P.wobble, P.wobbleFreq) },
      uB: { value: new THREE.Vector4(P.hub, P.free, P.radius, P.edgeNoise) },
      uD: { value: new THREE.Vector4(P.pitchNoise, P.sag, corner ? P.veil : 0, 0) },
      uE: { value: new THREE.Vector4(P.raysVar, L.nH, L.moor[0], L.moor[1]) },
      uHX: { value: new THREE.Vector4(...hx) }, uHY: { value: new THREE.Vector4(...hy) }
    })
  });
  mat.userData.info = { hubs: L.nH, moor: L.moor, fill: L.fill, render: 'shader' };
  return mat;
}
function silkUniforms(THREE, world, view, P, seed, corner) {
  return {
    ambient: world.ambient, sunColor: world.sunColor, sunDir: world.sunDir, lampColor: world.lampColor, lights: world.lights, lightCount: world.lightCount,
    darkOn: world.darkOn, eye: world.eye, eyeLit: world.eyeLit, uView: view, uSeed: { value: seed % 97 },
    uC: { value: new THREE.Vector4(P.width * (corner ? 1.2 : 1), P.glint, P.iri, P.alpha) }
  };
}

// ---------- Pavučina z čiar ----------
// Skutočné 3D vlákna (Webs.webThreads: tie isté parametre, vydutie z roviny) ako úsečky (gl.LINES, 1 pixel).
// Hrúbka: každá úsečka sa nakreslí v copies kópiách (inštancie), vertex shader ich posunie na obrazovke o pixel
// (až po premietnutí, takže svetlo počíta každá kópia z polohy skutočného vlákna); krajné kópie sú slabšie (mäkký okraj).
// Vietor: stred pavučiny sa kýve ako celok (jedno pole posunutia, kotvy na kmeňoch stoja). Svetlo: ten istý silkShade ako shader na rovine.
const LINE_VERT = `
attribute vec3 aT; attribute vec3 aOff;
uniform vec2 uSize; uniform vec2 uRes; uniform float uTime; uniform float uSway; uniform float uPhase;
varying vec3 vPos; varying vec3 vT; varying float vEdge;
void main() {
  vec3 p = position;
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
const LINE_FRAG = (MAX) => `
precision highp float;
${SILK_GLSL(MAX)}
varying vec3 vPos; varying vec3 vT; varying float vEdge;
void main() {
  vec4 c = silkShade(normalize(vT), vPos, vEdge, 0.0);
  if (c.a < 0.003) discard;
  gl_FragColor = c;
}`;
// posuny kópií v pixeloch (z = sila kópie): 1 = len vlákno, 2–4 = hrubšie
const COPIES = [[0, 0, 1], [1, 0, 0.6], [0, 1, 0.6], [1, 1, 0.35]];
export function webLines(THREE, world, view, P, opts, maxLights, frame) {
  const th = window.Webs.webThreads(P, opts), L = th.layout;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(th.pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(th.tan, 3));
  const n = P.copies, off = COPIES.slice(0, n), cx = off.reduce((s, o) => s + o[0], 0) / n, cy = off.reduce((s, o) => s + o[1], 0) / n;
  g.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(off.flatMap(o => [o[0] - cx, o[1] - cy, o[2]])), 3));
  g.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG(maxLights), transparent: true, depthWrite: false,
    uniforms: Object.assign(silkUniforms(THREE, world, view, P, L.seed, opts.corner), {
      uSize: { value: new THREE.Vector2(opts.w, opts.h) }, uRes: frame.res, uTime: frame.time, uSway: { value: P.sway }, uPhase: { value: (L.seed % 97) * 0.6 }
    })
  });
  mat.userData.info = { hubs: L.nH, moor: L.moor, fill: L.fill, render: 'lines', segments: th.count / 2, copies: n };
  const m = new THREE.LineSegments(g, mat);
  m.frustumCulled = false; // vydutie a kývanie mení tvar mimo pôvodnej rovinky
  return m;
}

export function createSpiders3d({ THREE, scene, S, D, Art, groundY, lightAt, spriteTex, makeSprite, project, camera, camTarget, renderer, world, maxLights }) {
  const SPI = D.SPIDERS;
  const webMeshes = new Map(), cornerMeshes = [], burrowMeshes = [], sprites = new Map();
  let builtWebs = -1, builtCorner = -1, builtArea = null, builtTiles = -1;
  const holeGeo = new THREE.CircleGeometry(0.26, 18);

  function add(o) { o.layers.set(1); scene.add(o); return o; }
  function drop(o) { scene.remove(o); if (o.material) o.material.dispose(); if (o.geometry && o.geometry !== holeGeo && !o.isSprite) o.geometry.dispose(); } // geometria spritov je spoločná
  // Pavučina so shaderom; parametre z Webs.webParams (v hre sa dajú skúsiť cez window.MF_WEB = { rays: 20, … })
  const view = { value: new THREE.Vector3(0, 1, 0) };
  const params = () => window.Webs.webParams(window.MF_WEB);
  const frame = { res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 } }; // pre pavučiny z čiar
  function webPlane(w, h, seed, keep, corner) {
    const P = params(), opts = { w, h, seed, keep, corner };
    const m = P.render === 1 ? webLines(THREE, world, view, P, opts, maxLights, frame)
      : new THREE.Mesh(new THREE.PlaneGeometry(w, h), webMaterial(THREE, world, view, P, opts, maxLights));
    m.renderOrder = 2;
    return add(m);
  }

  // ---- pavučiny a nory (Les divov) ----
  function buildWebs() {
    for (const m of webMeshes.values()) drop(m);
    webMeshes.clear();
    for (const m of burrowMeshes) drop(m);
    burrowMeshes.length = 0;
    if (S.area !== 'les') return;
    for (const wb of S.webs) {
      // od kmeňa po kmeň (vlákna začínajú na oporách), pri nízkom kríku či spadnutom kmeni nižšia
      const g = window.Webs.webGeom(S.tiles, S.W, S.H, wb, window.MF_WEB);
      const m = webPlane(g.len, g.hgt, wb.id, wb.silk >= 3 ? 1 : wb.silk === 2 ? 0.72 : 0.42, false);
      const mid = (g.u0 + g.u1) / 2, cx = wb.ax ? g.line : mid, cz = wb.ax ? mid : g.line;
      m.position.set(cx, groundY(Math.floor(cx), Math.floor(cz)) + g.hgt / 2 + 0.02, cz);
      if (wb.ax) m.rotation.y = Math.PI / 2;
      webMeshes.set(wb.id, m);
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
  function buildCorners() {
    for (const m of cornerMeshes) drop(m);
    cornerMeshes.length = 0;
    // šikmo v kúte medzi pätou steny a zemou, pri konci steny: hore sa drží steny, dole zeme
    const L = 0.7, up = 0.42, out = 0.4;
    for (const k of S.corner) {
      const gy = groundY(k.x, k.y);
      const fx = k.x + 0.5 + k.dx * 0.5, fz = k.y + 0.5 + k.dy * 0.5; // stred päty steny na hranici políčok
      const ex = fx + k.ex * 0.5, ez = fz + k.ey * 0.5;                 // koniec steny
      const top = new THREE.Vector3(ex - k.ex * L / 2, gy + up, ez - k.ey * L / 2);
      const bot = new THREE.Vector3(top.x - k.dx * out, gy + 0.01, top.z - k.dy * out);
      const X = new THREE.Vector3(k.ex, 0, k.ey), Y = top.clone().sub(bot), len = Y.length();
      Y.normalize();
      const m = webPlane(L, len, k.x * 31 + k.y * 7 + k.dx * 3 + k.ey, 1, true);
      m.matrixAutoUpdate = false;
      m.matrix.makeBasis(X, Y, X.clone().cross(Y)).setPosition(top.clone().add(bot).multiplyScalar(0.5));
      cornerMeshes.push(m);
      // krížiak sedí v pavučine
      const sp = makeSprite(0.26, 0.13); sp.material.map = frameTex('k', 0); sp.layers.set(1);
      sp.position.set(top.x * 0.7 + bot.x * 0.3 + k.ex * 0.2, gy + up * 0.55, top.z * 0.7 + bot.z * 0.3 + k.ey * 0.2);
      cornerMeshes.push(sp);
    }
  }

  // ---- pavúky ----
  const SIZE = { v: [1.0, 0.5], p: [2.3, 1.15], k: [0.42, 0.21] };
  function spriteFor(o) {
    let sp = sprites.get(o.id);
    if (!sp) { const [w, h] = SIZE[o.k] || SIZE.v; sp = makeSprite(w, h); sp.userData.k = o.k; sprites.set(o.id, sp); }
    return sp;
  }
  function frameTex(k, f) { return spriteTex(`spider:${k}:${f}`, 128, 64, c => Art.spider(c, k, 64, 62, 100, f * Math.PI / 2)); }

  const lastSeen = new Map(); // id → { x, y, z, seen, d } pre oči v prekrytí
  function update(dt, t, lights) {
    if (builtArea !== S.area || builtTiles !== S.tilesGen) { builtArea = S.area; builtTiles = S.tilesGen; builtWebs = builtCorner = -1; } // nová plocha (výška zeme)
    if (builtWebs !== S.websGen) { builtWebs = S.websGen; buildWebs(); }
    if (builtCorner !== S.cornerGen) { builtCorner = S.cornerGen; buildCorners(); }
    const me = S.me, lo = {};
    // pavučiny: v tme len v dohľade (a v svetle lampášov); s lampášom v ruke sa lesknú ešte kúsok ďalej
    // pavučiny svieti shader (svetlo zo sveta); smer ku kamere pre odlesk
    view.value.copy(camera.position).sub(camTarget).normalize();
    frame.time.value = t;
    if (renderer) renderer.getDrawingBufferSize(frame.res.value);
    for (const m of cornerMeshes) if (m.isSprite) m.material.color.setRGB(...lightAt(m.position.x, m.position.y, m.position.z, lights, lights.length));
    for (const m of burrowMeshes) { const p = m.position; lightAt(p.x, p.y, p.z, lights, lights.length, lo); m.material.opacity = 0.85 * lo.seen; m.visible = lo.seen > 0.02; }
    const alive = new Set();
    lastSeen.clear();
    for (const o of S.spiders.values()) {
      alive.add(o.id);
      const sp = spriteFor(o);
      let x = o.x, z = o.y, lift = 0;
      if (o.c) { // na chrbte hráča
        if (Math.hypot(o.x - me.x, o.y - me.y) < 1.2) { x = me.x; z = me.y; }
        lift = 0.45;
      }
      const f = o.m ? Math.floor(o.phase / (Math.PI / 2)) % 4 : 0;
      const key = o.k + f;
      if (sp.userData.key !== key) { sp.material.map = frameTex(o.k, f); sp.material.needsUpdate = true; sp.userData.key = key; }
      const y = groundY(x, z) + lift;
      sp.position.set(x, y, z);
      const c = lightAt(x, y + 0.2, z, lights, lights.length, lo);
      if (o.c) for (let i = 0; i < 3; i++) c[i] = Math.max(c[i], 0.8); // na sebe ho vidíš aj v tme
      sp.material.color.setRGB(...c);
      // pavúk na chrbte hráča sa kreslí navrch (inak by ho zakryla postavička)
      if (sp.userData.top !== !!o.c) { const m = sp.material; sp.userData.top = !!o.c; m.depthTest = !o.c; m.transparent = !!o.c; sp.renderOrder = o.c ? 1e6 + 1 : 0; m.needsUpdate = true; } // až po siluete hráča
      const inBurrow = o.k === 'v' && o.h;
      sp.visible = lo.seen > 0.02 && !inBurrow;
      lastSeen.set(o.id, { x, y: y + (SIZE[o.k] || SIZE.v)[1] * 0.4, z, seen: inBurrow ? 0 : lo.seen, d: Math.hypot(x - me.x, z - me.y), k: o.k });
    }
    for (const [id, sp] of sprites) if (!alive.has(id)) { scene.remove(sp); sp.material.dispose(); sprites.delete(id); }
  }

  // V tme: oči vlčiaka a pradleny sa lesknú aj za dohľadom (vlčiak do SPI.vlciak.eyes políčok) – kto si dá pozor, uvidí ich skôr.
  function overlay(c, ppb, t) {
    if (!D.isDark(S.area)) return;
    for (const [id, e] of lastSeen) {
      if (e.k === 'k') continue;
      const range = (e.k === 'p' ? SPI.pradlena : SPI.vlciak).eyes;
      if (e.d > range || e.seen > 0.7) continue;
      const h = (id.charCodeAt(1) || 0) * 1.7;
      if (Math.sin(t * 0.9 + h) < -0.85) continue; // žmurknutie
      const a = (1 - e.seen) * (1 - Math.max(0, e.d - range + 1.5) / 1.5) * (0.65 + 0.35 * Math.sin(t * 3 + h));
      if (a <= 0.02) continue;
      const P = project(e.x, e.y, e.z), gap = ppb * (e.k === 'p' ? 0.16 : 0.08), r = Math.max(1.5, ppb * (e.k === 'p' ? 0.045 : 0.03));
      c.globalAlpha = Math.min(1, a);
      c.fillStyle = e.k === 'p' ? '#ff6a4a' : '#ffcf6a';
      c.shadowColor = c.fillStyle; c.shadowBlur = r * 4;
      for (const s of [-1, 1]) { c.beginPath(); c.arc(P.x + s * gap / 2, P.y, r, 0, Math.PI * 2); c.fill(); }
      c.shadowBlur = 0; c.globalAlpha = 1;
    }
  }
  function dispose() {
    for (const m of webMeshes.values()) drop(m);
    for (const m of [...cornerMeshes, ...burrowMeshes]) drop(m);
    for (const sp of sprites.values()) { scene.remove(sp); sp.material.dispose(); }
    holeGeo.dispose();
  }
  return { update, overlay, dispose };
}
