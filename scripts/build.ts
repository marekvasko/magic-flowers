// Zostavenie pre prehliadač (#122, #136, #137) – prehliadač .ts nespustí. Dva balíky (ES moduly), každý s kúskami,
// ktoré sa načítajú až pri potrebe:
//  - hra: src/client/game.ts → build/client/game.js; 3D pohľad aj s Three.js je samostatný kúsok (build/client/chunks/),
//    hra ho načíta až po štarte. Server podáva /client/<súbor>.
//  - ladiaca stránka: src/debug/debug.ts → build/debug/debug.js; každá záložka je samostatný kúsok. Server podáva
//    /debug/<súbor> najprv z build/debug/, potom statické súbory stránky z debug/ (index.html, debug.css).
import { build } from 'esbuild';
import type { BuildOptions } from 'esbuild';
import { rmSync } from 'node:fs';

const COMMON: BuildOptions = { bundle: true, target: 'es2022', platform: 'browser', sourcemap: true, legalComments: 'none', logLevel: 'warning', format: 'esm', splitting: true, minify: true };

rmSync('build', { recursive: true, force: true });
await build({ ...COMMON, entryPoints: { game: 'src/client/game.ts' }, outdir: 'build/client', chunkNames: 'chunks/[name]-[hash]' });
await build({ ...COMMON, entryPoints: { debug: 'src/debug/debug.ts' }, outdir: 'build/debug', chunkNames: 'chunks/[name]-[hash]' });
console.log('build: build/client (hra), build/debug (ladiaca stránka)');
