import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import * as RM from '../src/shared/robotmodel.ts';
import type { RobotLook } from '../src/shared/robotmodel.ts';
import type { ToolId } from '../src/shared/data.ts';
import { buildRobot } from '../src/client/robot3d.ts';
import { robotBackend } from '../src/client/robotbatch.ts';
import type { BatchMaterials } from '../src/client/robotbatch.ts';

// Robot v hre (#194): zlúčené siete (robotbatch.ts) – bez kreslenia, len geometria a matice kĺbov
const LOOKS: [string, RobotLook][] = [
  ...RM.PRESET_IDS.map((p): [string, RobotLook] => [p, RM.PRESETS[p].look]),
  ...Array.from({ length: 12 }, (_, i): [string, RobotLook] => ['seed ' + i, RM.randomLook(i * 5 + 1)])
];
const TOOLS: readonly ToolId[] = ['hoe', 'can', 'pick', 'lamp'];
function mats(): BatchMaterials {
  return { skin: new THREE.MeshBasicMaterial(), skinGlass: new THREE.MeshBasicMaterial(), rigid: new THREE.MeshBasicMaterial(), jointTex: { value: null }, layers: o => { o.layers.set(1); o.layers.enable(2); } };
}
// siete pod objektom: objekt, materiál, počet trojuholníkov a atribúty geometrie
interface Attr { count: number; getX: (k: number) => number }
interface M { o: THREE.Object3D; material: unknown; tris: number; attr: Map<string, Attr> }
function meshes(o: THREE.Object3D): M[] {
  const out: M[] = [];
  o.traverse(c => {
    const g: unknown = c instanceof THREE.Mesh ? c.geometry : null, material: unknown = c instanceof THREE.Mesh ? c.material : null;
    if (!(g instanceof THREE.BufferGeometry)) return;
    const attr = new Map<string, Attr>();
    for (const n of ['position', 'normal', 'color', 'emis', 'alpha', 'rust', 'joint']) { const a: unknown = g.hasAttribute(n) ? g.getAttribute(n) : null; if (!(a instanceof THREE.BufferAttribute)) continue; const arr: unknown = a.array, size = a.itemSize; if (arr instanceof Float32Array) attr.set(n, { count: a.count, getX: k => arr[k * size] ?? NaN }); }
    out.push({ o: c, material, tris: (g.index ? g.index.count : attr.get('position')?.count ?? 0) / 3, attr });
  });
  return out;
}
const at = (m: M, n: string): Attr => { const a = m.attr.get(n); assert.ok(a, 'chýba atribút ' + n); return a; };

test('zlúčený robot: telo je jedna sieť (+ sklo), má tie isté trojuholníky ako robot z dielov a platné čísla kĺbov', () => {
  for (const [name, look] of LOOKS) {
    const m = mats(), plain = buildRobot(look), batch = buildRobot(look, robotBackend(m));
    const pm = meshes(plain.group).filter(x => x.o.name !== 'water'), bm = meshes(batch.group).filter(x => x.o.name !== 'water');
    assert.ok(bm.length <= 2, `${name}: telo má ${bm.length} sietí`);
    assert.ok(pm.length > 40, name);
    const sum = (ms: M[]): number => ms.reduce((n, x) => n + x.tris, 0);
    assert.strictEqual(sum(bm), sum(pm), name + ': počet trojuholníkov');
    const tex = m.jointTex.value;
    assert.ok(tex instanceof THREE.DataTexture, name);
    const rows = tex.image.height;
    for (const x of bm) {
      const joint = at(x, 'joint'), n = at(x, 'position').count;
      for (const a of ['normal', 'color', 'emis', 'alpha', 'rust', 'joint']) assert.strictEqual(at(x, a).count, n, `${name}: atribút ${a}`);
      for (let k = 0; k < joint.count; k++) { const j = joint.getX(k); assert.ok(Number.isInteger(j) && j >= 0 && j < rows, `${name}: kĺb ${j} z ${rows}`); }
      assert.ok(x.o.layers.isEnabled(1) && x.o.layers.isEnabled(2) && !x.o.layers.isEnabled(0), name + ': vrstvy');
    }
    // sklo je zvlášť (priehľadné), ostatné nepriehľadné
    const glass = bm.find(x => x.material === m.skinGlass);
    if (glass) { const a = at(glass, 'alpha'); for (let k = 0; k < a.count; k++) assert.ok(a.getX(k) < 1); }
    plain.dispose(); batch.dispose();
  }
});

test('zlúčený robot: póza prepíše matice kĺbov v textúre (vo svete, s polohou a mierkou robota)', () => {
  const m = mats(), r = buildRobot(RM.PRESETS.plechacik.look, robotBackend(m));
  r.group.position.set(5, 1, 7); r.group.scale.setScalar(1.5); r.group.rotation.y = 0.7;
  r.pose({});
  const tex = m.jointTex.value;
  assert.ok(tex instanceof THREE.DataTexture);
  const data: unknown = tex.image.data;
  assert.ok(data instanceof Float32Array);
  const rowOf = (k: number): number[] => Array.from(data.subarray(k * 16, k * 16 + 16));
  const body = r.group.getObjectByName('body'), hand = r.group.getObjectByName('handR');
  assert.ok(body && hand);
  const near = (a: number[], b: number[]): boolean => a.every((v, i) => Math.abs(v - (b[i] ?? NaN)) < 1e-5);
  const rows = Array.from({ length: tex.image.height }, (_, k) => rowOf(k));
  assert.ok(rows.some(x => near(x, body.matrixWorld.toArray())), 'matica trupu');
  assert.ok(rows.some(x => near(x, hand.matrixWorld.toArray())), 'matica ruky');
  const before = rows.find(x => near(x, hand.matrixWorld.toArray()));
  r.pose({ dance: true, t: 0.3 });
  assert.ok(!near(rowOf(rows.indexOf(before ?? [])), before ?? []), 'po zmene pózy sa matica ruky zmenila');
  r.dispose();
});

test('zlúčený robot: každé náradie je jedna sieť a výmena náradia (hod a výstrel) prebehne aj v hre', () => {
  const m = mats(), r = buildRobot(RM.PRESETS.hrdzavec.look, robotBackend(m));
  r.setTools('hoe', TOOLS);
  for (const t of TOOLS) {
    const o = r.group.getObjectByName('tool:' + t);
    assert.ok(o, t);
    assert.strictEqual(meshes(o).length, 1, t + ': náradie má byť jedna sieť');
  }
  assert.ok(r.group.getObjectByName('tool:lamp')?.getObjectByName('flame'), 'lampáš má bod plameňa');
  r.pose({});
  for (const to of ['can', 'lamp', null, 'pick'] as const) {
    r.switchTool(to);
    for (let k = 0; r.switching() && k < 600; k++) r.pose({}, 1 / 60);
    assert.ok(!r.switching(), `výmena na ${to} neskončila`);
    for (const t of TOOLS) {
      let p: THREE.Object3D | null = r.group.getObjectByName('tool:' + t) ?? null, where = '';
      while (p) { if (p.name === 'handR') where = 'hand'; if (p.name === 'rack') where = 'rack'; p = p.parent; }
      assert.strictEqual(where, t === to ? 'hand' : 'rack', `${to}: ${t}`);
    }
  }
  r.dispose();
});
