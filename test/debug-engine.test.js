// Ladiaca stránka (#106): záložka Engine – kruhová pamäť dávok, časová os, dávka do hĺbky (kolá, vinníci, skupiny,
// zmeny pred / po), fronta s pôvodom, odstránenie kľúčov hráčov a server (filter správ, dobiehanie po načítaní).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../src/shared/data.ts');
const E = require('../src/server/engine.ts');
const Econ = require('../src/server/economy.js');
const Events = require('../src/server/events.js');
const Actions = require('../src/server/actions.js');
const Ice = require('../src/server/ice.ts');
const Debug = require('../src/server/debug.js');
const api = require('../debug/api/engine.js');
const TPD = D.TICKS_PER_DAY;
const json = v => JSON.stringify(v);
const SP = Econ.PLANTABLE.find(k => !D.SPECIES[k].strict), SP2 = Econ.PLANTABLE.filter(k => !D.SPECIES[k].strict)[1];

// Svet ako na serveri (ako v actions.test.js): ana a bob pri domčeku
function makeWorld(seed) {
  const w = {
    tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'ladenie-' + seed, step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: true, ice: 0 }, up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  };
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = { coins: 500, water: 5, inv: { hoe: 1, can: 1 }, fb: {}, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 1 }, area: 'garden' };
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', x: Actions.HOUSE.x, y: Actions.HOUSE.y, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', x: Actions.HOUSE.x + 1, y: Actions.HOUSE.y, scav: null }];
  return w;
}
// Špecifikácia ako na serveri: po každej dávke záznam do kruhovej pamäte (s časmi častí z hodín)
function traced(w, max) {
  w.trace = Debug.traceRing(max || 600);
  let t = 0;
  return {
    proposers: Object.assign({}, Events.PROPOSERS, Actions.PROPOSERS), periodic: Events.PERIODIC, presence: x => x.presence, clock: () => (t += 0.25),
    onBatch: (x, out) => Debug.traceBatch(x.trace, out, { source: x.source || 'live', timing: out.timing }),
    onError(err) { throw err; }
  };
}
let seq = 0;
const act = (type, key, data) => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
const tools = w => ({ ROOM_RE: /^[a-z0-9-]{1,16}$/, trace: () => ({ max: w.trace.max, n: w.trace.n, records: Debug.traceList(w.trace), origins: w.trace.origins }), load: () => ({ state: JSON.parse(json(Object.assign({}, w, { trace: undefined }))) }) });
const get = (w, params) => api(new URLSearchParams(Object.assign({ room: 'x' }, params)), tools(w));

test('kruhová pamäť: nikdy nepresiahne N, drží posledných N v poradí, počíta prepísané', () => {
  const ring = Debug.traceRing(5);
  for (let i = 0; i < 3; i++) Debug.traceFilter(ring, 10 + i, [{ what: 'dropped' }]);
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.n), [1, 2, 3]);
  for (let i = 3; i < 23; i++) { Debug.traceFilter(ring, 10 + i, []); assert.ok(ring.buf.length <= 5); }
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.n), [19, 20, 21, 22, 23]);
  assert.deepStrictEqual(Debug.traceList(ring).map(r => r.tick), [28, 29, 30, 31, 32]);
  const w = { trace: ring, events: [], tick: 0 };
  const j = get(w, {});
  assert.deepStrictEqual([j.max, j.total, j.kept, j.overwritten], [5, 23, 5, 18]);
  // 30 dní dobiehania: pamäť ostane na N
  const w2 = makeWorld(1), spec = traced(w2, 50);
  E.advanceTo(w2, w2.tick + 30 * TPD, spec);
  assert.ok(w2.trace.n > 700, String(w2.trace.n));
  assert.strictEqual(Debug.traceList(w2.trace).length, 50);
  assert.ok(w2.trace.buf.length === 50);
});

