// Cheaty zo stránky (#153): tajný kľúč (v sessionStorage, kým je karta otvorená) a POST /api/debug/cheat.
// Spoločné pre záložky Cheats a Mapa (úprava políčka priamo na mape).
const KEY_STORE = 'mf-cheat-key';
export function cheatKey(): string { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
export function setCheatKey(k: string): void {
  try { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); } catch { /* súkromné okno */ }
}
// Stav sveta v odpovedi (server: CheatHost.status)
export interface CheatStatus { tick: number; speed: number; jump: number | null }
export type CheatBody = Readonly<Record<string, string | number | boolean | null | readonly number[]>>;
// disabled = server cheaty nemá (bez DEBUG_CHEATS_KEY)
export type CheatReply = { ok: true; status: CheatStatus } | { ok: false; error: string; disabled: boolean };
export async function cheat(room: string, body: CheatBody): Promise<CheatReply> {
  try {
    const r = await fetch('/api/debug/cheat', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Cheat-Key': cheatKey() }, body: JSON.stringify({ room, ...body }) });
    const j: unknown = await r.json().catch(() => ({}));
    const err = typeof j === 'object' && j && 'error' in j && typeof j.error === 'string' ? j.error : null;
    if (!r.ok) return { ok: false, error: err || 'HTTP ' + r.status, disabled: r.status === 404 && !!err && err.startsWith('cheats are disabled') };
    return { ok: true, status: j as CheatStatus }; // odpoveď nášho servera (CheatHost.status)
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), disabled: false }; }
}
