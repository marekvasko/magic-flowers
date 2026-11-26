import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import * as RM from '../src/shared/robotmodel.ts';
import type { RobotLook } from '../src/shared/robotmodel.ts';
import type { ToolId } from '../src/shared/data.ts';
import { buildRobot } from '../src/client/robot3d.ts';
import type { Robot3D } from '../src/client/robot3d.ts';
import { must } from './helpers.ts';

// Sieť robota (Three.js beží aj v Node – len geometria, bez kreslenia): predvoľby + vygenerované roboty
// (málo robotov, aby testy servera popri tom stíhali svoje časové limity; pri zmenách robota ich spusti na stovkách semienok)
const LOOKS: [string, RobotLook][] = [
  ...RM.PRESET_IDS.map((p): [string, RobotLook] => [p, RM.PRESETS[p].look]),
  ...Array.from({ length: 30 }, (_, i): [string, RobotLook] => ['seed ' + i, RM.randomLook(i * 7 + 3)])
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
      const rackParts: THREE.Object3D[] = [];
      const walkRack = (o: THREE.Object3D): void => {
        if (o.name === 'holder:' + t || o.name.startsWith('tool:')) return; // svoj držiak (kĺb aj čap) a náradie
        if (o instanceof THREE.Mesh) rackParts.push(o);
        for (const c of o.children) walkRack(c);
      };
      if (rack) walkRack(rack);
      assert.ok(rackParts.length > 8, name);
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
  for (const [name, look] of LOOKS.slice(0, 15)) {
    const r = onRack(look), sl = r.model.slots.can, k = sl.s ?? 1;
    const rack = r.group.getObjectByName('holder:can'), can = r.group.getObjectByName('tool:can'); // kĺb háku
    assert.ok(rack instanceof THREE.Group && can, name);
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
  ...[0.1, 0.3, 0.5, 0.7, 0.9].map((f): [string, RM.PoseOpts] => ['hrabanie ' + f, { dig: f / RM.DIG_RATE }])
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
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount' && o2.name !== 'water') rest.push(localBox(o2, inv));
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
  for (const [name, look] of LOOKS.slice(0, 15)) {
    const r = buildRobot(look), body = r.group.getObjectByName('body');
    assert.ok(body, name);
    for (const [label, held, carried] of [['motyka', 'hoe', ['can', 'pick', 'lamp']], ['krompáč', 'pick', ['hoe', 'can', 'lamp']], ['klepeto', null, TOOLS], ['klepeto (krhla v ruke)', 'can', ['hoe', 'pick', 'lamp']]] as const) {
      r.setTools(held, carried);
      const side = held === 'can' ? 'L' : 'R';
      const lows: number[] = [];
      for (const f of [0.1, 0.3, 0.5, 0.6, 0.7, 0.9]) {
        r.pose({ dig: f / RM.DIG_RATE });
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
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount' && o2.name !== 'water') rest.push(localBox(o2, inv));
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
  for (const [name, look] of LOOKS.slice(0, 20)) {
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
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount' && o2.name !== 'water') rest.push(localBox(o2, inv));
          for (const c of o2.children) walk(c);
        };
        walk(r.group);
        assert.ok(!tb.some(a => rest.some(b => a.intersectsBox(b))), `${name}, ${held}, ${pose}: náradie v ruke zasahuje do robota`);
      }
    }
    r.dispose();
  }
});

