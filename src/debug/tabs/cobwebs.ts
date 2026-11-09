// Generátor pavučín v /debug → Generators → Cobwebs (#57): všetky čísla z Webs.WEB_PARAMS (rozmiestnenie, veľkosť, stavba,
// šum, vzhľad) ako posuvníky, živý 3D náhľad pavučiny medzi skutočnými oporami (strom, obor, ker, spadnutý kmeň) s rovnakým
// shaderom ako v hre (src/client/spiders3d.ts) a pôdorys Lesa divov s miestami, kde môže pavučina visieť (rozpätie span / gladeSpan).
// Úpravy žijú len v tejto stránke (a v adrese); „Copy parameters“ dá JSON so zmenenými hodnotami (v hre: window.MF_WEB = …).
import * as THREE from 'three';
import { meshModel } from './modelview.ts';
import { webMaterial, webLines, cornerLines, threadLines, webInfo } from '../../client/spiders3d.ts';
import type { LineFrame, SilkWorld, WebInfo } from '../../client/spiders3d.ts';
import * as Webs from '../../shared/webs.ts';
import type { Anchor, LayoutOpts, WebParamName, WebParams } from '../../shared/webs.ts';
import * as World3D from '../../shared/world3d.ts';
import type { Ground } from '../../shared/data.ts';
import { keys, lookup, must } from '../../shared/util.ts';
import type { TabCtx, h as H } from '../ui.ts';
import type { seg as Seg } from './assets.ts';

// Prepísané parametre pavučiny (len čísla – posuvníky)
export type WebOver = Partial<Record<WebParamName, number>>;
// Pohľad pavučín v Generators: h, D, kontext, plocha, prepísané parametre (čítanie a zápis), uloženie, prepínač, odpojené?
export interface WebViewInit {
  h: typeof H; D: TabCtx['D']; ctx: Pick<TabCtx, 'param' | 'setParam' | 'snap' | 'room'>; mainEl: HTMLElement;
  over: () => WebOver; setOver: (o: WebOver) => void; save: () => void; seg: typeof Seg; isGone: () => boolean;
}
type V3 = [number, number, number];

const MAX_LIGHTS = 16;
export const CSS = `
.cw-view { position: relative; height: 52vh; min-height: 300px; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); touch-action: none; }
.cw-view canvas { display: block; width: 100%; height: 100%; }
.cw-hint { position: absolute; left: 8px; bottom: 6px; font-size: 11.5px; color: #cfd8dc; text-shadow: 0 1px 2px #000; pointer-events: none; }
.cw-groups h5 { margin: 8px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.cw-plan { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; margin-top: 10px; }
.cw-plan canvas { image-rendering: pixelated; border-radius: 4px; border: 1px solid var(--line); }
.cw-plan small { display: block; color: var(--muted); max-width: 260px; }
`;
// osvetlenie náhľadu (rovnaké uniformy, aké dáva svet v hre)
interface Light { label: string; amb: V3; sun: V3; dark: number; lamp: boolean; bg: number }
const LIGHT: Readonly<Record<string, Light>> = {
  'les-lamp': { label: 'Les divov + lantern', amb: [0.04, 0.05, 0.05], sun: [0, 0, 0], dark: 1, lamp: true, bg: 0x070b09 },
  'les-dark': { label: 'Les divov, no lantern', amb: [0.04, 0.05, 0.05], sun: [0, 0, 0], dark: 1, lamp: false, bg: 0x070b09 },
  day: { label: 'Garden, day', amb: [0.62, 0.64, 0.72], sun: [0.55, 0.52, 0.44], dark: 0, lamp: false, bg: 0x9ec7e0 },
  night: { label: 'Garden, night + lantern', amb: [0.22, 0.25, 0.42], sun: [0, 0, 0], dark: 0, lamp: true, bg: 0x0d1428 }
};
const ANCH: readonly string[] = ['tree', 'giant', 'bush', 'log', 'corner', 'corner3', 'house', 'hut', 'stall', 'icehouse'];
const BUILDINGS = ['house', 'hut', 'stall', 'icehouse'];

