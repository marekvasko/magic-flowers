import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import * as D from '../src/shared/data.ts';
import type { AreaId, Ground } from '../src/shared/data.ts';
import type { ServerMessage } from '../src/shared/protocol.ts';
import type { Icehouse, PlayerSave, SaveFile, Webs as WebState } from '../src/shared/save.ts';
import { isRecord } from '../src/shared/util.ts';
import * as E from '../src/server/engine.ts';
import * as Actions from '../src/server/actions.ts';
import * as Sp from '../src/server/spiders.ts';
import * as Webs from '../src/shared/webs.ts';
import * as W3 from '../src/shared/world3d.ts';
import type { GameWorld, Kriziak, Msg, SpiderState } from '../src/server/game.ts';
import type { Presence, Tile } from '../src/server/world.ts';
import { isMsg, must, parseJson, parseMsg, partial, portOf, readJson, rethrow, testWorld } from './helpers.ts';
import type { MsgOf, MsgType } from './helpers.ts';

const TPD = D.TICKS_PER_DAY, LW = D.LES_W, LH = D.LES_H;
const SEASON_TICK = (se: number): number => se * D.DAYS_PER_SEASON * TPD + D.DAWN_TICK; // prvé ráno obdobia se
const SEEDS = Array.from({ length: 30 }, (_, i) => (i * 2654435761 + 17) >>> 0);
const blocks = (g: Ground | undefined): boolean => !!g && !!D.BLOCK[g];
const gOf = (tiles: readonly Tile[], i: number): Ground | undefined => tiles[i]?.g;
const pathDist = (les: readonly Tile[], from: number): Int16Array => {
  const dist = new Int16Array(LW * LH).fill(-1), q = [from];
  dist[from] = 0;
  for (let k = 0; k < q.length; k++) {
    const i = must(q[k]), x = i % LW, y = (i / LW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, n = ny * LW + nx;
      if (nx < 0 || ny < 0 || nx >= LW || ny >= LH || (dist[n] ?? 0) >= 0 || blocks(gOf(les, n))) continue;
      dist[n] = (dist[i] ?? 0) + 1; q.push(n);
    }
  }
  return dist;
};

test('pavúky: 6 vlčiakov s norami ďaleko od seba, stará pradlena na čistine najďalej od vstupu', () => {
  for (const seed of SEEDS) {
    const les = D.buildLes(seed).map(g => ({ g })), f = Sp.analyze(les, seed);
    const v = f.homes.filter(h => h.k === 'v'), p = f.homes.filter(h => h.k === 'p');
    assert.strictEqual(v.length, D.SPIDERS.vlciak.n, `seed ${seed}: 6 vlčiakov`);
    assert.strictEqual(p.length, 1, `seed ${seed}: jedna pradlena`);
    assert.strictEqual(must(f.homes[f.homes.length - 1]).k, 'p', 'pradlena je posledná');
    for (const a of v) for (const b of v) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= D.SPIDERS.vlciak.gap);
    assert.strictEqual(gOf(les, must(p[0]).i), 'glade');
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
        assert.ok(!blocks(gOf(les, i)), 'územie je priechodné');
        const di = d[i] ?? -1;
        if (h.k === 'v') assert.ok(di >= 0 && di <= D.SPIDERS.vlciak.reach, 'do 10 krokov po chodníku');
        assert.ok((ent[i] ?? -1) > D.SPIDERS.entrance, 'nie pri vstupe');
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
        assert.ok(c.n >= 1 && c.n <= (c.tiles.some(i => gOf(les, i) === 'glade') ? Webs.WEB_PARAMS.gladeSpan.def : Webs.WEB_PARAMS.span.def));
        assert.deepStrictEqual(c.tiles, Sp.webTiles(c));
        for (const i of c.tiles) { assert.strictEqual(f.owner[i], o); assert.ok(!blocks(gOf(les, i)) && gOf(les, i) !== 'gate'); }
        const [sx, sy] = c.ax ? [0, 1] : [1, 0];
        const anchor = (i: number): boolean => { const g = gOf(les, i); return !!g && !!D.WEB_ANCHOR[g]; };
        assert.ok(anchor((c.y - sy) * LW + c.x - sx), 'opora pred');
        assert.ok(anchor((c.y + sy * c.n) * LW + c.x + sx * c.n), 'opora za');
      }
    });
    assert.ok(total > 60, `seed ${seed}: dosť miest na pavučiny (${total})`);
  }
});


