// Stopy v snehu v 3D (#159): jemné odtlačky vtlačené do snehu – šľapaje ľudí, drobné bodky pavúkov a dve súbežné čiary
// saní. Všetky stopy plochy sú JEDNA sieť (instancovaný štvorec, jedno kreslenie – #120): na stopu poloha, smer, druh
// a krok vzniku a zmiznutia; miznutie počíta shader z herného kroku (uTick), CPU pri každej snímke nič neprepočítava.
// Kresba stôp je malá textúra (4 políčka: ľavá šľapaj, pravá šľapaj, pavúk, sane) – len maska, farbu dá svetlo sveta.
// Stopy kreslí len hlavná kamera (vrstva 1): nevrhajú tieň a vo vode sa nezrkadlia.
// render3d.ts volá update() každú snímku; zoznam stôp je S.tracks (zo servera, game.ts), zmenu ohlási S.tracksGen.
import type * as THREE from 'three';
import * as T from '../shared/tracks.ts';
import type { TrackMark } from '../shared/tracks.ts';
import type { ViewState } from './state.ts';

type Three = typeof THREE;
export interface Tracks3dApi {
  THREE: Three; scene: THREE.Scene; S: ViewState; groundY: (x: number, y: number) => number;
  world: { ambient: THREE.IUniform<THREE.Vector3>; sunColor: THREE.IUniform<THREE.Vector3> }; // svetlo sveta (render3d)
}
export interface Tracks3d { readonly mesh: THREE.Mesh; update: () => void; count: () => number; dispose: () => void }

// Veľkosť stopy v políčkach: dĺžka (v smere pohybu) × šírka, podľa kódu druhu (encode: 0/1 šľapaj, 2 pavúk, 3 sane)
const SIZE: readonly (readonly [number, number])[] = [[0.27, 0.13], [0.27, 0.13], [0.3, 0.3], [T.TRACKS.stride.runner * 1.08, 0.46]];
const LIFT = 0.012; // nad zemou (proti blikaniu s terénom)

const VERT = `
attribute vec3 iPos; attribute vec4 iA; // iA = smer, druh, krok vzniku, krok zmiznutia
uniform float uTick; uniform vec2 uSize[4];
varying vec2 vUv; varying float vFade;
void main() {
  int code = int(iA.y + 0.5);
  vec2 size = uSize[0];
  if (code == 1) size = uSize[1]; else if (code == 2) size = uSize[2]; else if (code == 3) size = uSize[3];
  vec2 l = position.xy * size; // x v smere pohybu, y naprieč
  float c = cos(iA.x), s = sin(iA.x);
  vec3 p = vec3(iPos.x + l.x * c - l.y * s, iPos.y, iPos.z + l.x * s + l.y * c);
  vFade = clamp((iA.w - uTick) / max(1.0, iA.w - iA.z), 0.0, 1.0);
  vUv = vec2((float(code) + position.x + 0.5) / 4.0, position.y + 0.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const FRAG = `
