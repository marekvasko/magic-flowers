const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const Econ = require('../economy.js');

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

test('server: udalosti zo svetu verzie 4 dostanú kľúče, duplicity a odstránené typy zmiznú, chýbajúce sa doplnia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-events-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const f = D.FESTIVALS[0];
  const ev = (at, seq, type, data) => ({ at, seq, type, data: data === undefined ? null : data });
  const save = {
    v: 4, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 9, weather: 'sun',
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 1200, rep: 0, up: { can: 0, plots: 0, composter: 0 } } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 1, market: null, contracts: null,
    events: [
      ev(1012, 1, 'hourly'), ev(1050, 2, 'npc_fero'), ev(1060, 3, 'npc_fero'), ev(1100, 4, 'dawn'),
      ev(1150, 5, 'zrusena_udalost'), ev(1200, 6, 'vilyEnd', { key: 'eva' }),
      ev(5000, 7, 'festAnnounce', { id: f.id, start: 5576 })
    ]
  };
  fs.writeFileSync(path.join(dir, 'room-stary.json'), JSON.stringify(save));
  const proc = await startServer(dir, port);
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', room: 'stary', name: 'Eva' }));
    await new Promise(r => ws.on('message', raw => { if (JSON.parse(raw).t === 'welcome') r(); }));
    ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-stary.json'), 'utf8'));
  assert.strictEqual(saved.v, 5);
  const byKey = k => saved.events.filter(e => e.key === k);
  // pôvodné udalosti ostali tam, kde boli
  assert.deepStrictEqual(byKey('hourly').map(e => e.at), [1012]);
  assert.deepStrictEqual(byKey('dawn').map(e => e.at), [1100]);
  assert.deepStrictEqual(byKey('npc_fero').map(e => e.at), [1050], 'duplicita zmizla');
  assert.deepStrictEqual(byKey('festAnnounce:' + f.id).map(e => [e.at, e.data]), [[5000, { id: f.id }]]);
  assert.deepStrictEqual(byKey('vilyEnd:eva').map(e => [e.at, !!e.periodic]), [[1200, false]]);
  assert.ok(!saved.events.some(e => e.type === 'zrusena_udalost'), 'odstránený typ zmizol');
  // chýbajúce periodické udalosti (dodávky, ostatné NPC, sviatky) sa doplnili, každá práve raz
  for (const def of Econ.PERIODIC) assert.strictEqual(byKey(def.key).length, 1, def.key);
  // zákazky z novej nástenky majú unikátne udalosti
  for (const c of saved.contracts.list) assert.strictEqual(byKey('cDue:' + c.id).length, 1, 'cDue:' + c.id);
});
