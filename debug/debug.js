// Ladiaca stránka /debug (#64, #74): zoznam svetov, záložky a prehľad sveta. Všetko len číta cez /api/debug/*.
// Texty sú po anglicky (nástroj pre správcu). Údaje hráčov (mená…) idú do stránky len cez textContent.
(() => {
  const D = window.GameData;
  const $ = id => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'onclick') el.onclick = attrs[k];
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    return el;
  }

  const ISSUE = 'https://github.com/marekvasko/magic-flowers/issues/64';
  const TABS = [
    { id: 'room', label: 'Room' },
    { id: 'world', label: 'World', todo: 'A free camera over the whole rendered world of the selected room and area, with time, season and layer controls and visual debug helpers (bounding boxes, tile grid, tap areas, lights).' },
    { id: 'assets', label: 'Assets', todo: 'A 3D viewer with a list of every model (buildings, market stall, well, cauldron, icehouse, trees, bushes, rocks, flowers…), switchable season and rotation.' },
    { id: 'generators', label: 'Generators', todo: 'Seeds and parameter sliders for the procedural generators (trees first, their parameters already exist in World3D.TREE_PARAMS), area layouts side by side, and “copy parameters”.' },
    { id: 'market', label: 'Market', todo: 'Prices, stock and price history of the selected room, NPC state, festivals, contracts, and why each price is what it is.' }
  ];
  const SEASON_EN = ['Spring', 'Summer', 'Autumn', 'Winter'];

  // stav v adrese: #tab=room&room=zahrada&area=garden
  const st = Object.assign({ tab: 'room', room: '', area: 'garden' }, Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
  if (!TABS.some(t => t.id === st.tab)) st.tab = 'room';
  if (!D.AREAS.includes(st.area)) st.area = 'garden';
  let rooms = [], roomsErr = null, snap = null, snapErr = null, serverNow = Date.now();
  const saveHash = () => history.replaceState(null, '', '#' + new URLSearchParams({ tab: st.tab, room: st.room, area: st.area }));

  async function api(p) {
    const r = await fetch(p, { cache: 'no-store' });
    if (r.status === 404 && p.endsWith('/rooms')) throw new Error('Not authorised – open /debug?key=… again.');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // ---------- formát ----------
  const fmtSize = n => n == null ? '–' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
  function ago(ms) {
    if (!ms) return 'never saved';
    const s = Math.max(0, (serverNow - ms) / 1000);
    return s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  }
  const hhmm = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const when = tick => `day ${D.dayOfTick(tick)} ${hhmm(D.minOfTick(tick))}`;
  function inTicks(dt) {
    const m = dt * D.MIN_PER_TICK;
    return m < 60 ? `in ${m} min` : m < 1440 ? `in ${(m / 60).toFixed(1)} h` : `in ${(m / 1440).toFixed(1)} d`;
  }
  const short = v => { const s = JSON.stringify(v); return s == null ? '' : s.length > 80 ? s.slice(0, 77) + '…' : s; };

  // ---------- zoznam svetov ----------
  function renderRooms() {
    const q = $('search').value.trim().toLowerCase();
    const list = rooms.filter(r => r.id.includes(q));
    $('roomsMeta').textContent = `${rooms.length} room${rooms.length === 1 ? '' : 's'} · ${rooms.reduce((n, r) => n + r.online.length, 0)} online`;
    $('rooms').replaceChildren(...list.map(r => h('li', { class: r.id === st.room ? 'on' : null, onclick: () => selectRoom(r.id) },
      h('span', { class: 'id' }, r.online.length ? h('span', { class: 'dot', title: 'players online' }) : null, r.id),
      r.loaded ? h('span', { class: 'badge live' }, 'loaded') : h('span', { class: 'badge' }, 'file'),
      h('span', { class: 'sub' }, [ago(r.saved), fmtSize(r.size), r.online.length ? r.online.map(o => o.name).join(', ') : null].filter(Boolean).join(' · ')))));
    if (!list.length) $('rooms').appendChild(h('li', { class: 'muted' }, rooms.length ? 'No match' : 'No rooms yet'));
  }
  async function loadRooms() {
    try { const j = await api('/api/debug/rooms'); rooms = j.rooms; serverNow = j.now; roomsErr = null; }
    catch (e) { rooms = []; roomsErr = e.message; }
    if (!st.room && rooms.length) st.room = rooms[0].id;
    renderRooms();
  }
  async function loadRoom() {
    if (!st.room) { snap = null; return; }
    try { snap = await api('/api/debug/room?id=' + encodeURIComponent(st.room)); snapErr = null; }
    catch (e) { snap = null; snapErr = e.message; }
  }
  async function selectRoom(id) { st.room = id; saveHash(); renderRooms(); await loadRoom(); render(); }

  // ---------- záložky ----------
  function renderTabs() {
    $('tabs').replaceChildren(...TABS.map(t => h('button', { class: t.id === st.tab ? 'on' : null, onclick: () => { st.tab = t.id; saveHash(); renderTabs(); render(); } }, t.label)));
  }
  function render() {
    const main = $('main'), tab = TABS.find(t => t.id === st.tab);
    if (tab.todo) {
      main.replaceChildren(h('div', { class: 'placeholder' }, h('h2', null, tab.label), h('p', null, tab.todo),
        h('p', { class: 'muted' }, 'Not built yet. It’s a later part of ', h('a', { href: ISSUE, target: '_blank', rel: 'noopener' }, '#64'), '.'),
        h('p', { class: 'muted' }, `Selected: room ${st.room || '–'}, area ${D.AREA_NAMES[st.area] || st.area}.`)));
      return;
    }
    if (roomsErr) return main.replaceChildren(h('div', { class: 'empty err' }, roomsErr));
    if (!st.room) return main.replaceChildren(h('div', { class: 'empty' }, 'Pick a room on the left.'));
    if (snapErr) return main.replaceChildren(h('div', { class: 'empty err' }, `Room ${st.room}: ${snapErr}`));
    if (!snap) return main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    main.replaceChildren(...roomView(snap));
  }

  // ---------- záložka Room: prehľad sveta ----------
  function roomView(s) {
    const w = s.state, tick = w.tick || 0, day = D.dayOfTick(tick), se = D.seasonOf(day), meta = rooms.find(r => r.id === s.id);
    const saves = Object.entries(w.saves || {}), events = (w.events || []).slice().sort((a, b) => a.at - b.at || a.seq - b.seq);
    const onlineBy = new Map(s.online.map(o => [o.player, o]));
    const card = (label, value, sub) => h('div', { class: 'card' }, h('small', null, label), h('b', null, value), sub ? h('small', null, sub) : null);
    const m = w.market || {}, sum = o => Object.values(o || {}).reduce((n, x) => n + (x.stock || 0), 0);
    const out = [
      h('h2', null, s.id,
        h('span', { class: 'badge' + (s.source === 'memory' ? ' live' : '') }, s.source === 'memory' ? 'loaded – live state' : 'read from file'),
        s.online.length ? h('span', { class: 'badge live' }, s.online.length + ' online') : null),
      h('div', { class: 'muted' }, meta ? `saved ${ago(meta.saved)} · ${fmtSize(meta.size)}` : '', w.migratedFrom && w.migratedFrom !== w.v ? ` · migrated from save v${w.migratedFrom}` : '', ` · save v${w.v}`),
      h('div', { class: 'cards' },
        card('Day', `${day}`, `${D.SEASON_ICONS ? D.SEASON_ICONS[se] + ' ' : ''}${SEASON_EN[se]}, day ${(day - 1) % D.DAYS_PER_SEASON + 1}/${D.DAYS_PER_SEASON}`),
        card('Time', hhmm(D.minOfTick(tick)), `tick ${tick}`),
        card('Mode', w.mode || '–', w.mode === 'paused' ? 'time stops when empty' : 'time runs offline'),
        card('Day length', `${Math.round((w.daySeconds || D.BASE_DAY_SECONDS) / 60)} min`, `${w.daySeconds || D.BASE_DAY_SECONDS} s`),
        card('Weather', w.weather || '–', w.fairyNight >= 0 ? 'fairy night day ' + w.fairyNight : null),
        card('Players', `${saves.length}`, `${s.online.length} online`),
        card('Events', `${events.length}`, events[0] ? `next ${events[0].type}` : null),
        card('Market stock', `${sum(m.seeds)} seeds`, `${sum(m.flowers)} flowers${m.compost ? ', ' + (m.compost.stock || 0) + ' compost' : ''}`),
        card('Contracts', `${((w.contracts || {}).list || []).length}`, 'on the board'),
        card('Icehouse', w.icehouse && w.icehouse.built ? `${w.icehouse.ice || 0} ice` : 'not built'))
    ];

    out.push(h('h3', null, `Players (${saves.length})`));
    out.push(saves.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, ['Player', 'Online as', 'Area', 'Coins', 'Rep', 'Water', 'Inventory', 'Recipes', 'Upgrades', 'Last seen'].map((c, i) => h('th', { class: [3, 4, 5, 6, 7].includes(i) ? 'num' : null }, c))),
      saves.sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0)).map(([id, sv]) => {
        const o = onlineBy.get(id), inv = Object.values(sv.inv || {}).reduce((n, v) => n + (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 1), 0);
        return h('tr', null, h('td', { class: 'mono' }, id), h('td', null, o ? h('span', null, h('span', { class: 'dot' }), o.name) : '–'),
          h('td', null, D.AREA_NAMES[o ? o.area : sv.area] || sv.area || 'garden'),
          h('td', { class: 'num' }, sv.coins), h('td', { class: 'num' }, `${sv.rep || 0} (L${D.repLevel(sv.rep || 0)})`), h('td', { class: 'num' }, sv.water),
          h('td', { class: 'num' }, inv), h('td', { class: 'num' }, (sv.recipes || []).length),
          h('td', { class: 'mono' }, sv.up ? Object.entries(sv.up).map(([k, v]) => `${k} ${v}`).join(', ') : '–'),
          h('td', null, o ? 'now' : sv.lastTick != null ? when(sv.lastTick) : '–'));
      }))) : h('div', { class: 'empty' }, 'Nobody has played here yet.'));

    out.push(h('h3', null, `Upcoming events (${events.length})`));
    out.push(events.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, h('th', null, 'When'), h('th', null, ''), h('th', null, 'Type'), h('th', null, 'Data')),
      events.slice(0, 25).map(e => h('tr', null, h('td', null, when(e.at)), h('td', { class: 'muted' }, inTicks(e.at - tick)), h('td', null, h('b', null, e.type)), h('td', { class: 'mono' }, short(e.data)))),
      events.length > 25 ? h('tr', null, h('td', { colspan: 4, class: 'muted' }, `… and ${events.length - 25} more (see raw state)`)) : null)) : h('div', { class: 'empty' }, 'No events scheduled.'));

    out.push(h('h3', null, 'Raw state'));
    out.push(h('div', { class: 'json' }, jsonNode('state', w, true)));
    return out;
  }

  // JSON strom: deti sa vytvoria až pri prvom rozbalení
  function jsonNode(key, v, open) {
    const label = key != null ? [h('span', { class: 'k' }, key), ': '] : [];
    if (v === null || typeof v !== 'object') {
      return h('div', { class: 'leaf' }, ...label, h('span', { class: typeof v === 'string' ? 's' : 'n' }, JSON.stringify(v)));
    }
    const arr = Array.isArray(v), n = arr ? v.length : Object.keys(v).length;
    const d = h('details', null, h('summary', null, ...label, h('span', { class: 'muted' }, arr ? `[${n}]` : `{${n}}`), ' ', h('span', { class: 'muted' }, n ? short(v) : '')));
    let built = false;
    d.addEventListener('toggle', () => {
      if (!d.open || built) return;
      built = true;
      const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
      const LIMIT = 500;
      for (const [k, x] of entries.slice(0, LIMIT)) d.appendChild(jsonNode(k, x));
      if (entries.length > LIMIT) d.appendChild(h('div', { class: 'leaf muted' }, `… ${entries.length - LIMIT} more`));
    });
    if (open) d.open = true;
    return d;
  }

  // ---------- ovládanie ----------
  $('area').replaceChildren(...D.AREAS.map(a => h('option', { value: a, selected: a === st.area ? 'selected' : null }, D.AREA_NAMES[a] || a)));
  $('area').onchange = () => { st.area = $('area').value; saveHash(); render(); };
  $('search').oninput = renderRooms;
  async function refresh() { await loadRooms(); await loadRoom(); render(); }
  $('refresh').onclick = refresh;
  let timer = null;
  $('auto').onchange = () => { clearInterval(timer); timer = $('auto').checked ? setInterval(refresh, 5000) : null; };
  window.addEventListener('hashchange', () => {
    const p = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
    if (p.room && p.room !== st.room) selectRoom(p.room);
  });

  renderTabs();
  refresh().then(saveHash);
})();
