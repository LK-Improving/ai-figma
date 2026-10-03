import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpMainBridge } from '../../desktop/dist/mcp-main-bridge.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sidecarEntry = path.resolve(currentDir, '../dist/stdio.js');
const pixelBytes = Buffer.from('fixture-png-bytes');

function makeContext(revision = 7) {
  const child = { id: 'node-one', type: 'rectangle', name: 'Card', visible: true, locked: false, bounds: { x: 8, y: 8, width: 100, height: 60 }, children: [] };
  const root = { id: 'frame-one', type: 'frame', name: 'Canvas', visible: true, locked: false, bounds: { x: 0, y: 0, width: 400, height: 300 }, children: [child] };
  return {
    projectId: 'project-one',
    documentId: 'document-one',
    title: 'MCP fixture',
    revision,
    pages: [{ id: 'page-one', name: 'Page 1', width: 400, height: 300 }],
    variables: { color_ink: { type: 'color', value: '#223344' } },
    selectionIds: ['node-one'],
    nodesById: new Map([[root.id, root], [child.id, child]]),
    pageIdByNode: new Map([[root.id, 'page-one'], [child.id, 'page-one']]),
    assets: { asset_one: { id: 'asset_one', mimeType: 'image/png', byteSize: pixelBytes.byteLength, sha256: '0'.repeat(64) } }
  };
}

async function connect(endpointPath) {
  const client = new Client({ name: 'miaoma-s4-e2e', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [sidecarEntry, '--endpoint-file', endpointPath] });
  await client.connect(transport);
  return client;
}

function connectBridgeAddress(address) {
  if (process.platform !== 'win32') return createConnection(address);
  const match = /^tcp:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(address);
  assert.ok(match, 'Windows MCP bridge must bind to IPv4 loopback only');
  return createConnection({ host: '127.0.0.1', port: Number(match[1]) });
}

async function requestBridgeRaw(address, request) {
  const socket = connectBridgeAddress(address);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return await new Promise((resolve, reject) => {
    const chunks = [];
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks).toString('utf8');
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd >= 0) { socket.destroy(); resolve(JSON.parse(buffer.slice(0, lineEnd))); }
    });
    socket.end(`${JSON.stringify(request)}\n`);
  });
}

