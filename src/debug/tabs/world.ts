// Ladiaca stránka /debug, záložka World (#78): celý svet vykreslený herným 3D kódom (render3d.ts) bez hráča –
// voľná kamera, čas dňa a obdobie nezávislé od hodín sveta, vrstvy a ladiace pomôcky (obaly modelov, mriežka,
// miesta ťuknutia, prechody, svetlá, drôtený model, kamera tieňov). Údaje len číta cez /api/debug/world.
// Texty sú po anglicky (nástroj pre správcu); mená hráčov idú do stránky len cez textContent.
import * as THREE from 'three';
import { create as createRender3D } from '../../client/render3d.ts';
import type { DebugView, Render3D } from '../../client/render3d.ts';
import type { ViewOther, ViewState } from '../../client/state.ts';
import * as World3D from '../../shared/world3d.ts';
import type { AreaId, Gate, Ground } from '../../shared/data.ts';
import type { Weather } from '../../shared/save.ts';
import type { WorldPlayer, WorldView } from '../../server/debug-api/world.ts';
import { lookup, must } from '../../shared/util.ts';
import type { TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';

type Layer = 'terrain' | 'buildings' | 'trees' | 'rocks' | 'plants' | 'chars' | 'water' | 'glacier' | 'particles' | 'shadows' | 'lights';
type Helper = 'boxes' | 'grid' | 'tap' | 'gates' | 'lights' | 'wire' | 'frustum';
// online hráč ako postavička: k pohľadu (ViewOther) cieľ pohybu medzi obnoveniami
type Walker = ViewOther & { id: string; tx: number; ty: number };
interface Pt { x: number; y: number }

const PITCH0 = Math.atan(1 / Math.SQRT2); // herný sklon kamery (izometria)
const LAYERS: readonly (readonly [Layer, string])[] = [
  ['terrain', 'Terrain'], ['buildings', 'Buildings'], ['trees', 'Trees & bushes'], ['rocks', 'Rocks'], ['plants', 'Plants'],
  ['chars', 'Characters'], ['water', 'Water'], ['glacier', 'Glacier'], ['particles', 'Particles'], ['shadows', 'Shadows'], ['lights', 'Lamp lights']
];
const HELPERS: readonly (readonly [Helper, string])[] = [
  ['boxes', 'Bounding boxes'], ['grid', 'Tile grid'], ['tap', 'Tap areas'], ['gates', 'Gates, arrivals'],
  ['lights', 'Lights & sun'], ['wire', 'Wireframe'], ['frustum', 'Shadow camera']
];
const BOX_COL: Readonly<Record<string, number>> & { sprite: number; other: number } = { tree: 0x3fbf4a, bush: 0x9be05a, rock: 0xa0a0a0, sprite: 0xff6fb5, other: 0xff9a2e };

const CSS = `
.wv { position: relative; height: 100%; min-height: 360px; overflow: hidden; background: #000; }
.wv canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.wv canvas.ov { touch-action: none; cursor: grab; }
.wv canvas.ov.drag { cursor: grabbing; }
.wv-panel { position: absolute; top: 8px; right: 8px; width: 280px; max-height: calc(100% - 16px); overflow-y: auto; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px; font-size: 12.5px; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
.wv-panel.closed { width: auto; }
.wv-panel.closed .wv-body { display: none; }
.wv-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-weight: 600; cursor: pointer; user-select: none; }
.wv-head span { flex: 1; }
.wv-body { padding: 0 8px 8px; }
.wv-body h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.wv-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 4px; }
.wv-row button { padding: 2px 7px; font-size: 12px; }
.wv-row button.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.wv-row input[type=number] { width: 92px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; }
.wv-row input[type=range] { flex: 1; min-width: 120px; }
.wv-row select { max-width: 100%; }
.wv-row .val { font-family: var(--mono); min-width: 40px; text-align: right; }
.wv-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 6px; }
.wv-checks label { display: flex; gap: 4px; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wv-stats { position: absolute; left: 8px; bottom: 8px; right: 8px; pointer-events: none; font: 11.5px/1.35 var(--mono); color: #fff; text-shadow: 0 1px 2px #000, 0 0 4px #000; white-space: pre-wrap; }
.wv-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 14px; pointer-events: none; text-shadow: 0 1px 3px #000; }
.wv-hint { color: var(--muted); font-size: 11.5px; margin-top: 6px; }
@media (max-width: 700px) { .wv-panel { width: 240px; } }
`;

// Herné moduly (3D pohľad, Three.js, svet z kociek…) sú v balíku ladiacej stránky (#137) – záložka World je jeho kúsok

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  let ctx = ctx0;
  const { h, D } = ctx;
  const SEASON_EN = ctx.fmt.SEASON_EN;
  let alive = true, raf = 0, r3: Render3D | null = null;
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, ev: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions): void => { t.addEventListener(ev, fn, o); cleanups.push(() => { t.removeEventListener(ev, fn, o); }); };
  const onWin = (ev: 'keydown', fn: (e: KeyboardEvent) => void): void => { window.addEventListener(ev, fn); cleanups.push(() => { window.removeEventListener(ev, fn); }); };

  if (!document.getElementById('tab-world-css')) document.head.appendChild(h('style', { id: 'tab-world-css' }, CSS));
  const oldPad = el.style.padding, oldOverflow = el.style.overflow;
  el.style.padding = '0'; el.style.overflow = 'hidden'; // pohľad cez celú plochu záložky
  const oldNoFade = window.MF_NOFADE ?? false;
  window.MF_NOFADE = true; // bez hráča nie je čo odkrývať

  // ---------- nastavenia (časť v adrese, nech sa dá pohľad poslať) ----------
  const listParam = (k: string): Set<string> => new Set((ctx.param(k) || '').split(',').filter(Boolean));
  const offLayers = listParam('wl'), onHelpers = listParam('wh');
  const L = Object.fromEntries(LAYERS.map(([k]) => [k, !offLayers.has(k)])) as Record<Layer, boolean>; // každá vrstva z LAYERS
  const H = Object.fromEntries(HELPERS.map(([k]) => [k, onHelpers.has(k)])) as Record<Helper, boolean>; // každá pomôcka z HELPERS
  const wse = ctx.param('wse'), wwx = ctx.param('wwx');
  const P: { src: 'seed' | 'room'; seed: number; clock: boolean; min: number; play: boolean; season: number | 'room'; weather: Weather | 'room'; follow: string; drag: string } = {
    src: ctx.param('wsrc') === 'seed' || !ctx.room ? 'seed' : 'room',
    seed: (parseInt(ctx.param('wseed') ?? '', 10) || 12345) >>> 0,
    clock: ctx.param('wmin') == null, min: +(ctx.param('wmin') ?? 0) || 600, play: false,
    season: wse == null ? 'room' : +wse,
    weather: wwx === 'sun' || wwx === 'rain' || wwx === 'snow' ? wwx : 'room', follow: '', drag: 'rotate'
  };
  const saveParams = (): void => {
    ctx.setParam('wl', LAYERS.filter(([k]) => !L[k]).map(([k]) => k).join(','));
    ctx.setParam('wh', HELPERS.filter(([k]) => H[k]).map(([k]) => k).join(','));
    ctx.setParam('wsrc', P.src === 'seed' ? 'seed' : null);
    ctx.setParam('wseed', P.src === 'seed' ? P.seed : null);
    ctx.setParam('wmin', P.clock ? null : Math.round(P.min));
    ctx.setParam('wse', P.season === 'room' ? null : P.season);
    ctx.setParam('wwx', P.weather === 'room' ? null : P.weather);
  };

  // ---------- stav sveta pre render3d (rovnaké polia ako S v game.js) ----------
  const others = new Map<string, Walker>();
  const S: Omit<ViewState, 'others'> & { others: Map<string, Walker> } = {
    W: D.W, H: D.H, tiles: [], area: 'garden', tilesGen: 0, worldGen: 0, tick: 0, day: 1, weather: 'sun',
    me: { x: D.W / 2, y: D.H / 2, dir: 0, phase: 0, moving: false, jz: 0, jv: 0, crawl: false }, look: null, name: '', id: -1, myEmote: null, mySi: -1, sel: '',
    others, anchors: {}, fx: [], screenFx: [], bubbles: {}, tapMark: null, kbd: false,
    // pavúky (#57, #99): render3d ich kreslí vždy, tu zatiaľ prázdne (pavučiny ani pavúky sa sem nenačítavajú)
    webs: [], homes: [], websGen: 0, corner: [], cornerGen: 0, spiders: new Map()
  };
  let world: WorldView | null = null, worldKey = '', tilesSig = '', loadSeq = 0, offline: WorldPlayer[] = [], panelSig = '';

  // ---------- DOM ----------
  const gl = h('canvas', { class: 'gl' }), ov = h('canvas', { class: 'ov' });
  const stats = h('div', { class: 'wv-stats' }), msg = h('div', { class: 'wv-msg' }, 'Loading 3D…');
  const panel = h('div', { class: 'wv-panel' + (innerWidth < 700 ? ' closed' : '') });
  const wrap = h('div', { class: 'wv' }, gl, ov, msg, stats, panel);
  el.replaceChildren(wrap);
  const ovCtx = must(ov.getContext('2d') ?? undefined);

  const btn = (label: string, fn: () => void, title?: string | null, isOn?: boolean): HTMLElement => h('button', { title, class: isOn ? 'on' : null, onclick: fn }, label);
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const i = h('input', { type: 'checkbox' }); i.checked = get();
    i.onchange = () => { set(i.checked); };
    return h('label', null, i, label);
  };
  function renderPanel(): void {
    const sel = (opts: readonly (readonly [string | number, string])[], value: string | number, fn: (v: string) => void): HTMLElement => {
      const s = h('select', null, opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) ? 'selected' : null }, t)));
      s.onchange = () => { fn(s.value); };
      return s;
    };
    const seedIn = h('input', { type: 'number', min: 0, value: P.seed, title: 'Seed of the generated areas (Les na pomedzí, Les divov)' });
    seedIn.onchange = () => { P.seed = (parseInt(seedIn.value, 10) || 0) >>> 0; saveParams(); void loadWorld(true); };
    const timeLbl = h('span', { class: 'val' }, ctx.fmt.hhmm(Math.floor(curMin())));
    const range = h('input', { type: 'range', min: 0, max: 1439, step: 5, value: Math.round(curMin()) });
    range.oninput = () => { P.clock = false; P.min = +range.value; timeLbl.textContent = ctx.fmt.hhmm(P.min); saveParams(); syncTimeUi(); };
    timeUi = { range, timeLbl };
    const online = [...S.others.values()];
    const body = h('div', { class: 'wv-body' },
      h('h4', null, 'World'),
      h('div', { class: 'wv-row' },
        btn('Room', () => { if (!ctx.room) return; P.src = 'room'; saveParams(); void loadWorld(true); renderPanel(); }, ctx.room ? `Room ${ctx.room}` : 'No room selected', P.src === 'room'),
        btn('Seed', () => { P.src = 'seed'; saveParams(); void loadWorld(true); renderPanel(); }, 'A fresh world from a seed, no saved state', P.src === 'seed'),
        P.src === 'seed' ? seedIn : h('span', { class: 'muted' }, ctx.room || '–'),
        P.src === 'seed' ? btn('🎲', () => { P.seed = (Math.random() * 2 ** 32) >>> 0; saveParams(); void loadWorld(true); renderPanel(); }, 'Random seed') : null),
      h('div', { class: 'wv-row' }, D.AREAS.map(a => btn(D.AREA_NAMES[a] || a, () => { ctx.setArea(a); }, null, a === ctx.area))),
      h('h4', null, 'Camera'),
      h('div', { class: 'wv-row' },
        btn('Reset', () => { resetCam(); }, 'Whole area, game angle (R)'),
        btn('⟲', () => { cam.yaw -= Math.PI / 2; }, 'Rotate 90° (Q)'), btn('⟳', () => { cam.yaw += Math.PI / 2; }, 'Rotate 90° (E)'),
        btn('Top', () => { cam.pitch = 1.55; }, 'Top-down view'), btn('Iso', () => { cam.pitch = PITCH0; }, 'Game pitch'),
        btn('Game', () => { cam.zoom = D.viewSize(gl.clientWidth || 1, gl.clientHeight || 1).h; cam.pitch = PITCH0; }, 'Game zoom (what a player sees)')),
      h('div', { class: 'wv-row' }, 'Follow',
        sel([['', online.length ? '– nobody –' : '– nobody online here –'], ...online.map(o => [o.id, o.name] as const)], P.follow, v => { P.follow = v; })),
      h('div', { class: 'wv-row' }, '1 finger / left drag',
        sel([['rotate', 'rotates'], ['pan', 'pans']], P.drag, v => { P.drag = v; })),
      h('h4', null, 'Time'),
      h('div', { class: 'wv-row' }, range, timeLbl),
      h('div', { class: 'wv-row' },
        check('room clock', () => P.clock, v => { P.clock = v; saveParams(); syncTimeUi(); }),
        btn(P.play ? '⏸' : '▶', () => { P.play = !P.play; if (P.play) { P.min = curMin(); P.clock = false; } saveParams(); renderPanel(); }, 'Play time: 1 game hour per second')),
      h('div', { class: 'wv-row' }, 'Season',
        sel([['room', 'Room'], ...SEASON_EN.map((s, i) => [i, s] as const)], P.season, v => { P.season = v === 'room' ? 'room' : +v; saveParams(); }),
        'Weather', sel([['room', 'Room'], ['sun', 'Sun'], ['rain', 'Rain'], ['snow', 'Snow']], P.weather, v => { P.weather = v === 'sun' || v === 'rain' || v === 'snow' ? v : 'room'; saveParams(); })),
      h('h4', null, 'Layers'),
      h('div', { class: 'wv-checks' }, LAYERS.map(([k, t]) => check(t, () => L[k], v => { L[k] = v; saveParams(); layersChanged(); }))),
      h('h4', null, 'Debug helpers'),
      h('div', { class: 'wv-checks' }, HELPERS.map(([k, t]) => check(t, () => H[k], v => { H[k] = v; saveParams(); helpersDirty = true; }))),
      h('div', { class: 'wv-hint' }, 'Drag: rotate · right/shift-drag or two fingers: pan · wheel/pinch: zoom · two-finger twist: rotate · double-click: center on tile · keys: WASD/arrows, Q/E, +/−, R'));
    const head = h('div', { class: 'wv-head', onclick: () => { panel.classList.toggle('closed'); } }, h('span', null, '⚙ View'), h('small', { class: 'muted' }, '▾'));
    panel.replaceChildren(head, body);
  }
  let timeUi: { range: HTMLInputElement; timeLbl: HTMLElement } | null = null;
  function syncTimeUi(): void {
    if (!timeUi) return;
    const m = Math.floor(curMin());
    if (document.activeElement !== timeUi.range) timeUi.range.value = String(m);
    timeUi.timeLbl.textContent = ctx.fmt.hhmm(m) + (P.clock ? ' ⏱' : '');
  }

  // ---------- čas, obdobie, počasie (nezávislé od hodín sveta) ----------
  function roomMin(): number { return D.minOfTick(S.tick); }
  // svet len zo semienka nemá hodiny: „room“ tam znamená 10:00 v lete
  const hasClock = (): boolean => !!(world && world.room);
  function curMin(): number { return P.clock && hasClock() ? roomMin() : P.clock ? 600 : ((P.min % 1440) + 1440) % 1440; }
  function season(): number { return P.season !== 'room' ? P.season : hasClock() ? D.seasonOf(D.dayOfTick(S.tick)) : 1; }

  // ---------- kamera ----------
  let camFromHash = false; // kamera z adresy platí pri prvom načítaní, potom sa pri zmene plochy vráti na celú plochu
  const cam = { x: D.W / 2, z: D.H / 2, y: 1, yaw: Math.PI / 4, pitch: PITCH0, zoom: 30, reset: false };
  function resetCam(): void {
    cam.x = S.W / 2; cam.z = S.H / 2; cam.yaw = Math.PI / 4; cam.pitch = PITCH0;
    cam.zoom = Math.max(S.W, S.H) * 1.15 * Math.max(1, (gl.clientHeight || 1) / (gl.clientWidth || 1));
    P.follow = '';
  }
  (function loadCam() {
    const c = (ctx.param('wcam') || '').split(',').map(Number);
    const [x, z, yaw, pitch, zoom] = c;
    if (c.length === 5 && x != null && z != null && yaw != null && pitch != null && zoom != null && c.every(Number.isFinite)) { Object.assign(cam, { x, z, yaw, pitch, zoom }); camFromHash = true; }
  })();
  let camSaved = '', camSaveAt = 0;
  function saveCam(now: number): void {
    if (now - camSaveAt < 500) return;
    camSaveAt = now;
    const s = [cam.x, cam.z, cam.yaw, cam.pitch, cam.zoom].map(v => +v.toFixed(2)).join(',');
    if (s !== camSaved) { camSaved = s; ctx.setParam('wcam', s); }
  }
  function placeCamera(camera: THREE.OrthographicCamera, target: THREE.Vector3, dt: number): void {
    if (P.follow) {
      const o = S.others.get(P.follow);
      if (o) { const k = Math.min(1, dt * 6); cam.x += (o.x - cam.x) * k; cam.z += (o.y - cam.z) * k; }
    }
    cam.x = Math.max(-5, Math.min(S.W + 5, cam.x)); cam.z = Math.max(-5, Math.min(S.H + 5, cam.z));
    const v = must(r3 ?? undefined).debugView(), gy = v.grid ? v.groundY(cam.x, cam.z) : 1;
    cam.y += (gy - cam.y) * Math.min(1, dt * 6);
    target.set(cam.x, cam.y, cam.z);
    const dist = 100, cp = Math.cos(cam.pitch);
    camera.position.set(cam.x + Math.sin(cam.yaw) * cp * dist, cam.y + Math.sin(cam.pitch) * dist, cam.z + Math.cos(cam.yaw) * cp * dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const aspect = (gl.clientWidth || 1) / (gl.clientHeight || 1), hh = cam.zoom / 2;
    camera.top = hh; camera.bottom = -hh; camera.left = -hh * aspect; camera.right = hh * aspect;
    camera.updateProjectionMatrix();
  }
  // posun po zemi o (dx, dy) CSS px – svet ide s prstom
  function pan(dx: number, dy: number): void {
    const u = cam.zoom / (gl.clientHeight || 1), sy = Math.max(0.25, Math.sin(cam.pitch));
    const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw), fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    cam.x += -rx * dx * u + fx * dy * u / sy;
    cam.z += -rz * dx * u + fz * dy * u / sy;
    P.follow = '';
  }
  function orbit(dx: number, dy: number): void {
    cam.yaw -= dx * 0.008;
    cam.pitch = Math.max(0.06, Math.min(1.55, cam.pitch + dy * 0.006));
  }
  const zoomBy = (k: number): void => { cam.zoom = Math.max(3, Math.min(150, cam.zoom * k)); };

  // ---------- myš a dotyk ----------
  const ptrs = new Map<number, { x: number; y: number; btn: number; shift: boolean; type: string }>();
  let gesture: { mx: number; my: number; d: number; ang: number } | null = null, moved = 0, hover: Pt | null = null, hoverAt = 0, lastHoverXY: [number, number] | null = null;
  const ptrList = (): { x: number; y: number }[] => [...ptrs.values()];
  function twoInfo(): { mx: number; my: number; d: number; ang: number } {
    const [a = { x: 0, y: 0 }, b = { x: 0, y: 0 }] = ptrList();
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  on(ov, 'pointerdown', e => {
    try { ov.setPointerCapture(e.pointerId); } catch { /* syntetická udalosť */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey, type: e.pointerType });
    moved = 0; gesture = ptrs.size === 2 ? twoInfo() : null;
    ov.classList.add('drag');
  });
  on(ov, 'pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) { lastHoverXY = [e.clientX, e.clientY]; return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (ptrs.size === 1) {
      const panMode = p.btn === 1 || p.btn === 2 || p.shift || (P.drag === 'pan' && p.btn === 0);
      if (panMode) pan(dx, dy); else orbit(dx, dy);
    } else if (ptrs.size === 2 && gesture) {
      const g = twoInfo();
      pan(g.mx - gesture.mx, g.my - gesture.my);
      zoomBy(gesture.d / g.d);
      cam.yaw -= g.ang - gesture.ang;
      gesture = g;
    }
  });
  const up = (e: PointerEvent): void => {
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    gesture = ptrs.size === 2 ? twoInfo() : null;
    if (!ptrs.size) ov.classList.remove('drag');
    if (p && moved < 6 && e.type === 'pointerup') { lastHoverXY = [e.clientX, e.clientY]; hoverAt = 0; } // ťuknutie = ukáž políčko
  };
  on(ov, 'pointerup', up); on(ov, 'pointercancel', up);
  on(ov, 'pointerleave', () => { if (!ptrs.size) { lastHoverXY = null; hover = null; } });
  on(ov, 'wheel', e => { e.preventDefault(); zoomBy(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))); }, { passive: false });
  on(ov, 'contextmenu', e => { e.preventDefault(); });
  on(ov, 'dblclick', e => {
    const t = r3 && r3.pick(e.clientX, e.clientY);
    if (t) { cam.x = t.x + 0.5; cam.z = t.y + 0.5; P.follow = ''; }
  });
  onWin('keydown', e => {
    if (!r3 || e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
    const k = e.key.toLowerCase(), step = 40;
    if (k === 'w' || k === 'arrowup') pan(0, step);
    else if (k === 's' || k === 'arrowdown') pan(0, -step);
    else if (k === 'a' || k === 'arrowleft') pan(step, 0);
    else if (k === 'd' || k === 'arrowright') pan(-step, 0);
    else if (k === 'q') cam.yaw -= Math.PI / 2;
    else if (k === 'e') cam.yaw += Math.PI / 2;
    else if (k === '+' || k === '=') zoomBy(1 / 1.2);
    else if (k === '-') zoomBy(1.2);
    else if (k === 'r') resetCam();
    else return;
    e.preventDefault();
  });

  // ---------- svet zo servera ----------
  async function loadWorld(force: boolean): Promise<void> {
    const src = P.src === 'room' && ctx.room ? 'room' : 'seed';
    const key = src === 'room' ? `room=${encodeURIComponent(ctx.room)}&area=${ctx.area}` : `seed=${P.seed}&area=${ctx.area}`;
    const changed = key !== worldKey, seq = ++loadSeq;
    if (changed || force) { if (!r3) msg.textContent = 'Loading world…'; }
    let w: WorldView | null;
    try { w = await ctx.api<WorldView | null>('/api/debug/world?' + key); }
    catch (e) { if (seq === loadSeq && alive) { msg.textContent = 'World: ' + errText(e); } return; }
    if (!w) return;
    if (!alive || seq !== loadSeq) return;
    world = w; worldKey = key;
    const sig = JSON.stringify(w.tiles);
    S.tick = w.tick; S.day = D.dayOfTick(w.tick); S.weather = w.weather;
    if (sig !== tilesSig || S.area !== w.area) {
      tilesSig = sig;
      S.area = w.area; S.W = w.w; S.H = w.h; S.tiles = w.tiles; S.tilesGen++;
      S.anchors = {};
      const ANCHORS: readonly Ground[] = ['hut', 'house', 'stall', 'well', 'cauldron', 'icehouse'];
      S.tiles.forEach((t, i) => { if (ANCHORS.includes(t.g) && !S.anchors[t.g]) S.anchors[t.g] = { x: i % S.W, y: (i / S.W) | 0 }; });
      helpersDirty = true;
    }
    syncPlayers(w.players);
    S.vehicles = w.vehicles; // fúrik a sane (#158): render3d ich nakreslí, spolujazdec v nich sedí
    if (changed) { if (camFromHash) camFromHash = false; else cam.reset = true; }
    if (!r3) start();
    if (cam.reset && r3) { cam.reset = false; resetCam(); }
    msg.textContent = '';
    // panel sa prekreslí len pri zmene (inak by sa pri obnovení zavrel otvorený výber)
    const ps = key + '|' + [...S.others.values()].map(o => o.id + ':' + o.name).join(',');
    if (ps !== panelSig) { panelSig = ps; renderPanel(); }
  }
  // online hráči sú postavičky (pohyb sa medzi obnoveniami plynulo dobehne), ostatní len značka na poslednom mieste
  function syncPlayers(list: readonly WorldPlayer[]): void {
    const seen = new Set<string>();
    offline = [];
    for (const p of list) {
      if (!p.online) { offline.push(p); continue; }
      seen.add(p.id);
      let o = S.others.get(p.id);
      if (!o) { o = { id: p.id, name: p.name || p.id, x: p.x, y: p.y, dir: 0, phase: 0, tx: p.x, ty: p.y, look: null, a: undefined, e: null, jz: 0, cr: false, lp: false, si: -1, wb: 0 }; S.others.set(p.id, o); }
      o.tx = p.x; o.ty = p.y; o.look = p.look; o.name = p.name || p.id;
    }
    for (const id of [...S.others.keys()]) if (!seen.has(id)) S.others.delete(id);
    if (P.follow && !S.others.has(P.follow)) P.follow = '';
  }
  function movePlayers(dt: number): void {
    for (const o of S.others.values()) {
      const dx = o.tx - o.x, dy = o.ty - o.y, d = Math.hypot(dx, dy);
      if (d > 6) { o.x = o.tx; o.y = o.ty; continue; } // skok (prechod, dlhá pauza)
      if (d < 0.01) { o.x = o.tx; o.y = o.ty; continue; }
      const s = Math.min(d, Math.max(2.5, d * 1.5) * dt);
      o.x += dx / d * s; o.y += dy / d * s; o.a = Math.atan2(dy, dx); o.phase += s * 3;
    }
  }

  // ---------- 3D ----------
  function start(): void {
    if (!alive || r3) return;
    try {
      r3 = createRender3D({
        S, glCanvas: gl, ov, ovCtx, EMOJI: {}, curMin, season,
        searching: o => !!o && o.si != null && o.si >= 0, ctxAction: () => null, frontTile: () => ({ x: -1, y: -1 }),
        placeCamera, noPlayer: true, layers: L, beforeRender
      });
    } catch (e) { msg.textContent = '3D: ' + errText(e); return; }
    r3.setStats(true);
    resize();
    raf = requestAnimationFrame(loop);
  }
  function resize(): void {
    if (!alive) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ov.width = Math.max(1, Math.round(ov.clientWidth * dpr)); ov.height = Math.max(1, Math.round(ov.clientHeight * dpr));
    if (r3) r3.resize();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // ---------- vrstvy ----------
  function applyLayers(v: DebugView): void {
    if (v.mesh) v.mesh.visible = L.terrain;
    v.fineMeshes.forEach((m, i) => {
      const t = v.grid?.fine[i]?.type;
      m.visible = t === 'tree' || t === 'bush' ? L.trees : t === 'rock' ? L.rocks : L.buildings;
    });
    for (const sp of v.plantSprites.values()) sp.visible = L.plants;
    for (const o of v.chars.values()) o.sp.visible = o.ghost.visible = o.shadow.visible = L.chars;
    if (v.waterMesh) v.waterMesh.visible = L.water;
    if (v.lilyMesh) v.lilyMesh.visible = L.water;
    if (v.glacierMesh) v.glacierMesh.visible = L.glacier;
    for (const o of v.particleObjs) o.visible = L.particles;
    for (const m of v.materials) m.wireframe = H.wire;
  }
  function layersChanged(): void { if (r3) { applyLayers(r3.debugView()); r3.invalidateShadows(); } }

  // ---------- ladiace pomôcky (vrstva 1: vidí ich len hlavná kamera, nie tiene ani zrkadlo vody) ----------
  let helpers: THREE.Group | null = null, dyn: THREE.Group | null = null, frustumHelper: THREE.CameraHelper | null = null, sunArrow: THREE.ArrowHelper | null = null,
    hoverBox: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null, helpersDirty = true, builtGrid: DebugView['grid'] | undefined, builtPlants = -1;
  const lightPool: { g: THREE.Group; ring: THREE.LineLoop; ring2: THREE.LineLoop }[] = [];
  function onLayer1<O extends THREE.Object3D>(o: O): O { o.traverse(c => { c.layers.set(1); }); return o; }
  function disposeGroup(g: THREE.Group): void {
    g.traverse(c => {
      const geo: unknown = 'geometry' in c ? c.geometry : null, mat: unknown = 'material' in c ? c.material : null;
      if (geo instanceof THREE.BufferGeometry) geo.dispose();
      for (const m of [mat].flat()) if (m instanceof THREE.Material) m.dispose();
    });
    g.clear();
  }
  function lineMat(color: number, opacity: number): THREE.LineBasicMaterial { return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: true }); }
  // štvorec políčka tesne nad zemou
  function tileQuad(P3: number[], v: DebugView, x: number, y: number, inset?: number, lift?: number): void {
    const gy = v.groundY(x + 0.5, y + 0.5) + (lift || 0.03), a = inset || 0;
    const c = [[x + a, y + a], [x + 1 - a, y + a], [x + 1 - a, y + 1 - a], [x + a, y + 1 - a]] as const;
    for (let i = 0; i < 4; i++) { const p = c[i] ?? c[0], q = c[(i + 1) % 4] ?? c[0]; P3.push(p[0], gy, p[1], q[0], gy, q[1]); }
  }
  function segs(P3: number[], color: number, opacity?: number): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P3, 3));
    return new THREE.LineSegments(g, lineMat(color, opacity == null ? 1 : opacity));
  }
  function buildHelpers(v: DebugView): void {
    if (!helpers || !dyn) { helpers = new THREE.Group(); dyn = new THREE.Group(); v.scene.add(helpers, dyn); }
    const hp = helpers;
    disposeGroup(hp);
    builtGrid = v.grid; builtPlants = v.plantSprites.size; helpersDirty = false;
    if (!v.grid) return;
    if (H.boxes) {
      v.fineMeshes.forEach((m, i) => {
        const t = v.grid?.fine[i]?.type ?? 'other';
        hp.add(new THREE.Box3Helper(m.box, lookup(BOX_COL, t) || BOX_COL.other));
      });
      for (const sp of v.plantSprites.values()) {
        const p = sp.position, b = new THREE.Box3(new THREE.Vector3(p.x - 0.5 * sp.scale.x, p.y, p.z - 0.05), new THREE.Vector3(p.x + 0.5 * sp.scale.x, p.y + sp.scale.y, p.z + 0.05));
        hp.add(new THREE.Box3Helper(b, BOX_COL.sprite));
      }
    }
    if (H.grid) {
      const P3: number[] = [];
      for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) tileQuad(P3, v, x, y, 0, 0.02);
      hp.add(segs(P3, 0xffffff, 0.35));
    }
    if (H.tap) {
      // ťuknutie na model vyberie jeho políčko (napr. dvere budovy): žltý štvorec a čiara z modelu
      const P3: number[] = [], L3: number[] = [], c = new THREE.Vector3();
      v.fineMeshes.forEach(m => {
        const t = m.tile; if (!t) return;
        tileQuad(P3, v, t.x, t.y, 0.08, 0.05);
        m.box.getCenter(c);
        L3.push(c.x, m.box.max.y, c.z, t.x + 0.5, v.groundY(t.x + 0.5, t.y + 0.5) + 0.05, t.y + 0.5);
      });
      for (const sp of v.plantSprites.values()) { const t = sp.tile; if (t) tileQuad(P3, v, t.x, t.y, 0.2, 0.05); }
      hp.add(segs(P3, 0xffe14a, 0.95), segs(L3, 0xffe14a, 0.6));
    }
    if (H.gates) {
      const P3: number[] = [], A3: number[] = [];
      for (const g of D.GATES[S.area]) tileQuad(P3, v, g.x, g.y, 0.05, 0.06);
      for (const a of arrivals()) {
        const gy = v.groundY(a.x, a.y) + 0.06, r = 0.3;
        A3.push(a.x - r, gy, a.y - r, a.x + r, gy, a.y + r, a.x - r, gy, a.y + r, a.x + r, gy, a.y - r, a.x, gy, a.y, a.x, gy + 1.2, a.y);
      }
      hp.add(segs(P3, 0xff4fd8), segs(A3, 0x4fe3ff));
    }
    if (H.frustum) { frustumHelper = new THREE.CameraHelper(v.lightCam); hp.add(frustumHelper); } else frustumHelper = null;
    if (H.lights) {
      sunArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(S.W / 2, 8, S.H / 2), 5, 0xffd23a, 1, 0.5);
      hp.add(sunArrow);
    } else sunArrow = null;
    onLayer1(hp);
  }
  // príchodové miesta na tejto ploche (+ začiatok hry a babka v záhrade)
  function arrivals(): { x: number; y: number; label: string }[] {
    const out: { x: number; y: number; label: string }[] = [];
    for (const [k, a] of Object.entries(D.ARRIVE)) { const [from = '', to] = k.split('>'); if (to === S.area) out.push({ x: a.x, y: a.y, label: 'arrive from ' + (lookup(D.AREA_NAMES, from) || from) }); }
    if (S.area === 'garden') { out.push({ x: D.SPAWN.x, y: D.SPAWN.y, label: 'spawn' }); }
    return out;
  }
  // pomôcky, ktoré sa menia každú snímku: svetlá lámp, slnko, kamera tieňov, políčko pod kurzorom
  function updateDynamic(v: DebugView, min: number, se: number): void {
    const dy = dyn;
    if (!dy) return;
    if (frustumHelper) frustumHelper.update();
    if (sunArrow) {
      const d = World3D.sunDir(min, se);
      sunArrow.visible = !!d;
      if (d) { sunArrow.setDirection(new THREE.Vector3(-d.x, -d.y, -d.z)); sunArrow.position.set(S.W / 2 + d.x * 6, 2 + d.y * 6, S.H / 2 + d.z * 6); }
    }
    // svetlá: guľka v strede a kruh s dosahom (vodorovne aj zvislo)
    const lights = H.lights ? v.lights : [];
    while (lightPool.length < lights.length) {
      const g = new THREE.Group();
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, (_, i) => new THREE.Vector3(Math.cos(i / 40 * Math.PI * 2), 0, Math.sin(i / 40 * Math.PI * 2)))), lineMat(0xffb347, 0.9));
      const ring2 = ring.clone(); ring2.rotation.x = Math.PI / 2;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
      g.add(ring, ring2, dot);
      dy.add(onLayer1(g));
      lightPool.push({ g, ring, ring2 });
    }
    lightPool.forEach((p, i) => {
      const l = lights[i];
      p.g.visible = !!l;
      if (!l) return;
      p.g.position.set(l.x, l.y, l.z);
      p.ring.scale.setScalar(l.w); p.ring2.scale.setScalar(l.w);
    });
    // políčko pod kurzorom / po ťuknutí (výber hrou – r3.pick)
    const hb = hoverBox ??= segs(new Array<number>(24).fill(0), 0x4ff0ff);
    const pos = must(hb.geometry.attributes['position']);
    if (!hb.parent) { if (pos instanceof THREE.BufferAttribute) pos.setUsage(THREE.DynamicDrawUsage); dy.add(onLayer1(hb)); }
    hb.visible = !!hover && H.tap;
    if (hover && H.tap) {
      const P3: number[] = []; tileQuad(P3, v, hover.x, hover.y, 0.02, 0.08);
      pos.array.set(P3); pos.needsUpdate = true;
      hb.geometry.computeBoundingSphere();
    }
  }
  function beforeRender(): void {
    const R = must(r3 ?? undefined), v = R.debugView();
    if (v.grid !== builtGrid) R.invalidateShadows(); // nový svet: mapa tieňov ešte bola so všetkými vrstvami
    applyLayers(v);
    if (helpersDirty || v.grid !== builtGrid || (H.boxes && v.plantSprites.size !== builtPlants)) buildHelpers(v);
    updateDynamic(v, curMin(), season());
  }

  // ---------- prekrytie: popisy prechodov, súradnice mriežky, offline hráči ----------
  function drawLabels(): void {
    const v = must(r3 ?? undefined).debugView(), c = ovCtx, dpr = ov.width / (ov.clientWidth || 1), vec = new THREE.Vector3();
    const proj = (x: number, y: number, z: number): { x: number; y: number; in: boolean } => { vec.set(x, y, z).project(v.camera); return { x: (vec.x + 1) / 2 * ov.width, y: (1 - vec.y) / 2 * ov.height, in: vec.z < 1 && Math.abs(vec.x) < 1.1 && Math.abs(vec.y) < 1.1 }; };
    const tag = (x: number, y: number, z: number, text: string, color?: string): void => {
      const p = proj(x, y, z); if (!p.in) return;
      c.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`; c.textAlign = 'center';
      const w = c.measureText(text).width + 8 * dpr;
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(p.x - w / 2, p.y - 14 * dpr, w, 16 * dpr);
      c.fillStyle = color || '#fff'; c.fillText(text, p.x, p.y - 2 * dpr);
    };
    if (!v.grid) return;
    if (H.gates) {
      // jeden popis pre každý prechod (políčka s rovnakým cieľom), v ich strede
      const by = new Map<AreaId, Gate[]>();
      for (const g of D.GATES[S.area]) { const l = by.get(g.to) ?? []; l.push(g); by.set(g.to, l); }
      for (const [to, gs] of by) {
        const x = gs.reduce((n, g) => n + g.x, 0) / gs.length + 0.5, y = gs.reduce((n, g) => n + g.y, 0) / gs.length + 0.5;
        tag(x, v.groundY(x, y) + 0.6, y, '→ ' + (D.AREA_NAMES[to] || to), '#ff9ef0');
      }
      for (const a of arrivals()) tag(a.x, v.groundY(a.x, a.y) + 1.4, a.y, a.label, '#9ef3ff');
      if (S.area === 'garden') tag(D.BABKA.x + 0.5, v.groundY(D.BABKA.x + 0.5, D.BABKA.y + 0.5) + 1.9, D.BABKA.y + 0.5, 'babka', '#ddd');
    }
    if (H.grid) for (let y = 0; y < S.H; y += 5) for (let x = 0; x < S.W; x += 5) tag(x + 0.5, v.groundY(x + 0.5, y + 0.5) + 0.1, y + 0.5, `${x},${y}`, '#fff');
    if (H.lights) for (const l of v.lights) tag(l.x, l.y + 0.35, l.z, 'r ' + l.w.toFixed(1), '#ffd28a');
    if (L.chars) for (const p of offline) tag(p.x, v.groundY(p.x, p.y) + 0.3, p.y, '◌ ' + p.id + ' (offline)', '#bbb');
  }

  // ---------- slučka ----------
  let last = performance.now(), fpsN = 0, fpsT = last, fps = 0, statAt = 0, cpu = 0;
  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    if (!r3) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (P.play) P.min = (P.min + dt * 60) % 1440;
    S.weather = P.weather === 'room' ? world?.weather || 'sun' : P.weather;
    S.me.x = cam.x; S.me.y = cam.z; // podľa tohto bodu sa ráta šero v lese (obloha, lampáše)
    movePlayers(dt);
    if (lastHoverXY && now - hoverAt > 120) { hoverAt = now; hover = r3.pick(lastHoverXY[0], lastHoverXY[1]); }
    else if (!lastHoverXY) hover = null;
    const t0 = performance.now();
    r3.frame(now / 1000);
    drawLabels();
    cpu = cpu * 0.9 + (performance.now() - t0) * 0.1;
    fpsN++;
    if (now - fpsT > 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    saveCam(now);
    if (now - statAt > 250) { statAt = now; showStats(); if (P.play || P.clock) syncTimeUi(); }
  }
  function showStats(): void {
    const R = must(r3 ?? undefined), s = R.stats(), v = R.debugView(), f1 = (x: number): string => x.toFixed(1);
    const tl = hover && S.tiles[hover.y * S.W + hover.x];
    const narrow = wrap.clientWidth < 600;
    const lines = [
      narrow ? `${f1(fps)} fps · cpu ${f1(cpu)} ms · ${s.calls} calls · ${(s.triangles / 1000).toFixed(1)}k tris`
        : `${f1(fps)} fps · cpu ${f1(cpu)} ms (shadow ${f1(s.shadow)} · refl ${f1(s.refl)} · scene ${f1(s.scene)}) · ${s.calls} calls · ${(s.triangles / 1000).toFixed(1)}k tris · ${s.geometries} geo · ${s.textures} tex · ${s.w}×${s.h} @${s.pr}`,
      `${D.AREA_NAMES[S.area] || S.area} ${S.W}×${S.H} · ${v.fineMeshes.length} models · ${v.plantSprites.size} plants · ${v.lights.length} lights · ${ctx.fmt.hhmm(Math.floor(curMin()))} ${SEASON_EN[season()] ?? ''} · ${S.weather}` +
        (narrow ? '' : ` · cam ${f1(cam.x)},${f1(cam.z)} yaw ${((Math.round(cam.yaw * 180 / Math.PI) % 360) + 360) % 360}° pitch ${Math.round(cam.pitch * 180 / Math.PI)}° view ${f1(cam.zoom)}`)
    ];
    if (tl && hover) lines.push(`tile ${hover.x},${hover.y}: ${tl.g}${tl.ice != null ? ' ice ' + tl.ice : ''}${tl.cut ? ' (cut)' : ''}${tl.s ? ' · soil ' + ctx.fmt.short(tl.s) : ''}`);
    stats.textContent = lines.join('\n');
  }

  renderPanel();
  void loadWorld(true);
  const poll = setInterval(() => { if (P.src === 'room' && ctx.room && !document.hidden) void loadWorld(false); }, 2500);

  return {
    update(c) {
      const roomChanged = c.room !== ctx.room;
      ctx = c;
      if (roomChanged && c.room && P.src === 'seed' && !ctx.param('wsrc')) P.src = 'room';
      if (!c.room) P.src = 'seed';
      void loadWorld(false);
    },
    unmount() {
      alive = false;
      cancelAnimationFrame(raf); clearInterval(poll); ro.disconnect();
      for (const f of cleanups) f();
      if (r3) { try { r3.dispose(); } catch (e) { console.error(e); } r3 = null; }

      window.MF_NOFADE = oldNoFade;
      const st = document.getElementById('tab-world-css'); if (st) st.remove();
      el.style.padding = oldPad; el.style.overflow = oldOverflow;
      el.replaceChildren();
    }
  };
}
