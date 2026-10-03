import assert from 'node:assert/strict';
import test from 'node:test';
import { McpDomainError, registerMcpTools } from '../dist/index.js';

const toolNames = ['get_app_state', 'get_selected_node', 'get_nodes', 'get_screenshot', 'get_assets'];

function register(source, options) {
  const tools = new Map();
  const sdkServer = {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    }
  };
  registerMcpTools(sdkServer, source, options);
  return tools;
}

function source(overrides = {}) {
  return {
    async getAppState(input) { return { documentId: input.documentId ?? 'doc-1', revision: 7, pages: [], selectedNodeIds: [], capabilities: ['read'] }; },
    async getSelectedNode() { return { selectionIds: [], nodes: [], variables: {}, servedRevision: 7 }; },
    async getNodes(input) { return { nodes: [], missingIds: [], nextCursor: null, diagnostics: [], servedRevision: input.revision ?? 7 }; },
    async getScreenshot() { return { metadata: { documentId: 'doc-1', revision: 7 }, image: { mimeType: 'image/png', base64: Buffer.from('fixture-image').toString('base64') } }; },
    async getAssets() { return { documentId: 'doc-1', revision: 7, assets: [], missingIds: [], nextCursor: undefined }; },
    ...overrides
  };
}

test('registers exactly the five read-only design tools', () => {
  const tools = register(source());
  assert.deepEqual([...tools.keys()], toolNames);
  for (const { config } of tools.values()) {
    assert.equal(config.annotations.readOnlyHint, true);
    assert.equal(config.annotations.destructiveHint, false);
    assert.equal(config.annotations.idempotentHint, true);
    assert.equal(config.annotations.openWorldHint, false);
  }
});

test('tool schemas enforce IDs, pagination, depth, scale, and edge bounds', () => {
  const tools = register(source());
  assert.equal(tools.get('get_app_state').config.inputSchema.safeParse({}).success, true);
  assert.equal(tools.get('get_app_state').config.inputSchema.safeParse({ documentId: '../private' }).success, false);

  const selectedSchema = tools.get('get_selected_node').config.inputSchema;
  assert.equal(selectedSchema.safeParse({ depth: 8 }).success, true);
  assert.equal(selectedSchema.safeParse({ depth: 9 }).success, false);

  const nodesSchema = tools.get('get_nodes').config.inputSchema;
  assert.equal(nodesSchema.safeParse({ documentId: 'doc-1', nodeIds: ['node-1'], depth: 0 }).success, true);
  assert.equal(nodesSchema.safeParse({ documentId: 'doc-1', nodeIds: Array.from({ length: 501 }, (_, i) => `node-${i}`) }).success, false);

  const screenshotSchema = tools.get('get_screenshot').config.inputSchema;
  assert.equal(screenshotSchema.safeParse({ documentId: 'doc-1', nodeIds: ['node-1'], scale: 2, maxEdge: 4096 }).success, true);
  assert.equal(screenshotSchema.safeParse({ documentId: 'doc-1', nodeIds: ['node-1'], scale: 2.1 }).success, false);

  const assetsSchema = tools.get('get_assets').config.inputSchema;
  assert.equal(assetsSchema.safeParse({ documentId: 'doc-1', assetIds: [], revision: 7 }).success, true);
  assert.equal(assetsSchema.safeParse({ documentId: 'doc-1', revision: -1 }).success, false);
  assert.equal(screenshotSchema.safeParse({ documentId: 'doc-1', nodeIds: ['node-1'], maxEdge: 4097 }).success, false);

  assert.equal(assetsSchema.safeParse({ documentId: 'doc-1', includeContent: true }).success, true);
  assert.equal(assetsSchema.safeParse({ documentId: 'doc-1', assetIds: Array.from({ length: 501 }, (_, i) => `asset-${i}`) }).success, false);
});

