// Ladiaca stránka (#106): záložka Journal – denník dávok sveta zo súboru (aj pre nenačítaný svet): filtre podľa druhu,
// typu vstupu, hráča, osudu návrhu, kľúča a rozsahu krokov, stránkovanie od najnovšieho a jeden záznam rozobraný
// rovnako ako v záložke Engine. Údaje z /api/debug/journal, len na čítanie. Texty po anglicky.
import { ensureCss, renderer } from './engine.mjs';

const CSS = `
.jr .filters { display: flex; gap: 6px 10px; align-items: center; flex-wrap: wrap; margin: 6px 0 8px; }
.jr .filters label { display: flex; gap: 4px; align-items: center; color: var(--muted); }
.jr .filters input[type=search], .jr .filters input[type=number] { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
.jr .filters input[type=number] { width: 90px; }
.jr .filters input.key { width: 170px; }
.jr .more { margin: 8px 0; display: flex; justify-content: center; }
.jr .load td { background: var(--accent-bg); }
`;
const FILTERS = [['jk', 'kind'], ['jt', 'type'], ['ja', 'actor'], ['jo', 'outcome'], ['jy', 'key'], ['jf', 'from'], ['jto', 'to']];

export function mount(el, ctx0) {
  ensureCss();
  if (!document.getElementById('tab-journal-css')) {
    const st = document.createElement('style');
    st.id = 'tab-journal-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  let ctx = ctx0, data = null, rows = [], det = null, err = null, loadedRoom = null, seq = 0, more = false;
  const { h, fmt } = ctx;
  const R = renderer(ctx), { wrap, actor } = R;
  const sel = () => (ctx.param('jg') == null ? null : +ctx.param('jg'));
  const hideMoves = () => ctx.param('jm') !== '1';
  const fmtSize = fmt.size;

  function query(extra) {
    const p = new URLSearchParams({ room: ctx.room });
    for (const [k, q] of FILTERS) if (ctx.param(k)) p.set(q, ctx.param(k));
    if (hideMoves()) p.set('moves', '0');
    for (const k in extra || {}) p.set(k, extra[k]);
    return '/api/debug/journal?' + p;
  }
  // first: znova od najnovšieho (zmena filtra, obnovenie); inak ďalšia strana
  async function load(first = true) {
    const room = ctx.room, my = ++seq;
    if (!room) { data = det = null; rows = []; err = null; loadedRoom = null; return render(); }
    if (room !== loadedRoom) { data = det = null; rows = []; err = null; render(); }
    try {
      if (first) {
        const j = await ctx.api(query({ limit: Math.max(100, rows.length) }));
        if (my !== seq) return;
        data = j; rows = j.rows;
        const g = sel();
        det = g != null ? await ctx.api('/api/debug/journal?room=' + encodeURIComponent(room) + '&g=' + g) : null;
      } else {
        more = true; render();
        const j = await ctx.api(query({ before: data.next }));
        if (my !== seq) return;
        data = j; rows = rows.concat(j.rows); more = false;
      }
      if (my !== seq) return;
      err = null;
    } catch (e) { if (my !== seq) return; err = e.message; data = null; }
    loadedRoom = room;
    render();
  }
  async function select(g) {
    ctx.setParam('jg', g); det = null; render();
    const my = ++seq;
    try { det = await ctx.api('/api/debug/journal?room=' + encodeURIComponent(ctx.room) + '&g=' + g); } catch (e) { det = { error: e.message }; }
    if (my === seq) render();
  }

  // ---------- filtre ----------
  function filters() {
    const set = (k, v) => { ctx.setParam(k, v); rows = []; load(); };
    const select = (k, label, opts) => {
      const s = h('select', null, h('option', { value: '' }, 'any'), opts.map(([v, t]) => h('option', { value: v, selected: ctx.param(k) === v ? 'selected' : null }, t)));
      s.onchange = () => set(k, s.value);
      return h('label', null, label, s);
    };
    const text = (k, label, attrs) => {
      const i = h('input', Object.assign({ autocomplete: 'off' }, attrs));
      i.value = ctx.param(k) || '';
      i.onchange = () => set(k, i.value.trim());
      return h('label', null, label, i);
    };
    const mv = h('input', { type: 'checkbox' });
    mv.checked = hideMoves();
    mv.onchange = () => set('jm', mv.checked ? null : '1');
    const d = data || { types: [], players: [] };
    const clear = h('button', { onclick: () => { for (const [k] of FILTERS) ctx.setParam(k, null); ctx.setParam('jm', null); rows = []; render(); load(); } }, 'Clear');
    return h('div', { class: 'filters' },
      select('jk', 'Kind', [['events', 'event batches'], ['actions', 'action batches'], ['load', 'world loaded']]),
      select('jt', 'Type', d.types.map(t => [t, t])),
      select('ja', 'Player', d.players.map(p => [p.id, p.name ? `${p.name} (${p.id})` : p.id])),
      select('jo', 'Outcome', [['held', 'has held'], ['rejected', 'has rejected'], ['error', 'has error'], ['applied', 'has applied']]),
      text('jy', 'Key', { type: 'search', class: 'key', placeholder: 'e.g. market:seed_mak', title: 'Substring of a key some proposal read or wrote (tile:garden:12, save:p-…, contracts…)' }),
      text('jf', 'Ticks', { type: 'number', placeholder: 'from' }), text('jto', '–', { type: 'number', placeholder: 'to' }),
      h('label', { title: 'Hide action batches that only moved players without a conflict' }, mv, 'hide plain moves'),
      clear);
  }

  // ---------- zoznam ----------
  const nameOf = id => { const p = data && data.players.find(x => x.id === id); return p ? p.name : null; };
  const date = ms => ms ? new Date(ms).toLocaleString() : '–';
  function list() {
    const table = wrap(
      h('tr', null, h('th', { class: 'num' }, 'Line'), h('th', null, 'Tick'), h('th', null, 'Batch'), h('th', null, 'Players'), h('th', null, 'Outcome')),
      rows.map(r => r.kind === 'load'
        ? h('tr', { class: 'r load' + (r.g === sel() ? ' on' : ''), onclick: () => select(r.g) }, h('td', { class: 'num muted' }, r.g),
          h('td', { class: 'num', title: date(r.wall) }, r.tick, h('br'), h('small', { class: 'muted' }, fmt.hhmm(ctx.D.minOfTick(r.tick)))),
          h('td', { colspan: 3 }, h('b', null, 'world loaded'), h('span', { class: 'muted' }, ` · step ${r.step}${r.migratedFrom ? ' · migrated from save v' + r.migratedFrom : ''} · ${date(r.wall)}`)))
        : h('tr', { class: 'r' + (r.g === sel() ? ' on' : ''), onclick: () => select(r.g) }, h('td', { class: 'num muted' }, r.g),
          h('td', { class: 'num', title: date(r.wall) }, r.tick, h('br'), h('small', { class: 'muted' }, fmt.hhmm(ctx.D.minOfTick(r.tick)))),
          h('td', { class: 'bt' }, r.types.join(', '), ' ', h('span', { class: 'src' }, r.kind === 'events' ? `${r.n} ev` : `${r.n} in`)),
          h('td', { class: 'bt' }, r.actors.length ? r.actors.map(a => h('div', null, actor({ kind: 'player', key: a, name: nameOf(a) }))) : h('span', { class: 'muted' }, '–')),
          h('td', null, h('span', { class: 'muted' }, `${r.applied}✓`, r.held ? h('b', { style: 'color:var(--warn)' }, ` ${r.held}⏸`) : '', r.rejected ? ` ${r.rejected}✗` : '', r.errors ? h('b', { class: 'err' }, ` ${r.errors}!` ) : '', r.rounds > 1 ? ` · ${r.rounds} r` : '')))),
      rows.length ? null : h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No journal entries match.')));
    return h('div', { class: 'rows' }, table,
      data.next != null ? h('div', { class: 'more' }, h('button', { onclick: () => load(false), disabled: more ? 'disabled' : null }, more ? 'Loading…' : `Load older (${data.matched - rows.length} more)`)) : null);
  }
  function detail() {
    if (sel() == null) return h('div', { class: 'empty' }, 'Click a journal line to see its proposals, decisions and world changes.');
    if (!det) return h('div', { class: 'empty' }, 'Loading…');
    if (det.error) return h('div', { class: 'empty err' }, det.error);
    if (det.gone != null) return h('div', { class: 'empty' }, `Line ${det.gone} is no longer in the journal (rotated).`);
    if (det.load) return [h('h3', { style: 'margin-top:0' }, `World loaded at tick ${det.load.tick} · ${fmt.when(det.load.tick)}`),
      h('div', { class: 'note' }, 'The server loaded the world from its save here; the batches after this marker continue from this step and event counter. After a crash, the ticks caught up on load are journaled again.'),
      h('pre', null, JSON.stringify(det.load, null, 1))];
    return R.detail(det);
  }

  function render() {
    const head = h('h2', null, 'Journal', ctx.room ? h('span', { class: 'badge' }, ctx.room) : null);
    let body;
    if (!ctx.room) body = [h('div', { class: 'empty' }, 'Pick a room on the left.')];
    else if (err) body = [h('div', { class: 'empty err' }, /not found/.test(err) ? 'This room has no journal file.' : err)];
    else if (!data) body = [h('div', { class: 'empty' }, 'Loading…')];
    else body = [
      filters(),
      h('div', { class: 'note' }, `${data.files.map(f => `${f.name} (${fmtSize(f.size)})`).join(', ') || 'no journal file'} · ${data.total} lines`,
        data.first != null ? `, ticks ${data.first}–${data.last} (${fmt.when(data.first)} – ${fmt.when(data.last)})` : '', ` · ${data.matched} match, newest first.`),
      h('div', { class: 'split' }, list(), h('div', null, detail()))
    ];
    const old = el.querySelector('.rows'), top = old ? old.scrollTop : 0;
    el.replaceChildren(h('div', { class: 'en jr' }, head, ...body));
    const nr = el.querySelector('.rows');
    if (nr) nr.scrollTop = top;
  }

  load();
  return {
    update(c) { ctx = c; load(); },
    unmount() { seq++; }
  };
}
