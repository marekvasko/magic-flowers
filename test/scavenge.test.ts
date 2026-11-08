import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { Ground, SpeciesId } from '../src/shared/data.ts';
import type { Soil } from '../src/shared/save.ts';
import * as Scav from '../src/server/scavenge.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import type { Rng, Tile } from '../src/server/world.ts';
import { must, partial } from './helpers.ts';
const TPD = D.TICKS_PER_DAY, C = D.SCAVENGE;

const tiles: Tile[] = D.buildMap().map(g => ({ g, s: null }));
// tick v prvý deň jari o danej hodine
const at = (h: number, day = 1): number => (day - 1) * TPD + Math.round(h * 60 / D.MIN_PER_TICK);
// Svet hľadania: políčka, prehľadané políčka, tajná soľ (zo semienka) a generátor náhody
interface Room { tick: number; tiles: Tile[]; scav: Scav.Scav; scavSalt: number; g: Rng }
function room(tick: number, seed?: number): Room { return { tick, tiles, scav: {}, scavSalt: E.seedOf('test', seed || 7), g: E.generator(seed || 7) }; }
const density = (r: Room, i: number): number => Scav.density(r.tiles, r.tick, i);
const hasSeed = (r: Room, i: number): boolean => Scav.hasSeed(r.scavSalt, r.scav, r.tiles, r.tick, i);
const chance = (r: Room, i: number): number => Scav.chance(r.scavSalt, r.scav, r.tiles, r.tick, i);
const roll = (r: Room, i: number): boolean => Scav.roll(r.scavSalt, r.scav, r.tiles, r.tick, i, r.g);
const has = (list: readonly string[], v: string): boolean => list.includes(v);
// tráva ďaleko od lesa a ciest, aj tráva na okraji lesa
const field = must(((): number | undefined => { for (let i = 0; i < tiles.length; i++) if (must(tiles[i]).g === 'grass' && Scav.tileFactor(tiles, i) === 1) return i; return undefined; })());
const edge = ((): number | undefined => { for (let i = 0; i < tiles.length; i++) if (must(tiles[i]).g === 'grass' && Scav.tileFactor(tiles, i) > 1.2) return i; return undefined; })();

test('hľadať sa dá len v neprekopanej tráve', () => {
  assert.ok(Scav.canSearch({ g: 'grass', s: null }));
  assert.ok(!Scav.canSearch({ g: 'grass', s: partial<Soil>({ k: 'normal' }) }));
  const grounds: Ground[] = ['forest', 'path', 'sand', 'rock', 'water', 'tree'];
  for (const g of grounds) assert.ok(!Scav.canSearch({ g, s: null }), g);
});

test('hustota semienok závisí od dennej hodiny: ráno najviac, v noci takmer nič', () => {
  const morning = density(room(at(7)), field), noon = density(room(at(13)), field), night = density(room(at(23)), field);
  assert.ok(morning > noon && noon > night, `${morning} ${noon} ${night}`);
  assert.ok(Math.abs(noon - C.density) < 1e-9);
});

test('okraj lesa má viac semienok, zima menej', () => {
  assert.ok(edge != null && density(room(at(13)), edge) > density(room(at(13)), field));
  const spring = density(room(at(13, 1)), field), summer = density(room(at(13, 1 + D.DAYS_PER_SEASON)), field);
  const winter = density(room(at(13, 1 + 3 * D.DAYS_PER_SEASON)), field);
  assert.ok(summer > spring && spring > winter);
});

const grass = tiles.map((t, i) => i).filter(i => must(tiles[i]).g === 'grass');
const spots = (r: Room): number[] => grass.filter(i => hasSeed(r, i));

test('semienka sú len na niektorých políčkach, počas hodiny ostávajú a potom sa premiestnia', () => {
  const r = room(at(13), 3);
  const a = spots(r);
  assert.ok(a.length > 0 && a.length < grass.length * 0.2, 'políčok so semienkom: ' + a.length + '/' + grass.length);
  r.tick += C.window - 1 - (r.tick % C.window); // koniec tej istej hodiny
  assert.deepStrictEqual(spots(r), a, 'v rámci hodiny sa nemenia');
  r.tick += 1; // ďalšia hodina
  const b = spots(r);
  assert.notDeepStrictEqual(b, a, 'v ďalšej hodine sú inde');
  for (const i of grass) assert.strictEqual(chance(r, i), hasSeed(r, i) ? C.find : 0);
});

