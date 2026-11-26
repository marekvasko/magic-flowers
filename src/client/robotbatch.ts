// Robot v hre (#194): zlúčené siete pre shader sveta. Robot z robot3d.ts má stovku až tri stovky dielov – v hre by to
// bolo toľko kreslení na hráča (a ešte raz v zrkadle vody). Tento backend diely zlúči:
//  - telo: jedna sieť (a jedna malá pre sklo); každý vrchol nesie číslo kĺbu a shader si maticu kĺbu prečíta z malej
//    textúry (4 texely = 1 matica 4×4 vo svete), ktorú update() po každej póze prepíše z matíc skupín kĺbov;
//  - náradie: jedna sieť na kus (hýbe sa ako bežný objekt – v ruke, na nosiči, v lete);
//  - kvapky vody z krhly: malé siete.
// Materiály (shader sveta s ROBOT – svetlo, tiene, tma) dodá render3d.ts.
import * as THREE from 'three';
import type { BatchItem, RobotBackend } from './robot3d.ts';

export type BatchMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
export interface BatchMaterials {
  skin: THREE.Material;        // telo: matice kĺbov z textúry (uniform jointTex)
  skinGlass: THREE.Material;   // sklo tela (priehľadné)
  rigid: THREE.Material;       // náradie a kvapky: bežná matica objektu
  jointTex: THREE.IUniform<THREE.Texture | null>;
  // každá vytvorená sieť (render3d jej nastaví vrstvy a zapamätá si ju, aby ju vedel nakresliť aj do mapy tieňov)
  added: (m: BatchMesh, kind: 'skin' | 'glass' | 'rigid') => void;
}

// Zlúči položky do jednej geometrie: poloha a normála v súradniciach kĺbu, farba, žiarenie, priehľadnosť, číslo kĺbu
function merge(items: readonly BatchItem[], jointOf: (it: BatchItem) => number): THREE.BufferGeometry {
  let n = 0, ni = 0;
  for (const it of items) { const c = it.geo.getAttribute('position').count; n += c; ni += it.geo.index ? it.geo.index.count : c; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), emis = new Float32Array(n), alpha = new Float32Array(n), joint = new Float32Array(n);
  const index = n > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let o = 0, oi = 0;
  for (const it of items) {
    const p = it.geo.getAttribute('position'), q = it.geo.getAttribute('normal'), j = jointOf(it);
    nm.getNormalMatrix(it.local);
    for (let k = 0; k < p.count; k++) {
      v.fromBufferAttribute(p, k).applyMatrix4(it.local); pos.set([v.x, v.y, v.z], (o + k) * 3);
      v.fromBufferAttribute(q, k).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (o + k) * 3);
      col.set(it.color, (o + k) * 3);
      emis[o + k] = it.emis; alpha[o + k] = it.alpha; joint[o + k] = j;
    }
    if (it.geo.index) for (let k = 0; k < it.geo.index.count; k++) index[oi++] = it.geo.index.getX(k) + o;
    else for (let k = 0; k < p.count; k++) index[oi++] = o + k;
    o += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('emis', new THREE.BufferAttribute(emis, 1));
  g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  g.setAttribute('joint', new THREE.BufferAttribute(joint, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

const DROP_GEO = new THREE.IcosahedronGeometry(0.008, 0);
{
  // kvapka: farba vo vrcholoch (shader sveta ju číta z atribútov)
  const n = DROP_GEO.getAttribute('position').count, one = (v: number): Float32Array => new Float32Array(n).fill(v);
  const c = new Float32Array(n * 3); for (let k = 0; k < n; k++) c.set([0.56, 0.83, 1], k * 3);
  DROP_GEO.setAttribute('color', new THREE.BufferAttribute(c, 3));
  DROP_GEO.setAttribute('emis', new THREE.BufferAttribute(one(0), 1));
  DROP_GEO.setAttribute('alpha', new THREE.BufferAttribute(one(1), 1));
}

export function robotBackend(mats: BatchMaterials): RobotBackend {
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, kind: 'skin' | 'glass'): BatchMesh => {
    const me: BatchMesh = new THREE.Mesh(g, m);
    me.frustumCulled = false; // vrcholy posúva shader (matice kĺbov) – obálka geometrie neplatí
    mats.added(me, kind);
    return me;
  };
  return {
    body(items) {
      const nodes: THREE.Object3D[] = [], idx = new Map<THREE.Object3D, number>();
      const jointOf = (it: BatchItem): number => {
        const node = it.node;
        if (!node) return 0;
        let i = idx.get(node);
        if (i === undefined) { i = nodes.length; nodes.push(node); idx.set(node, i); }
        return i;
      };
      const solid = items.filter(it => it.alpha >= 1), glass = items.filter(it => it.alpha < 1);
      const gs = merge(solid, jointOf), gg = glass.length ? merge(glass, jointOf) : null;
      const data = new Float32Array(Math.max(1, nodes.length) * 16);
      const tex = new THREE.DataTexture(data, 4, Math.max(1, nodes.length), THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
      mats.jointTex.value = tex;
      const objects = [mesh(gs, mats.skin, 'skin')];
      if (gg) { const m = mesh(gg, mats.skinGlass, 'glass'); m.renderOrder = 2; objects.push(m); }
      return {
        objects,
        update() { for (const [i, node] of nodes.entries()) node.matrixWorld.toArray(data, i * 16); tex.needsUpdate = true; },
        dispose() { gs.dispose(); gg?.dispose(); tex.dispose(); }
      };
    },
    tool(items) {
      const g = merge(items, () => 0), m: BatchMesh = new THREE.Mesh(g, mats.rigid);
      mats.added(m, 'rigid');
      return { objects: [m], dispose() { g.dispose(); } };
    },
    drop() { const m: BatchMesh = new THREE.Mesh(DROP_GEO, mats.rigid); mats.added(m, 'rigid'); return m; }
  };
}
