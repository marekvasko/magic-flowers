// Záložka Assets v /debug (#79): zoznam všetkých jemných modelov z shared/world3d.ts (World3D.FINE_MODELS),
// 3D prehliadač s prepínaním obdobia a otočenia, mriežka 4 obdobia × 4 otočenia, údaje o modeli
// a 2D galéria kvetov z art.ts (druh × štádium rastu). Len zobrazuje, hru nemení.
import { createViewer, loadWorld3D, loadArt, injectCss, modelStats, matName } from './modelview.ts';
import type { Viewer } from './modelview.ts';
import type * as World3D from '../../shared/world3d.ts';
import type { FineModel, FineModelEntry } from '../../shared/world3d.ts';
import type { Art as ArtApi, BoatOpts, PlantOpts } from '../../client/art.ts';
// galérie 2D kresieb z art.ts namiesto 3D modelu
const GALLERIES: readonly string[] = ['flowers', 'vehicles', 'boat'];
import type { SpeciesId } from '../../shared/data.ts';
import { keys, must } from '../../shared/util.ts';
import type { TabCtx, TabInstance, h as H } from '../ui.ts';
import { errText } from '../ui.ts';
import { drawTow, drawVehicle } from '../../client/vehicleart.ts';

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
export const SEASONS: readonly string[] = ['Spring', 'Summer', 'Autumn', 'Winter'];
export const ROTS: readonly string[] = ['0°', '90°', '180°', '270°'];

// Prepínač s tlačidlami (jedno je zapnuté)
export function seg(h: typeof H, labels: readonly string[], value: number, onPick: (i: number) => void, disabled?: boolean): HTMLElement {
  return h('div', { class: 'as-seg' }, labels.map((l, i) => {
    const b = h('button', { class: i === value ? 'on' : null, onclick: () => { onPick(i); } }, l);
    if (disabled) b.disabled = true;
    return b;
  }));
}
const intParam = (ctx: Pick<TabCtx, 'param'>, k: string, def: number, max: number): number => { const v = parseInt(ctx.param(k) ?? '', 10); return Number.isInteger(v) && v >= 0 && v <= max ? v : def; };

