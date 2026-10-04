import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type VisionReviewProviderId = 'local-rules' | 'deepseek';

export interface VisionCredentialEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<string | { result: string; shouldReEncrypt: boolean }>;
}

export type VisionProviderSettingsView = {
  provider: VisionReviewProviderId;
  configured: boolean;
  model: 'deepseek-flash';
};

export type DeepSeekConnectionResult = { model: 'deepseek-flash'; latencyMs: number };

type PersistedVisionSettings = {
  version: 1;
  provider: VisionReviewProviderId;
  encryptedApiKey: string | null;
};

const SETTINGS_FILE = 'vision-provider-settings.json';
const MAX_SETTINGS_BYTES = 16 * 1024;
const MAX_API_KEY_LENGTH = 512;
const MAX_CONNECTION_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedJsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredBytes = response.headers.get('content-length');
  if (declaredBytes && /^\d+$/.test(declaredBytes) && Number(declaredBytes) > MAX_CONNECTION_RESPONSE_BYTES) {
    throw new Error('DeepSeek returned an invalid response');
  }
  const reader = response.body?.getReader();
  let responseText: string;
  if (!reader) {
    responseText = await response.text();
    if (Buffer.byteLength(responseText, 'utf8') > MAX_CONNECTION_RESPONSE_BYTES) throw new Error('DeepSeek returned an invalid response');
  } else {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const cancelReader = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.byteLength;
        if (totalBytes > MAX_CONNECTION_RESPONSE_BYTES) {
          cancelReader();
          throw new Error('DeepSeek returned an invalid response');
        }
        chunks.push(part.value);
      }
    } finally {
      signal.removeEventListener('abort', cancelReader);
      try { reader.releaseLock(); } catch { /* A pending read settles after cancellation. */ }
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { responseText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('DeepSeek returned an invalid response'); }
  }
  try { return JSON.parse(responseText) as unknown; }
  catch { throw new Error('DeepSeek returned an invalid response'); }
}

function decodeSettings(value: unknown): PersistedVisionSettings {
  if (!isRecord(value) || value.version !== 1
    || (value.provider !== 'local-rules' && value.provider !== 'deepseek')
    || (value.encryptedApiKey !== null && (typeof value.encryptedApiKey !== 'string' || value.encryptedApiKey.length < 1 || value.encryptedApiKey.length > 12_000))) {
    throw new Error('Stored vision provider settings are invalid');
  }
  return {
    version: 1,
    provider: value.encryptedApiKey && value.provider === 'deepseek' ? 'deepseek' : 'local-rules',
    encryptedApiKey: value.encryptedApiKey as string | null
  };
}

export class VisionProviderSettingsStore {
  private settings: PersistedVisionSettings = { version: 1, provider: 'local-rules', encryptedApiKey: null };
  private initialized = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly userDataDirectory: string, private readonly encryption: VisionCredentialEncryption) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let raw: Buffer;
    try {
      raw = await readFile(this.settingsPath);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return;
      throw new Error('Stored vision provider settings could not be read');
    }
    if (raw.byteLength > MAX_SETTINGS_BYTES) throw new Error('Stored vision provider settings exceed the size limit');
    let decoded: PersistedVisionSettings;
    try {
      decoded = decodeSettings(JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      throw new Error('Stored vision provider settings are invalid');
    }
    if (decoded.encryptedApiKey && !(await this.encryption.isAsyncEncryptionAvailable())) {
      throw new Error('Windows secure credential storage is unavailable');
    }
    this.settings = decoded;
  }

  getView(): VisionProviderSettingsView {
    this.ensureInitialized();
    return { provider: this.settings.provider, configured: this.settings.encryptedApiKey !== null, model: 'deepseek-flash' };
  }

  async getApiKey(): Promise<string | null> {
    this.ensureInitialized();
    const encrypted = this.settings.encryptedApiKey;
    if (!encrypted) return null;
    if (!(await this.encryption.isAsyncEncryptionAvailable())) throw new Error('Secure credential storage is unavailable');
    try {
      const bytes = Buffer.from(encrypted, 'base64');
      const first = await this.encryption.decryptStringAsync(bytes);
      if (typeof first === 'string') return first;
      if (!first.shouldReEncrypt) return first.result;
      const refreshed = await this.encryption.decryptStringAsync(bytes);
      if (typeof refreshed !== 'string' && refreshed.shouldReEncrypt) throw new Error('Encryption key rotation is still pending');
      return typeof refreshed === 'string' ? refreshed : refreshed.result;
    } catch {
      throw new Error('The saved DeepSeek API key could not be decrypted');
    }
  }

  async saveApiKey(input: unknown): Promise<void> {
    return this.serializeMutation(async () => {
      this.ensureInitialized();
      if (typeof input !== 'string') throw new Error('API key is invalid');
      const apiKey = input.trim();
      if (apiKey.length < 8 || apiKey.length > MAX_API_KEY_LENGTH || /[^\x21-\x7e]/.test(apiKey)) throw new Error('API key must contain 8 to 512 printable non-space characters');
      if (!(await this.encryption.isAsyncEncryptionAvailable())) throw new Error('Secure credential storage is unavailable on this device');
      const encrypted = await this.encryption.encryptStringAsync(apiKey);
      if (encrypted.byteLength < 1 || encrypted.byteLength > 8_192) throw new Error('Secure credential storage returned an invalid value');
      await this.persist({ ...this.settings, encryptedApiKey: encrypted.toString('base64') });
    });
  }

  async clearApiKey(): Promise<void> {
    return this.serializeMutation(async () => {
      this.ensureInitialized();
      await this.persist({ version: 1, provider: 'local-rules', encryptedApiKey: null });
    });
  }

  async setProvider(provider: VisionReviewProviderId): Promise<void> {
    return this.serializeMutation(async () => {
      this.ensureInitialized();
      if (provider !== 'local-rules' && provider !== 'deepseek') throw new Error('Vision review provider is unsupported');
      if (provider === 'deepseek' && !this.settings.encryptedApiKey) throw new Error('Save a DeepSeek API key before enabling remote visual review');
      await this.persist({ ...this.settings, provider });
    });
  }

  private get settingsPath(): string { return path.join(this.userDataDirectory, SETTINGS_FILE); }

  private ensureInitialized(): void {
    if (!this.initialized) throw new Error('Vision provider settings are not initialized');
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(next: PersistedVisionSettings): Promise<void> {
    await mkdir(this.userDataDirectory, { recursive: true });
    const temporaryPath = `${this.settingsPath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    let closed = false;
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporaryPath, this.settingsPath);
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    this.settings = next;
  }
}

export async function testDeepSeekConnection(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000
): Promise<DeepSeekConnectionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 4,
        stream: false
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('DeepSeek rejected the API key');
      if (response.status === 429) throw new Error('DeepSeek rate limit reached');
      if (response.status >= 500) throw new Error('DeepSeek service is temporarily unavailable');
      throw new Error(`DeepSeek connection request failed (${response.status})`);
    }
    const body = await readBoundedJsonResponse(response, controller.signal);
    if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length < 1 || !isRecord(body.choices[0])
      || !isRecord(body.choices[0].message) || typeof body.choices[0].message.content !== 'string') throw new Error('DeepSeek returned an invalid response');
    return { model: 'deepseek-flash', latencyMs: Math.max(0, Date.now() - startedAt) };
  } catch (error) {
    if (error instanceof Error && /^DeepSeek /.test(error.message)) throw error;
    if (controller.signal.aborted) throw new Error('DeepSeek connection test timed out');
    throw new Error('DeepSeek connection could not be completed');
  } finally {
    clearTimeout(timeout);
  }
}
