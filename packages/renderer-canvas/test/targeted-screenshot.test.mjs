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
