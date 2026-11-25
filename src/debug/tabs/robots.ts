// Záložka Robots v /debug (#194): procedurálny generátor hráča ako 3D robota.
//  - Presets: päť ručne naladených robotov (predvoľby generátora) vedľa seba alebo jeden zblízka.
//  - Generator: robot zo semienka; každý diel (podvozok, trup, hlava, oči, doplnok), rozmer, drobnosť a farba sa dá zmeniť,
//    „Copy parameters“ skopíruje genóm ako JSON (ten istý tvar, aký bude v uložení hráča).
//  - Crowd: 12 robotov z nasledujúcich semienok (ako by vyzerali iní hráči); klik na semienko ho otvorí v generátore.
// Spoločné: animácia (chôdza, plazenie, tanec, hrabanie, skok), deň / noc s lampášom, náradie v ruke a na chrbte.
// Kamera ako v hre (izometrická), ťahaním sa otáča. Texty po anglicky (nástroj pre správcu), mená dielov po slovensky ako v hre.
import * as THREE from 'three';
import * as RM from '../../shared/robotmodel.ts';
import type { FlagKey, NumKey, RobotLook } from '../../shared/robotmodel.ts';
import type { ToolId } from '../../shared/data.ts';
import { buildRobot } from '../../client/robot3d.ts';
import type { Robot3D } from '../../client/robot3d.ts';
import { must } from '../../shared/util.ts';
import { errText } from '../ui.ts';
import type { TabCtx, TabInstance } from '../ui.ts';

const CSS = `
.rb { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.rb-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.rb label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; }
.rb-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.rb-seg button { border: none; border-radius: 0; padding: 3px 9px; }
.rb-seg button.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.rb-main { display: grid; grid-template-columns: 300px 1fr; gap: 10px; flex: 1; min-height: 0; }
.rb-main.wide { grid-template-columns: 1fr; }
@media (max-width: 800px) { .rb-main { grid-template-columns: 1fr; } }
.rb-panel { overflow-y: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
.rb-panel > * { flex-shrink: 0; }
.rb-panel h5 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.rb-row { display: grid; grid-template-columns: 112px 1fr 44px; align-items: center; gap: 6px; }
.rb-row span:last-child { font-family: var(--mono); font-size: 12px; text-align: right; }
.rb-row input[type=range] { width: 100%; }
.rb-seed { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.rb-seed input { width: 110px; }
.rb-view { position: relative; min-height: 360px; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); cursor: grab; touch-action: none; }
.rb-view canvas { display: block; width: 100%; height: 100%; position: absolute; inset: 0; }
.rb-names { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: space-around; pointer-events: none; }
.rb-names div, .rb-tag { background: rgba(0,0,0,.45); color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.rb-tag { position: absolute; transform: translate(-50%, -100%); cursor: pointer; white-space: nowrap; }
.rb-tag:hover { background: rgba(107,63,160,.85); }
.rb-info { font-size: 12.5px; }
.rb input[type=color] { width: 32px; height: 22px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: none; }
`;
const ANIMS = ['idle', 'walk', 'use tool', 'crawl', 'dance', 'dig', 'jump'] as const;
const MODES = ['presets', 'generator', 'crowd'] as const;
type Mode = typeof MODES[number];
const TOOLS: readonly ToolId[] = ['hoe', 'can', 'pick', 'lamp'];
const TOOL_NAME: Readonly<Record<ToolId, string>> = { hoe: 'Motyka', can: 'Krhla', pick: 'Krompáč', lamp: 'Lampáš' };
const PITCH = Math.atan(1 / Math.SQRT2); // sklon kamery ako v hre
const CROWD = 12;

function seg(labels: readonly string[], value: number, onPick: (i: number) => void): HTMLElement {
  const d = document.createElement('div'); d.className = 'rb-seg';
  labels.forEach((l, i) => { const b = document.createElement('button'); b.textContent = l; if (i === value) b.className = 'on'; b.onclick = () => { onPick(i); }; d.appendChild(b); });
  return d;
}
function parseLook(s: string | null): RobotLook | null {
  if (!s) return null;
  try { const j: unknown = JSON.parse(s); return RM.robotLook(j); } catch { return null; }
}

