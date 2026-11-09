// Záložka Assets v /debug (#79): zoznam všetkých jemných modelov z shared/world3d.js (World3D.FINE_MODELS),
// 3D prehliadač s prepínaním obdobia a otočenia, mriežka 4 obdobia × 4 otočenia, údaje o modeli
// a 2D galéria kvetov z art.js (druh × štádium rastu). Len zobrazuje, hru nemení.
import { createViewer, loadWorld3D, loadArt, injectCss, modelStats, matName } from '/debug/tabs/modelview.mjs';

export const CSS = `
body.dbg-wide aside { display: none; }
.as { display: flex; gap: 14px; height: 100%; min-height: 0; }
.as-list { width: 230px; flex: none; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.as-list input[type=search] { width: 100%; }
.as-pick { display: none; text-align: left; }
.as-items { overflow-y: auto; flex: 1; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 4px; }
.as-items h4 { margin: 8px 6px 2px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.as-items button { display: flex; justify-content: space-between; gap: 6px; width: 100%; border: none; background: none; text-align: left; padding: 4px 8px; border-radius: 6px; }
.as-items button:hover { background: var(--bg); }
.as-items button.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.as-items button small { color: var(--muted); font-weight: 400; font-family: var(--mono); font-size: 11px; }
.as-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.as-bar { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.as-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.as-seg button { border: none; border-radius: 0; padding: 3px 9px; }
.as-seg button + button { border-left: 1px solid var(--line); }
.as-seg button.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.as-seg button:disabled { opacity: .4; cursor: default; }
.as-view { height: min(62vh, 620px); min-height: 260px; }
.as-view.grid { height: min(82vh, 900px); }
.as-info { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: baseline; }
.as-info h2 { margin: 0; }
.as-kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.as-kv div { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 9px; }
.as-kv small { display: block; color: var(--muted); }
.as-mats { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12.5px; }
.as-mats span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.as-sw { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(0,0,0,.25); display: inline-block; }
.as-gal { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.as-gal table { width: auto; }
.as-gal td, .as-gal th { padding: 3px 6px; text-align: center; vertical-align: middle; }
.as-gal td:first-child { text-align: left; }
.as-gal canvas { display: block; width: 56px; height: 70px; border-radius: 6px; }
.as-err { color: #c0392b; padding: 20px; }
@media (max-width: 700px) {
  .as { flex-direction: column; height: auto; }
  .as-list { width: auto; }
  .as-pick { display: block; width: 100%; }
  .as-list:not(.open) .as-items, .as-list:not(.open) input[type=search] { display: none; }
  .as-items { max-height: 45vh; }
  .as-view { height: 58vh; min-height: 300px; }
  .as-view.grid { height: 78vh; }
}
`;
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const ROTS = ['0°', '90°', '180°', '270°'];

// Prepínač s tlačidlami (jedno je zapnuté)
export function seg(h, labels, value, onPick, disabled) {
  return h('div', { class: 'as-seg' }, labels.map((l, i) => {
    const b = h('button', { class: i === value ? 'on' : null, onclick: () => onPick(i) }, l);
    if (disabled) b.disabled = true;
    return b;
  }));
}
const intParam = (ctx, k, def, max) => { const v = parseInt(ctx.param(k), 10); return Number.isInteger(v) && v >= 0 && v <= max ? v : def; };

