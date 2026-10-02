import assert from 'node:assert/strict';
import {
  backingStoreToWorld,
  canvasCssToBackingStore,
  clientToBackingStore,
  clientToWorld,
  commitDragDraft,
  createDragDraft,
  createViewport,
  getNodeLocalToWorldMatrix,
  getNodeWorldBounds,
  hitTestDocument,
  keyboardNudgeDelta,
  nodesIntersectingClientRect,
  updateDragDraft,
  updateSelection,
  worldToBackingStore,
  worldToClient,
  zoomViewportAt
} from './dist/index.js';

const rect = { left: 100, top: 50, width: 800, height: 600 };
const viewport = createViewport({ zoom: 2, panX: 3, panY: 5 });
const world = { x: 7, y: 11 };
const client = worldToClient(world, rect, viewport);
assert.deepEqual(clientToWorld(client, rect, viewport), world, 'client CSS coordinates invert viewport once');
const backing = clientToBackingStore(client, rect, 2);
assert.deepEqual(backing, canvasCssToBackingStore({ x: 17, y: 27 }, 2), 'client-to-backing subtracts DOM origin before applying DPR');
assert.deepEqual(backingStoreToWorld(backing, 2, viewport), world, 'backing-to-world removes DPR before the viewport inverse');
assert.deepEqual(worldToBackingStore(world, viewport, 2), backing, 'world-to-backing applies DPR once');
const anchor = { x: 260, y: 180 };
const zoomed = zoomViewportAt(createViewport({ zoom: 1, panX: 12, panY: -8 }), anchor, 1.75);
const oldWorldAnchor = { x: anchor.x - 12, y: anchor.y + 8 };
assert.deepEqual({ x: oldWorldAnchor.x * zoomed.zoom + zoomed.panX, y: oldWorldAnchor.y * zoomed.zoom + zoomed.panY }, anchor, 'zoom keeps its CSS anchor fixed');

const emptyStyle = { fills: [], strokes: [], effects: [], opacity: 1 };
function base(id, type, x, y, width, height, transform = {}) {
  return {
    id, type, name: id, visible: true, locked: false,
    bounds: { x, y, width, height },
    transform: { rotation: 0, scaleX: 1, scaleY: 1, ...transform },
    style: emptyStyle
  };
}
const rectangle = { ...base('rect', 'rectangle', 20, 20, 100, 100), radius: 0 };
const ellipse = base('ellipse', 'ellipse', 40, 40, 80, 80);
const icon = { ...base('icon', 'icon', 160, 20, 40, 40), iconKey: 'plus' };
const text = { ...base('text', 'text', 220, 20, 100, 40), text: 'Hello', typography: { fontFamily: 'Arial', fontSize: 16, fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, textAlign: 'left', color: '#000000' }, sizing: 'fixed' };
const locked = { ...base('locked', 'rectangle', 360, 20, 40, 40), locked: true, radius: 0 };
const hidden = { ...base('hidden', 'rectangle', 410, 20, 40, 40), visible: false, radius: 0 };
const clipped = { ...base('clipped', 'rectangle', 520, 20, 30, 30), radius: 0 };
const transformedFrame = {
  ...base('frame', 'frame', 0, 0, 500, 400),
  children: [rectangle, ellipse, icon, text, locked, hidden, clipped],
  layout: { mode: 'absolute' }, clipContent: true
};
const document = {
  documentVersion: '1.0', documentId: 'doc_self_check', fileToken: 'self-check-file-token', revision: 4, title: 'Self check',
  pages: [{ id: 'page', name: 'Page', root: transformedFrame }], variables: {}, assets: {}
};
const identityViewport = createViewport();
const pointAt = (x, y) => ({ x: x + rect.left, y: y + rect.top });
for (const dpr of [1, 1.5]) {
  for (const zoom of [0.25, 1]) {
    const testViewport = createViewport({ zoom });
    const expectedWorld = { x: 80, y: 80 };
    const cssPoint = worldToClient(expectedWorld, rect, testViewport);
    const backingPoint = clientToBackingStore(cssPoint, rect, dpr);
    const roundTrippedWorld = backingStoreToWorld(backingPoint, dpr, testViewport);
    const roundTrippedClient = worldToClient(roundTrippedWorld, rect, testViewport);
    assert.equal(hitTestDocument(document, 'page', roundTrippedClient, rect, testViewport)[0]?.node.id, 'ellipse', `DPR ${dpr} and ${zoom * 100}% zoom select the same node`);
  }
}
assert.equal(hitTestDocument(document, 'page', pointAt(80, 80), rect, identityViewport)[0]?.node.id, 'ellipse', 'reverse paint-order returns topmost ellipse');
assert.equal(hitTestDocument(document, 'page', pointAt(41, 41), rect, identityViewport)[0]?.node.id, 'rect', 'ellipse hit testing rejects points outside its curve');
assert.equal(hitTestDocument(document, 'page', pointAt(170, 30), rect, identityViewport)[0]?.node.id, 'icon', 'icon hit tests its bounds');
assert.equal(hitTestDocument(document, 'page', pointAt(230, 30), rect, identityViewport)[0]?.node.id, 'text', 'text hit tests its bounds');
assert.equal(hitTestDocument(document, 'page', pointAt(370, 30), rect, identityViewport).some((hit) => hit.node.id === 'locked'), false, 'locked node is excluded by default');
assert.equal(hitTestDocument(document, 'page', pointAt(370, 30), rect, identityViewport, { includeLocked: true })[0]?.node.id, 'locked', 'locked node can be selected with explicit opt-in');
assert.equal(hitTestDocument(document, 'page', pointAt(420, 30), rect, identityViewport).some((hit) => hit.node.id === 'hidden'), false, 'hidden node is not hit');
assert.equal(hitTestDocument(document, 'page', pointAt(530, 30), rect, identityViewport).length, 0, 'Frame clip excludes children and frame outside its content bounds');
assert.equal(nodesIntersectingClientRect(document, 'page', { x: 145, y: 95, width: 30, height: 30 }, rect, identityViewport).some((hit) => hit.node.id === 'ellipse'), true, 'marquee selection converts from CSS client coordinates');
assert.equal(nodesIntersectingClientRect(document, 'page', { x: 615, y: 115, width: 35, height: 35 }, rect, identityViewport).some((hit) => hit.node.id === 'clipped'), false, 'marquee selection respects Frame clipping');

