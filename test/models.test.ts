import test from 'node:test';
import assert from 'node:assert';
import * as W from '../src/shared/world3d.ts';
import { must } from './helpers.ts';

// Zoznam jemných modelov pre prehliadač v /debug (#79): každý sa postaví v každom období a otočení
const voxels = (m: W.FineModel): number => m.data.reduce((n, v) => n + (v ? 1 : 0), 0);

test('každý model zo zoznamu sa postaví v každom období a otočení', () => {
  const ids = new Set<string>();
  for (const e of W.FINE_MODELS) {
    assert.ok(e.id && e.name && e.group && e.fn && typeof e.build === 'function', e.id);
    assert.ok(!ids.has(e.id), 'duplicitné id ' + e.id);
    ids.add(e.id);
    for (let se = 0; se < 4; se++) {
      const base = e.build(se, 0);
      const n = voxels(base);
      assert.ok(n > 0, `${e.id} obdobie ${se}`);
      // pôdorys sedí s počtom polí (+ okraj FM na každej strane)
      assert.strictEqual(base.sx, e.tiles[0] * W.FINE + 2 * W.FM, e.id);
      assert.strictEqual(base.sz, e.tiles[1] * W.FINE + 2 * W.FM, e.id);
      for (let rot = 0; rot < 4; rot++) {
        const m = e.build(se, rot);
        assert.strictEqual(m.data.length, m.sx * m.sy * m.sz, `${e.id} ${se} ${rot}`);
        assert.strictEqual(voxels(m), n, `${e.id} ${se} ${rot}: otočenie nemení počet minikociek`);
        assert.deepStrictEqual([m.sx, m.sz], rot % 2 ? [base.sz, base.sx] : [base.sx, base.sz]);
      }
    }
  }
  // všetky budovy, stromy, kry a kamene
  for (const id of ['house', 'hut', 'icehouse', 'stall', 'well', 'cauldron', 'bush', 'bush-berries']) assert.ok(ids.has(id), id);
  for (const k of W.TREE_KINDS) assert.ok(ids.has('tree-' + k), k);
  assert.strictEqual(W.FINE_MODELS.filter(e => e.group === 'Rocks').length, 3);
});

test('rotateY na štvorci = otočenie stromov v hre, štyrikrát = pôvodný model', () => {
  const t0 = W.treeModel('buk', 1, 0), t1 = W.treeModel('buk', 1, 1);
  assert.deepStrictEqual(W.rotateY(t0).data, t1.data);
  const h = must(W.FINE_MODELS.find(e => e.id === 'house')).build(3, 0);
  let r = h;
  for (let i = 0; i < 4; i++) r = W.rotateY(r);
  assert.deepStrictEqual([r.sx, r.sy, r.sz], [h.sx, h.sy, h.sz]);
  assert.deepStrictEqual(r.data, h.data);
});
