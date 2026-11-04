// 3D častice: dážď (kvapky s čľapnutím a kruhmi na vode), oheň pod kotlíkom (plamene, iskry, dym),
// víly s trblietavou stopou a padajúce lístie zo stromov. Všetko je vo svete (nie na obrazovke),
// takže častice sa hýbu s kamerou, zakrývajú ich budovy a padajú na zem.
import * as THREE from '/vendor/three/three.module.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const hex = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// tvar bodu: 0 = žiara (mäkký kruh), 1 = štvorček (lístok, kvapka), 2 = mäkký disk (dym)
const GLOW = 0, PIXEL = 1, SOFT = 2;
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
function pointPool(scene, cap, blending) {
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
      for (const k of ['position', 'color', 'size', 'alpha', 'shape']) geo.attributes[k].needsUpdate = true;
      geo.setDrawRange(0, n);
    }
  };
}

export function createParticles({ scene, camera, renderer, W, D, S, api, ripple }) {
  const glow = pointPool(scene, 1400, THREE.AdditiveBlending);
  const soft = pointPool(scene, 900, THREE.NormalBlending);

  // ---------- Kvalita (nastavenie zariadenia): na telefóne predvolene menej častíc ----------
  const QUALITY = ['low', 'high'];
  let quality = matchMedia && matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
  try { const q = localStorage.getItem('mfParticles'); if (QUALITY.includes(q)) quality = q; } catch (e) { }
  function setQuality(q) { if (!QUALITY.includes(q)) return; quality = q; try { localStorage.setItem('mfParticles', q); } catch (e) { } }
  const k = () => (quality === 'high' ? 1 : 0.45);

  // ---------- Dážď: pásiky orientované ku kamere (čiary vo WebGL majú len 1 px) ----------
  const RAIN_MAX = 800;
  const rainGeo = new THREE.BufferGeometry();
  const rPos = new Float32Array(RAIN_MAX * 4 * 3), rAlpha = new Float32Array(RAIN_MAX * 4), rCol = new Float32Array(RAIN_MAX * 4 * 3);
  const rIdx = [];
  for (let i = 0; i < RAIN_MAX; i++) { const v = i * 4; rIdx.push(v, v + 1, v + 2, v, v + 2, v + 3); }
  rainGeo.setIndex(rIdx);
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3).setUsage(THREE.DynamicDrawUsage));
  rainGeo.setAttribute('alpha', new THREE.BufferAttribute(rAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  rainGeo.setAttribute('color', new THREE.BufferAttribute(rCol, 3).setUsage(THREE.DynamicDrawUsage));
  const rainMesh = new THREE.Mesh(rainGeo, new THREE.ShaderMaterial({ vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  rainMesh.frustumCulled = false; rainMesh.layers.set(1); rainMesh.renderOrder = 21;
  scene.add(rainMesh);
  const drops = [];
  const WIND = 1.6, FALL = 13, TOP = 8;
  let lastRipple = 0;

  // ---------- Stav častíc ----------
  let flames = [], embers = [], smoke = [], sparks = [], leaves = [], splashes = [];
  let fireAcc = 0, emberAcc = 0, smokeAcc = 0;
  const FLAME_HOT = [1, 0.95, 0.62], FLAME_MID = [1, 0.55, 0.14], FLAME_END = [0.75, 0.16, 0.05];
  const RAIN_COL = [0.72, 0.82, 0.98], SMOKE_COL = [0.55, 0.55, 0.58], SPLASH_COL = [0.75, 0.86, 1];
  const fairyCol = new Map();
  const colOf = c => { let v = fairyCol.get(c); if (!v) { v = hex(c); fairyCol.set(c, v); } return v; };

  const camRight = new THREE.Vector3();
  const tileAt = (x, z) => { const tx = Math.floor(x), tz = Math.floor(z); return tx >= 0 && tz >= 0 && tx < D.W && tz < D.H ? tz * D.W + tx : -1; };
  const groundAt = (grid, x, z) => { const i = tileAt(x, z); return i < 0 || !grid ? 0 : W.surfaceY(grid, i % D.W, (i / D.W) | 0); };

  // poloha víly (rovnaký pohyb ako v 2D: obieha okolo stredu, len v teréne a s výškou)
  function fairyPos(grid, p, t) {
    const ang = p.a + p.life * 1.6;
    const x = p.cx + Math.cos(ang) * p.rad, z = p.cy + Math.sin(ang * 1.3) * p.rad * 0.8;
    const y = groundAt(grid, p.cx, p.cy) + 0.85 + Math.sin(ang * 2.1 + p.a) * 0.3;
    return { x, y, z };
  }

  // Víly ako svetlá v noci (volá sa pri skladaní zoznamu svetiel)
  function fairyLights(grid, t, add) {
    for (const p of S.fx) if (p.fairy) { const f = fairyPos(grid, p, t); add(f.x, f.y, f.z, 1.5 * Math.min(1, p.life * 2, (p.max - p.life) * 2)); }
  }

  // ctx: { grid, fine, fineMeshes, target, viewW, viewH, se, lit, cauldron }
  function update(dt, t, ctx) {
    const { grid, target, se, lit } = ctx;
    const q = k();
    const span = Math.max(ctx.viewW, ctx.viewH * 1.75) / 2 + 1.5; // polovica štvorca okolo hráča, kde sa častice oplatí počítať
    const near = (x, z, m = 0) => Math.abs(x - target.x) < span + m && Math.abs(z - target.z) < span + m;
    const litC = c => [c[0] * lit[0], c[1] * lit[1], c[2] * lit[2]];
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    glow.mat.uniforms.pxPerUnit.value = soft.mat.uniforms.pxPerUnit.value = buf.y / (camera.top - camera.bottom);
    glow.toCam.copy(camera.position).sub(target).normalize(); soft.toCam.copy(glow.toCam);
    glow.begin(); soft.begin();

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
      const f = fairyPos(grid, p, t), c = colOf(p.color);
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

    // ---- lístie: na jeseň veľa, v lete občas, na jar okvetné lístky z jabloní, v zime nič ----
    if (se !== 3 && ctx.fine) {
      ctx.fine.forEach((f, i) => {
        if (f.type !== 'tree') return;
        const mats = W.leafMats(f.kind, se), m = ctx.fineMeshes[i];
        if (!mats || !m || !near(f.ox + 1, f.oz + 1, 1)) return;
        const rate = (se === 2 ? 0.9 : se === 0 && f.kind === 'jablon' ? 0.4 : 0.06) * q;
        if (Math.random() >= dt * rate) return;
        const b = m.userData.box, w = b.max.x - b.min.x, d = b.max.z - b.min.z, h = b.max.y - b.min.y;
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
      soft.put(p.x, p.y, p.z, litC(p.c).map(v => v * flip), p.s * (p.rest < 0 ? 0.7 + 0.3 * Math.abs(Math.sin(p.life * 3 + p.ph)) : 1), a, PIXEL);
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
        if (ti >= 0 && S.tiles[ti].g === 'water') {
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
      for (let j = 0; j < 4; j++) { rAlpha[n * 4 + j] = j < 2 ? 0.55 : 0.05; rCol[(n * 4 + j) * 3] = rc[0]; rCol[(n * 4 + j) * 3 + 1] = rc[1]; rCol[(n * 4 + j) * 3 + 2] = rc[2]; }
      n++;
    }
    for (const k2 of ['position', 'alpha', 'color']) rainGeo.attributes[k2].needsUpdate = true;
    rainGeo.setDrawRange(0, n * 6);
    rainMesh.visible = n > 0;
    splashes = splashes.filter(p => {
      p.life += dt; if (p.life >= p.max) return false;
      p.vy -= 9 * dt; p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;
      soft.put(p.x, p.y, p.z, litC(SPLASH_COL), 0.04, 0.7 * (1 - p.life / p.max), PIXEL);
      return true;
    });

    glow.end(); soft.end();
  }

  return { update, fairyLights, setQuality, get quality() { return quality; } };
}
