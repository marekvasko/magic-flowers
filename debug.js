// Ladiaca stránka /debug (#64, #74): statické súbory z debug/ a API len na čítanie, prístupné priamo (bez kľúča).
// Nič sa tu nedá zmeniť: čítanie sveta ho nikdy nenačíta do servera, neposúva čas ani neukladá.
// Kľúče hráčov (ich identita, s ňou by sa dalo prihlásiť za hráča) sa nikdy neukážu.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine.js');
const Econ = require('./economy.js');

const ROOM_RE = /^[a-z0-9-]{1,16}$/; // rovnaké mená svetov ako pri pripojení hráča
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Kľúč hráča (jeho identita v ukladaní) sa nikdy neukáže – nahradí ho krátky odtlačok
const keyId = k => 'p-' + sha('mf-player:' + k).slice(0, 8);

// Kľúče hráčov v hodnote nahradí odtlačkom (vráti kópiu): celé reťazce aj kľúče vnútri iných reťazcov ('save:<k>',
// 'event:scavDone:<k>', chybové hlásenie návrhu…) a mená vlastností (zmeny v 'save:*', uloženia). Kľúč hráča je meno
// malými písmenami, preto sa nahrádza len ako celé slovo: na začiatku alebo za ':', medzerou či úvodzovkou.
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redactor(keys) {
  const list = [...keys].filter(k => typeof k === 'string' && k).sort((a, b) => b.length - a.length);
  if (!list.length) return v => v;
  const re = new RegExp('(^|[:\\s"\'(])(' + list.map(reEsc).join('|') + ')(?=$|[:\\s"\',.;!?)])', 'g');
  const str = x => x.replace(re, (m, pre, k) => pre + keyId(k));
  const walk = v => {
    if (typeof v === 'string') return str(v);
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k in v) out[str(k)] = walk(v[k]);
    return out;
  };
  return walk;
}

// ---- Kruhová pamäť dávok pre záložku Engine (#106) ----
// Svet v pamäti si drží posledných `max` záznamov: každá vykonaná dávka (entry z denníka + čo k nej denník nemá:
// správy a operácie s frontou každého návrhu, časy častí, rozhodnutia filtra správ hráčov, kto dávku spustil)
// a rámce, v ktorých filter niečo rozhodol, no do enginu nič nešlo. Nikdy sa neukladá a nemení svet.
// origins: seq udalosti → kto ju naplánoval (návrh, krok, kolo) – pre frontu; drží sa len pre udalosti, čo ešte čakajú.
const ORIGINS_MAX = 20000;
function traceRing(max) { return { max: Math.max(1, max | 0), n: 0, buf: [], origins: new Map() }; }
function tracePush(ring, rec) {
  rec.n = ++ring.n;
  ring.buf[(rec.n - 1) % ring.max] = rec; // O(1): najstarší záznam sa prepíše
  return rec;
}
// Záznamy od najstaršieho po najnovší
function traceList(ring) {
  if (!ring) return [];
  const b = ring.buf, n = ring.n, len = b.length;
  return n <= ring.max ? b.slice() : b.slice(n % ring.max).concat(b.slice(0, n % ring.max)).slice(0, len);
}
// Zaznamená dávku z commitBatch (out). meta: { source, filter, timing, tick }. Výsledky návrhov (kópie výrezov) sa
// nedržia – len ich správy a operácie s frontou; entry je ten istý objekt, ktorý ide do denníka (nekopíruje sa).
function traceBatch(ring, out, meta) {
  const results = {};
  for (const r of out.applied.concat(out.rejected)) {
    const ops = r.ops.map(o => o.op === 'cancel' ? { op: 'cancel', key: o.key } : { op: 'insert', seq: o.seq, at: o.ev.at, type: o.ev.type, key: o.ev.key });
    if (r.outbox.length || ops.length) results[r.id] = { outbox: r.reject === undefined ? r.outbox : [], ops: r.reject === undefined ? ops : [] };
  }
  const entry = out.entry;
  for (const p of entry.proposals) {
    if (p.outcome !== 'applied' || !results[p.id]) continue;
    for (const o of results[p.id].ops) if (o.op === 'insert' && o.seq != null) ring.origins.set(o.seq, { by: p.id, type: p.type, tick: entry.tick, step: entry.step + p.round - 1, round: p.round });
  }
  while (ring.origins.size > ORIGINS_MAX) ring.origins.delete(ring.origins.keys().next().value);
  return tracePush(ring, { tick: entry.tick, source: meta.source || 'live', entry, results, filter: meta.filter || null, timing: meta.timing || out.timing || null });
}
// Rámec bez dávky: filter správ niečo rozhodol (zlúčil, odložil, zahodil…), ale do enginu nič nešlo
function traceFilter(ring, tick, filter, timing) {
  return tracePush(ring, { tick, source: 'frame', entry: null, results: {}, filter, timing: timing || null });
}

