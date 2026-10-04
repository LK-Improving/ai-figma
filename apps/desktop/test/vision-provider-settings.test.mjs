import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { testDeepSeekConnection, VisionProviderSettingsStore } from '../dist/vision-provider-settings.js';

class FakeEncryption {
  available = true;
  isAsyncEncryptionAvailable() { return Promise.resolve(this.available); }
  async encryptStringAsync(plainText) { return Buffer.from(`cipher:${Buffer.from(plainText).toString('base64')}`, 'utf8'); }
  async decryptStringAsync(encrypted) {
    const ciphertext = encrypted.toString('utf8');
    if (!ciphertext.startsWith('cipher:')) throw new Error('invalid ciphertext');
    return Buffer.from(ciphertext.slice('cipher:'.length), 'base64').toString('utf8');
  }
}

let directory;
test.beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'myfigma-vision-settings-')); });
test.afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('credential stays encrypted on disk, survives restart, and clearing returns to local rules', async () => {
  const encryption = new FakeEncryption();
  const store = new VisionProviderSettingsStore(directory, encryption);
  await store.initialize();
  assert.deepEqual(store.getView(), { provider: 'local-rules', configured: false, model: 'deepseek-flash' });
  await assert.rejects(store.setProvider('deepseek'), /Save a DeepSeek API key/);

  const apiKey = 'sk-test-only-vision-key-123456';
  await store.saveApiKey(apiKey);
  const file = await readFile(path.join(directory, 'vision-provider-settings.json'), 'utf8');
  assert.equal(file.includes(apiKey), false);

  const restarted = new VisionProviderSettingsStore(directory, encryption);
  await restarted.initialize();
  assert.equal(restarted.getView().configured, true);
  assert.equal(await restarted.getApiKey(), apiKey);
  await restarted.setProvider('deepseek');
  assert.equal(restarted.getView().provider, 'deepseek');
  await restarted.clearApiKey();
  assert.deepEqual(restarted.getView(), { provider: 'local-rules', configured: false, model: 'deepseek-flash' });
  assert.equal(await restarted.getApiKey(), null);
});

test('credential input is validated before encryption and unavailable encryption fails closed', async () => {
  const encryption = new FakeEncryption();
  const store = new VisionProviderSettingsStore(directory, encryption);
  await store.initialize();
  await assert.rejects(store.saveApiKey('short'), /8 to 512/);
  await assert.rejects(store.saveApiKey('sk-test-key with spaces'), /8 to 512/);
  encryption.available = false;
  await assert.rejects(store.saveApiKey('sk-test-vision-key-123'), /Secure credential storage/);
  assert.equal(store.getView().configured, false);
});

test('concurrent settings writes preserve invocation order when the key is cleared', async () => {
  const store = new VisionProviderSettingsStore(directory, new FakeEncryption());
  await store.initialize();
  await store.saveApiKey('sk-test-vision-key-123');
  await store.setProvider('deepseek');
  const clear = store.clearApiKey();
  const staleEnable = store.setProvider('deepseek');
  const results = await Promise.allSettled([clear, staleEnable]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(store.getView(), { provider: 'local-rules', configured: false, model: 'deepseek-flash' });
});

test('connection check sends only a short fixed text request and returns no response content', async () => {
  const secret = 'sk-test-connection-key-123456';
  let captured;
  const result = await testDeepSeekConnection(secret, async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
  assert.equal(captured.body.model, 'deepseek-flash');
  assert.deepEqual(Object.keys(result).sort(), ['latencyMs', 'model']);
  assert.equal(result.model, 'deepseek-flash');
});

test('connection errors are sanitized and request timeout aborts', async () => {
  const secret = 'sk-test-connection-key-123456';
  await assert.rejects(testDeepSeekConnection(secret, async () => new Response(JSON.stringify({ error: secret }), { status: 401 })), (error) => {
    assert.match(error.message, /rejected the API key/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(testDeepSeekConnection(secret, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), 5), /timed out/);
});
