// Oneskorenie medzi hráčmi (#111): dvaja hráči na jednom serveri – ako dlho trvá, kým pohyb jedného uvidí druhý
// (správa move → schránka → rámec → vysielanie polôh `pl` 10× za sekundu) a kým akcia na políčku príde späť
// ako `tile` (správa act → rámec → dávka akcií → notify). Čísla sa vypíšu; stráž je voľná (dva 100 ms časovače + rezerva).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');

const json = v => JSON.stringify(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
// Klient: čaká na správu, ktorá spĺňa podmienku (len správy prijaté po zavolaní wait)
function client(port, room, name) {
  const ws = new WebSocket('ws://127.0.0.1:' + port), waiters = [];
  let welcome = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') welcome = m;
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const wait = (pred, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('nedošlo: ' + pred)), ms || 3000); waiters.push({ pred, res: m => { clearTimeout(t); res(m); } }); });
  return new Promise(r => ws.on('open', async () => {
    const w = wait(m => m.t === 'welcome');
    ws.send(json({ t: 'join', room, name }));
    await w;
    r({ ws, wait, send: m => ws.send(json(m)), get id() { return welcome.id; }, get seq() { return welcome.seq; }, x: welcome.x, y: welcome.y });
  }));
}
const stats = list => { const s = list.slice().sort((a, b) => a - b); return { n: s.length, min: s[0], median: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }; };
const fmt = s => `min ${s.min.toFixed(0)} · medián ${s.median.toFixed(0)} · p90 ${s.p90.toFixed(0)} · max ${s.max.toFixed(0)} ms (n=${s.n})`;

test('oneskorenie: pohyb jedného hráča uvidí druhý do ~200 ms; vlastná akcia na políčku sa vráti ako tile do ~200 ms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-latencia-'));
  const port = 47000 + Math.floor(Math.random() * 2000);
  const proc = await startServer(dir, port);
  let ana, bob;
  try {
    ana = await client(port, 'latencia', 'Ana'); bob = await client(port, 'latencia', 'Bob');
    await bob.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Ana'));
    // 1. pohyb Ana → Bob: čas od odoslania move po prvú správu pl, v ktorej Bob vidí Anu na novej polohe
    const moves = [];
    for (let k = 0; k < 20; k++) {
      const x = +(ana.x + ((k % 5) - 2) * 0.3).toFixed(3), y = +(ana.y - (k % 3) * 0.3).toFixed(3);
      const seen = bob.wait(m => m.t === 'pl' && m.list.some(p => p.id === ana.id && p.x === x && p.y === y));
      const t0 = process.hrtime.bigint();
      ana.send({ t: 'move', x, y, dir: 0, ar: ana.seq });
      await seen;
      moves.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(30);
    }
    // 2. akcia Ana → Ana: motyka na trávu pred ňou, čas po správu tile s prekopanou zemou (a späť zarovnanie)
    const acts = [];
    const map = D.buildMap();
    let i = -1, best = Infinity;
    for (let k = 0; k < map.length; k++) if (map[k] === 'grass') { const d = Math.hypot(k % D.W + 0.5 - ana.x, Math.floor(k / D.W) + 0.5 - ana.y); if (d < best) { best = d; i = k; } }
    const tx = i % D.W, ty = Math.floor(i / D.W);
    const stand = bob.wait(m => m.t === 'pl' && m.list.some(p => p.id === ana.id && p.y === ty - 0.5));
    ana.send({ t: 'move', x: tx + 0.5, y: ty - 0.5, dir: 0, ar: ana.seq }); // Ana sa postaví severne od trávy
    await stand;
    for (let k = 0; k < 10; k++) {
      const tilled = !(k % 2); // striedavo prekopať a zarovnať
      const seen = ana.wait(m => m.t === 'tile' && m.i === i && !!m.v.s === tilled);
      const t0 = process.hrtime.bigint();
      ana.send({ t: 'act', x: tx, y: ty, item: 'hoe' });
      await seen;
      acts.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(30);
    }
    const sm = stats(moves), sa = stats(acts);
    console.log(`  pohyb hráča → druhý hráč: ${fmt(sm)}`);
    console.log(`  akcia na políčku → tile:    ${fmt(sa)}`);
    // rámec (do 100 ms) + vysielanie polôh (do 100 ms) + rezerva; akcia: rámec + spracovanie + rezerva
    assert.ok(sm.median < 250 && sm.max < 600, 'pohyb: ' + fmt(sm));
    assert.ok(sa.median < 200 && sa.max < 600, 'akcia: ' + fmt(sa));
  } finally {
    if (ana) ana.ws.close(); if (bob) bob.ws.close();
    await sleep(100);
    await stopServer(proc);
  }
});
