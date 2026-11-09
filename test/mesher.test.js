const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/shared/data.ts');
const W = require('../src/shared/world3d.ts');
const MS = require('../src/shared/mesher.ts');
const A = require('../src/server/areas.ts');

// Pôvodná sieť: každá viditeľná stena kocky samostatne – (stena, bunka, materiál, zatienenie rohov)
function naive(dims, get, visible, occ) {
  const out = new Map();
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const m = get(x, y, z);
    if (!m) continue;
    for (let f = 0; f < 6; f++) {
      const ax = f >> 1, sg = f & 1 ? -1 : 1, [, ua, va] = MS.AXES[ax];
      const n = [0, 0, 0]; n[ax] = sg;
      const nb = get(x + n[0], y + n[1], z + n[2]);
      if (!visible(m, nb, ax, sg)) continue;
      const ao = MS.CORNERS[sg < 0 ? 1 : 0].map(([du, dv]) => {
        const L = [x + n[0], y + n[1], z + n[2]];
        const s1 = L.slice(), s2 = L.slice(), cc = L.slice();
        s1[ua] += du ? 1 : -1; s2[va] += dv ? 1 : -1; cc[ua] += du ? 1 : -1; cc[va] += dv ? 1 : -1;
        const o1 = occ(get(...s1), nb) ? 1 : 0, o2 = occ(get(...s2), nb) ? 1 : 0, oc = occ(get(...cc), nb) ? 1 : 0;
        return o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
      });
      out.set(`${f}|${x},${y},${z}`, `${m}|${ao}`);
    }
  }
  return out;
}
// Zlúčené obdĺžniky rozložené späť na steny kociek
function unpack(quads) {
  const out = new Map();
  for (const q of quads) {
    const [, ua, va] = MS.AXES[q.ax], f = MS.faceIndex(q);
    for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) {
      const c = [0, 0, 0]; c[q.ax] = q.d; c[ua] = q.u + i; c[va] = q.v + j;
      const k = `${f}|${c}`;
      assert.ok(!out.has(k), 'stena pokrytá dvakrát: ' + k);
      out.set(k, `${q.m}|${q.ao}`);
    }
  }
  return out;
}
const sameFaces = (a, b) => {
  assert.strictEqual(a.size, b.size);
  for (const [k, v] of b) assert.strictEqual(a.get(k), v, k);
};
const fineGet = f => (x, y, z) => (y < 0 ? 1 : (x < 0 || z < 0 || x >= f.sx || y >= f.sy || z >= f.sz) ? 0 : f.data[(z * f.sy + y) * f.sx + x]);
const fineVis = (m, nb) => !nb, fineOcc = v => !!v;

test('náhodná mriežka: zlúčené steny pokryjú presne to isté ako pôvodné', () => {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 20; t++) {
    const dims = [3 + (t % 5), 2 + (t % 4), 4 + (t % 3)], data = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (let i = 0; i < data.length; i++) data[i] = rnd() < 0.45 ? 1 + Math.floor(rnd() * 3) : 0;
    const f = { sx: dims[0], sy: dims[1], sz: dims[2], data };
    const quads = MS.greedy(dims, fineGet(f), fineVis, fineOcc);
    sameFaces(unpack(quads), naive(dims, fineGet(f), fineVis, fineOcc));
  }
});

test('plná kocka: každá strana je jeden obdĺžnik', () => {
  const f = { sx: 4, sy: 4, sz: 4, data: new Uint8Array(64).fill(5) };
  const quads = MS.greedy([4, 4, 4], fineGet(f), fineVis, () => false);
  assert.strictEqual(quads.length, 5); // spodok leží na zemi
  for (const q of quads) assert.deepStrictEqual([q.w, q.h], [4, 4]);
  // so zatienením: bočné steny majú pri zemi tieň, ktorý sa mení len po výške – pás pri zemi + zvyšok
  assert.strictEqual(MS.greedy([4, 4, 4], fineGet(f), fineVis, fineOcc).length, 1 + 4 * 2);
});

test('zatienenie, ktoré sa mení len po jednej osi, sa zlúči po druhej', () => {
  // podlaha 4×1×3 a na nej dlhší múr pozdĺž x: vrch podlahy pri múre má tieň len smerom k múru
  const sx = 6, sy = 2, sz = 3, data = new Uint8Array(sx * sy * sz);
  for (let z = 0; z < sz; z++) for (let x = 1; x < sx - 1; x++) data[(z * sy) * sx + x] = 1;
  for (let x = 0; x < sx; x++) data[(2 * sy + 1) * sx + x] = 2;
  const f = { sx, sy, sz, data };
  const quads = MS.greedy([sx, sy, sz], fineGet(f), fineVis, fineOcc);
  sameFaces(unpack(quads), naive([sx, sy, sz], fineGet(f), fineVis, fineOcc));
  const floorTop = quads.filter(q => q.ax === 1 && q.sg > 0 && q.m === 1);
  assert.ok(floorTop.every(q => q.h === sx - 2), 'pásy po celej dĺžke múru'); // na vrchnej stene je u = z, v = x
  assert.strictEqual(floorTop.length, 2); // pás pri múre (s tieňom) a zvyšok bez tieňa
});

