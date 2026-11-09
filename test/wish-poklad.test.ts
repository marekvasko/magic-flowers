// Prianie „poklad víl“ (#100): už nedáva papraďové semienko, aby sa papraď z pokladu nemnožila sama.
import test from 'node:test';
import assert from 'node:assert';
import * as E from '../src/server/engine.ts';
import { act, give, makeWorld, save, SPEC } from './game-world.ts';

test('prianie poklad: dúhové semienka a plesnivce, ale už nie papraďové semienko (#100)', () => {
  const w = makeWorld(35), sv = save(w, 'ana');
  give(sv, 'fl_papradie', 1, w.tick);
  const r = E.commitBatch(w, [act('wish', 'ana', { kind: 'poklad' })], SPEC);
  assert.strictEqual(r.applied.length, 1);
  assert.deepStrictEqual([sv.inv.fl_papradie || 0, sv.inv.seed_duhova, sv.inv.seed_plesnivec, sv.inv.seed_papradie || 0], [0, 3, 3, 0]);
});
