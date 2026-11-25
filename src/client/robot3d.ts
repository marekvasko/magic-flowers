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
function roundedBox(sx: number, sy: number, sz: number, r0: number, seg = r0 >= 0.03 ? 2 : 1): THREE.BufferGeometry {
  // ostrá hrana: obyčajná kocka (inak by normály na hrane rozmazali tieň do plochy a hrana by vyzerala oblá)
  if (r0 <= 0.005) return new THREE.BoxGeometry(sx, sy, sz);
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
// počet stien okolo osi podľa polomeru (r × k), v rozsahu min…max
const segs = (r: number, k: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(r * k)));
function geometry(s: Shape): THREE.BufferGeometry {
  const key = JSON.stringify(s);
  let g = GEO.get(key);
  if (g) return g;
  switch (s.k) {
    case 'box': g = roundedBox(s.s[0], s.s[1], s.s[2], s.r); break;
    // Málo polygónov (robotov je na ploche veľa): počet stien podľa veľkosti, gule ako dvadsaťsteny (malé nity a oči
    // 20 trojuholníkov, stredné 80, veľké 320) namiesto presných gúľ. S počtom stien n je diel mnohosten
    // (ostré hrany, ploché tieňovanie – materiál flatShading).
    case 'cyl': g = new THREE.CylinderGeometry(s.r2 ?? s.r, s.r, s.h, s.n ?? segs(s.r, 90, 6, 16)); break;
    case 'sphere': g = s.n ? new THREE.SphereGeometry(s.r, s.n, Math.max(4, Math.round(s.n * 0.6))) : new THREE.IcosahedronGeometry(s.r, s.r < 0.02 ? 0 : s.r < 0.07 ? 1 : 2); if (s.s) g.scale(...s.s); break;
    case 'capsule': g = new THREE.CapsuleGeometry(s.r, s.h, 1, s.n ?? 6); break;
    case 'torus': g = new THREE.TorusGeometry(s.r, s.t, 4, segs(s.r, 100, 8, 16)); g.rotateX(Math.PI / 2); break;
    case 'dome': g = new THREE.SphereGeometry(s.r, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2); break;
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
    add(new THREE.CylinderGeometry(0.011, 0.011, 0.42, 6), wood, [0, 0.12, 0]);
    add(roundedBox(0.1, 0.012, 0.07, 0.005), steel, [0, 0.33, 0.035]);
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6), steel, [0, 0.33, 0.005], [Math.PI / 2, 0, 0]);
  } else if (id === 'pick') {
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.38, 6), wood, [0, 0.1, 0]);
    for (const s of [-1, 1]) add(new THREE.ConeGeometry(0.016, 0.11, 6), steel, [s * 0.055, 0.29, 0], [0, 0, -s * 1.4]);
    add(roundedBox(0.04, 0.035, 0.035, 0.008), steel, [0, 0.29, 0]);
  } else if (id === 'can') {
    // krhla: oblúk držadla sedí na vrchu tela (konce oblúka v y 0,02 = vrch tela), telo pod ním,
    // hubica od spodku tela šikmo hore dopredu, na nej ružica
    const tin = m('#6aa0b8', { metalness: 0.35, roughness: 0.4 });
    add(new THREE.TorusGeometry(0.035, 0.008, 4, 8, Math.PI), tin, [0, 0.02, 0], [0, Math.PI / 2, 0]);
    add(new THREE.CylinderGeometry(0.06, 0.065, 0.09, 10), tin, [0, -0.025, 0]);
    add(new THREE.CylinderGeometry(0.008, 0.013, 0.13, 6), tin, [0, -0.015, 0.09], [1.0, 0, 0]);
    add(new THREE.ConeGeometry(0.022, 0.025, 6, 1, true), tin, [0, 0.025, 0.145], [-0.55, 0, 0]);
  } else {
    // lampáš: krúžok, strieška, sklo so svetlom, spodok; visí dole z úchopu
    const iron = m('#3b3532', { metalness: 0.4 });
    add(new THREE.TorusGeometry(0.018, 0.004, 4, 8), iron, [0, -0.015, 0]);
    add(new THREE.ConeGeometry(0.045, 0.035, 8), iron, [0, -0.045, 0]);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8), m('#fff1c4', { emissive: col('#ffb347'), emissiveIntensity: 2.2, transparent: true, opacity: 0.9 }), [0, -0.1, 0]).name = 'flame';
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; add(new THREE.BoxGeometry(0.006, 0.075, 0.006), iron, [Math.cos(a) * 0.033, -0.1, Math.sin(a) * 0.033]); }
    add(new THREE.CylinderGeometry(0.04, 0.035, 0.015, 8), iron, [0, -0.142, 0]);
  }
  return g;
}
// Úchop náradia: bod na rúčke / držadle (v súradniciach modelu náradia), ktorý je v strede klepeta, a natočenie, ktoré
// otočí rúčku do osi z klepeta. Motyka a krompáč za spodok rúčky (os y náradia → z; čepeľ motyky dopredu, hlavica
// krompáča dopredu a dozadu), krhla za vrch oblúka držadla (ten ide pozdĺž z), lampáš za vrch krúžku (ten ide pozdĺž x).
const GRIP: Readonly<Record<ToolId, { p: [number, number, number]; r: [number, number, number] }>> = {
  hoe: { p: [0, -0.03, 0], r: [Math.PI / 2, 0, 0] },
  pick: { p: [0, -0.03, 0], r: [Math.PI / 2, Math.PI / 2, 0] },
  can: { p: [0, 0.055, 0], r: [0, 0, 0] },
  lamp: { p: [0, 0.003, 0], r: [0, -Math.PI / 2, 0] }
};

