'use strict';
// Ladiaca stránka (#106): záložka Journal – prehliadanie a filtrovanie denníka dávok na disku (data/journal-<svet>.jsonl
// a starší .1), aj pre svet, ktorý nie je načítaný.
//   GET /api/debug/journal?room=<id>[&kind=events|actions|load][&type=buy,pick][&actor=<p-…|meno>][&outcome=held|rejected|error|applied]
//                          [&key=<podreťazec kľúča>][&from=<krok>][&to=<krok>][&moves=0][&before=<g>][&limit=<n>]
//        → riadky od najnovšieho (g = poradie riadku v oboch súboroch, najprv .1), počty a kurzor na ďalšiu stranu
//   GET /api/debug/journal?room=<id>&g=<n>  → jeden záznam rozobraný ako v záložke Engine (kolá, vinníci, zmeny pred / po)
// Súbory sa len čítajú. Prehľad riadkov (krok, typy, aktéri, osudy, kľúče, poloha v súbore) sa drží v pamäti a pri
// ďalšej požiadavke sa dočíta len to, čo do súboru pribudlo (denník sa iba pripisuje; pri otočení sa začne odznova).
const fs = require('fs');
const { keyId } = require('../../debug.js');
const Engine = require('./engine.js');

const CHUNK = 4 << 20;
const cache = new Map(); // cesta → { ino, bytes, rest, items, names: kľúč hráča → meno (z prítomnosti v záznamoch) }

// Prehľad jedného riadku denníka
function summarize(e, off, len) {
  if (e.load) return { off, len, tick: e.tick, wall: e.wall, kind: 'load', step: e.step, seq: e.seq, migratedFrom: e.migratedFrom || null, types: [], actors: [], o: [0, 0, 0, 0], rounds: 0, n: 0, keys: '' };
  const inputs = e.inputs || [], props = e.proposals || [];
  const o = [0, 0, 0, 0], keys = new Set();
  let rounds = 0;
  for (const p of props) {
    o[['applied', 'held', 'rejected', 'error'].indexOf(p.outcome)]++;
    rounds = Math.max(rounds, p.round);
    for (const k of p.reads || []) keys.add(k);
    for (const k of p.writes || []) keys.add(k);
  }
  return {
    off, len, tick: e.tick, wall: e.wall, step: e.step, kind: inputs.some(i => i.ev) ? 'events' : 'actions', n: inputs.length,
    types: [...new Set(inputs.map(i => i.type))], actors: [...new Set(inputs.filter(i => i.actor != null).map(i => i.actor))],
    o, rounds, keys: [...keys].join(' ')
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

  // filtre
  const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
  const kind = query.get('kind') || '', types = new Set(list(query.get('type'))), outcome = query.get('outcome') || '';
  const actorQ = (query.get('actor') || '').trim(), actor = actorQ ? (byId.get(actorQ) || actorQ.toLowerCase()) : null;
  let keyQ = (query.get('key') || '').trim();
  keyQ = keyQ.replace(/p-[0-9a-f]{8}/g, m => byId.get(m) || m); // kľúč zadaný s odtlačkom hráča
  const from = query.has('from') && query.get('from') !== '' ? +query.get('from') : -Infinity, to = query.has('to') && query.get('to') !== '' ? +query.get('to') : Infinity;
  const hideMoves = query.get('moves') === '0';
  const oi = ['applied', 'held', 'rejected', 'error'].indexOf(outcome);
  const match = it => {
    if (kind && it.kind !== kind) return false;
    if (it.tick < from || it.tick > to) return false;
    if (it.kind === 'load') return !types.size && !actor && oi < 0 && !keyQ;
    if (types.size && !it.types.some(t => types.has(t))) return false;
    if (actor && !it.actors.includes(actor)) return false;
    if (oi >= 0 && !it.o[oi]) return false;
    if (keyQ && !it.keys.includes(keyQ)) return false;
    if (hideMoves && it.kind === 'actions' && it.types.length === 1 && it.types[0] === 'pos' && !it.o[1] && !it.o[2] && !it.o[3]) return false;
    return true;
  };
  const before = query.has('before') ? query.get('before') | 0 : all.length;
  const limit = Math.max(1, Math.min(500, query.get('limit') | 0 || 100));
  const rows = [];
  let matched = 0, next = null;
  for (let g = all.length - 1; g >= 0; g--) {
    const it = all[g].it;
    if (!match(it)) continue;
    matched++;
    if (g >= before) continue;
    if (rows.length < limit) rows.push({ g, tick: it.tick, wall: it.wall, kind: it.kind, step: it.step, n: it.n, types: it.types, actors: it.actors, applied: it.o[0], held: it.o[1], rejected: it.o[2], errors: it.o[3], rounds: it.rounds, migratedFrom: it.migratedFrom });
    else if (next === null) next = rows[rows.length - 1].g;
  }
  const typesAll = new Set();
  for (const { it } of all) for (const t of it.types) typesAll.add(t);
  return {
    room: id, files: fileInfo, total: all.length, matched, rows, next,
    first: all.length ? all[0].it.tick : null, last: all.length ? all[all.length - 1].it.tick : null,
    types: [...typesAll].sort(), players: [...players].map(k => ({ id: k, name: names.get(k) || null }))
  };
};
module.exports.summarize = summarize;
