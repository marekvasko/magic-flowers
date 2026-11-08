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

const SEEDS = Array.from({ length: 100 }, (_, i) => (i * 2654435761 + 17) >>> 0);
const { w: LW, h: LH } = D.areaSize('les');

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

test('Les divov: dvakrát väčší ako záhrada v každom smere, meno a vzhľad prechodu', () => {
  assert.deepStrictEqual(D.areaSize('les'), { w: 2 * D.W, h: 2 * D.H });
  assert.strictEqual(D.AREA_NAMES.les, 'Les divov');
  assert.strictEqual(D.AREA_IN.les, 'v Lese divov');
  assert.ok(D.AREA_FX.les.icon && D.AREA_FX.les.deco.length);
  assert.strictEqual(D.buildLes(1).length, LW * LH);
  // z Lesa na pomedzí na severe sa ide do Lesa divov, z neho na juhu späť
  const north = D.GATES.pomedzie.filter(g => g.to === 'les');
  assert.deepStrictEqual(north.map(g => [g.x, g.y]), D.POMEDZIE_NORTH.map(x => [x, 0]));
  assert.ok(D.GATES.les.every(g => g.to === 'pomedzie' && g.y === LH - 1));
  // veľká mriežka: hranice platia pre jej veľkosť
  assert.ok(Areas.inside('les', LW - 1, LH - 1) && !Areas.inside('les', LW, 0) && !Areas.inside('les', 0, LH));
  assert.ok(!Areas.inside('garden', D.W, 0) && Areas.inside('les', D.W, D.H));
  assert.deepStrictEqual(Areas.clampPos('les', 99, -3), { x: LW - 0.2, y: 0.2 });
  assert.deepStrictEqual(Areas.clampPos('les', 30.5, 60.25), { x: 30.5, y: 60.25 }, 'v lese sa dá ísť aj tam, kde záhrada už končí');
});

test('Les divov: rovnaké semienko = rovnaký les, iné semienko = iný les', () => {
  assert.deepStrictEqual(D.buildLes(123), D.buildLes(123));
  assert.notDeepStrictEqual(D.buildLes(123), D.buildLes(124));
  assert.deepStrictEqual(D.buildArea('les', 9), D.buildLes(9));
});

test('Les divov: každý chodník aj čistina sú dosiahnuteľné od vstupu (100 semienok)', () => {
  for (const seed of SEEDS) {
    const g = D.buildLes(seed), gt = D.GATES.les[0];
    for (const t of D.GATES.les) assert.strictEqual(g[t.y * LW + t.x], 'gate');
    const seen = reach(g, LW, LH, gt.y * LW + gt.x);
    for (let i = 0; i < g.length; i++) if (!D.BLOCK[g[i]]) assert.ok(seen[i], `semienko ${seed}: políčko ${i % LW},${(i / LW) | 0} (${g[i]}) je odrezané`);
    // príchod z Lesa na pomedzí je na voľnom políčku hneď pri prechode
    const a = D.arrival('pomedzie', 'les');
    assert.ok(!D.BLOCK[g[Math.floor(a.y) * LW + Math.floor(a.x)]]);
  }
});

