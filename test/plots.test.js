const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const Econ = require('../economy.js');

// ---------- Spoločné povolenie na pole ----------
test('povolenie na pole: najvyššia úroveň je 96 políčok', () => {
  const L = D.UPGRADES.plots.levels;
  assert.ok(D.UPGRADES.plots.shared);
  assert.deepStrictEqual(L.map(l => l.v), [8, 16, 28, 48, 96]);
});

test('povolenie na pole: patrí záhrade, kúpi ho ktokoľvek a obrobené políčka všetkých sa rátajú spolu', () => {
  const room = { up: { plots: 0 }, tiles: D.buildMap().map(g => ({ g, s: null })) };
  const eva = { coins: 500, rep: 0, up: { can: 0, composter: 0 } }, jan = { coins: 500, rep: 0, up: { can: 0, composter: 0 } };
  assert.strictEqual(Econ.plotLimit(room), 8);
  // Eva má 5 políčok, Ján 3 – spolu je povolenie plné
  for (let i = 0; i < 8; i++) room.tiles[400 + i].s = { k: 'normal', o: i < 5 ? 'eva' : 'jan' };
  assert.strictEqual(Econ.plotsUsed(room), 8);
  // Ján kúpi ďalšiu úroveň: platí on, povolenie stúpne pre celú záhradu
  assert.strictEqual(Econ.upgrade(room, jan, 'plots'), null);
  assert.strictEqual(jan.coins, 400);
  assert.strictEqual(eva.coins, 500);
  assert.strictEqual(room.up.plots, 1);
  assert.strictEqual(jan.up.plots, undefined, 'hráč vlastnú úroveň poľa nemá');
  assert.strictEqual(Econ.plotLimit(room), 16);
  // ďalšiu úroveň Eva bez reputácie nekúpi; s reputáciou áno
  assert.match(Econ.upgrade(room, eva, 'plots'), /reputáciu úrovne 1/);
  eva.rep = D.REP_LEVELS[3]; eva.coins = 5000;
  for (let k = 0; k < 3; k++) assert.strictEqual(Econ.upgrade(room, eva, 'plots'), null);
  assert.strictEqual(Econ.plotLimit(room), 96);
  assert.strictEqual(Econ.upgrade(room, eva, 'plots'), 'Záhrada už má najvyššiu úroveň.');
  // osobné vylepšenia ostávajú hráčovi
  assert.strictEqual(Econ.upgrade(room, jan, 'can'), null);
  assert.strictEqual(jan.up.can, 1);
  assert.strictEqual(eva.up.can, 0);
});

test('zarovnať: prázdne obrobené políčko môže zarovnať ktokoľvek, nielen ten, kto ho prekopal', () => {
  assert.strictEqual(D.canLevel({ g: 'grass', s: { k: 'normal', p: null, o: 'eva' } }), true);
  assert.strictEqual(D.canLevel({ g: 'grass', s: { k: 'normal', p: null } }), true, 'aj políčko bez zapísaného hráča');
  assert.strictEqual(D.canLevel({ g: 'grass', s: { k: 'normal', p: { sp: 'tulipan', prog: 1 }, o: 'eva' } }), false, 's rastlinou nie');
  assert.strictEqual(D.canLevel({ g: 'grass', s: null }), false, 'neprekopanú trávu nie');
  assert.strictEqual(D.canLevel(null), false);
});

// ---------- Server: migrácia osobných povolení a spoločný limit ----------
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
    ws, open: () => new Promise(r => ws.on('open', r)),
    send: m => ws.send(JSON.stringify(m)),
    wait(pred, ms) {
      const k = msgs.findIndex(pred);
      if (k >= 0) return Promise.resolve(msgs.splice(k, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: m => { clearTimeout(w.t); resolve(m); } };
        w.t = setTimeout(() => reject(new Error('správa neprišla: ' + pred)), ms || 4000);
        waiters.push(w);
      });
    }
  };
}

