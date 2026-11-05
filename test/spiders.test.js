const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const Sp = require('../spiders.js');
const Webs = require('../shared/webs.js');

const TPD = D.TICKS_PER_DAY, LW = D.LES_W, LH = D.LES_H;
const SEASON_TICK = se => se * D.DAYS_PER_SEASON * TPD + D.DAWN_TICK; // prvé ráno obdobia se
const SEEDS = Array.from({ length: 30 }, (_, i) => (i * 2654435761 + 17) >>> 0);

// Zachytené správy pre hráčov (toasty, spomalenie, odhodenie)
let sent = [];
Sp.setHooks({
  toast(pl, text) { sent.push({ pl: pl.id, t: 'toast', text }); },
  sendMe() {},
  send(pl, m) { sent.push(Object.assign({ pl: pl.id }, m)); },
  broadcastArea() {}
});
function mkRoom(seed, tick) {
  const room = {
    tick: tick == null ? SEASON_TICK(2) : tick, rng: 12345, seq: 0, events: [], players: new Map(), icehouse: { built: false, ice: 0 },
    les: D.buildLes(seed).map(g => ({ g })), lesSeed: seed, tiles: D.buildMap().map(g => ({ g, s: null })), hory: D.buildMountains().map(g => ({ g }))
  };
  Sp.load(room, null);
  return room;
}
function player(room, id, x, y, silk, area) {
  const p = { id, key: 'p' + id, area: area || 'les', x, y, lp: false, save: { inv: silk ? { silk } : {} } };
  room.players.set(id, p);
  return p;
}
const pathDist = (les, from) => {
  const dist = new Int16Array(LW * LH).fill(-1), q = [from];
  dist[from] = 0;
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * LW + nx;
      if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || dist[n] >= 0 || D.BLOCK[les[n].g]) continue;
      dist[n] = dist[i] + 1; q.push(n);
    }
  }
  return dist;
};
// beh simulácie: n krokov po 100 ms
function run(room, from, n, each) { let now = from; for (let k = 0; k < n; k++) { now += 100; if (each) each(now); Sp.update(room, now, 0.1); } return now; }

test('pavúky: 6 vlčiakov s norami ďaleko od seba, stará pradlena na čistine najďalej od vstupu', () => {
  for (const seed of SEEDS) {
    const les = D.buildLes(seed).map(g => ({ g })), f = Sp.analyze(les, seed);
    const v = f.homes.filter(h => h.k === 'v'), p = f.homes.filter(h => h.k === 'p');
    assert.strictEqual(v.length, D.SPIDERS.vlciak.n, `seed ${seed}: 6 vlčiakov`);
    assert.strictEqual(p.length, 1, `seed ${seed}: jedna pradlena`);
    assert.strictEqual(f.homes[f.homes.length - 1].k, 'p', 'pradlena je posledná');
    for (const a of v) for (const b of v) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= D.SPIDERS.vlciak.gap);
    assert.strictEqual(les[p[0].i].g, 'glade');
    // rovnaký les → rovnaké nory
    assert.deepStrictEqual(Sp.analyze(les, seed).homes, f.homes);
  }
});

test('pavúky: územia – len do 10 krokov od nory, nikdy pri vstupe ani v slnečnom srdci lesa', () => {
  const H = D.LES_HEART, hx = (LW - 1) / 2, hy = (LH - 1) / 2;
  for (const seed of SEEDS.slice(0, 10)) {
    const les = D.buildLes(seed).map(g => ({ g })), f = Sp.analyze(les, seed);
    const gate = les.findIndex(t => t.g === 'gate'), ent = pathDist(les, gate);
    f.homes.forEach((h, o) => {
      const d = pathDist(les, h.i);
      for (let i = 0; i < f.owner.length; i++) {
        if (f.owner[i] !== o) continue;
        assert.ok(!D.BLOCK[les[i].g], 'územie je priechodné');
        if (h.k === 'v') assert.ok(d[i] >= 0 && d[i] <= D.SPIDERS.vlciak.reach, 'do 10 krokov po chodníku');
        assert.ok(ent[i] > D.SPIDERS.entrance, 'nie pri vstupe');
        assert.ok(Math.hypot((i % LW - hx) / (H.rx + 1), (((i / LW) | 0) - hy) / (H.ry + 1)) > 1, 'nie v srdci lesa');
      }
    });
  }
});

