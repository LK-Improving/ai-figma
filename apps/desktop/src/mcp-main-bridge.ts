import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MCP_TOOL_NAMES = ['get_app_state', 'get_selected_node', 'get_nodes', 'get_screenshot', 'get_assets'] as const;
export type McpToolName = typeof MCP_TOOL_NAMES[number];
export type McpBridgeGrant = { projectId: string; documentId: string; grantedAt: string };
export type McpBridgeEndpoint = { version: 1; address: string; token: string };

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const SOFT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_HANDSHAKE_MS = 2_000;
const MAX_NODE_IDS = 500;
const MAX_CLONED_NODES = 50_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/;

export class McpBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpBridgeError';
  }
}

export type McpStudioSource = {
  getDocumentContext(): {
    projectId: string;
    documentId: string;
    title: string;
    revision: number;
    pages: Array<{ id: string; name: string; width: number; height: number }>;
    variables: Record<string, unknown>;
    selectionIds: string[];
    nodesById: Map<string, unknown>;
    pageIdByNode: Map<string, string>;
    assets: Record<string, { id: string; mimeType: string; byteSize: number; sha256: string }>;
  };
  getAsset(projectId: string, documentId: string, assetId: string, expectedRevision: number): Promise<{ mimeType: string; base64: string }>;
  renderScreenshot(input: { pageId: string; nodeIds: string[]; scale: number; maxEdge: number }): { metadata: Record<string, unknown>; svg: string };
};

type BridgeRequest = {
  protocolVersion: 1;
  requestId: string;
  token: string;
  method: McpToolName;
  params: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpBridgeError('INVALID_ARGUMENT', 'Tool arguments must be an object');
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new McpBridgeError('INVALID_ARGUMENT', `${field} is invalid`);
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new McpBridgeError('INVALID_ARGUMENT', `${field} must be an integer between ${min} and ${max}`);
  return value as number;
}

function cloneNode(node: unknown, depth: number, diagnostics: string[], budget: { count: number }): unknown {
  budget.count += 1;
  if (budget.count > MAX_CLONED_NODES) throw new McpBridgeError('PAYLOAD_TOO_LARGE', 'Node response exceeds the 50000-node limit');
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const source = node as Record<string, unknown>;
  const hasChildren = Object.hasOwn(source, 'children');
  const children = Array.isArray(source.children) ? source.children : [];
  const shallow = { ...source };
  delete shallow.children;
  const current = structuredClone(shallow) as Record<string, unknown>;
  if (hasChildren) {
    if (depth === 0 && children.length > 0) {
      if (!diagnostics.includes('Node tree was truncated at the requested depth limit.')) diagnostics.push('Node tree was truncated at the requested depth limit.');
      current.children = [];
    } else {
      current.children = children.map((child) => cloneNode(child, depth - 1, diagnostics, budget));
    }
  }
  return current;
}

function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string' || cursor.length > 32 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new McpBridgeError('INVALID_ARGUMENT', 'Cursor is invalid');
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(value) || value < 0 || encodeCursor(value) !== cursor) throw new McpBridgeError('INVALID_ARGUMENT', 'Cursor is invalid');
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function decodeRequest(input: Buffer): BridgeRequest {
  let value: unknown;
  try { value = JSON.parse(input.toString('utf8')); }
  catch { throw new McpBridgeError('INVALID_ARGUMENT', 'Bridge request is not valid JSON'); }
  const candidate = record(value);
  if (candidate.protocolVersion !== 1 || typeof candidate.requestId !== 'string' || candidate.requestId.length > 96 || typeof candidate.token !== 'string' || typeof candidate.method !== 'string' || !MCP_TOOL_NAMES.includes(candidate.method as McpToolName)) {
    throw new McpBridgeError('INVALID_ARGUMENT', 'Bridge request envelope is invalid');
  }
  return { protocolVersion: 1, requestId: candidate.requestId, token: candidate.token, method: candidate.method as McpToolName, params: record(candidate.params) };
}

