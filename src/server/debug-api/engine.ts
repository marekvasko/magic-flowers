// Ladiaca stránka (#106): GET /api/debug/engine?room=<id>          – časová os posledných dávok (kruhová pamäť sveta)
//                         GET /api/debug/engine?room=<id>&n=<n>    – jedna dávka: poradie vstupov, filter, návrhy po kolách,
//                                                                    skupiny riešiteľa, zmeny sveta pred / po
//                         GET /api/debug/engine?room=<id>&view=queue – fronta: kto udalosť naplánoval, z čoho bude jej náhoda
// Všetko sa odvodí zo záznamov, ktoré engine aj tak robí pre denník (entry) – nič sa nevyhodnocuje znova, svet sa nemení.
// Semienko sveta sa nikdy neukáže: pri náhode len vstupy odvodenia (krok, id vstupu, účel). Kľúče hráčov odstráni debug.ts.
import * as E from '../engine.ts';
import type { Change, EngineEvent, JournalEntry, ProposalRecord } from '../engine.ts';
import type { FilterDecision, TraceOp, TraceOrigin, TraceRecord, Tools } from '../debug.ts';
import type { Msg } from '../game.ts';
import type { Presence } from '../world.ts';

// Záznam dávky: z kruhovej pamäte sveta, alebo riadok denníka (ten má aj čas zápisu wall)
export type Rec = TraceRecord & { wall?: number };
type Entry = JournalEntry<Presence, Msg>;
type EntryInput = Entry['inputs'][number];
type Proposal = Pick<ProposalRecord, 'reads' | 'writes'>;

const NPC = /^npc_|^jano_/;
// Kto vstup poslal: hráč (kľúč – na odtlačok ho zmení debug.ts), NPC alebo plánovač (udalosť z fronty)
function actorOf(inp: EntryInput): { kind: 'player'; key: string } | { kind: 'npc' | 'scheduler' | 'server' } {
  if (inp.actor != null) return { kind: 'player', key: inp.actor };
  if (inp.ev) return { kind: NPC.test(inp.type) ? 'npc' : 'scheduler' };
  return { kind: 'server' };
}
// Fáza dávky: pohyb (pos), akcia hráča, alebo svet (udalosti z fronty)
const stageOf = (inp: EntryInput): 'world' | 'move' | 'act' => (inp.ev ? 'world' : inp.type === 'pos' ? 'move' : 'act');
// JSON.stringify(undefined) vráti undefined, aj keď typ hovorí string
const short = (v: unknown): string => { const s = JSON.stringify(v) as string | undefined; return s == null ? '' : s.length > 120 ? s.slice(0, 117) + '…' : s; };
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- návrh z denníka môže kľúče nemať (chyba v keys)
const keysOfP = (p: Proposal): string[] => [...(p.reads || []), ...(p.writes || [])];
const meetsAny = (keys: string[], writes: string[]): [string, string][] => { const hits: [string, string][] = []; for (const k of keys) for (const w of writes) if (E.meets(k, w)) hits.push([k, w]); return hits; };

// Jeden riadok časovej osi
function rowOf(rec: Rec) {
  const e = rec.entry, f = rec.filter || [];
  const base = { n: rec.n, tick: rec.tick, wall: rec.wall, source: rec.source, timing: rec.timing, filtered: f.filter(d => d.what !== 'input').length };
  if (!e) return Object.assign(base, { kind: 'filter' as const, inputs: 0, requests: 0, events: 0, proposals: 0, applied: 0, held: 0, rejected: 0, errors: 0, rounds: 0 });
  const cnt = (o: ProposalRecord['outcome']): number => e.proposals.filter(p => p.outcome === o).length;
  const events = e.inputs.filter(i => i.ev).length;
  return Object.assign(base, {
    kind: events ? 'events' as const : 'actions' as const, step: e.step, inputs: e.inputs.length, requests: e.inputs.length - events, events,
    proposals: e.proposals.length, applied: cnt('applied'), held: cnt('held'), rejected: cnt('rejected'), errors: cnt('error'),
    rounds: e.proposals.reduce((m, p) => Math.max(m, p.round), 0),
    types: [...new Set(e.inputs.map(i => i.type))].slice(0, 6)
  });
}
export type Row = ReturnType<typeof rowOf>;
export function row(rec: Rec): Row { return rowOf(rec); }
// Časová os: riadky od najnovšieho; kroky bez dávky medzi dvoma riadkami zbalené do jedného („312 empty ticks“)
export function timeline(records: Rec[]): (Row | { gap: number; from: number; to: number })[] {
  const out: (Row | { gap: number; from: number; to: number })[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i], newer = out.length ? records[i + 1] : null;
    if (!r) continue;
    if (newer && newer.tick - r.tick > 1) out.push({ gap: newer.tick - r.tick - 1, from: r.tick + 1, to: newer.tick - 1 });
    out.push(row(r));
  }
  return out;
}

