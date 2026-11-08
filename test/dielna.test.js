// Pavúčí hodváb (#23): izolácia ľadovne prikrývkami, majster hodvábu, Dielňa s krosnami a migrácia pozemku Dielne.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../src/shared/data.ts');
const E = require('../src/server/engine.ts');
const Econ = require('../src/server/economy.ts');
const Events = require('../src/server/events.ts');
const Actions = require('../src/server/actions.js');
const I = require('../src/server/items.ts');
const Ice = require('../src/server/ice.ts');
const Dielna = require('../src/server/dielna.ts');
const TPH = D.TICKS_PER_HOUR, TPD = D.TICKS_PER_DAY, MPT = D.MIN_PER_TICK;
const tickAt = (day, h, m) => (day - 1) * TPD + Math.round(((h * 60) + (m || 0)) / MPT);
const rethrow = err => { throw err; };

const L = D.DIELNA.lot, M = D.MASTER, IL = D.ICEHOUSE.lot;
const DIELNA_AT = { x: L.x0 + 1, y: L.y1 + 1.5 }, MASTER_AT = { x: M.x + 0.5, y: M.y + 1.5 }, ICE_AT = { x: IL.x0 + 1, y: IL.y0 - 0.5 };
// Svet ako na serveri po načítaní (postavená ľadovňa), ana a bob stoja v dedinke
function makeWorld() {
  const w = {
    tick: D.DAWN_TICK + 6, wall: 0, daySeconds: 1200, seed: 'dielna', step: 0, seq: 0, events: [],
    weather: 'sun', saves: {}, storage: {}, storageFb: {}, market: null, contracts: null, fairyNight: -1, eternal: false, scav: {}, scavSalt: 4242,
    icehouse: { built: true, ice: 12, bl: 0 }, dielna: Dielna.newDielna(), redeem: {}, up: { plots: 1 }, glacierFed: -1, plotsUsed: 0, maxRep: 0,
    tiles: D.buildMap().map(g => ({ g, s: null })), hory: Ice.loadHory(null)
  };
  Ice.applyIcehouse(w.icehouse, w.tiles);
  Dielna.applyDielna(w.dielna, w.tiles);
  Econ.initEconomy(w);
  for (const key of ['ana', 'bob']) w.saves[key] = { coins: 2000, water: 5, inv: { hoe: 1, can: 1, silk: 24 }, fb: {}, recipes: [], seen: [], vily: 0, rep: D.REP_LEVELS[2], up: { can: 0, composter: 0 }, area: 'garden' };
  w.presence = [{ key: 'ana', name: 'Ana', area: 'garden', ...DIELNA_AT, scav: null }, { key: 'bob', name: 'Bob', area: 'garden', ...DIELNA_AT, scav: null }];
  return w;
}
const SPEC = { proposers: Object.assign({}, Events.PROPOSERS, Actions.PROPOSERS), periodic: Events.PERIODIC, presence: w => w.presence, onError: rethrow };
let seq = 0;
const act = (type, key, data) => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++seq), actor: key });
const run = (w, ...inputs) => E.commitBatch(w, inputs, SPEC);
const rejected = r => r.rejected.map(x => x.reject);
const at = (w, key, p) => Object.assign(w.presence.find(x => x.key === key), p);
const tile = (x, y) => y * D.W + x;

test('mapa: pozemok Dielne vedľa trhu (2×2) a miesto majstra hodvábu medzi trhom a Dielňou; Dielňa je neprechodná až po stavbe', () => {
  const g = D.buildMap();
  for (let y = L.y0; y <= L.y1; y++) for (let x = L.x0; x <= L.x1; x++) assert.strictEqual(g[tile(x, y)], 'lot');
  assert.strictEqual(g[tile(M.x, M.y)], 'majster');
  assert.strictEqual(g[tile(13, 28)], 'stall', 'trh je hneď vedľa');
  assert.ok(D.BLOCK.dielna && !D.BLOCK.lot && !D.BLOCK.majster, 'miesto majstra je priechodné – majster je postavička, ktorá odchádza');
  assert.ok(!D.TILLABLE.majster, 'na mieste majstra sa nekope');
  const w = makeWorld();
  w.dielna.built = true; Dielna.applyDielna(w.dielna, w.tiles);
  assert.strictEqual(w.tiles.filter(t => t.g === 'dielna').length, 4);
});

