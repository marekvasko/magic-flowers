import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import * as Debug from '../src/server/debug.ts';
import type { GameProposer, GameSpec } from '../src/server/game.ts';
import { must, parseJson, partial, portOf } from './helpers.ts';

const KEY = 'abc123hracov-kluc';

// Testovací server: ladiaca stránka nad dočasným priečinkom; čo nevybaví, je 404 (ako chýbajúci súbor v hre)
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-debug-'));
  const dataDir = path.join(dir, 'data'), debugDir = path.join(dir, 'debug');
  fs.mkdirSync(dataDir); fs.mkdirSync(debugDir);
  fs.writeFileSync(path.join(debugDir, 'index.html'), '<h1>debug</h1>');
  fs.mkdirSync(path.join(debugDir, 'api'));
  // rozšírenie API: vráti kľúče a mince zo sveta – kľúč sa z odpovede musí stratiť sám
  fs.writeFileSync(path.join(debugDir, 'api', 'coins.js'), `module.exports = (q, t) => { const r = t.load(q.get('id')); if (!r) return null; r.state.saves = {}; return { source: r.source, coins: Object.entries(JSON.parse(JSON.stringify(t.load(q.get('id')).state.saves))).map(([k, v]) => [k, v.coins]) }; };`);
  fs.writeFileSync(path.join(debugDir, 'api', 'boom.js'), 'module.exports = () => { throw new Error("bum"); };');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nie');
  const saved = JSON.stringify({ v: 1, tick: 100, rng: 1, events: [{ at: 150, seq: 1, type: 'stary', data: null }, { at: 130, seq: 2, type: 'dawn', data: null, key: 'dawn', periodic: true }], saves: { [KEY]: { coins: 5 } }, contracts: { list: [{ by: KEY }] } });
  fs.writeFileSync(path.join(dataDir, 'room-stary.json'), saved);
  type Room = Debug.DebugRoom & { state: { tick: number; saves: Partial<Record<string, { coins: number }>> } };
  const rooms = new Map<string, Room>([['zivy', { tick: 7, state: { tick: 7, saves: { [KEY]: { coins: 9 } } }, players: new Map([[1, { name: 'Anka', area: 'hory', key: KEY }]]) }]]);
  const sim: GameSpec = { proposers: { dawn: partial<GameProposer<unknown>>({}), hourly: partial<GameProposer<unknown>>({}) }, periodic: [{ key: 'dawn', type: 'dawn', next: from => from + 50 }, { key: 'hourly', type: 'hourly', next: from => from + 12 }] };
  const handle = Debug.create({ dataDir, debugDir, rooms, serialize: r => JSON.stringify(r.state), migrate: s => Object.assign({ migrated: true }, s), sim: () => sim });
  const srv = http.createServer((req, res) => { if (!handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  type Reply = { status: number | undefined; headers: IncomingHttpHeaders; body: string };
  const request = (method: string, p: string): Promise<Reply> => new Promise((resolve, reject) => http.request({ host: '127.0.0.1', port: portOf(srv), path: p, method }, res => {
    let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); }); res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body }); });
  }).on('error', reject).end());
  return { dir, dataDir, rooms, saved, handle, request, get: (p: string) => request('GET', p), close: () => srv.close() };
}

test('debug: stránka je prístupná priamo, ale len na čítanie a len zo svojho priečinka', async () => {
  const s = await setup();
  try {
    for (const p of ['/debug', '/debug/', '/debug/index.html']) {
      const r = await s.get(p);
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.body, '<h1>debug</h1>');
    }
    assert.strictEqual((await s.get('/api/debug/rooms')).status, 200);
    assert.strictEqual((await s.get('/debug/../secret.txt')).status, 404);
    assert.strictEqual((await s.get('/debug/%2e%2e/secret.txt')).status, 404);
    assert.strictEqual((await s.get('/api/debug/nic')).status, 404);
    assert.strictEqual((await s.request('POST', '/api/debug/room?id=stary')).status, 404, 'nič sa nedá poslať ani zmeniť');
    assert.strictEqual(s.handle(partial<IncomingMessage>({ url: '/index.html', method: 'GET', headers: {} }), partial<ServerResponse>({})), false, 'hru nechá na server');
  } finally { s.close(); }
});

test('debug: zoznam svetov zo súborov aj z pamäte, kto je online', async () => {
  const s = await setup();
  try {
    const r = parseJson<{ rooms: Debug.RoomInfo[] }>((await s.get('/api/debug/rooms')).body);
    const ids = r.rooms.map(x => x.id);
    assert.deepStrictEqual(ids, ['zivy', 'stary']);
    assert.deepStrictEqual(must(r.rooms[0]).online, [{ name: 'Anka', area: 'hory', player: Debug.keyId(KEY) }]);
    assert.strictEqual(must(r.rooms[1]).loaded, false);
    assert.strictEqual(must(r.rooms[1]).size, s.saved.length);
  } finally { s.close(); }
});