test('Les divov: obrovské stromy na 2 × 2 políčkach, úzke chodníky, čistiny a ozdoby, srdce lesa', () => {
  for (const seed of SEEDS.slice(0, 40)) {
    const g = D.buildLes(seed), at = (x, y) => x >= 0 && y >= 0 && x < LW && y < LH ? g[y * LW + x] : null;
    let giants = 0;
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      const t = at(x, y);
      if (t === 'giant') { giants++; assert.deepStrictEqual([at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)], ['trunk', 'trunk', 'trunk'], `kmeň ${x},${y}`); }
      // každé políčko 'trunk' patrí k obrovi vľavo / hore / vľavo hore
      if (t === 'trunk') assert.ok([[x - 1, y], [x, y - 1], [x - 1, y - 1]].some(([a, b]) => at(a, b) === 'giant'), `kmeň bez stromu ${x},${y}`);
    }
    assert.ok(giants >= 40 && giants <= 95, `obrovské stromy – zhruba každý štvrtý voľný štvorec (${giants})`);
    // chodníky sú úzke: nikde mimo čistín nie je voľný štvorec 3 × 3
    for (let y = 0; y < LH - 2; y++) for (let x = 0; x < LW - 2; x++) {
      let open = true, glade = false;
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) { const t = at(x + dx, y + dy); if (D.BLOCK[t]) open = false; if (t === 'glade' || t === 'fern' || t === 'fungi') glade = true; }
      const atArrival = D.arrivalTiles('les').has((y + 1) * LW + x + 1); // pri vstupe (pod telom hráča) môže byť rázcestie
      const H = D.LES_HEART, heart = Math.hypot((x + 1 - (LW - 1) / 2) / H.rx, (y + 1 - (LH - 1) / 2) / H.ry) < H.ring + 0.1; // riedky les okolo srdca
      if (open && !atArrival && !heart) assert.ok(glade, `semienko ${seed}: široké miesto ${x},${y} mimo čistiny`);
    }
    const share = t => g.filter(v => v === t).length / g.length;
    assert.ok(share('glade') > 0.015, 'čistiny');
    // srdce lesa: stred plochy je veľká čistina
    const mid = at(Math.floor((LW - 1) / 2), Math.floor((LH - 1) / 2));
    assert.ok(['glade', 'fern', 'fungi'].includes(mid), 'srdce lesa ' + mid);
    for (const t of ['path', 'moss', 'fern', 'roots', 'fungi', 'log', 'tree', 'bush']) assert.ok(g.includes(t), t);
    assert.ok(share('path') < 0.35 && share('path') > 0.15, 'chodníky ' + share('path').toFixed(2));
    assert.ok(!g.some(t => ['grass', 'water', 'house', 'stall', 'meadow'].includes(t)), 'v Lese divov sa nič nepestuje ani nekupuje');
  }
});

test('Les divov: slnko len v srdci lesa a kúsok okolo', () => {
  const z = D.sunZone('les');
  assert.deepStrictEqual([z.cx, z.cz], [LW / 2, LH / 2]);
  assert.ok(z.rx > D.LES_HEART.rx && z.rz > D.LES_HEART.ry && z.rx < LW / 2 && z.rz < LH / 2, 'čistina a okolie, nie celá plocha');
  for (const a of ['garden', 'hory', 'pomedzie']) assert.strictEqual(D.sunZone(a), null, a);
});

test('Les divov: temná plocha – dohľad 3 políčka, s lampášom ďalej; inde nie', () => {
  assert.ok(D.isDark('les'));
  for (const a of ['garden', 'hory', 'pomedzie']) assert.ok(!D.isDark(a), a);
  assert.strictEqual(D.DARK.les.sight, 3);
  assert.ok(D.DARK.les.lamp > D.DARK.les.sight);
});

test('cesta do tmy: na severe Lesa na pomedzí postupne pribúda tma Lesa divov, pri prechode je plná', () => {
  const { h } = D.areaSize('pomedzie');
  assert.strictEqual(D.darkAt('les', 0), 1);
  assert.strictEqual(D.darkAt('les', LH - 1), 1);
  for (const a of ['garden', 'hory']) assert.strictEqual(D.darkAt(a, 0), 0, a);
  assert.strictEqual(D.darkAt('pomedzie', h - 1), 0, 'na lúke nič');
  assert.strictEqual(D.darkAt('pomedzie', D.DARK_RAMP.pomedzie.from), 0);
  assert.strictEqual(D.darkAt('pomedzie', 1), 1, 'pri prechode do Lesa divov rovnako ako v ňom');
  assert.strictEqual(D.darkAt('pomedzie', D.arrival('les', 'pomedzie').y), 1, 'aj na príchode z Lesa divov');
  let prev = 0;
  for (let y = h - 1; y >= 0; y -= 0.5) { const v = D.darkAt('pomedzie', y); assert.ok(v >= prev, 'na sever stále tmavšie'); prev = v; }
  assert.ok(D.darkAt('pomedzie', 5) > 0.2 && D.darkAt('pomedzie', 5) < 0.8, 'postupne');
});

