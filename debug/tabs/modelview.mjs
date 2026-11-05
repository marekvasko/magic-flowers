// Prehliadač modelov z minikociek pre záložky Assets a Generators v /debug (#79).
// Model { sx, sy, sz, data } zo shared/world3d.js → Three.js sieť s tieňovaním stien a AO ako v hre (render3d.mjs),
// orbitálna kamera (myš aj dotyk), mriežka polí na zemi, automatické priblíženie. Jeden renderer, viac výrezov
// (mriežka 4 obdobia × 4 otočenia, porovnanie predvolený vs. upravený), kreslí sa len pri zmene.
import * as THREE from '/vendor/three/three.module.js';

const FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.8, 0.8]; // +x, -x, +y, -y, +z, -z – ako v hre
const AO_CURVE = [0.5, 0.68, 0.84, 1];
const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]]; // [normálová os, u, v]
const hex = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// ---------- načítanie zdieľaných skriptov (stránka /debug načíta len data.js) ----------
const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) scripts[src] = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Cannot load ' + src));
    document.head.appendChild(s);
  });
  return scripts[src];
}
export async function loadWorld3D() { if (!window.World3D) await loadScript('/shared/world3d.js'); return window.World3D; }
export async function loadArt() { if (!window.Art) await loadScript('/art.js'); return window.Art; }

// CSS záložky raz do <head> (pri odpojení sa nechá, nič nerozbije)
export function injectCss(id, css) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id; s.textContent = css;
  document.head.appendChild(s);
}

// Počty a materiály modelu
export function modelStats(f) {
  const mats = new Map();
  let n = 0;
  for (let i = 0; i < f.data.length; i++) { const m = f.data[i]; if (m) { n++; mats.set(m, (mats.get(m) || 0) + 1); } }
  return { voxels: n, mats: [...mats.entries()].sort((a, b) => b[1] - a[1]) };
}
// Meno materiálu podľa čísla (z World3D.M)
export function matName(W, id) {
  for (const k in W.M) if (W.M[k] === id) return k;
  return '#' + id;
}

// ---------- sieť z minikociek ----------
// Ako buildFine v render3d.mjs: steny susediace s plnou minikockou sa vynechajú, pod modelom je zem,
// farba × tieňovanie steny × AO v rohoch. 1 minikocka = 1 jednotka, model je vycentrovaný v x a z.
export function meshModel(W, f, season) {
  const { sx, sy, sz, data } = f;
  const get = (x, y, z) => (y < 0 ? 1 : (x < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 0 : data[(z * sy + y) * sx + x]);
  const P = [], C = [], I = [];
  const box = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  const ox = -sx / 2, oz = -sz / 2;
  const colors = new Map();
  let vi = 0;
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    const m = data[(z * sy + y) * sx + x];
    if (!m) continue;
    if (x < box.x0) box.x0 = x; if (y < box.y0) box.y0 = y; if (z < box.z0) box.z0 = z;
    if (x + 1 > box.x1) box.x1 = x + 1; if (y + 1 > box.y1) box.y1 = y + 1; if (z + 1 > box.z1) box.z1 = z + 1;
    let mc = colors.get(m);
    if (!mc) { mc = hex(W.colorOf(m, season)); colors.set(m, mc); }
    const vary = 0.94 + W.hash(x, y, z) * 0.12;
    const emis = W.EMISSIVE[m] ? 1.12 : 1; // svietiace materiály trochu jasnejšie
    for (let fi = 0; fi < 6; fi++) {
      const ax = fi >> 1, sg = fi & 1 ? -1 : 1;
      const n = [0, 0, 0]; n[ax] = sg;
      if (get(x + n[0], y + n[1], z + n[2])) continue;
      const [, ua, va] = AXES[ax];
      const shade = FACE_SHADE[ax === 0 ? (sg > 0 ? 0 : 1) : ax === 1 ? (sg > 0 ? 2 : 3) : (sg > 0 ? 4 : 5)] * vary * emis;
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
        const k = shade * AO_CURVE[ao];
        P.push(p[0] + ox, p[1], p[2] + oz);
        C.push(Math.min(1, mc[0] * k), Math.min(1, mc[1] * k), Math.min(1, mc[2] * k));
      }
      if (aoV[0] + aoV[2] < aoV[1] + aoV[3]) I.push(vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi);
      else I.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      vi += 4;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setIndex(I);
  if (!Number.isFinite(box.x0)) Object.assign(box, { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 });
  // obal v súradniciach siete
  const bounds = new THREE.Box3(new THREE.Vector3(box.x0 + ox, box.y0, box.z0 + oz), new THREE.Vector3(box.x1 + ox, box.y1, box.z1 + oz));
  return { geo, bounds, faces: vi / 4 };
}

// Zem pod modelom: plocha o pole väčšia na každú stranu a čiary hraníc polí (1 pole = FINE minikociek)
function groundFor(W, f) {
  const F = W.FINE, tw = Math.round((f.sx - 2 * W.FM) / F), td = Math.round((f.sz - 2 * W.FM) / F);
  const hw = tw * F / 2, hd = td * F / 2, m = F; // okraj jedno pole
  const g = new THREE.Group();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2 * (hw + m), 2 * (hd + m)), new THREE.MeshBasicMaterial({ color: 0x8aa06a, transparent: true, opacity: 0.35, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2; plane.position.y = -0.02; plane.renderOrder = -1;
  g.add(plane);
  const pts = [];
  for (let i = -1; i <= tw + 1; i++) { const x = -hw + i * F; pts.push(x, 0.02, -hd - m, x, 0.02, hd + m); }
  for (let j = -1; j <= td + 1; j++) { const z = -hd + j * F; pts.push(-hw - m, 0.02, z, hw + m, 0.02, z); }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x3d4a33, transparent: true, opacity: 0.45 })));
  // obrys pôdorysu modelu (bez okraja FM)
  const fp = [-hw, 0.04, -hd, hw, 0.04, -hd, hw, 0.04, -hd, hw, 0.04, hd, hw, 0.04, hd, -hw, 0.04, hd, -hw, 0.04, hd, -hw, 0.04, -hd];
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  g.add(new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: 0xc0392b })));
  return g;
}
function disposeTree(o) {
  o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
}

