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
  ...Array.from({ length: 300 }, (_, i): [string, RobotLook] => ['seed ' + i, RM.randomLook(i)])
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

test('nosič: uložené náradie nezasahuje do seba navzájom, do nosiča (okrem svojho držiaka), do trupu ani do hlavy', () => {
  for (const [name, look] of LOOKS) {
    const r = onRack(look);
    const tool = (t: ToolId): THREE.Object3D => { const o = r.group.getObjectByName('tool:' + t); assert.ok(o, `${name}: ${t} nie je na nosiči`); return o; };
    const tb = TOOLS.map(t => boxes(tool(t)));
    const body = r.group.getObjectByName('body'), head = r.group.getObjectByName('head'), rack = r.group.getObjectByName('rack');
    assert.ok(body && head);
    // trup: len vlastné diely kĺbu trupu (nie nosič, ramená, hlava); hlava: vlastné diely hlavy
    const trunk = boxes(body, true), hd = boxes(head, true);
    for (const [i, t] of TOOLS.entries()) {
      const a = tb[i] ?? [];
      assert.ok(!hits(a, trunk), `${name}: ${t} zasahuje do trupu`);
      assert.ok(!hits(a, hd), `${name}: ${t} zasahuje do hlavy`);
      for (let k = i + 1; k < TOOLS.length; k++) assert.ok(!hits(a, tb[k] ?? []), `${name}: ${t} zasahuje do ${TOOLS[k]}`);
      // nosič: doska, úchyty a držiaky iného náradia (svoj držiak náradie drží, tam sa dotýka)
      const rackParts = (rack?.children ?? []).filter(c => c instanceof THREE.Mesh && c.name !== 'holder:' + t);
      for (const c of rackParts) assert.ok(!hits(a, boxes(c)), `${name}: ${t} zasahuje do nosiča (${c.name || 'doska / úchyt'})`);
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

test('krhla visí na háku: rameno háku leží vo vrchole oblúka držadla a ide kolmo cez oblúk', () => {
  for (const [name, look] of LOOKS.slice(0, 30)) {
    const r = onRack(look), sl = r.model.slots.can, k = sl.s ?? 1;
    const rack = r.group.getObjectByName('rack'), can = r.group.getObjectByName('tool:can');
    assert.ok(rack && can, name);
    // stred ramena háku (v súradniciach nosiča) a jeho smer (pozdĺž x) v súradniciach modelu krhly
    const hook = can.worldToLocal(rack.localToWorld(new THREE.Vector3(sl.p[0], sl.p[1] + RM.CAN_HOOK * k, sl.p[2])));
    const along = can.worldToLocal(rack.localToWorld(new THREE.Vector3(sl.p[0] + 0.01, sl.p[1] + RM.CAN_HOOK * k, sl.p[2]))).sub(hook).normalize();
    assert.ok(hook.distanceTo(new THREE.Vector3(0, RM.CAN_HOOK, 0)) < 1e-6, `${name}: hák nie je vo vrchole oblúka (${hook.toArray().join(', ')})`);
    assert.ok(Math.abs(along.x) > 0.999, `${name}: hák nejde kolmo cez oblúk držadla`);
    r.dispose();
  }
});

// Pózy, v ktorých sa ramená hýbu najviac: stoj, chôdza (krok dopredu aj dozadu), nesenie palice / zaveseného náradia,
// plazenie, tanec (ruky hore, oboje strany vlnenia) a hrabanie (oba krajné body)
const ARM_POSES: readonly [string, RM.PoseOpts][] = [
  ['stoj', {}], ['krok +', { phase: Math.PI / 2, walking: true }], ['krok −', { phase: -Math.PI / 2, walking: true }],
  ['palica', { hold: 'staff' }], ['zavesené', { hold: 'hang' }], ['plazenie', { crawl: true }],
  ['tanec +', { dance: true, t: Math.PI / 12 }], ['tanec −', { dance: true, t: -Math.PI / 12 }],
  ...[0.1, 0.3, 0.5, 0.7, 0.9].map((f): [string, RM.PoseOpts] => ['hrabanie ' + f, { dig: f / 1.2 }])
];
// presná obálka siete v súradniciach daného kĺbu (napr. trupu – pri tanci sa trup otáča a obálky vo svete by narástli)
function localBox(m: THREE.Object3D, frameInv: THREE.Matrix4): THREE.Box3 {
  const g: unknown = m instanceof THREE.Mesh ? m.geometry : null;
  const pos: unknown = g instanceof THREE.BufferGeometry ? g.getAttribute('position') : null, mat = new THREE.Matrix4().multiplyMatrices(frameInv, m.matrixWorld), v = new THREE.Vector3(), b = new THREE.Box3();
  if (pos instanceof THREE.BufferAttribute) for (let i = 0; i < pos.count; i++) b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mat));
  return b.expandByScalar(-0.002);
}
test('ramená sú mimo trupu: v žiadnej póze ruka ani rameno nezasahuje do trupu, hlavy, podvozku, nosiča ani náradia na ňom', () => {
  for (const [name, look] of LOOKS) {
    const r = buildRobot(look);
    r.setTools(null, TOOLS);
    const body = r.group.getObjectByName('body');
    assert.ok(body, name);
    for (const [pose, o] of ARM_POSES) {
      r.pose(o);
      r.group.updateMatrixWorld(true);
      const inv = body.matrixWorld.clone().invert();
      for (const side of ['L', 'R']) {
        const sh = r.group.getObjectByName('shoulder' + side);
        assert.ok(sh, name);
        const arm: THREE.Box3[] = [];
        sh.traverse(c => { if (c instanceof THREE.Mesh) arm.push(localBox(c, inv)); });
        // všetko ostatné okrem ramien (a držiaka plecia na trupe, ktorý sa ramena dotýka)
        const rest: THREE.Box3[] = [];
        const walk = (o2: THREE.Object3D): void => {
          if (o2.name === 'shoulderL' || o2.name === 'shoulderR') return;
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount') rest.push(localBox(o2, inv));
          for (const c of o2.children) walk(c);
        };
        walk(r.group);
        assert.ok(!arm.some(a => rest.some(b => a.intersectsBox(b))), `${name} (${look.loco}/${look.body}/${look.head}), ${pose}: rameno ${side} zasahuje do robota`);
      }
    }
    r.dispose();
  }
});

test('hrabanie: hrot motyky, krompáča aj klepeta zasekne do zeme pred robotom a ťahá k nemu; nič nejde do zeme ani do robota', () => {
  for (const [name, look] of LOOKS.slice(0, 999)) {
    const r = buildRobot(look), body = r.group.getObjectByName('body');
    assert.ok(body, name);
    for (const [label, held, carried] of [['motyka', 'hoe', ['can', 'pick', 'lamp']], ['krompáč', 'pick', ['hoe', 'can', 'lamp']], ['klepeto', null, TOOLS], ['klepeto (krhla v ruke)', 'can', ['hoe', 'pick', 'lamp']]] as const) {
      r.setTools(held, carried);
      const side = held === 'can' ? 'L' : 'R';
      const lows: number[] = [];
      for (const f of [0.1, 0.3, 0.5, 0.6, 0.7, 0.9]) {
        r.pose({ dig: f / 1.2 });
        r.group.updateMatrixWorld(true);
        const inv = body.matrixWorld.clone().invert(), sh = r.group.getObjectByName('shoulder' + side);
        assert.ok(sh, name);
        const arm: THREE.Box3[] = [];
        let low = Infinity;
        sh.traverse(c => { if (c instanceof THREE.Mesh) { arm.push(localBox(c, inv)); low = Math.min(low, new THREE.Box3().setFromObject(c, true).min.y); } });
        lows.push(low);
        assert.ok(low > -0.02, `${name}, ${label}, ${f}: ide do zeme (${low.toFixed(3)})`);
        const rest: THREE.Box3[] = [];
        const walk = (o2: THREE.Object3D): void => {
          if (o2.name === 'shoulderL' || o2.name === 'shoulderR') return;
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount') rest.push(localBox(o2, inv));
          for (const c of o2.children) walk(c);
        };
        walk(r.group);
        assert.ok(!arm.some(a => rest.some(b => a.intersectsBox(b))), `${name}, ${label}, ${f}: ruka alebo náradie zasahuje do robota`);
      }
      // počas ťahania (0,5 a 0,6) je hrot motyky a krompáča pri zemi; klepeto hrabe tak nízko, ako dočiahne; pri zdvihu (0,1) vyššie
      const msg = `${name}, ${label}: ${lows.map(v => v.toFixed(3)).join(', ')}`;
      if (held === 'hoe' || held === 'pick') assert.ok((lows[2] ?? 1) < 0.025 && (lows[3] ?? 1) < 0.025, msg + ' – hrot pri ťahaní nie je pri zemi');
      assert.ok((lows[0] ?? 0) > (lows[2] ?? 0) + 0.02, msg + ' – pri zdvihu nie je hrot vyššie ako pri ťahaní');
    }
    r.dispose();
  }
});

test('náradie v ruke: zavesená krhla a lampáš visia vždy zvislo (nikdy sa neprevrátia), nič v ruke nejde do robota ani do zeme', () => {
  for (const [name, look] of LOOKS.slice(0, 40)) {
    const r = buildRobot(look), body = r.group.getObjectByName('body');
    assert.ok(body, name);
    for (const held of ['can', 'lamp', 'hoe', 'pick'] as const) {
      r.setTools(held, TOOLS);
      for (const [pose, o] of ARM_POSES) {
        if (o.dig !== undefined) continue; // hrabanie má vlastný test
        if (o.hold && o.hold !== RM.TOOL_HOLD[held]) continue; // póza nesenia patrí k náradiu (palica / zavesené)
        r.pose(o);
        r.group.updateMatrixWorld(true);
        const tool = r.group.getObjectByName('tool:' + held);
        assert.ok(tool, name);
        if (held === 'can' || held === 'lamp') {
          const upw = new THREE.Vector3(0, 1, 0).applyQuaternion(tool.getWorldQuaternion(new THREE.Quaternion()));
          assert.ok(upw.y > 0.97, `${name}, ${held}, ${pose}: nevisí zvislo (${upw.y.toFixed(2)})`);
        }
        const inv = body.matrixWorld.clone().invert(), tb: THREE.Box3[] = [];
        let low = Infinity;
        tool.traverse(c => { if (c instanceof THREE.Mesh) { tb.push(localBox(c, inv)); low = Math.min(low, new THREE.Box3().setFromObject(c, true).min.y); } });
        assert.ok(low > -0.005, `${name}, ${held}, ${pose}: náradie ide do zeme (${low.toFixed(3)})`);
        const rest: THREE.Box3[] = [];
        const walk = (o2: THREE.Object3D): void => {
          if (o2.name === 'shoulderL' || o2.name === 'shoulderR') return;
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount') rest.push(localBox(o2, inv));
          for (const c of o2.children) walk(c);
        };
        walk(r.group);
        assert.ok(!tb.some(a => rest.some(b => a.intersectsBox(b))), `${name}, ${held}, ${pose}: náradie v ruke zasahuje do robota`);
      }
    }
    r.dispose();
  }
});