// ---------- Bez servera: svet, ktorý poháňa len engine (spiders.ts ako návrhy, pohyb z actions.ts) ----------
// Prítomnosť (pripojení hráči) je pole w.presence; hráč má aj uloženie (stav: poloha, batoh).
type W = GameWorld & { presence: Presence[]; webs: WebState; corners: Partial<Record<AreaId, string[]>>; sps: Partial<Record<string, SpiderState>>; kz: Partial<Record<AreaId, Kriziak | null>> };
type Spec = E.Spec<W, Presence, Msg>;
// zozbierané správy a (voliteľne) dávky denníka
type Out = Msg[] & { journal?: E.JournalEntry<Presence, Msg>[] };
const SLICE = (w: W, k: string): E.Slice | null => { const s = Sp.slice(w, k); return s === undefined ? E.sliceOf(w, k) : s; };
function spec(out?: Out): Spec {
  const base: Spec = {
    proposers: { ...Sp.PROPOSERS, pos: Actions.PROPOSERS.pos }, periodic: Sp.PERIODIC, slice: SLICE,
    presence: w => w.presence, onError: rethrow
  };
  return out ? { ...base, onBatch: (w, o) => { for (const m of o.outbox) out.push(m); if (Array.isArray(out.journal)) out.journal.push(o.entry); } } : base;
}
const ready = (w: GameWorld & { presence: Presence[] }): w is W => !!w.webs && !!w.corners && !!w.sps && !!w.kz;
function mkWorld(seed: number, tick?: number): W {
  const w = testWorld({
    tick: tick == null ? SEASON_TICK(2) : tick, seed: 'ab'.repeat(16), step: 0, seq: 0, events: [], daySeconds: 1200, saves: {}, presence: [] as Presence[],
    lesSeed: seed, les: D.buildLes(seed).map(g => ({ g })), tiles: D.buildMap().map((g): Tile => ({ g, s: null })), hory: D.buildMountains().map(g => ({ g })),
    icehouse: partial<Icehouse>({ built: false, ice: 0 })
  });
  Sp.load(w, E.liveCtx(w, 'pavuky'));
  if (!ready(w)) throw new Error('pavúky sa nenačítali');
  E.reconcile(w, spec());
  return w;
}
const spider = (w: W, id: string): SpiderState => must(w.sps[id]);
const save = (w: GameWorld, key: string): PlayerSave => must(w.saves[key]);
// hráč key na (x, y) v ploche area: uloženie (stav) a prítomnosť (pripojený)
function join(w: W, key: string, x: number, y: number, silk: number, area?: AreaId): Presence {
  w.saves[key] = partial<PlayerSave>({ inv: silk ? { silk } : {}, fb: {}, x, y, area: area || 'les' });
  const p: Presence = { key, name: key, area: area || 'les', x, y, lp: false, vx: 0, vy: 0, pull: null, scav: null };
  w.presence.push(p);
  return p;
}
const moveTo = (w: W, p: Presence, x: number, y: number): void => { Object.assign(p, { x, y }); Object.assign(save(w, p.key), { x, y }); };
// pavúk o sa hneď zobudí (ako keby hráč prišiel do lesa)
function wake(w: W, ids?: string[]): void { for (const id of ids || Object.keys(w.sps)) { spider(w, id).next = w.tick + 1; E.cancel(w, 'spider:' + id); } }
const T = (ms: number): number => Sp.ticksOf(ms, 1200), SEC = 1200 / TPD; // krok v sekundách
const run = (w: W, ticks: number, out?: Out): number => E.advanceTo(w, w.tick + ticks, spec(out));
let aid = 0;
// dávka akcií ako na serveri: potom hneď reconcile (zrušené udalosti pavúkov sa naplánujú znova – ako pri E.replay)
function commit(w: W, inputs: E.Input[], s?: Spec): E.BatchOut<Presence, Msg> { const r = E.commitBatch(w, inputs, s || spec()); E.reconcile(w, s || spec()); return r; }
type P2 = [number, number];
interface Across { before: P2; mid: P2; half: P2; after: P2 }
// Cesta naprieč pavučinou wb: políčko pred ňou, jej stred a políčko za ňou (obe priechodné); dir = smer (dx, dy)
function acrossWeb(w: W, wb: { x: number; y: number; ax: number }): Across | null {
  const [dx, dy] = wb.ax ? [1, 0] : [0, 1], cx = wb.x + 0.5, cy = wb.y + 0.5;
  const ok = (x: number, y: number): boolean => !blocks(gOf(w.les, Math.floor(y) * LW + Math.floor(x)));
  for (const s of [1, -1]) if (ok(cx - s * dx, cy - s * dy) && ok(cx + s * dx * 1.1, cy + s * dy * 1.1)) {
    return { before: [cx - s * dx, cy - s * dy], mid: [cx, cy], half: [cx + s * dx * 0.55, cy + s * dy * 0.55], after: [cx + s * dx * 1.1, cy + s * dy * 1.1] };
  }
  return null;
}
const across = (w: W, wb: { x: number; y: number; ax: number }): Across => must(acrossWeb(w, wb) ?? undefined);
// hráč key prejde pavučinou krokmi cez engine (pos); out zbiera správy
function walkThrough(w: W, key: string, wb: { x: number; y: number; ax: number }, out: Out, upTo?: 'mid' | 'half'): Across {
  const r = across(w, wb);
  for (const k of ['mid', 'half', 'after'] as const) { commit(w, [act('pos', key, { x: r[k][0], y: r[k][1] })], spec(out)); if (k === upTo) break; }
  return r;
}
// Vstup akcie hráča (dáta podľa typu akcie; test zadá len potrebné polia)
const act = (type: string, key: string, data?: { [field: string]: unknown }): E.Input => ({ type, data: Object.assign({ key }, data), id: 'a#' + (++aid), actor: key });
// Prvá zozbieraná správa daného typu
const firstOf = <T extends Msg['t']>(out: readonly Msg[], t: T): Extract<Msg, { t: T }> | undefined => out.find((m): m is Extract<Msg, { t: T }> => m.t === t);
const countOf = (k: 'vlciak' | 'pradlena', se: number): number => must(D.WEB.count[k][se]);
const webOf = (w: W, pred: (wb: WebState['list'][number]) => unknown): WebState['list'][number] => must(w.webs.list.find(pred));

test('pavučiny: počet podľa obdobia, roztrhnutú majiteľ utká znova o deň (udalosť weave:<o>), v zime ich ubudne', () => {
  const w = mkWorld(must(SEEDS[0])); // jeseň
  const f = Sp.forestOf(w), count = (o: number): number => w.webs.list.filter(x => x.o === o).length;
  f.homes.forEach((h, o) => { assert.strictEqual(count(o), Math.min(countOf(h.k === 'p' ? 'pradlena' : 'vlciak', 2), must(f.cands[o]).length)); });
  const used = new Set<number>();
  for (const x of w.webs.list) for (const i of Sp.webTiles(x)) { assert.ok(!used.has(i), 'pavučiny sa neprekrývajú'); used.add(i); }
  // prejdenie pavučinou ju roztrhne (pohyb cez engine) → o deň udalosť weave:0
  const wb = webOf(w, x => x.o === 0 && acrossWeb(w, x)), t = must(Sp.webTiles(wb)[0]);
  join(w, 'eva', ...across(w, wb).before, 0);
  const out: Out = [];
  walkThrough(w, 'eva', wb, out);
  assert.ok(!w.webs.list.some(x => x.id === wb.id), 'roztrhnutá');
  assert.deepStrictEqual(w.webs.pend['0'], [w.tick + D.WEB.reweave], 'utká ju o deň');
  assert.strictEqual(E.pending(w, 'weave:0')?.at, w.tick + D.WEB.reweave, 'engine naplánoval weave:0 na ten termín');
  w.presence = []; // hráč odišiel
  run(w, D.WEB.reweave + 1);
  assert.strictEqual(count(0), 3, 'znova utkaná');
  // príchod zimy: nadbytočné zmiznú, čakajúce tkanie sa zruší
  const wb1 = webOf(w, x => x.o === 1 && acrossWeb(w, x));
  join(w, 'ida', ...across(w, wb1).before, 0);
  walkThrough(w, 'ida', wb1, []);
  assert.ok(w.webs.pend['1'] && w.webs.pend['1'].length);
  w.presence = [];
  E.advanceTo(w, SEASON_TICK(3), spec());
  assert.strictEqual(count(0), 1);
  assert.strictEqual(count(1), 1);
  assert.ok(!w.webs.pend['1'], 'zbytočné tkanie zrušené');
  assert.ok(must(E.pending(w, 'weave:1') ?? undefined).at - w.tick >= TPD, 'udalosť weave:1 spí');
  assert.ok(t >= 0);
});

test('pavučina sa naťahuje: vojdeš – nič sa netrhá; cúvneš – pustí sa celá; až políčko za ňou sa roztrhne a majiteľ to vie', () => {
  const w = mkWorld(must(SEEDS[1]));
  const wb = webOf(w, x => acrossWeb(w, x)), r = across(w, wb);
  const p = join(w, 'eva', ...r.before, 0), out: Out = [];
  const inside = (): typeof wb.in => wb.in; // čerstvé čítanie (pavučinu mení engine)
  walkThrough(w, 'eva', wb, out, 'mid');
  assert.ok(w.webs.list.some(x => x.id === wb.id), 'v pavučine – ešte celá');
  assert.ok(inside()?.['eva'] != null, 'zaboril sa');
  assert.ok(must(Sp.websView(w).webs.find(x => x.id === wb.id)).in?.['eva'] != null, 'klient vie, kto je v nej (naťahovanie, spomalenie)');
  // cúvne späť – pustí sa
  commit(w, [act('pos', 'eva', { x: r.before[0], y: r.before[1] })], spec(out));
  assert.ok(w.webs.list.some(x => x.id === wb.id) && !inside(), 'pustila sa celá');
  // znova a cez: v polovici ešte drží, políčko za ňou sa roztrhne
  walkThrough(w, 'eva', wb, out, 'half');
  assert.ok(w.webs.list.some(x => x.id === wb.id), 'na pol ceste ešte drží');
  commit(w, [act('pos', 'eva', { x: r.after[0], y: r.after[1] })], spec(out));
  assert.ok(!w.webs.list.some(x => x.id === wb.id), 'prerazená');
  const owner = spider(w, 's' + wb.o);
  assert.ok(['alert', 'chase'].includes(owner.st), 'majiteľ vie: ' + owner.st);
  assert.ok(out.some(m => m.t === 'toast' && /Prerazil/.test(m.text)));
  assert.ok(p);
});

