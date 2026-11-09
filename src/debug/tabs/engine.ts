// Ladiaca stránka (#106): záložka Engine – časová os posledných dávok sveta (kruhová pamäť v serveri), jedna dávka
// do hĺbky (poradie vstupov, filter správ hráčov, návrhy po kolách s kľúčmi a rozhodnutím, skupiny riešiteľa, zmeny
// sveta pred / po) a fronta udalostí s pôvodom. Údaje z /api/debug/engine, len na čítanie. Texty po anglicky.
import type { Detail, DetailReply, QueueReply, Row, TimelineReply } from '../../server/debug-api/engine.ts';
import type { Kid, TabCtx, TabInstance } from '../ui.ts';
import { errText } from '../ui.ts';
import { lookup } from '../../shared/util.ts';

type Gap = { gap: number; from: number; to: number; merged?: boolean };
type TlRow = Row | Gap;
type Outcome = 'applied' | 'held' | 'rejected' | 'error';
type Actor = Detail['filter'][number]['actor'] | NonNullable<Detail['inputs']>[number]['actor'];

const CSS = `
.en .sub { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0 10px; }
.en .sub button.on { background: var(--accent-bg); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.en .sub label { display: flex; gap: 4px; align-items: center; color: var(--muted); }
.en .sub input[type=search] { width: 160px; }
.en .split { display: grid; grid-template-columns: minmax(360px, 500px) minmax(0, 1fr); gap: 14px; align-items: start; }
.en .rows { max-height: calc(100vh - 120px); overflow: auto; position: sticky; top: 0; }
.en .rows tr.r { cursor: pointer; }
.en .rows tr.r:hover td { background: var(--bg); }
.en .rows tr.on td { background: var(--accent-bg); }
.en .rows td, .en .rows th { padding: 4px 7px; }
.en .rows td.bt { white-space: normal; min-width: 120px; }
.en .rows tr.gap td { color: var(--muted); font-style: italic; text-align: center; padding: 2px 10px; font-size: 12px; }
.en .strip { display: block; width: 100%; height: 54px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
.en .strip .sel { fill: var(--accent); opacity: .18; }
.en .c-applied { fill: var(--ok); background: var(--ok); }
.en .c-held { fill: var(--warn); background: var(--warn); }
.en .c-rejected { fill: #8a7f9e; background: #8a7f9e; }
.en .c-error { fill: #c0392b; background: #c0392b; }
.en .c-filter { fill: var(--line); background: var(--line); }
.en .o { font-size: 11.5px; padding: 1px 7px; border-radius: 10px; color: #fff; white-space: nowrap; display: inline-block; }
.en .o.c-filter { color: var(--text); }
.en .src { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--line); color: var(--muted); }
.en .src.catchup, .en .src.ff { color: var(--accent); border-color: var(--accent); }
.en .tbar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--bg); margin: 6px 0 2px; max-width: 520px; }
.en .tbar span { display: block; height: 100%; }
.en .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--muted); }
.en .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.en .grid td.cell { text-align: center; }
.en .keys { font-family: var(--mono); font-size: 12px; white-space: normal; min-width: 160px; max-width: 360px; }
.en .keys .w { color: var(--accent); }
.en td.wrap { white-space: normal; min-width: 200px; max-width: 460px; }
.en .chg { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
.en .chg.hot { border-color: var(--warn); }
.en .chg h4 { margin: 0 0 4px; font: 600 13px var(--mono); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.en .chg table { width: auto; }
.en .chg table td { padding: 2px 8px; }
.en .from { color: #c0392b; } .en .to { color: var(--ok); }
.en .groups { font-size: 12.5px; margin: 6px 0 2px; }
.en .groups .g { display: inline-block; border: 1px solid var(--warn); border-radius: 6px; padding: 0 6px; margin: 2px 4px 2px 0; font-family: var(--mono); }
.en pre { white-space: pre-wrap; word-break: break-all; font: 12px var(--mono); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; max-height: 420px; overflow: auto; }
.en .note { color: var(--muted); max-width: 900px; margin: 0 0 8px; }
@media (max-width: 900px) { .en .split { grid-template-columns: 1fr; } .en .rows { max-height: 40vh; position: static; } }
`;

