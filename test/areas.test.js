const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const W3 = require('../shared/world3d.js');
const Areas = require('../areas.js');

const SEEDS = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0);

// Políčka dosiahnuteľné chôdzou z políčka start (len cez priechodné typy zeme)
function reach(tiles, w, h, start) {
  const seen = new Uint8Array(w * h), q = [start];
  seen[start] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[n] || D.BLOCK[tiles[n]]) continue;
      seen[n] = 1; q.push(n);
    }
  }
  return seen;
}

test('plochy: každá má svoju veľkosť a mapa sedí s veľkosťou', () => {
  assert.deepStrictEqual(D.AREAS, ['garden', 'hory', 'pomedzie', 'les']);
  for (const area of D.AREAS) {
    const { w, h } = D.areaSize(area);
    assert.ok(w > 0 && h > 0);
    assert.strictEqual(D.buildArea(area, 7).length, w * h, area);
    assert.ok(D.AREA_NAMES[area] && D.AREA_IN[area] && D.AREA_FX[area].icon, `meno a vzhľad prechodu pre ${area}`);
  }
  assert.deepStrictEqual(D.areaSize('pomedzie'), D.areaSize('garden'), 'Les na pomedzí je veľký ako záhrada');
  assert.strictEqual(D.AREA_NAMES.pomedzie, 'Les na pomedzí');
});

test('graf prechodov: každý prechod je na okraji, vedie späť a príchod je voľné políčko pri ňom', () => {
  for (const area of D.AREAS) {
    const { w, h } = D.areaSize(area), tiles = D.buildArea(area, 3);
    for (const g of D.GATES[area]) {
      assert.strictEqual(tiles[g.y * w + g.x], 'gate', `${area} ${g.x},${g.y}`);
      assert.ok(g.x === 0 || g.y === 0 || g.x === w - 1 || g.y === h - 1, `prechod ${area} ${g.x},${g.y} je na okraji`);
      assert.ok(D.AREAS.includes(g.to) && g.to !== area);
      // z cieľa vedie prechod späť
      assert.ok(D.GATES[g.to].some(b => b.to === area), `${g.to} → ${area}`);
      // príchod: vnútri cieľa, priechodné políčko, nie prechod, blízko prechodu späť
      const a = D.arrival(area, g.to), t = D.buildArea(g.to, 3), ts = D.areaSize(g.to);
      assert.ok(a, `príchod ${area}>${g.to}`);
      assert.ok(Areas.inside(g.to, Math.floor(a.x), Math.floor(a.y)));
      const at = t[Math.floor(a.y) * ts.w + Math.floor(a.x)];
      assert.ok(!D.BLOCK[at] && at !== 'gate', `príchod ${area}>${g.to} je na voľnom políčku (${at})`);
      const back = D.GATES[g.to].filter(b => b.to === area);
      assert.ok(back.some(b => Math.hypot(b.x + 0.5 - a.x, b.y + 0.5 - a.y) < 2), 'príchod je hneď pri prechode späť');
    }
  }
  // záhrada: hory na severe, Les na pomedzí na východe
  assert.deepStrictEqual(D.GATES.garden.map(g => D.gateSide('garden', g) + g.to), ['nhory', 'nhory', 'epomedzie', 'epomedzie']);
  // Les na pomedzí: záhrada na západe, Les divov na severe; z Lesa divov sa ide len na juh späť
  assert.deepStrictEqual(D.GATES.pomedzie.map(g => D.gateSide('pomedzie', g) + g.to), ['wgarden', 'wgarden', 'nles', 'nles']);
  assert.deepStrictEqual(D.GATES.les.map(g => D.gateSide('les', g) + g.to), ['spomedzie', 'spomedzie']);
});

test('príchod: celé telo hráča stojí na priechodnej zemi a odtiaľ sa dá dôjsť k prechodu späť (200 semienok)', () => {
  for (const [key, a] of Object.entries(D.ARRIVE)) {
    const [from, to] = key.split('>'), { w, h } = D.areaSize(to);
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => [Math.floor(a.x + sx * D.BODY.rx), Math.floor(a.y + sy * D.BODY.ry)]);
    const back = D.GATES[to].filter(g => g.to === from);
    for (const seed of SEEDS) {
      const tiles = D.buildArea(to, seed);
      for (const [x, y] of corners) assert.ok(!D.BLOCK[tiles[y * w + x]], `${key} semienko ${seed}: pod telom na ${x},${y} je ${tiles[y * w + x]}`);
      const seen = reach(tiles, w, h, corners[0][1] * w + corners[0][0]);
      for (const [x, y] of corners) assert.ok(seen[y * w + x], `${key} semienko ${seed}: políčka pod telom sú spojené`);
      assert.ok(back.some(g => seen[g.y * w + g.x]), `${key} semienko ${seed}: z príchodu sa dá dôjsť k prechodu späť`);
    }
  }
  // generátor drží voľné práve políčka pod telom na príchodovom mieste
  assert.deepStrictEqual([...D.arrivalTiles('les')].map(i => [i % D.LES_W, (i / D.LES_W) | 0]).sort(), [[19, 65], [20, 65]]);
});

