// Pavučiny (#57): generátor zdieľaný serverom, hrou a ladiacou stránkou (/debug → Generators → Cobwebs).
//  - WEB_PARAMS: všetky čísla pavučiny s rozsahom (rozmiestnenie, veľkosť, stavba, šum, vzhľad) – webParams(over) ich doplní a oreže;
//  - analyze(les, seed, over): nory vlčiakov, čistina pradleny, územia a miesta, kde môže visieť pavučina (rozpätie span / gladeSpan);
//  - webGeom(tiles, w, h, web, over): kde sa pavučina dotýka opôr – kmeňov stromov, obra (2 × 2), kríka, spadnutého kmeňa –
//    a aká je vysoká (pri kríku či kmeni na zemi nižšia), aby vlákna začínali na skutočnom kmeni;
//  - cornerSpots: kúty pre krížiaka.
// Shader, ktorý z parametrov kreslí vlákna, je v public/spiders3d.mjs (webMaterial).
(function (root) {
  const D = root.GameData || require('./data.js');
  const SP = D.SPIDERS, V = SP.vlciak;
  const LW = D.LES_W, LH = D.LES_H;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const NEAR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  const Pd = (def, min, max, step, group) => ({ def, min, max, step, group });
  const WEB_PARAMS = {
    // rozmiestnenie a veľkosť (span a gladeSpan menia, kde v lese pavučiny visia – použije ich server)
    span: Pd(2, 1, 4, 1, 'placement'), gladeSpan: Pd(3, 1, 5, 1, 'placement'), height: Pd(1.1, 0.4, 2.2, 0.05, 'placement'),
    // stavba: lúče, výplň (0 špirála, 1 sústredné kruhy, 2 podľa pavučiny), rozostup závitov, stred, voľná zóna, okraj
    rays: Pd(12, 4, 28, 1, 'structure'), raysVar: Pd(5, 0, 10, 1, 'structure'), fill: Pd(2, 0, 2, 1, 'structure'),
    pitch: Pd(0.055, 0.015, 0.16, 0.005, 'structure'), pitchVar: Pd(0.35, 0, 1, 0.05, 'structure'),
    hub: Pd(0.05, 0, 0.2, 0.01, 'structure'), free: Pd(0.11, 0, 0.4, 0.01, 'structure'), radius: Pd(0.47, 0.2, 0.75, 0.01, 'structure'),
    centerJitter: Pd(0.12, 0, 0.3, 0.01, 'structure'), moor: Pd(3, 1, 6, 1, 'structure'), sag: Pd(0.06, 0, 0.3, 0.01, 'structure'),
    // Perlinov šum: ohnutie lúčov, zvlnenie závitov, nerovný okraj, rozostup
    bend: Pd(0.22, 0, 0.8, 0.01, 'noise'), bendFreq: Pd(2.3, 0.2, 8, 0.1, 'noise'), wobble: Pd(0.035, 0, 0.2, 0.005, 'noise'),
    wobbleFreq: Pd(4, 0.5, 12, 0.5, 'noise'), edgeNoise: Pd(0.12, 0, 0.5, 0.01, 'noise'), pitchNoise: Pd(0.25, 0, 1, 0.05, 'noise'),
    // vzhľad: hrúbka vlákna (políčka), lesk (Kajiya–Kay), dúha v odlesku, priehľadnosť v šere
    width: Pd(0.006, 0.001, 0.03, 0.0005, 'look'), glint: Pd(48, 4, 160, 1, 'look'), iri: Pd(0.2, 0, 0.6, 0.01, 'look'), alpha: Pd(0.3, 0, 1, 0.05, 'look'),
    seed: Pd(0, 0, 999, 1, 'look')
  };
  function webParams(over) {
    const out = {};
    for (const [k, d] of Object.entries(WEB_PARAMS)) {
      const v = over && over[k] != null && over[k] !== '' && Number.isFinite(+over[k]) ? +over[k] : d.def;
      out[k] = Math.max(d.min, Math.min(d.max, d.step >= 1 ? Math.round(v) : v));
    }
    return out;
  }

  // Opory: polomer kmeňa pri zemi (políčka) a výška, po ktorú pavučina siaha (ker a spadnutý kmeň sú nízke).
  // Obor má kmeň na 2 × 2 políčkach (stred v strede štvorca, World3D.TREE_PARAMS.obor.trunkR ≈ 4,4 / 8).
  const ANCHOR = { tree: { r: 0.14, top: 9 }, giant: { r: 0.6, top: 9 }, trunk: { r: 0.6, top: 9 }, bush: { r: 0.36, top: 0.75 }, log: { r: 0.28, top: 0.55 } };
  function anchorAt(tiles, w, h, x, y) {
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x] : null;
    const t = at(x, y), g = t && (t.g || t);
    if (!g || !ANCHOR[g]) return null;
    let cx = x + 0.5, cz = y + 0.5;
    if (g === 'giant' || g === 'trunk') { // ľavý horný roh obra je 'giant'
      for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) { const o = at(x + dx, y + dy); if (o && (o.g || o) === 'giant') { cx = x + dx + 1; cz = y + dy + 1; break; } }
    }
    return Object.assign({ g, cx, cz }, ANCHOR[g]);
  }
  // Pavučina medzi oporami: rovina pozdĺž osi (ax 0: x, ax 1: z) na priamke line, od u0 po u1 (dotyk s kmeňmi), výška hgt.
  function webGeom(tiles, w, h, wb, over) {
    const P = webParams(over), ax = wb.ax ? 1 : 0;
    const A = ax ? anchorAt(tiles, w, h, wb.x, wb.y - 1) : anchorAt(tiles, w, h, wb.x - 1, wb.y);
    const B = ax ? anchorAt(tiles, w, h, wb.x, wb.y + wb.n) : anchorAt(tiles, w, h, wb.x + wb.n, wb.y);
    const line = ax ? wb.x + 0.5 : wb.y + 0.5;
    const lo = ax ? wb.y : wb.x, hi = lo + wb.n;
    // kde priamka pavučiny pretne kmeň (kruh okolo stredu opory) zo strany pavučiny
    const touch = (o, side, edge) => {
      if (!o) return edge;
      const c = ax ? o.cz : o.cx, off = line - (ax ? o.cx : o.cz), half = Math.sqrt(Math.max(0, o.r * o.r - off * off));
      const u = c + side * half;
      return side > 0 ? Math.min(Math.max(u, edge - 1.5), edge) : Math.max(Math.min(u, edge + 1.5), edge); // obor má stred kmeňa na rohu políčka
    };
    const u0 = touch(A, 1, lo), u1 = touch(B, -1, hi);
    const hgt = Math.min(P.height, A ? A.top : 9, B ? B.top : 9);
    return { ax, line, u0, u1, len: u1 - u0, hgt, a: A, b: B };
  }

  // ---- Rozbor lesa: nory, čistina pradleny, územia a miesta na pavučiny (rozpätie pavučín z parametrov) ----
  // BFS po priechodných políčkach od starts (najviac max krokov, ok(i) = smie sa vstúpiť). Vráti vzdialenosti (-1 = nedosiahnuté)
  // a pri viacerých štartoch aj, od ktorého štartu (src) je políčko najbližšie.
  function bfs(w, h, starts, ok, max) {
    const dist = new Int16Array(w * h).fill(-1), src = new Int16Array(w * h).fill(-1), q = [];
    starts.forEach((i, k) => { if (dist[i] < 0) { dist[i] = 0; src[i] = k; q.push(i); } });
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % w, y = (i / w) | 0;
      if (max != null && dist[i] >= max) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, n = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || dist[n] >= 0 || !ok(n)) continue;
        dist[n] = dist[i] + 1; src[n] = src[i]; q.push(n);
      }
    }
    return { dist, src };
  }

  function analyze(les, seed, over) {
    const P = webParams(over), w = LW, h = LH, N = w * h, g = i => les[i].g;
    const pass = i => !D.BLOCK[g(i)];
    const ent = bfs(w, h, les.map((t, i) => t.g === 'gate' ? i : -1).filter(i => i >= 0), pass).dist;
    const hx = (w - 1) / 2, hy = (h - 1) / 2, H = D.LES_HEART;
    const heart = i => Math.hypot((i % w - hx) / (H.rx + SP.heart), (((i / w) | 0) - hy) / (H.ry + SP.heart)) <= 1;
    const nobody = new Uint8Array(N);
    for (let i = 0; i < N; i++) if ((ent[i] >= 0 && ent[i] <= SP.entrance) || heart(i)) nobody[i] = 1;
    const owner = new Int16Array(N).fill(-1);
    const homes = [];

    // Stará pradlena: čistina (súvislé políčka 'glade' mimo srdca lesa) najďalej od vstupu; jej územie je čistina a 2 políčka okolo
    const comp = new Int32Array(N).fill(-1), comps = [];
    for (let i = 0; i < N; i++) {
      if (g(i) !== 'glade' || comp[i] >= 0) continue;
      const list = [i]; comp[i] = comps.length;
      for (let k = 0; k < list.length; k++) {
        const j = list[k], x = j % w, y = (j / w) | 0;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy, n = ny * w + nx;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || comp[n] >= 0 || g(n) !== 'glade') continue;
          comp[n] = comps.length; list.push(n);
        }
      }
      comps.push(list);
    }
    let lairComp = null, best = -1;
    for (const c of comps) {
      if (c.length < 6 || c.some(i => nobody[i] || ent[i] < 0)) continue;
      const d = Math.min(...c.map(i => ent[i]));
      if (d > best) { best = d; lairComp = c; }
    }
    const pradTiles = new Set();
    let lair = null;
    if (lairComp) {
      const cx = lairComp.reduce((s, i) => s + i % w, 0) / lairComp.length, cy = lairComp.reduce((s, i) => s + ((i / w) | 0), 0) / lairComp.length;
      lair = lairComp.reduce((a, i) => Math.hypot(i % w - cx, ((i / w) | 0) - cy) < Math.hypot(a % w - cx, ((a / w) | 0) - cy) ? i : a);
      for (const i of lairComp) {
        pradTiles.add(i);
        const x = i % w, y = (i / w) | 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const n = (y + dy) * w + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && pass(n) && !nobody[n]) pradTiles.add(n); }
      }
    }

    // Nory vlčiakov: pri kmeni vedľa chodníka, ďaleko od vstupu, od pradleny aj od seba (podľa semienka lesa – stále rovnaké)
    const rnd = D.mulberry32(((seed >>> 0) ^ 0x51ed27) >>> 0);
    const cand = [];
    for (let i = 0; i < N; i++) {
      if (!['path', 'moss', 'roots'].includes(g(i)) || nobody[i] || pradTiles.has(i) || ent[i] < SP.entrance + 6) continue;
      const x = i % w, y = (i / w) | 0;
      if (lair != null && Math.hypot(x - lair % w, y - ((lair / w) | 0)) < V.reach) continue;
      if (!DIRS.some(([dx, dy]) => { const t = les[(y + dy) * w + x + dx]; return t && ['tree', 'giant', 'trunk'].includes(t.g); })) continue;
      cand.push(i);
    }
    for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
    const burrows = [];
    for (const i of cand) {
      if (burrows.length >= V.n) break;
      if (burrows.some(b => Math.hypot(b % w - i % w, ((b / w) | 0) - ((i / w) | 0)) < V.gap)) continue;
      burrows.push(i);
    }
    // Územia vlčiakov: najbližšia nora (po chodníkoch) do V.reach krokov; ničie miesta a územie pradleny vynecháme
    const terr = bfs(w, h, burrows, n => pass(n) && !nobody[n] && !pradTiles.has(n), V.reach);
    for (let i = 0; i < N; i++) if (terr.src[i] >= 0) owner[i] = terr.src[i];
    burrows.forEach(i => homes.push({ k: 'v', i, x: i % w, y: (i / w) | 0 }));
    if (lair != null) {
      const o = homes.length;
      for (const i of pradTiles) owner[i] = o;
      homes.push({ k: 'p', i: lair, x: lair % w, y: (lair / w) | 0 });
    }

    // Miesta na pavučiny: rad priechodných políčok jedného majiteľa medzi dvoma oporami (kmeň, strom, ker, spadnutý kmeň)
    const webable = i => pass(i) && g(i) !== 'gate' && !nobody[i];
    const cands = homes.map(() => []);
    for (let i = 0; i < N; i++) {
      const o = owner[i];
      if (o < 0 || !webable(i)) continue;
      const x = i % w, y = (i / w) | 0;
      for (const ax of [0, 1]) {
        const [sx, sy] = ax ? [0, 1] : [1, 0];
        const bx = x - sx, by = y - sy;
        if (bx < 0 || by < 0 || !D.WEB_ANCHOR[g(by * w + bx)]) continue;
        const tiles = [];
        for (let n = 1; n <= P.gladeSpan; n++) {
          const tx = x + sx * (n - 1), ty = y + sy * (n - 1), ti = ty * w + tx;
          if (tx >= w || ty >= h || !webable(ti) || owner[ti] !== o) break;
          tiles.push(ti);
          const ex = x + sx * n, ey = y + sy * n;
          if (ex >= w || ey >= h) break;
          if (!D.WEB_ANCHOR[g(ey * w + ex)]) continue;
          if (n <= P.span || tiles.some(j => g(j) === 'glade')) cands[o].push({ x, y, ax, n, o, tiles: tiles.slice() });
          break;
        }
      }
    }
    return { owner, homes, cands, nobody, ent };
  }

  // Kút: priechodné políčko P pri konci steny (budova, balvan, skala) – stena je vedľa P v smere d a v smere e (kolmo)
  // sa už končí. Pavučina visí na hrane steny pri zemi. Kľúč kúta: "i:d:e" (indexy smerov v DIRS).
  function cornerSpots(tiles, w, h) {
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h ? tiles[y * w + x] : null;
    const wall = t => t && D.CORNER_WALL[t.g];
    const open = t => t && D.passable(t) && t.g !== 'gate' && t.g !== 'glacier';
    const out = [];
    for (let i = 0; i < tiles.length; i++) {
      if (!open(tiles[i])) continue;
      const x = i % w, y = (i / w) | 0;
      DIRS.forEach(([dx, dy], di) => {
        if (!wall(at(x + dx, y + dy))) return;
        DIRS.forEach(([ex, ey], ei) => {
          if (ex * dx + ey * dy !== 0) return; // len kolmo na stenu
          if (wall(at(x + dx + ex, y + dy + ey)) || !open(at(x + ex, y + ey))) return;
          out.push({ k: `${i}:${di}:${ei}`, i, x, y, dx, dy, ex, ey });
        });
      });
    }
    return out;
  }

  const api = { WEB_PARAMS, webParams, ANCHOR, anchorAt, webGeom, analyze, cornerSpots, bfs };
  root.Webs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
