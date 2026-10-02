import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateDesignDocument, type DesignDocument } from '@miaoma/design-schema';
import type { ScreenshotMetadata } from '@miaoma/shared-protocol';

export * from './persistence';
export * from './generation-run-store';

export type SavedProject = { projectPath: string; documentPath: string; screenshotPath: string; screenshotMetadataPath: string };

export async function saveDesignProject(rootDirectory: string, projectId: string, document: DesignDocument, svg: string, screenshot: ScreenshotMetadata): Promise<SavedProject> {
  const checked = validateDesignDocument(document);
  if (!checked.success) throw new Error(`Refusing to save invalid document: ${checked.diagnostics.map((item) => item.message).join('; ')}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId)) throw new Error('Invalid project ID');
  if (!svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || svg.length > 2_000_000 || /<script\b|<foreignObject\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(/i.test(svg)) throw new Error('Invalid or unsafe SVG preview');
  if (screenshot.documentId !== document.documentId || screenshot.documentRevision !== document.revision || screenshot.mimeType !== 'image/svg+xml' || screenshot.width > 4096 || screenshot.height > 4096) throw new Error('Screenshot metadata must match the document revision and size limits');
  const root = path.resolve(rootDirectory);
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  const projectPath = path.join(actualRoot, projectId);
  await mkdir(projectPath, { recursive: true });
  const actualProject = await realpath(projectPath);
  if (path.dirname(actualProject) !== actualRoot) throw new Error('Project path escaped the selected workspace');
  const finalPath = path.join(actualProject, document.documentId);
  const stagingPath = path.join(actualProject, `.staging-${randomUUID()}`);
  await mkdir(stagingPath);
  try {
    const documentPath = path.join(stagingPath, 'design.json');
    const screenshotPath = path.join(stagingPath, 'screenshot.svg');
    const screenshotMetadataPath = path.join(stagingPath, 'screenshot.json');
    for (const [filePath, content] of [[documentPath, `${JSON.stringify(document, null, 2)}\n`], [screenshotPath, svg], [screenshotMetadataPath, `${JSON.stringify(screenshot, null, 2)}\n`]] as const) {
      const handle = await open(filePath, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    await rename(stagingPath, finalPath);
    return { projectPath: finalPath, documentPath: path.join(finalPath, 'design.json'), screenshotPath: path.join(finalPath, 'screenshot.svg'), screenshotMetadataPath: path.join(finalPath, 'screenshot.json') };
  } catch (error) {
    const resolvedStaging = path.resolve(stagingPath);
    if (path.dirname(resolvedStaging) === actualProject && path.basename(resolvedStaging).startsWith('.staging-')) await rm(resolvedStaging, { recursive: true, force: true });
    throw error;
  }
}

export async function loadDesignDocument(filePath: string): Promise<DesignDocument> {
  const input: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  const parsed = validateDesignDocument(input);
  if (!parsed.success) throw new Error(`Stored document is invalid: ${parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
  return parsed.data;
}
