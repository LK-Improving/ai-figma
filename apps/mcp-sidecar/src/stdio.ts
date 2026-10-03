import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import {
  McpDomainError,
  serveMcpStdio,
  type GetAppStateInput,
  type GetAppStateOutput,
  type GetAssetsInput,
  type GetAssetsOutput,
  type GetNodesInput,
  type GetNodesOutput,
  type GetScreenshotInput,
  type GetScreenshotOutput,
  type GetSelectedNodeInput,
  type GetSelectedNodeOutput,
  type McpDataSource
} from '@miaoma/mcp';

type Endpoint = { version: 1; address: string; token: string };
type ToolMethod = 'get_app_state' | 'get_selected_node' | 'get_nodes' | 'get_screenshot' | 'get_assets';
type BridgeEnvelope = {
  protocolVersion?: number;
  requestId?: string;
  ok?: boolean;
  result?: unknown;
  servedRevision?: number;
  error?: { code?: string; message?: string };
};

const MAX_ENDPOINT_BYTES = 4 * 1024;
const MAX_BRIDGE_RESPONSE_BYTES = 64 * 1024 * 1024;
const BRIDGE_TOTAL_TIMEOUT_MS = 10_000;
const BRIDGE_ATTEMPT_TIMEOUT_MS = 4_250;
const BRIDGE_RETRY_DELAY_MS = 200;
const domainCodes = new Set([
  'APP_UNAVAILABLE', 'DOCUMENT_NOT_OPEN', 'NO_SELECTION', 'NODE_NOT_FOUND', 'ASSET_NOT_FOUND',
  'INVALID_ARGUMENT', 'REQUEST_TIMEOUT', 'PAYLOAD_TOO_LARGE', 'ACCESS_DENIED'
] as const);

function parseEndpointPath(argv: readonly string[]): string {
  const index = argv.indexOf('--endpoint-file');
  if (index < 0 || index + 1 >= argv.length || argv[index + 1]!.startsWith('--') || index + 2 !== argv.length) throw new McpDomainError('INVALID_ARGUMENT');
  return path.resolve(argv[index + 1]!);
}

