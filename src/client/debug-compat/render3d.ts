// Len do fázy 5c (#137): ladiaca stránka /debug (záložka World) načíta 3D pohľad hry ako /render3d.mjs a čaká window.Render3D.
// Zbalí sa s Three.js zvonka (/vendor/three/) – /debug a 3D pohľad tak zdieľajú jednu kópiu Three.js. Hra ho nepoužíva.
import { create } from '../render3d.ts';

Object.assign(window, { Render3D: { create } });
export { create };
