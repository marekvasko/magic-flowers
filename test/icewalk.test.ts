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
import * as IceC from '../src/client/icewalk.ts';
import type { CheatData } from '../src/server/cheats.ts';
import type { Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { keyId } from '../src/server/debug.ts';
import type { DebugState, Loaded } from '../src/server/debug.ts';
import worldApi from '../src/server/debug-api/world.ts';
import { iceOf, iceSeason } from '../src/debug/tabs/map-core.ts';
import { SPEC, act, json, makeWorld, save, textOf, TPD } from './game-world.ts';
import type { W } from './game-world.ts';
import { must, parseJson, partial, rethrow } from './helpers.ts';

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
  // na ľade platí vždy výpočet servera (presný integrál); keď je klient blízko, opravu mu neposiela
  const st = must(iw(w)), ex = x + IW.advance(st.vx, st.vy, 0, 0, 0.1)[2];
  r = E.commitBatch(w, [mv('ana', ex + 0.01, cy, 0, 0)], spec);
  assert.ok(near(pos(w)[0], ex) && !r.outbox.some(m => m.t === 'iw'), 'malý rozdiel: bez opravy');
});

test('pošmyknutie: otočka v plnej rýchlosti → leží (pevný počet krokov) a šmýka sa ďalej bez vstupu, potom vstane; každý svet rovnako (kocka enginu)', () => {
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
  const slipMsg = a.out.find((m): m is Extract<Msg, { t: 'iw' }> => m.t === 'iw' && m.why === 'slip');
  assert.ok(slipMsg && slipMsg.ts === st.t && slipMsg.x === pos(w)[0], 'pošmyknutie ostane tam, kde je (žiadny presun), k času pohybu');
  assert.ok(Math.hypot(st.vx, st.vy) > 0, 'hybnosť ostala – ležiaci sa šmýka ďalej');
  assert.strictEqual(fall - w.tick, IW.ticksOf(ICE.fallS, w.daySeconds));
  assert.strictEqual(IceWalk.pose(st, w.tick), 'fall');
  // kým leží, vstup sa nepočíta: šmýka sa a brzdí ako bez vstupu
  const [x, y] = pos(w), [, , ex, ey] = IW.advance(st.vx, st.vy, 0, 0, 0.1);
  st.t = ts; st.fe = ts + 1000; // druhý beh (b) posunul spoločné hodiny testu; leží ešte sekundu (čas klienta)
  let r = E.commitBatch(w, [mv('ana', x + 0.2, y, 1, 0)], spec);
  assert.ok(r.applied.length === 1 && near(pos(w)[0], x + ex) && near(pos(w)[1], y + ey), 'leží a šmýka sa bez vstupu');
  assert.strictEqual(must(iw(w)).fall, fall, 'stále leží');
  E.advanceTo(w, fall, spec);
  const [x2] = pos(w);
  r = E.commitBatch(w, [mv('ana', x2 + 0.03, y, 1, 0)], spec);
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
  assert.deepStrictEqual(pos(w), [cx + 1, cy], 'prepadol sa – skĺzne do stredu otvoru');
  const fm = r.outbox.find((m): m is Extract<Msg, { t: 'iw' }> => m.t === 'iw');
  assert.ok(fm && fm.why === 'hole' && fm.x === cx + 1 && fm.sw === 1 && fm.fall > 0, 'klient dostane stred otvoru, kam sa plynulo dosunie');
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

// ---- Ladiaca stránka ----

test('ladiaca stránka: World ukáže stav hráča na ľade, Map vrstvu ľadu, Cheats rozumejú op iw', () => {
  const { w, i, cx, cy } = iceWorld(14);
  // World: kópia sveta ako JSON (serialize) – ana leží na ľade, čupí (prítomnosť), bob je na tráve bez stavu
  const tick = w.tick, state = { tick, saves: { ana: { x: cx, y: cy, area: 'garden' }, bob: { x: 10.5, y: 8.5, area: 'garden' } }, icewalk: { ana: { vx: 1.5, vy: -2, fall: tick + 7 } } };
  const online: Loaded['online'] = [{ name: 'Ana', area: 'garden', player: keyId('ana'), ck: true }];
  const tools = { load: (id: unknown): Loaded | null => id === 'svet' ? partial<Loaded>({ id: 'svet', source: 'memory', online, state: parseJson<DebugState>(JSON.stringify(state)) }) : null };
  const v = must(worldApi(new URLSearchParams({ room: 'svet', area: 'garden' }), tools) ?? undefined);
  const ana = must(v.players.find(p => p.id === 'ana')), bob = must(v.players.find(p => p.id === 'bob'));
  assert.deepStrictEqual(ana.ice, { onIce: true, hole: false, vx: 1.5, vy: -2, speed: 2.5, fall: 7, swim: false, crouch: true, pose: 'fall' });
  assert.strictEqual(bob.ice, undefined, 'na tráve bez stavu nič navyše');
  // Map: vrstva ľadu podľa obdobia sveta; plocha zo semienka ako v zime
  must(w.tiles[i]).cut = 1;
  assert.deepStrictEqual([iceOf({ g: 'water' }, 3), iceOf({ g: 'water', cut: 1 }, 3), iceOf({ g: 'water' }, 1), iceOf({ g: 'glacier', ice: 2 }, 1), iceOf({ g: 'grass' }, 3)], ['ice', 'hole', 'open', 'ice', null]);
  assert.deepStrictEqual([iceSeason(D, { tick }), iceSeason(D, { tick: 0 }), iceSeason(D, null)], [3, 0, 3]);
  // Cheats: telo požiadavky → vstup enginu
  const room = { id: 'svet', tick, saves: w.saves, players: new Map() };
  assert.deepStrictEqual(Cheats.parseCheat(room, { op: 'iw', player: 'ana', what: 'momentum', vx: 2, vy: '1' }, k => k), { op: 'iw', key: 'ana', what: 'momentum', vx: 2, vy: 1 });
  assert.deepStrictEqual(Cheats.parseCheat(room, { op: 'iw', player: 'ana', what: 'slip' }, k => k), { op: 'iw', key: 'ana', what: 'slip' });
  assert.throws(() => Cheats.parseCheat(room, { op: 'iw', player: 'ana', what: 'fly' }, k => k), /what must be/);
});

// ---- Klient a server počítajú to isté (#163: bez skokov) ----

test('klient a server vypočítajú to isté šmýkanie: nerovnaké snímky, zmeny vstupu medzi pohybmi, zlúčené pohyby – žiadna oprava', () => {
  const { w, cx, cy } = iceWorld(15);
  const me = { x: cx, y: cy, vx: 0, vy: 0 }, cl = IceC.create(), anywhere = (): boolean => true;
  Object.assign(save(w, 'ana'), { x: cx, y: cy });
  w.icewalk = { ana: { vx: 0, vy: 0, t: 10000, ix: 0, iy: 0 } };
  cl.lastT = 10000;
  // vstup podľa času (čupí – bez pošmyknutia): doprava, šikmo, späť, pustí, hore…
  const inputOf = (t: number): [number, number] => t < 10400 ? [0.5, 0] : t < 10750 ? [0.35, -0.35] : t < 11300 ? [-0.5, 0] : t < 11600 ? [0, 0] : t < 12100 ? [0, 0.5] : [-0.21, -0.43];
  let now = 10000, sent = 0, k = 0, fixes = 0;
  const pending: E.Input[] = [];
  while (now < 13000) {
    now += 14 + ((k * 7919) % 13); k++; // snímky 14–26 ms
    const [t0, t] = IceC.clock(cl, now), [ix, iy] = inputOf(t0).map(IW.roundIn) as [number, number];
    IceC.input(cl, t0, ix, iy);
    IceC.slideFrame(cl, me, t0, t, ix, iy, anywhere);
    IceC.frame(cl, me, { t0, t, ix, iy, ice: true });
    if (t - sent >= 90) { // pohyb ako ho pošle klient
      sent = t;
      pending.push(act('pos', 'ana', { x: me.x, y: me.y, ix, iy, ck: true, ts: t, in: cl.segs.map((g): [number, number, number] => [g[0], g[1], g[2]]) }));
      if (k % 3) { // server zlúči dva pohyby z jedného rámca: platí len posledný
        const inp = must(pending.pop());
        pending.length = 0;
        const r = E.commitBatch(w, [inp], spec);
        fixes += r.outbox.filter(m => m.t === 'iw').length;
        const [sx, sy] = pos(w);
        assert.ok(near(sx, me.x, 1e-9) && near(sy, me.y, 1e-9), `server ${sx},${sy} = klient ${me.x},${me.y} (t ${t})`);
      }
    }
  }
  assert.strictEqual(fixes, 0, 'žiadna oprava');
  assert.ok(Math.hypot(me.x - cx, me.y - cy) > 0.3, 'naozaj sa šmýkal');
});

test('oprava zo servera sa nikdy nepreskočí: klient prepočíta snímky od ts a rozdiel dobieha plynulo', () => {
  const cl = IceC.create(), me = { x: 5, y: 5, vx: 2, vy: 0 }, anywhere = (): boolean => true;
  cl.lastT = 0;
  for (let t = 20; t <= 400; t += 20) {
    const [t0, t1, dt] = IceC.clock(cl, t);
    IceC.input(cl, t0, 0, 0);
    IceC.slide(me, 0, 0, dt, anywhere);
    IceC.frame(cl, me, { t0, t: t1, ix: 0, iy: 0, ice: true });
  }
  // server: v čase 200 bol o 0,2 ďalej a pošmykol sa (leží 1 s) – klient prepočíta od 200 bez vstupu
  const at = must(cl.frames.find(f => f.t === 200)), before = { x: me.x, y: me.y };
  IceC.onMsg(cl, me, { t: 'iw', x: at.x + 0.2, y: at.y, vx: 1.5, vy: 0, fall: 1000, sw: 0, ts: 200, why: 'slip' }, 400, anywhere);
  assert.deepStrictEqual([me.x, me.y], [before.x, before.y], 'poloha sa hneď nezmení');
  const b = { x: at.x + 0.2, y: at.y, vx: 1.5, vy: 0 };
  IW.slideStep(b, 0, 0, 0.2, anywhere);
  assert.ok(near(before.x + cl.pend.x, b.x, 1e-9), 'cieľ = prepočet od stavu servera');
  let prev = me.x, maxStep = 0;
  for (let t = 420; t <= 1400; t += 20) {
    const [t0, t1, dt] = IceC.clock(cl, t);
    IceC.slide(me, 0, 0, dt, anywhere);
    IceC.frame(cl, me, { t0, t: t1, ix: 0, iy: 0, ice: true });
    maxStep = Math.max(maxStep, Math.abs(me.x - prev) - Math.abs(me.vx) * dt);
    prev = me.x;
  }
  assert.ok(maxStep < 0.06, `dobieha po kúskoch (najväčší kúsok opravy ${maxStep.toFixed(3)})`);
  assert.ok(Math.abs(cl.pend.x) < 1e-3, 'oprava je dobehnutá');
  assert.deepStrictEqual(cl.corr.length, 1);
});

// ---- Prepadnutie bez presunu, roztopenie ----

test('prepadnutie počas šmýkania: stredom vojde do otvoru, klient sa nezastaví skokom – do stredu otvoru sa plynulo dosunie', () => {
  const { w, i, cx, cy } = iceWorld(16);
  must(w.tiles[i + 1]).cut = 1;
  Object.assign(save(w, 'ana'), { x: cx + 0.3, y: cy });
  w.icewalk = { ana: { vx: 3, vy: 0, t: ts, ix: 1, iy: 0 } };
  const r = E.commitBatch(w, [mv('ana', cx + 0.6, cy, 1, 0)], spec);
  assert.deepStrictEqual(pos(w), [cx + 1, cy]);
  const m = must(r.outbox.find((q): q is Extract<Msg, { t: 'iw' }> => q.t === 'iw'));
  assert.ok(m.why === 'hole' && m.x === cx + 1 && m.sw === 1);
  assert.deepStrictEqual([must(iw(w)).vx, must(iw(w)).sw], [0, 1]);
  // klient: predpovedal prepadnutie na okraji otvoru (x + 0,55) – správa servera ho neprenesie, len dosunie
  const cl = IceC.create(), me = { x: cx + 0.55, y: cy, vx: 0, vy: 0 };
  IceC.predictFallIn(cl, me, 0);
  IceC.onMsg(cl, me, m, 50, () => true); // klient snímku s týmto ts nemá – cieľom je poloha servera
  assert.deepStrictEqual([me.x, cl.pend.x > 0.4], [cx + 0.55, true], 'žiadny skok');
  let prev = me.x;
  for (let t = 66; t <= 700; t += 16) { IceC.frame(cl, me, { t0: t - 16, t, ix: 0, iy: 0, ice: false }); assert.ok(me.x - prev < 0.08, 'po kúskoch'); prev = me.x; }
  assert.ok(near(me.x, cx + 1, 0.01), 'v strede otvoru');
});

test('roztopenie: kto stojí na ľade jazierka, keď zima prejde na jar, prepadne sa na mieste a pláva (klient pošle pohyb hneď, ako zbadá vodu)', () => {
  const { w, cx, cy } = iceWorld(17);
  w.icewalk = { ana: { vx: 0, vy: 0, t: ts } }; // stojí na ľade, nehýbe sa
  E.advanceTo(w, (WINTER_DAY - 1 + D.DAYS_PER_SEASON) * TPD + 10, spec); // cez polnoc do jari
  assert.strictEqual(D.seasonOf(D.dayOfTick(w.tick)), 0);
  // klient: pod ním je otvorená voda → predpovie prepadnutie a pošle pohyb na tom istom mieste
  const cl = IceC.create(), me = { x: cx, y: cy, vx: 0, vy: 0 };
  assert.strictEqual(IceC.mode(cl, must(w.tiles[Math.floor(cy) * D.W + Math.floor(cx)]), 0, 0), 'swim');
  IceC.predictFallIn(cl, me, 0);
  assert.deepStrictEqual([cl.swim, IceC.pose(cl, 0)[0], IceC.pose(cl, 200)[1]], [true, 'swim', 0.5], 'ponára sa plynulo');
  const r = E.commitBatch(w, [mv('ana', cx, cy, 0, 0)], spec);
  assert.deepStrictEqual(pos(w), [cx, cy], 'ostal, kde stál');
  assert.strictEqual(must(iw(w)).sw, 1, 'pláva');
  assert.ok(r.outbox.some(m => textOf(m) === IceWalk.MSG.melt) && r.outbox.some(m => m.t === 'iw' && m.why === 'melt'));
  IceC.onMsg(cl, me, must(r.outbox.find((m): m is Extract<Msg, { t: 'iw' }> => m.t === 'iw')), 50, () => true);
  assert.deepStrictEqual([cl.swim, cl.pred, me.x, me.y], [true, 0, cx, cy], 'server potvrdil predpoveď – bez presunu');
});

test('roztopenie pod hráčom kdekoľvek: otvor vysekaný pod stojacim hráčom ho pri ďalšom pohybe zhodí do vody na mieste', () => {
  const { w, i, cx, cy } = iceWorld(18);
  w.icewalk = { ana: { vx: 0, vy: 0, t: ts } };
  must(w.tiles[i]).cut = 1; // niekto vysekal otvor priamo pod ňou
  const r = E.commitBatch(w, [mv('ana', cx + 0.02, cy, 0, 0)], spec);
  assert.deepStrictEqual(pos(w), [cx, cy], 'bez presunu');
  assert.ok(r.outbox.some(m => m.t === 'iw' && m.why === 'melt' && m.sw === 1));
});

test('ležanie po pošmyknutí sa meria časom klienta: v jednom pohybe do konca ležania bez vstupu, potom so vstupom – klient rovnako', () => {
  const { w, cx, cy } = iceWorld(19);
  Object.assign(save(w, 'ana'), { x: cx - 1, y: cy });
  w.icewalk = { ana: { vx: 2, vy: 0, t: 5000, ix: 0, iy: 0, fall: w.tick + 1000, fe: 5050 } };
  E.commitBatch(w, [act('pos', 'ana', { x: cx - 1, y: cy, ix: 0.5, iy: 0, ts: 5100, in: [[5000, 0.5, 0]] })], spec);
  const b = { x: cx - 1, y: cy, vx: 2, vy: 0 }, ok = (): boolean => true;
  IW.slideStep(b, 0, 0, 0.05, ok); IW.slideStep(b, 0.5, 0, 0.05, ok);
  assert.ok(near(pos(w)[0], b.x, 1e-9), 'server delí úsek koncom ležania');
  const cl = IceC.create(), me = { x: cx - 1, y: cy, vx: 2, vy: 0 };
  cl.fallUntil = 5050;
  IceC.slideFrame(cl, me, 5000, 5030, 0.5, 0, ok); IceC.slideFrame(cl, me, 5030, 5100, 0.5, 0, ok); // iné snímky, ten istý výsledok
  assert.ok(near(me.x, b.x, 1e-9), 'klient tiež');
  assert.deepStrictEqual(IW.cutsOf(5003, 5031, [5017]), [5003, 5010, 5017, 5020, 5030, 5031], 'mriežka 10 ms a zmeny');
});

test('náraz do brehu: klient (snímky) a server (pohyby) sa rozídu najviac o kúsok mriežky, nikdy o celý pohyb', () => {
  const { w, cx, cy } = iceWorld(20);
  const se = D.seasonOf(D.dayOfTick(w.tick));
  const body = (x: number, y: number): boolean => [[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx = 0, sy = 0]) =>
    IW.passableNow(w.tiles[Math.floor(y + sy * D.BODY.ry) * D.W + Math.floor(x + sx * D.BODY.rx)], se, false));
  const me = { x: cx, y: cy, vx: 0, vy: 0 }, cl = IceC.create();
  Object.assign(save(w, 'ana'), { x: cx, y: cy });
  w.icewalk = { ana: { vx: 0, vy: 0, t: 20000, ix: 0, iy: 0 } };
  cl.lastT = 20000;
  let now = 20000, sent = 20000, k = 0, worst = 0;
  while (now < 23000) {
    now += 15 + ((k * 31) % 11); k++;
    const [t0, t] = IceC.clock(cl, now), ix = IW.roundIn(now < 21500 ? 0.5 : -0.5); // čupí: k brehu a späť
    IceC.input(cl, t0, ix, 0);
    IceC.slideFrame(cl, me, t0, t, ix, 0, body);
    IceC.frame(cl, me, { t0, t, ix, iy: 0, ice: true });
    if (t - sent >= 95) {
      sent = t;
      E.commitBatch(w, [act('pos', 'ana', { x: me.x, y: me.y, ix, iy: 0, ck: true, ts: t, in: cl.segs.map((g): [number, number, number] => [g[0], g[1], g[2]]) })], spec);
      worst = Math.max(worst, Math.hypot(pos(w)[0] - me.x, pos(w)[1] - me.y));
    }
  }
  assert.ok(worst < 0.03, `najväčší rozdiel ${worst.toFixed(4)} políčka`);
  assert.ok(me.x > cx + 1, 'došiel až k brehu');
});

test('zíde z ľadu na breh: od chvíle, keď je stredom na zemi, platí poloha klienta ako na zemi (klient sa tam hneď zastaví)', () => {
  const w = makeWorld(21, winterTick());
  w.icewalk = {};
  const k = w.tiles.findIndex((t, j) => t.g === 'water' && w.tiles[j + 1]?.g === 'sand' && w.tiles[j - 1]?.g === 'water');
  const x0 = k % D.W + 0.8, y0 = Math.floor(k / D.W) + 0.5;
  Object.assign(save(w, 'ana'), { x: x0, y: y0, area: 'garden' });
  w.icewalk = { ana: { vx: 3, vy: 0, t: 30000, ix: 0, iy: 0 } };
  // klient: o 0,1 s je stredom na piesku (x + 0,25) a tam zastal (na zemi bez vstupu)
  const r = E.commitBatch(w, [act('pos', 'ana', { x: x0 + 0.25, y: y0, ix: 0, iy: 0, ts: 30100, in: [[29900, 0, 0]] })], spec);
  assert.deepStrictEqual([pos(w)[0], iw(w), r.outbox.filter(m => m.t === 'iw').length], [x0 + 0.25, undefined, 0]);
});
