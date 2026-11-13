// Záložka Assets v /debug (#176): výstup optimalizácie siete jemného modelu – presne to, čo hra vypečie (finebake.ts):
// farebný obrázok (1 texel na stenu minikocky, alfa = žiarenie), obrázok zatienenia rohov, obrysy zlúčených obdĺžnikov
// a počty stien pred a po zlúčení. Len zobrazuje, hru nemení.
import { bakeFine, atlasRects } from '../../client/finebake.ts';
import type { AtlasRect } from '../../client/finebake.ts';
import type { FineModel } from '../../shared/world3d.ts';
import { atlasPixels, faceOf, FACE_NAMES, meshStats, quadAt } from './mesher-core.ts';
import type { ColorMode } from './mesher-core.ts';
import type { h as H } from '../ui.ts';

export const MESHER_CSS = `
.ms { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.ms h3 { margin: 0; }
.ms-bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font-size: 12.5px; }
.ms-bar label { display: inline-flex; align-items: center; gap: 4px; }
.ms-atl { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.ms-atl > div { min-width: 0; max-width: 100%; }
.ms-atl h4 { margin: 0 0 4px; font-size: 12.5px; }
.ms-atl h4 small { color: var(--muted); font-weight: 400; font-family: var(--mono); }
.ms-scroll { overflow: auto; max-width: 100%; max-height: 70vh; border: 1px solid var(--line); border-radius: 6px;
  background: repeating-conic-gradient(#d6d6d6 0 25%, #f4f4f4 0 50%) 0 0 / 16px 16px; }
.ms-scroll canvas { display: block; image-rendering: pixelated; cursor: crosshair; }
.ms-hover { font-family: var(--mono); font-size: 12px; min-height: 1.4em; color: var(--muted); }
`;

const kb = (n: number): string => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' kB';
const pct = (a: number, b: number): string => (b ? (100 * a / b).toFixed(1) : '0') + ' %';

