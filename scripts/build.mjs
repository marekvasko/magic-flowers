// Zbalí zdieľané moduly v TypeScripte pre prehliadač (#122, fáza 2). Klient ešte nie je ES modul, preto
// každý modul je IIFE, ktorý nastaví rovnakú globálnu premennú ako predtým UMD súbor (napr. window.GameData).
// Výstup ide do build/shared/<meno>.js; server ho podáva na /shared/<meno>.js. Vo fáze 5 to nahradí jeden balík klienta.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const SHARED = [
  { entry: 'src/shared/data.ts', out: 'build/shared/data.js', global: 'GameData' },
  { entry: 'src/shared/world3d.ts', out: 'build/shared/world3d.js', global: 'World3D' },
  { entry: 'src/shared/webs.ts', out: 'build/shared/webs.js', global: 'Webs' },
  { entry: 'src/shared/spidermodel.ts', out: 'build/shared/spidermodel.js', global: 'SpiderModel' },
  { entry: 'src/shared/mesher.ts', out: 'build/shared/mesher.js', global: 'Mesher' },
  { entry: 'src/shared/players.ts', out: 'build/shared/players.js', global: 'Players' },
];

rmSync('build', { recursive: true, force: true });
for (const m of SHARED) {
  await build({
    entryPoints: [m.entry], outfile: m.out, bundle: true, format: 'iife', globalName: m.global,
    target: 'es2022', platform: 'browser', sourcemap: true, legalComments: 'none', logLevel: 'warning',
  });
}
console.log('build: ' + SHARED.map(m => m.out).join(', '));
