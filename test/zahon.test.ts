// Záhon (#179): ochranné zóny kvetov, kúpa na trhu, položenie (1 miesto v povolení), sadenie, pokryvy, polievanie
// a hnojenie celého záhonu, ranný rast, zrezanie, vykopanie, zrušenie, divé semienko, načítanie a správa pre klienta.
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
import * as Obj from '../src/shared/objects.ts';
import * as Z from '../src/shared/zahon.ts';
import type { ZahonObject } from '../src/shared/save.ts';
import * as E from '../src/server/engine.ts';
import * as Zahon from '../src/server/zahon.ts';
import * as Actions from '../src/server/actions.ts';
import * as Econ from '../src/server/economy.ts';
import type { Msg } from '../src/server/game.ts';
import type { Presence } from '../src/server/world.ts';
import { SPEC, TPD, makeWorld, save } from './game-world.ts';
import type { W } from './game-world.ts';
import { isMsg, must, parseMsg, portOf } from './helpers.ts';
import { SAVE_V15 } from './save-v15.fixture.ts';

type Spec = E.Spec<W, Presence, Msg>;
const spec: Spec = { ...SPEC, proposers: { ...SPEC.proposers, ...Zahon.PROPOSERS } };
let seq = 0;
// Vstup hráča ana (key sa doplní)
type In = Zahon.ZahonInputs & Pick<Actions.ActionInputs, 'till'>;
const act = <T extends keyof In>(w: W, type: T, data: Omit<In[T], 'key'>, key = 'ana'): E.BatchOut<Presence, Msg> => E.commitBatch(w, [{ type, data: { key, ...data }, id: 'z#' + String(++seq), actor: key }], spec);
const rejects = <T extends keyof In>(w: W, type: T, data: Omit<In[T], 'key'>): string[] => act(w, type, data).rejected.map(r => r.reject ?? '');
const SUMMER = D.DAWN_TICK + 6 + D.DAYS_PER_SEASON * TPD;
// Svet v lete; ana stojí pri trhovom stánku, bob pri voľnom políčku trávy (x, y)
function world(): { w: W; x: number; y: number; i: number } {
  const w = makeWorld(179, SUMMER);
  w.objects = Obj.defaultLots();
  w.up.plots = 1; // povolenie: 16 miest
  w.plotsUsed = 0;
  save(w, 'ana').rep = 100; save(w, 'ana').coins = 1000;
  const i = w.tiles.findIndex((t, k) => t.g === 'grass' && Math.floor(k / D.W) > 6 && Math.floor(k / D.W) < 20);
  const x = i % D.W, y = Math.floor(i / D.W);
  stand(w, 'ana', x + 0.5, y + 0.5);
  return { w, x, y, i };
}
function stand(w: W, key: string, x: number, y: number): void { w.presence = (w.presence || []).map(p => (p.key === key ? { ...p, x, y } : p)); }
const only = (w: W): ZahonObject => must(Obj.zahony(w.objects)[0]);
// Svet s položeným dreveným záhonom pri ane
function withZahon(): { w: W; z: ZahonObject } {
  const { w, i, x, y } = world();
  save(w, 'ana').inv.zahon_drevo = 1;
  assert.deepStrictEqual(rejects(w, 'zahonPlace', { i, v: 'drevo' }), []);
  stand(w, 'ana', x + 0.5, y + 0.5);
  return { w, z: only(w) };
}

