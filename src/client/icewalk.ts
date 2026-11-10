// Chôdza po ľade na klientovi (#157): klient pohyb predpovedá presne tou istou fyzikou ako server (src/shared/icewalk.ts):
// hodiny v celých ms (rovnaké čísla idú serveru ako ts), vstup na dve desatinné miesta a zmeny vstupu s časom (in),
// presný integrál po úsekoch (IW.advance). Server tak počíta to isté a opravu posiela len výnimočne (náraz inde, pošmyknutie).
// Opravu klient nikdy nepreskočí: prepočíta svoje snímky od času opravy (ts) a rozdiel dobehne plynulo počas pár snímok.
// O pošmyknutí rozhoduje server; prepadnutie cez otvor a roztopenie ľadu klient predpovie hneď (server ho potvrdí).
import * as IW from '../shared/icewalk.ts';
import type { IceTile, Seg, Slider } from '../shared/icewalk.ts';
import type { ServerMessage } from '../shared/protocol.ts';
type IwMsg = Extract<ServerMessage, { t: 'iw' }>; // bez state.ts – modul testuje aj Node (bez DOM)

// Snímka: úsek (t0, t] v ms klienta, vstup, či šlo o šmýkanie, poloha na konci a koľko opravy sa v nej dobehlo
export interface Frame { t0: number; t: number; ix: number; iy: number; ice: boolean; x: number; y: number; cx: number; cy: number }
// Stav vlastnej postavičky: do kedy leží / čľapká (performance.now ms), či pláva, kedy sa začala póza (animácia),
// predpovedané prepadnutie (čaká na server), hodiny fyziky, snímky a zmeny vstupu za poslednú sekundu,
// zvyšok opravy (dobieha sa) a veľkosti prijatých opráv (ladenie: MF.ice.corr)
export interface IceClient {
  fallUntil: number; swim: boolean; hinted: boolean; poseAt: number; pose: Pose; pred: number;
  lastT?: number; frames: Frame[]; segs: Seg[]; pend: { x: number; y: number }; corr: number[];
}
export type Pose = 'fall' | 'swim' | null;
export type IceMode = 'fall' | 'swim' | 'ice' | null;
// Postavička, ktorej sa krok týka (S.me): poloha a hybnosť
interface Body { x: number; y: number; vx?: number | undefined; vy?: number | undefined }
const BLEND_S = 0.12; // oprava sa dobehne zhruba za trojnásobok (≈ 0,35 s)
const SNAP = 2.5;     // väčší skok je presun (cheat, prechod) – ten sa nedobieha
const BLEND_V = 1.6;  // oprava (aj skĺznutie do otvoru) sa dobieha najviac takto rýchlo (políčka/s)
const POSE_MS = 400;  // pád na zem a ponorenie do vody trvajú toľko

export function create(): IceClient {
  return { fallUntil: 0, swim: false, hinted: false, poseAt: 0, pose: null, pred: 0, frames: [], segs: [], pend: { x: 0, y: 0 }, corr: [] };
}