test('Les divov: uloží sa celé rozloženie a načíta sa späť; zlé uloženie → zo semienka', () => {
  const room = { les: Areas.loadLes(null, 77) };
  assert.deepStrictEqual(room.les.map(t => t.g), D.buildLes(77));
  const saved = Areas.saveLes(room);
  assert.strictEqual(typeof saved, 'string');
  assert.strictEqual(saved.length, LW * LH);
  // uložené rozloženie má prednosť pred semienkom (generátor sa môže časom zmeniť)
  assert.deepStrictEqual(Areas.loadLes(saved, 1).map(t => t.g), D.buildLes(77));
  assert.deepStrictEqual(Areas.loadLes(saved.slice(1), 5).map(t => t.g), D.buildLes(5), 'krátke uloženie');
  assert.deepStrictEqual(Areas.loadLes('?' + saved.slice(1), 5).map(t => t.g), D.buildLes(5), 'neznámy znak');
  // každý typ zeme Lesa divov má svoj znak
  for (const t of new Set(D.buildLes(3))) assert.ok(Areas.LES_CODE[t], t);
});

test('3D: Les divov – obrovské stromy a kmene ako modely, mriežka podľa veľkosti', () => {
  const les = Areas.loadLes(null, 11);
  const g = W3.buildGrid(les, 1, LW, 'les');
  assert.strictEqual(g.NX, LW * W3.R); assert.strictEqual(g.NZ, LH * W3.R);
  const count = t => les.filter(x => x.g === t).length;
  assert.strictEqual(g.fine.filter(f => f.type === 'giant').length, count('giant'));
  assert.strictEqual(g.fine.filter(f => f.type === 'log').length, count('log'));
  assert.strictEqual(g.fine.filter(f => f.type === 'tree').length, count('tree'));
  assert.ok(g.fine.filter(f => f.type === 'tree').every(f => f.kind !== 'jablon' && f.kind !== 'breza'), 'v Lese divov nie sú jablone ani brezy');
  // obrovský strom: pôdorys 2 × 2 políčka (s okrajom), vyšší než bežný strom, zdieľané dáta rovnakých modelov
  const gi = g.fine.find(f => f.type === 'giant');
  assert.strictEqual(gi.sx, 2 * W3.FINE + W3.FINE);
  assert.ok(gi.sy > 40);
  const kinds = new Set(g.fine.filter(f => f.type === 'giant').map(f => f.data));
  assert.ok(kinds.size <= 12, 'tvary × natočenia, dáta sa zdieľajú: ' + kinds.size);
  // kmeň obra je pevný (náhrada v hrubej mriežke) – cez stred kmeňa lúč slnka neprejde
  const cx = gi.tile.x + 1, cz = gi.tile.y + 1;
  assert.ok(W3.get(g, cx * W3.R, 3, cz * W3.R), 'kmeň je v mriežke');
  // svietiaca živica na každom obrovi (aj v zime)
  assert.ok(W3.EMISSIVE[W3.M.SAP], 'živica svieti');
  for (const f of g.fine.filter(f => f.type === 'giant')) assert.ok(f.data.includes(W3.M.SAP), 'každý obor má živicu');
  // zima: holé konáre so snehom, bez lístia
  const win = W3.buildGrid(les, 3, LW, 'les').fine.find(f => f.type === 'giant');
  assert.ok(win.data.includes(W3.M.SNOW) && !win.data.includes(W3.M.LEAF_DARK));
});

