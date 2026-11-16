// Záhon (#179): pravidlá bodov 8 × 8 spoločné pre server (návrhy v zahon.ts) a klienta (priblížený pohľad – sivé body).
// Vonkajší prstenec bodov je rám záhonu, kvety aj pokryvy sú len na vnútorných 6 × 6 bodoch. Každý kvet má ochrannú zónu
// d × d bodov okolo seba (D.ZAHON_SPACE) a zóny dvoch kvetov sa nesmú prekrývať, nech sú to akékoľvek druhy:
// Čebyševova vzdialenosť ≥ (d₁ + d₂) / 2. Zóna smie siahať aj cez rám. Pokryv (trávnik, kamene) zóny nemá.
import * as D from './data.ts';
import type { CoverId, SpeciesId } from './data.ts';

// Bod záhonu na serveri (ZahonSpot) aj u klienta (protokol: divé semienko má druh 'wild', kým nevyklíči)
export interface SpotLike { sx: number; sy: number; c?: CoverId | undefined; p?: { sp: SpeciesId | 'wild'; prog: number; d?: 1 | undefined; wild?: 1 | undefined } | undefined }
interface HasSpots { spots: readonly SpotLike[] }

export const SPOTS = 8;
// Bod vo vnútri záhonu (nie na ráme)
export const inner = (sx: number, sy: number): boolean => Number.isInteger(sx) && Number.isInteger(sy) && sx >= 1 && sy >= 1 && sx <= SPOTS - 2 && sy <= SPOTS - 2;
export const spotAt = <S extends SpotLike>(z: { spots: readonly S[] }, sx: number, sy: number): S | undefined => z.spots.find(s => s.sx === sx && s.sy === sy);
// Ochranná zóna druhu (vodné kvety do záhonu nejdú – null)
export function spaceOf(sp: SpeciesId | 'wild'): number | null { return sp === 'wild' ? 1 : D.SPECIES[sp].aqua ? null : D.ZAHON_SPACE[sp] ?? 1; }

// Prečo sa kvet sp nedá zasadiť na bod (sx, sy) – null = dá sa. Divé semienko (sp = null) má zónu 1, kým nevyklíči.
export function plantError(z: HasSpots, sx: number, sy: number, sp: SpeciesId | null): string | null {
  if (!inner(sx, sy)) return 'Na rám záhonu sa nesadí.';
  const here = spotAt(z, sx, sy);
  if (here?.p) return 'Tu už niečo rastie.';
  if (here?.c) return 'Tu je pokryv – najprv ho zober prázdnou rukou.';
  const d = sp === null ? 1 : spaceOf(sp);
  if (d === null) return 'Vodné kvety do záhonu nepatria – sadia sa do vody. 🌊';
  for (const o of z.spots) {
    if (!o.p) continue;
    const od = o.p.wild && o.p.prog <= 0 ? 1 : spaceOf(o.p.sp) ?? 1;
    if (Math.max(Math.abs(o.sx - sx), Math.abs(o.sy - sy)) < (d + od) / 2) return 'Príliš blízko iného kvetu – každý potrebuje svoje miesto.';
  }
  return null;
}
// Prečo sa pokryv nedá dať na bod – null = dá sa (pokryv na rovnaký pokryv nič nemení)
export function coverError(z: HasSpots, sx: number, sy: number): string | null {
  if (!inner(sx, sy)) return 'Rám záhonu sa nepokrýva.';
  if (spotAt(z, sx, sy)?.p) return 'Tu rastie kvet.';
  return null;
}
// Kvet na bode kvitne (dá sa zrezať)?
export function blooming(s: SpotLike | undefined): boolean { const p = s?.p; return !!p && p.sp !== 'wild' && !p.d && p.prog >= D.SPECIES[p.sp].days; }
