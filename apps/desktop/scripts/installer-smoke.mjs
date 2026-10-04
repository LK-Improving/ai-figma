import { spawnSync } from 'node:child_process';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const outputArgument = args.indexOf('--output-dir');
if (outputArgument < 0 || !args[outputArgument + 1]) throw new Error('Usage: node installer-smoke.mjs --output-dir <directory>');

const outputDirectory = path.resolve(args[outputArgument + 1]);
const expectedOutputRoot = path.resolve(root, 'output', 'release');
if (outputDirectory.toLowerCase() !== expectedOutputRoot.toLowerCase()) throw new Error('Refusing to inspect an output directory outside output/release.');

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const installerName = `MyFigma-${rootPackage.version}-win-x64.exe`;
const installerPath = path.join(outputDirectory, installerName);
const unpacked = path.join(outputDirectory, 'win-unpacked');
const appDirectory = path.join(unpacked, 'resources', 'app');
const appExe = path.join(unpacked, 'MyFigma.exe');
const mainPath = path.join(appDirectory, 'apps', 'desktop', 'dist', 'main.js');
const sidecarPath = path.join(appDirectory, 'apps', 'mcp-sidecar', 'dist', 'stdio.js');

async function assertFile(file, minimumBytes = 1) {
  const details = await stat(file);
  if (!details.isFile() || details.size < minimumBytes) throw new Error(`Expected packaged file is missing or too small: ${file}`);
  return details;
}

const installer = await assertFile(installerPath, 10 * 1024 * 1024);
const installerHandle = await open(installerPath, 'r');
try {
  const dosHeader = Buffer.alloc(64);
  await installerHandle.read(dosHeader, 0, dosHeader.length, 0);
  if (dosHeader.toString('ascii', 0, 2) !== 'MZ') throw new Error('The NSIS installer does not have a Windows PE header.');
  const peOffset = dosHeader.readUInt32LE(0x3c);
  const signature = Buffer.alloc(4);
  await installerHandle.read(signature, 0, signature.length, peOffset);
  if (signature.toString('ascii') !== 'PE\0\0') throw new Error('The NSIS installer PE signature is invalid.');
} finally {
  await installerHandle.close();
}

const appExecutable = await assertFile(appExe, 10 * 1024 * 1024);
const main = await assertFile(mainPath, 100 * 1024);
const preload = await assertFile(path.join(appDirectory, 'apps', 'desktop', 'dist', 'preload.js'), 1_000);
const sidecar = await assertFile(sidecarPath, 10 * 1024);
for (const asset of ['renderer.html', 'renderer.js', 'renderer.css', 'studio.html', 'studio.js', 'studio.css']) {
  await assertFile(path.join(appDirectory, 'apps', 'desktop', 'dist', asset), 1);
}
for (const asset of ['flower-hero.png', 'flower-tulips.png', 'flower-roses.png', 'flower-dahlias.png']) {
  await assertFile(path.join(appDirectory, 'apps', 'desktop', 'dist', 'assets', 'demo', 'flowers', asset), 1_000_000);
}

const metadata = JSON.parse(await readFile(path.join(appDirectory, 'package.json'), 'utf8'));
if (metadata.main !== 'apps/desktop/dist/main.js' || metadata.version !== rootPackage.version) throw new Error('The packaged application metadata is inconsistent.');
if (await stat(path.join(appDirectory, 'app.asar')).then(() => true, () => false)) throw new Error('The app unexpectedly uses ASAR; the external Node sidecar must be a physical file.');
const mainSource = await readFile(mainPath, 'utf8');
const sidecarSource = await readFile(sidecarPath, 'utf8');
if (/\b(?:require\s*\(|from\s*)['"]@miaoma\//.test(mainSource) || /\b(?:require\s*\(|from\s*)['"](?:@miaoma|@modelcontextprotocol)\//.test(sidecarSource)) {
  throw new Error('Workspace or MCP SDK imports remain external instead of being bundled.');
}

const expectedSidecar = path.resolve(path.dirname(mainPath), '..', '..', 'mcp-sidecar', 'dist', 'stdio.js');
if (expectedSidecar !== sidecarPath) throw new Error('The packaged Sidecar location does not match the Main process runtime lookup.');

const sidecarProbe = spawnSync(process.execPath, [sidecarPath, '--invalid-packaging-smoke-argument'], { encoding: 'utf8', timeout: 10_000 });
if (sidecarProbe.error) throw sidecarProbe.error;
if (sidecarProbe.status !== 1 || !sidecarProbe.stderr.includes('The request contains an invalid argument.')) {
  throw new Error(`The packaged Sidecar failed its startup/import probe: ${sidecarProbe.stderr || sidecarProbe.stdout || `exit ${sidecarProbe.status}`}`);
}

const outputEntries = await readdir(outputDirectory);
if (!outputEntries.includes(installerName) || !outputEntries.includes('win-unpacked')) throw new Error('electron-builder did not emit both NSIS and directory targets.');

process.stdout.write(`${JSON.stringify({
  smoke: 'passed',
  installer: installerPath,
  installerBytes: installer.size,
  unpackedExecutableBytes: appExecutable.size,
  mainBundleBytes: main.size,
  preloadBundleBytes: preload.size,
  sidecarBundleBytes: sidecar.size,
  runtimeImports: 'workspace packages and MCP SDK bundled; only Node built-ins remain external',
  sidecarLayout: 'matches the Main process relative lookup',
  installerInstallExecuted: false
}, null, 2)}\n`);
