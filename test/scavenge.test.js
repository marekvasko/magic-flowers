const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/data.js');
const Scav = require('../scavenge.js');
const TPD = D.TICKS_PER_DAY, C = D.SCAVENGE;

const tiles = D.buildMap().map(g => ({ g, s: null }));
// tick v prvý deň jari o danej hodine
const at = (h, day = 1) => (day - 1) * TPD + Math.round(h * 60 / D.MIN_PER_TICK);
function room(tick, seed) { return { tick, rng: seed || 7, tiles, scav: {} }; }
// tráva ďaleko od lesa a ciest, aj tráva na okraji lesa
const field = (() => { for (let i = 0; i < tiles.length; i++) if (tiles[i].g === 'grass' && Scav.tileFactor(tiles, i) === 1) return i; })();
const edge = (() => { for (let i = 0; i < tiles.length; i++) if (tiles[i].g === 'grass' && Scav.tileFactor(tiles, i) > 1.2) return i; })();

test('hľadať sa dá len v neprekopanej tráve', () => {
  assert.ok(Scav.canSearch({ g: 'grass', s: null }));
  assert.ok(!Scav.canSearch({ g: 'grass', s: { k: 'normal' } }));
  for (const g of ['forest', 'path', 'sand', 'rock', 'water', 'tree']) assert.ok(!Scav.canSearch({ g, s: null }), g);
});

test('šanca závisí od dennej hodiny: ráno najlepšie, v noci takmer nič', () => {
  const morning = Scav.chance(room(at(7)), field), noon = Scav.chance(room(at(13)), field), night = Scav.chance(room(at(23)), field);
  assert.ok(morning > noon && noon > night, `${morning} ${noon} ${night}`);
  assert.ok(Math.abs(noon - C.chance) < 1e-9);
});

test('šanca závisí od políčka: okraj lesa je lepší, prehľadané políčko je prázdne a pomaly sa plní', () => {
  assert.ok(edge != null && Scav.chance(room(at(13)), edge) > Scav.chance(room(at(13)), field));
  const r = room(at(13));
  Scav.empty(r, field);
  assert.strictEqual(Scav.chance(r, field), 0);
  r.tick += TPD * C.refillDays / 2;
  assert.ok(Math.abs(Scav.fill(r, field) - 0.5) < 1e-9);
  r.tick += TPD * C.refillDays;
  assert.strictEqual(Scav.fill(r, field), 1);
  Scav.prune(r);
  assert.deepStrictEqual(r.scav, {}, 'plné políčka sa z uloženia vyhodia');
});

test('zima je skúpa, leto štedré', () => {
  const spring = Scav.chance(room(at(13, 1)), field), summer = Scav.chance(room(at(13, 1 + D.DAYS_PER_SEASON)), field);
  const winter = Scav.chance(room(at(13, 1 + 3 * D.DAYS_PER_SEASON)), field);
  assert.ok(summer > spring && spring > winter);
});

test('hod kockou vyprázdni políčko aj keď sa nič nenájde', () => {
  const r = room(at(13), 1);
  Scav.roll(r, field);
  assert.strictEqual(Scav.fill(r, field), 0);
  assert.strictEqual(Scav.roll(r, field), false, 'prázdne políčko nič nedá');
});

test('za deň poctivého hľadania (hodinu za hodinou, vždy na novom políčku) nájdeš v priemere okolo 4 semienok', () => {
  let found = 0, days = 200;
  const grass = tiles.map((t, i) => i).filter(i => tiles[i].g === 'grass');
  for (let d = 0; d < days; d++) {
    const r = room(0, 1000 + d);
    let k = 0;
    for (let h = 6; h < 21; h++) { r.tick = at(h, 1 + (d % 4)); if (Scav.roll(r, grass[k++ * 7 % grass.length])) found++; }
  }
  const avg = found / days;
  assert.ok(avg > 3 && avg < 6, 'priemer za deň: ' + avg);
});

test('divé semienko: len sezónne, nemagické a nie prísne druhy', () => {
  for (let se = 0; se < 4; se++) {
    const list = Scav.wildCandidates(se);
    assert.ok(list.length > 0, 'obdobie ' + se);
    for (const sp of list) {
      const s = D.SPECIES[sp];
      assert.ok(s.seasons.includes(se) && !s.magic && !s.strict, sp);
    }
  }
  assert.ok(!Scav.wildCandidates(1).includes('plesnivec'));
  assert.ok(!Scav.wildCandidates(1).includes('duhova') && !Scav.wildCandidates(3).includes('papradie'));
});

test('divé semienko „pozná trh“: drahší kvet v čase sadenia padne oveľa častejšie (váha cena²)', () => {
  const r = room(0, 99), n = 4000, cnt = {};
  const price = sp => sp === 'slnecnica' ? 100 : 20; // leto: slnečnica sa práve predáva za 5× viac
  for (let k = 0; k < n; k++) { const sp = Scav.pickWild(r, 1, price); cnt[sp] = (cnt[sp] || 0) + 1; }
  const others = Scav.wildCandidates(1).length - 1;
  const expected = 25 / (25 + others); // 100² : 20² = 25 : 1
  assert.ok(Math.abs(cnt.slnecnica / n - expected) < 0.03, `${cnt.slnecnica / n} vs ${expected}`);
  for (const sp in cnt) assert.ok(Scav.wildCandidates(1).includes(sp));
});

test('rovnaké semienko náhody → rovnaký druh (deterministické)', () => {
  const a = room(0, 5), b = room(0, 5), price = () => 30;
  for (let k = 0; k < 20; k++) assert.strictEqual(Scav.pickWild(a, 0, price), Scav.pickWild(b, 0, price));
});

test('klient nevidí druh divej rastliny, kým nevyklíči', () => {
  const t = { g: 'grass', s: { k: 'normal', w: 0, r: 0, o: 'jano', p: { sp: 'slnecnica', prog: 0, q: 3, dry: 0, wild: 1 } } };
  const v = Scav.tileView(t);
  assert.strictEqual(v.s.p.sp, 'wild');
  assert.strictEqual(t.s.p.sp, 'slnecnica', 'stav na serveri ostáva');
  assert.strictEqual(D.stageOf(v.s.p), 0);
  const sprouted = { g: 'grass', s: Object.assign({}, t.s, { p: { sp: 'slnecnica', prog: 1, q: 3, dry: 0 } }) };
  assert.strictEqual(Scav.tileView(sprouted), sprouted);
});

test('divé semienka sa nedajú predať a majú slovenský názov', () => {
  const Econ = require('../economy.js');
  for (let se = 0; se < 4; se++) {
    assert.strictEqual(Econ.sellQuote({ market: {} }, 'wild_' + se), null);
    assert.match(D.itemName('wild_' + se), /^Divé semienko \((jar|leto|jeseň|zima)\)$/);
  }
});