const PHASES: readonly (readonly [string, string])[] = [['filter', '#5b8def'], ['schedule', '#8e6fd8'], ['evaluate', '#2f8a4c'], ['resolve', '#b7791f'], ['commit', '#c0392b'], ['journal', '#7a7368'], ['notify', '#3aa6a0']];
const OUT: readonly Outcome[] = ['applied', 'held', 'rejected', 'error'];
const SRC: Readonly<Partial<Record<string, string>>> = { journal: 'journal file', frame: 'player frame', live: 'running time', catchup: 'catch-up after load', ff: 'night fast-forward' };
const WHAT: Readonly<Partial<Record<string, string>>> = { input: 'applied', coalesced: 'held', deferred: 'held', dropped: 'error', refused: 'rejected', ignored: 'rejected', presence: 'filter' };
const ms = (v: number | null | undefined): string => v == null ? '–' : v < 1 ? (v * 1000).toFixed(0) + ' µs' : v.toFixed(2) + ' ms';
const val = (v: unknown): string => v === undefined ? '∅' : JSON.stringify(v);
const srcName = (s: string): string => lookup(SRC, s) || s;

// Spoločné so záložkou Journal: štýly a vykreslenie jednej dávky (výstup detail() zo src/server/debug-api/engine.ts)
export function ensureCss(): void {
  if (document.getElementById('tab-engine-css')) return;
  const st = document.createElement('style');
  st.id = 'tab-engine-css'; st.textContent = CSS;
  document.head.appendChild(st);
}
// Vykreslenie dávky: detail(d, { onKey }) → prvky; pomocné tabuľka, osud návrhu a aktér
export interface Renderer {
  detail: (d: Detail, opts?: { onKey?: (k: string) => void }) => Kid[];
  wrap: (...kids: Kid[]) => HTMLElement; outcome: (o: string) => HTMLElement; actor: (a: Actor) => HTMLElement;
}
export function renderer(ctx: TabCtx): Renderer {
  const { h, fmt } = ctx;
  const wrap = (...kids: Kid[]): HTMLElement => h('div', { class: 'tablewrap' }, h('table', null, ...kids));
  const outcome = (o: string): HTMLElement => h('span', { class: 'o c-' + o }, o);
  const actor = (a: Actor): HTMLElement => !a ? h('span', { class: 'muted' }, '–') : a.kind === 'player' ? h('span', { class: 'mono', title: 'player (key redacted)' }, 'name' in a && a.name ? a.name + ' ' : '', h('small', { class: 'muted' }, a.key)) : h('span', { class: 'badge' }, a.kind);
  function timingBar(t: Row['timing']): HTMLElement | null {
    if (!t) return null;
    const at = (k: string): number | undefined => lookup(t, k);
    const total = PHASES.reduce((a, [k]) => a + (at(k) || 0), 0) || 1;
    return h('div', null,
      h('div', { class: 'tbar' }, PHASES.filter(([k]) => at(k)).map(([k, c]) => h('span', { style: `width:${((at(k) ?? 0) / total * 100).toFixed(2)}%;background:${c}`, title: `${k} ${ms(at(k))}` }))),
      h('div', { class: 'legend' }, PHASES.filter(([k]) => at(k) != null).map(([k, c]) => h('span', null, h('i', { style: 'background:' + c }), `${k} ${ms(at(k))}`))));
  }
  // onKey(kľúč): kliknutie na kľúč (záložka Journal ním filtruje); bez neho je kľúč len text
  let onKey: ((k: string) => void) | null = null;
  const keyEl = (k: string, attrs: { class?: string; title?: string } | null, text: string): HTMLElement => {
    const f = onKey;
    return h('span', Object.assign({}, attrs, f ? { class: (attrs?.class || '') + ' linkish', title: (attrs?.title || '') + ' · click to filter by this key', onclick: () => { f(k); } } : {}), text);
  };
  type PView = NonNullable<Detail['rounds']>[number]['proposals'][number];
  function keys(p: PView): HTMLElement {
    return h('td', { class: 'keys' }, p.writes.map(k => h('div', { class: 'w' }, keyEl(k, { title: 'writes' }, '✎ ' + k))), p.reads.map(k => h('div', null, keyEl(k, { title: 'reads' }, '👁 ' + k))));
  }
  function reason(p: PView): HTMLElement {
    if (p.outcome === 'held') return h('td', { class: 'wrap' }, p.blockedBy && p.blockedBy.length
      ? p.blockedBy.map(b => h('div', null, 'held: ', h('b', { class: 'mono' }, b.id), ` (${b.type}) already wrote `, h('span', { class: 'mono' }, b.keys.join(', '))))
      : 'held: a key it touched through the queue was written earlier in this round');
    if (p.outcome === 'rejected') return h('td', { class: 'wrap' }, p.msg == null ? h('span', { class: 'muted' }, 'refused silently') : '“' + p.msg + '”');
    if (p.outcome === 'error') return h('td', { class: 'wrap err' }, p.msg);
    const n = p.changes ? Object.values(p.changes).reduce((a, l) => a + l.length, 0) : 0;
    return h('td', { class: 'wrap muted' }, n ? `${n} change${n === 1 ? '' : 's'}` : 'no change',
      p.emits.length ? ` · ${p.emits.length} message${p.emits.length === 1 ? '' : 's'} (${[...new Set(p.emits.map(m => m.t))].join(', ')})` : '',
      p.ops.length ? ' · queue: ' + p.ops.map(o => o.op === 'cancel' ? `cancel ${o.key}` : `+${o.type}${o.key ? ' ' + o.key : ''} @${o.at}`).join(', ') : '');
  }
  function roundsGrid(d: Detail): HTMLElement {
    // mriežka: riadky = vstupy v poradí dávky, stĺpce = kolá; v bunke osud návrhu v tom kole
    const inputs = d.inputs || [], rounds = d.rounds || [];
    const ids = inputs.map(i => i.id), R = rounds.length;
    const cell = (id: string | number | undefined, r: number): HTMLElement => { const p = rounds[r]?.proposals.find(x => x.id === id); return h('td', { class: 'cell', title: p && p.blockedBy ? 'held by ' + p.blockedBy.map(b => b.id).join(', ') : null }, p ? outcome(p.outcome) : h('span', { class: 'muted' }, '·')); };
    return wrap(h('tr', null, h('th', null, '#'), h('th', null, 'Input'), ...rounds.map(r => h('th', { class: 'cell' }, `Round ${r.round}`, h('br'), h('small', { class: 'muted' }, 'step ' + r.step)))),
      ids.map((id, i) => h('tr', null, h('td', { class: 'num muted' }, i + 1), h('td', { class: 'mono' }, id, ' ', h('span', { class: 'muted' }, inputs[i]?.kind)), ...Array.from({ length: R }, (_, r) => cell(id, r)))));
  }
  function detail(d: Detail, opts?: { onKey?: (k: string) => void }): Kid[] {
    onKey = opts?.onKey || null;
    const r = d.row, out: Kid[] = [], step = 'step' in r ? r.step : null;
    out.push(h('h3', { style: 'margin-top:0' }, `Tick ${r.tick} · ${fmt.when(r.tick)} `, h('span', { class: 'src ' + r.source }, srcName(r.source)), ' ', h('span', { class: 'muted' }, `${r.source === 'journal' ? 'line' : 'batch'} #${r.n}${step != null ? ' · step ' + step : ''}${r.wall ? ' · ' + new Date(r.wall).toLocaleString() : ''}`)));
    out.push(timingBar(r.timing));
    if (d.filter.length) {
      out.push(h('h3', null, `Actor filter (${d.filter.length})`));
      out.push(h('div', { class: 'note' }, 'What the server’s frame did with each player message before the engine saw it, and under which rule.'));
      out.push(wrap(h('tr', null, h('th', { class: 'num' }, 'Seq'), h('th', null, 'Player'), h('th', null, 'Msg'), h('th', null, 'Decision'), h('th', null, 'Rule'), h('th', null, '→')),
        d.filter.map(f => h('tr', null, h('td', { class: 'num muted' }, f.seq == null ? '–' : f.seq), h('td', null, actor(f.actor)), h('td', { class: 'mono' }, f.t),
          h('td', null, h('span', { class: 'o c-' + (lookup(WHAT, f.what) || 'filter') }, f.what)), h('td', { class: 'wrap' }, f.rule), h('td', { class: 'mono muted' }, f.id || (f.into ? 'seq ' + f.into : ''))))));
    }
    if (!d.inputs || !d.rounds || !d.changes) return out;
    const rounds = d.rounds, changes = d.changes;
    out.push(h('h3', null, `Batch order (${d.inputs.length})`));
    out.push(wrap(h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'Stage'), h('th', null, 'Actor'), h('th', null, 'Kind'), h('th', null, 'Id'), h('th', null, 'Payload')),
      d.inputs.map(i => h('tr', null, h('td', { class: 'num muted' }, i.pos), h('td', null, h('span', { class: 'badge' }, i.stage)), h('td', null, actor(i.actor)),
        h('td', null, h('b', null, i.kind)), h('td', { class: 'mono muted', title: 'ev' in i ? `queued event seq ${i.ev.seq}, due at ${i.ev.at}${i.ev.key ? ', key ' + i.ev.key : ''}` : null }, i.id),
        h('td', { class: 'mono wrap' }, i.summary)))));
    out.push(h('h3', null, `Proposals (${rounds.reduce((a, x) => a + x.proposals.length, 0)} in ${rounds.length} round${rounds.length === 1 ? '' : 's'})`));
    if (rounds.length > 1) out.push(roundsGrid(d));
    for (const rd of rounds) {
      out.push(h('h4', { style: 'margin:12px 0 4px' }, `Round ${rd.round} `, h('span', { class: 'muted', title: 'every proposal of this round draws from hash(seed, step, id); the seed is never shown' }, `· random: hash(seed, step ${rd.step}, id)`)));
      out.push(h('div', { class: 'groups' }, rd.groups.shared.length ? ['Resolved together (shared keys): ', ...rd.groups.shared.map(g => h('span', { class: 'g' }, g.join(' · ')))] : null,
        rd.groups.independent.length ? h('span', { class: 'muted' }, `${rd.groups.shared.length ? ' · ' : ''}independent: ${rd.groups.independent.length}`) : null));
      out.push(wrap(h('tr', null, h('th', null, 'Id'), h('th', null, 'Type'), h('th', null, 'Keys'), h('th', null, 'Decision'), h('th', null, 'Why / effect')),
        rd.proposals.map(p => h('tr', null, h('td', { class: 'mono' }, p.id), h('td', null, h('b', null, p.type)), keys(p), h('td', null, outcome(p.outcome)), reason(p)))));
    }
    out.push(h('h3', null, `World changes (${changes.length} key${changes.length === 1 ? '' : 's'})`));
    if (!changes.length) out.push(h('div', { class: 'muted' }, 'Nothing in the world changed.'));
    const LIM = 60, LEAF = 40;
    for (const c of changes.slice(0, LIM)) {
      out.push(h('div', { class: 'chg' + (c.contenders.length ? ' hot' : '') },
        h('h4', null, keyEl(c.key, null, c.key), h('span', { class: 'muted', style: 'font-weight:400' }, `${c.leaves} leaf change${c.leaves === 1 ? '' : 's'}`)),
        c.writes.map(w => h('div', null, h('div', { class: 'muted' }, 'written by ', h('b', { class: 'mono' }, w.id), ` (${w.type}, round ${w.round}${w.via !== c.key ? ', via ' + w.via : ''})`),
          h('table', null, w.leaves.slice(0, LEAF).map(l => h('tr', null, h('td', { class: 'mono' }, l.p.length ? l.p.join('.') : '(whole)'),
            h('td', { class: 'mono from wrap' }, val(l.from)), h('td', null, '→'), h('td', { class: 'mono to wrap' }, 'deleted' in l ? 'deleted' : val(l.to)))),
          w.leaves.length > LEAF ? h('tr', null, h('td', { colspan: 4, class: 'muted' }, `… ${w.leaves.length - LEAF} more`)) : null))),
        c.contenders.length ? h('div', { style: 'margin-top:4px' }, 'also wanted this key: ', c.contenders.map(o => h('span', { style: 'margin-right:10px' }, h('span', { class: 'mono' }, o.id), ` ${o.type} r${o.round} `, outcome(o.outcome), o.msg ? h('small', { class: 'muted' }, ' “' + o.msg + '”') : ''))) : null));
    }
    if (changes.length > LIM) out.push(h('div', { class: 'muted' }, `… ${changes.length - LIM} more keys`));
    if (d.outbox && d.outbox.length) {
      out.push(h('h3', null, `Messages (${d.outbox.length})`));
      out.push(h('pre', null, d.outbox.slice(0, 50).map(m => JSON.stringify(m)).join('\n') + (d.outbox.length > 50 ? `\n… ${d.outbox.length - 50} more` : '')));
    }
    out.push(h('details', null, h('summary', { class: 'muted', style: 'cursor:pointer;margin-top:14px' }, 'Raw batch (inputs, presence)'), h('pre', null, JSON.stringify({ inputs: d.inputs.map(i => ({ id: i.id, type: i.kind, data: i.data, ev: 'ev' in i ? i.ev : undefined })), presence: d.presence }, null, 1))));
    return out;
  }

  return { detail, wrap, outcome, actor };
}

