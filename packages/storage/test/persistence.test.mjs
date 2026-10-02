import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  accumulateProjectAssetPixels,
  accumulateProjectAssetBytes,
  getPngDimensions,
  appendDesignJournalCommit,
  loadRecoverableDesignDocument,
  readLocalDesignPackage,
  readPortableProjectExport,
  readDesignAsset,
  readDesignAssetMetadata,
  saveDesignAsset,
  saveDesignSnapshot,
  writeProjectExport,
  MAX_PROJECT_ASSET_PIXELS,
  MAX_PROJECT_ASSET_BYTES,
  StoragePersistenceError
} = require('../dist/index.js');

function starterDocument(revision = 0) {
  return {
    documentVersion: '1.0', documentId: 'doc_persistence_test', fileToken: 'file-token-1234567890', revision, title: `Revision ${revision}`,
    pages: [{ id: 'page_main', name: 'Main', root: {
      id: 'frame_root', type: 'frame', name: 'Root', visible: true, locked: false,
      bounds: { x: 0, y: 0, width: 100, height: 100 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [], strokes: [], effects: [], opacity: 1 }, children: [], layout: { mode: 'absolute' }, clipContent: true
    } }], variables: {}, assets: {}
  };
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, crcInput, checksum]);
}

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 20, 30, 40, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function solidOneBitPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 1; header[9] = 0;
  const row = Buffer.alloc(1 + Math.ceil(width / 8));
  const pixels = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(pixels, y * row.length);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

