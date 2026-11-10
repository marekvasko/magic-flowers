// 3D fúrik a sane (#158): model z minikociek (world3d.ts vehicleModel – podľa nákladu ľadu), natočený za smerom
// a postavený na zem plochy, s mäkkým tieňom; sane majú lano k ruke hráča, ktorý ich ťahá. Spolujazdec sedí vo vozidle
// (render3d.ts ho kreslí vyššie a skrčeného – seat). Kreslí sa, čo je v S.vehicles (hra: plynulo dobiehajúce polohy
// z client/vehicles.ts, ladiaca stránka /debug → World: polohy zo servera).
// Model nevrhá tieň do mapy tieňov (hýbe sa, mapa sa nepočíta každú snímku) – je na vrstve 1 ako postavičky.
import type * as THREE from 'three';
import type { Baked } from '../shared/mesher.ts';
import * as W from '../shared/world3d.ts';
import type { FineModel } from '../shared/world3d.ts';
import type { VehicleView } from '../shared/protocol.ts';
import type { VehicleId } from '../shared/save.ts';
import type { ViewState } from './state.ts';

type Three = typeof THREE;
// Čo modul dostane od render3d.ts
export interface Vehicles3dDeps {
  THREE: Three;
  scene: THREE.Scene;
  S: ViewState;
  groundY: (x: number, y: number) => number;
  meshFine: (f: FineModel, se: number) => Baked;                   // vypečený model (sieť + obrázky farieb a zatienenia)
  bakedTex: (img: Baked['color'], format: THREE.PixelFormat) => THREE.DataTexture;
  material: THREE.ShaderMaterial;                                   // materiál jemných modelov sveta (svetlo, tiene, tma)
  vox: { voxColor: THREE.IUniform<THREE.Texture | null>; voxAo: THREE.IUniform<THREE.Texture | null> };
  shadow: () => THREE.Mesh;                                          // mäkký tieň (ako pod postavičkou)
}
export interface Vehicles3d {
  update: (dt: number, se: number) => void;
  seat: (charId: number | string) => number;   // o koľko vyššie sedí spolujazdec (0 = nesedí)
  objects: () => THREE.Object3D[];             // pre ladiacu stránku
  dispose: () => void;
}
const SEAT: Readonly<Record<VehicleId, number>> = { furik: 0.42, sane: 0.3 };
// Kde je lano na saniach (bloky pred stredom) a ruka hráča (výška)
const ROPE_AT = 1.05, HAND_Y = 0.5;

export function createVehicles3d(dp: Vehicles3dDeps): Vehicles3d {
  const { THREE: T, scene, S } = dp;
  interface Geo { geo: THREE.BufferGeometry; color: THREE.DataTexture; ao: THREE.DataTexture }
  interface Obj { group: THREE.Group; mesh: THREE.Mesh; shadow: THREE.Mesh; rope: THREE.Line; key: string; geo: Geo | null }
  const geos = new Map<string, Geo>(); // druh|náklad → sieť a obrázky (modely sa nemenia s obdobím)
  const objs = new Map<VehicleId, Obj>();

  function geoOf(id: VehicleId, ice: number, se: number): Geo {
    const key = id + '|' + String(ice);
    const known = geos.get(key);
    if (known) return known;
    const b = dp.meshFine(W.vehicleModel(id, ice), se);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(b.P, 3));
    geo.setAttribute('normal', new T.BufferAttribute(b.N, 3));
    geo.setAttribute('uv', new T.BufferAttribute(b.UV, 2));
    geo.setAttribute('aoUv', new T.BufferAttribute(b.UV2, 2));
    geo.setIndex(new T.BufferAttribute(b.I, 1));
    geo.computeBoundingSphere();
    const color = dp.bakedTex(b.color, T.RGBAFormat);
    color.magFilter = color.minFilter = T.NearestFilter;
    const ao = dp.bakedTex(b.ao, T.RedFormat);
    ao.magFilter = ao.minFilter = T.LinearFilter;
    const g = { geo, color, ao };
    geos.set(key, g);
    return g;
  }
  function objOf(id: VehicleId): Obj {
    const known = objs.get(id);
    if (known) return known;
    const group = new T.Group();
    const mesh = new T.Mesh(new T.BufferGeometry(), dp.material);
    mesh.position.set(-W.VEHICLE_CENTER.x, 0, -W.VEHICLE_CENTER.z);
    mesh.layers.set(1);
    const o: Obj = { group, mesh, shadow: dp.shadow(), rope: new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), new T.LineBasicMaterial({ color: 0xd8c08a })), key: '', geo: null };
    mesh.onBeforeRender = (_r, _sc, _cam, _g, mat) => {
      if (!o.geo || !(mat instanceof T.ShaderMaterial) || !('voxColor' in mat.uniforms)) return;
      dp.vox.voxColor.value = o.geo.color; dp.vox.voxAo.value = o.geo.ao; mat.uniformsNeedUpdate = true;
    };
    group.add(mesh);
    group.add(o.shadow); // tieň ide s vozidlom (otáča sa s ním)
    o.shadow.position.set(0, 0.01, 0); o.shadow.scale.set(id === 'sane' ? 1.5 : 1.35, 0.75, 1);
    o.rope.layers.set(1); o.rope.visible = false; o.rope.frustumCulled = false;
    scene.add(group); scene.add(o.rope);
    objs.set(id, o);
    return o;
  }
  function drop(id: VehicleId, o: Obj): void { scene.remove(o.group); scene.remove(o.rope); o.rope.geometry.dispose(); objs.delete(id); }
  // poloha hráča podľa čísla (alebo odtlačku na ladiacej stránke): vlastná postavička alebo iný hráč
  function playerAt(id: number | string | null): { x: number; y: number } | null {
    if (id == null) return null;
    if (id === S.id) return S.me;
    return S.others.get(id) ?? null;
  }
  const shown = (): VehicleView[] => (S.vehicles || []).filter(v => v.bought && v.area === S.area);

  function update(_dt: number, se: number): void {
    const seen = new Set<VehicleId>();
    for (const v of shown()) {
      seen.add(v.id);
      const o = objOf(v.id), key = v.id + '|' + String(v.ice);
      if (o.key !== key) { o.geo = geoOf(v.id, v.ice, se); o.mesh.geometry = o.geo.geo; o.key = key; }
      o.group.position.set(v.x, dp.groundY(v.x, v.y), v.y);
      o.group.rotation.y = -v.a;
      // lano saní k ruke toho, kto ich ťahá
      const d = v.id === 'sane' ? playerAt(v.d) : null;
      o.rope.visible = !!d;
      if (d) {
        const fx = v.x + Math.cos(v.a) * ROPE_AT, fz = v.y + Math.sin(v.a) * ROPE_AT, gy = dp.groundY(v.x, v.y);
        const pos = o.rope.geometry.getAttribute('position');
        pos.setXYZ(0, fx, gy + 0.55, fz); pos.setXYZ(1, d.x, dp.groundY(d.x, d.y) + HAND_Y, d.y);
        pos.needsUpdate = true;
      }
    }
    for (const [id, o] of objs) if (!seen.has(id)) drop(id, o);
  }
  function seat(charId: number | string): number {
    const id = charId === 'me' ? S.id : charId;
    for (const v of shown()) if (v.r != null && v.r === id) return SEAT[v.id];
    return 0;
  }
  function dispose(): void {
    for (const [id, o] of objs) drop(id, o);
    for (const g of geos.values()) { g.geo.dispose(); g.color.dispose(); g.ao.dispose(); }
    geos.clear();
  }
  return { update, seat, objects: () => [...objs.values()].map(o => o.group), dispose };
}
