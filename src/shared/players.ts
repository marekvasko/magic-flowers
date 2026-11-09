// Ostatní hráči na klientovi podľa správy pl (polohy hráčov 10× za sekundu). Zdieľané hrou a testami.
//  - syncOthers(others, list, myId, update): doplní a uprace mapu ostatných hráčov (id → postavička);
//    vlastná postavička medzi nimi nikdy nie je – ani keď pl prišiel skôr ako welcome a vlastné id sme ešte nepoznali (#125).
import type { PlayerView } from './protocol.ts';

// Postavička iného hráča na klientovi: poloha, fáza chôdze, výška a rýchlosť skoku, počítadlo skokov
// (klient si k nej v update doplní cieľ pohybu, vzhľad, emóciu…)
export interface Other { x: number; y: number; phase: number; jz: number; jv: number; j: number }
// Položka zoznamu pl: stačí id, poloha a počítadlo skokov
export type ListedPlayer = Pick<PlayerView, 'id' | 'x' | 'y' | 'j'>;

// update(o, p) prepíše údaje postavičky o z položky zoznamu p (cieľ pohybu, vzhľad, skok…);
// vráti vlastnú položku zo zoznamu (emócia, hľadanie) alebo null.
// Klient si postavičky rozširuje (OtherPlayer v src/client/state.ts) – vtedy novú vyrobí make(p).
export function syncOthers<P extends ListedPlayer>(others: Map<number, Other>, list: readonly P[], myId: number | null | undefined, update?: (o: Other, p: P) => void): P | null;
export function syncOthers<P extends ListedPlayer, O extends Other>(others: Map<number, O>, list: readonly P[], myId: number | null | undefined, update: (o: O, p: P) => void, make: (p: P) => O): P | null;
export function syncOthers<P extends ListedPlayer>(others: Map<number, Other>, list: readonly P[], myId: number | null | undefined, update?: (o: Other, p: P) => void, make?: (p: P) => Other): P | null {
  const seen = new Set<number>();
  let me: P | null = null;
  for (const p of list) {
    if (p.id === myId) { me = p; continue; } // vlastné id nie je v seen – záznam z čias pred welcome nižšie zmizne
    seen.add(p.id);
    let o = others.get(p.id);
    if (!o) { o = make ? make(p) : { x: p.x, y: p.y, phase: 0, jz: 0, jv: 0, j: p.j }; others.set(p.id, o); }
    if (update) update(o, p);
  }
  for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);
  return me;
}
