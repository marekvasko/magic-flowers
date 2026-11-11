// Fúrik a sane v 3D (#158): kreslený 2D sprite ako postavička (vehicleart.ts drawVehicle, 8 smerov podľa natočenia
// vozidla voči kamere – rovnaké dir8 ako hráči), s mäkkým tieňom na zemi; sane majú lano, ktoré končí presne v ruke
// postavičky (Art.handAt – tá istá ruka, ktorú kreslí char(), aj s mávaním pri chôdzi) a je vždy za ňou: lano nezapisuje
// hĺbku a ťahajúca postavička sa kreslí až po ňom (renderOrder, tows).
// Spolujazdec je nakreslený priamo v obrázku vozidla (sedí vo vaničke / na doske) – jeho vlastnú postavičku render3d
// skryje (seat), meno a bublina ostanú. Kreslí sa, čo je v S.vehicles (hra: plynulo dobiehajúce polohy
// z client/vehicles.ts, ladiaca stránka /debug → World: polohy zo servera).
import type * as THREE from 'three';
import type { Look } from '../shared/data.ts';
import type { VehicleView } from '../shared/protocol.ts';
import type { VehicleId } from '../shared/save.ts';
import { SEAT_Y } from '../shared/vehicleshape.ts';
import { PITCH, ROPE_AT, drawVehicle } from './vehicleart.ts';
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
  hand: (charId: number | string) => THREE.Vector3 | null;   // ruka postavičky vo svete (posledná kresba), 'me' = vlastná
}
export interface Vehicles3d {
  update: (dt: number, lights: readonly THREE.Vector4[]) => void;
  ropes: () => void;                           // po nakreslení postavičiek: lano saní do ruky
  tows: (charId: number | string) => boolean;  // drží táto postavička fúrik / sane (kreslí sa po lane, renderOrder 1)
  seat: (charId: number | string) => number;   // o koľko vyššie sedí spolujazdec (0 = nesedí) – jeho postavička sa skryje
  objects: () => THREE.Object3D[];             // pre ladiacu stránku
  pickables: () => THREE.Object3D[];           // sprity na ťuknutie (render3d pick – políčko vozidla)
  dispose: () => void;
}
// Plátno spritu: 128 × 160 px = 1,28 × 1,6 bloku (100 px na blok ako postavička); stred vozidla na zemi je v (64, GY).
// Sprite je ukotvený o FRONT bloku bližšie ku kamere (pod spodným okrajom kresby) – zem pred vozidlom ho tak nezakryje.
const CW = 128, CH = 160, PX = 100, GY = 124, FRONT = 0.5;
const ANCHOR_Y = GY + FRONT * Math.sin(PITCH) * PX;