test('pavučiny: medzi dvoma oporami, najviac 2 políčka (na čistine 3), celé v území majiteľa', () => {
  for (const seed of SEEDS.slice(0, 10)) {
    const les = D.buildLes(seed).map(g => ({ g })), f = Sp.analyze(les, seed);
    let total = 0;
    f.cands.forEach((list, o) => {
      for (const c of list) {
        total++;
        assert.ok(c.n >= 1 && c.n <= (c.tiles.some(i => les[i].g === 'glade') ? Webs.WEB_PARAMS.gladeSpan.def : Webs.WEB_PARAMS.span.def));
        assert.deepStrictEqual(c.tiles, Sp.webTiles(c));
        for (const i of c.tiles) { assert.strictEqual(f.owner[i], o); assert.ok(!D.BLOCK[les[i].g] && les[i].g !== 'gate'); }
        const [sx, sy] = c.ax ? [0, 1] : [1, 0];
        assert.ok(D.WEB_ANCHOR[les[(c.y - sy) * LW + c.x - sx].g], 'opora pred');
        assert.ok(D.WEB_ANCHOR[les[(c.y + sy * c.n) * LW + c.x + sx * c.n].g], 'opora za');
      }
    });
    assert.ok(total > 60, `seed ${seed}: dosť miest na pavučiny (${total})`);
  }
});

test('pavučiny: počet podľa obdobia, roztrhnutú majiteľ utká znova o deň, v zime ich ubudne', () => {
  const room = mkRoom(SEEDS[0], SEASON_TICK(2)); // jeseň
  const f = room.spf, count = o => room.spid.webs.filter(w => w.o === o).length;
  f.homes.forEach((h, o) => assert.ok(count(o) <= D.WEB.count[h.k === 'p' ? 'pradlena' : 'vlciak'][2]));
  assert.strictEqual(count(0), 3, 'vlčiak má v jeseni 3 pavučiny');
  // pavučiny sa neprekrývajú
  const used = new Set();
  for (const w of room.spid.webs) for (const i of Sp.webTiles(w)) { assert.ok(!used.has(i)); used.add(i); }
  // roztrhnutie → udalosť 'weave' o deň
  const wb = room.spid.webs.find(w => w.o === 0);
  Sp.tear(room, wb);
  assert.strictEqual(count(0), 2);
  const ev = room.events.find(e => e.type === 'weave');
  assert.deepStrictEqual([ev.at, ev.data.o], [room.tick + D.WEB.reweave, 0]);
  room.tick = ev.at; room.events = room.events.filter(e => e !== ev);
  Sp.onWeave(room, ev.data);
  assert.strictEqual(count(0), 3, 'znova utkaná');
  // príchod zimy: nadbytočné pavučiny zmiznú, čakajúce dotkanie sa zruší
  Sp.tear(room, room.spid.webs.find(w => w.o === 1));
  room.tick = SEASON_TICK(3);
  Sp.balance(room);
  assert.strictEqual(count(0), 1);
  assert.strictEqual(count(1), 1);
  assert.strictEqual(room.events.filter(e => e.type === 'weave' && e.data.o === 1).length, 0);
  // jar: dotkajú sa hneď
  room.tick = SEASON_TICK(4);
  Sp.balance(room);
  assert.strictEqual(count(0), 2);
});

