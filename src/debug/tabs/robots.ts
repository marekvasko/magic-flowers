// Záložka Robots v /debug (#194): návrh hráča ako 3D robota – všetky štýly vedľa seba, farby a doplnky, náradie
// v ruke a na chrbte, animácie (chôdza, plazenie, tanec, hrabanie, skok), deň a noc. „Crowd“ ukáže dav náhodných
// robotov, ako by vyzerali iní hráči. Kamera ako v hre (izometrická), ťahaním sa otáča. Texty po anglicky (nástroj
// pre správcu), mená štýlov a doplnkov sú po slovensky ako v hre.
import * as THREE from 'three';
import * as RM from '../../shared/robotmodel.ts';
import type { Accessory, RobotLook, RobotStyle } from '../../shared/robotmodel.ts';
import type { ToolId } from '../../shared/data.ts';
import { buildRobot } from '../../client/robot3d.ts';
import type { Robot3D } from '../../client/robot3d.ts';
import { keys, must } from '../../shared/util.ts';
import type { TabCtx, TabInstance } from '../ui.ts';

const CSS = `
.rb { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.rb-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.rb-bar label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; }
.rb-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.rb-seg button { border: none; border-radius: 0; padding: 3px 9px; }
.rb-seg button.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.rb-view { position: relative; flex: 1; min-height: 360px; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); cursor: grab; touch-action: none; }
.rb-view canvas { display: block; width: 100%; height: 100%; }
.rb-names { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; justify-content: space-around; pointer-events: none; }
.rb-names div { background: rgba(0,0,0,.45); color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.rb-info { font-size: 12.5px; }
.rb input[type=color] { width: 32px; height: 22px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: none; }
`;
const ANIMS = ['idle', 'walk', 'crawl', 'dance', 'dig', 'jump'] as const;
const TOOLS: readonly ToolId[] = ['hoe', 'can', 'pick', 'lamp'];
const TOOL_NAME: Readonly<Record<ToolId, string>> = { hoe: 'Motyka', can: 'Krhla', pick: 'Krompáč', lamp: 'Lampáš' };
const ACCS = keys(RM.ACCESSORIES);
const PITCH = Math.atan(1 / Math.SQRT2); // sklon kamery ako v hre

function seg(labels: readonly string[], value: number, onPick: (i: number) => void): HTMLElement {
  const d = document.createElement('div'); d.className = 'rb-seg';
  labels.forEach((l, i) => { const b = document.createElement('button'); b.textContent = l; if (i === value) b.className = 'on'; b.onclick = () => { onPick(i); }; d.appendChild(b); });
  return d;
}

