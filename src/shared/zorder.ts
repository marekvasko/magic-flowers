// Poradie plôch v 3D pohľade (#160): keď sa dve plochy prekrývajú alebo ležia v jednej rovine (z-fighting – pri
// pohybe kamery by medzi sebou blikali), rozhodne pevná priorita druhu plochy, nie posun geometrie vo výške.
// render3d.ts ju uplatní na materiáloch cez posun hĺbky (polygonOffset): plocha s vyššou prioritou sa pri rovnakej
// hĺbke kreslí navrchu, pri skutočne rozdielnej hĺbke sa nemení nič (posun je len pár najmenších krokov hĺbky).
// Druhy: zem (terén, piesok, chodník) < hladina vody < mólo (lávka) < predmety (kolíky, bójky, laná).
export type SurfaceKind = 'ground' | 'water' | 'dock' | 'prop';
export const SURFACE_PRIORITY: Readonly<Record<SurfaceKind, number>> = { ground: 0, water: 1, dock: 2, prop: 3 };
// Jemné modely podľa druhu (world3d FineInfo.type) – ktoré majú vlastnú prioritu; ostatné sa kreslia ako doteraz
export const FINE_SURFACE: Readonly<Partial<Record<string, SurfaceKind>>> = { dock: 'dock', edge: 'prop' };
// Posun hĺbky pre druh plochy (WebGL polygonOffset: záporný = bližšie ku kamere). Zem bez posunu.
// Len units (najmenšie kroky hĺbky): plochy v jednej rovine majú rovnaký sklon, rozhodne ich pevný posun. Bez factor –
// ten rastie so sklonom plochy voči kamere a pri šikmom pohľade by hladinu vytiahol nad tesne vyššie plochy
// (lekná na plese v horách, 0,01 bloku nad hladinou; v záhrade lekná nie sú).
export const BIAS_UNITS = 8;
export function depthBias(kind: SurfaceKind): { factor: number; units: number } {
  const p = SURFACE_PRIORITY[kind];
  return { factor: 0, units: p ? -BIAS_UNITS * p : 0 };
}
// Ktorá z dvoch plôch v jednej rovine sa nakreslí (pre testy a ladenie): tá s vyššou prioritou, pri rovnosti prvá
export function drawnOf(a: SurfaceKind, b: SurfaceKind): SurfaceKind { return SURFACE_PRIORITY[b] > SURFACE_PRIORITY[a] ? b : a; }
// Druh plochy jemného modelu (null = bez priority, kreslí sa ako doteraz)
export function fineSurface(type: string): SurfaceKind | null { return Object.hasOwn(FINE_SURFACE, type) ? FINE_SURFACE[type] ?? null : null; }