test('dávka: dve kúpy posledného semienka – poradie, odloženie s vinníkom a kľúčom, odmietnutie, skupiny, zmeny pred / po', () => {
  const w = makeWorld(2), spec = traced(w);
  w.market.seeds[SP].stock = 1; w.market.seeds[SP2].stock = 5;
  const a = act('buy', 'ana', { id: 'seed_' + SP, n: 1 }), b = act('buy', 'bob', { id: 'seed_' + SP2, n: 2 }), c = act('buy', 'bob', { id: 'seed_' + SP, n: 1 });
  E.commitBatch(w, [a, b, c], spec);
  const list = get(w, {});
  assert.strictEqual(list.rows.length, 1);
  const row = list.rows[0];
  assert.deepStrictEqual([row.kind, row.inputs, row.requests, row.events, row.proposals, row.applied, row.held, row.rejected, row.rounds], ['actions', 3, 3, 0, 4, 2, 1, 1, 2]);
  assert.ok(row.timing.evaluate > 0 && row.timing.resolve > 0 && row.timing.commit > 0, 'časy častí z hodín');
  const d = get(w, { n: row.n });
  assert.deepStrictEqual(d.inputs.map(i => [i.pos, i.id, i.stage, i.actor.kind, i.actor.key, i.actor.name]), [[1, a.id, 'act', 'player', 'ana', 'Ana'], [2, b.id, 'act', 'player', 'bob', 'Bob'], [3, c.id, 'act', 'player', 'bob', 'Bob']]);
  assert.strictEqual(d.rounds.length, 2);
  const [r1, r2] = d.rounds;
  assert.deepStrictEqual(r1.proposals.map(p => [p.id, p.outcome]), [[a.id, 'applied'], [b.id, 'applied'], [c.id, 'held']]);
  // vinníci: ana už kúpila to isté semienko, bob už zapísal svoje vlastné uloženie
  assert.deepStrictEqual(r1.proposals[2].blockedBy, [{ id: a.id, type: 'buy', keys: ['market:seed_' + SP] }, { id: b.id, type: 'buy', keys: ['save:bob'] }]);
  assert.deepStrictEqual(r1.groups.shared, [[a.id, b.id, c.id]], 'riešili sa spolu cez spoločné kľúče');
  assert.deepStrictEqual(r1.groups.independent, []);
  assert.deepStrictEqual(api.groupsOf([{ id: 'x', writes: ['save:ana'] }, { id: 'y', writes: ['save:bob'] }, { id: 'z', reads: ['save:*'], writes: [] }]), { shared: [['x', 'y', 'z']], independent: [] });
  assert.deepStrictEqual(api.groupsOf([{ id: 'x', writes: ['save:ana'] }, { id: 'y', writes: ['save:bob'] }]), { shared: [], independent: ['x', 'y'] });
  assert.deepStrictEqual(r2.proposals.map(p => [p.id, p.outcome, p.msg]), [[c.id, 'rejected', 'Vypredané. Veľkoobchodník príde o pár dní.']]);
  assert.deepStrictEqual([r1.step, r2.step, r2.proposals[0].rng], [0, 1, { step: 1, id: c.id }], 'náhoda: len krok a id, nikdy semienko');
  const stock = d.changes.find(x => x.key === 'market:seed_' + SP);
  assert.deepStrictEqual(stock.writes.map(x => x.id), [a.id]);
  assert.deepStrictEqual(stock.writes[0].leaves.find(l => l.p[0] === 'stock'), { p: ['stock'], from: 1, to: 0 });
  assert.deepStrictEqual(stock.contenders.map(x => [x.id, x.round, x.outcome]), [[c.id, 1, 'held'], [c.id, 2, 'rejected']]);
  assert.strictEqual(d.changes[0].key, 'market:seed_' + SP, 'kľúče, o ktoré sa súperilo, idú prvé');
  assert.ok(d.changes.some(x => x.key === 'save:ana' && x.writes[0].leaves.some(l => l.p.join('.') === 'coins')));
  assert.ok(!JSON.stringify(d).includes(w.seed), 'semienko sveta sa nikdy neukáže');
});