test('modely Lesa na pomedzí: len povrch (bez materiálu a tieňa) – rovnaké steny, výrazne menej trojuholníkov', () => {
  const area = 'pomedzie', w = D.areaSize(area).w;
  const g = W.buildGrid(A.loadPomedzie(12345), 1, w, area);
  let before = 0, after = 0;
  const seen = new Set();
  for (const f of g.fine) {
    // ako render3d.mjs: steny sa zlučujú len podľa toho, či tam sú (farbu a zatienenie dopočíta shader)
    const get = fineGet(f), solid = (x, y, z) => (get(x, y, z) ? 1 : 0), dims = [f.sx, f.sy, f.sz];
    const quads = MS.greedy(dims, solid, fineVis, () => false);
    if (!seen.has(f.data)) {
      seen.add(f.data);
      if (seen.size <= 4) sameFaces(unpack(quads), naive(dims, solid, fineVis, () => false));
    }
    let faces = 0;
    for (const q of quads) faces += q.w * q.h;
    before += faces; after += quads.length;
  }
  assert.ok(after * 1.8 < before, `${after} obdĺžnikov z ${before} stien`);
});

test('zem: rovnaký povrch ako pôvodná sieť a menej stien', () => {
  const g = W.buildGrid(A.loadPomedzie(12345), 1, D.areaSize('pomedzie').w, 'pomedzie'), I = W.M.INVIS;
  const get = (x, y, z) => W.get(g, x, y, z);
  const vis = (m, nb, ax, sg) => m !== I && m !== W.M.ICE && !(nb && nb !== I) && !(m === W.M.WATER && ax === 1 && sg > 0);
  const occ = (v, front) => v && !(front === I && v === I);
  const dims = [g.NX, W.NY, g.NZ];
  const quads = MS.greedy(dims, get, vis, occ), ref = naive(dims, get, vis, occ);
  sameFaces(unpack(quads), ref);
  assert.ok(quads.length * 2 < ref.size, `${quads.length} obdĺžnikov z ${ref.size} stien`);
});

test('rohy a trojuholníky obdĺžnika', () => {
  const q = { ax: 1, sg: 1, m: 1, d: 2, u: 1, v: 3, w: 2, h: 4, ao: [3, 3, 3, 3] };
  // os y: u = z, v = x
  assert.deepStrictEqual(MS.quadCorners(q), [[3, 3, 1], [3, 3, 3], [7, 3, 3], [7, 3, 1]]);
  assert.deepStrictEqual(MS.quadIndices([3, 0, 3, 0], 8), [8, 9, 10, 8, 10, 11]);
  assert.deepStrictEqual(MS.quadIndices([0, 3, 0, 3], 8), [9, 10, 11, 9, 11, 8]);
});

test('vypečená textúra: farba každej viditeľnej steny a zatienenie jej rohov ako pôvodná sieť', () => {
  const g = W.buildGrid(A.loadPomedzie(12345), 1, D.areaSize('pomedzie').w, 'pomedzie');
  const CURVE = [0.5, 0.68, 0.84, 1];
  const look = (m, x, y, z, f) => [m / 255, (x + y * 2) / 255, (z + f * 30) / 255, m & 1];
  for (const f of [g.fine[0], g.fine.find(m => m.type === 'bush')].filter(Boolean)) {
    const dims = [f.sx, f.sy, f.sz], get = fineGet(f), b = MS.bakeModel(dims, get, fineOcc, look, CURVE);
    const ref = naive(dims, get, fineVis, fineOcc);
    let faces = 0;
    b.quads.forEach((q, k) => {
      const [, ua, va] = MS.AXES[q.ax], fi = MS.faceIndex(q);
      const cx = Math.round(b.UV[k * 8] * b.color.W) - 1, cy = Math.round(b.UV[k * 8 + 1] * b.color.H) - 1;
      const ox = Math.round(b.UV2[k * 8] * b.ao.W - 1.5), oy = Math.round(b.UV2[k * 8 + 1] * b.ao.H - 1.5);
      for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) {
        const c = [0, 0, 0]; c[q.ax] = q.d; c[ua] = q.u + i; c[va] = q.v + j;
        const [m, ao] = ref.get(`${fi}|${c}`).split('|'), want = look(+m, ...c, fi).map(v => Math.round(v * 255));
        const o = ((cy + 1 + j) * b.color.W + cx + 1 + i) * 4;
        assert.deepStrictEqual([...b.color.data.slice(o, o + 4)], want);
        // rohy steny (poradie CORNERS) v mriežke zatienenia
        MS.CORNERS[q.sg < 0 ? 1 : 0].forEach(([du, dv], n) => {
          const t = b.ao.data[(oy + 1 + j + dv) * b.ao.W + ox + 1 + i + du];
          assert.strictEqual(t, Math.round(CURVE[ao.split(',')[n]] * 255), `${fi}|${c} roh ${n}`);
        });
        faces++;
      }
    });
    assert.strictEqual(faces, ref.size);
  }
});

test('rozloženie obdĺžnikov do obrázka sa neprekrýva', () => {
  const rects = Array.from({ length: 200 }, (_, i) => [1 + (i * 7) % 13, 1 + (i * 5) % 9]);
  const { W: w, H: h, at } = MS.pack(rects), used = new Uint8Array(w * h);
  rects.forEach(([rw, rh], i) => {
    const [x, y] = at[i];
    assert.ok(x + rw <= w && y + rh <= h);
    for (let j = 0; j < rh; j++) for (let k = 0; k < rw; k++) { assert.ok(!used[(y + j) * w + x + k]); used[(y + j) * w + x + k] = 1; }
  });
});

test('budovy sa pri prestavbe sveta nestavajú znova – rovnaké dáta, sieť sa počíta raz', () => {
  const tiles = D.buildMap().map(g => ({ g }));
  const a = W.buildGrid(tiles, 0).fine, b = W.buildGrid(tiles, 0).fine;
  assert.ok(a.length > 0);
  a.forEach((m, i) => assert.strictEqual(m.data, b[i].data, m.type));
});
