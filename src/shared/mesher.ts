// Optimalizácia siete z kociek (greedy meshing): susedné viditeľné steny v jednej rovine s rovnakým materiálom
// a rovnakým ambientným zatienením rohov sa zlúčia do jedného obdĺžnika – namiesto 2 trojuholníkov na každú stenu
// kocky ostane len toľko trojuholníkov, koľko treba na obrys povrchu. Používa to zem (podkocky) aj jemné modely.
// Zdieľa ho klient (render3d.ts) aj testy; nezávisí od Three.js.

// Os mriežky (x, y, z) a bod / bunka v nej
export type Axis = 0 | 1 | 2;
export type Vec3 = [number, number, number];
type Sign = 1 | -1;
export const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]] as const; // [normálová os, u, v] – u × v = normála
// rohy steny (du, dv) v poradí, v akom idú do siete – pri zápornej normále opačne, aby stena smerovala von
export const CORNERS = [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [0, 1], [1, 1], [1, 0]]] as const;
// šesť smerov stien v poradí f = 0..5: +x, -x, +y, -y, +z, -z
const FACES: readonly { ax: Axis; sg: Sign }[] = [{ ax: 0, sg: 1 }, { ax: 0, sg: -1 }, { ax: 1, sg: 1 }, { ax: 1, sg: -1 }, { ax: 2, sg: 1 }, { ax: 2, sg: -1 }];

// Materiál bunky (0 = prázdno); mimo mriežky rozhoduje volajúci
export type CellGet = (x: number, y: number, z: number) => number;
// Kreslí sa stena bunky m smerom k susedovi nb? (os ax, znamienko sg)
export type Visible = (m: number, nb: number, ax: Axis, sg: Sign) => boolean;
// Zatieňuje bunka v roh steny? front = sused pred stenou
export type Occludes = (v: number, front: number) => boolean;
// Zlúčený obdĺžnik: d je bunka po normále, (u, v) prvá bunka v rovine, w × h rozmer v bunkách,
// ao = 4 hodnoty zatienenia (0 – 3) v poradí rohov CORNERS[sg < 0]
export interface Quad { ax: Axis; sg: Sign; m: number; d: number; u: number; v: number; w: number; h: number; ao: number[] }

// Zatienenie 4 rohov steny bunky c (os ax, znamienko sg, sused pred stenou nb): dve bočné a jedna rohová bunka vo vrstve
// pred stenou. Vráti bajt – roh (du, dv) má 2 bity na pozícii (du * 2 + dv) * 2, hodnota 0 (najtmavší) až 3 (bez tieňa).
const q: Vec3 = [0, 0, 0];
export function faceAo(get: CellGet, occ: Occludes, c: Readonly<Vec3>, ax: Axis, sg: number, nb: number): number {
  const [, ua, va] = AXES[ax];
  let packed = 0;
  for (let du = 0; du < 2; du++) for (let dv = 0; dv < 2; dv++) {
    const su = du ? 1 : -1, sv = dv ? 1 : -1;
    q[ax] = c[ax] + sg; q[ua] = c[ua] + su; q[va] = c[va];
    const o1 = occ(get(q[0], q[1], q[2]), nb) ? 1 : 0;
    q[ua] = c[ua]; q[va] = c[va] + sv;
    const o2 = occ(get(q[0], q[1], q[2]), nb) ? 1 : 0;
    q[ua] = c[ua] + su;
    const oc = occ(get(q[0], q[1], q[2]), nb) ? 1 : 0;
    const ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
    packed |= ao << ((du * 2 + dv) * 2);
  }
  return packed;
}

