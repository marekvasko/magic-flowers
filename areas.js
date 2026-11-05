// Plochy sveta (záhrada, hory, Les na pomedzí): políčka každej plochy, hranice, prechody a príchodové miesta.
// Čisté funkcie nad stavom sveta (room) – server ich len volá.
// room.tiles = záhrada, room.hory = hory (ice.js), room.pomedzie = Les na pomedzí (len zo semienka room.pomedzieSeed)
const crypto = require('crypto');
const D = require('./shared/data.js');

function areaTiles(room, area) { return area === 'hory' ? room.hory : area === 'pomedzie' ? room.pomedzie : room.tiles; }
function newSeed() { return crypto.randomBytes(4).readUInt32LE(0); }

// Les na pomedzí sa nemení – rozloženie je celé zo semienka sveta, uloží sa len semienko.
function loadPomedzie(seed) { return D.buildPomedzie(seed).map(g => ({ g })); }

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

module.exports = { areaTiles, newSeed, loadPomedzie, inside, clampPos, gateTarget };
