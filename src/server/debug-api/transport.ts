// Ladiaca stránka /debug, záložka Transport (#161): fúrik a sane, mólo a loďka, kto ich používa a ďalšie udalosti dopravy.
//   GET /api/debug/transport?room=<id>  – prehľad zo sveta (z pamäte alebo zo súboru); len číta kópiu sveta
import * as Vehicles from '../vehicles.ts';
import * as Transport from '../transport.ts';
import type { TransportView } from '../transport.ts';
import type { Tools } from '../debug.ts';

export type TransportApi = TransportView & { room: string; source: 'memory' | 'file'; online: { name: string; area: string; player: string }[] };
export default function transport(query: URLSearchParams, tools: Pick<Tools, 'load'>): TransportApi | null {
  const r = tools.load(query.get('room'));
  if (!r) return null;
  const st = r.state, tick = typeof st.tick === 'number' ? st.tick : 0;
  return { room: r.id, source: r.source, online: r.online, ...Transport.overview(st, Vehicles.parseVehicles(st['vehicles'], true, tick)) };
}
