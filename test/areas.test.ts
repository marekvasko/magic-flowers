import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { AreaId, Ground } from '../src/shared/data.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.ts';
import type { SaveFile } from '../src/shared/save.ts';
import { entries } from '../src/shared/util.ts';
import * as W3 from '../src/shared/world3d.ts';
import * as Areas from '../src/server/areas.ts';
import { isMsg, must, parseMsg, readJson } from './helpers.ts';
import type { MsgOf, MsgType } from './helpers.ts';

const SEEDS = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0);
// typ zeme blokuje chôdzu (mimo mapy nie)
const blocks = (g: Ground | undefined): boolean => !!g && !!D.BLOCK[g];

// Políčka dosiahnuteľné chôdzou z políčka start (len cez priechodné typy zeme)
function reach(tiles: readonly Ground[], w: number, h: number, start: number): Uint8Array {
  const seen = new Uint8Array(w * h), q = [start];
  seen[start] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = must(q[k]), x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, n = ny * w + nx;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[n] || blocks(tiles[n])) continue;
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
      const a = must(D.arrival(area, g.to) ?? undefined), t = D.buildArea(g.to, 3), ts = D.areaSize(g.to);
      assert.ok(a, `príchod ${area}>${g.to}`);
      assert.ok(Areas.inside(g.to, Math.floor(a.x), Math.floor(a.y)));
      const at = t[Math.floor(a.y) * ts.w + Math.floor(a.x)];
      assert.ok(!blocks(at) && at !== 'gate', `príchod ${area}>${g.to} je na voľnom políčku (${String(at)})`);
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
  for (const [key, a] of entries(D.ARRIVE)) {
    const [from = '', to = 'garden'] = key.split('>'), { w, h } = D.areaSize(to);
    const corners = ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]): [number, number] => [Math.floor(a.x + sx * D.BODY.rx), Math.floor(a.y + sy * D.BODY.ry)]);
    const back = D.GATES[must(D.AREAS.find(x => x === to))].filter(g => g.to === from);
    const [c0x, c0y] = must(corners[0]);
    for (const seed of SEEDS) {
      const tiles = D.buildArea(to, seed);
      for (const [x, y] of corners) assert.ok(!blocks(tiles[y * w + x]), `${key} semienko ${seed}: pod telom na ${x},${y} je ${String(tiles[y * w + x])}`);
      const seen = reach(tiles, w, h, c0y * w + c0x);
      for (const [x, y] of corners) assert.ok(seen[y * w + x], `${key} semienko ${seed}: políčka pod telom sú spojené`);
      assert.ok(back.some(g => seen[g.y * w + g.x]), `${key} semienko ${seed}: z príchodu sa dá dôjsť k prechodu späť`);
    }
  }
  // generátor drží voľné práve políčka pod telom na príchodovom mieste
  assert.deepStrictEqual([...D.arrivalTiles('les')].map(i => [i % D.LES_W, (i / D.LES_W) | 0]).sort(), [[19, 65], [20, 65]]);
});

test('prechod záhrada ↔ Les na pomedzí: gateTarget podľa políčka', () => {
  const garden = D.buildMap().map(g => ({ g })), pom = Areas.loadPomedzie(42);
  const ge = must(D.GATES.garden.find(g => g.to === 'pomedzie')), pw = must(D.GATES.pomedzie[0]);
  assert.strictEqual(Areas.gateTarget(garden, 'garden', ge.x + 0.7, ge.y + 0.5), 'pomedzie');
  assert.strictEqual(Areas.gateTarget(pom, 'pomedzie', pw.x + 0.2, pw.y + 0.5), 'garden');
  assert.strictEqual(Areas.gateTarget(garden, 'garden', ge.x - 1 + 0.5, ge.y + 0.5), null);
  const a = must(D.arrival('garden', 'pomedzie') ?? undefined);
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
    const west = reach(g, w, h, must(D.GATES.pomedzie[0]).y * w), north = reach(g, w, h, nx0);
    assert.strictEqual(g[nx0], 'gate', `prechod do Lesa divov na severnom okraji (semienko ${seed})`);
    assert.strictEqual(g[nx1], 'gate');
    assert.strictEqual(g[w + nx0], 'path');
    for (let i = 0; i < g.length; i++) {
      if (blocks(g[i])) continue;
      assert.ok(west[i] && north[i], `semienko ${seed}: políčko ${i % w},${(i / w) | 0} (${String(g[i])}) je odrezané`);
    }
    for (const gt of D.GATES.pomedzie) assert.ok(west[gt.y * w + gt.x]);
  }
});

