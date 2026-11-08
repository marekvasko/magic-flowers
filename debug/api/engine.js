'use strict';
// Ladiaca stránka (#106): GET /api/debug/engine?room=<id>          – časová os posledných dávok (kruhová pamäť sveta)
//                         GET /api/debug/engine?room=<id>&n=<n>    – jedna dávka: poradie vstupov, filter, návrhy po kolách,
//                                                                    skupiny riešiteľa, zmeny sveta pred / po
//                         GET /api/debug/engine?room=<id>&view=queue – fronta: kto udalosť naplánoval, z čoho bude jej náhoda
// Všetko sa odvodí zo záznamov, ktoré engine aj tak robí pre denník (entry) – nič sa nevyhodnocuje znova, svet sa nemení.
// Semienko sveta sa nikdy neukáže: pri náhode len vstupy odvodenia (krok, id vstupu, účel). Kľúče hráčov odstráni debug.js.
const E = require('../../src/server/engine.js');

const NPC = /^npc_|^jano_/;
// Kto vstup poslal: hráč (kľúč – na odtlačok ho zmení debug.js), NPC alebo plánovač (udalosť z fronty)
function actorOf(inp) {
  if (inp.actor != null) return { kind: 'player', key: inp.actor };
  if (inp.ev) return { kind: NPC.test(inp.type) ? 'npc' : 'scheduler' };
  return { kind: 'server' };
}
// Fáza dávky: pohyb (pos), akcia hráča, alebo svet (udalosti z fronty)
const stageOf = inp => (inp.ev ? 'world' : inp.type === 'pos' ? 'move' : 'act');
const short = v => { const s = JSON.stringify(v); return s == null ? '' : s.length > 120 ? s.slice(0, 117) + '…' : s; };
const keysOfP = p => [...(p.reads || []), ...(p.writes || [])];
const meetsAny = (keys, writes) => { const hits = []; for (const k of keys) for (const w of writes) if (E.meets(k, w)) hits.push([k, w]); return hits; };

// Jeden riadok časovej osi
function row(rec) {
  const e = rec.entry, f = rec.filter || [];
  const base = { n: rec.n, tick: rec.tick, wall: rec.wall, source: rec.source, timing: rec.timing, filtered: f.filter(d => d.what !== 'input').length };
  if (!e) return Object.assign(base, { kind: 'filter', inputs: 0, requests: 0, events: 0, proposals: 0, applied: 0, held: 0, rejected: 0, errors: 0, rounds: 0 });
  const cnt = o => e.proposals.filter(p => p.outcome === o).length;
  const events = e.inputs.filter(i => i.ev).length;
  return Object.assign(base, {
    kind: events ? 'events' : 'actions', step: e.step, inputs: e.inputs.length, requests: e.inputs.length - events, events,
    proposals: e.proposals.length, applied: cnt('applied'), held: cnt('held'), rejected: cnt('rejected'), errors: cnt('error'),
    rounds: e.proposals.reduce((m, p) => Math.max(m, p.round), 0),
    types: [...new Set(e.inputs.map(i => i.type))].slice(0, 6)
  });
}
// Časová os: riadky od najnovšieho; kroky bez dávky medzi dvoma riadkami zbalené do jedného („312 empty ticks“)
function timeline(records) {
  const out = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i], newer = out.length ? records[i + 1] : null;
    if (newer && newer.tick - r.tick > 1) out.push({ gap: newer.tick - r.tick - 1, from: r.tick + 1, to: newer.tick - 1 });
    out.push(row(r));
  }
  return out;
}

// Skupiny riešiteľa v jednom kole: návrhy, ktorých kľúče sa stretávajú so zápisom iného, sa riešili spolu
// (union-find); ostatné boli nezávislé (mohli by bežať súbežne).
function groupsOf(list) {
  const parent = list.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (meetsAny(keysOfP(a), b.writes || []).length || meetsAny(keysOfP(b), a.writes || []).length) parent[find(i)] = find(j);
  }
  const by = new Map();
  list.forEach((p, i) => { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(p.id); });
  const groups = [...by.values()];
  return { shared: groups.filter(g => g.length > 1), independent: groups.filter(g => g.length === 1).map(g => g[0]) };
}

// Kľúč zmeny v kolekcii → konkrétny kľúč ('tile:garden:*' + [12, 's'] → 'tile:garden:12' + ['s']), aby sa zmena
// z dawn dala porovnať s trhaním toho istého políčka
function concrete(key, p) {
  if (!key.endsWith('*') || !p.length) return { key, p };
  if (key === 'market:*') return { key, p };
  const pre = key.slice(0, -1); // 'tile:garden:', 'save:', 'market:seed_', 'market:npc:'
  return { key: pre + p[0], p: p.slice(1) };
}

