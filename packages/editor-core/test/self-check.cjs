"use strict";

const assert = require('node:assert/strict');
const { createStarterDocument } = require('../dist/index.js');
const { CommandService, DocumentStore, EditorCommandError } = require('../dist/commands.js');

const style = () => ({ fills: [{ type: 'solid', color: '#8fae9c' }], strokes: [], effects: [], opacity: 1 });
const rectangle = (id, name = id) => ({
  id, type: 'rectangle', name, visible: true, locked: false,
  bounds: { x: 0, y: 0, width: 100, height: 80 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style(), radius: 8
});
const frame = (id) => ({
  id, type: 'frame', name: id, visible: true, locked: false,
  bounds: { x: 20, y: 20, width: 320, height: 240 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style(), children: [],
  layout: { mode: 'absolute' }, clipContent: true
});
const expectCode = (code, fn) => assert.throws(fn, (error) => error instanceof EditorCommandError && error.code === code);

function rootChildren(commands) {
  return commands.store.getSnapshot().pages[0].root.children;
}

const store = new DocumentStore(createStarterDocument('S1 editor-core self-check'));
const commands = new CommandService(store);
assert.deepEqual(store.getHistoryState(), { revision: 1, canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 });

// Document title edits participate in revisions and history like node edits.
let titleResult = commands.execute({ baseRevision: 1, commandId: 'rename-title', commands: [{ type: 'rename-document', title: '  Miaoma Studio  ' }] });
assert.equal(titleResult.document.title, 'Miaoma Studio');
assert.equal(titleResult.revision, 2);
titleResult = commands.undo(2);
assert.equal(titleResult.document.title, 'S1 editor-core self-check');
titleResult = commands.redo(3);
assert.equal(titleResult.document.title, 'Miaoma Studio');

// One multi-command batch is published as one undoable revision.
let result = commands.execute({ baseRevision: 4, commandId: 'batch-1', commands: [
  { type: 'create', parentId: 'frame_root', node: frame('frame_nested') },
  { type: 'create', parentId: 'frame_nested', node: frame('frame_inner') },
  { type: 'create', parentId: 'frame_root', node: rectangle('rect_a'), index: 1 },
  { type: 'create', parentId: 'frame_root', node: rectangle('rect_b'), index: 2 }
] });
assert.equal(result.revision, 5);
assert.equal(result.transactionId, 'batch-1');
assert.equal(result.history.undoDepth, 2);
assert.deepEqual(rootChildren(commands).map((node) => node.id), ['text_title', 'rect_a', 'rect_b', 'frame_nested']);

// Update, reorder, reparent and delete all use the validated command path.
result = commands.execute({ baseRevision: 5, commands: [{ type: 'update', nodeId: 'rect_a', patch: { name: 'Hero card' } }] });
assert.equal(result.document.pages[0].root.children.find((node) => node.id === 'rect_a').name, 'Hero card');
result = commands.execute({ baseRevision: 6, commands: [{ type: 'reorder', nodeId: 'rect_b', index: 1 }] });
assert.deepEqual(rootChildren(commands).map((node) => node.id), ['text_title', 'rect_b', 'rect_a', 'frame_nested']);
result = commands.execute({ baseRevision: 7, commands: [{ type: 'reparent', nodeId: 'rect_b', parentId: 'frame_nested', index: 0 }] });
assert.deepEqual(rootChildren(commands).map((node) => node.id), ['text_title', 'rect_a', 'frame_nested']);
assert.deepEqual(rootChildren(commands).find((node) => node.id === 'frame_nested').children.map((node) => node.id), ['rect_b', 'frame_inner']);
result = commands.execute({ baseRevision: 8, commands: [{ type: 'delete', nodeId: 'rect_a' }] });
assert.equal(rootChildren(commands).some((node) => node.id === 'rect_a'), false);

// Prepare is detached and one-use: persistence can inspect the candidate before publication.
const prepared = commands.prepare({ baseRevision: 9, commands: [{ type: 'create', parentId: 'frame_root', node: rectangle('rect_c') }] });
assert.equal(store.getSnapshot().pages[0].root.children.some((node) => node.id === 'rect_c'), false);
assert.equal(prepared.document.revision, 10);
assert.equal(Object.isFrozen(prepared.document), true);
assert.equal(Object.isFrozen(prepared.document.pages[0].root.children), true);
assert.throws(() => { prepared.document.title = 'tampered'; }, TypeError);
assert.equal(commands.commitPrepared(prepared).revision, 10);
expectCode('INVALID_COMMAND', () => commands.commitPrepared(prepared));

// Undo/redo each restore one whole transaction while revisions always increase.
const preparedUndo = commands.prepareUndo(10);
assert.equal(preparedUndo.document.revision, 11);
assert.equal(store.getSnapshot().pages[0].root.children.some((node) => node.id === 'rect_c'), true);
result = commands.commitPrepared(preparedUndo);
assert.equal(result.revision, 11);
assert.equal(result.document.pages[0].root.children.some((node) => node.id === 'rect_c'), false);
const preparedRedo = commands.prepareRedo(11);
assert.equal(preparedRedo.document.revision, 12);
assert.equal(store.getSnapshot().pages[0].root.children.some((node) => node.id === 'rect_c'), false);
result = commands.commitPrepared(preparedRedo);
assert.equal(result.revision, 12);
assert.equal(result.document.pages[0].root.children.some((node) => node.id === 'rect_c'), true);

// Failed batches are atomic; stale callers cannot mutate the current snapshot.
const beforeFailure = store.getSnapshot();
const historyBeforeFailure = store.getHistoryState();
expectCode('INVALID_DOCUMENT', () => commands.execute({ baseRevision: 12, commands: [
  { type: 'create', parentId: 'frame_root', node: rectangle('rect_temporary') },
  { type: 'update', nodeId: 'rect_c', patch: { style: { fills: [], strokes: [], effects: [], opacity: 2 } } }
] }));
assert.deepEqual(store.getSnapshot(), beforeFailure);
assert.deepEqual(store.getHistoryState(), historyBeforeFailure);
expectCode('REVISION_CONFLICT', () => commands.execute({ baseRevision: 11, commands: [{ type: 'delete', nodeId: 'rect_c' }] }));
assert.deepEqual(store.getSnapshot(), beforeFailure);

// Parent locks protect descendants; unlocking the locked node itself remains possible.
result = commands.execute({ baseRevision: 12, commands: [{ type: 'update', nodeId: 'frame_root', patch: { locked: true } }] });
expectCode('NODE_LOCKED', () => commands.execute({ baseRevision: 13, commands: [{ type: 'update', nodeId: 'rect_c', patch: { name: 'Blocked' } }] }));
expectCode('NODE_LOCKED', () => commands.execute({ baseRevision: 13, commands: [{ type: 'create', parentId: 'frame_root', node: rectangle('rect_denied') }] }));
result = commands.execute({ baseRevision: 13, commands: [{ type: 'update', nodeId: 'frame_root', patch: { locked: false } }] });
assert.equal(result.revision, 14);

// A new committed edit after undo discards the redo branch.
commands.undo(14);
assert.equal(store.getHistoryState().canRedo, true);
commands.execute({ baseRevision: 15, commands: [{ type: 'update', nodeId: 'frame_root', patch: { locked: false } }] });
assert.equal(store.getHistoryState().canRedo, false);
commands.execute({ baseRevision: 16, commands: [{ type: 'update', nodeId: 'rect_c', patch: { visible: false } }] });
expectCode('NOTHING_TO_REDO', () => commands.redo(17));

// Root and cycle mutations are rejected before publication.
expectCode('ROOT_NODE_IMMUTABLE', () => commands.execute({ baseRevision: 17, commands: [{ type: 'delete', nodeId: 'frame_root' }] }));
expectCode('CYCLE_DETECTED', () => commands.execute({ baseRevision: 17, commands: [{ type: 'reparent', nodeId: 'frame_nested', parentId: 'frame_inner' }] }));
const cyclicFrame = frame('frame_cyclic');
cyclicFrame.children.push(cyclicFrame);
expectCode('INVALID_COMMAND', () => commands.execute({ baseRevision: 17, commands: [{ type: 'create', parentId: 'frame_root', node: cyclicFrame }] }));
assert.equal(store.getSnapshot().revision, 17);

// Applying a generated page is one undoable, validated replacement transaction.
const generationStore = new DocumentStore(createStarterDocument('Before AI'));
const generationCommands = new CommandService(generationStore);
const base = generationStore.getSnapshot();
const replacement = structuredClone(base);
replacement.title = 'After AI';
replacement.pages[0].root.children = [rectangle('generated_hero')];
const applied = generationCommands.execute({ baseRevision: base.revision, commandId: 'apply-ai-candidate', commands: [{
  type: 'replace-content', title: replacement.title, pages: replacement.pages, variables: replacement.variables, assets: replacement.assets
}] });
assert.equal(applied.document.title, 'After AI');
assert.deepEqual(applied.document.pages[0].root.children.map((node) => node.id), ['generated_hero']);
const restored = generationCommands.undo(applied.revision);
assert.equal(restored.document.title, 'Before AI');
assert.deepEqual(restored.document.pages[0].root.children.map((node) => node.id), base.pages[0].root.children.map((node) => node.id));
expectCode('INVALID_DOCUMENT', () => generationCommands.execute({ baseRevision: restored.revision, commands: [{
  type: 'replace-content', title: 'Invalid candidate', pages: [{ id: 'page_1', name: 'Page 1', root: { ...base.pages[0].root, name: '', children: [] } }], variables: {}, assets: {}
}] }));

const lockedGenerationStore = new DocumentStore(createStarterDocument('Locked candidate protection'));
const lockedGenerationCommands = new CommandService(lockedGenerationStore);
const lockedRevision = lockedGenerationStore.getSnapshot().revision;
lockedGenerationCommands.execute({ baseRevision: lockedRevision, commands: [{ type: 'update', nodeId: 'text_title', patch: { locked: true } }] });
const lockedCandidate = structuredClone(lockedGenerationStore.getSnapshot());
lockedCandidate.pages[0].root.children = lockedCandidate.pages[0].root.children.filter((node) => node.id !== 'text_title');
expectCode('NODE_LOCKED', () => lockedGenerationCommands.execute({ baseRevision: lockedCandidate.revision, commands: [{
  type: 'replace-content', title: 'Generated page', pages: lockedCandidate.pages, variables: lockedCandidate.variables, assets: lockedCandidate.assets
}] }));
assert.equal(lockedGenerationStore.getSnapshot().pages[0].root.children.some((node) => node.id === 'text_title'), true, 'Full-content replacement must preserve locked nodes');

console.log('editor-core S1 self-check passed');