// Skupiny riešiteľa v jednom kole: návrhy, ktorých kľúče sa stretávajú so zápisom iného, sa riešili spolu
// (union-find); ostatné boli nezávislé (mohli by bežať súbežne).
export function groupsOf(list: (Proposal & { id: string })[]): { shared: string[][]; independent: string[] } {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => { const p = parent[i] ?? i; return p === i ? i : (parent[i] = find(p)); };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (!a || !b) continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- návrh z denníka môže kľúče nemať
    if (meetsAny(keysOfP(a), b.writes || []).length || meetsAny(keysOfP(b), a.writes || []).length) parent[find(i)] = find(j);
  }
  const by = new Map<number, string[]>();
  list.forEach((p, i) => { const r = find(i); const g = by.get(r) ?? []; if (!by.has(r)) by.set(r, g); g.push(p.id); });
  const groups = [...by.values()];
  return { shared: groups.filter(g => g.length > 1), independent: groups.flatMap(g => (g.length === 1 && g[0] !== undefined ? [g[0]] : [])) };
}

// Kľúč zmeny v kolekcii → konkrétny kľúč ('tile:garden:*' + [12, 's'] → 'tile:garden:12' + ['s']), aby sa zmena
// z dawn dala porovnať s trhaním toho istého políčka
function concrete(key: string, p: Change['p']): { key: string; p: Change['p'] } {
  if (!key.endsWith('*') || !p.length) return { key, p };
  if (key === 'market:*') return { key, p };
  const pre = key.slice(0, -1); // 'tile:garden:', 'save:', 'market:seed_', 'market:npc:'
  return { key: pre + String(p[0]), p: p.slice(1) };
}

// Návrh v pohľade dávky (po kolách)
interface ProposalView {
  id: string; type: string; round: number; reads: string[]; writes: string[]; outcome: ProposalRecord['outcome']; msg: string | null | undefined;
  rng: { step: number; id: string }; changes: ProposalRecord['changes'] | null; emits: Msg[]; ops: TraceOp[];
  blockedBy?: { id: string; type: string; keys: string[] }[];
}
type Leaf = { p: Change['p']; from: unknown; to: unknown } | { p: Change['p']; from: unknown; deleted: true };
interface KeyChange { key: string; writes: { id: string; type: string; round: number; via: string; leaves: Leaf[] }[] }
export interface Detail {
  row: Row;
  filter: (Omit<FilterDecision, 'actor'> & { actor: { kind: 'player'; key: string } | null })[];
  presence?: Entry['presence'];
  inputs?: (ReturnType<typeof inputView>)[];
  rounds?: { round: number; step: number; proposals: ProposalView[]; groups: ReturnType<typeof groupsOf> }[];
  changes?: (KeyChange & { leaves: number; contenders: { id: string; type: string; round: number; outcome: ProposalRecord['outcome']; msg: string | null | undefined }[] })[];
  outbox?: Msg[];
}
function inputView(inp: EntryInput, i: number, names: Map<string, string>) {
  return Object.assign({
    pos: i + 1, id: inp.id, kind: inp.type, stage: stageOf(inp), actor: Object.assign(actorOf(inp), inp.actor != null ? { name: names.get(inp.actor) || null } : {}),
    summary: short(inp.data), data: inp.data
  }, inp.ev ? { ev: inp.ev } : {});
}