test('PNG assets enforce an aggregate decoded-pixel budget', () => {
  assert.deepEqual(getPngDimensions(onePixelPng()), { width: 1, height: 1 });
  const maxed = accumulateProjectAssetPixels(0, { width: 4096, height: 4096 });
  assert.equal(maxed, MAX_PROJECT_ASSET_PIXELS / 2);
  const atLimit = accumulateProjectAssetPixels(maxed, { width: 4096, height: 4096 });
  assert.equal(atLimit, MAX_PROJECT_ASSET_PIXELS);
  assert.throws(
    () => accumulateProjectAssetPixels(atLimit, { width: 1, height: 1 }),
    (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_PIXEL_BUDGET_EXCEEDED'
  );
});

test('project PNG assets enforce an aggregate compressed-byte budget', () => {
  assert.equal(accumulateProjectAssetBytes(0, MAX_PROJECT_ASSET_BYTES / 2), MAX_PROJECT_ASSET_BYTES / 2);
  assert.equal(accumulateProjectAssetBytes(MAX_PROJECT_ASSET_BYTES / 2, MAX_PROJECT_ASSET_BYTES / 2), MAX_PROJECT_ASSET_BYTES);
  assert.throws(
    () => accumulateProjectAssetBytes(MAX_PROJECT_ASSET_BYTES, 1),
    (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_BYTES_BUDGET_EXCEEDED'
  );
});

test('local JSON and portable package imports reject decompression-bomb pixel totals', async () => {
  await withWorkspace(async (root) => {
    const largePng = solidOneBitPng(4096, 4096);
    const assetHash = createHash('sha256').update(largePng).digest('hex');
    const document = starterDocument(0);
    const ids = ['asset_a', 'asset_b', 'asset_c'];
    document.assets = Object.fromEntries(ids.map((id) => [id, {
      id, mimeType: 'image/png', relativePath: 'assets/large.png', sha256: assetHash, byteSize: largePng.byteLength
    }]));

    const localDirectory = path.join(root, 'local-pixel-bomb');
    await mkdir(path.join(localDirectory, 'assets'), { recursive: true });
    await writeFile(path.join(localDirectory, 'design.json'), JSON.stringify(document));
    await writeFile(path.join(localDirectory, 'assets', 'large.png'), largePng);
    await assert.rejects(
      readLocalDesignPackage(path.join(localDirectory, 'design.json')),
      (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_PIXEL_BUDGET_EXCEEDED'
    );

    const exportDirectory = path.join(root, 'portable-pixel-bomb');
    await mkdir(path.join(exportDirectory, 'assets'), { recursive: true });
    await writeFile(path.join(exportDirectory, 'design.json'), JSON.stringify(document));
    await writeFile(path.join(exportDirectory, 'assets', 'large.png'), largePng);
    const preview = solidOneBitPng(100, 100);
    await writeFile(path.join(exportDirectory, 'preview.png'), preview);
    await writeFile(path.join(exportDirectory, 'manifest.json'), JSON.stringify({
      formatVersion: 1, exportId: 'export_pixel_bomb', documentId: document.documentId, documentRevision: document.revision,
      pageId: 'page_main', nodeIds: ['frame_root'], mimeType: 'image/png', width: 100, height: 100, scale: 1,
      sha256: createHash('sha256').update(preview).digest('hex'),
      assets: ids.map((id) => ({ id, mimeType: 'image/png', relativePath: 'assets/large.png', sha256: assetHash, byteSize: largePng.byteLength, width: 4096, height: 4096 }))
    }));
    await assert.rejects(
      readPortableProjectExport(exportDirectory),
      (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_PIXEL_BUDGET_EXCEEDED'
    );
  });
});

async function withWorkspace(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'miaoma-storage-'));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('recovery replays committed records and ignores then truncates only an incomplete tail on append', async () => {
  await withWorkspace(async (root) => {
    const initial = starterDocument(0);
    await saveDesignSnapshot(root, 'project_test', initial);
    const first = starterDocument(1);
    first.title = 'Committed one';
    await appendDesignJournalCommit(root, 'project_test', {
      commandId: 'cmd_one', baseRevision: 0, nextRevision: 1, commands: [{ type: 'SetTitle', title: first.title }], origin: 'human', document: first
    });
    const journalPath = path.join(root, 'project_test', 'journal', `${initial.documentId}.jsonl`);
    const beforeRecovery = await readFile(journalPath);
    await writeFile(journalPath, Buffer.concat([beforeRecovery, Buffer.from('{"kind":"design-command-commit"') ]));
    const damagedBytes = await readFile(journalPath);

    const recovered = await loadRecoverableDesignDocument(root, 'project_test', initial.documentId);
    assert.equal(recovered.document.revision, 1);
    assert.equal(recovered.replayedCommits, 1);
    assert.ok(recovered.ignoredTailBytes > 0);
    assert.ok(recovered.diagnostics.some((item) => item.code === 'JOURNAL_INCOMPLETE_TAIL'));
    assert.deepEqual(await readFile(journalPath), damagedBytes, 'recovery preview leaves the source journal byte-for-byte intact');

    const second = starterDocument(2);
    second.title = 'Committed two';
    await appendDesignJournalCommit(root, 'project_test', {
      commandId: 'cmd_two', baseRevision: 1, nextRevision: 2, commands: [{ type: 'SetTitle', title: second.title }], origin: 'agent', document: second
    });
    const recoveredAgain = await loadRecoverableDesignDocument(root, 'project_test', initial.documentId);
    assert.equal(recoveredAgain.document.revision, 2);
    assert.equal(recoveredAgain.replayedCommits, 2);
    assert.equal(recoveredAgain.ignoredTailBytes, 0);

    const saved = await saveDesignSnapshot(root, 'project_test', second);
    assert.match(saved.snapshotPath, /snapshots[\\/]doc_persistence_test\.json$/);
    assert.equal(saved.revision, 2);
    assert.equal((await loadRecoverableDesignDocument(root, 'project_test', initial.documentId)).replayedCommits, 0);
  });
});

test('checksum failure returns the last safe snapshot and blocks future append', async () => {
  await withWorkspace(async (root) => {
    const initial = starterDocument(0);
    await saveDesignSnapshot(root, 'project_test', initial);
    const next = starterDocument(1);
    await appendDesignJournalCommit(root, 'project_test', {
      commandId: 'cmd_bad_hash', baseRevision: 0, nextRevision: 1, commands: [{ type: 'SetTitle', title: next.title }], origin: 'human', document: next
    });
    const journalPath = path.join(root, 'project_test', 'journal', `${initial.documentId}.jsonl`);
    const lines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
    const record = JSON.parse(lines[0]);
    record.document.title = 'Tampered';
    await writeFile(journalPath, `${JSON.stringify(record)}\n`);

    const recovered = await loadRecoverableDesignDocument(root, 'project_test', initial.documentId);
    assert.equal(recovered.document.revision, 0);
    assert.ok(recovered.diagnostics.some((item) => item.code === 'JOURNAL_CHECKSUM_MISMATCH'));
    await assert.rejects(
      appendDesignJournalCommit(root, 'project_test', { commandId: 'cmd_two', baseRevision: 0, nextRevision: 1, commands: [{ type: 'SetTitle' }], origin: 'human', document: next }),
      (error) => error instanceof StoragePersistenceError && error.code === 'JOURNAL_CHECKSUM_MISMATCH'
    );
  });
});

test('PNG export checks bytes and revision metadata and atomically writes a manifest', async () => {
  await withWorkspace(async (root) => {
    const document = starterDocument(4);
    document.pages[0].root.bounds.width = 1;
    document.pages[0].root.bounds.height = 1;
    const png = onePixelPng();
    const saved = await writeProjectExport(root, 'project_test', 'export_001', document, png, {
      documentId: document.documentId, documentRevision: document.revision, pageId: 'page_main', nodeIds: ['frame_root'],
      width: 1, height: 1, scale: 1, mimeType: 'image/png'
    });
    assert.equal((await readFile(saved.imagePath)).compare(png), 0);
    const manifest = JSON.parse(await readFile(saved.manifestPath, 'utf8'));
    assert.equal(manifest.documentRevision, 4);
    assert.equal(manifest.sha256, saved.sha256);

    const wrongSizeDocument = starterDocument(4);
    await assert.rejects(
      writeProjectExport(root, 'project_test', 'export_wrong_scale', wrongSizeDocument, png, {
        documentId: wrongSizeDocument.documentId, documentRevision: wrongSizeDocument.revision, pageId: 'page_main', nodeIds: ['frame_root'],
        width: 1, height: 1, scale: 1, mimeType: 'image/png'
      }),
      (error) => error instanceof StoragePersistenceError && error.code === 'EXPORT_DIMENSIONS_MISMATCH'
    );

    const brokenPng = Buffer.from(png); brokenPng[29] ^= 0xff;
    await assert.rejects(
      writeProjectExport(root, 'project_test', 'export_002', document, brokenPng, {
        documentId: document.documentId, documentRevision: document.revision, pageId: 'page_main', nodeIds: ['frame_root'],
        width: 1, height: 1, scale: 1, mimeType: 'image/png'
      }),
      (error) => error instanceof StoragePersistenceError && error.code === 'INVALID_PNG'
    );
  });
});

test('PNG asset round-trips by content hash and exports with its verified manifest entry', async () => {
  await withWorkspace(async (root) => {
    const initial = starterDocument(0);
    await saveDesignSnapshot(root, 'project_assets', initial);
    const png = onePixelPng();
    const asset = await saveDesignAsset(root, 'project_assets', initial.documentId, 'asset_logo', 'image/png', png);
    assert.equal(asset.relativePath, `assets/${asset.sha256}.png`);
    assert.equal(asset.byteSize, png.byteLength);
    const pendingAsset = await readDesignAssetMetadata(root, 'project_assets', initial.documentId, asset);
    assert.deepEqual(Buffer.from(pendingAsset.bytes), png);
    await assert.rejects(
      readDesignAsset(root, 'project_assets', initial.documentId, asset.id),
      (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_NOT_FOUND'
    );

    const committed = starterDocument(1);
    committed.pages[0].root.bounds.width = 1;
    committed.pages[0].root.bounds.height = 1;
    committed.assets[asset.id] = asset;
    await appendDesignJournalCommit(root, 'project_assets', {
      commandId: 'cmd_attach_asset', baseRevision: 0, nextRevision: 1,
      commands: [{ type: 'AddAsset', assetId: asset.id }], origin: 'human', document: committed
    });
    const roundTrip = await readDesignAsset(root, 'project_assets', initial.documentId, asset.id);
    assert.deepEqual(roundTrip.asset, asset);
    assert.deepEqual(Buffer.from(roundTrip.bytes), png);

    const exported = await writeProjectExport(root, 'project_assets', 'export_with_asset', committed, png, {
      documentId: committed.documentId, documentRevision: committed.revision, pageId: 'page_main', nodeIds: ['frame_root'],
      width: 1, height: 1, scale: 1, mimeType: 'image/png'
    });
    const manifest = JSON.parse(await readFile(exported.manifestPath, 'utf8'));
    assert.deepEqual(manifest.assets, [{
      id: asset.id, mimeType: 'image/png', relativePath: asset.relativePath, sha256: asset.sha256,
      byteSize: png.byteLength, width: 1, height: 1
    }]);
    const copied = await readFile(path.join(exported.exportPath, ...asset.relativePath.split('/')));
    assert.deepEqual(copied, png);

    const portable = await readPortableProjectExport(exported.exportPath);
    assert.equal(portable.document.documentId, committed.documentId);
    assert.equal(portable.document.revision, committed.revision);
    assert.equal(portable.assets.length, 1);
    assert.deepEqual(Buffer.from(portable.assets[0].bytes), png);

    const rawPackage = path.join(root, 'raw-import');
    await mkdir(rawPackage);
    await copyFile(exported.documentPath, path.join(rawPackage, 'design.json'));
    await mkdir(path.dirname(path.join(rawPackage, ...asset.relativePath.split('/'))), { recursive: true });
    await copyFile(path.join(exported.exportPath, ...asset.relativePath.split('/')), path.join(rawPackage, ...asset.relativePath.split('/')));
    const localPackage = await readLocalDesignPackage(path.join(rawPackage, 'design.json'));
    assert.equal(localPackage.assets.length, 1);
    assert.deepEqual(Buffer.from(localPackage.assets[0].bytes), png);

    const documentDirectory = path.join(root, 'project_assets', initial.documentId);
    const sourceAsset = path.join(documentDirectory, ...asset.relativePath.split('/'));
    const tampered = Buffer.from(png); tampered[tampered.length - 5] ^= 0xff;
    await writeFile(sourceAsset, tampered);
    await assert.rejects(
      readDesignAsset(root, 'project_assets', initial.documentId, asset.id),
      (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_HASH_MISMATCH'
    );
    await assert.rejects(
      writeProjectExport(root, 'project_assets', 'export_tampered_asset', committed, png, {
        documentId: committed.documentId, documentRevision: committed.revision, pageId: 'page_main', nodeIds: ['frame_root'],
        width: 1, height: 1, scale: 1, mimeType: 'image/png'
      }),
      (error) => error instanceof StoragePersistenceError && error.code === 'ASSET_HASH_MISMATCH'
    );
    await assert.rejects(lstat(path.join(root, 'project_assets', 'exports', 'export_tampered_asset')));
  });
});

test('asset operations reject traversal and symbolic-link escapes', async (t) => {
  await withWorkspace(async (root) => {
    const document = starterDocument(0);
    await saveDesignSnapshot(root, 'project_safe', document);
    const invalid = starterDocument(0);
    invalid.assets.asset_bad = {
      id: 'asset_bad', mimeType: 'image/png', relativePath: '../../outside.png', sha256: 'a'.repeat(64), byteSize: 1
    };
    await assert.rejects(
      saveDesignSnapshot(root, 'project_safe', invalid),
      (error) => error instanceof StoragePersistenceError && error.code === 'INVALID_DOCUMENT'
    );

    const documentDirectory = path.join(root, 'project_safe', document.documentId);
    const sameParentTarget = path.join(documentDirectory, 'alternate-assets');
    const assetsDirectory = path.join(documentDirectory, 'assets');
    await mkdir(sameParentTarget);
    try {
      await symlink(sameParentTarget, assetsDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      throw error;
    }
    await assert.rejects(
      saveDesignAsset(root, 'project_safe', document.documentId, 'asset_logo', 'image/png', onePixelPng()),
      (error) => error instanceof StoragePersistenceError && error.code === 'UNSAFE_PATH'
    );
  });
});

test('fresh or incomplete workspaces report SNAPSHOT_NOT_FOUND while unsafe snapshot paths retain diagnostics', async (t) => {
  await withWorkspace(async (root) => {
    const documentId = 'doc_missing_test';
    await assert.rejects(
      loadRecoverableDesignDocument(root, 'project_missing', documentId),
      (error) => error instanceof StoragePersistenceError && error.code === 'SNAPSHOT_NOT_FOUND'
    );

    const projectDirectory = path.join(root, 'project_missing');
    await mkdir(projectDirectory);
    const documentDirectory = path.join(projectDirectory, documentId);
    await mkdir(documentDirectory);
    await assert.rejects(
      loadRecoverableDesignDocument(root, 'project_missing', documentId),
      (error) => error instanceof StoragePersistenceError && error.code === 'SNAPSHOT_NOT_FOUND'
    );

    const snapshotsTarget = path.join(projectDirectory, 'snapshot-target');
    await mkdir(snapshotsTarget);
    try {
      await symlink(snapshotsTarget, path.join(projectDirectory, 'snapshots'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      throw error;
    }
    await assert.rejects(
      loadRecoverableDesignDocument(root, 'project_missing', documentId),
      (error) => error instanceof StoragePersistenceError && error.code === 'UNSAFE_PATH' && error.diagnostics?.some((item) => item.code === 'UNSAFE_PATH')
    );
  });
});
