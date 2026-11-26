// 3D robot hráča (#194): Three.js sieť z opisu shared/robotmodel.ts – kĺby sú skupiny, diely hladké siete s materiálmi
// podľa vzhľadu (náter, doplnková farba, svetlo očí, hrdza). Náradie: to, ktoré hráč drží, je v pravej ruke
// (lampáš visí kolmo dole, svieti), ostatné vlastnené náradie je na nosiči na chrbte.
// Kreslí ho /debug → Robots (každý diel vlastná sieť so štandardným materiálom Three.js) aj hra (render3d.ts): tam
// dostane „backend“ (RobotBackend), ktorý diely zlúči do jednej siete so shaderom sveta – kĺby ostávajú skupiny.
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

// tá istá geometria s plochými stenami (každý trojuholník vlastné normály) – pre ostré diely v zlúčenej sieti
const FLAT = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
function flatGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let f = FLAT.get(g);
  if (!f) { f = g.index ? g.toNonIndexed() : g.clone(); f.computeVertexNormals(); FLAT.set(g, f); }
  return f;
}

// ---------- backend (hra) ----------
// Diel pre zlúčenú sieť: geometria, kĺb (skupina), ku ktorému patrí, poloha voči nemu, farba (sRGB 0–1 bez prevodu –
// shader sveta ráta priamo v sRGB), či svieti, priehľadnosť a miera hrdze
export type RGB = [number, number, number];
export interface BatchItem { geo: THREE.BufferGeometry; node: THREE.Object3D | null; local: THREE.Matrix4; color: RGB; emis: number; alpha: number; rust: number }
export interface RobotBackend {
  // telo robota: všetky diely v jednej (dvoch – nepriehľadné a sklo) sieti; update() po každej póze prenesie polohy kĺbov
  body(items: BatchItem[]): { objects: THREE.Object3D[]; update(): void; dispose(): void };
  // náradie: jedna sieť na kus (node = null, polohy voči náradiu)
  tool(items: BatchItem[]): { objects: THREE.Object3D[]; dispose(): void };
  drop(): THREE.Mesh; // kvapka vody z krhly
}
const rgb = (h: string): RGB => { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
// farby dielov podľa vzhľadu (ako materials(), ale len farba – svetlo ráta shader sveta)
function batchLook(look: RobotLook): Record<Mat, { color: RGB; emis: number; alpha: number; rust: number }> {
  const w = look.wear * 0.25, p = rgb(look.paint), o = rgb('#8a6a4a'), paint: RGB = [p[0] + (o[0] - p[0]) * w, p[1] + (o[1] - p[1]) * w, p[2] + (o[2] - p[2]) * w];
  const m = (color: RGB, emis = 0, alpha = 1, rust = 0): { color: RGB; emis: number; alpha: number; rust: number } => ({ color, emis, alpha, rust });
  return {
    paint: m(paint, 0, 1, look.wear), accent: m(rgb(look.accent), 0, 1, look.wear * 0.7), metal: m(rgb('#a9b0b4')), dark: m(rgb('#3a3f43')), rubber: m(rgb('#2c2a28')),
    eye: m(rgb(look.eye), 1), lens: m(rgb('#101518')), glass: m(rgb('#e8f6ff'), 0, 0.35), rust: m(rgb('#a4532a')), warm: m(rgb('#ffb54a'), 1), leaf: m(rgb('#5aa646')), pot: m(rgb('#b8643c'))
  };
}

// ---------- materiály ----------
const col = (h: string): THREE.Color => new THREE.Color(h);
// Hrdza ako textúra v nátere (bez dielov navyše a bez UV): v shaderi sa z polohy na povrchu dielu ráta šum v troch
// mierkach; kde prekročí prah (podľa wear – čím ošúchanejší robot, tým viac), náter prejde cez tmavší lem do hrdzavej
// farby so zrnením a povrch je tam drsnejší a nekovový. wear = 0 → žiadna hrdza. Miera je v userData.rust.
export const RUST_GLSL = `
float rHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rHash(i), rHash(i + vec3(1, 0, 0)), f.x), mix(rHash(i + vec3(0, 1, 0)), rHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(rHash(i + vec3(0, 0, 1)), rHash(i + vec3(1, 0, 1)), f.x), mix(rHash(i + vec3(0, 1, 1)), rHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float rustMask(vec3 p, float wear) {
  float n = 0.55 * rNoise(p * 9.0) + 0.3 * rNoise(p * 23.0 + 7.0) + 0.15 * rNoise(p * 61.0 + 3.0);
  float th = 0.86 - 0.5 * wear;
  return wear <= 0.0 ? 0.0 : smoothstep(th, th + 0.07, n);
}`;
function rusty(m: THREE.MeshStandardMaterial, wear: number): THREE.MeshStandardMaterial {
  m.userData['rust'] = wear;
  m.onBeforeCompile = shader => {
    shader.uniforms['uRust'] = { value: wear };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRustP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRustP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRustP; uniform float uRust;' + RUST_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float rustK = rustMask(vRustP, uRust), rustG = rNoise(vRustP * 140.0);
        vec3 rustC = mix(vec3(0.42, 0.17, 0.06), vec3(0.72, 0.36, 0.13), rustG);
        diffuseColor.rgb = mix(diffuseColor.rgb * (1.0 - 0.35 * smoothstep(0.0, 0.5, rustK) * (1.0 - rustK)), rustC, rustK);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, rustK);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - rustK;');
  };
  m.customProgramCacheKey = () => 'rust';
  return m;
}
// Materiály robota podľa vzhľadu; ošúchaný náter je o kúsok tmavší a do hneda, s hrdzavými škvrnami (rusty)
function materials(look: RobotLook): Record<Mat, THREE.MeshStandardMaterial> {
  const rustCol = col('#a4532a'), paint = col(look.paint).lerp(col('#8a6a4a'), look.wear * 0.25);
  const std = (c: THREE.Color | string, rough: number, metal: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: typeof c === 'string' ? col(c) : c, roughness: rough, metalness: metal, ...extra });
  return {
    paint: rusty(std(paint, 0.55, 0.1), look.wear),
    accent: rusty(std(col(look.accent), 0.5, 0.25), look.wear * 0.7),
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
type ToolMat = 'wood' | 'steel' | 'tin' | 'iron' | 'flame';
const TOOL_MAT: Readonly<Record<ToolMat, { color: string; metal: number; rough: number; emis?: boolean }>> = {
  wood: { color: '#9a6a3c', metal: 0.1, rough: 0.6 }, steel: { color: '#b7bec2', metal: 0.5, rough: 0.35 }, tin: { color: '#6aa0b8', metal: 0.35, rough: 0.4 },
  iron: { color: '#3b3532', metal: 0.4, rough: 0.6 }, flame: { color: '#fff1c4', metal: 0.1, rough: 0.6, emis: true }
};
function toolMesh(id: ToolId, backend?: RobotBackend): THREE.Group {
  const g = new THREE.Group(); g.name = 'tool:' + id;
  const own: { dispose: () => void }[] = [], items: BatchItem[] = [];
  TOOL_FREE.set(g, () => { for (const o of own) o.dispose(); });
  const mats = new Map<ToolMat, THREE.MeshStandardMaterial>();
  const std = (k: ToolMat): THREE.MeshStandardMaterial => {
    let m = mats.get(k);
    if (!m) { const d = TOOL_MAT[k]; m = new THREE.MeshStandardMaterial({ color: col(d.color), roughness: d.rough, metalness: d.metal, ...(d.emis ? { emissive: col('#ffb347'), emissiveIntensity: 2.2, transparent: true, opacity: 0.9 } : {}) }); mats.set(k, m); own.push(m); }
    return m;
  };
  // diel náradia: v /debug vlastná sieť, v hre položka zlúčenej siete (pomenovaný diel ostane ako prázdny bod – plameň lampáša)
  const add = (geo: THREE.BufferGeometry, k: ToolMat, p: [number, number, number], r?: [number, number, number], name?: string): void => {
    own.push(geo);
    if (!backend) { const me = new THREE.Mesh(geo, std(k)); me.position.set(...p); if (r) me.rotation.set(...r); me.castShadow = true; if (name) me.name = name; g.add(me); return; }
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(r ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
    items.push({ geo, node: null, local, color: rgb(TOOL_MAT[k].color), emis: TOOL_MAT[k].emis ? 1 : 0, alpha: 1, rust: 0 });
    if (name) { const mark = new THREE.Object3D(); mark.name = name; mark.position.set(...p); g.add(mark); }
  };
  if (id === 'hoe') {
    add(new THREE.CylinderGeometry(0.011, 0.011, 0.42, 6), 'wood', [0, 0.12, 0]);
    add(roundedBox(0.1, 0.012, 0.07, 0.005), 'steel', [0, 0.33, 0.035]);
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6), 'steel', [0, 0.33, 0.005], [Math.PI / 2, 0, 0]);
  } else if (id === 'pick') {
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.38, 6), 'wood', [0, 0.1, 0]);
    for (const s of [-1, 1]) add(new THREE.ConeGeometry(0.016, 0.11, 6), 'steel', [s * 0.055, 0.29, 0], [0, 0, -s * 1.4]);
    add(roundedBox(0.04, 0.035, 0.035, 0.008), 'steel', [0, 0.29, 0]);
  } else if (id === 'can') {
    // krhla: oblúk držadla sedí na vrchu tela (konce oblúka v y 0,02 = vrch tela), telo pod ním,
    // hubica od spodku tela šikmo hore dopredu, na nej ružica
    add(new THREE.TorusGeometry(0.035, 0.008, 4, 8, Math.PI), 'tin', [0, 0.02, 0], [0, Math.PI / 2, 0]);
    add(new THREE.CylinderGeometry(0.06, 0.065, 0.09, 10), 'tin', [0, -0.025, 0]);
    add(new THREE.CylinderGeometry(0.008, 0.013, 0.13, 6), 'tin', [0, -0.015, 0.09], [1.0, 0, 0]);
    add(new THREE.ConeGeometry(0.022, 0.025, 6, 1, true), 'tin', [0, 0.025, 0.145], [-0.55, 0, 0]);
  } else {
    // lampáš: krúžok, strieška, sklo so svetlom, spodok; visí dole z úchopu
    add(new THREE.TorusGeometry(0.018, 0.004, 4, 8), 'iron', [0, -0.015, 0]);
    add(new THREE.ConeGeometry(0.045, 0.035, 8), 'iron', [0, -0.045, 0]);
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8), 'flame', [0, -0.1, 0], undefined, 'flame');
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; add(new THREE.BoxGeometry(0.006, 0.075, 0.006), 'iron', [Math.cos(a) * 0.033, -0.1, Math.sin(a) * 0.033]); }
    add(new THREE.CylinderGeometry(0.04, 0.035, 0.015, 8), 'iron', [0, -0.142, 0]);
  }
  if (backend) { const h = backend.tool(items); g.add(...h.objects); own.push(h); }
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
  // výmena náradia s fyzikou (RM.SWAP, šikmý vrh): ruka držané náradie rozbehne a pustí – po parabole padne do svojho
  // držiaka; držiak nového náradia sa natočí, vymrští ho a to po parabole dopadne do čakajúceho klepeta.
  // Náradie to musí mať na nosiči (inak sa vymení hneď). Priebeh posúva pose(o, dt).
  switchTool(to: ToolId | null): void;
  readonly switching: () => boolean;
  // dt (s): kĺby sa k póze ťahajú najviac rýchlosťou RM.jointSpeed (nehýbu sa okamžite); bez dt sa nastavia hneď
  pose(o: PoseOpts, dt?: number): void;
  // úchyt vo svete (po pose; napr. kde svieti lampáš)
  mountWorld(id: MountId, out?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}
