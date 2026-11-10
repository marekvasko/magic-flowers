// Chôdza po ľade na klientovi (#157): klient pohyb len predpovedá rovnakou fyzikou ako server (src/shared/icewalk.ts),
// aby sa postavička hýbala plynulo; o pošmyknutí, prepadnutí a plávaní rozhoduje server (správa iw) a poloha zo servera
// má prednosť (oprava). Tu je stav vlastnej postavičky (leží do, pláva), režim pohybu a jeden krok fyziky.
import * as IW from '../shared/icewalk.ts';
import type { IceTile } from '../shared/icewalk.ts';
import type { MsgOf } from './state.ts';

// Stav vlastnej postavičky: do kedy leží (performance.now ms), či pláva, či už dostala radu o čupnutí
export interface IceClient { fallUntil: number; swim: boolean; hinted: boolean; lastT?: number }
export type IceMode = 'fall' | 'swim' | 'ice' | null;
// Postavička, ktorej sa krok týka (S.me): poloha a hybnosť
interface Body { x: number; y: number; vx?: number | undefined; vy?: number | undefined }

export function create(): IceClient { return { fallUntil: 0, swim: false, hinted: false }; }

// Správa iw zo servera: hybnosť, ležanie, plávanie, prípadne oprava polohy. Vráti, čo sa práve začalo (pre zvuk).
export function onMsg(st: IceClient, me: Body, m: MsgOf<'iw'>, now: number): 'fall' | 'splash' | 'out' | null {
  const wasSwim = st.swim, wasDown = st.fallUntil > now;
  me.vx = m.vx; me.vy = m.vy;
  if (m.x !== undefined && m.y !== undefined) { me.x = m.x; me.y = m.y; }
  st.fallUntil = m.fall > 0 ? now + m.fall : 0;
  st.swim = !!m.sw;
  if (st.swim && !wasSwim) return 'splash';
  if (!st.swim && wasSwim) return 'out';
  return m.fall > 0 && !wasDown && !st.swim ? 'fall' : null;
}

// Režim pohybu podľa stavu a políčka pod stredom postavičky: leží, pláva, šmýka sa, alebo bežná chôdza (null)
export function mode(st: IceClient, here: IceTile | null | undefined, season: number, now: number): IceMode {
  if (st.fallUntil > now && !st.swim) return 'fall';
  if (st.swim || IW.openWater(here, season)) return st.fallUntil > now ? 'fall' : 'swim';
  return IW.isIce(here, season) ? 'ice' : null;
}
// Póza vlastnej postavičky (kreslenie): leží, pláva, alebo nič
export function pose(st: IceClient, now: number): 'fall' | 'swim' | null { return st.swim ? 'swim' : st.fallUntil > now ? 'fall' : null; }

// Skutočný čas od minulého snímku (s, najviac ICE.dtMax): fyzika ľadu ide v reálnom čase ako na serveri (ten počíta
// z času klienta), aj keď hra pri pomalom snímkovaní krok snímku oreže
export function realDt(st: IceClient, now: number, frameDt: number): number {
  const d = st.lastT === undefined ? frameDt : (now - st.lastT) / 1000;
  st.lastT = now;
  return Math.max(0, Math.min(IW.ICE.dtMax, d));
}
// Krok na ľade: hybnosť sa blíži k vstupu (ix, iy – smer × spomalenie) a vráti posun za dt
export function slide(me: Body, ix: number, iy: number, dt: number): [number, number] {
  const [vx, vy] = IW.accelerate(me.vx || 0, me.vy || 0, ix, iy, dt);
  me.vx = vx; me.vy = vy;
  return [vx * dt, vy * dt];
}
