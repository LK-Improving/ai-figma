import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStarterDocument } from '@miaoma/editor-core';
import { saveDesignSnapshot, loadRecoverableDesignDocument } from '@miaoma/storage';
import { listLocalProjects } from '../dist/project-catalog.js';

test('catalog lists persisted projects across restarts and isolates a corrupt snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'myfigma-catalog-'));
  try {
    const first = createStarterDocument('First project');
    const second = createStarterDocument('Second project');
    await saveDesignSnapshot(root, 'project_first', first);
    await saveDesignSnapshot(root, 'project_second', second);
    await mkdir(path.join(root, 'broken', 'snapshots'), { recursive: true });
    await writeFile(path.join(root, 'broken', 'snapshots', 'broken.json'), '{bad');
    const catalog = await listLocalProjects(root);
    assert.equal(catalog.length, 2);
    assert.deepEqual(catalog.map(item => item.title).sort(), ['First project', 'Second project']);
    for (const item of catalog) {
      const recovered = await loadRecoverableDesignDocument(root, item.projectId, item.documentId);
      assert.equal(recovered.document.title, item.title);
      assert.equal(item.pageCount, recovered.document.pages.length);
    }
    assert.deepEqual(await listLocalProjects(root), catalog);
  } finally { await rm(root, { recursive: true, force: true }); }
});