uniform sampler2D uTex; uniform vec3 ambient; uniform vec3 sunColor; uniform float uAlpha;
varying vec2 vUv; varying float vFade;
void main() {
  float a = texture2D(uTex, vUv).a * uAlpha * (0.25 + 0.75 * vFade) * smoothstep(0.0, 0.25, vFade);
  if (a < 0.01) discard;
  vec3 lit = min(vec3(1.2), ambient + sunColor * 0.7);
  gl_FragColor = vec4(vec3(0.52, 0.6, 0.74) * lit, a); // tieň vo vtlačenom snehu: modrosivý
}`;

// Kresba stôp (maska): v každom políčku 64 × 64 ide os x v smere pohybu (špička topánky vpravo)
function atlas(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = '#fff';
  const ell = (x: number, y: number, rx: number, ry: number, a?: number): void => { g.beginPath(); g.ellipse(x, y, rx, ry, a ?? 0, 0, Math.PI * 2); g.fill(); };
  g.filter = 'blur(1.5px)';
  for (const [cell, arch] of [[0, -1], [1, 1]] as const) { // ľavá a pravá šľapaj: podrážka s klenbou na vnútornej strane, päta
    const ox = cell * 64;
    ell(ox + 42, 32 - arch * 2, 17, 20, arch * 0.12);
    ell(ox + 15, 32 + arch * 1.5, 11, 15);
    g.globalAlpha = 0.6; ell(ox + 28, 32 + arch * 6, 8, 9); g.globalAlpha = 1;
  }
  const dots: readonly (readonly [number, number])[] = [[10, 16], [24, 12], [39, 12], [53, 16], [12, 48], [25, 52], [40, 52], [54, 48]];
  for (const [x, y] of dots) ell(128 + x, y, 4.2, 4.2); // pavúk: osem nôh v dvoch radoch
  g.globalAlpha = 0.35; ell(128 + 32, 32, 9, 2.5); g.globalAlpha = 1; // stopa bruška
  g.filter = 'blur(1px)';
  g.fillRect(192 - 2, 6, 68, 7); g.fillRect(192 - 2, 51, 68, 7); // sane: dve lyžiny (cez okraj políčka, nech sa stopy spoja)
  return c;
}

export function createTracks3d(api: Tracks3dApi): Tracks3d {
  const { THREE, scene, S, groundY } = api;
  const tex = new THREE.CanvasTexture(atlas());
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4;
  const uTick: THREE.IUniform<number> = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: {
      uTex: { value: tex }, uTick, uAlpha: { value: 0.55 },
      uSize: { value: SIZE.map(([l, w]) => new THREE.Vector2(l, w)) },
      ambient: api.world.ambient, sunColor: api.world.sunColor
    }
  });
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 2, 1, 0, 3, 2]); // zhora (os y štvorca ide do +z sveta)
  let cap = 0, pos: THREE.InstancedBufferAttribute | null = null, inf: THREE.InstancedBufferAttribute | null = null;
  function ensure(n: number): void {
    if (n <= cap && pos && inf) return;
    cap = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
    pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    inf = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    pos.setUsage(THREE.DynamicDrawUsage); inf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', pos); geo.setAttribute('iA', inf);
  }
  ensure(T.TRACKS.cap);
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.layers.set(1); // po terénne, pred spritmi; nie do tieňov ani zrkadla
  scene.add(mesh);

  const CODE: Readonly<Record<T.TrackKind, number>> = { foot: 0, spider: 2, runner: 3 };
  let builtGen = -1, builtTiles = -1, builtAt = 0, shown = 0;
  function rebuild(list: readonly TrackMark[]): void {
    ensure(list.length);
    const P = pos, A = inf;
    if (!P || !A) return;
    const pa = P.array, ia = A.array;
    let n = 0;
    for (const m of list) {
      if (m.e <= S.tick) continue; // zmizla (server ju aj tak vyhodí)
      pa[n * 3] = m.x; pa[n * 3 + 1] = groundY(m.x, m.y) + LIFT; pa[n * 3 + 2] = m.y;
      ia[n * 4] = m.a; ia[n * 4 + 1] = CODE[m.k] + (m.s ? 1 : 0); ia[n * 4 + 2] = m.t; ia[n * 4 + 3] = m.e;
      n++;
    }
    P.needsUpdate = true; A.needsUpdate = true;
    geo.instanceCount = shown = n;
  }
  function update(): void {
    const list = S.tracks || [], now = performance.now();
    uTick.value = S.tick;
    // prestavba pri zmene zoznamu, nového sveta (výšky zeme) a občas (zmiznuté stopy von)
    if (builtGen !== (S.tracksGen ?? 0) || builtTiles !== S.tilesGen || now - builtAt > 5000) {
      builtGen = S.tracksGen ?? 0; builtTiles = S.tilesGen; builtAt = now;
      rebuild(list);
    }
  }
  return {
    mesh, update, count: () => shown,
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); tex.dispose(); }
  };
}
