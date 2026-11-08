'use strict';
// Ladiaca stránka (#106): záložka Journal – prehliadanie a filtrovanie denníka dávok na disku (data/journal-<svet>.jsonl
// a starší .1), aj pre svet, ktorý nie je načítaný.
//   GET /api/debug/journal?room=<id>[&kind=events|actions|load][&type=buy,pick,-pos][&actor=<p-…|meno>,…]
//                          [&outcome=held,rejected,error,applied][&key=<podreťazec kľúča>][&q=<voľný text>]
//                          [&from=<krok>][&to=<krok>][&moves=0][&before=<g>][&limit=<n>]
//        → riadky od najnovšieho (g = poradie riadku v oboch súboroch, najprv .1), počty a kurzor na ďalšiu stranu.
//        type: zoznam = aspoň jeden z nich, '-typ' = žiadny taký; actor a outcome: aspoň jeden; q: všetky slová (bez
//        diakritiky) v texte záznamu (vstupy, hlásenia odmietnutí a chýb, kľúče, správy); moves=0 skryje rutinu (samotný
//        pohyb bez sporu, „naposledy videný“). facets: počty typov / hráčov / osudov / druhov pri ostatných filtroch.
//   GET /api/debug/journal?room=<id>&g=<n>  → jeden záznam rozobraný ako v záložke Engine (kolá, vinníci, zmeny pred / po)
// Súbory sa len čítajú. Prehľad riadkov (krok, typy, aktéri, osudy, kľúče, poloha v súbore) sa drží v pamäti a pri
// ďalšej požiadavke sa dočíta len to, čo do súboru pribudlo (denník sa iba pripisuje; pri otočení sa začne odznova).
const fs = require('fs');
const { keyId } = require('../../src/server/debug.ts');
const Engine = require('./engine.js');

const CHUNK = 4 << 20, TEXT_MAX = 600;
const OUT = ['applied', 'held', 'rejected', 'error'];
// text na hľadanie: malé písmená bez diakritiky
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const cache = new Map(); // cesta → { ino, bytes, rest, items, names: kľúč hráča → meno (z prítomnosti v záznamoch) }

// Prehľad jedného riadku denníka
function summarize(e, off, len) {
  if (e.load) return { off, len, tick: e.tick, wall: e.wall, kind: 'load', step: e.step, seq: e.seq, migratedFrom: e.migratedFrom || null, types: [], actors: [], o: [0, 0, 0, 0], rounds: 0, n: 0, keys: '', text: 'world loaded' };
  const inputs = e.inputs || [], props = e.proposals || [];
  const o = [0, 0, 0, 0], keys = new Set(), msgs = [];
  let rounds = 0;
  for (const p of props) {
    o[OUT.indexOf(p.outcome)]++;
    if (p.msg) msgs.push(p.msg);
    rounds = Math.max(rounds, p.round);
    for (const k of p.reads || []) keys.add(k);
    for (const k of p.writes || []) keys.add(k);
  }
  return {
    off, len, tick: e.tick, wall: e.wall, step: e.step, kind: inputs.some(i => i.ev) ? 'events' : 'actions', n: inputs.length,
    types: [...new Set(inputs.map(i => i.type))], actors: [...new Set(inputs.filter(i => i.actor != null).map(i => i.actor))],
    o, rounds, keys: [...keys].join(' '),
    text: norm([msgs.join(' '), inputs.map(i => i.type + ' ' + JSON.stringify(i.data)).join(' ').slice(0, TEXT_MAX), [...keys].join(' '),
      (e.outbox || []).map(m => m.t + (m.text ? ' ' + m.text : '')).join(' ').slice(0, TEXT_MAX)].join(' '))
  };
}

// Dočíta do prehľadu, čo v súbore pribudlo od minula
function index(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { cache.delete(file); return []; }
  let c = cache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.bytes) c = { ino: st.ino, bytes: 0, rest: Buffer.alloc(0), items: [], names: new Map() };
  if (st.size > c.bytes) {
    const fd = fs.openSync(file, 'r');
    try {
      while (c.bytes < st.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - c.bytes));
        const got = fs.readSync(fd, buf, 0, buf.length, c.bytes);
        if (!got) break;
        if (!c.names) c.names = new Map();
        const data = Buffer.concat([c.rest, buf.subarray(0, got)]);
        const base = c.bytes - c.rest.length; // poloha data[0] v súbore
        let from = 0, nl;
        while ((nl = data.indexOf(10, from)) >= 0) {
          if (nl > from) {
            try {
              const e = JSON.parse(data.toString('utf8', from, nl));
              c.items.push(summarize(e, base + from, nl - from));
              if (Array.isArray(e.presence)) for (const p of e.presence) if (p && p.key && p.name) c.names.set(p.key, p.name);
            } catch (e) { /* poškodený riadok */ }
          }
          from = nl + 1;
        }
        c.rest = data.subarray(from); // neúplný posledný riadok počká
        c.bytes += got;
      }
    } finally { fs.closeSync(fd); }
  }
  cache.set(file, c);
  return c.items;
}
function readEntry(file, it) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(it.len); fs.readSync(fd, buf, 0, it.len, it.off); return JSON.parse(buf.toString('utf8')); } finally { fs.closeSync(fd); }
}