// Hodiny fyziky: celé ms (ako ts v správe move). Vráti [začiatok, koniec, dt v s] úseku tohto snímku (najviac ICE.dtMax).
export function clock(st: IceClient, now: number): [number, number, number] {
  const t = Math.round(now), t0 = st.lastT === undefined ? t : Math.max(st.lastT, t - IW.ICE.dtMax * 1000);
  st.lastT = t;
  return [t0, t, (t - t0) / 1000];
}
// Vstup tohto snímku (už zaokrúhlený): pri zmene sa zapíše [od, ix, iy]; staré zmeny sa zahodia (posledná staršia ostane)
export function input(st: IceClient, t0: number, ix: number, iy: number): void {
  const last = st.segs[st.segs.length - 1];
  if (!last || last[1] !== ix || last[2] !== iy) st.segs.push([t0, ix, iy]);
  const old = t0 - IW.ICE.segMs;
  while (st.segs.length > 1 && (st.segs[1]?.[0] ?? Infinity) <= old) st.segs.shift();
}
// Úsek šmýkania (presný integrál, náraz po osiach) – ten istý výpočet, aký urobí server
export function slide(me: Body, ix: number, iy: number, dt: number, ok: (x: number, y: number) => boolean): void {
  const b: Slider = { x: me.x, y: me.y, vx: me.vx || 0, vy: me.vy || 0 };
  IW.slideStep(b, ix, iy, dt, ok);
  me.x = b.x; me.y = b.y; me.vx = b.vx; me.vy = b.vy;
}
// Koniec snímku: dobehne kus opravy a zapíše snímku (na prepočet po oprave)
export function frame(st: IceClient, me: Body, f: Omit<Frame, 'x' | 'y' | 'cx' | 'cy'>): void {
  // kus opravy: exponenciálne, ale najviac BLEND_V políčka/s (aj pri pomalých snímkach je to kĺzanie, nie skok)
  const dt = (f.t - f.t0) / 1000, k = 1 - Math.exp(-dt / BLEND_S), l = Math.hypot(st.pend.x, st.pend.y) * k, cap = BLEND_V * dt;
  const q = l > cap && l > 0 ? cap / l * k : k, cx = st.pend.x * q, cy = st.pend.y * q;
  me.x += cx; me.y += cy; st.pend.x -= cx; st.pend.y -= cy;
  st.frames.push({ ...f, x: me.x, y: me.y, cx, cy });
  while (st.frames.length > 120 || (st.frames.length > 1 && (st.frames[0]?.t ?? 0) < f.t - IW.ICE.segMs)) st.frames.shift();
}

// Správa iw zo servera. ok = kam smie telo (na prepočet). Vráti udalosť pre zvuk.
// Poloha zo servera platí k času ts: na ľade klient zopakuje svoje snímky od ts zo stavu servera, inde porovná so svojou
// polohou v čase ts; rozdiel si nechá dobehnúť (pend) – nikdy neskočí, okrem presunu ďalej než SNAP.
export function onMsg(st: IceClient, me: Body, m: IwMsg, now: number, ok: (x: number, y: number) => boolean): 'fall' | 'splash' | 'out' | null {
  const wasSwim = st.swim, wasDown = st.fallUntil > now, predicted = st.pred > 0;
  st.pred = 0;
  st.fallUntil = m.fall > 0 ? (m.ts !== undefined && m.sw === 0 ? m.ts + m.fall : now + m.fall) : 0; // ležanie na ľade: od ts ako na serveri
  st.swim = !!m.sw;
  if (m.x !== undefined && m.y !== undefined) {
    const ts = m.ts;
    let tx = m.x, ty = m.y, vx = m.vx, vy = m.vy;
    const after = ts === undefined ? [] : st.frames.filter(f => f.t > ts);
    const at = ts === undefined ? undefined : st.frames.find(f => f.t === ts);
    if (ts !== undefined && at && !st.swim && after.every(f => f.ice)) { // prepočet od stavu servera tými istými vstupmi
      const downTo = ts + m.fall, b: Slider = { x: tx, y: ty, vx, vy };
      for (const f of after) span(b, Math.max(f.t0, ts), f.t, downTo, f.ix, f.iy, ok); // ležiaci bez vstupu
      tx = b.x; ty = b.y; vx = b.vx; vy = b.vy;
    } else if (at) { // bez šmýkania: rozdiel v čase ts posunie aj to, kam odvtedy došiel (bez toho, čo sa odvtedy dobehlo)
      const cx = after.reduce((a, f) => a + f.cx, 0), cy = after.reduce((a, f) => a + f.cy, 0);
      tx = me.x + (m.x - at.x) - cx; ty = me.y + (m.y - at.y) - cy;
    }
    const dx = tx - me.x, dy = ty - me.y;
    if (m.why !== 'hole') st.corr.push(Math.round(Math.hypot(dx - st.pend.x, dy - st.pend.y) * 1000) / 1000); // skĺznutie do otvoru nie je chyba predpovede
    if (st.corr.length > 200) st.corr.shift();
    if (Math.hypot(dx, dy) > SNAP) { me.x = tx; me.y = ty; st.pend = { x: 0, y: 0 }; } else st.pend = { x: dx, y: dy };
    me.vx = st.swim ? 0 : vx; me.vy = st.swim ? 0 : vy;
  } else { me.vx = m.vx; me.vy = m.vy; }
  if (st.swim && !wasSwim) return predicted ? null : 'splash';
  if (!st.swim && wasSwim) return 'out';
  return m.fall > 0 && !wasDown && !st.swim ? 'fall' : null;
}
// Prepadnutie predpovedané klientom (otvor, roztopený ľad): hneď stojí a ponára sa; keď ho server do sekundy
// nepotvrdí, predpoveď sa zruší
export function predictFallIn(st: IceClient, me: Body, now: number): void {
  st.swim = true; st.fallUntil = now + IW.ICE.splashS * 1000; st.pred = now;
  me.vx = 0; me.vy = 0;
}
export function expire(st: IceClient, now: number): void {
  if (st.pred && now - st.pred > 1000) { st.pred = 0; st.swim = false; st.fallUntil = 0; }
}