test('záhon: ochranné zóny – dva kvety sú od seba aspoň (d₁ + d₂) / 2, nech sú to akékoľvek druhy', () => {
  const z = { spots: [] as Z.SpotLike[] };
  assert.strictEqual(Z.plantError(z, 0, 3, 'tulipan'), 'Na rám záhonu sa nesadí.');
  assert.strictEqual(Z.plantError(z, 7, 3, 'tulipan'), 'Na rám záhonu sa nesadí.');
  assert.match(Z.plantError(z, 3, 3, 'lekno') ?? '', /Vodné kvety/);
  z.spots.push({ sx: 3, sy: 3, p: { sp: 'tulipan', prog: 0 } });
  assert.strictEqual(Z.plantError(z, 3, 3, 'tulipan'), 'Tu už niečo rastie.');
  assert.strictEqual(Z.plantError(z, 4, 4, 'tulipan'), null, 'tulipán vedľa tulipánu (1)');
  assert.match(Z.plantError(z, 4, 3, 'mak') ?? '', /Príliš blízko/, 'mak a tulipán potrebujú 1,5 → 2');
  assert.strictEqual(Z.plantError(z, 5, 3, 'mak'), null);
  assert.match(Z.plantError(z, 5, 5, 'slnecnica') ?? '', /Príliš blízko/, 'tulipán a slnečnica potrebujú 2,5 → 3');
  assert.strictEqual(Z.plantError(z, 6, 6, 'slnecnica'), null);
  // ruža (6 × 6) v rohu nechá miesto na 20 tulipánov okolo, v strede zaplní celý záhon
  const rose = { spots: [{ sx: 1, sy: 1, p: { sp: 'ruza' as const, prog: 0 } }] as Z.SpotLike[] };
  let n = 0;
  for (let sy = 1; sy <= 6; sy++) for (let sx = 1; sx <= 6; sx++) if (!Z.plantError(rose, sx, sy, 'tulipan')) { rose.spots.push({ sx, sy, p: { sp: 'tulipan', prog: 0 } }); n++; }
  assert.strictEqual(n, 20);
  const mid = { spots: [{ sx: 3, sy: 3, p: { sp: 'ruza' as const, prog: 0 } }] as Z.SpotLike[] };
  for (let sy = 1; sy <= 6; sy++) for (let sx = 1; sx <= 6; sx++) assert.ok(Z.plantError(mid, sx, sy, 'tulipan'), `${sx},${sy}`);
  // pokryv zóny nemá, ale bod s pokryvom je obsadený; divé semienko má zónu 1, kým nevyklíči
  const c = { spots: [{ sx: 2, sy: 2, c: 'strk' as const }, { sx: 5, sy: 5, p: { sp: 'wild' as const, prog: 0, wild: 1 as const } }] as Z.SpotLike[] };
  assert.match(Z.plantError(c, 2, 2, 'tulipan') ?? '', /pokryv/);
  assert.strictEqual(Z.plantError(c, 2, 3, 'tulipan'), null);
  assert.strictEqual(Z.plantError(c, 4, 4, 'tulipan'), null);
  assert.strictEqual(Z.coverError(c, 5, 5), 'Tu rastie kvet.');
  assert.strictEqual(Z.coverError(c, 0, 0), 'Rám záhonu sa nepokrýva.');
});

test('záhon: kúpa na trhu – všetky rámy za 40 🪙 (reputácia 1), vedro pokryvu na 16 bodov; len pri stánku', () => {
  const { w } = world();
  assert.deepStrictEqual(rejects(w, 'zahonBuy', { v: 'tehla' }), ['Obchoduje sa pri trhovom stánku – podíď bližšie.']);
  stand(w, 'ana', 12.5, 29.5);
  for (const v of D.ZAHON_FRAMES) assert.deepStrictEqual(rejects(w, 'zahonBuy', { v }), []);
  assert.strictEqual(save(w, 'ana').coins, 1000 - 4 * 40);
  assert.deepStrictEqual(D.ZAHON_FRAMES.map(v => save(w, 'ana').inv[`zahon_${v}`]), [1, 1, 1, 1]);
  assert.deepStrictEqual(rejects(w, 'coverBuy', { c: 'okruhliaky' }), []);
  assert.strictEqual(save(w, 'ana').inv.cov_okruhliaky, 16);
  assert.strictEqual(save(w, 'ana').coins, 1000 - 160 - 10);
  save(w, 'ana').rep = 0;
  assert.deepStrictEqual(rejects(w, 'zahonBuy', { v: 'drevo' }), ['Potrebuješ reputáciu úrovne 1.']);
});