async function readEndpoint(endpointPath: string): Promise<Endpoint> {
  try {
    const details = await lstat(endpointPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > MAX_ENDPOINT_BYTES) throw new McpDomainError('ACCESS_DENIED');
    const raw: unknown = JSON.parse(await readFile(endpointPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpDomainError('ACCESS_DENIED');
    const endpoint = raw as Record<string, unknown>;
    if (endpoint.version !== 1 || typeof endpoint.address !== 'string' || typeof endpoint.token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(endpoint.token)) throw new McpDomainError('ACCESS_DENIED');
    const windowsAddress = /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(endpoint.address);
    const isWindowsLoopback = !!windowsAddress && Number(windowsAddress[1]) >= 1 && Number(windowsAddress[1]) <= 65535;
    const isUnixSocket = endpoint.address.startsWith(path.join(os.tmpdir(), `miaoma-`)) && /miaoma-[a-f0-9]{12}-[a-f0-9]{16}\.sock$/.test(endpoint.address);
    if (process.platform === 'win32' ? !isWindowsLoopback : !isUnixSocket) throw new McpDomainError('ACCESS_DENIED');
    return { version: 1, address: endpoint.address, token: endpoint.token };
  } catch (error) {
    if (error instanceof McpDomainError) throw error;
    throw new McpDomainError('APP_UNAVAILABLE');
  }
}

function domainError(code: unknown): McpDomainError {
  if (typeof code === 'string' && domainCodes.has(code as never)) return new McpDomainError(code as ConstructorParameters<typeof McpDomainError>[0]);
  return new McpDomainError('APP_UNAVAILABLE');
}

function connectionFor(endpoint: Endpoint) {
  if (process.platform !== 'win32') return createConnection(endpoint.address);
  const port = Number(endpoint.address.slice('tcp://127.0.0.1:'.length));
  return createConnection({ host: '127.0.0.1', port });
}

function requestBridge<T>(endpoint: Endpoint, method: ToolMethod, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const socket = connectionFor(endpoint);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let complete = false;
    const timeout = setTimeout(() => {
      if (complete) return;
      complete = true;
      socket.destroy();
      reject(new McpDomainError('REQUEST_TIMEOUT'));
    }, timeoutMs);
    timeout.unref();
    const cleanup = () => { clearTimeout(timeout); socket.removeAllListeners(); };
    socket.once('connect', () => {
      const request = JSON.stringify({ protocolVersion: 1, requestId, token: endpoint.token, method, params });
      socket.end(`${request}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (complete) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BRIDGE_RESPONSE_BYTES) {
        complete = true;
        cleanup();
        socket.destroy();
        reject(new McpDomainError('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(0x0a)) return;
      const buffer = Buffer.concat(chunks);
      const lineEnd = buffer.indexOf(0x0a);
      if (lineEnd < 0) return;
      complete = true;
      cleanup();
      socket.destroy();
      let response: BridgeEnvelope;
      try { response = JSON.parse(buffer.subarray(0, lineEnd).toString('utf8')) as BridgeEnvelope; }
      catch { reject(new McpDomainError('APP_UNAVAILABLE')); return; }
      if (response.protocolVersion !== 1 || response.requestId !== requestId || typeof response.ok !== 'boolean') {
        reject(new McpDomainError('APP_UNAVAILABLE'));
      } else if (!response.ok) {
        reject(domainError(response.error?.code));
      } else {
        resolve(response.result as T);
      }
    });
    socket.once('error', () => {
      if (complete) return;
      complete = true;
      cleanup();
      reject(new McpDomainError('APP_UNAVAILABLE'));
    });
  });
}

async function requestCurrentBridge<T>(endpointPath: string, method: ToolMethod, params: Record<string, unknown>): Promise<T> {
  const deadline = Date.now() + BRIDGE_TOTAL_TIMEOUT_MS;
  let lastError: unknown = new McpDomainError('APP_UNAVAILABLE');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const endpoint = await readEndpoint(endpointPath);
      const timeoutMs = Math.min(BRIDGE_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
      if (timeoutMs <= 0) throw new McpDomainError('REQUEST_TIMEOUT');
      return await requestBridge<T>(endpoint, method, params, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof McpDomainError && (error.code === 'APP_UNAVAILABLE' || error.code === 'REQUEST_TIMEOUT');
      if (!retryable || attempt === 1) throw error;
      const waitMs = Math.min(BRIDGE_RETRY_DELAY_MS, deadline - Date.now());
      if (waitMs <= 0) throw new McpDomainError('REQUEST_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

function makeDataSource(endpointPath: string): McpDataSource {
  return {
    getAppState: (input: GetAppStateInput) => requestCurrentBridge<GetAppStateOutput>(endpointPath, 'get_app_state', { ...input }),
    getSelectedNode: (input: GetSelectedNodeInput) => requestCurrentBridge<GetSelectedNodeOutput>(endpointPath, 'get_selected_node', { ...input }),
    getNodes: (input: GetNodesInput) => requestCurrentBridge<GetNodesOutput>(endpointPath, 'get_nodes', { ...input }),
    getScreenshot: (input: GetScreenshotInput) => requestCurrentBridge<GetScreenshotOutput>(endpointPath, 'get_screenshot', { ...input }),
    getAssets: (input: GetAssetsInput) => requestCurrentBridge<GetAssetsOutput>(endpointPath, 'get_assets', { ...input })
  };
}

async function main(): Promise<void> {
  try {
    const endpointPath = parseEndpointPath(process.argv.slice(2));
    serveMcpStdio(makeDataSource(endpointPath));
  } catch (error) {
    const safeMessage = error instanceof McpDomainError ? error.message : 'MCP sidecar could not start.';
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  }
}

void main();
