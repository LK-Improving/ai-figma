import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runDirectory = path.join(root, 'artifacts', 's2-poc', `run-${Date.now()}-${process.pid}`);
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
const mainPath = path.join(root, 'apps', 'desktop', 'dist', 'main.js');
await mkdir(runDirectory, { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [electronCli, mainPath, '--s2-poc'], {
    cwd: root,
    env: { ...process.env, MIAOMA_S2_POC_DIR: runDirectory },
    stdio: 'inherit',
    windowsHide: true
  });
  const timeout = setTimeout(() => child.kill(), 90_000);
  child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else reject(new Error(`Electron S2 POC exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`));
  });
});

const result = JSON.parse(await readFile(path.join(runDirectory, 's2-result.json'), 'utf8'));
if (result.s2Poc !== 'passed') throw new Error(result.error ?? 'S2 POC did not pass');
console.log(JSON.stringify({ ...result, artifactDirectory: runDirectory }, null, 2));