test('prehľadané políčko je do konca hodiny prázdne, staré záznamy sa vyhodia', () => {
  const r = room(at(13), 3), i = must(spots(r)[0]);
  roll(r, i);
  assert.strictEqual(hasSeed(r, i), false);
  assert.strictEqual(roll(r, i), false, 'druhýkrát nič');
  r.tick += C.window;
  Scav.prune(r.scav, r.tick);
  assert.deepStrictEqual(r.scav, {});
});

test('tajné číslo sveta určuje, kde sú semienka: rovnaká soľ rovnaké miesta, rôzne svety inde', () => {
  const a = room(at(13), 11), b = room(at(13), 12);
  const sa = spots(a);
  assert.deepStrictEqual(spots(a), sa);
  assert.deepStrictEqual(spots(room(at(13), 11)), sa);
  assert.notDeepStrictEqual(spots(b), sa);
});

test('za deň poctivého hľadania z políčka na políčko (pokus každý krok od 6:00 do 21:00) nájdeš v priemere okolo 8–10 semienok', () => {
  let found = 0;
  const days = 300;
  for (let d = 0; d < days; d++) {
    const r = room(0, 1000 + d);
    for (let k = 0; k < 180; k++) {
      r.tick = at(6 + k * 15 / 180, 1 + (d % 4)); // od 6:00 do 21:00, jeden pokus za krok
      if (roll(r, must(grass[(d * 31 + k * 7) % grass.length]))) found++;
    }
  }
  const avg = found / days;
  assert.ok(avg > 6 && avg < 14, 'priemer za deň: ' + avg);
});

test('divé semienko: len sezónne, nemagické a nie prísne druhy', () => {
  for (const se of [0, 1, 2, 3] as const) {
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
  const r = room(0, 99), n = 4000, cnt: Partial<Record<string, number>> = {};
  const price = (sp: SpeciesId): number => sp === 'slnecnica' ? 100 : 20; // leto: slnečnica sa práve predáva za 5× viac
  for (let k = 0; k < n; k++) { const sp = Scav.pickWild(r.g, 1, price); cnt[sp] = (cnt[sp] || 0) + 1; }
  const others = Scav.wildCandidates(1).length - 1;
  const expected = 25 / (25 + others); // 100² : 20² = 25 : 1
  const sl = must(cnt['slnecnica']);
  assert.ok(Math.abs(sl / n - expected) < 0.03, `${sl / n} vs ${expected}`);
  for (const sp in cnt) assert.ok(has(Scav.wildCandidates(1), sp));
});

test('rovnaké semienko náhody → rovnaký druh (deterministické)', () => {
  const a = room(0, 5), b = room(0, 5), price = () => 30;
  for (let k = 0; k < 20; k++) assert.strictEqual(Scav.pickWild(a.g, 0, price), Scav.pickWild(b.g, 0, price));
});

test('klient nevidí druh divej rastliny, kým nevyklíči', () => {
  const t: Tile & { s: Soil } = { g: 'grass', s: { k: 'normal', w: 0, r: 0, o: 'jano', p: { sp: 'slnecnica', prog: 0, q: 3, dry: 0, wild: 1 } } };
  const v = Scav.tileView(t), vp = must(v.s?.p ?? undefined);
  assert.strictEqual(vp.sp, 'wild');
  assert.strictEqual(t.s.p?.sp, 'slnecnica', 'stav na serveri ostáva');
  assert.strictEqual(D.stageOf(vp), 0);
  const sprouted: Tile = { g: 'grass', s: { ...t.s, p: { sp: 'slnecnica', prog: 1, q: 3, dry: 0 } } };
  assert.strictEqual(Scav.tileView(sprouted), sprouted);
});

test('divé semienka sa nedajú predať a majú slovenský názov', () => {
  for (let se = 0; se < 4; se++) {
    assert.strictEqual(Econ.sellQuote(partial<Econ.MarketPart>({}), 0, 'wild_' + se), null);
    assert.match(D.itemName('wild_' + se), /^Divé semienko \((jar|leto|jeseň|zima)\)$/);
  }
});
