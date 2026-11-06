// Ladiaca stránka: záložka Journal – denník zmien plánovača (journal.js: add, replace, cancel, run, drop)
// s filtrami, hlavne podľa kľúča udalosti (presný kľúč alebo predpona s *, napr. move:*, spider:*).
// Údaje z /api/debug/journal (filtruje server, na konci denníka). Texty po anglicky.

const CSS = `
.jr-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 8px; }
.jr-bar input[type=search] { flex: 1 1 200px; max-width: 320px; font-family: var(--mono); }
.jr-chips { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
.jr-chips button { font-size: 12px; padding: 1px 8px; border-radius: 10px; }
.jr-chips button.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
.jr-chips button small { color: var(--muted); margin-left: 4px; }
.jr-chips .lbl { font-size: 12px; color: var(--muted); min-width: 56px; align-self: center; }
.jr td.k button, .jr td.t button { all: unset; cursor: pointer; font-family: var(--mono); }
.jr td.k button:hover, .jr td.t button:hover { color: var(--accent); text-decoration: underline; }
.jr td.d { font-family: var(--mono); font-size: 12px; white-space: normal; word-break: break-all; min-width: 240px; }
.jr td.d details summary { cursor: pointer; list-style: none; }
.jr td.d pre { margin: 4px 0 0; white-space: pre-wrap; }
.jr .kd { font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); }
.jr .kd.run { color: var(--ok); border-color: var(--ok); }
.jr .kd.add { color: var(--accent); border-color: var(--accent); }
.jr .kd.replace, .jr .kd.cancel { color: var(--muted); }
.jr .kd.drop, .jr .kd.err { color: var(--warn); border-color: var(--warn); }
.jr tr.err td { background: color-mix(in srgb, var(--warn) 12%, transparent); }
.jr details.keys > summary { cursor: pointer; font-size: 12.5px; color: var(--muted); margin: 4px 0; }
`;

