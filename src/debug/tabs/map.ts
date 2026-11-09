// Záložka Mapa (#77): pôdorys plochy na plátne – výška zeme, chodníky, objekty, prechody, mriežka,
// inšpektor políčka a štatistiky. Zdroj: semienko (hocijaké) alebo vybraný svet (jeho semienko, pôda, ľad, hráči).
// Výpočty sú v map-core.mjs (bez DOM, testované), tu je len ovládanie a kreslenie.
import { kindOf, isSeeded, randomSeed, parseSeed, buildTiles, heightBlocks, arrivals, playersOn, areaStats, tileInfo } from './map-core.mjs';

const CSS = `
.map-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 8px; }
.map-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; background: var(--panel); }
.map-seg button { border: none; border-radius: 0; padding: 5px 11px; background: none; }
.map-seg button + button { border-left: 1px solid var(--line); }
.map-seg button.on { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.map-seg button:disabled { color: var(--muted); cursor: default; opacity: .6; }
.map-bar label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.map-seed input { width: 112px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 7px; font-family: var(--mono); }
.map-seed input:disabled { color: var(--muted); }
.map-layers { display: inline-flex; flex-wrap: wrap; gap: 4px 12px; }
.map-note { margin: 0 0 10px; }
.map-grid { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 14px; align-items: start; }
.map-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; display: flex; justify-content: center; min-width: 0; }
.map-wrap canvas { display: block; touch-action: manipulation; cursor: crosshair; border-radius: 2px; }
.map-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.map-box { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.map-box h4 { margin: 0 0 8px; font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; justify-content: space-between; gap: 6px; }
.map-box h4 span { text-transform: none; letter-spacing: 0; font-weight: 400; }
.map-scale { display: flex; height: 12px; border-radius: 3px; overflow: hidden; }
.map-scale i { flex: 1; }
.map-ticks { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 11.5px; color: var(--muted); margin: 3px 0 6px; }
.map-box p { margin: 0; font-size: 12.5px; color: var(--muted); }
.map-leg { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
.map-leg li { display: flex; align-items: center; gap: 8px; }
.map-leg canvas { flex: none; }
.map-dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; margin: 0; font-size: 13px; }
.map-dl dt { color: var(--muted); }
.map-dl dd { margin: 0; font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
@media (max-width: 900px) { .map-grid { grid-template-columns: minmax(0, 1fr); } .map-wrap { padding: 8px; } }
`;

// farby mapy (obrázok, rovnaký vo svetlej aj tmavej téme)
const COL = {
  low: [20, 36, 26], high: [126, 186, 128], flat: '#26412c', path: '#e3a03f', clearing: 'rgba(222, 200, 92, .62)',
  water: '#4f8fd0', hole: '#16304d', glacier: '#d6ecf7', obj: '#0a100b', gate: '#e2664b', soil: '#7a5432', soilWet: '#563820',
  player: '#ff5ca8', hover: '#ffffff', sel: '#ffd84a', grid: 'rgba(255,255,255,.10)', grid5: 'rgba(255,255,255,.24)'
};
const MAX_H = 4, STEPS = 9; // stupnica výšky 0–4 bloky po pol bloku
function heightColor(b) {
  const k = Math.max(0, Math.min(1, Math.round(b * 2) / 2 / MAX_H));
  const c = COL.low.map((v, i) => Math.round(v + (COL.high[i] - v) * k));
  return `rgb(${c})`;
}
const LAYERS = [
  { id: 'h', label: 'Heights' }, { id: 'p', label: 'Paths' }, { id: 'o', label: 'Objects' }, { id: 'g', label: 'Grid' },
  { id: 'b', label: 'Beds', room: true }, { id: 'u', label: 'Players', room: true }
];
const DEFAULT_LAYERS = 'hpobu';
const f2 = n => n.toFixed(2).replace(/\.?0+$/, '') || '0';