test('použitie náradia: motyka okopáva a krompáč seká do zeme pred robotom, krhla sa nakloní a polieva, lampáš sa zdvihne; nič nezasahuje do robota ani do zeme', () => {
  for (const [name, look] of LOOKS.slice(0, 15)) {
    const r = buildRobot(look), body = r.group.getObjectByName('body');
    assert.ok(body, name);
    for (const tool of TOOLS) {
      r.setTools(tool, TOOLS);
      let lowest = Infinity, poured = false, raised = false;
      for (let k = 0; k < 20; k++) {
        const t = (k / 20) * RM.USE_CYCLE[tool];
        r.pose({ use: { tool, t } });
        r.group.updateMatrixWorld(true);
        const inv = body.matrixWorld.clone().invert(), sh = r.group.getObjectByName('shoulderR'), held = r.group.getObjectByName('tool:' + tool);
        assert.ok(sh && held, name);
        const arm: THREE.Box3[] = [];
        let low = Infinity;
        sh.traverse(c => { if (c instanceof THREE.Mesh) { arm.push(localBox(c, inv)); } });
        held.traverse(c => { if (c instanceof THREE.Mesh) low = Math.min(low, new THREE.Box3().setFromObject(c, true).min.y); });
        lowest = Math.min(lowest, low);
        assert.ok(low > -0.02, `${name}, ${tool}, t ${t.toFixed(2)}: náradie ide do zeme (${low.toFixed(3)})`);
        const rest: THREE.Box3[] = [];
        const walk = (o2: THREE.Object3D): void => {
          if (o2.name === 'shoulderL' || o2.name === 'shoulderR') return;
          if (o2 instanceof THREE.Mesh && o2.name !== 'armmount' && o2.name !== 'water') rest.push(localBox(o2, inv));
          for (const c of o2.children) walk(c);
        };
        walk(r.group);
        assert.ok(!arm.some(a => rest.some(b => a.intersectsBox(b))), `${name}, ${tool}, t ${t.toFixed(2)}: ruka alebo náradie zasahuje do robota`);
        if (tool === 'can') {
          const spout = new THREE.Vector3(0, 0, 1).applyQuaternion(held.getWorldQuaternion(new THREE.Quaternion()));
          const rose = held.localToWorld(new THREE.Vector3(0, 0.03, 0.16));
          if (spout.y < -0.4 && rose.z > r.model.front * r.model.scale) poured = true;
        }
        if (tool === 'lamp' && held.getWorldPosition(new THREE.Vector3()).y > RM.FRAME.shoulder[1]) raised = true;
      }
      if (tool === 'hoe' || tool === 'pick') assert.ok(lowest < 0.025, `${name}, ${tool}: hrot nedosiahne zem (${lowest.toFixed(3)})`);
      if (tool === 'can') assert.ok(poured, `${name}: krhla sa nenakloní hubicou dolu pred robotom`);
      if (tool === 'lamp') assert.ok(raised, `${name}: lampáš sa nezdvihne nad plece`);
    }
    r.dispose();
  }
});

test('kĺby sa k novej póze ťahajú postupne (najviac jointSpeed), potom ju dosiahnu', () => {
  const r = buildRobot(RM.PRESETS.hrdzavec.look), sh = r.group.getObjectByName('shoulderR');
  assert.ok(sh);
  r.pose({});
  const x0 = sh.rotation.x;
  r.pose({ dance: true, t: 0 }, 0.016);
  assert.ok(Math.abs(sh.rotation.x - x0) <= RM.jointSpeed('shoulderR') * 0.016 + 1e-9, 'plece skočilo naraz');
  for (let k = 0; k < 100; k++) r.pose({ dance: true, t: 0 }, 0.016);
  const target = RM.robotPose(r.model, { dance: true, t: 0 }).joints.get('shoulderR')?.r[0] ?? 0;
  assert.ok(Math.abs(sh.rotation.x - target) < 1e-9, 'plece nedosiahlo pózu');
  r.dispose();
});

test('modely náradia sú celé: žiadny diel nevisí vo vzduchu (každý sa dotýka iného dielu toho istého náradia)', () => {
  const r = buildRobot(RM.PRESETS.hrdzavec.look);
  r.setTools(null, TOOLS);
  r.group.updateMatrixWorld(true);
  for (const t of TOOLS) {
    const tool = r.group.getObjectByName('tool:' + t);
    assert.ok(tool, t);
    const inv = tool.matrixWorld.clone().invert(), parts: THREE.Box3[] = [];
    tool.traverse(c => { if (c instanceof THREE.Mesh) parts.push(localBox(c, inv).expandByScalar(0.006)); });
    assert.ok(parts.length > 1, t);
    // zo všetkých dielov sa dá prejsť cez dotyky na všetky ostatné
    const seen = new Set([0]), queue = [0];
    while (queue.length) { const i = queue.pop() ?? 0; for (const [k, b] of parts.entries()) if (!seen.has(k) && parts[i]?.intersectsBox(b)) { seen.add(k); queue.push(k); } }
    assert.strictEqual(seen.size, parts.length, `${t}: ${parts.length - seen.size} dielov nie je spojených s ostatnými`);
  }
  r.dispose();
});