test('ťahanie hodvábu: +1 hodváb, šanca na povšimnutie 20 % / 50 % / vždy, tretie potiahnutie pavučinu roztrhne', () => {
  const room = mkRoom(SEEDS[1]);
  const wb = room.spid.webs.find(w => w.o === 0), t = Sp.webTiles(wb)[0];
  const p = player(room, 1, t % LW + 0.5, ((t / LW) | 0) + 1.5, 0);
  const s = Sp.spiders(room)[0];
  assert.match(Sp.startPull(room, Object.assign({}, p, { lp: true }), wb, 0), /lampášom/);
  assert.strictEqual(Sp.startPull(room, p, wb, 0), null);
  let r = Sp.finishPull(room, p, 0, 0.21);
  assert.deepStrictEqual(r, { torn: false, noticed: false });
  assert.strictEqual(p.save.inv.silk, 1);
  assert.strictEqual(s.st, 'home', '21 % > 20 % – nevšimol si');
  Sp.startPull(room, p, wb, 0);
  r = Sp.finishPull(room, p, 0, 0.49);
  assert.deepStrictEqual(r, { torn: false, noticed: true });
  assert.strictEqual(s.st, 'alert');
  assert.strictEqual(s.tgt, p.id);
  s.st = 'home';
  Sp.startPull(room, p, wb, 0);
  r = Sp.finishPull(room, p, 0, 0.999);
  assert.deepStrictEqual(r, { torn: true, noticed: true }, 'posledné potiahnutie si všimne vždy');
  assert.strictEqual(p.save.inv.silk, 3);
  assert.ok(!room.spid.webs.includes(wb), 'roztrhnutá');
  assert.ok(room.events.some(e => e.type === 'weave' && e.data.o === 0));
});

test('vbehnutie do pavučiny: lepí sa, pavučina sa roztrhne bez hodvábu a majiteľ sa rozbehne k nej', () => {
  const room = mkRoom(SEEDS[2]);
  const wb = room.spid.webs.find(w => w.o === 2), t = Sp.webTiles(wb)[0];
  const p = player(room, 1, t % LW + 0.5, ((t / LW) | 0) + 0.5, 0);
  sent = [];
  Sp.checkWalk(room, p, 1000);
  assert.ok(!room.spid.webs.includes(wb));
  assert.ok(!p.save.inv.silk);
  assert.ok(sent.some(m => m.t === 'slow' && m.k === D.WEB.stick && m.ms === D.WEB.stickMs));
  assert.strictEqual(Sp.spiders(room)[2].st, 'alert');
});

// Hráč stojí na políčku územia vlčiaka o, ktoré je `steps` krokov od nory
function terrTile(room, o, pred) {
  const f = room.spf, h = f.homes[o], d = pathDist(room.les, h.i);
  for (let i = 0; i < f.owner.length; i++) if (f.owner[i] === o && pred(d[i], i)) return i;
  return -1;
}
const center = i => ({ x: i % LW + 0.5, y: ((i / LW) | 0) + 0.5 });

test('vlčiak: chytí hráča, berie hodváb každé 3 s (najviac 3), lampáš ho odplaší a hodváb vráti', () => {
  const room = mkRoom(SEEDS[3]);
  const s = Sp.spiders(room)[0], h = room.spf.homes[0];
  const p = player(room, 1, h.x + 0.5, h.y + 0.5, 5);
  sent = [];
  let now = run(room, 0, 3);
  assert.strictEqual(s.st, 'cling');
  assert.strictEqual(p.save.inv.silk, 4, 'vzal 1 hneď');
  assert.ok(sent.some(m => m.t === 'slow' && m.k === D.SPIDERS.vlciak.slow));
  now = run(room, now, 31, n => { p.x = s.x; p.y = s.y; });
  assert.strictEqual(p.save.inv.silk, 3, 'po 3 s ďalší');
  // lampáš: pustí sa, hodváb vráti, drží sa ďalej ako 2,5 políčka
  p.lp = true;
  now = run(room, now, 1);
  assert.strictEqual(p.save.inv.silk, 5);
  assert.notStrictEqual(s.st, 'cling');
  now = run(room, now, 15);
  assert.ok(Math.hypot(s.x - p.x, s.y - p.y) >= D.SPIDERS.lamp - 0.6, 'kraj svetla');
  // lampáš dole: o 2 s sa vráti a chytí
  p.lp = false;
  now = run(room, now, 50);
  assert.strictEqual(s.st, 'cling');
  // bez lampáša: vezme najviac 3 a pustí sa
  now = run(room, now, 80, n => { p.x = s.x; p.y = s.y; });
  assert.strictEqual(p.save.inv.silk, 2, '5 − 3');
  assert.ok(['return', 'home'].includes(s.st), 'pustil sa a ide domov');
});