export class McpMainBridge {
  private server: Server | null = null;
  private endpoint: McpBridgeEndpoint | null = null;
  private grant: McpBridgeGrant | null = null;
  private socketPath: string | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly endpointDirectory: string;
  private readonly endpointPath: string;

  constructor(private readonly userDataPath: string, private readonly source: McpStudioSource) {
    this.endpointDirectory = path.join(userDataPath, 'mcp-bridge');
    this.endpointPath = path.join(this.endpointDirectory, 'endpoint.json');
  }

  getEndpointPath(): string { return this.endpointPath; }

  getStatus(): { active: boolean; endpointReady: boolean; toolNames: readonly string[]; grant: McpBridgeGrant | null } {
    return { active: this.server !== null, endpointReady: this.endpoint !== null, toolNames: MCP_TOOL_NAMES, grant: this.grant ? { ...this.grant } : null };
  }

  async setGrant(projectId: string, documentId: string): Promise<McpBridgeGrant> {
    if (!ID_PATTERN.test(projectId) || !ID_PATTERN.test(documentId)) throw new McpBridgeError('INVALID_ARGUMENT', 'Project or document identity is invalid');
    const context = this.source.getDocumentContext();
    if (context.projectId !== projectId || context.documentId !== documentId) throw new McpBridgeError('ACCESS_DENIED', 'MCP grant must match the active project and document');
    const grant = { projectId, documentId, grantedAt: new Date().toISOString() };
    if (!this.endpoint || !this.server) throw new McpBridgeError('APP_UNAVAILABLE', 'MCP bridge is not ready');
    const previousToken = this.endpoint.token;
    this.endpoint = { ...this.endpoint, token: randomBytes(32).toString('base64url') };
    try { await this.persistEndpoint(); }
    catch {
      this.endpoint = { ...this.endpoint, token: previousToken };
      throw new McpBridgeError('APP_UNAVAILABLE', 'MCP grant could not be activated');
    }
    this.grant = grant;
    return { ...this.grant };
  }