// ctx: { dataDir, debugDir, rooms (Map id → svet v pamäti), serialize(room) → JSON, migrate(stav) → stav,
//        sim() → špecifikácia simulácie { proposers, periodic } pre stav reconcilera }
// Vráti handle(req, res) → true, ak požiadavku vybavil (inak ju server spracuje ako obyčajný súbor).
function create(ctx) {
  const notFound = res => { res.writeHead(404); res.end('Not found'); return true; };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.end(JSON.stringify(obj));
    return true;
  };
  const roomFile = id => path.join(ctx.dataDir, 'room-' + id + '.json');
  const online = room => [...room.players.values()].map(p => ({ name: p.name, area: p.area, player: keyId(p.key) }));

  function listRooms() {
    const out = new Map();
    let files = [];
    try { files = fs.readdirSync(ctx.dataDir); } catch (e) { /* zatiaľ žiadne uložené svety */ }
    for (const f of files) {
      const m = /^room-([a-z0-9-]{1,16})\.json$/.exec(f);
      if (!m) continue;
      try { const st = fs.statSync(path.join(ctx.dataDir, f)); out.set(m[1], { id: m[1], size: st.size, saved: st.mtimeMs, loaded: false, online: [] }); } catch (e) { /* zmazaný medzitým */ }
    }
    for (const [id, room] of ctx.rooms) {
      const e = out.get(id) || { id, size: null, saved: null };
      Object.assign(e, { loaded: true, online: online(room), tick: room.tick });
      out.set(id, e);
    }
    return [...out.values()].sort((a, b) => b.online.length - a.online.length || (b.saved || 0) - (a.saved || 0) || a.id.localeCompare(b.id));
  }

  // Stav reconcilera (engine.js): čo je naplánované, čo chýba a čo by zahodil – len plán, svet sa nemení.
  // Kedy by sa chýbajúca udalosť naplánovala, sa počíta na kópii (next môže ťahať náhodu zo sveta).
  const WHY = { 'neznámy typ': 'unknown type (no proposer)', 'nedeklarovaná periodická': 'periodic, no longer declared', 'duplicita': 'duplicate' };
  function reconcilerView(state) {
    const sim = ctx.sim && ctx.sim();
    if (!sim) return null;
    const plan = E.reconcilePlan({ tick: state.tick, events: state.events || [] }, sim);
    const wouldAt = def => { try { return E.planAt(Object.assign({}, state), def, state.tick + 1); } catch (e) { return null; } };
    const evs = state.events || [];
    return {
      declared: (sim.periodic || []).length, proposers: Object.keys(sim.proposers || {}).length,
      counts: { periodic: evs.filter(e => e.periodic).length, unique: evs.filter(e => e.key != null && !e.periodic).length, plain: evs.filter(e => e.key == null).length },
      periodic: [...plan.ok.map(o => ({ key: o.def.key, type: o.def.type, status: 'scheduled', at: o.ev.at })),
        ...plan.missing.map(d => ({ key: d.key, type: d.type, status: 'missing', at: wouldAt(d) }))].sort((a, b) => (a.at == null) - (b.at == null) || a.at - b.at),
      drop: plan.drop.map(d => ({ key: d.ev.key || null, type: d.ev.type, at: d.ev.at, why: WHY[d.why] || d.why }))
    };
  }

  // Kópia stavu sveta: z pamäte, ak je načítaný (rovnaký serialize ako pri ukladaní); inak len prečítaný súbor
  // (migrate na kópii). Svet v serveri sa nikdy nedostane von – rozšírenia dostanú len túto kópiu.
  // Tajomstvá sveta (semienko náhody, soľ divých semienok) von nejdú – z nich by sa dali predvídať výsledky.
  // Odstraňujú sa až pred odpoveďou: reconcilerView potrebuje semienko, aby ukázal ten istý čas, aký naplánuje engine.
  function secretless(r) { if (r) { delete r.state.seed; delete r.state.scavSalt; } return r; }
  function loadState(id) {
    if (!ROOM_RE.test(id)) return null;
    const room = ctx.rooms.get(id);
    if (room) return { id, source: 'memory', file: null, online: online(room), state: JSON.parse(ctx.serialize(room)) };
    let text;
    try { text = fs.readFileSync(roomFile(id), 'utf8'); } catch (e) { return null; }
    const st = fs.statSync(roomFile(id));
    const state = ctx.migrate(JSON.parse(text));
    if (state.market) Econ.syncFestival(state.market); // ako pri načítaní na serveri: sviatočné násobky v položkách kvetov
    return { id, source: 'file', file: { size: st.size, saved: st.mtimeMs }, online: [], state };
  }
  // Kľúče hráčov (z načítaných svetov) nahradí v celej odpovedi odtlačkom
  function redact(obj, keys) { return redactor(keys)(JSON.parse(JSON.stringify(obj))); }
  function roomSnapshot(id) {
    const r = loadState(id);
    if (!r) return null;
    return redact(secretless(Object.assign({}, r, { reconciler: reconcilerView(r.state) })), Object.keys(r.state.saves || {}));
  }

  // Rozšírenia API pre záložky: debug/api/<name>.js exportuje (query, tools) → objekt na odpoveď (null = 404).
  //   tools.load(id) → { id, source, file, online, state } kópia sveta (alebo null), tools.rooms() → zoznam svetov,
  //   tools.sim → špecifikácia simulácie, tools.trace(id) → { max, n, records, origins } kruhová pamäť dávok sveta
  //   v pamäti (alebo null). Kľúče hráčov z načítaných svetov sa z odpovede odstránia samy.
  function extension(res, name, query) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return notFound(res);
    const file = path.join(ctx.debugDir, 'api', name + '.js');
    if (!fs.existsSync(file)) return notFound(res);
    const keys = new Set();
    const tools = {
      ROOM_RE, rooms: listRooms, sim: ctx.sim && ctx.sim(),
      load: id => { const r = loadState(String(id || '')); if (r) for (const k of Object.keys(r.state.saves || {})) keys.add(k); return secretless(r); },
      trace: id => {
        const room = ctx.rooms.get(String(id || ''));
        if (!room || !room.trace) return null;
        for (const k of Object.keys(room.saves || {})) keys.add(k);
        for (const p of room.players ? room.players.values() : []) if (p.key) keys.add(p.key);
        return { max: room.trace.max, n: room.trace.n, records: traceList(room.trace), origins: room.trace.origins };
      }
    };
    let body;
    try { body = require(file)(query, tools); } catch (e) { console.error('[debug]', name, e); return json(res, 500, { error: e.message }); }
    return body == null ? json(res, 404, { error: 'not found' }) : json(res, 200, redact(body, keys));
  }

  function serveFile(res, rel) {
    const file = path.normalize(path.join(ctx.debugDir, rel));
    if (!file.startsWith(ctx.debugDir + path.sep)) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) return notFound(res);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
      res.end(buf);
    });
    return true;
  }

  return function handle(req, res) {
    const q = (req.url || '/').indexOf('?');
    const url = (q >= 0 ? req.url.slice(0, q) : req.url) || '/';
    const query = new URLSearchParams(q >= 0 ? req.url.slice(q + 1) : '');
    if (url !== '/debug' && !url.startsWith('/debug/') && !url.startsWith('/api/debug/')) return false;
    if (req.method !== 'GET') return notFound(res); // len na čítanie
    if (url === '/api/debug/rooms') return json(res, 200, { rooms: listRooms(), now: Date.now() });
    if (url === '/api/debug/room') {
      const id = query.get('id') || '';
      if (!ROOM_RE.test(id)) return json(res, 400, { error: 'bad room id' });
      const snap = roomSnapshot(id);
      return snap ? json(res, 200, snap) : json(res, 404, { error: 'no such room' });
    }
    if (url.startsWith('/api/debug/')) return extension(res, url.slice(11), query);
    if (url === '/debug' || url === '/debug/') return serveFile(res, 'index.html');
    let rel;
    try { rel = decodeURIComponent(url.slice(7)); } catch (e) { return notFound(res); }
    return serveFile(res, rel);
  };
}

module.exports = { create, keyId, redactor, traceRing, tracePush, traceList, traceBatch, traceFilter };
