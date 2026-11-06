const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');

function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
const getJson = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => {
  let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
}).on('error', reject));

// Uloženie vo formáte v8 (288 krokov na deň po 5 minút): deň 7, 13:35
const OLD_TPD = 288, T0 = 6 * OLD_TPD + 163;
function v8save() {
  const tiles = D.buildMap().map(() => ({ s: null }));
  tiles[5 * D.W + 5] = { s: { k: 'soil', w: 1, p: { sp: 'tulipan', prog: 4, q: 3, bt: T0 - 50 } } };
  return {
    v: 8, tick: T0, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 5, seq: 4, weather: 'sun',
    events: [
      { at: T0 + 1, seq: 1, type: 'hourly', data: null, key: 'hourly', periodic: true },
      { at: T0 + 300, seq: 2, type: 'cDue', data: { id: 3 }, key: 'cDue:3' },
      { at: T0 + 40, seq: 3, type: 'vilyEnd', data: { key: 'eva' }, key: 'vilyEnd:eva' },
      { at: T0 + 2, seq: 4, type: 'scavDone', data: { key: 'eva', n: 1 }, key: 'scavDone:eva' }
    ],
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1, fl_ruza: 2, ice: 1 }, fb: { fl_ruza: [{ n: 2, a: 30, at: T0 - 10 }], ice: [{ n: 1, a: 0, at: T0 - 5 }] }, recipes: [], seen: [], vily: T0 + 40, lastTick: T0 - 100, rep: 0, up: { can: 0, composter: 0 }, x: 4.5, y: 20.5, area: 'garden' } },
    storage: { fl_mak: 3 }, storageFb: { fl_mak: [{ n: 3, a: 12.5, at: T0 - 20 }] },
    market: null, contracts: { list: [{ id: 3, kind: 'short', giver: 'babka', sp: 'mak', n: 2, got: 0, reward: 40, item: null, rep: 6, posted: T0 - 10, openUntil: T0 + 100, due: T0 + 300, takenBy: null }], nextId: 4 },
    tiles, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 1, up: { plots: 0 }, lesSeed: 2, les: null, spid: null, scav: { 17: Math.floor(T0 / 12) }, fairyNight: 6
  };
}

test('migrácia v9: každý uložený krok × 25 – herný čas (deň, minúta, vek kvetov, termíny) ostane rovnaký', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-migrate-'));
  const port = 45000 + Math.floor(Math.random() * 2000);
  fs.writeFileSync(path.join(dir, 'room-v8.json'), JSON.stringify(v8save()));
  const proc = await startServer(dir, port);
  try {
    // ladiaca stránka číta súbor cez migrate bez načítania sveta – presné hodnoty
    const st = (await getJson(port, '/api/debug/room?id=v8')).state;
    const K = D.TICKS_PER_DAY / OLD_TPD;
    assert.strictEqual(K, 25);
    assert.strictEqual(st.v, 9);
    assert.strictEqual(st.migratedFrom, 8);
    assert.strictEqual(st.tick, T0 * 25);
    assert.strictEqual(D.dayOfTick(st.tick), 7);
    assert.strictEqual(D.minOfTick(st.tick), 163 * 5, '13:35');
    const at = k => st.events.find(e => e.key && e.key.startsWith(k)).at;
    assert.strictEqual(at('hourly'), (T0 + 1) * 25);
    assert.strictEqual(at('cDue:'), (T0 + 300) * 25);
    assert.strictEqual(at('vilyEnd:'), (T0 + 40) * 25);
    assert.strictEqual(at('scavDone:'), (T0 + 2) * 25);
    assert.strictEqual(st.tiles[5 * D.W + 5].s.p.bt, (T0 - 50) * 25, 'kvitne od');
    const sv = Object.values(st.saves)[0];
    assert.deepStrictEqual(sv.fb.fl_ruza, [{ n: 2, a: 30 * 25, at: (T0 - 10) * 25 }], 'vek kvetu v batohu');
    assert.deepStrictEqual(sv.fb.ice, [{ n: 1, a: 0, at: (T0 - 5) * 25 }]);
    assert.strictEqual(sv.vily, (T0 + 40) * 25);
    assert.strictEqual(sv.lastTick, (T0 - 100) * 25);
    assert.deepStrictEqual(st.storageFb.fl_mak, [{ n: 3, a: 12.5 * 25, at: (T0 - 20) * 25 }], 'vek kvetu v sklade');
    const c = st.contracts.list[0];
    assert.deepStrictEqual([c.posted, c.openUntil, c.due], [(T0 - 10) * 25, (T0 + 100) * 25, (T0 + 300) * 25]);
    assert.deepStrictEqual(st.scav, { 17: Math.floor(T0 / 12) }, 'okno hľadania je herná hodina – rovnaké číslo');
    assert.strictEqual(Math.floor(st.tick / D.SCAVENGE.window), Math.floor(T0 / 12));
    assert.strictEqual(st.fairyNight, 6, 'dni sa nemenia');
    // vek kvetu v hernom čase: 30 starých krokov = 150 minút = 750 nových krokov
    assert.strictEqual(D.batchAge(sv.fb.fl_ruza[0], st.tick, 1) * D.MIN_PER_TICK, (30 + 10) * 5);

    // hráč sa pripojí: svet sa načíta, beží (pozastavený svet s hráčom) a uloží sa ako v9
    const ws = new WebSocket('ws://127.0.0.1:' + port), msgs = [];
    ws.on('message', raw => msgs.push(JSON.parse(raw)));
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', room: 'v8', name: 'Eva' }));
    const t0 = Date.now();
    while (!msgs.some(m => m.t === 'time') && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 20));
    const time = msgs.find(m => m.t === 'time');
    assert.ok(time.tick >= T0 * 25 && time.tick < T0 * 25 + 25, 'čas pokračuje odtiaľ, kde bol');
    assert.strictEqual(time.tickMs, 125, '8 krokov za sekundu');
    ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-v8.json'), 'utf8'));
  assert.strictEqual(saved.v, 9);
  assert.strictEqual(D.dayOfTick(saved.tick), 7);
  assert.ok(Math.abs(D.minOfTick(saved.tick) - 815) < 5, 'stále okolo 13:35');
  assert.strictEqual(saved.daySeconds, D.BASE_DAY_SECONDS);
  fs.rmSync(dir, { recursive: true, force: true });
});