test('prechod záhrada ↔ Les na pomedzí: gateTarget podľa políčka', () => {
  const garden = D.buildMap().map(g => ({ g })), pom = Areas.loadPomedzie(42);
  const ge = D.GATES.garden.find(g => g.to === 'pomedzie'), pw = D.GATES.pomedzie[0];
  assert.strictEqual(Areas.gateTarget(garden, 'garden', ge.x + 0.7, ge.y + 0.5), 'pomedzie');
  assert.strictEqual(Areas.gateTarget(pom, 'pomedzie', pw.x + 0.2, pw.y + 0.5), 'garden');
  assert.strictEqual(Areas.gateTarget(garden, 'garden', ge.x - 1 + 0.5, ge.y + 0.5), null);
  const a = D.arrival('garden', 'pomedzie');
  assert.strictEqual(Areas.gateTarget(pom, 'pomedzie', a.x, a.y), null, 'po príchode hráč nestojí na prechode');
  // mimo mriežky nič
  assert.strictEqual(Areas.gateTarget(pom, 'pomedzie', -0.5, 25.5), null);
});

test('veľkosť plochy: z mriežky sa vyjsť nedá', () => {
  const { w, h } = D.areaSize('pomedzie');
  assert.deepStrictEqual(Areas.clampPos('pomedzie', -3, 99), { x: 0.2, y: h - 0.2 });
  assert.deepStrictEqual(Areas.clampPos('pomedzie', w + 5, -1), { x: w - 0.2, y: 0.2 });
  assert.deepStrictEqual(Areas.clampPos('garden', 4.5, 7.25), { x: 4.5, y: 7.25 });
  assert.ok(Areas.inside('pomedzie', w - 1, h - 1) && !Areas.inside('pomedzie', w, 0) && !Areas.inside('pomedzie', 0, -1));
});

test('Les na pomedzí: rovnaké semienko = rovnaký les, iné semienko = iný les', () => {
  assert.deepStrictEqual(D.buildPomedzie(123), D.buildPomedzie(123));
  assert.notDeepStrictEqual(D.buildPomedzie(123), D.buildPomedzie(124));
  assert.deepStrictEqual(Areas.loadPomedzie(5).map(t => t.g), D.buildPomedzie(5));
});

test('Les na pomedzí: každé priechodné políčko je dosiahnuteľné od oboch prechodov (200 semienok)', () => {
  const { w, h } = D.areaSize('pomedzie'), [nx0, nx1] = D.POMEDZIE_NORTH;
  for (const seed of SEEDS) {
    const g = D.buildPomedzie(seed);
    const west = reach(g, w, h, D.GATES.pomedzie[0].y * w), north = reach(g, w, h, nx0);
    assert.strictEqual(g[nx0], 'gate', `prechod do Lesa divov na severnom okraji (semienko ${seed})`);
    assert.strictEqual(g[nx1], 'gate');
    assert.strictEqual(g[w + nx0], 'path');
    for (let i = 0; i < g.length; i++) {
      if (D.BLOCK[g[i]]) continue;
      assert.ok(west[i] && north[i], `semienko ${seed}: políčko ${i % w},${(i / w) | 0} (${g[i]}) je odrezané`);
    }
    for (const gt of D.GATES.pomedzie) assert.ok(west[gt.y * w + gt.x]);
  }
});

