import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/);
const documentIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const revisionSchema = z.number().int().nonnegative().safe();
const cursorSchema = z.string().trim().min(1).max(512);

export const getAppStateInputSchema = z.object({
  projectId: idSchema.optional(),
  documentId: documentIdSchema.optional()
}).strict();

export const getSelectedNodeInputSchema = z.object({
  documentId: documentIdSchema.optional(),
  depth: z.number().int().min(0).max(8).default(3),
  revision: revisionSchema.optional()
}).strict();

export const getNodesInputSchema = z.object({
  documentId: documentIdSchema,
  nodeIds: z.array(idSchema).min(1).max(500),
  depth: z.number().int().min(0).max(8).default(8),
  cursor: cursorSchema.optional(),
  revision: revisionSchema.optional()
}).strict();

export const getScreenshotInputSchema = z.object({
  documentId: documentIdSchema,
  nodeIds: z.array(idSchema).min(1).max(500),
  revision: revisionSchema.optional(),
  scale: z.number().finite().positive().max(2).default(1),
  maxEdge: z.number().int().min(64).max(4096).default(2048)
}).strict();

export const getAssetsInputSchema = z.object({
  documentId: documentIdSchema,
  assetIds: z.array(idSchema).max(500).default([]),
  cursor: cursorSchema.optional(),
  revision: revisionSchema.optional(),
  includeContent: z.boolean().default(false)
}).strict();

export type GetAppStateInput = z.infer<typeof getAppStateInputSchema>;
export type GetSelectedNodeInput = z.infer<typeof getSelectedNodeInputSchema>;
export type GetNodesInput = z.infer<typeof getNodesInputSchema>;
export type GetScreenshotInput = z.infer<typeof getScreenshotInputSchema>;
export type GetAssetsInput = z.infer<typeof getAssetsInputSchema>;

export type McpJsonValue = string | number | boolean | null | McpJsonObject | readonly McpJsonValue[];
export interface McpJsonObject { readonly [key: string]: McpJsonValue }

export type GetAppStateOutput = McpJsonObject;
export type GetSelectedNodeOutput = McpJsonObject;
export type GetNodesOutput = McpJsonObject;

export type McpImageMimeType = 'image/svg+xml' | 'image/png' | 'image/jpeg';
export interface GetScreenshotOutput {
  readonly metadata: McpJsonObject;
  readonly image: { readonly mimeType: McpImageMimeType; readonly base64: string };
}

export type McpAssetMimeType = McpImageMimeType | 'image/webp' | 'text/plain';
export interface GetAssetsOutput {
  readonly documentId?: string;
  readonly revision?: number;
  readonly assets: readonly {
    readonly metadata: McpJsonObject;
    readonly content?: { readonly mimeType: McpAssetMimeType; readonly base64: string };
  }[];
  readonly missingIds?: readonly string[];
  readonly nextCursor?: string;
  readonly diagnostics?: readonly string[];
}

/**
 * Read-only boundary to the desktop Main process. Implementations should scope
 * every lookup to the active project grant and return only the requested revision.
 */
export interface McpDataSource {
  getAppState(input: GetAppStateInput): Promise<GetAppStateOutput>;
  getSelectedNode(input: GetSelectedNodeInput): Promise<GetSelectedNodeOutput>;
  getNodes(input: GetNodesInput): Promise<GetNodesOutput>;
  getScreenshot(input: GetScreenshotInput): Promise<GetScreenshotOutput>;
  getAssets(input: GetAssetsInput): Promise<GetAssetsOutput>;
}

export type McpDomainErrorCode =
  | 'APP_UNAVAILABLE'
  | 'DOCUMENT_NOT_OPEN'
  | 'NO_SELECTION'
  | 'NODE_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'REQUEST_TIMEOUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'ACCESS_DENIED';

