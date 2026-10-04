import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const target = path.join(root, 'dist');
await mkdir(target, { recursive: true });
for (const file of ['renderer.html', 'renderer.js', 'renderer.css', 'studio.html', 'studio.css']) await copyFile(path.join(source, file), path.join(target, file));
const flowerSource = path.join(root, 'assets', 'demo', 'flowers');
const flowerTarget = path.join(target, 'assets', 'demo', 'flowers');
await mkdir(flowerTarget, { recursive: true });
for (const file of await readdir(flowerSource)) {
  if (!/^flower-(hero|tulips|roses|dahlias)\.png$/.test(file)) continue;
  await copyFile(path.join(flowerSource, file), path.join(flowerTarget, file));
}
await build({ entryPoints: [path.join(source, 'studio.ts'), path.join(source, 'mcp-wizard.ts')], outdir: target, bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], sourcemap: false });