test('záhon: položí sa len na čistú trávu, zaberá 1 miesto v povolení a pod ním sa nekope', () => {
  const { w, i, x, y } = world();
  const sv = save(w, 'ana');
  sv.inv.zahon_drevo = 2;
  must(w.tiles[i]).s = { k: 'normal', w: 0, r: 0, p: null, o: 'ana' };
  w.plotsUsed = 1;
  const me = must((w.presence || []).find(p => p.key === 'ana'));
  assert.deepStrictEqual(Actions.resolveAct(w, w.presence, me, { x, y, item: 'zahon_drevo' }), { toast: 'Najprv zarovnaj motykou.' });
  must(w.tiles[i]).s = null; w.plotsUsed = 0;
  assert.deepStrictEqual(Actions.resolveAct(w, w.presence, me, { x, y, item: 'zahon_drevo' }), { type: 'zahonPlace', data: { key: 'ana', i, v: 'drevo', sh: 'sq', rot: 0 } });
  act(w, 'zahonPlace', { i, v: 'drevo' });
  assert.deepStrictEqual([w.plotsUsed, Econ.plotsUsedOf(w.tiles, w.hory, w.objects), sv.inv.zahon_drevo, only(w).o], [1, 1, 1, 'ana']);
  assert.deepStrictEqual(rejects(w, 'zahonPlace', { i, v: 'drevo' }), ['Tu už niečo je.']);
  assert.strictEqual(Actions.resolveAct(w, w.presence, me, { x, y, item: 'hoe' }), null, 'ťuknutie na záhon otvorí priblížený pohľad (klient)');
  assert.deepStrictEqual(rejects(w, 'till', { i }), [''], 'pod záhonom sa nekope');
  // plné povolenie
  w.plotsUsed = Econ.plotLimit(w.up);
  const j = w.tiles.findIndex((t, k) => k !== i && t.g === 'grass' && Math.abs(k % D.W - x) + Math.abs(Math.floor(k / D.W) - y) === 1);
  assert.match(rejects(w, 'zahonPlace', { i: j, v: 'drevo' })[0] ?? '', /povolenie záhrady/);
});

test('záhon: sadenie podľa obdobia a zón, pokryvy ťahom (na koľko je v batohu), zobratie pokryvu späť', () => {
  const { w, z } = withZahon(), sv = save(w, 'ana');
  sv.inv.seed_mak = 5; sv.inv.seed_tulipan = 1; sv.inv.cov_strk = 3;
  assert.deepStrictEqual(rejects(w, 'zahonPlant', { id: z.id, sx: 2, sy: 2, item: 'seed_mak' }), []);
  assert.match(rejects(w, 'zahonPlant', { id: z.id, sx: 3, sy: 2, item: 'seed_mak' })[0] ?? '', /Príliš blízko/);
  assert.match(rejects(w, 'zahonPlant', { id: z.id, sx: 5, sy: 5, item: 'seed_tulipan' })[0] ?? '', /sadí v období: Jar/);
  assert.strictEqual(sv.inv.seed_mak, 4);
  act(w, 'zahonCover', { id: z.id, c: 'strk', spots: [[2, 2], [4, 4], [5, 4], [6, 4], [6, 5]] });
  assert.deepStrictEqual(z.spots.filter(s => s.c).map(s => [s.sx, s.sy]), [[4, 4], [5, 4], [6, 4]], 'kvet sa nepokryje, štrku je len na 3 body');
  assert.strictEqual(sv.inv.cov_strk ?? 0, 0);
  assert.match(rejects(w, 'zahonPlant', { id: z.id, sx: 4, sy: 4, item: 'seed_mak' })[0] ?? '', /pokryv/);
  act(w, 'zahonUncover', { id: z.id, spots: [[4, 4], [2, 2]] });
  assert.strictEqual(sv.inv.cov_strk, 1);
  assert.deepStrictEqual(z.spots.map(s => [s.sx, s.sy, s.p?.sp ?? s.c]), [[2, 2, 'mak'], [5, 4, 'strk'], [6, 4, 'strk']]);
  // ďaleko od záhonu sa nedá nič
  stand(w, 'ana', z.x + 6, z.y + 0.5);
  assert.deepStrictEqual(rejects(w, 'zahonWater', { id: z.id }), ['Podíď bližšie k záhonu.']);
});