export function mount(el, ctx0) {
  if (!document.getElementById('tab-journal-css')) {
    const st = document.createElement('style');
    st.id = 'tab-journal-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  let ctx = ctx0, data = null, err = null, seq = 0, keysOpen = false;
  const { h, D, fmt } = ctx;
  const P = { key: ctx.param('jkey') || '', kind: ctx.param('jkind') || '', type: ctx.param('jtype') || '', q: ctx.param('jq') || '', limit: ctx.param('jlimit') || '300' };
  const set = (k, v) => { P[k] = v; ctx.setParam('j' + k, v); load(); };
  const listOf = v => v.split(',').map(x => x.trim()).filter(Boolean);
  const toggle = (k, v) => { const l = listOf(P[k]); set(k, (l.includes(v) ? l.filter(x => x !== v) : l.concat(v)).join(',')); };

  const keyIn = h('input', { type: 'search', placeholder: 'Key: move:*, spider:s3, dawn, - (no key)…', autocomplete: 'off', title: 'Exact key or prefix ending in *, several separated by commas; - = events without a key' });
  const qIn = h('input', { type: 'search', placeholder: 'Text anywhere…', autocomplete: 'off' });
  const limitSel = h('select', { title: 'Newest entries shown' }, ['100', '300', '1000', '2000'].map(n => h('option', { value: n }, n + ' rows')));
  keyIn.value = P.key; qIn.value = P.q; limitSel.value = P.limit;
  let typing = null;
  const debounce = (k, input) => () => { clearTimeout(typing); typing = setTimeout(() => set(k, input.value.trim()), 250); };
  keyIn.oninput = debounce('key', keyIn); qIn.oninput = debounce('q', qIn);
  limitSel.onchange = () => set('limit', limitSel.value);
  const clear = h('button', { onclick: () => { keyIn.value = qIn.value = ''; for (const k of ['key', 'kind', 'type', 'q']) { P[k] = ''; ctx.setParam('j' + k, ''); } load(); } }, 'Clear filters');
  const body = h('div');
  el.append(h('div', { class: 'jr' }, h('h2', null, 'Event journal'),
    h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Every change of the scheduler, appended to ', h('code', null, 'journal-<room>.jsonl'),
      ': add (scheduled), replace (a newer event with the same key took its place), cancel, run (with the error if its handler threw), drop (removed by the reconciler). Newest first; the server reads the last few MB.'),
    h('div', { class: 'jr-bar' }, keyIn, qIn, limitSel, clear), body));

  async function load() {
    const room = ctx.room, my = ++seq;
    if (!room) { data = null; err = null; return render(); }
    const qs = new URLSearchParams({ id: room, key: P.key, kind: P.kind, type: P.type, q: P.q, limit: P.limit });
    try { const j = await ctx.api('/api/debug/journal?' + qs); if (my !== seq) return; data = j; err = null; }
    catch (e) { if (my !== seq) return; data = null; err = e.message; }
    render();
  }

  const realTime = ms => { const d = new Date(ms); return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
  const chip = (label, n, on, onclick, title) => h('button', { class: on ? 'on' : null, onclick, title }, label, n != null ? h('small', null, n) : null);
  function chips(label, items) { return h('div', { class: 'jr-chips' }, h('span', { class: 'lbl' }, label), items); }

  function render() {
    if (!ctx.room) return body.replaceChildren(h('div', { class: 'empty' }, 'Pick a room on the left.'));
    if (err) return body.replaceChildren(h('div', { class: 'empty err' }, err));
    if (!data) return body.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    const keys = listOf(P.key), kinds = listOf(P.kind), types = listOf(P.type), f = data.facets;
    const kindN = new Map(f.kind.map(x => [x.k, x.n]));
    const out = [
      h('div', { class: 'muted' }, data.total ? `${data.matched} of ${data.total} entries match · from ${fmt.when(data.from.tick)} (${new Date(data.from.ms).toLocaleString('en-GB')}) to ${fmt.when(data.to.tick)}` : 'The journal is empty.',
        data.loaded ? '' : ' · room not loaded (only what was written before)'),
      chips('Kind', data.kinds.map(k => chip(k, kindN.get(k) || 0, kinds.includes(k), () => toggle('kind', k)))),
      chips('Family', f.family.map(x => chip(x.k === '-' ? '(no key)' : x.k, x.n, keys.includes(x.k), () => toggle('key', x.k), x.k === '-' ? 'Events without a key' : 'All keys starting with ' + x.k.slice(0, -1)))),
      chips('Type', f.type.map(x => chip(x.k, x.n, types.includes(x.k), () => toggle('type', x.k))))
    ];
    const keyBox = h('details', { class: 'keys' }, h('summary', null, `Unique keys (${f.key.length}${f.key.length >= 150 ? '+' : ''}) – click one to follow just that key`),
      chips('', f.key.map(x => chip(x.k, x.n, keys.includes(x.k), () => toggle('key', x.k), 'last at tick ' + x.tick))));
    keyBox.open = keysOpen;
    keyBox.addEventListener('toggle', () => { keysOpen = keyBox.open; });
    out.push(keyBox);
    if (!data.entries.length) out.push(h('div', { class: 'empty' }, data.total ? 'No entry matches the filters.' : 'Nothing recorded yet.'));
    else out.push(h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, ['#', 'Game time', 'Real time', 'Kind', 'Key', 'Type', 'At', 'Data'].map(c => h('th', null, c))),
      data.entries.map(e => h('tr', { class: e.err ? 'err' : null },
        h('td', { class: 'muted mono', title: 'server start ' + new Date(e.b).toLocaleString('en-GB') }, e.n),
        h('td', { title: 'tick ' + e.tick }, fmt.when(e.tick)),
        h('td', { class: 'muted mono' }, realTime(e.ms)),
        h('td', null, h('span', { class: 'kd ' + (e.err ? 'err' : e.kind), title: e.err || e.why || '' }, e.err ? 'error' : e.kind), e.periodic ? h('span', { class: 'muted', title: 'periodic' }, ' ↻') : null),
        h('td', { class: 'k' }, e.key == null ? h('span', { class: 'muted' }, '–') : h('button', { onclick: () => { keyIn.value = e.key; set('key', e.key); }, title: 'Show only this key' }, e.key)),
        h('td', { class: 't' }, h('button', { onclick: () => toggle('type', e.type), title: 'Filter by this type' }, e.type)),
        h('td', { class: 'muted', title: 'tick ' + e.at }, e.at == null ? '' : e.at === e.tick ? 'now' : (e.at > e.tick ? '+' : '') + (e.at - e.tick)),
        h('td', { class: 'd' }, e.err || e.why ? h('div', { class: 'kd err', style: 'display:inline-block;margin-bottom:2px' }, e.err || e.why) : null,
          h('details', null, h('summary', null, fmt.short(e.data)), h('pre', null, JSON.stringify(e.data, null, 1)))))))));
    body.replaceChildren(...out);
  }

  load();
  return {
    update(c) { ctx = c; load(); },
    unmount() { seq++; clearTimeout(typing); }
  };
}
