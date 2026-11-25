// 3D robot hráča (#194): Three.js sieť z opisu shared/robotmodel.ts – kĺby sú skupiny, diely hladké siete s materiálmi
// podľa vzhľadu (náter, doplnková farba, svetlo očí, hrdza). Náradie: to, ktoré hráč drží, je v pravej ruke
// (lampáš visí kolmo dole, svieti), ostatné vlastnené náradie je na nosiči na chrbte.
// Zatiaľ ho kreslí /debug → Robots; v hre nahradí 2D postavičku v ďalšej fáze (#194 P2).
import * as THREE from 'three';
import * as RM from '../shared/robotmodel.ts';
import type { JointId, Mat, MountId, Part, PoseOpts, RobotLook, RobotModel, Shape } from '../shared/robotmodel.ts';
import type { ToolId } from '../shared/data.ts';
import { must } from '../shared/util.ts';

// ---------- tvary ----------
// Zaoblená kocka: kocka s viac dielikmi, ktorej body sa pritiahnu k vnútornej kocke a vytlačia o polomer
function roundedBox(sx: number, sy: number, sz: number, r0: number, seg = 3): THREE.BufferGeometry {
  const r = Math.min(r0, sx / 2, sy / 2, sz / 2) * 0.999;
  const g = new THREE.BoxGeometry(sx, sy, sz, seg * 2, seg * 2, seg * 2);
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const hx = sx / 2 - r, hy = sy / 2 - r, hz = sz / 2 - r;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    n.subVectors(v, c);
    if (n.lengthSq() < 1e-12) n.fromBufferAttribute(nor, i); else n.normalize();
    v.copy(c).addScaledVector(n, r);
    pos.setXYZ(i, v.x, v.y, v.z); nor.setXYZ(i, n.x, n.y, n.z);
  }
  // body na hranách sa zdvojili (rovnaká poloha zo susedných stien) – normály z polohy už sedia, šev nevidno
  return g;
}
const GEO = new Map<string, THREE.BufferGeometry>();
function geometry(s: Shape): THREE.BufferGeometry {
  const key = JSON.stringify(s);
  let g = GEO.get(key);
  if (g) return g;
  switch (s.k) {
    case 'box': g = roundedBox(s.s[0], s.s[1], s.s[2], s.r); break;
    case 'cyl': g = new THREE.CylinderGeometry(s.r2 ?? s.r, s.r, s.h, Math.max(10, Math.round(s.r * 160))); break;
    case 'sphere': g = new THREE.SphereGeometry(s.r, 20, 14); if (s.s) g.scale(...s.s); break;
    case 'capsule': g = new THREE.CapsuleGeometry(s.r, s.h, 4, 12); break;
    case 'torus': g = new THREE.TorusGeometry(s.r, s.t, 8, 28); g.rotateX(Math.PI / 2); break;
    case 'dome': g = new THREE.SphereGeometry(s.r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2); break;
  }
  GEO.set(key, g);
  return g;
}

// ---------- materiály ----------
const col = (h: string): THREE.Color => new THREE.Color(h);
// Materiály robota podľa vzhľadu; ošúchaný náter je o kúsok tmavší a do hneda
function materials(look: RobotLook): Record<Mat, THREE.MeshStandardMaterial> {
  const rustCol = col('#a4532a'), paint = col(look.paint).lerp(col('#8a6a4a'), look.wear * 0.25);
  const std = (c: THREE.Color | string, rough: number, metal: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: typeof c === 'string' ? col(c) : c, roughness: rough, metalness: metal, ...extra });
  return {
    paint: std(paint, 0.55, 0.1),
    accent: std(col(look.accent), 0.5, 0.25),
    metal: std('#a9b0b4', 0.35, 0.55),
    dark: std('#3a3f43', 0.6, 0.3),
    rubber: std('#2c2a28', 0.9, 0),
    eye: std(col(look.eye), 0.3, 0, { emissive: col(look.eye), emissiveIntensity: 1.6 }),
    lens: std('#101518', 0.15, 0.2),
    glass: std('#e8f6ff', 0.05, 0, { transparent: true, opacity: 0.35, depthWrite: false }),
    rust: std(rustCol, 0.95, 0.05),
    warm: std('#ffb54a', 0.4, 0, { emissive: col('#ff9a2a'), emissiveIntensity: 1.2 }),
    leaf: std('#5aa646', 0.7, 0),
    pot: std('#b8643c', 0.85, 0)
  };
}

