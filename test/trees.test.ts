import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import * as W from '../src/shared/world3d.ts';
import { entries } from '../src/shared/util.ts';
import { must } from './helpers.ts';

// Odtlačky modelov stromov (druh: [jar×4 otočenia, leto×4, jeseň×4, zima×4]); od #182 so skosenými hranami
// (bunky dielikov sú v dátach tiež). Predvolené parametre musia dať presne tie isté minikocky – stromy v hre sa
// nesmú zmeniť nechtiac.
const BEFORE: Readonly<Record<W.TreeKind, readonly string[]>> = {
  buk: ['ee1964f5df3c', '8e1a97b54870', '1be80268cfba', '95b6714f8451', '33553d8e685e', '028d834225e3', '6a5d86ffe196', 'bd478bc14b9c', '32011dc08448', '6629dc2ae55f', '9ad41c93d00f', '903cf25f8649', 'f2d7cb46ec27', '24b913d60cdc', '328c613ecc7a', '26630f84fef0'],
  dub: ['1651b2529295', '7a6f83a13b56', '34d4ef8a1f47', '0a3fdb38e585', '62e0e0eb8eba', '3f05609c1776', '55c2d8eca651', '3cf3bcafb8df', '20c14c6a810c', 'd1d2b1294409', '114e69170481', '380fddf799d7', 'dbee35869e29', '409233bc59db', 'ca40ec3f4b21', '0c8e6d43dc89'],
  breza: ['bdbe9826aeda', '2916cf02894e', 'a04eadcfad1f', '320b738bcd15', '831d9d1385e7', 'f15b187d8463', '6ba8c81eb50a', '1fab604ce648', '71520ac5a62c', '502147e8dd8e', '58f07c439997', 'b2391d237f13', '5a556f114eb9', '1dbab624b199', '5df781404c82', '1e55fbf89c1e'],
  jablon: ['a7a70b814674', 'ab674543e51a', '1ca8bcd9b3bb', 'c38aa107decb', 'cea4eb0b2576', '8c74ced3cdf1', '8d88a473cae9', '06668d860a46', 'ca7b4f333196', '6ebc6bb46a4e', '813acbe0856c', 'e8956daef4bf', '31df315e15e8', '66c606cf16ff', '02d60d93da6b', 'a157ee8a3cb7'],
  smrek: ['48c6c7fd3c74', '84dbfd24b47d', '9227431d88b6', '4394192caf40', '48c6c7fd3c74', '84dbfd24b47d', '9227431d88b6', '4394192caf40', '48c6c7fd3c74', '84dbfd24b47d', '9227431d88b6', '4394192caf40', '3d58053d2f0a', '4ca8b26740ff', 'dd47cf6057a4', '6ad73b6371fc'],
  borovica: ['643adac91318', '4020aad9fe10', '699cbdda5b4f', 'bf8a5d70a4dd', '643adac91318', '4020aad9fe10', '699cbdda5b4f', 'bf8a5d70a4dd', '643adac91318', '4020aad9fe10', '699cbdda5b4f', 'bf8a5d70a4dd', 'f0eef8822eba', 'd5714ce90436', 'ae0915ef5e93', '2d5cb282b548']
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
