const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const D = require('../shared/data.js');
const E = require('../engine.js');
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
    tick: tick == null ? SEASON_TICK(2) : tick, daySeconds: D.BASE_DAY_SECONDS, rng: 12345, seq: 0, events: [], players: new Map(), icehouse: { built: false, ice: 0 },
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
// Simulácia ide cez plánovač: každý pavúk má svoju udalosť (spider:<id>), krížiak spider:k<plocha>.
const SPEC = { handlers: Sp.HANDLERS, onError(err) { throw err; } };
const TICK_S = D.BASE_DAY_SECONDS / TPD; // krok = 0,125 s
const ticks = s => Math.round(s / TICK_S); // sekundy reálneho času → kroky
// beh simulácie: n krokov (each(tick) pred každým krokom); pavúky v lese s hráčom sa zobudia
function run(room, n, each) { Sp.ensure(room); for (let k = 0; k < n; k++) { if (each) each(room.tick + 1); E.advanceTo(room, room.tick + 1, SPEC); } return room.tick; }
// hráč sa pohol (ako udalosť arrivedFrom na serveri: pavúky v blízkosti zareagujú)
function move(room, p, to) { Object.assign(p, to); Sp.noticePlayer(room, p); }
// ručne nastavený stav pavúka – jeho udalosť sa preplánuje
function set(room, s, st) { Object.assign(s, st); Sp.plan(room, s); }
const spiderEvents = (room, id) => room.events.filter(e => e.key === 'spider:' + id);

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
  assert.match(Sp.startPull(room, Object.assign({}, p, { lp: true }), wb), /lampášom/);
  assert.strictEqual(Sp.startPull(room, p, wb), null);
  const pe = room.events.filter(e => e.key === 'pull:' + p.key);
  assert.deepStrictEqual(pe.map(e => [e.type, e.at]), [['pullDone', room.tick + ticks(D.WEB.pullMs / 1000)]], 'ťahanie trvá WEB.pullMs (udalosť v plánovači)');
  let r = Sp.finishPull(room, p, 0.21);
  assert.deepStrictEqual(r, { torn: false, noticed: false });
  assert.strictEqual(p.save.inv.silk, 1);
  assert.strictEqual(s.st, 'home', '21 % > 20 % – nevšimol si');
  Sp.startPull(room, p, wb);
  r = Sp.finishPull(room, p, 0.49);
  assert.deepStrictEqual(r, { torn: false, noticed: true });
  assert.strictEqual(s.st, 'alert');
  assert.strictEqual(s.tgt, p.id);
  assert.deepStrictEqual(spiderEvents(room, s.id).map(e => e.at), [room.tick + 1], 'reakcia pavúka hneď v najbližšom kroku');
  s.st = 'home';
  Sp.startPull(room, p, wb);
  r = Sp.finishPull(room, p, 0.999);
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
  Sp.checkWalk(room, p);
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
  run(room, 3);
  assert.strictEqual(s.st, 'cling');
  assert.strictEqual(p.save.inv.silk, 4, 'vzal 1 hneď');
  assert.ok(sent.some(m => m.t === 'slow' && m.k === D.SPIDERS.vlciak.slow));
  run(room, ticks(2.75), () => { p.x = s.x; p.y = s.y; });
  assert.strictEqual(p.save.inv.silk, 4, 'pred 3 s ešte nie');
  run(room, ticks(0.25), () => { p.x = s.x; p.y = s.y; });
  assert.strictEqual(p.save.inv.silk, 3, 'po 3 s ďalší');
  // lampáš: pustí sa, hodváb vráti, drží sa ďalej ako 2,5 políčka
  move(room, p, { lp: true });
  run(room, 1);
  assert.strictEqual(p.save.inv.silk, 5);
  assert.notStrictEqual(s.st, 'cling');
  run(room, ticks(1.5));
  assert.ok(Math.hypot(s.x - p.x, s.y - p.y) >= D.SPIDERS.lamp - 0.6, 'kraj svetla');
  // lampáš dole: o 2 s sa vráti a chytí
  move(room, p, { lp: false });
  run(room, ticks(5));
  assert.strictEqual(s.st, 'cling');
  // bez lampáša: vezme najviac 3 a pustí sa
  run(room, ticks(8), () => { p.x = s.x; p.y = s.y; });
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
  set(room, s, { st: 'chase', tgt: 1, seen: room.tick, border: 0 });
  run(room, ticks(1.5));
  assert.strictEqual(s.st, 'chase', 'chvíľu čaká na hranici');
  run(room, ticks(1.2));
  assert.ok(['return', 'home'].includes(s.st), 'vzdal to');
  // stratený: hráč je v území, ale už 4 s ďalej než 4 políčka → vzdá to
  const far = terrTile(room, 1, (d, i) => Math.hypot(center(i).x - room.spf.homes[1].x - 0.5, center(i).y - room.spf.homes[1].y - 0.5) > 5);
  set(room, s, { x: room.spf.homes[1].x + 0.5, y: room.spf.homes[1].y + 0.5, st: 'chase', tgt: 1, seen: room.tick - ticks(3.875), path: null });
  Object.assign(p, center(far));
  run(room, 1);
  assert.strictEqual(s.st, 'chase', 'ešte nie');
  run(room, 2);
  assert.ok(['return', 'home'].includes(s.st), 'stratil ho');
  // pustí sa aj vtedy, keď ho hráč vynesie za hranicu územia
  const h = room.spf.homes[1];
  Object.assign(p, { x: h.x + 0.5, y: h.y + 0.5 });
  set(room, s, { x: h.x + 0.5, y: h.y + 0.5, st: 'cling', tgt: 1, taken: 1, next: room.tick + ticks(3) });
  Object.assign(p, center(out));
  run(room, 1);
  assert.ok(['return', 'home'].includes(s.st));
  assert.strictEqual(room.spf.owner[Math.floor(s.y) * LW + Math.floor(s.x)], 1, 'ostal vo svojom území');
});

