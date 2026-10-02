import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = {
  'design-schema': [], 'shared-protocol': ['design-schema'], 'editor-core': ['design-schema'], 'editor-interaction': ['design-schema'],
  'renderer-canvas': ['design-schema', 'editor-core', 'shared-protocol'], storage: ['design-schema', 'shared-protocol'],
  'codex-provider': ['design-schema', 'shared-protocol'],
  'design-generation': ['design-schema', 'shared-protocol', 'editor-core', 'renderer-canvas', 'storage', 'codex-provider'],
  's0-poc': ['shared-protocol', 'design-generation'], desktop: ['design-schema', 'shared-protocol', 'design-generation', 'codex-provider', 'editor-core', 'editor-interaction', 'storage']
};
const errors = [];
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name)));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path.join(directory, entry.name));
  }
  return files;
}
const folders = [['packages/design-schema', 'design-schema'], ['packages/shared-protocol', 'shared-protocol'], ['packages/editor-core', 'editor-core'], ['packages/editor-interaction', 'editor-interaction'], ['packages/renderer-canvas', 'renderer-canvas'], ['packages/storage', 'storage'], ['packages/codex-provider', 'codex-provider'], ['packages/design-generation', 'design-generation'], ['apps/s0-poc', 's0-poc'], ['apps/desktop', 'desktop']];
for (const [folder, layer] of folders) {
  const packagePath = path.join(root, folder, 'package.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(packagePath, 'utf8')); } catch { errors.push(`Missing workspace package: ${folder}`); continue; }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dependency of Object.keys(dependencies).filter((key) => key.startsWith('@miaoma/'))) {
    const target = dependency.slice('@miaoma/'.length);
    if (!allowed[layer].includes(target)) errors.push(`${layer} has a forbidden workspace dependency on ${target}`);
  }
  try {
    for (const file of await walk(path.join(root, folder, 'src'))) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (['electron', 'react', 'react-dom'].includes(specifier) && ['design-schema', 'shared-protocol', 'editor-core', 'editor-interaction', 'renderer-canvas', 'storage', 'codex-provider', 'design-generation'].includes(layer)) errors.push(`${path.relative(root, file)} imports forbidden runtime ${specifier}`);
        if (specifier.startsWith('@miaoma/')) {
          const target = specifier.slice('@miaoma/'.length).split('/')[0];
          if (!allowed[layer].includes(target)) errors.push(`${path.relative(root, file)} imports forbidden workspace layer ${target}`);
        }
      }
    }
  } catch { /* absent source folders are reported from their missing package manifest */ }
}
if (errors.length) { console.error(errors.map((item) => `- ${item}`).join('\n')); process.exitCode = 1; }
else console.log(`Package import boundaries valid (${folders.length} layers).`);