// Presnejší dotyk ako obálky podľa osí: hranaté diely ako natočené kvádre (OBB), guľaté (gule, kupoly, sploštené gule –
// hlava, vrchnák kotla) ako elipsoidy: bod je vnútri, keď po prevode do priestoru jednotkovej gule má dĺžku < 1.
// Valce (trup kotla a plechovky, obruče hlavy) presne: bod je vnútri, keď je v miestnych súradniciach do polomeru a výšky.
type Solid = ({ obb: OBB } | { ball: THREE.Matrix4 } | { cyl: THREE.Matrix4; r: number; h: number; obb: OBB }) & { what?: string };
function solids(o: THREE.Object3D): Solid[] {
  const out: Solid[] = [];
  o.traverse(c => {
    const g: unknown = c instanceof THREE.Mesh ? c.geometry : null;
    if (!(g instanceof THREE.BufferGeometry)) return;
    g.computeBoundingBox();
    const b = g.boundingBox?.clone();
    if (!b) return;
    const n0 = out.length;
    const rad = g instanceof THREE.SphereGeometry || g instanceof THREE.IcosahedronGeometry ? g.parameters.radius : 0, size = b.getSize(new THREE.Vector3());
    if (rad > 0) {
      // kupola (pologuľa) = guľa s polomerom rad okolo počiatku; inak polosi z obálky (natiahnutie je zapečené v geometrii)
      const ax = b.min.y > -1e-6 ? new THREE.Vector3(rad, rad, rad) : size.clone().multiplyScalar(0.5);
      out.push({ ball: new THREE.Matrix4().multiplyMatrices(c.matrixWorld, new THREE.Matrix4().makeScale(Math.max(1e-4, ax.x - 0.002), Math.max(1e-4, ax.y - 0.002), Math.max(1e-4, ax.z - 0.002))).invert() });
    } else {
      const obb = new OBB().fromBox3(b.clone().expandByScalar(-0.002)).applyMatrix4(c.matrixWorld);
      if (g instanceof THREE.CylinderGeometry && c instanceof THREE.Mesh) out.push({ cyl: c.matrixWorld.clone().invert(), r: Math.max(g.parameters.radiusTop, g.parameters.radiusBottom) - 0.002, h: g.parameters.height - 0.004, obb });
      // prstenec ležiaci v rovine xz (obruč) ako nízky valec
      else if (g instanceof THREE.TorusGeometry && c instanceof THREE.Mesh && size.y < size.x * 0.5) out.push({ cyl: c.matrixWorld.clone().invert(), r: g.parameters.radius + g.parameters.tube - 0.002, h: size.y - 0.004, obb });
      else out.push({ obb });
    }
    for (let k = n0; k < out.length; k++) must(out[k]).what = `${c.parent?.name ?? ''}/${c.name || g.type}`;
  });
  return out;
}
// body na povrchu a vnútri kvádra (mriežka 3 × 3 × 3)
function samples(a: OBB): THREE.Vector3[] {
  const out: THREE.Vector3[] = [], e = a.rotation.elements;
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    out.push(new THREE.Vector3(
      a.center.x + e[0] * x * a.halfSize.x + e[3] * y * a.halfSize.y + e[6] * z * a.halfSize.z,
      a.center.y + e[1] * x * a.halfSize.x + e[4] * y * a.halfSize.y + e[7] * z * a.halfSize.z,
      a.center.z + e[2] * x * a.halfSize.x + e[5] * y * a.halfSize.y + e[8] * z * a.halfSize.z));
  }
  return out;
}
const inBall = (inv: THREE.Matrix4, p: THREE.Vector3): boolean => p.clone().applyMatrix4(inv).lengthSq() < 1;
// stred a konce polosí elipsoidu vo svete
const ballPoints = (inv: THREE.Matrix4): THREE.Vector3[] => { const m = inv.clone().invert(); return [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(m)); };
type Cyl = { cyl: THREE.Matrix4; r: number; h: number };
const inCyl = (c: Cyl, p: THREE.Vector3): boolean => { const q = p.clone().applyMatrix4(c.cyl); return Math.abs(q.y) < c.h / 2 && Math.hypot(q.x, q.z) < c.r; };
// body na plášti, podstavách a osi valca
function cylPoints(c: Cyl): THREE.Vector3[] {
  const m = c.cyl.clone().invert(), out: THREE.Vector3[] = [];
  for (const y of [-0.5, 0, 0.5]) { out.push(new THREE.Vector3(0, y * c.h, 0).applyMatrix4(m)); for (let k = 0; k < 8; k++) out.push(new THREE.Vector3(Math.cos(k * Math.PI / 4) * c.r, y * c.h, Math.sin(k * Math.PI / 4) * c.r).applyMatrix4(m)); }
  return out;
}
const points = (a: Solid): THREE.Vector3[] => 'cyl' in a ? cylPoints(a) : 'ball' in a ? ballPoints(a.ball) : samples(a.obb);
const inside = (a: Solid, p: THREE.Vector3): boolean => 'cyl' in a ? inCyl(a, p) : 'ball' in a ? inBall(a.ball, p) : a.obb.containsPoint(p);
// dva kvádre presne; inak (guľaté a valcové diely) bod jedného vnútri druhého
function touch(a: Solid, b: Solid): boolean {
  if ('obb' in a && 'obb' in b) { if (!a.obb.intersectsOBB(b.obb)) return false; if (!('cyl' in a) && !('cyl' in b)) return true; }
  return points(a).some(p => inside(b, p)) || points(b).some(p => inside(a, p));
}
// Výmena náradia krok po kroku: v každom snímku zavolá f(čas, náradie → kde je: 'hand' | 'rack' | 'air')
function runSwitch(r: Robot3D, to: ToolId | null, dt: number, f: (t: number, where: Map<ToolId, string>) => void): number {
  r.switchTool(to);
  let t = 0;
  while (r.switching() && t < 8) {
    r.pose({}, dt); t += dt;
    r.group.updateMatrixWorld(true);
    const where = new Map<ToolId, string>();
    for (const tool of TOOLS) {
      const all: THREE.Object3D[] = [];
      r.group.traverse(o => { if (o.name === 'tool:' + tool) all.push(o); });
      assert.strictEqual(all.length, 1, `${tool} je ${all.length}×`);
      let p: THREE.Object3D | null = all[0]?.parent ?? null, w = 'air';
      while (p) { if (p.name === 'handR') w = 'hand'; if (p.name === 'rack') w = 'rack'; p = p.parent; }
      where.set(tool, w);
    }
    f(t, where);
  }
  assert.ok(!r.switching(), 'výmena neskončila');
  return t;
}

