// Ladiaca stránka (#76): záložka Trh – ceny s rozkladom na činitele, história, NPC, sviatky, správy, udalosti a zákazky.
// Údaje z /api/debug/market (počíta ich economy.ts na kópii sveta). Texty po anglicky, mená kvetov po slovensky.
import type { MarketConstants, MarketView } from '../../server/debug-api/market.ts';
import type { Kid, TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';
import { entries } from '../../shared/util.ts';
import type { SpeciesId } from '../../shared/data.ts';

type Full = Extract<MarketView, { market: true }>;
type SeedRow = Full['seeds'][number];
type FlowerRow = Full['flowers'][number];
// stĺpec tabuľky: kľúč, popis, číselný, hodnota na triedenie a bunka
interface Col<R> { k: string; label: string; num?: 1; v: (r: R) => string | number; td: (r: R) => HTMLElement }

const CSS = `
.mk-filter { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 8px; }
.mk-filter input { flex: 1 1 180px; max-width: 280px; }
.mk table th.sort { cursor: pointer; user-select: none; }
.mk table th.sort:hover { color: var(--text); }
.mk table th.on { color: var(--accent); }
.mk td.name b { font-weight: 600; }
.mk td.name small { color: var(--muted); margin-left: 4px; }
.mk .clamp { color: var(--warn); }
.mk .price { font-weight: 700; }
.mk .spark { display: block; }
.mk .spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
.mk .spark circle { fill: var(--accent); }
.mk .how { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; max-width: 900px; }
.mk .how summary { cursor: pointer; font-weight: 600; }
.mk .how ul { margin: 8px 0 2px; padding-left: 18px; }
.mk .how li { margin: 3px 0; }
.mk .how code { background: var(--bg); border-radius: 4px; padding: 0 4px; }
.mk .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.mk .two h4 { margin: 0 0 6px; font-size: 13.5px; }
.mk td.wrap { white-space: normal; min-width: 220px; }
@media (max-width: 700px) { .mk td.name small { display: none; } }
`;

const fx = (v: number | null | undefined): string => v == null ? '–' : '×' + (Math.round(v * 100) / 100).toFixed(2);
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  if (!document.getElementById('tab-market-css')) {
    const st = document.createElement('style');
    st.id = 'tab-market-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  let ctx = ctx0, data: MarketView | null = null, err: string | null = null, loadedRoom: string | null = null, seq = 0, howOpen = true;
  const { h, D, fmt } = ctx;
  const filter = h('input', { type: 'search', placeholder: 'Filter seeds and flowers…', autocomplete: 'off' });
  filter.value = ctx.param('mq') || '';
  filter.oninput = () => { ctx.setParam('mq', filter.value.trim()); renderTables(); };
  const sorts = { seeds: ctx.param('mss') || '', flowers: ctx.param('mfs') || '' };
  const tables = { seeds: h('div'), flowers: h('div') };

  async function load(): Promise<void> {
    const room = ctx.room, my = ++seq;
    if (!room) { data = null; err = null; loadedRoom = null; render(); return; }
    if (room !== loadedRoom) { data = null; err = null; render(); }
    try {
      const j = await ctx.api<MarketView>('/api/debug/market?id=' + encodeURIComponent(room));
      if (my !== seq) return;
      data = j; err = null;
    } catch (e) {
      if (my !== seq) return;
      data = null; err = errText(e);
    }
    loadedRoom = room;
    render();
  }

  // ---------- pomocníci ----------
  const card = (label: string, value: string, sub: string | null): HTMLElement => h('div', { class: 'card' }, h('small', null, label), h('b', null, value), sub ? h('small', null, sub) : null);
  const when = (t: number | null | undefined): string => t == null ? '–' : fmt.when(t);
  const rel = (t: number | null | undefined): string => t == null || !data ? '' : t >= data.tick ? fmt.inTicks(t - data.tick) : 'past';
  const seasons = (list: readonly number[]): string => list.map(s => D.SEASON_ICONS[s] ?? '').join('');
  const mults = (m: Partial<Record<SpeciesId, number>> | null | undefined): string => entries(m || {}).map(([sp, x]) => `${D.SPECIES[sp].name || sp} ×${x}`).join(', ');
  const wrap = (...kids: Kid[]): HTMLElement => h('div', { class: 'tablewrap' }, h('table', null, ...kids));
  // činiteľ, ktorý narazil na hranicu: ukáže aj surovú hodnotu
  function factor(v: number, raw: number | null | undefined): HTMLElement {
    const clamped = raw != null && Math.abs(raw - v) > 1e-9;
    return h('td', { class: 'num' + (clamped ? ' clamp' : ''), title: clamped ? `clamped, raw ${fx(raw)}` : null }, fx(v), clamped ? ' ⚑' : null);
  }
  // malý graf histórie ceny (posledné ranné ceny)
  function spark(hist: readonly number[] | undefined): HTMLElement {
    if (!hist || hist.length < 2) return h('span', { class: 'muted' }, hist && hist.length ? String(hist[0]) : '–');
    const W = 64, H = 20, lo = Math.min(...hist), hi = Math.max(...hist), span = hi - lo || 1;
    const pts = hist.map((v, i) => [1 + i * (W - 2) / (hist.length - 1), H - 2 - (v - lo) / span * (H - 4)] as const);
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'spark');
    const t = document.createElementNS(ns, 'title'); t.textContent = `last ${hist.length} mornings: ${hist.join(', ')}`; svg.appendChild(t);
    const pl = document.createElementNS(ns, 'polyline'); pl.setAttribute('points', pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')); svg.appendChild(pl);
    const c = document.createElementNS(ns, 'circle'); const last = pts[pts.length - 1] ?? [0, 0];
    c.setAttribute('cx', last[0].toFixed(1)); c.setAttribute('cy', last[1].toFixed(1)); c.setAttribute('r', '2'); svg.appendChild(c);
    return h('span', { title: `min ${lo}, max ${hi}` }, svg);
  }

  // ---------- tabuľky so stĺpcami: { k, label, num, v(row) → hodnota na triedenie, td(row) → bunka } ----------
  const PHASE = { now: ['in season', ' live'], next: ['next season', ''], off: ['off season', ' warn'] } as const;
  const COLS: { seeds: Col<SeedRow>[]; flowers: Col<FlowerRow>[] } = {
    seeds: [
      { k: 'name', label: 'Seed', v: r => norm(r.name), td: r => h('td', { class: 'name' }, h('b', null, r.name), h('small', { class: 'mono' }, r.sp)) },
      { k: 'seasons', label: 'Seasons', v: r => r.seasons[0] ?? 0, td: r => h('td', { title: r.seasons.map(s => fmt.SEASON_EN[s]).join(', ') }, seasons(r.seasons), r.strict ? h('small', { class: 'muted', title: 'strict: only delivered in its seasons' }, ' strict') : null) },
      { k: 'phase', label: 'Phase', v: r => ['now', 'next', 'off'].indexOf(r.parts.phase), td: r => h('td', null, h('span', { class: 'badge' + PHASE[r.parts.phase][1] }, PHASE[r.parts.phase][0])) },
      { k: 'base', label: 'Base', num: 1, v: r => r.parts.base, td: r => h('td', { class: 'num' }, r.parts.base) },
      { k: 'demand', label: 'Demand', num: 1, v: r => r.parts.demand, td: r => h('td', { class: 'num' }, fx(r.parts.demand)) },
      { k: 'stock', label: 'Stock', num: 1, v: r => r.stock, td: r => h('td', { class: 'num' }, r.stock) },
      { k: 'scarcity', label: 'Scarcity', num: 1, v: r => r.parts.scarcity, td: r => factor(r.parts.scarcity, r.parts.scarcityRaw) },
      { k: 'raw', label: 'Raw', num: 1, v: r => r.parts.raw, td: r => h('td', { class: 'num muted' }, r.parts.raw.toFixed(2)) },
      { k: 'price', label: 'Price', num: 1, v: r => r.price, td: r => h('td', { class: 'num price' }, r.price) },
      { k: 'sellBack', label: 'Sell-back', num: 1, v: r => r.sellBack ?? 0, td: r => h('td', { class: 'num' }, r.sellBack) },
      { k: 'minRep', label: 'Min rep', num: 1, v: r => r.minRep, td: r => h('td', { class: 'num' }, r.minRep ? 'L' + r.minRep : '–') },
      { k: 'hist', label: 'History', v: r => trend(r.hist), td: r => h('td', null, spark(r.hist)) }
    ],
    flowers: [
      { k: 'name', label: 'Flower', v: r => norm(r.name), td: r => h('td', { class: 'name' }, h('b', null, r.name), h('small', { class: 'mono' }, r.sp)) },
      { k: 'seasons', label: 'Seasons', v: r => r.seasons[0] ?? 0, td: r => h('td', { title: r.seasons.map(s => fmt.SEASON_EN[s]).join(', ') }, seasons(r.seasons)) },
      { k: 'base', label: 'Base', num: 1, v: r => r.parts.base, td: r => h('td', { class: 'num' }, r.parts.base) },
      { k: 'rare', label: 'Rarity', num: 1, v: r => r.parts.rare, td: r => h('td', { class: 'num', title: r.parts.inSeason ? 'in season' : 'off season: rarer' }, fx(r.parts.rare)) },
      { k: 'fest', label: 'Festival', num: 1, v: r => r.parts.fest, td: r => h('td', { class: 'num' + (r.parts.fest !== 1 ? ' price' : '') }, fx(r.parts.fest)) },
      { k: 'stock', label: 'Stock', num: 1, v: r => r.stock, td: r => h('td', { class: 'num' }, r.stock) },
      { k: 'sat', label: 'Saturation', num: 1, v: r => r.parts.sat, td: r => factor(r.parts.sat, r.parts.satRaw) },
      { k: 'raw', label: 'Raw', num: 1, v: r => r.parts.raw, td: r => h('td', { class: 'num muted' }, r.parts.raw.toFixed(2)) },
      { k: 'price', label: 'Market pays', num: 1, v: r => r.price, td: r => h('td', { class: 'num price', title: 'for a fresh flower; older ones get less (freshness)' }, r.price) },
      { k: 'hist', label: 'History', v: r => trend(r.hist), td: r => h('td', null, spark(r.hist)) }
    ]
  };
  // trend histórie na triedenie: posledná cena oproti prvej
  function trend(hist: readonly number[]): number { return hist.length > 1 ? (hist[hist.length - 1] ?? 0) / Math.max(1, hist[0] ?? 0) : 1; }

  function table<R extends { name: string; sp: string }>(kind: 'seeds' | 'flowers', cols: Col<R>[], all: readonly R[]): HTMLElement {
    const s = sorts[kind], desc = s.startsWith('-'), key = desc ? s.slice(1) : s, q = norm(filter.value.trim());
    let rows = all.filter(r => !q || norm(r.name).includes(q) || r.sp.includes(q));
    const col = cols.find(c => c.k === key);
    if (col) rows = rows.slice().sort((a, b) => { const x = col.v(a), y = col.v(b); return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
    const head = h('tr', null, cols.map(c => h('th', {
      class: ['sort', c.num ? 'num' : null, c.k === key ? 'on' : null].filter(Boolean).join(' '), title: 'Sort',
      onclick: () => { sorts[kind] = c.k === key && !desc ? '-' + c.k : c.k === key ? '' : c.k; ctx.setParam(kind === 'seeds' ? 'mss' : 'mfs', sorts[kind]); renderTables(); }
    }, c.label, c.k === key ? (desc ? ' ▼' : ' ▲') : null)));
    if (!rows.length) return wrap(head, h('tr', null, h('td', { colspan: cols.length, class: 'muted' }, 'No match')));
    return wrap(head, rows.map(r => h('tr', null, cols.map(c => c.td(r)))));
  }
  function renderTables(): void {
    if (!data || !data.market) return;
    tables.seeds.replaceChildren(table('seeds', COLS.seeds, data.seeds));
    tables.flowers.replaceChildren(table('flowers', COLS.flowers, data.flowers));
  }

  // ---------- ako fungujú ceny (z konštánt ekonomiky) ----------
  function how(C: MarketConstants): HTMLElement {
    const pct = (v: number): string => Math.round(v * 100) + '%';
    const li = (...k: Kid[]): HTMLElement => h('li', null, ...k);
    const code = (t: string): HTMLElement => h('code', null, t);
    const rep = entries(C.MIN_SEED_REP).map(([sp, l]) => `${D.SPECIES[sp].name || sp} L${l}`).join(', ');
    const box = h('details', { class: 'how', open: howOpen ? 'open' : null }, h('summary', null, 'How prices work'), h('ul', null,
      li(h('b', null, 'Seed price'), ' = ', code('base × demand × scarcity'), `, rounded, at least ${C.seedMin}. Demand ×${C.seedDemand.now} in season, ×${C.seedDemand.next} the season before, ×${C.seedDemand.off} otherwise. Scarcity = `,
        code(`√(${C.SEED_TARGET} / stock)`), ` clamped to ${C.seedScarcity[0]}–${C.seedScarcity[1]}. Each seed bought lowers the stock, so the next one costs more. The market buys seeds back at ${pct(C.seedSellBack)}; stock is capped at ${C.SEED_CAP}.`),
      li(h('b', null, 'Flower price'), ' (what the market pays) = ', code('base × rarity × festival × saturation'), `, at least ${C.flowerMin}. Rarity ×${C.flowerOffSeason} when the flower is off season. Saturation = `,
        code(`${C.flowerSat.start} − ${C.flowerSat.perUnit} × stock`), `, at least ${C.flowerSat.min}. Every flower sold adds to the stock (max ${C.flowerCap}) and lowers the next price; the payout is also multiplied by the flower's freshness.`),
      li(h('b', null, 'Compost'), ' = ', code(`${C.compostBase} × √(${C.COMPOST_TARGET} / stock)`), `, scarcity clamped to ${C.compostScarcity[0]}–${C.compostScarcity[1]}, at least ${C.compostMin}; sell-back ${pct(C.compostSellBack)}, stock capped at ${C.COMPOST_CAP}.`),
      li(h('b', null, 'Every morning'), ` (6:00): ${pct(C.flowerOvernight)} of the flowers stay on the market (customers buy the rest), off-season seeds keep ${pct(C.seedOffSeasonDecay)}, and one point of price history is recorded (last ${C.HIST_LEN} kept).`),
      li(h('b', null, 'Who moves the stock:'), ' the wholesaler delivers every 2 days at 7:00 (mostly next season’s seeds); Jano buys cheap profitable seeds and later sells the flowers; Fero hoards next-season seeds and sells them when the price is ≥ 1.5× base or off season; Zuzka buys flowers off the market daily (more during festivals).'),
      rep ? li(h('b', null, 'Wholesale seeds'), ` need a reputation level: ${rep} (levels at ${C.REP_LEVELS.join(', ')} rep).`) : null,
      li(h('span', { class: 'clamp' }, '⚑'), ' marks a factor that hit its limit (hover for the raw value).')));
    box.addEventListener('toggle', () => { howOpen = box.open; });
    return box;
  }

  // ---------- celá záložka ----------
  function render(): void {
    const hadFocus = document.activeElement === filter, selS = filter.selectionStart, selE = filter.selectionEnd;
    const out: Kid[] = [];
    if (!ctx.room) out.push(h('div', { class: 'empty' }, 'Pick a room on the left to see its market.'));
    else if (err) out.push(h('div', { class: 'empty err' }, `Room ${ctx.room}: ${err}`));
    else if (!data) out.push(h('div', { class: 'empty' }, 'Loading…'));
    else out.push(...view(data));
    el.replaceChildren(h('div', { class: 'mk' }, ...out));
    renderTables();
    if (hadFocus && filter.isConnected) { filter.focus(); try { filter.setSelectionRange(selS, selE); } catch { /* nič */ } }
  }

  function view(d: MarketView): Kid[] {
    const out: Kid[] = [
      h('h2', null, 'Market · ', d.id, h('span', { class: 'badge' + (d.source === 'memory' ? ' live' : '') }, d.source === 'memory' ? 'loaded – live state' : 'read from file')),
      h('div', { class: 'muted' }, `Day ${d.day} · ${fmt.SEASON_EN[d.season]} day ${d.dayInSeason}/${d.daysPerSeason} · ${fmt.hhmm(D.minOfTick(d.tick))} · tick ${d.tick}`)
    ];
    if (!d.market) return [...out, h('div', { class: 'empty' }, 'This world has no market yet. It is created the next time the room loads.')];
    const n = d.npcs, held = n.fero.hold.reduce((a, x) => a + x.n, 0), heldVal = n.fero.hold.reduce((a, x) => a + (x.value || 0), 0);
    const growing = n.jano.growing.reduce((a, x) => a + (typeof x.n === 'number' ? x.n : 0), 0), up = d.upcoming, f = d.festival;
    out.push(h('div', { class: 'cards' },
      card('Season', `${D.SEASON_ICONS[d.season] ?? ''} ${fmt.SEASON_EN[d.season] ?? ''}`, `day ${d.dayInSeason} of ${d.daysPerSeason}`),
      f ? card('Festival now', `${f.icon} ${f.name}`, `until ${when(f.until)} · ${mults(f.mult)}`) : card('Festival now', 'none', null),
      up ? card('Next festival', `${up.icon} ${up.name}`, `${when(up.start)} (${rel(up.start)}) · ${up.announced ? 'announced' : 'announce ' + rel(up.announce)} · ${mults(up.mult)}`) : null,
      card('Next delivery', d.nextDelivery == null ? '–' : rel(d.nextDelivery), when(d.nextDelivery)),
      card('Jano', `${String(n.jano.coins ?? '–')} coins`, `growing ${growing} flowers · visit ${rel(n.jano.next) || '–'}`),
      card('Fero', `${String(n.fero.coins ?? '–')} coins`, `hoards ${held} seeds (worth ${heldVal}) · visit ${rel(n.fero.next) || '–'}`),
      card('Compost', `${d.compost.price} coins`, `stock ${d.compost.stock}/${d.constants.COMPOST_CAP} · scarcity ${fx(d.compost.parts.scarcity)} · sell-back ${d.compost.sellBack}`)));

    out.push(h('h3', null, 'Prices'));
    out.push(h('div', { class: 'mk-filter' }, filter, h('span', { class: 'muted' }, 'Click a column to sort. Seeds: what players pay; flowers: what the market pays.')));
    out.push(h('h3', null, `Seeds (${d.seeds.length})`), tables.seeds);
    out.push(h('h3', null, `Flowers (${d.flowers.length})`), tables.flowers);
    out.push(h('div', { style: 'margin-top:16px' }, how(d.constants)));

    out.push(h('h3', null, 'NPC traders'));
    out.push(h('div', { class: 'two' },
      h('div', null, h('h4', null, `🧑‍🌾 Jano growing (${growing})`), n.jano.growing.length ? wrap(
        h('tr', null, h('th', null, 'Flower'), h('th', { class: 'num' }, 'Count'), h('th', null, 'Brings them')),
        n.jano.growing.map(g => h('tr', null, h('td', null, String(g.name)), h('td', { class: 'num' }, String(g.n)), h('td', null, when(g.at), h('span', { class: 'muted' }, ' ' + rel(g.at)))))) : h('div', { class: 'muted' }, 'Nothing planted.')),
      h('div', null, h('h4', null, `🎩 Fero's hoard (${held})`), n.fero.hold.length ? wrap(
        h('tr', null, h('th', null, 'Seed'), h('th', { class: 'num' }, 'Count'), h('th', { class: 'num' }, 'Price now'), h('th', { class: 'num' }, 'Sells at ≥'), h('th', { class: 'num' }, 'Worth')),
        n.fero.hold.map(x => h('tr', null, h('td', null, x.name), h('td', { class: 'num' }, x.n), h('td', { class: 'num' + (x.price != null && x.price >= x.sellsAt ? ' price' : '') }, x.price ?? '–'),
          h('td', { class: 'num muted' }, Math.ceil(x.sellsAt)), h('td', { class: 'num' }, x.value ?? '–')))) : h('div', { class: 'muted' }, 'Holds no seeds.'))));

    out.push(h('h3', null, `Upcoming market events (${d.events.length})`));
    out.push(d.events.length ? wrap(
      h('tr', null, h('th', null, 'When'), h('th', null, ''), h('th', null, 'Type'), h('th', null, 'What')),
      d.events.slice(0, 40).map(e => h('tr', null, h('td', null, when(e.at)), h('td', { class: 'muted' }, rel(e.at)), h('td', null, h('span', { class: 'badge' }, e.type)), h('td', null, e.text))),
      d.events.length > 40 ? h('tr', null, h('td', { colspan: 4, class: 'muted' }, `… and ${d.events.length - 40} more`)) : null) : h('div', { class: 'empty' }, 'No market events scheduled.'));

    out.push(h('h3', null, `Contracts (${d.contracts.length})`));
    out.push(d.contracts.length ? wrap(
      h('tr', null, ['#', 'Kind', 'Giver', 'Flower', 'Delivered', 'Reward', 'Rep', 'Open until', 'Due', 'Taken by'].map((c, i) => h('th', { class: [0, 4, 5, 6].includes(i) ? 'num' : null }, c))),
      d.contracts.map(c => h('tr', null, h('td', { class: 'num' }, c.id), h('td', null, h('span', { class: 'badge' }, c.kind)), h('td', null, c.giverName),
        h('td', null, c.name), h('td', { class: 'num' }, `${c.got}/${c.n}`),
        h('td', { class: 'num' }, c.reward, c.item ? h('small', { class: 'muted' }, ` + ${c.item.n}× ${c.itemName}`) : null), h('td', { class: 'num' }, '+' + c.rep),
        h('td', null, when(c.openUntil), h('span', { class: 'muted' }, ' ' + rel(c.openUntil))), h('td', null, when(c.due), h('span', { class: 'muted' }, ' ' + rel(c.due))),
        h('td', null, c.takenBy ? h('span', { class: 'mono' }, c.takenBy) : h('span', { class: 'badge live' }, 'open'))))) : h('div', { class: 'empty' }, 'The board is empty.'));

    out.push(h('h3', null, `Market news (${d.news.length})`));
    out.push(d.news.length ? wrap(
      d.news.map(x => h('tr', null, h('td', null, when(x.tick)), h('td', { class: 'wrap' }, x.text)))) : h('div', { class: 'empty' }, 'No news yet.'));
    return out;
  }

  void load();
  return {
    update(c) { ctx = c; void load(); },

    unmount() { seq++; }
  };
}
