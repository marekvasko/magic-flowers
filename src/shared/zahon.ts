// Záhon (#179): pravidlá bodov 8 × 8 spoločné pre server (návrhy v zahon.ts) a klienta (priblížený pohľad – sivé body).
// Vonkajší prstenec bodov je rám záhonu – ale dva záhony vedľa seba sa spoja: na spoločnej strane rám nie je a body tam
// sú ako vnútri (Bed.open). Každý kvet má ochrannú zónu d × d bodov okolo seba (D.ZAHON_SPACE) a zóny dvoch kvetov sa
// nesmú prekrývať, nech sú to akékoľvek druhy, ani cez hranicu susedných záhonov (Bed.near): Čebyševova vzdialenosť
// ≥ (d₁ + d₂) / 2. Zóna smie siahať aj cez rám. Pokryv (trávnik, kamene) zóny nemá.
import * as D from './data.ts';
import type { CoverId, SpeciesId } from './data.ts';

// Bod záhonu na serveri (ZahonSpot) aj u klienta (protokol: divé semienko má druh 'wild', kým nevyklíči)
export interface SpotLike { sx: number; sy: number; c?: CoverId | undefined; p?: { sp: SpeciesId | 'wild'; prog: number; d?: 1 | undefined; wild?: 1 | undefined } | undefined }
// Záhon s okolím: open = strany, kde susedí iný záhon (tam nie je rám), near = kvety susedných záhonov (aj šikmo)
// v súradniciach bodov tohto záhonu. Bez open/near je záhon osamotený.
export interface Open { n: boolean; s: boolean; e: boolean; w: boolean }
interface HasSpots { spots: readonly SpotLike[]; open?: Open; near?: readonly SpotLike[] }
export const CLOSED: Open = { n: false, s: false, e: false, w: false };

export const SPOTS = 8;
// Bod v mriežke 8 × 8
export const inGrid = (sx: number, sy: number): boolean => Number.isInteger(sx) && Number.isInteger(sy) && sx >= 0 && sy >= 0 && sx < SPOTS && sy < SPOTS;
// Bod na ráme (na strane, kde nesusedí iný záhon)
export function isFrame(open: Open | undefined, sx: number, sy: number): boolean {
  const o = open ?? CLOSED;
  return (sx === 0 && !o.w) || (sx === SPOTS - 1 && !o.e) || (sy === 0 && !o.n) || (sy === SPOTS - 1 && !o.s);
}
// Bod vo vnútri osamoteného záhonu (nie na ráme)
export const inner = (sx: number, sy: number): boolean => inGrid(sx, sy) && !isFrame(CLOSED, sx, sy);
// Okolie záhonu z (x, y) v zozname objektov: susedné záhony a ich kvety v bodoch záhonu z
export interface BedPos { kind: string; area: string; x: number; y: number }
export function bedOf<Z extends BedPos & HasSpots>(list: readonly (BedPos | Z)[], z: Z): Z & { open: Open; near: SpotLike[] } {
  const beds = list.filter((o): o is Z => o.kind === 'zahon' && o.area === z.area && o !== z && Math.abs(o.x - z.x) <= 1 && Math.abs(o.y - z.y) <= 1);
  const at = (dx: number, dy: number): boolean => beds.some(o => o.x === z.x + dx && o.y === z.y + dy);
  const near: SpotLike[] = [];
  for (const o of beds) for (const q of o.spots) if (q.p) near.push({ sx: q.sx + (o.x - z.x) * SPOTS, sy: q.sy + (o.y - z.y) * SPOTS, p: q.p });
  return { ...z, open: { n: at(0, -1), s: at(0, 1), e: at(1, 0), w: at(-1, 0) }, near };
}
export const spotAt = <S extends SpotLike>(z: { spots: readonly S[] }, sx: number, sy: number): S | undefined => z.spots.find(s => s.sx === sx && s.sy === sy);
// Ochranná zóna druhu (vodné kvety do záhonu nejdú – null)
export function spaceOf(sp: SpeciesId | 'wild'): number | null { return sp === 'wild' ? 1 : D.SPECIES[sp].aqua ? null : D.ZAHON_SPACE[sp] ?? 1; }

// Prečo sa kvet sp nedá zasadiť na bod (sx, sy) – null = dá sa. Divé semienko (sp = null) má zónu 1, kým nevyklíči.
export function plantError(z: HasSpots, sx: number, sy: number, sp: SpeciesId | null): string | null {
  if (!inGrid(sx, sy) || isFrame(z.open, sx, sy)) return 'Na rám záhonu sa nesadí.';
  const here = spotAt(z, sx, sy);
  if (here?.p) return 'Tu už niečo rastie.';
  if (here?.c) return 'Tu je pokryv – najprv ho zober prázdnou rukou.';
  const d = sp === null ? 1 : spaceOf(sp);
  if (d === null) return 'Vodné kvety do záhonu nepatria – sadia sa do vody. 🌊';
  for (const o of z.near ? z.spots.concat(z.near) : z.spots) {
    if (!o.p) continue;
    const od = o.p.wild && o.p.prog <= 0 ? 1 : spaceOf(o.p.sp) ?? 1;
    if (Math.max(Math.abs(o.sx - sx), Math.abs(o.sy - sy)) < (d + od) / 2) return 'Príliš blízko iného kvetu – každý potrebuje svoje miesto.';
  }
  return null;
}
// Prečo sa pokryv nedá dať na bod – null = dá sa (pokryv na rovnaký pokryv nič nemení)
export function coverError(z: HasSpots, sx: number, sy: number): string | null {
  if (!inGrid(sx, sy) || isFrame(z.open, sx, sy)) return 'Rám záhonu sa nepokrýva.';
  if (spotAt(z, sx, sy)?.p) return 'Tu rastie kvet.';
  return null;
}
// Kvet na bode kvitne (dá sa zrezať)?
export function blooming(s: SpotLike | undefined): boolean { const p = s?.p; return !!p && p.sp !== 'wild' && !p.d && p.prog >= D.SPECIES[p.sp].days; }
// Spojený záhon (#179): všetky záhony spojené stranami so záhonom z (aj z samotný) – priblížený pohľad ich ukáže ako jeden kus
export function groupOf<Z extends BedPos & { id: number }>(list: readonly (BedPos | Z)[], z: Z): Z[] {
  const beds = list.filter((o): o is Z => o.kind === 'zahon' && o.area === z.area), out: Z[] = [z];
  for (let k = 0; k < out.length; k++) {
    const a = out[k];
    if (!a) continue;
    for (const b of beds) if (!out.includes(b) && Math.abs(b.x - a.x) + Math.abs(b.y - a.y) === 1) out.push(b);
  }
  return out;
}
