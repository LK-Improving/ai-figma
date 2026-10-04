import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { generateReactProject } from '../src/index';
import { makeAssets, makeDocument } from './fixture';

const runFile = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmShell = process.platform === 'win32';

test('generated project installs and builds from a clean temporary directory', { timeout: 360_000 }, async () => {
  const result = generateReactProject({ document: makeDocument(), assets: makeAssets() });
  assert.equal(result.success, true, JSON.stringify(result.success ? [] : result.diagnostics));
  if (!result.success) throw new Error('fixture did not generate');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'myfigma-codegen-build-'));
  try {
    for (const file of result.files) {
      const target = path.resolve(temporary, ...file.path.split('/'));
      assert.ok(target.startsWith(`${temporary}${path.sep}`), `escaped project directory: ${file.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await runFile(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: temporary, timeout: 180_000, shell: npmShell });
    const { stdout, stderr } = await runFile(npmCommand, ['run', 'build'], { cwd: temporary, timeout: 240_000, shell: npmShell });
    assert.match(`${stdout}\n${stderr}`, /vite v6\.3\.5|built in/);
  } finally {
    try { await rm(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 }); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EBUSY') throw error;
    }
  }
});