const VIEWER_CSS = `
.mv { position: relative; width: 100%; height: 100%; min-height: 200px; border-radius: 8px; overflow: hidden; background: var(--mv-bg, #cfe0ea); touch-action: none; user-select: none; }
.mv canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.mv canvas:active { cursor: grabbing; }
.mv .mv-label { position: absolute; font: 600 11.5px system-ui, sans-serif; color: #23211c; background: rgba(255,255,255,.72); padding: 1px 6px; border-radius: 6px; pointer-events: none; white-space: nowrap; max-width: calc(100% - 8px); overflow: hidden; text-overflow: ellipsis; }
.mv .mv-sep { position: absolute; background: rgba(0,0,0,.18); pointer-events: none; }
.mv .mv-hint { position: absolute; right: 6px; bottom: 4px; font: 11px system-ui, sans-serif; color: rgba(0,0,0,.45); pointer-events: none; }
@media (prefers-color-scheme: dark) { .mv { --mv-bg: #2c3640; } .mv .mv-hint { color: rgba(255,255,255,.45); } }
`;

// Prehliadač: createViewer(el, W) → { setCells(cells, opts), resetView(), dispose() }
// cells: [{ model, season, label }], opts { cols } – všetky výrezy majú spoločný uhol a mierku (dajú sa porovnať)
export function createViewer(host, W) {
  injectCss('mv-css', VIEWER_CSS);
  const el = document.createElement('div');
  el.className = 'mv';
  host.appendChild(el);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
  catch (e) { el.textContent = 'WebGL is not available: ' + e.message; return { setCells() {}, resetView() {}, dispose() { el.remove(); } }; }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // farby v sRGB priamo, ako v hre
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  const overlay = document.createElement('div');
  el.appendChild(overlay);
  const hint = document.createElement('div');
  hint.className = 'mv-hint'; hint.textContent = 'drag: rotate · wheel/pinch: zoom · double-click: reset';
  el.appendChild(hint);
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  renderer.setClearColor(dark ? 0x2c3640 : 0xcfe0ea);

  const DEF = { yaw: Math.PI / 5, pitch: 0.42, zoom: 1 };
  const view = Object.assign({}, DEF);
  let cells = [], union = new THREE.Box3(), dirty = true, raf = 0, w = 0, hgt = 0, disposed = false;
  const cam = new THREE.PerspectiveCamera(32, 1, 0.5, 2000);

  let fixedCols = 0;
  // opts.cols = pevný počet stĺpcov (mriežka 4 × 4), inak sa vyberie podľa veľkosti
  function setCells(list, opts) {
    fixedCols = (opts && opts.cols) || 0;
    for (const c of cells) { disposeTree(c.scene); }
    union = new THREE.Box3();
    cells = list.map(c => {
      const scene = new THREE.Scene();
      const { geo, bounds } = meshModel(W, c.model, c.season || 0);
      scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true })));
      scene.add(groundFor(W, c.model));
      union.union(bounds);
      return { scene, label: c.label || '' };
    });
    layout(); request();
  }
  // rozloženie výrezov: počet stĺpcov s najväčšou bunkou
  let grid = { cols: 1, rows: 1, cw: 1, ch: 1 };
  function layout() {
    w = el.clientWidth; hgt = el.clientHeight;
    renderer.setSize(w, hgt, false);
    const n = Math.max(1, cells.length);
    let best = null;
    for (let cols = fixedCols || 1; cols <= (fixedCols || n); cols++) {
      const rows = Math.ceil(n / cols), cw = w / cols, ch = hgt / rows;
      const s = Math.min(cw, ch); // pri rovnosti radšej viac stĺpcov (stromy sú vysoké)
      if (!best || s >= best.s - 0.5) best = { s, cols, rows, cw, ch };
    }
    grid = best;
    overlay.replaceChildren();
    cells.forEach((c, i) => {
      if (!c.label) return;
      const d = document.createElement('div');
      d.className = 'mv-label';
      d.textContent = c.label;
      d.style.left = (i % grid.cols) * grid.cw + 4 + 'px';
      d.style.top = Math.floor(i / grid.cols) * grid.ch + 4 + 'px';
      overlay.appendChild(d);
    });
    for (let i = 1; i < grid.cols; i++) { const d = document.createElement('div'); d.className = 'mv-sep'; Object.assign(d.style, { left: i * grid.cw + 'px', top: 0, width: '1px', height: '100%' }); overlay.appendChild(d); }
    for (let j = 1; j < grid.rows; j++) { const d = document.createElement('div'); d.className = 'mv-sep'; Object.assign(d.style, { top: j * grid.ch + 'px', left: 0, height: '1px', width: '100%' }); overlay.appendChild(d); }
    hint.style.display = w < 360 || cells.length > 4 ? 'none' : '';
  }
  function request() { dirty = true; if (!raf && !disposed) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0;
    if (!dirty || disposed) return;
    dirty = false;
    const { cols, cw, ch } = grid;
    const center = union.getCenter(new THREE.Vector3()), size = union.getSize(new THREE.Vector3());
    const r = Math.max(4, 0.5 * Math.hypot(size.x, size.y, size.z));
    const aspect = cw / ch;
    const fov = cam.fov * Math.PI / 180;
    // presné priblíženie: všetkých 8 rohov obalu (s pôdorysom zeme) musí byť vo výreze pri tomto uhle pohľadu
    const fwd = new THREE.Vector3(-Math.cos(view.pitch) * Math.sin(view.yaw), -Math.sin(view.pitch), -Math.cos(view.pitch) * Math.cos(view.yaw));
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
    const tv = Math.tan(fov / 2), th = tv * aspect;
    let need = 1;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? union.max.x : union.min.x, i & 2 ? union.max.y : union.min.y, i & 4 ? union.max.z : union.min.z).sub(center);
      const d = c.dot(fwd);
      need = Math.max(need, Math.abs(c.dot(right)) / th - d, Math.abs(c.dot(up)) / tv - d);
    }
    const dist = need * 1.08 * view.zoom;
    cam.aspect = aspect;
    cam.position.copy(center).addScaledVector(fwd, -dist);
    cam.near = Math.max(0.1, dist - r * 4); cam.far = dist + r * 4;
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    cells.forEach((c, i) => {
      const x = (i % cols) * cw, y = hgt - (Math.floor(i / cols) + 1) * ch;
      renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch);
      renderer.render(c.scene, cam);
    });
  }

  // ---------- ovládanie: ťahanie otáča, koliesko a štipnutie približuje ----------
  const ptrs = new Map();
  let pinch = 0;
  const cv = renderer.domElement;
  const onDown = e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2) pinch = spread(); };
  const spread = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const onMove = e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 1) {
      view.yaw -= (e.clientX - p.x) * 0.01;
      view.pitch = Math.max(-0.2, Math.min(1.5, view.pitch + (e.clientY - p.y) * 0.008));
    }
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) { const s = spread(); view.zoom = Math.max(0.25, Math.min(4, view.zoom * pinch / s)); pinch = s; }
    request();
  };
  const onUp = e => { ptrs.delete(e.pointerId); if (ptrs.size === 2) pinch = spread(); };
  const onWheel = e => { e.preventDefault(); view.zoom = Math.max(0.25, Math.min(4, view.zoom * Math.exp(e.deltaY * 0.0012))); request(); };
  const onDbl = () => resetView();
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('dblclick', onDbl);
  const ro = new ResizeObserver(() => { layout(); request(); });
  ro.observe(el);

  function resetView() { Object.assign(view, DEF); request(); }
  function dispose() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    for (const c of cells) disposeTree(c.scene);
    cells = [];
    renderer.dispose();
    renderer.forceContextLoss();
    el.remove();
  }
  return { el, setCells, resetView, dispose, view, request };
}