test('vlčiak: za hranicou územia to po 2 s vzdá, stratený hráč po 4 s', () => {
  const room = mkRoom(SEEDS[4]);
  const s = Sp.spiders(room)[1], f = room.spf;
  // hráč tesne za hranicou územia
  let out = -1;
  for (let i = 0; i < f.owner.length && out < 0; i++) {
    if (f.owner[i] !== 1) continue;
    const x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = (y + dy) * LW + x + dx; if (!D.BLOCK[room.les[n].g] && f.owner[n] !== 1) { out = n; break; } }
  }
  const p = player(room, 1, center(out).x, center(out).y, 2);
  Sp.spiders(room); s.st = 'chase'; s.tgt = 1; s.seen = 0; s.border = 0;
  let now = run(room, 0, 15);
  assert.strictEqual(s.st, 'chase', 'chvíľu čaká na hranici');
  now = run(room, now, 12);
  assert.ok(['return', 'home'].includes(s.st), 'vzdal to');
  // stratený: hráč je v území, ale už 4 s ďalej než 4 políčka → vzdá to
  const far = terrTile(room, 1, (d, i) => Math.hypot(center(i).x - room.spf.homes[1].x - 0.5, center(i).y - room.spf.homes[1].y - 0.5) > 5);
  Object.assign(s, { x: room.spf.homes[1].x + 0.5, y: room.spf.homes[1].y + 0.5, st: 'chase', tgt: 1, seen: now - 3900, path: null });
  Object.assign(p, center(far));
  now = run(room, now, 1);
  assert.strictEqual(s.st, 'chase', 'ešte nie');
  now = run(room, now, 2);
  assert.ok(['return', 'home'].includes(s.st), 'stratil ho');
  // pustí sa aj vtedy, keď ho hráč vynesie za hranicu územia
  const h = room.spf.homes[1];
  Object.assign(p, { x: h.x + 0.5, y: h.y + 0.5 });
  Object.assign(s, { x: h.x + 0.5, y: h.y + 0.5, st: 'cling', tgt: 1, taken: 1, next: now + 3000 });
  Object.assign(p, center(out));
  now = run(room, now, 1);
  assert.ok(['return', 'home'].includes(s.st));
  assert.strictEqual(room.spf.owner[Math.floor(s.y) * LW + Math.floor(s.x)], 1, 'ostal vo svojom území');
});

test('stará pradlena: na pavučinu siahnutú na jej čistine príde pomaly, uhryzne (3 hodváb) a odhodí za okraj; lampáš ju odtláča', () => {
  const room = mkRoom(SEEDS[5]);
  const o = room.spf.homes.length - 1, s = Sp.spiders(room)[o], h = room.spf.homes[o];
  const p = player(room, 1, h.x + 2.5, h.y + 0.5, 5);
  if (room.spf.owner[Math.floor(p.y) * LW + Math.floor(p.x)] !== o) Object.assign(p, { x: h.x + 0.5, y: h.y + 1.5 });
  // bez dotyku pavučiny si hráča nevšíma
  let now = run(room, 0, 20);
  assert.strictEqual(s.st, 'home');
  const wb = room.spid.webs.find(w => w.o === o) || { id: -1, x: h.x, y: h.y, ax: 0, n: 1, o };
  Sp.alert(room, wb, p, now);
  sent = [];
  now = run(room, now, 60);
  assert.ok(sent.some(m => m.t === 'shove'), 'odhodila');
  assert.strictEqual(p.save.inv.silk, 2);
  const sh = sent.find(m => m.t === 'shove');
  assert.notStrictEqual(room.spf.owner[Math.floor(sh.y) * LW + Math.floor(sh.x)], o, 'za okraj jej územia');
  // lampáš: odtláča ju rýchlosťou 0,5 políčka/s (dva lampáše dvakrát rýchlejšie)
  Object.assign(s, { x: h.x + 0.5, y: h.y + 0.5, st: 'chase', tgt: 1, cool: 0 });
  Object.assign(p, { x: h.x + 1.5, y: h.y + 0.5, lp: true });
  if (room.spf.owner[Math.floor(p.y) * LW + Math.floor(p.x)] !== o) Object.assign(p, { x: h.x + 0.5, y: h.y + 1.5 });
  const d0 = Math.hypot(s.x - p.x, s.y - p.y);
  now = run(room, now, 10);
  const d1 = Math.hypot(s.x - p.x, s.y - p.y);
  assert.ok(d1 > d0 && d1 - d0 <= D.SPIDERS.pradlena.push * 1 + 0.05, `odtlačená pomaly (${(d1 - d0).toFixed(2)})`);
});

