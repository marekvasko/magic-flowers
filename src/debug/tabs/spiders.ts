// Sprity pavúkov v /debug → Generators → Spiders (#57): pre každý druh 3D model (Three.js zo shared/spidermodel.ts)
// a 2D sprite z jednoduchých tvarov (ten istý model premietnutý do elíps a úsečiek, ako v hre) vedľa seba
// vo všetkých 16 pohľadoch (8 na zemi, 8 na zvislej ploche chrbtom/bruchom), zhoda obrysov (IoU) a fotky predlôh.
import * as THREE from 'three';
import * as SM from '../../shared/spidermodel.ts';
import type { Layout } from '../../shared/spidermodel.ts';
import { lookup, must } from '../../shared/util.ts';
import type { TabCtx, h as H } from '../ui.ts';
import type { seg as Seg } from './assets.ts';

export const CSS = `
.spd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-top: 10px; }
.spd-cell { border: 1px solid var(--line); border-radius: 8px; padding: 6px; background: var(--bg-soft, #1b1f22); }
.spd-cell h6 { margin: 0 0 4px; font-size: 12px; color: #e8eef0; display: flex; justify-content: space-between; }
.spd-pair { display: flex; gap: 4px; align-items: flex-end; justify-content: center; }
.spd-pair canvas { max-width: 50%; image-rendering: pixelated; background: #9aa58f; border-radius: 4px; }
.spd-refs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.spd-refs figure { margin: 0; width: 200px; font-size: 11px; color: var(--muted); }
.spd-refs img { width: 200px; height: 150px; object-fit: cover; border-radius: 6px; }
`;
const REFS: Readonly<Partial<Record<string, readonly (readonly [string, string])[]>>> = {
  k: [['Araneus diadematus (dorsal).jpg', 'dorsal'], ['Araneus diadematus (ventral).jpg', 'ventral, in web']],
  v: [['Hogna radiata (AF)-top 01.png', 'dorsal'], ['Female Hogna radiata from izmir.jpg', 'front'], ['Hogna radiata female preserved specimen 2.png', 'ventral']],
  p: [['Araneus angulatus female preserved specimen 1.png', 'dorsal'], ['Araneus angulatus female preserved specimen 2.png', 'ventral'], ['Araneus angulatus (Araneidae) - (female subadult), Bergherbosch (Montferland), the Netherlands.jpg', 'live']]
};
const thumb = (f: string): string => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(f) + '?width=400';
const page = (f: string): string => 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(f.replace(/ /g, '_'));
const BG = { ground: '#6f7d5e', dark: '#141a16' };