test('ťahanie hodvábu: akcia pullStart, o WEB.pullMs udalosť pullDone; +1 hodváb, tretie potiahnutie pavučinu roztrhne a majiteľ to vždy zacíti', () => {
  const w = mkWorld(must(SEEDS[1]));
  const wb = webOf(w, x => x.o === 0), side = wb.ax ? [1, 0] : [0, 1];
  const p = join(w, 'eva', wb.x + 0.5 + must(side[0]), wb.y + 0.5 + must(side[1]), 0);
  // s lampášom nie
  p.lp = true;
  const r = commit(w, [act('pullStart', 'eva', { id: wb.id })], spec());
  assert.match(must(r.rejected[0]).reject ?? '', /lampášom/);
  p.lp = false;
  for (let k = 0; k < 3; k++) {
    const out: Out = [];
    commit(w, [act('pullStart', 'eva', { id: wb.id })], spec(out));
    const st = firstOf(out, 'pullStart');
    assert.ok(st, 'začal ťahať');
    p.pull = { id: wb.id, n: st.n, px: p.x, py: p.y }; // server: prítomnosť podľa pokynu pullStart
    const ev = must(E.pending(w, 'pull:eva') ?? undefined);
    assert.strictEqual(ev.at - w.tick, T(D.WEB.pullMs));
    run(w, T(D.WEB.pullMs), out);
    assert.ok(out.some(m => m.t === 'pullDone'));
    p.pull = null;
    assert.strictEqual(save(w, 'eva').inv.silk, k + 1);
  }
  assert.ok(!w.webs.list.some(x => x.id === wb.id), 'tretie potiahnutie ju roztrhlo');
  assert.ok(['alert', 'chase'].includes(spider(w, 's0').st), 'posledné potiahnutie zacíti vždy: ' + spider(w, 's0').st);
  // ťahanie sa preruší pohybom
  const wb2 = webOf(w, x => x.o === 0);
  moveTo(w, p, wb2.x + 0.5 + (wb2.ax ? 1 : 0), wb2.y + 0.5 + (wb2.ax ? 0 : 1));
  const out: Out = [];
  commit(w, [act('pullStart', 'eva', { id: wb2.id })], spec(out));
  p.pull = { id: wb2.id, n: must(firstOf(out, 'pullStart')).n, px: p.x, py: p.y };
  commit(w, [act('pos', 'eva', { x: p.x + (wb2.ax ? 0.5 : 0), y: p.y + (wb2.ax ? 0 : 0.5) })], spec(out));
  assert.strictEqual(E.pending(w, 'pull:eva'), null, 'pohol sa – ťahanie zrušené');
});

test('vlčiak: dobehne hráča, zabalí ho do pavučiny, vezme 3 hodváb naraz a hneď uteká domov', () => {
  const w = mkWorld(must(SEEDS[3])), V = D.SPIDERS.vlciak;
  const s = spider(w, 's0'), f = Sp.forestOf(w);
  const i = f.owner.findIndex((o, i) => o === 0 && Math.hypot(i % LW + 0.5 - s.hx, ((i / LW) | 0) + 0.5 - s.hy) > 2 && Math.hypot(i % LW + 0.5 - s.hx, ((i / LW) | 0) + 0.5 - s.hy) < 4);
  join(w, 'eva', i % LW + 0.5, ((i / LW) | 0) + 0.5, 5);
  Object.assign(s, { st: 'chase', tgt: 'eva', seen: w.tick, cool: 0, scared: 0 });
  wake(w, ['s0']);
  const out: Out = [];
  for (let k = 0; k < T(4000) && !out.some(m => m.t === 'webbed'); k++) run(w, 1, out);
  const wb = firstOf(out, 'webbed');
  assert.ok(wb, 'zabalil ho');
  assert.deepStrictEqual([wb.to, wb.stuck, wb.ms, wb.k], ['eva', V.webStuckMs, V.webMs, V.webSlow]);
  assert.strictEqual(save(w, 'eva').inv.silk, 5 - V.take, 'vzal hodváb naraz');
  assert.ok(out.some(m => m.t === 'toast' && /zabalil do pavučiny/.test(m.text)));
  const now = (): SpiderState => spider(w, 's0'); // čerstvé čítanie (stav mení engine)
  assert.strictEqual(now().st, 'return');
  assert.ok(now().fast, 'uteká');
  assert.ok(now().cool > w.tick, 'chvíľu si hráča nevšíma');
  // uteká rýchlosťou behu
  const before = { x: now().x, y: now().y };
  run(w, Sp.ticksOf(Sp.STEP_MS, 1200));
  const moved = Math.hypot(now().x - before.x, now().y - before.y);
  assert.ok(moved > V.walk * 1.5 * Sp.ticksOf(Sp.STEP_MS, 1200) * SEC + 0.01, 'rýchlejšie než chôdza: ' + moved);
  run(w, T(6000));
  assert.strictEqual(save(w, 'eva').inv.silk, 5 - V.take, 'viac nevezme');
});

test('vlčiak: za hranicou územia to po 2 s vzdá, a ide domov', () => {
  const w = mkWorld(must(SEEDS[4]));
  const s = spider(w, 's1'), f = Sp.forestOf(w);
  const out = f.owner.findIndex((o, i) => o !== 1 && !blocks(gOf(w.les, i)) && Math.hypot(i % LW + 0.5 - s.hx, ((i / LW) | 0) + 0.5 - s.hy) < 14);
  const p = join(w, 'eva', out % LW + 0.5, ((out / LW) | 0) + 0.5, 0);
  Object.assign(s, { st: 'chase', tgt: 'eva', seen: w.tick, cool: 0, scared: 0 });
  wake(w, ['s1']);
  run(w, T(D.SPIDERS.vlciak.borderMs) + 3);
  assert.ok(['return', 'home'].includes(spider(w, 's1').st), spider(w, 's1').st);
  assert.ok(p);
});