test('krížiak: kúty pri koncoch stien, najviac 3 pavučiny na plochu, odstránením sa nič nezíska', () => {
  for (const area of D.CORNER_AREAS) {
    const tiles = D.buildArea(area, 1).map(g => ({ g })), list = Sp.cornerSpots(tiles, D.W, D.H);
    assert.ok(list.length >= 4, area + ': dosť kútov');
    for (const s of list) {
      assert.ok(D.passable(tiles[s.i]) && tiles[s.i].g !== 'gate');
      assert.ok(D.CORNER_WALL[tiles[(s.y + s.dy) * D.W + s.x + s.dx].g], 'vedľa je stena');
      assert.ok(!D.CORNER_WALL[tiles[(s.y + s.dy + s.ey) * D.W + s.x + s.dx + s.ex].g], 'stena sa tu končí');
    }
  }
  const room = mkRoom(SEEDS[6]);
  assert.strictEqual(room.spid.corner.garden.length, 1, 'nový svet má v kúte jednu pavučinu');
  // bez hráčov sa pavučina rovno objaví (náhoda pod šancou), najviac 3
  for (let k = 0; k < 200; k++) { room.rng = 1; Sp.hourlyCorners(room); }
  assert.ok(room.spid.corner.garden.length <= D.SPIDERS.kriziak.max);
  room.rng = 7;
  for (let k = 0; k < 2000 && room.spid.corner.garden.length < 3; k++) Sp.hourlyCorners(room);
  assert.strictEqual(room.spid.corner.garden.length, 3);
  const c = Sp.cornerList(room, 'garden')[0];
  assert.ok(Sp.clearCorner(room, 'garden', c.i));
  assert.strictEqual(room.spid.corner.garden.length, 2);
  assert.strictEqual(Sp.clearCorner(room, 'garden', c.i), null);
});

test('krížiak: keď je hráč na ploche, beží rýchlo do kúta (5 políčok/s) a pri hráčovi ujde bez pavučiny', () => {
  const room = mkRoom(SEEDS[7]);
  room.spid.corner.garden = [];
  const spot = Sp.spots(room, 'garden')[0];
  const p = player(room, 1, 0.5, 0.5, 0, 'garden');
  assert.ok(Sp.startKriziak(room, 'garden', spot));
  const z = room.kz.garden;
  assert.ok(z.path.length >= 8);
  let now = 0, moved = 0, prev = { x: z.x, y: z.y };
  for (let k = 0; k < 400 && room.kz.garden; k++) {
    now += 100; Sp.updateKriziak(room, now, 0.1);
    if (room.kz.garden) { moved = Math.max(moved, Math.hypot(z.x - prev.x, z.y - prev.y)); prev = { x: z.x, y: z.y }; }
  }
  assert.ok(Math.abs(moved - D.SPIDERS.kriziak.run * 0.1) < 0.02, 'rýchlosť ' + moved);
  assert.deepStrictEqual(room.spid.corner.garden, [spot.k], 'dobehol a utkal');
  // zľakne sa hráča
  room.spid.corner.garden = [];
  Sp.startKriziak(room, 'garden', spot);
  Object.assign(p, { x: room.kz.garden.x + 1, y: room.kz.garden.y });
  for (let k = 0; k < 20; k++) { now += 100; Sp.updateKriziak(room, now, 0.1); }
  assert.ok(!room.kz.garden, 'ušiel');
  assert.deepStrictEqual(room.spid.corner.garden, [], 'pavučinu neutkal');
});

