// #125: duch vlastnej postavičky na mieste pripojenia. Rámec (join → welcome) a polohy hráčov (pl) sú dva časovače po 100 ms;
// po jednom rámci dlhšom ako 100 ms ide pl prvý a pripájajúci sa hráč dostane polohy skôr ako welcome. Ešte nepozná vlastné id,
// a tak si seba pridá medzi ostatných – a tá postavička zamrzne na mieste pripojenia.
// Klient aj server testujeme priamo (presne táto postupnosť); test naživo na konci chybu sám nevyvolá
// (lokálne ide rámec skoro vždy prvý), stráži len pravidlo „welcome pred pl“.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const Players = require('../src/shared/players.js');
const P = require('../src/server/presence.js');

// ---------- Klient: ostatní hráči podľa pl ----------
const pl = (id, x, y, area) => ({ id, name: 'Hráč ' + id, x, y, area: area || 'garden', j: 0 });
const move = (o, p) => Object.assign(o, { id: p.id, tx: p.x, ty: p.y, name: p.name });

test('klient: pl prišiel skôr ako welcome – vlastná postavička nezostane medzi ostatnými ako duch (#125)', () => {
  const others = new Map();
  // pripájam sa ako hráč 7 na štarte (10, 30); id ešte nepoznám, Anna (1) už hrá
  Players.syncOthers(others, [pl(1, 3, 3), pl(7, 10, 30)], undefined, move);
  assert.deepStrictEqual([...others.keys()].sort(), [1, 7], 'bez vlastného id je každý „ostatný“');
  // welcome: som 7; odídem zo štartu, ďalšie pl už má moju novú polohu
  const me = Players.syncOthers(others, [pl(1, 3, 3), pl(7, 15, 30)], 7, move);
  assert.deepStrictEqual([...others.keys()], [1], 'zamrznutý duch hráča 7 na štarte zmizol');
  assert.strictEqual(me.x, 15, 'vlastná položka sa vráti (emócia, hľadanie)');
  assert.strictEqual(others.get(1).tx, 3);
});

test('klient: ostatní hráči – noví pribudnú, kto odišiel, zmizne, vlastná postavička nikdy', () => {
  const others = new Map();
  assert.strictEqual(Players.syncOthers(others, [pl(1, 1, 1), pl(2, 2, 2), pl(5, 5, 5)], 5, move).id, 5);
  assert.deepStrictEqual([...others.keys()], [1, 2]);
  const anna = others.get(1);
  Players.syncOthers(others, [pl(1, 4, 1), pl(5, 5, 5), pl(3, 3, 3)], 5, move);
  assert.deepStrictEqual([...others.keys()], [1, 3], 'hráč 2 odišiel, hráč 3 prišiel');
  assert.strictEqual(others.get(1), anna, 'postavička ostáva tá istá (plynulý pohyb)');
  assert.deepStrictEqual([anna.x, anna.tx], [1, 4], 'kreslí sa z doterajšej polohy, k cieľu sa len posúva');
  assert.strictEqual(Players.syncOthers(others, [], 5, move), null);
  assert.strictEqual(others.size, 0);
});

// ---------- Server: komu idú polohy hráčov ----------
test('server: hráč, ktorý sa ešte pripája, polohy nedostane; ostatní dostanú hráčov svojej plochy (#125)', () => {
  const ws = (open) => ({ readyState: open === false ? 3 : 1, got: [], send(s) { this.got.push(JSON.parse(s)); } });
  const anna = { id: 1, area: 'garden', ws: ws() }, eva = { id: 2, area: 'hory', ws: ws() };
  const marek = { id: 3, area: 'garden', ws: ws(), joining: true }, gone = { id: 4, area: 'garden', ws: ws(false) };
  const list = [anna, eva, marek, gone].map(p => pl(p.id, p.id, p.id, p.area));
  P.sendPlayers([anna, eva, marek, gone], list);
  assert.deepStrictEqual(marek.ws.got, [], 'pripájajúci sa hráč nedostal nič (welcome ešte neprišiel)');
  assert.deepStrictEqual(gone.ws.got, []);
  assert.deepStrictEqual(anna.ws.got.map(m => [m.t, m.list.map(p => p.id)]), [['pl', [1, 3, 4]]], 'Anna vidí aj Mareka, ktorý sa práve pripája');
  assert.deepStrictEqual(eva.ws.got.map(m => [m.t, m.list.map(p => p.id)]), [['pl', [2]]], 'v horách len hráči z hôr');
  // po welcome (joining = false) už polohy dostane aj Marek – vrátane seba, podľa toho si nastaví emóciu
  marek.joining = false;
  P.sendPlayers([marek], list);
  assert.deepStrictEqual(marek.ws.got[0].list.map(p => p.id), [1, 3, 4]);
});

// ---------- Server naživo ----------
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
// pripojí sa a zbiera typy správ, kým nepríde welcome a po ňom aj zoznam hráčov s vlastnou postavičkou
function join(port, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port), order = [];
    let id = null;
    const t = setTimeout(() => { ws.close(); reject(new Error('neprišiel welcome a pl: ' + order.join(','))); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'duch', name })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      order.push(m.t);
      if (m.t === 'welcome') id = m.id;
      if (m.t === 'pl' && id != null && m.list.some(p => p.id === id)) { clearTimeout(t); resolve({ ws, order }); }
    });
  });
}

test('server: polohy hráčov (pl) prídu až po welcome, aj keď sa pripája viac hráčov a znova (#125)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ghost-'));
  const port = await freePort();
  const proc = await startServer(dir, port);
  const open = [];
  try {
    // prvý hráč je v záhrade, aby sa polohy vysielali stále; ďalší sa pripájajú (aj pod rovnakým menom – znovupripojenie)
    open.push((await join(port, 'Anna')).ws);
    for (let i = 0; i < 8; i++) {
      const { ws, order } = await join(port, i % 2 ? 'Marek' : 'Beta' + i);
      ws.close(); // v záhrade sú najviac 4 hráči
      assert.ok(order.indexOf('welcome') < order.indexOf('pl'), 'pl prišiel pred welcome: ' + order.join(','));
    }
  } finally {
    for (const ws of open) ws.close();
    await stopServer(proc);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