export function mount(el: HTMLElement, ctx: TabCtx): TabInstance {
  const { h } = ctx;
  injectCss('tab-assets-css', CSS);
  document.body.classList.add('dbg-wide');
  let W: typeof World3D | null = null, Art: typeof ArtApi | null = null, viewer: Viewer | null = null, gone = false, q = '';
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
    if (!GALLERIES.includes(st.model) && !W.FINE_MODELS.some(m => m.id === st.model)) st.model = must(W.FINE_MODELS[0]).id;
    el.replaceChildren(root);
    build(w);
  }).catch((e: unknown) => { if (!gone) el.replaceChildren(h('div', { class: 'as-err' }, 'Cannot load models: ' + errText(e))); });

  const listEl = h('div', { class: 'as-list' });
  const mainEl = h('div', { class: 'as-main' });
  const barEl = h('div', { class: 'as-bar' });
  const viewEl = h('div', { class: 'as-view' });
  const infoEl = h('div');
  const galEl = h('div');
  root.append(listEl, mainEl);
  mainEl.append(barEl, viewEl, infoEl, galEl);

  function save(): void {
    ctx.setParam('model', st.model); ctx.setParam('season', st.season); ctx.setParam('rot', st.rot); ctx.setParam('grid', st.grid ? 1 : null);
  }
  const entry = (W: typeof World3D): FineModelEntry => W.FINE_MODELS.find(m => m.id === st.model) ?? must(W.FINE_MODELS[0]);

  // ---------- zoznam ----------
  const search = h('input', { type: 'search', placeholder: 'Filter models…', autocomplete: 'off' });
  search.oninput = () => { q = search.value.trim().toLowerCase(); if (W) renderList(W); };
  const pick = h('button', { class: 'as-pick', onclick: () => { listEl.classList.toggle('open'); } });
  const items = h('div', { class: 'as-items' });
  listEl.append(pick, search, items);
  function renderList(W: typeof World3D): void {
    const all = W.FINE_MODELS.map(m => ({ id: m.id, name: m.name, group: m.group, sub: String(m.kind || m.id) }))
      .concat([{ id: 'flowers', name: 'Flower gallery', group: 'Flowers (2D, art.js)', sub: Object.keys(ctx.D.SPECIES).length + ' species' },
        { id: 'vehicles', name: 'Fúrik a sane, 8 smerov', group: 'Vehicles (2D, vehicleart.ts)', sub: '#158' },
{ id: 'boat', name: 'Loďka (8 + 8 pohľadov)', group: 'Boat (2D, art.ts)', sub: '16 views' }]);
    const list = all.filter(m => !q || (m.name + ' ' + m.id + ' ' + m.group + ' ' + m.sub).toLowerCase().includes(q));
    const groups = [...new Set(list.map(m => m.group))];
    items.replaceChildren(...groups.flatMap(g => [h('h4', null, g), ...list.filter(m => m.group === g).map(m =>
      h('button', { class: m.id === st.model ? 'on' : null, onclick: () => { st.model = m.id; listEl.classList.remove('open'); save(); renderList(W); show(W); } }, m.name, h('small', null, m.sub)))]));
    if (!list.length) items.appendChild(h('div', { class: 'muted', style: 'padding:8px' }, 'No match'));
    const cur = all.find(m => m.id === st.model);
    pick.textContent = `▾ ${cur ? cur.name : st.model} (${W.FINE_MODELS.length} models)`;
  }

  // ---------- ovládanie ----------
  function renderBar(W: typeof World3D): void {
    const flowers = GALLERIES.includes(st.model); // 2D galérie: bez obdobia a otočenia
    barEl.replaceChildren(
      seg(h, SEASONS, st.grid ? -1 : st.season, i => { st.season = i; st.grid = false; save(); renderBar(W); show(W); }, flowers),
      seg(h, ROTS, st.grid ? -1 : st.rot, i => { st.rot = i; st.grid = false; save(); renderBar(W); show(W); }, flowers),
      seg(h, ['Single', 'Grid 4×4'], st.grid ? 1 : 0, i => { st.grid = i === 1; save(); renderBar(W); show(W); }, flowers),
      h('button', { onclick: () => { viewer?.resetView(); }, disabled: flowers ? 'disabled' : null }, 'Reset view'));
  }

  // ---------- zobrazenie ----------
  function show(W: typeof World3D): void {
    if (GALLERIES.includes(st.model)) {
      if (viewer) { viewer.dispose(); viewer = null; }
      viewEl.style.display = 'none';
      infoEl.replaceChildren();
      galEl.replaceChildren(...(st.model === 'boat' ? boatGallery() : st.model === 'vehicles' ? vehicleGallery() : flowerGallery()));
      return;
    }
    viewEl.style.display = '';
    viewEl.classList.toggle('grid', st.grid);
    galEl.replaceChildren();
    const e = entry(W);
    viewer ??= createViewer(viewEl, W);
    const t0 = performance.now();
    const cells = st.grid
      ? [0, 1, 2, 3].flatMap(se => [0, 1, 2, 3].map(r => ({ model: e.build(se, r), season: se, label: `${SEASONS[se]} ${ROTS[r]}` })))
      : [{ model: e.build(st.season, st.rot), season: st.season }];
    viewer.setCells(cells, { cols: st.grid ? 4 : 0 });
    info(W, e, must(cells[st.grid ? st.season * 4 + st.rot : 0]).model, performance.now() - t0);
  }
  function info(W: typeof World3D, e: FineModelEntry, f: FineModel, ms: number): void {
    const s = modelStats(f), F = W.FINE, tw = (f.sx - 2 * W.FM) / F, td = (f.sz - 2 * W.FM) / F;
    let top = 0;
    for (let i = 0; i < f.data.length; i++) if (f.data[i]) { const y = Math.floor(i / f.sx) % f.sy; if (y + 1 > top) top = y + 1; }
    const kv = (label: string, v: string, sub: string | null): HTMLElement => h('div', null, h('small', null, label), h('b', null, v), sub ? h('small', null, sub) : null);
    const se = st.season;
    infoEl.replaceChildren(
      h('div', { class: 'as-info' }, h('h2', null, e.name), h('span', null, 'builder ', h('code', null, e.fn)),
        h('span', { class: 'muted' }, `${e.group} · id ${e.id}`)),
      h('div', { class: 'as-kv', style: 'margin-top:8px' },
        kv('Size (voxels)', `${f.sx} × ${f.sy} × ${f.sz}`, `x × y × z, ${F} voxels = 1 tile`),
        kv('Footprint', `${tw} × ${td} tiles`, `+ ${W.FM} voxel margin each side`),
        kv('Height', `${top} voxels`, `${(top / F).toFixed(2)} blocks`),
        kv('Voxels', s.voxels.toLocaleString('en'), `${(100 * s.voxels / f.data.length).toFixed(1)} % of the box`),
        kv('Materials', String(s.mats.length), (SEASONS[se] ?? '') + ' colours'),
        kv('Build + mesh', `${ms.toFixed(0)} ms`, st.grid ? '16 models' : '1 model')),
      h('h3', null, `Materials (${SEASONS[se] ?? ''})`),
      h('div', { class: 'as-mats' }, s.mats.map(([m, n]) => h('span', { title: `material ${m}: ${W.colorOf(m, se)}${W.EMISSIVE[m] ? ', glows at night' : ''}` },
        h('span', { class: 'as-sw', style: `background:${W.colorOf(m, se)}` }), `${matName(W, m)}${W.EMISSIVE[m] ? ' ✦' : ''}`, h('span', { class: 'muted' }, n.toLocaleString('en'))))));
  }

  // 2D galéria kvetov z art.js: riadok = druh, stĺpce = štádiá rastu (+ v noci, odkvitá, zvädnutá)
  function flowerGallery(): HTMLElement[] {
    const A = Art;
    if (!A) return [h('div', { class: 'as-err' }, 'Cannot load the drawings (art.ts)')];
    const D = ctx.D, cols: readonly (readonly [string, number, PlantOpts])[] = [['Seed', 0, {}], ['Sprout', 1, {}], ['Bud', 2, {}], ['Bloom', 3, {}], ['Night', 3, { night: true }], ['Wilting', 3, { wilting: true }], ['Dead', 2, { dead: true }]];
    const cell = (key: SpeciesId, stage: number, o: PlantOpts): HTMLCanvasElement => {
      const c = h('canvas', { width: 112, height: 140 });
      const g = must(c.getContext('2d') ?? undefined);
      g.fillStyle = o.night ? '#1d2440' : '#cfe7b8'; g.fillRect(0, 0, 112, 140);
      g.fillStyle = o.night ? '#2a3350' : '#a07850'; g.fillRect(0, 118, 112, 22);
      try { A.plant(g, key, stage, 56, 124, 100, 0, o); } catch { g.fillStyle = '#c0392b'; g.fillText('error', 10, 20); }
      return c;
    };
    return [
      h('h2', null, 'Flowers (art.ts)'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Art.plant(ctx, species, stage, x, y, size, t, opts) – the same drawing the 3D game uses as plant sprites.'),
      h('div', { class: 'as-gal' }, h('table', null,
        h('tr', null, h('th', null, 'Species'), cols.map(c => h('th', null, c[0]))),
        keys(D.SPECIES).map(k => h('tr', null,
          h('td', null, h('b', null, D.SPECIES[k].name), h('br'), h('small', { class: 'muted mono' }, `${k} · ${D.SPECIES[k].shape}${D.SPECIES[k].magic ? ' · magic' : ''}`)),
          cols.map(([, stage, o]) => h('td', null, cell(k, stage, o)))))))
    ];
  }

  // Fúrik a sane (#158): 8 smerov ako postavička (art.ts char), prázdne, s ľadom a so spolujazdcom; vedľa hráč na porovnanie
  function vehicleGallery(): HTMLElement[] {
    const A = Art;
    const DIRS = ['0 down', '1 left', '2 right', '3 up', '4 down-left', '5 down-right', '6 up-left', '7 up-right'];
    const rows: readonly (readonly ['furik' | 'sane', number, boolean, string])[] = [
      ['furik', 0, false, 'Fúrik, empty'], ['furik', 3, false, 'Fúrik, 3 ice'], ['furik', 6, false, 'Fúrik, 6 ice'], ['furik', 2, true, 'Fúrik, passenger + 2 ice'],
      ['sane', 0, false, 'Sane, empty'], ['sane', 3, false, 'Sane, 3 ice'], ['sane', 6, false, 'Sane, 6 ice'], ['sane', 2, true, 'Sane, passenger + 2 ice']];
    const tow = (dir: number, phase: number): HTMLCanvasElement => {
      const c = h('canvas', { width: 260, height: 260 });
      const g = must(c.getContext('2d') ?? undefined);
      g.fillStyle = '#eef4f6'; g.fillRect(0, 0, 260, 260);
      drawTow(g, 130, 165, 100, dir, 3, { shirt: '#4a90d9', hair: '#5b3a1a', hat: true }, phase);
      return c;
    };
    const cell = (id: 'furik' | 'sane', ice: number, rider: boolean, dir: number, player: boolean): HTMLCanvasElement => {
      const c = h('canvas', { width: player ? 200 : 128, height: 160 });
      const g = must(c.getContext('2d') ?? undefined);
      g.fillStyle = '#cfe7b8'; g.fillRect(0, 0, c.width, 160);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(64, 124, 44, 14, 0, 0, 7); g.fill();
      drawVehicle(g, id, 64, 124, 100, dir, ice, rider ? { look: { shirt: '#e05a5a', hair: '#e8c36a', hat: false } } : null);
      if (player && A) A.char(g, 160, 128, 100, { shirt: '#4a90d9', hair: '#5b3a1a', hat: true }, 0, 0, {}); // hráč na porovnanie veľkosti
      return c;
    };
    return [
      h('h2', null, 'Fúrik a sane (vehicleart.ts)'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'drawVehicle(ctx, id, x, y, size, dir, ice, rider) – the same 2D sprite the 3D game shows (100 px = 1 block, like the player), the Dielňa dialog, the hotbar and toasts. dir = the player sprite\'s 8 directions.'),
      h('div', { class: 'as-gal' }, h('table', null,
        h('tr', null, h('th', null, ''), DIRS.map(d => h('th', null, d)), h('th', null, 'size vs player')),
        rows.map(([id, ice, rider, label]) => h('tr', null, h('td', null, h('b', null, label)),
          DIRS.map((_, dir) => h('td', null, cell(id, ice, rider, dir, false))), h('td', null, cell(id, ice, rider, 5, true)))))),
      h('h2', { style: 'margin-top:16px' }, 'Sane ťahané hráčom (lano v ruke, vždy za hráčom)'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'drawTow – the rope ends in the hand that Art.char draws (Art.handAt, with the walking arm swing) and is always drawn behind the player. Two walk phases per direction.'),
      h('div', { class: 'as-gal' }, h('table', null,
        h('tr', null, h('th', null, ''), DIRS.map(d => h('th', null, d))),
        [0, 1.4].map(phase => h('tr', null, h('td', null, h('b', null, `phase ${String(phase)}`)), DIRS.map((_, dir) => h('td', null, tow(dir, phase)))))))
    ];
  }

  // 2D loďka z art.ts (#160): 8 smerov na vode (prázdna a s posádkou) a 8 smerov prevrátená so snehom (zima na móle)
  function boatGallery(): HTMLElement[] {
    const A = Art;
    if (!A) return [h('div', { class: 'as-err' }, 'Cannot load the drawings (art.ts)')];
    const DIRS = ['0 down', '1 left', '2 right', '3 up', '4 down-left', '5 down-right', '6 up-left', '7 up-right'];
    const crew = [{ shirt: '#e05a5a', hair: '#5b3a1a', hat: true }, { shirt: '#4a90d9', hair: '#e8c36a', hat: false }];
    const cell = (dir: number, o: BoatOpts, bg: string): HTMLCanvasElement => {
      const c = h('canvas', { width: 220, height: 170 });
      const g = must(c.getContext('2d') ?? undefined);
      g.fillStyle = bg; g.fillRect(0, 0, 220, 170);
      try { A.boat(g, 110, 112, 100, dir, o); } catch { g.fillStyle = '#c0392b'; g.fillText('error', 10, 20); }
      return c;
    };
    const rows: readonly (readonly [string, BoatOpts, string])[] = [['On the water', {}, '#4aa3df'], ['With the crew (rower, passenger)', { crew }, '#4aa3df'], ['Flipped on the dock, winter (snow)', { flip: true, snow: true }, '#c9a77a']];
    return [
      h('h2', null, 'Boat (art.ts)'),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Art.boat(ctx, x, y, pixelsPerBlock, dir, { flip, snow, crew, t, rowing }) – the sprite the 3D game shows for the boat (src/client/boat3d.ts) and the Upgrade-menu icon. Directions as Art.char: 0 down, 1 left, 2 right, 3 up, 4–7 diagonals; the game picks one from the boat heading and the camera.'),
      h('div', { class: 'as-gal' }, h('table', null,
        h('tr', null, h('th', null, 'View'), DIRS.map(d => h('th', null, d))),
        rows.map(([label, o, bg]) => h('tr', null, h('td', null, h('b', null, label)), [0, 1, 2, 3, 4, 5, 6, 7].map(d => h('td', null, cell(d, o, bg)))))))
    ];
  }

  function build(W: typeof World3D): void { renderList(W); renderBar(W); show(W); }


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