test('záhon: jedno poliatie krhlou = celý záhon; ráno rastú všetky kvety, dážď záhon poleje; kompost do konca obdobia', () => {
  const { w, z } = withZahon(), sv = save(w, 'ana');
  sv.inv.seed_mak = 3; sv.inv.compost = 2; sv.water = 2;
  for (const [sx, sy] of [[1, 1], [3, 1], [5, 1]] as const) act(w, 'zahonPlant', { id: z.id, sx, sy, item: 'seed_mak' });
  act(w, 'zahonWater', { id: z.id });
  assert.deepStrictEqual([z.w, sv.water], [1, 1]);
  assert.deepStrictEqual(rejects(w, 'zahonWater', { id: z.id }), ['Záhon je dnes už poliaty. 💧']);
  act(w, 'zahonCompost', { id: z.id });
  assert.deepStrictEqual([z.r, sv.inv.compost], [1, 1]);
  E.advanceTo(w, w.tick + TPD, spec); // ráno
  // mak chce piesočnatú pôdu – v záhone (obyčajná pôda) rastie polovičnou rýchlosťou ako na prekopanej tráve; kompost ×1,5
  assert.deepStrictEqual(z.spots.map(s => must(s.p).prog), [0.75, 0.75, 0.75], 'všetky kvety v poliatom a pohnojenom záhone rastú');
  assert.strictEqual(z.w, w.weather === 'rain' ? 1 : 0, 'ráno je záhon znova suchý (ak neprší)');
  assert.strictEqual(z.r, 1, 'kompost ostáva');
});

test('záhon: rozkvitnutý kvet sa zreže do batohu, motyka kvet vykopá, zrušenie krompáčom vráti kvitnúce kvety a pokryvy a uvoľní miesto', () => {
  const { w, z } = withZahon(), sv = save(w, 'ana');
  const days = D.SPECIES.mak.days;
  z.spots.push({ sx: 2, sy: 2, p: { sp: 'mak', prog: days, q: 3, dry: 0, bt: w.tick } }, { sx: 5, sy: 2, p: { sp: 'mak', prog: days, q: 2, dry: 0, bt: w.tick } },
    { sx: 2, sy: 5, p: { sp: 'mak', prog: 1, q: 3, dry: 0 } }, { sx: 6, sy: 6, c: 'travnik' });
  w.plotsUsed = 1;
  act(w, 'zahonPick', { id: z.id, sx: 2, sy: 2 });
  assert.strictEqual(sv.inv.fl_mak, 3);
  assert.ok(!Z.spotAt(z, 2, 2), 'letnička po zrezaní zmizne');
  assert.deepStrictEqual(rejects(w, 'zahonPick', { id: z.id, sx: 2, sy: 5 }), ['Tu nič nekvitne.']);
  act(w, 'zahonDig', { id: z.id, sx: 2, sy: 5 });
  assert.ok(!Z.spotAt(z, 2, 5));
  assert.deepStrictEqual(rejects(w, 'zahonDestroy', { id: z.id }), ['Záhon zrušíš krompáčom – kúpiš ho na trhu (záložka Vylepšiť). ⛏️']);
  sv.inv.pick = 1;
  act(w, 'zahonDestroy', { id: z.id });
  assert.deepStrictEqual([sv.inv.fl_mak, sv.inv.cov_travnik, Obj.zahony(w.objects).length, w.plotsUsed], [5, 1, 0, 0]);
});