test('naháňanie: z diaľky beží k políčku, kde hráč o krok bude; na blízko rovno na hráča – stojaceho chytí, aj keď má v prítomnosti starú rýchlosť', () => {
  const w = mkWorld(must(SEEDS[3]));
  const s = spider(w, 's0'), f = Sp.forestOf(w), dt = SEC * Sp.ticksOf(Sp.STEP_MS, 1200);
  const tile = (x: number, y: number): number => Math.floor(y) * LW + Math.floor(x);
  // hráč 3–4 políčka od pavúka beží tak, že o krok bude na susednom políčku územia
  let p: Presence | null = null;
  for (let i = 0; i < f.owner.length && !p; i++) {
    const x = i % LW + 0.5, y = ((i / LW) | 0) + 0.5, d = Math.hypot(x - s.hx, y - s.hy);
    if (f.owner[i] !== 0 || d < 3 || d > 4) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (f.owner[tile(x + dx, y + dy)] !== 0) continue;
      p = join(w, 'eva', x + dx * 0.45, y + dy * 0.45, 0); p.vx = dx * 3.8; p.vy = dy * 3.8;
      break;
    }
  }
  assert.ok(p, 'miesto pre beh');
  Object.assign(s, { st: 'chase', tgt: 'eva', seen: w.tick, cool: 0, scared: 0 });
  wake(w, ['s0']);
  run(w, 1);
  assert.strictEqual(spider(w, 's0').goal, tile(p.x + (p.vx ?? 0) * dt, p.y + (p.vy ?? 0) * dt), 'cieľ cesty = políčko, kam hráč dobehne');
  // stojaci hráč tesne pri pavúkovi, v prítomnosti ešte rýchlosť z behu: pavúk ho aj tak chytí
  w.presence = []; delete w.saves['eva'];
  const w2 = mkWorld(must(SEEDS[3])), s2 = spider(w2, 's0');
  const near = f.owner.findIndex((o, i) => o === 0 && Math.hypot(i % LW + 0.5 - s2.hx, ((i / LW) | 0) + 0.5 - s2.hy) > 0.7 && Math.hypot(i % LW + 0.5 - s2.hx, ((i / LW) | 0) + 0.5 - s2.hy) < 1.1);
  const q = join(w2, 'eva', near % LW + 0.5, ((near / LW) | 0) + 0.5, 2);
  q.vx = 3.8; q.vy = 0; // už stojí, ale prítomnosť má starú rýchlosť
  Object.assign(s2, { st: 'chase', tgt: 'eva', seen: w2.tick, cool: 0, scared: 0 });
  wake(w2, ['s0']);
  run(w2, T(2000));
  assert.strictEqual(save(w2, 'eva').inv.silk || 0, 0, 'dobehol ho a zabalil (vzal aj posledné 2 hodvábu): ' + spider(w2, 's0').st);
});

test('stará pradlena: na siahnutie na pavučinu príde, zabalí hráča (3 hodváb, dlhšie) a odhodí za okraj; lampáš ju len pomaly odtláča', () => {
  const w = mkWorld(must(SEEDS[5]));
  const o = Sp.forestOf(w).homes.length - 1, s = spider(w, 's' + o), f = Sp.forestOf(w);
  const i = f.owner.findIndex((x, i) => x === o && Math.hypot(i % LW + 0.5 - s.hx, ((i / LW) | 0) + 0.5 - s.hy) >= 1.5);
  const p = join(w, 'eva', i % LW + 0.5, ((i / LW) | 0) + 0.5, 5);
  const wb = webOf(w, x => x.o === o);
  assert.ok(Sp.alert(f, s, wb, 'eva', w.tick));
  E.cancel(w, 'spider:' + s.id);
  const out: Out = [];
  run(w, T(20000), out);
  const sh = firstOf(out, 'shove');
  assert.ok(sh, 'odhodila');
  assert.strictEqual(save(w, 'eva').inv.silk, 2);
  const wbd = firstOf(out, 'webbed');
  assert.ok(wbd && wbd.ms === D.SPIDERS.pradlena.webMs && wbd.ms > D.SPIDERS.vlciak.webMs, 'jej pavučina drží dlhšie');
  assert.notStrictEqual(f.owner[Math.floor(sh.y) * LW + Math.floor(sh.x)], o, 'za okraj jej územia');
  // lampáš: odtláča ju 0,5 políčka/s
  const now = (): SpiderState => spider(w, 's' + o);
  Object.assign(now(), { x: now().hx, y: now().hy, st: 'chase', tgt: 'eva', cool: 0 });
  moveTo(w, p, now().hx + 1.6, now().hy); p.lp = true;
  if (f.owner[Math.floor(p.y) * LW + Math.floor(p.x)] !== o) moveTo(w, p, now().hx, now().hy + 1.6);
  wake(w, [now().id]);
  const d0 = Math.hypot(now().x - p.x, now().y - p.y);
  run(w, T(1000));
  const d1 = Math.hypot(now().x - p.x, now().y - p.y);
  assert.ok(d1 > d0 && d1 - d0 <= D.SPIDERS.pradlena.push + 0.06, `odtlačená pomaly (${(d1 - d0).toFixed(2)})`);
});

test('na strome: vlčiak pri pavučine vylezie na kmeň a čaká hlavou dole; pri lampáši vylezie vyššie a pavučinu nechá tak; potom zlezie', () => {
  let w: W | undefined, wb: WebState['list'][number] | undefined;
  for (const seed of SEEDS) { const ww = mkWorld(seed); w = ww; wb = ww.webs.list.find(x => x.o === 0 && Sp.trunkSpot(ww.les, x)); if (wb) break; }
  assert.ok(w && wb);
  const W0 = w, B = wb;
  const s = (): SpiderState => spider(W0, 's0'), f = Sp.forestOf(W0), V = D.SPIDERS.vlciak, spot = must(Sp.trunkSpot(W0.les, B) ?? undefined);
  const far = must(f.homes.find(h => Math.hypot(h.x - s().hx, h.y - s().hy) > 15));
  const p = join(W0, 'eva', far.x + 0.5, far.y + 0.5, 0);
  const t0 = must(Sp.webTiles(B)[0]);
  Object.assign(s(), { st: 'walk', web: B.id, path: [], x: t0 % LW + 0.5, y: ((t0 / LW) | 0) + 0.5 });
  wake(W0, ['s0']);
  run(W0, T(3000));
  assert.strictEqual(s().st, 'guard');
  assert.ok(Math.hypot(s().x - spot.x, s().y - spot.y) < 1e-6, 'na kmeni');
  assert.ok(s().z >= must(V.guard[0]) - 1e-6 && s().z <= must(V.guard[1]) + 1e-6, 'výška ' + s().z);
  run(W0, T(2000)); // dolezie do svojej výšky
  const e = must(Sp.entities(W0, 'les').find(x => x.id === s().id));
  assert.ok(e.z && e.z > 0 && e.n && e.u === 0, 'klient: výška, strana kmeňa, hlavou dole: ' + JSON.stringify(e));
  assert.ok(must(E.pending(W0, 'spider:s0') ?? undefined).at - W0.tick > 1, 'nečinný pavúk nekoná každý krok');
  moveTo(W0, p, s().x + 1, s().y); p.lp = true;
  wake(W0, ['s0']);
  run(W0, T(3000));
  assert.ok(Math.abs(s().z - V.high) < 1e-6, 'vyššie ' + s().z);
  assert.ok(!Sp.alert(f, s(), B, 'eva', W0.tick), 'pavučinu nechá tak');
  p.lp = false; moveTo(W0, p, far.x + 0.5, far.y + 0.5);
  let down = false;
  for (let k = 0; k < T(must(V.guardMs[1]) + 4000) && !down; k += 4) { run(W0, 4); down = s().st === 'return' && s().z === 0; }
  assert.ok(down, 'zliezol z kmeňa a ide domov');
});