test('server: osobné povolenia z verzie 4 prejdú na spoločné povolenie záhrady', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-plots-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const map = D.buildMap(), tiles = map.map(() => ({ s: null }));
  // Eva mala povolenie úrovne 1 (16), Ján úrovne 3 (48); spolu majú obrobených 48 políčok
  const plotIdx = map.map((g, i) => i).filter(i => D.TILLABLE[map[i]] && map[i] !== 'ring' && i < 25 * D.W);
  for (let k = 0; k < 48; k++) tiles[plotIdx[k]] = { s: { k: 'normal', w: 0, r: 0, p: null, o: k < 16 ? 'eva' : 'jan' } };
  // obe postavičky stoja v záhrade na voľnej tráve, každá inde (na políčku s iným hráčom by motyka darovala)
  const free = map.map((g, i) => i).filter(i => map[i] === 'grass' && i >= 26 * D.W && i < 29 * D.W && (i % D.W) > 2 && (i % D.W) < 17);
  const fx = free[0] % D.W, fy = (free[0] / D.W) | 0;
  const far = free.find(i => Math.abs(i % D.W - fx) > 5), jx = far % D.W, jy = (far / D.W) | 0;
  const pl = { water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 0, talked: true, area: 'garden' };
  const save = {
    v: 4, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun',
    saves: {
      eva: Object.assign({}, pl, { x: fx + 0.5, y: fy + 0.5, coins: 3000, rep: D.REP_LEVELS[3], up: { can: 0, plots: 1, composter: 0 } }),
      jan: Object.assign({}, pl, { x: jx + 0.5, y: jy + 0.5, coins: 10, rep: 0, up: { can: 1, plots: 3, composter: 0 } })
    },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 7, tiles
  };
  fs.writeFileSync(path.join(dir, 'room-pole.json'), JSON.stringify(save));
  const proc = await startServer(dir, port);
  try {
    const eva = client(port), jan = client(port);
    await eva.open(); await jan.open();
    eva.send({ t: 'join', room: 'pole', name: 'Eva' });
    jan.send({ t: 'join', room: 'pole', name: 'Jan' });
    const me = await eva.wait(m => m.t === 'me');
    assert.strictEqual(me.plotLimit, 48, 'záhrada má najvyššiu úroveň, akú mal niektorý hráč');
    assert.strictEqual(me.plotsUsed, 48, 'rátajú sa políčka všetkých hráčov');
    assert.strictEqual(me.up.plots, 3);
    assert.strictEqual(me.up.can, 0, 'krhla ostala osobná');
    await jan.wait(m => m.t === 'me');
    // povolenie je plné: Eva nové políčko neprekope, hoci sama má len 16
    eva.send({ t: 'act', x: fx, y: fy, item: 'hoe' });
    assert.match((await eva.wait(m => m.t === 'toast' && /povolenie/.test(m.text))).text, /Spoločné povolenie záhrady je na 48 políčok/);
    // Eva kúpi ďalšiu úroveň pre všetkých – Ján sa to dozvie a môže kopať
    eva.send({ t: 'upgrade', kind: 'plots' });
    assert.match((await jan.wait(m => m.t === 'toast' && /celú záhradu/.test(m.text))).text, /Eva kúpil\(a\) pre celú záhradu Povolenie na pole: 96 políčok/);
    assert.strictEqual((await jan.wait(m => m.t === 'me')).up.plots, 4);
    assert.deepStrictEqual(await jan.wait(m => m.t === 'plots'), { t: 'plots', used: 48, limit: 96 });
    assert.deepStrictEqual(await eva.wait(m => m.t === 'plots'), { t: 'plots', used: 48, limit: 96 });
    jan.send({ t: 'act', x: jx, y: jy, item: 'hoe' });
    assert.deepStrictEqual(await eva.wait(m => m.t === 'plots' && m.used === 49), { t: 'plots', used: 49, limit: 96 });
    // prázdne políčko zarovná ktokoľvek, nielen ten, kto ho prekopal – uvoľní miesto pre všetkých
    // (Ján z políčka odstúpi – motyka na políčku s iným hráčom by darovala)
    jan.send({ t: 'move', x: jx + 1.9, y: jy + 0.5, dir: 0, ar: 0 });
    eva.send({ t: 'move', x: jx - 0.9, y: jy + 0.5, dir: 0, ar: 0 });
    await jan.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Eva' && Math.abs(p.x - (jx - 0.9)) < 0.01) && m.list.some(p => p.name === 'Jan' && Math.abs(p.x - (jx + 1.9)) < 0.01));
    eva.send({ t: 'act', x: jx, y: jy, item: 'hoe' });
    assert.deepStrictEqual(await eva.wait(m => m.t === 'plots' && m.used === 48), { t: 'plots', used: 48, limit: 96 });
    // ďalšia úroveň už nie je
    eva.send({ t: 'upgrade', kind: 'plots' });
    assert.strictEqual((await eva.wait(m => m.t === 'toast' && /najvyššiu/.test(m.text))).text, 'Záhrada už má najvyššiu úroveň.');
    eva.ws.close(); jan.ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-pole.json'), 'utf8'));
  try {
    assert.strictEqual(saved.v, 8);
    assert.deepStrictEqual(saved.up, { plots: 4 });
    assert.strictEqual(saved.saves.eva.up.plots, undefined);
    assert.strictEqual(saved.saves.jan.up.can, 1);
    assert.strictEqual(saved.saves.eva.coins, 500);
    assert.strictEqual(saved.tiles.filter(t => t.s).length, 48, 'žiadne políčko sa nestratilo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server: divé semienko na cudzom políčku vyklíči bez správy, do herbára pribudne tomu, kto políčko prekopal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-plots-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const map = D.buildMap(), tiles = map.map(() => ({ s: null }));
  // Eva prekopala políčko a zasadila divé semienko; Ján stojí vedľa, Eva ďaleko (na políčku s iným hráčom by elixír daroval)
  const free = map.map((g, i) => i).filter(i => map[i] === 'grass' && i >= 26 * D.W && i < 29 * D.W && (i % D.W) > 2 && (i % D.W) < 17);
  const wi = free[0], wx = wi % D.W, wy = (wi / D.W) | 0;
  const far = free.find(i => Math.abs(i % D.W - wx) > 5), ex = far % D.W, ey = (far / D.W) | 0;
  tiles[wi] = { s: { k: 'normal', w: 1, r: 0, o: 'eva', p: { sp: 'slnecnica', prog: 0, q: 3, dry: 0, wild: 1 } } };
  const pl = { water: 3, recipes: [], seen: [], vily: 0, talked: true, area: 'garden', coins: 10, rep: 0, up: { can: 0, composter: 0 } };
  const save = {
    v: 7, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun',
    saves: {
      eva: Object.assign({}, pl, { inv: { hoe: 1 }, x: ex + 0.5, y: ey + 0.5 }),
      jan: Object.assign({}, pl, { inv: { hoe: 1, po_rast: 1 }, x: wx + 1.5, y: wy + 0.5 })
    },
    up: { plots: 0 }, storage: {}, icehouse: { built: false, ice: 0 }, hory: null, pomedzieSeed: 7, tiles
  };
  fs.writeFileSync(path.join(dir, 'room-klicok.json'), JSON.stringify(save));
  const proc = await startServer(dir, port);
  try {
    const eva = client(port), jan = client(port);
    await eva.open(); await jan.open();
    eva.send({ t: 'join', room: 'klicok', name: 'Eva' });
    jan.send({ t: 'join', room: 'klicok', name: 'Jan' });
    await eva.wait(m => m.t === 'me'); await jan.wait(m => m.t === 'me');
    // Ján použije elixír rastu na Evino políčko → divé semienko vyklíči
    jan.send({ t: 'act', x: wx, y: wy, item: 'po_rast' });
    const tile = await eva.wait(m => m.t === 'tile' && m.i === wi && m.v.s.p.sp !== 'wild');
    assert.strictEqual(tile.v.s.p.sp, 'slnecnica', 'klíčok vidno v záhrade');
    assert.strictEqual(tile.v.s.o, 'eva', 'políčko si pamätá, kto ho prekopal');
    // správa o klíčku by prišla pred zmenou políčka – nesmie prísť nikomu
    await assert.rejects(eva.wait(m => m.t === 'toast' && /klíčok/.test(m.text), 300));
    await assert.rejects(jan.wait(m => m.t === 'toast' && /klíčok/.test(m.text), 300));
    eva.ws.close(); jan.ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-klicok.json'), 'utf8'));
  try {
    assert.ok(saved.saves.eva.seen.includes('slnecnica'), 'kvet pribudol do herbára tomu, kto políčko prekopal');
    assert.ok(!saved.saves.jan.seen.includes('slnecnica'), 'tomu, kto použil elixír, nie');
    assert.strictEqual(saved.tiles[wi].s.p.wild, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
