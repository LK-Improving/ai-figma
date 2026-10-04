import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runDirectory = path.join(root, 'artifacts', 's6-poc', `run-${Date.now()}-${process.pid}`);
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const mainPath = path.join(root, 'apps', 'desktop', 'dist', 'main.js');
await mkdir(runDirectory, { recursive: true });

function processExited(child) { return child.exitCode !== null || child.signalCode !== null; }

async function stopProcessTree(child) {
  if (!child.pid || processExited(child)) return true;
  if (process.platform === 'win32') {
    const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    if (stopped.error || stopped.status !== 0) {
      if (!processExited(child)) child.kill();
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      return processExited(child);
    }
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    return processExited(child);
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGTERM'); }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') child.kill('SIGKILL'); }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  try { process.kill(-child.pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

await new Promise((resolve, reject) => {
  const child = spawn(electronExecutable, [mainPath, '--s6-poc'], {
    cwd: root,
    env: { ...process.env, MYFIGMA_S6_POC_DIR: runDirectory },
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopProcessTree(child).then((stopped) => reject(new Error(stopped
      ? 'Electron S6 POC exceeded 90 seconds'
      : 'Electron S6 POC timed out and process-tree cleanup could not be confirmed')));
  }, 90_000);
  child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (timedOut) return;
    if (code === 0) resolve();
    else reject(new Error(`Electron S6 POC exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`));
  });
});

const result = JSON.parse(await readFile(path.join(runDirectory, 's6-result.json'), 'utf8'));
if (result.s6Poc !== 'passed') throw new Error(result.error ?? 'S6 POC did not pass');
console.log(JSON.stringify({ ...result, artifactDirectory: runDirectory }, null, 2));