test('políčko a zákazka: dvaja trhajú ten istý kvet, dvaja berú tú istú zákazku – víťaz, odmietnutý a jeho dôvod', () => {
  const w = makeWorld(3), spec = traced(w);
  const ti = w.tiles.map((t, i) => i).filter(i => D.TILLABLE[w.tiles[i].g] && w.tiles[i].g !== 'ring');
  w.tiles[ti[0]].s = { k: D.TILLABLE[w.tiles[ti[0]].g], w: 1, r: 0, o: 'ana', p: { sp: SP, prog: D.SPECIES[SP].days, q: 3, dry: 0 } };
  const c = w.contracts.list.find(x => !x.takenBy);
  const p1 = act('pick', 'bob', { i: ti[0] }), p2 = act('pick', 'ana', { i: ti[0] }), k1 = act('ctake', 'ana', { id: c.id }), k2 = act('ctake', 'bob', { id: c.id });
  E.commitBatch(w, [p1, p2, k1, k2], spec);
  const d = get(w, { n: w.trace.n });
  const tile = d.changes.find(x => x.key === 'tile:garden:' + ti[0]);
  assert.deepStrictEqual(tile.writes.map(x => x.id), [p1.id]);
  assert.deepStrictEqual(tile.contenders.filter(x => x.outcome === 'rejected').map(x => [x.id, x.msg]), [[p2.id, 'Tu nič nekvitne.']]);
  const board = d.changes.find(x => x.key === 'contracts');
  assert.deepStrictEqual(board.writes.map(x => x.id), [k1.id]);
  assert.deepStrictEqual(board.contenders.filter(x => x.outcome === 'rejected').map(x => x.msg), ['Túto zákazku už niekto zobral.']);
  const held = d.rounds[0].proposals.filter(p => p.outcome === 'held');
  assert.deepStrictEqual(held.map(p => [p.id, p.blockedBy.map(b => b.id)]), [[p2.id, [p1.id]], [k2.id, [p1.id, k1.id]]], 'bob už zapísal svoje uloženie, ana zákazku');
});

test('časová os: udalosti aj akcie, prázdne kroky zbalené, zdroj (dobiehanie, pretočenie noci), fronta s pôvodom a náhodou', () => {
  const w = makeWorld(4), spec = traced(w);
  const ti = w.tiles.map((t, i) => i).filter(i => w.tiles[i].g === 'grass' && !w.tiles[i].s);
  w.source = 'catchup';
  E.advanceTo(w, w.tick + 2 * TPD, spec);
  w.source = 'ff';
  E.advanceTo(w, w.tick + 600, spec);
  w.source = 'frame';
  w.presence[0].x = ti[0] % D.W + 0.5; w.presence[0].y = Math.floor(ti[0] / D.W) + 0.5;
  const s = act('scavStart', 'ana', { i: ti[0] });
  E.commitBatch(w, [s], spec);
  const list = get(w, {});
  const rows = list.rows.filter(r => !r.gap), gaps = list.rows.filter(r => r.gap);
  assert.strictEqual(rows[0].kind, 'actions', 'najnovšia hore');
  assert.ok(rows.some(r => r.source === 'catchup' && r.kind === 'events' && r.types.includes('dawn')));
  assert.ok(rows.some(r => r.source === 'ff'));
  assert.ok(gaps.length && gaps.every(g => g.gap > 0 && g.to - g.from + 1 === g.gap));
  // medzera = presne kroky medzi susednými riadkami
  for (let i = 1; i < list.rows.length - 1; i++) if (list.rows[i].gap) assert.strictEqual(list.rows[i - 1].tick - list.rows[i + 1].tick - 1, list.rows[i].gap);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].tick >= r.tick));
  // udalosť z fronty: aktér plánovač / NPC, fáza world, id ev#<seq>
  const ev = get(w, { n: rows.find(r => r.types.includes('dawn')).n });
  assert.ok(ev.inputs.every(i => i.stage === 'world' && /^ev#\d+$/.test(i.id) && i.ev));
  assert.strictEqual(ev.inputs.find(i => i.kind === 'dawn').actor.kind, 'scheduler');
  // scavStart naplánoval scavDone: fronta vie, ktorý návrh, v ktorom kroku a z čoho bude náhoda
  const det = get(w, { n: rows[0].n });
  assert.deepStrictEqual(det.rounds[0].proposals[0].ops.map(o => [o.op, o.type, o.key]), [['cancel', undefined, 'scavDone:ana'], ['insert', 'scavDone', 'scavDone:ana']], 'scheduleUnique = zruš + naplánuj');
  const q = get(w, { view: 'queue' });
  const done = q.queue.find(e => e.type === 'scavDone');
  assert.deepStrictEqual([done.origin.kind, done.origin.by, done.origin.tick, done.rng], ['proposal', s.id, w.tick, 'ev#' + done.seq]);
  assert.ok(q.queue.filter(e => e.kind === 'periodic').every(e => e.origin.kind === 'reconciler'));
  assert.ok(q.queue.every((e, i) => i === 0 || q.queue[i - 1].at <= e.at));
});