test('izolácia: každá úroveň je ťažšia – po 1, 9 a 20 prikrývkach (spolu), ľad sa topí na 75 %, 50 % a 35 %', () => {
  assert.deepStrictEqual(D.ICEHOUSE.blankets, [0, 1, 9, 20]);
  assert.deepStrictEqual([0, 1, 8, 9, 19, 20, 25].map(D.insulLevel), [0, 1, 1, 2, 2, 3, 3]);
  const melted = bl => {
    const h = { built: true, ice: 12, bl }, st = { inv: {}, fb: {} };
    Ice.meltHourly(h, st, 0, 1); // leto
    return +(12 - h.ice).toFixed(4);
  };
  const base = D.ICEHOUSE.melt[1];
  assert.strictEqual(melted(0), +base.toFixed(4));
  assert.strictEqual(melted(1), +(base * 0.75).toFixed(4));
  assert.strictEqual(melted(9), +(base * 0.5).toFixed(4));
  assert.strictEqual(melted(20), +(base * 0.35).toFixed(4));
  // v zime sa netopí ani bez izolácie
  const h = { built: true, ice: 5, bl: 0 }; Ice.meltHourly(h, { inv: {}, fb: {} }, 0, 3); assert.strictEqual(h.ice, 5);
});

test('ľadovňa: ťuknutie s prikrývkou ju izoluje, s ľadom plní, s kvetom vysvetlí, že kvety patria do skladu (#63)', () => {
  const w = makeWorld(), me = at(w, 'ana', ICE_AT), i = tile(IL.x0, IL.y0);
  const r = item => Actions.resolveAct(w, w.presence, me, { x: IL.x0, y: IL.y0, item });
  w.saves.ana.inv.blanket = 1; w.saves.ana.inv.ice = 1; w.saves.ana.inv['fl_' + 'ruza'] = 1;
  assert.strictEqual(w.tiles[i].g, 'icehouse');
  assert.deepStrictEqual(r('blanket'), { type: 'insulate', data: { key: 'ana' } });
  assert.strictEqual(r('ice').type, 'fillIce');
  for (const item of ['fl_ruza', '', 'hoe']) assert.match(r(item).toast, /len ľad.*skladu v domčeku/, item || 'prázdna ruka');
});

test('izolácia: prikrývky sa vkladajú po jednej, úroveň stúpa pri 1, 9 a 20, viac sa nezmestí; treba stáť pri ľadovni', () => {
  const w = makeWorld();
  w.saves.ana.inv.blanket = 21;
  assert.deepStrictEqual(rejected(run(w, act('insulate', 'ana'))), ['Podíď bližšie k ľadovni.']);
  at(w, 'ana', ICE_AT);
  const levels = [];
  for (let k = 0; k < 20; k++) { const out = run(w, act('insulate', 'ana')); assert.strictEqual(out.rejected.length, 0); levels.push(D.insulLevel(w.icehouse.bl)); }
  assert.deepStrictEqual(levels.map((l, k) => l !== levels[k - 1] ? `${k + 1}:${l}` : null).filter(Boolean), ['1:1', '9:2', '20:3']);
  assert.strictEqual(w.saves.ana.inv.blanket, 1);
  assert.match(rejected(run(w, act('insulate', 'ana')))[0], /najlepšie/);
  w.icehouse.bl = 0; delete w.saves.ana.inv.blanket;
  assert.match(rejected(run(w, act('insulate', 'ana')))[0], /Nemáš hodvábnu prikrývku/);
  w.icehouse.built = false; w.saves.ana.inv.blanket = 1;
  assert.match(rejected(run(w, act('insulate', 'ana')))[0], /nie je postavená/);
});

test('majster hodvábu: 6 hodvábu + 100 🪙 = prikrývka hneď; bez hodvábu, mincí alebo ďaleko nič', () => {
  const w = makeWorld(), sv = w.saves.ana;
  at(w, 'ana', ICE_AT);
  assert.deepStrictEqual(rejected(run(w, act('masterWeave', 'ana'))), ['Podíď bližšie k majstrovi hodvábu.']);
  at(w, 'ana', MASTER_AT);
  run(w, act('masterWeave', 'ana'));
  assert.deepStrictEqual([sv.inv.blanket, sv.inv.silk, sv.coins], [1, 18, 1900]);
  sv.inv.silk = 5;
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /6× pavúčí hodváb/);
  sv.inv.silk = 6; sv.coins = 99;
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /100 🪙/);
  assert.deepStrictEqual([sv.inv.blanket, sv.inv.silk, sv.coins], [1, 6, 99]);
});