export function webView({ h, D, ctx, mainEl, over, setOver, save, seg, isGone }: WebViewInit): { dispose: () => void } {
  const defs = Webs.WEB_PARAMS;
  const p = (k: string): string => ctx.param(k) ?? '';
  const wl = ctx.param('wl'), wa = ctx.param('wa'), wla = ctx.param('wla');
  const st = {
    light: wl && lookup(LIGHT, wl) ? wl : 'les-lamp',
    anchor: wa && ANCH.includes(wa) ? wa : 'tree',
    n: Math.max(1, Math.min(5, parseInt(p('wn'), 10) || 2)),
    silk: Math.max(1, Math.min(3, parseInt(p('ws'), 10) || 3)),
    web: parseInt(p('wid'), 10) || 1,
    lamp: wla != null && Number.isFinite(+wla) ? +wla : 0.6,
    lseed: parseInt(p('wls'), 10) || 4242
  };
  const light = (): Light => lookup(LIGHT, st.light) ?? must(LIGHT['les-lamp']);
  const saveSt = (): void => { ctx.setParam('wl', st.light); ctx.setParam('wa', st.anchor); ctx.setParam('wn', st.n); ctx.setParam('ws', st.silk); ctx.setParam('wid', st.web); ctx.setParam('wla', st.lamp); ctx.setParam('wls', st.lseed); };
  const changed = (): WebOver => { const p = Webs.webParams(over()), out: WebOver = {}; for (const k of keys(defs)) if (p[k] !== defs[k].def) out[k] = p[k]; return out; };

  // ---- ovládanie ----
  const bar = h('div', { class: 'as-bar' });
  const viewEl = h('div', { class: 'cw-view' }, h('div', { class: 'cw-hint' }, 'drag: rotate · wheel: zoom · double-click: reset'));
  const stats = h('div', { class: 'muted' });
  const json = h('pre', { class: 'gn-json' });
  const groups = h('div', { class: 'cw-groups' });
  const copyBtn = h('button', { onclick: () => { void copy(); } }, 'Copy parameters');
  const planEl = h('div', { class: 'cw-plan' });
  const tools = h('div', { class: 'gn-tools' }, h('b', null, 'Parameters'),
    h('button', { onclick: () => { setOver({}); syncAll(); changedAll(); } }, 'Reset'),
    h('button', { onclick: () => { st.web = 1 + Math.floor(Math.random() * 9999); saveSt(); renderBar(); rebuild(); } }, 'Random web'),
    copyBtn, h('span', { class: 'muted' }, 'double-click a name to reset it'));
  mainEl.replaceChildren(h('h2', null, 'Cobweb ', h('code', null, 'Webs.webParams(over) → webMaterial / Webs.analyze')), bar, viewEl, stats,
    h('div', { class: 'gn-params' }, tools, json, groups), h('h3', null, 'Placement in Les divov'), planEl);

  function renderBar(): void {
    const lampIn = h('input', { type: 'range', min: 0, max: 6.28, step: 0.01, value: st.lamp, title: 'lantern position around the web' });
    lampIn.oninput = () => { st.lamp = +lampIn.value; saveSt(); placeLamp(); request(); };
    const webIn = h('input', { type: 'number', min: 1, max: 99999, value: st.web, style: 'width:80px' });
    webIn.onchange = () => { st.web = Math.max(1, +webIn.value | 0); saveSt(); rebuild(); };
    bar.replaceChildren(...[
      seg(h, Object.values(LIGHT).map(l => l.label), Object.keys(LIGHT).indexOf(st.light), i => { st.light = Object.keys(LIGHT)[i] ?? st.light; saveSt(); renderBar(); applyLight(); request(); }),
      seg(h, ANCH, ANCH.indexOf(st.anchor), i => { st.anchor = ANCH[i] ?? st.anchor; saveSt(); renderBar(); resetView(); rebuild(); }),
      h('label', null, 'tiles ', seg(h, ['1', '2', '3', '4', '5'], st.n - 1, i => { st.n = i + 1; saveSt(); renderBar(); rebuild(); })),
      h('label', null, 'silk ', seg(h, ['1', '2', '3'], st.silk - 1, i => { st.silk = i + 1; saveSt(); renderBar(); rebuild(); })),
      h('label', null, 'web id ', webIn),
      light().lamp ? h('label', null, '🏮 ', lampIn) : null,
      h('button', { onclick: () => { resetView(); } }, 'Reset view')].flatMap(x => x ? [x] : [])); // bez lampáša nič navyše
  }

  // ---- posuvníky po skupinách ----
  const rows: Partial<Record<WebParamName, { input: HTMLInputElement; out: HTMLOutputElement; row: HTMLElement }>> = {};
  const GROUP_NAMES: Readonly<Record<string, string>> = { corner: 'Corner web (krížiak: corner = end of a wall, corner3 = inner corner)', render: 'Render (0 = shader on a plane, 1 = 3D lines)', placement: 'Placement & size', structure: 'Structure', noise: 'Perlin noise', look: 'Look & light' };
  for (const gr of Object.keys(GROUP_NAMES)) {
    const box = h('div', { class: 'gn-sliders' });
    for (const k of keys(defs)) {
      const d = defs[k];
      if (d.group !== gr) continue;
      const input = h('input', { type: 'range', min: d.min, max: d.max, step: d.step });
      const out = h('output');
      const label = h('label', { title: `${k}: default ${d.def}, ${d.min}…${d.max}, step ${d.step}` }, k);
      const row = h('div', { class: 'gn-sl' }, label, input, out);
      input.oninput = () => { const o: WebOver = { ...over() }; o[k] = +input.value; setOver(o); syncRow(k); changedAll(); };
      label.ondblclick = () => { const o: WebOver = { ...over() }; delete o[k]; setOver(o); syncRow(k); changedAll(); };
      rows[k] = { input, out, row };
      box.appendChild(row);
    }
    groups.append(h('h5', null, GROUP_NAMES[gr] ?? gr), box);
  }
  const fmtV = (v: number, d: { step: number }): string => d.step >= 1 ? String(v) : String(+v.toFixed(4));
  function syncRow(k: WebParamName): void { const p = Webs.webParams(over()), d = defs[k], r = rows[k]; if (!r) return; r.input.value = String(p[k]); r.out.textContent = fmtV(p[k], d); r.row.classList.toggle('ch', p[k] !== d.def); }
  function syncAll(): void { for (const k of keys(rows)) syncRow(k); }
  let raf2 = 0;
  function changedAll(): void {
    json.textContent = `window.MF_WEB = ${JSON.stringify(changed())}`;
    save();
    if (!raf2) raf2 = requestAnimationFrame(() => { raf2 = 0; if (!isGone()) { rebuild(); plan(); } });
  }
  async function copy(): Promise<void> {
    const text = JSON.stringify(changed());
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { const r = document.createRange(); r.selectNodeContents(json); const s = getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); } }
    copyBtn.textContent = ok ? 'Copied ✓' : 'Select + Ctrl+C';
    setTimeout(() => { if (!isGone()) copyBtn.textContent = 'Copy parameters'; }, 1500);
  }

  // ---- 3D náhľad ----
  let renderer: THREE.WebGLRenderer | null = null;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { viewEl.textContent = 'WebGL is not available: ' + (e instanceof Error ? e.message : String(e)); }
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.05, 100), target = new THREE.Vector3();
  const world: SilkWorld = {
    ambient: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Vector3() }, sunDir: { value: new THREE.Vector3(0.45, 0.8, 0.4).normalize() },
    lampColor: { value: new THREE.Vector3(1, 0.78, 0.45) }, lights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) }, lightCount: { value: 0 },
    darkOn: { value: 0 }, eye: { value: new THREE.Vector4(0, 0, 0, 3.5) }, eyeLit: { value: new THREE.Vector2(3.6, 0.2) }
  };
  const viewDir = { value: new THREE.Vector3() };
  const frame: LineFrame = { res: { value: new THREE.Vector2(1, 1) }, time: { value: 0 } }; // pavučina z čiar: veľkosť obrazu a čas (kývanie)
  const lampMesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
  let objs: (THREE.Mesh | THREE.LineSegments)[] = [], web: THREE.Mesh | THREE.LineSegments | null = null;
  const lamp0 = must(world.lights.value[0]);
  const infoOf = (m: THREE.Mesh | THREE.LineSegments): WebInfo => must(webInfo(m));
  const view = { yaw: 0.35, pitch: 0.38, dist: 4.2 };
  if (renderer) {
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    viewEl.prepend(renderer.domElement);
    scene.add(lampMesh);
    let drag: { x: number; y: number } | null = null;
    const cv = renderer.domElement;
    cv.onpointerdown = e => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => { if (!drag) return; view.yaw -= (e.clientX - drag.x) * 0.008; view.pitch = Math.max(-0.2, Math.min(1.4, view.pitch + (e.clientY - drag.y) * 0.006)); drag = { x: e.clientX, y: e.clientY }; request(); };
    cv.onpointerup = () => { drag = null; };
    cv.onwheel = e => { e.preventDefault(); view.dist = Math.max(0.6, Math.min(14, view.dist * (e.deltaY > 0 ? 1.1 : 0.9))); request(); };
    cv.ondblclick = resetView;
    new ResizeObserver(() => { request(); }).observe(viewEl);
  }
  function resetView(): void { Object.assign(view, BUILDINGS.includes(st.anchor) ? { yaw: 0.8, pitch: 0.3, dist: 1.4 } : st.anchor.startsWith('corner') ? { yaw: 0.8, pitch: 0.45, dist: 2.2 } : { yaw: 0.35, pitch: 0.38, dist: 2.2 + st.n * 1.1 }); request(); }
  const matBark = new THREE.MeshLambertMaterial({ color: 0x7a5236 }), matLeaf = new THREE.MeshLambertMaterial({ color: 0x3f7a36 }), matGround = new THREE.MeshLambertMaterial({ color: 0x5a4a36 });
  const amb = new THREE.AmbientLight(0xffffff, 1), sunL = new THREE.DirectionalLight(0xffffff, 0), lampL = new THREE.PointLight(0xffc878, 0, 3.5, 1.5);
  scene.add(amb, sunL, lampL);
  // Umelé políčka: chodník šírky n medzi dvoma oporami (ako v Lese divov), pavučina cez stred
  function tiles(): { t: { g: Ground }[]; w: number; hh: number; wb: { x: number; y: number; ax: 0; n: number } } {
    const w = st.n + 6, hh = 6, t = new Array<Ground>(w * hh).fill('path');
    const a = 2, b = 3 + st.n, y = 3; // opory v stĺpcoch a a b, pavučina v riadku y
    const put = (x: number, yy: number, g: Ground): void => { if (x >= 0 && yy >= 0 && x < w && yy < hh) t[yy * w + x] = g; };
    if (st.anchor === 'giant') { put(a - 1, y - 1, 'giant'); put(a, y - 1, 'trunk'); put(a - 1, y, 'trunk'); put(a, y, 'trunk'); put(b, y - 1, 'giant'); put(b + 1, y - 1, 'trunk'); put(b, y, 'trunk'); put(b + 1, y, 'trunk'); }
    else { const g = st.anchor as Ground; put(a, y, g); put(b, y, g); } // tree, bush, log (kúty a budovy sa riešia inde)
    return { t: t.map(g => ({ g })), w, hh, wb: { x: a + 1, y, ax: 0, n: st.n } };
  }
  // pavučina tak, ako ju kreslí hra: shader na rovine, alebo 3D vlákna z čiar (render = 1)
  function makeWeb(P: WebParams, opts: LayoutOpts): THREE.Mesh | THREE.LineSegments {
    return P.render === 1 ? webLines(THREE, world, viewDir, P, opts, MAX_LIGHTS, frame) : new THREE.Mesh(new THREE.PlaneGeometry(opts.w, opts.h), webMaterial(THREE, world, viewDir, P, opts, MAX_LIGHTS));
  }
  function anchorMesh(o: Anchor): THREE.Mesh {
    if (o.g === 'bush') { const m = new THREE.Mesh(new THREE.SphereGeometry(o.r, 16, 12), matLeaf); m.position.set(o.cx, o.r * 0.8, o.cz); return m; }
    if (o.g === 'log') { const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, 1, 14), matBark); m.rotation.x = Math.PI / 2; m.position.set(o.cx, o.r, o.cz); return m; }
    const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r * 0.9, o.r * 1.1, 3.2, 20), matBark); m.position.set(o.cx, 1.6, o.cz); return m;
  }
  function disposeObj(o: THREE.Mesh | THREE.LineSegments): void { o.geometry.dispose(); for (const m of [o.material].flat()) if (m instanceof THREE.ShaderMaterial) m.dispose(); }
  function rebuild(): void {
    if (!renderer) return;
    for (const o of objs) { scene.remove(o); disposeObj(o); }
    objs = [];
    const T = tiles(), P = Webs.webParams(over()), g = Webs.webGeom(T.t, T.w, T.hh, T.wb, over());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(T.w, T.hh), matGround); ground.rotation.x = -Math.PI / 2; ground.position.set(T.w / 2, 0, T.hh / 2); objs.push(ground);
    if (st.anchor.startsWith('corner')) { rebuildCorner(P); return; }
    if (BUILDINGS.includes(st.anchor)) { rebuildBuilding(P); return; }
    for (const o of [g.a, g.b]) if (o) objs.push(anchorMesh(o));
    const wb = web = makeWeb(P, { w: g.len, h: g.hgt, seed: st.web, keep: st.silk >= 3 ? 1 : st.silk === 2 ? 0.72 : 0.42 });
    wb.position.set((g.u0 + g.u1) / 2, g.hgt / 2 + 0.02, g.line);
    objs.push(wb);
    for (const o of objs) scene.add(o);
    target.set((g.u0 + g.u1) / 2, g.hgt * 0.5, g.line);
    const inf = infoOf(wb);
    stats.textContent = `web ${st.web}: ${g.len.toFixed(2)} × ${g.hgt.toFixed(2)} tiles between ${g.a ? g.a.g : '–'} and ${g.b ? g.b.g : '–'} · ${inf.render}${inf.render === 'lines' ? ` (${inf.segments ?? 0} segments × ${inf.copies ?? 0} copies)` : ''} · ${inf.hubs} centre${inf.hubs > 1 ? 's' : ''} · mooring ${inf.moor[0]} + ${inf.moor[1]} · ${inf.fill ? 'concentric' : 'spiral'} fill · ${Object.keys(changed()).length} changed`;
    placeLamp(); applyLight(); request();
  }
  // kútová pavučina: v súradniciach kúta (počiatok na zemi v kúte, X von zo steny 1, Z pozdĺž nej / von zo steny 2), ako v hre
  function rebuildCorner(P: WebParams): void {
    const three = st.anchor === 'corner3', O = new THREE.Vector3(3, 0, 3);
    const box = (x0: number, x1: number, z0: number, z1: number): void => { const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1.4, z1 - z0), new THREE.MeshLambertMaterial({ color: 0xd8cbb0 })); m.position.set(O.x + (x0 + x1) / 2, 0.7, O.z + (z0 + z1) / 2); objs.push(m); };
    box(-1, 0, three ? -1 : 0, 2);   // stena 1 (X < 0); pri konci steny sa končí v Z = 0
    if (three) box(0, 2, -1, 0);     // stena 2 (Z < 0)
    const wb = web = cornerLines(THREE, world, viewDir, P, { seed: st.web, faces: three ? 3 : 2, keep: st.silk >= 3 ? 1 : st.silk === 2 ? 0.72 : 0.42 }, MAX_LIGHTS, frame);
    wb.position.copy(O);
    objs.push(wb);
    const inf = infoOf(wb), hub = must(inf.hub ?? undefined);
    const kz = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: 0xa0682e })); // krížiak
    kz.position.set(O.x + hub[0], hub[1], O.z + hub[2]); objs.push(kz);
    for (const o of objs) scene.add(o);
    target.set(O.x + 0.3, 0.3, O.z + 0.3);
    stats.textContent = `corner web ${st.web} (${three ? '3 faces: two walls + ground' : '2 faces: wall + ground'}): ${inf.hubs === 2 ? 'with a break – 2 regions' : 'no break – 1 region'} · ${inf.segments ?? 0} segments × ${inf.copies ?? 0} copies · ${inf.fill ? 'concentric' : 'spiral'} fill · ${Object.keys(changed()).length} changed`;
    placeLamp(); applyLight(); request();
  }
  // kút v budove z minikociek: model budovy (ako v hre), Webs.voxelCorners na celom modeli, výber a veľkosť podľa „web id“
  function rebuildBuilding(P: WebParams): void {
    const W3 = World3D, ft = W3.FINE_MODELS.find(m => m.id === st.anchor);
    if (!ft) { stats.textContent = 'World3D is not loaded'; return; }
    const model = ft.build(1, 0), O = new THREE.Vector3(1, 0, 1);
    const { geo } = meshModel(W3, model, 1);
    const house = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    house.scale.setScalar(1 / 8); house.position.set(O.x + model.sx / 16, 0, O.z + model.sz / 16); objs.push(house); // meshModel je vycentrovaný
    const all = Webs.voxelCorners(model, { x0: 0, x1: model.sx - 1, y0: 0, y1: model.sy - 1, z0: 0, z1: model.sz - 1 });
    const r = Webs.voxelWeb(model, all, st.web, over(), st.silk >= 3 ? 1 : st.silk === 2 ? 0.72 : 0.42); // kotvy sa navzájom vidia
    if (!r) { stats.textContent = 'no corner with anchors that see each other'; return; }
    const q = r.q;
    const wb = web = threadLines(THREE, world, viewDir, P, r.th, MAX_LIGHTS, frame);
    wb.matrixAutoUpdate = false;
    wb.matrix.makeBasis(new THREE.Vector3(...q.X), new THREE.Vector3(...q.Y), new THREE.Vector3(...q.Z)).setPosition(O.x + q.o[0] / 8, q.o[1] / 8, O.z + q.o[2] / 8);
    wb.matrixWorldNeedsUpdate = true;
    objs.push(wb);
    for (const o of objs) scene.add(o);
    const inf = infoOf(wb);
    const c = new THREE.Vector3(...must(inf.hub ?? undefined)).applyMatrix4(wb.matrix);
    target.copy(c);
    // kamera z otvorenej strany kúta (uhlopriečka osí pavučiny), blízko – pavučiny v budove sú malé
    const d = new THREE.Vector3(...q.X).add(new THREE.Vector3(...q.Y)).add(new THREE.Vector3(...q.Z)).normalize();
    Object.assign(view, { yaw: Math.atan2(d.x, d.z), pitch: Math.max(-0.2, Math.min(1.4, Math.asin(d.y) * 0.6 + 0.15)), dist: 0.5 + Math.max(...q.size) * 1.6 });
    stats.textContent = `${st.anchor}: corner ${all.findIndex(x => x.o.join() === q.o.join() && x.X.join() === q.X.join() && x.Z.join() === q.Z.join()) + 1} of ${all.length} · web ${q.vox.join(' × ')} voxels (free space ${q.free.join(' × ')}) · ${q.faces} faces · ${inf.hubs === 2 ? 'with a break' : 'no break'} · ${inf.segments ?? 0} segments · change “web id” for another corner`;
    placeLamp(); applyLight(); request();
  }
  function placeLamp(): void {
    const r = 0.9 + st.n * 0.25;
    lampMesh.position.set(target.x + Math.cos(st.lamp) * r, 0.9, target.z + Math.sin(st.lamp) * r);
  }
  function applyLight(): void {
    const L = light();
    world.ambient.value.set(...L.amb); world.sunColor.value.set(...L.sun); world.darkOn.value = L.dark;
    world.lampColor.value.set(1, 0.78, 0.45).multiplyScalar(L.dark ? 0.6 : 1);
    world.lightCount.value = L.lamp ? 1 : 0;
    lamp0.set(lampMesh.position.x, lampMesh.position.y, lampMesh.position.z, L.dark ? 3.5 : 6.5);
    world.eye.value.set(lampMesh.position.x, 0.9, lampMesh.position.z, L.lamp ? 3.5 : 3);
    lampMesh.visible = L.lamp;
    amb.intensity = Math.max(L.amb[0], 0.06) * 4; sunL.intensity = L.sun[0] * 2; sunL.position.copy(world.sunDir.value);
    lampL.intensity = L.lamp ? 2.5 : 0; lampL.position.copy(lampMesh.position);
    if (renderer) renderer.setClearColor(L.bg);
  }
  let rafR = 0;
  function request(): void { if (!rafR && renderer) rafR = requestAnimationFrame(draw); }
  function draw(): void {
    rafR = 0;
    if (isGone() || !renderer) return;
    const w = viewEl.clientWidth, hh = viewEl.clientHeight;
    if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) renderer.setSize(w, hh, false);
    cam.aspect = w / Math.max(1, hh); cam.updateProjectionMatrix();
    cam.position.set(target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * view.dist, target.y + Math.sin(view.pitch) * view.dist, target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.dist);
    cam.lookAt(target);
    viewDir.value.copy(cam.position).sub(target).normalize();
    if (light().lamp) { lamp0.set(lampMesh.position.x, lampMesh.position.y, lampMesh.position.z, light().dark ? 3.5 : 6.5); }
    renderer.getDrawingBufferSize(frame.res.value);
    frame.time.value = performance.now() / 1000;
    renderer.render(scene, cam);
    if (web instanceof THREE.LineSegments && Webs.webParams(over()).sway > 0) request(); // kývanie: kreslí sa stále
  }

  // ---- pôdorys: kde môže pavučina visieť (Webs.analyze s aktuálnym rozpätím) ----
  function plan(): void {
    const seedIn = h('input', { type: 'number', min: 0, max: 4294967295, value: st.lseed, style: 'width:120px' });
    seedIn.onchange = () => { st.lseed = Math.max(0, +seedIn.value >>> 0); saveSt(); plan(); };
    const ls = ctx.snap?.state.lesSeed, roomSeed = typeof ls === 'number' && Number.isInteger(ls) ? ls : null;
    const les = D.buildLes(st.lseed).map(g => ({ g })), f = Webs.analyze(les, st.lseed, over());
    const w = D.LES_W, hh = D.LES_H, s = 7;
    const c = h('canvas', { width: w * s, height: hh * s }), x = must(c.getContext('2d') ?? undefined);
    const COL: Readonly<Partial<Record<Ground, string>>> = { path: '#c9a86e', moss: '#55703f', roots: '#a88a5a', fern: '#4b7a3a', fungi: '#7a4a6a', glade: '#d8c95a', gate: '#f0a030' };
    les.forEach((t, i) => { x.fillStyle = D.BLOCK[t.g] ? (t.g === 'giant' || t.g === 'trunk' ? '#2a1a0e' : t.g === 'log' ? '#5a3c22' : '#1d3320') : COL[t.g] || '#666'; x.fillRect(i % w * s, ((i / w) | 0) * s, s, s); });
    for (let i = 0; i < f.owner.length; i++) { const o = f.owner[i] ?? -1; if (o >= 0) { x.fillStyle = `hsla(${o * 52},80%,55%,.28)`; x.fillRect(i % w * s, ((i / w) | 0) * s, s, s); } }
    let total = 0;
    const by: Partial<Record<number, number>> = {};
    f.cands.forEach((list, o) => { list.forEach(cd => {
      total++; by[cd.n] = (by[cd.n] || 0) + 1;
      x.strokeStyle = `hsl(${o * 52},90%,75%)`; x.lineWidth = 2; x.beginPath();
      const x0 = cd.x * s + (cd.ax ? s / 2 : 0), y0 = cd.y * s + (cd.ax ? 0 : s / 2);
      x.moveTo(x0, y0); x.lineTo(x0 + (cd.ax ? 0 : cd.n * s), y0 + (cd.ax ? cd.n * s : 0)); x.stroke();
    }); });
    for (const hm of f.homes) { x.fillStyle = hm.k === 'p' ? '#ff5a4a' : '#ffcf6a'; x.beginPath(); x.arc(hm.x * s + s / 2, hm.y * s + s / 2, s * 0.6, 0, 7); x.fill(); }
    const P = Webs.webParams(over());
    planEl.replaceChildren(c, h('div', null,
      h('label', null, 'Forest seed ', seedIn), ' ',
      h('button', { onclick: () => { st.lseed = Math.floor(Math.random() * 4294967296); saveSt(); plan(); } }, 'Random'),
      roomSeed != null ? h('button', { onclick: () => { st.lseed = roomSeed; saveSt(); plan(); } }, `Room ${ctx.room}'s forest`) : null,
      h('small', null, `${total} possible webs (span ≤ ${P.span}, across a clearing ≤ ${P.gladeSpan}): ` + Object.entries(by).map(([n, k]) => `${k ?? 0}× ${n} tile${+n > 1 ? 's' : ''}`).join(', ')),
      h('small', null, 'Lines = where a web can hang (between two anchors), colour = owner. Tinted tiles = territories. ● yellow = wolf spider burrows, ● red = stará pradlena.')));
  }

  renderBar(); syncAll();
  json.textContent = `window.MF_WEB = ${JSON.stringify(changed())}`;
  resetView(); rebuild(); plan();
  return { dispose() { if (renderer) { for (const o of objs) disposeObj(o); renderer.dispose(); renderer.forceContextLoss(); } } };

}
