// #125: hráč nesmie dostať polohy hráčov (pl) skôr ako welcome – inak nevie, ktorá postavička je on, a vidí svojho „ducha“.
// Na serveri sa to stane, keď časovač polôh predbehne časovač rámca (stačí jeden rámec dlhší ako 100 ms). Lokálne ide rámec
// skoro vždy prvý, takže tento test chybu sám nevyvolá – stráži pravidlo (overené ručne zdržaním prvého rámca o 150 ms).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
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