test('plánovanie: jedna udalosť na pavúka; bez hráčov v lese spia (nič nekonajú), príchod hráča ich zobudí', () => {
  const w = mkWorld(must(SEEDS[2]));
  for (const id of Sp.IDS.filter(id => w.sps[id])) {
    assert.strictEqual(w.events.filter(e => e.key === 'spider:' + id).length, 1);
    assert.ok(must(E.pending(w, 'spider:' + id) ?? undefined).at - w.tick >= TPD, 'spí');
  }
  // hráč príde bránou z Lesa na pomedzí → pos zobudí pavúky (budú konať hneď v ďalšom kroku)
  const g = must(D.GATES.pomedzie.find(x => x.to === 'les'));
  const p = join(w, 'eva', g.x + 0.5, g.y + 1.5, 0, 'pomedzie');
  w.pomedzie = D.buildArea('pomedzie', 1).map(x => ({ g: x }));
  commit(w, [act('pos', 'eva', { x: g.x + 0.5, y: g.y + 0.5 })], spec());
  assert.strictEqual(save(w, 'eva').area, 'les');
  p.area = 'les'; Object.assign(p, { x: save(w, 'eva').x, y: save(w, 'eva').y });
  E.reconcile(w, spec()); // zrušené udalosti pavúkov engine hneď naplánuje znova podľa ich stavu
  for (const id of Object.keys(w.sps)) assert.strictEqual(E.pending(w, 'spider:' + id)?.at, w.tick + 1);
  run(w, T(2000));
  // hráč odíde → pavúky zaspia doma (nečinné najneskôr pri svojom ďalšom rozhliadnutí)
  w.presence = [];
  run(w, T(4000));
  for (const s of Object.values(w.sps)) { assert.strictEqual(s?.next, null); assert.deepStrictEqual([s.x, s.y], [s.hx, s.hy]); }
});

test('les žije len okolo hráčov: pavúk ďaleko od všetkých hráčov je doma a spí; pohyb hráča k jeho nore ho zobudí', () => {
  const w = mkWorld(must(SEEDS[2]));
  const f = Sp.forestOf(w), ids = Object.keys(w.sps);
  const h = must(f.homes[0]), far = must(f.homes.find(x => Math.hypot(x.x - h.x, x.y - h.y) > 30));
  const p = join(w, 'eva', far.x + 0.5, far.y + 0.5, 0);
  wake(w);
  run(w, T(4000));
  const s0 = spider(w, 's0');
  assert.strictEqual(s0.next, null, 'vzdialený pavúk spí');
  assert.deepStrictEqual([s0.x, s0.y, s0.st], [s0.hx, s0.hy, 'home']);
  assert.ok(ids.some(id => spider(w, id).next != null), 'pavúk pri hráčovi bdie');
  // hráč príde bližšie (pohyb cez engine) → les okolo neho ožije
  const i = f.owner.findIndex((o, i) => o === 0 && !blocks(gOf(w.les, i)) && Math.hypot(i % LW + 0.5 - s0.hx, ((i / LW) | 0) + 0.5 - s0.hy) > 8 && Math.hypot(i % LW + 0.5 - s0.hx, ((i / LW) | 0) + 0.5 - s0.hy) < 12);
  moveTo(w, p, i % LW + 0.5, ((i / LW) | 0) + 0.5);
  save(w, 'eva').x = p.x - 3; // skok – kontroluje sa len cieľové políčko
  commit(w, [act('pos', 'eva', { x: p.x, y: p.y })], spec());
  assert.strictEqual(spider(w, 's0').next, w.tick + 1, 'zobudený');
});

test('krížiak: kúty pri koncoch stien, najviac 3 pavučiny na plochu; výprava, keď je hráč na ploche, rýchly beh (5 políčok/s), odstránením sa nič nezíska', () => {
  for (const area of D.CORNER_AREAS) {
    const tiles = D.buildArea(area, 1).map(g => ({ g })), list = Sp.cornerSpots(tiles, D.W, D.H);
    assert.ok(list.length >= 4, area + ': dosť kútov');
    for (const s of list) {
      const t = must(tiles[s.i]);
      assert.ok(D.passable(t) && t.g !== 'gate');
      const wall = must(tiles[(s.y + s.dy) * D.W + s.x + s.dx]).g;
      assert.ok(D.CORNER_WALL[wall], 'vedľa je stena');
    }
  }
  const w = mkWorld(must(SEEDS[6]));
  const garden = (): string[] => must(w.corners.garden); // čerstvé čítanie (kúty mení engine)
  assert.strictEqual(garden().length, 1, 'nový svet má v kúte jednu pavučinu');
  // bez hráčov výpravy rovno utkajú (najviac 3)
  E.advanceTo(w, w.tick + 6 * TPD, spec());
  assert.strictEqual(garden().length, D.SPIDERS.kriziak.max);
  // odstránenie: akcia clearWeb, nič sa nezíska
  const k = must(garden()[0]), i = parseInt(k, 10);
  join(w, 'eva', i % D.W + 0.5, Math.floor(i / D.W) + 0.5, 0, 'garden');
  const out: Out = [];
  commit(w, [act('clearWeb', 'eva', { area: 'garden', i })], spec(out));
  assert.strictEqual(garden().length, 2);
  assert.ok(out.some(m => m.t === 'fx' && m.k === 'cobweb'));
  assert.deepStrictEqual(save(w, 'eva').inv, {});
  // hráč je na ploche: výprava je vidieť – krížiak beží 5 políčok/s a utká (hráč je ďaleko)
  E.cancel(w, 'kriziakTrip');
  const ev = E.scheduleUnique(w, 'kriziakTrip', w.tick + 1, 'kriziakTrip', null);
  ev.periodic = true;
  run(w, 2);
  const kz = (): Kriziak | null | undefined => w.kz.garden;
  const z = must(kz() ?? undefined);
  assert.ok(z.st === 'go', 'vybehol');
  let moved = 0, prev = { x: z.x, y: z.y };
  for (let n = 0; n < 400 && kz(); n++) { run(w, 1); const c = kz(); if (c && c.st === 'go') moved = Math.max(moved, Math.hypot(c.x - prev.x, c.y - prev.y)); if (c) prev = { x: c.x, y: c.y }; }
  assert.ok(Math.abs(moved - D.SPIDERS.kriziak.run * SEC) < 0.02, 'rýchlosť ' + moved);
  assert.strictEqual(garden().length, 3, 'dobehol a utkal');
});

test('kútová pavučina a klik: prázdna ruka ju odstráni, motyka na tráve najprv kope (pavučinu len tam, kde nemá čo robiť)', () => {
  const w = mkWorld(must(SEEDS[9]));
  const spot = Sp.spotsOf(w.tiles, 'garden').find(p => { const g = must(w.tiles[p.i]).g; return D.TILLABLE[g] && g !== 'ring'; });
  assert.ok(spot, 'kút na tráve');
  w.corners.garden = [spot.k];
  const me = join(w, 'eva', spot.x + 0.5, spot.y + 0.5, 0, 'garden');
  save(w, 'eva').inv = { hoe: 1, can: 1 };
  const click = (item: string): string | undefined => { const r = Actions.resolveAct(w, w.presence, me, { x: spot.x, y: spot.y, item }); return r && 'type' in r ? r.type : undefined; };
  assert.strictEqual(click(''), 'clearWeb');
  assert.strictEqual(click('hoe'), 'till', 'motyka kope');
  assert.strictEqual(click('can'), 'scavStart', 's krhlou sa v tráve hľadá (ako inde)');
  save(w, 'eva').inv.lamp = 1;
  assert.strictEqual(click('lamp'), 'clearWeb', 'lampáš na políčku nič nerobí – odstráni pavučinu');
});

