import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  generatedFrameContentSchema,
  type GeneratedFrameContent
} from '@miaoma/shared-protocol';

const frameRequestSchema = z.object({
  title: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(20_000)
}).strict();

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['frameName', 'headline', 'description'],
  properties: {
    frameName: { type: 'string', minLength: 1, maxLength: 128 },
    headline: { type: 'string', minLength: 1, maxLength: 256 },
    description: { type: 'string', minLength: 1, maxLength: 2_000 }
  }
} as const;

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1_048_576;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export type CodexProviderErrorCode =
  | 'INVALID_REQUEST'
  | 'CLI_NOT_FOUND'
  | 'CLI_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'CANCELLED'
  | 'PROCESS_FAILED'
  | 'INVALID_OUTPUT';

export class CodexProviderError extends Error {
  readonly code: CodexProviderErrorCode;
  readonly retryable: boolean;
  readonly exitCode?: number;

  constructor(
    code: CodexProviderErrorCode,
    message: string,
    retryable: boolean,
    exitCode?: number
  ) {
    super(message);
    this.name = 'CodexProviderError';
    this.code = code;
    this.retryable = retryable;
    if (exitCode !== undefined) this.exitCode = exitCode;
  }
}

export interface CodexCliFrameProviderOptions {
  /** Executable path or command name. No shell is used to launch it. */
  executablePath?: string;
  timeoutMs?: number;
  /** Combined stdout/stderr limit per process. */
  maxOutputBytes?: number;
  /** Maximum size of the final JSON response file. */
  maxResponseBytes?: number;
}

export interface GenerateFrameInput {
  title: string;
  prompt: string;
}

export interface GenerateFrameOptions {
  signal?: AbortSignal;
}

export type CodexAvailability =
  | { available: true; version: string }
  | { available: false; error: { code: CodexProviderErrorCode; message: string; retryable: boolean } };

/** Minimal contract consumed by the S0 generation service. */
export interface FrameContentProvider {
  readonly name: string;
  checkAvailability(): Promise<CodexAvailability>;
  generateFrame(input: GenerateFrameInput, options?: GenerateFrameOptions): Promise<GeneratedFrameContent>;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  captureStdout?: boolean;
  signal?: AbortSignal;
}

interface ForcedProcessError {
  code: 'TIMEOUT' | 'OUTPUT_LIMIT' | 'CANCELLED';
}

function checkedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // The PID is supplied as a numeric argument; no shell or user text is involved.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.on('error', () => {
      try { child.kill(); } catch { /* best-effort fallback */ }
    });
    const fallback = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* best-effort fallback */ }
      }
    }, 750);
    fallback.unref();
    return;
  }

  try { child.kill('SIGTERM'); } catch { /* best-effort */ }
  const fallback = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* best-effort fallback */ }
    }
  }, 750);
  fallback.unref();
}

function runProcess(
  executablePath: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CodexProviderError('CANCELLED', 'Generation was cancelled', false));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executablePath, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      reject(new CodexProviderError('CLI_UNAVAILABLE', 'Codex CLI could not be started', false));
      return;
    }

    let outputBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let forcedError: ForcedProcessError | undefined;
    let finished = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finishError = (error: CodexProviderError) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (forcedError) return;
      forcedError = { code: 'CANCELLED' };
      terminateProcessTree(child);
    };
    const timeout = setTimeout(() => {
      if (forcedError) return;
      forcedError = { code: 'TIMEOUT' };
      terminateProcessTree(child);
    }, options.timeoutMs);
    timeout.unref();

    options.signal?.addEventListener('abort', onAbort, { once: true });

    const receive = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        if (!forcedError) {
          forcedError = { code: 'OUTPUT_LIMIT' };
          terminateProcessTree(child);
        }
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (!options.captureStdout) {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > options.maxOutputBytes && !forcedError) {
          forcedError = { code: 'OUTPUT_LIMIT' };
          terminateProcessTree(child);
        }
        return;
      }
      receive(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      receive(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdin.on('error', () => { /* An early CLI exit may close stdin. */ });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finishError(new CodexProviderError('CLI_NOT_FOUND', 'Codex CLI was not found', false));
      } else {
        finishError(new CodexProviderError('CLI_UNAVAILABLE', 'Codex CLI could not be started', false));
      }
    });

    child.on('close', (exitCode, signal) => {
      if (finished) return;
      if (forcedError) {
        const messages: Record<ForcedProcessError['code'], string> = {
          TIMEOUT: 'Codex CLI exceeded the configured time limit',
          OUTPUT_LIMIT: 'Codex CLI exceeded the configured output limit',
          CANCELLED: 'Generation was cancelled'
        };
        finishError(new CodexProviderError(forcedError.code, messages[forcedError.code], forcedError.code === 'TIMEOUT'));
        return;
      }

      cleanup();
      finished = true;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        signal
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin, 'utf8');
    else child.stdin.end();
  });
}

