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
    // kútová pavučina krížiaka: hustota mliečneho závoja
    veil: Pd(0.18, 0, 0.6, 0.01, 'look'),
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
    const P = webParams(over), L = webLayout(P, opts), { w, h, corner } = opts, keep = opts.keep == null ? 1 : opts.keep;
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
    if (corner) { // kútová spleť: trojuholník pri konci steny (x = šírka), od steny (y = výška) k zemi
      for (let i = 0; i < 36; i++) {
        let u = hh(i), v = hh(i + 7); if (u + v < 1) { u = 1 - u; v = 1 - v; }
        const an = hh(i + 13) * 6.2831853, ln = (0.12 + 0.3 * hh(i + 19)) * w, a = [u * w, v * h];
        const b = [Math.min(w, Math.max(0, a[0] + Math.cos(an) * ln)), Math.min(h, Math.max(0, a[1] + Math.sin(an) * ln))];
        if (b[0] / w + b[1] / h >= 0.85) seg(a, b, 3, hh(i + 23));
      }
      for (let i = 0; i < 7; i++) {
        const a = [w, hh(i + 90) * h], b = [(0.05 + 0.9 * hh(i + 95)) * w, h], c = [(a[0] + b[0]) / 2 - 0.06 * w * hh(i + 99), (a[1] + b[1]) / 2 - 0.06 * h * hh(i + 99)];
        line([a, c, b], hh(i + 100));
      }
      return finish();
    }
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

  const api = { WEB_PARAMS, webParams, ANCHOR, anchorAt, webGeom, webLayout, webThreads, noise2, analyze, cornerSpots, bfs };
  root.Webs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
