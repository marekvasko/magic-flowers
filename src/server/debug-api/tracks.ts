// Ladiaca stránka /debug (#159): stopy v snehu jedného sveta – len v pamäti servera (neukladajú sa), preto ich nedá
// kópia sveta (tools.load); číta ich priamo z server/tracks.ts. Svet, ktorý nie je načítaný, nemá žiadne stopy.
//   GET /api/debug/tracks?room=<id>&area=<plocha>  – stopy plochy a počty stôp na všetkých plochách
import * as D from '../../shared/data.ts';
import type { AreaId } from '../../shared/data.ts';
import * as T from '../../shared/tracks.ts';
import type { TrackWire } from '../../shared/tracks.ts';
import * as Tracks from '../tracks.ts';
import type { Tools } from '../debug.ts';

export interface TracksView {
  room: string; area: AreaId; loaded: boolean; counts: Record<AreaId, number>; list: TrackWire[];
  cap: number; life: number; snowLife: number; stride: Readonly<Record<T.TrackKind, number>>;
}

export default function tracks(query: URLSearchParams, tools: Pick<Tools, 'ROOM_RE'>): TracksView | null {
  const id = query.get('room') || '';
  if (!tools.ROOM_RE.test(id)) return null;
  const area = D.AREAS.find(a => a === query.get('area')) ?? 'garden';
  const s = Tracks.stores.get(id);
  return {
    room: id, area, loaded: !!s, counts: Tracks.counts(id), list: (s?.areas[area] || []).map(T.encode),
    cap: T.TRACKS.cap, life: T.TRACKS.life, snowLife: T.TRACKS.snowLife, stride: T.TRACKS.stride
  };
}