test('výmena náradia: staré skončí v držiaku, nové v klepete; každé je vždy práve raz; nič cestou nezasiahne trup ani hlavu', () => {
  for (const [name, look] of LOOKS.slice(0, 12)) {
    const r = buildRobot(look), body = r.group.getObjectByName('body'), head = r.group.getObjectByName('head');
    assert.ok(body && head, name);
    r.setTools('hoe', TOOLS);
    r.pose({});
    for (const [from, to] of [['hoe', 'can'], ['can', 'pick'], ['pick', 'lamp'], ['lamp', null], [null, 'hoe']] as const) {
      const flew = new Set<ToolId>();
      runSwitch(r, to, 1 / 60, (t, where) => {
        const rest: Solid[] = [];
        for (const part of [...body.children, ...head.children]) if (part instanceof THREE.Mesh && part.name !== 'armmount') rest.push(...solids(part));
        const hit = (tb: Solid[]): string | null => { for (const a of tb) for (const b of rest) if (touch(a, b)) return `${a.what} × ${b.what}` + ('obb' in a ? ` @ ${a.obb.center.toArray().map(v => v.toFixed(3)).join(',')} half ${a.obb.halfSize.toArray().map(v => v.toFixed(3)).join(',')}` : '') + ('cyl' in b ? ` cyl r ${b.r.toFixed(3)} h ${b.h.toFixed(3)} at ${b.obb.center.toArray().map(v => v.toFixed(3)).join(',')}` : ''); return null; };
        // náradie, ktoré sa práve vymieňa (v ruke pri hode, v natočenom držiaku, vo vzduchu), nezasahuje do trupu ani hlavy
        for (const tool of [from, to]) {
          if (!tool) continue;
          if (where.get(tool) === 'air') flew.add(tool);
          const o = r.group.getObjectByName('tool:' + tool), tb = o ? solids(o) : [];
          const h = hit(tb);
          assert.ok(!h, `${name} ${from}→${to}, t ${t.toFixed(2)}: ${tool} (${where.get(tool)}) zasahuje do robota: ${h}`);
        }
      });
      for (const tool of [from, to]) if (tool) assert.ok(flew.has(tool), `${name} ${from}→${to}: ${tool} neletelo`);
      const where = new Map<ToolId, string>();
      runSwitch(r, to, 1 / 60, (_t, w) => { for (const [k, v] of w) where.set(k, v); }); // už je vymenené – nič sa nestane
      r.pose({}, 1 / 60); r.group.updateMatrixWorld(true);
      for (const tool of TOOLS) {
        let p: THREE.Object3D | null = r.group.getObjectByName('tool:' + tool) ?? null, w = 'air';
        while (p) { if (p.name === 'handR') w = 'hand'; if (p.name === 'rack') w = 'rack'; p = p.parent; }
        assert.strictEqual(w, tool === to ? 'hand' : 'rack', `${name} ${from}→${to}: ${tool} je ${w}`);
      }
    }
    r.dispose();
  }
});

