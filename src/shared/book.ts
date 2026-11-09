// Kniha objednávok na trhu (#112) – pravidlá spoločné pre server (src/server/market.ts) a klienta (src/client/game.ts):
// čo sa v knihe obchoduje, limit otvorených objednávok, kroky štyroch tlačidiel a prechod knihou pre okamžitý nákup či predaj.
import * as D from './data.ts';
import type { ItemId } from './data.ts';

// Objednávka platí 3 herné dni (ponuka kvetov najviac dovtedy, kým najstarší kvet nezvädne)
export const ORDER_DAYS = 3;
// Najviac otvorených objednávok podľa úrovne reputácie 0–4: 2, 3, 4, 5, 6
export function orderLimit(rep: number): number { return 2 + D.repLevel(rep); }
// Štyri tlačidlá Dopyt / Ponuka: násobky ceny okamžitého obchodu (zľava doprava)
export const STEPS: readonly number[] = [0.8, 0.9, 1.1, 1.2];
// Starnutie priority: objednávka, ktorá čaká, sa pri výbere posúva dopredu o AGING.perDay mince za deň čakania,
// najviac o AGING.max. Mení len poradie výberu – nikdy limitnú cenu, zálohu ani cenu obchodu (tá je vždy limit čakajúcej objednávky).
export const AGING = { perDay: 0.5, max: 1.5 } as const;
export function aging(ageTicks: number): number { return Math.min(AGING.max, Math.max(0, ageTicks) / D.TICKS_PER_DAY * AGING.perDay); }

// Tovar s knihou: semienka a kvety pestovateľných druhov a kompost. Elixíry, zvädnuté kvety, ľad a čarovné semienka
// trh vykupuje za pevnú cenu mimo knihy.
export function isBookItem(id: string): id is ItemId {
  if (id === 'compost') return true;
  const sp = D.speciesOfItem(id);
  return !!sp && !D.SPECIES[sp].magic && (id.startsWith('seed_') || id.startsWith('fl_'));
}
export const isFlowerItem = (id: string): boolean => id.startsWith('fl_');

// Úroveň knihy pre klienta: cena za kus, kusy, kto (meno; '' = veľkoobchodník), čerstvosť najstaršieho kvetu ponuky (0–1)
// a f = 1, ak kupujúci platí podľa čerstvosti (postavy vykupujú kvety ako doteraz trh: cena × čerstvosť).
export interface Level { p: number; n: number; w: string; fr?: number; f?: 1 }
// Cena n-tého kusu pri predaji kvetu postave: limit × čerstvosť kusu, aspoň 1
export const freshPay = (p: number, fresh: number): number => Math.max(1, Math.round(p * fresh));

// Prechod knihou pre okamžitý obchod n kusov (úrovne v poradí priority, ako ich poslal server).
// fresh(i) = čerstvosť i-teho predávaného kusu (len pri predaji kvetov). Vráti, koľko kusov sa dá vybaviť, súčet mincí,
// najhoršiu cenu za kus (limit okamžitého príkazu) a kto je prvý protivník.
export function walk(levels: readonly Level[], n: number, fresh?: (i: number) => number): { n: number; total: number; worst: number; first: string | null } {
  let got = 0, total = 0, worst = 0, first: string | null = null;
  for (const l of levels) {
    if (got >= n) break;
    const k = Math.min(l.n, n - got);
    if (first === null) first = l.w;
    for (let i = 0; i < k; i++) total += l.f && fresh ? freshPay(l.p, fresh(got + i)) : l.p;
    got += k; worst = l.p;
  }
  return { n: got, total, worst, first };
}
// Limitná cena za kus pre tlačidlo s násobkom f, keď okamžitý obchod stojí v priemere avg za kus.
// Celé mince: nižšie tlačidlá zaokrúhľujú nadol, vyššie nahor, aby sa od okamžitej ceny naozaj líšili; aspoň 1.
export function stepPrice(avg: number, f: number): number { return Math.max(1, f < 1 ? Math.floor(avg * f) : Math.ceil(avg * f)); }
