// Póza kreslenej postavičky (client/art.ts char) bez kreslenia (#158): smer, pohupovanie, mávanie rúk, plazenie – a kde sú
// ruky. char() kreslí ruky presne z handsOf, takže handAt (lano saní) je vždy tá istá ruka. Bez DOM, aby sa dala testovať.
// Póza z možností kresby postavičky (CharOpts v art.ts): plazenie, tanec, hrabanie (čas v s)
export interface PoseOpts { crawl?: boolean; dance?: boolean; dig?: number }
// Póza postavičky (spoločná pre kreslenie a pre polohu rúk – handAt): smer kreslenia d (0–3) s natočením do strany,
// výška tela yb (pohupovanie), krok, mávanie rúk sw, predklon pri plazení fx a pokrčenie kolien kn
export interface Pose { o: PoseOpts; phase: number; d: number; side: number; yb: number; step: number; sw: number; fx: number; kn: number }
export function charPose<O extends PoseOpts>(y: number, s: number, dir: number, phase0: number, o0: O): Pose & { o: O } {
  let o = o0, phase = phase0, d = dir;
  if (o.dig) { o = Object.assign({}, o, { crawl: true }); phase = 0; }
  let bob = Math.abs(Math.sin(phase)) * s * 0.04;
  if (o.dance) { d = Math.floor(phase * 1.2) % 4; bob = Math.abs(Math.sin(phase * 3)) * s * 0.12; }
  // uhlopriečne smery kreslíme ako pohľad dole/hore natočený do strany
  const side = d === 4 || d === 6 ? -1 : d === 5 || d === 7 ? 1 : 0;
  if (d >= 4) d = d <= 5 ? 0 : 3;
  const step = Math.sin(phase) * s * 0.06;
  const sw = o.dance ? Math.sin(phase * 3) * s * 0.15 : step;
  // plazenie: kolená pokrčené (kratšie nohy), trup sa predkloní v bokoch smerom pohybu;
  // pri pohľade spredu/zozadu predklon nevidno do strany, tak sa hlava len prikrčí k telu
  const fx = d === 1 ? -1 : d === 2 ? 1 : side;
  return { o, phase, d, side, yb: y - bob, step, sw, fx, kn: o.crawl ? s * 0.08 : 0 };
}
// Ruky (stredy kruhov) v súradniciach kreslenia tela – pri plazení ešte pod jeho natočením
export function handsOf(x: number, s: number, p: Pose): { l: [number, number]; r: [number, number] } {
  const k = p.d === 1 || p.d === 2 ? 0 : p.sw;
  return { l: [x - s * 0.22, p.yb - s * 0.36 + k], r: [x + s * 0.22, p.yb - s * 0.36 - k] };
}
// Kde je na plátne ruka, ktorá drží lano saní (#158) – presne tá, ktorú char() nakreslí (rovnaká póza a mávanie pri
// chôdzi, pri plazení aj s natočením tela). Pri pohľade doľava ľavá (bližšie k divákovi), inak pravá – ako lampáš.
// x, y = chodidlá ako v char(); pri hrabaní (dig) sa lano nedrží, vráti polohu rúk bez hrabania.
export function handAt(x: number, y: number, s: number, dir: number, phase: number, o: PoseOpts = {}): { x: number; y: number } {
  const p = charPose(y, s, dir, phase, o), h = handsOf(x, s, p), [hx0, hy0] = p.d === 1 ? h.l : h.r;
  if (!p.o.crawl) return { x: hx0, y: hy0 };
  // plazenie: posun ťažiska, potom predklon trupu okolo bokov (ako transformácie v char)
  const ang = p.fx * (p.d === 0 || p.d === 3 ? 0.3 : 0.45), cx = x, cy = p.yb - s * 0.2, dx = hx0 - cx, dy = hy0 - cy;
  const rx = dx * Math.cos(ang) - dy * Math.sin(ang), ry = dx * Math.sin(ang) + dy * Math.cos(ang);
  return { x: cx + rx - p.fx * s * 0.08, y: cy + p.kn + (p.fx ? 0 : s * 0.07) + ry };
}
