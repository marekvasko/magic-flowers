// Záložka Generators v /debug (#79): procedurálne generátory a ich parametre.
//  - stromy: posuvník pre každý parameter z World3D.TREE_PARAMS, živý 3D náhľad, porovnanie predvolený vs. upravený,
//    reset, náhodné semienko a „Copy parameters“ (JSON len so zmenenými hodnotami pre treeModel(kind, season, rot, over));
//  - plochy: D.buildArea(area, seed) ako pôdorysy pre viac semienok vedľa seba.
// Úpravy žijú len v tejto stránke (a v adrese), hru nikdy nemenia.
import { createViewer, loadWorld3D, injectCss, modelStats } from '/debug/tabs/modelview.mjs';
import { CSS as ASSETS_CSS, SEASONS, ROTS, seg } from '/debug/tabs/assets.mjs';

const CSS = `
.gn-params { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.gn-tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.gn-sliders { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 2px 18px; }
.gn-sl { display: grid; grid-template-columns: 92px 1fr 46px; gap: 6px; align-items: center; font-size: 12.5px; }
.gn-sl label { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.gn-sl input { width: 100%; min-width: 0; accent-color: var(--accent); }
.gn-sl output { font-family: var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
.gn-sl.ch label, .gn-sl.ch output { color: var(--accent); font-weight: 700; }
.gn-json { font-family: var(--mono); font-size: 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; overflow-wrap: anywhere; margin: 0 0 8px; }
.gn-plans { display: flex; flex-wrap: wrap; gap: 12px; }
.gn-plan { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.gn-plan canvas { display: block; image-rendering: pixelated; border-radius: 4px; cursor: crosshair; }
.gn-plan small { color: var(--muted); font-size: 11.5px; max-width: 200px; }
.gn-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; margin-top: 10px; }
.gn-legend span { display: inline-flex; align-items: center; gap: 4px; }
.gn-tip { font-family: var(--mono); font-size: 12px; min-height: 1.4em; }
.gn-seed { width: 120px; }
.as-bar input[type=number] { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
@media (max-width: 700px) {
  .gn-sliders { grid-template-columns: 1fr; }
  .as-view.gn-v { height: 46vh; }
}
`;

// Farby políčok pôdorysu (stromy podľa druhu, ktorý by na políčku rástol)
const TILE = {
  grass: '#86c255', meadow: '#a6d46c', forest: '#5f9a46', fern: '#4b8a3a', bush: '#2f6f2a', shroom: '#c0533a', ring: '#b07fd0',
  path: '#d9b77e', gate: '#f0a030', lot: '#cfc6b4', sand: '#ecd9a0', water: '#4aa3df', rock: '#a9a39a', boulder: '#7d776f',
  cliff: '#5f5a54', scree: '#b7b1a6', snow: '#f2f6f9', glacier: '#9fd0ec', alp: '#8cc76a',
  house: '#8b5a2b', hut: '#f0e6d0', babka: '#e07bb0', cauldron: '#2b2b33', well: '#3a6ea5', stall: '#e53935',
  // Les divov
  moss: '#3f6a33', roots: '#a88a5a', fungi: '#7a4a6a', glade: '#d8c95a', giant: '#3a2414', trunk: '#4a2e1a', log: '#6b4a2a'
};
const KIND = { buk: '#2f8a3a', dub: '#1d5a26', breza: '#e9e4d2', jablon: '#e0608c', smrek: '#103a22', borovica: '#a0522d' };