test('uloženie: pavučiny a kúty sa po načítaní zachovajú, neplatné sa zahodia', () => {
  const room = mkRoom(SEEDS[8]);
  const saved = JSON.parse(JSON.stringify(Sp.save(room)));
  saved.webs.push({ id: 999, x: 0, y: 0, ax: 0, n: 2, silk: 3, o: 0 }); // na okraji lesa – nesedí na mapu
  saved.corner.garden.push('nie-je-kut');
  const r2 = Object.assign({}, room, { spf: null, spid: null, events: room.events.slice() });
  Sp.load(r2, saved);
  assert.deepStrictEqual(r2.spid.webs.map(w => w.id).sort((a, b) => a - b), room.spid.webs.map(w => w.id).sort((a, b) => a - b));
  assert.deepStrictEqual(r2.spid.corner.garden, room.spid.corner.garden);
});

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

test('server: svet z verzie 7 dostane pavučiny; v lese sa ťahá hodváb, s lampášom nie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-spiders-'));
  const port = 43000 + Math.floor(Math.random() * 2000);
  const lesSeed = 777, f = Sp.analyze(D.buildLes(lesSeed).map(g => ({ g })), lesSeed);
  const save = {
    v: 7, tick: SEASON_TICK(2), wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun', pomedzieSeed: 1, lesSeed, les: null,
    saves: { eva: { coins: 5, water: 3, inv: { hoe: 1, can: 1, lamp: 1 }, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 0 }, x: 1, y: 1, area: 'les' } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, up: { plots: 0 }
  };
  fs.writeFileSync(path.join(dir, 'room-sp.json'), JSON.stringify(save));
  const proc = await startServer(dir, port);
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port), msgs = [];
    ws.on('message', raw => msgs.push(JSON.parse(raw)));
    await new Promise(r => ws.on('open', r));
    const wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { const k = msgs.findIndex(pred); if (k >= 0) return msgs.splice(k, 1)[0]; await new Promise(r => setTimeout(r, 20)); } throw new Error('správa neprišla'); };
    ws.send(JSON.stringify({ t: 'join', room: 'sp', name: 'Eva' }));
    const wel = await wait(m => m.t === 'welcome');
    const webs = await wait(m => m.t === 'webs');
    assert.ok(webs.webs.length >= 15, 'v jeseni je les plný pavučín');
    assert.deepStrictEqual(webs.homes.map(h => [h.k, h.x, h.y]), f.homes.map(h => [h.k, h.x, h.y]));
    // postaví sa vedľa pavučiny (na susedné voľné políčko mimo nej)
    const wb = webs.webs[0], t = wb.y * LW + wb.x;
    const tiles = wel.tiles, side = wb.ax ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    const [dx, dy] = side.find(([dx, dy]) => !D.BLOCK[tiles[t + dy * LW + dx].g]);
    const at = { x: wb.x + dx + 0.5, y: wb.y + dy + 0.5 };
    ws.send(JSON.stringify({ t: 'move', x: at.x, y: at.y, dir: 0, lp: true, ar: wel.seq }));
    await wait(m => m.t === 'pl' && m.list.some(p => p.x === at.x && p.y === at.y));
    ws.send(JSON.stringify({ t: 'act', x: wb.x, y: wb.y, item: 'lamp' }));
    assert.match((await wait(m => m.t === 'toast' && /lampáš/.test(m.text))).text, /neutrhneš/);
    ws.send(JSON.stringify({ t: 'move', x: at.x, y: at.y, dir: 0, lp: false, ar: wel.seq }));
    await new Promise(r => setTimeout(r, 150));
    ws.send(JSON.stringify({ t: 'act', x: wb.x, y: wb.y, item: '' }));
    assert.match((await wait(m => m.t === 'toast' && /Pavúčí hodváb/.test(m.text), 3000)).text, /\+1/);
    const me = await wait(m => m.t === 'me' && m.inv.silk === 1);
    assert.strictEqual(me.inv.silk, 1);
    ws.close();
  } finally { await stopServer(proc); }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'room-sp.json'), 'utf8'));
  assert.strictEqual(saved.v, 8);
  assert.strictEqual(saved.migratedFrom, 7);
  assert.ok(saved.spid.webs.length >= 15);
  assert.ok(saved.spid.corner.garden.length >= 1);
  assert.strictEqual(saved.saves.eva.inv.silk, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pavučina: parametre sa orežú na rozsah; vlákna začínajú na kmeňoch opôr (strom, obor, ker, spadnutý kmeň)', () => {
  const P = Webs.webParams({ rays: 999, pitch: -1, fill: 1.4, nope: 3 });
  assert.strictEqual(P.rays, Webs.WEB_PARAMS.rays.max);
  assert.strictEqual(P.pitch, Webs.WEB_PARAMS.pitch.min);
  assert.strictEqual(P.fill, 1);
  assert.ok(!('nope' in P));
  assert.deepStrictEqual(Webs.webParams(), Object.fromEntries(Object.entries(Webs.WEB_PARAMS).map(([k, d]) => [k, d.def])));
  // chodník široký 2 políčka medzi dvoma oporami v riadku 3
  const geom = (anchor, over) => {
    const w = 8, h = 6, t = new Array(w * h).fill('path'), put = (x, y, g) => { t[y * w + x] = g; };
    if (anchor === 'giant') { put(1, 2, 'giant'); put(2, 2, 'trunk'); put(1, 3, 'trunk'); put(2, 3, 'trunk'); put(5, 2, 'giant'); put(6, 2, 'trunk'); put(5, 3, 'trunk'); put(6, 3, 'trunk'); }
    else { put(2, 3, anchor); put(5, 3, anchor); }
    return Webs.webGeom(t.map(g => ({ g })), w, h, { x: 3, y: 3, ax: 0, n: 2 }, over);
  };
  for (const a of ['tree', 'giant', 'bush', 'log']) {
    const g = geom(a), A = Webs.ANCHOR[a];
    assert.strictEqual(g.a.g === 'trunk' ? 'giant' : g.a.g, a === 'giant' ? 'giant' : a);
    // dotyk leží na povrchu kmeňa (kruh okolo stredu opory) a pavučina je medzi oporami
    assert.ok(Math.abs(Math.hypot(g.u0 - g.a.cx, g.line - g.a.cz) - A.r) < 1e-9, a + ': ľavý dotyk na kmeni');
    assert.ok(Math.abs(Math.hypot(g.u1 - g.b.cx, g.line - g.b.cz) - A.r) < 1e-9, a + ': pravý dotyk na kmeni');
    assert.ok(g.u0 <= 3 && g.u1 >= 5 && g.len > 2);
    assert.strictEqual(g.hgt, Math.min(Webs.WEB_PARAMS.height.def, A.top), a + ': pri nízkej opore nižšia');
  }
  assert.deepStrictEqual([geom('giant').a.cx, geom('giant').a.cz], [2, 3], 'obor: stred kmeňa v strede štvorca 2 × 2');
  assert.strictEqual(geom('tree', { height: 1.6 }).hgt, 1.6);
  // rozpätie z parametrov mení, kde môžu pavučiny visieť
  const les = D.buildLes(SEEDS[0]).map(g => ({ g }));
  const n1 = Webs.analyze(les, SEEDS[0], { span: 1, gladeSpan: 1 }).cands.flat(), n4 = Webs.analyze(les, SEEDS[0], { span: 4, gladeSpan: 5 }).cands.flat();
  assert.ok(n1.every(c => c.n === 1) && n4.some(c => c.n >= 3) && n4.length > n1.length);
});
