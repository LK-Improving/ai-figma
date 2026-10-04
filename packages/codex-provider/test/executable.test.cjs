const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveCodexExecutable } = require('../dist/executable.js');

test('Windows discovers a desktop install even with an empty inherited PATH', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'myfigma-cli-'));
  try {
    const binary = path.join(root, 'OpenAI', 'Codex', 'bin', 'version-test', 'codex.exe');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, 'test fixture');
    assert.equal(resolveCodexExecutable(undefined, { platform: 'win32', env: { PATH: '', LOCALAPPDATA: root, APPDATA: root }, home: root }), binary);
    assert.equal(resolveCodexExecutable('custom.exe', { platform: 'win32', env: {} }), 'custom.exe');
    assert.equal(resolveCodexExecutable(undefined, { platform: 'win32', env: { MIAOMA_CODEX_PATH: 'override.exe' } }), 'override.exe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm wrapper directory resolves to the packaged native executable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'myfigma-npm-cli-'));
  try {
    const binary = path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, 'test fixture');
    writeFileSync(path.join(root, 'codex.cmd'), 'test fixture');
    assert.equal(resolveCodexExecutable(undefined, { platform: 'win32', arch: 'x64', env: { Path: root } }), binary);
    assert.equal(resolveCodexExecutable(undefined, { platform: 'linux', env: {} }), 'codex');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