export function mount(el, ctx) {
  const { h, D } = ctx;
  injectCss('tab-assets-css', ASSETS_CSS);
  injectCss('tab-generators-css', CSS);
  document.body.classList.add('dbg-wide');
  let W = null, viewer = null, gone = false, raf = 0;
  const intP = (k, def, max) => { const v = parseInt(ctx.param(k), 10); return Number.isInteger(v) && v >= 0 && v <= max ? v : def; };
  let over = {};
  try { const o = JSON.parse(ctx.param('tp') || '{}'); if (o && typeof o === 'object') over = o; } catch (e) { /* zlá adresa */ }
  const st = {
    gen: ctx.param('gen') || 'tree-buk',
    season: intP('season', 1, 3), rot: intP('rot', 0, 3), cmp: ctx.param('cmp') !== '0',
    seed: intP('aseed', 1, 4294967295), n: intP('n', 6, 24)
  };
  const root = h('div', { class: 'as' });
  const listEl = h('div', { class: 'as-list' }), mainEl = h('div', { class: 'as-main' });
  root.append(listEl, mainEl);
  el.replaceChildren(h('div', { class: 'muted', style: 'padding:20px' }, 'Loading generators…'));

  loadWorld3D().then(w => {
    if (gone) return;
    W = w;
    if (!gens().some(g => g.id === st.gen)) st.gen = 'tree-buk';
    el.replaceChildren(root);
    renderList(); show();
  }).catch(e => { if (!gone) el.replaceChildren(h('div', { class: 'as-err' }, 'Cannot load /shared/world3d.js: ' + e.message)); });

  const gens = () => [
    ...W.TREE_KINDS.map(k => ({ id: 'tree-' + k, kind: k, name: (W.TREE_NAMES && W.TREE_NAMES[k]) || k, group: 'Trees', sub: Object.keys(W.TREE_PARAMS[k]).length + ' params' })),
    ...D.AREAS.map(a => ({ id: 'area-' + a, area: a, name: D.AREA_NAMES[a] || a, group: 'Area layouts', sub: a === 'pomedzie' || a === 'les' ? 'seeded' : 'fixed' }))
  ];
  const cur = () => gens().find(g => g.id === st.gen);
  function save() {
    ctx.setParam('gen', st.gen);
    const g = cur();
    if (g && g.kind) {
      ctx.setParam('season', st.season); ctx.setParam('rot', st.rot); ctx.setParam('cmp', st.cmp ? null : 0);
      ctx.setParam('tp', Object.keys(changed()).length ? JSON.stringify(changed()) : null);
    } else { ctx.setParam('aseed', st.seed); ctx.setParam('n', st.n); }
  }

  // ---------- zoznam ----------
  const pick = h('button', { class: 'as-pick', onclick: () => listEl.classList.toggle('open') });
  const items = h('div', { class: 'as-items' });
  listEl.append(pick, items);
  function renderList() {
    const all = gens(), groups = [...new Set(all.map(g => g.group))];
    items.replaceChildren(...groups.flatMap(gr => [h('h4', null, gr), ...all.filter(g => g.group === gr).map(g =>
      h('button', { class: g.id === st.gen ? 'on' : null, onclick: () => select(g.id) }, g.name, h('small', null, g.kind || g.sub)))]));
    const c = cur();
    pick.textContent = `▾ ${c ? c.group + ': ' + c.name : st.gen}`;
  }
  function select(id) {
    if (id === st.gen) return listEl.classList.remove('open');
    st.gen = id; over = {};
    listEl.classList.remove('open');
    save(); renderList(); show();
  }

  function show() {
    const g = cur();
    if (viewer) { viewer.dispose(); viewer = null; }
    if (g.kind) treeView(g); else areaView(g);
  }

  // ---------- stromy ----------
  // zmenené hodnoty (orezané na rozsah a krok ako v treeParams), len tie, ktoré sa líšia od predvolených
  function changed() {
    const g = cur();
    if (!g || !g.kind) return {};
    const p = W.treeParams(g.kind, over), out = {};
    for (const [k, d] of Object.entries(W.TREE_PARAMS[g.kind])) if (p[k] !== d.def) out[k] = p[k];
    return out;
  }
  function treeView(g) {
    const defs = W.TREE_PARAMS[g.kind];
    const bar = h('div', { class: 'as-bar' });
    const viewEl = h('div', { class: 'as-view gn-v' });
    const stats = h('div', { class: 'muted' });
    const json = h('pre', { class: 'gn-json' });
    const sliders = h('div', { class: 'gn-sliders' });
    const copyBtn = h('button', { onclick: copy }, 'Copy parameters');
    const tools = h('div', { class: 'gn-tools' },
      h('b', null, 'Parameters'),
      h('button', { onclick: () => { over = {}; syncSliders(); changedAll(); } }, 'Reset'),
      h('button', { onclick: () => { over.seed = 1 + Math.floor(Math.random() * defs.seed.max); syncSliders(); changedAll(); } }, 'Random seed'),
      copyBtn, h('span', { class: 'muted' }, 'double-click a name to reset it'));
    mainEl.replaceChildren(bar, viewEl, stats, h('div', { class: 'gn-params' }, tools, json, sliders));

    function renderBar() {
      bar.replaceChildren(
        seg(h, SEASONS, st.season, i => { st.season = i; save(); renderBar(); rebuild(); }),
        seg(h, ROTS, st.rot, i => { st.rot = i; save(); renderBar(); rebuild(); }),
        seg(h, ['Tweaked', 'Default | Tweaked'], st.cmp ? 1 : 0, i => { st.cmp = i === 1; save(); renderBar(); rebuild(); }),
        h('button', { onclick: () => viewer && viewer.resetView() }, 'Reset view'));
    }
    const rows = {};
    for (const [k, d] of Object.entries(defs)) {
      const input = h('input', { type: 'range', min: d.min, max: d.max, step: d.step });
      const out = h('output');
      const label = h('label', { title: `${k}: default ${d.def}, ${d.min}…${d.max}, step ${d.step}` }, k);
      const row = h('div', { class: 'gn-sl' }, label, input, out);
      input.oninput = () => { over[k] = +input.value; syncRow(k); changedAll(); };
      label.ondblclick = () => { delete over[k]; syncRow(k); changedAll(); };
      rows[k] = { input, out, row };
      sliders.appendChild(row);
    }
    const fmtV = (v, d) => d.step >= 1 ? String(v) : String(+v.toFixed(2));
    function syncRow(k) {
      const p = W.treeParams(g.kind, over), d = defs[k], r = rows[k];
      r.input.value = p[k]; r.out.textContent = fmtV(p[k], d);
      r.row.classList.toggle('ch', p[k] !== d.def);
    }
    function syncSliders() { for (const k in rows) syncRow(k); }
    function changedAll() {
      const c = changed();
      json.textContent = `World3D.treeModel('${g.kind}', season, rot, ${JSON.stringify(c)})`;
      save(); schedule();
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!gone) rebuild(); }); }
    function rebuild() {
      if (!viewer) viewer = createViewer(viewEl, W);
      const c = changed(), t0 = performance.now();
      const tweaked = W.treeModel(g.kind, st.season, st.rot, c);
      const def = W.treeModel(g.kind, st.season, st.rot);
      viewer.setCells(st.cmp ? [{ model: def, season: st.season, label: 'Default' }, { model: tweaked, season: st.season, label: Object.keys(c).length ? 'Tweaked' : 'Tweaked (= default)' }]
        : [{ model: tweaked, season: st.season }]);
      const nd = modelStats(def).voxels, nt = modelStats(tweaked).voxels;
      stats.textContent = `${g.name} (${g.kind}) · ${SEASONS[st.season]} · ${Object.keys(c).length} changed · voxels: default ${nd.toLocaleString('en')}, tweaked ${nt.toLocaleString('en')} (${nt >= nd ? '+' : ''}${(nt - nd).toLocaleString('en')}) · ${(performance.now() - t0).toFixed(0)} ms`;
    }
    async function copy() {
      const text = JSON.stringify(changed());
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        // bez schránky (http bez localhostu): označíme text na ručné skopírovanie
        const r = document.createRange(); r.selectNodeContents(json); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      copyBtn.textContent = ok ? 'Copied ✓' : 'Select + Ctrl+C';
      setTimeout(() => { if (!gone) copyBtn.textContent = 'Copy parameters'; }, 1500);
    }
    renderBar(); syncSliders();
    json.textContent = `World3D.treeModel('${g.kind}', season, rot, ${JSON.stringify(changed())})`;
    rebuild();
  }

  // ---------- pôdorysy plôch ----------
  function areaView(g) {
    const seeded = g.area === 'pomedzie' || g.area === 'les';
    const seedIn = h('input', { type: 'number', class: 'gn-seed', min: 0, max: 4294967295, step: 1, value: st.seed });
    const nSel = h('select', null, [1, 2, 4, 6, 8, 12].map(n => h('option', { value: n, selected: n === st.n ? 'selected' : null }, n + (n === 1 ? ' seed' : ' seeds'))));
    const sk = g.area + 'Seed', roomSeed = ctx.snap && ctx.snap.state && Number.isInteger(ctx.snap.state[sk]) ? ctx.snap.state[sk] : null;
    const tip = h('div', { class: 'gn-tip muted' }, 'Hover a plan to inspect a tile.');
    const plans = h('div', { class: 'gn-plans' });
    const legend = h('div', { class: 'gn-legend' });
    const apply = () => { st.seed = Math.max(0, Math.min(4294967295, Math.floor(+seedIn.value) || 0)); st.n = +nSel.value; seedIn.value = st.seed; save(); draw(); };
    seedIn.onchange = apply; nSel.onchange = apply;
    const bar = h('div', { class: 'as-bar' },
      seeded ? [h('label', null, 'First seed ', seedIn), nSel,
        h('button', { onclick: () => { seedIn.value = Math.floor(Math.random() * 4294967296); apply(); } }, 'Random seeds'),
        h('button', { onclick: () => { seedIn.value = st.seed + st.n; apply(); } }, 'Next ›'),
        roomSeed != null ? h('button', { title: `${sk} of room ${ctx.room}`, onclick: () => { seedIn.value = roomSeed; nSel.value = 1; apply(); } }, `Room ${ctx.room}'s seed`) : null]
        : h('span', { class: 'muted' }, `${g.name} has a fixed layout (D.buildArea ignores the seed).`));
    mainEl.replaceChildren(h('h2', null, `${g.name} `, h('code', null, `D.buildArea('${g.area}'${seeded ? ', seed' : ''})`)), bar, tip, plans, legend);

    function draw() {
      const { w, h: ah } = D.areaSize(g.area);
      const count = seeded ? st.n : 1;
      const avail = mainEl.clientWidth || 360;
      // veľkosť políčka: aspoň 2 plány vedľa seba na mobile, inak podľa šírky
      const per = count === 1 ? 1 : Math.max(2, Math.min(count, Math.floor(avail / 190)));
      const s = Math.max(3, Math.min(count === 1 ? 14 : 10, Math.floor((avail - per * 40) / per / w)));
      const used = new Set();
      plans.replaceChildren(...Array.from({ length: count }, (_, i) => {
        const seed = (st.seed + i) >>> 0, tiles = D.buildArea(g.area, seed);
        const c = h('canvas', { width: w * s, height: ah * s });
        const x = c.getContext('2d');
        const cnt = {};
        tiles.forEach((t, k) => {
          const tx = k % w, ty = (k / w) | 0;
          cnt[t] = (cnt[t] || 0) + 1;
          if (t === 'tree' || t === 'spruce') {
            const kind = t === 'spruce' ? (W.hash(tx, ty, 11) < 0.75 ? 'smrek' : 'borovica') : W.treeKind(tx, ty, g.area);
            used.add('kind:' + kind);
            x.fillStyle = TILE[t === 'spruce' ? 'alp' : 'forest']; x.fillRect(tx * s, ty * s, s, s);
            x.fillStyle = KIND[kind]; x.beginPath(); x.arc(tx * s + s / 2, ty * s + s / 2, s * 0.42, 0, Math.PI * 2); x.fill();
            x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1; x.stroke();
          } else {
            used.add(t);
            x.fillStyle = TILE[t] || '#ff00ff'; x.fillRect(tx * s, ty * s, s, s);
          }
        });
        if (g.area === 'pomedzie' && D.MEADOW_Y) { x.strokeStyle = 'rgba(255,255,255,.6)'; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(0, D.MEADOW_Y * s + 0.5); x.lineTo(w * s, D.MEADOW_Y * s + 0.5); x.stroke(); x.setLineDash([]); }
        c.onmousemove = e => {
          const r = c.getBoundingClientRect(), tx = Math.floor((e.clientX - r.left) / r.width * w), ty = Math.floor((e.clientY - r.top) / r.height * ah);
          if (tx < 0 || ty < 0 || tx >= w || ty >= ah) return;
          const t = tiles[ty * w + tx];
          tip.textContent = `seed ${seed} · tile ${tx},${ty}: ${t}${t === 'tree' ? ' (' + W.treeKind(tx, ty, g.area) + ')' : ''}`;
        };
        const sum = ['tree', 'bush', 'fern', 'water', 'boulder', 'path'].filter(k => cnt[k]).map(k => `${cnt[k]} ${k}`).join(' · ');
        return h('div', { class: 'gn-plan' }, h('b', null, seeded ? `seed ${seed}` : g.name), c, h('small', null, sum));
      }));
      legend.replaceChildren(...[...used].sort().map(k => {
        const kind = k.startsWith('kind:') ? k.slice(5) : null;
        return h('span', null, h('span', { class: 'as-sw', style: `background:${kind ? KIND[kind] : TILE[k] || '#ff00ff'};${kind ? 'border-radius:50%' : ''}` }), kind ? `tree: ${(W.TREE_NAMES && W.TREE_NAMES[kind]) || kind}` : k);
      }));
    }
    draw();
  }

  return {
    update(c) { ctx = c; },
    unmount() {
      gone = true;
      if (raf) cancelAnimationFrame(raf);
      if (viewer) viewer.dispose();
      viewer = null;
      document.body.classList.remove('dbg-wide');
    }
  };
}
