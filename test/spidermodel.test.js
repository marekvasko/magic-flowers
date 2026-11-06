const test = require('node:test');
const assert = require('node:assert');
const SM = require('../shared/spidermodel.js');

// rozmery pavúkov: rozpätie nôh, výška pradleny ako hráč
function bounds(kind) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (const p of SM.build(kind, 0, 'ground')) {
    if (p.k === 'ell') top = Math.max(top, p.c[1] + Math.hypot(p.A[0][1], p.A[1][1], p.A[2][1]));
    else for (const q of [p.a, p.b]) { top = Math.max(top, q[1]); if (q[1] < 0.05) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); } }
  }
  return { span: Math.max(x1 - x0, z1 - z0), top };
}

test('veľkosti: krížiak 1/4, vlčiak 1, pradlena 1,5 políčka a vysoká ako hráč', () => {
  assert.ok(Math.abs(bounds('k').span - 0.25) < 0.02);
  assert.ok(Math.abs(bounds('v').span - 1) < 0.06);
  assert.ok(Math.abs(bounds('p').span - 1.5) < 0.08);
  assert.ok(Math.abs(bounds('p').top - 1.2) < 0.08, 'pradlena ' + bounds('p').top);
  assert.ok(bounds('v').top < 0.35 && bounds('k').top < 0.12);
});

test('16 pohľadov × 4 snímky: každý sa premietne do elíps a úsečiek', () => {
  assert.strictEqual(SM.VIEWS.length, 16);
  for (const k of Object.keys(SM.SPECIES)) for (const v of SM.VIEWS) {
    const L = SM.layout(k, v);
    assert.ok(L.w > 20 && L.h > 20 && L.w < 400 && L.h < 400, `${k} ${v} ${L.w}×${L.h}`);
    assert.strictEqual(L.frames.length, SM.FRAMES);
    for (const items of L.frames) {
      assert.ok(items.filter(i => i.k === 'ell').length >= 3);
      assert.strictEqual(items.filter(i => i.k === 'seg' && i.band).length, 24); // 8 nôh × 3 články
    }
  }
});

test('smer hlavy voči kamere → pohľad na zemi', () => {
  // kamera na +z: hlava ku kamere = S, doprava = E, od kamery = N
  assert.strictEqual(SM.planarView(0, 1, 0, 1), 'S');
  assert.strictEqual(SM.planarView(1, 0, 0, 1), 'E');
  assert.strictEqual(SM.planarView(0, -1, 0, 1), 'N');
  assert.strictEqual(SM.planarView(-1, 0, 0, 1), 'W');
  assert.strictEqual(SM.planarView(1, 1, 0, 1), 'SE');
  // otočená kamera (na +x): hlava na +x je ku kamere
  assert.strictEqual(SM.planarView(1, 0, 1, 0), 'S');
});

test('chrbát a brucho: kresba zadočka len zo strany, ktorá je ku kamere', () => {
  const cols = v => new Set(SM.layout('k', v).frames[0].flatMap(i => (i.marks || []).map(m => m.col)));
  const C = SM.SPECIES.k.col;
  assert.ok(cols('down').has(C.mark) && !cols('down').has(C.belly2)); // chrbtom: biely kríž
  assert.ok(cols('down-b').has(C.belly2) && !cols('down-b').has(C.mark)); // bruchom: žlté zátvorky
});

test('nohy za veľkým zadočkom krížiaka sa kreslia pred ním (zakryje ich)', () => {
  // pohľad N (hlava od kamery): zadné nohy smerujú ku kamere, predné sú za zadočkom
  const items = SM.layout('k', 'N').frames[0];
  const abd = items.findIndex(i => i.k === 'ell' && i.e.rx > 0.03);
  const front = items.filter(i => i.k === 'seg' && i.tip && i.d < items[abd].d - 0.03);
  assert.ok(front.length > 0 && front.every(s => items.indexOf(s) < abd));
});

test('na kmeni: 10 pohľadov podľa strany kmeňa voči kamere, zo zadnej strany žiaden', () => {
  assert.strictEqual(SM.TRUNK.length, 10);
  for (const k of Object.keys(SM.SPECIES)) for (const v of SM.TRUNK) {
    const L = SM.layout(k, v);
    assert.ok(L.w > 10 && L.h > 10 && L.frames[0].length > 20, `${k} ${v}`);
  }
  // kamera na +z (gx 0, gz 1); kmeň s pavúkom na strane ku kamere = 0°, vpravo = +90°
  assert.strictEqual(SM.trunkView(0, 1, 0, 1, false), 't0d');
  assert.strictEqual(SM.trunkView(1, 0, 0, 1, true), 't90u');
  assert.strictEqual(SM.trunkView(-1, 1, 0, 1, false), 't-45d');
  assert.strictEqual(SM.trunkView(1, -0.3, 0, 1, false), 't90d');
  assert.strictEqual(SM.trunkView(0, -1, 0, 1, false), null, 'za kmeňom');
  // t0 = rovnaký ako starý pohľad 'down'
  const a = SM.layout('v', 't0d'), b = SM.layout('v', 'down');
  assert.deepStrictEqual([a.w, a.h], [b.w, b.h]);
});

test('oči na snímke: spredu áno, zozadu ich zakryje zadoček, z brucha žiadne', () => {
  for (const k of ['k', 'p']) {
    assert.ok(SM.layout(k, 'S').eyes[0].length >= 2, k + ' spredu');
    assert.strictEqual(SM.layout(k, 'N').eyes[0].length, 0, k + ' zozadu');
    assert.strictEqual(SM.layout(k, 'down-b').eyes[0].length, 0, k + ' brucho');
  }
  for (const e of SM.layout('v', 'S').eyes[0]) assert.ok(e.r > 0 && e.y > 0, 'oko nad zemou');
});
