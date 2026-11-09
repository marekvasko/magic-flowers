// Výkup čarovných semienok (#100): nie sú na trhu, ich cena sa nenasycuje – preto len symbolických 10 🪙.
import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import * as E from '../src/server/engine.ts';
import * as Econ from '../src/server/economy.ts';
import { act, give, makeWorld, save, SPEC } from './game-world.ts';

test('výkup čarovných semienok: symbolických 10 🪙 za kus, rovnako na serveri aj v predaji (#100)', () => {
  const w = makeWorld(38), sv = save(w, 'ana');
  for (const id of ['seed_papradie', 'seed_duhova'] as const) {
    assert.strictEqual(D.sellPrice(id), D.MAGIC_SEED_SELL);
    assert.strictEqual(Econ.sellQuote(w.market, w.tick, id), D.MAGIC_SEED_SELL);
    give(sv, id, 3, w.tick);
  }
  E.commitBatch(w, [act('sell', 'ana', { id: 'seed_papradie', n: 3 }), act('sell', 'ana', { id: 'seed_duhova', n: 3 })], SPEC);
  assert.strictEqual(sv.coins, 500 + 6 * D.MAGIC_SEED_SELL);
});
