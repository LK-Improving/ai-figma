import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const readyPath = process.argv[2];
const resultPath = process.argv[3];
if (!readyPath || !resultPath) throw new Error('Usage: s5-workflow-client.mjs <ready.json> <result.json>');
let client;

function parseText(result) {
  assert.equal(result.isError, undefined, result.content?.find((item) => item.type === 'text')?.text ?? 'MCP tool call failed');
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'MCP tool returned no JSON text content');
  return JSON.parse(text);
}

try {
  const ready = JSON.parse(await readFile(readyPath, 'utf8'));
  assert.equal(typeof ready.endpointPath, 'string');
  assert.equal(typeof ready.sidecarEntry, 'string');
  client = new Client({ name: 'miaoma-s5-external-acceptance', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [ready.sidecarEntry, '--endpoint-file', ready.endpointPath] });
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['get_app_state', 'get_assets', 'get_nodes', 'get_screenshot', 'get_selected_node'].sort());
  assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));

  const state = parseText(await client.callTool({ name: 'get_app_state', arguments: {} }));
  assert.equal(state.projectId, ready.projectId);
  assert.equal(state.document.documentId, ready.documentId);
  assert.equal(state.document.revision, ready.revision);
  assert.equal(state.capabilities.readOnly, true);

  const selection = parseText(await client.callTool({ name: 'get_selected_node', arguments: { documentId: ready.documentId, revision: ready.revision } }));
  assert.equal(selection.revision, ready.revision);
  assert.deepEqual(selection.selectionIds, [ready.selectedNodeId]);
  assert.equal(selection.nodes[0].id, ready.selectedNodeId);

  const nodes = parseText(await client.callTool({ name: 'get_nodes', arguments: { documentId: ready.documentId, nodeIds: [ready.selectedNodeId], revision: ready.revision } }));
  assert.equal(nodes.revision, ready.revision);
  assert.equal(nodes.nodes[0].id, ready.selectedNodeId);
  assert.equal(nodes.nodes[0].text, ready.expectedText);

  const screenshot = await client.callTool({ name: 'get_screenshot', arguments: { documentId: ready.documentId, nodeIds: [ready.selectedNodeId], revision: ready.revision } });
  const screenshotMetadata = parseText(screenshot);
  assert.equal(screenshotMetadata.metadata.documentRevision, ready.revision);
  assert.deepEqual(screenshot.content.map((item) => item.type), ['text', 'image']);
  assert.equal(screenshot.content[1].mimeType, 'image/svg+xml');

  const assets = await client.callTool({ name: 'get_assets', arguments: { documentId: ready.documentId, assetIds: [ready.assetId], revision: ready.revision, includeContent: true } });
  const manifest = parseText(assets);
  assert.equal(manifest.revision, ready.revision);
  assert.equal(manifest.assets[0].metadata.sha256, ready.assetSha256);
  const pngContent = assets.content.find((item) => item.type === 'image' && item.mimeType === 'image/png');
  assert.ok(pngContent, 'The PNG asset content is missing');
  const contentSha256 = createHash('sha256').update(Buffer.from(pngContent.data, 'base64')).digest('hex');
  assert.equal(contentSha256, ready.assetSha256, 'PNG asset bytes do not match the manifest SHA-256');

  const stale = await client.callTool({ name: 'get_nodes', arguments: { documentId: ready.documentId, nodeIds: [ready.selectedNodeId], revision: Math.max(0, ready.revision - 1) } });
  assert.equal(stale.isError, true, 'A stale design revision must be rejected');
  assert.match(stale.content[0].text, /INVALID_ARGUMENT/);

  await writeFile(resultPath, `${JSON.stringify({ s5ExternalClient: 'passed', toolNames, documentId: ready.documentId, revision: ready.revision, selectedNodeId: ready.selectedNodeId, assetId: ready.assetId, staleRevisionRejected: true }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ s5ExternalClient: 'passed', toolNames, documentId: ready.documentId, revision: ready.revision }));
} catch (error) {
  const failure = { s5ExternalClient: 'failed', error: error instanceof Error ? error.message : 'Unknown external client failure' };
  await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => undefined);
}