// ---------- robot ----------
export interface Robot3D {
  readonly group: THREE.Group; readonly model: RobotModel;
  // náradie: held = v ruke, carried = ostatné vlastnené (na chrbte; held sa na chrbte nezobrazí)
  setTools(held: ToolId | null, carried: readonly ToolId[]): void;
  // výmena náradia s animáciou (RM.SWAP): držané náradie prehodí dozadu do jeho držiaka, nosič vystrelí nové náradie
  // ponad hlavu do klepeta. Náradie to musí mať na nosiči (inak sa vymení hneď). Priebeh posúva pose(o, dt).
  switchTool(to: ToolId | null): void;
  readonly switching: () => boolean;
  // dt (s): kĺby sa k póze ťahajú najviac rýchlosťou RM.jointSpeed (nehýbu sa okamžite); bez dt sa nastavia hneď
  pose(o: PoseOpts, dt?: number): void;
  // úchyt vo svete (po pose; napr. kde svieti lampáš)
  mountWorld(id: MountId, out?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}
export function buildRobot(look: RobotLook): Robot3D {
  const model = RM.robotModel(look), mats = materials(model.look);
  const group = new THREE.Group(); group.name = `robot:${model.look.loco}/${model.look.body}/${model.look.head}`;
  const joints = new Map<JointId, THREE.Group>();
  const jointBase = new Map<THREE.Object3D, readonly [number, number, number]>(), partBase = new Map<THREE.Object3D, THREE.Vector3>();
  const steamMats: THREE.MeshStandardMaterial[] = [];
  for (const j of model.joints) {
    const o = new THREE.Group(); o.name = j.id; o.position.set(...j.p);
    jointBase.set(o, j.p);
    joints.set(j.id, o);
    if (!j.parent) o.scale.setScalar(model.scale); // koreň nesie zmenšenie celého robota
    (j.parent ? must(joints.get(j.parent)) : group).add(o);
  }
  // materiály s plochým tieňovaním pre ostré diely (mnohosteny), jeden na druh materiálu
  const flatMats = new Map<Mat, THREE.MeshStandardMaterial>();
  const flatMat = (m: Mat): THREE.MeshStandardMaterial => { let f = flatMats.get(m); if (!f) { f = mats[m].clone(); f.flatShading = true; flatMats.set(m, f); } return f; };
  const tagged = new Map<string, THREE.Mesh[]>();
  const partMesh = (p: Part): THREE.Mesh => {
    // para má každý obláčik vlastný materiál (mení sa mu priehľadnosť)
    const mat = p.tag === 'steam' ? mats[p.m].clone() : p.flat ? flatMat(p.m) : mats[p.m];
    if (p.tag === 'steam') steamMats.push(mat);
    const me = new THREE.Mesh(geometry(p.shape), mat);
    me.position.set(...p.p); if (p.r) me.rotation.set(...p.r);
    if (p.tag) me.name = p.tag; // napr. holder:hoe – držiak náradia na nosiči
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
  const hand = mountGroup('handR');
  // miesta náradia na nosiči (puzdrá a háčiky)
  const slotGroup = (tool: ToolId): THREE.Group => {
    const sl = model.slots[tool], g = new THREE.Group();
    g.position.set(...sl.p); if (sl.r) g.rotation.set(...sl.r); g.scale.setScalar(sl.s ?? 1);
    must(joints.get(sl.j)).add(g);
    return g;
  };
  const slots: Record<ToolId, THREE.Group> = { hoe: slotGroup('hoe'), can: slotGroup('can'), pick: slotGroup('pick'), lamp: slotGroup('lamp') };
  let lamp: THREE.Group | null = null, hanging: THREE.Group | null = null;
  const tools: THREE.Group[] = [];                    // všetky siete náradia (na uvoľnenie)
  const stored = new Map<ToolId, THREE.Group>();      // náradie v držiakoch na nosiči
  let heldObj: THREE.Group | null = null;             // náradie v klepete (alebo značka, kam priletí)
  // úchop → (zavesené: kĺb, ktorý sa otáča okolo držadla, aby náradie viselo dole) → natočenie rúčky → náradie
  function attachHeld(tool: ToolId, obj: THREE.Group): void {
    const g = GRIP[tool], frame = new THREE.Group(), pivot = new THREE.Group();
    obj.position.set(-g.p[0], -g.p[1], -g.p[2]); obj.quaternion.identity(); obj.scale.setScalar(1);
    frame.rotation.set(...g.r); frame.add(obj);
    pivot.add(frame); hand.add(pivot);
    hanging = RM.TOOL_HOLD[tool] === 'hang' ? pivot : null;
    heldObj = obj;
    lamp = tool === 'lamp' ? obj : null;
  }
  function dropHeld(): void { const pv = heldObj?.parent?.parent; pv?.removeFromParent(); heldObj = null; hanging = null; lamp = null; }
  function setTools(held: ToolId | null, carried: readonly ToolId[]): void {
    for (const t of tools) {
      t.removeFromParent();
      TOOL_FREE.get(t)?.();
    }
    tools.length = 0; stored.clear(); dropHeld(); flights.length = 0; swap = null;
    if (held) { const t = toolMesh(held); tools.push(t); attachHeld(held, t); }
    // ostatné vlastnené náradie na svojom mieste na nosiči (rúčkou v puzdre alebo zavesené na háčiku)
    for (const c of new Set(carried)) {
      if (c === held) continue;
      const t = toolMesh(c); slots[c].add(t); tools.push(t); stored.set(c, t);
    }
    held0 = held;
  }
  // ---------- výmena náradia (let po pevnej dráhe) ----------
  // Let: náradie je dieťa robota (group), poloha a natočenie z matíc v súradniciach robota. Dráha je parabola od začiatku
  // k cieľu (cieľ sa čita v každom snímku – ruka sa môže hýbať, náradie aj tak skončí presne v klepete), vrchol vysoko
  // nad hlavou (aj dlhá motyka ju minie) a oblúk do strany (na strane ruky, mimo hlavy); natočenie sa plynulo mení
  // z polohy na nosiči do polohy v ruke; mierka z nosiča (0,75) na ruku (1).
  interface Flight { obj: THREE.Object3D; t0: number; start: THREE.Matrix4; target: () => THREE.Object3D; land: () => void }
  const flights: Flight[] = [];
  interface Swap { t: number; from: ToolId | null; to: ToolId | null; launch: number; end: number; tossed: boolean; launched: boolean; marker: THREE.Object3D | null }
  let swap: Swap | null = null;
  const inv = new THREE.Matrix4(), mB = new THREE.Matrix4();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), sA = new THREE.Vector3(), sB = new THREE.Vector3();
  const ease3 = (x: number): number => x * x * (3 - 2 * x);
  const local = (o: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 => out.multiplyMatrices(inv.copy(group.matrixWorld).invert(), o.matrixWorld);
  function fly(obj: THREE.Object3D, target: () => THREE.Object3D, land: () => void, t0: number): void {
    group.updateMatrixWorld(true);
    const start = local(obj, new THREE.Matrix4());
    group.add(obj); obj.matrixAutoUpdate = true;
    flights.push({ obj, t0, start, target, land });
  }
  function stepFlights(t: number): void {
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = must(flights[i]), k = Math.max(0, Math.min(1, (t - f.t0) / RM.SWAP.flight));
      group.updateMatrixWorld(true);
      f.start.decompose(pA, qA, sA); local(f.target(), mB).decompose(pB, qB, sB);
      const top = model.height * model.scale + RM.SWAP.apex, h = Math.max(0.08, top - Math.max(pA.y, pB.y));
      const arc = 4 * k * (1 - k);
      // najprv preč od robota (z nosiča dozadu, z ruky dopredu), na konci prilieta zo svojej strany
      f.obj.position.lerpVectors(pA, pB, k); f.obj.position.y += h * arc; f.obj.position.x += Math.sign(pA.x + pB.x) * 0.1 * arc;
      f.obj.position.z += Math.sign(pA.z) * 0.2 * arc * (1 - k) + Math.sign(pB.z) * 0.2 * arc * k;
      f.obj.quaternion.slerpQuaternions(qA, qB, ease3(k));
      f.obj.scale.lerpVectors(sA, sB, k);
      if (k >= 1) { flights.splice(i, 1); f.land(); }
    }
  }
  function switchTool(to: ToolId | null): void {
    const from = swap ? swap.to : held0;
    if (swap || from === to) { if (from !== to) { const owned = [...stored.keys(), ...(held0 ? [held0] : [])]; setTools(to, owned); } return; }
    if (to && !stored.has(to)) { setTools(to, [...stored.keys(), ...(from ? [from] : [])]); return; } // nie je na nosiči – hneď
    const launch = from ? RM.SWAP.toss + RM.SWAP.flight : 0;
    swap = { t: 0, from, to, launch, end: RM.swapTime(from, to), tossed: !from, launched: !to, marker: null };
  }
  function stepSwap(dt: number): 'toss' | 'catch' | null {
    const sw = swap;
    if (!sw) return null;
    sw.t += dt;
    // 1) prehodenie držaného náradia dozadu do jeho držiaka
    if (!sw.tossed && sw.t >= RM.SWAP.toss && sw.from && heldObj) {
      sw.tossed = true;
      const obj = heldObj, from = sw.from;
      group.updateMatrixWorld(true);
      group.attach(obj); dropHeld(); held0 = null;
      fly(obj, () => slots[from], () => { slots[from].add(obj); obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.setScalar(1); stored.set(from, obj); }, RM.SWAP.toss);
    }
    // 2) výstrel nového náradia z nosiča do klepeta (cieľ = značka v klepete, kde náradie bude držané)
    if (!sw.launched && sw.to && sw.t >= sw.launch) {
      sw.launched = true;
      const to = sw.to, obj = must(stored.get(to)), marker = new THREE.Group();
      stored.delete(to);
      attachHeld(to, marker); sw.marker = marker; held0 = null;
      group.updateMatrixWorld(true);
      group.attach(obj);
      fly(obj, () => marker, () => {
        dropHeld(); // odstráni úchop so značkou
        attachHeld(to, obj); held0 = to;
      }, sw.launch);
    }
    stepFlights(sw.t);
    const catching = sw.to && sw.t >= sw.launch - RM.SWAP.prep && sw.t < sw.launch + RM.SWAP.flight + 0.05;
    const tossing = sw.from && sw.t < RM.SWAP.toss + 0.1;
    if (sw.t >= sw.end && !flights.length) swap = null;
    return tossing ? 'toss' : catching ? 'catch' : null;
  }
  let held0: ToolId | null = null;
  const q = new THREE.Quaternion(), up = new THREE.Vector3(), bar = new THREE.Vector3(), side = new THREE.Vector3(), lastBar = new THREE.Vector3(0, 0, 1), basis = new THREE.Matrix4();
  const cur = new Map<THREE.Object3D, { r: [number, number, number]; d: [number, number, number] }>();
  const step = (a: number, b: number, max: number): number => a + Math.max(-max, Math.min(max, b - a));
  function pose(o: PoseOpts, dt?: number): void {
    const sw = stepSwap(dt ?? 0);
    const P = RM.robotPose(model, { ...o, swap: o.swap !== undefined ? o.swap : sw, use: o.use !== undefined ? o.use : null, hold: o.hold !== undefined ? o.hold : held0 ? RM.TOOL_HOLD[held0] : null, digWith: o.digWith !== undefined ? o.digWith : held0 });
    for (const [id, g] of joints) {
      const jp = P.joints.get(id), base = must(jointBase.get(g)), tr = jp?.r ?? [0, 0, 0], td = jp?.d ?? [0, 0, 0];
      const sp = RM.jointSpeed(id), c = cur.get(g);
      if (!c || dt === undefined || !Number.isFinite(sp)) cur.set(g, { r: [tr[0], tr[1], tr[2]], d: [td[0], td[1], td[2]] });
      else {
        const a = sp * dt, l = 0.8 * dt; // posun (pohupovanie, prikrčenie) najviac 0,8 políčka/s
        c.r = [step(c.r[0], tr[0], a), step(c.r[1], tr[1], a), step(c.r[2], tr[2], a)];
        c.d = [step(c.d[0], td[0], l), step(c.d[1], td[1], l), step(c.d[2], td[2], l)];
      }
      const n = must(cur.get(g));
      g.rotation.set(...n.r);
      g.position.set(base[0] + n.d[0], base[1] + n.d[1], base[2] + n.d[2]);
    }
    group.position.y = o.jz ?? 0;
    for (const l of lids) l.position.y = must(partBase.get(l)).y - P.blink * 0.03;
    for (const [k, s] of (tagged.get('steam') ?? []).entries()) {
      const b = must(partBase.get(s)), f = (P.steam + k / 3) % 1;
      s.position.set(b.x + f * 0.03, b.y - 0.05 + f * 0.15, b.z); s.scale.setScalar(0.4 + f);
      const sm = steamMats[k]; if (sm) sm.opacity = 0.35 * (1 - f);
    }
    // Zavesené náradie (krhla, lampáš) visí vždy zvislo dolu (gravitácia), držadlo je čo najbližšie k osi klepeta (z ruky)
    // a nikdy sa neprevráti: os y kĺbu = hore vo svete, os z = os klepeta premietnutá do vodorovnej roviny (keď je klepeto
    // zvislo, použije sa os x ruky); znamienko osi z ostáva ako v predošlom snímku, aby náradie neprehodilo o 180°.
    if (hanging && P.rigid) hanging.quaternion.identity(); // pri polievaní drží krhlu pevne v klepete a nakláňa ju
    else if (hanging) {
      group.updateMatrixWorld(true);
      hand.getWorldQuaternion(q).invert();
      up.set(0, 1, 0).applyQuaternion(q);
      bar.set(0, 0, 1).addScaledVector(up, -up.z);
      if (bar.lengthSq() < 0.04) bar.set(1, 0, 0).addScaledVector(up, -up.x);
      bar.normalize();
      if (bar.dot(lastBar) < 0) bar.negate();
      lastBar.copy(bar);
      side.crossVectors(up, bar);
      basis.makeBasis(side, up, bar);
      hanging.quaternion.setFromRotationMatrix(basis);
      hanging.rotateX(Math.sin((o.phase ?? 0) * 2) * (o.walking ? 0.12 : 0));
    }
    water(P.pour, o.use?.t ?? o.t ?? 0);
  }
  // voda z ružice krhly pri polievaní: kvapky padajú po parabole, kým je krhla naklonená
  const dropMat = new THREE.MeshStandardMaterial({ color: col('#8fd3ff'), roughness: 0.1, transparent: true, opacity: 0.8 });
  const dropGeo = new THREE.IcosahedronGeometry(0.008, 0);
  const drops = Array.from({ length: 12 }, () => { const d = new THREE.Mesh(dropGeo, dropMat); d.name = 'water'; d.visible = false; group.add(d); return d; });
  const rose = new THREE.Vector3(), roseDir = new THREE.Vector3(), dp = new THREE.Vector3();
  function water(pour: number, t: number): void {
    const can = pour > 0.55 ? group.getObjectByName('tool:can') : undefined;
    for (const [i, d] of drops.entries()) {
      d.visible = false;
      if (!can) continue;
      can.localToWorld(rose.set(0, 0.03, 0.16));
      can.localToWorld(roseDir.set(0, -0.25, 1)).sub(can.localToWorld(dp.set(0, 0, 0))).normalize().multiplyScalar(0.45);
      const a = ((t * 2.2 + i / drops.length) % 1) * 0.45;
      dp.copy(rose).addScaledVector(roseDir, a); dp.y -= 4.9 * a * a;
      if (dp.y < 0) continue;
      d.visible = true; d.position.copy(group.worldToLocal(dp));
    }
  }
  function mountWorld(id: MountId, out = new THREE.Vector3()): THREE.Vector3 {
    group.updateMatrixWorld(true);
    if (id === 'handR' && lamp) { const f = lamp.getObjectByName('flame'); if (f) return f.getWorldPosition(out); }
    return (id === 'handR' ? hand : must(joints.get(model.mounts[id].j))).getWorldPosition(out);
  }
  function dispose(): void { for (const m of [...Object.values(mats), ...steamMats, ...flatMats.values(), dropMat]) m.dispose(); dropGeo.dispose(); for (const t of tools) TOOL_FREE.get(t)?.(); group.removeFromParent(); }
  setTools(null, []);
  pose({});
  return { group, model, setTools, switchTool, switching: () => swap !== null, pose, mountWorld, dispose };
}