// Podrobnosti jednej dávky
function detail(rec) {
  const e = rec.entry;
  const filter = (rec.filter || []).map(d => Object.assign({}, d, { actor: d.actor != null ? { kind: 'player', key: d.actor } : null }));
  const out = { row: row(rec), filter };
  if (!e) return out;
  const names = new Map((Array.isArray(e.presence) ? e.presence : []).map(p => [p.key, p.name]));
  out.presence = e.presence;
  out.inputs = e.inputs.map((inp, i) => Object.assign({
    pos: i + 1, id: inp.id, kind: inp.type, stage: stageOf(inp), actor: Object.assign(actorOf(inp), inp.actor != null ? { name: names.get(inp.actor) || null } : {}),
    summary: short(inp.data), data: inp.data
  }, inp.ev ? { ev: inp.ev } : {}));
  // návrhy po kolách; pri odložení (held) vinník: skorší návrh toho istého kola, ktorý už zapísal kľúč, čo tento chce
  const rounds = [];
  e.proposals.forEach((p, idx) => {
    const list = rounds[p.round - 1] || (rounds[p.round - 1] = []);
    const res = rec.results[p.id];
    const v = {
      id: p.id, type: p.type, round: p.round, reads: p.reads, writes: p.writes, outcome: p.outcome, msg: p.msg,
      rng: { step: e.step + p.round - 1, id: p.id }, changes: p.changes || null,
      emits: p.outcome === 'applied' && res ? res.outbox : [], ops: p.outcome === 'applied' && res ? res.ops : []
    };
    if (p.outcome === 'held') {
      v.blockedBy = [];
      for (let j = 0; j < idx; j++) {
        const q = e.proposals[j];
        if (q.round !== p.round || q.outcome !== 'applied') continue;
        const hits = meetsAny(keysOfP(p), q.writes);
        if (hits.length) v.blockedBy.push({ id: q.id, type: q.type, keys: hits.map(([mine, theirs]) => (mine === theirs ? mine : `${mine} ↔ ${theirs}`)) });
      }
    }
    list.push(v);
  });
  out.rounds = rounds.map((list, i) => ({ round: i + 1, step: e.step + i, proposals: list, groups: groupsOf(list) }));
  // zmeny sveta podľa kľúča: pred / po, kto zapísal, a kto ďalší o kľúč v tejto dávke stál (odložený, odmietnutý…)
  const byKey = new Map();
  for (const p of e.proposals) {
    if (!p.changes) continue;
    for (const [key, list] of Object.entries(p.changes)) {
      for (const c of list) {
        const k = concrete(key, c.p);
        if (!byKey.has(k.key)) byKey.set(k.key, { key: k.key, writes: [] });
        const ent = byKey.get(k.key);
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
  }).sort((a, b) => (b.contenders.length > 0) - (a.contenders.length > 0) || a.key.localeCompare(b.key));
  out.outbox = e.outbox;
  return out;
}

// Fronta s pôvodom: návrh, ktorý udalosť naplánoval (z kruhovej pamäte – len za posledných N dávok), periodické
// plánuje reconciler; náhoda udalosti bude hash(semienko, krok v čase behu, 'ev#<seq>'), periodickej pri plánovaní
// hash(semienko, 'plan', kľúč, od).
function queue(events, tick, origins) {
  return events.slice().sort((a, b) => a.at - b.at || a.seq - b.seq).map(ev => {
    const o = origins && origins.get(ev.seq);
    return {
      at: ev.at, in: ev.at - tick, seq: ev.seq, type: ev.type, key: ev.key || null, kind: ev.periodic ? 'periodic' : ev.key != null ? 'unique' : 'plain',
      summary: short(ev.data), rng: 'ev#' + ev.seq,
      origin: o ? Object.assign({ kind: 'proposal' }, o) : ev.periodic ? { kind: 'reconciler' } : { kind: 'earlier' }
    };
  });
}

module.exports = (query, tools) => {
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
    const n = query.get('n') | 0;
    const rec = tr.records.find(r => r.n === n);
    return rec ? Object.assign({ room: id, loaded: true }, detail(rec)) : { room: id, loaded: true, gone: n };
  }
  const first = tr.records.length ? tr.records[0].n : 0;
  return { room: id, loaded: true, max: tr.max, total: tr.n, kept: tr.records.length, overwritten: Math.max(0, first - 1), rows: timeline(tr.records) };
};
module.exports.timeline = timeline;
module.exports.row = row;
module.exports.detail = detail;
module.exports.queue = queue;
module.exports.groupsOf = groupsOf;