// Odpoveď časovej osi: zoznam dávok, alebo svet nie je načítaný; detail dávky, ktorá už vypadla z pamäte
type TimelineAns = TimelineReply | { room: string; loaded: false; rows: [] };
type DetailAns = DetailReply | { room: string; loaded: true; gone: number };

export function mount(el: HTMLElement, ctx0: TabCtx): TabInstance {
  ensureCss();
  let ctx = ctx0, list: TimelineAns | null = null, det: DetailAns | null = null, q: QueueReply | null = null, err: string | null = null, loadedRoom: string | null = null, seq = 0;
  const { h, fmt } = ctx;
  const R = renderer(ctx), { wrap } = R;
  const view = (): string => ctx.param('ev') || 'timeline';
  const sel = (): number | null => { const v = ctx.param('eb'); return v == null ? null : +v; };
  const opt = (k: string, def: boolean): boolean => { const v = ctx.param(k); return v == null ? def : v === '1'; };

  async function load(): Promise<void> {
    const room = ctx.room, my = ++seq;
    if (!room) { list = det = q = null; err = null; loadedRoom = null; render(); return; }
    if (room !== loadedRoom) { list = det = q = null; err = null; render(); }
    try {
      const base = '/api/debug/engine?room=' + encodeURIComponent(room);
      if (view() === 'queue') q = await ctx.api<QueueReply>(base + '&view=queue');
      else {
        list = await ctx.api<TimelineAns>(base);
        const n = sel();
        det = n != null ? await ctx.api<DetailAns>(base + '&n=' + n) : null;
      }
      if (my !== seq) return;
      err = null;
    } catch (e) { if (my !== seq) return; err = errText(e); }
    loadedRoom = room;
    render();
  }
  function select(n: number): void { ctx.setParam('eb', n); det = null; render(); void load(); }

  // ---------- časová os ----------
  const typesOf = (r: Row): string[] => r.kind === 'filter' ? [] : r.types;
  function visibleRows(rows0: readonly TlRow[]): TlRow[] {
    const hideMoves = opt('emv', true), hideFilter = opt('efl', false), qq = (ctx.param('eq') || '').toLowerCase();
    const rows = rows0.filter(r => 'gap' in r || !(
      (hideMoves && r.kind === 'actions' && r.types.length === 1 && r.types[0] === 'pos' && !r.held && !r.rejected && !r.errors) ||
      (hideFilter && r.kind === 'filter') ||
      (qq && !typesOf(r).some(t => t.toLowerCase().includes(qq)) && !r.source.includes(qq))));
    // po skrytí riadkov zlúč susedné medzery
    const out: TlRow[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if ('gap' in r && last && 'gap' in last) { last.from = Math.min(last.from, r.from); last.to = Math.max(last.to, r.to); last.gap = last.to - last.from + 1; last.merged = true; }
      else out.push(Object.assign({}, r));
    }
    return out;
  }
  // pásik: jeden stĺpec na dávku (najstaršia vľavo), výška = počet návrhov, farby = osud
  function strip(rows: readonly TlRow[]): SVGSVGElement {
    const recs = rows.flatMap(r => 'gap' in r ? [] : [r]).reverse(), ns = 'http://www.w3.org/2000/svg';
    const W = 1000, H = 54, n = Math.max(recs.length, 1), bw = W / n, max = Math.max(1, ...recs.map(r => r.proposals));
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'strip');
    const t = document.createElementNS(ns, 'title'); t.textContent = 'Each column is one batch (oldest left); height = proposals, colour = outcome. Click to open.'; svg.appendChild(t);
    const rect = (x: number, y: number, w: number, hh: number, cls: string): SVGRectElement => { const r = document.createElementNS(ns, 'rect'); r.setAttribute('x', String(x)); r.setAttribute('y', String(y)); r.setAttribute('width', String(w)); r.setAttribute('height', String(hh)); r.setAttribute('class', cls); svg.appendChild(r); return r; };
    recs.forEach((r, i) => {
      const x = i * bw;
      if (r.n === sel()) rect(x, 0, Math.max(bw, 2), H, 'sel');
      if (r.kind === 'filter') { rect(x, H - 4, Math.max(bw - 0.5, 0.6), 4, 'c-filter'); return; }
      let y = H - 1;
      for (const o of OUT) {
        const c = o === 'error' ? r.errors : r[o];
        if (!c) continue;
        const hh = Math.max(1.5, (H - 6) * c / max);
        y -= hh; rect(x, y, Math.max(bw - 0.5, 0.6), hh, 'c-' + o);
      }
    });
    svg.addEventListener('click', ev => {
      const b = svg.getBoundingClientRect(), i = Math.floor((ev.clientX - b.left) / b.width * n), r = recs[i];
      if (r?.n != null) select(r.n);
    });
    return svg;
  }
  function timelineView(list: TimelineReply): Kid[] {
    const rows = visibleRows(list.rows);
    const head = h('div', { class: 'note' },
      `${list.kept} of the last ${list.max} batches kept in memory (${list.total} recorded since the room was loaded${list.overwritten ? `, ${list.overwritten} overwritten` : ''}). `,
      'One row per batch: an event batch (the queue’s due events of a tick) or an action batch (the player messages of one 100 ms frame). Ticks with nothing in them are collapsed.');
    const table = wrap(
      h('tr', null, h('th', null, 'Tick'), h('th', null, 'Batch'), h('th', { class: 'num', title: 'requests from players / events from the queue' }, 'In'), h('th', { class: 'num' }, 'Prop.'), h('th', null, 'Outcome'), h('th', { class: 'num' }, 'Time')),
      rows.map(r => {
        if ('gap' in r) return h('tr', { class: 'gap' }, h('td', { colspan: 6 }, `${r.gap} ${r.merged ? 'ticks without a shown batch' : 'empty ticks'}`));
        const total = r.timing ? Object.values(r.timing).reduce<number>((a, b) => a + (b || 0), 0) : null;
        return h('tr', { class: 'r' + (r.n === sel() ? ' on' : ''), onclick: () => { if (r.n != null) select(r.n); } },
          h('td', { class: 'num', title: fmt.when(r.tick) }, r.tick, h('br'), h('small', { class: 'muted' }, fmt.hhmm(ctx.D.minOfTick(r.tick)))),
          h('td', { class: 'bt' }, r.kind === 'filter' ? h('span', { class: 'muted' }, 'filter only') : r.types.join(', '), ' ', h('span', { class: 'src ' + r.source, title: srcName(r.source) }, r.source)),
          h('td', { class: 'num' }, r.kind === 'events' ? `${r.events} ev` : r.kind === 'filter' ? `${r.filtered} msg` : `${r.requests}${r.filtered ? ' +' + r.filtered : ''}`),
          h('td', { class: 'num' }, r.proposals || ''),
          h('td', null, r.kind === 'filter' ? '' : h('span', { class: 'muted' }, `${r.applied}✓`, r.held ? h('b', { style: 'color:var(--warn)' }, ` ${r.held}⏸`) : '', r.rejected ? ` ${r.rejected}✗` : '', r.errors ? h('b', { class: 'err' }, ` ${r.errors}!`) : '', r.rounds > 1 ? ` · ${r.rounds} rounds` : '')),
          h('td', { class: 'num muted' }, ms(total)));
      }),
      rows.length ? null : h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'No batches yet.')));
    return [head, strip(rows), h('div', { class: 'split' }, h('div', { class: 'rows' }, table), h('div', null, detailView()))];
  }

  function detailView(): Kid {
    if (sel() == null) return h('div', { class: 'empty' }, 'Click a batch to see its proposals, decisions and world changes.');
    if (!det) return h('div', { class: 'empty' }, 'Loading…');
    if ('gone' in det) return h('div', { class: 'empty' }, `Batch #${det.gone} is no longer in the buffer.`);
    return R.detail(det);
  }

  // ---------- fronta ----------
  function queueView(q: QueueReply): Kid[] {
    const out: Kid[] = [h('div', { class: 'note' }, `Tick ${q.tick} · ${fmt.when(q.tick)}. Who scheduled each pending event: a proposal (known for events scheduled while this room was loaded, ${q.traced} remembered), the reconciler (periodic events) or earlier (scheduled before this room was loaded, when the world was created, or by a batch older than the buffer). `,
      'When it runs, an event draws from hash(seed, step at that tick, ev#<seq>); a periodic event’s time was drawn from hash(seed, “plan”, key, from). The seed is never shown.')];
    out.push(q.queue.length ? wrap(h('tr', null, h('th', null, 'When'), h('th', null, ''), h('th', { class: 'num' }, 'Seq'), h('th', null, 'Type'), h('th', null, 'Kind'), h('th', null, 'Scheduled by'), h('th', null, 'Random'), h('th', null, 'Data')),
      q.queue.map(e => h('tr', null, h('td', null, fmt.when(e.at)), h('td', { class: 'muted' }, fmt.inTicks(e.in)), h('td', { class: 'num muted' }, e.seq), h('td', null, h('b', null, e.type)),
        h('td', null, h('span', { class: 'badge', title: e.key || '' }, e.kind)),
        h('td', null, e.origin.kind === 'proposal' ? h('span', null, h('span', { class: 'mono' }, e.origin.by), ` ${e.origin.type} @ tick ${e.origin.tick}, round ${e.origin.round}`) : h('span', { class: 'muted' }, e.origin.kind)),
        h('td', { class: 'mono muted' }, e.kind === 'periodic' ? `plan(${e.key}) · ${e.rng}` : e.rng), h('td', { class: 'mono wrap' }, e.summary)))) : h('div', { class: 'empty' }, 'The queue is empty.'));
    return out;
  }

  function render(): void {
    const v = view();
    const btn = (id: string, label: string): HTMLElement => h('button', { class: v === id ? 'on' : null, onclick: () => { ctx.setParam('ev', id === 'timeline' ? null : id); render(); void load(); } }, label);
    const bar = h('div', { class: 'sub' }, btn('timeline', 'Timeline'), btn('queue', 'Queue'));
    if (v === 'timeline') {
      const box = (k: string, def: boolean, label: string, title: string): HTMLElement => { const i = h('input', { type: 'checkbox' }); i.checked = opt(k, def); i.onchange = () => { ctx.setParam(k, i.checked === def ? null : i.checked ? '1' : '0'); render(); }; return h('label', { title }, i, label); };
      const f = h('input', { type: 'search', placeholder: 'Filter by type…', autocomplete: 'off' });
      f.value = ctx.param('eq') || '';
      f.oninput = () => { ctx.setParam('eq', f.value.trim()); const p = f.selectionStart; render(); const n = el.querySelector('.sub input[type=search]'); if (n instanceof HTMLInputElement) { n.focus(); n.setSelectionRange(p, p); } };
      bar.append(box('emv', true, 'hide plain moves', 'Hide action batches that only moved players without a conflict'), box('efl', false, 'hide filter-only', 'Hide frames where only the message filter decided something'), f);
    }
    const head = h('h2', null, 'Engine', ctx.room ? h('span', { class: 'badge' }, ctx.room) : null);
    let body: Kid[];
    if (!ctx.room) body = [h('div', { class: 'empty' }, 'Pick a room on the left.')];
    else if (err) body = [h('div', { class: 'empty err' }, err)];
    else if (v === 'queue') body = q ? queueView(q) : [h('div', { class: 'empty' }, 'Loading…')];
    else if (!list) body = [h('div', { class: 'empty' }, 'Loading…')];
    else if (!list.loaded) body = [h('div', { class: 'empty' }, 'This room is not loaded on the server, so there are no batches in memory. They appear once a player joins (and the catch-up after loading is recorded too).')];
    else body = timelineView(list);
    const old = el.querySelector('.en .rows'), top = old ? old.scrollTop : 0; // obnovenie (auto) nesmie odskočiť v zozname
    el.replaceChildren(h('div', { class: 'en' }, head, bar, ...body));
    const rows = el.querySelector('.en .rows');
    if (rows) rows.scrollTop = top;
  }

  void load();
  return {
    update(c) { ctx = c; void load(); },

    unmount() { seq++; }
  };
}