test('stará pradlena: na pavučinu siahnutú na jej čistine príde pomaly, uhryzne (3 hodváb) a odhodí za okraj; lampáš ju odtláča', () => {
  const room = mkRoom(SEEDS[5]);
  const o = room.spf.homes.length - 1, s = Sp.spiders(room)[o], h = room.spf.homes[o];
  const p = player(room, 1, h.x + 2.5, h.y + 0.5, 5);
  if (room.spf.owner[Math.floor(p.y) * LW + Math.floor(p.x)] !== o) Object.assign(p, { x: h.x + 0.5, y: h.y + 1.5 });
  // bez dotyku pavučiny si hráča nevšíma
  run(room, ticks(2));
  assert.strictEqual(s.st, 'home');
  const wb = room.spid.webs.find(w => w.o === o) || { id: -1, x: h.x, y: h.y, ax: 0, n: 1, o };
  Sp.alert(room, wb, p);
  sent = [];
  run(room, ticks(6));
  assert.ok(sent.some(m => m.t === 'shove'), 'odhodila');
  assert.strictEqual(p.save.inv.silk, 2);
  const sh = sent.find(m => m.t === 'shove');
  assert.notStrictEqual(room.spf.owner[Math.floor(sh.y) * LW + Math.floor(sh.x)], o, 'za okraj jej územia');
  // lampáš: odtláča ju rýchlosťou 0,5 políčka/s (dva lampáše dvakrát rýchlejšie)
  Object.assign(p, { x: h.x + 1.5, y: h.y + 0.5, lp: true });
  if (room.spf.owner[Math.floor(p.y) * LW + Math.floor(p.x)] !== o) Object.assign(p, { x: h.x + 0.5, y: h.y + 1.5 });
  set(room, s, { x: h.x + 0.5, y: h.y + 0.5, st: 'chase', tgt: 1, cool: 0 });
  const d0 = Math.hypot(s.x - p.x, s.y - p.y);
  run(room, ticks(1));
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
      if (s.faces === 3) assert.ok(D.CORNER_WALL[tiles[(s.y + s.ey) * D.W + s.x + s.ex].g], 'vnútorný kút: aj druhá stena');
      else assert.ok(!D.CORNER_WALL[tiles[(s.y + s.dy + s.ey) * D.W + s.x + s.dx + s.ex].g], 'stena sa tu končí');
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
  assert.strictEqual(spiderEvents(room, 'kgarden').length, 1, 'krížiak má svoju udalosť');
  let moved = 0, prev = { x: z.x, y: z.y };
  for (let k = 0; k < 400 && room.kz.garden; k++) {
    run(room, 1);
    if (room.kz.garden) { moved = Math.max(moved, Math.hypot(z.x - prev.x, z.y - prev.y)); prev = { x: z.x, y: z.y }; }
  }
  assert.ok(Math.abs(moved - D.SPIDERS.kriziak.run * TICK_S) < 0.02, 'rýchlosť ' + moved);
  assert.strictEqual(spiderEvents(room, 'kgarden').length, 0, 'po dobehnutí udalosť zmizne');
  assert.deepStrictEqual(room.spid.corner.garden, [spot.k], 'dobehol a utkal');
  // zľakne sa hráča
  room.spid.corner.garden = [];
  Sp.startKriziak(room, 'garden', spot);
  Object.assign(p, { x: room.kz.garden.x + 1, y: room.kz.garden.y });
  run(room, ticks(2));
  assert.ok(!room.kz.garden, 'ušiel');
  assert.deepStrictEqual(room.spid.corner.garden, [], 'pavučinu neutkal');
});

