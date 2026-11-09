// Výkup semienok prísnych druhov (#100): plesnivec najviac zo základnej ceny – pri prázdnej zásobe by vzácnosť ×3
// semienko z pokladu vykúpila za 77–130 🪙; ostatné druhy sa vykupujú ako doteraz.
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import { must } from './helpers.ts';
import { act, give, makeWorld, save, setStock, SPEC, TPD } from './game-world.ts';

const SP = must(Econ.PLANTABLE.find(k => !D.SPECIES[k].strict));
const nn = <T,>(v: T | null | undefined): T => must(v ?? undefined);

test('výkup prísnych semienok (plesnivec): najviac 40 % zo základnej ceny aj pri prázdnej zásobe, ostatné druhy bez zmeny (#100)', () => {
  for (const se of [0, 1, 2, 3]) {
    const w = makeWorld(39, D.DAWN_TICK + 6 + se * D.DAYS_PER_SEASON * TPD);
    setStock(w, 'seed_plesnivec', 0);
    assert.ok(Econ.seedPrice(w.market, w.tick, 'plesnivec') > D.SPECIES.plesnivec.seed, 'nákupná cena ostáva vysoká');
    assert.strictEqual(Econ.sellQuote(w.market, w.tick, 'seed_plesnivec'), Math.round(D.SPECIES.plesnivec.seed * Econ.PRICING.seedSellBack));
    setStock(w, `seed_${SP}`, 0);
    assert.strictEqual(Econ.sellQuote(w.market, w.tick, `seed_${SP}`), Math.round(Econ.seedPrice(w.market, w.tick, SP) * Econ.PRICING.seedSellBack), 'obyčajný druh: vzácnosť platí aj pri výkupe');
  }
  // plná zásoba: výkup klesne pod strop ako pri iných semienkach
  const w = makeWorld(40); setStock(w, 'seed_plesnivec', Econ.SEED_CAP);
  assert.ok(nn(Econ.sellQuote(w.market, w.tick, 'seed_plesnivec')) < Math.round(D.SPECIES.plesnivec.seed * Econ.PRICING.seedSellBack));
  const sv = save(w, 'ana'); setStock(w, 'seed_plesnivec', 0); give(sv, 'seed_plesnivec', 3, w.tick);
  E.commitBatch(w, [act('sell', 'ana', { id: 'seed_plesnivec', n: 3 })], SPEC);
  assert.ok(sv.coins - 500 <= 3 * 32, 'tri semienka najviac za 3 × 32 🪙: ' + String(sv.coins - 500));
});
