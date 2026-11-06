// Sprity pavúkov v /debug → Generators → Spiders (#57): pre každý druh 3D model (Three.js zo shared/spidermodel.js)
// a 2D sprite z jednoduchých tvarov (ten istý model premietnutý do elíps a úsečiek, ako v hre) vedľa seba
// vo všetkých 16 pohľadoch (8 na zemi, 8 na zvislej ploche chrbtom/bruchom), zhoda obrysov (IoU) a fotky predlôh.
import * as THREE from '/vendor/three/three.module.js';

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
const REFS = {
  k: [['Araneus diadematus (dorsal).jpg', 'dorsal'], ['Araneus diadematus (ventral).jpg', 'ventral, in web']],
  v: [['Hogna radiata (AF)-top 01.png', 'dorsal'], ['Female Hogna radiata from izmir.jpg', 'front'], ['Hogna radiata female preserved specimen 2.png', 'ventral']],
  p: [['Araneus angulatus female preserved specimen 1.png', 'dorsal'], ['Araneus angulatus female preserved specimen 2.png', 'ventral'], ['Araneus angulatus (Araneidae) - (female subadult), Bergherbosch (Montferland), the Netherlands.jpg', 'live']]
};
const thumb = f => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(f) + '?width=400';
const page = f => 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(f.replace(/ /g, '_'));
const BG = { ground: '#6f7d5e', dark: '#141a16' };

export function spiderView({ h, ctx, mainEl, save, seg }) {
  const SM = window.SpiderModel;
  const KINDS = Object.keys(SM.SPECIES);
  const st = {
    kind: KINDS.includes(ctx.param('sk')) ? ctx.param('sk') : 'v',
    frame: Math.max(0, Math.min(3, parseInt(ctx.param('sf'), 10) || 0)),
    zoom: Math.max(1, Math.min(4, parseInt(ctx.param('sz'), 10) || 2)),
    bg: ctx.param('sb') === 'dark' ? 'dark' : 'ground',
    anim: false
  };
  const bar = h('div', { class: 'as-bar' });
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
  cam.up.set(...SM.CAM.u); cam.position.set(...SM.CAM.c.map(v => v * 20)); cam.lookAt(0, 0, 0);
  const VIEWS = SM.VIEWS.concat(SM.TRUNK, ['dorsal', 'ventral']);
  let raf = 0, last = 0;

  function renderBar() {
    bar.replaceChildren(
      seg(h, KINDS.map(k => SM.SPECIES[k].name), KINDS.indexOf(st.kind), i => { st.kind = KINDS[i]; saveSt(); renderBar(); rebuild(); }),
      seg(h, ['frame 0', '1', '2', '3'], st.frame, i => { st.frame = i; saveSt(); renderBar(); rebuild(); }),
      seg(h, ['1×', '2×', '3×', '4×'], st.zoom - 1, i => { st.zoom = i + 1; saveSt(); renderBar(); rebuild(); }),
      seg(h, ['ground', 'dark'], st.bg === 'dark' ? 1 : 0, i => { st.bg = i ? 'dark' : 'ground'; saveSt(); renderBar(); rebuild(); }),
      h('button', { class: st.anim ? 'on' : null, onclick: () => { st.anim = !st.anim; renderBar(); if (st.anim) loop(); } }, st.anim ? '■ Stop walk' : '▶ Walk'));
  }
  function saveSt() { ctx.setParam && (ctx.setParam('sk', st.kind), ctx.setParam('sf', st.frame), ctx.setParam('sz', st.zoom), ctx.setParam('sb', st.bg)); save(); }

  // obrys z alfa kanála
  const mask = cv => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, m = new Uint8Array(cv.width * cv.height); for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 100 ? 1 : 0; return m; };
  function iou(a, b) { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; }

  function cell(view, phase) {
    const L = SM.layout(st.kind, view), z = st.zoom;
    // 2D sprite (rovnaký kód ako v hre)
    const c2 = document.createElement('canvas'); c2.width = L.w; c2.height = L.h;
    if (SM.SPECIES[st.kind] && phase == null) SM.sprite(c2.getContext('2d'), st.kind, view, st.frame);
    else SM.draw(c2.getContext('2d'), SM.project(SM.build(st.kind, phase, SM.isSurface(view) ? 'surface' : 'ground'), view), L.ppu, L.ox, L.oy);
    // 3D model rovnakým (ortografickým) pohľadom a mierkou
    renderer.setSize(L.w, L.h, false);
    cam.left = -L.ox / L.ppu; cam.right = (L.w - L.ox) / L.ppu; cam.top = L.oy / L.ppu; cam.bottom = -(L.h - L.oy) / L.ppu; cam.updateProjectionMatrix();
    const g = SM.buildMesh(THREE, st.kind, phase == null ? st.frame * Math.PI / 2 : phase, view);
    scene.add(g); renderer.render(scene, cam); scene.remove(g);
    g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    const c3 = document.createElement('canvas'); c3.width = L.w; c3.height = L.h; c3.getContext('2d').drawImage(renderer.domElement, 0, 0);
    const score = iou(mask(c2), mask(c3));
    for (const cv of [c3, c2]) { cv.style.width = cv.width * z / 2 + 'px'; cv.style.background = BG[st.bg]; }
    return { c2, c3, score, L };
  }
  function rebuild(phase) {
    const out = [];
    let sum = 0;
    grid.replaceChildren(...VIEWS.map(v => {
      const r = cell(v, phase);
      sum += r.score; out.push(v + ' ' + r.score.toFixed(2));
      return h('div', { class: 'spd-cell', 'data-view': v, 'data-iou': r.score.toFixed(3) },
        h('h6', null, h('span', null, v + (SM.PLANAR.includes(v) ? '' : v.startsWith('dorsal') || v.startsWith('ventral') ? ' (reference)' : SM.TRUNK.includes(v) ? ' (on trunk)' : ' (on surface)')), h('span', { class: 'muted' }, 'IoU ' + r.score.toFixed(2))),
        h('div', { class: 'spd-pair' }, r.c3, r.c2), h('div', { class: 'muted', style: 'font-size:11px;text-align:center' }, `3D model · 2D sprite ${r.L.w}×${r.L.h}px`));
    }));
    const K = SM.SPECIES[st.kind];
    info.textContent = `${K.name} (${K.ref}) – span ${K.span} tiles${K.top ? ', height ' + K.top : ''} · ${K.ppu} px/tile · mean silhouette IoU ${(sum / VIEWS.length).toFixed(3)}`;
    refs.replaceChildren(...(REFS[st.kind] || []).map(([f, label]) => h('figure', null, h('a', { href: page(f), target: '_blank' }, h('img', { src: thumb(f), alt: f, loading: 'lazy' })), h('figcaption', null, label + ' – ' + f))));
  }
  function loop(t) {
    if (!st.anim) return;
    raf = requestAnimationFrame(loop);
    if (t - last < 120) return;
    last = t;
    rebuild(t / 1000 * 6);
  }
  renderBar(); rebuild();
  return { dispose() { st.anim = false; cancelAnimationFrame(raf); renderer.dispose(); renderer.forceContextLoss(); } };
}
