// Záložka Mapa (#77): pôdorys plochy na plátne – výška zeme, chodníky, objekty, prechody, mriežka,
// inšpektor políčka a štatistiky. Zdroj: semienko (hocijaké) alebo vybraný svet (jeho semienko, pôda, ľad, hráči).
// Výpočty sú v map-core.ts (bez DOM, testované), tu je len ovládanie a kreslenie.
import { kindOf, isSeeded, randomSeed, parseSeed, buildTiles, heightBlocks, arrivals, playersOn, areaStats, tileInfo } from './map-core.ts';
import type { AreaMap, MapError, MapPlayer, MapTile } from './map-core.ts';
import { vehiclesOf, vehicleText, drawVehicle, nextToggle, VEHICLE_COLOR } from './vehicles-core.ts';
import type { DebugVehicle } from './vehicles-core.ts';
import type { Kid, TabCtx, TabInstance } from '../ui.ts';
import { lookup, must } from '../../shared/util.ts';

type C2 = CanvasRenderingContext2D;
interface Pt { x: number; y: number }

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
  low: [20, 36, 26] as const, high: [126, 186, 128] as const, flat: '#26412c', path: '#e3a03f', clearing: 'rgba(222, 200, 92, .62)',
  water: '#4f8fd0', deep: '#2f6aa8', dock: '#b8875a', boat: '#f4f1e8', edge: '#e2664b', hole: '#16304d', glacier: '#d6ecf7', obj: '#0a100b', gate: '#e2664b', soil: '#7a5432', soilWet: '#563820',
  player: '#ff5ca8', hover: '#ffffff', sel: '#ffd84a', grid: 'rgba(255,255,255,.10)', grid5: 'rgba(255,255,255,.24)'
};
const MAX_H = 4, STEPS = 9; // stupnica výšky 0–4 bloky po pol bloku
function heightColor(b: number): string {
  const k = Math.max(0, Math.min(1, Math.round(b * 2) / 2 / MAX_H));
  const c = COL.low.map((v, i) => Math.round(v + ((COL.high[i] ?? v) - v) * k));
  return `rgb(${c.join(',')})`;
}
const LAYERS: readonly { id: string; label: string; room?: boolean }[] = [
  { id: 'h', label: 'Heights' }, { id: 'p', label: 'Paths' }, { id: 'o', label: 'Objects' }, { id: 'g', label: 'Grid' },
  { id: 'd', label: 'Deep water' }, { id: 'b', label: 'Beds', room: true }, { id: 'u', label: 'Players', room: true }, { id: 'v', label: 'Vehicles', room: true }, { id: 'k', label: 'Boat', room: true }
];
const DEFAULT_LAYERS = 'hpobudvk';

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  let ctx = ctx0;
  const { h, D } = ctx;
  if (!document.getElementById('tab-map-css')) document.head.appendChild(h('style', { id: 'tab-map-css' }, CSS));

  // stav záložky (seed, zdroj a vrstvy sú v adrese)
  let seed = parseSeed(ctx.param('mapseed'));
  if (seed == null) { seed = randomSeed(); ctx.setParam('mapseed', seed); }
  let layers = ctx.param('maplayers') ?? DEFAULT_LAYERS;
  let vehicles: DebugVehicle[] = [], names = new Map<string, string>(), toggleAt: number | null = null; // fúrik a sane (#158)
  let map: AreaMap | MapError | null = null, players: MapPlayer[] = [], hover: Pt | null = null, sel: Pt | null = null, T = 16, shownArea: string | null = null;
  const on = (id: string): boolean => layers.includes(id);
  const source = (): 'room' | 'seed' => {
    const s = ctx.param('mapsrc');
    return ctx.room && (s === 'room' || s == null) ? 'room' : 'seed';
  };

  // ---------- ovládanie ----------
  const areaSeg = h('div', { class: 'map-seg', role: 'group', 'aria-label': 'Area' });
  const srcSeg = h('div', { class: 'map-seg', role: 'group', 'aria-label': 'Source' });
  const seedIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Seed' });
  const newSeed = h('button', { onclick: () => { seed = randomSeed(); ctx.setParam('mapseed', seed); ctx.setParam('mapsrc', 'seed'); rebuild(); } }, 'New seed');
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
    if (v == null) { seedIn.value = String(map && !map.error && map.seed != null ? map.seed : seed); return; }
    seed = v; ctx.setParam('mapseed', seed); ctx.setParam('mapsrc', 'seed'); rebuild();
  });
  seedIn.addEventListener('keydown', e => { if (e.key === 'Enter') seedIn.blur(); });

  function renderBar(): void {
    areaSeg.replaceChildren(...D.AREAS.map(a => h('button', { class: a === ctx.area ? 'on' : null, onclick: () => { ctx.setArea(a); } }, D.AREA_NAMES[a] || a)));
    const src = source();
    srcSeg.replaceChildren(
      h('button', { class: src === 'room' ? 'on' : null, disabled: ctx.room ? null : 'disabled', title: ctx.room ? `The real map of room ${ctx.room}` : 'Pick a room on the left',
        onclick: () => { ctx.setParam('mapsrc', 'room'); rebuild(); } }, 'Room'),
      h('button', { class: src === 'seed' ? 'on' : null, title: 'Any seed, without a room', onclick: () => { ctx.setParam('mapsrc', 'seed'); rebuild(); } }, 'Seed'));
    const seeded = isSeeded(D, ctx.area);
    seedIn.disabled = !seeded;
    newSeed.disabled = !seeded;
    if (document.activeElement !== seedIn) seedIn.value = !seeded ? '–' : String(map && !map.error && map.seed != null ? map.seed : seed);
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
  function rebuild(): void {
    const src = source();
    const snap = ctx.snap && ctx.snap.id === ctx.room ? ctx.snap : null;
    if (ctx.area !== shownArea) { hover = null; sel = null; }
    shownArea = ctx.area;
    const name = D.AREA_NAMES[ctx.area] || ctx.area;
    const seeded = isSeeded(D, ctx.area);
    let msg: string;
    if (src === 'room' && snap) {
      map = buildTiles(D, ctx.area, { state: snap.state });
      players = playersOn(D, ctx.area, snap);
      vehicles = vehiclesOf(snap.state); names = new Map(snap.online.map(o => [o.player, o.name])); toggleAt = nextToggle(snap.state);
      msg = map.error
        ? `Room ${ctx.room} has no seed for ${name} yet; it gets one the next time the world loads. Switch to Seed to look at any seed.`
        : `Room ${ctx.room} (${snap.source === 'memory' ? 'loaded, live state' : 'read from file'})${seeded ? `, seed ${String(map.seed)}` : ''}: its planted beds, tilled soil, ice and players.`;
    } else {
      map = buildTiles(D, ctx.area, { seed });
      players = []; vehicles = [];
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
  function fitTile(map: AreaMap): number {
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
  function draw(): void {
    if (!map || map.error) return;
    const m = map;
    T = fitTile(m);
    const dpr = window.devicePixelRatio || 1, cw = T * map.w, ch = T * map.h;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const g = must(canvas.getContext('2d') ?? undefined);
    g.setTransform(dpr * T, 0, 0, dpr * T, 0, 0); // ďalej sa kreslí v jednotkách políčok
    const { w, h: hh, tiles } = m, at = (x: number, y: number): MapTile | null => x >= 0 && y >= 0 && x < w && y < hh ? tiles[y * w + x] ?? null : null;
    const tl = (x: number, y: number): MapTile => must(tiles[y * w + x]);
    // zem: farba podľa výšky
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const t = tl(x, y);
      g.fillStyle = on('h') ? heightColor(heightBlocks(D, t)) : COL.flat;
      g.fillRect(x, y, 1.02, 1.02);
    }
    // voda a ľadovec (terén, vždy)
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const t = tl(x, y);
      if (t.g === 'water' || t.g === 'dock') {
        g.fillStyle = on('d') && m.deep.has(y * w + x) ? COL.deep : COL.water; g.fillRect(x, y, 1.02, 1.02);
        if (t.g === 'dock') { g.fillStyle = COL.dock; g.fillRect(x + 0.18, y, 0.64, 1.02); g.fillStyle = 'rgba(0,0,0,.25)'; for (let k = 1; k < 4; k++) g.fillRect(x + 0.18, y + k / 4, 0.64, 0.04); } // mólo: lávka
        if (on('d') && m.deep.has(y * w + x)) { g.fillStyle = 'rgba(255,255,255,.35)'; for (const [dx, dy] of [[0.3, 0.3], [0.7, 0.7]] as const) { g.beginPath(); g.arc(x + dx, y + dy, 0.06, 0, 7); g.fill(); } }
        if (t.cut) { g.strokeStyle = COL.hole; g.lineWidth = 0.12; g.beginPath(); g.arc(x + 0.5, y + 0.5, 0.26, 0, 7); g.stroke(); }
      } else if (t.g === 'glacier') {
        g.globalAlpha = t.top ? 0.25 + 0.7 * (t.ice || 0) / t.top : 0.6;
        g.fillStyle = COL.glacier; g.fillRect(x, y, 1.02, 1.02);
        g.globalAlpha = 1;
      }
    }
    // pôda a rastliny (svet)
    if (m.source === 'room' && on('b')) for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const s = tl(x, y).s;
      if (!s) continue;
      g.fillStyle = s.w ? COL.soilWet : COL.soil; g.fillRect(x + 0.09, y + 0.09, 0.82, 0.82);
      const p = s.p;
      if (!p) continue;
      const sp = D.isSpeciesId(p.sp) ? D.SPECIES[p.sp] : null, r = 0.12 + 0.07 * D.stageOf(p);
      g.beginPath(); g.arc(x + 0.5, y + 0.5, r, 0, 7);
      g.fillStyle = p.d ? '#8a8a80' : sp ? sp.color : '#b9e07a'; g.fill();
      g.lineWidth = 0.06; g.strokeStyle = sp && sp.center && !p.d ? sp.center : '#222'; g.stroke();
    }
    // chodníky (hrubé čiary medzi susednými políčkami chodníka a prechodu) a čistiny
    if (on('p')) {
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (kindOf(D, tl(x, y).g) === 'clearing') { g.fillStyle = COL.clearing; g.fillRect(x, y, 1, 1); }
      const isP = (t: MapTile | null): boolean => !!t && (kindOf(D, t.g) === 'path' || t.g === 'gate');
      g.strokeStyle = COL.path; g.fillStyle = COL.path; g.lineWidth = 0.36; g.lineCap = 'round';
      g.beginPath();
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        if (!isP(at(x, y))) continue;
        let alone = true;
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) if (isP(at(x + dx, y + dy))) {
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
        const k = kindOf(D, tl(x, y).g);
        const dot = (cx: number, cy: number, r: number): void => { g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); };
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
    for (const gt of lookup(D.GATES, m.area) || []) tri(g, gt.x + 0.5, gt.y + 0.5, D.gateSide(m.area, gt), 0.42);
    g.lineWidth = 0.08;
    for (const a of arrivals(D, m.area)) { g.beginPath(); g.arc(a.x, a.y, 0.22, 0, 7); g.stroke(); }
    // fúrik a sane (#158): značka natočená za smerom, bodky = ľad, ružová bodka = kto ho drží
    if (m.source === 'room' && on('v')) for (const v of vehicles) if (v.bought && v.area === m.area) drawVehicle(g, v);
    // okraj jazierka smerom do Močiara (#160): červená čiarka na okraji mapy
    if (m.area === 'garden') { g.fillStyle = COL.edge; for (const p of D.POND_EDGE) g.fillRect(p.x, p.y + 0.15, 0.14, 0.7); }
    // loďka (#160): podlhovastý trup v smere prove; prevrátená (zima) na móle šedá s krížikom
    if (m.source === 'room' && on('k') && m.boat) {
      const b = m.boat, last = D.DOCK.tiles[D.DOCK.tiles.length - 1], bx = b.flip && last ? last.x + 0.5 : b.x, by = b.flip && last ? last.y + 0.5 : b.y, a = b.flip ? Math.PI / 2 : b.a;
      g.save(); g.translate(bx, by); g.rotate(a);
      g.beginPath(); g.moveTo(0.55, 0); g.quadraticCurveTo(0.2, 0.32, -0.45, 0.26); g.lineTo(-0.45, -0.26); g.quadraticCurveTo(0.2, -0.32, 0.55, 0); g.closePath();
      g.fillStyle = b.flip ? '#9aa4ad' : COL.boat; g.fill(); g.lineWidth = 0.08; g.strokeStyle = '#3a6ea5'; g.stroke();
      if (b.flip) { g.beginPath(); g.moveTo(-0.25, -0.15); g.lineTo(0.25, 0.15); g.moveTo(-0.25, 0.15); g.lineTo(0.25, -0.15); g.stroke(); }
      g.restore();
    }
    // hráči sveta (online plné s menom, offline krúžok na poslednom mieste)
    if (m.source === 'room' && on('u')) {
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
    const box = (p: Pt | null, c: string, lw: number): void => { if (!p) return; g.strokeStyle = c; g.lineWidth = lw / T; g.strokeRect(p.x + lw / T / 2, p.y + lw / T / 2, 1 - lw / T, 1 - lw / T); };
    box(sel, COL.sel, 3);
    if (hover && !(sel && sel.x === hover.x && sel.y === hover.y)) box(hover, COL.hover, 2);
  }
  // trojuholník prechodu smerom k okraju plochy (side: n, s, w, e)
  function tri(g: C2, cx: number, cy: number, side: 'n' | 's' | 'w' | 'e', r: number): void {
    const d = ({ n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as const)[side], p = [-d[1], d[0]] as const;
    g.beginPath();
    g.moveTo(cx + d[0] * r, cy + d[1] * r);
    g.lineTo(cx - d[0] * r + p[0] * r, cy - d[1] * r + p[1] * r);
    g.lineTo(cx - d[0] * r - p[0] * r, cy - d[1] * r - p[1] * r);
    g.closePath(); g.fill();
  }

  // ---------- legenda a panely ----------
  function swatch(fn: (g: C2) => void): HTMLCanvasElement {
    const c = document.createElement('canvas'), dpr = window.devicePixelRatio || 1, s = 16;
    c.width = c.height = Math.round(s * dpr); c.style.width = c.style.height = s + 'px';
    const g = must(c.getContext('2d') ?? undefined);
    g.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    g.fillStyle = on('h') ? heightColor(1) : COL.flat; g.fillRect(0, 0, 1, 1);
    fn(g);
    return c;
  }
  function renderLegend(): void {
    const sc = h('div', { class: 'map-scale' });
    for (let i = 0; i < STEPS; i++) sc.appendChild(h('i', { style: `background:${heightColor(i / 2)}` }));
    legendH.replaceChildren(h('h4', null, 'Ground height'), sc, h('div', { class: 'map-ticks' }, ...[0, 1, 2, 3, 4].map(n => h('span', null, n))),
      h('p', null, 'In blocks above ground zero. A player steps up at most ½ block (1 with a jump).'));
    const fill = (c: string) => (g: C2): void => { g.fillStyle = c; g.fillRect(0.12, 0.12, 0.76, 0.76); };
    const items: [string | null, string, (g: C2) => void][] = [
      ['p', 'Path (incl. roots)', g => { g.fillStyle = COL.path; g.fillRect(0, 0.32, 1, 0.36); }],
      ['p', 'Clearing', fill(COL.clearing)],
      [null, 'Water (ring = hole in the ice)', fill(COL.water)],
      ['d', 'Deep water: out of reach from the shore, boat only', g => { g.fillStyle = COL.deep; g.fillRect(0.12, 0.12, 0.76, 0.76); g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.arc(0.35, 0.35, 0.07, 0, 7); g.arc(0.65, 0.65, 0.07, 0, 7); g.fill(); }],
      [null, 'Dock (built) · pond edge to Močiar', g => { g.fillStyle = COL.water; g.fillRect(0, 0, 1, 1); g.fillStyle = COL.dock; g.fillRect(0.3, 0, 0.4, 1); g.fillStyle = COL.edge; g.fillRect(0, 0.15, 0.14, 0.7); }],
      [null, 'Glacier (paler = less ice)', fill(COL.glacier)],
      ['o', 'Tree · giant tree (2×2) · bush', g => { g.fillStyle = COL.obj; g.beginPath(); g.arc(0.5, 0.5, 0.36, 0, 7); g.fill(); }],
      ['o', 'Log · rock · building', g => { g.fillStyle = COL.obj; g.fillRect(0.2, 0.2, 0.6, 0.6); }],
      ['o', 'Building lot (icehouse)', g => { g.strokeStyle = COL.obj; g.lineWidth = 0.08; g.setLineDash([0.16, 0.12]); g.strokeRect(0.16, 0.16, 0.68, 0.68); }],
      [null, 'Gate to another area', g => { g.fillStyle = COL.gate; tri(g, 0.5, 0.5, 'n', 0.4); }],
      [null, 'Arrival point', g => { g.strokeStyle = COL.gate; g.lineWidth = 0.1; g.beginPath(); g.arc(0.5, 0.5, 0.28, 0, 7); g.stroke(); }]
    ];
    if (map && !map.error && map.source === 'room') items.push(
      ['b', 'Tilled soil · plant (darker = watered)', g => { g.fillStyle = COL.soil; g.fillRect(0.1, 0.1, 0.8, 0.8); g.fillStyle = '#f2c94c'; g.beginPath(); g.arc(0.5, 0.5, 0.22, 0, 7); g.fill(); }],
      ['k', 'Boat (grey with a cross = flipped on the dock, winter)', g => { g.fillStyle = COL.boat; g.strokeStyle = '#3a6ea5'; g.lineWidth = 0.08; g.beginPath(); g.ellipse(0.5, 0.5, 0.42, 0.24, 0, 0, 7); g.fill(); g.stroke(); }],

      ['u', 'Player online · last place offline', g => { g.fillStyle = COL.player; g.strokeStyle = '#fff'; g.lineWidth = 0.1; g.beginPath(); g.arc(0.5, 0.5, 0.32, 0, 7); g.fill(); g.stroke(); }],
      ['v', 'Fúrik (red) · sane (wood), dots = ice', g => { g.fillStyle = VEHICLE_COLOR.furik; g.fillRect(0.1, 0.25, 0.8, 0.5); g.fillStyle = '#bfe6fb'; g.fillRect(0.2, 0.35, 0.2, 0.2); }]);
    legendL.replaceChildren(h('h4', null, 'Layers'), h('ul', { class: 'map-leg' },
      ...items.map(([l, label, fn]) => h('li', { style: l && !on(l) ? 'opacity:.45' : null, title: l && !on(l) ? 'Layer hidden' : null }, swatch(fn), label))));
  }
  const dl = (rows: ([string, Kid] | null)[]): HTMLElement => h('dl', { class: 'map-dl' }, ...rows.flatMap(r => r ? [h('dt', null, r[0]), h('dd', null, r[1])] : []));
  function renderTile(): void {
    const p = hover || sel;
    const head = h('h4', null, 'Tile', h('span', null, hover ? '' : sel ? 'selected · tap again to clear' : ''));
    if (!map || map.error || !p) { tileBox.replaceChildren(head, h('p', null, 'Hover or tap a tile.')); return; }
    const i = tileInfo(D, map, p.x, p.y);
    if (!i) { tileBox.replaceChildren(head, h('p', null, 'Hover or tap a tile.')); return; }
    const here = players.filter(q => Math.floor(q.x) === p.x && Math.floor(q.y) === p.y);
    tileBox.replaceChildren(head, dl([
      ['Tile', `${i.x}, ${i.y}`],
      ['Type', i.g + (i.giantAt ? ` (giant tree at ${i.giantAt.x}, ${i.giantAt.y})` : '')],
      ['Height', `${i.height.toFixed(2)} blocks`],
      ['Walkable', i.walkable ? 'yes' : 'no'],
      i.gateTo ? ['Gate to', D.AREA_NAMES[i.gateTo] || i.gateTo] : null,
      i.ice != null ? ['Ice', `${i.ice} / ${i.iceTop ?? 0} layers`] : null,
      i.cut ? ['Ice hole', 'cut today'] : null,
      i.deep ? ['Deep water', 'out of reach from the shore (boat only)'] : null,
      i.boat && map.boat ? ['Boat', `${map.boat.flip ? 'flipped on the dock (winter)' : 'here'}${map.boat.seats.length ? ', seats: ' + map.boat.seats.join(', ') : ', empty'}`] : null,
      i.soil ? ['Soil', `${i.soil}${i.wet ? ', watered' : ''}`] : null,
      i.plant ? ['Plant', `${i.plant.name}${i.plant.wild ? ' (wild)' : ''}, stage ${i.plant.stage}${i.plant.dead ? ', dead' : ''}`] : null,
      here.length ? ['Players', here.map(q => q.online ? q.name : `${q.id} (offline)`).join(', ')] : null,
      ...vehicles.filter(v => v.bought && v.area === map?.area && Math.floor(v.x) === p.x && Math.floor(v.y) === p.y).map((v): [string, Kid] => [v.name, vehicleText(v, names)])
    ]));
  }
  function renderArea(): void {
    if (!map || map.error) { areaBox.replaceChildren(h('h4', null, 'Area'), h('p', null, 'No map.')); return; }
    const s = areaStats(D, map), on_ = players.filter(p => p.online).length;
    areaBox.replaceChildren(h('h4', null, 'Area', h('span', null, lookup(D.AREA_NAMES, map.area) || map.area)), dl([
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
      map.source === 'room' ? ['Players here', `${on_} online, ${players.length - on_} offline`] : null,
      ...(map.source === 'room' ? vehicles.map((v): [string, Kid] => [v.name, vehicleText(v, names)]) : []),
      map.source === 'room' ? ['Vehicle season', toggleAt == null ? 'vehSeason not scheduled' : `next toggle (vehSeason) ${ctx.fmt.when(toggleAt)} · tick ${String(toggleAt)}`] : null,
      map.area === 'garden' ? ['Deep water', `${map.deep.size} tiles (boat only)`] : null,
      map.area === 'garden' && map.source === 'room' ? ['Dock', map.boat ? `built; boat at ${map.boat.x.toFixed(2)}, ${map.boat.y.toFixed(2)}${map.boat.flip ? ' (flipped, winter)' : ''}; seats: ${map.boat.seats.join(', ') || 'empty'}` : 'not built'] : null
    ]));
  }

  // ---------- myš a dotyk ----------
  const tileAt = (e: MouseEvent): Pt | null => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / T), y = Math.floor((e.clientY - r.top) / T);
    return map && !map.error && x >= 0 && y >= 0 && x < map.w && y < map.h ? { x, y } : null;
  };
  const same = (a: Pt | null, b: Pt | null): boolean => a === b || (!!a && !!b && a.x === b.x && a.y === b.y);
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
  const ro = new ResizeObserver(() => { draw(); });
  ro.observe(wrap);
  const onResize = (): void => { draw(); };

  window.addEventListener('resize', onResize);

  rebuild();
  return {
    update(c) { ctx = c; rebuild(); },
    unmount() { ro.disconnect(); window.removeEventListener('resize', onResize); }
  };
}