test('Les na pomedzí: na juhu lúka, smerom na sever hustnúci les, na severe len chodník', () => {
  const { w, h } = D.areaSize('pomedzie');
  const share = (g, y0, y1, types) => { let n = 0, all = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) { all++; if (types.includes(g[y * w + x])) n++; } return n / all; };
  let south = 0, mid = 0, north = 0, meadow = 0;
  for (const seed of SEEDS) {
    const g = D.buildPomedzie(seed);
    meadow += share(g, D.MEADOW_Y, h - 1, ['meadow']);
    south += share(g, D.MEADOW_Y, h - 1, ['tree']);
    mid += share(g, 10, 20, ['tree']);
    north += share(g, 3, 8, ['tree']);
    for (let y = 0; y <= 2; y++) for (let x = 0; x < w; x++) assert.ok(['tree', 'path', 'gate'].includes(g[y * w + x]), `sever ${x},${y}: ${g[y * w + x]}`);
    assert.ok(g.includes('fern') && g.includes('bush') && g.includes('path'), 'paprade, kry a chodníky');
    assert.ok(!g.some(t => ['grass', 'water', 'house', 'stall'].includes(t)), 'v lese sa nič nepestuje ani nekupuje');
  }
  const n = SEEDS.length;
  assert.ok(meadow / n > 0.7, 'na juhu je lúka: ' + (meadow / n).toFixed(2));
  assert.ok(south / n < 0.1 && south < mid && mid < north, `stromy: juh ${(south / n).toFixed(2)}, stred ${(mid / n).toFixed(2)}, sever ${(north / n).toFixed(2)}`);
  assert.ok(north / n > 0.6, 'na severe hustý les');
});

test('stmievanie: na juhu nič, smerom na sever postupne tmavšie, v záhrade a horách nie', () => {
  const { h } = D.areaSize('pomedzie');
  assert.strictEqual(D.gloomAt('pomedzie', h - 1), 0);
  assert.strictEqual(D.gloomAt('pomedzie', D.MEADOW_Y), 0);
  let prev = 0;
  for (let y = D.MEADOW_Y - 1; y >= 0; y--) { const v = D.gloomAt('pomedzie', y); assert.ok(v >= prev, 'na sever tmavšie'); prev = v; }
  assert.ok(prev >= 0.7 && prev <= 0.85, 'na severnom okraji je šero, ale nie úplná tma: ' + prev);
  assert.ok(D.gloomAt('pomedzie', 12) > 0.1 && D.gloomAt('pomedzie', 12) < prev / 2, 'v strede len mierne');
  assert.strictEqual(D.gloomAt('garden', 0), 0);
  assert.strictEqual(D.gloomAt('hory', 0), 0);
});

test('3D: svet Lesa na pomedzí – kry ako modely, stromy podľa plochy, mriežka podľa veľkosti', () => {
  const pom = Areas.loadPomedzie(9), { w, h } = D.areaSize('pomedzie');
  const g = W3.buildGrid(pom, 1, w, 'pomedzie');
  assert.strictEqual(g.NX, w * W3.R); assert.strictEqual(g.NZ, h * W3.R);
  assert.strictEqual(g.fine.filter(f => f.type === 'bush').length, pom.filter(t => t.g === 'bush').length);
  assert.ok(g.fine.filter(f => f.type === 'tree').every(f => f.kind !== 'jablon'), 'ovocný sad je len pri babke v záhrade');
  // zima: kry sú holé prútie so snehom
  const win = W3.buildGrid(pom, 3, w, 'pomedzie').fine.find(f => f.type === 'bush');
  assert.ok(win.data.includes(W3.M.SNOW) && !win.data.includes(W3.M.LEAF_SUMMER));
  // na severe viac ihličnanov než na juhu
  const con = (y0, y1) => { let c = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) { const k = W3.treeKind(x, y, 'pomedzie'); n++; if (k === 'smrek' || k === 'borovica') c++; } return c / n; };
  assert.ok(con(0, 6) > con(18, 24) + 0.2);
  // menšia plocha: mriežka a voda podľa šírky
  const small = Array.from({ length: 6 * 4 }, (_, i) => ({ g: i === 7 ? 'water' : 'grass' }));
  const sg = W3.buildGrid(small, 1, 6);
  assert.strictEqual(sg.NX, 12); assert.strictEqual(sg.NZ, 8);
  assert.deepStrictEqual(W3.waterQuads(small, 6), [{ x: 1, y: 1 }]);
  assert.strictEqual(W3.surfaceY(sg, 1, 1), W3.WATER_Y);
});

// ---------- Server: migrácia starého uloženia a cesta záhrada ↔ Les na pomedzí ----------
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
// Hráč dôjde na políčko ťuknutím (goTo) – server overuje každý pohyb, preskok správou move by neprijal
let walkN = 0;
function walkTo(c, x, y, ar, pred) {
  c.send({ t: 'goTo', x: Math.floor(x), y: Math.floor(y), n: ++walkN, ar });
  return c.wait(pred || (m => m.t === 'goToEnd' || m.t === 'goToNo' || m.t === 'shove'), 20000);
}
// klient: správy do fronty, wait(pred) počká na prvú vyhovujúcu
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
        w.t = setTimeout(() => reject(new Error('správa neprišla')), ms || 4000);
        waiters.push(w);
      });
    }
  };
}

