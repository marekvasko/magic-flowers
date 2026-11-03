// 3D svet z kociek: mriežka podkociek (1 blok = 2×2×2 podkocky), terén, generované low-poly modely,
// poloha slnka a mäkké tiene. Zdieľa ho klient (3D vykresľovanie) aj server (neskôr: hodiny slnka pre rastliny).
(function (root) {
  const D = root.GameData || (typeof require !== 'undefined' ? require('./data.js') : null);
  const R = 2;                   // podkocky na blok
  const NX = D.W * R, NZ = D.H * R, NY = 12;

  // ---- Materiály (id < 16 = terén, ich vrchná plocha nesie textúru zeme) ----
  const M = {
    AIR: 0, DIRT: 1, TOPSOIL: 2, PATH: 3, SAND: 4, STONE: 5, WATER: 6,
    TRUNK: 16, LEAF: 17, LEAF2: 18, BLOSSOM: 19, SPRUCE: 20, SNOW: 21,
    PLANK: 22, PLANK_DARK: 23, THATCH: 24, ROOF_RED: 25, WALL_WHITE: 26, BAND_BLUE: 27, DOOR: 28,
    WINDOW: 29, AWN_RED: 30, AWN_WHITE: 31, COUNTER: 32, POT: 33, BREW: 34, DARKSTONE: 35,
    FL_RED: 36, FL_YELLOW: 37, FL_BLUE: 38, FL_PINK: 39,
    LOG: 40, LOG_DARK: 41, ORN: 42, SHINGLE: 43, SHINGLE_DARK: 44, RIDGE: 45, SHUTTER: 46, HANDLE: 47, LANTERN: 48,
    INVIS: 63 // neviditeľná náhrada jemného modelu v hrubej mriežke (tieň, zatienenie, výber)
  };
  // Farby podľa ročného obdobia [jar, leto, jeseň, zima]; emis = svieti v noci
  const PALETTE = {
    [M.DIRT]: ['#7a5634'], [M.TOPSOIL]: ['#6f9a3c', '#5f8f34', '#8f8a3a', '#dfe7ea'], [M.PATH]: ['#b89a62', '#b89a62', '#b89a62', '#d8d4c6'],
    [M.SAND]: ['#d8c48a', '#d8c48a', '#d8c48a', '#e8e6dc'], [M.STONE]: ['#9a958d', '#9a958d', '#9a958d', '#c9ccce'], [M.WATER]: ['#3d8fcf', '#3d8fcf', '#3d8fcf', '#a9d4ec'],
    [M.TRUNK]: ['#6d4c2f'], [M.LEAF]: ['#5cb34a', '#3f8f3a', '#d9822b', '#3f8f3a'], [M.LEAF2]: ['#4a9a3c', '#347a30', '#e6b42b', '#347a30'],
    [M.BLOSSOM]: ['#ffc8de', '#e53935', '#c4621e', '#ffffff'], [M.SPRUCE]: ['#2e6b3a', '#2a6235', '#2e6b3a', '#2f5d3a'], [M.SNOW]: ['#f4f7f9'],
    [M.PLANK]: ['#c9a77a'], [M.PLANK_DARK]: ['#8b6a45'], [M.THATCH]: ['#b5884a', '#b5884a', '#a8783e', '#f2f6f8'],
    [M.ROOF_RED]: ['#c0533a', '#c0533a', '#c0533a', '#f2f6f8'], [M.WALL_WHITE]: ['#f5efe0'], [M.BAND_BLUE]: ['#3a6ea5'], [M.DOOR]: ['#5a3d24'],
    [M.WINDOW]: ['#9fd3f0'], [M.AWN_RED]: ['#e53935'], [M.AWN_WHITE]: ['#ffffff'], [M.COUNTER]: ['#b07840'], [M.POT]: ['#2b2b33'],
    [M.BREW]: ['#7cfc9a'], [M.DARKSTONE]: ['#7d7872'],
    [M.FL_RED]: ['#e53935'], [M.FL_YELLOW]: ['#ffc107'], [M.FL_BLUE]: ['#3f6fd8'], [M.FL_PINK]: ['#ec5c8d'],
    [M.LOG]: ['#6b4528'], [M.LOG_DARK]: ['#3e2716'], [M.ORN]: ['#f3efe6'], [M.SHINGLE]: ['#7a6450'], [M.SHINGLE_DARK]: ['#5e4c3d'],
    [M.RIDGE]: ['#4a3b30'], [M.SHUTTER]: ['#2f6f8f'], [M.HANDLE]: ['#e0b040'], [M.LANTERN]: ['#ffe9a8']
  };
  const EMISSIVE = { [M.WINDOW]: '#ffd27a', [M.BREW]: '#9dffb8', [M.LANTERN]: '#ffe9a8' };
  function colorOf(mat, season) { const p = PALETTE[mat] || ['#ff00ff']; return p[Math.min(season, p.length - 1)] || p[0]; }

  function hash(x, y, k) { let h = (x * 374761393 + y * 668265263 + (k || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  // Výška terénu v podkockách pre typ zeme
  function groundHeight(g) { return g === 'water' ? 1 : (g === 'rock' || g === 'boulder') ? 3 : 2; }
  function topMaterial(g) {
    if (g === 'water') return M.WATER;
    if (g === 'path') return M.PATH;
    if (g === 'sand') return M.SAND;
    if (g === 'rock' || g === 'boulder') return M.STONE;
    return M.TOPSOIL;
  }

  // Mriežka: materiál na každú podkocku. x ∈ [0,NX), y ∈ [0,NY), z ∈ [0,NZ)
  function makeGrid() { return { NX, NY, NZ, R, m: new Uint8Array(NX * NY * NZ), heights: new Uint8Array(D.W * D.H) }; }
  const idx = (x, y, z) => (z * NY + y) * NX + x;
  function get(g, x, y, z) { return (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) ? 0 : g.m[idx(x, y, z)]; }
  function set(g, x, y, z, v) { if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return; g.m[idx(x, y, z)] = v; }
  function box(g, x0, y0, z0, x1, y1, z1, v) { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(g, x, y, z, v); }

  // ---- Generované modely ----
  function tree(g, tx, ty, season) {
    const sx = tx * R, sz = ty * R, base = g.heights[ty * D.W + tx];
    const h = hash(tx, ty, 3);
    const cx = sx + (hash(tx, ty, 5) < 0.5 ? 0 : 1), cz = sz + (hash(tx, ty, 6) < 0.5 ? 0 : 1);
    if (h > 0.55) { // smrek: kmeň a zužujúce sa poschodia
      const top = base + 7;
      box(g, cx, base, cz, cx, top - 1, cz, M.TRUNK);
      const layers = [[base + 2, 2], [base + 3, 2], [base + 4, 1], [base + 5, 1], [base + 6, 0], [top, 0]];
      for (const [y, r] of layers) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        set(g, cx + dx, y, cz + dz, season === 3 && (y === top || (r && hash(cx + dx, y, cz + dz) < 0.35)) ? M.SNOW : M.SPRUCE);
      }
      return;
    }
    const th = 3 + (hash(tx, ty, 7) < 0.5 ? 0 : 1);
    box(g, cx, base, cz, cx, base + th - 1, cz, M.TRUNK);
    const y0 = base + th - 1;
    if (season === 3) { // zima: holé konáre so snehom
      box(g, cx, y0, cz, cx, y0 + 2, cz, M.TRUNK);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (hash(cx + dx, y0, cz + dz) < 0.6) { set(g, cx + dx, y0 + 1, cz + dz, M.TRUNK); set(g, cx + dx, y0 + 2, cz + dz, M.SNOW); }
      set(g, cx, y0 + 3, cz, M.SNOW);
      return;
    }
    const r = hash(tx, ty, 8) < 0.5 ? 1 : 2;
    for (let ly = 0; ly < 3; ly++) {
      const rr = ly === 2 ? Math.max(1, r - 1) : r;
      for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
        if (rr > 1 && Math.abs(dx) === rr && Math.abs(dz) === rr) continue;
        const x = cx + dx, y = y0 + ly, z = cz + dz, hv = hash(x, y, z);
        let mat = hv < 0.5 ? M.LEAF : M.LEAF2;
        if (season === 0 && h < 0.3 && hv < 0.25) mat = M.BLOSSOM;   // jarné kvitnutie
        if (season === 1 && h < 0.2 && hv < 0.12) mat = M.BLOSSOM;   // letné plody
        set(g, x, y, z, mat);
      }
    }
  }
  function boulder(g, tx, ty) {
    const sx = tx * R, sz = ty * R, base = g.heights[ty * D.W + tx];
    box(g, sx, base, sz, sx + 1, base, sz + 1, M.DARKSTONE);
    set(g, sx + (hash(tx, ty, 1) < 0.5 ? 0 : 1), base + 1, sz + (hash(tx, ty, 2) < 0.5 ? 0 : 1), M.DARKSTONE);
  }
  // Budova s valbovou strechou zo schodov. x0..x1, z0..z1 v podkockách (vrátane), výška stien wh
  function building(g, x0, z0, x1, z1, wh, wall, roof, frontZ, doorX, windowsX) {
    const base = 2;
    box(g, x0, base, z0, x1, base + wh - 1, z1, wall);
    for (const zf of [z0, z1]) for (const wx of windowsX) box(g, wx, base + 1, zf, wx, base + 2, zf, M.WINDOW);
    box(g, doorX, base, frontZ, doorX + 1, base + 2, frontZ, M.DOOR);
    // strecha: poschodia sa zužujú v smere z (sedlová strecha), presah 1 podkocka
    let za = z0 - 1, zb = z1 + 1, y = base + wh;
    while (za <= zb) { box(g, x0 - 1, y, za, x1 + 1, y, zb, roof); za++; zb--; y++; }
    return y;
  }
  function stamp(g, tiles, season) {
    const done = {};
    for (let ty = 0; ty < D.H; ty++) for (let tx = 0; tx < D.W; tx++) {
      const t = tiles[ty * D.W + tx].g;
      if (t === 'tree') tree(g, tx, ty, season);
      else if (t === 'boulder') boulder(g, tx, ty);
      else if ((t === 'hut' || t === 'house' || t === 'stall') && !done[t]) {
        done[t] = true;
        const sx = tx * R, sz = ty * R;
        if (t === 'hut') {
          const top = building(g, sx, sz, sx + 5, sz + 3, 4, M.PLANK, M.THATCH, sz + 3, sx + 2, [sx + 1, sx + 4]);
          box(g, sx + 4, top - 2, sz + 1, sx + 4, top, sz + 1, M.DARKSTONE); // komín
        } else if (t === 'house') {
          // domček je jemný model z minikociek (fineModels) – sem sa zapíše len jeho neviditeľná náhrada
        } else { // stánok na trhu
          box(g, sx, 2, sz + 1, sx + 5, 3, sz + 1, M.COUNTER);
          for (const px of [sx, sx + 5]) box(g, px, 2, sz, px, 5, sz, M.PLANK_DARK);
          for (let x = sx - 1; x <= sx + 6; x++) box(g, x, 6, sz - 1, x, 6, sz + 2, (x - sx) % 2 ? M.AWN_WHITE : M.AWN_RED);
          const fl = [M.FL_RED, M.FL_YELLOW, M.FL_BLUE, M.FL_PINK];
          for (let i = 0; i < 4; i++) set(g, sx + 1 + i, 4, sz + 1, fl[i]);
        }
      } else if (t === 'well') {
        const sx = tx * R, sz = ty * R;
        box(g, sx, 2, sz, sx + 1, 2, sz + 1, M.STONE);
        set(g, sx, 3, sz, M.PLANK_DARK); set(g, sx + 1, 3, sz + 1, M.PLANK_DARK);
        set(g, sx, 4, sz, M.PLANK_DARK); set(g, sx + 1, 4, sz + 1, M.PLANK_DARK);
        box(g, sx, 5, sz, sx + 1, 5, sz + 1, M.THATCH);
      } else if (t === 'cauldron') {
        const sx = tx * R, sz = ty * R;
        box(g, sx, 2, sz, sx + 1, 2, sz + 1, M.POT);
        box(g, sx, 3, sz, sx + 1, 3, sz + 1, M.BREW);
      }
    }
  }

  // ---- Jemné modely z minikociek: 1 blok = FINE × FINE × FINE ----
  const FINE = 8;
  const FM = 4; // okraj modelu v minikockách (= pol bloku), aby sedel s hrubou mriežkou
  // Domček v štýle Čičmian: zrub s bielymi ornamentmi, šindľová strecha, okná s okenicami a truhlíkmi.
  // Súradnice fx, fy, fz sú v minikockách od rohu pôdorysu (3×2 polia = 24×16) a od vrchu zeme.
  function cicmanyHouse(season) {
    const sx = 24 + 2 * FM, sy = 36, sz = 16 + 2 * FM;
    const data = new Uint8Array(sx * sy * sz);
    const at = (x, y, z) => ((z + FM) * sy + y) * sx + (x + FM);
    const ok = (x, y, z) => x >= -FM && x < 24 + FM && y >= 0 && y < sy && z >= -FM && z < 16 + FM;
    const put = (x, y, z, m) => { if (ok(x, y, z)) data[at(x, y, z)] = m; };
    const getf = (x, y, z) => ok(x, y, z) ? data[at(x, y, z)] : 0;
    const fbox = (x0, y0, z0, x1, y1, z1, m) => { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, z, typeof m === 'function' ? m(x, y, z) : m); };
    const outer = (x, z) => x === 1 || x === 22 || z === 1 || z === 14;
    // sokel z kameňa
    fbox(0, 0, 0, 23, 2, 15, (x, y, z) => hash(x, y, z + 99) < 0.3 ? M.DARKSTONE : M.STONE);
    // zrubové steny: trámy po 3 minikockách, medzi nimi tmavá drážka
    fbox(1, 3, 1, 22, 18, 14, (x, y, z) => outer(x, z) && (y - 3) % 3 === 2 ? M.LOG_DARK : M.LOG);
    // na rohoch prečnievajú konce trámov (striedavo)
    for (let y = 3; y <= 18; y++) {
      if (((y - 3) / 3 | 0) % 2 || (y - 3) % 3 === 2) continue;
      for (const [cx, cz, dx, dz] of [[1, 1, -1, -1], [22, 1, 1, -1], [1, 14, -1, 1], [22, 14, 1, 1]]) { put(cx + dx, y, cz, M.LOG); put(cx, y, cz + dz, M.LOG); }
    }
    // čičmanské ornamenty na vonkajšej vrstve stien
    const paint = (x, y, z) => { if (getf(x, y, z) === M.LOG || getf(x, y, z) === M.LOG_DARK) put(x, y, z, M.ORN); };
    for (let y = 15; y <= 17; y++) for (let i = 1; i <= 22; i++) {
      const lattice = (i + y) % 4 === 0 || ((i - y) % 4 + 4) % 4 === 0;
      if (lattice) { paint(i, y, 14); paint(i, y, 1); }
      if (i <= 14 && lattice) { paint(1, y, i); paint(22, y, i); }
    }
    for (let y = 4; y <= 13; y += 2) for (const x of [2, 21, 8, 15]) paint(x, y, 14);
    for (const [cx, cy] of [[4.5, 5], [18.5, 5]]) for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) { paint(Math.floor(cx) + dx, cy + dy, 14); paint(Math.ceil(cx) + dx, cy + dy, 14); }
    // okno: zapustené sklo s priečkami, biely rám, okenice a truhlík s kvetmi
    function frontWindow(x0) {
      fbox(x0, 8, 14, x0 + 3, 12, 14, 0);
      fbox(x0, 8, 13, x0 + 3, 12, 13, (x, y) => (x === x0 + 1 || y === 10) ? M.ORN : M.WINDOW);
      for (let y = 7; y <= 13; y++) for (let x = x0 - 1; x <= x0 + 4; x++) if (y === 7 || y === 13 || x === x0 - 1 || x === x0 + 4) put(x, y, 14, M.ORN);
      fbox(x0 - 3, 8, 15, x0 - 2, 12, 15, (x, y) => y === 10 ? M.LOG_DARK : M.SHUTTER);
      fbox(x0 + 5, 8, 15, x0 + 6, 12, 15, (x, y) => y === 10 ? M.LOG_DARK : M.SHUTTER);
      fbox(x0 - 1, 6, 15, x0 + 4, 7, 16, M.PLANK_DARK);
      for (let x = x0 - 1; x <= x0 + 4; x++) for (const z of [15, 16]) { const hv = hash(x, 8, z); put(x, 8, z, hv < 0.35 ? M.FL_RED : hv < 0.6 ? M.FL_PINK : M.LEAF); if (hv < 0.25) put(x, 9, z, M.FL_RED); }
    }
    frontWindow(3); frontWindow(17);
    // bočné okná
    for (const [xs, xg] of [[22, 21], [1, 2]]) {
      fbox(xs, 8, 6, xs, 12, 9, 0);
      fbox(xg, 8, 6, xg, 12, 9, (x, y, z) => (z === 7 || y === 10) ? M.ORN : M.WINDOW);
      for (let y = 7; y <= 13; y++) for (let z = 5; z <= 10; z++) if (y === 7 || y === 13 || z === 5 || z === 10) put(xs, y, z, M.ORN);
    }
    // dvere s rámom, kľučkou a schodíkom
    fbox(10, 3, 14, 13, 13, 14, 0);
    fbox(10, 3, 13, 13, 13, 13, (x) => x % 2 ? M.PLANK_DARK : M.DOOR);
    for (let y = 3; y <= 14; y++) for (let x = 9; x <= 14; x++) if (y === 14 || x === 9 || x === 14) put(x, y, 14, M.ORN);
    put(12, 8, 14, M.HANDLE);
    fbox(9, 0, 16, 14, 2, 17, M.STONE);
    // lampáš pri dverách
    put(16, 11, 15, M.LANTERN); put(16, 12, 15, M.LOG_DARK); put(16, 12, 14, M.LOG_DARK);
    // strecha: sedlová so šindľami, presah 3 na bokoch a 2 vpredu/vzadu, zapustený štít
    for (let k = 0; k < 10; k++) {
      const y = 19 + k, za = -2 + k, zb = 17 - k;
      for (let z = za; z <= zb; z++) for (let x = -3; x <= 26; x++) {
        const shell = z <= za + 1 || z >= zb - 1 || k === 9;
        const end = x <= -2 || x >= 25;
        if (shell) put(x, y, z, k === 9 ? M.RIDGE : end ? M.PLANK_DARK : ((x + (k % 2) * 2) % 4 < 2 ? M.SHINGLE : M.SHINGLE_DARK));
        else if (x >= 1 && x <= 22 && z >= 1 && z <= 14) put(x, y, z, x === 1 || x === 22 ? M.PLANK : M.LOG);
      }
    }
    // ornament a okrúhle okienko v štíte
    for (const xs of [1, 22]) {
      for (let y = 20; y <= 26; y++) for (let z = 3; z <= 12; z++) if (getf(xs, y, z) === M.PLANK && ((y + z) % 3 === 0)) put(xs, y, z, M.ORN);
      for (const [dz, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [2, 0], [0, -1], [1, -1], [0, 2], [1, 2]]) put(xs, 23 + dy, 7 + dz, Math.abs(dz - 0.5) + Math.abs(dy - 0.5) < 1.5 ? M.WINDOW : M.ORN);
    }
    // komín
    fbox(16, 19, 4, 18, 31, 6, (x, y, z) => y === 31 ? M.DARKSTONE : hash(x, y, z) < 0.4 ? M.DARKSTONE : M.STONE);
    // v zime sneh na všetkom, čo je navrchu strechy
    if (season === 3) for (let z = -FM; z < 16 + FM; z++) for (let x = -FM; x < 24 + FM; x++) {
      for (let y = sy - 1; y >= 19; y--) {
        const m = getf(x, y, z);
        if (!m) continue;
        if (m === M.SHINGLE || m === M.SHINGLE_DARK || m === M.RIDGE || m === M.PLANK_DARK) put(x, y, z, M.SNOW);
        break;
      }
    }
    return { sx, sy, sz, data };
  }

  // Zoznam jemných modelov na mape (pozícia v blokoch, rozmery a minikocky)
  function fineModels(tiles, season) {
    const out = [];
    const i = tiles.findIndex(t => t.g === 'house');
    if (i >= 0) {
      const tx = i % D.W, ty = (i / D.W) | 0;
      const m = cicmanyHouse(season);
      out.push(Object.assign(m, { type: 'house', ox: tx - FM / FINE, oy: groundHeight('grass') / R, oz: ty - FM / FINE, tile: { x: tx + 1, y: ty + 1 } }));
    }
    return out;
  }
  // Neviditeľná náhrada jemného modelu v hrubej mriežke: podkocka je plná, ak je aspoň ~40 % jej minikociek plných.
  function stampInvisible(g, fm) {
    const k = FINE / R; // minikociek na podkocku
    const cx0 = Math.round(fm.ox * R), cy0 = Math.round(fm.oy * R), cz0 = Math.round(fm.oz * R);
    for (let cz = 0; cz < fm.sz / k; cz++) for (let cy = 0; cy < Math.ceil(fm.sy / k); cy++) for (let cx = 0; cx < fm.sx / k; cx++) {
      let n = 0;
      for (let z = 0; z < k; z++) for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
        const fy = cy * k + y;
        if (fy < fm.sy && fm.data[((cz * k + z) * fm.sy + fy) * fm.sx + cx * k + x]) n++;
      }
      if (n >= k * k * k * 0.4) set(g, cx0 + cx, cy0 + cy, cz0 + cz, M.INVIS);
    }
  }

  // Celý svet z mapy (typy zeme) – deterministický, závisí len od mapy a ročného obdobia.
  function buildGrid(tiles, season) {
    const g = makeGrid();
    for (let ty = 0; ty < D.H; ty++) for (let tx = 0; tx < D.W; tx++) {
      const gt = tiles[ty * D.W + tx].g, h = groundHeight(gt);
      g.heights[ty * D.W + tx] = h;
      for (let y = 0; y < h; y++) box(g, tx * R, y, ty * R, tx * R + 1, y, ty * R + 1, y === h - 1 ? topMaterial(gt) : (gt === 'rock' || gt === 'boulder' ? M.STONE : M.DIRT));
    }
    stamp(g, tiles, season);
    g.fine = fineModels(tiles, season);
    for (const fm of g.fine) stampInvisible(g, fm);
    return g;
  }
  // Výška povrchu políčka v blokoch (na tú postavíme rastliny a postavičky)
  function surfaceY(g, tx, ty) { return (g.heights[ty * D.W + tx] || 2) / R; }

  // ---- Slnko ----
  const MAX_ELEV = [50, 62, 40, 22]; // najvyššia výška slnka v stupňoch podľa obdobia
  // Smer k slnku (jednotkový vektor) alebo null v noci. Východ 5:00 na východe (+x), poludnie na juhu (+z), západ 21:00.
  function sunDir(minuteOfDay, season) {
    const t = (minuteOfDay - 300) / 960;
    if (t <= 0 || t >= 1) return null;
    const e = MAX_ELEV[season] * Math.PI / 180 * Math.sin(Math.PI * t);
    const ce = Math.cos(e);
    return { x: Math.cos(Math.PI * t) * ce, y: Math.sin(e), z: Math.sin(Math.PI * t) * ce };
  }
  // Intenzita denného svetla 0..1 (súmrak je plynulý)
  function daylight(minuteOfDay) {
    const h = minuteOfDay / 60;
    if (h < 4 || h >= 22) return 0;
    if (h < 6) return (h - 4) / 2;
    if (h >= 20) return 1 - (h - 20) / 2;
    return 1;
  }

  // Je bod (vo svetových súradniciach blokov) osvetlený slnkom? Pochod lúča cez mriežku podkociek.
  function rayFree(g, px, py, pz, d, maxDist, start) {
    const step = 0.2;
    for (let s = start || 0.05; s < maxDist; s += step) {
      const x = Math.floor((px + d.x * s) * R), y = Math.floor((py + d.y * s) * R), z = Math.floor((pz + d.z * s) * R);
      if (y >= NY) return true;
      if (get(g, x, y, z)) return false;
    }
    return true;
  }
  // Mäkký tieň: priemer viacerých lúčov v malom kuželi okolo smeru slnka (0 = tieň, 1 = plné slnko)
  const SOFT = [[0, 0], [0.07, 0], [-0.07, 0], [0, 0.07], [0, -0.07], [0.05, 0.05], [-0.05, -0.05], [0.05, -0.05], [-0.05, 0.05]];
  function sunVisibility(g, px, py, pz, dir, samples, start) {
    if (!dir) return 0;
    const n = Math.min(samples || SOFT.length, SOFT.length);
    // dve kolmice na smer slnka
    const ux = -dir.z, uz = dir.x, ul = Math.hypot(ux, uz) || 1;
    const vx = -dir.x * dir.y, vy = dir.x * dir.x + dir.z * dir.z, vz = -dir.z * dir.y;
    let lit = 0;
    for (let i = 0; i < n; i++) {
      const [a, b] = SOFT[i];
      const d = { x: dir.x + ux / ul * a + vx * b, y: dir.y + vy * b, z: dir.z + uz / ul * a + vz * b };
      const l = Math.hypot(d.x, d.y, d.z); d.x /= l; d.y /= l; d.z /= l;
      if (d.y > 0 && rayFree(g, px, py, pz, d, 14, start)) lit++;
    }
    return lit / n;
  }

  // Koľko hodín priameho slnka denne dostane vrch políčka (pre hernú logiku: slnkomilné vs. tieňomilné kvety)
  function sunHours(g, tx, ty, season) {
    const py = surfaceY(g, tx, ty) + 0.02;
    let hours = 0;
    for (let m = 300 + 15; m < 1260; m += 30) hours += 0.5 * sunVisibility(g, tx + 0.5, py, ty + 0.5, sunDir(m, season), 5);
    return hours;
  }

  const api = { R, NX, NY, NZ, M, FINE, PALETTE, EMISSIVE, colorOf, hash, buildGrid, get, surfaceY, sunDir, daylight, sunVisibility, sunHours, groundHeight };
  root.World3D = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