// ---------- náradie ----------
// Model náradia: úchop (rúčka) je v počiatku, náradie ide pozdĺž +y (v ruke dopredu)
const TOOL_FREE = new WeakMap<THREE.Group, () => void>(); // uvoľnenie sietí a materiálov náradia
function toolMesh(id: ToolId): THREE.Group {
  const g = new THREE.Group(); g.name = 'tool:' + id;
  const own: { dispose: () => void }[] = [];
  TOOL_FREE.set(g, () => { for (const o of own) o.dispose(); });
  const m = (c: string, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: col(c), roughness: 0.6, metalness: 0.1, ...extra });
  const wood = m('#9a6a3c'), steel = m('#b7bec2', { metalness: 0.5, roughness: 0.35 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number], r?: [number, number, number]): THREE.Mesh => {
    const me = new THREE.Mesh(geo, mat); me.position.set(...p); if (r) me.rotation.set(...r); me.castShadow = true; g.add(me); own.push(geo, mat); return me;
  };
  if (id === 'hoe') {
    add(new THREE.CylinderGeometry(0.011, 0.011, 0.42, 8), wood, [0, 0.12, 0]);
    add(roundedBox(0.1, 0.012, 0.07, 0.005), steel, [0, 0.33, 0.035]);
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 8), steel, [0, 0.33, 0.005], [Math.PI / 2, 0, 0]);
  } else if (id === 'pick') {
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.38, 8), wood, [0, 0.1, 0]);
    for (const s of [-1, 1]) add(new THREE.ConeGeometry(0.016, 0.11, 8), steel, [s * 0.055, 0.29, 0], [0, 0, -s * 1.4]);
    add(roundedBox(0.04, 0.035, 0.035, 0.008), steel, [0, 0.29, 0]);
  } else if (id === 'can') {
    // krhla: držiak hore, telo pod ním, hubica s ružicou dopredu
    const tin = m('#6aa0b8', { metalness: 0.35, roughness: 0.4 });
    add(new THREE.TorusGeometry(0.035, 0.008, 6, 16, Math.PI), tin, [0, 0.02, 0], [0, Math.PI / 2, 0]);
    add(new THREE.CylinderGeometry(0.06, 0.065, 0.09, 16), tin, [0, -0.05, 0]);
    add(new THREE.CylinderGeometry(0.008, 0.013, 0.13, 8), tin, [0, -0.04, 0.09], [1.0, 0, 0]);
    add(new THREE.ConeGeometry(0.022, 0.025, 10, 1, true), tin, [0, 0.0, 0.145], [-0.55, 0, 0]);
  } else {
    // lampáš: krúžok, strieška, sklo so svetlom, spodok; visí dole z úchopu
    const iron = m('#3b3532', { metalness: 0.4 });
    add(new THREE.TorusGeometry(0.018, 0.004, 6, 14), iron, [0, -0.015, 0]);
    add(new THREE.ConeGeometry(0.045, 0.035, 8), iron, [0, -0.045, 0]);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8), m('#fff1c4', { emissive: col('#ffb347'), emissiveIntensity: 2.2, transparent: true, opacity: 0.9 }), [0, -0.1, 0]).name = 'flame';
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; add(new THREE.BoxGeometry(0.006, 0.075, 0.006), iron, [Math.cos(a) * 0.033, -0.1, Math.sin(a) * 0.033]); }
    add(new THREE.CylinderGeometry(0.04, 0.035, 0.015, 8), iron, [0, -0.142, 0]);
  }
  return g;
}
// Ako sa náradie drží v ruke (natočenie voči úchytu ruky): motyka a krompáč šikmo dopredu a dole, krhla za držadlo
const HELD_ROT: Readonly<Record<ToolId, [number, number, number]>> = { hoe: [-0.9, 0, 0], pick: [-0.9, 0, 0], can: [-Math.PI / 2, 0, 0], lamp: [-Math.PI / 2, 0, 0] };
// Miesta na nosiči na chrbte (posun voči úchytu chrbta, natočenie)
const BACK_SLOTS: readonly { p: [number, number, number]; r: [number, number, number] }[] = [
  { p: [0.07, -0.12, 0], r: [0, 0, -0.25] }, { p: [-0.07, -0.12, 0], r: [0, 0, 0.25] }, { p: [0.0, 0.05, -0.02], r: [0, Math.PI, 0] }, { p: [0.1, 0.06, -0.01], r: [0, Math.PI, 0] }
];

