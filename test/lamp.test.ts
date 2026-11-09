import test from 'node:test';
import assert from 'node:assert';
import * as D from '../src/shared/data.ts';
import type { PlayerSave } from '../src/shared/save.ts';
import * as Ice from '../src/server/ice.ts';
import * as Econ from '../src/server/economy.ts';
import { partial } from './helpers.ts';

test('lampáš je náradie z trhu s menom a cenou', () => {
  const T = D.TOOLS.lamp;
  assert.ok(T.price > 0 && T.rep === 0);
  assert.strictEqual(T.name, 'Lampáš');
  assert.strictEqual(D.itemName('lamp'), 'Lampáš');
  assert.ok(D.isTool('lamp'));
});

test('lampáš sa kupuje raz, s dostatkom mincí', () => {
  const sv = partial<PlayerSave>({ coins: D.TOOLS.lamp.price - 1, rep: 0, inv: {} });
  assert.ok(Ice.buyTool(sv, 'lamp'), 'bez mincí nie');
  sv.coins = 200;
  assert.strictEqual(Ice.buyTool(sv, 'lamp'), null);
  assert.strictEqual(sv.coins, 200 - D.TOOLS.lamp.price);
  assert.strictEqual(sv.inv.lamp, 1);
  assert.ok(Ice.buyTool(sv, 'lamp'), 'druhý lampáš nie');
});

test('trh lampáš nevykupuje', () => {
  const room = { market: partial<Econ.MarketPart>({ compost: { stock: 50 } }), tick: 0 };
  const sv = partial<PlayerSave>({ coins: 0, rep: 0, inv: { lamp: 1 } });
  const r = Econ.sellFixed(room.market, room.tick, sv, 'lamp', 1);
  assert.strictEqual(r.n, 0);
  assert.strictEqual(sv.inv.lamp, 1);
});