test('výmena náradia je šikmý vrh: let je parabola s gravitáciou, ruka aj vystreľovač dajú náradiu rýchlosť, s ktorou letí, a dopadne presne do držiaka / klepeta', () => {
  const dt = 1 / 600, G = RM.GRAVITY;
  for (const [name, look] of LOOKS.slice(0, 5)) {
    const r = buildRobot(look);
    r.setTools('hoe', TOOLS);
    r.pose({});
    for (const [from, to] of [['hoe', 'pick'], ['pick', 'can'], ['can', 'lamp'], ['lamp', 'hoe']] as const) {
      // dráha oboch kusov náradia (svet = súradnice trupu, robot stojí)
      const objs = [from, to].map(tool => { const o = r.group.getObjectByName('tool:' + tool); assert.ok(o); return o; });
      const track: { p: THREE.Vector3; air: boolean }[][] = [[], []];
      r.switchTool(to);
      for (let t = 0; r.switching() && t < 8; t += dt) {
        r.pose({}, dt);
        r.group.updateMatrixWorld(true);
        for (const [k, o] of objs.entries()) track[k]?.push({ p: o.getWorldPosition(new THREE.Vector3()), air: o.parent?.name === 'body' });
      }
      assert.ok(!r.switching(), name);
      for (const [i, tool] of [from, to].entries()) {
        const tr = track[i] ?? [], a = tr.findIndex(x => x.air), b = tr.findLastIndex(x => x.air), msg = `${name} ${from}→${to}, ${tool}`;
        const vel = (k: number): THREE.Vector3 => must(tr[k]).p.clone().sub(must(tr[k - 1]).p).divideScalar(dt); // rýchlosť v čase k − ½
        assert.ok(a > 3 && b > a + 50 && b < tr.length - 1, msg + ': chýba let');
        // 1) vo vzduchu: zrýchlenie = gravitácia (druhá diferencia polohy), žiadne iné
        for (let k = a + 1; k < b; k += 7) {
          const acc = vel(k + 1).sub(vel(k)).divideScalar(dt);
          assert.ok(Math.abs(acc.y + G) < 0.03 * G && Math.hypot(acc.x, acc.z) < 0.03 * G, `${msg}: zrýchlenie vo vzduchu ${acc.toArray().map(v => v.toFixed(2)).join(', ')}`);
        }
        // 2) pustenie: rýchlosť, ktorú náradiu dala ruka / vystreľovač (predĺžená do okamihu pustenia), je rýchlosť,
        //    s ktorou letí (vrátená o gravitáciu do toho istého okamihu)
        const vHand = vel(a - 1).add(vel(a - 1).sub(vel(a - 2))), vFly = vel(a + 2); vFly.y += G * 2 * dt;
        assert.ok(vFly.length() > 1.5, `${msg}: štartová rýchlosť ${vFly.length().toFixed(2)}`);
        assert.ok(vHand.distanceTo(vFly) < 0.08 * vFly.length(), `${msg}: pri pustení ${vHand.toArray().map(v => v.toFixed(2)).join(', ')} → ${vFly.toArray().map(v => v.toFixed(2)).join(', ')}`);
        // 3) dopad: náradie doletí tam, kde ostane (držiak / klepeto) – bez skoku
        const stepFly = must(tr[b]).p.distanceTo(must(tr[b - 1]).p), jump = must(tr[b + 1]).p.distanceTo(must(tr[b]).p);
        assert.ok(jump < stepFly + 0.004, `${msg}: pri dopade skok ${jump.toFixed(4)} (krok letu ${stepFly.toFixed(4)})`);
      }
    }
    r.dispose();
  }
});