// ---------- robot ----------
export interface Robot3D {
  readonly group: THREE.Group; readonly model: RobotModel;
  // náradie: held = v ruke, carried = ostatné vlastnené (na chrbte; held sa na chrbte nezobrazí)
  setTools(held: ToolId | null, carried: readonly ToolId[]): void;
  pose(o: PoseOpts): void;
  // úchyt vo svete (po pose; napr. kde svieti lampáš)
  mountWorld(id: MountId, out?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}
export function buildRobot(look: RobotLook): Robot3D {
  const model = RM.robotModel(look), mats = materials(model.look);
  const group = new THREE.Group(); group.name = 'robot:' + model.look.style;
  const joints = new Map<JointId, THREE.Group>();
  const jointBase = new Map<THREE.Object3D, readonly [number, number, number]>(), partBase = new Map<THREE.Object3D, THREE.Vector3>();
  const steamMats: THREE.MeshStandardMaterial[] = [];
  for (const j of model.joints) {
    const o = new THREE.Group(); o.name = j.id; o.position.set(...j.p);
    jointBase.set(o, j.p);
    joints.set(j.id, o);
    (j.parent ? must(joints.get(j.parent)) : group).add(o);
  }
  const tagged = new Map<string, THREE.Mesh[]>();
  const partMesh = (p: Part): THREE.Mesh => {
    // para má každý obláčik vlastný materiál (mení sa mu priehľadnosť)
    const mat = p.tag === 'steam' ? mats[p.m].clone() : mats[p.m];
    if (p.tag === 'steam') steamMats.push(mat);
    const me = new THREE.Mesh(geometry(p.shape), mat);
    me.position.set(...p.p); if (p.r) me.rotation.set(...p.r);
    me.castShadow = p.m !== 'glass'; me.receiveShadow = true;
    if (p.tag) { let a = tagged.get(p.tag); if (!a) tagged.set(p.tag, a = []); a.push(me); partBase.set(me, me.position.clone()); }
    return me;
  };
  for (const p of model.parts) must(joints.get(p.j)).add(partMesh(p));
  // viečka sú zavreté posunuté dole (oči zakryjú), otvorené hore
  const lids = tagged.get('lid') ?? [];
  const mountGroup = (id: MountId): THREE.Group => {
    const mt = model.mounts[id], g = new THREE.Group();
    g.position.set(...mt.p); if (mt.r) g.rotation.set(...mt.r);
    must(joints.get(mt.j)).add(g);
    return g;
  };
  const hand = mountGroup('handR'), back = mountGroup('back');
  let lamp: THREE.Group | null = null;
  const tools: THREE.Group[] = [];
  function setTools(held: ToolId | null, carried: readonly ToolId[]): void {
    for (const t of tools) {
      t.removeFromParent();
      TOOL_FREE.get(t)?.();
    }
    tools.length = 0; lamp = null;
    if (held) {
      const t = toolMesh(held); t.rotation.set(...HELD_ROT[held]); hand.add(t); tools.push(t);
      if (held === 'lamp') lamp = t;
    }
    let i = 0;
    for (const c of carried) {
      if (c === held) continue;
      const slot = BACK_SLOTS[i++];
      if (!slot) break;
      const t = toolMesh(c); t.position.set(...slot.p); t.rotation.set(...slot.r); t.scale.setScalar(0.85);
      if (c === 'can' || c === 'lamp') t.position.y += 0.04;
      back.add(t); tools.push(t);
    }
    held0 = held;
  }
  let held0: ToolId | null = null;
  const q = new THREE.Quaternion(), qr = new THREE.Quaternion();
  function pose(o: PoseOpts): void {
    const P = RM.robotPose(model, { ...o, holding: o.holding ?? !!held0 });
    for (const [id, g] of joints) {
      const jp = P.joints.get(id), base = must(jointBase.get(g));
      if (jp) g.rotation.set(...jp.r); else g.rotation.set(0, 0, 0);
      const d = jp?.d ?? [0, 0, 0];
      g.position.set(base[0] + d[0], base[1] + d[1], base[2] + d[2]);
    }
    group.position.y = o.jz ?? 0;
    for (const l of lids) l.position.y = must(partBase.get(l)).y - P.blink * 0.03;
    for (const [k, s] of (tagged.get('steam') ?? []).entries()) {
      const b = must(partBase.get(s)), f = (P.steam + k / 3) % 1;
      s.position.set(b.x + f * 0.03, b.y - 0.05 + f * 0.15, b.z); s.scale.setScalar(0.4 + f);
      const sm = steamMats[k]; if (sm) sm.opacity = 0.35 * (1 - f);
    }
    // lampáš visí kolmo dole bez ohľadu na natočenie ruky (kýve sa len trochu)
    if (lamp) {
      group.updateMatrixWorld(true);
      hand.getWorldQuaternion(q).invert();
      group.getWorldQuaternion(qr);
      lamp.quaternion.copy(q.multiply(qr));
      lamp.rotateX(Math.sin((o.phase ?? 0) * 2) * (o.walking ? 0.12 : 0));
    }
  }
  function mountWorld(id: MountId, out = new THREE.Vector3()): THREE.Vector3 {
    group.updateMatrixWorld(true);
    if (id === 'handR' && lamp) { const f = lamp.getObjectByName('flame'); if (f) return f.getWorldPosition(out); }
    return (id === 'handR' ? hand : id === 'back' ? back : must(joints.get(model.mounts[id].j))).getWorldPosition(out);
  }
  function dispose(): void { for (const m of [...Object.values(mats), ...steamMats]) m.dispose(); group.removeFromParent(); }
  setTools(null, []);
  pose({});
  return { group, model, setTools, pose, mountWorld, dispose };
}
