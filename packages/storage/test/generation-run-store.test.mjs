import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  appendGenerationRunEvent,
  listGenerationRunIds,
  listGenerationRunCheckpoints,
  loadGenerationRunCheckpoint,
  readGenerationRunEvents,
  readScreenshotEvidence,
  saveGenerationRunCheckpoint,
  saveScreenshotEvidence,
  StoragePersistenceError
} = require('../dist/index.js');

const projectId = 'project_run_store';
const documentId = 'doc_run_store';
const runId = 'run_run_store';
const attemptId = 'attempt_run_store';
const hash = (input) => createHash('sha256').update(input).digest('hex');

async function withWorkspace(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miaoma-run-store-'));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function checkpoint(overrides = {}) {
  return {
    formatVersion: 1,
    projectId,
    documentId,
    runId,
    attemptId,
    request: {
      documentId, title: 'Storage recovery', prompt: 'Create a simple landing page', pageId: 'page_main',
      targetNodeIds: [], baseRevision: 4, viewport: { width: 1280, height: 900 }, referenceAssetIds: [],
      providerRef: 'local-fake', constraints: [], maxParallel: 3
    },
    baseRevision: 4,
    baseDocumentHash: 'a'.repeat(64),
    tokenVersion: 'b'.repeat(64),
    providerVersion: 'fake-v1',
    phase: 'reviewing',
    collaboration: {
      runId, attemptId, maxParallel: 3, activeCount: 0, queuedCount: 0,
      coordinator: { agentId: 'miaoma', displayName: 'Miaoma', state: 'reviewing' }, agents: [], tasks: []
    },
    loop: {
      stage: 'reviewing', quality: 'pending', reviewRound: 0, repairRound: 0, maxRepairRounds: 2,
      evidence: [], reports: [], proposals: [], diagnostics: []
    },
    completedRegions: {},
    eventSeq: 2,
    updatedAt: '2026-10-03T03:20:00.000Z',
    ...overrides
  };
}

function event(seq, payload = {}) {
  return {
    eventId: `event_${seq}`, runId, attemptId, seq,
    timestamp: `2026-10-03T03:20:${String(seq % 60).padStart(2, '0')}.000Z`,
    type: 'stateChanged', documentRevision: 4, payload
  };
}

function evidence(previewSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240" role="img" aria-label="Preview"><title>Preview</title><g data-node-id="frame_main" opacity="1"></g></svg>') {
  return {
    evidence: {
      evidenceId: 'shot_run_store_01', runId, attemptId, reviewRound: 0, documentId,
      revision: 4, candidateRevision: 0, pageId: 'page_main', imageHash: hash(previewSvg),
      width: 320, height: 240, scale: 1, mimeType: 'image/svg+xml',
      nodeIds: ['frame_main'], fontsReady: true, assetStatus: 'ready'
    },
    previewSvg
  };
}

function assertStorageCode(code) {
  return (error) => error instanceof StoragePersistenceError && error.code === code;
}

test('run checkpoints are validated, checksummed, listable and bounded to 50 IDs', async () => {
  await withWorkspace(async (root) => {
    const first = await saveGenerationRunCheckpoint(root, checkpoint(), 'checkpoint_first');
    assert.equal(first.checkpointId, 'checkpoint_first');
    assert.equal((await loadGenerationRunCheckpoint(root, projectId, runId, first.checkpointId)).eventSeq, 2);

    const secondCheckpoint = checkpoint({ eventSeq: 3, phase: 'repairing', updatedAt: '2026-10-03T03:21:00.000Z' });
    const second = await saveGenerationRunCheckpoint(root, secondCheckpoint, 'checkpoint_second');
    const listed = await listGenerationRunCheckpoints(root, projectId, runId);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].checkpointId, second.checkpointId);

    for (let index = 3; index <= 50; index++) {
      await saveGenerationRunCheckpoint(root, checkpoint({ eventSeq: index }), `checkpoint_${String(index).padStart(2, '0')}`);
    }
    await assert.rejects(
      saveGenerationRunCheckpoint(root, checkpoint({ eventSeq: 51 }), 'checkpoint_51'),
      assertStorageCode('CHECKPOINT_LIMIT')
    );
    assert.equal((await listGenerationRunCheckpoints(root, projectId, runId)).length, 50);
  });
});

test('checkpoint reads reject checksum corruption and identity/path mismatches', async () => {
  await withWorkspace(async (root) => {
    const saved = await saveGenerationRunCheckpoint(root, checkpoint(), 'checkpoint_safe');
    const bytes = await readFile(saved.checkpointPath, 'utf8');
    const altered = JSON.parse(bytes);
    altered.checkpoint.phase = 'completed';
    await writeFile(saved.checkpointPath, JSON.stringify(altered));
    await assert.rejects(
      loadGenerationRunCheckpoint(root, projectId, runId, saved.checkpointId),
      assertStorageCode('CHECKPOINT_HASH_MISMATCH')
    );

    await assert.rejects(
      saveGenerationRunCheckpoint(root, checkpoint({ projectId: '../escape' }), 'bad_project'),
      assertStorageCode('CHECKPOINT_INVALID')
    );
    await assert.rejects(
      loadGenerationRunCheckpoint(root, projectId, 'other_run', saved.checkpointId),
      assertStorageCode('RUN_NOT_FOUND')
    );
  });
});

