import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactRoot = path.join(root, 'artifacts', 's5-poc');
const s2Root = path.join(root, 'artifacts', 's2-poc');
const runRoot = path.join(artifactRoot, `run-${Date.now()}-${process.pid}`);
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const mainPath = path.join(root, 'apps', 'desktop', 'dist', 'main.js');
const externalClientPath = path.join(root, 'apps', 'mcp-sidecar', 'test', 's5-workflow-client.mjs');
await mkdir(runRoot, { recursive: true });

function processExited(child) { return child.exitCode !== null || child.signalCode !== null; }

async function stopProcessTree(child) {
  if (!child.pid) return true;
  if (process.platform === 'win32') {
    if (processExited(child)) return true;
    const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    if (stopped.error || stopped.status !== 0) {
      if (!processExited(child)) child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
      return false;
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    return processExited(child);
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGTERM'); }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGKILL'); }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    try { process.kill(-child.pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: 'inherit', ...options });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void stopProcessTree(child).then((stopped) => reject(new Error(stopped ? `${path.basename(command)} exceeded 120 seconds` : `${path.basename(command)} timed out and process-tree cleanup could not be confirmed`)));
    }, 120_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void stopProcessTree(child).then((stopped) => reject(new Error(stopped ? `${path.basename(command)} exceeded 100 seconds` : `${path.basename(command)} timed out and process-tree cleanup could not be confirmed`)));
    }, 100_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} exited with code ${code ?? 'null'} (${signal ?? 'no signal'}): ${stderr.slice(-2000)}`));
    });
  });
}

const previousRuns = new Set(await readdir(s2Root).catch(() => []));
await run(process.execPath, [path.join(root, 'apps', 'desktop', 'scripts', 's2-poc.mjs')]);
const currentRuns = (await readdir(s2Root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !previousRuns.has(entry.name))
  .map((entry) => path.join(s2Root, entry.name));
if (currentRuns.length !== 1) throw new Error(`Expected exactly one new S2 acceptance run, found ${currentRuns.length}`);
const s2RunRoot = currentRuns[0];
const s2Result = JSON.parse(await readFile(path.join(s2RunRoot, 's2-result.json'), 'utf8'));
if (s2Result.s2Poc !== 'passed') throw new Error('The S2 create/generate/edit acceptance did not pass');
for (const value of [s2Result.variantProjectId, s2Result.variantDocumentId]) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new Error('S2 result contains an invalid project identity');
}

const isolatedUserData = path.join(s2RunRoot, 'user-data');
await writeFile(path.join(isolatedUserData, 'active-project.json'), `${JSON.stringify({ projectId: s2Result.variantProjectId, documentId: s2Result.variantDocumentId }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

const electron = spawn(electronExecutable, [mainPath, '--s5-poc'], {
  cwd: root,
  env: { ...process.env, MIAOMA_S2_POC_DIR: s2RunRoot, MIAOMA_S5_POC_DIR: runRoot },
  detached: process.platform !== 'win32',
  stdio: 'inherit',
  windowsHide: true
});
let electronExit = null;
electron.once('error', (error) => { electronExit = error; });
electron.once('exit', (code, signal) => { electronExit = { code, signal }; });

const readyPath = path.join(runRoot, 'ready.json');
const clientResultPath = path.join(runRoot, 'client-result.json');
const electronResultPath = path.join(runRoot, 's5-result.json');
const waitFor = async (file, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch {
      if (electronExit instanceof Error) throw electronExit;
      if (electronExit && electronExit.code !== 0) throw new Error(`Electron exited with code ${electronExit.code ?? 'null'} (${electronExit.signal ?? 'no signal'})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
};

try {
  const ready = await waitFor(readyPath, 45_000);
  if (ready.documentId !== s2Result.variantDocumentId || ready.projectId !== s2Result.variantProjectId || ready.savedRevision !== ready.revision) throw new Error('The opened/edited project did not match the S2 candidate copy or durable revision');
  await runCapture(process.execPath, [externalClientPath, readyPath, clientResultPath]);
  const clientResult = JSON.parse(await readFile(clientResultPath, 'utf8'));
  if (clientResult.s5ExternalClient !== 'passed') throw new Error(clientResult.error ?? 'The MCP external client acceptance failed');
  const finalResult = await waitFor(electronResultPath, 15_000);
  if (finalResult.s5Poc !== 'passed') throw new Error(finalResult.error ?? 'The S5 Electron acceptance failed');
  await new Promise((resolve, reject) => {
    if (electronExit) return electronExit.code === 0 ? resolve() : reject(new Error(`Electron exited with code ${electronExit.code ?? 'null'}`));
    const timeout = setTimeout(() => reject(new Error('Electron did not close after S5 acceptance')), 15_000);
    electron.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Electron exited with code ${code ?? 'null'}`)); });
  });
  const report = { ...finalResult, s2RunRoot, s5RunRoot: runRoot, artifactFile: path.join(runRoot, 's5-result.json') };
  await writeFile(path.join(runRoot, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const stopped = await stopProcessTree(electron);
  const failure = { s5Poc: 'failed', error: error instanceof Error ? error.message : 'Unknown S5 POC failure', s2RunRoot, s5RunRoot: runRoot };
  if (!stopped) failure.error += '; process-tree cleanup could not be confirmed';
  await writeFile(path.join(runRoot, 'summary.json'), `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  throw error;
}
