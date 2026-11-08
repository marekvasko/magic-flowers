// Ladiaca stránka /debug, záložka World (#78): políčka jednej plochy presne tak, ako ich hra pošle hráčovi
// (základ z generátora + uložená pôda, rastliny, ľad a ľadovňa), a hráči na ploche. Len číta kópiu sveta.
//   GET /api/debug/world?room=<id>&area=<plocha>  – svet zo zoznamu
//   GET /api/debug/world?seed=<n>&area=<plocha>   – čerstvý svet len zo semienka (bez hráčov a bez uloženia)
const D = require('../../src/shared/data.js');
const Ice = require('../../src/server/ice.js');
const Areas = require('../../src/server/areas.js');
const Scav = require('../../src/server/scavenge.js');
const { keyId } = require('../../src/server/debug.js');

// Políčka plochy zo (skopírovaného) stavu sveta – rovnako ako getRoom + tilesView v server.js
function areaTiles(state, area) {
  if (area === 'hory') return Ice.loadHory(state.hory);
  if (area === 'pomedzie') return Areas.loadPomedzie(state.pomedzieSeed);
  if (area === 'les') return Areas.loadLes(state.les, state.lesSeed); // uložené rozloženie, inak zo semienka
  const base = D.buildMap(), saved = state.tiles;
  const room = {
    icehouse: state.icehouse,
    tiles: base.map((g, i) => {
      const sv = saved && saved.length === base.length && saved[i];
      const t = { g, s: (sv && sv.s) || null };
      if (g === 'water' && sv && sv.cut) t.cut = 1;
      return t;
    })
  };
  Ice.applyIcehouse(room.icehouse, room.tiles);
  return room.tiles.map(Scav.tileView); // druh divej rastliny ostane skrytý ako v hre
}

module.exports = (query, tools) => {
  const area = D.AREAS.includes(query.get('area')) ? query.get('area') : 'garden';
  const { w, h } = D.areaSize(area);
  const id = query.get('room');
  if (!id) {
    const seed = (parseInt(query.get('seed'), 10) || 0) >>> 0;
    const state = { tiles: null, hory: null, pomedzieSeed: seed, lesSeed: seed, les: null, icehouse: { built: false, ice: 0 } };
    return { room: null, seed, area, w, h, tick: 0, weather: 'sun', tiles: areaTiles(state, area), players: [] };
  }
  const r = tools.load(id);
  if (!r) return null;
  const st = r.state, online = new Map((r.online || []).map(o => [o.player, o]));
  // hráči na tejto ploche: online podľa mena, ostatní len ako posledné miesto, kde boli
  const players = [];
  for (const [key, sv] of Object.entries(st.saves || {})) {
    const o = online.get(keyId(key)) || null;
    const pa = o ? o.area : D.AREAS.includes(sv.area) ? sv.area : 'garden';
    if (pa !== area || typeof sv.x !== 'number' || typeof sv.y !== 'number') continue;
    players.push({ id: key, name: o ? o.name : null, online: !!o, x: sv.x, y: sv.y, look: sv.look || null });
  }
  return { room: r.id, source: r.source, seed: area === 'les' ? st.lesSeed : st.pomedzieSeed, area, w, h, tick: st.tick || 0, weather: st.weather || 'sun', tiles: areaTiles(st, area), players };
};