test('krížiak: pri úteku vybehne na strom a stratí sa v korune (bez pavučiny)', () => {
  const w = mkWorld(must(SEEDS[7]));
  w.corners.garden = [];
  const t = w.tiles.findIndex((x, i) => x.g === 'tree' && i % D.W < D.W - 3 && D.passable(must(w.tiles[i + 2])) && D.passable(must(w.tiles[i + 3])));
  const tx = t % D.W, ty = (t / D.W) | 0;
  join(w, 'eva', tx + 3.5, ty + 0.5, 0, 'garden');
  const spot = must(Sp.spotsOf(w.tiles, 'garden')[0]);
  w.kz.garden = { id: 'kgarden', k: 'k', x: tx + 2.5, y: ty + 0.5, a: 0, path: [spot.i], w: D.W, spot: spot.k, trees: [[tx + 0.5, ty + 0.5, 0.14]], st: 'go', until: 0, left: 2, moving: false, next: w.tick + 1 };
  E.cancel(w, 'kz:garden');
  let climbed = false;
  const kzOf = (): Kriziak | null | undefined => w.kz.garden; // čerstvé čítanie (krížiaka mení engine)
  for (let n = 0; n < 60 && kzOf(); n++) {
    run(w, 1);
    const e = Sp.entities(w, 'garden')[0];
    if (e?.z && e.z > 0) { climbed = true; assert.ok(e.n && e.u === 1); assert.ok(Math.hypot(e.x - tx - 0.5, e.y - ty - 0.5) < 0.5, 'na kmeni stromu'); }
  }
  assert.ok(climbed, 'vybehol na strom');
  assert.strictEqual(w.kz.garden, null, 'zmizol v korune');
  assert.deepStrictEqual(w.corners.garden, [], 'pavučinu neutkal');
});

test('determinizmus: rovnaký svet a vstupy dajú rovnaký beh; denník (vbehnutie do pavučiny, naháňačka, chytenie) sa prehrá na ten istý svet', () => {
  const strip = (w: unknown): unknown => { const o = parseJson<{ les?: unknown; tiles?: unknown; hory?: unknown }>(JSON.stringify(w)); delete o.les; delete o.tiles; delete o.hory; return o; };
  const scenario = (): { w: W; out: Out; start: W } => {
    aid = 0;
    const w = mkWorld(must(SEEDS[3])), out: Out = [];
    out.journal = [];
    const wb = webOf(w, x => x.o === 0 && acrossWeb(w, x));
    join(w, 'eva', ...across(w, wb).before, 4);
    const start = parseJson<W>(JSON.stringify(w));
    walkThrough(w, 'eva', wb, out); // prerazí pavučinu
    E.advanceTo(w, w.tick + T(8000), spec(out));
    return { w, out, start };
  };
  const a = scenario(), b = scenario();
  assert.deepStrictEqual(strip(a.w), strip(b.w));
  const journal = must(a.out.journal);
  assert.ok(journal.length > 20, 'dávky: ' + journal.length);
  assert.ok(journal.some(e => e.inputs.some(i => i.type === 'spider')), 'pavúk v denníku');
  const room = a.start;
  E.replay(room, journal, spec());
  E.advanceTo(room, a.w.tick, spec()); // pôvodný beh skončil o pár prázdnych krokov neskôr
  const diff = (x: unknown, y: unknown, path: string): string | null => { if (JSON.stringify(x) === JSON.stringify(y)) return null; if (isRecord(x) && isRecord(y)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = diff(x[k], y[k], path + '.' + k); if (d) return d; } } return path + ': ' + JSON.stringify(x) + ' vs ' + JSON.stringify(y); };
  assert.deepStrictEqual(strip(room), strip(a.w), 'prehranie denníka dá ten istý svet: ' + String(diff(strip(room), strip(a.w), '')));
});

test('uloženie: pavučiny a kúty sa po načítaní zachovajú, neplatné sa zahodia; pavúky sú doma a spia', () => {
  const w = mkWorld(must(SEEDS[8]));
  const saved = parseJson<{ webs: WebState; corners: Partial<Record<AreaId, string[]>> }>(JSON.stringify(Sp.save(w)));
  saved.webs.list.push({ id: 999, x: 0, y: 0, ax: 0, n: 2, silk: 3, o: 0 }); // na okraji lesa – nesedí na mapu
  must(saved.corners.garden).push('nie-je-kut');
  // pavúky a krížiaky sa neukladajú – po načítaní ich postaví load (sps, kz bez hodnoty)
  const w2: GameWorld = Object.assign({}, w, saved, { events: w.events.slice() });
  delete w2.sps; delete w2.kz;
  Sp.load(w2, E.liveCtx(w2, 'pavuky'));
  assert.deepStrictEqual(must(w2.webs ?? undefined).list.map(x => x.id).sort((a, b) => a - b), w.webs.list.map(x => x.id).sort((a, b) => a - b));
  assert.deepStrictEqual(w2.corners?.garden, w.corners.garden);
  const spsOf = (x: GameWorld): Partial<Record<string, SpiderState>> => must(x.sps); // čerstvé čítanie (delete vyššie zúžilo typ)
  for (const s of Object.values(spsOf(w2))) { assert.strictEqual(s?.st, 'home'); assert.strictEqual(s.next, null); }
});

// voľný port od systému (náhodný port sa občas zrazil s iným testom)
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, () => { const port = portOf(srv); srv.close(() => { r(port); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DEFAULT_MODE: 'paused' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c) + ': ' + err.slice(0, 800))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }

test('server: svet z verzie 9 dostane pavučiny; v lese sa ťahá hodváb, s lampášom nie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-spiders-'));
  const port = await freePort();
  const lesSeed = 777, f = Sp.analyze(D.buildLes(lesSeed).map(g => ({ g })), lesSeed);
  const save9 = {
    v: 9, tick: SEASON_TICK(2), wall: Date.now(), mode: 'paused', daySeconds: 1200, seed: E.newSeed(), step: 0, seq: 0, events: [], weather: 'sun', pomedzieSeed: 1, lesSeed, les: null, scav: {}, scavSalt: 1,
    saves: { eva: { coins: 5, water: 3, inv: { hoe: 1, can: 1, lamp: 1 }, recipes: [], seen: [], vily: 0, rep: 0, up: { can: 0, composter: 0 }, x: 1, y: 1, area: 'les' } },
    storage: {}, icehouse: { built: false, ice: 0 }, hory: null, up: { plots: 0 }
  };
  fs.writeFileSync(path.join(dir, 'room-sp.json'), JSON.stringify(save9));
  const proc = await startServer(dir, port);
  try {
    const ws = new WebSocket('ws://127.0.0.1:' + port), msgs: ServerMessage[] = [];
    ws.on('message', raw => { msgs.push(parseMsg(raw)); });
    await new Promise<void>(r => ws.on('open', () => { r(); }));
    const wait = async <T extends MsgType>(t: T, test?: (m: MsgOf<T>) => unknown, ms?: number): Promise<MsgOf<T>> => {
      const pred = (m: ServerMessage): m is MsgOf<T> => isMsg(m, t) && (!test || !!test(m));
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 4000)) { const k = msgs.findIndex(pred); const m = k >= 0 ? msgs.splice(k, 1)[0] : undefined; if (m && pred(m)) return m; await new Promise(r => setTimeout(r, 20)); }
      throw new Error('správa neprišla');
    };
    ws.send(JSON.stringify({ t: 'join', room: 'sp', name: 'Eva' }));
    const wel = await wait('welcome');
    const webs = await wait('webs');
    assert.ok(webs.webs.length >= 15, 'v jeseni je les plný pavučín');
    assert.deepStrictEqual(webs.homes.map(h => [h.k, h.x, h.y]), f.homes.map(h => [h.k, h.x, h.y]));
    // postaví sa vedľa pavučiny (na susedné voľné políčko mimo nej)
    const tiles = wel.tiles, sideOf = (wb: (typeof webs.webs)[number]): readonly [number, number] | undefined => (wb.ax ? [[1, 0], [-1, 0]] as const : [[0, 1], [0, -1]] as const).find(([dx, dy]) => { const g = tiles[(wb.y + dy) * LW + wb.x + dx]; return g && !blocks(g.g) && !webs.webs.some(o => Sp.webTiles(o).includes((wb.y + dy) * LW + wb.x + dx)); });
    const wb = must(webs.webs.find(sideOf)), [dx, dy] = must(sideOf(wb)); // pavučina s voľným políčkom vedľa
    const at = { x: wb.x + dx + 0.5, y: wb.y + dy + 0.5 };
    ws.send(JSON.stringify({ t: 'move', x: at.x, y: at.y, dir: 0, lp: true, ar: wel.seq }));
    await wait('pl', m => m.list.some(p => p.x === at.x && p.y === at.y));
    ws.send(JSON.stringify({ t: 'act', x: wb.x, y: wb.y, item: 'lamp' }));
    assert.match((await wait('toast', m => /lampáš/.test(m.text))).text, /neutrhneš/);
    ws.send(JSON.stringify({ t: 'move', x: at.x, y: at.y, dir: 0, lp: false, ar: wel.seq }));
    await new Promise(r => setTimeout(r, 150));
    ws.send(JSON.stringify({ t: 'act', x: wb.x, y: wb.y, item: '' }));
    assert.match((await wait('toast', m => /Pavúčí hodváb/.test(m.text), 3000)).text, /\+1/);
    const me = await wait('me', m => m.inv.silk === 1);
    assert.strictEqual(me.inv.silk, 1);
    ws.close();
  } finally { await stopServer(proc); }
  const saved = readJson<SaveFile & { sps?: unknown; kz?: unknown }>(path.join(dir, 'room-sp.json'));
  assert.strictEqual(saved.v, 13);
  assert.strictEqual(saved.migratedFrom, 9);
  assert.ok(saved.webs.list.length >= 15);
  assert.ok(saved.corners.garden.length >= 1);
  assert.ok(!saved.sps && !saved.kz, 'pavúky sa neukladajú');
  assert.strictEqual(must(saved.saves['eva']).inv.silk, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pavučina: parametre sa orežú na rozsah; vlákna začínajú na kmeňoch opôr (strom, obor, ker, spadnutý kmeň)', () => {
  const over = { rays: 999, pitch: -1, fill: 1.4, nope: 3 }; // aj neznámy parameter (nope)
  const P = Webs.webParams(over);
  assert.strictEqual(P.rays, Webs.WEB_PARAMS.rays.max);
  assert.strictEqual(P.pitch, Webs.WEB_PARAMS.pitch.min);
  assert.strictEqual(P.fill, 1);
  assert.ok(!('nope' in P));
  assert.deepStrictEqual(Webs.webParams(), Object.fromEntries(Object.entries(Webs.WEB_PARAMS).map(([k, d]) => [k, d.def])));
  // chodník široký 2 políčka medzi dvoma oporami v riadku 3
  const geom = (anchor: Ground, over?: Webs.WebOverrides): Webs.WebGeom => {
    const w = 8, h = 6, t = new Array<Ground>(w * h).fill('path'), put = (x: number, y: number, g: Ground): void => { t[y * w + x] = g; };
    if (anchor === 'giant') { put(1, 2, 'giant'); put(2, 2, 'trunk'); put(1, 3, 'trunk'); put(2, 3, 'trunk'); put(5, 2, 'giant'); put(6, 2, 'trunk'); put(5, 3, 'trunk'); put(6, 3, 'trunk'); }
    else { put(2, 3, anchor); put(5, 3, anchor); }
    return Webs.webGeom(t.map(g => ({ g })), w, h, { x: 3, y: 3, ax: 0, n: 2 }, over);
  };
  for (const a of ['tree', 'giant', 'bush', 'log'] as const) {
    const g = geom(a), A = must(Webs.ANCHOR[a]), ga = must(g.a ?? undefined), gb = must(g.b ?? undefined);
    assert.strictEqual(ga.g === 'trunk' ? 'giant' : ga.g, a === 'giant' ? 'giant' : a);
    // dotyk leží na povrchu kmeňa (kruh okolo stredu opory) a pavučina je medzi oporami
    assert.ok(Math.abs(Math.hypot(g.u0 - ga.cx, g.line - ga.cz) - A.r) < 1e-9, a + ': ľavý dotyk na kmeni');
    assert.ok(Math.abs(Math.hypot(g.u1 - gb.cx, g.line - gb.cz) - A.r) < 1e-9, a + ': pravý dotyk na kmeni');
    assert.ok(g.u0 <= 3 && g.u1 >= 5 && g.len > 2);
    assert.strictEqual(g.hgt, Math.min(Webs.WEB_PARAMS.height.def, A.top), a + ': pri nízkej opore nižšia');
  }
  const giant = must(geom('giant').a ?? undefined);
  assert.deepStrictEqual([giant.cx, giant.cz], [2, 3], 'obor: stred kmeňa v strede štvorca 2 × 2');
  assert.strictEqual(geom('tree', { height: 1.6 }).hgt, 1.6);
  // rozpätie z parametrov mení, kde môžu pavučiny visieť
  const les = D.buildLes(must(SEEDS[0])).map(g => ({ g }));
  const n1 = Webs.analyze(les, must(SEEDS[0]), { span: 1, gladeSpan: 1 }).cands.flat(), n4 = Webs.analyze(les, must(SEEDS[0]), { span: 4, gladeSpan: 5 }).cands.flat();
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
  const at = (v: Float32Array, i: number): number => v[i] ?? NaN;
  let maxZ = 0;
  for (let i = 0; i < a.count; i++) {
    const x = at(a.pos, i * 3) + opts.w / 2, y = at(a.pos, i * 3 + 1) + opts.h / 2, z = at(a.pos, i * 3 + 2);
    assert.ok(x >= -1e-6 && x <= opts.w + 1e-6 && y >= -1e-6 && y <= opts.h + 1e-6, 'v rámci pavučiny');
    if (x < 1e-6 || x > opts.w - 1e-6) assert.ok(Math.abs(z) < 1e-6, 'na kmeni bez vydutia');
    maxZ = Math.max(maxZ, Math.abs(z));
    assert.ok(Math.abs(Math.hypot(at(a.tan, i * 3), at(a.tan, i * 3 + 1), at(a.tan, i * 3 + 2)) - 1) < 1e-5, 'smer vlákna je jednotkový');
  }
  assert.ok(maxZ > 0.05 && maxZ <= Webs.WEB_PARAMS.bow.def * 1.25 + 1e-9);
  assert.ok(Webs.webThreads({ bow: 0 }, opts).pos.every((v, i) => i % 3 !== 2 || v === 0), 'bez vydutia rovná');
  const torn = Webs.webThreads({}, Object.assign({ keep: 0.42 }, opts));
  assert.ok(torn.count < a.count * 0.8, 'vyťahaná pavučina má menej vlákien');
});