const DOMAIN_ERROR_MESSAGES: Readonly<Record<McpDomainErrorCode, string>> = {
  APP_UNAVAILABLE: 'The design application is unavailable.',
  DOCUMENT_NOT_OPEN: 'The requested document is not open.',
  NO_SELECTION: 'There is no selected node.',
  NODE_NOT_FOUND: 'One or more requested nodes were not found.',
  ASSET_NOT_FOUND: 'One or more requested assets were not found.',
  INVALID_ARGUMENT: 'The request contains an invalid argument.',
  REQUEST_TIMEOUT: 'The design data request timed out.',
  PAYLOAD_TOO_LARGE: 'The response exceeds the allowed size.',
  ACCESS_DENIED: 'The requested design data is not available to this client.'
};

/** A safe, stable error type for expected failures from an injected data source. */
export class McpDomainError extends Error {
  readonly code: McpDomainErrorCode;

  constructor(code: McpDomainErrorCode) {
    super(DOMAIN_ERROR_MESSAGES[code]);
    this.name = 'McpDomainError';
    this.code = code;
  }
}

export interface McpServerOptions {
  /** Defaults to the design document's 10 second total request deadline. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 64;
const MAX_IMAGE_BYTES = MAX_RESPONSE_BYTES;
const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const SENSITIVE_KEY = /(?:secret|password|credential|authorization|api[-_]?(?:key|token)|access[-_]?token|capability[-_]?token|filetoken)/i;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]*/g;
const FILE_URI = /\bfile:\/\/[^\s"'<>|]*/gi;
const UNIX_ABSOLUTE_PATH = /(^|[\s"'(])\/(?:[^\s"'<>|]+)/gm;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;"']+/gi;
const INLINE_KEY_CREDENTIAL = /\b(?:api[-_]?key|access[-_]?token|capability[-_]?token|password|secret)\s*[:=]\s*[^\s,;"']+/gi;
const TOKEN_LIKE_CREDENTIAL = /\b(?:sk|ds)[_-][A-Za-z0-9_-]{16,}\b/g;
const SAFE_IMAGE_MIMES = new Set<McpImageMimeType>(['image/svg+xml', 'image/png', 'image/jpeg']);
const SAFE_ASSET_MIMES = new Set<McpAssetMimeType>(['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);

type SanitizerBudget = { nodes: number; seen: WeakSet<object> };

function sanitizeString(value: string): string {
  return value
    .replace(FILE_URI, '[local resource redacted]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[local path redacted]')
    .replace(UNIX_ABSOLUTE_PATH, '$1[local path redacted]')
    .replace(BEARER_CREDENTIAL, 'Bearer [redacted]')
    .replace(INLINE_KEY_CREDENTIAL, '[credential redacted]')
    .replace(TOKEN_LIKE_CREDENTIAL, '[credential redacted]');
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  // Keep domain concepts such as `tokens` / `designTokens`, but discard fields
  // that carry authentication tokens under alternate names like `sessionToken`.
  return normalized.includes('token') && normalized !== 'tokens' && normalized !== 'designtokens';
}

function sanitizeJson(value: unknown, budget: SanitizerBudget = { nodes: 0, seen: new WeakSet<object>() }, depth = 0): McpJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new McpDomainError('PAYLOAD_TOO_LARGE');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new McpDomainError('INVALID_ARGUMENT');
    return value;
  }
  if (typeof value !== 'object') throw new McpDomainError('INVALID_ARGUMENT');
  if (budget.seen.has(value)) throw new McpDomainError('INVALID_ARGUMENT');
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => sanitizeJson(item, budget, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new McpDomainError('INVALID_ARGUMENT');
    const result: Record<string, McpJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      const safeKey = sanitizeString(key);
      if (safeKey.includes('[local path redacted]')) continue;
      result[safeKey] = sanitizeJson(item, budget, depth + 1);
    }
    return result;
  } finally {
    budget.seen.delete(value);
  }
}

function safeJsonText(value: unknown): string {
  const text = JSON.stringify(sanitizeJson(value));
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new McpDomainError('PAYLOAD_TOO_LARGE');
  return text;
}

function safeMetadataText(metadata: McpJsonObject): string {
  return safeJsonText({ metadata });
}

function assertBase64(data: string): number {
  if (data.length > MAX_BASE64_IMAGE_CHARS) throw new McpDomainError('PAYLOAD_TOO_LARGE');
  if (!data || data.length % 4 !== 0) throw new McpDomainError('INVALID_ARGUMENT');
  const paddingIndex = data.indexOf('=');
  const payload = paddingIndex < 0 ? data : data.slice(0, paddingIndex);
  const paddingLength = data.length - payload.length;
  if (paddingLength > 2 || /[^A-Za-z0-9+/]/.test(payload)
    || paddingLength === 1 && payload.length % 4 !== 3
    || paddingLength === 2 && payload.length % 4 !== 2) throw new McpDomainError('INVALID_ARGUMENT');
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data) throw new McpDomainError('INVALID_ARGUMENT');
  if (decoded.byteLength > MAX_IMAGE_BYTES) throw new McpDomainError('PAYLOAD_TOO_LARGE');
  return decoded.byteLength;
}

function assertSafeSvg(mimeType: string, base64: string): void {
  if (mimeType !== 'image/svg+xml') return;
  const svg = Buffer.from(base64, 'base64').toString('utf8');
  if (!svg.trimStart().startsWith('<svg') || /<script\b|<foreignObject\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(/i.test(svg)) {
    throw new McpDomainError('ACCESS_DENIED');
  }
}

function resultWithText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(error: unknown): CallToolResult {
  const code = error instanceof McpDomainError ? error.code : 'APP_UNAVAILABLE';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message: DOMAIN_ERROR_MESSAGES[code] }) }]
  };
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpDomainError('REQUEST_TIMEOUT')), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function handleJson<TInput, TOutput extends McpJsonObject>(
  operation: (input: TInput) => Promise<TOutput>,
  timeoutMs: number
): (input: TInput) => Promise<CallToolResult> {
  return async input => {
    try {
      const data = await withDeadline(() => operation(input), timeoutMs);
      return resultWithText(safeJsonText(data));
    } catch (error) {
      return errorResult(error);
    }
  };
}

