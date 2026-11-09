// Ladiaca stránka /debug (#137): spoločné pre shell (debug.ts) a záložky (tabs/*.ts) – tvorba prvkov, kontext záložky
// a typy odpovedí servera. Texty sú po anglicky (nástroj pre správcu).
import type * as D from '../shared/data.ts';
import type { RoomInfo, RoomSnapshot } from '../server/debug.ts';

// Dieťa prvku: uzol, text (aj číslo), pole detí; null, undefined a false sa vynechajú (true sa vypíše ako text)
export type Kid = Node | string | number | boolean | null | undefined | readonly Kid[];
// Atribúty: onclick je obsluha kliknutia, ostatné sa nastavia ako atribút (null, undefined a false = bez atribútu)
export type Attrs = { onclick?: ((e: MouseEvent) => void) | null; [attr: string]: string | number | boolean | ((e: MouseEvent) => void) | null | undefined };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (typeof v === 'function') { if (k === 'onclick') el.onclick = v; }
    else if (v != null && v !== false) el.setAttribute(k, String(v));
  }
  const add = (c: Kid): void => {
    if (c == null || c === false) return;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') el.appendChild(document.createTextNode(String(c)));
    else if (c instanceof Node) el.appendChild(c);
    else for (const x of c) add(x);
  };
  for (const c of kids) add(c);
  return el;
}

// Formátovanie spoločné pre záložky (čas hry, veľkosť, krátky JSON…)
export interface Fmt {
  when: (tick: number) => string; hhmm: (min: number) => string; inTicks: (dt: number) => string;
  ago: (ms: number | null | undefined) => string; size: (n: number | null | undefined) => string; short: (v: unknown) => string;
  SEASON_EN: readonly string[];
}
// Kontext záložky: vybraný svet a plocha, jeho stav (snap), zoznam svetov, parametre v adrese a volanie API
export interface TabCtx {
  room: string; area: D.AreaId; snap: RoomSnapshot | null; rooms: RoomInfo[];
  h: typeof h; D: typeof D; fmt: Fmt;
  api: <T>(path: string) => Promise<T>;
  param: (k: string) => string | null;
  setParam: (k: string, v: string | number | boolean | null | undefined) => void;
  setArea: (a: string) => void;
}
// Záložka: mount(el, ctx) → { update?(ctx), unmount?() }; update príde pri zmene sveta, plochy alebo po obnovení
export interface TabInstance { update?: (ctx: TabCtx) => void; unmount?: () => void }
export interface TabModule { mount: (el: HTMLElement, ctx: TabCtx) => TabInstance | undefined }

// Chyba z hocičoho (catch) ako text
export const errText = (e: unknown): string => e instanceof Error ? e.message : String(e);