export function mount(el: HTMLElement, ctx: TabCtx): TabInstance {
  const { h } = ctx;
  const style = h('style', null, CSS); document.head.appendChild(style);
  const p = (k: string): string | null => ctx.param(k);
  const seed0 = Number.parseInt(p('rs') ?? '', 10);
  const st: {
    mode: Mode; anim: typeof ANIMS[number]; held: ToolId | null; carried: Set<ToolId>; night: boolean;
    one: RM.PresetId | null; seed: number; look: RobotLook; yaw: number; zoom: number;
  } = {
    mode: MODES.find(m => m === p('rv')) ?? 'generator',
    anim: ANIMS.find(a => a === p('ra')) ?? 'idle',
    held: p('rh') === 'none' ? null : TOOLS.find(t => t === p('rh')) ?? 'hoe',
    carried: new Set<ToolId>((p('rc') ?? 'can,pick').split(',').flatMap(t => TOOLS.filter(x => x === t))),
    night: p('rn') === '1',
    one: RM.PRESET_IDS.find(x => x === p('rf')) ?? null, // predvoľba zblízka
    seed: Number.isFinite(seed0) ? seed0 >>> 0 : 1,
    look: RM.PRESETS.hrdzavec.look,
    yaw: Number(p('ry') ?? '0.35') || 0,
    zoom: Math.max(1, Math.min(3, Number.parseInt(p('rz') ?? '1', 10) || 1))
  };
  st.look = parseLook(p('rg')) ?? RM.randomLook(st.seed);
  const save = (): void => {
    ctx.setParam('rv', st.mode); ctx.setParam('ra', st.anim); ctx.setParam('rh', st.held ?? 'none');
    ctx.setParam('rc', [...st.carried].join(',')); ctx.setParam('rn', st.night ? 1 : null); ctx.setParam('rf', st.one);
    ctx.setParam('rs', st.seed); ctx.setParam('rg', JSON.stringify(st.look)); ctx.setParam('ry', st.yaw.toFixed(2)); ctx.setParam('rz', st.zoom > 1 ? st.zoom : null);
  };

  const bar = h('div', { class: 'rb-bar' }), panel = h('div', { class: 'rb-panel' });
  const view = h('div', { class: 'rb-view' }), names = h('div', { class: 'rb-names' }), tags = h('div');
  const main = h('div', { class: 'rb-main' }, panel, view);
  const info = h('div', { class: 'rb-info muted' },
    'Procedural robot generator for ', h('a', { href: 'https://github.com/marekvasko/magic-flowers/issues/194', target: '_blank' }, '#194'),
    ': a robot is a genome of parts (chassis, body, head, eyes, details), sizes and colours; a seed gives a random one, the five presets are hand-tuned genomes. ',
    `Every robot has the same dimensions (${RM.FRAME.height} tiles tall, same shoulders, arm length and hand positions) – only shapes and looks change. The selected tool is in the right gripper; every other owned tool has its own place on the back rack (motyka and krompáč in the holster tubes, krhla and lampáš on the hooks). Switching tools (In hand) is animated: the robot tosses the held tool over its shoulder into its holder and the rack catapults the new one over its head into the gripper. Drag to rotate; 1 grid square = 1 tile.`);
  el.replaceChildren(h('div', { class: 'rb' }, bar, main, info));

  // ---------- scéna ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  view.append(renderer.domElement, names, tags);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x5a6b3a, 1.3); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 20 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const lampLights: THREE.PointLight[] = [];
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x7c9a52, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(14, 14, 0x5d7a3c, 0x5d7a3c); grid.position.y = 0.002;
  const gm = grid.material; if (gm instanceof THREE.Material) { gm.transparent = true; gm.opacity = 0.35; }
  scene.add(grid);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);

  interface Bot { r: Robot3D; x: number; z: number; tag?: HTMLElement }
  let robots: Bot[] = [];
  const addBot = (b: Bot): void => { b.r.setTools(st.held, [...st.carried]); scene.add(b.r.group); robots.push(b); };
  function rebuild(): void {
    for (const o of robots) o.r.dispose();
    robots = [];
    names.replaceChildren(); tags.replaceChildren();
    if (st.mode === 'presets') {
      const ids = st.one ? [st.one] : RM.PRESET_IDS;
      ids.forEach((s, i) => { addBot({ r: buildRobot(RM.PRESETS[s].look), x: (i - (ids.length - 1) / 2) * 1.0, z: 0 }); });
      names.replaceChildren(...ids.map(s => h('div', null, RM.PRESETS[s].name)));
    } else if (st.mode === 'generator') {
      addBot({ r: buildRobot(st.look), x: 0, z: 0 });
    } else {
      for (let i = 0; i < CROWD; i++) {
        const seed = (st.seed + i) >>> 0;
        const tag = h('div', { class: 'rb-tag', title: 'Open in the generator', onclick: () => { st.seed = seed; st.look = RM.randomLook(seed); st.mode = 'generator'; save(); rebuild(); } }, '#' + seed);
        tags.appendChild(tag);
        addBot({ r: buildRobot(RM.randomLook(seed)), x: ((i % 4) - 1.5) * 1.15, z: (Math.floor(i / 4) - 1) * 1.25, tag });
      }
    }
    while (lampLights.length < robots.length) { const l = new THREE.PointLight(0xffb04a, 0, 2.5, 1.6); scene.add(l); lampLights.push(l); }
    main.className = 'rb-main' + (st.mode === 'generator' ? '' : ' wide');
    panel.style.display = st.mode === 'generator' ? '' : 'none';
    renderBar(); if (st.mode === 'generator') renderPanel();
  }
  function light(): void {
    const n = st.night;
    hemi.intensity = n ? 0.25 : 1.3; hemi.color.set(n ? 0x5565a0 : 0xdfefff);
    sun.intensity = n ? 0.15 : 2.2; sun.color.set(n ? 0x8090ff : 0xfff2dc);
    scene.background = new THREE.Color(n ? 0x0d1224 : 0xa9d4ee);
  }

  // ---------- ovládanie ----------
  function renderBar(): void {
    bar.replaceChildren(...[
      seg(['Presets', 'Generator', 'Crowd'], MODES.indexOf(st.mode), i => { st.mode = must(MODES[i]); save(); rebuild(); }),
      st.mode === 'presets' ? seg(['All', ...RM.PRESET_IDS.map(x => RM.PRESETS[x].name)], st.one ? RM.PRESET_IDS.indexOf(st.one) + 1 : 0, i => { st.one = RM.PRESET_IDS[i - 1] ?? null; save(); rebuild(); }) : null,
      st.mode === 'crowd' ? h('span', { class: 'rb-seed' }, h('button', { onclick: () => { st.seed = Math.max(0, st.seed - CROWD); save(); rebuild(); } }, '◀'), `seeds ${st.seed}–${st.seed + CROWD - 1}`, h('button', { onclick: () => { st.seed += CROWD; save(); rebuild(); } }, '▶')) : null,
      seg(ANIMS, ANIMS.indexOf(st.anim), i => { st.anim = must(ANIMS[i]); save(); renderBar(); }),
      seg(['Day', 'Night'], st.night ? 1 : 0, i => { st.night = !!i; save(); light(); renderBar(); }),
      seg(['1×', '2×', '3×'], st.zoom - 1, i => { st.zoom = i + 1; save(); renderBar(); }),
      // výmena náradia s animáciou: staré letí na nosič, nové z nosiča do ruky (obe sú vlastnené – sú v „On back“)
      h('label', null, 'In hand', seg(['—', ...TOOLS.map(t => TOOL_NAME[t])], st.held ? TOOLS.indexOf(st.held) + 1 : 0, i => {
        const to = TOOLS[i - 1] ?? null;
        if (st.held) st.carried.add(st.held);
        if (to) st.carried.add(to);
        st.held = to; save();
        for (const o of robots) o.r.switchTool(to);
        renderBar();
      })),
      h('label', null, 'On back', ...TOOLS.map(t => {
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = st.carried.has(t);
        c.onchange = () => { if (c.checked) st.carried.add(t); else st.carried.delete(t); save(); rebuild(); };
        return h('label', null, c, TOOL_NAME[t]);
      }))].filter(x => x !== null));
  }
  // zmena genómu v generátore: prestaví len robota (panel sa prekreslí len pri zmene dielu, aby posúvač nestratil ťahanie)
  const stats = h('div', { class: 'muted' });
  const statText = (): string => { const m = robots[0]?.r.model; return m ? `${m.parts.length} parts · ${m.joints.length} joints · height ${m.height} tiles · scale ${m.scale.toFixed(2)} · ${m.gait}` : ''; };
  function setLook(l: RobotLook, panelToo = false): void {
    st.look = RM.robotLook(l); save();
    for (const o of robots) o.r.dispose();
    robots = [];
    addBot({ r: buildRobot(st.look), x: 0, z: 0 });
    if (panelToo) renderPanel(); else stats.textContent = statText();
  }
  const copyMsg = h('span', { class: 'muted' });
  function renderPanel(): void {
    const L = st.look;
    const seedIn = document.createElement('input'); seedIn.type = 'number'; seedIn.min = '0'; seedIn.value = String(st.seed);
    const goSeed = (s: number): void => { st.seed = s >>> 0; setLook(RM.randomLook(st.seed), true); };
    seedIn.onchange = () => { goSeed(Number.parseInt(seedIn.value, 10) || 0); };
    const part = <K extends 'loco' | 'body' | 'head' | 'acc'>(k: K, ids: readonly RobotLook[K][], label: (x: RobotLook[K]) => string): HTMLElement =>
      seg(ids.map(label), ids.indexOf(L[k]), i => { setLook({ ...st.look, [k]: must(ids[i]) }, true); });
    const slider = (k: NumKey): HTMLElement => {
      const r = RM.NUM[k], v = h('span', null, String(L[k]));
      const i = document.createElement('input'); i.type = 'range'; i.min = String(r.min); i.max = String(r.max); i.step = String((r.max - r.min) / 100); i.value = String(L[k]);
      i.oninput = () => { v.textContent = Number(i.value).toFixed(3); setLook({ ...st.look, [k]: Number(i.value) }); };
      return h('div', { class: 'rb-row' }, h('span', null, r.name), i, v);
    };
    const flag = (k: FlagKey): HTMLElement => {
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = L[k];
      c.onchange = () => { setLook({ ...st.look, [k]: c.checked }); };
      return h('label', null, c, RM.FLAGS[k]);
    };
    const colorIn = (k: 'paint' | 'accent' | 'eye', label: string): HTMLElement => {
      const i = document.createElement('input'); i.type = 'color'; i.value = L[k];
      i.oninput = () => { setLook({ ...st.look, [k]: i.value }); };
      return h('label', null, label, i);
    };
    panel.replaceChildren(
      h('div', { class: 'rb-seed' }, 'Seed', seedIn,
        h('button', { title: 'Previous seed', onclick: () => { goSeed(Math.max(0, st.seed - 1)); } }, '◀'),
        h('button', { title: 'Next seed', onclick: () => { goSeed(st.seed + 1); } }, '▶'),
        h('button', { title: 'Random seed', onclick: () => { goSeed(Math.floor(Math.random() * 1e6)); } }, '🎲')),
      h('div', { class: 'rb-seed' }, 'Preset', ...RM.PRESET_IDS.map(id => h('button', { onclick: () => { setLook(RM.PRESETS[id].look, true); } }, RM.PRESETS[id].name))),
      stats,
      h('h5', null, 'Parts'),
      h('label', null, 'Podvozok'), part('loco', RM.LOCOS, x => RM.PART_NAMES.loco[x]),
      h('label', null, 'Trup'), part('body', RM.BODIES, x => RM.PART_NAMES.body[x]),
      h('label', null, 'Hlava'), part('head', RM.HEADS, x => RM.PART_NAMES.head[x]),
      h('label', null, 'Oči', seg(['1', '2'], L.eyes - 1, i => { setLook({ ...st.look, eyes: i ? 2 : 1 }, true); })),
      h('label', null, 'Hrany', seg(RM.EDGES.map(x => RM.PART_NAMES.edges[x]), RM.EDGES.indexOf(L.edges), i => { setLook({ ...st.look, edges: must(RM.EDGES[i]) }, true); })),
      h('label', null, 'Doplnok'), part('acc', RM.ACCS, x => RM.PART_NAMES.acc[x]),
      h('h5', null, 'Shape'),
      ...RM.NUM_KEYS.filter(k => k !== 'wear').map(slider),
      h('h5', null, 'Details & colours'),
      h('div', { class: 'rb-bar' }, ...RM.FLAG_KEYS.map(flag)),
      slider('wear'),
      h('div', { class: 'rb-bar' }, colorIn('paint', 'Náter'), colorIn('accent', 'Doplnková'), colorIn('eye', 'Oči')),
      h('div', { class: 'rb-bar' },
        h('button', { onclick: () => { navigator.clipboard.writeText(JSON.stringify(st.look)).then(() => { copyMsg.textContent = 'copied'; }, (e: unknown) => { copyMsg.textContent = errText(e); }); } }, 'Copy parameters'),
        h('button', { onclick: () => { setLook(RM.randomLook(st.seed), true); } }, 'Reset to seed'),
        copyMsg));
    stats.textContent = statText();
  }

  // otáčanie ťahaním
  let drag: { x: number; yaw: number } | null = null;
  view.addEventListener('pointerdown', e => { if (e.target !== renderer.domElement) return; drag = { x: e.clientX, yaw: st.yaw }; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', e => { if (drag) st.yaw = drag.yaw + (e.clientX - drag.x) * 0.01; });
  view.addEventListener('pointerup', () => { if (drag) { drag = null; save(); } });

  // ---------- kreslenie ----------
  const t0 = performance.now(), v3 = new THREE.Vector3();
  let raf = 0, dist = 0, last = t0;
  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const w = view.clientWidth, hh = view.clientHeight;
    if (w < 10 || hh < 10) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const t = (now - t0) / 1000;
    const pr = renderer.getPixelRatio();
    if (renderer.domElement.width !== Math.round(w * pr) || renderer.domElement.height !== Math.round(hh * pr)) renderer.setSize(w, hh, false);
    // kamera: izometrická ako v hre, otočená o yaw
    const single = st.mode === 'generator' || (st.mode === 'presets' && !!st.one);
    const span = st.mode === 'crowd' ? 5.4 : single ? 1.5 : 4.4, asp = w / hh;
    const vw = Math.max(span, (st.mode === 'crowd' ? 3.6 : single ? 1.15 : 1.6) * asp) / 2 / st.zoom, vh = vw / asp;
    Object.assign(cam, { left: -vw, right: vw, top: vh, bottom: -vh }); cam.updateProjectionMatrix();
    const cy = st.mode === 'crowd' ? 0.1 : st.zoom > 1 ? 0.25 : 0.38;
    cam.position.set(Math.sin(st.yaw) * Math.cos(PITCH) * 20, Math.sin(PITCH) * 20 + cy, Math.cos(st.yaw) * Math.cos(PITCH) * 20); cam.lookAt(0, cy, 0);
    const walking = st.anim === 'walk' || st.anim === 'crawl';
    dist += dt * (walking ? (st.anim === 'crawl' ? 15 : 30) : 0); // fáza kroku: ~10 za políčko, 3 políčka/s
    for (const l of lampLights) l.intensity = 0;
    for (const [i, o] of robots.entries()) {
      const jump = st.anim === 'jump' ? Math.max(0, Math.sin(t * 3 + i)) * 0.35 : 0;
      o.r.group.position.set(o.x, 0, o.z);
      // „use tool“: vlastný pohyb náradia v ruke (motyka okopáva, krompáč seká, krhla polieva, lampáš svieti), bez náradia hrabe klepetom
      const use = st.anim === 'use tool' && st.held && !o.r.switching() ? { tool: st.held, t: t + i * 0.37 } : null;
      o.r.pose({ phase: dist + i, t: t + i * 1.7, walking, crawl: st.anim === 'crawl', dance: st.anim === 'dance', dig: st.anim === 'dig' || (st.anim === 'use tool' && !st.held) ? t : 0, use, jz: jump }, dt);
      const ll = lampLights[i];
      if (ll && st.night && st.held === 'lamp') { o.r.mountWorld('handR', ll.position); ll.intensity = 1.6; }
      // menovka semienka nad hlavou robota v dave
      if (o.tag) {
        v3.set(o.x, o.r.model.height + 0.08, o.z).project(cam);
        o.tag.style.left = ((v3.x + 1) / 2 * w) + 'px'; o.tag.style.top = ((1 - v3.y) / 2 * hh) + 'px';
      }
    }
    renderer.render(scene, cam);
  }
  light(); rebuild();
  raf = requestAnimationFrame(frame);
  return {
    unmount: () => { cancelAnimationFrame(raf); for (const o of robots) o.r.dispose(); for (const l of lampLights) l.dispose(); renderer.dispose(); style.remove(); }
  };
}
