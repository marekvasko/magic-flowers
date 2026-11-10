// Procedurálna grafika – textúry zeme, kvety, postavičky a ikony (3D ich používa ako textúry a sprity).
import * as D from '../shared/data.ts';
import type { Ground, Look, SpeciesId } from '../shared/data.ts';
import type { SoilView } from '../shared/protocol.ts';
import { must } from '../shared/util.ts';

type C2 = CanvasRenderingContext2D;
// Voľby kreslenia rastliny (plant): zahynutá, v noci (papraď svieti), odkvitá, pripravená na zber (trblietka)
export interface PlantOpts { dead?: boolean; night?: boolean; wilting?: boolean; ready?: boolean }
// Voľby postavičky (char): plazí sa, tancuje, hrabe v tráve (dig = čas v s), babka, lampáš v ruke ('lit' = svieti), bez tieňa
export interface CharOpts {
  crawl?: boolean; dance?: boolean; dig?: number; babka?: boolean; lamp?: 'lit' | 'on' | boolean; noShadow?: boolean;
  crouch?: boolean | undefined; pose?: 'fall' | 'swim' | null | undefined; poseK?: number;   // chôdza po ľade (#157): čupí, leží na ľade, pláva; priebeh pózy 0 → 1
}
// Prechod na okraji plochy: strana, kam vedie, a ikona cieľovej plochy
export interface GateInfo { side: 'n' | 's' | 'w' | 'e'; icon: string }
export const Art = (() => {
  const TAU = Math.PI * 2;

  function ell(c: C2, x: number, y: number, rx: number, ry: number, rot: number | null, fill: string | null, stroke?: string | null): void {
    c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, TAU);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = Math.max(0.6, rx * 0.12); c.stroke(); }
  }
  function circ(c: C2, x: number, y: number, r: number, fill: string | CanvasGradient): void { c.beginPath(); c.arc(x, y, Math.max(0.1, r), 0, TAU); c.fillStyle = fill; c.fill(); }
  function hash(x: number, y: number, k?: number): number { let h = (x * 374761393 + y * 668265263 + (k || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function shade(hex: string, f: number): string {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }
  const OUT = 'rgba(40,30,20,0.35)';

  function petals(c: C2, x: number, y: number, n: number, len: number, wid: number, color: string, rot: number, stroke: boolean): void {
    for (let i = 0; i < n; i++) {
      const a = (rot || 0) + i * TAU / n;
      ell(c, x + Math.sin(a) * len * 0.55, y - Math.cos(a) * len * 0.55, wid, len * 0.55, a, color, stroke ? OUT : null);
    }
  }

  // Kvet (rozkvitnutá hlavička) so stredom v x,y a polomerom r
  function bloom(c: C2, key: SpeciesId, x: number, y: number, r: number, t: number, night: boolean | undefined): void {
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

  function leaf(c: C2, x: number, y: number, len: number, ang: number, col: string): void { ell(c, x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, len * 0.5, len * 0.2, ang, col); }

  // Rastlina na políčku – x je stred, y spodok, s veľkosť políčka
  function plant(c: C2, key: SpeciesId, stage: number, x: number, y: number, s: number, t: number, o: PlantOpts = {}): void {
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
  // o.crawl: plazí sa (pokrčené kolená, predklon)
  // o.dig: čas v s, keď hráč hrabe v tráve – je prikrčený a rukami striedavo hrabe pred sebou
  function lantern(c: C2, x: number, y: number, h: number, lit: boolean): void {
    const w = h * 0.5;
    c.strokeStyle = '#3a3a3a'; c.lineWidth = Math.max(1, h * 0.05);
    c.beginPath(); c.arc(x, y + h * 0.16, h * 0.14, Math.PI, TAU); c.stroke(); // ucho
    c.fillStyle = '#4a4a4a';
    c.beginPath(); c.moveTo(x - w * 0.55, y + h * 0.3); c.lineTo(x, y + h * 0.14); c.lineTo(x + w * 0.55, y + h * 0.3); c.fill(); // strieška
    c.fillStyle = lit ? '#ffe28a' : '#cfd9dc'; c.fillRect(x - w * 0.4, y + h * 0.3, w * 0.8, h * 0.5); // sklo
    if (lit) { ell(c, x, y + h * 0.58, w * 0.16, h * 0.13, 0, '#ff9a2a'); ell(c, x, y + h * 0.6, w * 0.08, h * 0.07, 0, '#fff6c8'); }
    c.fillStyle = '#3a3a3a';
    c.fillRect(x - w * 0.45, y + h * 0.28, w * 0.9, h * 0.05); c.fillRect(x - w * 0.5, y + h * 0.78, w, h * 0.1); // obruče
    c.fillRect(x - w * 0.04, y + h * 0.3, w * 0.08, h * 0.5); // priečka
  }

  // Pózy z chôdze po ľade (#157): leží na chrbte po pošmyknutí (postavička otočená naležato, nad ňou hviezdičky),
  // pláva (vidno len hlavu a plecia nad hladinou, okolo vlnky a ruky, ktoré pádlujú)
  function posed(c: C2, x: number, y: number, s: number, look: Partial<Look> | null, dir: number, phase: number, o: CharOpts): void {
    const rest: CharOpts = { ...o, pose: null, crouch: false, crawl: false, dance: false, dig: 0, lamp: false };
    const e = 1 - (1 - Math.max(0, Math.min(1, o.poseK ?? 1))) ** 2; // priebeh pádu / ponorenia (zrýchľuje sa)
    if (o.pose === 'fall') { // padá na chrbát okolo chodidiel, naležato je o kúsok menší, nech sa zmestí do spritu
      const k = 1 - 0.22 * e, side = dir === 1 || dir === 4 || dir === 6 ? -1 : 1;
      if (!o.noShadow) ell(c, x, y, s * (0.24 + 0.16 * e), s * 0.08, 0, 'rgba(0,0,0,0.25)');
      c.save();
      c.translate(x - side * s * 0.37 * e, y - s * 0.13 * e);
      c.rotate(side * Math.PI / 2 * e);
      char(c, 0, 0, s * k, look, e > 0.5 ? 0 : dir, 0, { ...rest, noShadow: true });
      c.restore();
      if (e < 1) return;
      const tw = phase * 0.7; // hviezdičky krúžia nad hlavou
      for (let i = 0; i < 3; i++) {
        const a = tw + i * TAU / 3;
        circ(c, x + side * s * 0.3 + Math.cos(a) * s * 0.09, y - s * 0.34 + Math.sin(a) * s * 0.035, s * 0.028, i ? '#fff3a0' : '#ffd23f');
      }
      return;
    }
    const wl = y - s * 0.05 * e, dip = s * 0.42 * e; // hladina a o koľko je postavička ponorená (plynulo sa ponára)
    c.save();
    c.beginPath(); c.rect(x - s, y - s * 1.6, s * 2, wl - (y - s * 1.6)); c.clip();
    char(c, x, y + dip, s, look, dir, 0, { ...rest, noShadow: true });
    c.restore();
    const bob = Math.sin(phase * 1.5) * s * 0.02 * e;
    ell(c, x, wl + bob, s * (0.16 + 0.18 * e), s * (0.04 + 0.04 * e), 0, 'rgba(168,214,240,0.9)', '#ffffff');
    ell(c, x, wl + bob, s * 0.2 * e, s * 0.045 * e, 0, 'rgba(120,180,220,0.9)');
    if (e < 0.7) return;
    const skin = '#f2c9a0', pd = Math.sin(phase * 3) * s * 0.03;
    circ(c, x - s * 0.27, wl - s * 0.02 + pd, s * 0.055, skin);
    circ(c, x + s * 0.27, wl - s * 0.02 - pd, s * 0.055, skin);
  }

  function char(c: C2, x: number, y: number, s: number, look: Partial<Look> | null, dir: number, phase: number, o: CharOpts = {}): void {
    if (o.pose === 'fall' || o.pose === 'swim') { posed(c, x, y, s, look, dir, phase, o); return; }
    look = look || {};
    const skin = '#f2c9a0';
    let d = dir;
    if (o.dig) { o = Object.assign({}, o, { crawl: true }); phase = 0; }
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
    const kn = o.crawl ? s * 0.08 : o.crouch ? s * 0.14 : 0; // čupnutie (#157): ešte kratšie nohy, telo nižšie
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
    const squat = !!o.crouch && !o.crawl;
    if (squat && !o.babka) { // čupí: kolená do strán (pri pohľade z boku dopredu)
      c.fillStyle = '#3b4a6b';
      if (d === 1 || d === 2) ell(c, x + (d === 1 ? -1 : 1) * s * 0.13, yb - s * 0.14, s * 0.11, s * 0.07, 0, '#3b4a6b');
      else { ell(c, x - s * 0.15, yb - s * 0.13, s * 0.09, s * 0.07, 0, '#3b4a6b'); ell(c, x + s * 0.15, yb - s * 0.13, s * 0.09, s * 0.07, 0, '#3b4a6b'); }
    }
    if (squat) { c.save(); c.translate(0, kn); } // čupí: trup, ruky a hlava o kolená nižšie
    if (o.crawl) { const hx = x, hyp = yb - s * 0.2; c.translate(hx, hyp + kn + (fx ? 0 : s * 0.07)); c.rotate(fx * (d === 0 || d === 3 ? 0.3 : 0.45)); c.translate(-hx, -hyp); }
    // telo
    const shirt = look.shirt || '#4a90d9';
    c.fillStyle = shirt;
    c.beginPath();
    if (o.babka) { c.moveTo(x - s * 0.26, yb - s * 0.02); c.lineTo(x - s * 0.16, yb - s * 0.55); c.lineTo(x + s * 0.16, yb - s * 0.55); c.lineTo(x + s * 0.26, yb - s * 0.02); }
    else c.roundRect(x - s * 0.19, yb - s * 0.56, s * 0.38, s * 0.38, s * 0.1);
    c.fill();
    if (o.babka) { c.fillStyle = '#f5f0e0'; c.fillRect(x - s * 0.12, yb - s * 0.4, s * 0.24, s * 0.3); c.fillStyle = '#e57373'; for (let i = 0; i < 3; i++) circ(c, x - s * 0.06 + i * s * 0.06, yb - s * 0.2, s * 0.02, '#e57373'); }
    else { c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(x - s * 0.19, yb - s * 0.26, s * 0.38, s * 0.06); }
    // ruky
    const sw = o.dance ? Math.sin(phase * 3) * s * 0.15 : step;
    if (o.dig) { // obe ruky dole pred telom, jemne a striedavo hrabú
      const k1 = Math.sin(o.dig * 8), k2 = Math.sin(o.dig * 8 + Math.PI);
      const reach = (k: number): number => fx ? fx * s * (0.18 + 0.04 * k) : 0;
      circ(c, x + (fx ? reach(k1) - fx * s * 0.06 : -s * 0.15 + k1 * s * 0.015), yb - s * 0.2 + k1 * s * 0.03, s * 0.065, skin);
      circ(c, x + (fx ? reach(k2) : s * 0.15 - k2 * s * 0.015), yb - s * 0.2 + k2 * s * 0.03, s * 0.065, skin);
    } else {
      circ(c, x - s * 0.22, yb - s * 0.36 + (d === 1 || d === 2 ? 0 : sw), s * 0.065, skin);
      circ(c, x + s * 0.22, yb - s * 0.36 - (d === 1 || d === 2 ? 0 : sw), s * 0.065, skin);
      // lampáš visí z pravej ruky (pri pohľade doľava ho zakryje telo – kreslíme ho pred telo k ľavej ruke)
      if (o.lamp) {
        const lx = d === 1 ? x - s * 0.22 : x + s * 0.22, ly = yb - s * 0.36 + (d === 1 ? sw : d === 2 ? 0 : -sw);
        lantern(c, lx, ly, s * 0.3, o.lamp === 'lit');
      }
    }
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
    if (squat) c.restore();
    if (o.crawl) c.restore();
  }

  // ---- Prostredie ----
  type Seasonal = readonly [string, string, string, string];
  const GRASS: Seasonal = ['#86c95b', '#74b84a', '#aab24e', '#e7edf0'];
  const FOREST: Seasonal = ['#5f9a46', '#4f8a3c', '#8a8a3f', '#cfd8dc'];
  const ALP: Seasonal = ['#8cc76a', '#7fbb5c', '#b0a95a', '#eef3f6'];
  const MEADOW: Seasonal = ['#8ccf5e', '#86c255', '#b5b553', '#e9eff2'];
  const MOSS: Seasonal = ['#4f7a3a', '#466f35', '#6b6634', '#cdd6d9']; // Les divov: tmavý mach pod stromami (v zime len poprašok snehu)
  const GLADE: Seasonal = ['#7cb557', '#6ea64b', '#a39d4a', '#e3eaee']; // čistina v Lese divov
  const bySeason = (list: Seasonal, se: number): string => list[se & 3] ?? list[0];

  // gate = { side: 'n'|'s'|'w'|'e', icon } – na ktorú stranu prechod vedie a ikona cieľovej plochy (inak podľa riadku)
  function ground(c: C2, g: Ground, x: number, y: number, s: number, se: number, t: number, tx: number, ty: number, gate: GateInfo | null): void {
    const h = hash(tx, ty);
    let base: string;
    switch (g) {
      case 'path': case 'majster': base = se === 3 ? '#e0dccf' : '#d9b77e'; break;
      case 'sand': base = se === 3 ? '#efece0' : '#ecd9a0'; break;
      case 'rock': case 'boulder': base = se === 3 ? '#d8dcde' : '#a9a39a'; break;
      case 'water': base = se === 3 ? '#a9d4ec' : '#4aa3df'; break;
      case 'forest': case 'ring': case 'shroom': case 'tree': case 'fern': case 'bush': base = bySeason(FOREST, se); break;
      case 'meadow': base = bySeason(MEADOW, se); break;
      case 'moss': case 'fungi': case 'giant': case 'trunk': case 'log': base = bySeason(MOSS, se); break;
      case 'roots': base = se === 3 ? '#d6d2c4' : '#b99a68'; break; // korene cez chodník
      case 'glade': base = bySeason(GLADE, se); break;
      case 'alp': case 'spruce': base = bySeason(ALP, se); break;
      case 'scree': base = se === 3 ? '#e3e7ea' : '#b7b1a6'; break;
      case 'snow': base = se === 3 ? '#f7fbfd' : '#eaf1f5'; break;
      case 'glacier': base = '#a9d4ec'; break; // ako ľad na jazierku v zime
      case 'cliff': base = se === 3 ? '#cfd4d7' : '#7d776f'; break;
      case 'gate': base = se === 3 ? '#e0dccf' : '#d9b77e'; break;
      case 'lot': base = se === 3 ? '#e4e1d8' : '#cfc6b4'; break;
      default: base = bySeason(GRASS, se);
    }
    c.fillStyle = base; c.fillRect(x, y, s + 1, s + 1);
    if (g === 'alp' || g === 'spruce') {
      if (se !== 3) {
        c.strokeStyle = 'rgba(30,80,20,0.3)'; c.lineWidth = Math.max(1, s * 0.025);
        for (let i = 0; i < 2; i++) { const gx = x + hash(tx, ty, i) * s, gy = y + hash(tx, ty, i + 9) * s; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx - s * 0.03, gy - s * 0.07); c.stroke(); }
        if (h > 0.8) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.045, h > 0.92 ? '#f4f3e8' : '#3f5fd8'); // plesnivec a horec
      } else if (h > 0.7) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.05, '#fff');
      return;
    }
    if (g === 'scree' || g === 'cliff') {
      for (let i = 0; i < 4; i++) ell(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.06, s * 0.04, hash(tx, ty, i + 2) * 3, se === 3 ? 'rgba(150,160,170,0.35)' : 'rgba(80,75,70,0.35)');
      return;
    }
    if (g === 'snow') {
      for (let i = 0; i < 3; i++) circ(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.025, 'rgba(150,190,220,0.45)');
      return;
    }
    if (g === 'glacier') { // rovnaké biele šmuhy ako na zamrznutom jazierku, len nehybné
      c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = Math.max(1, s * 0.03);
      for (let i = 0; i < 2; i++) {
        const wy = y + s * (0.3 + i * 0.4), off = (hash(tx, ty, i + 20) - 0.5) * s * 0.2;
        c.beginPath(); c.moveTo(x + s * 0.2 + off, wy); c.quadraticCurveTo(x + s * 0.4 + off, wy - s * 0.08, x + s * 0.6 + off, wy); c.stroke();
      }
      return;
    }
    if (g === 'gate') { // chodník na okraji mapy so šípkami (smerom von) a smerovníkom s ikonou cieľa
      const side = gate ? gate.side : ty === 0 ? 'n' : 's', icon = gate ? gate.icon : ty === 0 ? '⛰️' : '🏡';
      const vert = side === 'n' || side === 's', sg = side === 'n' || side === 'w' ? -1 : 1;
      c.strokeStyle = 'rgba(110,80,40,0.55)'; c.lineWidth = Math.max(1, s * 0.06);
      for (let i = 0; i < 2; i++) {
        const k = s * (0.35 + i * 0.3), d = sg * s * 0.1;
        c.beginPath();
        if (vert) { c.moveTo(x + s * 0.3, y + k - d); c.lineTo(x + s * 0.5, y + k + d); c.lineTo(x + s * 0.7, y + k - d); }
        else { c.moveTo(x + k - d, y + s * 0.3); c.lineTo(x + k + d, y + s * 0.5); c.lineTo(x + k - d, y + s * 0.7); }
        c.stroke();
      }
      if ((vert ? tx : ty) % 2 === 0) {
        c.fillStyle = '#6d4c2f'; c.fillRect(x + s * 0.08, y + s * 0.15, s * 0.06, s * 0.7);
        c.fillStyle = '#c9a77a'; c.fillRect(x - s * 0.02, y + s * 0.12, s * 0.3, s * 0.2);
        c.font = (s * 0.17 | 0) + 'px serif'; c.textAlign = 'center'; c.fillStyle = '#000'; c.fillText(icon, x + s * 0.13, y + s * 0.28);
      }
      return;
    }
    if (g === 'lot') { // stavebný pozemok: štrk a kolíky v rohoch
      for (let i = 0; i < 5; i++) circ(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.03, 'rgba(110,100,85,0.4)');
      const DL = D.DIELNA.lot, L = tx >= DL.x0 && tx <= DL.x1 && ty >= DL.y0 && ty <= DL.y1 ? DL : { x0: 0, y0: 0 }; // kolíky v rohoch pozemku (ľadovne či Dielne)
      c.fillStyle = '#8b5a2b'; c.fillRect(x + s * ((tx - L.x0) % 2 ? 0.82 : 0.08), y + s * ((ty - L.y0) % 2 ? 0.8 : 0.08), s * 0.1, s * 0.12);
      return;
    }
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
    if (g === 'meadow') { // lúka: hustejšia tráva a veľa poľných kvetov (v zime sneh)
      if (se === 3) { if (h > 0.6) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.05, '#fff'); return; }
      c.strokeStyle = 'rgba(30,90,20,0.35)'; c.lineWidth = Math.max(1, s * 0.025);
      for (let i = 0; i < 5; i++) {
        const gx = x + hash(tx, ty, i) * s, gy = y + hash(tx, ty, i + 9) * s;
        c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx - s * 0.03, gy - s * 0.1); c.moveTo(gx, gy); c.lineTo(gx + s * 0.04, gy - s * 0.09); c.stroke();
      }
      // kvety podľa obdobia: jar biele a žlté, leto maky, nevädze a margaréty, jeseň fialové astry
      const cols = must([['#fff', '#ffe14d', '#fff', '#b39ddb'], ['#e8261f', '#3f6fd8', '#fff', '#ffe14d'], ['#8a63d2', '#d58cd6', '#ffcc33', '#fff']][se]);
      const n = h > 0.5 ? 3 : h > 0.2 ? 2 : 1;
      for (let i = 0; i < n; i++) circ(c, x + (0.12 + 0.76 * hash(tx, ty, 30 + i)) * s, y + (0.12 + 0.76 * hash(tx, ty, 40 + i)) * s, s * 0.045, must(cols[(hash(tx, ty, 50 + i) * 4) | 0]));
      if (se === 2 && h > 0.7) ell(c, x + hash(tx, ty, 7) * s, y + hash(tx, ty, 8) * s, s * 0.06, s * 0.035, h * 6, '#d9822b');
      return;
    }
    if (g === 'moss' || g === 'giant' || g === 'trunk' || g === 'log' || g === 'fungi') { // Les divov: mach, lístie, huby
      if (se === 3) { for (let i = 0; i < 3; i++) circ(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.06, 'rgba(255,255,255,0.55)'); }
      else {
        for (let i = 0; i < 4; i++) ell(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.12, s * 0.08, hash(tx, ty, i + 2) * 3, hash(tx, ty, i + 11) < 0.5 ? 'rgba(20,50,15,0.35)' : 'rgba(140,170,70,0.25)');
        if (h > 0.55) ell(c, x + hash(tx, ty, 7) * s, y + hash(tx, ty, 8) * s, s * 0.07, s * 0.04, h * 6, se === 2 ? '#b0662a' : '#6b5a33'); // spadnutý list
      }
      if (g === 'fungi') { // huby: hnedé a červené klobúčiky (muchotrávka s bodkami)
        const n = 2 + ((h * 3) | 0);
        for (let i = 0; i < n; i++) {
          const mx = x + (0.15 + 0.7 * hash(tx, ty, 80 + i)) * s, my = y + (0.2 + 0.65 * hash(tx, ty, 90 + i)) * s, r = s * (0.06 + 0.04 * hash(tx, ty, 95 + i));
          c.fillStyle = '#efe6d0'; c.fillRect(mx - r * 0.25, my, r * 0.5, r * 0.9);
          const red = hash(tx, ty, 99 + i) < 0.4;
          ell(c, mx, my, r, r * 0.6, 0, red ? '#c62828' : '#8a5a2e');
          if (red) { circ(c, mx - r * 0.35, my - r * 0.15, r * 0.14, '#fff'); circ(c, mx + r * 0.3, my - r * 0.2, r * 0.12, '#fff'); }
        }
      }
      return;
    }
    if (g === 'roots') { // korene, ktoré sa plazia cez chodník
      for (let i = 0; i < 3; i++) circ(c, x + hash(tx, ty, i) * s, y + hash(tx, ty, i + 5) * s, s * 0.03, 'rgba(90,60,30,0.3)');
      c.strokeStyle = se === 3 ? '#7d6a55' : '#5a3d24'; c.lineCap = 'round';
      for (let i = 0; i < 2; i++) {
        const y0 = y + s * (0.2 + 0.6 * hash(tx, ty, 20 + i)), y1 = y + s * (0.2 + 0.6 * hash(tx, ty, 22 + i));
        c.lineWidth = Math.max(1.5, s * (0.07 - i * 0.025));
        c.beginPath(); c.moveTo(x - 1, y0); c.bezierCurveTo(x + s * 0.35, y0 - s * 0.15, x + s * 0.6, y1 + s * 0.15, x + s + 1, y1); c.stroke();
      }
      c.lineCap = 'butt';
      return;
    }
    if (g === 'glade') { // čistina: krátka lesná tráva a sem-tam kvietok (sem preniká slnko)
      if (se === 3) { if (h > 0.6) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.05, '#fff'); return; }
      c.strokeStyle = 'rgba(30,80,20,0.35)'; c.lineWidth = Math.max(1, s * 0.025);
      for (let i = 0; i < 4; i++) {
        const gx = x + hash(tx, ty, i) * s, gy = y + hash(tx, ty, i + 9) * s;
        c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx - s * 0.03, gy - s * 0.09); c.moveTo(gx, gy); c.lineTo(gx + s * 0.04, gy - s * 0.08); c.stroke();
      }
      if (h > 0.75) circ(c, x + hash(tx, ty, 31) * s, y + hash(tx, ty, 41) * s, s * 0.04, se === 2 ? '#b39ddb' : '#fff'); // veternica, na jeseň astra
      return;
    }
    if (g === 'fern' && se !== 3) { // papraď: niekoľko zelených vejárov (na jeseň hrdzavé)
      c.strokeStyle = se === 2 ? '#a0612a' : se === 0 ? '#6fae3c' : '#3f7f2e'; c.lineWidth = Math.max(1, s * 0.035);
      const cx = x + s * (0.35 + 0.3 * hash(tx, ty, 60)), cy = y + s * (0.55 + 0.25 * hash(tx, ty, 61));
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.55 + (hash(tx, ty, 62 + i) - 0.5) * 0.3, L = s * (0.28 + 0.12 * hash(tx, ty, 70 + i));
        const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L;
        c.beginPath(); c.moveTo(cx, cy); c.quadraticCurveTo(cx + Math.cos(a) * L * 0.6, cy + Math.sin(a) * L * 0.4, ex, ey); c.stroke();
        for (let k = 1; k < 4; k++) { // lístky po oboch stranách
          const px = cx + (ex - cx) * k / 4, py = cy + (ey - cy) * k / 4, ln = s * 0.07 * (1 - k / 5);
          c.beginPath(); c.moveTo(px - Math.sin(a) * ln, py + Math.cos(a) * ln); c.lineTo(px + Math.sin(a) * ln, py - Math.cos(a) * ln); c.stroke();
        }
      }
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
        circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.04, must(cols[(h * 40 | 0) % 4]));
      }
      if (se === 2 && h > 0.6) ell(c, x + hash(tx, ty, 7) * s, y + hash(tx, ty, 8) * s, s * 0.06, s * 0.035, h * 6, '#d9822b');
    } else if (h > 0.7) circ(c, x + hash(tx, ty, 3) * s, y + hash(tx, ty, 4) * s, s * 0.05, '#fff');
    if (g === 'ring') { c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x, y, s, s); }
  }

  function soil(c: C2, so: Pick<SoilView, 'k' | 'w' | 'r'>, x: number, y: number, s: number, se: number): void {
    const m = s * 0.06;
    let col = so.k === 'sand' ? '#c9a26a' : so.k === 'rock' ? '#8d7b6a' : '#8b5a2b';
    if (so.w) col = shade(col, -0.35);
    c.fillStyle = col;
    c.beginPath(); c.roundRect(x + m, y + m, s - 2 * m, s - 2 * m, s * 0.12); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.15)'; c.lineWidth = Math.max(1, s * 0.03);
    for (let i = 1; i < 3; i++) { c.beginPath(); c.moveTo(x + s * 0.18, y + s * i / 3); c.lineTo(x + s * 0.82, y + s * i / 3); c.stroke(); }
    if (so.r) for (let i = 0; i < 5; i++) circ(c, x + s * (0.2 + 0.6 * hash(i, x | 0)), y + s * (0.2 + 0.6 * hash(y | 0, i)), s * 0.035, '#3a2410');
    if (so.w) { c.fillStyle = 'rgba(120,180,255,0.18)'; c.fillRect(x + m, y + m, s - 2 * m, s - 2 * m); }
    if (se === 3 && !so.w) { c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x + m, y + m, s - 2 * m, s * 0.25); }
  }

  function shroom(c: C2, x: number, y: number, s: number, night: boolean, t: number): void {
    if (night) {
      const g = c.createRadialGradient(x, y - s * 0.15, 0, x, y - s * 0.15, s * 0.5);
      g.addColorStop(0, 'rgba(180,255,220,' + (0.35 + 0.15 * Math.sin(t * 2 + x)) + ')'); g.addColorStop(1, 'rgba(180,255,220,0)');
      c.fillStyle = g; c.fillRect(x - s * 0.5, y - s * 0.65, s, s);
    }
    c.fillStyle = '#f5f0e0'; c.fillRect(x - s * 0.05, y - s * 0.22, s * 0.1, s * 0.2);
    c.beginPath(); c.arc(x, y - s * 0.2, s * 0.17, Math.PI, TAU); c.fillStyle = night ? '#ff6b6b' : '#d32f2f'; c.fill();
    circ(c, x - s * 0.07, y - s * 0.27, s * 0.03, '#fff'); circ(c, x + s * 0.06, y - s * 0.3, s * 0.025, '#fff'); circ(c, x + s * 0.01, y - s * 0.23, s * 0.02, '#fff');
  }

  // ---- Ikony ----
  const iconCache = new Map<string, string>();
  function icon(id: string): string {
    const hit = iconCache.get(id);
    if (hit) return hit;
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = must(cv.getContext('2d') ?? undefined);
    const t = 1;
    if (id === 'hoe') {
      c.strokeStyle = '#8b5a2b'; c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.moveTo(14, 54); c.lineTo(46, 14); c.stroke();
      c.fillStyle = '#9aa4ad'; c.beginPath(); c.moveTo(40, 10); c.lineTo(58, 16); c.lineTo(54, 26); c.lineTo(44, 20); c.fill();
    } else if (id === 'can') {
      c.fillStyle = '#4a9fd8'; c.beginPath(); c.roundRect(14, 24, 30, 28, 6); c.fill();
      c.strokeStyle = '#4a9fd8'; c.lineWidth = 5; c.beginPath(); c.moveTo(42, 40); c.lineTo(58, 22); c.stroke();
      c.beginPath(); c.arc(29, 24, 11, Math.PI, 0); c.stroke();
      ell(c, 58, 21, 4, 3, 0.8, '#2f7fb8');
      for (let i = 0; i < 3; i++) circ(c, 56 + i * 2, 30 + i * 6, 2, '#9fd8ff');
    } else if (id === 'pick') {
      c.strokeStyle = '#8b5a2b'; c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.moveTo(16, 56); c.lineTo(42, 18); c.stroke();
      c.strokeStyle = '#8e99a3'; c.lineWidth = 7; c.beginPath(); c.moveTo(18, 14); c.quadraticCurveTo(42, 4, 60, 30); c.stroke();
      c.strokeStyle = '#c6cfd6'; c.lineWidth = 2; c.beginPath(); c.moveTo(22, 11); c.quadraticCurveTo(42, 3, 56, 24); c.stroke();
    } else if (id === 'lamp') {
      lantern(c, 32, 8, 50, true);
    } else if (id === 'ice') {
      c.fillStyle = '#bfe6fb'; c.beginPath(); c.moveTo(32, 8); c.lineTo(56, 20); c.lineTo(32, 32); c.lineTo(8, 20); c.fill();
      c.fillStyle = '#8ccbec'; c.beginPath(); c.moveTo(8, 20); c.lineTo(32, 32); c.lineTo(32, 58); c.lineTo(8, 46); c.fill();
      c.fillStyle = '#6fb6de'; c.beginPath(); c.moveTo(56, 20); c.lineTo(32, 32); c.lineTo(32, 58); c.lineTo(56, 46); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.moveTo(20, 18); c.lineTo(30, 13); c.lineTo(34, 15); c.lineTo(24, 20); c.fill();
      c.fillRect(13, 28, 3, 12);
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
    } else if (id === 'silk') { // klbko pavúčieho hodvábu
      web(c, 64, 64, 3, 7, 0.55);
      ell(c, 32, 40, 15, 13, 0, '#e9eef2'); ell(c, 28, 36, 8, 6, -0.4, '#ffffff');
      c.strokeStyle = '#b7c3cc'; c.lineWidth = 1.5;
      for (let i = 0; i < 5; i++) { c.beginPath(); c.ellipse(32, 40, 15 - i * 2, 6 + i * 1.5, 0.6 + i * 0.5, 0, TAU); c.stroke(); }
    } else if (id === 'blanket') { // hodvábna prikrývka: zložená, so strieborným leskom a prešívaním
      const fold = (y: number, h: number, col: string): void => { c.fillStyle = col; c.beginPath(); c.moveTo(10, y); c.quadraticCurveTo(32, y - 4, 54, y); c.lineTo(54, y + h); c.quadraticCurveTo(32, y + h - 4, 10, y + h); c.fill(); };
      fold(40, 16, '#c9ced6'); fold(28, 14, '#dfe4ea'); fold(16, 14, '#f4f6f9');
      c.strokeStyle = '#9aa5b1'; c.lineWidth = 1.2; c.setLineDash([3, 3]);
      for (const y of [23, 35, 48]) { c.beginPath(); c.moveTo(14, y); c.quadraticCurveTo(32, y - 3, 50, y); c.stroke(); }
      c.setLineDash([]);
      c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2; c.beginPath(); c.moveTo(18, 19); c.quadraticCurveTo(26, 17, 34, 18); c.stroke();
      c.fillStyle = '#b48a5a'; c.fillRect(30, 14, 4, 44); // stužka
    } else if (/^wild_[0-3]$/.test(id)) { // divé semienko: hrsť semien v tráve s otáznikom
      for (let i = 0; i < 7; i++) leaf(c, 10 + i * 7, 58, 14 + (i % 3) * 4, -Math.PI / 2 + (i - 3) * 0.12, i % 2 ? '#7cb342' : '#558b2f');
      ell(c, 30, 40, 7, 4, 0.5, '#8d6e3f'); ell(c, 38, 44, 6, 3.5, -0.4, '#a1824a'); ell(c, 26, 47, 5, 3, 0.2, '#7a5a30');
      c.font = 'bold 22px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineWidth = 4; c.strokeStyle = '#fff'; c.strokeText('?', 46, 18); c.fillStyle = '#5b3a1a'; c.fillText('?', 46, 18);
      c.font = '14px serif'; c.fillText(D.SEASON_ICONS[+id.slice(5)] ?? '', 16, 14);
    } else if (id.startsWith('seed_') && D.isSpeciesId(id.slice(5))) {
      const k = id.slice(5) as SpeciesId; // overené riadkom vyššie (isSpeciesId)
      c.fillStyle = '#e9d3a0'; c.beginPath(); c.moveTo(14, 12); c.lineTo(50, 12); c.lineTo(52, 56); c.lineTo(12, 56); c.fill();
      c.strokeStyle = '#b8955a'; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#c9a46a'; c.fillRect(14, 12, 36, 7);
      if (D.SPECIES[k].magic) { c.fillStyle = 'rgba(180,120,255,0.3)'; c.fillRect(12, 12, 40, 44); }
      bloom(c, k, 32, 36, 12, t, true);
    } else if (id.startsWith('fl_') && D.isSpeciesId(id.slice(3))) {
      const k = id.slice(3) as SpeciesId; // overené riadkom vyššie (isSpeciesId)
      c.strokeStyle = '#3f8f2f'; c.lineWidth = 3; c.beginPath(); c.moveTo(32, 60); c.lineTo(32, 30); c.stroke();
      leaf(c, 32, 50, 14, Math.PI + 0.5, '#56a83a'); leaf(c, 32, 46, 14, -0.5, '#56a83a');
      bloom(c, k, 32, 26, D.SPECIES[k].shape === 'bell' ? 13 : 17, t, true);
    } else if (id.startsWith('po_') && D.isPotionId(id.slice(3))) {
      const p = D.POTIONS[id.slice(3) as D.PotionId]; // overené riadkom vyššie (isPotionId)
      c.fillStyle = '#e0f0f8'; c.beginPath(); c.arc(32, 40, 18, 0, TAU); c.fill(); c.fillRect(26, 10, 12, 16);
      if (id === 'po_duha') {
        const g = c.createLinearGradient(14, 30, 50, 56);
        ['#ff5252', '#ffb74d', '#fff176', '#81c784', '#64b5f6', '#ba68c8'].forEach((col, i) => { g.addColorStop(i / 5, col); });
        c.fillStyle = g;
      } else c.fillStyle = p.color;
      c.beginPath(); c.arc(32, 40, 15, -0.2, Math.PI + 0.2); c.fill();
      c.fillStyle = '#8b5a2b'; c.fillRect(25, 6, 14, 7);
      ell(c, 25, 34, 3, 6, 0.4, 'rgba(255,255,255,0.7)');
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2; c.beginPath(); c.arc(32, 40, 18, 0, TAU); c.stroke();
      if (id !== 'po_sliz') { circ(c, 46, 14, 3, '#fff8b0'); circ(c, 52, 24, 2, '#fff8b0'); }
    }
    const url = cv.toDataURL();
    iconCache.set(id, url);
    return url;
  }

  // ---- Pavúky a pavučiny (#57) ----
  // Pavučina do obdĺžnika w × h: lúče z mierne posunutého stredu a špirála; silk 1–3 = koľko z nej ešte ostalo
  // (vyťahaná je rozpadnutá). k = semienko tvaru, a = krytie.
  function web(c: C2, w: number, h: number, silk: number, k: number, a?: number): void {
    const cx = w * (0.45 + hash(k, 1) * 0.1), cy = h * (0.42 + hash(k, 2) * 0.1);
    const rays = 12, R = Math.hypot(w, h) * 0.6;
    c.save();
    c.beginPath(); c.rect(1, 1, w - 2, h - 2); c.clip();
    c.strokeStyle = `rgba(236,243,248,${a == null ? 0.95 : a})`; c.lineWidth = Math.max(1.5, Math.min(w, h) / 50);
    const keep = (i: number): boolean => silk >= 3 || hash(k, i + 10) < (silk === 2 ? 0.75 : 0.45);
    for (let i = 0; i < rays; i++) {
      if (!keep(i)) continue;
      const ang = i / rays * TAU + hash(k, i) * 0.2;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); c.stroke();
    }
    const turns = silk >= 3 ? 9 : silk === 2 ? 6 : 3;
    c.beginPath();
    for (let t = 0; t < turns * rays; t++) {
      const i = t % rays, ang = i / rays * TAU + hash(k, i) * 0.2, rr = (t / rays + 0.6) / (turns + 0.6) * Math.min(w, h) * 0.62;
      const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
      if (!keep(i) || !keep((i + rays - 1) % rays)) { c.moveTo(px, py); continue; }
      if (t) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.stroke();
    c.strokeStyle = 'rgba(232,240,246,0.7)'; c.strokeRect(1, 1, w - 2, h - 2); // nosné vlákna k oporám
    c.restore();
  }
  // Postavička zabalená do pavučiny (#57; postavička nakreslená na (x, y) veľkosťou s ako v char): hodvábny závoj len na
  // jej pixeloch, vlákna ovinuté okolo tela a pri zodieraní strapky. left = koľko pavučiny ešte zostáva (1 → 0): vlákna
  // miznú v náhodnom poradí (podľa k), tie, ktoré práve odchádzajú, visia ako potrhané konce.
  function cocoon(c: C2, x: number, y: number, s: number, left: number, k: number): void {
    if (!(left > 0)) return;
    c.save();
    c.globalCompositeOperation = 'source-atop'; // závoj len na postavičke
    c.fillStyle = `rgba(232,238,244,${0.42 * left})`;
    c.fillRect(x - s * 0.5, y - s, s, s);
    c.globalCompositeOperation = 'source-over';
    c.lineCap = 'round';
    const N = 16, w = Math.max(1.2, s * 0.022);
    for (let i = 0; i < N; i++) {
      const r = hash(k, i + 40); // poradie zodierania
      if (r > left + 0.18) continue;
      const fray = r > left; // práve sa trhá – len kúsok, ktorý visí
      const hy = y - s * (0.1 + 0.78 * hash(k, i + 70)), tilt = (hash(k, i + 90) - 0.5) * s * 0.22;
      const half = s * (0.2 + 0.08 * hash(k, i + 110)) * (hy < y - s * 0.62 ? 0.8 : 1); // pri hlave užšie
      const x0 = x - half, x1 = x + half, y0 = hy - tilt, y1 = hy + tilt, sag = s * (0.03 + 0.04 * hash(k, i + 130));
      c.strokeStyle = `rgba(246,249,252,${fray ? 0.55 : 0.92})`;
      c.lineWidth = w * (fray ? 0.8 : 1);
      c.beginPath();
      if (!fray) { c.moveTo(x0, y0); c.quadraticCurveTo(x, (y0 + y1) / 2 + sag, x1, y1); }
      else { // potrhané vlákno: kus od jednej strany a voľný koniec visí dole
        const side = hash(k, i + 150) < 0.5 ? -1 : 1, sx = x + side * half, sy = side < 0 ? y0 : y1;
        c.moveTo(sx, sy); c.quadraticCurveTo(sx - side * half * 0.5, sy + sag, sx - side * half * 0.55, sy + s * 0.12);
      }
      c.stroke();
    }
    // pár šikmých vlákien krížom (zmiznú medzi prvými)
    for (let i = 0; i < 4; i++) {
      if (hash(k, i + 200) * 0.6 + 0.4 > left) continue;
      const ya = y - s * (0.2 + 0.6 * hash(k, i + 210)), yb = ya - s * (0.25 + 0.15 * hash(k, i + 220)), d = i % 2 ? 1 : -1;
      c.strokeStyle = 'rgba(246,249,252,0.75)'; c.lineWidth = w * 0.9;
      c.beginPath(); c.moveTo(x - d * s * 0.2, ya); c.lineTo(x + d * s * 0.2, yb); c.stroke();
    }
    c.restore();
  }
  // Bublina chatu nad hráčom: zalomí slová do max. 4 riadkov (šírka ~4,5 políčka), zvyšok skončí „…“.
  // (x, y) = účiarie menovky; bublina (biely obdĺžnik) sa kreslí nad ňu.
  function wrapText(c: C2, text: string, maxW: number, maxLines: number): string[] {
    const lines: string[] = []; let cur = '';
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
    let l = must(lines[maxLines - 1]);
    while (l && c.measureText(l + '…').width > maxW) l = l.slice(0, -1);
    lines[maxLines - 1] = l.trimEnd() + '…';
    return lines;
  }
  function bubble(c: C2, text: string, x: number, y: number, ts: number): void {
    const fs = Math.max(11, ts * 0.26 | 0), lh = fs * 1.2, pad = ts * 0.14;
    c.font = fs + 'px system-ui, sans-serif'; c.textAlign = 'center';
    const lines = wrapText(c, text, Math.max(120, ts * 4.5), 4);
    const bw = Math.max(...lines.map(l => c.measureText(l).width)) + pad * 2, bh = lines.length * lh + pad * 1.4;
    const top = y - ts * 0.34 - bh;
    c.fillStyle = '#fff'; c.fillRect(x - bw / 2, top, bw, bh);
    c.fillStyle = '#222'; c.textBaseline = 'middle';
    lines.forEach((l, k) => { c.fillText(l, x, top + pad * 0.7 + lh * (k + 0.5)); });
    c.textBaseline = 'alphabetic';
  }

  return { plant, char, ground, soil, shroom, icon, hash, circ, bubble, web, cocoon };
})();

