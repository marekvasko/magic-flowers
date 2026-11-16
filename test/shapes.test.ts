// Stavebné dieliky (#182): katalóg tvarov (shapes.ts), ich sieť (Mesher.bakeModel) a pomocníci plátna modelov.
import test from 'node:test';
import assert from 'node:assert';
import * as SH from '../src/shared/shapes.ts';
import * as W from '../src/shared/world3d.ts';
import { bakeFine } from '../src/client/finebake.ts';
import { must } from './helpers.ts';

type V3 = readonly [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const shapes = (): SH.Shape[] => SH.SHAPES.filter(s => s !== undefined);
const shape = (id: number): SH.Shape => must(SH.SHAPES[id]);
// objem z povrchu (vejár trojuholníkov každej steny)
function volume(s: SH.Shape): number {
  let v = 0;
  for (const f of s.faces) for (let k = 1; k + 1 < f.pts.length; k++) v += dot(must(f.pts[0]), cross(must(f.pts[k]), must(f.pts[k + 1]))) / 6;
  return v;
}

test('dieliky: katalóg má všetky rodiny v každom otočení a zmestí sa do bajtu', () => {
  const count: Partial<Record<SH.Family, number>> = {};
  for (const s of shapes()) count[s.family] = (count[s.family] ?? 0) + 1;
  assert.deepStrictEqual(count, { klin: 12, narozie: 24, uzlabie: 24, roh: 8, zrezany: 8, nizkyA: 24, nizkyB: 24, narozieN: 24, uzlabieN: 24, doska: 6, platna: 6, stlpik: 3, hrot: 6, strieska: 12 });
  assert.ok(SH.SHAPES.length <= 256);
  assert.strictEqual(SH.SHAPES[0], undefined, '0 je plná kocka');
  shapes().forEach((s, i) => { assert.strictEqual(s.id, i + 1); });
  // ten istý tvar z rôznych smerov je jeden dielik
  assert.strictEqual(SH.klin('x+', 'y+'), SH.klin('y-', 'x-'));
  assert.strictEqual(SH.narozie('x+', 'z+'), SH.narozie('z+', 'x+'));
  assert.notStrictEqual(SH.klin('x+'), SH.klin('x-'));
  assert.throws(() => SH.klin('x+', 'x-'), /neznámy dielik/);
});

test('dieliky: povrch je uzavretý, steny smerujú von a objem sedí', () => {
  const VOL: Record<SH.Family, number> = { klin: 1 / 2, narozie: 1 / 3, uzlabie: 2 / 3, roh: 1 / 6, zrezany: 5 / 6, nizkyA: 1 / 4, nizkyB: 3 / 4, narozieN: 1 / 6, uzlabieN: 1 / 3, doska: 1 / 2, platna: 1 / 4, stlpik: 1 / 4, hrot: 1 / 3, strieska: 1 / 2 };
  for (const s of shapes()) {
    const label = `${s.family} ${s.dirs.join(' ')}`;
    // každá hrana je v povrchu práve raz v každom smere
    const edges = new Map<string, number>();
    for (const f of s.faces) {
      assert.ok(f.pts.length >= 3, label);
      for (const p of f.pts) for (const c of p) assert.ok(c >= 0 && c <= 1, label + ': vrchol v kocke');
      // normála sedí s poradím vrcholov
      const n = cross(sub(must(f.pts[1]), must(f.pts[0])), sub(must(f.pts[2]), must(f.pts[0])));
      assert.ok(dot(n, f.n) > 0, label + ': poradie vrcholov proti normále');
      assert.ok(Math.abs(Math.hypot(...f.n) - 1) < 1e-5, label + ': jednotková normála');
      if (f.side >= 0) { const ax = f.side >> 1, want = f.side & 1 ? 0 : 1; for (const p of f.pts) assert.strictEqual(p[ax], want, label + ': stena na strane kocky'); }
      f.pts.forEach((p, i) => { const k = p.join(',') + '>' + must(f.pts[(i + 1) % f.pts.length]).join(','); edges.set(k, (edges.get(k) ?? 0) + 1); });
    }
    for (const [k, n] of edges) {
      const [a, b] = k.split('>');
      assert.strictEqual(n, 1, label + ': hrana dvakrát ' + k);
      assert.strictEqual(edges.get(`${b}>${a}`), 1, label + ': otvorená hrana ' + k);
    }
    assert.ok(Math.abs(volume(s) - VOL[s.family]) < 1e-6, `${label}: objem ${volume(s)}`);
  }
});

test('dieliky: zakrytie strán – klin má plnú podstavu a chrbát, boky sú trojuholníky', () => {
  const k = shape(SH.klin('x+')), full = SH.FULL_COVER; // strany: +x, -x, +y, -y, +z, -z
  assert.deepStrictEqual(k.cover.map(c => (c === full ? 'full' : c === 0 ? 'none' : 'part')), ['full', 'none', 'none', 'full', 'part', 'part']);
  assert.strictEqual(k.full, 0b001001);
  assert.strictEqual(k.cover[4], k.cover[5], 'oba boky rovnaký trojuholník');
  assert.deepStrictEqual(k.prism, [false, false, true], 'klin sa nemení po osi hrebeňa');
  // doplnok klinu (hore nohami, opačne) zakrýva na boku druhý trojuholník – spolu celú stranu, spoločná len uhlopriečka
  const other = shape(SH.klin('x-', 'y-'));
  assert.strictEqual(must(k.cover[4]) | must(other.cover[4]), full);
  assert.notStrictEqual(must(k.cover[4]) & ~must(other.cover[4]), 0);
  // tenké dieliky nezatieňujú rohy susedov
  assert.strictEqual(shape(SH.stlpik()).occ, false);
  assert.strictEqual(shape(SH.platna()).occ, false);
  assert.strictEqual(k.occ, true);
});

test('dieliky: otočenie o 90° okolo zvislej osi sedí s geometriou a štyri otočenia sú späť', () => {
  assert.strictEqual(SH.ROT_Y[0], 0);
  assert.strictEqual(SH.ROT_Y[SH.klin('x+')], SH.klin('z+'));
  assert.strictEqual(SH.ROT_Y[SH.klin('z+')], SH.klin('x-'));
  const key = (pts: readonly V3[]): string => pts.map(p => p.map(c => c.toFixed(4)).join(',')).sort().join(' ');
  for (const s of shapes()) {
    const r = shape(must(SH.ROT_Y[s.id]));
    // bunka (x, z) sa otočí do (1 − z, x) – ako minikocky v world3d.rotateY
    const want = s.faces.map(f => key(f.pts.map((p): V3 => [1 - p[2], p[1], p[0]]))).sort();
    assert.deepStrictEqual(r.faces.map(f => key(f.pts)).sort(), want, `${s.family} ${s.dirs.join(' ')}`);
    let id = s.id;
    for (let i = 0; i < 4; i++) id = must(SH.ROT_Y[id]);
    assert.strictEqual(id, s.id);
  }
});

// ---- sieť ----
// malý model: bunky [x, y, z, dielik] (materiál kameň)
function model(sx: number, sy: number, sz: number, cells: readonly (readonly [number, number, number, number])[]): W.FineModel {
  const data = new Uint8Array(sx * sy * sz), sh = new Uint8Array(sx * sy * sz);
  for (const [x, y, z, s] of cells) { data[(z * sy + y) * sx + x] = W.M.STONE; sh[(z * sy + y) * sx + x] = s; }
  return { sx, sy, sz, data, shape: sh };
}
// plocha všetkých trojuholníkov siete
function area(b: { P: Float32Array; I: Uint16Array | Uint32Array }): number {
  const p = (i: number): V3 => [must(b.P[i * 3]), must(b.P[i * 3 + 1]), must(b.P[i * 3 + 2])];
  let a = 0;
  for (let i = 0; i < b.I.length; i += 3) { const p0 = p(must(b.I[i])); a += Math.hypot(...cross(sub(p(must(b.I[i + 1])), p0), sub(p(must(b.I[i + 2])), p0))) / 2; }
  return a;
}

test('sieť: model bez dielikov sa vypečie rovnako s poľom tvarov aj bez neho', () => {
  const f = must(W.FINE_MODELS.find(m => m.id === 'tree-' + must(W.TREE_KINDS[0]))).build(1, 0);
  assert.strictEqual(f.shape, undefined, 'stromy sú len z kociek');
  const a = bakeFine(f, 1), b = bakeFine({ ...f, shape: new Uint8Array(f.data.length) }, 1);
  assert.strictEqual(a.shaped, 0);
  assert.deepStrictEqual(a.quads, b.quads);
  assert.deepStrictEqual(a.P, b.P);
  assert.deepStrictEqual(a.color.data.subarray(0, 64), b.color.data.subarray(0, 64));
});

test('sieť: klin na zemi – podstava sa nekreslí, šikmá stena má šikmú normálu', () => {
  const b = bakeFine(model(3, 3, 3, [[1, 0, 1, SH.klin('x+')]]), 1);
  assert.strictEqual(b.quads.length, 0);
  assert.strictEqual(b.shaped, 4, 'chrbát, dva boky a šikmá stena (podstava leží na zemi)');
  assert.strictEqual(b.I.length / 3, 2 + 1 + 1 + 2);
  assert.ok(Math.abs(area(b) - (1 + 0.5 + 0.5 + Math.SQRT2)) < 1e-5);
  const slanted: number[] = [];
  for (let i = 0; i < b.N.length; i += 3) if (must(b.N[i + 1]) > 0.1) slanted.push(must(b.N[i]), must(b.N[i + 1]), must(b.N[i + 2]));
  assert.strictEqual(slanted.length, 4 * 3);
  assert.ok(Math.abs(must(slanted[0]) + Math.SQRT1_2) < 1e-5 && Math.abs(must(slanted[1]) - Math.SQRT1_2) < 1e-5 && slanted[2] === 0);
  for (const v of b.UV) assert.ok(v > 0 && v < 1);
  for (const v of b.UV2) assert.ok(v > 0 && v < 1);
  for (const i of b.I) assert.ok(i < b.P.length / 3);
});

test('sieť: steny medzi susedmi – plná strana dielika zakryje kocku, čiastočná nie', () => {
  // kocka za chrbtom klinu: chrbát klinu aj stena kocky ku klinu zmiznú
  const back = bakeFine(model(4, 3, 3, [[1, 0, 1, SH.klin('x+')], [2, 0, 1, 0]]), 1);
  assert.strictEqual(back.shaped, 3, 'boky a šikmá stena');
  assert.strictEqual(back.quads.length, 4, 'kocka: vrch a tri boky');
  // kocka pri boku klinu: trojuholník klinu zmizne, stena kocky ostane celá
  const side = bakeFine(model(3, 3, 4, [[1, 0, 1, SH.klin('x+')], [1, 0, 2, 0]]), 1);
  assert.strictEqual(side.shaped, 3, 'chrbát, druhý bok a šikmá stena');
  assert.strictEqual(side.quads.length, 5, 'kocka: vrch a štyri boky');
  // dva rovnaké kliny vedľa seba: spoločné boky zmiznú, šikmá stena je jedna cez oba
  const pair = bakeFine(model(3, 3, 4, [[1, 0, 1, SH.klin('x+')], [1, 0, 2, SH.klin('x+')]]), 1);
  assert.strictEqual(pair.shaped, 2 + 2 + 1, 'dva chrbty, dva krajné boky, jedna šikmá stena');
  assert.ok(Math.abs(area(pair) - (2 + 1 + 2 * Math.SQRT2)) < 1e-5);
  // klin a jeho doplnok tvoria kocku: zvonka šesť… bez podstavy päť štvorcov
  const whole = bakeFine(model(3, 3, 3, [[1, 0, 1, SH.klin('x+')]]), 1), cube = bakeFine(model(3, 3, 3, [[1, 0, 1, 0]]), 1);
  assert.ok(area(whole) < area(cube));
  assert.strictEqual(area(cube), 5);
});

test('modely: budovy majú dieliky, otočenie ich otočí a sneh im nechá tvar', () => {
  const entry = (id: string): W.FineModelEntry => must(W.FINE_MODELS.find(m => m.id === id));
  for (const id of ['house', 'hut', 'icehouse', 'dielna', 'stall', 'well', 'dock']) {
    const e = entry(id), f = e.build(1, 0), sh = must(f.shape);
    assert.ok(sh.some(v => v), id + ' má dieliky');
    sh.forEach((v, i) => { if (v) assert.ok(f.data[i], id + ': dielik má materiál'); });
    // sneh mení len materiál
    assert.deepStrictEqual(e.build(3, 0).shape, sh, id + ': zima');
    // otočená sieť má rovnaký povrch (zlučovanie stien závisí od smeru, plocha nie) a štyri otočenia sú pôvodný model
    const b0 = bakeFine(f, 1), b1 = bakeFine(e.build(1, 1), 1);
    assert.strictEqual(b1.shaped > 0, true);
    assert.ok(Math.abs(area(b1) - area(b0)) < 1e-3 * area(b0), id + ': plocha po otočení');
    let r = f;
    for (let i = 0; i < 4; i++) r = W.rotateY(r);
    assert.deepStrictEqual(r.shape, f.shape);
    assert.deepStrictEqual(r.data, f.data);
    for (const v of b0.P) assert.ok(v >= 0 && v <= Math.max(f.sx, f.sy, f.sz));
  }
  // strecha domčeka je šikmá: vrchná bunka nad odkvapom je klin
  const house = entry('house').build(1, 0), kinds = new Set([...must(house.shape)].filter(v => v).map(v => must(SH.SHAPES[v]).family));
  assert.ok(kinds.has('klin') && kinds.has('platna') && kinds.has('narozie'));
  assert.ok(new Set([...must(entry('hut').build(1, 0).shape)].map(v => SH.SHAPES[v]?.family)).has('narozie'), 'valbová strecha má nárožia');
});

test('plátno: slopes vyplní schody klinmi, rohy nárožím a úžľabím; round zaoblí kúty', () => {
  const C = W.fineCanvas(1, 1, 6), S = W.M.SHINGLE;
  // dvojstupňová „pyramída“: 4 × 4 a na nej 2 × 2
  C.fbox(0, 0, 0, 3, 0, 3, S); C.fbox(1, 1, 1, 2, 1, 2, S);
  C.slopes([S]);
  assert.strictEqual(C.gets(0, 1, 1), SH.klin('x+'));
  assert.strictEqual(C.gets(3, 1, 2), SH.klin('x-'));
  assert.strictEqual(C.gets(1, 1, 0), SH.klin('z+'));
  assert.strictEqual(C.gets(0, 1, 0), SH.narozie('x+', 'z+'));
  assert.strictEqual(C.gets(3, 1, 3), SH.narozie('x-', 'z-'));
  assert.strictEqual(C.getf(0, 1, 0), S, 'materiál z kocky, o ktorú sa opiera');
  assert.strictEqual(C.gets(1, 1, 1), 0, 'kocky ostanú kockami');
  assert.strictEqual(C.getf(-1, 1, 1), 0, 'bez kocky pod sebou nič');
  // vnútorný roh „L“: úžľabie
  const L = W.fineCanvas(1, 1, 6);
  L.fbox(0, 0, 0, 3, 0, 3, S); L.fbox(0, 1, 0, 3, 1, 0, S); L.fbox(0, 1, 0, 0, 1, 3, S);
  L.slopes([S]);
  assert.strictEqual(L.gets(1, 1, 1), SH.uzlabie('x-', 'z-'));
  assert.strictEqual(L.gets(2, 1, 1), SH.klin('z-'));
  // nadol: bunka visí pod kockou
  const U = W.fineCanvas(1, 1, 6);
  U.fbox(0, 3, 0, 3, 3, 3, S); U.fbox(1, 2, 1, 2, 2, 2, S);
  U.slopes([S], { down: true });
  assert.strictEqual(U.gets(0, 2, 1), SH.klin('x+', 'y-'));
  // zaoblenie v pôdoryse: kút medzi dvoma stenami dostane zvislý klin, materiál podľa opts.mat
  const R = W.fineCanvas(1, 1, 6);
  R.fbox(0, 0, 0, 3, 1, 0, S); R.fbox(0, 0, 0, 0, 1, 3, S);
  R.round([S], { mat: W.M.STONE });
  assert.strictEqual(R.gets(1, 0, 1), SH.klin('x-', 'z+'));
  assert.strictEqual(R.getf(1, 1, 1), W.M.STONE);
  // put bez dielika vráti kocku, paint nechá tvar, model bez dielikov nemá pole shape
  R.paint(1, 0, 1, S);
  assert.strictEqual(R.gets(1, 0, 1), SH.klin('x-', 'z+'));
  R.put(1, 0, 1, S); R.put(1, 1, 1, 0);
  assert.strictEqual(R.gets(1, 0, 1), 0);
  assert.strictEqual(R.done().shape, undefined);
});