// Zlúčené steny mriežky [sx, sy, sz].
//   get(x, y, z)            → materiál bunky (0 = prázdno); mimo mriežky rozhoduje volajúci
//   visible(m, nb, ax, sg)  → kreslí sa stena bunky m smerom k susedovi nb? (os ax, znamienko sg)
//   occ(v, front)           → zatieňuje bunka v roh steny? front = sused pred stenou
// Vráti zoznam obdĺžnikov { ax, sg, m, d, u, v, w, h, ao } – d je bunka po normále, (u, v) prvá bunka v rovine,
// w × h rozmer v bunkách, ao = 4 hodnoty zatienenia (0 – 3) v poradí rohov CORNERS[sg < 0].
// Zlučuje sa len to, čo vyzerá rovnako: rovnaký materiál a rovnaké zatienenie rohov. Stena, ktorej zatienenie
// sa mení len po jednej osi, sa zlúči po druhej osi (prechod tieňa ostane rovnaký); stena so zatienením,
// ktoré sa mení po oboch osiach, ostane samostatná.
export function greedy(dims: Readonly<Vec3>, get: CellGet, visible: Visible, occ: Occludes): Quad[] {
  const out: Quad[] = [];
  for (const { ax, sg } of FACES) {
    const [, ua, va] = AXES[ax];
    const nd = dims[ax], nu = dims[ua], nv = dims[va];
    const corners = CORNERS[sg < 0 ? 1 : 0];
    // maska jednej roviny: kľúč (materiál a zatienenie) alebo -1, keď tu stena nie je
    const key = new Int32Array(nu * nv), done = new Uint8Array(nu * nv);
    const c: Vec3 = [0, 0, 0];
    for (let d = 0; d < nd; d++) {
      key.fill(-1); done.fill(0);
      let any = false;
      for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) {
        c[ax] = d; c[ua] = u; c[va] = v;
        const m = get(c[0], c[1], c[2]);
        if (!m) continue;
        c[ax] = d + sg;
        const nb = get(c[0], c[1], c[2]);
        c[ax] = d;
        if (!visible(m, nb, ax, sg)) continue;
        const packed = faceAo(get, occ, c, ax, sg, nb);
        key[v * nu + u] = m * 256 + packed;
        any = true;
      }
      if (!any) continue;
      for (let v = 0; v < nv; v++) for (let u = 0; u < nu; u++) {
        const i = v * nu + u, k = key[i] ?? -1;
        if (k < 0 || done[i]) continue;
        const packed = k & 255, a = (j: number): number => (packed >> (j * 2)) & 3; // j = du * 2 + dv
        const alongU = a(0) === a(2) && a(1) === a(3); // zatienenie sa po u nemení
        const alongV = a(0) === a(1) && a(2) === a(3); // ... po v nemení
        let w = 1;
        if (alongU) while (u + w < nu && key[i + w] === k && !done[i + w]) w++;
        let h = 1;
        if (alongV) {
          grow: while (v + h < nv) {
            const row = (v + h) * nu + u;
            for (let j = 0; j < w; j++) if (key[row + j] !== k || done[row + j]) break grow;
            h++;
          }
        }
        for (let y = 0; y < h; y++) done.fill(1, (v + y) * nu + u, (v + y) * nu + u + w);
        out.push({ ax, sg, m: k >> 8, d, u, v, w, h, ao: corners.map(([du, dv]) => a(du * 2 + dv)) });
      }
    }
  }
  return out;
}

// Rohy obdĺžnika v bunkách mriežky (v poradí CORNERS) – stena leží na rovine d (záporná normála) alebo d + 1
export function quadCorners(q: Readonly<Pick<Quad, 'ax' | 'sg' | 'd' | 'u' | 'v' | 'w' | 'h'>>): Vec3[] {
  const [, ua, va] = AXES[q.ax];
  return CORNERS[q.sg < 0 ? 1 : 0].map(([du, dv]) => {
    const p: Vec3 = [0, 0, 0];
    p[q.ax] = q.d + (q.sg > 0 ? 1 : 0);
    p[ua] = q.u + du * q.w; p[va] = q.v + dv * q.h;
    return p;
  });
}
// index plochy (+x, -x, +y, -y, +z, -z)
export const faceIndex = (q: Readonly<Pick<Quad, 'ax' | 'sg'>>): number => q.ax * 2 + (q.sg > 0 ? 0 : 1);
// uhlopriečka podľa zatienenia, aby tieň v rohoch nebol „zalomený“ – indexy 2 trojuholníkov od vrcholu vi
export function quadIndices(ao: readonly number[], vi: number): number[] {
  const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = ao;
  return a0 + a2 < a1 + a3 ? [vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi] : [vi, vi + 1, vi + 2, vi, vi + 2, vi + 3];
}

// Rozloženie obdĺžnikov [w, h] do jedného obrázka (po riadkoch od najvyšších) → { W, H, at: [[x, y], …] }
export function pack(rects: readonly (readonly [number, number])[]): { W: number; H: number; at: [number, number][] } {
  let area = 0, maxW = 1;
  for (const [w, h] of rects) { area += w * h; maxW = Math.max(maxW, w); }
  let W = 1;
  while (W < Math.max(maxW, Math.sqrt(area * 1.15))) W *= 2;
  const size = (i: number): readonly [number, number] => rects[i] ?? [0, 0];
  const order = rects.map((r, i) => i).sort((a, b) => size(b)[1] - size(a)[1] || size(b)[0] - size(a)[0]);
  const at = new Array<[number, number]>(rects.length);
  let x = 0, y = 0, rowH = 0;
  for (const i of order) {
    const [w, h] = size(i);
    if (x + w > W) { x = 0; y += rowH; rowH = 0; }
    at[i] = [x, y];
    x += w; rowH = Math.max(rowH, h);
  }
  return { W, H: Math.max(1, y + rowH), at };
}