test('kútová pavučina: 3 kotvy na 2 alebo 3 plochách kúta, rám vo vzduchu, občas zlom s vláknom k vrcholu', () => {
  let breaks = 0;
  for (let seed = 1; seed <= 60; seed++) for (const faces of [2, 3]) {
    const t = must(Webs.cornerThreads({}, { seed, faces }) ?? undefined), S = Webs.WEB_PARAMS.cornerSize.def;
    // každá kotva leží na niektorej ploche kúta: stena 1 (X = 0), zem (Y = 0), pri troch plochách aj stena 2 (Z = 0)
    const on = t.anchors.map(p => p[0] === 0 ? 'w1' : p[1] === 0 ? 'g' : p[2] === 0 ? 'w2' : '?');
    assert.ok(!on.includes('?'));
    if (faces === 3) assert.deepStrictEqual(on.slice().sort(), ['g', 'w1', 'w2']);
    else assert.ok(new Set(on).size === 2 && !on.includes('w2'), 'dve plochy: stena a zem');
    assert.ok(t.anchors.every(p => p.every(v => v >= 0 && v <= S + 1e-9)), 'do cornerSize od kúta');
    // všetky vlákna vo vzduchu (v kladnom kvadrante) – nikdy nejdú do steny ani do zeme
    for (const v of t.pos) assert.ok(v >= -1e-6, 'vlákno vo vzduchu');
    // všetky vlákna v rovine troch kotiev
    const [A, B, C] = t.anchors, u: Webs.Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w: Webs.Vec3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n: Webs.Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], nl = Math.hypot(...n);
    const pos = (i: number): number => t.pos[i] ?? NaN;
    for (let i = 0; i < t.count; i++) assert.ok(Math.abs(((pos(i * 3) - A[0]) * n[0] + (pos(i * 3 + 1) - A[1]) * n[1] + (pos(i * 3 + 2) - A[2]) * n[2]) / nl) < 1e-6);
    assert.ok(t.count / 2 > 40, 'vyplnená');
    if (t.layout.nH === 2) breaks++;
  }
  assert.ok(breaks > 30 && breaks < 90, `zlom približne v polovici (${breaks}/120)`);
  assert.strictEqual(Webs.cornerThreads({ cornerBreak: 0 }, { seed: 5, faces: 2 })?.layout.nH, 1);
  assert.strictEqual(Webs.cornerThreads({ cornerBreak: 1 }, { seed: 5, faces: 2 })?.layout.nH, 2);
});

test('kúty v budovách z minikociek: hrana steny so zemou a pod presahom strechy, nesúmerná veľkosť, nie na streche', () => {
  // model 12 × 12 × 12: stena v x = 0…3 (celá výška 10), na vrchu presah strechy x = 4…7 vo výške 9; schod na zemi v z = 0…1
  const sx = 12, sy = 12, sz = 12, data = new Uint8Array(sx * sy * sz);
  const put = (x: number, y: number, z: number): void => { data[(z * sy + y) * sx + x] = 1; };
  for (let z = 0; z < sz; z++) { for (let y = 0; y < 10; y++) for (let x = 0; x < 4; x++) put(x, y, z); for (let x = 4; x < 8; x++) put(x, 9, z); }
  for (let x = 8; x < 11; x++) for (let z = 0; z < 2; z++) put(x, 0, z); // nízky schod pod holým nebom
  const all = Webs.voxelCorners({ sx, sy, sz, data }, { x0: 0, x1: sx - 1, y0: 0, y1: sy - 1, z0: 0, z1: sz - 1 });
  const key = (q: Webs.VoxelCorner): string => q.X.join() + '|' + q.Y.join();
  // stena a zem: X von zo steny (+x), Y hore; voľné miesto po presah (4 kocky) a 8 nahor (strop 9 – najviac max 8)
  const ground = must(all.find(q => key(q) === '1,0,0|0,1,0' && q.o[1] === 0 && q.v[2] >= 2)); // mimo schodu
  assert.strictEqual(must(all.find(q => key(q) === '1,0,0|0,1,0' && q.v[2] < 2)).size[0], 4, 'pri schode len po schod');
  assert.ok(ground, 'hrana steny so zemou');
  assert.strictEqual(ground.size[0], 8);
  assert.deepStrictEqual(ground.o.slice(0, 2), [4, 0], 'roh na päte steny');
  // pod presahom strechy: X dole (von zo strechy), Y von zo steny – výška pod strechou 8 (y 1…8 nad schodom/ zemou 0…8 = 9 → max 8)
  const eave = must(all.find(q => q.X.join() === '1,0,0' && q.Y.join() === '0,-1,0'));
  assert.ok(eave, 'pod strechou pri stene');
  assert.strictEqual(eave.size[0], 4, 'od steny len po okraj presahu (4 kocky)');
  assert.strictEqual(eave.size[1], 8, 'nadol po stene (najviac 8)');
  assert.deepStrictEqual(eave.o.slice(0, 2), [4, 9]);
  // na schode pod holým nebom nič (vodorovná plocha nad zemou bez strechy nad ňou)
  assert.ok(!all.some(q => q.v[1] === 1 && q.v[0] >= 8), 'nie na streche/schode pod nebom');
  // veľkosti: aspoň 2 kocky, nikdy viac ako voľné miesto; rôzne semienka → rôzne a nesúmerné
  const sizes = new Set<string>();
  for (let s = 1; s <= 40; s++) {
    const q = must(Webs.pickVoxelCorner(all, s) ?? undefined);
    q.vox.forEach((n, i) => { assert.ok(n >= 2 && n <= must(q.free[i])); });
    assert.deepStrictEqual(q.size, q.vox.map(n => n / 8));
    sizes.add(q.vox.join('x'));
  }
  assert.ok(sizes.size > 10, 'rôzne veľkosti');
  assert.ok([...sizes].some(s => { const v = s.split('x').map(Number); return Math.max(...v) >= 3 * Math.min(...v); }), 'aj pretiahnuté (napr. 2 × 6)');
  // pavučina s veľkosťou po osiach drží kotvy v nej
  const t = must(Webs.cornerThreads({}, { seed: 9, faces: 2, size: [2 / 8, 6 / 8, 3 / 8] }) ?? undefined);
  assert.ok(t.anchors.every(p => p[0] <= 2 / 8 + 1e-9 && p[1] <= 6 / 8 + 1e-9 && p[2] <= 3 / 8 + 1e-9));
});

test('pavučina v budove: kotvy (aj zlom) sa navzájom vidia – medzi nimi nie je plná minikocka', () => {
  let webs = 0;
  for (const id of ['house', 'hut', 'stall', 'icehouse', 'well']) {
    const f = must(W3.FINE_MODELS.find(m => m.id === id)).build(1, 0);
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
