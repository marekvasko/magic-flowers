// 3D model pavúkov (#57) a jeho priemet do jednoduchých 2D tvarov pre sprity.
// Jeden opis tela (elipsoidy hlavohrude, zadočku a hrbov, kresba ako malé škvrny na povrchu, nohy ako zúžené úsečky)
// slúži trom účelom: Three.js model v /debug (buildMesh), 2D sprite z elipsy a úsečiek (draw) a porovnanie oboch.
// Predlohy: krížiak = Araneus diadematus (guľatý zadoček najvyšší vpredu, biely kríž, pruhované nohy, zospodu čierny
// pás so žltými zátvorkami), vlčiak = Hogna radiata (pretiahnutá hlavohruď so svetlým stredným pásom a tmavými lúčmi,
// 2 veľké oči hore vpredu, oválny zadoček so srdcovou škvrnou a šípkami, silné nohy, tmavé brucho), stará pradlena =
// Araneus angulatus (dva hrby na pleciach zadočka, listová kresba, výrazne pruhované nohy) – ale dlhonohá, vysoká ako hráč.
// Rozmery: krížiak 1/4 políčka, vlčiak 1 políčko, pradlena 1,5 políčka (od končekov nôh) a vysoká ako hráč.
// Pohľady: 8 na zemi (S, SE, E, NE, N, NW, W, SW = kam je otočená hlava voči kamere: S ku kamere, E doprava)
// a 8 na zvislej ploche (kmeň, stena, pavučina): hlava hore/dole/vľavo/vpravo, chrbtom ku kamere alebo bruchom (-b).
// Kamera je izometrická ako v hre (sklon atan(1/√2)); súradnice modelu: x dopredu, y hore (chrbát), z doprava.
(function (root) {
  const PITCH = Math.atan(1 / Math.SQRT2);
  const SP = Math.sin(PITCH), CP = Math.cos(PITCH);
  // kanonická kamera: stojí na +z, pozerá šikmo dole; vpravo = +x
  const CAM = { r: [1, 0, 0], u: [0, CP, -SP], c: [0, SP, CP] };
  const LIGHT = norm([-0.35, 1, 0.45]);

  const VIEWS = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW', 'up', 'down', 'left', 'right', 'up-b', 'down-b', 'left-b', 'right-b'];
  const PLANAR = VIEWS.slice(0, 8);
  // Na kmeni: plocha kmeňa natočená voči kamere o 0°, ±45°, ±90° (+ = jej normála mieri doprava), hlavou hore (u)
  // alebo dole (d) – 10 pohľadov 't<uhol><u|d>', napr. 't-45d'. Zo zadnej strany kmeňa pavúka zakryje kmeň.
  const TRUNK_ANG = [-90, -45, 0, 45, 90];
  const TRUNK = TRUNK_ANG.flatMap(a => ['u', 'd'].map(h => 't' + a + h));

  // ---------- druhy ----------
  // Dĺžky v jednotkách dĺžky hlavohrude (L); celý model sa potom zmenší tak, aby rozpätie nôh bolo span.
  // leg: [uhol bedra od predku (°), uhol chodidla (°), dosah chodidla od stredu, výška kolena nad bedrom, kde je koleno (0–1),
  //       výška členka, kde je členok, hrúbka pri tele, hrúbka na konci]
  const SPECIES = {
    k: {
      name: 'krížiak', span: 0.25, ppu: 420, ref: 'Araneus diadematus', glow: '#c8ff9a',
      ceph: { len: 0.9, wid: 0.78, hgt: 0.4, x: 0.6, y: 0.42 },
      abd: { len: 1.75, wid: 1.6, hgt: 1.45, x: -0.72, y: 0.98, tilt: 0.32 }, gloss: 0.35,
      legs: [[38, 34, 3.15, 1.05, 0.34, 0.55, 0.7, 0.13, 0.05], [72, 66, 2.85, 1.0, 0.36, 0.5, 0.7, 0.13, 0.05],
             [112, 118, 2.05, 0.75, 0.4, 0.38, 0.72, 0.12, 0.05], [148, 152, 2.7, 0.95, 0.38, 0.48, 0.72, 0.13, 0.05]],
      palp: [0.55, 0.1], cheli: 0.2, stride: 0.22, lift: 0.3,
      col: { body: '#c47f3a', abd: '#d9934a', leg: '#d8b37a', band: '#7a3f1c', dark: '#5a2e12', out: '#3a1e0c',
             mark: '#fbf1dc', belly: '#2a1a10', belly2: '#f2d27a', eye: '#1a1008', ceph: '#a8692e' },
      marks: kriziakMarks
    },
    v: {
      name: 'vlčiak', span: 1.0, ppu: 150, ref: 'Hogna radiata', glow: '#ffcf6a',
      ceph: { len: 1, wid: 0.84, hgt: 0.44, x: 0.55, y: 0.4, rise: 0.12 },
      abd: { len: 1.2, wid: 0.8, hgt: 0.62, x: -0.6, y: 0.4, tilt: 0.05 }, gloss: 0.12,
      legs: [[40, 30, 3.3, 0.85, 0.32, 0.4, 0.66, 0.19, 0.07], [70, 64, 3.0, 0.82, 0.34, 0.38, 0.68, 0.19, 0.07],
             [108, 116, 2.75, 0.8, 0.36, 0.36, 0.68, 0.19, 0.07], [146, 156, 3.55, 0.88, 0.34, 0.4, 0.68, 0.2, 0.07]],
      palp: [0.7, 0.11], cheli: 0.24, stride: 0.32, lift: 0.28,
      col: { body: '#6b5238', abd: '#7a6146', leg: '#9c7f5a', band: '#6e5438', dark: '#2e2016', out: '#1e140c',
             mark: '#cdb48c', belly: '#1c1410', belly2: '#3a2c20', eye: '#0c0a08', ceph: '#8a6c4a' },
      marks: vlciakMarks
    },
    p: {
      name: 'stará pradlena', span: 1.5, top: 1.2, ppu: 120, ref: 'Araneus angulatus', glow: '#ff6a4a',
      ceph: { len: 1, wid: 0.86, hgt: 0.46, x: 0.6, y: 0.5 },
      abd: { len: 1.85, wid: 1.65, hgt: 1.4, x: -0.78, y: 0.95, tilt: 0.45 }, gloss: 0.2,
      humps: [[0.42, 0.62, 0.5, 0.36], [0.42, 0.62, -0.5, 0.36]],
      legs: [[38, 32, 3.0, 1.8, 0.4, 1.0, 0.74, 0.13, 0.045], [72, 68, 2.75, 1.75, 0.42, 0.95, 0.74, 0.13, 0.045],
             [112, 120, 2.2, 1.3, 0.44, 0.7, 0.74, 0.12, 0.045], [148, 154, 2.6, 1.6, 0.42, 0.9, 0.74, 0.13, 0.045]],
      palp: [0.7, 0.1], cheli: 0.24, stride: 0.26, lift: 0.4, lifted: 1.3,
      col: { body: '#4a3a30', abd: '#5c4838', leg: '#c8b496', band: '#3a2a20', dark: '#22160f', out: '#120c08',
             mark: '#d8c8a8', belly: '#1a120c', belly2: '#9a8468', eye: '#ff6a4a', ceph: '#3e2f26' },
      marks: pradlenaMarks
    }
  };

  // ---------- vektory ----------
  function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const mv = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]]; // M = stĺpce
  const slerp = (a, b, t) => norm(add(mul(a, 1 - t), mul(b, t)));

  // ---------- kresba (škvrny na jednotkovej guli časti tela: x dopredu, y hore, z doprava) ----------
  // m(dir, a, b, farba, natočenie) – elipsa a × b (v jednotkách polomeru) so stredom v smere dir;
  // line(od, do, hrúbka, farba) – rad malých škvŕn pozdĺž oblúka
  function marker() {
    const out = [];
    const m = (d, a, b, col, rot) => out.push({ d: norm(d), a, b: b == null ? a : b, col, rot: rot || 0 });
    const line = (p, q, w, col, n) => { p = norm(p); q = norm(q); n = n || Math.max(3, Math.ceil(Math.acos(Math.max(-1, Math.min(1, dot(p, q)))) / (w * 0.7))); for (let i = 0; i <= n; i++) m(slerp(p, q, i / n), w, w, col); };
    return { out, m, line };
  }
  function kriziakMarks(C) {
    const A = marker(), H = marker(), S = marker();
    // chrbát zadočka: tmavý zvlnený list po bokoch, biely kríž zo škvŕn, drobné biele bodky
    for (const s of [-1, 1]) {
      A.line([0.75, 0.55, s * 0.45], [0.2, 0.8, s * 0.6], 0.07, C.band);
      A.line([0.2, 0.8, s * 0.6], [-0.25, 0.85, s * 0.4], 0.07, C.band);
      A.line([-0.25, 0.85, s * 0.4], [-0.75, 0.55, s * 0.25], 0.06, C.band);
      A.m([0.45, 0.85, s * 0.22], 0.08, 0.08, C.mark); A.m([-0.05, 0.95, s * 0.2], 0.06, 0.06, C.mark);
      A.m([0.1, 0.75, s * 0.75], 0.05, 0.05, C.mark); A.m([-0.45, 0.8, s * 0.45], 0.05, 0.05, C.mark);
    }
    A.line([0.9, 0.42, 0], [-0.35, 0.94, 0], 0.085, C.mark); // pozdĺžne rameno kríža
    A.line([0.42, 0.88, -0.42], [0.42, 0.88, 0.42], 0.08, C.mark); // priečne rameno
    // brucho: čierny pás a dve žlté zátvorky
    S.line([0.45, -1, 0], [-0.5, -0.9, 0], 0.22, C.belly);
    for (const s of [-1, 1]) S.line([0.4, -0.95, s * 0.36], [-0.4, -0.85, s * 0.3], 0.08, C.belly2);
    // hlavohruď: tmavší stred, oči vpredu
    H.line([0.8, 0.6, 0], [-0.4, 0.9, 0], 0.18, C.dark);
    for (const s of [-1, 1]) { H.m([0.9, 0.42, s * 0.12], 0.07, 0.07, C.eye); H.m([0.82, 0.5, s * 0.3], 0.06, 0.06, C.eye); }
    return { abd: A.out.concat(S.out), ceph: H.out };
  }
  function vlciakMarks(C) {
    const A = marker(), H = marker();
    // hlavohruď: tmavé bočné pásy s lúčmi, svetlý stredný pás a okraje, veľké oči hore vpredu
    for (const s of [-1, 1]) {
      H.line([0.75, 0.62, s * 0.3], [-0.6, 0.72, s * 0.35], 0.2, C.dark);
      H.line([0.3, 0.35, s * 0.88], [-0.6, 0.35, s * 0.72], 0.1, C.mark);
      H.m([0.72, 0.62, s * 0.18], 0.12, 0.12, C.eye); H.m([0.5, 0.8, s * 0.3], 0.085, 0.085, C.eye);
      H.m([0.97, 0.18, s * 0.05], 0.045, 0.045, C.eye); H.m([0.95, 0.15, s * 0.15], 0.045, 0.045, C.eye);
    }
    H.line([0.55, 0.85, 0], [-0.7, 0.72, 0], 0.11, C.mark);
    // zadoček: tmavá srdcová škvrna vpredu, svetlé šípky vzadu, tmavé brucho
    A.line([0.92, 0.38, 0], [0.2, 0.98, 0], 0.13, C.dark);
    for (let i = 0; i < 4; i++) {
      const x = -0.05 - i * 0.22;
      for (const s of [-1, 1]) A.line([x + 0.1, 0.9 - i * 0.08, s * 0.32], [x, 0.98 - i * 0.12, 0.001 * s], 0.05, C.mark);
    }
    for (const s of [-1, 1]) A.line([0.6, 0.5, s * 0.62], [-0.6, 0.55, s * 0.6], 0.07, C.dark);
    A.line([0.6, -1, 0], [-0.6, -1, 0], 0.45, C.belly);
    return { abd: A.out, ceph: H.out };
  }
  function pradlenaMarks(C) {
    const A = marker(), H = marker(), S = marker();
    // svetlé škvrny pred hrbmi, listová kresba (tmavý zubatý okraj) za nimi, šípky
    for (const s of [-1, 1]) {
      A.m([0.75, 0.6, s * 0.28], 0.1, 0.07, C.mark); A.m([0.62, 0.72, s * 0.12], 0.07, 0.07, C.mark);
      A.line([0.25, 0.9, s * 0.42], [-0.15, 0.9, s * 0.48], 0.07, C.dark);
      A.line([-0.15, 0.9, s * 0.48], [-0.35, 0.85, s * 0.3], 0.07, C.dark);
      A.line([-0.35, 0.85, s * 0.3], [-0.55, 0.75, s * 0.36], 0.07, C.dark);
      A.line([-0.55, 0.75, s * 0.36], [-0.85, 0.45, s * 0.08], 0.07, C.dark);
      A.line([0.15, 0.95, s * 0.28], [-0.4, 0.88, s * 0.12], 0.05, C.mark);
    }
    for (let i = 0; i < 3; i++) A.m([-0.15 - i * 0.24, 0.97 - i * 0.12, 0], 0.09 - i * 0.015, 0.05, C.mark);
    S.line([0.45, -1, 0], [-0.45, -0.9, 0], 0.2, C.belly);
    for (const s of [-1, 1]) S.m([0.05, -1, s * 0.3], 0.1, 0.07, C.belly2);
    H.line([0.8, 0.6, 0], [-0.4, 0.9, 0], 0.16, C.dark);
    for (const s of [-1, 1]) { H.m([0.9, 0.45, s * 0.12], 0.08, 0.08, C.eye); H.m([0.8, 0.55, s * 0.32], 0.065, 0.065, C.eye); }
    return { abd: A.out.concat(S.out), ceph: H.out };
  }

  // ---------- stavba modelu ----------
  // ell: { c, A (3 stĺpce = poloosi), col, dark, marks }, seg: { a, b, wa, wb, col }
  function ellAxes(len, hgt, wid, tilt) {
    const ct = Math.cos(tilt || 0), st = Math.sin(tilt || 0);
    return [[len / 2 * ct, len / 2 * st, 0], [-hgt / 2 * st, hgt / 2 * ct, 0], [0, 0, wid / 2]];
  }
  // pose: 'ground' (stojí na zemi) alebo 'surface' (prilepený na zvislej ploche – telo bližšie k ploche)
  function build(kind, phase, pose) {
    const K = SPECIES[kind] || SPECIES.v, C = K.col, ph = phase || 0;
    const parts = [];
    const lift0 = pose === 'surface' ? 0.55 : 1;
    const raise = (K.lifted || 0) * (pose === 'surface' ? 0.35 : 1); // pradlena stojí vysoko na nohách
    const bob = Math.abs(Math.sin(ph)) * 0.03;
    const cy = K.ceph.y * lift0 + raise + bob, ay = K.abd.y * lift0 + raise + bob;
    const ceph = { k: 'ell', c: [K.ceph.x, cy, 0], A: ellAxes(K.ceph.len, K.ceph.hgt, K.ceph.wid, -(K.ceph.rise || 0)), col: C.ceph, dark: C.out, part: 'ceph' };
    const abd = { k: 'ell', c: [K.abd.x, ay, 0], A: ellAxes(K.abd.len, K.abd.hgt, K.abd.wid, K.abd.tilt), col: C.abd, dark: C.out, part: 'abd' };
    const mk = K.marks(C);
    for (const m of mk.ceph) if (m.col === C.eye) m.eye = true; // oči sa v tme lesknú
    ceph.marks = mk.ceph; abd.marks = mk.abd;
    parts.push(ceph, abd);
    // hrudná kosť zospodu (tmavá)
    parts.push({ k: 'ell', c: [K.ceph.x, cy - K.ceph.hgt * 0.32, 0], A: ellAxes(K.ceph.len * 0.72, K.ceph.hgt * 0.25, K.ceph.wid * 0.62, 0), col: C.belly, dark: C.out, part: 'sternum' });
    // stopka medzi hlavohruďou a zadočkom
    parts.push({ k: 'seg', a: [K.ceph.x - K.ceph.len * 0.42, cy - 0.02, 0], b: [K.abd.x + K.abd.len * 0.38, ay - K.abd.hgt * 0.15, 0], wa: 0.14, wb: 0.14, col: C.dark });
    for (const [x, y, z, r] of K.humps || []) {
      const p = add(abd.c, mv(abd.A, [x, y, z]));
      parts.push({ k: 'ell', c: p, A: ellAxes(r * K.abd.len * 0.5, r * K.abd.hgt * 0.62, r * K.abd.wid * 0.5, 0.6), col: C.abd, dark: C.out, part: 'hump', marks: [{ d: norm([0.6, 0.8, 0]), a: 0.45, b: 0.35, col: C.mark, rot: 0 }] });
    }
    // chelicery a makadlá
    for (const s of [-1, 1]) {
      const f = [K.ceph.x + K.ceph.len * 0.48, cy - K.ceph.hgt * 0.12, s * K.ceph.wid * 0.13];
      parts.push({ k: 'ell', c: f, A: ellAxes(K.cheli, K.cheli * 1.4, K.cheli * 0.85, -1.1), col: C.dark, dark: C.out, part: 'cheli' });
      const [reach, w] = K.palp, hip = [K.ceph.x + K.ceph.len * 0.42, cy - K.ceph.hgt * 0.1, s * K.ceph.wid * 0.28];
      const mid = add(hip, [reach * 0.45, 0.12, s * reach * 0.35]), tip = add(hip, [reach, Math.max(0.03 - hip[1], -0.25), s * reach * 0.42]);
      parts.push({ k: 'seg', a: hip, b: mid, wa: w, wb: w * 0.85, col: C.leg }, { k: 'seg', a: mid, b: tip, wa: w * 0.85, wb: w, col: C.band });
    }
    // nohy: bedro na okraji hlavohrude → koleno (najvyššie) → členok → chodidlo na zemi; chôdza striedavo (L1 P2 L3 P4)
    K.legs.forEach(([ha, fa, reach, kh, kf, ah, af, w0, w1], i) => {
      for (const s of [-1, 1]) {
        const g = (i + (s > 0 ? 1 : 0)) % 2, q = ph + g * Math.PI;
        const hr = ha * Math.PI / 180, fr = fa * Math.PI / 180;
        const hip = [K.ceph.x + Math.cos(hr) * K.ceph.len * 0.42, cy - K.ceph.hgt * 0.15, s * Math.sin(hr) * K.ceph.wid * 0.42];
        const step = Math.sin(q) * K.stride, up = Math.max(0, Math.cos(q)) * K.lift;
        const foot = [Math.cos(fr) * reach + step, up + 0.02, s * Math.sin(fr) * reach];
        const hz = [foot[0] - hip[0], 0, foot[2] - hip[2]];
        const base = hip[1] - foot[1];
        const knee = add(hip, [hz[0] * kf, kh * lift0 + (kh * (1 - lift0)) * 0.3 + up * 0.4 + (raise ? raise * 0.35 : 0), hz[2] * kf]);
        const ankle = [hip[0] + hz[0] * af, foot[1] + ah * lift0 + up * 0.5 + (base > 0 ? base * 0.12 : 0), hip[2] + hz[2] * af];
        const wm = w0 + (w1 - w0) * 0.45, wa = w0 + (w1 - w0) * 0.75;
        parts.push({ k: 'seg', a: hip, b: knee, wa: w0, wb: wm, col: C.leg, band: C.band, leg: i },
          { k: 'seg', a: knee, b: ankle, wa: wm, wb: wa, col: C.leg, band: C.band, leg: i },
          { k: 'seg', a: ankle, b: foot, wa, wb: w1, col: C.leg, band: C.band, leg: i, tip: true });
      }
    });
    // zmenšenie na rozpätie (raz pre druh, v kľudovej póze)
    const k = scaleOf(kind);
    for (const p of parts) {
      if (p.k === 'ell') { p.gloss = K.gloss; p.c = mul(p.c, k); p.A = p.A.map(a => mul(a, k)); }
      else { p.a = mul(p.a, k); p.b = mul(p.b, k); p.wa *= k; p.wb *= k; }
    }
    return parts;
  }
  const scales = {};
  function scaleOf(kind) {
    if (scales[kind]) return scales[kind];
    const K = SPECIES[kind] || SPECIES.v;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [, fa, reach] of K.legs) for (const s of [-1, 1]) {
      const fr = fa * Math.PI / 180, x = Math.cos(fr) * reach, z = s * Math.sin(fr) * reach;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    scales[kind] = K.span / Math.max(x1 - x0, z1 - z0);
    return scales[kind];
  }

  // ---------- pohľady: model → kanonický svet (stĺpce = kam ide os x, y, z modelu) ----------
  // navyše 'dorsal' a 'ventral' – kolmo zhora a zdola, hlava hore (len na porovnanie s fotkami v /debug)
  function viewMatrix(view) {
    if (view === 'dorsal' || view === 'ventral') { const n = view === 'dorsal' ? CAM.c : mul(CAM.c, -1); return [CAM.u, n, cross(CAM.u, n)]; }
    const i = PLANAR.indexOf(view);
    if (i >= 0) {
      const a = i * Math.PI / 4, h = [Math.sin(a), 0, Math.cos(a)], y = [0, 1, 0];
      return [h, y, cross(h, y)];
    }
    const tm = /^t(-?\d+)([ud])$/.exec(view);
    if (tm) {
      const a = +tm[1] * Math.PI / 180, n = [Math.sin(a), 0, Math.cos(a)], h = tm[2] === 'u' ? [0, 1, 0] : [0, -1, 0];
      return [h, n, cross(h, n)];
    }
    const belly = view.endsWith('-b'), dir = view.replace('-b', '');
    // plocha je zvislá a natočená ku kamere; chrbát ku kamere (+z) alebo od nej
    const n = belly ? [0, 0, -1] : [0, 0, 1];
    const h = { up: [0, 1, 0], down: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0] }[dir];
    return [h, n, cross(h, n)];
  }
  const isSurface = view => !PLANAR.includes(view) && view !== 'dorsal' && view !== 'ventral';

  // ---------- priemet do 2D (jednotky sveta; y hore) ----------
  // Elipsoid → elipsa (presne, ortografický priemet), kresba → malé elipsy (len na strane ku kamere),
  // úsečka → zúžený pás. Poradie podľa hĺbky (maliarov algoritmus).
  function project(parts, view) {
    const M = viewMatrix(view);
    const W = v => mv(M, v);
    const P2 = v => [dot(v, CAM.r), dot(v, CAM.u)];
    const items = [];
    for (const p of parts) {
      if (p.k === 'ell') {
        const c = W(p.c), A = p.A.map(W);
        const e = ellipse2(A.map(P2));
        // svetlá škvrna: bod povrchu s normálou k svetlu
        const s = norm([dot(A[0], LIGHT), dot(A[1], LIGHT), dot(A[2], LIGHT)]);
        const hl = P2(add(c, add(add(mul(A[0], s[0]), mul(A[1], s[1])), mul(A[2], s[2]))));
        const it = { k: 'ell', part: p.part, d: dot(c, CAM.c), C3: c, A3: A, c: P2(c), e, hl, col: p.col, dark: p.dark, gloss: p.gloss == null ? 0.3 : p.gloss, marks: [] };
        for (const mk of p.marks || []) {
          // normála elipsoidu v bode A·d je A^-T·d; ku kamere ⇔ (A^-T d)·cam > 0 ⇔ d·(A^-1 cam) > 0
          const n = dot(mk.d, solve3(A, CAM.c));
          if (n <= 0.02) continue;
          const f = markFrame(A, mk), at = add(c, f.at);
          const T1 = P2(f.T1), T2 = P2(f.T2);
          it.marks.push({ c: P2(at), m: [T1, T2], col: mk.col, fade: Math.min(1, n * 4), eye: mk.eye });
        }
        items.push(it);
      } else {
        const a = W(p.a), b = W(p.b);
        items.push({ k: 'seg', d: dot(mul(add(a, b), 0.5), CAM.c), a3: a, b3: b, a: P2(a), b: P2(b), wa: p.wa, wb: p.wb, col: p.col, band: p.band, tip: p.tip });
      }
    }
    return order(items);
  }
  // Poradie kreslenia: elipsoidy medzi sebou a úsečky medzi sebou podľa hĺbky stredu; úsečka voči elipsoidu presne –
  // z bodov úsečky (ktoré na obrazovke padnú do elipsy) lúč ku kamere: ak pretne povrch elipsoidu, je úsečka za ním.
  // Topologické triedenie (pri cykle vyhrá najvzdialenejší).
  function behind(sg, el) {
    let vote = 0;
    for (const t of [0.15, 0.5, 0.85]) {
      const q = add(mul(sg.a3, 1 - t), mul(sg.b3, t));
      const a0 = solve3(el.A3, sub(q, el.C3)), b0 = solve3(el.A3, CAM.c);
      const A = dot(b0, b0), B = 2 * dot(a0, b0), Cq = dot(a0, a0) - 1, D = B * B - 4 * A * Cq;
      if (D <= 0) continue; // lúč elipsoid míňa – tu sa neprekrývajú
      const lf = (-B + Math.sqrt(D)) / (2 * A);
      vote += lf > 0 ? 1 : -1;
    }
    return vote;
  }
  function order(items) {
    const n = items.length, before = items.map(() => new Set()), deps = new Array(n).fill(0);
    const edge = (i, j) => { if (!before[i].has(j)) { before[i].add(j); deps[j]++; } }; // i sa kreslí pred j
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = items[i], b = items[j];
      if (a.k === b.k) { if (a.d < b.d) edge(i, j); else edge(j, i); continue; }
      const sg = a.k === 'seg' ? a : b, el = a.k === 'seg' ? b : a, si = a.k === 'seg' ? i : j, ei = a.k === 'seg' ? j : i;
      const v = behind(sg, el);
      if (v > 0) edge(si, ei); else if (v < 0) edge(ei, si);
    }
    const out = [], done = new Array(n).fill(false);
    for (let k = 0; k < n; k++) {
      let best = -1;
      for (let i = 0; i < n; i++) if (!done[i] && deps[i] === 0 && (best < 0 || items[i].d < items[best].d)) best = i;
      if (best < 0) for (let i = 0; i < n; i++) if (!done[i] && (best < 0 || items[i].d < items[best].d)) best = i; // cyklus
      done[best] = true; out.push(items[best]);
      for (const j of before[best]) deps[j]--;
    }
    return out;
  }
  // škvrna na povrchu: stred (voči stredu elipsoidu) a jej dve poloosi vo svete
  function markFrame(A, mk) {
    const d = mk.d, ref = Math.abs(d[0]) > 0.98 ? [0, 1, 0] : [1, 0, 0];
    const t1 = norm(sub(ref, mul(d, dot(d, ref)))), t2 = cross(d, t1);
    const cr = Math.cos(mk.rot), sr = Math.sin(mk.rot);
    const u1 = add(mul(t1, cr), mul(t2, sr)), u2 = add(mul(t1, -sr), mul(t2, cr));
    return { at: combo(A, d), T1: mul(combo(A, u1), mk.a), T2: mul(combo(A, u2), mk.b) };
  }
  const combo = (A, v) => add(add(mul(A[0], v[0]), mul(A[1], v[1])), mul(A[2], v[2]));
  // A (stĺpce) · x = b
  function solve3(A, b) {
    const [a, c, e] = A, det = dot(a, cross(c, e));
    return [dot(b, cross(c, e)) / det, dot(a, cross(b, e)) / det, dot(a, cross(c, b)) / det];
  }
  // priemet elipsoidu: kovariancia B·Bᵀ (B = 2 × 3) → poloosi a uhol
  function ellipse2(B) {
    let xx = 0, xy = 0, yy = 0;
    for (const [x, y] of B) { xx += x * x; xy += x * y; yy += y * y; }
    const tr = (xx + yy) / 2, df = Math.sqrt(Math.max(0, ((xx - yy) / 2) ** 2 + xy * xy));
    const l1 = tr + df, l2 = Math.max(1e-9, tr - df);
    const ang = Math.abs(xy) < 1e-12 ? (xx >= yy ? 0 : Math.PI / 2) : Math.atan2(l1 - xx, xy);
    return { rx: Math.sqrt(l1), ry: Math.sqrt(l2), ang };
  }

  // ---------- kreslenie do 2D plátna ----------
  // (ox, oy) = pixel počiatku modelu (zem pod stredom tela), ppu = pixelov na jednotku sveta
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = v => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))));
    return '#' + ((1 << 24) + (f(n >> 16) << 16) + (f((n >> 8) & 255) << 8) + f(n & 255)).toString(16).slice(1);
  }
  function draw(c, items, ppu, ox, oy) {
    const X = p => ox + p[0] * ppu, Y = p => oy - p[1] * ppu;
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const it of items) {
      if (it.k === 'seg') { seg(c, it, X, Y, ppu); continue; }
      const { rx, ry, ang } = it.e, cx = X(it.c), cy = Y(it.c);
      const path = (k, dx, dy) => { c.beginPath(); c.ellipse(cx + (dx || 0), cy + (dy || 0), Math.max(0.3, rx * ppu * k), Math.max(0.3, ry * ppu * k), -ang, 0, Math.PI * 2); };
      // obrys, tieň, telo, svetlá strana (posunutá k svetlu), lesk
      const out = Math.max(0.4, Math.min(ppu * 0.003, Math.min(rx, ry) * ppu * 0.05));
      c.fillStyle = it.dark; path(1); c.save(); c.lineWidth = out * 2; c.strokeStyle = it.dark; c.stroke(); c.fill(); c.restore();
      const hx = X(it.hl) - cx, hy = Y(it.hl) - cy;
      c.save(); path(1); c.clip();
      c.fillStyle = shade(it.col, -0.35); path(0.98); c.fill();
      c.fillStyle = it.col; path(0.86, hx * 0.18, hy * 0.18); c.fill();
      for (const mk of it.marks) {
        c.save();
        c.globalAlpha = mk.fade;
        c.translate(X(mk.c), Y(mk.c));
        c.transform(mk.m[0][0] * ppu, -mk.m[0][1] * ppu, mk.m[1][0] * ppu, -mk.m[1][1] * ppu, 0, 0);
        c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.restore(); c.save(); c.globalAlpha = mk.fade; c.fillStyle = mk.col; c.fill(); c.restore();
      }
      c.globalAlpha = 0.25 + it.gloss * 0.3; c.fillStyle = shade(it.col, 0.35); path(0.45, hx * 0.5, hy * 0.5); c.fill();
      c.globalAlpha = it.gloss; c.fillStyle = '#fff'; path(0.1, hx * 0.75, hy * 0.75); c.fill();
      c.globalAlpha = 1;
      c.restore();
    }
    c.restore();
  }
  // zúžený článok nohy: obrys, farba, tmavý prúžok na konci článku (pruhované nohy), konček tmavší
  function seg(c, it, X, Y, ppu) {
    const ax = X(it.a), ay = Y(it.a), bx = X(it.b), by = Y(it.b);
    const wa = Math.max(0.6, it.wa * ppu), wb = Math.max(0.5, it.wb * ppu);
    const quad = (x0, y0, x1, y1, w0, w1, col) => {
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1e-6, nx = -dy / l, ny = dx / l;
      c.fillStyle = col; c.beginPath();
      c.moveTo(x0 + nx * w0 / 2, y0 + ny * w0 / 2); c.lineTo(x1 + nx * w1 / 2, y1 + ny * w1 / 2);
      c.lineTo(x1 - nx * w1 / 2, y1 - ny * w1 / 2); c.lineTo(x0 - nx * w0 / 2, y0 - ny * w0 / 2); c.closePath(); c.fill();
      c.beginPath(); c.arc(x0, y0, w0 / 2, 0, Math.PI * 2); c.arc(x1, y1, w1 / 2, 0, Math.PI * 2); c.fill();
    };
    const o = Math.max(0.3, Math.min(ppu * 0.003, (wa + wb) * 0.1));
    quad(ax, ay, bx, by, wa + o * 2, wb + o * 2, '#000000' === it.col ? it.col : shade(it.band || it.col, -0.55));
    quad(ax, ay, bx, by, wa, wb, it.col);
    if (it.band) {
      const t = it.tip ? 0.55 : 0.62, mx = ax + (bx - ax) * t, my = ay + (by - ay) * t, wm = wa + (wb - wa) * t;
      quad(mx, my, bx, by, wm * 0.98, wb * 0.98, it.band);
    }
  }

  // ---------- sprity: veľkosť plátna cez všetky snímky pohľadu ----------
  const FRAMES = 4;
  const layouts = {};
  function layout(kind, view) {
    const key = kind + ':' + view;
    if (layouts[key]) return layouts[key];
    const K = SPECIES[kind] || SPECIES.v, ppu = K.ppu;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const frames = [];
    for (let f = 0; f < FRAMES; f++) {
      const items = project(build(kind, f * Math.PI / 2, isSurface(view) ? 'surface' : 'ground'), view);
      frames.push(items);
      for (const it of items) {
        if (it.k === 'ell') { const r = Math.max(it.e.rx, it.e.ry); x0 = Math.min(x0, it.c[0] - r); x1 = Math.max(x1, it.c[0] + r); y0 = Math.min(y0, it.c[1] - r); y1 = Math.max(y1, it.c[1] + r); }
        else for (const p of [it.a, it.b]) { const r = Math.max(it.wa, it.wb); x0 = Math.min(x0, p[0] - r); x1 = Math.max(x1, p[0] + r); y0 = Math.min(y0, p[1] - r); y1 = Math.max(y1, p[1] + r); }
      }
    }
    const pad = 3;
    // vodorovne súmerne okolo počiatku (sprite sa centruje), zvislo podľa obsahu
    const hw = Math.max(-x0, x1);
    const w = Math.ceil(hw * ppu * 2 + pad * 2), h = Math.ceil((y1 - y0) * ppu + pad * 2);
    const L = { w, h, ox: w / 2, oy: pad + y1 * ppu, ppu, frames, bottom: y0, eyes: frames.map(eyesOf) };
    layouts[key] = L;
    return L;
  }
  // Oči viditeľné v snímke: { x, y } (svet, voči počiatku modelu, y hore) a polomer r. Oko, ktoré zakryje časť tela
  // nakreslená po hlavohrudi (zadoček, hrb), sa nepočíta.
  function eyesOf(items) {
    const hi = items.findIndex(i => i.part === 'ceph');
    if (hi < 0) return [];
    const inside = (e, p) => {
      const dx = p[0] - e.c[0], dy = p[1] - e.c[1], c = Math.cos(e.e.ang), s = Math.sin(e.e.ang);
      const u = (dx * c + dy * s) / e.e.rx, v = (-dx * s + dy * c) / e.e.ry;
      return u * u + v * v < 1;
    };
    const later = items.slice(hi + 1).filter(i => i.k === 'ell' && i.part !== 'cheli');
    return items[hi].marks.filter(m => m.eye && m.fade > 0.3 && !later.some(e => inside(e, m.c)))
      .map(m => ({ x: m.c[0], y: m.c[1], r: Math.sqrt(Math.abs(m.m[0][0] * m.m[1][1] - m.m[0][1] * m.m[1][0])) }));
  }
  // nakreslí snímku f (0–3) pohľadu do plátna veľkosti layout(kind, view)
  function sprite(c, kind, view, f) {
    const L = layout(kind, view);
    draw(c, L.frames[((f | 0) % FRAMES + FRAMES) % FRAMES], L.ppu, L.ox, L.oy);
    return L;
  }
  // pohľad na kmeni podľa strany kmeňa (nx, nz = smer od kmeňa) a smeru ku kamere; null = za kmeňom (nevidno ho)
  function trunkView(nx, nz, gx, gz, up) {
    const a = Math.atan2(nx * gz - nz * gx, nx * gx + nz * gz) * 180 / Math.PI;
    if (Math.abs(a) > 112.5) return null;
    const q = Math.max(-90, Math.min(90, Math.round(a / 45) * 45));
    return 't' + q + (up ? 'u' : 'd');
  }
  // pohľad na zemi podľa smeru hlavy (dx, dz vo svete) a smeru ku kamere (gx, gz vodorovne)
  function planarView(dx, dz, gx, gz) {
    const s = dx * gx + dz * gz, e = dx * gz - dz * gx; // vpravo od kamery = (gz, -gx)
    const i = ((Math.round(Math.atan2(e, s) / (Math.PI / 4)) % 8) + 8) % 8;
    return PLANAR[i];
  }

  // ---------- 3D model (Three.js) – pre /debug, na porovnanie s 2D ----------
  function buildMesh(THREE, kind, phase, view) {
    const g = new THREE.Group();
    const parts = build(kind, phase || 0, view && isSurface(view) ? 'surface' : 'ground');
    const sphere = new THREE.SphereGeometry(1, 28, 18), ball = new THREE.SphereGeometry(1, 10, 8);
    const mats = new Map();
    const mat = col => { if (!mats.has(col)) mats.set(col, new THREE.MeshLambertMaterial({ color: col })); return mats.get(col); };
    const basis = A => new THREE.Matrix4().makeBasis(new THREE.Vector3(...A[0]), new THREE.Vector3(...A[1]), new THREE.Vector3(...A[2]));
    for (const p of parts) {
      if (p.k === 'ell') {
        const m = new THREE.Mesh(sphere, mat(p.col));
        m.matrixAutoUpdate = false; m.matrix.copy(basis(p.A)).setPosition(...p.c);
        g.add(m);
        // kresba: sploštené guľôčky tesne na povrchu
        for (const mk of p.marks || []) {
          const f = markFrame(p.A, mk), nrm = norm(solve3T(p.A, mk.d)), th = avgR(p.A) * 0.02;
          const d = new THREE.Mesh(sphere, mat(mk.col));
          d.matrixAutoUpdate = false;
          d.matrix.makeBasis(new THREE.Vector3(...f.T1), new THREE.Vector3(...mul(nrm, th)), new THREE.Vector3(...f.T2)).setPosition(...add(add(p.c, f.at), mul(nrm, th * 0.5)));
          g.add(d);
        }
      } else {
        const a = new THREE.Vector3(...p.a), b = new THREE.Vector3(...p.b), d = b.clone().sub(a), len = d.length();
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.wb / 2, p.wa / 2, len, 10, 1), mat(p.col));
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        g.add(m);
        for (const [q, w] of [[a, p.wa], [b, p.wb]]) { const j = new THREE.Mesh(ball, mat(p.band || p.col)); j.position.copy(q); j.scale.setScalar(w / 2); g.add(j); }
      }
    }
    // model → svet pohľadu
    const M = viewMatrix(view || 'S');
    g.matrixAutoUpdate = false; g.matrix.makeBasis(new THREE.Vector3(...M[0]), new THREE.Vector3(...M[1]), new THREE.Vector3(...M[2]));
    return g;
  }
  const avgR = A => (Math.hypot(...A[0]) + Math.hypot(...A[1]) + Math.hypot(...A[2])) / 3;
  function solve3T(A, d) { // A^-T · d (normála)
    const [a, b, e] = A, det = dot(a, cross(b, e));
    const r0 = cross(b, e), r1 = cross(e, a), r2 = cross(a, b);
    return [r0[0] * d[0] / det + r1[0] * d[1] / det + r2[0] * d[2] / det, r0[1] * d[0] / det + r1[1] * d[1] / det + r2[1] * d[2] / det, r0[2] * d[0] / det + r1[2] * d[1] / det + r2[2] * d[2] / det];
  }

  // výška očí nad zemou (stred hlavohrude) – pre lesk očí v tme
  const eyeH = {};
  const eyeHeight = kind => eyeH[kind] != null ? eyeH[kind] : (eyeH[kind] = build(kind, 0, 'ground')[0].c[1]);

  const api = { eyeHeight, SPECIES, VIEWS, PLANAR, TRUNK, trunkView, PITCH, CAM, FRAMES, build, project, draw, layout, sprite, planarView, viewMatrix, isSurface, buildMesh, scaleOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpiderModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