// Režim pohybu: šmýka sa (aj ležiaci – bez vstupu), čľapká alebo leží na zemi → stojí ('fall'), pláva, alebo chôdza (null)
export function mode(st: IceClient, here: IceTile | null | undefined, season: number, now: number): IceMode {
  const down = st.fallUntil > now;
  if (st.swim || IW.openWater(here, season)) return down ? 'fall' : 'swim';
  if (IW.isIce(here, season)) return 'ice';
  return down ? 'fall' : null;
}
export const lying = (st: IceClient, now: number): boolean => st.fallUntil > now && !st.swim;
// Úsek (a, z] ms klienta po tých istých kúskoch ako na serveri (IW.cutsOf: mriežka a koniec ležania fe); do fe bez vstupu
export function span(b: Slider, a: number, z: number, fe: number, ix: number, iy: number, ok: (x: number, y: number) => boolean): void {
  const c = IW.cutsOf(a, z, [fe]);
  for (let k = 0; k + 1 < c.length; k++) {
    const u = c[k] ?? 0, w = c[k + 1] ?? 0, lie = u < fe;
    IW.slideStep(b, lie ? 0 : ix, lie ? 0 : iy, (w - u) / 1000, ok);
  }
}
// Snímka na ľade: ako span, s hybnosťou postavičky (ležanie podľa stavu: fallUntil v ms klienta)
export function slideFrame(st: IceClient, me: Body, t0: number, t: number, ix: number, iy: number, ok: (x: number, y: number) => boolean): void {
  const b: Slider = { x: me.x, y: me.y, vx: me.vx || 0, vy: me.vy || 0 };
  span(b, t0, t, st.swim ? 0 : st.fallUntil, ix, iy, ok);
  me.x = b.x; me.y = b.y; me.vx = b.vx; me.vy = b.vy;
}
// Oprava polohy bez času (správa pos – server pohyb odmietol): malá sa dobehne plynulo, veľká (presun) platí hneď
export function nudge(st: IceClient, me: Body, x: number, y: number): void {
  const dx = x - me.x, dy = y - me.y;
  st.corr.push(Math.round(Math.hypot(dx - st.pend.x, dy - st.pend.y) * 1000) / 1000);
  if (Math.hypot(dx, dy) > SNAP) { me.x = x; me.y = y; st.pend = { x: 0, y: 0 }; } else st.pend = { x: dx, y: dy };
  me.vx = 0; me.vy = 0;
}
// Póza vlastnej postavičky a jej priebeh 0 → 1 (pád, ponorenie)
export function pose(st: IceClient, now: number): [Pose, number] {
  const p: Pose = st.swim ? 'swim' : st.fallUntil > now ? 'fall' : null;
  if (p !== st.pose) { st.pose = p; st.poseAt = now; }
  return [p, Math.min(1, (now - st.poseAt) / POSE_MS)];
}
export const poseK = (at: number | undefined, now: number): number => (at === undefined ? 1 : Math.min(1, (now - at) / POSE_MS));