export function mount(el: HTMLElement, ctx: TabCtx): TabInstance {
  const { h } = ctx;
  const style = h('style', null, CSS); document.head.appendChild(style);
  const p = (k: string): string | null => ctx.param(k);
  const st = {
    view: p('rv') === 'crowd' ? 'crowd' as const : 'styles' as const,
    anim: ANIMS.find(a => a === p('ra')) ?? 'walk',
    held: TOOLS.find(t => t === p('rh')) ?? null,
    carried: new Set<ToolId>((p('rc') ?? 'hoe,can,pick').split(',').flatMap(t => TOOLS.filter(x => x === t))),
    night: p('rn') === '1',
    // jeden spoločný vzhľad (farby, doplnok) pre všetky štýly, alebo predvolený vzhľad každého štýlu
    own: p('ro') === '1',
    look: RM.robotLook({ ...RM.STYLES.hrdzavec.look, paint: p('rp'), accent: p('rx'), eye: p('re'), wear: p('rw') != null ? Number(p('rw')) : undefined, acc: p('rq') }),
    yaw: Number(p('ry') ?? '0.35') || 0,
    one: RM.STYLE_IDS.find(x => x === p('rf')) ?? null // jeden štýl zblízka
  };
  const save = (): void => {
    ctx.setParam('rv', st.view === 'crowd' ? 'crowd' : null); ctx.setParam('ra', st.anim); ctx.setParam('rh', st.held);
    ctx.setParam('rc', [...st.carried].join(',')); ctx.setParam('rn', st.night ? 1 : null); ctx.setParam('ro', st.own ? 1 : null);
    ctx.setParam('rp', st.look.paint); ctx.setParam('rx', st.look.accent); ctx.setParam('re', st.look.eye); ctx.setParam('rw', st.look.wear); ctx.setParam('rq', st.look.acc);
    ctx.setParam('ry', st.yaw.toFixed(2)); ctx.setParam('rf', st.one);
  };

  const bar = h('div', { class: 'rb-bar' }), bar2 = h('div', { class: 'rb-bar' });
  const view = h('div', { class: 'rb-view' }), names = h('div', { class: 'rb-names' });
  const info = h('div', { class: 'rb-info muted' },
    'Design prototype for ', h('a', { href: 'https://github.com/marekvasko/magic-flowers/issues/194', target: '_blank' }, '#194'),
    ': smooth 3D robots instead of the 2D character. Drag to rotate. The selected tool is in the right gripper, the other owned tools ride on the back rack. 1 grid square = 1 tile.');
  el.replaceChildren(h('div', { class: 'rb' }, bar, bar2, view, info));

  // ---------- scéna ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  view.append(renderer.domElement, names);
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x5a6b3a, 1.3); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 20 });
  sun.shadow.bias = -0.0005; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const lampLights = [0, 1, 2, 3].map(() => { const l = new THREE.PointLight(0xffb04a, 0, 2.5, 1.6); scene.add(l); return l; });
  // zem: tráva s mriežkou políčok a prekopané záhony pod robotmi
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x7c9a52, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(14, 14, 0x5d7a3c, 0x5d7a3c); grid.position.y = 0.002;
  const gm = grid.material; if (gm instanceof THREE.Material) { gm.transparent = true; gm.opacity = 0.35; }
  scene.add(grid);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);

  let robots: { r: Robot3D; x: number; z: number; circle?: { r: number; w: number; a0: number } }[] = [];
  function lookFor(s: RobotStyle): RobotLook { return st.own ? { ...st.look, style: s } : RM.STYLES[s].look; }
  function rebuild(): void {
    for (const o of robots) o.r.dispose();
    robots = [];
    if (st.view === 'styles') {
      const ids = st.one ? [st.one] : RM.STYLE_IDS;
      ids.forEach((s, i) => robots.push({ r: buildRobot(lookFor(s)), x: (i - (ids.length - 1) / 2) * 1.0, z: 0 }));
      names.replaceChildren(...ids.map(s => h('div', null, RM.STYLES[s].name)));
    } else {
      for (let i = 0; i < 12; i++) {
        const look = RM.randomLook(RM.hashStr('hráč ' + i));
        robots.push({ r: buildRobot(look), x: 0, z: 0, circle: { r: 1.1 + (i % 3) * 0.9, w: (i % 2 ? 1 : -1) * (0.35 + (i % 4) * 0.08), a0: i * 2.1 } });
      }
      names.replaceChildren();
    }
    robots.forEach((o, i) => {
      const held = st.view === 'crowd' ? TOOLS[i % 5] ?? null : st.held;
      o.r.setTools(held, st.view === 'crowd' ? TOOLS.filter((_, k) => (i >> k) & 1) : [...st.carried]);
      scene.add(o.r.group);
    });
    renderBar();
  }
  function light(): void {
    const n = st.night;
    hemi.intensity = n ? 0.25 : 1.3; hemi.color.set(n ? 0x5565a0 : 0xdfefff);
    sun.intensity = n ? 0.15 : 2.2; sun.color.set(n ? 0x8090ff : 0xfff2dc);
    scene.background = new THREE.Color(n ? 0x0d1224 : 0xa9d4ee);
  }

  // ---------- ovládanie ----------
  function renderBar(): void {
    const colorIn = (v: string, set: (c: string) => void): HTMLInputElement => {
      const i = document.createElement('input'); i.type = 'color'; i.value = v; i.disabled = !st.own;
      i.oninput = () => { set(i.value); save(); rebuild(); };
      return i;
    };
    const wear = document.createElement('input'); wear.type = 'range'; wear.min = '0'; wear.max = '1'; wear.step = '0.05'; wear.value = String(st.look.wear); wear.disabled = !st.own;
    wear.onchange = () => { st.look = { ...st.look, wear: Number(wear.value) }; save(); rebuild(); };
    const own = document.createElement('input'); own.type = 'checkbox'; own.checked = st.own;
    own.onchange = () => { st.own = own.checked; save(); rebuild(); };
    bar.replaceChildren(...[
      seg(['Styles', 'Crowd (other players)'], st.view === 'crowd' ? 1 : 0, i => { st.view = i ? 'crowd' : 'styles'; save(); rebuild(); }),
      st.view === 'styles' ? seg(['All', ...RM.STYLE_IDS.map(x => RM.STYLES[x].name)], st.one ? RM.STYLE_IDS.indexOf(st.one) + 1 : 0, i => { st.one = RM.STYLE_IDS[i - 1] ?? null; save(); rebuild(); }) : null,
      seg(ANIMS, ANIMS.indexOf(st.anim), i => { st.anim = must(ANIMS[i]); save(); renderBar(); }),
      seg(['Day', 'Night'], st.night ? 1 : 0, i => { st.night = !!i; save(); light(); renderBar(); }),
      h('label', null, 'In hand', seg(['—', ...TOOLS.map(t => TOOL_NAME[t])], st.held ? TOOLS.indexOf(st.held) + 1 : 0, i => { st.held = TOOLS[i - 1] ?? null; save(); rebuild(); })),
      h('label', null, 'On back', ...TOOLS.map(t => {
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = st.carried.has(t);
        c.onchange = () => { if (c.checked) st.carried.add(t); else st.carried.delete(t); save(); rebuild(); };
        return h('label', null, c, TOOL_NAME[t]);
      }))].filter(x => x !== null));
    bar2.replaceChildren(
      h('label', null, own, 'Custom look for all styles'),
      h('label', null, 'Paint', colorIn(st.look.paint, c => { st.look = { ...st.look, paint: c }; })),
      h('label', null, 'Accent', colorIn(st.look.accent, c => { st.look = { ...st.look, accent: c }; })),
      h('label', null, 'Eyes', colorIn(st.look.eye, c => { st.look = { ...st.look, eye: c }; })),
      h('label', null, 'Rust', wear),
      h('label', null, 'Accessory', seg(ACCS.map(a => RM.ACCESSORIES[a]), ACCS.indexOf(st.look.acc), i => { if (!st.own) { st.own = true; } st.look = { ...st.look, acc: must<Accessory>(ACCS[i]) }; save(); rebuild(); })),
      h('button', { onclick: () => { const r = RM.randomLook(Math.floor(Math.random() * 1e9)); st.look = { ...r, style: 'hrdzavec' }; st.own = true; save(); rebuild(); } }, '🎲 Random'));
  }

  // otáčanie ťahaním
  let drag: { x: number; yaw: number } | null = null;
  view.addEventListener('pointerdown', e => { drag = { x: e.clientX, yaw: st.yaw }; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', e => { if (drag) st.yaw = drag.yaw + (e.clientX - drag.x) * 0.01; });
  view.addEventListener('pointerup', () => { drag = null; save(); });

  // ---------- kreslenie ----------
  const t0 = performance.now();
  let raf = 0, dist = 0, last = t0;
  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const w = view.clientWidth, hh = view.clientHeight;
    if (w < 10 || hh < 10) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const t = (now - t0) / 1000;
    if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) renderer.setSize(w, hh, false);
    // kamera: izometrická ako v hre, otočená o yaw; v pohľade so štýlmi pribl. 4,4 políčka na šírku
    const span = st.view === 'crowd' ? 7.5 : st.one ? 1.4 : 4.4, asp = w / hh;
    const vw = Math.max(span, (st.one ? 1.1 : 1.6) * asp) / 2, vh = vw / asp;
    Object.assign(cam, { left: -vw, right: vw, top: vh, bottom: -vh }); cam.updateProjectionMatrix();
    const cy = st.view === 'styles' ? (st.one ? 0.35 : 0.4) : 0;
    cam.position.set(Math.sin(st.yaw) * Math.cos(PITCH) * 20, Math.sin(PITCH) * 20 + cy, Math.cos(st.yaw) * Math.cos(PITCH) * 20); cam.lookAt(0, cy, 0);
    const walking = st.anim === 'walk' || st.anim === 'crawl' || st.view === 'crowd';
    dist += dt * (walking ? (st.anim === 'crawl' ? 1.5 : 3) : 0) / 0.09 * 0.09 * 10; // fáza kroku: ~10 za políčko
    for (const l of lampLights) l.intensity = 0;
    for (const [i, o] of robots.entries()) {
      const jump = st.anim === 'jump' ? Math.max(0, Math.sin(t * 3 + i)) * 0.35 : 0;
      const opts = { phase: dist + i, t: t + i * 1.7, walking, crawl: st.anim === 'crawl', dance: st.anim === 'dance', dig: st.anim === 'dig' ? t : 0, jz: jump };
      if (o.circle) {
        const a = o.circle.a0 + t * o.circle.w, c = o.circle;
        o.r.group.position.set(Math.cos(a) * c.r, 0, Math.sin(a) * c.r);
        // smer pohybu po kružnici (dotyčnica)
        const dir = Math.atan2(Math.cos(a) * Math.sign(c.w), -Math.sin(a) * Math.sign(c.w));
        o.r.group.rotation.y = RM.yawOf(dir);
        o.r.pose({ ...opts, crawl: false, dance: false, dig: 0, jz: 0, walking: true });
      } else {
        o.r.group.position.set(o.x, 0, o.z);
        o.r.group.rotation.y = 0;
        o.r.pose(opts);
      }
      const ll = lampLights[i];
      if (ll && st.night && st.view === 'styles' && st.held === 'lamp') { o.r.mountWorld('handR', ll.position); ll.intensity = 1.6; }
    }
    renderer.render(scene, cam);
  }
  light(); rebuild();
  raf = requestAnimationFrame(frame);
  return {
    unmount: () => { cancelAnimationFrame(raf); for (const o of robots) o.r.dispose(); renderer.dispose(); style.remove(); }
  };
}
