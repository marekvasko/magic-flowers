const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const E = require('../engine.js');
const Actions = require('../actions.js');

function setup() {
  const room = { tick: 100, rng: 1, seq: 0, events: [], players: new Map() };
  const pl = (id) => { const p = { id, key: 'k' + id, areaSeq: 0 }; room.players.set(id, p); return p; };
  return { room, a: pl(1), b: pl(2) };
}

test('akcie hráča: jeden kľúč playerAction:<hráč> – nová akcia čakajúcu nahradí a preruší', () => {
  const { room, a, b } = setup();
  const log = [];
  Actions.define('tScav', { interrupted(r, p, ev, why) { log.push([p.id, ev.type, why]); } });
  Actions.schedule(room, a, 125, 'tScav', { i: 7 });
  Actions.schedule(room, b, 125, 'tScav', { i: 8 });
  assert.strictEqual(Actions.doing(room, a, 'tScav').data.i, 7, 'stav rozpracovanej akcie je v jej udalosti');
  Actions.schedule(room, a, 101, 'arriveAt', { x: 1 });
  assert.deepStrictEqual(room.events.filter(e => e.key === Actions.KEY(a)).map(e => e.type), ['arriveAt'], 'najviac jedna akcia na hráča');
  assert.deepStrictEqual(log, [[1, 'tScav', 'arriveAt']], 'prerušená akcia sa dozvie, čím');
  assert.strictEqual(Actions.doing(room, a, 'tScav'), null);
  assert.strictEqual(Actions.doing(room, b, 'tScav').data.i, 8, 'iný hráč má svoju');
  Actions.cancel(room, b, 'leave');
  assert.deepStrictEqual(log[1], [2, 'tScav', 'leave']);
  assert.strictEqual(Actions.current(room, b), null);
});

test('akcie hráča: jednorazový úkon (once) nič nenahradí; akcia hráča na inej ploche už nie je jeho', () => {
  const { room, a } = setup();
  Actions.schedule(room, a, 125, 'scavDone', { i: 1 });
  Actions.once(room, a, 101, 'buy', { m: { id: 'seed_mak' } });
  Actions.once(room, a, 101, 'buy', { m: { id: 'seed_mak' } });
  assert.deepStrictEqual(room.events.map(e => e.type).sort(), ['buy', 'buy', 'scavDone'], 'dve kúpy a hľadanie beží ďalej');
  assert.ok(room.events.every(Actions.isRuntime), 'po načítaní sveta sa zahodia');
  a.areaSeq++;
  assert.strictEqual(Actions.current(room, a), null, 'po prechode na inú plochu stará akcia nepatrí hráčovi');
  assert.strictEqual(Actions.owner(room, room.events[0].data), null);
});

// ---------- naozajstný server ----------
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
function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port), msgs = [], waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    const k = waiters.findIndex(w => w.pred(m));
    if (k >= 0) waiters.splice(k, 1)[0].resolve(m); else msgs.push(m);
  });
  return {
    ws, send: m => ws.send(JSON.stringify(m)), open: () => new Promise(r => ws.on('open', r)),
    wait(pred, ms) {
      const k = msgs.findIndex(pred);
      if (k >= 0) return Promise.resolve(msgs.splice(k, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: m => { clearTimeout(w.t); resolve(m); } };
        w.t = setTimeout(() => reject(new Error('správa neprišla')), ms || 4000);
        waiters.push(w);
      });
    },
    drop(pred) { for (let k = msgs.length - 1; k >= 0; k--) if (pred(msgs[k])) msgs.splice(k, 1); }
  };
}

test('server: hľadanie preruší pohyb, kúpa nie; všetko ide cez plánovač a je v denníku', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-actions-'));
  const port = 45000 + Math.floor(Math.random() * 2000);
  const proc = await startServer(dir, port);
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'akcie', name: 'Eva' });
    const wel = await c.wait(m => m.t === 'welcome');
    // najbližšia neprekopaná tráva, kam sa dá dôjsť
    const grass = wel.tiles.map((t, i) => ({ t, i })).filter(o => o.t.g === 'grass' && !o.t.s)
      .sort((p, q) => Math.hypot(p.i % D.W - wel.x, (p.i / D.W | 0) - wel.y) - Math.hypot(q.i % D.W - wel.x, (q.i / D.W | 0) - wel.y));
    let at = null;
    for (let k = 0; k < 10 && !at; k++) {
      const x = grass[k].i % D.W, y = (grass[k].i / D.W) | 0;
      c.send({ t: 'goTo', x, y, n: k + 1, ar: 0 });
      if ((await c.wait(m => m.t === 'goToEnd' || m.t === 'goToNo', 15000)).t === 'goToEnd') at = { x, y };
    }
    assert.ok(at, 'k tráve sa dá dôjsť');
    const me = m => m.t === 'pl' && m.list.some(p => p.name === 'Eva' && p.e === 'search');
    c.send({ t: 'act', x: at.x, y: at.y, item: '', px: at.x + 0.5, py: at.y + 0.5, ar: 0 });
    await c.wait(me);
    // kúpa počas hľadania (jednorazový úkon) hľadanie nepreruší
    c.send({ t: 'buy', id: 'compost', n: 1 });
    await c.wait(m => m.t === 'toast' && /kompost|mincí|🪙/i.test(m.text));
    c.drop(m => m.t === 'pl');
    await c.wait(me);
    // pohyb áno – a hráč sa to dozvie
    c.send({ t: 'move', x: at.x + 0.5, y: at.y + 0.9, dir: 0, ar: 0 });
    assert.match((await c.wait(m => m.t === 'toast' && /dohľadal/.test(m.text))).text, /Pohol\(a\) si sa skôr/);
    // denník: akcia na políčku, hľadanie nahradené pohybom, kúpa ako obyčajná udalosť
    await new Promise(r => setTimeout(r, 1300)); // server zapisuje denník raz za sekundu
    const j = await (await fetch(`http://127.0.0.1:${port}/api/debug/journal?id=akcie&key=playerAction:*`)).json();
    const kinds = j.entries.slice().reverse().map(e => e.kind + ' ' + e.type);
    for (const k of ['add act', 'run act', 'add scavDone', 'replace scavDone', 'run arriveAt']) assert.ok(kinds.includes(k), k);
    const buy = await (await fetch(`http://127.0.0.1:${port}/api/debug/journal?id=akcie&type=buy`)).json();
    assert.deepStrictEqual(buy.entries.map(e => [e.kind, e.key, e.data.m.id]), [['run', null, 'compost'], ['add', null, 'compost']]);
    c.ws.close();
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