test('hrdza je textúra v nátere: materiál náteru nesie mieru hrdze podľa ošúchanosti, žiadne hrdzavé diely navyše', () => {
  const rustOf = (wear: number): number[] => {
    const r = buildRobot({ ...RM.PRESETS.hranac.look, wear }), out = new Set<number>();
    r.group.traverse(o => { const m: unknown = o instanceof THREE.Mesh ? o.material : null; if (m instanceof THREE.MeshStandardMaterial && typeof m.userData['rust'] === 'number') out.add(m.userData['rust']); });
    r.dispose();
    return [...out].sort((a, b) => a - b);
  };
  assert.deepStrictEqual(rustOf(0), [0]);
  assert.deepStrictEqual(rustOf(1), [0.7, 1]); // doplnková farba hrdzavie menej ako náter
  const a = buildRobot({ ...RM.PRESETS.hranac.look, wear: 0 }), b = buildRobot({ ...RM.PRESETS.hranac.look, wear: 1 });
  assert.strictEqual(triangles(a.group), triangles(b.group));
  a.dispose(); b.dispose();
});

test('výmena náradia: vystrelené náradie padne do ruky tam, kde ho ruka pri odhodení púšťa', () => {
  const dt = 1 / 240;
  for (const [name, look] of LOOKS.slice(0, 5)) {
    const r = buildRobot(look);
    r.setTools('hoe', TOOLS);
    r.pose({});
    // kde každé náradie opustilo ruku (prvý snímok letu po hode) a kde do nej dopadlo (posledný snímok letu po výstrele)
    const released = new Map<ToolId, THREE.Vector3>(), caught = new Map<ToolId, THREE.Vector3>();
    for (const to of ['can', 'pick', 'lamp', 'hoe', 'can'] as const) {
      const objs = new Map(TOOLS.map(t => { const o = r.group.getObjectByName('tool:' + t); assert.ok(o); return [t, o] as const; }));
      const was = new Map(TOOLS.map(t => [t, '']));
      r.switchTool(to);
      for (let t = 0; r.switching() && t < 8; t += dt) {
        r.pose({}, dt);
        r.group.updateMatrixWorld(true);
        for (const [tool, o] of objs) {
          let p: THREE.Object3D | null = o.parent, w = 'air';
          while (p) { if (p.name === 'handR') w = 'hand'; if (p.name === 'rack') w = 'rack'; p = p.parent; }
          const pos = o.getWorldPosition(new THREE.Vector3());
          if (was.get(tool) === 'hand' && w === 'air') released.set(tool, pos);
          if (was.get(tool) === 'air' && w === 'hand') caught.set(tool, pos);
          was.set(tool, w);
        }
      }
    }
    for (const tool of TOOLS) {
      const a = released.get(tool), b = caught.get(tool);
      assert.ok(a && b, `${name}: ${tool} nebolo odhodené aj chytené`);
      assert.ok(a.distanceTo(b) < 0.03, `${name}: ${tool} pustené v ${a.toArray().map(v => v.toFixed(3)).join(', ')}, chytené v ${b.toArray().map(v => v.toFixed(3)).join(', ')}`);
    }
    r.dispose();
  }
});

