// Loďka v 3D pohľade (#160): 2D obrázok (sprite) ako postavička – kreslí ho Art.boat v jednom z 8 smerov podľa smeru
// provy a natočenia kamery (rovnako ako postavička, render3d dir8), na vode s posádkou a veslami, v zime prevrátený
// na móle so snehom. Posádka sa kreslí priamo do obrázka loďky (od pása nahor), ich vlastné postavičky render3d skryje
// a nechá im len meno nad hlavou (seat).
// Obrázok stojí v rovine kolmej na kameru; aby ho hladina neprekryla, posunie sa ku kamere práve o hĺbku najbližšieho
// bodu loďky (boatNear) – kamera je ortografická, na obrazovke sa tým nič nepohne.
// THREE sa odovzdáva (nie import) – rovnako ako spiders3d.ts.
import type * as THREE from 'three';
import * as D from '../shared/data.ts';
import * as W from '../shared/world3d.ts';
import type { Look } from '../shared/data.ts';
import { Art, BOAT2D, boatNear } from './art.ts';
import type { ViewState } from './state.ts';

type Three = typeof THREE;
type V3 = [number, number, number];
export interface Boat3dCtx {
  THREE: Three;
  scene: THREE.Scene;
  camera: THREE.Camera;
  S: ViewState;
  dir8: (a: number) => number;                    // smer v rovine x/y → jeden z 8 pohľadov (ako postavička)
  yaw: () => number;                               // natočenie kamery
  light: (x: number, y: number, z: number) => V3;  // svetlo v bode (ako pre postavičky)
}
// Kto sedí: hráč podľa mena (v hre) alebo podľa id (ladiaca stránka – id je odtlačok kľúča, rovnako ako v seats)
export type Who = { name: string; id: number | string };
// Miesto hráča v loďke (pre meno nad hlavou): bod vo svete
export interface Seat { x: number; z: number; y: number }
export interface Boat3d {
  update: (dt: number, t: number) => void;
  seat: (who: Who | null) => Seat | null;
  boatAt: () => { x: number; y: number; dir: number; flip: boolean } | null;
  dispose: () => void;
}

const PPB = 100, CW = 3, CH = 2.4, CY = 1.6; // pixely na blok, šírka a výška obrázka v blokoch, stred loďky od vrchu
const DECK_Y = 1;                              // lávka móla (world3d dockModel, vo výške zeme), na nej leží prevrátená loďka
const keyOf = (name: string): string => name.replace(/[<>*]/g, '').trim().slice(0, 14).toLowerCase(); // ako kľúč hráča na serveri
const isSeat = (who: Who, seat: string | undefined): boolean => !!seat && (keyOf(who.name) === seat || String(who.id) === seat);

