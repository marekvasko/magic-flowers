// Hľadanie divých semienok v tráve a divé semienka, ktoré „poznajú trh“.
// Stav: room.scav = { index políčka: krok, kedy ho niekto naposledy vyprázdnil } – chýbajúce políčko je plné.
const D = require('./shared/data.js');
const E = require('./engine.js');
const C = D.SCAVENGE, TPD = D.TICKS_PER_DAY;

const WILDISH = { forest: 1, tree: 1, shroom: 1, ring: 1 };
const TRAMPLED = { path: 1, house: 1, hut: 1, stall: 1, well: 1, cauldron: 1, babka: 1 };

// Hľadať sa dá len v neprekopanej tráve
function canSearch(tile) { return !!tile && tile.g === 'grass' && !tile.s; }

// Zásoba semienok políčka 0–1: po prehľadaní je prázdna a za C.refillDays dní sa znova naplní
function fill(room, i) {
  const at = room.scav && room.scav[i];
  if (at == null) return 1;
  return Math.max(0, Math.min(1, (room.tick - at) / (C.refillDays * TPD)));
}
// Okolie: okraj lesa pomáha, udupaná tráva pri cestách a budovách škodí
function tileFactor(tiles, i) {
  const x = i % D.W, y = Math.floor(i / D.W);
  let wild = 0, trampled = false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= D.W || ny >= D.H) continue;
    const g = tiles[ny * D.W + nx].g;
    if (WILDISH[g]) wild++;
    if (TRAMPLED[g]) trampled = true;
  }
  return (1 + C.edge * Math.min(4, wild)) * (trampled ? C.trampled : 1);
}
function timeFactor(min) {
  const h = min / 60;
  for (const [a, b, k] of C.hours) if (h >= a && h < b) return k;
  return 1;
}
function chance(room, i) {
  return Math.min(0.95, C.chance * fill(room, i) * tileFactor(room.tiles, i) * timeFactor(D.minOfTick(room.tick)) * C.seasons[D.seasonOf(D.dayOfTick(room.tick))]);
}
// Políčko je prehľadané – zásoba sa vyprázdni (aj keď sa nič nenašlo)
function empty(room, i) { room.scav = room.scav || {}; room.scav[i] = room.tick; }
// Hod kockou na konci hľadania; vráti, či sa našlo divé semienko
function roll(room, i) {
  const c = chance(room, i);
  empty(room, i);
  return E.rand(room) < c;
}
// Plné políčka netreba pamätať – udrží to uloženie malé
function prune(room) {
  if (!room.scav) return;
  for (const i in room.scav) if (fill(room, i) >= 1) delete room.scav[i];
}

// Druhy, ktoré môžu vyrásť z divého semienka daného obdobia (bez magických a bez tých, čo rastú len na jednej pôde)
function wildCandidates(season) {
  return Object.keys(D.SPECIES).filter(k => { const s = D.SPECIES[k]; return !s.magic && !s.strict && s.seasons.includes(season); });
}
// Druh sa vyberie raz, pri sadení: váha = výkupná cena kvetu v tej chvíli ^ C.priceExp
function pickWild(room, season, priceOf) {
  const list = wildCandidates(season);
  const w = list.map(sp => Math.pow(Math.max(1, priceOf(sp)), C.priceExp));
  let r = E.rand(room) * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < list.length; k++) { r -= w[k]; if (r < 0) return list[k]; }
  return list[list.length - 1];
}

// Klient nesmie vedieť, čo z divého semienka vyrastie, kým nevyklíči
function tileView(t) {
  const p = t.s && t.s.p;
  if (!p || !p.wild) return t;
  return { g: t.g, s: Object.assign({}, t.s, { p: Object.assign({}, p, { sp: 'wild' }) }) };
}

module.exports = { canSearch, fill, tileFactor, timeFactor, chance, empty, roll, prune, wildCandidates, pickWild, tileView };