test('záhon: divé semienko – druh sa určí pri sadení, klient ho nevidí, kým nevyklíči; do herbára tomu, kto záhon položil', () => {
  const { w, z } = withZahon(), sv = save(w, 'ana'), bob = save(w, 'bob');
  sv.inv.wild_1 = 1;
  stand(w, 'bob', z.x + 0.5, z.y + 0.5);
  bob.inv.wild_1 = 1;
  act(w, 'zahonPlant', { id: z.id, sx: 3, sy: 3, item: 'wild_1' }, 'bob');
  const p = must(must(Z.spotAt(z, 3, 3)).p);
  assert.ok(p.wild && D.isSpeciesId(p.sp));
  const view = Zahon.objectView(z);
  assert.ok(view.kind === 'zahon' && view.spots[0]?.p?.sp === 'wild', 'klient druh nevidí');
  sv.seen = []; z.w = 1;
  E.advanceTo(w, w.tick + TPD, spec);
  assert.ok(!p.wild, 'vyklíčilo');
  assert.ok(sv.seen.includes(p.sp), 'herbár toho, kto záhon položil');
});

test('záhon: načítanie uloženia – body v mriežke, kvet alebo pokryv, neplatné sa vynechajú', () => {
  const o = Obj.loadObjects({
    list: [
      { id: 7, area: 'garden', x: 5, y: 12, kind: 'zahon', v: 'prut', w: 1, r: 0, o: 'ana', spots: [{ sx: 1, sy: 1, p: { sp: 'mak', prog: 2, q: 3, dry: 0 } }, { sx: 1, sy: 1, c: 'strk' }, { sx: 9, sy: 1, c: 'strk' }, { sx: 2, sy: 2, c: 'mramor' }, { sx: 3, sy: 3, c: 'kamen' }] },
      { id: 8, area: 'garden', x: 5, y: 12, kind: 'zahon', v: 'drevo', w: 0, r: 0, o: 'bob', spots: [] }, // to isté políčko
      { id: 9, area: 'garden', x: 6, y: 12, kind: 'zahon', v: 'zlato', w: 0, r: 0, o: 'bob', spots: [] }
    ],
    nid: 10
  });
  assert.deepStrictEqual(o.list.map(x => x.id), [7]);
  assert.deepStrictEqual(must(Obj.zahony(o)[0]).spots, [{ sx: 1, sy: 1, p: { sp: 'mak', prog: 2, q: 3, dry: 0 } }, { sx: 3, sy: 3, c: 'kamen' }]);
  assert.strictEqual(o.nid, 10);
});

test('záhon: uloženie v15 zo servera (fixtúra) – štyri záhony s kvetmi a pokryvmi sa načítajú bez zmeny', () => {
  const o = Obj.loadObjects(SAVE_V15.objects);
  assert.deepStrictEqual(o, SAVE_V15.objects);
  assert.deepStrictEqual(Obj.zahony(o).map(z => z.v), ['drevo', 'prut', 'kamen', 'tehla']);
  assert.ok(Obj.zahony(o).every(z => z.spots.every(q => Z.inner(q.sx, q.sy))));
  assert.strictEqual(Econ.plotsUsedOf([], [], o), 4);
});

