import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runDirectory = path.join(root, 'artifacts', 's1-poc', `run-${Date.now()}-${process.pid}`);
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
const mainPath = path.join(root, 'apps', 'desktop', 'dist', 'main.js');
await mkdir(runDirectory, { recursive: true });

function runElectron(mode, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [electronCli, mainPath, mode], {
      cwd: root,
      env: { ...process.env, MIAOMA_S1_POC_DIR: runDirectory, ...extraEnv },
      stdio: 'inherit',
      windowsHide: true
    });
    const timeout = setTimeout(() => child.kill(), 90_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Electron ${mode} exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`));
    });
  });
}

await runElectron('--s1-poc-write');
const writeResult = JSON.parse(await readFile(path.join(runDirectory, 'write-result.json'), 'utf8'));
if (writeResult.s1Poc === 'failed') throw new Error(writeResult.error);
const exportPath = writeResult.export?.exportPath;
if (!exportPath) throw new Error('The PNG export did not produce a portable package path');
await runElectron('--s1-poc-reopen', { MIAOMA_S1_IMPORT_PACKAGE: exportPath });
const reopenResult = JSON.parse(await readFile(path.join(runDirectory, 'reopen-result.json'), 'utf8'));
if (reopenResult.s1Poc === 'failed') throw new Error(reopenResult.error);
await runElectron('--s1-poc-project-reopen');
const projectReopenResult = JSON.parse(await readFile(path.join(runDirectory, 'project-reopen-result.json'), 'utf8'));
if (projectReopenResult.s1Poc === 'failed') throw new Error(projectReopenResult.error);
await runElectron('--s1-poc-new-project-reopen');
const newProjectReopenResult = JSON.parse(await readFile(path.join(runDirectory, 'new-project-reopen-result.json'), 'utf8'));
if (newProjectReopenResult.s1Poc === 'failed') throw new Error(newProjectReopenResult.error);
console.log(JSON.stringify({ s1Poc: 'passed', writeResult, reopenResult, projectReopenResult, newProjectReopenResult, artifactDirectory: runDirectory }, null, 2));