test('debug: snímka sveta je len na čítanie a bez kľúčov hráčov', async () => {
  const s = await setup();
  const file = path.join(s.dataDir, 'room-stary.json'), before = fs.statSync(file).mtimeMs;
  try {
    const f = await s.get('/api/debug/room?id=stary');
    const snap = parseJson<{ source: string; state: { migrated: boolean; saves: Partial<Record<string, { coins: number }>>; contracts: { list: { by: string }[] } } }>(f.body);
    assert.strictEqual(snap.source, 'file');
    assert.strictEqual(snap.state.migrated, true, 'uloženie zo súboru prejde migrate() na kópii');
    assert.ok(!f.body.includes(KEY), 'kľúč hráča nesmie byť vo výstupe');
    assert.deepStrictEqual(Object.keys(snap.state.saves), [Debug.keyId(KEY)]);
    assert.strictEqual(must(snap.state.contracts.list[0]).by, Debug.keyId(KEY));
    const m = await s.get('/api/debug/room?id=zivy');
    assert.strictEqual(parseJson<{ source: string }>(m.body).source, 'memory');
    assert.ok(!m.body.includes(KEY));
    // neexistujúci svet sa nevytvorí, zlé meno sa ani neskúša
    assert.strictEqual((await s.get('/api/debug/room?id=novy')).status, 404);
    assert.strictEqual((await s.get('/api/debug/room?id=../stary')).status, 400);
    assert.deepStrictEqual(fs.readdirSync(s.dataDir), ['room-stary.json']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), s.saved);
    assert.strictEqual(fs.statSync(file).mtimeMs, before);
    assert.deepStrictEqual([...s.rooms.keys()], ['zivy'], 'svet zo súboru sa nenačíta do servera');
  } finally { s.close(); }
});

test('debug: stav reconcilera – naplánované, chýbajúce a zahodené udalosti (svet sa nezmení)', async () => {
  const s = await setup();
  try {
    type Reconciler = { declared: number; proposers: number; counts: Record<'periodic' | 'unique' | 'plain', number>; periodic: { key: string; type: string; status: string; at: number | null }[]; drop: { key: string | null; type: string; at: number; why: string }[] };
    const r = parseJson<{ reconciler: Reconciler }>((await s.get('/api/debug/room?id=stary')).body).reconciler;
    assert.deepStrictEqual([r.declared, r.proposers], [2, 2]);
    assert.deepStrictEqual(r.counts, { periodic: 1, unique: 0, plain: 1 });
    assert.deepStrictEqual(r.periodic, [
      { key: 'hourly', type: 'hourly', status: 'missing', at: 113 },
      { key: 'dawn', type: 'dawn', status: 'scheduled', at: 130 }
    ]);
    assert.deepStrictEqual(r.drop, [{ key: null, type: 'stary', at: 150, why: 'unknown type (no proposer)' }]);
    assert.strictEqual(fs.readFileSync(path.join(s.dataDir, 'room-stary.json'), 'utf8'), s.saved);
  } finally { s.close(); }
});

test('debug: rozšírenia API z debug/api/<name>.js dostanú len kópiu sveta, bez kľúčov hráčov', async () => {
  const s = await setup();
  try {
    const f = await s.get('/api/debug/coins?id=stary');
    assert.strictEqual(f.status, 200);
    assert.ok(!f.body.includes(KEY));
    assert.deepStrictEqual(parseJson<unknown>(f.body), { source: 'file', coins: [[Debug.keyId(KEY), 5]] });
    const m = await s.get('/api/debug/coins?id=zivy');
    assert.deepStrictEqual(parseJson<unknown>(m.body), { source: 'memory', coins: [[Debug.keyId(KEY), 9]] });
    assert.strictEqual(must(must(s.rooms.get('zivy')).state.saves[KEY]).coins, 9, 'živý svet ostal nedotknutý (rozšírenie zmenilo len kópiu)');
    assert.strictEqual((await s.get('/api/debug/coins?id=nie')).status, 404);
    assert.strictEqual((await s.get('/api/debug/neexistuje')).status, 404);
    assert.strictEqual((await s.get('/api/debug/..%2Fx')).status, 404);
    const warn = console.error; console.error = () => {};
    try { assert.strictEqual((await s.get('/api/debug/boom')).status, 500); } finally { console.error = warn; }
  } finally { s.close(); }
});