test('záhon: dva záhony vedľa seba sa spoja – na spoločnej strane nie je rám a zóny kvetov platia aj cez hranicu', () => {
  const { w, z } = withZahon(), sv = save(w, 'ana');
  // druhý záhon napravo (x + 1); prázdna tráva, ak tam nie je, sa pre test vytvorí
  const i2 = z.y * D.W + z.x + 1;
  must(w.tiles[i2]).g = 'grass'; must(w.tiles[i2]).s = null;
  sv.inv.zahon_tehla = 1;
  act(w, 'zahonPlace', { i: i2, v: 'tehla' });
  const [a, b] = Obj.zahony(w.objects);
  const A = Z.bedOf(w.objects.list, must(a)), B = Z.bedOf(w.objects.list, must(b));
  assert.deepStrictEqual([A.open, B.open], [{ n: false, s: false, e: true, w: false }, { n: false, s: false, e: false, w: true }]);
  assert.ok(!Z.isFrame(A.open, 7, 3) && Z.isFrame(A.open, 0, 3) && Z.isFrame(A.open, 7, 0), 'spoločná strana nie je rám, rohy áno');
  sv.inv.seed_slnecnica = 2; sv.inv.seed_mak = 2; sv.inv.cov_strk = 2;
  assert.deepStrictEqual(rejects(w, 'zahonPlant', { id: must(a).id, sx: 7, sy: 3, item: 'seed_mak' }), [], 'na spoločnej strane sa sadí');
  // slnečnica v susednom záhone na (1, 3) je od maku na (7, 3) vľavo vzdialená 2 body – potrebuje (4 + 2) / 2 = 3
  assert.match(rejects(w, 'zahonPlant', { id: must(b).id, sx: 1, sy: 3, item: 'seed_slnecnica' })[0] ?? '', /Príliš blízko/);
  assert.deepStrictEqual(rejects(w, 'zahonPlant', { id: must(b).id, sx: 2, sy: 3, item: 'seed_slnecnica' }), []);
  act(w, 'zahonCover', { id: must(b).id, c: 'strk', spots: [[0, 6]] });
  assert.ok(Z.spotAt(must(b), 0, 6)?.c, 'pokryv aj na spoločnej strane');
  // zrušenie pravého záhonu: ľavému sa vráti rám a mak na ňom skončí ako pri zrušení (rastúci zanikne)
  sv.inv.pick = 1;
  assert.deepStrictEqual(rejects(w, 'zahonDestroy', { id: must(b).id }), []);
  assert.ok(!Z.spotAt(only(w), 7, 3), 'z rámu zmizol'); // zoznam objektov sa pri zrušení nahradí – záhon znova zo sveta
  assert.strictEqual(sv.inv.cov_strk, 2, 'pokryv z rušeného záhonu je späť');
  assert.strictEqual(w.plotsUsed, 1);
});

test('rohový záhon (#186): šikmý a oblý tvar, otočenie, spája sa len na rovných stranách', () => {
  // šikmý pri otočení 0: pravý uhol vľavo dole – rovné strany západ a juh, rám po uhlopriečke
  const d0 = { sh: 'diag' as const, rot: 0 as const };
  assert.deepStrictEqual(Z.fullSides(d0), ['w', 's']);
  assert.deepStrictEqual(Z.fullSides({ sh: 'diag', rot: 1 }), ['n', 'w']);
  assert.deepStrictEqual([Z.cellOf(d0, 5, 2), Z.cellOf(d0, 3, 3), Z.cellOf(d0, 2, 5), Z.cellOf(d0, 0, 4)], ['out', 'frame', 'in', 'frame']);
  assert.strictEqual(Z.plantError({ ...d0, spots: [] }, 5, 2, 'tulipan'), 'Tu záhon nie je.');
  assert.strictEqual(Z.plantError({ ...d0, spots: [] }, 2, 5, 'tulipan'), null);
  // oblý: štvrťkruh so stredom vľavo dole
  const r0 = { sh: 'round' as const, rot: 0 as const };
  assert.deepStrictEqual([Z.cellOf(r0, 7, 0), Z.cellOf(r0, 6, 3), Z.cellOf(r0, 3, 4)], ['out', 'frame', 'in']);
  let inside = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (Z.cellOf(r0, x, y) === 'in') inside++;
  assert.ok(inside > 20 && inside < 36, 'oblý má menej pôdy ako štvorec');
  // spájanie: šikmý (rovné strany Z a J) sa spojí so záhonom na západe, nie na východe
  const bed = (id: number, x: number, extra: { sh?: D.ZahonShape; rot?: 0 | 1 | 2 | 3 } = {}): { id: number; kind: 'zahon'; area: 'garden'; x: number; y: number; spots: Z.SpotLike[] } => ({ id, kind: 'zahon', area: 'garden', x, y: 5, spots: [], ...extra });
  const mid = bed(1, 5, d0), west = bed(2, 4), east = bed(3, 6);
  assert.ok(Z.joined(mid, west) && !Z.joined(mid, east));
  assert.deepStrictEqual(Z.groupOf([mid, west, east], mid).map(b => b.id), [1, 2]);
  assert.deepStrictEqual(Z.bedOf([mid, west, east], east).open.w, false, 'východný sused má na šikmom záhone rám');
});