test('nohy: chodidlá stoja na zemi a nohy nejdú do zeme ani do trupu – v stoji, pri chôdzi, plazení aj tanci', () => {
  const walkers = LOOKS.filter(([, l]) => l.loco === 'legs2' || l.loco === 'legs3');
  assert.ok(walkers.length >= 6);
  for (const [name, look] of walkers) {
    const r = buildRobot(look), body = r.group.getObjectByName('body');
    assert.ok(body, name);
    r.setTools(null, TOOLS);
    const poses: [string, RM.PoseOpts][] = [['stoj', {}], ['plazenie v stoji', { crawl: true }],
      ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((k): [string, RM.PoseOpts][] => [['chôdza ' + k, { walking: true, phase: (k * Math.PI) / 4 }], ['plazenie ' + k, { crawl: true, walking: true, phase: (k * Math.PI) / 4 }]]),
      ['tanec', { dance: true, t: 0.26 }]];
    for (const [pose, o] of poses) {
      r.pose(o);
      r.group.updateMatrixWorld(true);
      const legs: THREE.Object3D[] = [], feet: THREE.Object3D[] = [];
      body.traverse(c => { if (/^hip/.test(c.name)) legs.push(c); if (/^foot/.test(c.name)) feet.push(c); });
      assert.strictEqual(feet.length, look.loco === 'legs2' ? 2 : 3, name);
      const msg = `${name} (${look.loco}/${look.body}), ${pose}`;
      // 1) nič z nôh nie je pod zemou; každé chodidlo je na zemi alebo najviac o zdvih kroku nad ňou
      const stepping = !!o.walking;
      for (const f of feet) {
        const low = new THREE.Box3().setFromObject(f, true).min.y;
        assert.ok(low > -0.006, `${msg}: chodidlo pod zemou (${low.toFixed(3)})`);
        // pri tanci robot poskakuje (trup vyskočí vyššie, ako nohy dočiahnu) – chodidlá sa smú odlepiť
        assert.ok(low < (o.dance ? 0.06 : stepping ? 0.04 : 0.006), `${msg}: chodidlo vo vzduchu (${low.toFixed(3)})`);
      }
      for (const l of legs) assert.ok(new THREE.Box3().setFromObject(l, true).min.y > -0.006, `${msg}: noha pod zemou`);
      if (stepping) assert.ok(feet.some(f => new THREE.Box3().setFromObject(f, true).min.y < 0.006), `${msg}: žiadne chodidlo nestojí na zemi`);
      // 2) nohy od kolena dolu nejdú do trupu (stehno je k trupu pripojené v bedre – tam sa ho dotýka)
      const rest: Solid[] = [];
      for (const part of body.children) if (part instanceof THREE.Mesh && part.name !== 'armmount') rest.push(...solids(part));
      const knees: THREE.Object3D[] = [];
      body.traverse(c => { if (/^knee/.test(c.name)) knees.push(c); });
      for (const k of knees) for (const a of solids(k)) for (const b of rest) assert.ok(!touch(a, b), `${msg}: ${a.what} zasahuje do ${b.what}`);
    }
    r.dispose();
  }
});
