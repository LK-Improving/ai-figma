import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarterDocument } from '@miaoma/editor-core';
import { renderDocumentScreenshot } from '../dist/index.js';

test('targeted screenshots crop to requested nodes and exclude unrelated siblings', () => {
  const document = createStarterDocument('Screenshot test', 'Page');
  const root = document.pages[0].root;
  root.children.push({
    ...structuredClone(root.children[0]),
    id: 'text_unrelated',
    name: 'Unrelated sibling',
    bounds: { x: 1200, y: 400, width: 120, height: 80 }
  });

  const pageShot = renderDocumentScreenshot(document, document.pages[0].id);
  const selectedShot = renderDocumentScreenshot(document, document.pages[0].id, 1, 2048, ['text_title']);

  assert.match(pageShot.svg, /data-node-id="text_unrelated"/);
  assert.doesNotMatch(selectedShot.svg, /data-node-id="text_unrelated"/);
  assert.match(selectedShot.svg, /viewBox="72 72 960 96"/);
  assert.ok(selectedShot.metadata.nodeIds.includes('text_title'));
  assert.ok(!selectedShot.metadata.nodeIds.includes('text_unrelated'));
});

test('targeted screenshots reject unknown and duplicate node IDs', () => {
  const document = createStarterDocument('Screenshot test', 'Page');
  assert.throws(() => renderDocumentScreenshot(document, document.pages[0].id, 1, 2048, ['missing']), /not found/);
  assert.throws(() => renderDocumentScreenshot(document, document.pages[0].id, 1, 2048, ['text_title', 'text_title']), /unique IDs/);
});

test('screenshots embed only document-owned raster assets and report asset readiness', () => {
  const document = createStarterDocument('Asset screenshot', 'Page');
  document.assets.photo_test = {
    id: 'photo_test', mimeType: 'image/png', relativePath: 'assets/photo.png', sha256: 'a'.repeat(64), byteSize: 8
  };
  document.pages[0].root.children.push({
    id: 'photo_node', type: 'rectangle', name: 'Photo', visible: true, locked: false,
    bounds: { x: 100, y: 240, width: 320.5, height: 180.25 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [{ type: 'asset', assetId: 'photo_test' }], strokes: [], effects: [], opacity: 1 }, radius: 0
  });

  const ready = renderDocumentScreenshot(document, document.pages[0].id, 1, 2048, undefined, { photo_test: 'data:image/jpeg;base64,ZmFrZQ==' });
  const missing = renderDocumentScreenshot(document);
  const untrusted = renderDocumentScreenshot(document, document.pages[0].id, 1, 2048, undefined, { photo_test: 'https://example.invalid/photo.jpg' });

  assert.equal(ready.metadata.assets, 'ready');
  assert.match(ready.svg, /<image data-node-id="photo_node"[^>]+href="data:image\/jpeg;base64,ZmFrZQ=="/);
  assert.equal(missing.metadata.assets, 'missing');
  assert.equal(untrusted.metadata.assets, 'missing');
  assert.doesNotMatch(untrusted.svg, /https:\/\/example\.invalid/);
});
