// Optimalizácia siete z kociek (greedy meshing): susedné viditeľné steny v jednej rovine s rovnakým materiálom
// a rovnakým ambientným zatienením rohov sa zlúčia do jedného obdĺžnika – namiesto 2 trojuholníkov na každú stenu
// kocky ostane len toľko trojuholníkov, koľko treba na obrys povrchu. Používa to zem (podkocky) aj jemné modely.
// Zdieľa ho klient (render3d.mjs) aj testy; nezávisí od Three.js.
(function (root) {
  const AXES = [[0, 1, 2], [1, 2, 0], [2, 0, 1]]; // [normálová os, u, v] – u × v = normála
  // rohy steny (du, dv) v poradí, v akom idú do siete – pri zápornej normále opačne, aby stena smerovala von
  const CORNERS = [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [0, 1], [1, 1], [1, 0]]];

  // Zatienenie 4 rohov steny bunky c (os ax, znamienko sg, sused pred stenou nb): dve bočné a jedna rohová bunka vo vrstve
  // pred stenou. Vráti bajt – roh (du, dv) má 2 bity na pozícii (du * 2 + dv) * 2, hodnota 0 (najtmavší) až 3 (bez tieňa).
  const q = [0, 0, 0];
  function faceAo(get, occ, c, ax, sg, nb) {
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
  function greedy(dims, get, visible, occ) {
    const out = [];
    for (let f = 0; f < 6; f++) {
      const ax = f >> 1, sg = f & 1 ? -1 : 1, [, ua, va] = AXES[ax];
      const nd = dims[ax], nu = dims[ua], nv = dims[va];
      const corners = CORNERS[sg < 0 ? 1 : 0];
      // maska jednej roviny: kľúč (materiál a zatienenie) alebo -1, keď tu stena nie je
      const key = new Int32Array(nu * nv), done = new Uint8Array(nu * nv);
      const c = [0, 0, 0];
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
          const i = v * nu + u, k = key[i];
          if (k < 0 || done[i]) continue;
          const packed = k & 255, a = j => (packed >> (j * 2)) & 3; // j = du * 2 + dv
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
  function quadCorners(q) {
    const [, ua, va] = AXES[q.ax];
    return CORNERS[q.sg < 0 ? 1 : 0].map(([du, dv]) => {
      const p = [0, 0, 0];
      p[q.ax] = q.d + (q.sg > 0 ? 1 : 0);
      p[ua] = q.u + du * q.w; p[va] = q.v + dv * q.h;
      return p;
    });
  }
  // index plochy (+x, -x, +y, -y, +z, -z)
  const faceIndex = q => q.ax * 2 + (q.sg > 0 ? 0 : 1);
  // uhlopriečka podľa zatienenia, aby tieň v rohoch nebol „zalomený“ – indexy 2 trojuholníkov od vrcholu vi
  function quadIndices(ao, vi) {
    return ao[0] + ao[2] < ao[1] + ao[3] ? [vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi] : [vi, vi + 1, vi + 2, vi, vi + 2, vi + 3];
  }

  // Rozloženie obdĺžnikov [w, h] do jedného obrázka (po riadkoch od najvyšších) → { W, H, at: [[x, y], …] }
  function pack(rects) {
    let area = 0, maxW = 1;
    for (const [w, h] of rects) { area += w * h; maxW = Math.max(maxW, w); }
    let W = 1;
    while (W < Math.max(maxW, Math.sqrt(area * 1.15))) W *= 2;
    const order = rects.map((r, i) => i).sort((a, b) => rects[b][1] - rects[a][1] || rects[b][0] - rects[a][0]);
    const at = new Array(rects.length);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const [w, h] = rects[i];
      if (x + w > W) { x = 0; y += rowH; rowH = 0; }
      at[i] = [x, y];
      x += w; rowH = Math.max(rowH, h);
    }
    return { W, H: Math.max(1, y + rowH), at };
  }

  // Model s vypečenou textúrou: sieť je len povrch (steny sa zlúčia bez ohľadu na materiál a tieň) a všetko ostatné
  // je v dvoch obrázkoch modelu:
  //   color – 1 texel na stenu minikocky (bez interpolácie): RGB = look(m, x, y, z, f) a alfa = žiarenie;
  //   ao    – jeden kanál: jas zatienenia v rohoch minikociek, (w + 1) × (h + 1) na obdĺžnik, čítajú sa s lineárnou
  //           interpoláciou – presne ako kedysi zatienenie vo vrcholoch (v zlúčenom obdĺžniku sú rohy spojité).
  // Každý obdĺžnik má okraj 1 texel (kópia krajných), aby nepresnosť na hrane nesiahla do suseda v obrázku.
  //   look(m, x, y, z, f) → [r, g, b, žiarenie] v 0..1; aoCurve[0..3] = jas pre zatienenie 0 (najtmavší) až 3
  // Vráti { quads, P (v bunkách), N, UV, UV2, I, color: { W, H, data }, ao: { W, H, data } }.
  function bakeModel(dims, get, occ, look, aoCurve) {
    const solid = (x, y, z) => (get(x, y, z) ? 1 : 0);
    const quads = greedy(dims, solid, (m, nb) => !nb, () => false);
    const cp = pack(quads.map(q => [q.w + 2, q.h + 2])), ap = pack(quads.map(q => [q.w + 3, q.h + 3]));
    const col = new Uint8Array(cp.W * cp.H * 4), ao = new Uint8Array(ap.W * ap.H);
    const n = quads.length, P = new Float32Array(n * 12), N = new Int8Array(n * 12);
    const UV = new Float32Array(n * 8), UV2 = new Float32Array(n * 8);
    const I = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
    const c = [0, 0, 0], clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    quads.forEach((q, k) => {
      const { ax, sg, d, u, v, w, h } = q, [, ua, va] = AXES[ax], f = faceIndex(q);
      const cell = (i, j) => { c[ax] = d; c[ua] = u + i; c[va] = v + j; return c; };
      // farby stien minikociek
      const [cx, cy] = cp.at[k];
      for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) {
        const p = cell(clamp(i, 0, w - 1), clamp(j, 0, h - 1));
        const rgbe = look(get(p[0], p[1], p[2]), p[0], p[1], p[2], f);
        const o = ((cy + 1 + j) * cp.W + cx + 1 + i) * 4;
        for (let t = 0; t < 4; t++) col[o + t] = Math.round(clamp(rgbe[t], 0, 1) * 255);
      }
      // zatienenie v rohoch (cu, cv) – z minikocky obdĺžnika, ktorej je to roh
      const [ox, oy] = ap.at[k];
      for (let j = -1; j <= h + 1; j++) for (let i = -1; i <= w + 1; i++) {
        const cu = clamp(i, 0, w), cv = clamp(j, 0, h), ci = Math.min(cu, w - 1), cj = Math.min(cv, h - 1);
        const p = cell(ci, cj);
        c[ax] = d + sg;
        const nb = get(c[0], c[1], c[2]);
        c[ax] = d;
        const bits = faceAo(get, occ, p, ax, sg, nb), du = cu - ci, dv = cv - cj;
        ao[(oy + 1 + j) * ap.W + ox + 1 + i] = Math.round(aoCurve[(bits >> ((du * 2 + dv) * 2)) & 3] * 255);
      }
      quadCorners(q).forEach((pt, j) => {
        const i = k * 4 + j, [du, dv] = CORNERS[sg < 0 ? 1 : 0][j];
        P.set(pt, i * 3);
        N[i * 3 + ax] = sg;
        UV[i * 2] = (cx + 1 + du * w) / cp.W; UV[i * 2 + 1] = (cy + 1 + dv * h) / cp.H;
        UV2[i * 2] = (ox + 1.5 + du * w) / ap.W; UV2[i * 2 + 1] = (oy + 1.5 + dv * h) / ap.H; // stredy rohových texelov
      });
      I.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    });
    return { quads, P, N, UV, UV2, I, color: { W: cp.W, H: cp.H, data: col }, ao: { W: ap.W, H: ap.H, data: ao } };
  }

  const api = { AXES, CORNERS, greedy, faceAo, pack, bakeModel, quadCorners, faceIndex, quadIndices };
  root.Mesher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
