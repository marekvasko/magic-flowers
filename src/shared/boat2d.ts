// Loďka (#160) ako 2D obrázok: tvar a premietanie, ktoré zdieľa kreslenie (src/client/art.ts Art.boat), 3D pohľad
// (src/client/boat3d.ts – kam postaviť obrázok a mená posádky) a testy. Bez DOM.
// Loďka ako 2D obrázok (#160): kreslí sa ako skutočná 3D loďka premietnutá rovnako ako 3D pohľad hry (izometria,
// sklon kamery PITCH), v 8 smeroch ako postavička (dir 0 dole, 1 vľavo, 2 vpravo, 3 hore, 4–7 uhlopriečky).
// Súradnice loďky v blokoch: u pozdĺž (prova +u), v naprieč (vpravo od provy), h nahor od hladiny.
export const BOAT2D = {
  L: 1.1, W: 0.46, H: 0.4,               // polovičná dĺžka, polovičná šírka, výška boku nad hladinou
  seats: [0.36, -0.58] as const,         // lavička veslára (u) a spolujazdca
  bench: 0.17,                           // výška lavičky nad hladinou
  pitch: Math.atan(1 / Math.SQRT2),      // sklon kamery (render3d PITCH)
  angle: [90, 180, 0, 270, 135, 45, 225, 315] as const // smer provy na obrazovke (stupne, y dolu) pre dir 0–7
};
// Bod loďky (u, v, h) na obrazovke: posun od stredu loďky na hladine (v blokoch, y dolu)
export function boatScreen(dir: number, u: number, v: number, h: number): [number, number] {
  const a = (BOAT2D.angle[dir & 7] ?? 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), SP = Math.sin(BOAT2D.pitch), CP = Math.cos(BOAT2D.pitch);
  return [u * cs - v * sn, (u * sn + v * cs) * SP - h * CP];
}
// O koľko blokov smerom ku kamere je najbližší bod loďky pred jej stredom (3D pohľad tam postaví obrázok, aby ho hladina neprekryla)
export function boatNear(dir: number): number {
  const a = (BOAT2D.angle[dir & 7] ?? 0) * Math.PI / 180;
  let g = 0;
  for (let i = 0; i <= 16; i++) { const u = -BOAT2D.L + 2 * BOAT2D.L * i / 16, w = boatHalfW(u); for (const v of [-w, w]) g = Math.max(g, u * Math.sin(a) + v * Math.cos(a)); }
  return g * Math.cos(BOAT2D.pitch);
}
// Polovičná šírka trupu na okraji v mieste u: kormidlo (zadná doska) užšie, prova do špičky
export function boatHalfW(u: number): number {
  const { L, W } = BOAT2D, b = 0.18;
  if (u <= b) { const t = (b - u) / (L + b); return W * (1 - 0.3 * t * t); }
  const t = Math.min(1, (u - b) / (L - b));
  return W * Math.pow(Math.max(0, 1 - Math.pow(t, 1.8)), 0.6);
}
