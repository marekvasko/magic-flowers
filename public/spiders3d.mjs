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
export const WEB_FRAG = (MAX) => `
precision highp float;
#define TAU 6.28318530718
uniform vec2 uSize; uniform vec2 uCenter; uniform float uSeed; uniform float uKeep; uniform vec3 uView;
uniform vec4 uMode; // x výplň (0 špirála, 1 kruhy), y kútová, z počet lúčov, w rozostup závitov
uniform vec4 uA;    // ohnutie lúčov, jeho frekvencia, zvlnenie závitov, jeho frekvencia
uniform vec4 uB;    // stred, voľná zóna, polomer, šum okraja
uniform vec4 uC;    // hrúbka vlákna, lesk, dúha, priehľadnosť v šere
uniform vec4 uD;    // šum rozostupu, prehnutie nosných vlákien, kotviace vlákna na stranu
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 sunDir; uniform vec3 lampColor;
uniform vec4 lights[${MAX}]; uniform int lightCount;
uniform float darkOn; uniform vec4 eye; uniform vec2 eyeLit;
varying vec2 vP; varying vec3 vPos; varying vec3 vAx; varying vec3 vAy;
float h11(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.13) * 43758.5453); }
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
void main() {
  vec2 q = vP - uCenter;
  float r = length(q), a = atan(q.y, q.x);
  bool corner = uMode.y > 0.5; // kútová pavučina: vejár zo stredu v rohu (štvrť kruhu)
  float rays = uMode.z, span = corner ? TAU * 0.25 : TAU, W = uC.x;
  float bend = perlin(vec2(r * uA.y, uSeed * 7.1)) * uA.x / max(r * 2.0, 0.6); // lúče sa jemne vlnia
  float ab = a + bend;
  float k = floor(ab / (span / rays) + 0.5);
  float ar = k * span / rays + (h11(k) - 0.5) * (span / rays) * 0.35;
  float dt = ab - ar;
  float rMax = (corner ? 0.95 : uB.z * min(uSize.x, uSize.y) + 0.12 * max(uSize.x - uSize.y, 0.0)) * (1.0 + uB.w * perlin(vec2(a * 1.3, uSeed * 3.7)));
  // nosné vlákna hore a dole: medzi kmeňmi (x = 0 a x = šírka), prehnuté
  float s = clamp(vP.x / uSize.x, 0.0, 1.0), sagK = uD.y * 4.0 * s * (1.0 - s);
  float yTop = uSize.y * 0.96 - sagK, yBot = uSize.y * 0.06 + sagK * 0.5;
  bool inside = corner || (vP.y < yTop && vP.y > yBot);
  float mR = inside && r > uB.x * 0.5 && h11(k + 40.0) < uKeep + 0.15 ? thread(r * abs(sin(dt)), W) : 0.0;
  float mF = 0.0, mM = 0.0; vec2 tM = vec2(1.0, 0.0);
  if (!corner) {
    float kf = step(0.5, h21(floor(vP * 2.0)) + uKeep);
    mF = max(thread(abs(vP.y - yTop), W * 1.3), thread(abs(vP.y - yBot), W)) * kf;
    // kotviace vlákna: z bodov na oboch kmeňoch k okraju pavučiny
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uD.z) break;
      for (int sd = 0; sd < 2; sd++) {
        float fy = (float(i) + 0.5 + (h11(float(i * 2 + sd) + 9.0) - 0.5) * 0.6) / uD.z;
        vec2 A = vec2(sd == 0 ? 0.0 : uSize.x, mix(yBot, yTop, fy));
        vec2 dir = normalize(A - uCenter), B = uCenter + dir * rMax * 0.92;
        float d = segDist(vP, A, B);
        if (h11(float(i * 2 + sd) + 70.0) < uKeep + 0.2) { float m = thread(d, W); if (m > mM) { mM = m; tM = normalize(B - A); } }
      }
    }
  }
  // výplň: závity sú medzi lúčmi rovné (polomer premietnutý na os lúča), zvlnené šumom
  float rp = r * cos(dt) * (1.0 + uA.z * perlin(vec2(ab * uA.w, r * 6.0)));
  float pitch = uMode.w * (1.0 + uD.x * perlin(vec2(r * 3.0, uSeed)));
  float free = uB.y, hub = uB.x;
  float t = uMode.x < 0.5 ? (rp - free) / pitch - (corner ? ab / span : (a + 3.14159265) / TAU) : (rp - free) / pitch; // špirála / kruhy
  float dS = abs(fract(t + 0.5) - 0.5) * pitch;
  float seg = h21(vec2(floor(t + 0.5), k));
  float mS = inside && rp > free && r < rMax && seg < uKeep ? thread(dS, W) : 0.0;
  // hustý stred
  float mH = !corner && r < hub ? thread(abs(fract(r / (pitch * 0.3) + 0.5) - 0.5) * pitch * 0.3, W) : 0.0;
  float mask = max(max(max(mR, mF), max(mS, mH)), mM);
  if (corner) mask *= step(0.0, ab) * step(ab, span + 0.05) * step(r, 1.0);
  if (mask < 0.003) discard;
  // smer vlákna vo svete: lúč ide od stredu, závit kolmo naň, nosné vlákno vodorovne, kotviace k okraju
  vec2 tl = mM >= mask - 1e-4 ? tM : mF >= mask - 1e-4 ? vec2(1.0, 0.0) : mR >= mS ? vec2(cos(ar), sin(ar)) : vec2(-sin(ar), cos(ar));
  vec3 T = normalize(vAx * tl.x + vAy * tl.y), V = normalize(uView);
  // rozptyl a odlesk na vlákne (Kajiya–Kay)
  float lamp = 0.0, spec = 0.0, diff = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= lightCount) break;
    vec3 L = lights[i].xyz - vPos; float d = length(L); L /= d;
    float att = 1.0 - smoothstep(0.0, lights[i].w, d), attG = 1.0 - smoothstep(0.0, lights[i].w * 1.3, d);
    float tl2 = dot(T, L), th = dot(T, normalize(L + V));
    lamp += att; diff += att * sqrt(max(0.0, 1.0 - tl2 * tl2));
    spec += attG * pow(sqrt(max(0.0, 1.0 - th * th)), uC.y);
  }
  float sl = dot(T, sunDir), sh = dot(T, normalize(sunDir + V));
  float sunK = 1.0 - darkOn * 0.85; // v Lese divov sa slnko cez koruny skoro nedostane
  vec3 silk = vec3(0.86, 0.9, 0.95);
  vec3 col = silk * (ambient * 0.9 + sunColor * sunK * sqrt(max(0.0, 1.0 - sl * sl)) + lampColor * diff * 1.1);
  col += silk * vec3(0.8, 0.85, 1.0) * eyeLit.y * darkOn * (1.0 - smoothstep(0.0, eyeLit.x, distance(vPos, eye.xyz)));
  vec3 iri = (1.0 - uC.z) + uC.z * cos(vec3(0.0, 2.1, 4.2) + dot(T, V) * 6.0 + uSeed); // jemná dúha v odlesku
  col += (lampColor * spec * 2.2 + sunColor * sunK * pow(sqrt(max(0.0, 1.0 - sh * sh)), uC.y) * 1.5) * iri;
  // tma Lesa divov: za dohľadom vlákna zmiznú, lampášom osvetlené ostanú
  float fogK = 0.0;
  if (darkOn > 0.0) fogK = darkOn * smoothstep(eye.w * 0.6, eye.w * 1.15, distance(vPos.xz, eye.xz)) * (1.0 - clamp(lamp * 1.6 + spec * 4.0, 0.0, 1.0));
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  float alpha = mask * clamp(uC.w + lum * 1.3, 0.0, 1.0) * (1.0 - fogK);
  gl_FragColor = vec4(min(col, vec3(1.6)), alpha);
}`;
// Materiál jednej pavučiny: P = Webs.webParams(...), opts = { w, h, seed, keep (0–1 koľko vlákien ostalo), corner }.
// world = uniformy svetla (svet v hre, vlastné v ladiacej stránke), view = { value: Vector3 } smer ku kamere.
export function webMaterial(THREE, world, view, P, opts, maxLights) {
  const { w, h, corner } = opts, seed = (opts.seed + P.seed * 101) % 997;
  const hs = n => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
  const fill = P.fill === 2 ? (hs(3) < 0.5 ? 0 : 1) : P.fill;
  const cj = P.centerJitter;
  return new THREE.ShaderMaterial({
    vertexShader: WEB_VERT, fragmentShader: WEB_FRAG(maxLights), transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      ambient: world.ambient, sunColor: world.sunColor, sunDir: world.sunDir, lampColor: world.lampColor, lights: world.lights, lightCount: world.lightCount,
      darkOn: world.darkOn, eye: world.eye, eyeLit: world.eyeLit, uView: view,
      uSize: { value: new THREE.Vector2(w, h) },
      uCenter: { value: corner ? new THREE.Vector2(0, 0) : new THREE.Vector2(w * (0.5 + (hs(1) - 0.5) * 2 * cj), h * (0.5 + (hs(2) - 0.5) * 2 * cj)) },
      uSeed: { value: seed % 97 }, uKeep: { value: opts.keep == null ? 1 : opts.keep },
      uMode: { value: new THREE.Vector4(fill, corner ? 1 : 0, corner ? 6 : P.rays + Math.floor(hs(4) * (P.raysVar + 1)), (corner ? 1.6 : 1) * P.pitch * (1 + (hs(5) - 0.5) * P.pitchVar)) },
      uA: { value: new THREE.Vector4(P.bend, P.bendFreq, P.wobble, P.wobbleFreq) },
      uB: { value: new THREE.Vector4(corner ? 0 : P.hub, corner ? 0.06 : P.free, P.radius, P.edgeNoise) },
      uC: { value: new THREE.Vector4(P.width * (corner ? 1.3 : 1), P.glint, P.iri, P.alpha) },
      uD: { value: new THREE.Vector4(P.pitchNoise, P.sag, P.moor, 0) }
    }
  });
}