test('checkpoints and run directories enforce record and aggregate size limits', async () => {
  await withWorkspace(async (root) => {
    const regions = Object.fromEntries(Array.from({ length: 2_500 }, (_, index) => [`region_${index}`, {
      frameName: 'Generated region', headline: 'A concise headline', description: 'x'.repeat(2_000)
    }]));
    await assert.rejects(
      saveGenerationRunCheckpoint(root, checkpoint({ completedRegions: regions }), 'checkpoint_too_large'),
      assertStorageCode('RUN_RECORD_TOO_LARGE')
    );

    const runDirectory = path.join(root, projectId, 'runs', runId);
    await mkdir(runDirectory, { recursive: true });
    const oversizedFile = path.join(runDirectory, 'orphan.bin');
    const handle = await open(oversizedFile, 'w');
    try { await handle.truncate(128 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(appendGenerationRunEvent(root, projectId, event(1)), assertStorageCode('RUN_TOO_LARGE'));
  });
});

test('event log appends durable contiguous records, ignores only a torn tail, then repairs it on append', async () => {
  await withWorkspace(async (root) => {
    const first = await appendGenerationRunEvent(root, projectId, event(1));
    await appendGenerationRunEvent(root, projectId, event(2, { state: 'reviewing' }));
    await assert.rejects(appendGenerationRunEvent(root, projectId, event(4)), assertStorageCode('EVENT_SEQUENCE_INVALID'));

    const original = await readFile(first.eventPath);
    await writeFile(first.eventPath, Buffer.concat([original, Buffer.from('{"torn":') ]));
    const preview = await readGenerationRunEvents(root, projectId, runId, 1);
    assert.deepEqual(preview.events.map((item) => item.seq), [2]);
    assert.ok(preview.ignoredTailBytes > 0);
    assert.ok(preview.validBytes < (await readFile(first.eventPath)).byteLength);

    await appendGenerationRunEvent(root, projectId, event(3, { state: 'interrupted' }));
    const recovered = await readGenerationRunEvents(root, projectId, runId);
    assert.deepEqual(recovered.events.map((item) => item.seq), [1, 2, 3]);
    assert.equal(recovered.ignoredTailBytes, 0);
  });
});

test('event recovery rejects a corrupt complete middle record and checksum-chain edits', async () => {
  await withWorkspace(async (root) => {
    const first = await appendGenerationRunEvent(root, projectId, event(1));
    await appendGenerationRunEvent(root, projectId, event(2));
    await appendGenerationRunEvent(root, projectId, event(3));
    const lines = (await readFile(first.eventPath, 'utf8')).trimEnd().split('\n');
    const middle = JSON.parse(lines[1]);
    middle.event.payload = { changed: true };
    lines[1] = JSON.stringify(middle);
    await writeFile(first.eventPath, `${lines.join('\n')}\n`);
    await assert.rejects(readGenerationRunEvents(root, projectId, runId), assertStorageCode('EVENT_CHECKSUM_MISMATCH'));
    await assert.rejects(appendGenerationRunEvent(root, projectId, event(4)), assertStorageCode('EVENT_CHECKSUM_MISMATCH'));
  });
});

test('event records and event log enforce individual and aggregate size caps', async () => {
  await withWorkspace(async (root) => {
    const oversized = 'x'.repeat(4 * 1024 * 1024);
    await assert.rejects(
      appendGenerationRunEvent(root, projectId, event(1, { detail: oversized })),
      assertStorageCode('RUN_RECORD_TOO_LARGE')
    );

    const eventPath = path.join(root, projectId, 'runs', runId, 'events.jsonl');
    await mkdir(path.dirname(eventPath), { recursive: true });
    await writeFile(eventPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await assert.rejects(readGenerationRunEvents(root, projectId, runId), assertStorageCode('EVENT_LOG_TOO_LARGE'));
  });
});

test('SVG evidence round-trips only when hash, IDs, dimensions and safe subset match', async () => {
  await withWorkspace(async (root) => {
    const input = evidence();
    const saved = await saveScreenshotEvidence(root, projectId, input);
    assert.equal(saved.imageHash, input.evidence.imageHash);
    const loaded = await readScreenshotEvidence(root, projectId, runId, input.evidence.evidenceId);
    assert.deepEqual(loaded, input);

    await assert.rejects(
      saveScreenshotEvidence(root, projectId, { ...input, evidence: { ...input.evidence, imageHash: '0'.repeat(64) } }),
      assertStorageCode('EVIDENCE_HASH_MISMATCH')
    );
    await assert.rejects(
      saveScreenshotEvidence(root, projectId, { ...input, evidence: { ...input.evidence, nodeIds: ['different_node'] } }),
      assertStorageCode('EVIDENCE_MISMATCH')
    );
  });
});

test('SVG evidence rejects active content, external links, mismatched dimensions and stored tampering', async () => {
  await withWorkspace(async (root) => {
    const malicious = evidence('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><script>alert(1)</script></svg>');
    await assert.rejects(saveScreenshotEvidence(root, projectId, malicious), assertStorageCode('UNSAFE_SVG'));

    const external = evidence('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><image href="https://evil.invalid/a.svg"/></svg>');
    await assert.rejects(saveScreenshotEvidence(root, projectId, external), assertStorageCode('UNSAFE_SVG'));

    const embedded = evidence('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><g data-node-id="frame_main" opacity="1"><image data-node-id="photo_main" x="0" y="0" width="320.5" height="240" href="data:image/jpeg;base64,ZmFrZQ==" preserveAspectRatio="none" opacity="1"/></g></svg>');
    const embeddedInput = { ...embedded, evidence: { ...embedded.evidence, evidenceId: 'shot_run_store_02', nodeIds: ['frame_main', 'photo_main'] } };
    await saveScreenshotEvidence(root, projectId, embeddedInput);
    assert.equal((await readScreenshotEvidence(root, projectId, runId, embeddedInput.evidence.evidenceId)).previewSvg, embedded.previewSvg);

    const badDimensions = evidence('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 320 240"><g data-node-id="frame_main" opacity="1"></g></svg>');
    await assert.rejects(saveScreenshotEvidence(root, projectId, badDimensions), assertStorageCode('EVIDENCE_MISMATCH'));

    const valid = evidence();
    const saved = await saveScreenshotEvidence(root, projectId, valid);
    await writeFile(saved.svgPath, `${valid.previewSvg} `);
    await assert.rejects(readScreenshotEvidence(root, projectId, runId, valid.evidence.evidenceId), assertStorageCode('EVIDENCE_HASH_MISMATCH'));
  });
});

test('evidence path IDs are bound to metadata; project and run symlinks are rejected', async (t) => {
  await withWorkspace(async (root) => {
    const input = evidence();
    const saved = await saveScreenshotEvidence(root, projectId, input);
    const evidenceDirectory = path.dirname(saved.svgPath);
    await rename(saved.svgPath, path.join(evidenceDirectory, 'shot_other.svg'));
    await rename(saved.metadataPath, path.join(evidenceDirectory, 'shot_other.json'));
    await assert.rejects(readScreenshotEvidence(root, projectId, runId, 'shot_other'), assertStorageCode('EVIDENCE_IDENTITY_MISMATCH'));

    const unsafeRoot = path.join(root, 'unsafe');
    const target = path.join(root, 'outside');
    await mkdir(unsafeRoot);
    await mkdir(target);
    try {
      await symlink(target, path.join(unsafeRoot, projectId), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symbolic links are unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(saveScreenshotEvidence(unsafeRoot, projectId, input), assertStorageCode('UNSAFE_PATH'));
  });
});

test('project run discovery returns only safe directories with checkpoint or event content', async () => {
  await withWorkspace(async (root) => {
    assert.deepEqual(await listGenerationRunIds(root, projectId), []);

    const runsDirectory = path.join(root, projectId, 'runs');
    await mkdir(path.join(runsDirectory, 'empty_run'), { recursive: true });
    await mkdir(path.join(runsDirectory, 'evidence_only', 'evidence'), { recursive: true });
    await writeFile(path.join(runsDirectory, 'evidence_only', 'evidence', 'orphan.svg'), '<svg/>');
    await mkdir(path.join(runsDirectory, 'invalid!id'), { recursive: true });

    await saveGenerationRunCheckpoint(root, checkpoint(), 'checkpoint_discovery');
    const secondRunId = 'run_event_discovery';
    await appendGenerationRunEvent(root, projectId, { ...event(1), runId: secondRunId, attemptId: 'attempt_event_discovery' });

    assert.deepEqual(await listGenerationRunIds(root, projectId), [runId, secondRunId].sort((a, b) => a.localeCompare(b)));
  });
});

test('project run discovery rejects symlink entries beneath the runs directory', async (t) => {
  await withWorkspace(async (root) => {
    const runsDirectory = path.join(root, projectId, 'runs');
    const externalDirectory = path.join(root, 'external-run');
    await mkdir(runsDirectory, { recursive: true });
    await mkdir(externalDirectory);
    try {
      await symlink(externalDirectory, path.join(runsDirectory, 'run_external'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symbolic links are unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(listGenerationRunIds(root, projectId), assertStorageCode('UNSAFE_PATH'));
  });
});