export function mount(el, ctx) {
  const { h } = ctx;
  injectCss('tab-assets-css', CSS);
  document.body.classList.add('dbg-wide');
  let W = null, Art = null, viewer = null, gone = false, q = '';
  const st = {
    model: ctx.param('model') || 'house',
    season: intParam(ctx, 'season', 1, 3),
    rot: intParam(ctx, 'rot', 0, 3),
    grid: ctx.param('grid') === '1'
  };
  const root = h('div', { class: 'as' });
  el.replaceChildren(root, h('div', { class: 'muted', style: 'padding:20px' }, 'Loading models…'));

  Promise.all([loadWorld3D(), loadArt().catch(() => null)]).then(([w, a]) => {
    if (gone) return;
    W = w; Art = a;
    if (!W.FINE_MODELS) throw new Error('World3D.FINE_MODELS is missing');
    if (st.model !== 'flowers' && !W.FINE_MODELS.some(m => m.id === st.model)) st.model = W.FINE_MODELS[0].id;
    el.replaceChildren(root);
    build();
  }).catch(e => { if (!gone) el.replaceChildren(h('div', { class: 'as-err' }, 'Cannot load models: ' + e.message)); });

  const listEl = h('div', { class: 'as-list' });
  const mainEl = h('div', { class: 'as-main' });
  const barEl = h('div', { class: 'as-bar' });
  const viewEl = h('div', { class: 'as-view' });
  const infoEl = h('div');
  const galEl = h('div');
  root.append(listEl, mainEl);
  mainEl.append(barEl, viewEl, infoEl, galEl);

  function save() {
    ctx.setParam('model', st.model); ctx.setParam('season', st.season); ctx.setParam('rot', st.rot); ctx.setParam('grid', st.grid ? 1 : null);
  }
  const entry = () => W.FINE_MODELS.find(m => m.id === st.model);

  // ---------- zoznam ----------
  const search = h('input', { type: 'search', placeholder: 'Filter models…', autocomplete: 'off' });
  search.oninput = () => { q = search.value.trim().toLowerCase(); renderList(); };
  const pick = h('button', { class: 'as-pick', onclick: () => listEl.classList.toggle('open') });
  const items = h('div', { class: 'as-items' });
  listEl.append(pick, search, items);
  function renderList() {
    const all = W.FINE_MODELS.map(m => ({ id: m.id, name: m.name, group: m.group, sub: m.kind || m.id }))
      .concat([{ id: 'flowers', name: 'Flower gallery', group: 'Flowers (2D, art.js)', sub: Object.keys(ctx.D.SPECIES).length + ' species' }]);
    const list = all.filter(m => !q || (m.name + ' ' + m.id + ' ' + m.group + ' ' + m.sub).toLowerCase().includes(q));
    const groups = [...new Set(list.map(m => m.group))];
    items.replaceChildren(...groups.flatMap(g => [h('h4', null, g), ...list.filter(m => m.group === g).map(m =>
      h('button', { class: m.id === st.model ? 'on' : null, onclick: () => { st.model = m.id; listEl.classList.remove('open'); save(); renderList(); show(); } }, m.name, h('small', null, m.sub)))]));
    if (!list.length) items.appendChild(h('div', { class: 'muted', style: 'padding:8px' }, 'No match'));
    const cur = all.find(m => m.id === st.model);
    pick.textContent = `▾ ${cur ? cur.name : st.model} (${W.FINE_MODELS.length} models)`;
  }

  // ---------- ovládanie ----------
  function renderBar() {
    const flowers = st.model === 'flowers';
    barEl.replaceChildren(
      seg(h, SEASONS, st.grid ? -1 : st.season, i => { st.season = i; st.grid = false; save(); renderBar(); show(); }, flowers),
      seg(h, ROTS, st.grid ? -1 : st.rot, i => { st.rot = i; st.grid = false; save(); renderBar(); show(); }, flowers),
      seg(h, ['Single', 'Grid 4×4'], st.grid ? 1 : 0, i => { st.grid = i === 1; save(); renderBar(); show(); }, flowers),
      h('button', { onclick: () => viewer && viewer.resetView(), disabled: flowers ? 'disabled' : null }, 'Reset view'));
  }

  // ---------- zobrazenie ----------
  function show() {
    if (st.model === 'flowers') {
      if (viewer) { viewer.dispose(); viewer = null; }
      viewEl.style.display = 'none';
      infoEl.replaceChildren();
      galEl.replaceChildren(...flowerGallery());
      return;
    }
    viewEl.style.display = '';
    viewEl.classList.toggle('grid', st.grid);
    galEl.replaceChildren();
    const e = entry();
    if (!viewer) viewer = createViewer(viewEl, W);
    const t0 = performance.now();
    const cells = st.grid
      ? [0, 1, 2, 3].flatMap(se => [0, 1, 2, 3].map(r => ({ model: e.build(se, r), season: se, label: `${SEASONS[se]} ${ROTS[r]}` })))
      : [{ model: e.build(st.season, st.rot), season: st.season }];
    viewer.setCells(cells, { cols: st.grid ? 4 : 0 });
    info(e, cells[st.grid ? st.season * 4 + st.rot : 0].model, performance.now() - t0);
  }
  function info(e, f, ms) {
    const s = modelStats(f), F = W.FINE, tw = (f.sx - 2 * W.FM) / F, td = (f.sz - 2 * W.FM) / F;
    let top = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i]) { const y = Math.floor(i / f.sx) % f.sy; if (y + 1 > top) top = y + 1; }
    const kv = (label, v, sub) => h('div', null, h('small', null, label), h('b', null, v), sub ? h('small', null, sub) : null);
    const se = st.season;
    infoEl.replaceChildren(
      h('div', { class: 'as-info' }, h('h2', null, e.name), h('span', null, 'builder ', h('code', null, e.fn)),
        h('span', { class: 'muted' }, `${e.group} · id ${e.id}`)),
      h('div', { class: 'as-kv', style: 'margin-top:8px' },
        kv('Size (voxels)', `${f.sx} × ${f.sy} × ${f.sz}`, `x × y × z, ${F} voxels = 1 tile`),
        kv('Footprint', `${tw} × ${td} tiles`, `+ ${W.FM} voxel margin each side`),
        kv('Height', `${top} voxels`, `${(top / F).toFixed(2)} blocks`),
        kv('Voxels', s.voxels.toLocaleString('en'), `${(100 * s.voxels / f.data.length).toFixed(1)} % of the box`),
        kv('Materials', String(s.mats.length), SEASONS[se] + ' colours'),
        kv('Build + mesh', `${ms.toFixed(0)} ms`, st.grid ? '16 models' : '1 model')),
      h('h3', null, `Materials (${SEASONS[se]})`),
      h('div', { class: 'as-mats' }, s.mats.map(([m, n]) => h('span', { title: `material ${m}: ${W.colorOf(m, se)}${W.EMISSIVE[m] ? ', glows at night' : ''}` },
        h('span', { class: 'as-sw', style: `background:${W.colorOf(m, se)}` }), `${matName(W, m)}${W.EMISSIVE[m] ? ' ✦' : ''}`, h('span', { class: 'muted' }, n.toLocaleString('en'))))));
  }

  // 2D galéria kvetov z art.js: riadok = druh, stĺpce = štádiá rastu (+ v noci, odkvitá, zvädnutá)
  function flowerGallery() {
    if (!Art) return [h('div', { class: 'as-err' }, 'Cannot load /art.js')];
    const D = ctx.D, cols = [['Seed', 0, {}], ['Sprout', 1, {}], ['Bud', 2, {}], ['Bloom', 3, {}], ['Night', 3, { night: true }], ['Wilting', 3, { wilting: true }], ['Dead', 2, { dead: true }]];
    const cell = (key, stage, o) => {
      const c = h('canvas', { width: 112, height: 140 });
      const g = c.getContext('2d');
      g.fillStyle = o.night ? '#1d2440' : '#cfe7b8'; g.fillRect(0, 0, 112, 140);
      g.fillStyle = o.night ? '#2a3350' : '#a07850'; g.fillRect(0, 118, 112, 22);
      try { Art.plant(g, key, stage, 56, 124, 100, 0, o); } catch (e) { g.fillStyle = '#c0392b'; g.fillText('error', 10, 20); }
      return c;
    };
    return [
      h('h2', null, 'Flowers (art.js)'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Art.plant(ctx, species, stage, x, y, size, t, opts) – the same drawing the 3D game uses as plant sprites.'),
      h('div', { class: 'as-gal' }, h('table', null,
        h('tr', null, h('th', null, 'Species'), cols.map(c => h('th', null, c[0]))),
        Object.keys(D.SPECIES).map(k => h('tr', null,
          h('td', null, h('b', null, D.SPECIES[k].name), h('br'), h('small', { class: 'muted mono' }, `${k} · ${D.SPECIES[k].shape}${D.SPECIES[k].magic ? ' · magic' : ''}`)),
          cols.map(([, stage, o]) => h('td', null, cell(k, stage, o)))))))
    ];
  }

  function build() { renderList(); renderBar(); show(); }

  return {
    update() { /* modely nezávisia od sveta ani plochy */ },
    unmount() {
      gone = true;
      if (viewer) viewer.dispose();
      viewer = null;
      document.body.classList.remove('dbg-wide');
    }
  };
}