test('server: svet z verzie 3 sa prevedie (záhrada aj poloha ostanú) a hráč prejde do Lesa na pomedzí a späť', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-areas-'));
  const port = 39000 + Math.floor(Math.random() * 2000);
  // starý svet (v3): prekopané políčko so zasadenou rastlinou a hráčka uložená v záhrade
  const tiles = D.buildMap().map(() => ({ s: null }));
  const plot = 30 * D.W + 8;
  tiles[plot] = { s: { k: 'normal', w: 1, r: 0, p: { sp: 'mak', prog: 1, q: 3, dry: 0 }, o: 'eva' } };
  const save = {
    v: 3, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun',
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, plots: 0, composter: 0 }, x: 12.25, y: 20.5, area: 'garden' } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, tiles
  };
  fs.writeFileSync(path.join(dir, 'room-stary.json'), JSON.stringify(save));
  let proc = await startServer(dir, port);
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'stary', name: 'Eva' });
    const wel = await c.wait(m => m.t === 'welcome');
    assert.strictEqual(wel.area, 'garden');
    assert.deepStrictEqual([wel.x, wel.y], [12.25, 20.5], 'poloha hráčky ostala');
    assert.deepStrictEqual([wel.w, wel.h], [D.W, D.H]);
    assert.strictEqual(wel.tiles[plot].s.p.sp, 'mak', 'záhrada ostala');
    // na prechod na východnom okraji záhrady
    const ge = D.GATES.garden.find(g => g.to === 'pomedzie');
    const toPom = await walkTo(c, ge.x, ge.y, 0, m => m.t === 'area');
    const a = D.arrival('garden', 'pomedzie');
    assert.strictEqual(toPom.area, 'pomedzie');
    assert.deepStrictEqual([toPom.x, toPom.y, toPom.w, toPom.h], [a.x, a.y, D.areaSize('pomedzie').w, D.areaSize('pomedzie').h]);
    assert.strictEqual(toPom.tiles.length, toPom.w * toPom.h);
    assert.ok(toPom.tiles.some(t => t.g === 'meadow') && !toPom.tiles.some(t => t.s), 'Les na pomedzí bez záhonov');
    // mimo mriežky sa nedá – server polohu udrží na ploche
    const H = D.areaSize('pomedzie').h;
    assert.strictEqual((await walkTo(c, 0, H - 1, toPom.seq)).t, 'goToEnd');
    c.send({ t: 'move', x: -4, y: 40, dir: 0, ar: toPom.seq });
    const pl = await c.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Eva' && p.x === 0.2));
    assert.deepStrictEqual(pl.list.map(p => [p.area, p.x, p.y]), [['pomedzie', 0.2, H - 0.2]]);
    // motyka v lese nič neprekope
    c.send({ t: 'act', x: 0, y: D.areaSize('pomedzie').h - 1, item: 'hoe' });
    assert.match((await c.wait(m => m.t === 'toast' && /nepestuje/.test(m.text))).text, /Les na pomedzí je divý/);
    // späť cez prechod na západe
    const pw = D.GATES.pomedzie[0];
    const back = await walkTo(c, pw.x, pw.y, toPom.seq, m => m.t === 'area');
    const b = D.arrival('pomedzie', 'garden');
    assert.deepStrictEqual([back.area, back.x, back.y], ['garden', b.x, b.y]);
    // a znova do lesa: po odpojení a znovupripojení je hráčka v lese
    await walkTo(c, ge.x, ge.y, back.seq, m => m.t === 'area' && m.area === 'pomedzie');
    c.ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-stary.json'), 'utf8'));
  assert.strictEqual(saved.v, 9);
  assert.strictEqual(saved.migratedFrom, 3);
  assert.ok(Number.isInteger(saved.pomedzieSeed));
  assert.strictEqual(saved.tiles[plot].s.p.sp, 'mak');
  assert.strictEqual(saved.saves.eva.coins, 77);
  assert.strictEqual(saved.saves.eva.area, 'pomedzie');
  // po reštarte servera: rovnaký les (zo semienka) a hráčka v ňom
  proc = await startServer(dir, port);
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'stary', name: 'Eva' });
    const wel = await c.wait(m => m.t === 'welcome');
    assert.strictEqual(wel.area, 'pomedzie');
    assert.deepStrictEqual(wel.tiles.map(t => t.g), D.buildPomedzie(saved.pomedzieSeed));
    c.ws.close();
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
