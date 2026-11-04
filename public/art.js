// Procedurálna grafika – kvety, postavičky, budovy, ikony.
const Art = (() => {
  const D = window.GameData;
  const TAU = Math.PI * 2;

  function ell(c, x, y, rx, ry, rot, fill, stroke) {
    c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, TAU);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = Math.max(0.6, rx * 0.12); c.stroke(); }
  }
  function circ(c, x, y, r, fill) { c.beginPath(); c.arc(x, y, Math.max(0.1, r), 0, TAU); c.fillStyle = fill; c.fill(); }
  function hash(x, y, k) { let h = (x * 374761393 + y * 668265263 + (k || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  const OUT = 'rgba(40,30,20,0.35)';

  function petals(c, x, y, n, len, wid, color, rot, stroke) {
    for (let i = 0; i < n; i++) {
      const a = (rot || 0) + i * TAU / n;
      ell(c, x + Math.sin(a) * len * 0.55, y - Math.cos(a) * len * 0.55, wid, len * 0.55, a, color, stroke ? OUT : null);
    }
  }

  // Kvet (rozkvitnutá hlavička) so stredom v x,y a polomerom r
  function bloom(c, key, x, y, r, t, night) {
    const sp = D.SPECIES[key];
    const col = sp.color, cen = sp.center;
    switch (sp.shape) {
      case 'cup': {
        ell(c, x - r * 0.42, y, r * 0.48, r * 0.85, -0.3, shade(col, -0.15), OUT);
        ell(c, x + r * 0.42, y, r * 0.48, r * 0.85, 0.3, shade(col, -0.15), OUT);
        ell(c, x, y - r * 0.08, r * 0.5, r * 0.92, 0, col, OUT);
        if (key === 'mak') circ(c, x, y + r * 0.35, r * 0.22, cen);
        ell(c, x - r * 0.12, y - r * 0.35, r * 0.12, r * 0.35, 0, 'rgba(255,255,255,0.35)');
        break;
      }
      case 'bell': {
        for (let i = -1; i <= 1; i++) {
          const bx = x + i * r * 0.75, by = y + Math.abs(i) * r * 0.35;
          ell(c, bx, by, r * 0.38, r * 0.5, 0, col, 'rgba(60,80,40,0.5)');
          circ(c, bx, by - r * 0.45, r * 0.13, cen);
          if (key === 'snezienka') circ(c, bx, by + r * 0.3, r * 0.1, cen);
        }
        break;
      }
      case 'star':
        petals(c, x, y, 6, r * 1.05, r * 0.36, col, 0, true);
        circ(c, x, y, r * 0.45, cen); circ(c, x, y, r * 0.28, shade(cen, -0.2));
        break;
      case 'daisy':
        petals(c, x, y, 13, r * 1.05, r * 0.17, col, t * 0.05, true);
        circ(c, x, y, r * 0.38, cen); circ(c, x - r * 0.1, y - r * 0.1, r * 0.13, shade(cen, 0.4));
        break;
      case 'spiky': {
        c.fillStyle = col; c.strokeStyle = OUT; c.lineWidth = 0.8;
        for (let i = 0; i < 9; i++) {
          const a = i * TAU / 9;
          c.beginPath();
          c.moveTo(x + Math.sin(a - 0.25) * r * 0.3, y - Math.cos(a - 0.25) * r * 0.3);
          c.lineTo(x + Math.sin(a - 0.18) * r * 1.05, y - Math.cos(a - 0.18) * r * 1.05);
          c.lineTo(x + Math.sin(a) * r * 0.85, y - Math.cos(a) * r * 0.85);
          c.lineTo(x + Math.sin(a + 0.18) * r * 1.05, y - Math.cos(a + 0.18) * r * 1.05);
          c.lineTo(x + Math.sin(a + 0.25) * r * 0.3, y - Math.cos(a + 0.25) * r * 0.3);
          c.fill(); c.stroke();
        }
        circ(c, x, y, r * 0.32, cen);
        break;
      }
      case 'sun':
        petals(c, x, y, 18, r * 1.1, r * 0.2, col, 0, true);
        circ(c, x, y, r * 0.58, cen);
        for (let i = 0; i < 10; i++) { const a = i * 2.4; circ(c, x + Math.cos(a) * r * 0.32 * (i / 10), y + Math.sin(a) * r * 0.32 * (i / 10), r * 0.06, '#3e2a1e'); }
        break;
      case 'spike':
        for (let j = -1; j <= 1; j++) for (let i = 0; i < 6; i++) {
          circ(c, x + j * r * 0.55 + (i % 2 ? 1 : -1) * r * 0.12, y + r * 0.6 - i * r * 0.3 - Math.abs(j) * r * -0.2, r * 0.17, i % 2 ? col : sp.center);
        }
        break;
      case 'rose':
      case 'rainbow': {
        const base = sp.shape === 'rainbow' ? 'hsl(' + ((t * 60) % 360 | 0) + ',85%,62%)' : col;
        const dark = sp.shape === 'rainbow' ? 'hsl(' + ((t * 60 + 40) % 360 | 0) + ',80%,45%)' : shade(col, -0.25);
        petals(c, x, y, 5, r * 1.0, r * 0.45, base, 0.3, true);
        circ(c, x, y, r * 0.55, dark);
        c.strokeStyle = sp.shape === 'rainbow' ? 'hsl(' + ((t * 60 + 120) % 360 | 0) + ',90%,75%)' : shade(col, 0.35);
        c.lineWidth = Math.max(1, r * 0.12);
        c.beginPath(); for (let a = 0; a < 9; a += 0.3) { const rr = r * 0.05 * a; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } c.stroke();
        if (sp.shape === 'rainbow') { c.globalAlpha = 0.3 + 0.2 * Math.sin(t * 3); circ(c, x, y, r * 1.4, '#fff'); c.globalAlpha = 1; }
        break;
      }
      case 'pom':
        for (let ring = 3; ring >= 0; ring--) {
          const n = 6 + ring * 4, rr = r * (0.2 + ring * 0.27);
          for (let i = 0; i < n; i++) { const a = i * TAU / n + ring; circ(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, r * 0.22, shade(col, -0.25 + ring * 0.1)); }
        }
        circ(c, x, y, r * 0.25, cen);
        break;
      case 'edel': {
        c.fillStyle = col; c.strokeStyle = 'rgba(120,120,100,0.6)'; c.lineWidth = 1;
        for (let i = 0; i < 8; i++) {
          const a = i * TAU / 8 + 0.2, l = r * (i % 2 ? 0.85 : 1.1);
          c.beginPath();
          c.moveTo(x + Math.cos(a - 0.35) * r * 0.3, y + Math.sin(a - 0.35) * r * 0.3);
          c.quadraticCurveTo(x + Math.cos(a - 0.15) * l, y + Math.sin(a - 0.15) * l, x + Math.cos(a) * l, y + Math.sin(a) * l);
          c.quadraticCurveTo(x + Math.cos(a + 0.15) * l, y + Math.sin(a + 0.15) * l, x + Math.cos(a + 0.35) * r * 0.3, y + Math.sin(a + 0.35) * r * 0.3);
          c.fill(); c.stroke();
        }
        for (let i = 0; i < 7; i++) circ(c, x + Math.cos(i * 0.9) * r * 0.2 * (i ? 1 : 0), y + Math.sin(i * 0.9) * r * 0.2 * (i ? 1 : 0), r * 0.12, cen);
        break;
      }
      case 'hell':
        petals(c, x, y, 5, r * 1.0, r * 0.5, col, 0, true);
        for (let i = 0; i < 5; i++) { const a = i * TAU / 5 + 0.6; ell(c, x + Math.sin(a) * r * 0.5, y - Math.cos(a) * r * 0.5, r * 0.18, r * 0.3, a, 'rgba(220,130,170,0.35)'); }
        for (let i = 0; i < 10; i++) { const a = i * TAU / 10; circ(c, x + Math.cos(a) * r * 0.28, y + Math.sin(a) * r * 0.28, r * 0.08, cen); }
        circ(c, x, y, r * 0.15, '#9ccc65');
        break;
      case 'fern': {
        const glow = night ? 1 : 0.35;
        const g = c.createRadialGradient(x, y, 0, x, y, r * 2.2);
        g.addColorStop(0, 'rgba(255,150,240,' + 0.8 * glow + ')'); g.addColorStop(1, 'rgba(255,150,240,0)');
        c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 2.2, 0, TAU); c.fill();
        petals(c, x, y, 5, r * 1.0, r * 0.38, col, t * 0.6, false);
        petals(c, x, y, 5, r * 0.6, r * 0.22, '#ffd0f6', t * 0.6 + 0.6, false);
        circ(c, x, y, r * 0.25, cen);
        for (let i = 0; i < 4; i++) { const a = t * 2 + i * 1.57; circ(c, x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.1, r * 0.1, '#fff8b0'); }
        break;
      }
    }
  }

  function leaf(c, x, y, len, ang, col) { ell(c, x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, len * 0.5, len * 0.2, ang, col); }

  // Rastlina na políčku – x je stred, y spodok, s veľkosť políčka
  function plant(c, key, stage, x, y, s, t, o) {
    o = o || {};
    const sp = D.SPECIES[key];
    const sway = Math.sin(t * 2 + x * 0.05) * 0.06;
    const green = o.dead ? '#8a6a3a' : '#3f8f2f', leafC = o.dead ? '#9b7b45' : '#56a83a';
    if (stage === 0) {
      ell(c, x, y - s * 0.12, s * 0.16, s * 0.07, 0, o.dead ? '#6b4a2a' : '#5b3a1a');
      circ(c, x - s * 0.05, y - s * 0.14, s * 0.025, '#e8d29a'); circ(c, x + s * 0.05, y - s * 0.12, s * 0.025, '#e8d29a');
      return;
    }
    if (o.dead) {
      c.strokeStyle = green; c.lineWidth = s * 0.05; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x, y - s * 0.1); c.quadraticCurveTo(x + s * 0.05, y - s * 0.45, x + s * 0.22, y - s * 0.3); c.stroke();
      leaf(c, x, y - s * 0.15, s * 0.2, Math.PI * 0.85, leafC); leaf(c, x, y - s * 0.15, s * 0.2, Math.PI * 0.15, leafC);
      circ(c, x + s * 0.22, y - s * 0.28, s * 0.07, '#7a5a30');
      return;
    }
    const tall = sp.shape === 'sun' ? 1.0 : sp.shape === 'rose' || sp.shape === 'rainbow' ? 0.65 : 0.55;
    const h = s * tall * (stage === 1 ? 0.35 : stage === 2 ? 0.75 : 1);
    const by = y - s * 0.1;
    if (sp.shape === 'fern') {
      for (let i = -2; i <= 2; i++) {
        const a = -Math.PI / 2 + i * 0.45 + sway, len = s * (stage === 1 ? 0.3 : 0.55) * (1 - Math.abs(i) * 0.12);
        c.strokeStyle = '#2f7d32'; c.lineWidth = s * 0.03;
        const ex = x + Math.cos(a) * len, ey = by + Math.sin(a) * len;
        c.beginPath(); c.moveTo(x, by); c.lineTo(ex, ey); c.stroke();
        for (let k = 1; k < 6; k++) { const px = x + Math.cos(a) * len * k / 6, py = by + Math.sin(a) * len * k / 6; leaf(c, px, py, s * 0.1 * (1 - k / 7), a - 1.2, '#4caf50'); leaf(c, px, py, s * 0.1 * (1 - k / 7), a + 1.2, '#4caf50'); }
      }
      if (stage === 2) ell(c, x, by - s * 0.5, s * 0.06, s * 0.09, 0, '#c45ab3');
      if (stage === 3) {
        if (o.night) bloom(c, key, x, by - s * 0.55, s * 0.17, t, true);
        else { ell(c, x, by - s * 0.52, s * 0.08, s * 0.12, 0, '#d16ac2'); circ(c, x, by - s * 0.52, s * 0.04, '#ffd0f6'); }
      }
      return;
    }
    const tx = x + Math.sin(sway) * h, ty = by - h;
    c.strokeStyle = green; c.lineWidth = Math.max(1.2, s * (sp.shape === 'sun' ? 0.06 : 0.04)); c.lineCap = 'round';
    if (sp.shape === 'spike') {
      for (let j = -1; j <= 1; j++) { c.beginPath(); c.moveTo(x, by); c.lineTo(tx + j * s * 0.13, ty + Math.abs(j) * s * 0.06); c.stroke(); }
    } else { c.beginPath(); c.moveTo(x, by); c.quadraticCurveTo(x, by - h * 0.5, tx, ty); c.stroke(); }
    leaf(c, x, by - h * 0.25, s * (stage === 1 ? 0.16 : 0.22), Math.PI + 0.5, leafC);
    leaf(c, x, by - h * 0.3, s * (stage === 1 ? 0.16 : 0.22), -0.5, leafC);
    if (sp.shape === 'sun' && stage >= 2) { leaf(c, x, by - h * 0.6, s * 0.25, Math.PI + 0.4, leafC); leaf(c, x, by - h * 0.65, s * 0.25, -0.4, leafC); }
    if (stage === 2) {
      const col = sp.shape === 'rainbow' ? 'hsl(' + ((t * 60) % 360 | 0) + ',80%,60%)' : sp.color;
      ell(c, tx, ty, s * 0.07, s * 0.11, 0, col, OUT);
      ell(c, tx, ty + s * 0.05, s * 0.075, s * 0.06, 0, '#4f9a32');
    } else if (stage === 3) {
      const r = s * (sp.shape === 'sun' ? 0.28 : sp.shape === 'bell' ? 0.17 : sp.shape === 'spike' ? 0.2 : 0.22);
      if (o.wilting) { c.globalAlpha = 0.6; bloom(c, key, tx + s * 0.04, ty + s * 0.07, r * 0.85, t, o.night); c.globalAlpha = 1; } // odkvitá: bledne a ovisne
      else bloom(c, key, tx, ty, r, t, o.night);
      if (o.ready && !o.wilting) { const a = 0.5 + 0.5 * Math.sin(t * 4); circ(c, tx + r, ty - r, s * 0.03 * (1 + a), 'rgba(255,255,220,' + (0.5 + a * 0.5) + ')'); }
    }
  }

  // Postavička – x stred, y chodidlá.
  // dir: 0 dole, 1 vľavo, 2 vpravo, 3 hore, 4 vľavo dole, 5 vpravo dole, 6 vľavo hore, 7 vpravo hore
  // o.lift: výška skoku v px (tieň ostáva na zemi), o.crawl: plazí sa (pokrčené kolená, predklon)
  function char(c, x, y, s, look, dir, phase, o) {
    o = o || {};
    const lift = o.lift || 0;
    if (lift > 0) {
      if (!o.noShadow) { const k = Math.max(0.45, 1 - lift / s); ell(c, x, y, s * 0.24 * k, s * 0.08 * k, 0, 'rgba(0,0,0,' + 0.25 * k + ')'); }
      c.save(); c.translate(0, -lift);
      char(c, x, y, s, look, dir, phase, Object.assign({}, o, { lift: 0, noShadow: true }));
      c.restore();
      return;
    }
    const skin = '#f2c9a0';
    let d = dir;
    let bob = Math.abs(Math.sin(phase)) * s * 0.04;
    if (o.dance) { d = Math.floor(phase * 1.2) % 4; bob = Math.abs(Math.sin(phase * 3)) * s * 0.12; }
    // uhlopriečne smery kreslíme ako pohľad dole/hore natočený do strany
    const side = d === 4 || d === 6 ? -1 : d === 5 || d === 7 ? 1 : 0;
    if (d >= 4) d = d <= 5 ? 0 : 3;
    if (!o.noShadow) ell(c, x, y, s * 0.24, s * 0.08, 0, 'rgba(0,0,0,0.25)');
    const yb = y - bob;
    const step = Math.sin(phase) * s * 0.06;
    // plazenie: kolená pokrčené (kratšie nohy), trup sa predkloní v bokoch smerom pohybu;
    // pri pohľade spredu/zozadu predklon nevidno do strany, tak sa hlava len prikrčí k telu
    const fx = d === 1 ? -1 : d === 2 ? 1 : side;
    const kn = o.crawl ? s * 0.08 : 0;
    if (o.crawl) { c.save(); c.translate(-fx * s * 0.08, 0); } // ťažisko dozadu, nech sa postavička zmestí do spritu
    // nohy
    c.fillStyle = o.babka ? '#5b3a6b' : '#3b4a6b';
    if (!o.babka) {
      c.fillRect(x - s * 0.13, yb - s * 0.22 + kn + (d === 1 || d === 2 ? 0 : step * 0.5), s * 0.1, s * 0.2 - kn);
      c.fillRect(x + s * 0.03, yb - s * 0.22 + kn - (d === 1 || d === 2 ? 0 : step * 0.5), s * 0.1, s * 0.2 - kn);
      c.fillStyle = '#4a3020';
      c.fillRect(x - s * 0.14 + (d === 1 ? -step : d === 2 ? step : 0), yb - s * 0.05, s * 0.12, s * 0.05);
      c.fillRect(x + s * 0.02 - (d === 1 ? -step : d === 2 ? step : 0), yb - s * 0.05, s * 0.12, s * 0.05);
    }
    if (o.crawl) { const hx = x, hyp = yb - s * 0.2; c.translate(hx, hyp + kn + (fx ? 0 : s * 0.07)); c.rotate(fx * (d === 0 || d === 3 ? 0.3 : 0.45)); c.translate(-hx, -hyp); }
    // telo
    const shirt = look.shirt || '#4a90d9';
    c.fillStyle = shirt;
    c.beginPath();
    if (o.babka) { c.moveTo(x - s * 0.26, yb - s * 0.02); c.lineTo(x - s * 0.16, yb - s * 0.55); c.lineTo(x + s * 0.16, yb - s * 0.55); c.lineTo(x + s * 0.26, yb - s * 0.02); }
    else { c.roundRect ? c.roundRect(x - s * 0.19, yb - s * 0.56, s * 0.38, s * 0.38, s * 0.1) : c.rect(x - s * 0.19, yb - s * 0.56, s * 0.38, s * 0.38); }
    c.fill();
    if (o.babka) { c.fillStyle = '#f5f0e0'; c.fillRect(x - s * 0.12, yb - s * 0.4, s * 0.24, s * 0.3); c.fillStyle = '#e57373'; for (let i = 0; i < 3; i++) circ(c, x - s * 0.06 + i * s * 0.06, yb - s * 0.2, s * 0.02, '#e57373'); }
    else { c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(x - s * 0.19, yb - s * 0.26, s * 0.38, s * 0.06); }
    // ruky
    const sw = o.dance ? Math.sin(phase * 3) * s * 0.15 : step;
    circ(c, x - s * 0.22, yb - s * 0.36 + (d === 1 || d === 2 ? 0 : sw), s * 0.065, skin);
    circ(c, x + s * 0.22, yb - s * 0.36 - (d === 1 || d === 2 ? 0 : sw), s * 0.065, skin);
    // hlava
    const hy = yb - s * 0.74;
    circ(c, x, hy, s * 0.21, skin);
    const hair = look.hair || '#5b3a1a';
    c.fillStyle = hair;
    if (o.babka) {
      c.fillStyle = '#eeeeee'; c.beginPath(); c.arc(x, hy - s * 0.04, s * 0.215, Math.PI, TAU); c.fill();
      c.fillStyle = '#c0392b';
      c.beginPath(); c.arc(x, hy - s * 0.06, s * 0.235, Math.PI * 1.05, Math.PI * 1.95); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(x - s * 0.23, hy - s * 0.1); c.lineTo(x - s * 0.27, hy + s * 0.16); c.lineTo(x - s * 0.16, hy - s * 0.06); c.fill();
      c.beginPath(); c.moveTo(x + s * 0.23, hy - s * 0.1); c.lineTo(x + s * 0.27, hy + s * 0.16); c.lineTo(x + s * 0.16, hy - s * 0.06); c.fill();
      for (let i = 0; i < 3; i++) circ(c, x - s * 0.1 + i * s * 0.1, hy - s * 0.17, s * 0.022, '#fff');
    } else {
      c.beginPath(); c.arc(x, hy - s * 0.02, s * 0.225, Math.PI, TAU); c.fill();
      if (d === 3) { circ(c, x, hy, s * 0.2, hair); if (side) circ(c, x + side * s * 0.19, hy + s * 0.03, s * 0.045, skin); }
      else if (side) c.fillRect(side < 0 ? x + s * 0.12 : x - s * 0.22, hy - s * 0.07, s * 0.1, s * 0.15);
      else if (d === 1) c.fillRect(x, hy - s * 0.08, s * 0.22, s * 0.16);
      else if (d === 2) c.fillRect(x - s * 0.22, hy - s * 0.08, s * 0.22, s * 0.16);
      else { c.fillRect(x - s * 0.22, hy - s * 0.06, s * 0.07, s * 0.14); c.fillRect(x + s * 0.15, hy - s * 0.06, s * 0.07, s * 0.14); }
    }
    // oči
    const eye = '#222';
    if (d === 0 && side) {
      const ex = x + side * s * 0.06;
      circ(c, ex - s * 0.06, hy + s * 0.03, s * 0.03, eye); circ(c, ex + s * 0.06, hy + s * 0.03, s * 0.03, eye);
      circ(c, ex + side * s * 0.1, hy + s * 0.09, s * 0.03, 'rgba(255,120,120,0.5)');
    } else if (d === 0) { circ(c, x - s * 0.075, hy + s * 0.03, s * 0.03, eye); circ(c, x + s * 0.075, hy + s * 0.03, s * 0.03, eye); circ(c, x - s * 0.12, hy + s * 0.09, s * 0.03, 'rgba(255,120,120,0.5)'); circ(c, x + s * 0.12, hy + s * 0.09, s * 0.03, 'rgba(255,120,120,0.5)'); }
    else if (d === 1) circ(c, x - s * 0.1, hy + s * 0.03, s * 0.03, eye);
    else if (d === 2) circ(c, x + s * 0.1, hy + s * 0.03, s * 0.03, eye);
    if (o.babka && d === 0 && !side) { c.strokeStyle = '#555'; c.lineWidth = 1; c.beginPath(); c.arc(x - s * 0.075, hy + s * 0.03, s * 0.055, 0, TAU); c.moveTo(x + s * 0.13, hy + s * 0.03); c.arc(x + s * 0.075, hy + s * 0.03, s * 0.055, 0, TAU); c.stroke(); }
    // slamený klobúk pre farmára
    if (look.hat) { ell(c, x, hy - s * 0.12, s * 0.32, s * 0.08, 0, '#e8c86a'); ell(c, x, hy - s * 0.2, s * 0.16, s * 0.1, 0, '#e8c86a'); c.fillStyle = '#c0392b'; c.fillRect(x - s * 0.16, hy - s * 0.17, s * 0.32, s * 0.03); }
    if (o.crawl) c.restore();
  }

  // ---- Prostredie ----
  const GRASS = ['#86c95b', '#74b84a', '#aab24e', '#e7edf0'];
  const FOREST = ['#5f9a46', '#4f8a3c', '#8a8a3f', '#cfd8dc'];

  function ground(c, g, x, y, s, se, t, tx, ty) {
    const h = hash(tx, ty);
    let base;
    switch (g) {
      case 'path': base = se === 3 ? '#e0dccf' : '#d9b77e'; break;
      case 'sand': base = se === 3 ? '#efece0' : '#ecd9a0'; break;
      case 'rock': case 'boulder': base = se === 3 ? '#d8dcde' : '#a9a39a'; break;
      case 'water': base = se === 3 ? '#a9d4ec' : '#4aa3df'; break;
      case 'forest': case 'ring': case 'shroom': case 'tree': base = FOREST[se]; break;
      default: base = GRASS[se];
    }
    c.fillStyle = base; c.fillRect(x, y, s + 1, s + 1);
    if (g === 'water') {
      c.strokeStyle = se === 3 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)'; c.lineWidth = Math.max(1, s * 0.03);
      for (let i = 0; i < 2; i++) {
        const wy = y + s * (0.3 + i * 0.4), off = Math.sin(t * 1.5 + tx + i * 2) * s * 0.1;
        c.beginPath(); c.moveTo(x + s * 0.2 + off, wy); c.quadraticCurveTo(x + s * 0.4 + off, wy - s * 0.08, x + s * 0.6 + off, wy); c.stroke();
      }
      if (h < 0.12 && se !== 3) { ell(c, x + s * 0.5, y + s * 0.5, s * 0.2, s * 0.14, 0, '#5fae4a'); circ(c, x + s * 0.55, y + s * 0.45, s * 0.06, '#ffb6d9'); }
      return;
    }
    if (g === 'path' || g === 'sand') {
      for (let i = 0; i < 3; i++) circ(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.03, 'rgba(120,90,50,0.3)');
      return;
    }
    if (g === 'rock' || g === 'boulder') {
      for (let i = 0; i < 3; i++) ell(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.07, s * 0.05, 0, 'rgba(80,75,70,0.35)');
      if (h < 0.15 && se !== 3) { circ(c, x + s * 0.3, y + s * 0.6, s * 0.05, '#c8e6c9'); }
      return;
    }
    // tráva / les
    if (se !== 3) {
      c.strokeStyle = 'rgba(30,80,20,0.35)'; c.lineWidth = Math.max(1, s * 0.025);
      for (let i = 0; i < 3; i++) {
        const gx = x + hash(tx, ty, i) * s, gy = y + hash(tx, ty, i + 9) * s;
        c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx - s * 0.03, gy - s * 0.08); c.moveTo(gx, gy); c.lineTo(gx + s * 0.04, gy - s * 0.07); c.stroke();
      }
      if (g === 'grass' && h > 0.86) {
        const cols = ['#fff', '#ffe14d', '#ff9ecf', '#b39ddb'];
        circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.04, cols[(h * 40 | 0) % 4]);
      }
      if (se === 2 && h > 0.6) ell(c, x + hash(tx, ty, 7) * s, y + hash(tx, ty, 8) * s, s * 0.06, s * 0.035, h * 6, '#d9822b');
    } else if (h > 0.7) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.05, '#fff');
    if (g === 'ring') { c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x, y, s, s); }
  }

  function soil(c, so, x, y, s, se) {
    const m = s * 0.06;
    let col = so.k === 'sand' ? '#c9a26a' : so.k === 'rock' ? '#8d7b6a' : '#8b5a2b';
    if (so.w) col = shade(col, -0.35);
    c.fillStyle = col;
    if (c.roundRect) { c.beginPath(); c.roundRect(x + m, y + m, s - 2 * m, s - 2 * m, s * 0.12); c.fill(); } else c.fillRect(x + m, y + m, s - 2 * m, s - 2 * m);
    c.strokeStyle = 'rgba(0,0,0,0.15)'; c.lineWidth = Math.max(1, s * 0.03);
    for (let i = 1; i < 3; i++) { c.beginPath(); c.moveTo(x + s * 0.18, y + s * i / 3); c.lineTo(x + s * 0.82, y + s * i / 3); c.stroke(); }
    if (so.r) for (let i = 0; i < 5; i++) circ(c, x + s * (0.2 + 0.6 * hash(i, x | 0)), y + s * (0.2 + 0.6 * hash(y | 0, i)), s * 0.035, '#3a2410');
    if (so.w) { c.fillStyle = 'rgba(120,180,255,0.18)'; c.fillRect(x + m, y + m, s - 2 * m, s - 2 * m); }
    if (se === 3 && !so.w) { c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x + m, y + m, s - 2 * m, s * 0.25); }
  }

  function tree(c, x, y, s, se, t, h) {
    ell(c, x, y - s * 0.05, s * 0.45, s * 0.14, 0, 'rgba(0,0,0,0.22)');
    c.fillStyle = '#6d4c2f'; c.fillRect(x - s * 0.09, y - s * 0.6, s * 0.18, s * 0.58);
    const sway = Math.sin(t + h * 10) * s * 0.02;
    if (h > 0.55) { // smrek
      const cols = se === 3 ? ['#2f5d3a', '#fff'] : ['#2e6b3a', '#3d8a4a'];
      for (let i = 0; i < 3; i++) {
        const ty = y - s * (0.5 + i * 0.38), w = s * (0.62 - i * 0.14);
        c.fillStyle = cols[0]; c.beginPath(); c.moveTo(x - w + sway, ty); c.lineTo(x + w + sway, ty); c.lineTo(x + sway * 2, ty - s * 0.6); c.fill();
        if (se === 3) { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(x - w * 0.5 + sway, ty - s * 0.3); c.lineTo(x + w * 0.5 + sway, ty - s * 0.3); c.lineTo(x + sway * 2, ty - s * 0.6); c.fill(); }
      }
      return;
    }
    if (se === 3) {
      c.strokeStyle = '#6d4c2f'; c.lineWidth = s * 0.06;
      for (let i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(x, y - s * 0.55); c.lineTo(x + i * s * 0.35 + sway, y - s * 1.1); c.stroke(); }
      for (let i = -1; i <= 1; i++) ell(c, x + i * s * 0.33 + sway, y - s * 1.1, s * 0.1, s * 0.05, 0, '#fff');
      return;
    }
    const col = [['#4caf50', '#3e8e41'], ['#3f9a3a', '#2f7a2f'], ['#e08a2b', '#c4621e'], ['', '']][se];
    if (se === 2 && h < 0.2) { col[0] = '#e6b42b'; col[1] = '#c48a1e'; }
    circ(c, x - s * 0.25 + sway, y - s * 0.75, s * 0.33, col[1]);
    circ(c, x + s * 0.25 + sway, y - s * 0.78, s * 0.33, col[1]);
    circ(c, x + sway, y - s * 1.05, s * 0.4, col[0]);
    circ(c, x - s * 0.12 + sway, y - s * 1.15, s * 0.14, 'rgba(255,255,255,0.15)');
    if (se === 0 && h < 0.25) for (let i = 0; i < 5; i++) circ(c, x + (hash(i, 1, h * 99) - 0.5) * s * 0.7 + sway, y - s * (0.8 + hash(i, 2, h * 99) * 0.5), s * 0.05, '#ffd6e8');
    if (se === 1 && h < 0.2) for (let i = 0; i < 4; i++) circ(c, x + (hash(i, 1, h * 99) - 0.5) * s * 0.7 + sway, y - s * (0.8 + hash(i, 2, h * 99) * 0.5), s * 0.05, '#e53935');
  }

  function shroom(c, x, y, s, night, t) {
    if (night) {
      const g = c.createRadialGradient(x, y - s * 0.15, 0, x, y - s * 0.15, s * 0.5);
      g.addColorStop(0, 'rgba(180,255,220,' + (0.35 + 0.15 * Math.sin(t * 2 + x)) + ')'); g.addColorStop(1, 'rgba(180,255,220,0)');
      c.fillStyle = g; c.fillRect(x - s * 0.5, y - s * 0.65, s, s);
    }
    c.fillStyle = '#f5f0e0'; c.fillRect(x - s * 0.05, y - s * 0.22, s * 0.1, s * 0.2);
    c.beginPath(); c.arc(x, y - s * 0.2, s * 0.17, Math.PI, TAU); c.fillStyle = night ? '#ff6b6b' : '#d32f2f'; c.fill();
    circ(c, x - s * 0.07, y - s * 0.27, s * 0.03, '#fff'); circ(c, x + s * 0.06, y - s * 0.3, s * 0.025, '#fff'); circ(c, x + s * 0.01, y - s * 0.23, s * 0.02, '#fff');
  }

  function boulder(c, x, y, s, se) {
    ell(c, x, y - s * 0.08, s * 0.42, s * 0.12, 0, 'rgba(0,0,0,0.2)');
    ell(c, x, y - s * 0.3, s * 0.42, s * 0.3, 0, '#8a8580');
    ell(c, x - s * 0.1, y - s * 0.4, s * 0.2, s * 0.12, -0.3, '#a8a39e');
    if (se === 3) ell(c, x, y - s * 0.52, s * 0.3, s * 0.1, 0, '#fff');
  }

  function hut(c, x, y, s, se, night) { // x,y = ľavý horný roh 3×2
    const w = s * 3, h = s * 2;
    ell(c, x + w / 2, y + h, w * 0.55, s * 0.2, 0, 'rgba(0,0,0,0.2)');
    c.fillStyle = '#c9a77a'; c.fillRect(x + s * 0.1, y + s * 0.4, w - s * 0.2, h - s * 0.4);
    c.strokeStyle = '#8b6a45'; c.lineWidth = s * 0.04;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(x + s * 0.1, y + s * 0.4 + i * s * 0.38); c.lineTo(x + w - s * 0.1, y + s * 0.4 + i * s * 0.38); c.stroke(); }
    c.fillStyle = se === 3 ? '#f2f6f8' : '#b5884a';
    c.beginPath(); c.moveTo(x - s * 0.2, y + s * 0.6); c.lineTo(x + w / 2, y - s * 0.7); c.lineTo(x + w + s * 0.2, y + s * 0.6); c.fill();
    c.strokeStyle = se === 3 ? '#cfd8dc' : '#8b6a35'; c.lineWidth = s * 0.03;
    for (let i = 1; i < 5; i++) { c.beginPath(); c.moveTo(x + w / 2, y - s * 0.7); c.lineTo(x - s * 0.2 + i * (w + s * 0.4) / 5, y + s * 0.6); c.stroke(); }
    c.fillStyle = '#6d4c2f'; c.fillRect(x + s * 1.2, y + s * 1.15, s * 0.6, s * 0.85);
    circ(c, x + s * 1.68, y + s * 1.6, s * 0.04, '#ffd54f');
    const win = night ? '#ffe082' : '#9fd3f0';
    c.fillStyle = win; c.fillRect(x + s * 0.35, y + s * 0.9, s * 0.5, s * 0.45); c.fillRect(x + s * 2.15, y + s * 0.9, s * 0.5, s * 0.45);
    c.strokeStyle = '#6d4c2f'; c.lineWidth = s * 0.04; c.strokeRect(x + s * 0.35, y + s * 0.9, s * 0.5, s * 0.45); c.strokeRect(x + s * 2.15, y + s * 0.9, s * 0.5, s * 0.45);
    // sušené bylinky
    for (let i = 0; i < 4; i++) { c.fillStyle = ['#8e7cc3', '#ffcf1f', '#e53935', '#7cb342'][i]; c.fillRect(x + s * (0.95 + i * 0.3), y + s * 0.62, s * 0.08, s * 0.22); }
    c.fillStyle = '#7a5a3a'; c.fillRect(x + s * 2.3, y - s * 0.45, s * 0.22, s * 0.5);
  }

  function house(c, x, y, s, se, night) {
    const w = s * 3, h = s * 2;
    ell(c, x + w / 2, y + h, w * 0.55, s * 0.2, 0, 'rgba(0,0,0,0.2)');
    c.fillStyle = '#f5efe0'; c.fillRect(x + s * 0.1, y + s * 0.4, w - s * 0.2, h - s * 0.4);
    c.fillStyle = '#3a6ea5'; c.fillRect(x + s * 0.1, y + s * 1.75, w - s * 0.2, s * 0.25);
    c.fillStyle = se === 3 ? '#f2f6f8' : '#c0533a';
    c.beginPath(); c.moveTo(x - s * 0.2, y + s * 0.6); c.lineTo(x + s * 0.4, y - s * 0.6); c.lineTo(x + w - s * 0.4, y - s * 0.6); c.lineTo(x + w + s * 0.2, y + s * 0.6); c.fill();
    c.fillStyle = '#6d4c2f'; c.fillRect(x + s * 1.2, y + s * 1.1, s * 0.6, s * 0.9);
    const win = night ? '#ffe082' : '#9fd3f0';
    c.fillStyle = win; c.fillRect(x + s * 0.4, y + s * 0.9, s * 0.45, s * 0.45); c.fillRect(x + s * 2.15, y + s * 0.9, s * 0.45, s * 0.45);
    // ornament ako v Čičmanoch
    c.strokeStyle = '#fff'; c.lineWidth = s * 0.04;
    for (let i = 0; i < 5; i++) { const ox = x + s * (0.4 + i * 0.55); c.beginPath(); c.moveTo(ox, y + s * 1.55); c.lineTo(ox + s * 0.12, y + s * 1.45); c.lineTo(ox + s * 0.24, y + s * 1.55); c.stroke(); }
    // kvetináče
    for (let i = 0; i < 2; i++) { const px = x + s * (0.62 + i * 1.76); c.fillStyle = '#b5652a'; c.fillRect(px - s * 0.2, y + s * 1.35, s * 0.4, s * 0.12); circ(c, px - s * 0.1, y + s * 1.3, s * 0.06, '#e53935'); circ(c, px + s * 0.1, y + s * 1.3, s * 0.06, '#e53935'); }
  }

  function stall(c, x, y, s, t) { // 3×1
    const w = s * 3;
    ell(c, x + w / 2, y + s, w * 0.5, s * 0.15, 0, 'rgba(0,0,0,0.2)');
    c.fillStyle = '#8b5a2b'; c.fillRect(x + s * 0.1, y - s * 0.9, s * 0.1, s * 1.8); c.fillRect(x + w - s * 0.2, y - s * 0.9, s * 0.1, s * 1.8);
    c.fillStyle = '#b07840'; c.fillRect(x, y + s * 0.2, w, s * 0.7);
    c.fillStyle = '#8b5a2b'; c.fillRect(x, y + s * 0.2, w, s * 0.1);
    for (let i = 0; i < 6; i++) { c.fillStyle = i % 2 ? '#fff' : '#e53935'; c.fillRect(x - s * 0.1 + i * (w + s * 0.2) / 6, y - s * 1.05, (w + s * 0.2) / 6 + 1, s * 0.4); }
    for (let i = 0; i < 6; i++) { c.fillStyle = i % 2 ? '#fff' : '#e53935'; c.beginPath(); c.arc(x - s * 0.1 + (i + 0.5) * (w + s * 0.2) / 6, y - s * 0.65, (w + s * 0.2) / 12, 0, Math.PI); c.fill(); }
    const fl = ['tulipan', 'slnecnica', 'mak', 'nevadza', 'ruza'];
    for (let i = 0; i < 5; i++) { c.fillStyle = '#d9b77e'; c.fillRect(x + s * (0.25 + i * 0.52), y + s * 0.02, s * 0.4, s * 0.2); bloom(c, fl[i], x + s * (0.45 + i * 0.52), y - s * 0.05, s * 0.11, t); }
    c.fillStyle = '#fff8e7'; c.fillRect(x + s * 1.05, y + s * 0.4, s * 0.9, s * 0.35);
    c.fillStyle = '#5b3a1a'; c.font = 'bold ' + (s * 0.22 | 0) + 'px sans-serif'; c.textAlign = 'center'; c.fillText('TRH', x + s * 1.5, y + s * 0.65);
  }

  function well(c, x, y, s, se) {
    ell(c, x, y - s * 0.05, s * 0.45, s * 0.14, 0, 'rgba(0,0,0,0.2)');
    c.fillStyle = '#8a8580'; c.beginPath(); c.ellipse(x, y - s * 0.25, s * 0.4, s * 0.22, 0, 0, Math.PI); c.lineTo(x - s * 0.4, y - s * 0.45); c.ellipse(x, y - s * 0.45, s * 0.4, s * 0.2, 0, Math.PI, 0, true); c.fill();
    ell(c, x, y - s * 0.45, s * 0.33, s * 0.15, 0, '#245a80');
    c.fillStyle = '#6d4c2f'; c.fillRect(x - s * 0.4, y - s * 1.1, s * 0.07, s * 0.7); c.fillRect(x + s * 0.33, y - s * 1.1, s * 0.07, s * 0.7);
    c.fillStyle = se === 3 ? '#fff' : '#a0522d'; c.beginPath(); c.moveTo(x - s * 0.55, y - s * 1.0); c.lineTo(x, y - s * 1.35); c.lineTo(x + s * 0.55, y - s * 1.0); c.fill();
    c.strokeStyle = '#ddd'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y - s * 1.0); c.lineTo(x, y - s * 0.6); c.stroke();
    c.fillStyle = '#8b5a2b'; c.fillRect(x - s * 0.08, y - s * 0.62, s * 0.16, s * 0.12);
  }

  function cauldron(c, x, y, s, t) {
    ell(c, x, y - s * 0.05, s * 0.42, s * 0.12, 0, 'rgba(0,0,0,0.25)');
    for (let i = 0; i < 3; i++) circ(c, x + (i - 1) * s * 0.18, y - s * 0.12, s * 0.08 + Math.sin(t * 10 + i) * s * 0.01, ['#ff7043', '#ffca28', '#ff5722'][i]);
    ell(c, x, y - s * 0.38, s * 0.38, s * 0.3, 0, '#2b2b33');
    ell(c, x, y - s * 0.58, s * 0.36, s * 0.1, 0, '#3a3a44');
    ell(c, x, y - s * 0.58, s * 0.3, s * 0.07, 0, '#7cfc9a');
    for (let i = 0; i < 3; i++) {
      const p = (t * 0.6 + i / 3) % 1;
      c.globalAlpha = 1 - p; circ(c, x + Math.sin(t * 2 + i * 2) * s * 0.15, y - s * (0.6 + p * 0.6), s * (0.05 + p * 0.06), '#b9ffcf'); c.globalAlpha = 1;
    }
  }

  // ---- Ikony ----
  const iconCache = {};
  function icon(id) {
    if (iconCache[id]) return iconCache[id];
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    const t = 1;
    if (id === 'hoe') {
      c.strokeStyle = '#8b5a2b'; c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.moveTo(14, 54); c.lineTo(46, 14); c.stroke();
      c.fillStyle = '#9aa4ad'; c.beginPath(); c.moveTo(40, 10); c.lineTo(58, 16); c.lineTo(54, 26); c.lineTo(44, 20); c.fill();
    } else if (id === 'can') {
      c.fillStyle = '#4a9fd8'; c.beginPath(); c.roundRect ? c.roundRect(14, 24, 30, 28, 6) : c.rect(14, 24, 30, 28); c.fill();
      c.strokeStyle = '#4a9fd8'; c.lineWidth = 5; c.beginPath(); c.moveTo(42, 40); c.lineTo(58, 22); c.stroke();
      c.beginPath(); c.arc(29, 24, 11, Math.PI, 0); c.stroke();
      ell(c, 58, 21, 4, 3, 0.8, '#2f7fb8');
      for (let i = 0; i < 3; i++) circ(c, 56 + i * 2, 30 + i * 6, 2, '#9fd8ff');
    } else if (id === 'compost') {
      ell(c, 32, 40, 20, 18, 0, '#8b6a45'); ell(c, 32, 22, 12, 6, 0, '#6d4c2f');
      c.fillStyle = '#5b3a1a'; c.fillRect(26, 18, 12, 6);
      circ(c, 32, 42, 6, '#4caf50'); leaf(c, 32, 40, 12, -1.2, '#66bb6a');
    } else if (id === 'wilted') {
      c.strokeStyle = '#7a6a3a'; c.lineWidth = 3; c.lineCap = 'round';
      c.beginPath(); c.moveTo(26, 60); c.quadraticCurveTo(28, 26, 44, 30); c.stroke();
      c.beginPath(); c.moveTo(36, 60); c.quadraticCurveTo(38, 36, 50, 42); c.stroke();
      ell(c, 46, 34, 9, 6, 0.6, '#8d6a44'); ell(c, 51, 46, 7, 5, 0.9, '#a07a4a');
      leaf(c, 27, 48, 12, Math.PI + 0.9, '#8a7a45');
    } else if (id.startsWith('seed_')) {
      const k = id.slice(5);
      c.fillStyle = '#e9d3a0'; c.beginPath(); c.moveTo(14, 12); c.lineTo(50, 12); c.lineTo(52, 56); c.lineTo(12, 56); c.fill();
      c.strokeStyle = '#b8955a'; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#c9a46a'; c.fillRect(14, 12, 36, 7);
      if (D.SPECIES[k] && D.SPECIES[k].magic) { c.fillStyle = 'rgba(180,120,255,0.3)'; c.fillRect(12, 12, 40, 44); }
      bloom(c, k, 32, 36, 12, t, true);
    } else if (id.startsWith('fl_')) {
      const k = id.slice(3);
      c.strokeStyle = '#3f8f2f'; c.lineWidth = 3; c.beginPath(); c.moveTo(32, 60); c.lineTo(32, 30); c.stroke();
      leaf(c, 32, 50, 14, Math.PI + 0.5, '#56a83a'); leaf(c, 32, 46, 14, -0.5, '#56a83a');
      bloom(c, k, 32, 26, D.SPECIES[k].shape === 'bell' ? 13 : 17, t, true);
    } else if (id.startsWith('po_')) {
      const p = D.POTIONS[id.slice(3)];
      c.fillStyle = '#e0f0f8'; c.beginPath(); c.arc(32, 40, 18, 0, TAU); c.fill(); c.fillRect(26, 10, 12, 16);
      if (id === 'po_duha') {
        const g = c.createLinearGradient(14, 30, 50, 56);
        ['#ff5252', '#ffb74d', '#fff176', '#81c784', '#64b5f6', '#ba68c8'].forEach((col, i) => g.addColorStop(i / 5, col));
        c.fillStyle = g;
      } else c.fillStyle = p.color;
      c.beginPath(); c.arc(32, 40, 15, -0.2, Math.PI + 0.2); c.fill();
      c.fillStyle = '#8b5a2b'; c.fillRect(25, 6, 14, 7);
      ell(c, 25, 34, 3, 6, 0.4, 'rgba(255,255,255,0.7)');
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.beginPath(); c.arc(32, 40, 18, 0, TAU); c.stroke();
      if (id !== 'po_sliz') { circ(c, 46, 14, 3, '#fff8b0'); circ(c, 52, 24, 2, '#fff8b0'); }
    }
    iconCache[id] = cv.toDataURL();
    return iconCache[id];
  }

  // Bublina chatu nad hráčom: zalomí slová do max. 4 riadkov (šírka ~4,5 políčka), zvyšok skončí „…“.
  // (x, y) = účiarie menovky; bublina sa kreslí nad ňu so šípkou nadol.
  function wrapText(c, text, maxW, maxLines) {
    const lines = []; let cur = '';
    for (let w of text.split(/\s+/).filter(Boolean)) {
      const tryL = cur ? cur + ' ' + w : w;
      if (c.measureText(tryL).width <= maxW) { cur = tryL; continue; }
      if (cur) lines.push(cur);
      // príliš dlhé slovo – rozsekni po znakoch
      while (c.measureText(w).width > maxW) {
        let n = w.length - 1; while (n > 1 && c.measureText(w.slice(0, n)).width > maxW) n--;
        lines.push(w.slice(0, n)); w = w.slice(n);
      }
      cur = w;
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return lines;
    lines.length = maxLines;
    let l = lines[maxLines - 1];
    while (l && c.measureText(l + '…').width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = l.trimEnd() + '…';
    return lines;
  }
  function bubble(c, text, x, y, ts) {
    const fs = Math.max(11, ts * 0.26 | 0), lh = fs * 1.2, pad = ts * 0.14;
    c.font = fs + 'px system-ui, sans-serif'; c.textAlign = 'center';
    const lines = wrapText(c, text, Math.max(120, ts * 4.5), 4);
    const bw = Math.max(...lines.map(l => c.measureText(l).width)) + pad * 2, bh = lines.length * lh + pad * 1.4;
    const bottom = y - ts * 0.34, top = bottom - bh, left = x - bw / 2, tail = ts * 0.1;
    c.fillStyle = '#fff'; c.strokeStyle = '#0003'; c.lineWidth = Math.max(1, ts * 0.02);
    c.beginPath();
    if (c.roundRect) c.roundRect(left, top, bw, bh, Math.min(bh / 2, ts * 0.14)); else c.rect(left, top, bw, bh);
    c.moveTo(x - tail, bottom); c.lineTo(x, bottom + tail); c.lineTo(x + tail, bottom);
    c.fill(); c.stroke();
    c.fillStyle = '#222'; c.textBaseline = 'middle';
    lines.forEach((l, k) => c.fillText(l, x, top + pad * 0.7 + lh * (k + 0.5)));
    c.textBaseline = 'alphabetic';
  }

  return { bloom, plant, char, ground, soil, tree, shroom, boulder, hut, house, stall, well, cauldron, icon, hash, ell, circ, bubble, wrapText };
})();
window.Art = Art; // pre 3D modul (render3d.mjs)