// Farba steny minikocky: [r, g, b, žiarenie] v 0..1
export type Look = (m: number, x: number, y: number, z: number, f: number) => readonly number[];
export interface Baked {
  quads: Quad[]; P: Float32Array; N: Int8Array; UV: Float32Array; UV2: Float32Array; I: Uint16Array | Uint32Array;
  color: { W: number; H: number; data: Uint8Array }; ao: { W: number; H: number; data: Uint8Array };
}
// Model s vypečenou textúrou: sieť je len povrch (steny sa zlúčia bez ohľadu na materiál a tieň) a všetko ostatné
// je v dvoch obrázkoch modelu:
//   color – 1 texel na stenu minikocky (bez interpolácie): RGB = look(m, x, y, z, f) a alfa = žiarenie;
//   ao    – jeden kanál: jas zatienenia v rohoch minikociek, (w + 1) × (h + 1) na obdĺžnik, čítajú sa s lineárnou
//           interpoláciou – presne ako kedysi zatienenie vo vrcholoch (v zlúčenom obdĺžniku sú rohy spojité).
// Každý obdĺžnik má okraj 1 texel (kópia krajných), aby nepresnosť na hrane nesiahla do suseda v obrázku.
//   look(m, x, y, z, f) → [r, g, b, žiarenie] v 0..1; aoCurve[0..3] = jas pre zatienenie 0 (najtmavší) až 3
// Vráti { quads, P (v bunkách), N, UV, UV2, I, color: { W, H, data }, ao: { W, H, data } }.
export function bakeModel(dims: Readonly<Vec3>, get: CellGet, occ: Occludes, look: Look, aoCurve: readonly number[]): Baked {
  const solid = (x: number, y: number, z: number): number => (get(x, y, z) ? 1 : 0);
  const quads = greedy(dims, solid, (m, nb) => !nb, () => false);
  const cp = pack(quads.map(q => [q.w + 2, q.h + 2])), ap = pack(quads.map(q => [q.w + 3, q.h + 3]));
  const col = new Uint8Array(cp.W * cp.H * 4), ao = new Uint8Array(ap.W * ap.H);
  const n = quads.length, P = new Float32Array(n * 12), N = new Int8Array(n * 12);
  const UV = new Float32Array(n * 8), UV2 = new Float32Array(n * 8);
  const I = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);
  const c: Vec3 = [0, 0, 0], clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
  quads.forEach((q, k) => {
    const { ax, sg, d, u, v, w, h } = q, [, ua, va] = AXES[ax], f = faceIndex(q);
    const cell = (i: number, j: number): Vec3 => { c[ax] = d; c[ua] = u + i; c[va] = v + j; return c; };
    // farby stien minikociek
    const [cx, cy] = cp.at[k] ?? [0, 0];
    for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) {
      const p = cell(clamp(i, 0, w - 1), clamp(j, 0, h - 1));
      const rgbe = look(get(p[0], p[1], p[2]), p[0], p[1], p[2], f);
      const o = ((cy + 1 + j) * cp.W + cx + 1 + i) * 4;
      for (let t = 0; t < 4; t++) col[o + t] = Math.round(clamp(rgbe[t] ?? 0, 0, 1) * 255);
    }
    // zatienenie v rohoch (cu, cv) – z minikocky obdĺžnika, ktorej je to roh
    const [ox, oy] = ap.at[k] ?? [0, 0];
    for (let j = -1; j <= h + 1; j++) for (let i = -1; i <= w + 1; i++) {
      const cu = clamp(i, 0, w), cv = clamp(j, 0, h), ci = Math.min(cu, w - 1), cj = Math.min(cv, h - 1);
      const p = cell(ci, cj);
      c[ax] = d + sg;
      const nb = get(c[0], c[1], c[2]);
      c[ax] = d;
      const bits = faceAo(get, occ, p, ax, sg, nb), du = cu - ci, dv = cv - cj;
      ao[(oy + 1 + j) * ap.W + ox + 1 + i] = Math.round((aoCurve[(bits >> ((du * 2 + dv) * 2)) & 3] ?? 0) * 255);
    }
    const corners = CORNERS[sg < 0 ? 1 : 0];
    quadCorners(q).forEach((pt, j) => {
      const i = k * 4 + j, [du, dv] = corners[j] ?? [0, 0];
      P.set(pt, i * 3);
      N[i * 3 + ax] = sg;
      UV[i * 2] = (cx + 1 + du * w) / cp.W; UV[i * 2 + 1] = (cy + 1 + dv * h) / cp.H;
      UV2[i * 2] = (ox + 1.5 + du * w) / ap.W; UV2[i * 2 + 1] = (oy + 1.5 + dv * h) / ap.H; // stredy rohových texelov
    });
    I.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
  });
  return { quads, P, N, UV, UV2, I, color: { W: cp.W, H: cp.H, data: col }, ao: { W: ap.W, H: ap.H, data: ao } };
}
