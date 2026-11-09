import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import * as W from '../src/shared/world3d.ts';
import { entries } from '../src/shared/util.ts';
import { must } from './helpers.ts';

// Odtlačky modelov stromov pred zavedením parametrov (druh: [jar×4 otočenia, leto×4, jeseň×4, zima×4]).
// Predvolené parametre musia dať presne tie isté minikocky – stromy v hre sa nesmú zmeniť.
const BEFORE: Readonly<Record<W.TreeKind, readonly string[]>> = {
  buk: ['0082f877955c', '8b3c75a33087', '8373228c72f5', 'd6cab361f283', '0d1c0223d5d2', '358e7268e590', 'ee3b437235b9', '7fc997aa5049', '86a915354180', '1b1e26d56c78', 'f1f2e8d0625e', '8f9adcaf871f', '3216f3fa071c', 'e07d7f4b74c1', '2fc525a3986a', '8104b9a5b243'],
  dub: ['6ff6cd578971', '13b5d017a8d6', 'ce5f41ca433c', '7dce96b38134', 'ac49ee50300b', '90c8fbee0d78', '46ff9e019f16', 'd8f6e931cdfc', '657e8fb7ad69', '0f75cdce97ba', '471a1ac317d3', '1732d05d21f0', 'fe966553913c', '8825319ae72c', 'f21291b2b479', 'd74032401618'],
  breza: ['b58ceae307e5', '32e58eda8009', '046ac3c3964f', '428bcdc203dc', '6e2186ed0cb9', '5fd000f85e8d', '02454aa75c9e', 'f48519b7a707', 'fd304b0e565f', '9b5624a9dc57', '461791870862', 'f5f4b2cd6b05', '97b74bd24dbf', '04984bffdd39', '8f3f4e557cde', '9062eed0c845'],
  jablon: ['411ae98d4a23', 'f967a981f2a3', '2ba8fe4be280', '5e6bffecf2e8', '962ce9b93caa', 'ffbc6844f0a8', 'd2f7096c289d', '346491a16da1', 'a2e22c58b066', 'fc68060ed160', '770b14087fa4', 'a813754ef8cc', '3f8a106bde44', '94af20de6d42', '234ed18f5cfa', '931bdeadc654'],
  smrek: ['39e04a9c7bc6', '5d210b07e05a', 'a4d7052fcf71', 'fd1f6fbb6faa', '39e04a9c7bc6', '5d210b07e05a', 'a4d7052fcf71', 'fd1f6fbb6faa', '39e04a9c7bc6', '5d210b07e05a', 'a4d7052fcf71', 'fd1f6fbb6faa', '6f985ac42e6f', 'b0357c97d5cb', 'bad330f9be25', '3932facfcb27'],
  borovica: ['0e2e66ae19c5', 'aa6ee5a4fd77', 'ee78a4b8002c', '2748c215e502', '0e2e66ae19c5', 'aa6ee5a4fd77', 'ee78a4b8002c', '2748c215e502', '0e2e66ae19c5', 'aa6ee5a4fd77', 'ee78a4b8002c', '2748c215e502', '40ed8a4513b9', 'ac659c8eddaf', 'ef4305ee0e05', '0697e61d1e88']
};
const print = (m: W.FineModel): string => crypto.createHash('sha1').update(Buffer.from([m.sx, m.sy, m.sz])).update(m.data).digest('hex').slice(0, 12);
const voxels = (m: W.FineModel): number => m.data.reduce((n, v) => n + (v ? 1 : 0), 0);

test('stromy s predvolenými parametrami sú presne také ako predtým', () => {
  assert.deepStrictEqual(Object.keys(BEFORE), W.TREE_KINDS);
  for (const kind of W.TREE_KINDS) for (let se = 0; se < 4; se++) for (let rot = 0; rot < 4; rot++) {
    assert.strictEqual(print(W.treeModel(kind, se, rot)), must(BEFORE[kind][se * 4 + rot]), `${kind}, obdobie ${se}, otočenie ${rot}`);
    // prázdne prepísanie = predvolené parametre (bez cache)
    if (rot === 1) assert.strictEqual(print(W.treeModel(kind, se, rot, {})), must(BEFORE[kind][se * 4 + rot]));
  }
});

test('každý parameter má predvolenú hodnotu v rozsahu', () => {
  for (const kind of W.TREE_KINDS) for (const [k, d] of entries<string, { def: number; min: number; max: number; step: number }>(W.TREE_PARAMS[kind])) {
    assert.ok(d.min <= d.def && d.def <= d.max && d.step > 0, `${kind}.${k}`);
    assert.strictEqual(entries<string, number>(W.treeParams(kind)).find(([n]) => n === k)?.[1], d.def);
  }
});

test('parametre menia strom a orezávajú sa na rozsah', () => {
  assert.ok(voxels(W.treeModel('buk', 1, 0, { crownR: 8 })) > voxels(W.treeModel('buk', 1, 0)));
  assert.notStrictEqual(print(W.treeModel('smrek', 1, 0, { seed: 7 })), print(W.treeModel('smrek', 1, 0)));
  assert.ok(voxels(W.treeModel('jablon', 0, 0, { trunkH: 3, branches: 0, crownR: 1, crownH: 1 })) < voxels(W.treeModel('jablon', 0, 0)));
  const p = W.treeParams('dub', { trunkH: 999, branches: 2.6, crownR: -5, holes: 'x' });
  assert.strictEqual(p.trunkH, W.TREE_PARAMS.dub.trunkH.max);
  assert.strictEqual(p.branches, 3);
  assert.strictEqual(p.crownR, W.TREE_PARAMS.dub.crownR.min);
  assert.strictEqual(p.holes, W.TREE_PARAMS.dub.holes.def);
  // vlastný model neprepíše ten z hry (cache)
  assert.strictEqual(print(W.treeModel('buk', 1, 0)), must(BEFORE.buk[4]));
});
