// Malé pomocné funkcie pre prísne typy (#122), zdieľané serverom aj klientom.

// Hodnota tabuľky pre kľúč z uloženia alebo zo správy (ľubovoľný reťazec): len vlastné kľúče tabuľky, inak undefined
export function lookup<V>(table: { readonly [key: string]: V | undefined }, key: string): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
// Prvok, ktorý podľa algoritmu určite existuje (index v rozsahu poľa, kľúč z vlastného zoznamu) – inak je to chyba v kóde
export function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('chýba prvok, ktorý musí existovať');
  return v;
}
// Kľúče tabuľky s typom kľúča (Object.keys vracia len string[]); tabuľka smie mať len kľúče typu K
export function keys<K extends string>(o: Readonly<Partial<Record<K, unknown>>>): K[] {
  return Object.keys(o) as K[];
}
// Dvojice [kľúč, hodnota] tabuľky s typom kľúča; chýbajúce (undefined) hodnoty vynechá
export function entries<K extends string, V>(o: Readonly<Partial<Record<K, V>>>): [K, V][] {
  const out: [K, V][] = [];
  for (const k of keys(o)) { const v = o[k]; if (v !== undefined) out.push([k, v]); }
  return out;
}
// Nová tabuľka s tými istými kľúčmi (v tom istom poradí) a hodnotami f(hodnota, kľúč)
export function mapValues<K extends string, A, B>(o: Readonly<Record<K, A>>, f: (a: A, k: K) => B): Record<K, B> {
  const out: Partial<Record<K, B>> = {};
  for (const k of keys(o)) out[k] = f(o[k], k);
  return out as Record<K, B>;
}

// Nedôveryhodný JSON (uloženie zo staršej verzie, správa od klienta) pred overením: objekt s ľubovoľnými kľúčmi.
// Výnimka z prísnych typov – len na čítanie a overenie vstupu, hodnoty sa pred použitím skontrolujú.
export type JsonRecord = { [key: string]: unknown };
export const isRecord = (v: unknown): v is JsonRecord => v !== null && typeof v === 'object';
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