export function buildRobot(look: RobotLook, backend?: RobotBackend): Robot3D {
  const model = RM.robotModel(look), mats = materials(model.look), bl = batchLook(model.look);
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
  // (clone neprenáša úpravu shadera – hrdza sa na kópiu náteru pridá znova)
  const flatMat = (m: Mat): THREE.MeshStandardMaterial => { let f = flatMats.get(m); if (!f) { f = mats[m].clone(); f.flatShading = true; const w: unknown = mats[m].userData['rust']; if (typeof w === 'number') rusty(f, w); flatMats.set(m, f); } return f; };
  const tagged = new Map<string, THREE.Object3D[]>(), items: BatchItem[] = [];
  const tag = (t: string, o: THREE.Object3D): void => { let a = tagged.get(t); if (!a) tagged.set(t, a = []); a.push(o); partBase.set(o, o.position.clone()); };
  const partMesh = (p: Part): THREE.Object3D => {
    // para má každý obláčik vlastný materiál (mení sa mu priehľadnosť)
    const mat = p.tag === 'steam' ? mats[p.m].clone() : p.flat ? flatMat(p.m) : mats[p.m];
    if (p.tag === 'steam') steamMats.push(mat);
    const me = new THREE.Mesh(geometry(p.shape), mat);
    me.position.set(...p.p); if (p.r) me.rotation.set(...p.r);
    if (p.tag) me.name = p.tag; // napr. holder:hoe – držiak náradia na nosiči
    me.castShadow = p.m !== 'glass'; me.receiveShadow = true;
    if (p.tag) tag(p.tag, me);
    return me;
  };
  // hra (backend): diely sa nezaradia ako siete, ale ako položky zlúčenej siete; diel, ktorý sa hýbe zvlášť (viečko,
  // para…), má vlastnú prázdnu skupinu, ostatné patria priamo kĺbu
  const partItem = (p: Part): void => {
    const joint = must(joints.get(p.j)), geo = p.flat ? flatGeometry(geometry(p.shape)) : geometry(p.shape), look1 = bl[p.m];
    const pos = new THREE.Vector3(...p.p), rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.r ?? [0, 0, 0])));
    if (p.tag) {
      const node = new THREE.Group(); node.name = p.tag; node.position.copy(pos); node.quaternion.copy(rot); joint.add(node);
      tag(p.tag, node);
      items.push({ geo, node, local: new THREE.Matrix4(), ...look1 });
    } else items.push({ geo, node: joint, local: new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1)), ...look1 });
  };
  for (const p of model.parts) { if (backend) partItem(p); else must(joints.get(p.j)).add(partMesh(p)); }
  const bodyH = backend ? backend.body(items) : null;
  if (bodyH) group.add(...bodyH.objects);
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
    heldObj = obj; heldPivot = pivot;
    lamp = tool === 'lamp' ? obj : null;
  }
  let heldPivot: THREE.Group | null = null;           // úchop v klepete (kĺb zaveseného náradia → natočenie rúčky → náradie)
  function dropHeld(): void { heldPivot?.removeFromParent(); heldPivot = null; heldObj = null; hanging = null; lamp = null; }
  function setTools(held: ToolId | null, carried: readonly ToolId[]): void {
    for (const t of tools) {
      t.removeFromParent();
      TOOL_FREE.get(t)?.();
    }
    tools.length = 0; stored.clear(); dropHeld(); flights.length = 0; swap = null;
    if (held) { const t = toolMesh(held, backend); tools.push(t); attachHeld(held, t); }
    // ostatné vlastnené náradie na svojom mieste na nosiči (rúčkou v puzdre alebo zavesené na háčiku)
    for (const c of new Set(carried)) {
      if (c === held) continue;
      const t = toolMesh(c, backend); slots[c].add(t); tools.push(t); stored.set(c, t);
    }
    held0 = held;
  }
  // ---------- výmena náradia: šikmý vrh v súradniciach trupu ----------
  const bodyJ = must(joints.get('body')), rackJ = must(joints.get('rack'));
  const holders: Record<ToolId, THREE.Group> = { hoe: must(joints.get('holder:hoe')), can: must(joints.get('holder:can')), pick: must(joints.get('holder:pick')), lamp: must(joints.get('holder:lamp')) };
  const armJ = [must(joints.get('shoulderR')), must(joints.get('elbowR')), must(joints.get('handR'))] as const;
  const ease3 = (x: number): number => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
  const tmpM = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Vector3(), ID = new THREE.Quaternion();
  // matica objektu v súradniciach trupu
  const inBody = (o: THREE.Object3D): THREE.Matrix4 => { group.updateMatrixWorld(true); return new THREE.Matrix4().multiplyMatrices(tmpM.copy(bodyJ.matrixWorld).invert(), o.matrixWorld); };
  const v3 = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
  // Kde a ako by bolo náradie v ruke pri danom cieli ruky (ruka sa na chvíľu nastaví, prečíta sa a vráti späť)
  function probeHeld(tool: ToolId, a: RM.ArmTarget): THREE.Matrix4 {
    const saved = armJ.map(g => g.quaternion.clone()), lb = lastBar.clone(), temp = !heldObj, hq = hanging?.quaternion.clone();
    if (temp) attachHeld(tool, new THREE.Group());
    const r = RM.armPlane(model, a);
    armJ[0].rotation.set(...r.sh); armJ[1].rotation.set(...r.el); armJ[2].rotation.set(...r.hd);
    hang(false, 0);
    const m = inBody(must(heldObj ?? undefined));
    armJ.forEach((g, k) => g.quaternion.copy(must(saved[k])));
    lastBar.copy(lb);
    if (temp) dropHeld(); else if (hanging && hq) hanging.quaternion.copy(hq);
    return m;
  }
  // Kde a ako je náradie v držiaku natočenom o aim a vysunutom o d
  function setHolder(tool: ToolId, aim: THREE.Quaternion, d: THREE.Vector3): void {
    const h = holders[tool], b = must(jointBase.get(h));
    h.quaternion.copy(aim); h.position.set(b[0] + d.x, b[1] + d.y, b[2] + d.z);
  }
  function probeSlot(tool: ToolId, aim: THREE.Quaternion, d: THREE.Vector3): THREE.Matrix4 {
    const h = holders[tool], q = h.quaternion.clone(), p = h.position.clone();
    setHolder(tool, aim, d);
    const m = inBody(slots[tool]);
    h.quaternion.copy(q); h.position.copy(p);
    return m;
  }
  // Rovina hodu náradia: zvislá, cez jeho držiak a pravé plece; h = smer od držiaka k plecu (dopredu), yaw = jej natočenie
  function throwPlane(tool: ToolId): { h: THREE.Vector3; yaw: number } {
    const hb = must(jointBase.get(holders[tool])), rb = must(jointBase.get(rackJ));
    const h = new THREE.Vector3(-model.shoulder[0] - (hb[0] + rb[0]), 0, model.shoulder[2] - (hb[2] + rb[2])).normalize();
    return { h, yaw: Math.atan2(h.x, h.z) };
  }
  // vrchol dráhy (v súradniciach trupu): nad temenom robota
  const apexY = (): number => model.height / model.scale - must(jointBase.get(bodyJ))[1] + RM.SWAP.apex;
  const restAxis = (tool: ToolId): THREE.Vector3 => UP.clone().applyQuaternion(slots[tool].quaternion); // os puzdra v pokoji
  const staffTool = (tool: ToolId): boolean => RM.TOOL_HOLD[tool] === 'staff';
  interface Plan {
    tool: ToolId; yaw: number; h: THREE.Vector3;
    phi: number | null;              // natočenie ruky pri pustení / chytení
    aim: THREE.Quaternion;           // natočenie držiaka
    dir: THREE.Vector3; speed: number; // smer a veľkosť štartovej rýchlosti
    L: number; tau: number;          // dráha a čas zrýchlenia vystreľovača; pri hode tau = čas švihu po pustenie
    swing?: { from: number; at: number; omega: number; tauF: number; R: number; g: number }; // švih ruky: uhly, uhlová rýchlosť pri pustení, dobeh
    catchArm?: RM.ArmTarget;         // kde klepeto čaká na vystrelené náradie (= kde ho pri hode púšťa)
    target: THREE.Matrix4;           // kde a ako náradie skončí (v súradniciach trupu)
    T: number;
  }
  // Švih: kde je úchop, keď je natiahnutá ruka pod uhlom ang (od zvislice dolu, dopredu). Palicu drží zápästie stále
  // rovnako natočenú (phi) – úchop je o g posunutý v smere ruky; zavesené náradie visí na ruke v predĺžení predlaktia.
  function swingAt(p: { yaw: number; phi: number | null }, sw: { R: number; g: number }, ang: number): RM.ArmTarget {
    if (p.phi === null) return { yaw: p.yaw, f: (sw.R + sw.g) * Math.sin(ang), y: -(sw.R + sw.g) * Math.cos(ang), phi: null };
    return { yaw: p.yaw, f: sw.R * Math.sin(ang) + sw.g * Math.sin(p.phi), y: -sw.R * Math.cos(ang) - sw.g * Math.cos(p.phi), phi: p.phi };
  }
  // Odhodenie: švih spodom. Náradie sa pri ňom neotáča (len posúva po oblúku), takže jeho rýchlosť je rýchlosť ruky:
  // kolmá na ruku, veľká omega × dĺžka ruky. Pustí sa pod uhlom, kde tento smer = smer štartovej rýchlosti v0 šikmého
  // vrhu do držiaka, a švih je načasovaný tak, aby tam ruka mala omega = |v0| / dĺžka. Náradie drží ruka už natočené tak,
  // ako dopadne – proti smeru dopadu (a = −v pri dopade), a držiak sa natočí rovnako. Pár iterácií (všetko závisí od
  // bodu pustenia a ten od uhla).
  function planToss(tool: ToolId): Plan {
    const { h, yaw } = throwPlane(tool), staff = staffTool(tool), rest = restAxis(tool);
    const sw = { R: model.armLen * 1.05 * RM.SWAP.reach, g: -model.mounts.handR.p[1] }, lever = staff ? sw.R : sw.R + sw.g;
    const a = UP.clone(), aim = new THREE.Quaternion(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let phi: number | null = null, at = 1.7, b = RM.ballistic([0, 0, 0], [0, 0, 0], 1);
    for (let k = 0; k < 6; k++) {
      phi = staff ? Math.atan2(a.y, a.dot(h)) : null;
      probeHeld(tool, swingAt({ yaw, phi }, sw, at)).decompose(p0, q, sc);
      if (staff) aim.setFromUnitVectors(rest, a);
      probeSlot(tool, aim, ZERO).decompose(p1, q, sc);
      b = RM.ballistic(v3(p0), v3(p1), apexY());
      a.set(-b.vEnd[0], -b.vEnd[1], -b.vEnd[2]).normalize();
      at = Math.atan2(b.v0[1], b.v0[0] * h.x + b.v0[2] * h.z); // rýchlosť ruky (cos, sin) uhla = smer v0 v rovine hodu
    }
    const dir = new THREE.Vector3(...b.v0), speed = dir.length(); dir.normalize();
    const omega = speed / lever, from = Math.min(RM.SWAP.swingFrom, at - 0.8);
    return { tool, yaw, h, phi, aim, dir, speed, L: 0, tau: (2 * (at - from)) / omega, target: probeSlot(tool, aim, ZERO), T: b.T, swing: { from, at, omega, tauF: (2 * RM.SWAP.follow) / omega, ...sw } };
  }
  // Výstrel: držiak (puzdro) sa natočí do smeru štartovej rýchlosti, zdvihom SWAP.stroke náradie zrýchli a pustí.
  // Klepeto čaká presne tam, kde ruka to isté náradie pri odhodení púšťa (koniec švihu z planToss), natočené ako letiace
  // náradie – výstrel je teda tá istá parabola ako hod, len opačným smerom.
  function planLaunch(tool: ToolId): Plan {
    const toss = planToss(tool), g = must(toss.swing), { h, yaw } = toss, staff = staffTool(tool), rest = restAxis(tool), L = RM.SWAP.stroke;
    const a = UP.clone().multiplyScalar(3).add(h).normalize(), aim = new THREE.Quaternion(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let phi: number | null = null, b = RM.ballistic([0, 0, 0], [0, 0, 0], 1), target = new THREE.Matrix4(), arm = swingAt(toss, g, g.at);
    for (let k = 0; k < 4; k++) {
      phi = staff ? Math.atan2(a.y, a.dot(h)) : null;
      arm = swingAt({ yaw, phi }, g, g.at);
      target = probeHeld(tool, arm);
      target.decompose(p1, q, sc);
      if (staff) aim.setFromUnitVectors(rest, a);
      probeSlot(tool, aim, a.clone().multiplyScalar(L)).decompose(p0, q, sc);
      b = RM.ballistic(v3(p0), v3(p1), apexY());
      a.set(...b.v0).normalize();
    }
    const speed = Math.hypot(...b.v0);
    return { tool, yaw, h, phi, aim, dir: a.clone(), speed, L, tau: (2 * L) / speed, target, T: b.T, catchArm: arm };
  }
  // Let: náradie je dieťa trupu; poloha = šikmý vrh z miesta, kde ho ruka / držiak naozaj pustili, do cieľa; natočenie sa
  // rovnomerne dotočí do cieľového (smer už sedí, mení sa najviac otočenie okolo vlastnej osi); náradie je na nosiči rovnako veľké ako v ruke
  interface Flight { obj: THREE.Group; t0: number; T: number; p0: [number, number, number]; v0: [number, number, number]; q0: THREE.Quaternion; s0: number; q1: THREE.Quaternion; s1: number; land: () => void }
  const flights: Flight[] = [];
  function fly(obj: THREE.Group, target: THREE.Matrix4, t0: number, land: () => void): void {
    const p = new THREE.Vector3(), q0 = new THREE.Quaternion(), sc = new THREE.Vector3(), p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    inBody(obj).decompose(p, q0, sc); target.decompose(p1, q1, s1);
    const b = RM.ballistic(v3(p), v3(p1), apexY());
    bodyJ.add(obj);
    flights.push({ obj, t0, T: b.T, p0: v3(p), v0: b.v0, q0, s0: sc.x, q1, s1: s1.x, land });
  }
  function stepFlights(t: number): boolean {
    let landed = false;
    for (let k = flights.length - 1; k >= 0; k--) {
      const f = must(flights[k]), tt = Math.min(f.T, t - f.t0), u = tt / f.T;
      f.obj.position.set(...RM.ballisticAt(f.p0, f.v0, tt));
      f.obj.quaternion.slerpQuaternions(f.q0, f.q1, u);
      f.obj.scale.setScalar(f.s0 + (f.s1 - f.s0) * u);
      if (t - f.t0 >= f.T) { flights.splice(k, 1); f.land(); landed = true; }
    }
    return landed;
  }
  // Priebeh výmeny (časy od začiatku): náprah → zrýchlenie ruky → pustenie (tRel) → let do držiaka (tLand);
  // natočenie držiaka nového náradia → zdvih (od tStroke) → pustenie (tOut) → let do klepeta → chytenie
  interface Swap {
    t: number; from: ToolId | null; to: ToolId | null;
    toss: Plan | null; tRel: number; tLand: number; released: boolean;
    launch: Plan | null; tAim: number; tStroke: number; tOut: number; tCatch: number; out: boolean;
  }
  let swap: Swap | null = null;
  function switchTool(to: ToolId | null): void {
    const from = swap ? swap.to : held0;
    if (swap || from === to) { if (from !== to) { const owned = [...stored.keys(), ...(held0 ? [held0] : [])]; setTools(to, owned); } return; }
    if (to && !stored.has(to)) { setTools(to, [...stored.keys(), ...(from ? [from] : [])]); return; } // nie je na nosiči – hneď
    const toss = from ? planToss(from) : null, tRel = toss ? RM.SWAP.wind + toss.tau : 0, tLand = toss ? tRel + toss.T : 0;
    swap = { t: 0, from, to, toss, tRel, tLand, released: !toss, launch: null, tAim: Infinity, tStroke: Infinity, tOut: Infinity, tCatch: Infinity, out: !to };
    if (!toss && to) planOut(swap, 0);
  }
  // naplánuje výstrel (ruka už musí byť prázdna): natočenie od času t, zdvih po dopade odhodeného náradia
  function planOut(sw: Swap, t: number): void {
    if (!sw.to) return;
    sw.launch = planLaunch(sw.to);
    sw.tAim = t; sw.tStroke = Math.max(t + RM.SWAP.aim, sw.tLand + 0.05, t + 0.45); sw.tOut = sw.tStroke + sw.launch.tau; sw.tCatch = sw.tOut + sw.launch.T;
  }
  // cieľ ruky podľa fázy výmeny (pred výpočtom pózy)
  function swapArm(dt: number): RM.ArmTarget | null {
    const sw = swap;
    if (!sw) return null;
    sw.t += dt;
    const p = sw.toss, g = p?.swing;
    if (p && g && sw.t < sw.tRel + g.tauF) {
      // náprah (ruka klesne na začiatok švihu), švih s rovnomerným uhlovým zrýchlením až po pustenie (tam má omega),
      // potom dobeh s rovnomerným spomalením
      const u = Math.max(0, Math.min(1, (sw.t - RM.SWAP.wind) / p.tau)), s = sw.t - sw.tRel;
      const ang = s < 0 ? g.from + (g.at - g.from) * u * u : g.at + g.omega * s - (g.omega / (2 * g.tauF)) * s * s;
      return swingAt(p, g, ang);
    }
    const l = sw.launch;
    if (l?.catchArm && sw.t < sw.tCatch + 0.05) return l.catchArm;
    return null;
  }
  // držiaky podľa fázy výmeny (po nastavení kĺbov)
  const hq = new THREE.Quaternion(), hd = new THREE.Vector3();
  function swapHolders(): void {
    const sw = swap;
    if (!sw) return;
    const p = sw.toss, l = sw.launch;
    // držiak odhodeného náradia: natočí sa proti dopadu, po dopade sa s náradím vráti
    if (p) setHolder(p.tool, hq.slerpQuaternions(ID, p.aim, sw.t < sw.tLand ? ease3(sw.t / RM.SWAP.wind) : 1 - ease3((sw.t - sw.tLand) / 0.3)), ZERO);
    // držiak nového náradia: natočí sa do smeru výstrelu, zdvih s = L·u² (na konci rýchlosť |v0|), potom sa vráti
    if (l) {
      const k = sw.t < sw.tOut ? ease3((sw.t - sw.tAim) / RM.SWAP.aim) : 1 - ease3((sw.t - sw.tOut - 0.1) / 0.3);
      const u = Math.max(0, Math.min(1, (sw.t - sw.tStroke) / l.tau)), d = sw.t < sw.tOut ? l.L * u * u : l.L * (1 - ease3((sw.t - sw.tOut) / 0.15));
      setHolder(l.tool, hq.slerpQuaternions(ID, l.aim, k), hd.copy(l.dir).multiplyScalar(d));
    }
  }
  // udalosti výmeny (po nastavení kĺbov a zaveseného náradia): pustenie z ruky, výstrel z držiaka, dopady
  function swapEvents(): void {
    const sw = swap;
    if (!sw) return;
    if (!sw.released && sw.toss && sw.t >= sw.tRel && heldObj) {
      sw.released = true;
      const obj = heldObj, from = sw.toss.tool, target = sw.toss.target;
      group.updateMatrixWorld(true);
      bodyJ.attach(obj); dropHeld(); held0 = null;
      fly(obj, target, sw.tRel, () => { slots[from].add(obj); obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.setScalar(1); stored.set(from, obj); });
      planOut(sw, sw.t);
    }
    if (!sw.out && sw.launch && sw.t >= sw.tOut) {
      sw.out = true;
      const to = sw.launch.tool, obj = must(stored.get(to));
      stored.delete(to);
      group.updateMatrixWorld(true);
      bodyJ.attach(obj);
      fly(obj, sw.launch.target, sw.tOut, () => { attachHeld(to, obj); held0 = to; hang(false, 0); });
    }
    stepFlights(sw.t);
    const end = sw.to ? sw.tCatch + 0.3 : sw.tLand + 0.3;
    if (sw.t >= end && !flights.length) swap = null;
  }
  let held0: ToolId | null = null;
  const q = new THREE.Quaternion(), up = new THREE.Vector3(), bar = new THREE.Vector3(), side = new THREE.Vector3(), lastBar = new THREE.Vector3(0, 0, 1), basis = new THREE.Matrix4();
  const cur = new Map<THREE.Object3D, { r: [number, number, number]; d: [number, number, number] }>();
  const step = (a: number, b: number, max: number): number => a + Math.max(-max, Math.min(max, b - a));
  function pose(o: PoseOpts, dt?: number): void {
    const arm = o.arm !== undefined ? o.arm : swapArm(dt ?? 0);
    // zrýchlenie ruky pri hode: kĺby pravej ruky smú rýchlejšie (RM.THROW_SPEED)
    const throwing = !!swap?.toss?.swing && swap.t >= RM.SWAP.wind && swap.t < swap.tRel + swap.toss.swing.tauF + 0.05;
    const P = RM.robotPose(model, { ...o, arm, use: o.use !== undefined ? o.use : null, hold: o.hold !== undefined ? o.hold : held0 ? RM.TOOL_HOLD[held0] : null, digWith: o.digWith !== undefined ? o.digWith : held0 });
    for (const [id, g] of joints) {
      const jp = P.joints.get(id), base = must(jointBase.get(g)), tr = jp?.r ?? [0, 0, 0], td = jp?.d ?? [0, 0, 0];
      const sp = throwing && (g === armJ[0] || g === armJ[1] || g === armJ[2]) ? RM.THROW_SPEED : RM.jointSpeed(id), c = cur.get(g);
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
    for (const l of lids) l.position.y = must(partBase.get(l)).y - P.blink * 0.03;
    for (const [k, s] of (tagged.get('steam') ?? []).entries()) {
      const b = must(partBase.get(s)), f = (P.steam + k / 3) % 1;
      s.position.set(b.x + f * 0.03, b.y - 0.05 + f * 0.15, b.z); s.scale.setScalar(0.4 + f);
      const sm = steamMats[k]; if (sm) sm.opacity = 0.35 * (1 - f);
    }
    swapHolders();
    hang(P.rigid, Math.sin((o.phase ?? 0) * 2) * (o.walking ? 0.12 : 0));
    swapEvents();
    water(P.pour, o.use?.t ?? o.t ?? 0);
    if (bodyH) { group.updateMatrixWorld(true); bodyH.update(); } // matice kĺbov do zlúčenej siete
  }
  // Zavesené náradie (krhla, lampáš) visí vždy zvislo dolu (gravitácia), držadlo je čo najbližšie k osi klepeta (z ruky)
  // a nikdy sa neprevráti: os y kĺbu = hore vo svete, os z = os klepeta premietnutá do vodorovnej roviny.
  function hang(rigid: boolean, sway: number): void {
    if (!hanging) return;
    if (rigid) { hanging.quaternion.identity(); return; } // pri polievaní drží krhlu pevne v klepete a nakláňa ju
    group.updateMatrixWorld(true);
    hand.getWorldQuaternion(q).invert();
    up.set(0, 1, 0).applyQuaternion(q);
    // os klepeta premietnutá do vodorovnej roviny – vždy v tom istom zmysle, takže sa náradie neprevráti; len keď je
    // klepeto skoro zvislo, použije sa os x ruky (v zmysle bližšom k predošlému smeru)
    bar.set(0, 0, 1).addScaledVector(up, -up.z);
    if (bar.lengthSq() < 0.04) { bar.set(1, 0, 0).addScaledVector(up, -up.x); if (bar.dot(lastBar) < 0) bar.negate(); }
    bar.normalize();
    lastBar.copy(bar);
    side.crossVectors(up, bar);
    basis.makeBasis(side, up, bar);
    hanging.quaternion.setFromRotationMatrix(basis);
    hanging.rotateX(sway);
  }
  // voda z ružice krhly pri polievaní: kvapky padajú po parabole, kým je krhla naklonená
  const dropMat = new THREE.MeshStandardMaterial({ color: col('#8fd3ff'), roughness: 0.1, transparent: true, opacity: 0.8 });
  const dropGeo = new THREE.IcosahedronGeometry(0.008, 0);
  const drops = Array.from({ length: 12 }, () => { const d = backend ? backend.drop() : new THREE.Mesh(dropGeo, dropMat); d.name = 'water'; d.visible = false; group.add(d); return d; });
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
  function dispose(): void { for (const m of [...Object.values(mats), ...steamMats, ...flatMats.values(), dropMat]) m.dispose(); dropGeo.dispose(); bodyH?.dispose(); for (const t of tools) TOOL_FREE.get(t)?.(); group.removeFromParent(); }
  setTools(null, []);
  pose({});
  return { group, model, setTools, switchTool, switching: () => swap !== null, pose, mountWorld, dispose };
}