// Podrobnosti jednej dávky
export function detail(rec: Rec): Detail {
  const e = rec.entry;
  const filter = (rec.filter || []).map(d => Object.assign({}, d, { actor: d.actor != null ? { kind: 'player' as const, key: d.actor } : null }));
  const out: Detail = { row: row(rec), filter };
  if (!e) return out;
  const names = new Map((Array.isArray(e.presence) ? e.presence : []).map(p => [p.key, p.name]));
  out.presence = e.presence;
  out.inputs = e.inputs.map((inp, i) => inputView(inp, i, names));
  // návrhy po kolách; pri odložení (held) vinník: skorší návrh toho istého kola, ktorý už zapísal kľúč, čo tento chce
  const rounds: ProposalView[][] = [];
  e.proposals.forEach((p, idx) => {
    const list = rounds[p.round - 1] || (rounds[p.round - 1] = []);
    const res = rec.results[p.id];
    const v: ProposalView = {
      id: p.id, type: p.type, round: p.round, reads: p.reads, writes: p.writes, outcome: p.outcome, msg: p.msg,
      rng: { step: e.step + p.round - 1, id: p.id }, changes: p.changes || null,
      emits: p.outcome === 'applied' && res ? res.outbox : [], ops: p.outcome === 'applied' && res ? res.ops : []
    };
    if (p.outcome === 'held') {
      v.blockedBy = [];
      for (let j = 0; j < idx; j++) {
        const q = e.proposals[j];
        if (!q || q.round !== p.round || q.outcome !== 'applied') continue;
        const hits = meetsAny(keysOfP(p), q.writes);
        if (hits.length) v.blockedBy.push({ id: q.id, type: q.type, keys: hits.map(([mine, theirs]) => (mine === theirs ? mine : `${mine} ↔ ${theirs}`)) });
      }
    }
    list.push(v);
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- kolo bez návrhov je v riedkom poli prázdne miesto
  out.rounds = rounds.map((list, i) => ({ round: i + 1, step: e.step + i, proposals: list, groups: groupsOf(list || []) }));
  // zmeny sveta podľa kľúča: pred / po, kto zapísal, a kto ďalší o kľúč v tejto dávke stál (odložený, odmietnutý…)
  const byKey = new Map<string, KeyChange>();
  for (const p of e.proposals) {
    if (!p.changes) continue;
    for (const [key, list] of Object.entries(p.changes)) {
      for (const c of list) {
        const k = concrete(key, c.p);
        const ent = byKey.get(k.key) ?? { key: k.key, writes: [] };
        if (!byKey.has(k.key)) byKey.set(k.key, ent);
        let w = ent.writes.find(x => x.id === p.id);
        if (!w) ent.writes.push(w = { id: p.id, type: p.type, round: p.round, via: key, leaves: [] });
        w.leaves.push('to' in c ? { p: k.p, from: c.from, to: c.to } : { p: k.p, from: c.from, deleted: true });
      }
    }
  }
  out.changes = [...byKey.values()].map(ent => {
    const others = e.proposals.filter(p => !ent.writes.some(w => w.id === p.id && p.outcome === 'applied') && keysOfP(p).some(k => E.meets(k, ent.key)))
      .map(p => ({ id: p.id, type: p.type, round: p.round, outcome: p.outcome, msg: p.msg }));
    return Object.assign(ent, { leaves: ent.writes.reduce((n, w) => n + w.leaves.length, 0), contenders: others });
  }).sort((a, b) => Number(b.contenders.length > 0) - Number(a.contenders.length > 0) || a.key.localeCompare(b.key));
  out.outbox = e.outbox;
  return out;
}

// Fronta s pôvodom: návrh, ktorý udalosť naplánoval (z kruhovej pamäte – len za posledných N dávok), periodické
// plánuje reconciler; náhoda udalosti bude hash(semienko, krok v čase behu, 'ev#<seq>'), periodickej pri plánovaní
// hash(semienko, 'plan', kľúč, od).
function queueOf(events: EngineEvent[], tick: number, origins: Map<number, TraceOrigin> | null | undefined) {
  return events.slice().sort((a, b) => a.at - b.at || a.seq - b.seq).map(ev => {
    const o = origins && origins.get(ev.seq);
    return {
      at: ev.at, in: ev.at - tick, seq: ev.seq, type: ev.type, key: ev.key || null, kind: ev.periodic ? 'periodic' : ev.key != null ? 'unique' : 'plain',
      summary: short(ev.data), rng: 'ev#' + ev.seq,
      origin: o ? Object.assign({ kind: 'proposal' as const }, o) : ev.periodic ? { kind: 'reconciler' as const } : { kind: 'earlier' as const }
    };
  });
}

export type QueueItem = ReturnType<typeof queueOf>[number];
export function queue(events: EngineEvent[], tick: number, origins: Map<number, TraceOrigin> | null | undefined): QueueItem[] { return queueOf(events, tick, origins); }

// Odpovede: časová os, jedna dávka, fronta (a svet, ktorý nie je načítaný / dávka, ktorá už vypadla z pamäte)
export type Timeline = ReturnType<typeof timeline>;
export interface TimelineReply { room: string; loaded: true; max: number; total: number; kept: number; overwritten: number; rows: Timeline }
export type DetailReply = Detail & { room: string; loaded: true };
export interface QueueReply { room: string; loaded: boolean; tick: number; traced: number; queue: QueueItem[] }
export type EngineReply = TimelineReply | DetailReply | QueueReply | { room: string; loaded: false; rows: [] } | { room: string; loaded: true; gone: number };

export default function engine(query: URLSearchParams, tools: Pick<Tools, 'ROOM_RE' | 'trace' | 'load'>): EngineReply | null {
  const id = query.get('room') || query.get('id') || '';
  if (!tools.ROOM_RE.test(id)) return null;
  const tr = tools.trace(id);
  const view = query.get('view');
  if (view === 'queue') {
    const r = tools.load(id);
    if (!r) return null;
    const events = r.state.events || [], tick = r.state.tick || 0;
    return { room: id, loaded: !!tr, tick, traced: tr ? tr.origins.size : 0, queue: queue(events, tick, tr && tr.origins) };
  }
  if (!tr) return { room: id, loaded: false, rows: [] };
  if (query.has('n')) {
    const n = Number(query.get('n')) | 0;
    const rec = tr.records.find(r => r.n === n);
    return rec ? Object.assign({ room: id, loaded: true as const }, detail(rec)) : { room: id, loaded: true, gone: n };
  }
  const first = tr.records[0]?.n ?? 0;
  return { room: id, loaded: true, max: tr.max, total: tr.n, kept: tr.records.length, overwritten: Math.max(0, first - 1), rows: timeline(tr.records) };
}
