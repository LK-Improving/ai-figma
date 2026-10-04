import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadRecoverableDesignDocument } from '@miaoma/storage';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';

export type ProjectSummary = { projectId: string; documentId: string; title: string; revision: number; pageCount: number; updatedAt: string; previewSvg: string };
export type ProjectPreviewAssetLoader = (projectId: string, document: Awaited<ReturnType<typeof loadRecoverableDesignDocument>>['document']) => Promise<Record<string, string>>;

export async function listLocalProjects(root: string, loadPreviewAssets?: ProjectPreviewAssetLoader): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)) continue;
    const snapshots = path.join(root, entry.name, 'snapshots');
    try {
      const directory = await lstat(snapshots);
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      for (const file of await readdir(snapshots, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}\.json$/.test(file.name)) continue;
        const documentId = file.name.slice(0, -5);
        try {
          const { document } = await loadRecoverableDesignDocument(root, entry.name, documentId);
          const snapshot = await lstat(path.join(snapshots, file.name));
          const journal = await lstat(path.join(root, entry.name, 'journal', `${documentId}.jsonl`)).catch(() => null);
          let previewAssets: Record<string, string> = {};
          try { previewAssets = await loadPreviewAssets?.(entry.name, document) ?? {}; }
          catch { /* A missing preview asset must not hide an otherwise recoverable project. */ }
          const previewSvg = renderDocumentScreenshot(document, document.pages[0]!.id, 0.2, 640, undefined, previewAssets).svg;
          projects.push({ projectId: entry.name, documentId, title: document.title, revision: document.revision,
            pageCount: document.pages.length, updatedAt: new Date(Math.max(snapshot.mtimeMs, journal?.mtimeMs ?? 0)).toISOString(), previewSvg });
        } catch { /* One damaged design must not hide the remaining saved projects. */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
