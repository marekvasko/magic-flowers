// Fúrik a sane v 3D (#158): kreslený 2D sprite ako postavička (vehicleart.ts drawVehicle, 8 smerov podľa natočenia
// vozidla voči kamere – rovnaké dir8 ako hráči), s mäkkým tieňom na zemi; sane majú lano k ruke toho, kto ich ťahá.
// Spolujazdec je nakreslený priamo v obrázku vozidla (sedí vo vaničke / na doske) – jeho vlastnú postavičku render3d
// skryje (seat), meno a bublina ostanú. Kreslí sa, čo je v S.vehicles (hra: plynulo dobiehajúce polohy
// z client/vehicles.ts, ladiaca stránka /debug → World: polohy zo servera).
import type * as THREE from 'three';
import type { Look } from '../shared/data.ts';
import type { VehicleView } from '../shared/protocol.ts';
import type { VehicleId } from '../shared/save.ts';
import { SEAT_Y } from '../shared/vehicleshape.ts';
import { PITCH, drawVehicle } from './vehicleart.ts';
import type { ViewState } from './state.ts';

type Three = typeof THREE;
type V3 = [number, number, number];
// sprite, na ktorý sa dá ťuknúť (render3d TileSprite): políčko, ktoré ťuknutie vyberie
type Sprite = THREE.Sprite & { tile: { x: number; y: number } | null };
// Čo modul dostane od render3d.ts
export interface Vehicles3dDeps {
  THREE: Three;
  scene: THREE.Scene;
  S: ViewState;
  groundY: (x: number, y: number) => number;
  makeSprite: (w: number, h: number) => Sprite;
  spriteTex: (key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => THREE.CanvasTexture;
  lightAt: (x: number, y: number, z: number, lights: readonly THREE.Vector4[], n: number) => V3;
  shadow: () => THREE.Mesh;
  dir8: (a: number) => number;
  yaw: () => number;
}
export interface Vehicles3d {
  update: (dt: number, lights: readonly THREE.Vector4[]) => void;
  seat: (charId: number | string) => number;   // o koľko vyššie sedí spolujazdec (0 = nesedí) – jeho postavička sa skryje
  objects: () => THREE.Object3D[];             // pre ladiacu stránku
  pickables: () => THREE.Object3D[];           // sprity na ťuknutie (render3d pick – políčko vozidla)
  dispose: () => void;
}
// Plátno spritu: 128 × 160 px = 1,28 × 1,6 bloku (100 px na blok ako postavička); stred vozidla na zemi je v (64, GY).
// Sprite je ukotvený o FRONT bloku bližšie ku kamere (pod spodným okrajom kresby) – zem pred vozidlom ho tak nezakryje.
const CW = 128, CH = 160, PX = 100, GY = 124, FRONT = 0.5;
const ANCHOR_Y = GY + FRONT * Math.sin(PITCH) * PX;
const ROPE_AT = 0.42, HAND_Y = 0.5;

export function createVehicles3d(dp: Vehicles3dDeps): Vehicles3d {
  const { THREE: T, scene, S } = dp;
  interface Obj { sp: Sprite; shadow: THREE.Mesh; rope: THREE.Line; key: string }
  const objs = new Map<VehicleId, Obj>();

  function objOf(id: VehicleId): Obj {
    const known = objs.get(id);
    if (known) return known;
    const sp = dp.makeSprite(CW / PX, CH / PX);
    sp.center.set(0.5, 1 - ANCHOR_Y / CH);
    const shadow = dp.shadow();
    shadow.scale.set(id === 'sane' ? 1.0 : 0.95, 0.5, 1);
    const rope = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), new T.LineBasicMaterial({ color: 0xd8c08a }));
    rope.layers.set(1); rope.visible = false; rope.frustumCulled = false;
    rope.raycast = () => { /* lano sa ťuknutím nevyberá */ };
    scene.add(rope);
    const o = { sp, shadow, rope, key: '' };
    objs.set(id, o);
    return o;
  }
  function drop(id: VehicleId, o: Obj): void { scene.remove(o.sp); scene.remove(o.shadow); scene.remove(o.rope); o.rope.geometry.dispose(); objs.delete(id); }
  // hráč podľa čísla (alebo odtlačku na ladiacej stránke): vlastná postavička alebo iný hráč
  function playerAt(id: number | string | null): { x: number; y: number; look: Look | null } | null {
    if (id == null) return null;
    if (id === S.id) return { x: S.me.x, y: S.me.y, look: S.look };
    const o = S.others.get(id);
    return o ? { x: o.x, y: o.y, look: o.look } : null;
  }
  const shown = (): VehicleView[] => (S.vehicles || []).filter(v => v.bought && v.area === S.area);

  function update(_dt: number, lights: readonly THREE.Vector4[]): void {
    const seen = new Set<VehicleId>(), yaw = dp.yaw(), fx = Math.sin(yaw) * FRONT, fz = Math.cos(yaw) * FRONT;
    for (const v of shown()) {
      seen.add(v.id);
      const o = objOf(v.id), dir = dp.dir8(v.a), rider = v.r != null ? playerAt(v.r) : null, gy = dp.groundY(v.x, v.y);
      const look = rider ? rider.look : null, key = `${v.id}|${String(dir)}|${String(v.ice)}|${rider ? JSON.stringify(look ?? {}) : '-'}`;
      if (o.key !== key) {
        o.key = key;
        o.sp.material.map = dp.spriteTex('veh|' + key, CW, CH, c => { drawVehicle(c, v.id, CW / 2, GY, PX, dir, v.ice, rider ? { look } : null); });
        o.sp.material.needsUpdate = true;
      }
      o.sp.position.set(v.x + fx, gy, v.y + fz);
      o.sp.tile = { x: Math.floor(v.x), y: Math.floor(v.y) };
      o.sp.material.color.setRGB(...dp.lightAt(v.x, gy + 0.3, v.y, lights, lights.length));
      o.shadow.position.set(v.x, gy + 0.01, v.y);
      o.shadow.rotation.z = -v.a; // tieň (elipsa položená na zem) je pretiahnutý v smere vozidla
      // lano saní k ruke toho, kto ich ťahá
      const d = v.id === 'sane' ? playerAt(v.d) : null;
      o.rope.visible = !!d;
      if (d) {
        const pos = o.rope.geometry.getAttribute('position');
        pos.setXYZ(0, v.x + Math.cos(v.a) * ROPE_AT, gy + 0.18, v.y + Math.sin(v.a) * ROPE_AT); pos.setXYZ(1, d.x, dp.groundY(d.x, d.y) + HAND_Y, d.y);
        pos.needsUpdate = true;
      }
    }
    for (const [id, o] of objs) if (!seen.has(id)) drop(id, o);
  }
  function seat(charId: number | string): number {
    const id = charId === 'me' ? S.id : charId;
    for (const v of shown()) if (v.r != null && v.r === id) return SEAT_Y[v.id];
    return 0;
  }
  function dispose(): void { for (const [id, o] of objs) drop(id, o); }
  return { update, seat, objects: () => [...objs.values()].map(o => o.sp), pickables: () => [...objs.values()].map(o => o.sp), dispose };
}
