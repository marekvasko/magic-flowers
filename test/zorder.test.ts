// Priorita plôch v 3D pohľade (#160, src/shared/zorder.ts): plochy v jednej rovine (z-fighting) rozhodne druh plochy.
import test from 'node:test';
import assert from 'node:assert';
import * as Z from '../src/shared/zorder.ts';
import type { SurfaceKind } from '../src/shared/zorder.ts';

const KINDS: readonly SurfaceKind[] = ['ground', 'water', 'dock', 'prop'];

test('priorita plôch: zem < hladina < mólo < predmety; navrchu je vždy plocha s vyššou prioritou', () => {
  for (let i = 1; i < KINDS.length; i++) assert.ok(Z.SURFACE_PRIORITY[KINDS[i] ?? 'ground'] > Z.SURFACE_PRIORITY[KINDS[i - 1] ?? 'ground']);
  assert.strictEqual(Z.drawnOf('ground', 'dock'), 'dock', 'lávka móla nad pieskom brehu');
  assert.strictEqual(Z.drawnOf('dock', 'water'), 'dock', 'lávka nad hladinou');
  assert.strictEqual(Z.drawnOf('water', 'ground'), 'water');
  assert.strictEqual(Z.drawnOf('prop', 'dock'), 'prop', 'kolíky a laná nad mólom');
  for (const a of KINDS) for (const b of KINDS) assert.strictEqual(Z.drawnOf(a, b), Z.drawnOf(b, a), `poradie nezávisí od toho, čo sa kreslí prvé (${a}, ${b})`);
});

test('posun hĺbky: zem bez posunu, vyššia priorita = bližšie ku kamere, len pevné kroky (bez závislosti od sklonu)', () => {
  assert.deepStrictEqual(Z.depthBias('ground'), { factor: 0, units: 0 });
  for (let i = 1; i < KINDS.length; i++) {
    const a = Z.depthBias(KINDS[i - 1] ?? 'ground'), b = Z.depthBias(KINDS[i] ?? 'ground');
    assert.ok(b.units < a.units, 'vyššia priorita – zápornejší posun (bližšie)');
    assert.strictEqual(b.factor, 0, 'bez factor: hladina sa pri šikmom pohľade nevytiahne nad tesne vyššie plochy (lekná na plese v horách, 0,01 nad ňou)');
  }
  assert.ok(Math.abs(Z.depthBias('prop').units) <= 32, 'posun je len pár krokov hĺbky – skutočne rozdielne hĺbky nemení');
});

test('jemné modely: mólo a kolíky okraja majú svoju prioritu, ostatné modely sa kreslia ako doteraz', () => {
  assert.strictEqual(Z.fineSurface('dock'), 'dock');
  assert.strictEqual(Z.fineSurface('edge'), 'prop');
  for (const t of ['house', 'tree', 'rock', 'icehouse', 'dielna', 'toString', 'constructor']) assert.strictEqual(Z.fineSurface(t), null, t);
});