export function createSpiders3d({ THREE, scene, S, D, Art, groundY, lightAt, spriteTex, makeSprite, project, camera, camTarget, world, maxLights }) {
  const SPI = D.SPIDERS;
  const webMeshes = new Map(), cornerMeshes = [], burrowMeshes = [], sprites = new Map();
  let builtWebs = -1, builtCorner = -1, builtArea = null, builtTiles = -1;
  const holeGeo = new THREE.CircleGeometry(0.26, 18);

  function add(o) { o.layers.set(1); scene.add(o); return o; }
  function drop(o) { scene.remove(o); if (o.material) o.material.dispose(); if (o.geometry && o.geometry !== holeGeo && !o.isSprite) o.geometry.dispose(); } // geometria spritov je spoločná
  // Pavučina so shaderom; parametre z Webs.webParams (v hre sa dajú skúsiť cez window.MF_WEB = { rays: 20, … })
  const view = { value: new THREE.Vector3(0, 1, 0) };
  const params = () => window.Webs.webParams(window.MF_WEB);
  function webPlane(w, h, seed, keep, corner) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), webMaterial(THREE, world, view, params(), { w, h, seed, keep, corner }, maxLights));
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
    const s = 0.55;
    for (const k of S.corner) {
      const bx = k.x + 0.5 + k.dx * 0.5 + k.ex * 0.47, bz = k.y + 0.5 + k.dy * 0.5 + k.ey * 0.47, gy = groundY(k.x, k.y);
      const m = webPlane(s, s, k.x * 31 + k.y * 7 + k.dx * 3 + k.ey, 1, true);
      m.position.set(bx - k.dx * s / 2, gy + s / 2, bz - k.dy * s / 2);
      const rot = k.ex !== 0; // normála pavučiny je v smere e (pozdĺž steny)
      if (rot) m.rotation.y = Math.PI / 2;
      if ((rot ? -k.dy : k.dx) > 0) m.scale.x = -1; // stred vejára (roh plochy vľavo dolu) k stene
      cornerMeshes.push(m);
      // krížiak sedí v pavučine
      const sp = makeSprite(0.26, 0.13); sp.material.map = frameTex('k', 0); sp.layers.set(1);
      sp.position.set(bx - k.dx * 0.16, gy + 0.2, bz - k.dy * 0.16);
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
