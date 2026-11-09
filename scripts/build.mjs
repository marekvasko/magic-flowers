// Zostavenie pre prehliadač (#122, #136) – prehliadač .ts nespustí:
//  - hra: src/client/game.ts → build/client/game.js (ES modul); 3D pohľad aj s Three.js je samostatný kúsok
//    (build/client/chunks/), hra ho načíta až po štarte – import('./render3d.ts'). Server podáva /client/<súbor>.
//  - ladiaca stránka /debug (do fázy 5c, #137): zdieľané moduly ako globály (/shared/<meno>.js → build/shared/)
//    a 3D pohľad, pavučiny a kresby hry (/render3d.mjs, /spiders3d.mjs, /art.js → build/debug-compat/), všetko
//    s Three.js zvonka z /vendor/three/, ako ho načítava /debug.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const COMMON = { bundle: true, target: 'es2022', platform: 'browser', sourcemap: true, legalComments: 'none', logLevel: 'warning' };
// 'three' → /vendor/three/three.module.js (len pre /debug, ktorý Three.js načítava sám)
const vendorThree = {
  name: 'vendor-three',
  setup(b) { b.onResolve({ filter: /^three$/ }, () => ({ path: '/vendor/three/three.module.js', external: true })); },
};

const SHARED = [
  { entry: 'src/shared/data.ts', out: 'build/shared/data.js', global: 'GameData' },
  { entry: 'src/shared/world3d.ts', out: 'build/shared/world3d.js', global: 'World3D' },
  { entry: 'src/shared/webs.ts', out: 'build/shared/webs.js', global: 'Webs' },
  { entry: 'src/shared/spidermodel.ts', out: 'build/shared/spidermodel.js', global: 'SpiderModel' },
  { entry: 'src/shared/mesher.ts', out: 'build/shared/mesher.js', global: 'Mesher' },
];

rmSync('build', { recursive: true, force: true });
await build({
  ...COMMON, entryPoints: { game: 'src/client/game.ts' }, outdir: 'build/client', format: 'esm', splitting: true,
  chunkNames: 'chunks/[name]-[hash]', minify: true,
});
for (const m of SHARED) await build({ ...COMMON, entryPoints: [m.entry], outfile: m.out, format: 'iife', globalName: m.global });
await build({
  ...COMMON, entryPoints: { render3d: 'src/client/debug-compat/render3d.ts', spiders3d: 'src/client/spiders3d.ts' },
  outdir: 'build/debug-compat', outExtension: { '.js': '.mjs' }, format: 'esm', plugins: [vendorThree],
});
await build({ ...COMMON, entryPoints: ['src/client/debug-compat/art.ts'], outfile: 'build/debug-compat/art.js', format: 'iife' });
console.log('build: build/client (hra), build/shared + build/debug-compat (/debug do fázy 5c)');