export function mount(el, ctx0) {
  let ctx = ctx0;
  const { h, D } = ctx;
  if (!document.getElementById('tab-map-css')) document.head.appendChild(h('style', { id: 'tab-map-css' }, CSS));

  // stav záložky (seed, zdroj a vrstvy sú v adrese)
  let seed = parseSeed(ctx.param('mapseed'));
  if (seed == null) { seed = randomSeed(); ctx.setParam('mapseed', seed); }
  let layers = ctx.param('maplayers');
  if (layers == null) layers = DEFAULT_LAYERS;
  let map = null, players = [], hover = null, sel = null, T = 16, shownArea = null;
  const on = id => layers.includes(id);
  const source = () => {
    const s = ctx.param('mapsrc');
    return ctx.room && (s === 'room' || s == null) ? 'room' : 'seed';
  };

  // ---------- ovládanie ----------
  const areaSeg = h('div', { class: 'map-seg', role: 'group', 'aria-label': 'Area' });
  const srcSeg = h('div', { class: 'map-seg', role: 'group', 'aria-label': 'Source' });
  const seedIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Seed' });
  const newSeed = h('button', { onclick: () => { seed = randomSeed(); ctx.setParam('mapseed', seed); ctx.setParam('mapsrc', 'seed'); rebuild(true); } }, 'New seed');
  const layerBox = h('div', { class: 'map-layers' });
  const note = h('div', { class: 'map-note muted' });
  const canvas = h('canvas', { 'aria-label': 'Area map' });
  const wrap = h('div', { class: 'map-wrap' }, canvas);
  const legendH = h('div', { class: 'map-box' });
  const legendL = h('div', { class: 'map-box' });
  const tileBox = h('div', { class: 'map-box' });
  const areaBox = h('div', { class: 'map-box' });
  el.append(
    h('div', { class: 'map-bar' }, areaSeg, srcSeg, h('label', { class: 'map-seed' }, 'Seed', seedIn), newSeed, layerBox),
    note,
    h('div', { class: 'map-grid' }, wrap, h('div', { class: 'map-side' }, legendH, legendL, tileBox, areaBox)));

  seedIn.addEventListener('change', () => {
    const v = parseSeed(seedIn.value);
    if (v == null) { seedIn.value = map && map.seed != null ? map.seed : seed; return; }
    seed = v; ctx.setParam('mapseed', seed); ctx.setParam('mapsrc', 'seed'); rebuild(true);
  });
  seedIn.addEventListener('keydown', e => { if (e.key === 'Enter') seedIn.blur(); });

  function renderBar() {
    areaSeg.replaceChildren(...D.AREAS.map(a => h('button', { class: a === ctx.area ? 'on' : null, onclick: () => ctx.setArea(a) }, D.AREA_NAMES[a] || a)));
    const src = source();
    srcSeg.replaceChildren(
      h('button', { class: src === 'room' ? 'on' : null, disabled: ctx.room ? null : 'disabled', title: ctx.room ? `The real map of room ${ctx.room}` : 'Pick a room on the left',
        onclick: () => { ctx.setParam('mapsrc', 'room'); rebuild(true); } }, 'Room'),
      h('button', { class: src === 'seed' ? 'on' : null, title: 'Any seed, without a room', onclick: () => { ctx.setParam('mapsrc', 'seed'); rebuild(true); } }, 'Seed'));
    const seeded = isSeeded(D, ctx.area);
    seedIn.disabled = !seeded;
    newSeed.disabled = !seeded;
    if (document.activeElement !== seedIn) seedIn.value = !seeded ? '–' : map && map.seed != null ? map.seed : seed;
    layerBox.replaceChildren(...LAYERS.filter(l => !l.room || src === 'room').map(l => {
      const cb = h('input', { type: 'checkbox', checked: on(l.id) ? 'checked' : null });
      cb.addEventListener('change', () => {
        layers = LAYERS.map(x => x.id).filter(id => id === l.id ? cb.checked : on(id)).join('');
        ctx.setParam('maplayers', layers === DEFAULT_LAYERS ? null : layers || '-');
        draw(); renderLegend();
      });
      return h('label', null, cb, l.label);
    }));
  }

  // ---------- údaje ----------
  function rebuild(force) {
    const src = source();
    const snapOk = ctx.snap && ctx.snap.id === ctx.room;
    if (ctx.area !== shownArea) { hover = null; sel = null; }
    shownArea = ctx.area;
    const name = D.AREA_NAMES[ctx.area] || ctx.area;
    const seeded = isSeeded(D, ctx.area);
    let msg;
    if (src === 'room' && snapOk) {
      map = buildTiles(D, ctx.area, { state: ctx.snap.state });
      players = playersOn(D, ctx.area, ctx.snap);
      msg = map.error
        ? `Room ${ctx.room} has no seed for ${name} yet; it gets one the next time the world loads. Switch to Seed to look at any seed.`
        : `Room ${ctx.room} (${ctx.snap.source === 'memory' ? 'loaded, live state' : 'read from file'})${seeded ? `, seed ${map.seed}` : ''}: its planted beds, tilled soil, ice and players.`;
    } else {
      map = buildTiles(D, ctx.area, { seed });
      players = [];
      msg = src === 'room' ? 'Loading the room…' : seeded ? `${name} generated from seed ${seed}, as a new world with this seed would get it.` : `${name} has a fixed layout: every world has the same one, the seed doesn’t change it.`;
      if (!ctx.room && ctx.param('mapsrc') === 'room') msg = 'No room selected, showing the seed. ' + msg;
    }
    note.textContent = msg;
    renderBar();
    if (map.error) { canvas.width = canvas.height = 0; canvas.style.width = canvas.style.height = '0'; }
    else draw();
    renderLegend(); renderTile(); renderArea();
  }

  // ---------- kreslenie ----------
  function fitTile() {
    const cs = getComputedStyle(wrap);
    const avW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const stacked = window.matchMedia('(max-width: 900px)').matches;
    let t = Math.floor(avW / map.w);
    if (!stacked) {
      // na počítači sa celá mapa zmestí na výšku okna pod lištu (bez posúvania)
      const sc = wrap.closest('main'), top = wrap.getBoundingClientRect().top + (sc ? sc.scrollTop : 0);
      const avH = window.innerHeight - top - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 24;
      t = Math.min(t, Math.floor(Math.max(340, avH) / map.h));
    }
    return Math.max(4, Math.min(28, t));
  }
  function draw() {
    if (!map || map.error) return;
    T = fitTile();
    const dpr = window.devicePixelRatio || 1, cw = T * map.w, ch = T * map.h;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr * T, 0, 0, dpr * T, 0, 0); // ďalej sa kreslí v jednotkách políčok
    const { w, h: hh, tiles } = map, at = (x, y) => x >= 0 && y >= 0 && x < w && y < hh ? tiles[y * w + x] : null;
    // zem: farba podľa výšky
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      g.fillStyle = on('h') ? heightColor(heightBlocks(D, t)) : COL.flat;
      g.fillRect(x, y, 1.02, 1.02);
    }
    // voda a ľadovec (terén, vždy)
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      if (t.g === 'water') {
        g.fillStyle = COL.water; g.fillRect(x, y, 1.02, 1.02);
        if (t.cut) { g.strokeStyle = COL.hole; g.lineWidth = 0.12; g.beginPath(); g.arc(x + 0.5, y + 0.5, 0.26, 0, 7); g.stroke(); }
      } else if (t.g === 'glacier') {
        g.globalAlpha = t.top ? 0.25 + 0.7 * (t.ice || 0) / t.top : 0.6;
        g.fillStyle = COL.glacier; g.fillRect(x, y, 1.02, 1.02);
        g.globalAlpha = 1;
      }
    }
    // pôda a rastliny (svet)
    if (map.source === 'room' && on('b')) for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const s = tiles[y * w + x].s;
      if (!s) continue;
      g.fillStyle = s.w ? COL.soilWet : COL.soil; g.fillRect(x + 0.09, y + 0.09, 0.82, 0.82);
      const p = s.p;
      if (!p) continue;
      const sp = D.SPECIES[p.sp], r = 0.12 + 0.07 * D.stageOf(p);
      g.beginPath(); g.arc(x + 0.5, y + 0.5, r, 0, 7);
      g.fillStyle = p.d ? '#8a8a80' : sp ? sp.color : '#b9e07a'; g.fill();
      g.lineWidth = 0.06; g.strokeStyle = sp && sp.center && !p.d ? sp.center : '#222'; g.stroke();
    }
    // chodníky (hrubé čiary medzi susednými políčkami chodníka a prechodu) a čistiny
    if (on('p')) {
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (kindOf(D, tiles[y * w + x].g) === 'clearing') { g.fillStyle = COL.clearing; g.fillRect(x, y, 1, 1); }
      const isP = t => t && (kindOf(D, t.g) === 'path' || t.g === 'gate');
      g.strokeStyle = COL.path; g.fillStyle = COL.path; g.lineWidth = 0.36; g.lineCap = 'round';
      g.beginPath();
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        if (!isP(at(x, y))) continue;
        let alone = true;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) if (isP(at(x + dx, y + dy))) {
          alone = false;
          if (dx > 0 || dy > 0) { g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + dx + 0.5, y + dy + 0.5); }
        }
        if (alone) { g.moveTo(x + 0.5, y + 0.5); g.lineTo(x + 0.5001, y + 0.5); }
      }
      g.stroke();
      // široký chodník (2 × 2 políčka chodníka) vyplnený, aby nevyzeral ako rebrík
      for (let y = 0; y < hh - 1; y++) for (let x = 0; x < w - 1; x++)
        if (isP(at(x, y)) && isP(at(x + 1, y)) && isP(at(x, y + 1)) && isP(at(x + 1, y + 1))) g.fillRect(x + 0.32, y + 0.32, 1.36, 1.36);
    }
    // objekty: stromy a kry ako bodky, kmene, kamene a stavby ako štvorce
    if (on('o')) {
      g.fillStyle = COL.obj; g.strokeStyle = COL.obj;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const k = kindOf(D, tiles[y * w + x].g);
        const dot = (cx, cy, r) => { g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); };
        if (k === 'tree') dot(x + 0.5, y + 0.5, 0.4);
        else if (k === 'giant') dot(x + 1, y + 1, 0.86);
        else if (k === 'bush') dot(x + 0.5, y + 0.5, 0.24);
        else if (k === 'shroom') dot(x + 0.5, y + 0.5, 0.1);
        else if (k === 'rock' || k === 'log') g.fillRect(x + 0.22, y + 0.22, 0.56, 0.56);
        else if (k === 'building') g.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
        else if (k === 'lot') { g.setLineDash([0.16, 0.12]); g.lineWidth = 0.08; g.strokeRect(x + 0.14, y + 0.14, 0.72, 0.72); g.setLineDash([]); }
      }
    }
    // mriežka (v pixeloch zariadenia, aby bola ostrá)
    if (on('g')) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      const px = dpr * T, lw = Math.max(1, Math.round(dpr));
      for (let x = 1; x < w; x++) { g.fillStyle = x % 5 ? COL.grid : COL.grid5; g.fillRect(Math.round(x * px) - (lw >> 1), 0, lw, canvas.height); }
      for (let y = 1; y < hh; y++) { g.fillStyle = y % 5 ? COL.grid : COL.grid5; g.fillRect(0, Math.round(y * px) - (lw >> 1), canvas.width, lw); }
      g.setTransform(dpr * T, 0, 0, dpr * T, 0, 0);
    }
    // prechody (trojuholník smerom von z plochy) a príchodové miesta
    g.fillStyle = COL.gate; g.strokeStyle = COL.gate;
    for (const gt of D.GATES[map.area] || []) tri(g, gt.x + 0.5, gt.y + 0.5, D.gateSide(map.area, gt), 0.42);
    g.lineWidth = 0.08;
    for (const a of arrivals(D, map.area)) { g.beginPath(); g.arc(a.x, a.y, 0.22, 0, 7); g.stroke(); }
    // hráči sveta (online plné s menom, offline krúžok na poslednom mieste)
    if (map.source === 'room' && on('u')) {
      for (const p of players) {
        g.beginPath(); g.arc(p.x, p.y, p.online ? 0.36 : 0.28, 0, 7);
        if (p.online) { g.fillStyle = COL.player; g.fill(); }
        g.lineWidth = 0.1; g.strokeStyle = p.online ? '#fff' : 'rgba(255,255,255,.75)'; g.stroke();
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.lineJoin = 'round';
      for (const p of players) if (p.online && p.name) {
        const tx = p.x * T, ty = p.y * T - 0.42 * T - 2;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(p.name, tx, ty);
        g.fillStyle = '#fff'; g.fillText(p.name, tx, ty);
      }
      g.setTransform(dpr * T, 0, 0, dpr * T, 0, 0);
    }
    // vybrané a ukázané políčko
    const box = (p, c, lw) => { if (!p) return; g.strokeStyle = c; g.lineWidth = lw / T; g.strokeRect(p.x + lw / T / 2, p.y + lw / T / 2, 1 - lw / T, 1 - lw / T); };
    box(sel, COL.sel, 3);
    if (hover && !(sel && sel.x === hover.x && sel.y === hover.y)) box(hover, COL.hover, 2);
  }
  // trojuholník prechodu smerom k okraju plochy (side: n, s, w, e)
  function tri(g, cx, cy, side, r) {
    const d = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[side] || [0, -1], p = [-d[1], d[0]];
    g.beginPath();
    g.moveTo(cx + d[0] * r, cy + d[1] * r);
    g.lineTo(cx - d[0] * r + p[0] * r, cy - d[1] * r + p[1] * r);
    g.lineTo(cx - d[0] * r - p[0] * r, cy - d[1] * r - p[1] * r);
    g.closePath(); g.fill();
  }

  // ---------- legenda a panely ----------
  function swatch(fn) {
    const c = document.createElement('canvas'), dpr = window.devicePixelRatio || 1, s = 16;
    c.width = c.height = Math.round(s * dpr); c.style.width = c.style.height = s + 'px';
    const g = c.getContext('2d');
    g.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    g.fillStyle = on('h') ? heightColor(1) : COL.flat; g.fillRect(0, 0, 1, 1);
    fn(g);
    return c;
  }
  function renderLegend() {
    const sc = h('div', { class: 'map-scale' });
    for (let i = 0; i < STEPS; i++) sc.appendChild(h('i', { style: `background:${heightColor(i / 2)}` }));
    legendH.replaceChildren(h('h4', null, 'Ground height'), sc, h('div', { class: 'map-ticks' }, ...[0, 1, 2, 3, 4].map(n => h('span', null, n))),
      h('p', null, 'In blocks above ground zero. A player steps up at most ½ block (1 with a jump).'));
    const fill = c => g => { g.fillStyle = c; g.fillRect(0.12, 0.12, 0.76, 0.76); };
    const items = [
      ['p', 'Path (incl. roots)', g => { g.fillStyle = COL.path; g.fillRect(0, 0.32, 1, 0.36); }],
      ['p', 'Clearing', fill(COL.clearing)],
      [null, 'Water (ring = hole in the ice)', fill(COL.water)],
      [null, 'Glacier (paler = less ice)', fill(COL.glacier)],
      ['o', 'Tree · giant tree (2×2) · bush', g => { g.fillStyle = COL.obj; g.beginPath(); g.arc(0.5, 0.5, 0.36, 0, 7); g.fill(); }],
      ['o', 'Log · rock · building', g => { g.fillStyle = COL.obj; g.fillRect(0.2, 0.2, 0.6, 0.6); }],
      ['o', 'Building lot (icehouse)', g => { g.strokeStyle = COL.obj; g.lineWidth = 0.08; g.setLineDash([0.16, 0.12]); g.strokeRect(0.16, 0.16, 0.68, 0.68); }],
      [null, 'Gate to another area', g => { g.fillStyle = COL.gate; tri(g, 0.5, 0.5, 'n', 0.4); }],
      [null, 'Arrival point', g => { g.strokeStyle = COL.gate; g.lineWidth = 0.1; g.beginPath(); g.arc(0.5, 0.5, 0.28, 0, 7); g.stroke(); }]
    ];
    if (map && map.source === 'room') items.push(
      ['b', 'Tilled soil · plant (darker = watered)', g => { g.fillStyle = COL.soil; g.fillRect(0.1, 0.1, 0.8, 0.8); g.fillStyle = '#f2c94c'; g.beginPath(); g.arc(0.5, 0.5, 0.22, 0, 7); g.fill(); }],
      ['u', 'Player online · last place offline', g => { g.fillStyle = COL.player; g.strokeStyle = '#fff'; g.lineWidth = 0.1; g.beginPath(); g.arc(0.5, 0.5, 0.32, 0, 7); g.fill(); g.stroke(); }]);
    legendL.replaceChildren(h('h4', null, 'Layers'), h('ul', { class: 'map-leg' },
      ...items.map(([l, label, fn]) => h('li', { style: l && !on(l) ? 'opacity:.45' : null, title: l && !on(l) ? 'Layer hidden' : null }, swatch(fn), label))));
  }
  const dl = rows => h('dl', { class: 'map-dl' }, ...rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  function renderTile() {
    const p = hover || sel;
    const head = h('h4', null, 'Tile', h('span', null, hover ? '' : sel ? 'selected · tap again to clear' : ''));
    if (!map || map.error || !p) return tileBox.replaceChildren(head, h('p', null, 'Hover or tap a tile.'));
    const i = tileInfo(D, map, p.x, p.y);
    if (!i) return tileBox.replaceChildren(head, h('p', null, 'Hover or tap a tile.'));
    const here = players.filter(q => Math.floor(q.x) === p.x && Math.floor(q.y) === p.y);
    tileBox.replaceChildren(head, dl([
      ['Tile', `${i.x}, ${i.y}`],
      ['Type', i.g + (i.giantAt ? ` (giant tree at ${i.giantAt.x}, ${i.giantAt.y})` : '')],
      ['Height', `${i.height.toFixed(2)} blocks`],
      ['Walkable', i.walkable ? 'yes' : 'no'],
      i.gateTo ? ['Gate to', D.AREA_NAMES[i.gateTo] || i.gateTo] : null,
      i.ice != null ? ['Ice', `${i.ice} / ${i.iceTop} layers`] : null,
      i.cut ? ['Ice hole', 'cut today'] : null,
      i.soil ? ['Soil', `${i.soil}${i.wet ? ', watered' : ''}`] : null,
      i.plant ? ['Plant', `${i.plant.name}${i.plant.wild ? ' (wild)' : ''}, stage ${i.plant.stage}${i.plant.dead ? ', dead' : ''}`] : null,
      here.length ? ['Players', here.map(q => q.online ? q.name : `${q.id} (offline)`).join(', ')] : null
    ]));
  }
  function renderArea() {
    if (!map || map.error) return areaBox.replaceChildren(h('h4', null, 'Area'), h('p', null, 'No map.'));
    const s = areaStats(D, map), on_ = players.filter(p => p.online).length;
    areaBox.replaceChildren(h('h4', null, 'Area', h('span', null, D.AREA_NAMES[map.area] || map.area)), dl([
      ['Size', `${s.w} × ${s.h} tiles`],
      ['Seed', map.seeded ? String(map.seed) : 'fixed layout'],
      ['Walkable', `${s.walkablePct} % (${s.walkable})`],
      ['Path tiles', String(s.paths)],
      ['Trees', String(s.trees)],
      ['Bushes', String(s.bushes)],
      ['Gates', s.gates.length ? s.gates.map(g => `${g.name} at ${g.tiles.map(t => t.x + ',' + t.y).join(' / ')}`).join('; ') : 'none'],
      s.iceTop ? ['Glacier ice', `${s.ice} / ${s.iceTop} layers`] : null,
      map.source === 'room' && s.holes ? ['Ice holes', String(s.holes)] : null,
      map.source === 'room' && (s.tilled || map.area === 'garden') ? ['Beds', `${s.tilled} tilled, ${s.planted} planted`] : null,
      map.source === 'room' ? ['Players here', `${on_} online, ${players.length - on_} offline`] : null
    ]));
  }

  // ---------- myš a dotyk ----------
  const tileAt = e => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / T), y = Math.floor((e.clientY - r.top) / T);
    return map && !map.error && x >= 0 && y >= 0 && x < map.w && y < map.h ? { x, y } : null;
  };
  const same = (a, b) => a === b || (a && b && a.x === b.x && a.y === b.y);
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return; // na dotyk len ťuknutie
    const t = tileAt(e);
    if (!same(t, hover)) { hover = t; draw(); renderTile(); }
  });
  canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; draw(); renderTile(); } });
  canvas.addEventListener('click', e => {
    const t = tileAt(e);
    sel = same(t, sel) ? null : t;
    draw(); renderTile();
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  rebuild(true);
  return {
    update(c) { ctx = c; rebuild(); },
    unmount() { ro.disconnect(); window.removeEventListener('resize', onResize); }
  };
}