export function createVehicles3d(dp: Vehicles3dDeps): Vehicles3d {
  const { THREE: T, scene, S } = dp;
  interface Obj { sp: Sprite; shadow: THREE.Mesh; rope: THREE.Mesh; key: string }
  const objs = new Map<VehicleId, Obj>();

  function objOf(id: VehicleId): Obj {
    const known = objs.get(id);
    if (known) return known;
    const sp = dp.makeSprite(CW / PX, CH / PX);
    sp.center.set(0.5, 1 - ANCHOR_Y / CH);
    const shadow = dp.shadow();
    shadow.scale.set(id === 'sane' ? 1.0 : 0.95, 0.5, 1);
    // lano: tenký pásik otočený ku kamere (čiara WebGL má len 1 px), 2 vrcholy na každý bod lana
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.BufferAttribute(new Float32Array((SEG + 1) * 6), 3));
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    rg.setIndex(idx);
    const rope = new T.Mesh(rg, new T.MeshBasicMaterial({ color: 0xb08a4e, depthWrite: false, side: T.DoubleSide }));
    rope.layers.set(1); rope.visible = false; rope.frustumCulled = false;
    rope.renderOrder = 0.5; // po svete a saniach, pred ťahajúcou postavičkou (renderOrder 1) – tá ho vždy prekryje
    rope.raycast = () => { /* lano sa ťuknutím nevyberá */ };
    scene.add(rope);
    const o = { sp, shadow, rope, key: '' };
    objs.set(id, o);
    return o;
  }
  function drop(id: VehicleId, o: Obj): void { scene.remove(o.sp); scene.remove(o.shadow); scene.remove(o.rope); o.rope.geometry.dispose(); objs.delete(id); }
  // hráč podľa čísla (alebo odtlačku na ladiacej stránke): vlastná postavička alebo iný hráč
  const charIdOf = (id: number | string): number | string => (id === S.id ? 'me' : id);
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
      // Poradie s hráčom, ktorý vozidlo drží: sprite vozidla je kvôli zemi posunutý ku kamere, preto o prekrytí s ním
      // nerozhoduje hĺbka, ale poradie kreslenia – vozidlo bez zápisu hĺbky pred ním (je bližšie ku kamere), inak po ňom
      const d = v.d != null ? playerAt(v.d) : null;
      if (d) {
        const front = (d.x - v.x) * Math.sin(yaw) + (d.y - v.y) * Math.cos(yaw) > 0; // hráč je bližšie ku kamere než vozidlo
        o.sp.renderOrder = front ? 0.6 : 1.5; o.sp.material.depthWrite = false;
      } else { o.sp.renderOrder = 0; o.sp.material.depthWrite = true; }
      o.shadow.position.set(v.x, gy + 0.01, v.y);
      o.shadow.rotation.z = -v.a; // tieň (elipsa položená na zem) je pretiahnutý v smere vozidla
    }
    for (const [id, o] of objs) if (!seen.has(id)) drop(id, o);
  }
  // Lano saní: od priečky saní (bod kresby v smere spritu, nie presný uhol – sedí s obrázkom) do ruky ťahajúceho
  const SEG = 8, ROPE_W = 0.022;
  function ropes(): void {
    const yaw = dp.yaw();
    for (const v of shown()) {
      const o = objs.get(v.id);
      if (!o) continue;
      const hand = v.id === 'sane' && v.d != null ? dp.hand(charIdOf(v.d)) : null;
      o.rope.visible = !!hand;
      if (!hand) continue;
      // smer „dopredu“ obrázka (8 smerov) späť do sveta: obrazovka (cos, sin) → svet cez natočenie kamery
      const th = [Math.PI / 2, Math.PI, 0, -Math.PI / 2, Math.PI * 3 / 4, Math.PI / 4, -Math.PI * 3 / 4, -Math.PI / 4][dp.dir8(v.a)] ?? 0;
      const sx = Math.cos(th), sy = Math.sin(th), fx = sx * Math.cos(yaw) + sy * Math.sin(yaw), fz = -sx * Math.sin(yaw) + sy * Math.cos(yaw);
      const gy = dp.groundY(v.x, v.y), ax = v.x + fx * ROPE_AT[0], ay = gy + ROPE_AT[1], az = v.y + fz * ROPE_AT[0];
      const pos = o.rope.geometry.getAttribute('position'), len = Math.hypot(hand.x - ax, hand.y - ay, hand.z - az);
      const eye = new T.Vector3(Math.sin(yaw) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(yaw) * Math.cos(PITCH)); // ku kamere
      const seg = new T.Vector3(hand.x - ax, hand.y - ay, hand.z - az), side = new T.Vector3().crossVectors(seg, eye).normalize().multiplyScalar(ROPE_W / 2);
      for (let i = 0; i <= SEG; i++) { // mierne previsnuté lano
        const t = i / SEG, sag = Math.sin(Math.PI * t) * len * 0.08;
        const x = ax + (hand.x - ax) * t, y = ay + (hand.y - ay) * t - sag, z = az + (hand.z - az) * t;
        pos.setXYZ(2 * i, x - side.x, y - side.y, z - side.z); pos.setXYZ(2 * i + 1, x + side.x, y + side.y, z + side.z);
      }
      pos.needsUpdate = true;
      o.rope.geometry.computeBoundingSphere();
    }
  }
  function tows(charId: number | string): boolean {
    for (const v of shown()) if (v.d != null && charIdOf(v.d) === charId) return true;
    return false;
  }
  function seat(charId: number | string): number {
    const id = charId === 'me' ? S.id : charId;
    for (const v of shown()) if (v.r != null && v.r === id) return SEAT_Y[v.id];
    return 0;
  }
  function dispose(): void { for (const [id, o] of objs) drop(id, o); }
  return { update, ropes, tows, seat, objects: () => [...objs.values()].map(o => o.sp), pickables: () => [...objs.values()].map(o => o.sp), dispose };
}