test('Dielňa: kúpa na trhu (600 🪙, reputácia 2), pozemok dostane budovu; krosná za 300 🪙 sa kupujú v Dielni', () => {
  const w = makeWorld(), sv = w.saves.ana;
  sv.rep = D.REP_LEVELS[1];
  assert.match(rejected(run(w, act('build', 'ana', { id: 'dielna' })))[0], /reputáciu úrovne 2/);
  sv.rep = D.REP_LEVELS[2];
  assert.match(rejected(run(w, act('buyLoom', 'ana')))[0], /Najprv treba postaviť Dielňu/);
  const r = run(w, act('build', 'ana', { id: 'dielna' }), act('build', 'bob', { id: 'dielna' }));
  assert.deepStrictEqual(rejected(r), ['Dielňa už v záhrade stojí.']);
  assert.strictEqual(sv.coins, 1400);
  assert.ok(w.dielna.built && w.tiles.filter(t => t.g === 'dielna').length === 4);
  assert.strictEqual(w.icehouse.built, true, 'ľadovňa ostala');
  run(w, act('buyLoom', 'ana'));
  assert.ok(w.dielna.loom); assert.strictEqual(sv.coins, 1100);
  assert.match(rejected(run(w, act('buyLoom', 'bob')))[0], /už v Dielni sú/);
});

test('Dielňa: na prekopanom pozemku sa nepostaví', () => {
  const w = makeWorld();
  w.tiles[tile(L.x0, L.y0)].s = { k: 'soil', w: 0, r: 0, p: null };
  assert.match(rejected(run(w, act('build', 'ana', { id: 'dielna' })))[0], /prekopaná zem/);
  assert.ok(!w.dielna.built);
});

test('krosná: tkajú 2–4 herné hodiny, naraz jednu prikrývku; hotová čaká v Dielni na tkáča', () => {
  const w = makeWorld();
  w.dielna.built = true; w.dielna.loom = true; Dielna.applyDielna(w.dielna, w.tiles);
  const t0 = w.tick;
  const r = run(w, act('loomStart', 'ana'), act('loomStart', 'bob'));
  assert.match(rejected(r)[0], /pre niekoho iného/);
  assert.strictEqual(w.saves.ana.inv.silk, 18); assert.strictEqual(w.saves.bob.inv.silk, 24);
  const job = w.dielna.job;
  assert.strictEqual(job.key, 'ana');
  assert.ok(job.at >= t0 + 2 * TPH && job.at <= t0 + 4 * TPH, `hotová o ${(job.at - t0) / TPH} h`);
  assert.ok(E.pending(w, 'loomDone:ana'));
  assert.match(rejected(run(w, act('loomStart', 'ana')))[0], /už tkajú/);
  assert.match(rejected(run(w, act('loomTake', 'ana')))[0], /nečaká/);
  E.advanceTo(w, job.at, SPEC);
  assert.strictEqual(w.dielna.job, null);
  assert.deepStrictEqual(w.dielna.ready, { ana: 1 });
  assert.match(rejected(run(w, act('loomTake', 'bob')))[0], /nečaká/);
  at(w, 'ana', { x: 1, y: 1 });
  assert.deepStrictEqual(rejected(run(w, act('loomTake', 'ana'))), ['Podíď bližšie k Dielni.']);
  at(w, 'ana', DIELNA_AT);
  run(w, act('loomTake', 'ana'));
  assert.strictEqual(w.saves.ana.inv.blanket, 1);
  assert.deepStrictEqual(w.dielna.ready, {});
  run(w, act('loomStart', 'bob'));
  assert.strictEqual(w.dielna.job.key, 'bob', 'krosná sú voľné pre ďalšieho');
});

test('krosná: čas tkania je náhodný medzi 2 a 4 hodinami', () => {
  const d = { built: true, loom: true, job: null, ready: {} }, sv = { inv: { silk: 6 }, fb: {} };
  assert.strictEqual(Dielna.loomStart(d, sv, 'a', 100, 0).at, 100 + 2 * TPH);
  d.job = null; sv.inv.silk = 6;
  assert.strictEqual(Dielna.loomStart(d, sv, 'a', 100, 0.99999).at, 100 + 4 * TPH);
});

