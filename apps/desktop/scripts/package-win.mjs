import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { copyFile, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '../../..');
const stageRelative = path.join('artifacts', 's5', 'staging');
const stage = path.join(root, stageRelative);
const stageMarker = path.join(stage, '.miaoma-managed-s5-stage');
const markerContents = 'Managed by apps/desktop/scripts/package-win.mjs. Safe to recreate.';
const desktopDist = path.join(root, 'apps', 'desktop', 'dist');
const sidecarDist = path.join(root, 'apps', 'mcp-sidecar', 'dist');
const configPath = path.join(root, 'apps', 'desktop', 'electron-builder.yml');
const packagePath = path.join(root, 'package.json');
const outputDirectory = path.join(root, 'output', 'release');
const builderVersion = '26.15.3';
const electronVersion = '44.5.1';
const builderToolDirectory = path.join(root, 'tmp', 's5-builder');
const builderToolPackagePath = path.join(builderToolDirectory, 'package.json');

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const options = { cwd, env: process.env, encoding: 'utf8', stdio: 'inherit' };
  const result = process.platform === 'win32'
    ? spawnSync(`${command} ${args.map((argument) => `"${argument.replaceAll('"', '""')}"`).join(' ')}`, { ...options, shell: true })
    : spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status ?? 'unknown'}`);
}

function normalizedPath(value) {
  return value.split(path.sep).join('/');
}

function assertBundledRuntime(metadata, outputLabel) {
  const output = Object.values(metadata.outputs).find((entry) => entry.entryPoint && path.basename(entry.entryPoint) === outputLabel);
  if (!output) fail(`esbuild did not report the ${outputLabel} entry point`);
  const unresolved = output.imports
    .filter((entry) => entry.external)
    .map((entry) => entry.path)
    .filter((specifier) => {
      if (specifier === 'electron') return false;
      const unprefixed = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
      return !builtinModules.includes(unprefixed);
    });
  if (unresolved.length) fail(`${outputLabel} has non-built-in runtime imports that would be absent from the installer: ${unresolved.join(', ')}`);
}

async function ensureOwnedStage() {
  try {
    const stageInfo = await lstat(stage);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) fail(`Refusing to replace a non-directory or symlink at ${stage}`);
    let marker;
    try { marker = await readFile(stageMarker, 'utf8'); }
    catch { fail(`Refusing to replace unrecognized data at ${stage}`); }
    if (marker !== markerContents) fail(`Refusing to replace unrecognized data at ${stage}`);
    if (path.resolve(stage).toLowerCase() !== path.resolve(root, 'artifacts', 's5', 'staging').toLowerCase()) fail('The stage path escaped artifacts/s5');
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(stage, { recursive: true });
  await writeFile(stageMarker, markerContents, 'utf8');
}

async function bundle(input, output, label) {
  const result = await build({
    entryPoints: [input],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    metafile: true,
    logLevel: 'info'
  });
  assertBundledRuntime(result.metafile, label);
}

async function ensureBuilderTool() {
  await mkdir(builderToolDirectory, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(builderToolPackagePath, 'utf8'));
    if (existing.name !== 'miaoma-s5-builder-tools' || existing.private !== true) {
      fail(`Refusing to modify the existing package manifest at ${builderToolPackagePath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(builderToolPackagePath, `${JSON.stringify({ name: 'miaoma-s5-builder-tools', version: '0.0.0', private: true }, null, 2)}\n`, 'utf8');
  }

  let installedVersion = '';
  try {
    const installed = JSON.parse(await readFile(path.join(builderToolDirectory, 'node_modules', 'electron-builder', 'package.json'), 'utf8'));
    installedVersion = installed.version;
  } catch { /* Install the pinned local tool below. */ }
  if (installedVersion !== builderVersion) {
    run('npm', [
      'install',
      '--prefix', builderToolDirectory,
      '--no-save',
      '--package-lock=false',
      `electron-builder@${builderVersion}`
    ], root);
  }

  const packageDirectory = path.join(builderToolDirectory, 'node_modules', 'electron-builder');
  const installed = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (installed.version !== builderVersion) fail(`Expected electron-builder ${builderVersion}, found ${installed.version}`);
  const cliRelativePath = typeof installed.bin === 'string' ? installed.bin : installed.bin?.['electron-builder'];
  if (!cliRelativePath) fail(`electron-builder ${builderVersion} does not declare its CLI entry point.`);
  const cliPath = path.resolve(packageDirectory, cliRelativePath);
  if (!(await lstat(cliPath)).isFile()) fail(`electron-builder CLI is missing at ${cliPath}`);
  return cliPath;
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('The S5 installer workflow must run on Windows x64.');

  run('pnpm', ['build:desktop'], root);
  const rootPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  const electronPackage = await realpath(path.join(root, 'node_modules', 'electron'));
  const stageNodeModules = path.join(stage, 'node_modules');
  const stageElectron = path.join(stageNodeModules, 'electron');
  await ensureOwnedStage();

  const appPackage = {
    name: 'myfigma-studio',
    version: rootPackage.version,
    productName: 'MyFigma',
    description: 'A local AI-assisted design editor.',
    author: 'MyFigma',
    private: true,
    main: 'apps/desktop/dist/main.js',
    devDependencies: { electron: electronVersion }
  };
  await mkdir(path.join(stage, 'apps', 'desktop', 'dist'), { recursive: true });
  await mkdir(path.join(stage, 'apps', 'mcp-sidecar', 'dist'), { recursive: true });
  await mkdir(stageNodeModules, { recursive: true });
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`, 'utf8');
  try {
    const existingElectron = await lstat(stageElectron);
    if (!existingElectron.isSymbolicLink() || await realpath(stageElectron) !== electronPackage) {
      fail(`Refusing to replace an unexpected Electron package entry at ${stageElectron}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(electronPackage, stageElectron, 'junction');
  }

  await bundle(path.join(desktopDist, 'main.js'), path.join(stage, 'apps', 'desktop', 'dist', 'main.js'), 'main.js');
  await bundle(path.join(desktopDist, 'preload.js'), path.join(stage, 'apps', 'desktop', 'dist', 'preload.js'), 'preload.js');
  await bundle(path.join(sidecarDist, 'stdio.js'), path.join(stage, 'apps', 'mcp-sidecar', 'dist', 'stdio.js'), 'stdio.js');

  for (const asset of ['renderer.html', 'renderer.js', 'renderer.css', 'studio.html', 'studio.js', 'studio.css']) {
    await copyFile(path.join(desktopDist, asset), path.join(stage, 'apps', 'desktop', 'dist', asset));
  }
  const flowerAssetDirectory = path.join(desktopDist, 'assets', 'demo', 'flowers');
  const stagedFlowerAssetDirectory = path.join(stage, 'apps', 'desktop', 'dist', 'assets', 'demo', 'flowers');
  await mkdir(stagedFlowerAssetDirectory, { recursive: true });
  for (const asset of ['flower-hero.png', 'flower-tulips.png', 'flower-roses.png', 'flower-dahlias.png']) {
    await copyFile(path.join(flowerAssetDirectory, asset), path.join(stagedFlowerAssetDirectory, asset));
  }

  const electronExe = path.join(electronPackage, 'dist', 'electron.exe');
  if (!(await lstat(electronExe)).isFile()) fail(`Electron ${electronVersion} Windows x64 runtime is missing at ${electronExe}`);

  await mkdir(outputDirectory, { recursive: true });
  const expectedConfig = await readFile(configPath, 'utf8');
  if (!expectedConfig.includes(normalizedPath(stageRelative))) fail('electron-builder.yml does not point to the controlled staging directory');
  if (!expectedConfig.includes('output/release')) fail('electron-builder.yml does not point to output/release');
  const builderCli = await ensureBuilderTool();
  run(process.execPath, [
    builderCli,
    '--projectDir', root,
    '--config', configPath,
    '--win',
    '--x64',
    '--publish', 'never'
  ], root);

  const smoke = spawnSync(process.execPath, [
    path.join(scriptDirectory, 'installer-smoke.mjs'),
    '--output-dir', outputDirectory
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (smoke.error) throw smoke.error;
  if (smoke.status !== 0) {
    if (smoke.stdout) process.stdout.write(smoke.stdout);
    if (smoke.stderr) process.stderr.write(smoke.stderr);
    fail(`Installer smoke failed with status ${smoke.status ?? 'unknown'}`);
  }
  if (smoke.stdout) process.stdout.write(smoke.stdout);

  const stageMarkerCheck = await readFile(stageMarker, 'utf8');
  if (stageMarkerCheck !== markerContents) fail('The managed staging marker changed during packaging; preserving the directory.');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