type Kind = keyof typeof SM.SPECIES;
// Pohľad pavúkov v Generators: h, kontext (parametre v adrese), plocha, uloženie stavu a prepínač
export interface SpiderViewInit { h: typeof H; ctx: Pick<TabCtx, 'param' | 'setParam' | 'D'>; mainEl: HTMLElement; save: () => void; seg: typeof Seg }
export function spiderView({ h, ctx, mainEl, save, seg }: SpiderViewInit): { dispose: () => void } {
  const KINDS = Object.keys(SM.SPECIES).filter((k): k is Kind => k in SM.SPECIES);
  const sk = ctx.param('sk');
  const st = {
    kind: KINDS.find(k => k === sk) ?? 'v',
    frame: Math.max(0, Math.min(SM.FRAMES - 1, parseInt(ctx.param('sf') ?? '', 10) || 0)),
    zoom: Math.max(1, Math.min(4, parseInt(ctx.param('sz') ?? '', 10) || 2)),
    bg: ctx.param('sb') === 'dark' ? 'dark' as const : 'ground' as const,
    speed: 0 // index v SPEEDS: 0 = stojí, inak prehráva chôdzu rýchlosťou ako v hre
  };
  // rýchlosti z hry (D.SPIDERS), políčka/s
  const SP = ctx.D.SPIDERS;
  const SPEEDS: Readonly<Record<Kind, readonly (readonly [string, number])[]>> = {
    k: [['stand', 0], ['run', SP.kriziak.run], ['flee', SP.kriziak.flee], ['climb', SP.kriziak.climb]],
    v: [['stand', 0], ['walk', SP.vlciak.walk], ['run', SP.vlciak.run], ['climb', SP.vlciak.climb]],
    p: [['stand', 0], ['walk', SP.pradlena.walk], ['climb', SP.pradlena.climb]]
  };
  const sprites: { c: HTMLCanvasElement; view: string }[] = []; // 2D sprity v mriežke, prekresľujú sa pri prehrávaní
  const bar = h('div', { class: 'as-bar' });
  const speedInfo = h('span', { class: 'muted' });
  const info = h('div', { class: 'muted' });
  const grid = h('div', { class: 'spd-grid' });
  const refs = h('div', { class: 'spd-refs' });
  mainEl.replaceChildren(bar, info, grid, h('h4', null, 'References (Wikimedia Commons)'), refs);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(-0.35, 1, 0.45); scene.add(sun);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  cam.up.set(...SM.CAM.u); cam.position.set(SM.CAM.c[0] * 20, SM.CAM.c[1] * 20, SM.CAM.c[2] * 20); cam.lookAt(0, 0, 0);
  const VIEWS = SM.VIEWS.concat(SM.TRUNK, ['dorsal', 'ventral']);
  let raf = 0, last = 0;
  const speeds = (): readonly (readonly [string, number])[] => SPEEDS[st.kind];

  function renderBar(): void {
    bar.replaceChildren(
      seg(h, KINDS.map(k => SM.SPECIES[k].name), KINDS.indexOf(st.kind), i => { st.kind = must(KINDS[i]); saveSt(); renderBar(); rebuild(); }),
      seg(h, Array.from({ length: SM.FRAMES }, (_, i) => i ? String(i) : 'frame 0'), st.frame, i => { st.frame = i; saveSt(); renderBar(); rebuild(); }),
      seg(h, speeds().map(([n, v]) => v ? `${n} ${v}` : n), Math.min(st.speed, speeds().length - 1), i => { st.speed = i; renderBar(); if (i) { last = 0; loop(performance.now()); } }),
      seg(h, ['1×', '2×', '3×', '4×'], st.zoom - 1, i => { st.zoom = i + 1; saveSt(); renderBar(); rebuild(); }),
      seg(h, ['ground', 'dark'], st.bg === 'dark' ? 1 : 0, i => { st.bg = i ? 'dark' : 'ground'; saveSt(); renderBar(); rebuild(); }),
      speedInfo);
    if (!speeds()[st.speed]) st.speed = 0;
  }
  function saveSt(): void { ctx.setParam('sk', st.kind); ctx.setParam('sf', st.frame); ctx.setParam('sz', st.zoom); ctx.setParam('sb', st.bg); save(); }
  const ctx2 = (cv: HTMLCanvasElement): CanvasRenderingContext2D => must(cv.getContext('2d') ?? undefined);

  // 2D sprite ako v hre; na tmavom pozadí stmavený (ako v Lese divov) a so svitom očí
  function paint(cv: HTMLCanvasElement, view: string, f: number): void {
    const g = ctx2(cv), L = SM.layout(st.kind, view);
    g.clearRect(0, 0, cv.width, cv.height);
    SM.sprite(g, st.kind, view, f);
    if (st.bg !== 'dark') return;
    g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(8,12,10,0.8)'; g.fillRect(0, 0, cv.width, cv.height); g.restore();
    SM.glow(g, st.kind, L.eyes[f], L.ox, L.oy, L.ppu, 1);
  }
  // obrys z alfa kanála
  const mask = (cv: HTMLCanvasElement): Uint8Array => { const d = ctx2(cv).getImageData(0, 0, cv.width, cv.height).data, m = new Uint8Array(cv.width * cv.height); for (let i = 0; i < m.length; i++) m[i] = (d[i * 4 + 3] ?? 0) > 100 ? 1 : 0; return m; };
  function iou(a: Uint8Array, b: Uint8Array): number { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { const x = a[k] ?? 0, y = b[k] ?? 0; i += x & y; u += x | y; } return u ? i / u : 1; }

  function cell(view: string): { c2: HTMLCanvasElement; c3: HTMLCanvasElement; score: number; L: Layout } {
    const L = SM.layout(st.kind, view), z = st.zoom;
    // 2D sprite (rovnaký kód ako v hre)
    const c2 = document.createElement('canvas'); c2.width = L.w; c2.height = L.h;
    paint(c2, view, st.frame);
    sprites.push({ c: c2, view });
    // 3D model rovnakým (ortografickým) pohľadom a mierkou
    renderer.setSize(L.w, L.h, false);
    cam.left = -L.ox / L.ppu; cam.right = (L.w - L.ox) / L.ppu; cam.top = L.oy / L.ppu; cam.bottom = -(L.h - L.oy) / L.ppu; cam.updateProjectionMatrix();
    const g = SM.buildMesh(THREE, st.kind, st.frame * 2 * Math.PI / SM.FRAMES, view);
    scene.add(g); renderer.render(scene, cam); scene.remove(g);
    g.traverse(o => { if (o instanceof THREE.Mesh) { const m: unknown = o.material, geo: unknown = o.geometry; if (geo instanceof THREE.BufferGeometry) geo.dispose(); if (m instanceof THREE.Material) m.dispose(); } });
    const c3 = document.createElement('canvas'); c3.width = L.w; c3.height = L.h; ctx2(c3).drawImage(renderer.domElement, 0, 0);
    const score = iou(mask(c2), mask(c3));
    for (const cv of [c3, c2]) { cv.style.width = cv.width * z / 2 + 'px'; cv.style.background = BG[st.bg]; }
    return { c2, c3, score, L };
  }
  function rebuild(): void {
    const out: string[] = [];
    let sum = 0;
    sprites.length = 0;
    grid.replaceChildren(...VIEWS.map(v => {
      const r = cell(v);
      sum += r.score; out.push(v + ' ' + r.score.toFixed(2));
      return h('div', { class: 'spd-cell', 'data-view': v, 'data-iou': r.score.toFixed(3) },
        h('h6', null, h('span', null, v + (SM.PLANAR.includes(v) ? '' : v.startsWith('dorsal') || v.startsWith('ventral') ? ' (reference)' : SM.TRUNK.includes(v) ? ' (on trunk)' : ' (on surface)')), h('span', { class: 'muted' }, 'IoU ' + r.score.toFixed(2))),
        h('div', { class: 'spd-pair' }, r.c3, r.c2), h('div', { class: 'muted', style: 'font-size:11px;text-align:center' }, `3D model · 2D sprite ${r.L.w}×${r.L.h}px`));
    }));
    const K = SM.SPECIES[st.kind];
    info.textContent = `${K.name} (${K.ref}) – span ${K.span} tiles${K.top ? ', height ' + K.top : ''} · ${K.ppu} px/tile · mean silhouette IoU ${(sum / VIEWS.length).toFixed(3)}`;
    refs.replaceChildren(...(lookup(REFS, st.kind) || []).map(([f, label]) => h('figure', null, h('a', { href: page(f), target: '_blank' }, h('img', { src: thumb(f), alt: f, loading: 'lazy' })), h('figcaption', null, label + ' – ' + f))));
  }
  // Prehrávanie ako v hre: fáza podľa prejdenej dráhy (SpiderModel.stepPhase), snímka SpiderModel.frameOf; prekresľujú
  // sa len 2D sprity (3D model ostane na zvolenej snímke).
  let phase = 0;
  function loop(t: number): void {
    cancelAnimationFrame(raf);
    const sp = speeds()[st.speed];

    if (!sp || !sp[1]) { speedInfo.textContent = ''; return; }
    raf = requestAnimationFrame(loop);
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    phase += SM.stepPhase(st.kind, sp[1] * dt, dt);
    const f = SM.frameOf(phase), hz = Math.min(sp[1] / SM.cycle(st.kind), SM.MAX_HZ);
    speedInfo.textContent = `${hz.toFixed(1)} steps/s${sp[1] / SM.cycle(st.kind) > SM.MAX_HZ ? ' (capped)' : ''} · ${(hz * SM.FRAMES).toFixed(0)} frames/s · frame ${f}`;
    for (const { c, view } of sprites) paint(c, view, f);
  }
  renderBar(); rebuild();
  return { dispose() { st.speed = 0; cancelAnimationFrame(raf); renderer.dispose(); renderer.forceContextLoss(); } };
}