test('passes app-state data through as bounded, sanitized JSON', async () => {
  const tools = register(source({
    async getAppState(input) {
      assert.deepEqual(input, {});
      return {
        documentId: 'doc-1',
        revision: 8,
        pages: [{ id: 'page-1', name: 'Overview' }],
        documentPath: 'C:\\Users\\secret\\design.json',
        fileToken: 'do-not-return',
        note: 'stored at /home/alice/private/design.json with Bearer abc.def.ghi'
      };
    }
  }));
  const input = tools.get('get_app_state').config.inputSchema.parse({});
  const result = await tools.get('get_app_state').handler(input);
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.documentId, 'doc-1');
  assert.equal(payload.revision, 8);
  assert.equal(payload.fileToken, undefined);
  assert.doesNotMatch(result.content[0].text, /C:\\Users|\/home\/alice|abc\.def\.ghi|do-not-return/);
  assert.match(result.content[0].text, /local path redacted/);
});

test('forwards screenshot bytes as an MCP image block with metadata text', async () => {
  const tools = register(source());
  const input = tools.get('get_screenshot').config.inputSchema.parse({ documentId: 'doc-1', nodeIds: ['node-1'] });
  const result = await tools.get('get_screenshot').handler(input);
  assert.deepEqual(result.content.map(item => item.type), ['text', 'image']);
  assert.deepEqual(JSON.parse(result.content[0].text), { metadata: { documentId: 'doc-1', revision: 7 } });
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), 'fixture-image');
});

test('returns asset metadata and maps image/text attachments to MCP content', async () => {
  const tools = register(source({
    async getAssets() {
      return {
        documentId: 'doc-1',
        revision: 3,
        missingIds: ['asset-missing'],
        assets: [
          { metadata: { id: 'asset-1', mimeType: 'image/png' }, content: { mimeType: 'image/png', base64: Buffer.from('pixel').toString('base64') } },
          { metadata: { id: 'asset-2', mimeType: 'text/plain' }, content: { mimeType: 'text/plain', base64: Buffer.from('Label at C:\\private\\note.txt').toString('base64') } }
        ]
      };
    }
  }));
  const input = tools.get('get_assets').config.inputSchema.parse({ documentId: 'doc-1', includeContent: true });
  const result = await tools.get('get_assets').handler(input);
  assert.deepEqual(result.content.map(item => item.type), ['text', 'image', 'text']);
  const manifest = JSON.parse(result.content[0].text);
  assert.equal(manifest.documentId, 'doc-1');
  assert.equal(manifest.revision, 3);
  assert.deepEqual(manifest.missingIds, ['asset-missing']);
  assert.equal(manifest.assets[0].contentIndex, 1);
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.match(result.content[2].text, /local path redacted/);
});

test('maps domain and unexpected errors to safe bounded tool errors', async () => {
  const domainTools = register(source({ async getNodes() { throw new McpDomainError('ACCESS_DENIED'); } }));
  const nodesInput = domainTools.get('get_nodes').config.inputSchema.parse({ documentId: 'doc-1', nodeIds: ['node-1'] });
  const domainResult = await domainTools.get('get_nodes').handler(nodesInput);
  assert.equal(domainResult.isError, true);
  assert.deepEqual(JSON.parse(domainResult.content[0].text), {
    code: 'ACCESS_DENIED',
    message: 'The requested design data is not available to this client.'
  });

  const failingTools = register(source({ async getAppState() { throw new Error('failed at C:\\private\\app.js with sk-live-not-a-real-key-12345'); } }));
  const appInput = failingTools.get('get_app_state').config.inputSchema.parse({});
  const failure = await failingTools.get('get_app_state').handler(appInput);
  assert.equal(failure.isError, true);
  assert.doesNotMatch(failure.content[0].text, /C:\\private|sk-live/);
  assert.match(failure.content[0].text, /APP_UNAVAILABLE/);
});

test('rejects oversized image payloads with a domain tool error', async () => {
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
  const tools = register(source({
    async getScreenshot() {
      return { metadata: { revision: 1 }, image: { mimeType: 'image/png', base64: oversized } };
    }
  }));
  const input = tools.get('get_screenshot').config.inputSchema.parse({ documentId: 'doc-1', nodeIds: ['node-1'] });
  const result = await tools.get('get_screenshot').handler(input);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PAYLOAD_TOO_LARGE/);
});
