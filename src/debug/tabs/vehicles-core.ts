// Fúrik a sane na ladiacej stránke (#158): z uloženého stavu sveta (snap.state.vehicles, kľúče hráčov už nahradené
// odtlačkom) – pre záložky Map (značka na mape a riadky v paneloch) a Cheats (stav pri tlačidlách). Bez DOM okrem kreslenia.
import type { AreaId } from '../../shared/data.ts';
import type { VehicleId } from '../../shared/save.ts';
import * as V from '../../shared/vehicles.ts';
import { isRecord } from '../../shared/util.ts';

export interface DebugVehicle { id: VehicleId; name: string; bought: boolean; area: AreaId; x: number; y: number; a: number; ice: number; usable: boolean | null; driver: string | null; passenger: string | null }
// Fúriky zo stavu sveta (staršie uloženie: nekúpené pred Dielňou)
export function vehiclesOf(state: { [key: string]: unknown } | null | undefined): DebugVehicle[] {
  const src = state && isRecord(state['vehicles']) ? state['vehicles'] : {};
  return V.VEHICLE_IDS.map(id => {
    const base = V.newVehicle(id), raw = src[id], v = isRecord(raw) ? raw : {};
    const num = (k: string, d: number): number => { const n = v[k]; return typeof n === 'number' && Number.isFinite(n) ? n : d; };
    const str = (k: string): string | null => { const s = v[k]; return typeof s === 'string' ? s : null; };
    return {
      id, name: V.VEHICLES[id].name, bought: !!v['bought'], area: V.VEHICLE_AREAS.find(a => a === v['area']) ?? base.area,
      x: num('x', base.x), y: num('y', base.y), a: num('a', base.a), ice: num('ice', 0), usable: typeof v['usable'] === 'boolean' ? v['usable'] : null, driver: str('driver'), passenger: str('passenger')
    };
  });
}
// Popis: kde, náklad, vodič, spolujazdec (names = odtlačok → meno pripojeného hráča)
export function vehicleText(v: DebugVehicle, names: ReadonlyMap<string, string>): string {
  if (!v.bought) return 'not bought';
  const who = (k: string | null): string => (k ? `${names.get(k) ?? ''} ${k}`.trim() : '—');
  return `${v.area} ${v.x.toFixed(2)}, ${v.y.toFixed(2)} · ${v.usable === false ? 'unusable (season)' : v.usable ? 'usable' : 'usable: derived on load'} · ice ${String(v.ice)}/${String(V.VEHICLE_ICE)} · driver ${who(v.driver)} · passenger ${who(v.passenger)}`;
}
// Kedy udalosť vehSeason (začiatok obdobia) znova prepne, či sa dajú fúrik a sane používať – z fronty udalostí sveta
export function nextToggle(state: { [key: string]: unknown } | null | undefined): number | null {
  const evs = state && Array.isArray(state['events']) ? state['events'] : [];
  for (const e of evs) if (isRecord(e) && e['key'] === 'vehSeason' && typeof e['at'] === 'number') return e['at'];
  return null;
}
export const VEHICLE_COLOR: Readonly<Record<VehicleId, string>> = { furik: '#e53935', sane: '#c9a77a' };
// Značka na mape (súradnice v políčkach): obdĺžnik natočený za smerom, špička vpredu, bodky = ľad
export function drawVehicle(g: CanvasRenderingContext2D, v: DebugVehicle): void {
  g.save();
  g.translate(v.x, v.y); g.rotate(v.a);
  g.fillStyle = VEHICLE_COLOR[v.id]; g.strokeStyle = '#fff'; g.lineWidth = 0.08;
  g.beginPath(); g.moveTo(-0.45, -0.2); g.lineTo(0.28, -0.2); g.lineTo(0.45, 0); g.lineTo(0.28, 0.2); g.lineTo(-0.45, 0.2); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#bfe6fb';
  for (let k = 0; k < v.ice; k++) g.fillRect(-0.34 + (k % 3) * 0.2, k < 3 ? -0.15 : 0.02, 0.14, 0.12);
  if (v.driver) { g.fillStyle = '#ff5ca8'; g.beginPath(); g.arc(V.VEHICLES[v.id].push ? -V.PUSH_L : V.TOW_L, 0, 0.12, 0, 7); g.fill(); }
  g.restore();
}
