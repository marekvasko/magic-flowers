// Len do fázy 5c (#137): ladiaca stránka /debug (Assets, World) načíta kresby hry ako /art.js a čaká window.Art. Hra ho nepoužíva.
import { Art } from '../art.ts';

Object.assign(window, { Art });
