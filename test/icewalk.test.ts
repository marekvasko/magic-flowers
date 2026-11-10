// Chôdza po ľade (#157): šmýkanie s hybnosťou, pošmyknutie pri prudkej zákrute (kocka enginu), čupnutie, prepadnutie
// cez otvor, plávanie a vylezenie z vody – fyzika (shared/icewalk.ts) aj rozhodnutia servera v návrhu pos (icewalk.ts).
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import * as IW from '../src/shared/icewalk.ts';
import { ICE } from '../src/shared/icewalk.ts';
import * as E from '../src/server/engine.ts';
import * as IceWalk from '../src/server/icewalk.ts';
import * as Cheats from '../src/server/cheats.ts';
import type { CheatData } from '../src/server/cheats.ts';
import type { Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { SPEC, act, json, makeWorld, save, textOf, TPD } from './game-world.ts';
import type { W } from './game-world.ts';
import { must, parseJson, rethrow } from './helpers.ts';

type Spec = E.Spec<W, Presence, Msg>;
type Journal = E.JournalEntry<Presence, Msg>[];
const spec: Spec = { ...SPEC, proposers: { ...SPEC.proposers, ...Cheats.PROPOSERS }, onError: rethrow };
const WINTER_DAY = 3 * D.DAYS_PER_SEASON + 1; // prvý deň zimy
const winterTick = (): number => (WINTER_DAY - 1) * TPD + D.DAWN_TICK + 20;

// Zimný svet: ana stojí uprostred jazierka (políčko vody, okolo ktorého je samá voda – hľadá sa, nie pevné súradnice)
function iceWorld(seed: number): { w: W; i: number; cx: number; cy: number } {
  const w = makeWorld(seed, winterTick());
  w.icewalk = {};
  const water = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < D.W && y < D.H && must(w.tiles[y * D.W + x]).g === 'water';
  const i = w.tiles.findIndex((t, k) => {
    const x = k % D.W, y = Math.floor(k / D.W);
    return t.g === 'water' && [-1, 0, 1].every(dy => [-1, 0, 1].every(dx => water(x + dx, y + dy)));
  });
  assert.ok(i >= 0, 'jazierko má vnútorné políčko');
  const cx = i % D.W + 0.5, cy = Math.floor(i / D.W) + 0.5;
  Object.assign(save(w, 'ana'), { x: cx, y: cy, area: 'garden' });
  return { w, i, cx, cy };
}
let ts = 1000;
// Pohyb, ako ho pošle klient: poloha, vstup a čas (ms) o dt sekúnd neskôr
const mv = (key: string, x: number, y: number, ix: number, iy: number, dt = 0.1, extra?: { ck?: boolean }): E.Input => act('pos', key, { x, y, ix, iy, ts: (ts += dt * 1000), ...extra });
const iw = (w: W, key = 'ana'): ReturnType<typeof IceWalk.load>[string] => (w.icewalk || {})[key];
const pos = (w: W, key = 'ana'): [number, number] => [save(w, key).x, save(w, key).y];
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// ---- Fyzika ----

test('fyzika: ľad je zamrznutá voda v zime a ľadovec s ľadom; otvor ľad nie je; vodou sa dá prejsť len v zime alebo plávaním', () => {
  const water = { g: 'water' as const }, hole = { g: 'water' as const, cut: 1 as const }, gl = { g: 'glacier' as const, ice: 3 }, gl0 = { g: 'glacier' as const, ice: 0 };
  assert.deepStrictEqual([IW.isIce(water, 3), IW.isIce(water, 0), IW.isIce(hole, 3), IW.isIce(gl, 1), IW.isIce(gl0, 3), IW.isIce({ g: 'grass' }, 3)], [true, false, false, true, false, false]);
  assert.deepStrictEqual([IW.isHole(hole, 3), IW.isHole(water, 3), IW.openWater(hole, 3), IW.openWater(water, 3), IW.openWater(water, 1)], [true, false, true, false, true]);
  assert.deepStrictEqual([IW.passableNow(water, 3, false), IW.passableNow(water, 1, false), IW.passableNow(water, 1, true), IW.passableNow({ g: 'tree' }, 3, true)], [true, false, true, false]);
  // z brehu (piesok) na ľad sa schádza, z ľadu na breh je to krok o pol bloku hore (dá sa), plazením nie
  assert.deepStrictEqual([IW.canStep({ g: 'sand' }, water, 3, false), IW.canStep(water, { g: 'sand' }, 3, false), IW.canStep(water, { g: 'sand' }, 3, false, 0, true), IW.canStep({ g: 'sand' }, water, 1, false)], [true, true, false, false]);
});

test('fyzika: hybnosť nezávisí od toho, na koľko krokov sa čas rozdelí; brzdenie bez vstupu je pomalšie než na zemi', () => {
  let a: [number, number] = [0, 0], b: [number, number] = [0, 0];
  a = IW.accelerate(a[0], a[1], 1, 0, 0.4);
  for (let k = 0; k < 8; k++) b = IW.accelerate(b[0], b[1], 1, 0, 0.05);
  assert.ok(near(a[0], b[0]) && near(a[1], b[1]), 'rovnaký výsledok pre 1 × 0,4 s aj 8 × 0,05 s');
  assert.ok(near(a[0], ICE.accel * 0.4), 'rozbeh je postupný');
  const full = IW.accelerate(0, 0, 1, 0, 10);
  assert.deepStrictEqual(full, [ICE.speed, 0], 'najviac plná rýchlosť');
  const coast = IW.accelerate(ICE.speed, 0, 0, 0, 0.5);
  assert.ok(coast[0] > 0 && near(coast[0], ICE.speed - ICE.brake * 0.5), 'bez vstupu sa ešte šmýka');
});

test('fyzika: rovno a mierna zákruta sú bezpečné, otočka v plnej rýchlosti takmer istá; pomaly sa nepošmykne nikto', () => {
  const v = ICE.speed;
  assert.strictEqual(IW.slipChance(v, 0, 1, 0, 0.1), 0, 'rovno');
  assert.strictEqual(IW.slipChance(v, 0, Math.cos(0.8), Math.sin(0.8), 0.1), 0, 'zákruta do 60°');
  const turn = IW.slipChance(v, 0, 0, 1, 0.1), back = IW.slipChance(v, 0, -1, 0, 0.1);
  assert.ok(turn > 0 && back > turn && back > 0.5, `90° ${turn.toFixed(2)}, otočka ${back.toFixed(2)}`);
  assert.strictEqual(IW.slipChance(1, 0, -1, 0, 0.1), 0, 'pomaly');
  assert.strictEqual(IW.slipChance(v, 0, 0, 0, 0.1), 0, 'bez vstupu (len sa šmýka)');
  assert.ok(near(IW.slipChance(v, 0, -1, 0, 0.2), 1 - (1 - back) ** 2), 'riziko nezávisí od dĺžky kroku');
});

// ---- Server: návrh pos ----

test('šmýkanie: vstup na ľad dá hybnosť; bez vstupu sa hráč šmýka ďalej – server zapíše svoju polohu a pošle opravu', () => {
  const { w, cx, cy } = iceWorld(1);
  Object.assign(save(w, 'ana'), { x: cx - 1.4, y: cy }); // ešte na ľade, ale stav chýba → prvý krok ako na zemi
  let r = E.commitBatch(w, [mv('ana', cx - 1, cy, 1, 0)], spec);
  assert.deepStrictEqual(pos(w), [cx - 1, cy], 'prvý krok platí, ako ho poslal klient');
  assert.ok(must(iw(w)).vx > 3, 'hybnosť z kroku');
  // klient tvrdí, že zastal na mieste – na ľade to nejde, server ho posunie po hybnosti
  r = E.commitBatch(w, [mv('ana', cx - 1, cy, 0, 0, 0.2)], spec);
  const [x] = pos(w);
  assert.ok(x > cx - 1 + 0.3, `šmýka sa ďalej (x ${x.toFixed(2)})`);
  const fix = r.outbox.find((m): m is Extract<Msg, { t: 'iw' }> => m.t === 'iw');
  assert.ok(fix && near(fix.x ?? NaN, x, 1e-3), 'oprava polohy klientovi');
  assert.ok(must(iw(w)).vx < ICE.speed && must(iw(w)).vx > 0, 'brzdí');
  // na ľade platí vždy výpočet servera; keď je klient blízko, opravu mu neposiela
  const st = must(iw(w)), ex = x + IW.accelerate(st.vx, st.vy, 0, 0, 0.1)[0] * 0.1;
  r = E.commitBatch(w, [mv('ana', ex + 0.05, cy, 0, 0)], spec);
  assert.ok(near(pos(w)[0], ex) && !r.outbox.some(m => m.t === 'iw'), 'malý rozdiel: bez opravy');
});

test('pošmyknutie: otočka v plnej rýchlosti → leží (pevný počet krokov), nehýbe sa, potom vstane; každý svet rovnako (kocka enginu)', () => {
  const run = (seed: number): { slipAt: number; w: W; out: Msg[] } => {
    const { w, cx, cy } = iceWorld(seed);
    w.icewalk = { ana: { vx: ICE.speed, vy: 0, t: ts } };
    let x = cx - 1, slipAt = -1;
    Object.assign(save(w, 'ana'), { x });
    const out: Msg[] = [];
    for (let k = 0; k < 30 && slipAt < 0; k++) {
      const r = E.commitBatch(w, [{ ...mv('ana', x, cy, -1, 0), id: 'a#' + String(k) }], spec); // prudko späť (rovnaké id → rovnaká kocka)
      out.push(...r.outbox);
      x = pos(w)[0];
      if (iw(w)?.fall != null) slipAt = k;
      else Object.assign(must(iw(w)), { vx: ICE.speed, vy: 0 }); // stále v plnej rýchlosti
    }
    return { slipAt, w, out };
  };
  const a = run(5), b = run(5);
  assert.ok(a.slipAt >= 0, 'pošmykne sa');
  assert.strictEqual(a.slipAt, b.slipAt, 'rovnaký svet → rovnaký výsledok');
  assert.ok(a.out.some(m => textOf(m) === IceWalk.MSG.slip) && a.out.some(m => m.t === 'fx' && m.k === 'ice'));
  const w = a.w, st = must(iw(w)), fall = must(st.fall);
  assert.deepStrictEqual([st.vx, st.vy], [0, 0]);
  assert.strictEqual(fall - w.tick, IW.ticksOf(ICE.fallS, w.daySeconds));
  assert.strictEqual(IceWalk.pose(st, w.tick), 'fall');
  const [x, y] = pos(w);
  let r = E.commitBatch(w, [mv('ana', x + 0.2, y, 1, 0)], spec);
  assert.deepStrictEqual([r.rejected.length, pos(w)[0]], [1, x], 'kým leží, nehne sa');
  E.advanceTo(w, fall, spec);
  r = E.commitBatch(w, [mv('ana', x + 0.03, y, 1, 0)], spec);
  assert.strictEqual(r.applied.length, 1, 'vstal');
  assert.strictEqual(iw(w)?.fall, undefined);
  assert.strictEqual(IceWalk.pose(iw(w), w.tick), null);
});

test('čupnutie: čupnutý sa nepošmykne ani pri otočkách a pred otvorom zastane; nečupiaci sa cez otvor prepadne', () => {
  const { w, i, cx, cy } = iceWorld(7);
  w.icewalk = { ana: { vx: ICE.speed, vy: 0, t: ts } };
  for (let k = 0; k < 60; k++) {
    const [x] = pos(w);
    E.commitBatch(w, [mv('ana', x, cy, k % 2 ? -1 : 1, 0, 0.1, { ck: true })], spec);
    assert.strictEqual(iw(w)?.fall, undefined, 'čupnutý sa nepošmykne');
    Object.assign(must(iw(w)), { vx: ICE.speed * (k % 2 ? 1 : -1), vy: 0 }); // najhoršia otočka zakaždým
    Object.assign(save(w, 'ana'), { x: cx, y: cy });
  }
  // otvor o políčko vpravo: čupnutý doň nevstúpi (odmietnuté → oprava na potvrdené miesto)
  const hole = i + 1;
  must(w.tiles[hole]).cut = 1;
  w.icewalk = {};
  Object.assign(save(w, 'ana'), { x: cx + 0.45, y: cy });
  let r = E.commitBatch(w, [mv('ana', cx + 0.6, cy, 1, 0, 0.1, { ck: true })], spec);
  assert.deepStrictEqual([r.rejected.length, pos(w)[0]], [1, cx + 0.45], 'čupnutý pred otvorom zastane');
  r = E.commitBatch(w, [mv('ana', cx + 0.6, cy, 1, 0)], spec);
  assert.deepStrictEqual(pos(w), [cx + 1, cy], 'prepadol sa – je uprostred otvoru');
  assert.ok(r.outbox.some(m => textOf(m) === IceWalk.MSG.fallIn) && r.outbox.some(m => m.t === 'fx' && m.k === 'splash'));
  assert.strictEqual(must(iw(w)).sw, 1);
  assert.strictEqual(IceWalk.pose(iw(w), w.tick), 'swim');
});

test('plávanie: vo vode pomaly (bez hybnosti); von len na breh alebo pevný ľad; mimo zimy sa do vody nevojde', () => {
  const { w, i, cx, cy } = iceWorld(8);
  must(w.tiles[i]).cut = 1; must(w.tiles[i + 1]).cut = 1; // dva otvory vedľa seba
  w.icewalk = { ana: { vx: 0, vy: 0, t: ts, sw: 1 } };
  // rýchlejšie, než sa dá plávať: server pohyb skráti a pošle opravu
  let r = E.commitBatch(w, [mv('ana', cx + 0.9, cy, 1, 0)], spec);
  const [x] = pos(w);
  assert.ok(x > cx && x < cx + 0.3, `pláva pomaly (x ${(x - cx).toFixed(2)})`);
  assert.ok(r.outbox.some(m => m.t === 'iw' && 'x' in m));
  assert.strictEqual(must(iw(w)).sw, 1);
  // z otvoru do susedného otvoru: stále pláva
  Object.assign(save(w, 'ana'), { x: cx + 0.95 });
  E.commitBatch(w, [mv('ana', cx + 1.05, cy, 1, 0)], spec);
  assert.strictEqual(must(iw(w)).sw, 1, 'v otvore stále pláva');
  // na pevný ľad (nad otvorom): vyliezol
  Object.assign(save(w, 'ana'), { x: cx + 1.5, y: cy - 0.45 });
  r = E.commitBatch(w, [mv('ana', cx + 1.5, cy - 0.55, 0, -1)], spec);
  assert.deepStrictEqual(pos(w), [cx + 1.5, cy - 0.55]);
  assert.strictEqual(iw(w), undefined, 'už nepláva');
  assert.ok(r.outbox.some(m => textOf(m) === IceWalk.MSG.out));
  // mimo zimy je voda neprechodná ako doteraz – z brehu sa do nej nevojde
  const sp = makeWorld(9);
  sp.icewalk = {};
  const shore = sp.tiles.findIndex((t, k) => t.g === 'sand' && sp.tiles[k + 1]?.g === 'water');
  Object.assign(save(sp, 'ana'), { x: shore % D.W + 0.5, y: Math.floor(shore / D.W) + 0.5, area: 'garden' });
  r = E.commitBatch(sp, [mv('ana', shore % D.W + 1.5, Math.floor(shore / D.W) + 0.5, 1, 0)], spec);
  assert.strictEqual(r.rejected.length, 1, 'v lete sa do vody nevojde');
  // kto však vo vode už je (napr. ľad sa roztopil), pláva k brehu
  Object.assign(save(sp, 'ana'), { x: shore % D.W + 1.5 });
  r = E.commitBatch(sp, [mv('ana', shore % D.W + 1.4, Math.floor(shore / D.W) + 0.5, -1, 0)], spec);
  assert.deepStrictEqual([r.applied.length, must(iw(sp)).sw], [1, 1]);
});

test('na zemi sa nič nemení: pohyb platí, ako ho poslal klient, a stav ľadu sa nezakladá', () => {
  const w = makeWorld(10, winterTick());
  w.icewalk = {};
  const grass = w.tiles.findIndex((t, k) => t.g === 'grass' && w.tiles[k + 1]?.g === 'grass'), gx = grass % D.W + 0.5, gy = Math.floor(grass / D.W) + 0.5;
  Object.assign(save(w, 'ana'), { x: gx, y: gy, area: 'garden' });
  const r = E.commitBatch(w, [mv('ana', gx + 0.9, gy, 0, 0)], spec);
  assert.deepStrictEqual([r.applied.length, pos(w)[0], iw(w), r.outbox.filter(m => m.t === 'iw').length], [1, gx + 0.9, undefined, 0]);
  assert.ok(must(r.applied[0]).writes.has('iw:ana') && !must(r.applied[0]).reads.has(`tile:garden:${grass - 2 * D.W}`), 'na zemi len vlastné políčka');
});

test('ľadovec v horách je ľad (šmýka sa), keď je na ňom ľad', () => {
  const w = makeWorld(11, winterTick() - 2 * D.DAYS_PER_SEASON * TPD); // v lete
  w.icewalk = {};
  const g = w.hory.findIndex((t, k) => t.g === 'glacier' && w.hory[k + 1]?.g === 'glacier' && w.hory[k + 2]?.g === 'glacier' && (t.ice ?? 0) === (w.hory[k + 1]?.ice ?? 0));
  assert.ok(g >= 0);
  const gx = g % D.W + 0.5, gy = Math.floor(g / D.W) + 0.5;
  Object.assign(save(w, 'ana'), { x: gx, y: gy, area: 'hory' });
  w.icewalk = { ana: { vx: 3, vy: 0, t: ts } };
  E.commitBatch(w, [mv('ana', gx, gy, 0, 0)], spec);
  assert.ok(pos(w)[0] > gx + 0.2, 'na ľadovci sa šmýka aj v lete');
});

// ---- Cheaty a prehranie ----

const cheat = (w: W, d: CheatData, s: Spec = spec): E.BatchOut<Presence, Msg> => E.commitBatch(w, [{ type: 'cheat', data: d, id: 'cheat#' + String(++ts) }], s);

test('cheaty: pošmyknúť, hodiť do vody (v zime cez nový otvor), nastaviť hybnosť a zrušiť stav – hráč dostane stav aj polohu', () => {
  const { w, cx, cy } = iceWorld(12);
  let r = cheat(w, { op: 'iw', key: 'ana', what: 'momentum', vx: 9, vy: 0 });
  assert.deepStrictEqual([must(iw(w)).vx, must(iw(w)).vy], [ICE.speed, 0], 'hybnosť najviac plná rýchlosť');
  assert.ok(r.outbox.some(m => m.t === 'iw' && m.vx === ICE.speed));
  r = cheat(w, { op: 'iw', key: 'ana', what: 'slip' });
  assert.strictEqual(IceWalk.pose(iw(w), w.tick), 'fall');
  r = cheat(w, { op: 'iw', key: 'ana', what: 'clear' });
  assert.strictEqual(iw(w), undefined);
  // do vody: najbližšia voda je pod ňou → otvor v ľade a pláva
  Object.assign(save(w, 'ana'), { x: cx + 0.2, y: cy + 0.1 });
  r = cheat(w, { op: 'iw', key: 'ana', what: 'swim' });
  const i = Math.floor(cy) * D.W + Math.floor(cx);
  assert.deepStrictEqual([must(w.tiles[i]).cut, pos(w), must(iw(w)).sw], [1, [cx, cy], 1]);
  const m = r.outbox.find(x => x.t === 'iw');
  assert.ok(m && 'x' in m && m.x === cx && m.sw === 1 && m.fall > 0, 'hráč dostane polohu, plávanie a čľapkanie');
});

test('denník s chôdzou po ľade (šmýkanie, pošmyknutie, prepadnutie, plávanie, cheaty) sa prehrá na ten istý svet', () => {
  const play = (w: W, j: Journal): void => {
    const s: Spec = { ...spec, onBatch: (_w, out) => { j.push(out.entry); } };
    ts = 50000;
    const [cx, cy] = pos(w);
    E.commitBatch(w, [mv('ana', cx - 0.4, cy, -1, 0)], s);
    for (let k = 0; k < 12; k++) { const [x, y] = pos(w); E.commitBatch(w, [mv('ana', x + (k % 2 ? 0.3 : -0.3), y, k % 2 ? 1 : -1, k % 3 ? 0 : 1)], s); E.advanceTo(w, w.tick + 3, s); }
    E.advanceTo(w, w.tick + 40, s);
    for (let k = 0; k < 8; k++) { const [x, y] = pos(w); E.commitBatch(w, [mv('ana', x + 0.25, y, 1, 0)], s); E.advanceTo(w, w.tick + 2, s); }
    cheat(w, { op: 'iw', key: 'ana', what: 'momentum', vx: 2, vy: 1 }, s);
    cheat(w, { op: 'iw', key: 'ana', what: 'swim' }, s);
    E.advanceTo(w, w.tick + 30, s);
    const [x, y] = pos(w);
    E.commitBatch(w, [mv('ana', x, y - 0.3, 0, -1)], s);
  };
  const holed = (): W => { const { w, i } = iceWorld(13); must(w.tiles[i + 1]).cut = 1; return w; };
  const a = holed(), ja: Journal = [];
  play(a, ja);
  assert.ok(ja.some(e => e.proposals.some(p => p.writes.includes('iw:ana'))), 'denník má stav ľadu');
  const b = holed(), jb: Journal = [];
  const n = E.replay(b, parseJson<Journal>(json(ja)), { ...spec, onBatch: (_w, out) => { jb.push(out.entry); } });
  assert.strictEqual(n, ja.length);
  assert.strictEqual(json(b), json(a));
  assert.strictEqual(json(jb), json(ja));
});

test('uložený stav ľadu: zlé záznamy sa zahodia, chýbajúci = nikto nie je na ľade', () => {
  assert.deepStrictEqual(IceWalk.load(undefined), {});
  assert.deepStrictEqual(IceWalk.load({ ana: { vx: 1, vy: 'x', fall: 5, sw: 1, t: 3 }, bob: 7 }), { ana: { vx: 1, vy: 0, t: 3, fall: 5, sw: 1 } });
});