  revokeGrant(): void { this.grant = null; }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(this.endpointDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') this.secureWindowsEndpointDirectory();
    else await chmod(this.endpointDirectory, 0o700);
    const token = randomBytes(32).toString('base64url');
    const userHash = createHash('sha256').update(this.userDataPath).digest('hex').slice(0, 12);
    const address = path.join(os.tmpdir(), `miaoma-${userHash}-${randomUUID().replaceAll('-', '').slice(0, 16)}.sock`);
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    server.maxConnections = 16;
    server.on('error', () => {
      if (this.server !== server) return;
      this.server = null;
      this.endpoint = null;
      this.grant = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      void rm(this.endpointPath, { force: true }).catch(() => undefined);
      if (server.listening) server.close(() => undefined);
      if (this.socketPath) void rm(this.socketPath, { force: true }).catch(() => undefined);
      this.socketPath = null;
    });
    this.server = server;
    this.socketPath = process.platform === 'win32' ? null : address;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListen); this.server = null; reject(error); };
      const onListen = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListen);
      if (process.platform === 'win32') server.listen(0, '127.0.0.1');
      else server.listen(address);
    });
    let endpointAddress = address;
    if (process.platform === 'win32') {
      const tcpAddress = server.address();
      if (!tcpAddress || typeof tcpAddress === 'string') {
        await this.stop();
        throw new McpBridgeError('APP_UNAVAILABLE', 'Local MCP endpoint could not be created');
      }
      endpointAddress = `tcp://127.0.0.1:${tcpAddress.port}`;
    }
    this.endpoint = { version: 1, address: endpointAddress, token };
    try {
      if (this.socketPath) await chmod(this.socketPath, 0o600);
      await this.persistEndpoint();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private secureWindowsEndpointDirectory(): void {
    try {
      const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.match(/S-\d-(?:\d+-)+\d+/)?.[0];
      if (!sid) throw new Error('Windows user SID is unavailable');
      const icaclsPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
      execFileSync(icaclsPath, [
        this.endpointDirectory,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F'
      ], { stdio: 'ignore', windowsHide: true });
    } catch {
      throw new McpBridgeError('APP_UNAVAILABLE', 'Private MCP endpoint storage could not be secured');
    }
  }

  private async persistEndpoint(): Promise<void> {
    if (!this.endpoint) throw new McpBridgeError('APP_UNAVAILABLE', 'MCP bridge is not ready');
    const tempPath = `${this.endpointPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(this.endpoint), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') await chmod(tempPath, 0o600);
      try { await rename(tempPath, this.endpointPath); }
      catch (error) {
        if (process.platform === 'win32') {
          await rm(this.endpointPath, { force: true });
          await rename(tempPath, this.endpointPath);
        } else {
          throw error;
        }
      }
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.grant = null;
    const server = this.server;
    this.server = null;
    this.endpoint = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketPath) await rm(this.socketPath, { force: true }).catch(() => undefined);
    this.socketPath = null;
    await rm(this.endpointPath, { force: true }).catch(() => undefined);
  }

  private accept(socket: Socket): void {
    if (process.platform === 'win32' && socket.remoteAddress?.replace(/^::ffff:/, '') !== '127.0.0.1') {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const handshakeDeadline = setTimeout(() => socket.destroy(), MAX_HANDSHAKE_MS);
    handshakeDeadline.unref();
    socket.once('close', () => {
      clearTimeout(handshakeDeadline);
      this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(handshakeDeadline);
        this.reply(socket, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'MCP request exceeds the 1 MiB limit' } });
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(0x0a)) return;
      const all = Buffer.concat(chunks, bytes);
      const end = all.indexOf(0x0a);
      if (end < 0) return;
      handled = true;
      clearTimeout(handshakeDeadline);
      socket.setTimeout(10_000, () => socket.destroy());
      void this.handleFrame(socket, all.subarray(0, end));
    });
  }

  private async handleFrame(socket: Socket, frame: Buffer): Promise<void> {
    let requestId = '';
    try {
      const request = decodeRequest(frame);
      requestId = request.requestId;
      if (!this.endpoint || !constantTimeEqual(request.token, this.endpoint.token)) throw new McpBridgeError('ACCESS_DENIED', 'MCP bridge authorization failed');
      const grant = this.grant;
      if (!grant) throw new McpBridgeError('ACCESS_DENIED', 'No project has been granted to MCP clients');
      const context = this.source.getDocumentContext();
      if (context.projectId !== grant.projectId || context.documentId !== grant.documentId) throw new McpBridgeError('ACCESS_DENIED', 'The granted project is no longer active');
      const result = await this.dispatch(request.method, request.params, grant, context);
      const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (resultBytes > SOFT_RESPONSE_BYTES) throw new McpBridgeError('PAYLOAD_TOO_LARGE', 'MCP response exceeds the 4 MiB soft limit');
      const latestContext = this.source.getDocumentContext();
      if (!this.grant || this.grant.projectId !== grant.projectId || this.grant.documentId !== grant.documentId) throw new McpBridgeError('ACCESS_DENIED', 'The granted project changed during the request');
      if (latestContext.projectId !== grant.projectId || latestContext.documentId !== grant.documentId) throw new McpBridgeError('ACCESS_DENIED', 'The granted project is no longer active');
      if (latestContext.revision !== context.revision) throw new McpBridgeError('INVALID_ARGUMENT', 'The design changed during this read; retry at the latest revision');
      this.reply(socket, { protocolVersion: 1, requestId, ok: true, result, servedRevision: context.revision });
    } catch (error) {
      const failure = error instanceof McpBridgeError ? error : new McpBridgeError('APP_UNAVAILABLE', 'The requested design data is unavailable');
      this.reply(socket, { protocolVersion: 1, requestId, ok: false, error: { code: failure.code, message: failure.message } });
    }
  }

  private async dispatch(method: McpToolName, rawParams: Record<string, unknown>, grant: McpBridgeGrant, context: ReturnType<McpStudioSource['getDocumentContext']>): Promise<unknown> {
    const params = rawParams;
    const requestedProjectId = optionalId(params.projectId, 'projectId');
    const requestedDocumentId = optionalId(params.documentId, 'documentId');
    if (requestedProjectId && requestedProjectId !== grant.projectId) throw new McpBridgeError('ACCESS_DENIED', 'Requested project is outside the granted scope');
    if (requestedDocumentId && requestedDocumentId !== grant.documentId) throw new McpBridgeError('ACCESS_DENIED', 'Requested document is outside the granted scope');
    const revision = params.revision;
    if (revision !== undefined && revision !== context.revision) throw new McpBridgeError('INVALID_ARGUMENT', 'Requested revision is stale; call get_app_state to refresh');

    if (method === 'get_app_state') {
      return {
        projectId: grant.projectId,
        document: { documentId: context.documentId, title: context.title, revision: context.revision, pages: context.pages },
        selectionIds: context.selectionIds,
        capabilities: { readOnly: true, tools: MCP_TOOL_NAMES }
      };
    }

    if (method === 'get_selected_node') {
      const depth = boundedInteger(params.depth, 'depth', 0, 8, 4);
      const diagnostics: string[] = [];
      const selectionIds = context.selectionIds.slice(0, 100);
      if (context.selectionIds.length > selectionIds.length) diagnostics.push('Selection was truncated to the first 100 nodes.');
      const budget = { count: 0 };
      const nodes = selectionIds.flatMap((id) => {
        const node = context.nodesById.get(id);
        return node === undefined ? [] : [cloneNode(node, depth, diagnostics, budget)];
      });
      return { documentId: grant.documentId, revision: context.revision, selectionIds, nodes, variables: context.variables, diagnostics };
    }

    if (method === 'get_nodes') {
      const rawIds = params.nodeIds;
      if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_NODE_IDS || rawIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id)) || new Set(rawIds).size !== rawIds.length) throw new McpBridgeError('INVALID_ARGUMENT', `nodeIds must contain 1–${MAX_NODE_IDS} unique valid IDs`);
      const depth = boundedInteger(params.depth, 'depth', 0, 8, 4);
      const cursor = decodeCursor(params.cursor);
      if (cursor > rawIds.length) throw new McpBridgeError('INVALID_ARGUMENT', 'Cursor is outside the requested node list');
      const limit = Math.min(100, rawIds.length - cursor);
      const ids = rawIds.slice(cursor, cursor + limit) as string[];
      const missingIds = ids.filter((id) => !context.nodesById.has(id));
      const diagnostics: string[] = [];
      const budget = { count: 0 };
      const nodes = ids.flatMap((id) => {
        const node = context.nodesById.get(id);
        return node === undefined ? [] : [cloneNode(node, depth, diagnostics, budget)];
      });
      const nextOffset = cursor + limit;
      return { documentId: grant.documentId, revision: context.revision, nodes, missingIds, ...(nextOffset < rawIds.length ? { nextCursor: encodeCursor(nextOffset) } : {}), diagnostics };
    }

    if (method === 'get_screenshot') {
      const nodeIds = params.nodeIds;
      if (!Array.isArray(nodeIds) || nodeIds.length < 1 || nodeIds.length > MAX_NODE_IDS || nodeIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id)) || new Set(nodeIds).size !== nodeIds.length) throw new McpBridgeError('INVALID_ARGUMENT', `nodeIds must contain 1–${MAX_NODE_IDS} unique valid IDs`);
      if (nodeIds.some((id) => !context.nodesById.has(id as string))) throw new McpBridgeError('NODE_NOT_FOUND', 'One or more requested nodes do not exist in this document');
      const targetPages = [...new Set(nodeIds.map((id) => context.pageIdByNode.get(id as string)).filter((id): id is string => !!id))];
      if (targetPages.length !== 1) throw new McpBridgeError('INVALID_ARGUMENT', 'Screenshot requests must target nodes from one page');
      const pageId = targetPages[0]!;
      const scale = params.scale === undefined ? 1 : params.scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 2) throw new McpBridgeError('INVALID_ARGUMENT', 'scale must be greater than 0 and no greater than 2');
      const maxEdge = boundedInteger(params.maxEdge, 'maxEdge', 64, 4096, 2048);
      const screenshot = this.source.renderScreenshot({ pageId, nodeIds: nodeIds as string[], scale, maxEdge });
      const base64 = Buffer.from(screenshot.svg, 'utf8').toString('base64');
      if (Buffer.byteLength(base64, 'utf8') > SOFT_RESPONSE_BYTES) throw new McpBridgeError('PAYLOAD_TOO_LARGE', 'Screenshot exceeds the 4 MiB response soft limit');
      return { metadata: { ...screenshot.metadata, projectId: grant.projectId, documentId: context.documentId, revision: context.revision, requestedNodeIds: nodeIds }, image: { mimeType: 'image/svg+xml', base64 } };
    }

    if (method === 'get_assets') {
      const rawIds = params.assetIds;
      if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.length > MAX_NODE_IDS || rawIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id)))) throw new McpBridgeError('INVALID_ARGUMENT', `assetIds must contain no more than ${MAX_NODE_IDS} valid IDs`);
      const includeContent = params.includeContent === true;
      const ids = (rawIds as string[] | undefined)?.length ? rawIds as string[] : Object.keys(context.assets);
      const cursor = decodeCursor(params.cursor);
      if (cursor > ids.length) throw new McpBridgeError('INVALID_ARGUMENT', 'Cursor is outside the requested asset list');
      const limit = Math.min(100, Math.max(0, ids.length - cursor));
      const selectedIds = ids.slice(cursor, cursor + limit);
      const missingIds = selectedIds.filter((id) => !context.assets[id]);
      const assets = [];
      let payloadBytes = 0;
      for (const id of selectedIds) {
        const metadata = context.assets[id];
        if (!metadata) continue;
        if (!includeContent) { assets.push({ metadata }); continue; }
        const encodedSize = Math.ceil(metadata.byteSize / 3) * 4;
        if (!Number.isSafeInteger(encodedSize) || encodedSize < 0 || payloadBytes + encodedSize > SOFT_RESPONSE_BYTES) throw new McpBridgeError('PAYLOAD_TOO_LARGE', 'Asset content exceeds the 4 MiB response soft limit; request fewer assets');
        const content = await this.source.getAsset(grant.projectId, grant.documentId, id, context.revision);
        const actualEncodedSize = Buffer.byteLength(content.base64, 'utf8');
        if (actualEncodedSize !== encodedSize) throw new McpBridgeError('APP_UNAVAILABLE', 'Asset size did not match its active metadata');
        payloadBytes += actualEncodedSize;
        if (payloadBytes > SOFT_RESPONSE_BYTES) throw new McpBridgeError('PAYLOAD_TOO_LARGE', 'Asset content exceeds the 4 MiB response soft limit; request fewer assets');
        assets.push({ metadata, content });
      }
      const nextOffset = cursor + limit;
      return { documentId: grant.documentId, revision: context.revision, assets, missingIds, ...(nextOffset < ids.length ? { nextCursor: encodeCursor(nextOffset) } : {}) };
    }

    throw new McpBridgeError('INVALID_ARGUMENT', 'Unknown read-only MCP tool');
  }

  private reply(socket: Socket, response: Record<string, unknown>): void {
    if (socket.destroyed) return;
    let body: string;
    try { body = JSON.stringify(response); }
    catch { body = JSON.stringify({ protocolVersion: 1, ok: false, error: { code: 'APP_UNAVAILABLE', message: 'Bridge result could not be serialized' } }); }
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) body = JSON.stringify({ protocolVersion: 1, ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Bridge response exceeds the 64 MiB hard limit' } });
    socket.end(`${body}\n`);
  }
}
