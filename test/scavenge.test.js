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

test('hustota semienok závisí od dennej hodiny: ráno najviac, v noci takmer nič', () => {
  const morning = Scav.density(room(at(7)), field), noon = Scav.density(room(at(13)), field), night = Scav.density(room(at(23)), field);
  assert.ok(morning > noon && noon > night, `${morning} ${noon} ${night}`);
  assert.ok(Math.abs(noon - C.density) < 1e-9);
});

test('okraj lesa má viac semienok, zima menej', () => {
  assert.ok(edge != null && Scav.density(room(at(13)), edge) > Scav.density(room(at(13)), field));
  const spring = Scav.density(room(at(13, 1)), field), summer = Scav.density(room(at(13, 1 + D.DAYS_PER_SEASON)), field);
  const winter = Scav.density(room(at(13, 1 + 3 * D.DAYS_PER_SEASON)), field);
  assert.ok(summer > spring && spring > winter);
});

const grass = tiles.map((t, i) => i).filter(i => tiles[i].g === 'grass');
const spots = r => grass.filter(i => Scav.hasSeed(r, i));

test('semienka sú len na niektorých políčkach, počas hodiny ostávajú a potom sa premiestnia', () => {
  const r = room(at(13), 3);
  const a = spots(r);
  assert.ok(a.length > 0 && a.length < grass.length * 0.2, 'políčok so semienkom: ' + a.length + '/' + grass.length);
  r.tick += C.window - 1 - (r.tick % C.window); // koniec tej istej hodiny
  assert.deepStrictEqual(spots(r), a, 'v rámci hodiny sa nemenia');
  r.tick += 1; // ďalšia hodina
  const b = spots(r);
  assert.notDeepStrictEqual(b, a, 'v ďalšej hodine sú inde');
  for (const i of grass) assert.strictEqual(Scav.chance(r, i), Scav.hasSeed(r, i) ? C.find : 0);
});

test('prehľadané políčko je do konca hodiny prázdne, staré záznamy sa vyhodia', () => {
  const r = room(at(13), 3), i = spots(r)[0];
  Scav.roll(r, i);
  assert.strictEqual(Scav.hasSeed(r, i), false);
  assert.strictEqual(Scav.roll(r, i), false, 'druhýkrát nič');
  r.tick += C.window;
  Scav.prune(r);
  assert.deepStrictEqual(r.scav, {});
});

test('tajné číslo sveta je jedno a rôzne svety majú semienka inde', () => {
  const a = room(at(13), 11), b = room(at(13), 12);
  const sa = spots(a);
  const salt = a.scavSalt;
  assert.ok(Number.isInteger(salt), 'vytvorí sa pri prvom hľadaní');
  assert.deepStrictEqual(spots(a), sa);
  assert.strictEqual(a.scavSalt, salt, 'a už sa nemení');
  assert.notDeepStrictEqual(spots(b), sa);
});

test('za deň poctivého hľadania z políčka na políčko (≈ 70 pokusov cez deň) nájdeš v priemere okolo 4 semienok', () => {
  let found = 0;
  const days = 300;
  for (let d = 0; d < days; d++) {
    const r = room(0, 1000 + d);
    for (let k = 0; k < 70; k++) {
      r.tick = at(6 + k * 15 / 70, 1 + (d % 4)); // od 6:00 do 21:00
      if (Scav.roll(r, grass[(d * 31 + k * 7) % grass.length])) found++;
    }
  }
  const avg = found / days;
  assert.ok(avg > 2.5 && avg < 6, 'priemer za deň: ' + avg);
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
