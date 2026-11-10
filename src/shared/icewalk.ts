// Chôdza po ľade (#157): šmýkanie s hybnosťou, pošmyknutie pri prudkej zákrute, čupnutie, prepadnutie cez otvor
// a plávanie. Spoločné pre server (src/server/icewalk.ts – rozhoduje) a klienta (src/client/icewalk.ts – predpovedá),
// aby obaja počítali rovnakou fyzikou a server opravoval len to, čo naozaj nesedí.
// Ľad = zamrznutá voda v zime (akákoľvek voda, nikdy pevné súradnice) a ľadovec, na ktorom ešte je ľad.
// Otvor vysekaný vo vode (cut) ľad nie je – kto naň vstúpi nečupiac, prepadne sa a pláva.
import * as D from './data.ts';
import type { GroundTile } from './data.ts';

// Políčko, ako ho chôdza po ľade potrebuje (zem, vrstvy ľadu na ľadovci, otvor vo vode)
export interface IceTile extends GroundTile { readonly cut?: 1 | undefined }

export const WINTER = 3;
// Konštanty (políčka, sekundy). Maintainer ich doladí na náhľade (otvorená otázka v #157).
export const ICE = {
  speed: 3.8,       // najvyššia rýchlosť (ako chôdza po zemi, políčka/s)
  accel: 4.5,       // rozbeh a zatáčanie na ľade (políčka/s²) – na zemi je okamžité
  brake: 3.2,       // brzdenie bez vstupu: z plnej rýchlosti sa zastaví asi po 2,3 políčka
  crouch: 0.5,      // čupnutie: polovičná rýchlosť (aj na zemi)
  swim: 0.35,       // plávanie: tretina rýchlosti, bez hybnosti
  slipSpeed: 1.6,   // pomalšie sa nepošmykne nikto
  safeTurn: 1.05,   // zákruta do 60° medzi smerom šmýkania a vstupom je bezpečná
  fullTurn: 2.6,    // od ~150° (otočka) je riziko najvyššie
  slipRate: 9,      // najvyššie riziko pošmyknutia za sekundu (pri otočke v plnej rýchlosti ≈ 60 % za 0,1 s)
  fallS: 1.6,       // ako dlho po pošmyknutí leží (s)
  splashS: 1.0,     // ako dlho po prepadnutí čľapká, kým môže plávať (s)
  tol: 0.35,        // o koľko smie poloha klienta ujsť od výpočtu servera, kým ju server opraví (políčka)
  dtMax: 0.25,      // najdlhší krok fyziky na jeden pohyb (s)
  dtDef: 0.1        // krok, keď klient čas neposlal alebo je zlý
} as const;

export const isWinter = (season: number): boolean => season === WINTER;
// Je políčko práve ľad? (zamrznutá voda bez otvoru, ľadovec s ľadom)
export function isIce(t: IceTile | null | undefined, season: number): boolean {
  if (!t) return false;
  if (t.g === 'water') return isWinter(season) && !t.cut;
  return t.g === 'glacier' && (t.ice ?? 0) > 0;
}
// Otvor v zamrznutej vode (prepadne sa ním, kto nečupí)
export function isHole(t: IceTile | null | undefined, season: number): boolean { return !!t && t.g === 'water' && isWinter(season) && !!t.cut; }
// Voda, v ktorej sa pláva: mimo zimy každá, v zime len otvor
export function openWater(t: IceTile | null | undefined, season: number): boolean { return !!t && t.g === 'water' && (!isWinter(season) || !!t.cut); }
// Dá sa políčko práve prejsť? Ako D.passable, navyše voda v zime (ľad aj otvor) a pre plávajúceho každá voda.
export function passableNow(t: IceTile | null | undefined, season: number, swim: boolean): t is IceTile {
  if (!t) return false;
  return t.g === 'water' ? isWinter(season) || swim : passable(t);
}
const passable: (t: IceTile) => boolean = D.passable;
// D.canStep s vodou podľa obdobia (z brehu na ľad sa schádza o pol bloku nižšie, späť je to krok hore)
export function canStep(from: IceTile | null | undefined, to: IceTile | null | undefined, season: number, swim: boolean, lift?: number, crawl?: boolean): boolean {
  if (!passableNow(to, season, swim)) return false;
  const up = D.level(to) - D.level(from);
  return crawl ? up === 0 : up <= D.GLACIER_STEP + (lift || 0);
}

// Vstup (smer joysticku / klávesov, dĺžka ≤ 1) na dĺžku najviac max
export function clampInput(ix: number, iy: number, max: number): [number, number] {
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) return [0, 0];
  const l = Math.hypot(ix, iy);
  return l > max && l > 0 ? [ix / l * max, iy / l * max] : [ix, iy];
}
// Hybnosť na ľade: rýchlosť sa blíži k cieľu (vstup × ICE.speed) najviac o accel·dt (bez vstupu brzdí o brake·dt).
// Pri stálom vstupe nezáleží na tom, na koľko krokov sa dt rozdelí – klient a server sa tak zhodnú.
export function accelerate(vx: number, vy: number, ix: number, iy: number, dt: number): [number, number] {
  const tx = ix * ICE.speed, ty = iy * ICE.speed, dx = tx - vx, dy = ty - vy, d = Math.hypot(dx, dy);
  const k = (ix || iy ? ICE.accel : ICE.brake) * dt;
  if (d <= k || d === 0) return [tx, ty];
  return [vx + dx / d * k, vy + dy / d * k];
}
// Riziko pošmyknutia za krok dt: podľa uhla medzi smerom šmýkania a vstupom a podľa rýchlosti (0 = bezpečné).
// Server hodí kockou (ctx.rng) – pomalá zákruta je bezpečná, prudká otočka v plnej rýchlosti takmer istá.
export function slipChance(vx: number, vy: number, ix: number, iy: number, dt: number): number {
  const sp = Math.hypot(vx, vy), il = Math.hypot(ix, iy);
  if (sp < ICE.slipSpeed || il < 0.2 || dt <= 0) return 0;
  const cos = (vx * ix + vy * iy) / (sp * il), ang = Math.acos(Math.max(-1, Math.min(1, cos)));
  const kt = Math.max(0, Math.min(1, (ang - ICE.safeTurn) / (ICE.fullTurn - ICE.safeTurn)));
  const ks = Math.max(0, Math.min(1, (sp - ICE.slipSpeed) / (ICE.speed - ICE.slipSpeed)));
  const rate = ICE.slipRate * kt * (0.35 + 0.65 * ks);
  return rate > 0 ? 1 - Math.exp(-rate * dt) : 0;
}
// Sekundy → kroky sveta (pevný počet krokov pre svet s danou dĺžkou dňa; najmenej 1)
export function ticksOf(sec: number, daySeconds: number): number {
  return Math.max(1, Math.round(sec * D.TICKS_PER_DAY / (daySeconds > 0 ? daySeconds : D.BASE_DAY_SECONDS)));
}