// ---------- Server: migrácia v4 → v5 a cesta Les na pomedzí ↔ Les divov ----------
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
        w.t = setTimeout(() => reject(new Error('správa neprišla')), ms || 4000);
        waiters.push(w);
      });
    }
  };
}

test('server: svet z verzie 4 dostane (cez v7) Les divov (záhrada aj Les na pomedzí ostanú) a hráč prejde z Lesa na pomedzí do Lesa divov a späť', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-les-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  const tiles = D.buildMap().map(() => ({ s: null }));
  const plot = 30 * D.W + 8;
  tiles[plot] = { s: { k: 'normal', w: 1, r: 0, p: { sp: 'mak', prog: 1, q: 3, dry: 0 }, o: 'eva' } };
  const save = {
    v: 4, tick: 1000, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun', pomedzieSeed: 4242,
    saves: { eva: { coins: 77, water: 3, inv: { hoe: 1, can: 1 }, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, plots: 0, composter: 0 }, x: 9.5, y: 1.5, area: 'pomedzie' } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, tiles
  };
  fs.writeFileSync(path.join(dir, 'room-v4.json'), JSON.stringify(save));
  let proc = await startServer(dir, port), lesTiles;
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'v4', name: 'Eva' });
    const wel = await c.wait(m => m.t === 'welcome');
    assert.strictEqual(wel.area, 'pomedzie');
    assert.deepStrictEqual(wel.tiles.map(t => t.g), D.buildPomedzie(4242), 'Les na pomedzí ostal (iba s prechodom na severe)');
    // na prechod na severnom okraji Lesa na pomedzí
    const gn = D.GATES.pomedzie.find(g => g.to === 'les');
    c.send({ t: 'move', x: gn.x + 0.5, y: gn.y + 0.4, dir: 0, ar: wel.seq });
    const toLes = await c.wait(m => m.t === 'area');
    const a = D.arrival('pomedzie', 'les');
    assert.deepStrictEqual([toLes.area, toLes.x, toLes.y, toLes.w, toLes.h], ['les', a.x, a.y, LW, LH]);
    assert.strictEqual(toLes.tiles.length, LW * LH);
    assert.ok(toLes.tiles.some(t => t.g === 'giant') && toLes.tiles.some(t => t.g === 'glade'));
    lesTiles = toLes.tiles.map(t => t.g);
    assert.match((await c.wait(m => m.t === 'toast' && /Lesa divov/.test(m.text))).text, /tma/);
    // veľká plocha: dá sa ísť aj ďaleko za hranice záhrady, ale nie von z mriežky
    c.send({ t: 'move', x: 300, y: 300, dir: 0, ar: toLes.seq });
    if (D.passable(toLes.tiles[(LH - 1) * LW + LW - 1])) { // roh plochy je priechodný: poloha sa udrží na ploche
      const pl = await c.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Eva' && p.area === 'les' && p.x > D.W));
      assert.deepStrictEqual(pl.list.map(p => [p.x, p.y]), [[LW - 0.2, LH - 0.2]]);
    } else { // neprechodná zem: server pohyb odmietne a vráti hráčku na príchodové miesto
      const fix = await c.wait(m => m.t === 'pos');
      assert.deepStrictEqual([fix.x, fix.y], [a.x, a.y]);
    }
    // v Lese divov sa nepestuje
    c.send({ t: 'move', x: a.x, y: a.y, dir: 0, ar: toLes.seq });
    await c.wait(m => m.t === 'pl' && m.list.some(p => p.name === 'Eva' && p.x === a.x));
    c.send({ t: 'act', x: Math.floor(a.x), y: Math.floor(a.y), item: 'hoe' });
    assert.match((await c.wait(m => m.t === 'toast' && /Pestuj/.test(m.text))).text, /Lese divov/);
    // späť cez prechod na juhu
    const gs = D.GATES.les[0];
    c.send({ t: 'move', x: gs.x + 0.5, y: gs.y + 0.5, dir: 0, ar: toLes.seq });
    const back = await c.wait(m => m.t === 'area');
    const b = D.arrival('les', 'pomedzie');
    assert.deepStrictEqual([back.area, back.x, back.y], ['pomedzie', b.x, b.y]);
    assert.strictEqual(Areas.gateTarget(back.tiles, 'pomedzie', b.x, b.y), null, 'po príchode hráčka nestojí na prechode');
    // a znova do Lesa divov – po reštarte servera tam ostane
    c.send({ t: 'move', x: gn.x + 0.5, y: gn.y + 0.4, dir: 0, ar: back.seq });
    await c.wait(m => m.t === 'area' && m.area === 'les');
    c.ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-v4.json'), 'utf8'));
  assert.strictEqual(saved.v, 11);
  assert.strictEqual(saved.migratedFrom, 4);
  assert.strictEqual(saved.pomedzieSeed, 4242);
  assert.ok(Number.isInteger(saved.lesSeed));
  assert.strictEqual(saved.les.length, LW * LH, 'rozloženie Lesa divov je uložené');
  assert.strictEqual(saved.tiles[plot].s.p.sp, 'mak', 'záhrada ostala');
  assert.strictEqual(saved.saves.eva.coins, 77);
  assert.strictEqual(saved.saves.eva.area, 'les');
  // po reštarte: rovnaký les (z uloženia) a hráčka v ňom
  proc = await startServer(dir, port);
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'v4', name: 'Eva' });
    const wel = await c.wait(m => m.t === 'welcome');
    assert.strictEqual(wel.area, 'les');
    assert.deepStrictEqual([wel.w, wel.h], [LW, LH]);
    assert.deepStrictEqual(wel.tiles.map(t => t.g), lesTiles);
    c.ws.close();
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ladiaca stránka: Les divov zo semienka aj z uloženého rozloženia sveta', () => {
  const world = require('../debug/api/world.js');
  const q = o => new URLSearchParams(o);
  const fresh = world(q({ seed: '42', area: 'les' }), { load: () => null });
  assert.deepStrictEqual([fresh.w, fresh.h, fresh.seed], [LW, LH, 42]);
  assert.deepStrictEqual(fresh.tiles.map(t => t.g), D.buildLes(42));
  // svet má uložené rozloženie – to platí, nie semienko (ako v hre)
  const saved = Areas.saveLes({ les: Areas.loadLes(null, 5) });
  const state = { tick: 1, lesSeed: 999, les: saved, saves: {} };
  const r = world(q({ room: 'svet', area: 'les' }), { load: id => ({ id, source: 'file', online: [], state }) });
  assert.strictEqual(r.seed, 999);
  assert.deepStrictEqual(r.tiles.map(t => t.g), D.buildLes(5));
});

test('Les divov: pohľad bližšie na hráča (cestou k nemu postupne)', () => {
  assert.strictEqual(D.viewDiagAt('garden', 10), D.VIEW_DIAG);
  assert.strictEqual(D.viewDiagAt('les', 10), D.DARK.les.viewDiag);
  assert.ok(D.VIEW_DIAG - D.DARK.les.viewDiag >= 4 && D.VIEW_DIAG - D.DARK.les.viewDiag <= 5, 'o 4–5 blokov menej');
  const mid = D.viewDiagAt('pomedzie', 6);
  assert.ok(mid < D.VIEW_DIAG && mid > D.DARK.les.viewDiag, 'cestou do Lesa divov postupne');
  assert.strictEqual(D.viewDiagAt('pomedzie', 1), D.DARK.les.viewDiag);
  const v = D.viewSize(390, 780, D.DARK.les.viewDiag), n = D.viewSize(390, 780);
  assert.ok(Math.abs(Math.hypot(v.w, v.h) - D.DARK.les.viewDiag) < 1e-9 && v.w < n.w);
});
