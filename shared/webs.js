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
    centerJitter: Pd(0.12, 0, 0.3, 0.01, 'structure'), sag: Pd(0.06, 0, 0.3, 0.01, 'structure'),
    // veľká pavučina: náhodne 1 … hubs stredov (na každý aspoň hubSpan políčka šírky), na každom kmeni moorMin … moor kotviacich vlákien
    hubs: Pd(3, 1, 4, 1, 'structure'), hubSpan: Pd(1.3, 0.5, 3, 0.1, 'structure'), moorMin: Pd(1, 0, 6, 1, 'structure'), moor: Pd(4, 0, 6, 1, 'structure'),
    // kútová pavučina krížiaka: 3 kotvy na 2 alebo 3 susedných plochách kúta (najďalej cornerSize od kúta),
    // so šancou cornerBreak zlom na hrane (bod posunutý o breakPull k protiľahlému vrcholu a vlákno k nemu)
    cornerSize: Pd(0.7, 0.3, 1.2, 0.05, 'corner'), cornerBreak: Pd(0.5, 0, 1, 0.05, 'corner'), breakPull: Pd(0.25, 0, 0.6, 0.01, 'corner'),
    cornerRays: Pd(11, 4, 20, 1, 'corner'), cornerFill: Pd(0.85, 0.4, 1, 0.01, 'corner'),
    // pavučina v kúte budovy z minikociek je malá – menej detailov: počet lúčov a rozostup závitov v minikockách
    voxelRays: Pd(5, 3, 12, 1, 'corner'), voxelPitch: Pd(0.8, 0.3, 2, 0.05, 'corner'),
    // kreslenie: 0 = shader na rovine (vlákna z výpočtu v každom pixeli), 1 = skutočné 3D vlákna ako čiary;
    // pri čiarach: copies = koľko kópií posunutých o pixel (hrúbka), bow = vydutie z roviny, sway = kývanie vo vetre
    render: Pd(0, 0, 1, 1, 'render'), copies: Pd(2, 1, 4, 1, 'render'), bow: Pd(0.12, 0, 0.5, 0.01, 'render'), sway: Pd(0.02, 0, 0.12, 0.005, 'render'),
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

  // Kút: priechodné políčko P pri stene (budova, balvan, skala) v smere d. Dva druhy:
  //  - koniec steny (faces 2): v smere e (kolmo) sa stena končí – pavučina medzi stenou a zemou, kľúč "i:d:e";
  //  - vnútorný kút (faces 3): aj v smere e je stena – pavučina medzi dvoma stenami a zemou, kľúč "i:d:e:3" (d < e).
  // (indexy smerov v DIRS)
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
          if (wall(at(x + ex, y + ey))) { if (di < ei) out.push({ k: `${i}:${di}:${ei}:3`, i, x, y, dx, dy, ex, ey, faces: 3 }); return; }
          if (wall(at(x + dx + ex, y + dy + ey)) || !open(at(x + ex, y + ey))) return;
          out.push({ k: `${i}:${di}:${ei}`, i, x, y, dx, dy, ex, ey, faces: 2 });
        });
      });
    }
    return out;
  }


  // ---- Rozloženie jednej pavučiny (spoločné pre shader aj čiary): stredy, kotvenie, výplň ----
  function webLayout(P, opts) {
    const { w, h, corner } = opts, seed = (opts.seed + P.seed * 101) % 997;
    const hs = n => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    const fill = P.fill === 2 ? (hs(3) < 0.5 ? 0 : 1) : P.fill;
    const cj = P.centerJitter, room = Math.max(1, Math.min(P.hubs, Math.floor(w / P.hubSpan)));
    const nH = corner ? 1 : 1 + Math.floor(hs(6) * room);
    const hubs = [];
    for (let i = 0; i < nH; i++) hubs.push({ x: w * (i + 0.5 + (hs(10 + i) - 0.5) * 2 * cj * (nH > 1 ? 0.8 : 1)) / nH, y: h * (0.5 + (hs(20 + i) - 0.5) * 2 * cj * (nH > 1 ? 1.5 : 1)) });
    const moorN = k => P.moorMin + Math.floor(hs(k) * (Math.max(P.moor, P.moorMin) - P.moorMin + 1));
    return { seed, hs, fill, nH, hubs, moor: [moorN(7), moorN(8)], pitch: P.pitch * (1 + (hs(5) - 0.5) * P.pitchVar) };
  }

  // ---- Skutočné vlákna (čiary) z tých istých parametrov ----
  // Výsledok v súradniciach roviny pavučiny so stredom v strede (x pozdĺž, y hore, z von z roviny – vydutie):
  // pos (dvojice bodov úsečiek), tan (smer vlákna pri každom bode).
  function noise2(x, y, s) { // gradientový (Perlinov) šum, ~ −0,7 … 0,7
    const g = (i, j) => { const a = Math.sin(i * 127.1 + j * 311.7 + s * 17.13) * 43758.5453; const t = (a - Math.floor(a)) * 6.2831853; return [Math.cos(t), Math.sin(t)]; };
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const d = (gi, gj, dx, dy) => { const q = g(gi, gj); return q[0] * dx + q[1] * dy; };
    const a = d(i, j, fx, fy), b = d(i + 1, j, fx - 1, fy), c = d(i, j + 1, fx, fy - 1), e = d(i + 1, j + 1, fx - 1, fy - 1);
    return a + (b - a) * u + (c - a + (a - b - c + e) * u) * v;
  }
  function webThreads(over, opts) {
    const P = webParams(over), L = webLayout(P, opts), { w, h } = opts, keep = opts.keep == null ? 1 : opts.keep;
    const s = L.seed, hh = n => { const x = Math.sin(s * 3.17 + n * 91.7) * 43758.5453; return x - Math.floor(x); };
    const pos = [], tan = [];
    const bowZ = (x, y) => P.bow * Math.sin(Math.PI * Math.min(1, Math.max(0, x / w))) * Math.sin(Math.PI * Math.min(1, Math.max(0, y / h))) * (0.75 + 0.5 * noise2(x * 2, y * 2, s));
    // polyline v rovine → úsečky s vydutím (z) a smerom vlákna
    const line = (pts, r) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], za = bowZ(a[0], a[1]), zb = bowZ(b[0], b[1]);
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = zb - za, l = Math.hypot(dx, dy, dz) || 1;
        pos.push(a[0] - w / 2, a[1] - h / 2, za, b[0] - w / 2, b[1] - h / 2, zb);
        tan.push(dx / l, dy / l, dz / l, dx / l, dy / l, dz / l);
      }
    };
    const seg = (a, b, n, r) => { const pts = []; for (let i = 0; i <= n; i++) pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); line(pts, r); };
    const nH = L.nH, hubs = L.hubs;
    const sagY = x => P.sag * 4 * (x / w) * (1 - x / w);
    const yTop = x => h * 0.96 - sagY(x), yBot = x => h * 0.06 + sagY(x) * 0.5;
    const nearest = (x, y) => { let bi = 0, bd = 1e9; hubs.forEach((c, i) => { const d = Math.hypot(x - c.x, y - c.y); if (d < bd) { bd = d; bi = i; } }); return bi; };
    const inside = (x, y, i) => x >= 0 && x <= w && y > yBot(x) && y < yTop(x) && nearest(x, y) === i;
    // nosné vlákna hore a dole (od kmeňa po kmeň, prehnuté)
    for (const f of [yTop, yBot]) { const pts = []; for (let i = 0; i <= 24; i++) pts.push([w * i / 24, f(w * i / 24)]); line(pts, hh(200 + (f === yTop ? 0 : 1))); }
    // deliace vlákna medzi susednými stredmi (os úsečky medzi nimi)
    for (let i = 0; i + 1 < nH; i++) {
      const c1 = hubs[i], c2 = hubs[i + 1], mx = (c1.x + c2.x) / 2, my = (c1.y + c2.y) / 2, dx = c2.x - c1.x, dy = c2.y - c1.y, pts = [];
      for (let k = 0; k <= 10; k++) { const y = yBot(mx) + (yTop(mx) - yBot(mx)) * k / 10; pts.push([mx - (y - my) * dy / dx, y]); }
      line(pts, hh(300 + i));
    }
    hubs.forEach((c, hi) => {
      const hsd = n => hh(n + hi * 37 + 500);
      const rays = P.rays + Math.floor(hsd(5) * (P.raysVar + 1)), cellW = w / nH;
      const rMaxAt = a => (P.radius * Math.min(cellW, h) + 0.12 * Math.max(cellW - h, 0)) * (1 + P.edgeNoise * noise2(a * 1.3, hi * 3.7, s));
      // lúče: od stredu von, ohnuté šumom, až po hranicu bunky / nosné vlákno / kmeň
      const spokes = [];
      for (let k = 0; k < rays; k++) {
        const ar = (k + (hsd(k) - 0.5) * 0.35) * 6.2831853 / rays, pts = [];
        for (let t = P.hub * 0.5; t < 4; t += 0.025) {
          const a = ar - P.bend * noise2(t * P.bendFreq, s * 7.1 + hi, s) / Math.max(t * 2, 0.6);
          const x = c.x + Math.cos(a) * t, y = c.y + Math.sin(a) * t;
          if (!inside(x, y, hi)) { if (x <= 0 || x >= w) pts.push([Math.min(w, Math.max(0, x)), y]); break; }
          pts.push([x, y]);
        }
        spokes.push({ ar, pts, keep: hsd(k + 40) < keep + 0.15 });
        if (spokes[k].keep && pts.length > 1) line(pts.filter((p, i) => i % 3 === 0 || i === pts.length - 1), hsd(k + 60));
      }
      // bod na lúči k vo vzdialenosti r od stredu (null, ak je lúč kratší)
      const at = (k, r) => { const sp = spokes[(k + rays) % rays]; const i = Math.round((r - P.hub * 0.5) / 0.025); return i >= 0 && i < sp.pts.length ? sp.pts[i] : null; };
      // výplň: špirála (polomer rastie s uhlom) alebo sústredné kruhy; medzi lúčmi rovné úsečky
      for (let turn = 0; turn < 60; turn++) {
        let any = false;
        for (let k = 0; k < rays; k++) {
          const rr = (kk, tt) => { const base = P.free + L.pitch * (tt + (L.fill === 0 ? kk / rays : 0)); return base * (1 + P.wobble * noise2(kk * P.wobbleFreq / rays * 6, base * 6, s)) * (1 + P.pitchNoise * 0.3 * noise2(base * 3, s, s)); };
          const r1 = rr(k, turn), r2 = L.fill === 0 && k === rays - 1 ? rr(0, turn + 1) : rr(k + 1, turn);
          if (r1 > rMaxAt(spokes[k].ar) || r2 > rMaxAt(spokes[(k + 1) % rays].ar)) continue;
          const a = at(k, r1), b2 = at(k + 1, r2);
          if (!a || !b2) continue;
          any = true;
          if (hh(turn * 31 + k + hi * 977) < keep) seg(a, b2, 2, hsd(turn * 7 + k));
        }
        if (!any && P.free + L.pitch * turn > 3) break;
      }
      // hustý stred
      for (let r = L.pitch * 0.3; r < P.hub; r += L.pitch * 0.3) for (let k = 0; k < rays; k++) { const a = at(k, r), b2 = at(k + 1, r); if (a && b2) seg(a, b2, 1, hsd(k + 900)); }
    });
    // kotviace vlákna: z bodov na kmeňoch k okraju krajného stredu
    for (let sd = 0; sd < 2; sd++) {
      const cnt = L.moor[sd], c = sd === 0 ? hubs[0] : hubs[nH - 1], rim = P.radius * Math.min(w / nH, h) * 0.92;
      for (let i = 0; i < cnt; i++) {
        const fi = i * 2 + sd, fy = (i + 0.5 + (hh(fi + 9) - 0.5) * 0.8) / cnt, ax = sd === 0 ? 0 : w;
        const A = [ax, yBot(ax) + (yTop(ax) - yBot(ax)) * fy];
        let dx = A[0] - c.x, dy = A[1] - c.y + (hh(fi + 3) - 0.5) * 0.4; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        if (hh(fi + 70) < keep + 0.2) seg(A, [c.x + dx * rim, c.y + dy * rim], 6, hh(fi + 11));
      }
    }
    return finish();
    function finish() { return { pos: new Float32Array(pos), tan: new Float32Array(tan), count: pos.length / 3, layout: L }; }
  }


  // ---- Kútová pavučina (krížiak): skutočná 3D trojuholníková pavučina v kúte ----
  // Súradnice kúta: počiatok na zemi v kúte, X von zo steny 1, Y hore, Z pozdĺž steny 1 (pri dvoch plochách: od konca
  // steny dozadu; pri troch: von zo steny 2). Plochy: stena 1 (X = 0), zem (Y = 0) a pri vnútornom kúte stena 2 (Z = 0).
  // Tri náhodné body na 2 alebo 3 plochách = rám (trojuholník, celý vo vzduchu – body sú v kladnom kvadrante).
  // Zlom: na hrane oproti náhodnému vrcholu bod posunutý k nemu, rám sa tam zlomí a z bodu ide vlákno k vrcholu –
  // vzniknú dve oblasti. Každá oblasť sa vyplní ako veľká pavučina: stred, lúče po rám, špirála alebo kruhy.
  // Výsledok: pos/tan úsečiek v súradniciach kúta, hub = stred prvej oblasti (tam sedí krížiak).
  function cornerThreads(over, opts) {
    const P = webParams(over), seed = (opts.seed + P.seed * 101) % 997, keep = opts.keep == null ? 1 : opts.keep;
    // veľkosť kúta po osiach (políčka): v kúte pri stene všade cornerSize, v kúte budovy z minikociek podľa miesta (napr. 2 × 6 minikociek)
    const see = opts.see || null;
    const SZ = opts.size || [P.cornerSize, P.cornerSize, P.cornerSize], S = Math.max(...SZ), S2 = (SZ[0] * SZ[1] + SZ[1] * SZ[2] + SZ[0] * SZ[2]) / 3;
    const hs = n => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    const R = (n, a, b) => a + (b - a) * hs(n);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len = a => Math.hypot(a[0], a[1], a[2]);
    // tri body (pri plochom trojuholníku ďalší pokus)
    let V = null;
    for (let t = 0; t < 24 && !V; t++) {
      const k = t * 17, x = (n, a, b) => R(k + n, a, b) * SZ[0], y = (n, a, b) => R(k + n, a, b) * SZ[1], z = (n, a, b) => R(k + n, a, b) * SZ[2];
      let pts;
      if (opts.faces === 3) pts = [[0, y(1, 0.15, 1), z(2, 0.15, 1)], [x(3, 0.15, 1), y(4, 0.15, 1), 0], [x(5, 0.15, 1), 0, z(6, 0.15, 1)]];
      else if (hs(k + 7) < 0.5) pts = [[0, y(1, 0.2, 1), z(2, 0.05, 0.95)], [0, y(3, 0.2, 1), z(4, 0.05, 0.95)], [x(5, 0.15, 0.95), 0, z(6, 0, 0.95)]];
      else pts = [[0, y(1, 0.3, 1), z(2, 0.05, 0.95)], [x(3, 0.15, 0.95), 0, z(4, 0, 0.95)], [x(5, 0.15, 0.95), 0, z(6, 0, 0.95)]];
      // v budove z minikociek: kotva vždy v strede minikocky (na ploche v strede jej steny)
      if (opts.voxel) pts = pts.map(p => p.map((v, i) => v === 0 ? 0 : Math.min(SZ[i] - 0.5 / 8, (Math.floor(v * 8) + 0.5) / 8)));
      // nie príliš plochý: plocha a najkratšia výška voči najdlhšej strane
      const ar = len(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))) / 2, lm = Math.max(len(sub(pts[1], pts[0])), len(sub(pts[2], pts[1])), len(sub(pts[0], pts[2])));
      // kotvy sa musia navzájom vidieť (opts.see: medzi nimi nič plné – v budove z minikociek)
      // každá kotva musí ležať na skutočnej ploche (opts.hold: za ňou plná minikocka) – inak by visela vo vzduchu
      if (ar > 0.12 * S2 && 2 * ar / lm > 0.25 * Math.sqrt(S2) && (!see || (see(pts[0], pts[1]) && see(pts[1], pts[2]) && see(pts[2], pts[0])))
        && (!opts.hold || pts.every(opts.hold))) V = pts;
    }
    if (!V && see) return null; // v tomto kúte sa vidiace sa kotvy nenašli
    V = V || [[0, 0.7 * SZ[1], 0.1 * SZ[2]], [0, 0.25 * SZ[1], 0.9 * SZ[2]], [0.7 * SZ[0], 0, 0.5 * SZ[2]]];
    // rovina pavučiny: 2D súradnice (u, v) v rovine trojuholníka
    const O = V[0], U = mul(sub(V[1], O), 1 / len(sub(V[1], O))), N = cross(U, sub(V[2], O)), W = mul(cross(mul(N, 1 / len(N)), U), 1);
    const to2 = p => [dot(sub(p, O), U), dot(sub(p, O), W)], to3 = q => add(O, add(mul(U, q[0]), mul(W, q[1])));
    const v2 = V.map(to2);
    const pos = [], tan = [];
    const seg2 = (a, b, n) => { // úsečka v rovine, rozdelená na n kúskov
      const A = to3(a), B = to3(b), d = sub(B, A), l = len(d) || 1, t = mul(d, 1 / l);
      for (let i = 0; i < n; i++) { const p = add(A, mul(d, i / n)), q = add(A, mul(d, (i + 1) / n)); pos.push(...p, ...q); tan.push(...t, ...t); }
    };
    // rám a oblasti (so zlomom: dve oblasti so spoločným deliacim vláknom)
    let polys = null, frame;
    if (hs(40) < P.cornerBreak) {
      const c = Math.floor(hs(41) * 3), e1 = v2[(c + 1) % 3], e2 = v2[(c + 2) % 3], C = v2[c];
      const t = R(42, 0.3, 0.7), mid = [e1[0] + (e2[0] - e1[0]) * t, e1[1] + (e2[1] - e1[1]) * t], k = P.breakPull * R(43, 0.6, 1.4);
      const M = [mid[0] + (C[0] - mid[0]) * k, mid[1] + (C[1] - mid[1]) * k];
      // aj bod zlomu musí vidieť na oba konce hrany aj na protiľahlý vrchol – inak bez zlomu
      const ok = !see || [e1, e2, C].every(q => see(to3(M), to3(q)));
      if (ok) { polys = [[e1, M, C], [M, e2, C]]; frame = [[e1, M], [M, e2], [e2, C], [C, e1], [M, C]]; }
    }
    if (!polys) {
      polys = [v2];
      frame = [[v2[0], v2[1]], [v2[1], v2[2]], [v2[2], v2[0]]];
    }
    for (const [a, b] of frame) if (hs(a[0] * 31 + b[1] * 7 + 50) < keep + 0.3) seg2(a, b, 4);
    // výplň oblasti ako veľká pavučina
    const fill = P.fill === 2 ? (hs(3) < 0.5 ? 0 : 1) : P.fill;
    let hub0 = null;
    polys.forEach((poly, pi) => {
      const n = poly.length;
      // vzdialenosť stredu od rámu (najmenšia) – podľa nej veľkosť stredu, voľnej zóny a rozostupu
      const edgeDist = (x, y) => Math.min(...poly.map((p, i) => { const q = poly[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1; return Math.abs((x - p[0]) * ey - (y - p[1]) * ex) / l; }));
      // stred: stred vpísanej kružnice (najďalej od rámu, výplň siaha rovnomerne ku všetkým stranám), posunutý o kúsok,
      // no vždy vnútri oblasti (aspoň polovica polomeru vpísanej kružnice od rámu)
      const inside = (x, y) => poly.every((p, i) => { const q = poly[(i + 1) % n]; return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]) >= 0; }) || poly.every((p, i) => { const q = poly[(i + 1) % n]; return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]) <= 0; });
      const sl = poly.map((p, i) => { const a = poly[(i + 1) % n], b2 = poly[(i + 2) % n]; return Math.hypot(b2[0] - a[0], b2[1] - a[1]); }); // strana oproti vrcholu i
      const per = sl.reduce((s2, v) => s2 + v, 0) || 1, ic = [poly.reduce((s2, p, i) => s2 + p[0] * sl[i], 0) / per, poly.reduce((s2, p, i) => s2 + p[1] * sl[i], 0) / per];
      const r0 = edgeDist(ic[0], ic[1]), j = P.centerJitter * 2;
      let h = [ic[0] + (hs(60 + pi) - 0.5) * j * r0 * 2, ic[1] + (hs(70 + pi) - 0.5) * j * r0 * 2];
      if (!inside(h[0], h[1]) || edgeDist(h[0], h[1]) < r0 / 2) h = ic;
      const inr = edgeDist(h[0], h[1]);
      if (pi === 0) hub0 = to3(h);
      // lúč zo stredu: kde narazí na rám
      const hit = a => {
        const dx = Math.cos(a), dy = Math.sin(a); let best = 9;
        for (let i = 0; i < n; i++) {
          const p = poly[i], q = poly[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((p[0] - h[0]) * ey - (p[1] - h[1]) * ex) / den, s2 = ((p[0] - h[0]) * dy - (p[1] - h[1]) * dx) / den;
          if (t > 0 && s2 >= -1e-6 && s2 <= 1 + 1e-6) best = Math.min(best, t);
        }
        return best;
      };
      const rays = opts.voxel ? P.voxelRays + Math.floor(hs(80 + pi) * 2) : P.cornerRays + Math.floor(hs(80 + pi) * 3), sp = [];
      for (let k = 0; k < rays; k++) {
        const a = (k + (hs(90 + k + pi * 31) - 0.5) * 0.35) / rays * Math.PI * 2, d = Math.min(hit(a), S * 2);
        sp.push({ a, d });
        if (d < S * 2 && hs(120 + k + pi * 31) < keep + 0.15) seg2([h[0] + Math.cos(a) * inr * 0.15, h[1] + Math.sin(a) * inr * 0.15], [h[0] + Math.cos(a) * d, h[1] + Math.sin(a) * d], 3);
      }
      const free = inr * 0.3, pitch = opts.voxel ? P.voxelPitch / 8 * (1 + (hs(5) - 0.5) * P.pitchVar * 0.5) : Math.max(0.012, P.pitch * 0.7 * (1 + (hs(5) - 0.5) * P.pitchVar));
      const at = (k, r) => { const s = sp[(k + rays) % rays]; return r <= s.d * P.cornerFill ? [h[0] + Math.cos(s.a) * r, h[1] + Math.sin(s.a) * r] : null; };
      for (let turn = 0; turn < 80; turn++) {
        let any = false;
        for (let k = 0; k < rays; k++) {
          const rr = (kk, tt) => (free + pitch * (tt + (fill === 0 ? kk / rays : 0))) * (1 + P.wobble * noise2(kk, tt, seed));
          const a = at(k, rr(k, turn)), b2 = fill === 0 && k === rays - 1 ? at(0, rr(0, turn + 1)) : at(k + 1, rr(k + 1, turn));
          if (!a || !b2) continue;
          any = true;
          if (hs(turn * 13 + k + pi * 577 + 200) < keep) seg2(a, b2, 1);
        }
        if (!any && free + pitch * turn > S * 2) break;
      }
      if (!opts.voxel) for (let r = inr * 0.04; r < inr * 0.15; r += inr * 0.035) for (let k = 0; k < rays; k++) { const a = at(k, r), b2 = at(k + 1, r); if (a && b2) seg2(a, b2, 1); } // hustý stred
    });
    return { pos: new Float32Array(pos), tan: new Float32Array(tan), count: pos.length / 3, hub: hub0, anchors: V, layout: { seed, nH: polys.length, moor: [0, 0], fill, hubs: [] } };
  }


  // ---- Kúty v budovách z minikociek (1/8 políčka) ----
  // Prázdna minikocka E, ktorá má plnú susednú kocku v dvoch kolmých smeroch a, b (vnútorná hrana: pod strechou pri stene,
  // v okne, pri schode, stena pri zemi – pod modelom je zem), prípadne aj v treťom c (vnútorný roh). Pavučina sa napne
  // v otvorenom kvadrante: X von z plochy a (−a), Y von z plochy b (−b), Z pozdĺž hrany c. Veľkosť po osiach v minikockách
  // je, kam až siaha voľné miesto a zároveň plocha, na ktorej ležia kotvy (pod presahom strechy len po jeho okraj),
  // najviac max – nemusí byť súmerná, napr. 2 × 6. Kúty na streche pod holým nebom
  // (vodorovná plocha nad zemou a nad ňou už nič) sa vynechajú. Vráti zoznam kútov:
  // { o: roh v súradniciach minikociek (spojité), X, Y, Z: celočíselné smery, size: [nx, ny, nz], faces: 2 | 3 }.
  // f = { sx, sy, sz, data } (data[(z * sy + y) * sx + x]), box = oblasť hľadania v minikockách { x0, x1, y0, y1, z0, z1 }.
  const VDIR = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  function voxelCorners(f, box, max) {
    max = max || 8;
    const { sx, sy, sz, data } = f;
    const inXZ = (x, z) => x >= 0 && z >= 0 && x < sx && z < sz;
    const solid = (x, y, z) => !inXZ(x, z) ? false : y < 0 ? true : y >= sy ? false : data[(z * sy + y) * sx + x] !== 0;
    const free = (x, y, z) => !solid(x, y, z);
    const run = (x, y, z, d, ok) => { let n = 0; while (n < max && ok(x + d[0] * n, y + d[1] * n, z + d[2] * n)) n++; return n; };
    const out = [];
    for (let z = Math.max(0, box.z0); z <= Math.min(sz - 1, box.z1); z++) for (let y = Math.max(0, box.y0); y <= Math.min(sy - 1, box.y1); y++) for (let x = Math.max(0, box.x0); x <= Math.min(sx - 1, box.x1); x++) {
      if (solid(x, y, z)) continue;
      for (let ia = 0; ia < 6; ia++) for (let ib = ia + 1; ib < 6; ib++) {
        const a = VDIR[ia], b = VDIR[ib];
        if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] !== 0) continue;
        if (!solid(x + a[0], y + a[1], z + a[2]) || !solid(x + b[0], y + b[1], z + b[2])) continue;
        // hrana pokračuje v smere c (kolmo na a aj b): ešte voľno a obe plochy pokračujú
        const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const edge = (px, py, pz) => free(px, py, pz) && solid(px + a[0], py + a[1], pz + a[2]) && solid(px + b[0], py + b[1], pz + b[2]);
        for (const cc of [c, c.map(v => -v)]) {
          if (edge(x - cc[0], y - cc[1], z - cc[2])) continue; // nie je začiatok hrany
          const len = run(x, y, z, cc, edge);
          // veľkosť od plochy a: kým je voľno a plocha b (kotvy na nej) ešte pokračuje – a naopak
          const nA = run(x, y, z, a.map(v => -v), (px, py, pz) => free(px, py, pz) && solid(px + b[0], py + b[1], pz + b[2]));
          const nB = run(x, y, z, b.map(v => -v), (px, py, pz) => free(px, py, pz) && solid(px + a[0], py + a[1], pz + a[2]));
          if (len < 2 || nA < 2 || nB < 2) continue;
          const faces = solid(x - cc[0], y - cc[1], z - cc[2]) ? 3 : 2; // aj začiatok hrany je stena → vnútorný roh
          // vodorovná plocha pod pavučinou (zem, parapet) áno, ale nie schody strechy pod holým nebom
          const up = a[1] < 0 || b[1] < 0;
          if (up && y > 0) { let sky = true; for (let yy = y + 1; yy < sy && sky; yy++) if (solid(x, yy, z)) sky = false; if (sky) continue; }
          const o = [x, y, z].map((v, i) => v + (a[i] > 0 ? 1 : 0) + (b[i] > 0 ? 1 : 0) + (cc[i] < 0 ? 1 : 0));
          out.push({ o, X: a.map(v => -v || 0), Y: b.map(v => -v || 0), Z: cc.map(v => v || 0), size: [nA, nB, len], faces, v: [x, y, z] });
        }
      }
    }
    return out;
  }

  // Priama viditeľnosť v modeli z minikociek: úsečka a–b (súradnice kúta q v políčkach) nesmie prejsť plnou minikockou
  // (zem pod modelom sa ráta ako plná). Body ležia na plochách – vzorky sa posunú o kúsok do otvoreného kvadrantu.
  function voxelSight(f, q) {
    const { sx, sy, sz, data } = f;
    const solid = (x, y, z) => x < 0 || z < 0 || x >= sx || z >= sz ? false : y < 0 ? true : y >= sy ? false : data[(z * sy + y) * sx + x] !== 0;
    const toV = p => [0, 1, 2].map(i => q.o[i] + (q.X[i] * p[0] + q.Y[i] * p[1] + q.Z[i] * p[2]) * 8 + (q.X[i] + q.Y[i] + q.Z[i]) * 0.01);
    return (a, b) => {
      const A = toV(a), B = toV(b), n = Math.max(2, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) * 4));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (solid(Math.floor(A[0] + (B[0] - A[0]) * t), Math.floor(A[1] + (B[1] - A[1]) * t), Math.floor(A[2] + (B[2] - A[2]) * t))) return false;
      }
      return true;
    };
  }
  // Kotva p (súradnice kúta q v políčkach) leží na ploche, keď za ňou (proti osi, ktorej súradnica je 0) je plná minikocka
  // a pred ňou voľno – plocha tam naozaj je (tretia stena vnútorného kúta môže byť len úzka, rímsa sa môže skončiť skôr).
  function voxelHold(f, q) {
    const { sx, sy, sz, data } = f;
    const solid = (x, y, z) => x < 0 || z < 0 || x >= sx || z >= sz ? false : y < 0 ? true : y >= sy ? false : data[(z * sy + y) * sx + x] !== 0;
    const ax = [q.X, q.Y, q.Z];
    return p => {
      const i = p.findIndex(v => v === 0);
      if (i < 0) return false;
      const at = k => solid(...[0, 1, 2].map(j => Math.floor(q.o[j] + (q.X[j] * p[0] + q.Y[j] * p[1] + q.Z[j] * p[2]) * 8 + ax[i][j] * k)));
      return at(-0.5) && !at(0.5);
    };
  }
  // Pavučina v budove: kúty v poradí podľa semienka, v každom veľkosť podľa semienka (pickVoxelCorner); berie sa prvý kút,
  // v ktorom sa kotvy navzájom vidia (voxelSight). Vráti { q, th } (th = cornerThreads) alebo null.
  function voxelWeb(f, list, seed, over, keep) {
    const hs = n => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    const start = Math.floor(hs(1) * list.length);
    for (let i = 0; i < Math.min(list.length, 16); i++) {
      const q = pickVoxelCorner([list[(start + i * 7) % list.length]], seed + i * 101);
      const th = cornerThreads(over, { seed: seed + i * 101, faces: q.faces, size: q.size, keep, see: voxelSight(f, q), hold: voxelHold(f, q), voxel: true });
      if (th) return { q, th };
    }
    return null;
  }

  // Výber kúta zo zoznamu podľa semienka a jeho veľkosť: po osiach náhodne v rámci voľného miesta (najmenej 2 minikocky),
  // takže pavučiny sú rôzne a nesúmerné (napr. 2 × 6). size je v políčkach (minikocka = 1/8).
  function pickVoxelCorner(list, seed) {
    if (!list.length) return null;
    const hs = n => { const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    const q = list[Math.floor(hs(1) * list.length)];
    return Object.assign({}, q, { free: q.size, vox: q.size.map((n, i) => 2 + Math.floor(hs(2 + i) * (n - 1))), size: q.size.map((n, i) => (2 + Math.floor(hs(2 + i) * (n - 1))) / 8) });
  }

  const api = { WEB_PARAMS, webParams, ANCHOR, anchorAt, webGeom, webLayout, webThreads, cornerThreads, voxelCorners, pickVoxelCorner, voxelSight, voxelHold, voxelWeb, noise2, analyze, cornerSpots, bfs };
  root.Webs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