test('kľúče hráčov: odtlačok v celej odpovedi – actor, data.key, save:/pos:/event: kľúče, cesty zmien, správy, prítomnosť, filter', async () => {
  const w = makeWorld(5), spec = traced(w);
  Object.assign(w.saves.ana, { x: 10.5, y: 10.5 });
  const ti = w.tiles.map((t, i) => i).filter(i => w.tiles[i].g === 'grass' && !w.tiles[i].s);
  w.presence[0].x = ti[0] % D.W + 0.5; w.presence[0].y = Math.floor(ti[0] / D.W) + 0.5;
  E.commitBatch(w, [act('scavStart', 'ana', { i: ti[0] }), act('buy', 'bob', { id: 'seed_' + SP, n: 1 }), act('gift', 'bob', { to: 'ana', item: 'seed_' + SP })], spec);
  E.advanceTo(w, w.tick + TPD, spec); // dawn mení save:* (cesty zmien začínajú kľúčom hráča)
  Debug.traceFilter(w.trace, w.tick, [{ seq: 4, actor: 'ana', t: 'act', what: 'deferred', rule: 'one tile action per player per frame' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-engine-'));
  const room = Object.assign(w, { players: new Map([[1, { key: 'ana', name: 'Ana', area: 'garden' }]]) });
  const handle = Debug.create({ dataDir: dir, debugDir: path.join(__dirname, '..', 'debug'), rooms: new Map([['ladenie', room]]), serialize: r => json(Object.assign({}, r, { trace: undefined, players: undefined })), migrate: s => s, sim: () => spec });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const fetchJ = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  try {
    const leak = /(^|[:"\s#])(ana|bob)(?=$|[:"\s,.])/;
    const list = await fetchJ('/api/debug/engine?room=ladenie');
    assert.strictEqual(list.status, 200);
    const rows = JSON.parse(list.body).rows.filter(r => !r.gap);
    for (const r of rows) {
      const d = await fetchJ('/api/debug/engine?room=ladenie&n=' + r.n);
      assert.strictEqual(d.status, 200);
      assert.ok(!leak.test(d.body), `kľúč hráča v dávke #${r.n}: ${(d.body.match(new RegExp('.{40}' + leak.source + '.{40}')) || [])[0]}`);
      assert.ok(!d.body.includes(w.seed));
    }
    const all = (await Promise.all(rows.map(r => fetchJ('/api/debug/engine?room=ladenie&n=' + r.n)))).map(x => x.body).join('');
    assert.ok(all.includes('save:' + Debug.keyId('ana')) && all.includes('save:' + Debug.keyId('bob')), 'kľúče výrezov');
    assert.ok(all.includes('event:scavDone:' + Debug.keyId('ana')), 'kľúč vo vnútri kľúča udalosti');
    assert.ok(all.includes('"Ana"'), 'meno ostáva (je verejné ako v zozname online)');
    const q = await fetchJ('/api/debug/engine?room=ladenie&view=queue');
    assert.ok(!leak.test(q.body) && JSON.parse(q.body).queue.length);
    assert.strictEqual((await fetchJ('/api/debug/engine?room=nikto')).body, json({ room: 'nikto', loaded: false, rows: [] }));
  } finally { srv.close(); }
});

// ---- server ----
function freePort() { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); }); }
function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000', DEBUG_TRACE: '300' }), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.stderr.on('data', d => process.stderr.write(String(d)));
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
function client(port, room, name) {
  const ws = new WebSocket('ws://127.0.0.1:' + port), got = [], waiters = [];
  ws.on('message', raw => { const m = JSON.parse(raw); got.push(m); for (const wt of waiters.slice()) if (wt.pred(m)) { waiters.splice(waiters.indexOf(wt), 1); wt.res(m); } });
  const wait = (pred, ms) => new Promise((res, rej) => { const f = got.find(pred); if (f) return res(f); const t = setTimeout(() => rej(new Error('nedošlo: ' + pred)), ms || 3000); waiters.push({ pred, res: m => { clearTimeout(t); res(m); } }); });
  return new Promise(r => ws.on('open', async () => { ws.send(json({ t: 'join', room, name })); await wait(m => m.t === 'welcome'); r({ ws, got, wait, send: m => ws.send(json(m)) }); }));
}
const httpJ = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));