const parent = { ...base('parent', 'frame', 100, 80, 200, 120, { rotation: 90 }), children: [], layout: { mode: 'absolute' }, clipContent: true };
const parentMatrix = getNodeLocalToWorldMatrix(parent);
const child = { ...base('child', 'rectangle', 10, 20, 40, 30, { scaleX: 2 }), radius: 0 };
const childWorld = getNodeWorldBounds(child, parentMatrix);
assert.ok(Math.abs(childWorld.width - 30) < 1e-9 && Math.abs(childWorld.height - 80) < 1e-9, 'nested 90° rotation and node scale produce correct world AABB');

const draggable = { ...base('drag-me', 'rectangle', 10, 20, 40, 30), radius: 0 };
const dragStart = createDragDraft(draggable, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 9, pointAt(110, 70), rect, identityViewport);
const dragUpdate = updateDragDraft(dragStart, pointAt(130, 80), rect, identityViewport, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, { snapToGrid: true, gridSize: 8 });
assert.deepEqual(dragUpdate.draftBounds, { ...draggable.bounds, x: 32, y: 32 }, 'drag remains a draft and snaps parent-local position to grid');
assert.deepEqual(commitDragDraft(dragUpdate), { nodeId: 'drag-me', baseRevision: 9, from: draggable.bounds, to: dragUpdate.draftBounds, delta: { x: 22, y: 12 } }, 'commit descriptor preserves revision and delta');
assert.deepEqual(keyboardNudgeDelta('left'), { x: -1, y: 0 });
assert.deepEqual(keyboardNudgeDelta('down', true), { x: 0, y: 10 });
assert.deepEqual(updateSelection(['a'], 'b', 'add'), ['a', 'b']);
assert.deepEqual(updateSelection(['a', 'b'], 'a', 'toggle'), ['b']);

console.log('editor-interaction self-check passed (DPR, viewport, transformed hit testing, clipping, selection, drag, snap, nudge).');
