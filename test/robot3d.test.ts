import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import * as RM from '../src/shared/robotmodel.ts';
import type { RobotLook } from '../src/shared/robotmodel.ts';
import type { ToolId } from '../src/shared/data.ts';
import { buildRobot } from '../src/client/robot3d.ts';
import type { Robot3D } from '../src/client/robot3d.ts';

// Sieť robota (Three.js beží aj v Node – len geometria, bez kreslenia): predvoľby + vygenerované roboty
const LOOKS: [string, RobotLook][] = [
  ...RM.PRESET_IDS.map((p): [string, RobotLook] => [p, RM.PRESETS[p].look]),
  ...Array.from({ length: 120 }, (_, i): [string, RobotLook] => ['seed ' + i, RM.randomLook(i)])
];
const TOOLS: readonly ToolId[] = ['hoe', 'can', 'pick', 'lamp'];

function triangles(o: THREE.Object3D): number {
  let n = 0;
  o.traverse(c => { const g: unknown = c instanceof THREE.Mesh ? c.geometry : null; if (g instanceof THREE.BufferGeometry) { const pos: unknown = g.getAttribute('position'); n += (g.index ? g.index.count : pos instanceof THREE.BufferAttribute ? pos.count : 0) / 3; } });
  return n;
}
// presné obálky (z vrcholov) všetkých sietí pod objektom, každá zvlášť
function boxes(o: THREE.Object3D, direct = false): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  const add = (c: THREE.Object3D): void => { if (c instanceof THREE.Mesh) out.push(new THREE.Box3().setFromObject(c, true).expandByScalar(-0.002)); };
  if (direct) o.children.forEach(add); else o.traverse(add);
  return out;
}
const hits = (a: THREE.Box3[], b: THREE.Box3[]): boolean => a.some(x => b.some(y => x.intersectsBox(y)));
function onRack(look: RobotLook): Robot3D {
  const r = buildRobot(look);
  r.setTools(null, TOOLS);
  r.pose({});
  r.group.updateMatrixWorld(true);
  return r;
}

test('málo polygónov: robot aj so všetkým náradím má najviac 8000 trojuholníkov', () => {
  for (const [name, look] of LOOKS) {
    const r = onRack(look), n = triangles(r.group);
    assert.ok(n <= 8000, `${name}: ${n} trojuholníkov`);
    r.dispose();
  }
});

test('nosič: uložené náradie nezasahuje do seba navzájom, do trupu ani do hlavy', () => {
  for (const [name, look] of LOOKS) {
    const r = onRack(look);
    const tool = (t: ToolId): THREE.Object3D => { const o = r.group.getObjectByName('tool:' + t); assert.ok(o, `${name}: ${t} nie je na nosiči`); return o; };
    const tb = TOOLS.map(t => boxes(tool(t)));
    const body = r.group.getObjectByName('body'), head = r.group.getObjectByName('head');
    assert.ok(body && head);
    // trup: len vlastné diely kĺbu trupu (nie nosič, ramená, hlava); hlava: vlastné diely hlavy
    const trunk = boxes(body, true), hd = boxes(head, true);
    for (const [i, t] of TOOLS.entries()) {
      const a = tb[i] ?? [];
      assert.ok(!hits(a, trunk), `${name}: ${t} zasahuje do trupu`);
      assert.ok(!hits(a, hd), `${name}: ${t} zasahuje do hlavy`);
      for (let k = i + 1; k < TOOLS.length; k++) assert.ok(!hits(a, tb[k] ?? []), `${name}: ${t} zasahuje do ${TOOLS[k]}`);
    }
    r.dispose();
  }
});

test('v ruke: náradie je v klepete, na nosiči jeho miesto ostane prázdne', () => {
  const r = buildRobot(RM.PRESETS.hrdzavec.look);
  for (const t of TOOLS) {
    r.setTools(t, TOOLS);
    const all: THREE.Object3D[] = [];
    r.group.traverse(o => { if (o.name === 'tool:' + t) all.push(o); });
    assert.strictEqual(all.length, 1, t + ': náradie má byť len raz (v ruke)');
  }
  r.dispose();
});