test('migrácia: čo stálo na pozemku Dielne a na mieste majstra, sa odstráni a dostane to prvý hráč, ktorý príde', () => {
  const saved = D.buildMap().map(() => ({ s: null }));
  const sp = 'ruza', S = D.SPECIES[sp];
  saved[tile(L.x0, L.y0)].s = { k: 'soil', w: 1, r: 1, p: { sp, prog: S.days, q: 2, dry: 0 } }; // kvitne, pohnojená → 3 kvety
  saved[tile(L.x1, L.y0)].s = { k: 'soil', w: 1, r: 0, p: { sp: 'mak', prog: 1, q: 3, dry: 0, wild: 1 } }; // rastie → semienko
  saved[tile(L.x0, L.y1)].s = { k: 'soil', w: 0, r: 1, p: null }; // pohnojená zem → kompost
  saved[tile(L.x1, L.y1)].s = { k: 'soil', w: 0, r: 0, p: { sp, prog: 2, q: 1, dry: 3, d: 1 } }; // uhynutá → nič
  saved[tile(M.x, M.y)].s = { k: 'soil', w: 0, r: 0, p: null }; // holá zem → nič
  const other = tile(5, 20); saved[other].s = { k: 'soil', w: 0, r: 0, p: null };
  const redeem = Dielna.clearForDielna(saved);
  assert.deepStrictEqual(redeem, { fl_ruza: 3, seed_mak: 1, compost: 1 });
  for (const i of Dielna.clearedIdx()) assert.strictEqual(saved[i].s, null);
  assert.ok(saved[other].s, 'iné políčka ostanú');
  assert.deepStrictEqual(Dielna.clearForDielna(null), {}, 'svet bez uložených políčok');

  const w = makeWorld();
  w.redeem = redeem;
  delete w.saves.ana;
  const out = run(w, act('join', 'ana', { name: 'Ana', start: { coins: 30, rep: 0 } }));
  const inv = w.saves.ana.inv;
  assert.deepStrictEqual([inv.fl_ruza, inv.seed_mak, inv.compost], [3, 1, 1]);
  assert.ok(out.outbox.some(m => m.to === 'ana' && /Dielňu/.test(m.text)));
  assert.deepStrictEqual(w.redeem, {});
  run(w, act('join', 'bob', { name: 'Bob' }));
  assert.ok(!w.saves.bob.inv.fl_ruza, 'druhý hráč už nič nedostane');
});

test('majster hodvábu: len na jar a na jeseň; cez deň pri trhu, na noc ide k babke do chalúpky, ráno sa vráti', () => {
  const se = D.DAYS_PER_SEASON, M = D.MASTER;
  const spring = 1, summer = 1 + se, autumn = 1 + 2 * se, winter = 1 + 3 * se;
  assert.strictEqual(D.masterAt(summer, 12 * 60), null);
  assert.strictEqual(D.masterAt(winter, 12 * 60), null);
  for (const day of [spring, autumn]) {
    assert.deepStrictEqual(pick(D.masterAt(day, 6 * 60)), { x: M.x + 0.5, y: M.y + 0.5, still: true, where: 'market' });
    assert.strictEqual(D.masterAt(day, 20 * 60 + 59).where, 'market');
    const walk = D.masterAt(day, 21 * 60 + 15);
    assert.ok(!walk.still && walk.where === 'road' && walk.to === 'hut');
    assert.strictEqual(D.masterAt(day, 5 * 60 + 40).to, 'market');
    assert.notStrictEqual(D.masterRoadText(walk), D.masterRoadText(D.masterAt(day, 5 * 60 + 40)), 'odchod a príchod majú iný text');
    assert.deepStrictEqual(pick(D.masterAt(day, 23 * 60)), { x: M.hut.x + 0.5, y: M.hut.y + 0.5, still: true, where: 'hut' });
    assert.strictEqual(D.masterAt(day, 3 * 60).where, 'hut');
    assert.strictEqual(D.masterAt(day, 5 * 60 + 45).where, 'road');
  }
  // cesta vedie len po priechodných políčkach a končí pri chalúpke babky
  const g = D.buildMap();
  for (const [x, y] of M.route) assert.ok(!D.BLOCK[g[Math.floor(y) * D.W + Math.floor(x)]], `${x},${y}`);
  for (let m = 21 * 60; m <= 21 * 60 + M.walk; m++) { const p = D.masterAt(spring, m); assert.ok(!D.BLOCK[g[Math.floor(p.y) * D.W + Math.floor(p.x)]], 'minúta ' + m); }
  assert.strictEqual(g[M.hut.y * D.W + M.hut.x], 'path');
  assert.ok(Math.hypot(M.hut.x - D.BABKA.x, M.hut.y - D.BABKA.y) <= 1.5, 'stojí pri babke');
});
function pick(m) { return { x: m.x, y: m.y, still: m.still, where: m.where }; }

