// Ladiaca stránka /debug (#64, #74): statické súbory z debug/ a API len na čítanie, prístupné priamo (bez kľúča).
// Nič sa tu nedá zmeniť: čítanie sveta ho nikdy nenačíta do servera, neposúva čas ani neukladá.
// Kľúče hráčov (ich identita, s ňou by sa dalo prihlásiť za hráča) sa nikdy neukážu.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine.js');

const ROOM_RE = /^[a-z0-9-]{1,16}$/; // rovnaké mená svetov ako pri pripojení hráča
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Kľúč hráča (jeho identita v ukladaní) sa nikdy neukáže – nahradí ho krátky odtlačok
const keyId = k => 'p-' + sha('mf-player:' + k).slice(0, 8);

// ctx: { dataDir, debugDir, rooms (Map id → svet v pamäti), serialize(room) → JSON, migrate(stav) → stav,
//        sim() → špecifikácia simulácie { handlers, periodic } pre stav reconcilera }
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
  const WHY = { 'neznámy typ': 'unknown type (no handler)', 'nedeklarovaná periodická': 'periodic, no longer declared', 'duplicita': 'duplicate' };
  function reconcilerView(state) {
    const sim = ctx.sim && ctx.sim();
    if (!sim) return null;
    const plan = E.reconcilePlan({ tick: state.tick, events: state.events || [] }, sim);
    const wouldAt = def => { try { return def.next(Object.assign({}, state), state.tick + 1); } catch (e) { return null; } };
    const evs = state.events || [];
    return {
      declared: (sim.periodic || []).length, handlers: Object.keys(sim.handlers).length,
      counts: { periodic: evs.filter(e => e.periodic).length, unique: evs.filter(e => e.key != null && !e.periodic).length, plain: evs.filter(e => e.key == null).length },
      periodic: [...plan.ok.map(o => ({ key: o.def.key, type: o.def.type, status: 'scheduled', at: o.ev.at })),
        ...plan.missing.map(d => ({ key: d.key, type: d.type, status: 'missing', at: wouldAt(d) }))].sort((a, b) => (a.at == null) - (b.at == null) || a.at - b.at),
      drop: plan.drop.map(d => ({ key: d.ev.key || null, type: d.ev.type, at: d.ev.at, why: WHY[d.why] || d.why }))
    };
  }

  // Kópia stavu sveta: z pamäte, ak je načítaný (rovnaký serialize ako pri ukladaní); inak len prečítaný súbor
  // (migrate na kópii). Svet v serveri sa nikdy nedostane von – rozšírenia dostanú len túto kópiu.
  function loadState(id) {
    if (!ROOM_RE.test(id)) return null;
    const room = ctx.rooms.get(id);
    if (room) return { id, source: 'memory', file: null, online: online(room), state: JSON.parse(ctx.serialize(room)) };
    let text;
    try { text = fs.readFileSync(roomFile(id), 'utf8'); } catch (e) { return null; }
    const st = fs.statSync(roomFile(id));
    return { id, source: 'file', file: { size: st.size, saved: st.mtimeMs }, online: [], state: ctx.migrate(JSON.parse(text)) };
  }
  // Kľúče hráčov (z načítaných svetov) nahradí v celej odpovedi odtlačkom – aj za dvojbodkou v kľúčoch udalostí
  function redact(obj, keys) {
    let text = JSON.stringify(obj);
    for (const k of keys) {
      text = text.split(JSON.stringify(k)).join(JSON.stringify(keyId(k)));
      // aj v kľúčoch udalostí (move:<hráč>, pull:<hráč>, scavDone:<hráč>…)
      text = text.split(':' + JSON.stringify(k).slice(1)).join(':' + JSON.stringify(keyId(k)).slice(1));
    }
    return JSON.parse(text);
  }
  function roomSnapshot(id) {
    const r = loadState(id);
    if (!r) return null;
    return redact(Object.assign({}, r, { reconciler: reconcilerView(r.state) }), Object.keys(r.state.saves || {}));
  }

  // Rozšírenia API pre záložky: debug/api/<name>.js exportuje (query, tools) → objekt na odpoveď (null = 404).
  //   tools.load(id) → { id, source, file, online, state } kópia sveta (alebo null), tools.rooms() → zoznam svetov,
  //   tools.sim → špecifikácia simulácie. Kľúče hráčov z načítaných svetov sa z odpovede odstránia samy.
  function extension(res, name, query) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return notFound(res);
    const file = path.join(ctx.debugDir, 'api', name + '.js');
    if (!fs.existsSync(file)) return notFound(res);
    const keys = new Set();
    const tools = {
      ROOM_RE, rooms: listRooms, sim: ctx.sim && ctx.sim(),
      load: id => { const r = loadState(String(id || '')); if (r) for (const k of Object.keys(r.state.saves || {})) keys.add(k); return r; }
    };
    let body;
    try { body = require(file)(query, tools); } catch (e) { console.error('[debug]', name, e); return json(res, 500, { error: e.message }); }
    return body == null ? json(res, 404, { error: 'not found' }) : json(res, 200, redact(body, keys));
  }

  // Denník udalostí (journal.js): koniec súboru sveta, kľúče hráčov nahradené odtlačkom, až potom filtre
  // (filter kľúča teda píše odtlačok, ako ho stránka ukazuje). Najnovšie prvé.
  //   key  = presný kľúč alebo predpona s * na konci (move:*, spider:*), viac oddelených čiarkou; '-' = udalosti bez kľúča
  //   kind = add, replace, cancel, run, drop (čiarkou); type = typ udalosti (čiarkou); q = text kdekoľvek v zázname
  const KINDS = ['add', 'replace', 'cancel', 'run', 'drop'];
  const family = k => k == null ? '-' : k.includes(':') ? k.slice(0, k.indexOf(':') + 1) + '*' : k;
  async function journalView(id, query) {
    const r = loadState(id);
    const all = redact(await ctx.journal(id), r ? Object.keys(r.state.saves || {}) : []);
    const list = v => (query.get(v) || '').split(',').map(x => x.trim()).filter(Boolean);
    const keys = list('key'), kinds = list('kind'), types = list('type'), q = (query.get('q') || '').toLowerCase();
    const limit = Math.max(1, Math.min(2000, parseInt(query.get('limit'), 10) || 300));
    const keyOk = k => !keys.length || keys.some(f => f === '-' ? k == null : f.endsWith('*') ? k != null && k.startsWith(f.slice(0, -1)) : k === f);
    const count = (m, k, e) => { const c = m.get(k) || { n: 0, tick: 0 }; c.n++; c.tick = Math.max(c.tick, e.tick); m.set(k, c); };
    const fam = new Map(), byKey = new Map(), byKind = new Map(), byType = new Map(), hits = [];
    for (const e of all) {
      count(fam, family(e.key), e); if (e.key != null) count(byKey, e.key, e); count(byKind, e.kind, e); count(byType, e.type, e);
      if (keyOk(e.key) && (!kinds.length || kinds.includes(e.kind)) && (!types.length || types.includes(e.type)) && (!q || JSON.stringify(e).toLowerCase().includes(q))) hits.push(e);
    }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, n).map(([k, c]) => ({ k, n: c.n, tick: c.tick }));
    return {
      id, loaded: ctx.rooms.has(id), total: all.length, matched: hits.length, kinds: KINDS,
      from: all.length ? { tick: all[0].tick, ms: all[0].ms } : null, to: all.length ? { tick: all[all.length - 1].tick, ms: all[all.length - 1].ms } : null,
      facets: { family: top(fam, 60), key: top(byKey, 150), kind: top(byKind, 10), type: top(byType, 60) },
      entries: hits.slice(-limit).reverse()
    };
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
    if (url === '/api/debug/journal') {
      const id = query.get('id') || '';
      if (!ROOM_RE.test(id)) return json(res, 400, { error: 'bad room id' });
      if (!ctx.journal) return json(res, 404, { error: 'no journal' });
      journalView(id, query).then(body => json(res, 200, body), e => { console.error('[debug] journal', e); json(res, 500, { error: e.message }); });
      return true;
    }
    if (url.startsWith('/api/debug/')) return extension(res, url.slice(11), query);
    if (url === '/debug' || url === '/debug/') return serveFile(res, 'index.html');
    let rel;
    try { rel = decodeURIComponent(url.slice(7)); } catch (e) { return notFound(res); }
    return serveFile(res, rel);
  };
}

module.exports = { create, keyId };