test('server: dobiehanie po načítaní je v pamäti, filter správ (odložená druhá akcia, zlúčené pohyby) a súboj o políčko sú vidieť', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-srv-'));
  const port = await freePort();
  const w = makeWorld(6);
  delete w.presence;
  const ti = w.tiles.map((t, i) => i).filter(i => D.TILLABLE[w.tiles[i].g] && w.tiles[i].g !== 'ring');
  const px = ti[0] % D.W + 1.5, py = Math.floor(ti[0] / D.W) + 0.5;
  for (const k of ['ana', 'bob']) Object.assign(w.saves[k], { x: px, y: py, area: 'garden', look: { shirt: '#000', hair: '#000', hat: false }, talked: true });
  w.saves.ana.inv['seed_' + SP] = 2;
  // svet beží a server bol pol dňa vypnutý: načítanie dobehne čas (DAY_SECONDS je veľký – wall posunieme o pol dňa podľa uloženej dĺžky)
  const save = Object.assign(JSON.parse(json(w)), { v: 9, mode: 'running', daySeconds: 100000, wall: Date.now() - 0.5 * 100000 * 1000, tiles: w.tiles.map(t => ({ s: t.s })), hory: Ice.saveHory(w.hory), les: null, pomedzieSeed: 1, lesSeed: 1 });
  fs.writeFileSync(path.join(dir, 'room-ladenie.json'), json(save));
  const proc = await startServer(dir, port);
  let ana, bob;
  try {
    ana = await client(port, 'ladenie', 'Ana'); bob = await client(port, 'ladenie', 'Bob');
    const x = ti[0] % D.W, y = Math.floor(ti[0] / D.W);
    ana.send({ t: 'act', x, y, item: 'hoe' }); bob.send({ t: 'act', x, y, item: 'hoe' });
    await (await ana.wait(m => m.t === 'tile' && m.i === ti[0] && m.v.s) && Promise.race([ana.wait(m => m.t === 'toast' && m.text === 'Tu už je záhon.'), bob.wait(m => m.t === 'toast' && m.text === 'Tu už je záhon.')]));
    // dve akcie na políčku od jednej hráčky v jednom rámci + dva pohyby: druhá akcia počká, starší pohyb sa zlúči
    // (dávka správ naraz, aby aspoň dve padli do jedného rámca aj na vyťaženom stroji)
    for (let i = 0; i < 6; i++) ana.send({ t: 'move', x: px, y: py + i * 0.01, dir: 0, ar: 0 });
    ana.send({ t: 'act', x, y, item: 'seed_' + SP }); ana.send({ t: 'act', x, y, item: 'can' }); ana.send({ t: 'act', x, y, item: 'can' });
    await ana.wait(m => m.t === 'tile' && m.i === ti[0] && m.v.s.p && m.v.s.w === 1);
    const list = await httpJ(port, '/api/debug/engine?room=ladenie');
    assert.ok(list.loaded && list.kept <= 300);
    const rows = list.rows.filter(r => !r.gap);
    assert.ok(rows.some(r => r.source === 'catchup' && r.kind === 'events'), 'dávky z dobiehania');
    const clash = rows.find(r => r.source === 'frame' && r.held === 1 && r.rejected === 1 && r.types.includes('till'));
    assert.ok(clash, 'súboj o políčko');
    const d = await httpJ(port, '/api/debug/engine?room=ladenie&n=' + clash.n);
    const till = d.rounds[1].proposals[0];
    assert.deepStrictEqual([till.type, till.outcome, till.msg], ['till', 'rejected', 'Tu už je záhon.']);
    assert.ok(d.row.timing.filter >= 0 && d.row.timing.evaluate >= 0 && d.row.timing.notify >= 0 && d.row.timing.journal >= 0);
    let deferred = null, coalesced = null;
    for (const r of rows.filter(x => x.source === 'frame')) {
      const dd = await httpJ(port, '/api/debug/engine?room=ladenie&n=' + r.n);
      deferred = deferred || dd.filter.find(f => f.what === 'deferred' && f.t === 'act');
      coalesced = coalesced || dd.filter.find(f => f.what === 'coalesced' && f.t === 'move');
    }
    assert.ok(deferred, 'odložená akcia na políčku');
    assert.ok(coalesced, 'zlúčený pohyb');
    assert.match(deferred.rule, /one tile action per player per frame/);
    assert.strictEqual(deferred.actor.key, Debug.keyId('ana'));
    assert.match(coalesced.rule, /latest move/);
    // ten istý súboj v denníku na disku (záložka Journal), kľúče hráčov odstránené
    const httpRaw = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }).on('error', reject));
    const leak = /(^|[:"\s#])(ana|bob)(?=$|[:"\s,.])/;
    const jl = await httpRaw('/api/debug/journal?room=ladenie&type=till');
    assert.ok(!leak.test(jl), jl.slice(0, 300));
    const jt = JSON.parse(jl);
    assert.ok(jt.rows.length && jt.players.some(p => p.id === Debug.keyId('ana') && p.name === 'Ana'), json(jt.players));
    const one = await httpRaw('/api/debug/journal?room=ladenie&g=' + jt.rows.find(r => r.rejected).g);
    assert.ok(!leak.test(one));
    assert.ok(JSON.parse(one).rounds[1].proposals.some(p => p.msg === 'Tu už je záhon.'));
    assert.ok(JSON.parse(await httpRaw('/api/debug/journal?room=ladenie&kind=load')).matched >= 1);
  } finally {
    for (const c of [ana, bob]) if (c) c.ws.close();
    await stopServer(proc);
  }
});

