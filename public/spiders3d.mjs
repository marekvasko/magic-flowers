// 3D pavúky a pavučiny (#57): pavučiny medzi kmeňmi v Lese divov (v tme ich vidno len v dohľade, s lampášom sa lesknú
// kúsok ďalej), nory vlčiakov, kútové pavučiny krížiaka v záhrade a v horách a samotné pavúky (sprity s krokom nôh).
// V tme sú z pavúkov za dohľadom vidno len lesknúce sa oči (kreslia sa do prekrytia).
// render3d.mjs volá update() každú snímku a overlay() pri kreslení prekrytia.
export function createSpiders3d({ THREE, scene, S, D, Art, groundY, lightAt, spriteTex, makeSprite, project }) {
  const WEB = D.WEB, SPI = D.SPIDERS;
  const webMeshes = new Map(), cornerMeshes = [], burrowMeshes = [], sprites = new Map();
  let builtWebs = -1, builtCorner = -1, builtArea = null, builtTiles = -1;
  const holeGeo = new THREE.CircleGeometry(0.26, 18);

  function add(o) { o.layers.set(1); scene.add(o); return o; }
  function drop(o) { scene.remove(o); if (o.material) o.material.dispose(); if (o.geometry && o.geometry !== holeGeo) o.geometry.dispose(); }
  function plane(w, h, tex) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 2;
    return add(m);
  }

  // ---- pavučiny a nory (Les divov) ----
  function buildWebs() {
    for (const m of webMeshes.values()) drop(m);
    webMeshes.clear();
    for (const m of burrowMeshes) drop(m);
    burrowMeshes.length = 0;
    if (S.area !== 'les') return;
    for (const wb of S.webs) {
      const key = `web:${wb.n}:${wb.silk}:${wb.id % 5}`;
      const tex = spriteTex(key, 128 * wb.n, 140, c => Art.web(c, 128 * wb.n, 140, wb.silk, wb.id % 5));
      const m = plane(wb.n, 1.1, tex);
      m.material.blending = THREE.AdditiveBlending; m.userData.glow = true; // v tme sa vlákna lesknú (svetlo sa pripočíta)
      const cx = wb.ax ? wb.x + 0.5 : wb.x + wb.n / 2, cz = wb.ax ? wb.y + wb.n / 2 : wb.y + 0.5;
      m.position.set(cx, groundY(Math.floor(cx), Math.floor(cz)) + 0.62, cz);
      if (wb.ax) m.rotation.y = Math.PI / 2;
      webMeshes.set(wb.id, m);
    }
    for (const h of S.homes) {
      if (h.k !== 'v') continue;
      const m = add(new THREE.Mesh(holeGeo, new THREE.MeshBasicMaterial({ color: 0x0d0906, transparent: true, depthWrite: false })));
      m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.7, 1);
      m.position.set(h.x + 0.5, groundY(h.x, h.y) + 0.02, h.y + 0.5);
      burrowMeshes.push(m);
    }
  }
  // ---- kútové pavučiny krížiaka: vejár na hrane steny pri zemi, kolmo na stenu ----
  function buildCorners() {
    for (const m of cornerMeshes) drop(m);
    cornerMeshes.length = 0;
    const s = 0.55, tex = spriteTex('cornerweb', 64, 64, c => Art.cornerWeb(c, 64, true));
    for (const k of S.corner) {
      const bx = k.x + 0.5 + k.dx * 0.5 + k.ex * 0.47, bz = k.y + 0.5 + k.dy * 0.5 + k.ey * 0.47;
      const m = plane(s, s, tex);
      m.position.set(bx - k.dx * s / 2, groundY(k.x, k.y) + s / 2, bz - k.dy * s / 2);
      const rot = k.ex !== 0; // normála pavučiny je v smere e (pozdĺž steny)
      if (rot) m.rotation.y = Math.PI / 2;
      if ((rot ? -k.dy : k.dx) > 0) m.scale.x = -1; // roh textúry (vľavo dolu) k stene
      cornerMeshes.push(m);
    }
  }

  // ---- pavúky ----
  const SIZE = { v: [1.0, 0.5], p: [2.3, 1.15], k: [0.42, 0.21] };
  function spriteFor(o) {
    let sp = sprites.get(o.id);
    if (!sp) { const [w, h] = SIZE[o.k] || SIZE.v; sp = makeSprite(w, h); sp.userData.k = o.k; sprites.set(o.id, sp); }
    return sp;
  }
  function frameTex(k, f) { return spriteTex(`spider:${k}:${f}`, 128, 64, c => Art.spider(c, k, 64, 62, 100, f * Math.PI / 2)); }

  const lastSeen = new Map(); // id → { x, y, z, seen, d } pre oči v prekrytí
  function update(dt, t, lights) {
    if (builtArea !== S.area || builtTiles !== S.tilesGen) { builtArea = S.area; builtTiles = S.tilesGen; builtWebs = builtCorner = -1; } // nová plocha (výška zeme)
    if (builtWebs !== S.websGen) { builtWebs = S.websGen; buildWebs(); }
    if (builtCorner !== S.cornerGen) { builtCorner = S.cornerGen; buildCorners(); }
    const me = S.me, lamp = S.sel === 'lamp', lo = {};
    // pavučiny: v tme len v dohľade (a v svetle lampášov); s lampášom v ruke sa lesknú ešte kúsok ďalej
    for (const m of [...webMeshes.values(), ...cornerMeshes]) {
      const p = m.position, c = lightAt(p.x, p.y, p.z, lights, lights.length, lo);
      let seen = lo.seen, k = Math.max(c[0], c[1], c[2]);
      if (m.userData.glow) {
        // pavučina v lese: v dohľade jemne strieborná, s lampášom v ruke sa leskne (aj kúsok za dohľadom)
        const d = Math.hypot(p.x - me.x, p.z - me.y);
        const glint = lamp && d <= WEB.glint ? 1 - Math.max(0, d - WEB.glint + 1) : 0;
        k = Math.max(0.45 * seen, 0.85 * glint) * (0.9 + 0.1 * Math.sin(t * 2 + p.x * 3 + p.z));
        seen = Math.max(seen, glint);
      }
      m.material.color.setRGB(Math.min(1, k * 1.05), Math.min(1, k * 1.08), Math.min(1, k * 1.12));
      m.material.opacity = m.userData.glow ? 1 : seen;
      m.visible = seen > 0.02 && k > 0.01;
    }
    for (const m of burrowMeshes) { const p = m.position; lightAt(p.x, p.y, p.z, lights, lights.length, lo); m.material.opacity = 0.85 * lo.seen; m.visible = lo.seen > 0.02; }
    const alive = new Set();
    lastSeen.clear();
    for (const o of S.spiders.values()) {
      alive.add(o.id);
      const sp = spriteFor(o);
      let x = o.x, z = o.y, lift = 0;
      if (o.c) { // na chrbte hráča
        if (Math.hypot(o.x - me.x, o.y - me.y) < 1.2) { x = me.x; z = me.y; }
        lift = 0.45;
      }
      const f = o.m ? Math.floor(o.phase / (Math.PI / 2)) % 4 : 0;
      const key = o.k + f;
      if (sp.userData.key !== key) { sp.material.map = frameTex(o.k, f); sp.material.needsUpdate = true; sp.userData.key = key; }
      const y = groundY(x, z) + lift;
      sp.position.set(x, y, z);
      const c = lightAt(x, y + 0.2, z, lights, lights.length, lo);
      if (o.c) for (let i = 0; i < 3; i++) c[i] = Math.max(c[i], 0.8); // na sebe ho vidíš aj v tme
      sp.material.color.setRGB(...c);
      // pavúk na chrbte hráča sa kreslí navrch (inak by ho zakryla postavička)
      if (sp.userData.top !== !!o.c) { const m = sp.material; sp.userData.top = !!o.c; m.depthTest = !o.c; m.transparent = !!o.c; sp.renderOrder = o.c ? 1e6 + 1 : 0; m.needsUpdate = true; } // až po siluete hráča
      const inBurrow = o.k === 'v' && o.h;
      sp.visible = lo.seen > 0.02 && !inBurrow;
      lastSeen.set(o.id, { x, y: y + (SIZE[o.k] || SIZE.v)[1] * 0.4, z, seen: inBurrow ? 0 : lo.seen, d: Math.hypot(x - me.x, z - me.y), k: o.k });
    }
    for (const [id, sp] of sprites) if (!alive.has(id)) { scene.remove(sp); sp.material.dispose(); sprites.delete(id); }
  }

  // V tme: oči vlčiaka a pradleny sa lesknú aj za dohľadom (vlčiak do SPI.vlciak.eyes políčok) – kto si dá pozor, uvidí ich skôr.
  function overlay(c, ppb, t) {
    if (!D.isDark(S.area)) return;
    for (const [id, e] of lastSeen) {
      if (e.k === 'k') continue;
      const range = (e.k === 'p' ? SPI.pradlena : SPI.vlciak).eyes;
      if (e.d > range || e.seen > 0.7) continue;
      const h = (id.charCodeAt(1) || 0) * 1.7;
      if (Math.sin(t * 0.9 + h) < -0.85) continue; // žmurknutie
      const a = (1 - e.seen) * (1 - Math.max(0, e.d - range + 1.5) / 1.5) * (0.65 + 0.35 * Math.sin(t * 3 + h));
      if (a <= 0.02) continue;
      const P = project(e.x, e.y, e.z), gap = ppb * (e.k === 'p' ? 0.16 : 0.08), r = Math.max(1.5, ppb * (e.k === 'p' ? 0.045 : 0.03));
      c.globalAlpha = Math.min(1, a);
      c.fillStyle = e.k === 'p' ? '#ff6a4a' : '#ffcf6a';
      c.shadowColor = c.fillStyle; c.shadowBlur = r * 4;
      for (const s of [-1, 1]) { c.beginPath(); c.arc(P.x + s * gap / 2, P.y, r, 0, Math.PI * 2); c.fill(); }
      c.shadowBlur = 0; c.globalAlpha = 1;
    }
  }
  function dispose() {
    for (const m of webMeshes.values()) drop(m);
    for (const m of [...cornerMeshes, ...burrowMeshes]) drop(m);
    for (const sp of sprites.values()) { scene.remove(sp); sp.material.dispose(); }
    holeGeo.dispose();
  }
  return { update, overlay, dispose };
}