// pavúk o, jeho pavučina na strome a hráč ďaleko od neho (v lese, inak simulácia stojí)
function treeCase(o, seeds) {
  for (const seed of seeds || SEEDS) {
    const room = mkRoom(seed), wb = room.spid.webs.find(w => w.o === o && Sp.trunkSpot(room, w));
    if (!wb) continue;
    const s = Sp.spiders(room)[o], far = room.spf.homes.find(h => Math.hypot(h.x - s.hx, h.y - s.hy) > 15);
    return { room, wb, s, p: player(room, 1, far.x + 0.5, far.y + 0.5, 3) };
  }
  throw new Error('žiadna pavučina na strome');
}
// pavúk práve došiel k pavučine
function toWebNow(room, s, wb) { const i = Sp.webTiles(wb)[0]; Object.assign(s, { st: 'walk', web: wb.id, path: [], x: i % LW + 0.5, y: ((i / LW) | 0) + 0.5 }); }

test('na strome: vlčiak pri svojej pavučine vylezie na jej kmeň a čaká hlavou dole; pri lampáši vylezie vyššie a pavučinu nechá tak', () => {
  const { room, wb, s, p } = treeCase(0);
  const spot = Sp.trunkSpot(room, wb), V = D.SPIDERS.vlciak;
  toWebNow(room, s, wb);
  run(room, ticks(3));
  assert.strictEqual(s.st, 'guard');
  assert.ok(spiderEvents(room, s.id)[0].at > room.tick + 1, 'čaká na kmeni – ďalšia udalosť až na jeho termín');
  assert.ok(Math.hypot(s.x - spot.x, s.y - spot.y) < 1e-6, 'na kmeni');
  assert.ok(s.z >= V.guard[0] - 1e-6 && s.z <= V.guard[1] + 1e-6, 'výška ' + s.z);
  const e = Sp.entities(room, 'les').find(o => o.id === s.id);
  assert.ok(e.z > 0 && e.n && e.u === 0, 'klient: výška, strana kmeňa, hlavou dole');
  // zdvihnutý lampáš pri ňom: vylezie na high, siahnutie na pavučinu ignoruje
  move(room, p, { x: s.x + 1, y: s.y, lp: true });
  run(room, ticks(3));
  assert.ok(Math.abs(s.z - V.high) < 1e-6, 'vyššie ' + s.z);
  Sp.alert(room, wb, p);
  assert.strictEqual(s.st, 'guard', 'pavučinu nechá tak');
  // bez lampáša (ešte čaká na kmeni): zoskočí a naháňa
  s.until = room.tick + ticks(60); move(room, p, { lp: false });
  run(room, ticks(2.5));
  Sp.alert(room, wb, p);
  assert.strictEqual(s.st, 'chase');
  assert.strictEqual(s.z, 0);
});