// ---- záložka Journal: denník na disku ----
const journalApi = require('../debug/api/journal.js');

test('denník: riadky od najnovšieho, filtre (druh, typ, hráč odtlačkom, osud, kľúč, kroky, pohyby), strany, dočítanie a otočenie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dbg-journal-'));
  const file = path.join(dir, 'journal-x.jsonl');
  const w = makeWorld(7);
  w.market.seeds[SP].stock = 1;
  const spec = Object.assign(traced(w), { onBatch: (x, out) => fs.appendFileSync(file, json(Object.assign({ wall: 1700000000000 }, out.entry)) + '\n') });
  fs.writeFileSync(file, json({ wall: 1700000000000, load: true, tick: w.tick, step: 0, seq: 0, migratedFrom: null }) + '\n');
  E.commitBatch(w, [act('pos', 'ana', { x: 10.5, y: 10.5 })], spec);
  E.commitBatch(w, [act('buy', 'ana', { id: 'seed_' + SP, n: 1 }), act('buy', 'bob', { id: 'seed_' + SP, n: 1 })], spec);
  E.advanceTo(w, w.tick + TPD, spec);
  const keys = new Set();
  const tl = { ROOM_RE: /^[a-z0-9-]{1,16}$/, journalFiles: () => [file + '.1', file].filter(f => fs.existsSync(f)).map(f => ({ path: f, name: path.basename(f) })), load: () => ({ state: { saves: { ana: {}, bob: {} } } }), redactKeys: l => l.forEach(k => keys.add(k)) };
  const q = p => journalApi(new URLSearchParams(Object.assign({ room: 'x' }, p)), tl);
  const all = q({});
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  assert.strictEqual(all.total, lines);
  assert.ok(all.rows.every((r, i) => i === 0 || all.rows[i - 1].g > r.g), 'od najnovšieho');
  assert.strictEqual(all.rows[all.rows.length - 1].kind, 'load');
  assert.deepStrictEqual([...keys].sort(), ['ana', 'bob'], 'kľúče hráčov idú na odstránenie');
  assert.ok(all.types.includes('dawn') && all.types.includes('buy'));
  assert.strictEqual(q({ kind: 'load' }).matched, 1);
  assert.ok(q({ kind: 'events' }).rows.every(r => r.kind === 'events'));
  const buys = q({ type: 'buy' });
  assert.strictEqual(buys.matched, 1);
  assert.deepStrictEqual([buys.rows[0].applied, buys.rows[0].held, buys.rows[0].rejected], [1, 1, 1]);
  assert.strictEqual(q({ outcome: 'held' }).rows.filter(r => r.types.includes('buy')).length, 1);
  assert.strictEqual(q({ actor: Debug.keyId('bob') }).matched, 1, 'hráč podľa odtlačku');
  assert.strictEqual(q({ actor: 'Ana' }).matched, 2, 'alebo podľa mena');
  assert.strictEqual(q({ key: 'save:' + Debug.keyId('bob') }).matched, 1, 'kľúč s odtlačkom hráča');
  assert.strictEqual(q({ moves: '0', kind: 'actions' }).matched, 1, 'samotný pohyb bez sporu sa dá skryť');
  const dawnTick = q({ type: 'dawn' }).rows[0].tick;
  assert.ok(q({ from: dawnTick, to: dawnTick }).rows.every(r => r.tick === dawnTick));
  // vylúčenie typu, viac osudov naraz, voľný text bez diakritiky, počty pre čipy
  assert.ok(q({ type: '-pos,-dawn' }).rows.every(r => !r.types.includes('pos') && !r.types.includes('dawn')));
  assert.ok(q({ type: '-pos' }).rows.some(r => r.kind === 'load'), 'vylúčenie nechá aj značky načítania');
  assert.strictEqual(q({ type: 'buy,pos' }).matched, 2);
  assert.strictEqual(q({ outcome: 'rejected,error' }).rows.filter(r => r.types.includes('buy')).length, 1);
  assert.strictEqual(q({ q: 'vypredane' }).matched, 1, 'hlásenie odmietnutia, bez diakritiky');
  assert.strictEqual(q({ q: 'VYPREDANÉ seed_' + SP }).matched, 1, 'všetky slová');
  assert.strictEqual(q({ q: 'vypredane dawn' }).matched, 0);
  assert.strictEqual(q({ q: 'save:' + Debug.keyId('bob') }).matched, 1, 'odtlačok hráča aj v texte');
  const f = q({ type: 'buy' }).facets;
  assert.strictEqual(f.type.buy, 1);
  assert.ok(f.type.dawn >= 1, 'počet typu ráta s ostatnými filtrami, nie so samotným filtrom typu');
  assert.deepStrictEqual([f.actor.ana, f.actor.bob], [1, 1]);
  assert.strictEqual(f.outcome.held, 1);
  assert.deepStrictEqual(q({ outcome: 'held' }).facets.kind.actions, 1);
  assert.strictEqual(q({ moves: '0' }).rows.filter(r => r.types.length === 1 && r.types[0] === 'pos').length, 0);
  // strany: limit + kurzor
  const p1 = q({ limit: 5 }), p2 = q({ limit: 5, before: p1.next });
  assert.strictEqual(p1.rows.length, 5);
  assert.strictEqual(p2.rows[0].g, p1.rows[4].g - 1);
  // jeden záznam: rozobraný ako v záložke Engine
  const d = q({ g: buys.rows[0].g });
  assert.deepStrictEqual(d.rounds.map(r => r.proposals.map(p => p.outcome)), [['applied', 'held'], ['rejected']]);
  assert.strictEqual(d.row.source, 'journal');
  assert.ok(q({ g: all.rows[all.rows.length - 1].g }).load.load);
  // dočítanie: pribudne riadok (aj neúplný koniec počká), potom otočenie na .1
  const before = q({}).total;
  fs.appendFileSync(file, json({ wall: 1, load: true, tick: w.tick, step: w.step, seq: w.seq }) + '\n{"wall":2,"load":tr');
  assert.strictEqual(q({}).total, before + 1);
  fs.appendFileSync(file, 'ue,"tick":5}\n');
  assert.strictEqual(q({}).total, before + 2);
  fs.renameSync(file, file + '.1');
  fs.writeFileSync(file, json({ wall: 3, load: true, tick: 9, step: 0, seq: 0 }) + '\n');
  const rot = q({});
  assert.strictEqual(rot.total, before + 3);
  assert.deepStrictEqual(rot.files.map(f => f.name), ['journal-x.jsonl.1', 'journal-x.jsonl']);
  assert.strictEqual(rot.rows[0].tick, 9);
});
