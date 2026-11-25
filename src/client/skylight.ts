// Farby denného svetla a oblohy podľa dennej doby (#190): noc → modrá hodinka → oranžový východ slnka → zlaté ráno →
// ostré poludnie → zlaté popoludnie → západ → modrá hodinka → noc. Bez Three.js, aby sa dalo testovať.
// Všetko v sRGB (ako kresby z art.ts a farby sveta). Medzi kľúčmi sa farby prelínajú plynulo (smoothstep).
//   ambSky    – okolité svetlo z oblohy (svieti na vrchy kociek; cez deň modrasté, pri východe teplé)
//   ambGround – svetlo odrazené od zeme (spodky kociek; zelenkavo-teplé, slabšie)
//   sun       – farba a sila slnka (pri východe a západe oranžová, na poludnie takmer biela a silnejšia)
//   zenith, horizon – obloha hore a pri obzore; glow – sila teplej žiary pri obzore na strane slnka (0–1)
type V3 = [number, number, number];
export interface SkyLight { ambSky: V3; ambGround: V3; sun: V3; zenith: V3; horizon: V3; glow: number }
interface Key extends SkyLight { h: number }

const NIGHT: Omit<Key, 'h'> = {
  ambSky: [0.21, 0.25, 0.44], ambGround: [0.15, 0.17, 0.3], sun: [0, 0, 0],
  zenith: [0.02, 0.03, 0.1], horizon: [0.07, 0.1, 0.22], glow: 0
};
// popoludnie je o niečo teplejšie než predpoludnie; noc je rovnaká na oboch koncoch dňa
export const SKY_KEYS: readonly Key[] = [
  { h: 0, ...NIGHT },
  { h: 3.8, ...NIGHT },
  { h: 4.8, ambSky: [0.32, 0.35, 0.56], ambGround: [0.22, 0.22, 0.34], sun: [0, 0, 0], zenith: [0.1, 0.16, 0.38], horizon: [0.46, 0.42, 0.6], glow: 0.35 }, // modrá hodinka
  { h: 5.5, ambSky: [0.5, 0.45, 0.54], ambGround: [0.42, 0.33, 0.3], sun: [0.72, 0.45, 0.22], zenith: [0.3, 0.42, 0.68], horizon: [1, 0.62, 0.4], glow: 1 }, // východ
  { h: 6.6, ambSky: [0.56, 0.55, 0.64], ambGround: [0.5, 0.45, 0.36], sun: [0.7, 0.54, 0.32], zenith: [0.38, 0.6, 0.88], horizon: [0.98, 0.82, 0.64], glow: 0.45 }, // zlaté ráno
  { h: 8.5, ambSky: [0.54, 0.58, 0.72], ambGround: [0.47, 0.49, 0.41], sun: [0.6, 0.56, 0.47], zenith: [0.34, 0.6, 0.94], horizon: [0.7, 0.86, 0.98], glow: 0 },
  { h: 11.5, ambSky: [0.5, 0.56, 0.72], ambGround: [0.44, 0.48, 0.4], sun: [0.64, 0.62, 0.55], zenith: [0.28, 0.55, 0.94], horizon: [0.66, 0.84, 0.98], glow: 0 }, // poludnie – ostré
  { h: 15, ambSky: [0.5, 0.56, 0.72], ambGround: [0.44, 0.48, 0.4], sun: [0.64, 0.62, 0.55], zenith: [0.28, 0.55, 0.94], horizon: [0.66, 0.84, 0.98], glow: 0 },
  { h: 18, ambSky: [0.57, 0.6, 0.7], ambGround: [0.5, 0.49, 0.4], sun: [0.65, 0.57, 0.44], zenith: [0.34, 0.58, 0.92], horizon: [0.76, 0.86, 0.94], glow: 0.05 },
  { h: 19.5, ambSky: [0.57, 0.53, 0.58], ambGround: [0.52, 0.43, 0.34], sun: [0.72, 0.5, 0.26], zenith: [0.36, 0.5, 0.8], horizon: [1, 0.74, 0.48], glow: 0.6 }, // zlatá hodinka
  { h: 20.6, ambSky: [0.46, 0.38, 0.5], ambGround: [0.4, 0.3, 0.3], sun: [0.7, 0.4, 0.2], zenith: [0.24, 0.28, 0.54], horizon: [0.98, 0.52, 0.38], glow: 1 }, // západ
  { h: 21.4, ambSky: [0.3, 0.32, 0.54], ambGround: [0.2, 0.2, 0.32], sun: [0, 0, 0], zenith: [0.08, 0.12, 0.32], horizon: [0.38, 0.32, 0.54], glow: 0.35 }, // modrá hodinka
  { h: 22.3, ...NIGHT },
  { h: 24, ...NIGHT }
];

const smooth = (t: number): number => t * t * (3 - 2 * t);
const mixV = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function skyLight(minuteOfDay: number): SkyLight {
  const h = ((minuteOfDay % 1440) + 1440) % 1440 / 60;
  let i = 0;
  while (i < SKY_KEYS.length - 2 && (SKY_KEYS[i + 1]?.h ?? 24) <= h) i++;
  const a = SKY_KEYS[i] ?? SKY_KEYS[0], b = SKY_KEYS[i + 1] ?? a;
  if (!a || !b) throw new Error('SKY_KEYS');
  const t = b.h > a.h ? smooth(Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)))) : 0;
  return {
    ambSky: mixV(a.ambSky, b.ambSky, t), ambGround: mixV(a.ambGround, b.ambGround, t), sun: mixV(a.sun, b.sun, t),
    zenith: mixV(a.zenith, b.zenith, t), horizon: mixV(a.horizon, b.horizon, t), glow: a.glow + (b.glow - a.glow) * t
  };
}

// jas farby (Rec. 709) – na zamračenú oblohu a porovnanie teplých a studených farieb v testoch
export const luma = (c: Readonly<V3>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// zamračené (dážď, sneh): farba sa priblíži k šedej s rovnakým jasom; k = 0 bez zmeny, 1 = celkom šedá
export function overcast(c: Readonly<V3>, k: number): V3 { const l = luma(c); return mixV([c[0], c[1], c[2]], [l, l, l], k); }