test('rohový záhon (#186): kúpa za 40 🪙, položenie s otočením z náhľadu', () => {
  const { w, i, x, y } = world(), sv = save(w, 'ana');
  stand(w, 'ana', 12.5, 29.5);
  assert.deepStrictEqual(rejects(w, 'zahonBuy', { v: 'kamen', sh: 'round' }), []);
  assert.strictEqual(sv.inv.zahon_kamen_round, 1);
  assert.strictEqual(D.itemName('zahon_kamen_round'), 'Oblý kamenný záhon');
  stand(w, 'ana', x + 0.5, y + 0.5);
  const me = must((w.presence || []).find(p => p.key === 'ana'));
  assert.deepStrictEqual(Actions.resolveAct(w, w.presence, me, { x, y, item: 'zahon_kamen_round', rot: 2 }), { type: 'zahonPlace', data: { key: 'ana', i, v: 'kamen', sh: 'round', rot: 2 } });
  act(w, 'zahonPlace', { i, v: 'kamen', sh: 'round', rot: 2 });
  assert.deepStrictEqual([only(w).sh, only(w).rot, sv.inv.zahon_kamen_round ?? 0, w.plotsUsed], ['round', 2, 0, 1]);
  assert.deepStrictEqual(Obj.loadObjects(JSON.parse(JSON.stringify(w.objects))).list.find(o => o.kind === 'zahon'), only(w), 'tvar a otočenie sa uložia');
});

// ---------- Server: správa 'zahon' prejde až k návrhu ----------
function freePort(): Promise<number> { return new Promise(r => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = portOf(srv); srv.close(() => { r(p); }); }); }); }
type Server = ChildProcessByStdio<null, Readable, Readable>;
function startServer(dataDir: string, port: number): Promise<Server> {
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, DAY_SECONDS: '100000', JOURNAL: '0' }), stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('server sa nespustil')); }, 8000);
    proc.stdout.on('data', (d: Buffer) => { if (/beží/.test(String(d))) { clearTimeout(t); resolve(proc); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server skončil ' + String(c))); });
  });
}
function stopServer(proc: Server): Promise<void> { return new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', () => { r(); }); proc.kill('SIGTERM'); }); }

test('server: správa zahon (kúpa záhonu) prejde k návrhu – nový hráč pri stánku bez reputácie dostane odmietnutie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-zahon-')), port = await freePort(), proc = await startServer(dir, port);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port);
      const t = setTimeout(() => { ws.close(); reject(new Error('bez odpovede')); }, 6000);
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', room: 'zahon', name: 'Eva' })); });
      ws.on('message', raw => {
        const m = parseMsg(raw);
        if (isMsg(m, 'objects')) ws.send(JSON.stringify({ t: 'zahon', op: 'buy', v: 'drevo' }));
        if (isMsg(m, 'toast') && /reputáciu|stánku|mincí/.test(m.text)) { clearTimeout(t); ws.close(); resolve(m.text); }
      });
    });
    assert.strictEqual(text, 'Potrebuješ reputáciu úrovne 1.'); // nový hráč stojí pri stánku (D.SPAWN), reputáciu nemá
  } finally { await stopServer(proc); fs.rmSync(dir, { recursive: true, force: true }); }
});
