// 3D tráva (#196): poradie trsov spredu dozadu – z-buffer vďaka nemu zahodí zakryté trsy skôr, než sa vyfarbia
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontToBack } from '../src/shared/world3d.ts';

// koreň trsu = x, y, z a štvrté číslo (odtieň), ktoré poradie neovplyvní
const roots = [0, 0, 0, 7, /**/ 3, 0, 0, 7, /**/ 1, 0, 2, 7, /**/ 1, 5, 0, 7];

test('frontToBack: trs bližšie ku kamere (menší priemet do smeru pohľadu) ide skôr', () => {
  assert.deepEqual([...frontToBack(roots, { x: 1, y: 0, z: 0 })], [0, 2, 3, 1]);
  assert.deepEqual([...frontToBack(roots, { x: 0, y: 0, z: -1 })], [2, 0, 1, 3]);
  assert.deepEqual([...frontToBack(roots, { x: 0, y: -1, z: 0 })], [3, 0, 1, 2]);
});

test('frontToBack: opačný pohľad dá opačné poradie (až na rovnako vzdialené trsy, tie ostanú podľa čísla)', () => {
  const dir = { x: -0.5, y: -0.6, z: -0.6 };
  const a = [...frontToBack(roots, dir)], b = [...frontToBack(roots, { x: -dir.x, y: -dir.y, z: -dir.z })];
  assert.deepEqual(a, b.reverse());
});

test('frontToBack: každý trs práve raz, prázdne pole nič', () => {
  assert.deepEqual([...frontToBack(roots, { x: 0.3, y: -0.5, z: 0.8 })].sort(), [0, 1, 2, 3]);
  assert.equal(frontToBack([], { x: 1, y: 0, z: 0 }).length, 0);
});
