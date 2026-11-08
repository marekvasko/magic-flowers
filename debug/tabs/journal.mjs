// Ladiaca stránka (#106): záložka Journal – denník dávok sveta zo súboru (aj pre nenačítaný svet): filtre podľa druhu,
// typu vstupu, hráča, osudu návrhu, kľúča a rozsahu krokov, stránkovanie od najnovšieho a jeden záznam rozobraný
// rovnako ako v záložke Engine. Údaje z /api/debug/journal, len na čítanie. Texty po anglicky.
import { ensureCss, renderer } from './engine.mjs';

const CSS = `
.jr .filters { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 8px; }
.jr .fl { display: flex; gap: 6px 10px; align-items: center; flex-wrap: wrap; }
.jr .fl > b { font-size: 12px; color: var(--muted); font-weight: 600; min-width: 56px; }
.jr .chip { font-size: 12px; padding: 1px 8px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; white-space: nowrap; }
.jr .chip small { color: var(--muted); margin-left: 3px; }
.jr .chip.inc { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.jr .chip.exc { border-color: #c0392b; color: #c0392b; text-decoration: line-through; }
.jr .chip.zero { opacity: .45; }
.jr .preset { font-size: 12.5px; }
.jr .preset.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
.jr input.q { flex: 1 1 260px; max-width: 420px; }
.jr .linkish { cursor: pointer; }
.jr .linkish:hover { text-decoration: underline; color: var(--accent); }
.jr .filters label { display: flex; gap: 4px; align-items: center; color: var(--muted); }
.jr .filters input[type=search], .jr .filters input[type=number] { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
.jr .filters input.tk { width: 110px; }
.jr .filters input.key { width: 170px; }
.jr .more { margin: 8px 0; display: flex; justify-content: center; }
.jr .load td { background: var(--accent-bg); }
`;
const FILTERS = [['jk', 'kind'], ['jt', 'type'], ['ja', 'actor'], ['jo', 'outcome'], ['jy', 'key'], ['jq', 'q'], ['jf', 'from'], ['jto', 'to']];
// rýchle nastavenia filtrov: { parameter: hodnota }, ostatné filtre sa vyčistia
const PRESETS = [
  ['All', {}],
  ['Conflicts', { jo: 'held,rejected,error' }],
  ['Errors', { jo: 'error' }],
  ['Player actions', { jk: 'actions', jt: '-pos,-seen' }],
  ['World events', { jk: 'events' }],
  ['Loads', { jk: 'load' }]
];

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
  const TPD = ctx.D.TICKS_PER_DAY;
  // krok z textu: „12345“, „d3“, „day 3 14:00“, „d3 6“ (deň hry od 1, čas hh[:mm])
  function tickOf(text, end) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) return +t;
    const m = /^d(?:ay)?\s*(\d+)(?:\s+(\d{1,2})(?::(\d{2}))?)?$/i.exec(t);
    if (!m) return NaN;
    const day = Math.max(1, +m[1]) - 1;
    if (m[2] == null) return day * TPD + (end ? TPD - 1 : 0);
    return day * TPD + Math.round(((+m[2]) * 60 + (+m[3] || 0)) / ctx.D.MIN_PER_TICK) + (end && m[3] == null ? Math.round(60 / ctx.D.MIN_PER_TICK) - 1 : 0);
  }
  const csv = k => (ctx.param(k) || '').split(',').filter(Boolean);

  function query(extra) {
    const p = new URLSearchParams({ room: ctx.room });
    for (const [k, q] of FILTERS) {
      if (!ctx.param(k)) continue;
      if (k === 'jf' || k === 'jto') { const t = tickOf(ctx.param(k), k === 'jto'); if (t != null && !isNaN(t)) p.set(q, t); }
      else p.set(q, ctx.param(k));
    }
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
  const apply = () => { rows = []; load(); };
  let typing = null;
  const set = (k, v, now) => { ctx.setParam(k, v); clearTimeout(typing); if (now) apply(); else typing = setTimeout(apply, 300); };
  // typ: klik prepína zahrnúť → vylúčiť → nič; hráč a osud: zahrnúť / nič (viac naraz = aspoň jeden)
  function toggle(k, v, cycle) {
    const cur = csv(k), inc = cur.includes(v), exc = cur.includes('-' + v);
    let nextList = cur.filter(x => x !== v && x !== '-' + v);
    if (!inc && !exc) nextList.push(v); else if (inc && cycle) nextList.push('-' + v);
    set(k, nextList.join(','), true);
  }
  function filters() {
    const d = data || { types: [], players: [], facets: { type: {}, actor: {}, outcome: {}, kind: {} } }, f = d.facets;
    const chip = (k, v, label, count, cycle, title) => {
      const cur = csv(k), state = cur.includes(v) ? ' inc' : cur.includes('-' + v) ? ' exc' : '';
      return h('button', { class: 'chip' + state + (!count && !state ? ' zero' : ''), title: title || (cycle ? 'click: only these · again: exclude · again: off' : 'click to toggle'), onclick: () => toggle(k, v, cycle) }, label, h('small', null, count || 0));
    };
    const text = (k, attrs) => {
      const i = h('input', Object.assign({ autocomplete: 'off', type: 'search', 'data-k': k }, attrs));
      i.value = ctx.param(k) || '';
      i.oninput = () => set(k, i.value.trim());
      return i;
    };
    const tick = (k, ph) => {
      const i = text(k, { class: 'tk', placeholder: ph, title: 'tick (12345) or game day and time: d3, d3 14:00' });
      const t = tickOf(ctx.param(k), k === 'jto');
      if (t != null && isNaN(t)) i.style.borderColor = '#c0392b';
      return h('label', { title: t != null && !isNaN(t) ? `tick ${t} · ${fmt.when(t)}` : null }, i);
    };
    const mv = h('input', { type: 'checkbox' });
    mv.checked = hideMoves();
    mv.onchange = () => set('jm', mv.checked ? null : '1', true);
    const active = FILTERS.some(([k]) => ctx.param(k));
    const isPreset = p => FILTERS.every(([k]) => (ctx.param(k) || '') === (p[k] || ''));
    const preset = ([label, p]) => h('button', { class: 'preset' + (isPreset(p) ? ' on' : ''), onclick: () => { for (const [k] of FILTERS) ctx.setParam(k, p[k] || null); apply(); } }, label);
    const kinds = [['events', 'event batches'], ['actions', 'action batches'], ['load', 'world loaded']];
    const types = Object.keys(Object.assign({}, ...d.types.map(t => ({ [t]: 1 })), f.type)).sort((a, b) => (f.type[b] || 0) - (f.type[a] || 0) || a.localeCompare(b));
    return h('div', { class: 'filters' },
      h('div', { class: 'fl' }, text('jq', { class: 'q', placeholder: 'Search text: payload, refusal message, key, player… (all words)' }), ...PRESETS.map(preset),
        active ? h('button', { onclick: () => { for (const [k] of FILTERS) ctx.setParam(k, null); apply(); } }, '✕ Clear') : null),
      h('div', { class: 'fl' }, h('b', null, 'Kind'), kinds.map(([v, t]) => h('button', { class: 'chip' + (ctx.param('jk') === v ? ' inc' : ''), onclick: () => set('jk', ctx.param('jk') === v ? null : v, true) }, t, h('small', null, f.kind[v] || 0))),
        h('b', { style: 'margin-left:12px' }, 'Outcome'), ['held', 'rejected', 'error', 'applied'].map(o => chip('jo', o, 'has ' + o, f.outcome[o], false))),
      h('div', { class: 'fl' }, h('b', null, 'Type'), types.map(t => chip('jt', t, t, f.type[t], true))),
      h('div', { class: 'fl' }, h('b', null, 'Player'), d.players.length ? d.players.map(p => chip('ja', p.id, p.name || p.id, f.actor[p.id], false, p.id)) : h('span', { class: 'muted' }, '–')),
      h('div', { class: 'fl' }, h('b', null, 'Key'), text('jy', { class: 'key', placeholder: 'e.g. market:seed_mak', title: 'Substring of a key some proposal read or wrote (tile:garden:12, save:p-…, contracts…). Click a key in a batch to fill it in.' }),
        h('b', { style: 'min-width:0;margin-left:8px' }, 'Ticks'), tick('jf', 'from, e.g. d2'), '–', tick('jto', 'to'),
        h('label', { title: 'Hide action batches that only moved players or refreshed “last seen”, without a conflict' }, mv, 'hide routine (moves, last seen)')));
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
          h('td', { class: 'bt' }, r.types.map((t, i) => [i ? ', ' : '', h('span', { class: 'linkish', title: 'filter by this type', onclick: ev => { ev.stopPropagation(); set('jt', t, true); } }, t)]).flat(), ' ', h('span', { class: 'src' }, r.kind === 'events' ? `${r.n} ev` : `${r.n} in`)),
          h('td', { class: 'bt' }, r.actors.length ? r.actors.map(a => h('div', { class: 'linkish', title: 'filter by this player', onclick: ev => { ev.stopPropagation(); if (!csv('ja').includes(a)) toggle('ja', a, false); } }, actor({ kind: 'player', key: a, name: nameOf(a) }))) : h('span', { class: 'muted' }, '–')),
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
    return R.detail(det, { onKey: k => { ctx.setParam('jy', k); apply(); } });
  }

  function render() {
    const head = h('h2', null, 'Journal', ctx.room ? h('span', { class: 'badge' }, ctx.room) : null);
    let body;
    if (!ctx.room) body = [h('div', { class: 'empty' }, 'Pick a room on the left.')];
    else if (err) body = [h('div', { class: 'empty err' }, /not found/.test(err) ? 'This room has no journal file.' : err)];
    else if (!data) body = [h('div', { class: 'empty' }, 'Loading…')];
    else body = [
      filters(),
      h('div', { class: 'note' }, h('b', null, `${data.matched} of ${data.total} lines match`), ` · newest first · ${data.files.map(f => `${f.name} (${fmtSize(f.size)})`).join(', ') || 'no journal file'}`,
        data.first != null ? `, ticks ${data.first}–${data.last} (${fmt.when(data.first)} – ${fmt.when(data.last)})` : '', `.`),
      h('div', { class: 'split' }, list(), h('div', null, detail()))
    ];
    const old = el.querySelector('.rows'), top = old ? old.scrollTop : 0;
    const fo = document.activeElement && el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement : null;
    const fk = fo && fo.dataset.k, caret = fo && fo.selectionStart;
    el.replaceChildren(h('div', { class: 'en jr' }, head, ...body));
    if (fk) { const n = el.querySelector(`input[data-k="${fk}"]`); if (n) { n.focus(); try { n.setSelectionRange(caret, caret); } catch (e) { /* number */ } } }
    const nr = el.querySelector('.rows');
    if (nr) nr.scrollTop = top;
  }

  load();
  return {
    update(c) { ctx = c; load(); },
    unmount() { seq++; }
  };
}