test('S4 sidecar lists five tools, returns fixed-revision reads, and revocation fences stale sidecars', async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'miaoma-s4-main-'));
  let context = makeContext();
  const bridge = new McpMainBridge(userDataPath, {
    getDocumentContext: () => context,
    async getAsset(projectId, documentId, assetId, expectedRevision) {
      assert.equal(projectId, 'project-one');
      assert.equal(documentId, 'document-one');
      assert.equal(assetId, 'asset_one');
      assert.equal(expectedRevision, context.revision);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { mimeType: 'image/png', base64: pixelBytes.toString('base64') };
    },
    renderScreenshot({ pageId, scale, maxEdge }) {
      return { metadata: { pageId, revision: context.revision, width: 400, height: 300, scale, maxEdge }, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#fff"/></svg>' };
    }
  });

  let oldClient;
  let newClient;
  try {
    await bridge.start();
    const status = bridge.getStatus();
    assert.equal(status.endpointReady, true);
    assert.equal(Object.hasOwn(status, 'token'), false);
    assert.equal(Object.hasOwn(status, 'endpointPath'), false);
    assert.deepEqual([...status.toolNames], ['get_app_state', 'get_selected_node', 'get_nodes', 'get_screenshot', 'get_assets']);
    await assert.rejects(bridge.setGrant('project-other', 'document-one'), /active project and document/);
    await bridge.setGrant('project-one', 'document-one');

    const endpointBeforeRegrant = JSON.parse(await readFile(bridge.getEndpointPath(), 'utf8'));
    assert.equal(typeof endpointBeforeRegrant.token, 'string');
    if (process.platform === 'win32') {
      const userIdentity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const userSid = userIdentity.match(/S-\d-(?:\d+-)+\d+/)?.[0];
      assert.ok(userSid);
      const icaclsPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
      const acl = execFileSync(icaclsPath, [path.dirname(bridge.getEndpointPath())], { encoding: 'utf8', windowsHide: true });
      assert.ok(acl.includes(os.userInfo().username));
      assert.match(acl, /SYSTEM/i);
      assert.match(acl, /Administrators/i);
      assert.doesNotMatch(acl, /Everyone|Authenticated Users/i);
    }
    const idleSocket = connectBridgeAddress(endpointBeforeRegrant.address);
    await new Promise((resolve, reject) => { idleSocket.once('connect', resolve); idleSocket.once('error', reject); });
    const idleClosed = await Promise.race([
      new Promise((resolve) => idleSocket.once('close', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_500))
    ]);
    idleSocket.destroy();
    assert.equal(idleClosed, true, 'unauthenticated handshakes must have an absolute deadline');
    oldClient = await connect(bridge.getEndpointPath());

    const listed = await oldClient.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['get_app_state', 'get_selected_node', 'get_nodes', 'get_screenshot', 'get_assets']);

    const appState = await oldClient.callTool({ name: 'get_app_state', arguments: {} });
    const stateText = appState.content.find((part) => part.type === 'text').text;
    const state = JSON.parse(stateText);
    assert.equal(state.document.documentId, 'document-one');
    assert.equal(state.document.revision, 7);
    assert.equal(state.capabilities.readOnly, true);
    assert.doesNotMatch(stateText, /token|secret|C:\\|file:\/\//i);

    const nodes = await oldClient.callTool({ name: 'get_nodes', arguments: { documentId: 'document-one', nodeIds: ['node-one'], revision: 7 } });
    assert.equal(JSON.parse(nodes.content[0].text).nodes[0].id, 'node-one');

    const screenshot = await oldClient.callTool({ name: 'get_screenshot', arguments: { documentId: 'document-one', nodeIds: ['node-one'], revision: 7, maxEdge: 1024 } });
    assert.deepEqual(screenshot.content.map((item) => item.type), ['text', 'image']);
    assert.equal(screenshot.content[1].mimeType, 'image/svg+xml');
    assert.equal(Buffer.from(screenshot.content[1].data, 'base64').toString().startsWith('<svg'), true);
    const duplicateTargets = await oldClient.callTool({ name: 'get_screenshot', arguments: { documentId: 'document-one', nodeIds: ['node-one', 'node-one'], revision: 7 } });
    assert.equal(duplicateTargets.isError, true);
    assert.match(duplicateTargets.content[0].text, /INVALID_ARGUMENT/);
    const tooSmallScreenshot = await oldClient.callTool({ name: 'get_screenshot', arguments: { documentId: 'document-one', nodeIds: ['node-one'], revision: 7, maxEdge: 63 } });
    assert.equal(tooSmallScreenshot.isError, true);

    const multiSelection = makeContext();
    multiSelection.selectionIds = Array.from({ length: 101 }, (_, index) => `selection_${index}`);
    for (const id of multiSelection.selectionIds) multiSelection.nodesById.set(id, { id, type: 'rectangle', children: [] });
    context = multiSelection;
    const selected = await oldClient.callTool({ name: 'get_selected_node', arguments: { documentId: 'document-one', revision: 7 } });
    const selectedValue = JSON.parse(selected.content[0].text);
    assert.equal(selectedValue.selectionIds.length, 100);
    assert.equal(selectedValue.nodes.length, 100);
    assert.match(selectedValue.diagnostics[0], /truncated/i);
    context = makeContext();

    const assets = await oldClient.callTool({ name: 'get_assets', arguments: { documentId: 'document-one', assetIds: ['asset_one'], revision: 7, includeContent: true } });
    assert.equal(assets.content.some((item) => item.type === 'image' && Buffer.from(item.data, 'base64').equals(pixelBytes)), true, JSON.stringify(assets).slice(0, 1200));

    const rawEndpoint = JSON.parse(await readFile(bridge.getEndpointPath(), 'utf8'));
    const resetClient = connectBridgeAddress(rawEndpoint.address);
    await new Promise((resolve, reject) => { resetClient.once('connect', resolve); resetClient.once('error', reject); });
    resetClient.write(`${JSON.stringify({ protocolVersion: 1, requestId: 'reset-test', token: rawEndpoint.token, method: 'get_assets', params: { documentId: 'document-one', assetIds: ['asset_one'], includeContent: true } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    resetClient.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const denied = await oldClient.callTool({ name: 'get_app_state', arguments: { projectId: 'project-other' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /ACCESS_DENIED/);

    const previousToken = endpointBeforeRegrant.token;
    await bridge.setGrant('project-one', 'document-one');
    const endpointAfterRegrant = JSON.parse(await readFile(bridge.getEndpointPath(), 'utf8'));
    assert.notEqual(endpointAfterRegrant.token, previousToken);
    const staleToken = await requestBridgeRaw(endpointAfterRegrant.address, {
      protocolVersion: 1, requestId: 'stale-token-test', token: previousToken, method: 'get_app_state', params: {}
    });
    assert.equal(staleToken.ok, false);
    assert.equal(staleToken.error.code, 'ACCESS_DENIED');
    const staleClientResult = await oldClient.callTool({ name: 'get_app_state', arguments: {} });
    assert.equal(JSON.parse(staleClientResult.content[0].text).document.revision, 7);

    await oldClient.close();
    oldClient = undefined;
    newClient = await connect(bridge.getEndpointPath());
    const freshRead = await newClient.callTool({ name: 'get_app_state', arguments: {} });
    assert.equal(JSON.parse(freshRead.content[0].text).document.revision, 7);

    await bridge.stop();
    const restartRead = newClient.callTool({ name: 'get_app_state', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.start();
    await bridge.setGrant('project-one', 'document-one');
    const recoveredRead = await restartRead;
    assert.equal(JSON.parse(recoveredRead.content[0].text).document.revision, 7);

    bridge.revokeGrant();
    const revokedRead = await newClient.callTool({ name: 'get_app_state', arguments: {} });
    assert.equal(revokedRead.isError, true);
    assert.match(revokedRead.content[0].text, /ACCESS_DENIED/);

    context = makeContext(8);
    await bridge.setGrant('project-one', 'document-one');
    await newClient.close();
    newClient = await connect(bridge.getEndpointPath());
    const staleRevision = await newClient.callTool({ name: 'get_nodes', arguments: { documentId: 'document-one', nodeIds: ['node-one'], revision: 7 } });
    assert.equal(staleRevision.isError, true);
    assert.match(staleRevision.content[0].text, /INVALID_ARGUMENT/);

    const bulk = makeContext(9);
    const children = Array.from({ length: 50_000 }, (_, index) => ({ id: `node_${index}`, type: 'rectangle', name: `Node ${index}`, visible: true, locked: false, bounds: { x: 0, y: 0, width: 1, height: 1 }, style: { fills: [], strokes: [], effects: [], opacity: 1 } }));
    const bulkRoot = { id: 'bulk_root', type: 'frame', name: 'Large tree', visible: true, locked: false, bounds: { x: 0, y: 0, width: 400, height: 300 }, children };
    bulk.nodesById.set(bulkRoot.id, bulkRoot);
    bulk.pageIdByNode.set(bulkRoot.id, 'page-one');
    for (const node of children) { bulk.nodesById.set(node.id, node); bulk.pageIdByNode.set(node.id, 'page-one'); }
    context = bulk;
    await newClient.close();
    await bridge.setGrant('project-one', 'document-one');
    newClient = await connect(bridge.getEndpointPath());
    const boundedTree = await newClient.callTool({ name: 'get_nodes', arguments: { documentId: 'document-one', nodeIds: ['bulk_root'], depth: 1, revision: 9 } });
    assert.equal(boundedTree.isError, true);
    assert.match(boundedTree.content[0].text, /PAYLOAD_TOO_LARGE/);

    context = makeContext(10);
    context.assets.asset_large = { id: 'asset_large', mimeType: 'image/png', byteSize: 4 * 1024 * 1024 + 1, sha256: '0'.repeat(64) };
    await newClient.close();
    await bridge.setGrant('project-one', 'document-one');
    newClient = await connect(bridge.getEndpointPath());
    const oversizedAsset = await newClient.callTool({ name: 'get_assets', arguments: { documentId: 'document-one', assetIds: ['asset_large'], revision: 10, includeContent: true } });
    assert.equal(oversizedAsset.isError, true);
    assert.match(oversizedAsset.content[0].text, /PAYLOAD_TOO_LARGE/);
  } finally {
    await oldClient?.close().catch(() => undefined);
    await newClient?.close().catch(() => undefined);
    await bridge.stop();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
