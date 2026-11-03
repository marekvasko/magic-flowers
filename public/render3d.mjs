// 3D vykresľovanie (Three.js): ortogonálna kamera pod 45°, svet z podkociek, flat shading
// s tieňom stien podľa strany, ambientným zatienením rohov a mäkkým tieňom od slnka.
// Herná logika, sieť aj ovládanie zostávajú v game.js – toto je len iný pohľad na ten istý svet.
import * as THREE from '/vendor/three/three.module.js';

const D = window.GameData, W = window.World3D, Art = window.Art;
const R = W.R;
const PITCH = Math.atan(1 / Math.SQRT2);       // klasická izometria ~35,26°
const VIEW_BLOCKS = 11;                          // koľko blokov sa zmestí na šírku obrazovky
const FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.8, 0.8]; // +x, -x, +y, -y, +z, -z (ako v Minecrafte)
const AO_CURVE = [0.5, 0.68, 0.84, 1];
const GT = 32;                                   // px na políčko v textúre zeme
const MAX_LIGHTS = 16;

// ---------- Shader: plochý, bez rozptylu a odrazov ----------
const VERT = `
attribute vec3 color;
attribute float ao;
attribute float sun;
attribute float emis;
attribute float tex;
varying vec3 vColor; varying float vAo; varying float vSun; varying float vEmis; varying float vTex;
varying vec2 vUv; varying vec3 vPos;
void main() {
  vColor = color; vAo = ao; vSun = sun; vEmis = emis; vTex = tex; vUv = uv; vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
precision highp float;
uniform sampler2D map;
uniform vec3 ambient; uniform vec3 sunColor; uniform vec3 lampColor; uniform vec3 emisColor;
uniform vec4 lights[${MAX_LIGHTS}]; uniform int lightCount;
varying vec3 vColor; varying float vAo; varying float vSun; varying float vEmis; varying float vTex;
varying vec2 vUv; varying vec3 vPos;
void main() {
  vec3 base = vTex > 0.5 ? texture2D(map, vUv).rgb * vColor : vColor;
  vec3 light = ambient + sunColor * vSun;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    float d = distance(vPos, lights[i].xyz);
    light += lampColor * (1.0 - smoothstep(0.0, lights[i].w, d));
  }
  vec3 col = base * vAo * light;
  col = max(col, base * emisColor * vEmis);
  gl_FragColor = vec4(col, 1.0);
}`;

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hex = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const toLin = c => c; // pracujeme priamo v sRGB ako 2D hra (bez prevodu farieb)
THREE.ColorManagement.enabled = false;

