const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Debug = require('../debug.js');

const TOKEN = 'tajne-heslo-123';
const KEY = 'abc123hracov-kluc';

// Testovací server: ladiaca stránka nad dočasným priečinkom; čo nevybaví, je 404 (ako chýbajúci súbor v hre)
async function setup(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-debug-'));
  const dataDir = path.join(dir, 'data'), debugDir = path.join(dir, 'debug');
  fs.mkdirSync(dataDir); fs.mkdirSync(debugDir);
  fs.writeFileSync(path.join(debugDir, 'index.html'), '<h1>debug</h1>');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nie');
  const saved = JSON.stringify({ v: 1, tick: 100, saves: { [KEY]: { coins: 5 } }, contracts: { list: [{ by: KEY }] } });
  fs.writeFileSync(path.join(dataDir, 'room-stary.json'), saved);
  const rooms = new Map([['zivy', { tick: 7, state: { tick: 7, saves: { [KEY]: { coins: 9 } } }, players: new Map([[1, { name: 'Anka', area: 'hory', key: KEY }]]) }]]);
  const handle = Debug.create({ token, dataDir, debugDir, rooms, serialize: r => JSON.stringify(r.state), migrate: s => Object.assign({ migrated: true }, s) });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const get = (p, headers) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject));
  return { dir, dataDir, rooms, saved, get, close: () => srv.close() };
}

test('debug: bez DEBUG_TOKEN stránka neexistuje', async () => {
  const s = await setup('');
  try {
    for (const p of ['/debug', '/debug?key=' + TOKEN, '/api/debug/rooms']) assert.strictEqual((await s.get(p)).status, 404, p);
  } finally { s.close(); }
});

test('debug: bez cookie alebo so zlým kľúčom je všetko 404', async () => {
  const s = await setup(TOKEN);
  try {
    for (const p of ['/debug', '/debug/', '/debug/index.html', '/api/debug/rooms', '/api/debug/room?id=stary', '/debug?key=zle', '/debug?key=']) assert.strictEqual((await s.get(p)).status, 404, p);
    assert.strictEqual((await s.get('/api/debug/rooms', { cookie: 'mfdebug=' + TOKEN })).status, 404, 'token v cookie nestačí, musí tam byť odtlačok');
    assert.strictEqual((await s.get('/api/debug/rooms', { 'x-debug-token': 'zle' })).status, 404);
  } finally { s.close(); }
});

test('debug: /debug?key= nastaví cookie (HttpOnly, bez tokenu) a presmeruje', async () => {
  const s = await setup(TOKEN);
  try {
    const r = await s.get('/debug?key=' + TOKEN);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/debug');
    const c = r.headers['set-cookie'][0];
    assert.match(c, /^mfdebug=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
    assert.ok(!c.includes(TOKEN));
    const cookie = c.split(';')[0];
    const page = await s.get('/debug', { cookie });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.body, '<h1>debug</h1>');
    assert.strictEqual((await s.get('/debug/../secret.txt', { cookie })).status, 404);
    assert.strictEqual((await s.get('/debug/%2e%2e/secret.txt', { cookie })).status, 404);
    assert.strictEqual((await s.get('/api/debug/rooms', { 'x-debug-token': TOKEN })).status, 200, 'hlavička X-Debug-Token');
  } finally { s.close(); }
});

test('debug: zoznam svetov zo súborov aj z pamäte, kto je online', async () => {
  const s = await setup(TOKEN);
  try {
    const r = JSON.parse((await s.get('/api/debug/rooms', { 'x-debug-token': TOKEN })).body);
    const ids = r.rooms.map(x => x.id);
    assert.deepStrictEqual(ids, ['zivy', 'stary']);
    assert.deepStrictEqual(r.rooms[0].online, [{ name: 'Anka', area: 'hory', player: Debug.keyId(KEY) }]);
    assert.strictEqual(r.rooms[1].loaded, false);
    assert.strictEqual(r.rooms[1].size, s.saved.length);
  } finally { s.close(); }
});

test('debug: snímka sveta je len na čítanie a bez kľúčov hráčov', async () => {
  const s = await setup(TOKEN);
  const file = path.join(s.dataDir, 'room-stary.json'), before = fs.statSync(file).mtimeMs;
  try {
    const H = { 'x-debug-token': TOKEN };
    const f = await s.get('/api/debug/room?id=stary', H), snap = JSON.parse(f.body);
    assert.strictEqual(snap.source, 'file');
    assert.strictEqual(snap.state.migrated, true, 'uloženie zo súboru prejde migrate() na kópii');
    assert.ok(!f.body.includes(KEY), 'kľúč hráča nesmie byť vo výstupe');
    assert.deepStrictEqual(Object.keys(snap.state.saves), [Debug.keyId(KEY)]);
    assert.strictEqual(snap.state.contracts.list[0].by, Debug.keyId(KEY));
    const m = await s.get('/api/debug/room?id=zivy', H);
    assert.strictEqual(JSON.parse(m.body).source, 'memory');
    assert.ok(!m.body.includes(KEY));
    // neexistujúci svet sa nevytvorí, zlé meno sa ani neskúša
    assert.strictEqual((await s.get('/api/debug/room?id=novy', H)).status, 404);
    assert.strictEqual((await s.get('/api/debug/room?id=../stary', H)).status, 400);
    assert.deepStrictEqual(fs.readdirSync(s.dataDir), ['room-stary.json']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), s.saved);
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
    assert.deepStrictEqual([...s.rooms.keys()], ['zivy'], 'svet zo súboru sa nenačíta do servera');
  } finally { s.close(); }
});