test('majster hodvábu: v noci tká u babky, na trhu vtedy nie je; v lete ani v zime tu nie je vôbec', () => {
  const w = makeWorld(), sv = w.saves.ana, M = D.MASTER;
  w.tick = tickAt(1, 23); // jar, noc
  at(w, 'ana', MASTER_AT);
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /u babky v chalúpke/);
  at(w, 'ana', { x: M.hut.x + 0.5, y: M.hut.y + 1.5 });
  run(w, act('masterWeave', 'ana'));
  assert.strictEqual(sv.inv.blanket, 1);
  w.tick = tickAt(1, 21, 10); // večer odchádza k babke
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /pobral na noc k babke/);
  w.tick = tickAt(2, 5, 45); // ráno prichádza na trh
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /vracia na trh/);
  w.tick = tickAt(1 + D.DAYS_PER_SEASON, 12); // leto
  at(w, 'ana', MASTER_AT);
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /len na jar a na jeseň/);
  assert.strictEqual(sv.inv.blanket, 1);
});

test('majster hodvábu: keď sú v Dielni krosná, už nepríde (ani cez deň na jar)', () => {
  const w = makeWorld();
  at(w, 'ana', MASTER_AT);
  assert.ok(D.masterAt(1, 12 * 60, false) && D.masterAt(1, 12 * 60, true) === null);
  w.dielna.built = true; w.dielna.loom = true; Dielna.applyDielna(w.dielna, w.tiles);
  assert.match(rejected(run(w, act('masterWeave', 'ana')))[0], /majster hodvábu do dedinky nechodí/);
  assert.ok(!w.saves.ana.inv.blanket);
});

test('mená postáv: Babka a Majster hodvábu sú vyhradené (veľké písmená, diakritika, skrátené na 14 znakov)', () => {
  for (const n of ['Babka', 'babka', 'BÁBKA', ' Babka ', 'Babka bylinkárka', 'Majster', 'Majster hodvábu', 'majster hodvabu', 'Majster hodváb'])
    assert.ok(D.reservedName(n), n);
  for (const n of ['Babkin vnuk', 'Babička', 'Majo', 'Ana', '', 'Majster hod']) assert.ok(!D.reservedName(n), n);
});

// Server: prihlásenie menom postavy z hry
function freePort() { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); }); }
function startServer(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server sa nespustil')), 8000);
    proc.stdout.on('data', d => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + c)); });
  });
}
function stopServer(proc) { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); }); }
// Pripojí sa menom name; vráti prvú odpoveď servera, ktorá rozhodne: welcome alebo error (a či server spojenie zavrel)
function tryJoin(port, room, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    let res = null;
    const t = setTimeout(() => reject(new Error('bez odpovede: ' + name)), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name })));
    ws.on('message', raw => { const m = JSON.parse(raw); if (!res && (m.t === 'welcome' || m.t === 'error')) { res = m; if (m.t === 'welcome') { clearTimeout(t); ws.close(); resolve({ m, closed: false }); } } });
    ws.on('close', () => { clearTimeout(t); if (res && res.t === 'error') resolve({ m: res, closed: true }); });
  });
}

test('server: nový hráč s menom Babka či Majster hodvábu sa neprihlási (chyba, žiadne uloženie); kto už tak hrá, o záhradu nepríde', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-mena-'));
  const port = await freePort();
  let proc = await startServer(dir, port);
  try {
    for (const name of ['Babka', 'bábka', 'Majster hodvábu', 'Majster Hodvabu']) {
      const r = await tryJoin(port, 'mena', name);
      assert.strictEqual(r.m.t, 'error', name);
      assert.match(r.m.text, /patrí postave v hre/);
      assert.ok(r.closed, 'server spojenie zavrie');
    }
    assert.strictEqual((await tryJoin(port, 'mena', 'Ana')).m.t, 'welcome');
    await new Promise(r => setTimeout(r, 400));
  } finally { await stopServer(proc); }
  // svet sa uložil bez uložení postáv; potom doň pridáme hráča „Babka“ zo staršej verzie hry
  const file = path.join(dir, 'room-mena.json'), w = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(w.saves), ['ana']);
  w.saves.babka = JSON.parse(JSON.stringify(w.saves.ana));
  fs.writeFileSync(file, JSON.stringify(w));
  proc = await startServer(dir, port);
  try {
    const r = await tryJoin(port, 'mena', 'Babka');
    assert.strictEqual(r.m.t, 'welcome', 'existujúci hráč Babka sa prihlási do svojej záhrady');
    assert.strictEqual((await tryJoin(port, 'mena', 'Majster hodváb')).m.t, 'error', 'nový hráč ani so skráteným menom');
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