function handleScreenshot(source: McpDataSource, timeoutMs: number) {
  return async (input: GetScreenshotInput): Promise<CallToolResult> => {
    try {
      const output = await withDeadline(() => source.getScreenshot(input), timeoutMs);
      if (!SAFE_IMAGE_MIMES.has(output.image.mimeType)) throw new McpDomainError('INVALID_ARGUMENT');
      assertBase64(output.image.base64);
      assertSafeSvg(output.image.mimeType, output.image.base64);
      const metadataText = safeMetadataText(output.metadata);
      if (Buffer.byteLength(metadataText, 'utf8') + output.image.base64.length > MAX_RESPONSE_BYTES) throw new McpDomainError('PAYLOAD_TOO_LARGE');
      return {
        content: [
          { type: 'text', text: metadataText },
          { type: 'image', mimeType: output.image.mimeType, data: output.image.base64 }
        ]
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

function handleAssets(source: McpDataSource, timeoutMs: number) {
  return async (input: GetAssetsInput): Promise<CallToolResult> => {
    try {
      const output = await withDeadline(() => source.getAssets(input), timeoutMs);
      const content: CallToolResult['content'] = [];
      const assetManifest = output.assets.map(asset => {
        const metadata = sanitizeJson(asset.metadata) as McpJsonObject;
        if (!asset.content) return { metadata };
        if (!SAFE_ASSET_MIMES.has(asset.content.mimeType)) throw new McpDomainError('INVALID_ARGUMENT');
        const size = assertBase64(asset.content.base64);
        assertSafeSvg(asset.content.mimeType, asset.content.base64);
        const contentIndex = content.length + 1;
        if (asset.content.mimeType === 'text/plain') {
          const text = sanitizeString(Buffer.from(asset.content.base64, 'base64').toString('utf8'));
          if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new McpDomainError('PAYLOAD_TOO_LARGE');
          content.push({ type: 'text', text: JSON.stringify({ contentIndex, text }) });
        } else {
          content.push({ type: 'image', mimeType: asset.content.mimeType, data: asset.content.base64 });
        }
        return { metadata, contentIndex, contentMimeType: asset.content.mimeType, contentBytes: size };
      });
      const manifest: Record<string, McpJsonValue> = { assets: assetManifest };
      if (output.documentId !== undefined) manifest.documentId = sanitizeString(output.documentId);
      if (output.revision !== undefined) manifest.revision = output.revision;
      if (output.missingIds !== undefined) manifest.missingIds = output.missingIds.map(sanitizeString);
      if (output.nextCursor !== undefined) manifest.nextCursor = sanitizeString(output.nextCursor);
      if (output.diagnostics !== undefined) manifest.diagnostics = output.diagnostics.map(sanitizeString);
      const manifestText = safeJsonText(manifest);
      const attachmentTextBytes = content.reduce((sum, item) => {
        if (item.type === 'text') return sum + Buffer.byteLength(item.text, 'utf8');
        if (item.type === 'image') return sum + item.data.length;
        return sum;
      }, 0);
      if (Buffer.byteLength(manifestText, 'utf8') + attachmentTextBytes > MAX_RESPONSE_BYTES) throw new McpDomainError('PAYLOAD_TOO_LARGE');
      return { content: [{ type: 'text', text: manifestText }, ...content] };
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** Register the five documented read-only design tools on an SDK server instance. */
export function registerMcpTools(server: McpServer, source: McpDataSource, options: McpServerOptions = {}): void {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError('requestTimeoutMs must be between 1 and 60000');
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool('get_app_state', {
    description: 'Read the active MiaoMa design application state, document revision, pages, selection IDs, and supported capabilities.',
    inputSchema: getAppStateInputSchema,
    annotations
  }, handleJson((input: GetAppStateInput) => source.getAppState(input), timeoutMs));

  server.registerTool('get_selected_node', {
    description: 'Read the selected node IDs and their bounded node trees, variables, and served revision. Returns an empty selection when nothing is selected.',
    inputSchema: getSelectedNodeInputSchema,
    annotations
  }, handleJson((input: GetSelectedNodeInput) => source.getSelectedNode(input), timeoutMs));

  server.registerTool('get_nodes', {
    description: 'Read up to 500 requested design nodes with bounded depth, pagination, missing IDs, diagnostics, and an optional fixed revision.',
    inputSchema: getNodesInputSchema,
    annotations
  }, handleJson((input: GetNodesInput) => source.getNodes(input), timeoutMs));

  server.registerTool('get_screenshot', {
    description: 'Capture a bounded screenshot for the requested document nodes and optional revision, returning metadata and image content.',
    inputSchema: getScreenshotInputSchema,
    annotations
  }, handleScreenshot(source, timeoutMs));

  server.registerTool('get_assets', {
    description: 'Read an allowlisted asset manifest for the requested document and optionally return bounded asset image or text content.',
    inputSchema: getAssetsInputSchema,
    annotations
  }, handleAssets(source, timeoutMs));
}

/** Create an injectable MCP server instance for desktop integration and testing. */
export function createMcpServer(source: McpDataSource, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'miaoma-design', version: '0.1.0' }, {
    instructions: 'Expose read-only design data only. Use the served revision returned by a tool for subsequent reads. Never infer unselected nodes or request data outside the active project grant.',
    capabilities: { tools: {} }
  });
  registerMcpTools(server, source, options);
  return server;
}

/** Start one stdio connection. The SDK owns stdout as the JSON-RPC channel. */
export function serveMcpStdio(source: McpDataSource, options: McpServerOptions = {}): StdioServerHandle {
  return serveStdio(() => createMcpServer(source, options));
}