test('Les na pomedzí: na juhu lúka, smerom na sever hustnúci les, na severe len chodník', () => {
  const { w, h } = D.areaSize('pomedzie');
  const share = (g: readonly Ground[], y0: number, y1: number, types: readonly Ground[]): number => { let n = 0, all = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) { all++; const t = g[y * w + x]; if (t && types.includes(t)) n++; } return n / all; };
  let south = 0, mid = 0, north = 0, meadow = 0;
  for (const seed of SEEDS) {
    const g = D.buildPomedzie(seed);
    meadow += share(g, D.MEADOW_Y, h - 1, ['meadow']);
    south += share(g, D.MEADOW_Y, h - 1, ['tree']);
    mid += share(g, 10, 20, ['tree']);
    north += share(g, 3, 8, ['tree']);
    for (let y = 0; y <= 2; y++) for (let x = 0; x < w; x++) { const t = must(g[y * w + x]); assert.ok(['tree', 'path', 'gate'].includes(t), `sever ${x},${y}: ${t}`); }
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
  const win = must(W3.buildGrid(pom, 3, w, 'pomedzie').fine.find(f => f.type === 'bush'));
  assert.ok(win.data.includes(W3.M.SNOW) && !win.data.includes(W3.M.LEAF_SUMMER));
  // na severe viac ihličnanov než na juhu
  const con = (y0: number, y1: number): number => { let c = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) { const k = W3.treeKind(x, y, 'pomedzie'); n++; if (k === 'smrek' || k === 'borovica') c++; } return c / n; };
  assert.ok(con(0, 6) > con(18, 24) + 0.2);
  // menšia plocha: mriežka a voda podľa šírky
  const small = Array.from({ length: 6 * 4 }, (_, i) => ({ g: i === 7 ? 'water' as const : 'grass' as const }));
  const sg = W3.buildGrid(small, 1, 6);
  assert.strictEqual(sg.NX, 12); assert.strictEqual(sg.NZ, 8);
  assert.deepStrictEqual(W3.waterQuads(small, 6), [{ x: 1, y: 1 }]);
  assert.strictEqual(W3.surfaceY(sg, 1, 1), W3.WATER_Y);
});

// ---------- Server: migrácia starého uloženia a cesta záhrada ↔ Les na pomedzí ----------
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }
// klient: správy do fronty, wait(typ, podmienka) počká na prvú vyhovujúcu
interface Client { ws: WebSocket; open: () => Promise<void>; send: (m: ClientMessage) => void; wait: <T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number) => Promise<MsgOf<T>> }
function client(port: number): Client {
  const ws = new WebSocket('ws://127.0.0.1:' + port), msgs: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => unknown; resolve: (m: ServerMessage) => void; t?: NodeJS.Timeout }[] = [];
  ws.on('message', raw => {
    const m = parseMsg(raw);
    const k = waiters.findIndex(w => w.pred(m));
    if (k >= 0) must(waiters.splice(k, 1)[0]).resolve(m); else msgs.push(m);
  });
  return {
    ws, open: () => new Promise(r => ws.on('open', () => { r(); })),
    send: m => { ws.send(JSON.stringify(m)); },
    wait: <T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number): Promise<MsgOf<T>> => {
      const pred = (m: ServerMessage): m is MsgOf<T> => isMsg(m, t) && (!test || !!test(m));
      const k = msgs.findIndex(pred);
      const found = k >= 0 ? msgs.splice(k, 1)[0] : undefined;
      if (found && pred(found)) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w: (typeof waiters)[number] = { pred, resolve: m => { clearTimeout(w.t); if (pred(m)) resolve(m); } };
        w.t = setTimeout(() => { reject(new Error('správa neprišla')); }, ms || 4000);
        waiters.push(w);
      });
    }
  };
}