// Panel pod prehliadačom: mesherPanel(h, model, obdobie) → prvok (stav ovládania si drží sám)
export interface PanelState { zoom: number; outlines: boolean; stretch: boolean; mode: ColorMode }
export function mesherPanel(h: typeof H, f: FineModel, se: number, st: PanelState, onChange: () => void): HTMLElement {
  const t0 = performance.now();
  const b = bakeFine(f, se);
  const ms = performance.now() - t0;
  const s = meshStats(f, b), rects = atlasRects(b);
  const kv = (label: string, v: string, sub: string | null): HTMLElement => h('div', null, h('small', null, label), h('b', null, v), sub ? h('small', null, sub) : null);
  const hover = h('div', { class: 'ms-hover' }, 'Hover an atlas texel to see its quad.');
  let hot = -1;

  // jeden obrázok: plátno so zväčšením, obrysy obdĺžnikov a zvýraznený obdĺžnik pod myšou (aj na druhom obrázku)
  const views: (() => void)[] = [];
  function atlas(title: string, which: 'color' | 'emission' | 'ao', rs: readonly AtlasRect[]): HTMLElement {
    const { W, H, px } = atlasPixels(b, which, st.stretch);
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sg = src.getContext('2d');
    if (sg) sg.putImageData(new ImageData(px, W, H), 0, 0);
    const z = Math.max(1, Math.min(st.zoom, Math.floor(8192 / Math.max(W, H)))); // plátno najviac 8192 px
    const cv = h('canvas', { width: W * z, height: H * z });
    const g = cv.getContext('2d');
    const draw = (): void => {
      if (!g) return;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(src, 0, 0, W * z, H * z);
      if (st.outlines && z >= 2) {
        g.strokeStyle = 'rgba(255,0,200,.75)'; g.lineWidth = 1;
        for (const r of rs) g.strokeRect(r.x * z + 0.5, r.y * z + 0.5, r.w * z - 1, r.h * z - 1);
      }
      const r = rs[hot];
      if (r) { g.strokeStyle = '#00e5ff'; g.lineWidth = 2; g.strokeRect(r.x * z + 1, r.y * z + 1, r.w * z - 2, r.h * z - 2); }
    };
    views.push(draw);
    draw();
    // myš aj dotyk (ťuknutie ukáže obdĺžnik pod prstom)
    const onPoint = (e: PointerEvent): void => {
      const rc = cv.getBoundingClientRect(), x = Math.floor((e.clientX - rc.left) * cv.width / rc.width / z), y = Math.floor((e.clientY - rc.top) * cv.height / rc.height / z);
      const k = quadAt(rs, x, y);
      if (k !== hot) { hot = k; for (const v of views) v(); }
      const q = b.quads[k];
      hover.textContent = q
        ? `texel ${x}, ${y} · quad #${k}: face ${FACE_NAMES[faceOf(q)] ?? '?'}, plane d=${q.d}, u=${q.u} v=${q.v}, ${q.w} × ${q.h} voxels`
        : `texel ${x}, ${y} · padding / free space`;
    };
    cv.addEventListener('pointermove', onPoint);
    cv.addEventListener('pointerdown', onPoint);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && hot >= 0) { hot = -1; for (const v of views) v(); } });
    return h('div', null, h('h4', null, title, ' ', h('small', null, `${W} × ${H}${z !== st.zoom ? ` · zoom capped at ${z}×` : ''}`)), h('div', { class: 'ms-scroll' }, cv));
  }

  const check = (label: string, on: boolean, set: (v: boolean) => void): HTMLElement => {
    const i = h('input', { type: 'checkbox' });
    i.checked = on;
    i.onchange = () => { set(i.checked); onChange(); };
    return h('label', null, i, label);
  };
  const segBtns = <T>(opts: readonly (readonly [T, string])[], cur: T, set: (v: T) => void): HTMLElement =>
    h('div', { class: 'as-seg' }, opts.map(([v, l]) => h('button', { class: v === cur ? 'on' : null, onclick: () => { set(v); onChange(); } }, l)));

  return h('div', { class: 'ms' },
    h('h3', null, 'Mesher (baked, as in the game)'),
    h('div', { class: 'muted' }, 'Output of Mesher.bakeModel via client/finebake.ts – the same mesh and images render3d.ts uploads to the GPU. Colour atlas: 1 texel per voxel face, nearest filtering, alpha = emission. AO atlas: corner shading of each merged quad, linear filtering. Each quad has a 1-texel border.'),
    h('div', { class: 'as-kv' },
      kv('Faces → quads', `${s.voxelFaces.toLocaleString('en')} → ${s.quads.toLocaleString('en')}`, `${pct(s.quads, s.voxelFaces)} of the voxel faces`),
      kv('Triangles', `${s.trisBefore.toLocaleString('en')} → ${s.trisAfter.toLocaleString('en')}`, 'without merging → merged'),
      kv('Colour atlas', `${s.color.W} × ${s.color.H}`, `${pct(s.color.used, s.color.W * s.color.H)} faces, ${kb(s.color.bytes)} RGBA`),
      kv('AO atlas', `${s.ao.W} × ${s.ao.H}`, `${pct(s.ao.used, s.ao.W * s.ao.H)} corners, ${kb(s.ao.bytes)} R8`),
      kv('Mesh buffers', kb(s.meshBytes), `${(s.quads * 4).toLocaleString('en')} vertices`),
      kv('Bake', `${ms.toFixed(1)} ms`, 'greedy + pack + bake')),
    h('div', { class: 'ms-bar' },
      h('span', null, 'Zoom '), segBtns([[1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']] as const, st.zoom, v => { st.zoom = v; }),
      segBtns([['color', 'Colour'], ['emission', 'Emission']] as const, st.mode, v => { st.mode = v; }),
      check('quad outlines', st.outlines, v => { st.outlines = v; }),
      check('stretch AO contrast', st.stretch, v => { st.stretch = v; })),
    hover,
    h('div', { class: 'ms-atl' },
      atlas(st.mode === 'color' ? 'Colour atlas' : 'Emission (alpha)', st.mode, rects.color),
      atlas('AO atlas', 'ao', rects.ao)));
}