test('na strome: vlčiak po čase zlezie a ide domov', () => {
  const { room, wb, s } = treeCase(1);
  toWebNow(room, s, wb);
  run(room, ticks(3 + D.SPIDERS.vlciak.guardMs[1] / 1000 + 2));
  assert.ok(['return', 'home'].includes(s.st), s.st);
  assert.strictEqual(s.z, 0);
});

test('na strome: stará pradlena občas zájde k pavučine a čaká na jej kmeni', () => {
  const o = mkRoom(SEEDS[0]).spf.homes.length - 1;
  const { room, s } = treeCase(o);
  let seen = false;
  run(room, ticks(60), () => { if (s.st === 'guard' && s.z > 0.5) seen = true; });
  assert.ok(seen, 'čakala na strome');
});

test('krížiak: pri úteku vybehne na strom a stratí sa v korune', () => {
  const room = mkRoom(SEEDS[7]);
  room.spid.corner.garden = [];
  const { w } = D.areaSize('garden'), spot = Sp.spots(room, 'garden')[0];
  // strom s voľným políčkom 2 vpravo; krížiak tam, hráč ešte o 1 ďalej
  const t = room.tiles.findIndex((x, i) => x.g === 'tree' && i % w < w - 3 && D.passable(room.tiles[i + 2]) && D.passable(room.tiles[i + 3]));
  const tx = t % w, ty = (t / w) | 0;
  const p = player(room, 1, tx + 3.5, ty + 0.5, 0, 'garden');
  room.kz = { garden: { id: 'kgarden', k: 'k', x: tx + 2.5, y: ty + 0.5, a: 0, path: [], spot, st: 'go', until: 0, left: 2, moving: false } };
  E.scheduleUnique(room, 'spider:kgarden', room.tick + 1, 'kriziak', { area: 'garden' });
  let climbed = false;
  for (let k = 0; k < ticks(4) && room.kz.garden; k++) {
    run(room, 1);
    const e = Sp.entities(room, 'garden')[0];
    if (e && e.z > 0) { climbed = true; assert.ok(e.n && e.u === 1); assert.ok(Math.hypot(e.x - tx - 0.5, e.y - ty - 0.5) < 0.5, 'na kmeni stromu'); }
  }
  assert.ok(climbed, 'vybehol na strom');
  assert.ok(!room.kz.garden, 'zmizol v korune');
  assert.deepStrictEqual(room.spid.corner.garden, [], 'pavučinu neutkal');
  assert.ok(p);
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

test('plánovač: každý pavúk má najviac jednu udalosť; kto sa hýbe, je na rade v každom kroku, kto čaká, až na svoj termín', () => {
  const room = mkRoom(SEEDS[9]);
  const f = room.spf, h = f.homes[0];
  const p = player(room, 1, h.x + 0.5, h.y + 4.5, 2);
  // hráč sa každých 5 s premiestni na iné miesto v územiach vlčiakov 0 a 1
  const spots = [0, 1].flatMap(o => [2, 5, 8].map(k => terrTile(room, o, d => d === k))).filter(i => i >= 0);
  let busySeen = 0, idleSeen = 0;
  run(room, ticks(60), t => {
    if (t % 40 === 0) move(room, p, center(spots[(t / 40) % spots.length]));
    for (const s of Sp.spiders(room)) {
      const evs = spiderEvents(room, s.id);
      assert.ok(evs.length <= 1, `${s.id}: ${evs.length} udalosti`);
      if (!evs.length) continue;
      if (evs[0].at === room.tick + 1) busySeen++; else { idleSeen++; assert.ok(evs[0].type === 'spider', 'čakajúci pavúk nenaháňa'); }
    }
  });
  assert.ok(busySeen > 0 && idleSeen > 0, `hýbu sa (${busySeen}) aj čakajú (${idleSeen})`);
  // pavúky doma čakajú na svoj termín – fronta nemá udalosť každého pavúka v každom kroku
  const at = Sp.spiders(room).map(s => (spiderEvents(room, s.id)[0] || {}).at).filter(Boolean);
  assert.ok(at.some(t => t > room.tick + 1), 'aspoň jeden pavúk spí až do termínu');
});

test('plánovač: hráč odíde z lesa – pavúky sú doma bez udalostí; po návrate sa zobudia', () => {
  const room = mkRoom(SEEDS[10]);
  const h = room.spf.homes[0], p = player(room, 1, h.x + 0.5, h.y + 0.5, 0);
  run(room, ticks(2));
  assert.ok(room.events.some(e => /^spider:/.test(e.key)));
  p.area = 'pomedzie';
  run(room, ticks(10));
  assert.ok(!room.events.some(e => /^spider:/.test(e.key)), 'žiadne udalosti pavúkov');
  assert.ok(Sp.spiders(room).every(s => s.st === 'home' && s.x === s.hx && s.y === s.hy), 'všetci doma');
  p.area = 'les';
  Sp.ensure(room);
  assert.strictEqual(room.events.filter(e => /^spider:s/.test(e.key)).length, Sp.spiders(room).length, 'každý pavúk dostal udalosť');
});

test('naháňanie (goTo): pavúk ide k predpovedanej polohe hráča v najbližšom kroku', () => {
  const room = mkRoom(SEEDS[11]);
  const f = room.spf, o = 0, h = f.homes[o];
  // políčko územia aspoň 3 kroky od nory, vpravo od neho tiež územie
  const i = terrTile(room, o, (d, k) => d >= 3 && d <= 6 && f.owner[k + 1] === o && f.owner[k - 1] === o);
  assert.ok(i >= 0);
  const p = player(room, 1, center(i).x, center(i).y, 2);
  const s = Sp.spiders(room)[o];
  p.mv = { vx: 0.6, vy: 0, t: room.tick }; // ide doprava 0,6 políčka za krok
  set(room, s, { st: 'chase', tgt: p.id, seen: room.tick, path: null });
  const ev = spiderEvents(room, s.id);
  assert.deepStrictEqual(ev.map(e => [e.type, e.at, e.data.p, e.data.x, e.data.y]), [['goTo', room.tick + 1, p.id, +(p.x + 0.6).toFixed(3), p.y]]);
  run(room, 1);
  assert.strictEqual(s.goal, i + 1, 'cesta na políčko, kde hráč bude');
  // hráč stojí (posledný pohyb je starý) – cieľ je jeho políčko
  p.mv.t = room.tick - 10;
  Object.assign(s, { x: h.x + 0.5, y: h.y + 0.5, path: null });
  Sp.plan(room, s);
  assert.strictEqual(spiderEvents(room, s.id)[0].data.x, p.x);
  run(room, 1);
  assert.strictEqual(s.goal, i);
});

test('pauza: pavúky sa hýbu len s herným časom (krokmi), nie s reálnym – pozastavený svet stojí, potom pokračuje rovnako', async () => {
  const mk = () => { const room = mkRoom(SEEDS[12]); const h = room.spf.homes[2]; player(room, 1, h.x + 0.5, h.y + 1.5, 3); return room; };
  const snap = room => JSON.stringify(Sp.spiders(room).map(s => [s.id, s.st, s.x.toFixed(4), s.y.toFixed(4), s.z || 0]));
  const a = mk(), b = mk();
  run(a, 80);
  run(b, 40);
  const before = snap(b);
  // pauza: čas sveta sa neposúva (server len posúva wall), pavúky ani ich udalosti sa nezmenia
  b.wall = Date.now();
  const evs = JSON.stringify(b.events);
  await new Promise(r => setTimeout(r, 300));
  b.wall = Date.now();
  assert.strictEqual(E.advance(b, b.wall, SPEC), 0);
  assert.strictEqual(snap(b), before, 'pavúky stoja');
  assert.strictEqual(JSON.stringify(b.events), evs);
  run(b, 40);
  assert.strictEqual(snap(b), snap(a), 'po pauze rovnako ako bez nej (deterministické, náhoda zo sveta)');
});

test('načítanie / dobiehanie po výpadku: udalosti pavúkov a ťahania sa zahodia, pavúky začínajú doma', () => {
  const room = mkRoom(SEEDS[13]);
  const h = room.spf.homes[0], p = player(room, 1, h.x + 0.5, h.y + 0.5, 3);
  const wb = room.spid.webs.find(w => w.o === 1);
  Sp.startPull(room, p, wb);
  run(room, ticks(1));
  assert.ok(room.events.some(e => /^spider:/.test(e.key)));
  const saved = JSON.parse(JSON.stringify({ events: room.events, spid: Sp.save(room) }));
  const r2 = Object.assign({}, room, { spf: null, spid: null, sps: null, players: new Map(), events: saved.events });
  Sp.load(r2, saved.spid);
  assert.ok(!r2.events.some(e => Sp.isRuntime(e)), 'žiadne udalosti pavúkov ani ťahania');
  assert.ok(r2.events.some(e => e.type === 'weave') || !room.events.some(e => e.type === 'weave'), 'tkanie pavučín ostáva');
  assert.ok(Sp.spiders(r2).every(s => s.st === 'home' && s.x === s.hx && s.y === s.hy));
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
    v: 7, tick: SEASON_TICK(2) / 25, wall: Date.now(), mode: 'paused', daySeconds: 1200, rng: 1, seq: 0, events: [], weather: 'sun', pomedzieSeed: 1, lesSeed, les: null,
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
  assert.strictEqual(saved.v, 9);
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

test('pavučina z čiar: rovnaké stredy ako shader, kotvy na kmeňoch ležia v rovine, vydutie len uprostred', () => {
  const opts = { w: 5.3, h: 1.1, seed: 8 };
  const a = Webs.webThreads({}, opts), b = Webs.webThreads({}, opts);
  assert.deepStrictEqual(a.pos, b.pos, 'rovnaké semienko → rovnaké vlákna');
  assert.deepStrictEqual(a.layout.hubs, Webs.webLayout(Webs.webParams(), opts).hubs);
  assert.strictEqual(a.pos.length, a.count * 3);
  assert.strictEqual(a.tan.length, a.pos.length);
  assert.ok(a.count / 2 > 300, 'dosť úsečiek');
  let maxZ = 0;
  for (let i = 0; i < a.count; i++) {
    const x = a.pos[i * 3] + opts.w / 2, y = a.pos[i * 3 + 1] + opts.h / 2, z = a.pos[i * 3 + 2];
    assert.ok(x >= -1e-6 && x <= opts.w + 1e-6 && y >= -1e-6 && y <= opts.h + 1e-6, 'v rámci pavučiny');
    if (x < 1e-6 || x > opts.w - 1e-6) assert.ok(Math.abs(z) < 1e-6, 'na kmeni bez vydutia');
    maxZ = Math.max(maxZ, Math.abs(z));
    assert.ok(Math.abs(Math.hypot(a.tan[i * 3], a.tan[i * 3 + 1], a.tan[i * 3 + 2]) - 1) < 1e-5, 'smer vlákna je jednotkový');
  }
  assert.ok(maxZ > 0.05 && maxZ <= Webs.WEB_PARAMS.bow.def * 1.25 + 1e-9);
  assert.ok(Webs.webThreads({ bow: 0 }, opts).pos.every((v, i) => i % 3 !== 2 || v === 0), 'bez vydutia rovná');
  const torn = Webs.webThreads({}, Object.assign({ keep: 0.42 }, opts));
  assert.ok(torn.count < a.count * 0.8, 'vyťahaná pavučina má menej vlákien');
});

test('kútová pavučina: 3 kotvy na 2 alebo 3 plochách kúta, rám vo vzduchu, občas zlom s vláknom k vrcholu', () => {
  let breaks = 0;
  for (let seed = 1; seed <= 60; seed++) for (const faces of [2, 3]) {
    const t = Webs.cornerThreads({}, { seed, faces }), S = Webs.WEB_PARAMS.cornerSize.def;
    // každá kotva leží na niektorej ploche kúta: stena 1 (X = 0), zem (Y = 0), pri troch plochách aj stena 2 (Z = 0)
    const on = t.anchors.map(p => p[0] === 0 ? 'w1' : p[1] === 0 ? 'g' : p[2] === 0 ? 'w2' : '?');
    assert.ok(!on.includes('?'));
    if (faces === 3) assert.deepStrictEqual(on.slice().sort(), ['g', 'w1', 'w2']);
    else assert.ok(new Set(on).size === 2 && !on.includes('w2'), 'dve plochy: stena a zem');
    assert.ok(t.anchors.every(p => p.every(v => v >= 0 && v <= S + 1e-9)), 'do cornerSize od kúta');
    // všetky vlákna vo vzduchu (v kladnom kvadrante) – nikdy nejdú do steny ani do zeme
    for (let i = 0; i < t.pos.length; i++) assert.ok(t.pos[i] >= -1e-6, 'vlákno vo vzduchu');
    // všetky vlákna v rovine troch kotiev
    const [A, B, C] = t.anchors, u = B.map((v, i) => v - A[i]), w = C.map((v, i) => v - A[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], nl = Math.hypot(...n);
    for (let i = 0; i < t.count; i++) assert.ok(Math.abs(((t.pos[i * 3] - A[0]) * n[0] + (t.pos[i * 3 + 1] - A[1]) * n[1] + (t.pos[i * 3 + 2] - A[2]) * n[2]) / nl) < 1e-6);
    assert.ok(t.count / 2 > 40, 'vyplnená');
    if (t.layout.nH === 2) breaks++;
  }
  assert.ok(breaks > 30 && breaks < 90, `zlom približne v polovici (${breaks}/120)`);
  assert.strictEqual(Webs.cornerThreads({ cornerBreak: 0 }, { seed: 5, faces: 2 }).layout.nH, 1);
  assert.strictEqual(Webs.cornerThreads({ cornerBreak: 1 }, { seed: 5, faces: 2 }).layout.nH, 2);
});

test('kúty v budovách z minikociek: hrana steny so zemou a pod presahom strechy, nesúmerná veľkosť, nie na streche', () => {
  // model 12 × 12 × 12: stena v x = 0…3 (celá výška 10), na vrchu presah strechy x = 4…7 vo výške 9; schod na zemi v z = 0…1
  const sx = 12, sy = 12, sz = 12, data = new Uint8Array(sx * sy * sz);
  const put = (x, y, z) => { data[(z * sy + y) * sx + x] = 1; };
  for (let z = 0; z < sz; z++) { for (let y = 0; y < 10; y++) for (let x = 0; x < 4; x++) put(x, y, z); for (let x = 4; x < 8; x++) put(x, 9, z); }
  for (let x = 8; x < 11; x++) for (let z = 0; z < 2; z++) put(x, 0, z); // nízky schod pod holým nebom
  const all = Webs.voxelCorners({ sx, sy, sz, data }, { x0: 0, x1: sx - 1, y0: 0, y1: sy - 1, z0: 0, z1: sz - 1 });
  const key = q => q.X.join() + '|' + q.Y.join();
  // stena a zem: X von zo steny (+x), Y hore; voľné miesto po presah (4 kocky) a 8 nahor (strop 9 – najviac max 8)
  const ground = all.find(q => key(q) === '1,0,0|0,1,0' && q.o[1] === 0 && q.v[2] >= 2); // mimo schodu
  assert.strictEqual(all.find(q => key(q) === '1,0,0|0,1,0' && q.v[2] < 2).size[0], 4, 'pri schode len po schod');
  assert.ok(ground, 'hrana steny so zemou');
  assert.strictEqual(ground.size[0], 8);
  assert.deepStrictEqual(ground.o.slice(0, 2), [4, 0], 'roh na päte steny');
  // pod presahom strechy: X dole (von zo strechy), Y von zo steny – výška pod strechou 8 (y 1…8 nad schodom/ zemou 0…8 = 9 → max 8)
  const eave = all.find(q => q.X.join() === '1,0,0' && q.Y.join() === '0,-1,0');
  assert.ok(eave, 'pod strechou pri stene');
  assert.strictEqual(eave.size[0], 4, 'od steny len po okraj presahu (4 kocky)');
  assert.strictEqual(eave.size[1], 8, 'nadol po stene (najviac 8)');
  assert.deepStrictEqual(eave.o.slice(0, 2), [4, 9]);
  // na schode pod holým nebom nič (vodorovná plocha nad zemou bez strechy nad ňou)
  assert.ok(!all.some(q => q.v[1] === 1 && q.v[0] >= 8), 'nie na streche/schode pod nebom');
  // veľkosti: aspoň 2 kocky, nikdy viac ako voľné miesto; rôzne semienka → rôzne a nesúmerné
  const sizes = new Set();
  for (let s = 1; s <= 40; s++) {
    const q = Webs.pickVoxelCorner(all, s);
    q.vox.forEach((n, i) => assert.ok(n >= 2 && n <= q.free[i]));
    assert.deepStrictEqual(q.size, q.vox.map(n => n / 8));
    sizes.add(q.vox.join('x'));
  }
  assert.ok(sizes.size > 10, 'rôzne veľkosti');
  assert.ok([...sizes].some(s => { const v = s.split('x').map(Number); return Math.max(...v) >= 3 * Math.min(...v); }), 'aj pretiahnuté (napr. 2 × 6)');
  // pavučina s veľkosťou po osiach drží kotvy v nej
  const t = Webs.cornerThreads({}, { seed: 9, faces: 2, size: [2 / 8, 6 / 8, 3 / 8] });
  assert.ok(t.anchors.every(p => p[0] <= 2 / 8 + 1e-9 && p[1] <= 6 / 8 + 1e-9 && p[2] <= 3 / 8 + 1e-9));
});

test('pavučina v budove: kotvy (aj zlom) sa navzájom vidia – medzi nimi nie je plná minikocka', () => {
  const W3 = require('../shared/world3d.js');
  let webs = 0;
  for (const id of ['house', 'hut', 'stall', 'icehouse', 'well']) {
    const f = W3.FINE_MODELS.find(m => m.id === id).build(1, 0);
    const all = Webs.voxelCorners(f, { x0: 0, x1: f.sx - 1, y0: 0, y1: f.sy - 1, z0: 0, z1: f.sz - 1 });
    for (let seed = 1; seed <= 15; seed++) {
      const r = Webs.voxelWeb(f, all, seed, {}, 1);
      if (!r) continue;
      webs++;
      const see = Webs.voxelSight(f, r.q), A = r.th.anchors;
      assert.ok(see(A[0], A[1]) && see(A[1], A[2]) && see(A[2], A[0]), `${id} ${seed}: kotvy sa vidia`);
      assert.ok(A.every(Webs.voxelHold(f, r.q)), `${id} ${seed}: každá kotva leží na skutočnej ploche (za ňou plná minikocka)`);
      // kotvy vždy v strede minikocky: na ploche 0, inak (n + ½) / 8
      for (const p of A) for (const v of p) assert.ok(v === 0 || Math.abs(v * 8 - Math.floor(v * 8) - 0.5) < 1e-9, `${id} ${seed}: stred minikocky (${v * 8})`);
      assert.ok(r.th.count / 2 < 80, `${id} ${seed}: málo detailov (${r.th.count / 2} úsečiek)`);
    }
  }
  assert.ok(webs > 60, 'v budovách sa pavučiny nájdu');
  // stena medzi kotvami: voxelSight to odhalí
  const sx = 8, sy = 8, sz = 8, data = new Uint8Array(sx * sy * sz);
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) data[(z * sy + y) * sx + 4] = 1; // stena v x = 4
  const see = Webs.voxelSight({ sx, sy, sz, data }, { o: [0, 2, 0], X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] });
  assert.ok(see([0, 0, 0.1], [0.4, 0, 0.1]), 'pred stenou');
  assert.ok(!see([0, 0, 0.1], [0.8, 0, 0.1]), 'cez stenu nie');
});