test('server: svet z verzie 3 sa prevedie (záhrada aj poloha ostanú) a hráč prejde do Lesa na pomedzí a späť', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-areas-'));
  const port = 39000 + Math.floor(Math.random() * 2000);
  // starý svet (v3): prekopané políčko so zasadenou rastlinou a hráčka uložená v záhrade
  const tiles: { s: { k: string; w: number; r: number; p: { sp: string; prog: number; q: number; dry: number }; o: string } | null }[] = D.buildMap().map(() => ({ s: null }));
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
    const wel = await c.wait('welcome');
    assert.strictEqual(wel.area, 'garden');
    assert.deepStrictEqual([wel.x, wel.y], [12.25, 20.5], 'poloha hráčky ostala');
    assert.deepStrictEqual([wel.w, wel.h], [D.W, D.H]);
    assert.strictEqual(must(wel.tiles[plot]).s?.p?.sp, 'mak', 'záhrada ostala');
    // na prechod na východnom okraji záhrady
    const ge = must(D.GATES.garden.find(g => g.to === 'pomedzie'));
    c.send({ t: 'move', x: ge.x + 0.5, y: ge.y + 0.5, dir: 0, ar: 0 });
    const toPom = await c.wait('area');
    const a = must(D.arrival('garden', 'pomedzie') ?? undefined);
    assert.strictEqual(toPom.area, 'pomedzie');
    assert.deepStrictEqual([toPom.x, toPom.y, toPom.w, toPom.h], [a.x, a.y, D.areaSize('pomedzie').w, D.areaSize('pomedzie').h]);
    assert.strictEqual(toPom.tiles.length, toPom.w * toPom.h);
    assert.ok(toPom.tiles.some(t => t.g === 'meadow') && !toPom.tiles.some(t => t.s), 'Les na pomedzí bez záhonov');
    // mimo mriežky sa nedá – server polohu udrží na ploche (a ak je tam neprechodná zem, pohyb odmietne a vráti hráčku späť)
    c.send({ t: 'move', x: -4, y: 40, dir: 0, ar: toPom.seq });
    const ph = D.areaSize('pomedzie').h, corner = must(toPom.tiles[(ph - 1) * toPom.w]);
    let at: { x: number; y: number }; // kde hráčka naozaj stojí (rozloženie lesa je zo semienka, roh môže byť strom)
    if (D.passable(corner)) {
      const pl = await c.wait('pl', m => m.list.some(p => p.name === 'Eva' && p.x === 0.2));
      assert.deepStrictEqual(pl.list.map(p => [p.area, p.x, p.y]), [['pomedzie', 0.2, ph - 0.2]]);
      at = { x: 0, y: ph - 1 };
    } else {
      const fix = await c.wait('pos');
      assert.deepStrictEqual([fix.x, fix.y], [a.x, a.y], 'oprava polohy na príchodové miesto');
      at = { x: Math.floor(a.x), y: Math.floor(a.y) };
    }
    // motyka v lese nič neprekope
    c.send({ t: 'act', x: at.x, y: at.y, item: 'hoe' });
    assert.match((await c.wait('toast', m => /nepestuje/.test(m.text))).text, /Les na pomedzí je divý/);
    // späť cez prechod na západe
    const pw = must(D.GATES.pomedzie[0]);
    c.send({ t: 'move', x: pw.x + 0.5, y: pw.y + 0.5, dir: 0, ar: toPom.seq });
    const back = await c.wait('area');
    const b = must(D.arrival('pomedzie', 'garden') ?? undefined);
    assert.deepStrictEqual([back.area, back.x, back.y], ['garden', b.x, b.y]);
    // a znova do lesa: po odpojení a znovupripojení je hráčka v lese
    c.send({ t: 'move', x: ge.x + 0.5, y: ge.y + 0.5, dir: 0, ar: back.seq });
    await c.wait('area', m => m.area === 'pomedzie');
    c.ws.close();
  } finally { await stopServer(proc); }
  const saved = readJson<SaveFile>(path.join(dir, 'room-stary.json'));
  assert.strictEqual(saved.v, 11);
  assert.strictEqual(saved.migratedFrom, 3);
  assert.ok(Number.isInteger(saved.pomedzieSeed));
  assert.strictEqual(must(saved.tiles[plot]).s?.p?.sp, 'mak');
  assert.strictEqual(must(saved.saves['eva']).coins, 77);
  const area: AreaId | undefined = must(saved.saves['eva']).area;
  assert.strictEqual(area, 'pomedzie');
  // po reštarte servera: rovnaký les (zo semienka) a hráčka v ňom
  proc = await startServer(dir, port);
  try {
    const c = client(port);
    await c.open();
    c.send({ t: 'join', room: 'stary', name: 'Eva' });
    const wel = await c.wait('welcome');
    assert.strictEqual(wel.area, 'pomedzie');
    assert.deepStrictEqual(wel.tiles.map(t => t.g), D.buildPomedzie(saved.pomedzieSeed));
    c.ws.close();
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