export function create(api) {
  const { S } = api;
  const renderer = new THREE.WebGLRenderer({ canvas: api.glCanvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  let yaw = Math.PI / 4, yawTarget = yaw;

  // ---------- Textúra zeme (rovnaká kresba ako 2D hra) ----------
  const gcv = document.createElement('canvas');
  gcv.width = D.W * GT; gcv.height = D.H * GT;
  const gctx = gcv.getContext('2d');
  const groundTex = new THREE.CanvasTexture(gcv);
  groundTex.colorSpace = THREE.NoColorSpace;
  groundTex.magFilter = THREE.LinearFilter;
  groundTex.minFilter = THREE.LinearFilter;
  groundTex.generateMipmaps = false;
  const tileSig = [];
  let drawnSeason = -1;
  function drawTile(i, se, t) {
    const tl = S.tiles[i], x = i % D.W, y = (i / D.W) | 0;
    Art.ground(gctx, tl.g, x * GT, y * GT, GT, se, t, x, y);
    if (tl.s) Art.soil(gctx, tl.s, x * GT, y * GT, GT, se);
  }
  function refreshGround(se, t, force) {
    let changed = false;
    for (let i = 0; i < S.tiles.length; i++) {
      const tl = S.tiles[i];
      const sig = tl.g + '|' + (tl.s ? tl.s.k + tl.s.w + tl.s.r : '');
      if (force || sig !== tileSig[i] || tl.g === 'water') { drawTile(i, se, t); tileSig[i] = sig; changed = true; }
    }
    if (changed) groundTex.needsUpdate = true;
  }

  // ---------- Sieť sveta z podkociek ----------
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      map: { value: groundTex }, ambient: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Vector3() },
      lampColor: { value: new THREE.Vector3(...toLin([1, 0.78, 0.45])) }, emisColor: { value: new THREE.Vector3(1, 1, 1) },
      lights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) }, lightCount: { value: 0 }
    }
  });
  let mesh = null, grid = null, builtSeason = -1;
  let vtx = null; // { pos: Float32Array, nrm: Int8Array, sun: Float32Array, target: Float32Array, n }
  const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]]; // [normálová os, u, v] – u × v = normála

  function buildMesh(se) {
    grid = W.buildGrid(S.tiles, se);
    const P = [], C = [], A = [], E = [], T = [], U = [], N = [], I = [];
    const g = grid, get = (x, y, z) => W.get(g, x, y, z);
    let vi = 0;
    for (let z = 0; z < W.NZ; z++) for (let y = 0; y < W.NY; y++) for (let x = 0; x < W.NX; x++) {
      const m = get(x, y, z);
      if (!m || m === W.M.INVIS) continue;
      const matCol = toLin(hex(W.colorOf(m, se)));
      const em = W.EMISSIVE[m] ? 1 : 0;
      for (let f = 0; f < 6; f++) {
        const ax = f >> 1, sg = f & 1 ? -1 : 1;
        const n = [0, 0, 0]; n[ax] = sg;
        if (get(x + n[0], y + n[1], z + n[2])) continue; // skrytá stena
        const [, ua, va] = AXES[ax];
        const fi = ax === 0 ? (sg > 0 ? 0 : 1) : ax === 1 ? (sg > 0 ? 2 : 3) : (sg > 0 ? 4 : 5);
        const textured = m < 16 && ax === 1 && sg > 0;   // vrch terénu nesie kresbu zeme
        const shade = FACE_SHADE[fi];
        const col = textured ? [1, 1, 1] : matCol;
        let corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
        if (sg < 0) corners = [[0, 0], [0, 1], [1, 1], [1, 0]];
        const aoV = [];
        for (const [du, dv] of corners) {
          const p = [x, y, z];
          if (sg > 0) p[ax] += 1;
          p[ua] += du; p[va] += dv;
          // ambientné zatienenie rohu: dve bočné a jedna rohová podkocka vo vrstve pred stenou
          const L = [x + n[0], y + n[1], z + n[2]];
          const s1 = L.slice(), s2 = L.slice(), cc = L.slice();
          s1[ua] += du ? 1 : -1; s2[va] += dv ? 1 : -1; cc[ua] += du ? 1 : -1; cc[va] += dv ? 1 : -1;
          const o1 = get(...s1) ? 1 : 0, o2 = get(...s2) ? 1 : 0, oc = get(...cc) ? 1 : 0;
          const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
          aoV.push(ao);
          P.push(p[0] / R, p[1] / R, p[2] / R);
          C.push(col[0] * shade, col[1] * shade, col[2] * shade);
          A.push(AO_CURVE[ao]); E.push(em); T.push(textured ? 1 : 0);
          U.push(p[0] / R / D.W, 1 - p[2] / R / D.H);
          N.push(n[0], n[1], n[2]);
        }
        // otočenie uhlopriečky podľa AO, aby tieň v rohoch nebol „zalomený“
        if (aoV[0] + aoV[2] < aoV[1] + aoV[3]) I.push(vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi);
        else I.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setAttribute('ao', new THREE.Float32BufferAttribute(A, 1));
    geo.setAttribute('emis', new THREE.Float32BufferAttribute(E, 1));
    geo.setAttribute('tex', new THREE.Float32BufferAttribute(T, 1));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    const sunA = new Float32Array(vi).fill(1);
    geo.setAttribute('sun', new THREE.BufferAttribute(sunA, 1));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);
    vtx = { pos: new Float32Array(P), nrm: new Int8Array(N), sun: sunA, target: new Float32Array(vi).fill(1), from: new Float32Array(vi).fill(1), n: vi, mesh, start: 0.05 };
    for (const fm of fineMeshes) { scene.remove(fm); fm.geometry.dispose(); }
    fineMeshes = grid.fine.map(f => buildFine(f, se));
    parts = [vtx].concat(fineMeshes.map(m => m.userData.vtx));
    sunJob = null; lastSunKey = '';
    builtSeason = se;
  }

  // ---------- Jemné modely z minikociek (1 blok = 8×8×8) ----------
  let fineMeshes = [], parts = [];
  function buildFine(f, se) {
    const F = W.FINE, { sx, sy, sz, data } = f;
    const get = (x, y, z) => (y < 0 ? 1 : (x < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 0 : data[(z * sy + y) * sx + x]); // pod modelom je zem
    const P = [], C = [], A = [], E = [], T = [], U = [], N = [], I = [];
    let vi = 0;
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
      const m = data[(z * sy + y) * sx + x];
      if (!m) continue;
      const vary = 0.94 + W.hash(x, y, z) * 0.12; // jemná variácia farby – drevo, kameň, šindle
      const mc = toLin(hex(W.colorOf(m, se))).map(v => Math.min(1, v * vary));
      const em = W.EMISSIVE[m] ? 1 : 0;
      for (let fi = 0; fi < 6; fi++) {
        const ax = fi >> 1, sg = fi & 1 ? -1 : 1;
        const n = [0, 0, 0]; n[ax] = sg;
        if (get(x + n[0], y + n[1], z + n[2])) continue;
        const [, ua, va] = AXES[ax];
        const shade = FACE_SHADE[ax === 0 ? (sg > 0 ? 0 : 1) : ax === 1 ? (sg > 0 ? 2 : 3) : (sg > 0 ? 4 : 5)];
        const corners = sg > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
        const aoV = [];
        for (const [du, dv] of corners) {
          const p = [x, y, z];
          if (sg > 0) p[ax] += 1;
          p[ua] += du; p[va] += dv;
          const L = [x + n[0], y + n[1], z + n[2]];
          const s1 = L.slice(), s2 = L.slice(), cc = L.slice();
          s1[ua] += du ? 1 : -1; s2[va] += dv ? 1 : -1; cc[ua] += du ? 1 : -1; cc[va] += dv ? 1 : -1;
          const o1 = get(...s1) ? 1 : 0, o2 = get(...s2) ? 1 : 0, oc = get(...cc) ? 1 : 0;
          const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
          aoV.push(ao);
          P.push(f.ox + p[0] / F, f.oy + p[1] / F, f.oz + p[2] / F);
          C.push(mc[0] * shade, mc[1] * shade, mc[2] * shade);
          A.push(AO_CURVE[ao]); E.push(em); T.push(0); U.push(0, 0); N.push(n[0], n[1], n[2]);
        }
        if (aoV[0] + aoV[2] < aoV[1] + aoV[3]) I.push(vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi);
        else I.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setAttribute('ao', new THREE.Float32BufferAttribute(A, 1));
    geo.setAttribute('emis', new THREE.Float32BufferAttribute(E, 1));
    geo.setAttribute('tex', new THREE.Float32BufferAttribute(T, 1));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    const sunA = new Float32Array(vi).fill(1);
    geo.setAttribute('sun', new THREE.BufferAttribute(sunA, 1));
    geo.setIndex(I);
    geo.computeBoundingSphere();
    const fmesh = new THREE.Mesh(geo, material);
    fmesh.userData.tile = f.tile;
    // lúč tieňa začína až za vlastnou neviditeľnou náhradou modelu v hrubej mriežke
    fmesh.userData.vtx = { pos: new Float32Array(P), nrm: new Int8Array(N), sun: sunA, target: new Float32Array(vi).fill(1), from: new Float32Array(vi).fill(1), n: vi, mesh: fmesh, start: 0.45 };
    scene.add(fmesh);
    return fmesh;
  }

  // ---------- Mäkký slnečný tieň: počíta sa postupne (pár tisíc vrcholov na snímku) ----------
  let sunJob = null, lastSunKey = '', blendT = 1;
  function scheduleSun(min, se) {
    const key = se + ':' + Math.floor(min / 15);  // prepočet každých 15 herných minút
    if (key === lastSunKey || !vtx) return;
    lastSunKey = key;
    sunJob = { dir: W.sunDir(min + 7, se), i: 0, part: 0, cache: new Map() };
  }
  function stepSun(budget) {
    if (!sunJob) return;
    const { dir } = sunJob;
    while (budget > 0 && sunJob.part < parts.length) {
      const v = parts[sunJob.part];
      const end = Math.min(v.n, sunJob.i + budget);
      for (let i = sunJob.i; i < end; i++) {
        const nx = v.nrm[i * 3], ny = v.nrm[i * 3 + 1], nz = v.nrm[i * 3 + 2];
        let s = 0;
        if (dir && nx * dir.x + ny * dir.y + nz * dir.z > 0.02) {
          const px = v.pos[i * 3] + nx * 0.02, py = v.pos[i * 3 + 1] + ny * 0.02, pz = v.pos[i * 3 + 2] + nz * 0.02;
          const k = px.toFixed(2) + ',' + py.toFixed(2) + ',' + pz.toFixed(2);
          s = sunJob.cache.get(k);
          if (s === undefined) { s = W.sunVisibility(grid, px, py, pz, dir, 5, v.start); sunJob.cache.set(k, s); }
        }
        v.target[i] = s;
      }
      budget -= end - sunJob.i;
      sunJob.i = end;
      if (end >= v.n) { sunJob.part++; sunJob.i = 0; }
    }
    if (sunJob.part >= parts.length) { for (const v of parts) v.from.set(v.sun); blendT = 0; sunJob = null; }
  }
  function blendSun(dt) {
    if (blendT >= 1 || !vtx) return;
    blendT = Math.min(1, blendT + dt / 1.5);
    for (const v of parts) {
      for (let i = 0; i < v.n; i++) v.sun[i] = lerp(v.from[i], v.target[i], blendT);
      v.mesh.geometry.attributes.sun.needsUpdate = true;
    }
  }

  // ---------- Sprity: kvety, huby, babka, hráči ----------
  const texCache = new Map();
  function spriteTex(key, w, h, draw) {
    let t = texCache.get(key);
    if (t) return t;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'));
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
    texCache.set(key, t);
    return t;
  }
  function makeSprite(w, h) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ alphaTest: 0.4, transparent: false }));
    sp.center.set(0.5, 0.03); sp.scale.set(w, h, 1);
    scene.add(sp);
    return sp;
  }
  const plantSprites = new Map();
  function plantKey(p, night, t) {
    const st = D.stageOf(p), wil = st === 3 && !p.d && p.bt != null && (S.tick - p.bt) > 0.6 * D.SPECIES[p.sp].life * D.TICKS_PER_DAY;
    return { key: `${p.sp}|${st}|${p.d ? 1 : 0}|${night && p.sp === 'papradie' ? 1 : 0}|${wil ? 1 : 0}`, st, wil };
  }
  const shadowGeo = new THREE.CircleGeometry(0.3, 20);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  function blobShadow() { const m = new THREE.Mesh(shadowGeo, shadowMat); m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.75, 1); scene.add(m); return m; }

  function syncPlants(night) {
    const seen = new Set();
    for (let i = 0; i < S.tiles.length; i++) {
      const tl = S.tiles[i];
      const x = i % D.W, y = (i / D.W) | 0;
      let key = null, draw = null, h = 1.5;
      if (tl.s && tl.s.p) {
        const p = tl.s.p, k = plantKey(p, night);
        key = 'p:' + k.key;
        draw = c => Art.plant(c, p.sp, k.st, 32, 92, 60, 0, { dead: p.d, night, ready: false, wilting: k.wil });
      } else if (tl.g === 'shroom') {
        key = 's:' + (night ? 1 : 0); h = 1;
        draw = c => Art.shroom(c, 32, 58, 60, night, 0);
      }
      if (!key) continue;
      seen.add(i);
      let sp = plantSprites.get(i);
      if (!sp) { sp = makeSprite(1, h); sp.userData.tile = { x, y }; plantSprites.set(i, sp); }
      if (sp.userData.key !== key) {
        sp.material.map = spriteTex(key, 64, h === 1 ? 64 : 96, draw); sp.material.needsUpdate = true; sp.userData.key = key;
        sp.scale.set(1, h, 1);
      }
      sp.position.set(x + 0.5, W.surfaceY(grid, x, y), y + 0.5);
    }
    for (const [i, sp] of plantSprites) if (!seen.has(i)) { scene.remove(sp); plantSprites.delete(i); }
  }

  // postavičky – 2D sprite s tieňom pod sebou, kreslený každú snímku (animácia chôdze)
  const chars = new Map();
  function charObj(id) {
    let o = chars.get(id);
    if (o) return o;
    const c = document.createElement('canvas'); c.width = 96; c.height = 128;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace;
    const sp = makeSprite(0.96, 1.28); sp.material.map = tex;
    // „röntgen“: polopriehľadná silueta postavičky viditeľná aj cez budovy a stromy
    const ghost = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }));
    ghost.center.copy(sp.center); ghost.scale.copy(sp.scale); ghost.renderOrder = 10;
    scene.add(ghost);
    o = { c, ctx: c.getContext('2d'), tex, sp, ghost, shadow: blobShadow(), h: 1 };
    chars.set(id, o);
    return o;
  }
  // smer pohybu vo svete → jeden z 8 smerov spritu vzhľadom na natočenie kamery
  function dir8(a) {
    const dx = Math.cos(a), dz = Math.sin(a);
    const sx = dx * Math.cos(yaw) - dz * Math.sin(yaw), sy = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const oct = ((Math.round(Math.atan2(sy, sx) / (Math.PI / 4)) % 8) + 8) % 8;
    return [2, 5, 0, 4, 1, 6, 3, 7][oct];
  }
  const DIR_ANGLE = [Math.PI / 2, Math.PI, 0, -Math.PI / 2];
  function drawChar(id, x, z, look, a, phase, opts, dt) {
    const o = charObj(id);
    const target = grid ? W.surfaceY(grid, Math.max(0, Math.min(D.W - 1, Math.floor(x))), Math.max(0, Math.min(D.H - 1, Math.floor(z)))) : 1;
    o.h = lerp(o.h, target, Math.min(1, dt * 10));
    o.ctx.clearRect(0, 0, 96, 128);
    Art.char(o.ctx, 48, 124, 100, look || {}, opts.dance ? 0 : dir8(a), phase, Object.assign({ noShadow: true }, opts));
    o.tex.needsUpdate = true;
    o.sp.position.set(x, o.h, z);
    o.ghost.position.copy(o.sp.position);
    o.shadow.position.set(x, o.h + 0.01, z);
    o.sp.userData.tile = { x: Math.floor(x), y: Math.floor(z) };
    o.alive = true;
    return o;
  }

  // ---------- Svetlo ----------
  const NIGHT_AMB = toLin([0.22, 0.25, 0.42]), DAY_AMB = toLin([0.62, 0.64, 0.72]);
  const SUN_DAY = toLin([0.55, 0.52, 0.44]), SUN_LOW = toLin([0.62, 0.38, 0.2]);
  const SKY_DAY = [0.62, 0.82, 0.96], SKY_NIGHT = [0.05, 0.07, 0.16], SKY_DUSK = [0.98, 0.62, 0.42];
  let curAmb = DAY_AMB, curSun = SUN_DAY, curSunDir = null;
  function lighting(min, se) {
    const dl = W.daylight(min), dir = W.sunDir(min, se);
    curSunDir = dir;
    const elev = dir ? Math.min(1, dir.y * 3) : 0;
    const rain = S.weather === 'rain' ? 0.75 : S.weather === 'snow' ? 0.9 : 1;
    curAmb = mix3(NIGHT_AMB, DAY_AMB, dl).map(v => v * (rain < 1 ? 0.92 : 1));
    curSun = mix3(SUN_LOW, SUN_DAY, Math.min(1, elev * 1.4)).map(v => v * elev * dl * rain);
    material.uniforms.ambient.value.set(...curAmb);
    material.uniforms.sunColor.value.set(...curSun);
    material.uniforms.emisColor.value.set(...(dl < 0.6 ? toLin([1, 0.85, 0.55]) : [0, 0, 0]));
    const dusk = dir ? Math.max(0, 1 - dir.y * 4) * dl : 0;
    const sky = mix3(mix3(SKY_NIGHT, SKY_DAY, dl), SKY_DUSK, dusk * 0.6);
    renderer.setClearColor(new THREE.Color(sky[0], sky[1], sky[2]));
    return dl;
  }
  // svetlo v bode pre sprity (CPU verzia shaderu)
  function lightAt(x, y, z, lights, n) {
    const vis = curSunDir ? W.sunVisibility(grid, x, y + 0.3, z, curSunDir, 3) : 0;
    let r = curAmb[0] + curSun[0] * vis, g = curAmb[1] + curSun[1] * vis, b = curAmb[2] + curSun[2] * vis;
    const lc = material.uniforms.lampColor.value;
    for (let i = 0; i < n; i++) {
      const L = lights[i], d = Math.hypot(L.x - x, L.y - y, L.z - z);
      const f = 1 - Math.min(1, Math.max(0, d / L.w)); const s = f * f * (3 - 2 * f);
      r += lc.x * s; g += lc.y * s; b += lc.z * s;
    }
    return [Math.min(1.4, r), Math.min(1.4, g), Math.min(1.4, b)];
  }

  // ---------- Kamera ----------
  let viewTop = 1;
  function resize() {
    const r = api.glCanvas.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    const halfW = VIEW_BLOCKS / 2, H = VIEW_BLOCKS * r.height / r.width;
    const bottomFrac = api.bottomH() / r.height;
    viewTop = H * (1 - bottomFrac) * 0.5;          // hráč v strede viditeľnej časti nad lištou
    camera.left = -halfW; camera.right = halfW; camera.top = viewTop; camera.bottom = viewTop - H;
    camera.updateProjectionMatrix();
  }
  const camTarget = new THREE.Vector3();
  function placeCamera(dt) {
    yaw = lerp(yaw, yawTarget, Math.min(1, dt * 8));
    if (Math.abs(yaw - yawTarget) < 0.001) yaw = yawTarget;
    const me = S.me, h = grid ? W.surfaceY(grid, Math.floor(me.x), Math.floor(me.y)) : 1;
    camTarget.set(me.x, lerp(camTarget.y || h, h, Math.min(1, dt * 6)), me.y);
    const dist = 60;
    camera.position.set(camTarget.x + Math.sin(yaw) * Math.cos(PITCH) * dist, camTarget.y + Math.sin(PITCH) * dist, camTarget.z + Math.cos(yaw) * Math.cos(PITCH) * dist);
    camera.lookAt(camTarget);
  }
  function rotate(k) { yawTarget += k * Math.PI / 2; }
  // vektor z joysticku (obrazovka: x vpravo, y dole) → smer vo svete
  function screenToWorld(vx, vy) {
    return [vx * Math.cos(yaw) + vy * Math.sin(yaw), -vx * Math.sin(yaw) + vy * Math.cos(yaw)];
  }

  // ---------- Výber objektu ťuknutím (lúč do scény) ----------
  const ray = new THREE.Raycaster();
  function pick(clientX, clientY) {
    const r = api.glCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const sprites = [...[...chars.values()].filter(o => o.alive).map(o => o.sp), ...plantSprites.values(), babka && babka.sp].filter(Boolean);
    const hits = ray.intersectObjects(sprites.concat(mesh ? [mesh] : [], fineMeshes), false);
    for (const h of hits) {
      if (h.object.isSprite || h.object.userData.tile) return Object.assign({}, h.object.userData.tile);
      const q = h.point.clone().addScaledVector(h.face.normal, -0.01);
      const x = Math.floor(q.x), y = Math.floor(q.z);
      if (x >= 0 && y >= 0 && x < D.W && y < D.H) return { x, y };
    }
    return null;
  }

  // ---------- Prekrytie: mená, bubliny, efekty, počasie ----------
  const ov = api.ovCtx;
  const v3 = new THREE.Vector3();
  function project(x, y, z) {
    v3.set(x, y, z).project(camera);
    const c = api.ov;
    return { x: (v3.x + 1) / 2 * c.width, y: (1 - v3.y) / 2 * c.height };
  }
  function pxPerBlock() { return api.ov.width / VIEW_BLOCKS; }

  let babka = null, last = performance.now(), lastGround = 0;
  function frame(t) {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    const min = api.curMin(), se = api.season(), night = D.isNight(min);
    if (builtSeason !== se) { buildMesh(se); refreshGround(se, t, true); drawnSeason = se; }
    if (now - lastGround > 600) { refreshGround(se, t, false); lastGround = now; }
    scheduleSun(min, se);
    stepSun(2500);
    blendSun(dt);
    lighting(min, se);
    placeCamera(dt);

    // svetelné zdroje (okná, kotlík, hráči, svietiace kvety) – len keď je šero
    const lights = [];
    const dl = W.daylight(min);
    if (dl < 0.8) {
      const A = api.S.anchors;
      const add = (x, y, z, r) => { if (lights.length < MAX_LIGHTS) lights.push(new THREE.Vector4(x, y, z, r)); };
      add(S.me.x, 1.6, S.me.y, 3.2);
      for (const o of S.others.values()) add(o.x, 1.6, o.y, 2.6);
      if (A.hut) { add(A.hut.x + 0.75, 1.7, A.hut.y + 2.3, 2.2); add(A.hut.x + 2.25, 1.7, A.hut.y + 2.3, 2.2); }
      if (A.house) { add(A.house.x + 0.62, 2.2, A.house.y + 2.3, 2.2); add(A.house.x + 2.37, 2.2, A.house.y + 2.3, 2.2); add(A.house.x + 2.06, 2.4, A.house.y + 2.06, 1.8); }
      if (A.cauldron) add(A.cauldron.x + 0.5, 2, A.cauldron.y + 0.5, 2.4);
      if (A.stall) add(A.stall.x + 1.5, 2.6, A.stall.y + 0.5, 2.6);
      for (let i = 0; i < S.tiles.length && lights.length < MAX_LIGHTS; i++) {
        const p = S.tiles[i].s && S.tiles[i].s.p;
        if (p && !p.d && (p.sp === 'papradie' || p.sp === 'duhova') && D.stageOf(p) === 3) add(i % D.W + 0.5, 1.6, ((i / D.W) | 0) + 0.5, 2.2);
      }
    }
    const lu = material.uniforms.lights.value;
    lights.forEach((l, i) => lu[i].copy(l));
    material.uniforms.lightCount.value = lights.length;

    // sprity
    syncPlants(night);
    for (const sp of plantSprites.values()) {
      if (!sp.userData.lit || now - sp.userData.litAt > 400) {
        sp.userData.lit = lightAt(sp.position.x, sp.position.y, sp.position.z, lights, lights.length);
        sp.userData.litAt = now + Math.random() * 200;
      }
      sp.material.color.setRGB(...sp.userData.lit);
    }
    for (const o of chars.values()) o.alive = false;
    const me = S.me;
    const meO = drawChar('me', me.x, me.y, S.look, me.a != null ? me.a : DIR_ANGLE[me.dir], S.myEmote === 'dance' ? t * 4 : me.phase, { dance: S.myEmote === 'dance' }, dt);
    for (const o of S.others.values()) drawChar(o.id, o.x, o.y, o.look, o.a != null ? o.a : DIR_ANGLE[o.dir || 0], o.e === 'dance' ? t * 4 : o.phase, { dance: o.e === 'dance' }, dt);
    if (!babka) babka = drawChar('babka', D.BABKA.x + 0.5, D.BABKA.y + 0.75, { shirt: '#7b4a9e', hair: '#eee' }, Math.PI / 2, 0, { babka: true }, 1);
    else { babka.alive = true; if (Math.floor(t) !== babka.lastT) { babka.lastT = Math.floor(t); drawChar('babka', D.BABKA.x + 0.5, D.BABKA.y + 0.75, { shirt: '#7b4a9e', hair: '#eee' }, Math.PI / 2, Math.sin(t) * 0.3, { babka: true }, 1); } }
    for (const [id, o] of chars) {
      if (!o.alive) { scene.remove(o.sp); scene.remove(o.ghost); scene.remove(o.shadow); chars.delete(id); continue; }
      o.sp.material.color.setRGB(...lightAt(o.sp.position.x, o.sp.position.y, o.sp.position.z, lights, lights.length));
    }
    void meO;

    renderer.render(scene, camera);
    drawOverlay(t, min, se, night);
  }

  function drawOverlay(t, min, se, night) {
    const c = ov, cw = api.ov.width, ch = api.ov.height, ppb = pxPerBlock();
    c.clearRect(0, 0, cw, ch);
    // značka ťuknutia a cieľové políčko (klávesnica)
    const ring = (x, y, color, r) => {
      const h = grid ? W.surfaceY(grid, x, y) : 1;
      const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => project(x + 0.5 + (a - 0.5) * r, h + 0.01, y + 0.5 + (b - 0.5) * r));
      c.strokeStyle = color; c.lineWidth = Math.max(2, ppb * 0.05);
      c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.stroke();
    };
    if (S.tapMark) {
      const age = (performance.now() - S.tapMark.t) / 600;
      if (age < 1) ring(S.tapMark.x, S.tapMark.y, S.tapMark.act ? `rgba(255,230,90,${1 - age})` : `rgba(255,255,255,${0.8 - age * 0.8})`, 0.5 + age * 0.4);
      else S.tapMark = null;
    }
    if (S.kbd) { const f = api.frontTile(); if (f.x >= 0 && f.y >= 0 && f.x < D.W && f.y < D.H) ring(f.x, f.y, api.ctxAction(f.x, f.y) ? 'rgba(255,230,90,0.8)' : 'rgba(255,255,255,0.3)', 0.9); }

    // efekty (pohyb častíc je v 2D – ukotvíme ich do bodu vo svete)
    for (const p of S.fx) {
      const a = 1 - p.life / p.max;
      if (p.ox === undefined) { p.ox = p.fairy ? p.cx : p.x; p.oy = p.fairy ? p.cy : p.y; }
      const gy = grid ? W.surfaceY(grid, Math.max(0, Math.min(D.W - 1, Math.floor(p.ox))), Math.max(0, Math.min(D.H - 1, Math.floor(p.oy)))) : 1;
      const o = project(p.ox, gy + 0.5, p.oy);
      if (p.fairy) {
        const ang = p.a + p.life * 1.6, X = o.x + Math.cos(ang) * p.rad * ppb, Y = o.y + Math.sin(ang * 1.3) * p.rad * 0.7 * ppb - ppb * 0.5;
        c.globalAlpha = Math.min(1, a * 3);
        const g = c.createRadialGradient(X, Y, 0, X, Y, ppb * 0.35); g.addColorStop(0, p.color); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.beginPath(); c.arc(X, Y, ppb * 0.35, 0, 6.29); c.fill();
        Art.circ(c, X, Y, ppb * 0.04, '#fff'); c.globalAlpha = 1;
        continue;
      }
      const X = o.x + (p.x - p.ox) * ppb, Y = o.y + (p.y - p.oy) * ppb;
      c.globalAlpha = Math.max(0, a);
      if (p.text) { c.font = (ppb * 0.4 | 0) + 'px serif'; c.textAlign = 'center'; c.fillText(p.text, X, Y); }
      else if (p.star) { const s = ppb * p.size * (0.6 + 0.4 * Math.sin(p.life * 12)); c.fillStyle = p.color; c.fillRect(X - s / 2, Y - s * 1.5, s, s * 3); c.fillRect(X - s * 1.5, Y - s / 2, s * 3, s); }
      else Art.circ(c, X, Y, ppb * p.size, p.color);
      c.globalAlpha = 1;
    }

    // počasie
    const ts = ppb;
    if (S.weather === 'rain') {
      c.strokeStyle = 'rgba(180,210,255,0.55)'; c.lineWidth = Math.max(1, ts * 0.02); c.beginPath();
      for (let i = 0; i < 90; i++) { const rx = (Art.hash(i, 1) * cw + t * 60) % cw, ry = (Art.hash(i, 2) * ch + t * ch * 1.4) % ch; c.moveTo(rx, ry); c.lineTo(rx - ts * 0.08, ry + ts * 0.35); }
      c.stroke();
    } else if (S.weather === 'snow' || (se === 3 && Math.sin(t * 0.1) > 0.5)) {
      for (let i = 0; i < 70; i++) { const sx = (Art.hash(i, 1) * cw + Math.sin(t + i) * ts * 0.4) % cw, sy = (Art.hash(i, 2) * ch + t * ts * 0.9 * (0.6 + Art.hash(i, 3))) % ch; Art.circ(c, sx, sy, ts * 0.035, 'rgba(255,255,255,0.85)'); }
    }

    // mená, emócie, bubliny
    const label = (o, name, e, bubble) => {
      const P = project(o.sp.position.x, o.sp.position.y + 1.35, o.sp.position.z);
      c.font = 'bold ' + (ts * 0.24 | 0) + 'px system-ui, sans-serif'; c.textAlign = 'center';
      const w = c.measureText(name).width + ts * 0.2;
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(P.x - w / 2, P.y - ts * 0.22, w, ts * 0.3);
      c.fillStyle = '#fff'; c.fillText(name, P.x, P.y);
      if (e) { c.font = (ts * 0.42 | 0) + 'px serif'; c.fillText(e === 'dance' ? (Math.floor(t * 3) % 2 ? '🎵' : '🎶') : api.EMOJI[e], P.x + ts * 0.45, P.y - ts * 0.25 + Math.sin(t * 6) * ts * 0.05); }
      if (bubble && bubble.until > performance.now()) {
        c.font = (ts * 0.26 | 0) + 'px system-ui, sans-serif';
        const txt = bubble.text.length > 28 ? bubble.text.slice(0, 27) + '…' : bubble.text;
        const bw = c.measureText(txt).width + ts * 0.3;
        c.fillStyle = '#fff'; c.fillRect(P.x - bw / 2, P.y - ts * 0.75, bw, ts * 0.4);
        c.fillStyle = '#222'; c.fillText(txt, P.x, P.y - ts * 0.47);
      }
    };
    for (const o of S.others.values()) { const co = chars.get(o.id); if (co) label(co, o.name, o.e, S.bubbles[o.id]); }
    const mo = chars.get('me'); if (mo) label(mo, S.name, S.myEmote, S.bubbles[S.id]);
    if (babka) label(babka, 'Babka', null, null);

    // dúha a zlatý dážď
    for (const fx of S.screenFx) {
      const a = Math.min(1, fx.life, fx.max - fx.life);
      if (fx.k === 'rainbow') {
        const cols = ['#ff5252', '#ffb74d', '#fff176', '#81c784', '#64b5f6', '#7986cb', '#ba68c8'];
        c.globalAlpha = a * 0.45; c.lineWidth = cw * 0.035;
        cols.forEach((col, i) => { c.strokeStyle = col; c.beginPath(); c.arc(cw / 2, ch * 0.75, cw * (0.75 - i * 0.035), Math.PI, 0); c.stroke(); });
        c.globalAlpha = 1;
      } else if (fx.k === 'gold') {
        c.font = (ts * 0.45 | 0) + 'px serif'; c.textAlign = 'center';
        for (const k of fx.coins) c.fillText('🪙', k.x * cw, (k.y + fx.life * k.v) * ch);
      }
    }
  }

  // hodiny priameho slnka pre políčko (zatiaľ len informácia; neskôr pre rast rastlín)
  function sunHoursAt(x, y) { return grid ? W.sunHours(grid, x, y, api.season()) : null; }

  resize();
  return { frame, resize, pick, screenToWorld, rotate, sunHoursAt, dir8, get yaw() { return yaw; } };
}

window.Render3D = { create };
