// Doprava (#158): fúrik a sane – údaje a pohyb, ktoré zdieľa server (src/server/vehicles.ts) aj klient
// (src/client/vehicles.ts predpovedá polohu fúrika, ktorý hráč práve tlačí, rovnakým výpočtom ako server).
// Fúrik sa tlačí pred sebou (natáča sa za smerom chôdze, cúvať sa s ním dá), sane sa ťahajú za sebou na lane.
import * as D from './data.ts';
import type { AreaId, Season } from './data.ts';
import type { Vehicle, VehicleId, Vehicles } from './save.ts';

export interface VehicleInfo {
  readonly name: string;      // meno v hre (Fúrik, Sane)
  readonly acc: string;       // 4. pád: „chytil si fúrik / sane“
  readonly loc: string;       // 6. pád s predložkou: „vo fúriku / v saniach“
  readonly icon: string;      // emoji do textov (obrázok kreslí klient z 3D modelu)
  readonly price: number;
  readonly rep: number;
  readonly seasons: readonly Season[];
  readonly push: boolean;     // true = tlačí sa pred sebou, false = ťahá sa za sebou
  readonly desc: string;
}
export const VEHICLE_IDS: readonly VehicleId[] = ['furik', 'sane'];
export const VEHICLES: Readonly<Record<VehicleId, VehicleInfo>> = {
  furik: {
    name: 'Fúrik', acc: 'fúrik', loc: 'vo fúriku', icon: '🛞', price: 400, rep: 2, seasons: [0, 1, 2], push: true,
    desc: 'Tlačí sa pred sebou. Odvezie naraz 6 kusov ľadu z hôr do ľadovne a nespomalí ťa. Na jar, v lete a na jeseň.'
  },
  sane: {
    name: 'Sane', acc: 'sane', loc: 'v saniach', icon: '🛷', price: 400, rep: 2, seasons: [3], push: false,
    desc: 'Ťahajú sa za sebou po snehu. Odvezú naraz 6 kusov ľadu a nespomalia ťa. Len v zime.'
  }
};
export const isVehicleId = (v: unknown): v is VehicleId => v === 'furik' || v === 'sane';
export const VEHICLE_ICE = 6;                                 // najviac kusov ľadu vo fúriku či saniach
export const VEHICLE_AREAS: readonly AreaId[] = ['garden', 'hory'];  // kam smú (aj prechod medzi nimi)
export const VEHICLE_REACH = 1.6;                             // ako blízko treba stáť, aby sa dal chytiť, naložiť, naskočiť
export const VEHICLE_ICEHOUSE = 3.4;                          // ako blízko ľadovne musí stáť, aby sa z neho dalo vyložiť do nej
export const PUSH_L = 0.62, TOW_L = 0.95;                      // vzdialenosť stredu fúrika pred hráčom / saní za hráčom (políčka)
const TURN = 2.6;                                             // ako rýchlo sa fúrik natáča za smerom chôdze (radiány na políčko)
const BACK = 2.2;                                             // pohyb proti smeru fúrika (viac než ~126°) je cúvanie – fúrik sa nenatáča
// Kde stojí nový fúrik a nové sane: pred Dielňou (pozemok x 15–16, y 27–28; vchod je na juh)
export const VEHICLE_HOME: Readonly<Record<VehicleId, { x: number; y: number; a: number }>> = {
  furik: { x: 15.5, y: 29.6, a: Math.PI / 2 },
  sane: { x: 16.6, y: 29.6, a: Math.PI / 2 }
};

export function newVehicle(id: VehicleId): Vehicle {
  const h = VEHICLE_HOME[id];
  return { bought: false, area: 'garden', x: h.x, y: h.y, a: h.a, ice: 0, fb: [], usable: true, driver: null, passenger: null };
}
export const newVehicles = (): Vehicles => ({ furik: newVehicle('furik'), sane: newVehicle('sane') });

export const inSeason = (id: VehicleId, season: Season): boolean => VEHICLES[id].seasons.includes(season);
// Prečo sa teraz nedá chytiť (mimo obdobia) – inak ''
export function seasonText(id: VehicleId, season: Season): string {
  if (inSeason(id, season)) return '';
  return id === 'furik'
    ? 'V snehu by sa koliesko fúrika zaborilo. V zime vezmi radšej sane. 🛷'
    : 'Bez snehu sa sane nepohnú – jazdia len v zime. Teraz vezmi fúrik. 🛞';
}
// Text pre ľadový náklad: „1 kus / 2 kusy / 5 kusov ľadu“
export function iceText(n: number): string { return `${n} ${n === 1 ? 'kus' : n >= 2 && n <= 4 ? 'kusy' : 'kusov'} ľadu`; }

// ---- Pohyb ----
export interface Pose { x: number; y: number; a: number }
const wrap = (a: number): number => { let r = a % (2 * Math.PI); if (r > Math.PI) r -= 2 * Math.PI; if (r < -Math.PI) r += 2 * Math.PI; return r; };
// Kam sa fúrik / sane pohnú, keď sa hráč, ktorý ich drží, posunie z from na to. v = doterajšia poloha a natočenie.
// Fúrik: natočí sa za smerom chôdze (najviac TURN radiánov na prejdené políčko; pri cúvaní nie) a stojí PUSH_L pred hráčom.
// Sane: kým je lano voľné (bližšie než TOW_L), stoja; potom ich lano ťahá za hráčom.
export function follow(id: VehicleId, v: Pose, from: { x: number; y: number }, to: { x: number; y: number }): Pose {
  if (!VEHICLES[id].push) {
    const ux = to.x - v.x, uy = to.y - v.y, r = Math.hypot(ux, uy);
    if (r <= TOW_L) return { x: v.x, y: v.y, a: v.a };
    return { x: to.x - ux / r * TOW_L, y: to.y - uy / r * TOW_L, a: Math.atan2(uy, ux) };
  }
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy);
  let a = v.a;
  if (d > 1e-6) {
    const diff = wrap(Math.atan2(dy, dx) - v.a);
    if (Math.abs(diff) <= BACK) a = wrap(v.a + Math.max(-TURN * d, Math.min(TURN * d, diff)));
  }
  return { x: to.x + Math.cos(a) * PUSH_L, y: to.y + Math.sin(a) * PUSH_L, a };
}
// Natočenie pri chytení: fúrik smerom od hráča, sane smerom k hráčovi
export function grabAngle(id: VehicleId, v: { x: number; y: number }, p: { x: number; y: number }): number {
  return VEHICLES[id].push ? Math.atan2(v.y - p.y, v.x - p.x) : Math.atan2(p.y - v.y, p.x - v.x);
}
// Zaokrúhlenie polohy na uloženie (ako polohy hráčov)
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
// Políčko plochy pod stredom fúrika (index), alebo -1 mimo plochy
export function tileIndex(area: string, x: number, y: number): number {
  const { w, h } = D.areaSize(area), tx = Math.floor(x), ty = Math.floor(y);
  return tx < 0 || ty < 0 || tx >= w || ty >= h ? -1 : ty * w + tx;
}
// Ktorý fúrik drží / v ktorom sedí hráč key (null = v žiadnom)
export function drivenBy(vs: Partial<Vehicles> | null | undefined, key: string): VehicleId | null {
  for (const id of VEHICLE_IDS) if (vs?.[id]?.bought && vs[id].driver === key) return id;
  return null;
}
export function ridden(vs: Partial<Vehicles> | null | undefined, key: string): VehicleId | null {
  for (const id of VEHICLE_IDS) if (vs?.[id]?.bought && vs[id].passenger === key) return id;
  return null;
}
