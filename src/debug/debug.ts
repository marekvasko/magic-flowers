// Ladiaca stránka /debug (#64, #74): zoznam svetov, záložky a prehľad sveta. Všetko len číta cez /api/debug/*.
// Texty sú po anglicky (nástroj pre správcu). Údaje hráčov (mená…) idú do stránky len cez textContent.
// Zbalí ho esbuild (#137); záložky sú samostatné kúsky balíka, načítajú sa až pri otvorení.
import * as D from '../shared/data.ts';
import { must } from '../shared/util.ts';
import type { ReconcilerView, RoomInfo, RoomSnapshot } from '../server/debug.ts';
import { errText, h } from './ui.ts';
import type { Kid, TabCtx, TabInstance, TabModule } from './ui.ts';

(() => {
  const $ = (id: string): HTMLElement => must(document.getElementById(id) ?? undefined);
  const $as = <T extends HTMLElement>(id: string, type: new () => T): T => { const el = $(id); if (!(el instanceof type)) throw new Error('#' + id + ': zlý druh prvku'); return el; };

  const ISSUE = 'https://github.com/marekvasko/magic-flowers/issues/64';
  interface Tab { id: string; label: string; todo?: string }
  const TABS: readonly Tab[] = [
    { id: 'room', label: 'Room' },
    { id: 'map', label: 'Map', todo: 'A top-down plan of every area: ground heights, paths, objects, gates and a grid as layers, a tile inspector and area stats, for any seed or for the selected room.' },
    { id: 'world', label: 'World', todo: 'A free camera over the whole rendered world of the selected room and area, with time, season and layer controls and visual debug helpers (bounding boxes, tile grid, tap areas, lights).' },
    { id: 'assets', label: 'Assets', todo: 'A 3D viewer with a list of every model (buildings, market stall, well, cauldron, icehouse, trees, bushes, rocks, flowers…), switchable season and rotation.' },
    { id: 'generators', label: 'Generators', todo: 'Seeds and parameter sliders for the procedural generators (trees first, their parameters already exist in World3D.TREE_PARAMS), area layouts side by side, and “copy parameters”.' },
    { id: 'market', label: 'Market', todo: 'Prices, stock and price history of the selected room, NPC state, festivals, contracts, and why each price is what it is.' },
    { id: 'engine', label: 'Engine', todo: 'The last batches of the engine: proposals, keys, decisions with their reasons, world changes, the actor filter and the queue with who scheduled what.' },
    { id: 'journal', label: 'Journal', todo: 'Browse and filter the journal file of a room: every committed batch, by kind, type, player, outcome, key and ticks.' },
    { id: 'transport', label: 'Transport', todo: 'Fúrik, sane, dock and boat in one place: who uses them, where they are, their next events and combined cheats (#161).' },
    { id: 'cheats', label: 'Cheats', todo: 'Give players coins, reputation and items, fill the storage and icehouse, jump forward in time and change the speed of time (needs the cheat key).' }
  ];
  const SEASON_EN = ['Spring', 'Summer', 'Autumn', 'Winter'];

  // stav v adrese: #tab=room&room=zahrada&area=garden (+ vlastné parametre záložiek, napr. seed)
  const st: Partial<Record<string, string>> & { tab: string; room: string; area: D.AreaId } = { tab: 'room', room: '', area: 'garden' };
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) st[k] = v;
  if (!TABS.some(t => t.id === st.tab)) st.tab = 'room';
  const isArea = (a: string | undefined): a is D.AreaId => D.AREAS.some(x => x === a);
  if (!isArea(st.area)) st.area = 'garden';
  let rooms: RoomInfo[] = [], roomsErr: string | null = null, snap: RoomSnapshot | null = null, snapErr: string | null = null, serverNow = Date.now();
  const saveHash = (): void => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(st)) if (v != null) p.set(k, v); history.replaceState(null, '', '#' + p.toString()); };

  // Odpoveď nášho servera (/api/debug/*): JSON, ktorého tvar opisujú typy v src/server/debug*.ts – jediné pretypovanie
  async function api<T>(p: string): Promise<T> {
    const r = await fetch(p, { cache: 'no-store' });
    const j: unknown = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((typeof j === 'object' && j && 'error' in j && typeof j.error === 'string' ? j.error : '') || 'HTTP ' + r.status);
    return j as T;
  }

  // ---------- formát ----------
  const fmtSize = (n: number | null | undefined): string => n == null ? '–' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
  function ago(ms: number | null | undefined): string {
    if (!ms) return 'never saved';
    const s = Math.max(0, (serverNow - ms) / 1000);
    return s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  }
  const hhmm = (min: number): string => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(Math.floor(min % 60)).padStart(2, '0');
  const when = (tick: number): string => `day ${D.dayOfTick(tick)} ${hhmm(D.minOfTick(tick))}`;
  function inTicks(dt: number): string {
    const m = dt * D.MIN_PER_TICK;
    return m < 60 ? `in ${m} min` : m < 1440 ? `in ${(m / 60).toFixed(1)} h` : `in ${(m / 1440).toFixed(1)} d`;
  }
  const short = (v: unknown): string => { const s = JSON.stringify(v) as string | undefined; /* undefined pre undefined a funkcie */ return s == null ? '' : s.length > 80 ? s.slice(0, 77) + '…' : s; };

  // ---------- zoznam svetov ----------
  function renderRooms(): void {
    const q = $as('search', HTMLInputElement).value.trim().toLowerCase();
    const list = rooms.filter(r => r.id.includes(q));
    $('roomsMeta').textContent = `${rooms.length} room${rooms.length === 1 ? '' : 's'} · ${rooms.reduce((n, r) => n + r.online.length, 0)} online`;
    $('rooms').replaceChildren(...list.map(r => h('li', { class: r.id === st.room ? 'on' : null, onclick: () => { void selectRoom(r.id); } },
      h('span', { class: 'id' }, r.online.length ? h('span', { class: 'dot', title: 'players online' }) : null, r.id),
      r.loaded ? h('span', { class: 'badge live' }, 'loaded') : h('span', { class: 'badge' }, 'file'),
      h('span', { class: 'sub' }, [ago(r.saved), fmtSize(r.size), r.online.length ? r.online.map(o => o.name).join(', ') : null].filter(Boolean).join(' · ')))));
    if (!list.length) $('rooms').appendChild(h('li', { class: 'muted' }, rooms.length ? 'No match' : 'No rooms yet'));
  }
  async function loadRooms(): Promise<void> {
    try { const j = await api<{ rooms: RoomInfo[]; now: number }>('/api/debug/rooms'); rooms = j.rooms; serverNow = j.now; roomsErr = null; }
    catch (e) { rooms = []; roomsErr = errText(e); }
    if (!st.room && rooms[0]) st.room = rooms[0].id;
    renderRooms();
  }
  async function loadRoom(): Promise<void> {
    if (!st.room) { snap = null; return; }
    try { snap = await api<RoomSnapshot>('/api/debug/room?id=' + encodeURIComponent(st.room)); snapErr = null; }
    catch (e) { snap = null; snapErr = errText(e); }
  }
  async function selectRoom(id: string): Promise<void> { st.room = id; saveHash(); renderRooms(); await loadRoom(); render(); }

  // ---------- záložky ----------
  function renderTabs(): void {
    $('tabs').replaceChildren(...TABS.map(t => h('button', { class: t.id === st.tab ? 'on' : null, onclick: () => { st.tab = t.id; saveHash(); renderTabs(); render(); } }, t.label)));
  }
  // Záložky okrem Room sú samostatné moduly src/debug/tabs/<id>.ts (v balíku samostatné kúsky, načítajú sa až pri otvorení):
  //   export function mount(el, ctx) → { update?(ctx), unmount?() }
  // ctx: { room, area, snap, rooms, param(k), setParam(k, v), setArea(a), refresh(), api(path), h, D, fmt }
  // update(ctx) príde pri zmene sveta, plochy alebo po obnovení; unmount pri prepnutí záložky.
  // Keď modul ešte neexistuje, ukáže sa popis, čo v záložke bude.
  // záložka → modul (esbuild z nich spraví samostatné kúsky balíka)
  const LOADERS: Readonly<Partial<Record<string, () => Promise<TabModule>>>> = {
    map: () => import('./tabs/map.ts'), world: () => import('./tabs/world.ts'), assets: () => import('./tabs/assets.ts'),
    generators: () => import('./tabs/generators.ts'), market: () => import('./tabs/market.ts'), engine: () => import('./tabs/engine.ts'),
    journal: () => import('./tabs/journal.ts'), transport: () => import('./tabs/transport.ts'), cheats: () => import('./tabs/cheats.ts')
  };
  const mods: Partial<Record<string, Promise<TabModule | null>>> = {};
  let mounted: { id: string; inst: TabInstance } | null = null, renderSeq = 0;
  const fmt = { when: (t: number) => when(t), hhmm, inTicks, ago: (ms: number | null | undefined) => ago(ms), size: fmtSize, short, SEASON_EN };
  function ctx(): TabCtx {
    return {
      room: st.room, area: st.area, snap, rooms, h, D, fmt,
      api: <T>(p: string) => api<T>(p),
      param: k => st[k] ?? null,
      setParam: (k, v) => { if (v == null || v === '') delete st[k]; else st[k] = String(v); saveHash(); },
      setArea: a => { if (isArea(a)) { st.area = a; $as('area', HTMLSelectElement).value = a; saveHash(); render(); } },
      refresh: () => refresh()
    };
  }
  function unmountTab(): void {
    if (mounted?.inst.unmount) try { mounted.inst.unmount(); } catch (e) { console.error(e); }
    mounted = null;
  }
  function render(): void {
    const main = $('main'), tab = TABS.find(t => t.id === st.tab) ?? must(TABS[0]), seq = ++renderSeq;
    if (tab.id !== 'room') {
      if (mounted && mounted.id === tab.id) { if (mounted.inst.update) mounted.inst.update(ctx()); return; }
      unmountTab();
      const load = LOADERS[tab.id];
      const mod = mods[tab.id] ??= load ? load().catch((e: unknown) => { console.error(e); return null; }) : Promise.resolve(null);
      void mod.then(m => {
        if (seq !== renderSeq) return;
        if (m) { main.replaceChildren(); mounted = { id: tab.id, inst: m.mount(main, ctx()) || {} }; }
        else placeholder(main, tab);
      });
      return;
    }
    unmountTab();
    if (roomsErr) { main.replaceChildren(h('div', { class: 'empty err' }, roomsErr)); return; }
    if (!st.room) { main.replaceChildren(h('div', { class: 'empty' }, 'Pick a room on the left.')); return; }
    if (snapErr) { main.replaceChildren(h('div', { class: 'empty err' }, `Room ${st.room}: ${snapErr}`)); return; }
    if (!snap) { main.replaceChildren(h('div', { class: 'empty' }, 'Loading…')); return; }
    main.replaceChildren(...roomView(snap));
  }
  function placeholder(main: HTMLElement, tab: Tab): void {
      main.replaceChildren(h('div', { class: 'placeholder' }, h('h2', null, tab.label), h('p', null, tab.todo),
        h('p', { class: 'muted' }, 'Not built yet. It’s a later part of ', h('a', { href: ISSUE, target: '_blank', rel: 'noopener' }, '#64'), '.'),
        h('p', { class: 'muted' }, `Selected: room ${st.room || '–'}, area ${D.AREA_NAMES[st.area] || st.area}.`)));
  }
  // ---------- záložka Room: prehľad sveta ----------
  function roomView(s: RoomSnapshot): Node[] {
    const w = s.state, tick = w.tick || 0, day = D.dayOfTick(tick), se = D.seasonOf(day), meta = rooms.find(r => r.id === s.id);
    const saves = Object.entries(w.saves || {}).flatMap(([id, sv]) => sv ? [[id, sv] as const] : []), events = (w.events || []).slice().sort((a, b) => a.at - b.at || a.seq - b.seq);
    const onlineBy = new Map(s.online.map(o => [o.player, o]));
    const num = (v: unknown): number => typeof v === 'number' ? v : 0;
    const card = (label: string, value: string, sub?: string | null): HTMLElement => h('div', { class: 'card' }, h('small', null, label), h('b', null, value), sub ? h('small', null, sub) : null);
    const m = w.market, sum = (o: Partial<Record<string, { stock?: number }>> | undefined): number => Object.values(o || {}).reduce((n, x) => n + (x?.stock || 0), 0);
    const out: Node[] = [
      h('h2', null, s.id,
        h('span', { class: 'badge' + (s.source === 'memory' ? ' live' : '') }, s.source === 'memory' ? 'loaded – live state' : 'read from file'),
        s.online.length ? h('span', { class: 'badge live' }, s.online.length + ' online') : null),
      h('div', { class: 'muted' }, meta ? `saved ${ago(meta.saved)} · ${fmtSize(meta.size)}` : '', num(w['migratedFrom']) && w['migratedFrom'] !== w['v'] ? ` · migrated from save v${num(w['migratedFrom'])}` : '', ` · save v${num(w['v'])}`),
      h('div', { class: 'cards' },
        card('Day', `${day}`, `${D.SEASON_ICONS[se] ?? ''} ${SEASON_EN[se] ?? ''}, day ${(day - 1) % D.DAYS_PER_SEASON + 1}/${D.DAYS_PER_SEASON}`),
        card('Time', hhmm(D.minOfTick(tick)), `tick ${tick}`),
        card('Mode', typeof w['mode'] === 'string' && w['mode'] ? w['mode'] : '–', w['mode'] === 'paused' ? 'time stops when empty' : 'time runs offline'),
        card('Day length', `${Math.round((num(w['daySeconds']) || D.BASE_DAY_SECONDS) / 60)} min`, `${num(w['daySeconds']) || D.BASE_DAY_SECONDS} s`),
        card('Weather', w.weather || '–', num(w['fairyNight']) >= 0 && w['fairyNight'] != null ? 'fairy night day ' + num(w['fairyNight']) : null),
        card('Players', `${saves.length}`, `${s.online.length} online`),
        card('Events', `${events.length}`, events[0] ? `next ${events[0].type}` : null),
        card('Market stock', `${sum(m?.seeds)} seeds`, `${sum(m?.flowers)} flowers${m?.compost ? ', ' + (m.compost.stock || 0) + ' compost' : ''}`),
        card('Contracts', `${(w.contracts?.list || []).length}`, 'on the board'),
        card('Icehouse', w.icehouse && w.icehouse.built ? `${w.icehouse.ice || 0} ice` : 'not built'))
    ];

    out.push(...reconcilerView(s.reconciler, tick));

    out.push(h('h3', null, `Players (${saves.length})`));
    out.push(saves.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, ['Player', 'Online as', 'Area', 'Coins', 'Rep', 'Water', 'Inventory', 'Recipes', 'Upgrades', 'Last seen'].map((c, i) => h('th', { class: [3, 4, 5, 6, 7].includes(i) ? 'num' : null }, c))),
      saves.sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0)).map(([id, sv]) => {
        const vals: unknown[] = Object.values(sv.inv); // staré uloženia mali v batohu aj zoznamy
        const o = onlineBy.get(id), inv = vals.reduce<number>((n, v) => n + (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 1), 0);
        return h('tr', null, h('td', { class: 'mono' }, id), h('td', null, o ? h('span', null, h('span', { class: 'dot' }), o.name) : '–'),
          h('td', null, D.AREA_NAMES[o ? o.area : sv.area ?? 'garden']),
          h('td', { class: 'num' }, sv.coins), h('td', { class: 'num' }, `${sv.rep || 0} (L${D.repLevel(sv.rep || 0)})`), h('td', { class: 'num' }, sv.water),
          h('td', { class: 'num' }, inv), h('td', { class: 'num' }, sv.recipes.length),
          h('td', { class: 'mono' }, Object.entries(sv.up).map(([k, v]) => `${k} ${v}`).join(', ') || '–'),
          h('td', null, o ? 'now' : sv.lastTick != null ? when(sv.lastTick) : '–'));
      }))) : h('div', { class: 'empty' }, 'Nobody has played here yet.'));

    out.push(h('h3', null, `Upcoming events (${events.length})`));
    out.push(events.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, h('th', null, 'When'), h('th', null, ''), h('th', null, 'Type'), h('th', null, 'Kind'), h('th', null, 'Data')),
      events.slice(0, 25).map(e => h('tr', null, h('td', null, when(e.at)), h('td', { class: 'muted' }, inTicks(e.at - tick)), h('td', null, h('b', null, e.type)),
        h('td', null, h('span', { class: 'badge', title: e.key || '' }, e.periodic ? 'periodic' : e.key != null ? 'unique' : 'plain')), h('td', { class: 'mono' }, short(e.data)))),
      events.length > 25 ? h('tr', null, h('td', { colspan: 5, class: 'muted' }, `… and ${events.length - 25} more (see raw state)`)) : null)) : h('div', { class: 'empty' }, 'No events scheduled.'));

    out.push(h('h3', null, 'Raw state'));
    out.push(h('div', { class: 'json' }, jsonNode('state', w, true)));
    return out;
  }

  // Stav reconcilera: každá deklarovaná periodická udalosť má mať vo fronte práve jednu; čo chýba, doplní,
  // čo už do hry nepatrí (neznámy typ, nedeklarovaná, duplicita), zahodí. Toto je len plán, svet sa nemení.
  function reconcilerView(r: ReconcilerView | null, tick: number): Node[] {
    if (!r) return [];
    const missing = r.periodic.filter(p => p.status === 'missing');
    const healthy = !missing.length && !r.drop.length;
    const out: Node[] = [
      h('h3', null, 'Reconciler ', h('span', { class: 'badge' + (healthy ? ' live' : ' warn') }, healthy ? 'in sync' : `${missing.length} missing · ${r.drop.length} to drop`)),
      h('div', { class: 'muted', style: 'margin-bottom:8px' },
        `${r.declared} periodic declared, ${r.proposers} proposers · queue: ${r.counts.periodic} periodic, ${r.counts.unique} unique, ${r.counts.plain} plain. `,
        'The next reconcile (before every jump in time, and when the world loads) adds the missing ones and drops the rest. A loaded world should always be in sync; an old save read from file may not be yet.')
    ];
    out.push(h('div', { class: 'tablewrap' }, h('table', null,
      h('tr', null, h('th', null, 'Periodic key'), h('th', null, 'Type'), h('th', null, 'Status'), h('th', null, 'Next run'), h('th', null, '')),
      r.periodic.map(p => h('tr', null, h('td', { class: 'mono' }, p.key), h('td', null, p.type),
        h('td', null, h('span', { class: 'badge' + (p.status === 'scheduled' ? ' live' : ' warn') }, p.status === 'scheduled' ? 'scheduled' : 'missing')),
        h('td', null, p.at == null ? '–' : (p.status === 'missing' ? 'would be ' : '') + when(p.at)), h('td', { class: 'muted' }, p.at == null ? '' : inTicks(p.at - tick)))))));
    if (r.drop.length) {
      out.push(h('div', { class: 'muted', style: 'margin:10px 0 6px' }, 'Would be dropped:'));
      out.push(h('div', { class: 'tablewrap' }, h('table', null,
        h('tr', null, h('th', null, 'Key / type'), h('th', null, 'At'), h('th', null, 'Why')),
        r.drop.map(d => h('tr', null, h('td', { class: 'mono' }, d.key || d.type), h('td', null, when(d.at)), h('td', null, d.why))))));
    }
    return out;
  }

  // JSON strom: deti sa vytvoria až pri prvom rozbalení
  function jsonNode(key: string | number | null, v: unknown, open?: boolean): HTMLElement {
    const label: Kid[] = key != null ? [h('span', { class: 'k' }, key), ': '] : [];
    if (v === null || typeof v !== 'object') {
      return h('div', { class: 'leaf' }, ...label, h('span', { class: typeof v === 'string' ? 's' : 'n' }, JSON.stringify(v)));
    }
    const list: readonly unknown[] | null = Array.isArray(v) ? v : null, arr = !!list, n = list ? list.length : Object.keys(v).length;
    const d = h('details', null, h('summary', null, ...label, h('span', { class: 'muted' }, arr ? `[${n}]` : `{${n}}`), ' ', h('span', { class: 'muted' }, n ? short(v) : '')));
    let built = false;
    d.addEventListener('toggle', () => {
      if (!d.open || built) return;
      built = true;
      const entries: [string | number, unknown][] = list ? list.map((x, i) => [i, x]) : Object.entries(v);
      const LIMIT = 500;
      for (const [k, x] of entries.slice(0, LIMIT)) d.appendChild(jsonNode(k, x));
      if (entries.length > LIMIT) d.appendChild(h('div', { class: 'leaf muted' }, `… ${entries.length - LIMIT} more`));
    });
    if (open) d.open = true;
    return d;
  }

  // ---------- ovládanie ----------
  const areaSel = $as('area', HTMLSelectElement);
  areaSel.replaceChildren(...D.AREAS.map(a => h('option', { value: a, selected: a === st.area ? 'selected' : null }, D.AREA_NAMES[a] || a)));
  areaSel.onchange = () => { if (isArea(areaSel.value)) st.area = areaSel.value; saveHash(); render(); };
  $('search').oninput = renderRooms;
  async function refresh(): Promise<void> { await loadRooms(); await loadRoom(); render(); }
  $('refresh').onclick = () => { void refresh(); };
  let timer: ReturnType<typeof setInterval> | undefined;
  const auto = $as('auto', HTMLInputElement);
  auto.onchange = () => { clearInterval(timer); timer = auto.checked ? setInterval(() => { void refresh(); }, 5000) : undefined; };
  window.addEventListener('hashchange', () => {
    const room = new URLSearchParams(location.hash.slice(1)).get('room');
    if (room && room !== st.room) void selectRoom(room);
  });

  renderTabs();
  void refresh().then(saveHash);

})();