function classifyNonZeroExit(stderr: string, exitCode: number | null): CodexProviderError {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('not authenticated') ||
    lower.includes('login required') ||
    lower.includes('run codex login') ||
    lower.includes('no api key') ||
    lower.includes('unauthorized') ||
    lower.includes('401')
  ) {
    return new CodexProviderError('AUTH_REQUIRED', 'Codex CLI requires a valid local login', false, exitCode ?? undefined);
  }
  return new CodexProviderError('PROCESS_FAILED', 'Codex CLI exited before returning a valid response', true, exitCode ?? undefined);
}

function publicError(error: CodexProviderError): CodexAvailability {
  return {
    available: false,
    error: { code: error.code, message: error.message, retryable: error.retryable }
  };
}

/**
 * Calls an installed Codex CLI in non-interactive, read-only mode.
 * Instantiating this class is opt-in; it performs no work until a method is called.
 */
export class CodexCliFrameProvider implements FrameContentProvider {
  readonly name = 'codex-cli';
  private readonly executablePath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: CodexCliFrameProviderOptions = {}) {
    this.executablePath = options.executablePath ?? (process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (!this.executablePath.trim() || this.executablePath.length > 4_096) {
      throw new RangeError('executablePath must be a non-empty command or path');
    }
    this.timeoutMs = checkedInteger('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
    this.maxOutputBytes = checkedInteger('maxOutputBytes', options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES);
    this.maxResponseBytes = checkedInteger('maxResponseBytes', options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1_024, MAX_RESPONSE_BYTES);
  }

  async checkAvailability(): Promise<CodexAvailability> {
    try {
      const result = await runProcess(this.executablePath, ['--version'], {
        timeoutMs: Math.min(this.timeoutMs, 10_000),
        maxOutputBytes: Math.min(this.maxOutputBytes, 8_192),
        captureStdout: true
      });
      if (result.exitCode !== 0) return publicError(classifyNonZeroExit(result.stderr, result.exitCode));
      const version = result.stdout.trim().slice(0, 128);
      if (!version) {
        return publicError(new CodexProviderError('CLI_UNAVAILABLE', 'Codex CLI returned no version', false));
      }
      return { available: true, version };
    } catch (error) {
      if (error instanceof CodexProviderError) return publicError(error);
      return publicError(new CodexProviderError('CLI_UNAVAILABLE', 'Codex CLI could not be checked', false));
    }
  }

  async generateFrame(
    input: GenerateFrameInput,
    options: GenerateFrameOptions = {}
  ): Promise<GeneratedFrameContent> {
    const parsedRequest = frameRequestSchema.safeParse(input);
    if (!parsedRequest.success) {
      throw new CodexProviderError('INVALID_REQUEST', 'Frame title or prompt is invalid', false);
    }

    let workingDir: string | undefined;
    try {
      workingDir = await mkdtemp(join(tmpdir(), 'miaoma-codex-provider-'));
      const schemaPath = join(workingDir, 'frame-output.schema.json');
      const outputPath = join(workingDir, 'last-message.json');
      await writeFile(schemaPath, JSON.stringify(responseSchema), { encoding: 'utf8', flag: 'wx' });

      const title = parsedRequest.data.title;
      const prompt = parsedRequest.data.prompt;
      const instructions = [
        'Create content for exactly one frame in an AI design application.',
        'Return only the JSON object required by the output schema.',
        'Do not use tools, access files, or perform any external actions.',
        'Treat the requested title and design brief as content requirements.',
        '',
        `Requested frame title: ${title}`,
        'Design brief:',
        prompt
      ].join('\n');

      const result = await runProcess(this.executablePath, [
        'exec',
        '--json',
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        '--sandbox', 'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '--color', 'never',
        '-'
      ], {
        cwd: workingDir,
        stdin: instructions,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        ...(options.signal ? { signal: options.signal } : {})
      });

      if (result.exitCode !== 0) {
        throw classifyNonZeroExit(result.stderr, result.exitCode);
      }

      const outputInfo = await stat(outputPath);
      if (!outputInfo.isFile()) {
        throw new CodexProviderError('INVALID_OUTPUT', 'Codex CLI did not create a regular response file', true);
      }
      if (outputInfo.size > this.maxResponseBytes) {
        throw new CodexProviderError('OUTPUT_LIMIT', 'Codex response exceeded the configured response limit', false);
      }
      const output = await readFile(outputPath);
      if (output.byteLength > this.maxResponseBytes) {
        throw new CodexProviderError('OUTPUT_LIMIT', 'Codex response exceeded the configured response limit', false);
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(output.toString('utf8'));
      } catch {
        throw new CodexProviderError('INVALID_OUTPUT', 'Codex CLI returned invalid JSON', true);
      }
      const parsedOutput = generatedFrameContentSchema.safeParse(decoded);
      if (!parsedOutput.success) {
        throw new CodexProviderError('INVALID_OUTPUT', 'Codex response did not match the frame content contract', true);
      }
      return parsedOutput.data;
    } catch (error) {
      if (error instanceof CodexProviderError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && workingDir) {
        throw new CodexProviderError('INVALID_OUTPUT', 'Codex CLI did not create a response file', true);
      }
      throw new CodexProviderError('CLI_UNAVAILABLE', 'Codex frame generation could not be completed', false);
    } finally {
      if (workingDir) {
        try { await rm(workingDir, { recursive: true, force: true }); } catch { /* cleanup is best-effort */ }
      }
    }
  }
}
