// Plochy sveta (záhrada, hory, Les na pomedzí, Les divov): políčka každej plochy, hranice, prechody a príchodové miesta.
// Čisté funkcie nad stavom sveta (room) – server ich len volá.
// room.tiles = záhrada, room.hory = hory (ice.js), room.pomedzie = Les na pomedzí (len zo semienka room.pomedzieSeed),
// room.les = Les divov (rozloženie zo semienka room.lesSeed, uložené so svetom – saveLes / loadLes)
const crypto = require('crypto');
const D = require('../shared/data.ts');

const AREA_TILES = { hory: 'hory', pomedzie: 'pomedzie', les: 'les' };
function areaTiles(room, area) { return room[AREA_TILES[area] || 'tiles']; }
function newSeed() { return crypto.randomBytes(4).readUInt32LE(0); }

// Les na pomedzí sa nemení – rozloženie je celé zo semienka sveta, uloží sa len semienko.
function loadPomedzie(seed) { return D.buildPomedzie(seed).map(g => ({ g })); }

// Les divov sa ukladá celý (jeden znak na políčko) – rozloženie sveta ostane rovnaké, aj keď sa generátor neskôr zmení.
// Neplatné alebo chýbajúce uloženie → rozloženie zo semienka.
const LES_CODE = D.LES_CODE;
function saveLes(room) { return room.les.map(t => LES_CODE[t.g]).join(''); }
function loadLes(saved, seed) { return (D.decodeLes(saved) || D.buildLes(seed)).map(g => ({ g })); }

// Je políčko (x, y) na ploche?
function inside(area, x, y) { const { w, h } = D.areaSize(area); return x >= 0 && y >= 0 && x < w && y < h; }
// Poloha hráča vždy vnútri plochy (kúsok od okraja) – z mriežky sa vyjsť nedá
function clampPos(area, x, y) {
  const { w, h } = D.areaSize(area);
  return { x: Math.max(0.2, Math.min(w - 0.2, x)), y: Math.max(0.2, Math.min(h - 0.2, y)) };
}

// Na ktorom prechode stojí hráč: vráti cieľovú plochu, alebo null.
function gateTarget(tiles, area, x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inside(area, tx, ty)) return null;
  if (tiles[ty * D.areaSize(area).w + tx].g !== 'gate') return null;
  const g = D.gateAt(area, tx, ty);
  return g ? g.to : null;
}

module.exports = { areaTiles, newSeed, loadPomedzie, LES_CODE, saveLes, loadLes, inside, clampPos, gateTarget };
