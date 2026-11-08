// Rozklad cien (#76): *PriceParts musia dať presne rovnaké ceny ako pôvodné vzorce.
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { SpeciesId } from '../src/shared/data.ts';
import type { ActiveFestival } from '../src/shared/save.ts';
import * as Econ from '../src/server/economy.ts';
import { must, partial } from './helpers.ts';
const TPD = D.TICKS_PER_DAY, DPS = D.DAYS_PER_SEASON;
type Room = { tick: number; market: Econ.MarketPart };

// ---- pôvodné vzorce (skopírované pred refaktorom, nemeniť) ----
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const season = (room: Room): number => D.seasonOf(D.dayOfTick(room.tick));
const has = (list: readonly number[], v: number): boolean => list.includes(v);
function oldPhase(sp: SpeciesId, se: number): string {
  const s = D.SPECIES[sp].seasons;
  if (has(s, se)) return 'now';
  if (has(s, (se + 1) % 4)) return 'next';
  return 'off';
}
function oldSeedPrice(room: Room, sp: SpeciesId): number {
  const st = must(room.market.seeds[sp]).stock;
  const ph = oldPhase(sp, season(room));
  const demand = ph === 'now' ? 1.35 : ph === 'next' ? 1.0 : 0.8;
  const scarcity = clamp(Math.sqrt(10 / Math.max(1, st)), 0.75, 3);
  return Math.max(2, Math.round(D.SPECIES[sp].seed * demand * scarcity));
}
function oldCompostPrice(room: Room): number {
  return Math.max(5, Math.round(15 * clamp(Math.sqrt(15 / Math.max(1, must(room.market.compost ?? undefined).stock)), 0.7, 3)));
}
function oldFlowerPrice(room: Room, sp: SpeciesId): number {
  const s = D.SPECIES[sp], st = must(room.market.flowers[sp]).stock;
  const rare = has(s.seasons, season(room)) ? 1 : 1.6;
  const fest = (room.market.festival && room.market.festival.mult[sp]) || 1;
  const sat = Math.max(0.35, 1.3 - 0.06 * st);
  return Math.max(1, Math.round(s.sell * rare * fest * sat));
}
function oldSellQuote(room: Room, id: string): number | null {
  const sp = D.speciesOfItem(id);
  if (id.startsWith('fl_')) return oldFlowerPrice(room, must(sp ?? undefined));
  if (id.startsWith('seed_')) return Math.max(1, Math.round(oldSeedPrice(room, must(sp ?? undefined)) * 0.4));
  if (id === 'compost') return Math.max(1, Math.round(oldCompostPrice(room) * 0.5));
  return null;
}

test('rozklad cien: rovnaké ceny ako pôvodné vzorce (každý druh × obdobie × zásoba × sviatok)', () => {
  const stocks: number[] = [];
  for (let s = 0; s <= 45; s++) stocks.push(s);
  stocks.push(60, 80, 99, 150);
  const fests: (ActiveFestival | null)[] = [null, ...D.FESTIVALS.map(f => ({ id: f.id, name: f.name, icon: f.icon, mult: f.mult, until: 0 }))];
  let n = 0;
  for (let se = 0; se < 4; se++) for (const dis of [1, DPS]) {
    const tick = ((se * DPS + dis - 1) * TPD) + D.DAWN_TICK;
    for (const festival of fests) for (const st of stocks) {
      const room: Room = { tick, market: { seeds: {}, flowers: {}, compost: { stock: st }, festival } };
      for (const sp of Econ.PLANTABLE) { room.market.seeds[sp] = { stock: st }; room.market.flowers[sp] = { stock: st }; }
      Econ.syncFestival(room.market); // násobky sviatku sú v položkách kvetov
      for (const sp of Econ.PLANTABLE) {
        const sp1 = Econ.seedPriceParts(room.market, room.tick, sp), fp = Econ.flowerPriceParts(room.market, room.tick, sp);
        assert.strictEqual(sp1.price, oldSeedPrice(room, sp), `semienko ${sp} obdobie ${se} zásoba ${st}`);
        assert.strictEqual(Econ.seedPrice(room.market, room.tick, sp), sp1.price);
        assert.strictEqual(fp.price, oldFlowerPrice(room, sp), `kvet ${sp} obdobie ${se} zásoba ${st} sviatok ${festival && festival.id}`);
        assert.strictEqual(Econ.flowerPrice(room.market, room.tick, sp), fp.price);
        assert.strictEqual(sp1.phase, oldPhase(sp, se));
        for (const id of [`seed_${sp}`, `fl_${sp}`]) assert.strictEqual(Econ.sellQuote(room.market, room.tick, id), oldSellQuote(room, id), id);
        n++;
      }
      assert.strictEqual(Econ.compostPriceParts(room.market).price, oldCompostPrice(room));
      assert.strictEqual(Econ.compostPrice(room.market), oldCompostPrice(room));
      assert.strictEqual(Econ.sellQuote(room.market, room.tick, 'compost'), oldSellQuote(room, 'compost'));
    }
  }
  assert.ok(n > 10000, 'prešlo ' + n + ' kombinácií');
});

test('rozklad cien: činitele dávajú dokopy cenu a nič nemenia', () => {
  const room: Room = { tick: D.DAWN_TICK, market: { seeds: {}, flowers: {}, compost: { stock: 2 }, festival: partial<ActiveFestival>({ id: 'matky', mult: must(D.FESTIVALS[0]).mult }) } };
  for (const sp of Econ.PLANTABLE) { room.market.seeds[sp] = { stock: 3 }; room.market.flowers[sp] = { stock: 30 }; }
  Econ.syncFestival(room.market);
  const before = JSON.stringify(room);
  const s = Econ.seedPriceParts(room.market, room.tick, 'tulipan');
  assert.strictEqual(s.raw, s.base * s.demand * s.scarcity);
  assert.strictEqual(s.price, Math.max(s.min, Math.round(s.raw)));
  const f = Econ.flowerPriceParts(room.market, room.tick, 'tulipan');
  assert.strictEqual(f.fest, 2.2);
  assert.strictEqual(f.festival, 'matky');
  assert.strictEqual(f.sat, 0.35, 'plný trh: najnižšie nasýtenie');
  assert.ok(f.satRaw < f.sat);
  assert.strictEqual(f.raw, f.base * f.rare * f.fest * f.sat);
  const c = Econ.compostPriceParts(room.market);
  assert.strictEqual(c.raw, c.base * c.scarcity);
  assert.strictEqual(JSON.stringify(room), before);
});
