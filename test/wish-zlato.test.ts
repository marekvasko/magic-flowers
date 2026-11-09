// Prianie „zlatý dážď“ (#100): celú sumu dostane ten, kto si prial, ostatní pripojení menší podiel, odpojení nič.
import test from 'node:test';
import assert from 'node:assert';
import * as E from '../src/server/engine.ts';
import * as Actions from '../src/server/actions.ts';
import { act, give, makeWorld, newPlayer, save, SPEC, textOf } from './game-world.ts';

test('prianie zlatý dážď: 400 🪙 tomu, kto si prial, ostatným pripojeným po 100 🪙, odpojeným nič (#100)', () => {
  const w = makeWorld(36);
  w.saves['cyril'] = newPlayer(); // uložený, ale nepripojený
  give(save(w, 'bob'), 'fl_papradie', 1, w.tick);
  const r = E.commitBatch(w, [act('wish', 'bob', { kind: 'zlato' })], SPEC);
  assert.deepStrictEqual([save(w, 'bob').coins, save(w, 'ana').coins, save(w, 'cyril').coins], [500 + Actions.WISH_GOLD.me, 500 + Actions.WISH_GOLD.others, 500]);
  assert.ok(r.outbox.some(m => m.to === E.ALL && /Bob dostáva 400 🪙 a každý ďalší hráč 100 🪙/.test(textOf(m))));
  // sám v hre: celú sumu, bez zmienky o ostatných
  const y = makeWorld(37); y.presence = y.presence?.slice(0, 1);
  give(save(y, 'ana'), 'fl_papradie', 1, y.tick);
  const r2 = E.commitBatch(y, [act('wish', 'ana', { kind: 'zlato' })], SPEC);
  assert.deepStrictEqual([save(y, 'ana').coins, save(y, 'bob').coins], [900, 500]);
  assert.ok(r2.outbox.some(m => /Ana si prial\(a\) zlatý dážď a dostáva 400 🪙\./.test(textOf(m))));
});