export function createBoat3d(ctx: Boat3dCtx): Boat3d {
  const { THREE, scene, S } = ctx;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(CW * PPB); canvas.height = Math.round(CH * PPB);
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.NoColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.4, transparent: false }));
  sprite.center.set(0.5, 1 - CY / CH); sprite.scale.set(CW, CH, 1);
  sprite.layers.set(1); // nevrhá tieň a v zrkadle vody nie je (posunutý obrázok by sa odrážal inde)
  scene.add(sprite);
  const toCam = new THREE.Vector3();
  let cur: { x: number; y: number; a: number } | null = null, drawn = '', dir = 0, lastX = 0, lastY = 0, rowing = 0;

  // kde je loďka: veslár (ja – moja poloha, iný – jeho plynulá poloha), inak poloha zo servera; smer provy
  function target(): { x: number; y: number; a: number; flip: boolean } | null {
    const d = S.dock;
    if (!d || !d.built || S.area !== 'garden') return null;
    if (d.flip) { const p = D.DOCK.tiles[0] ?? D.DOCK.land; return { x: p.x + 0.5, y: p.y + D.DOCK.tiles.length / 2, a: Math.PI / 2, flip: true }; }
    const rower = d.seats[0];
    if (rower && rower === keyOf(S.name)) return { x: S.me.x, y: S.me.y, a: S.me.a ?? d.boat.a, flip: false };
    if (rower) for (const o of S.others.values()) if (isSeat(o, rower)) return { x: o.x, y: o.y, a: d.boat.a, flip: false };
    return { x: d.boat.x, y: d.boat.y, a: d.boat.a, flip: false };
  }
  // vzhľad posádky podľa miest (null = prázdne miesto)
  function crew(): (Partial<Look> | null)[] {
    const d = S.dock;
    return [0, 1].map(i => {
      const k = d?.seats[i];
      if (!k) return null;
      if (k === keyOf(S.name)) return S.look ?? {};
      for (const o of S.others.values()) if (isSeat(o, k)) return o.look ?? {};
      return {};
    });
  }
  function update(dt: number, t: number): void {
    const tg = target();
    sprite.visible = !!tg;
    if (!tg || !g) { cur = null; return; }
    if (!cur || Math.hypot(tg.x - cur.x, tg.y - cur.y) > 3) { cur = { x: tg.x, y: tg.y, a: tg.a }; lastX = cur.x; lastY = cur.y; }
    const k = Math.min(1, dt * 12);
    cur.x += (tg.x - cur.x) * k; cur.y += (tg.y - cur.y) * k; cur.a = tg.a;
    const speed = Math.hypot(cur.x - lastX, cur.y - lastY) / Math.max(dt, 1e-3);
    lastX = cur.x; lastY = cur.y;
    rowing = speed > 0.3 ? 0.4 : Math.max(0, rowing - dt); // veslár vesluje ešte chvíľu po zastavení
    dir = ctx.dir8(cur.a);
    const cr = tg.flip ? [] : crew(), row = rowing > 0;
    const key = `${dir}|${tg.flip ? 1 : 0}|${D.seasonOf(S.day)}|${JSON.stringify(cr)}|${row ? Math.floor(t * 10) : -1}`;
    if (key !== drawn) {
      drawn = key;
      g.clearRect(0, 0, canvas.width, canvas.height);
      Art.boat(g, CW * PPB / 2, CY * PPB, PPB, dir, { flip: tg.flip, snow: tg.flip && D.seasonOf(S.day) === 3, crew: cr, t, rowing: row, noShadow: true });
      tex.needsUpdate = true;
    }
    // obrázok na hladine (prevrátený na lávke móla), posunutý ku kamere o hĺbku najbližšieho bodu loďky
    const base = tg.flip ? DECK_Y : W.WATER_Y;
    ctx.camera.getWorldDirection(toCam).negate();
    const push = boatNear(dir) + 0.06;
    sprite.position.set(cur.x + toCam.x * push, base + toCam.y * push, cur.y + toCam.z * push);
    sprite.material.color.setRGB(...ctx.light(cur.x, base + 0.3, cur.y));
  }
  // miesto hráča v loďke: nad lavičkou (len pre meno; jeho postavička je nakreslená v obrázku loďky)
  function seat(who: Who | null): Seat | null {
    const d = S.dock;
    if (!d || !d.built || d.flip || S.area !== 'garden' || !cur || !sprite.visible) return null;
    const i = who ? d.seats.findIndex(k => isSeat(who, k)) : d.seats.indexOf(keyOf(S.name));
    if (i < 0) return null;
    // smer provy vo svete pre nakreslený pohľad (uhol na obrazovke mínus natočenie kamery)
    const aq = (BOAT2D.angle[dir] ?? 0) * Math.PI / 180 - ctx.yaw(), u = BOAT2D.seats[i] ?? 0;
    return { x: cur.x + Math.cos(aq) * u, z: cur.y + Math.sin(aq) * u, y: W.WATER_Y + BOAT2D.bench };
  }
  return {
    update, seat,
    boatAt: () => (cur && S.dock ? { x: cur.x, y: cur.y, dir, flip: S.dock.flip } : null),
    dispose(): void { scene.remove(sprite); tex.dispose(); sprite.material.dispose(); }
  };
}