module.exports = (query, tools) => {
  const id = query.get('room') || query.get('id') || '';
  if (!tools.ROOM_RE.test(id)) return null;
  const files = tools.journalFiles(id);
  const r = tools.load(id); // kľúče hráčov z uložení sa tým odstránia z odpovede
  if (!files.length && !r) return null;
  // všetky riadky oboch súborov: g = poradie (najprv starší .1)
  const all = [];
  const names = new Map();
  for (const [fi, f] of files.entries()) {
    for (const it of index(f.path)) all.push({ fi, it });
    const c = cache.get(f.path);
    if (c) for (const [k, n] of c.names) names.set(k, n);
  }
  const players = new Set(Object.keys((r && r.state.saves) || {}));
  for (const { it } of all) for (const a of it.actors) players.add(a);
  tools.redactKeys([...players]);
  const byId = new Map([...players].map(k => [keyId(k), k]));
  const fileInfo = files.map(f => ({ name: f.name, size: fs.statSync(f.path).size }));

  if (query.has('g')) {
    const g = query.get('g') | 0, x = all[g];
    if (!x) return { room: id, files: fileInfo, gone: g };
    const e = readEntry(files[x.fi].path, x.it);
    for (const p of Array.isArray(e.presence) ? e.presence : []) if (p && p.key) tools.redactKeys([p.key]);
    if (e.load) return { room: id, files: fileInfo, g, load: e };
    const d = Engine.detail({ n: g, tick: e.tick, wall: e.wall, source: 'journal', entry: e, results: {}, filter: null, timing: null });
    return Object.assign({ room: id, files: fileInfo, g }, d);
  }

  // filtre: každý je predikát; počty (facets) pre jeden filter sa rátajú so všetkými ostatnými
  const list = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);
  const kind = query.get('kind') || '';
  const tl = list(query.get('type')), inc = new Set(tl.filter(t => t[0] !== '-')), exc = new Set(tl.filter(t => t[0] === '-').map(t => t.slice(1)));
  const actors = new Set(list(query.get('actor')).map(a => byId.get(a) || a.toLowerCase()));
  const outs = list(query.get('outcome')).map(o => OUT.indexOf(o)).filter(i => i >= 0);
  const keyQ = (query.get('key') || '').trim().replace(/p-[0-9a-f]{8}/g, m => byId.get(m) || m); // kľúč zadaný s odtlačkom hráča
  const words = norm(query.get('q') || '').replace(/p-[0-9a-f]{8}/g, m => byId.get(m) || m).split(/\s+/).filter(Boolean);
  const num = k => (query.has(k) && query.get(k) !== '' && isFinite(+query.get(k)) ? +query.get(k) : null);
  const from = num('from') == null ? -Infinity : num('from'), to = num('to') == null ? Infinity : num('to');
  const hideRoutine = query.get('moves') === '0';
  const routine = it => it.kind === 'actions' && !it.o[1] && !it.o[2] && !it.o[3] && it.types.every(t => t === 'pos' || t === 'seen');
  const load = it => it.kind === 'load';
  const P = {
    kind: it => !kind || it.kind === kind,
    tick: it => it.tick >= from && it.tick <= to,
    type: it => (!inc.size || (!load(it) && it.types.some(t => inc.has(t)))) && !it.types.some(t => exc.has(t)),
    actor: it => !actors.size || it.actors.some(a => actors.has(a)),
    outcome: it => !outs.length || outs.some(i => it.o[i] > 0),
    key: it => !keyQ || it.keys.includes(keyQ),
    q: it => words.every(w => it.text.includes(w)),
    routine: it => !hideRoutine || !routine(it)
  };
  const names_ = Object.keys(P);
  const facets = { type: {}, actor: {}, outcome: { applied: 0, held: 0, rejected: 0, error: 0 }, kind: { events: 0, actions: 0, load: 0 } };
  const before = query.has('before') ? query.get('before') | 0 : all.length;
  const limit = Math.max(1, Math.min(500, query.get('limit') | 0 || 100));
  const rows = [];
  let matched = 0, next = null;
  for (let g = all.length - 1; g >= 0; g--) {
    const it = all[g].it;
    let fails = 0, failed = null;
    for (const n of names_) if (!P[n](it)) { fails++; failed = n; if (fails > 1) break; }
    if (fails > 1) continue;
    // počty: riadok, ktorý prešiel všetkým okrem jedného filtra, sa počíta len do počtov toho filtra
    if (!fails || failed === 'type') for (const t of it.types) facets.type[t] = (facets.type[t] || 0) + 1;
    if (!fails || failed === 'actor') for (const a of it.actors) facets.actor[a] = (facets.actor[a] || 0) + 1;
    if (!fails || failed === 'outcome') it.o.forEach((c, i) => { if (c) facets.outcome[OUT[i]]++; });
    if (!fails || failed === 'kind') facets.kind[it.kind]++;
    if (fails) continue;
    matched++;
    if (g >= before) continue;
    if (rows.length < limit) rows.push({ g, tick: it.tick, wall: it.wall, kind: it.kind, step: it.step, n: it.n, types: it.types, actors: it.actors, applied: it.o[0], held: it.o[1], rejected: it.o[2], errors: it.o[3], rounds: it.rounds, migratedFrom: it.migratedFrom, routine: routine(it) });
    else if (next === null) next = rows[rows.length - 1].g;
  }
  const typesAll = new Set();
  for (const { it } of all) for (const t of it.types) typesAll.add(t);
  return {
    room: id, files: fileInfo, total: all.length, matched, rows, next, facets,
    first: all.length ? all[0].it.tick : null, last: all.length ? all[all.length - 1].it.tick : null,
    types: [...typesAll].sort(), players: [...players].map(k => ({ id: k, name: names.get(k) || null }))
  };
};
module.exports.summarize = summarize;
