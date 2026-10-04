import type { DesignDocument } from '@miaoma/design-schema';
import type { CodegenDiagnostic, CodegenFile, CodegenInput, CodegenResult } from './types';
import { createInteractionReport, createManifest, createValidationReport, createViewportReport } from './reports';
import { createProjectFiles } from './templates';
import { validateCodegenInput } from './validation';

export type {
  CodegenDiagnostic, CodegenFile, CodegenInput, CodegenInteractionBinding, CodegenInteractionReport,
  CodegenManifest, CodegenMissingInteraction, CodegenProject, CodegenResult, CodegenValidationReport,
  CodegenViewport, CodegenViewportCheck, CodegenViewportIssue, CodegenViewportReport
} from './types';
export { sanitizeSvg, validateCodegenInput } from './validation';

const JSON_MIME = 'application/json';

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment));
}

function fileUtf8(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * Convert a DesignDocument snapshot into a deterministic React + TypeScript project.
 * It performs a fresh schema/reference check and verifies every supplied asset before
 * returning any generated files. No file-system writes or code execution occur here.
 */
export function generateReactProject(input: CodegenInput): CodegenResult {
  let checked;
  try { checked = validateCodegenInput(input); }
  catch (error) {
    return { success: false, diagnostics: [{ code: 'CODEGEN_VALIDATION_ERROR', path: [], message: error instanceof Error ? error.message : 'Input validation failed' }] };
  }
  if (!checked.success) return { success: false, diagnostics: checked.diagnostics };
  const { document, assets, nodeCount, assetByteSize } = checked.value;
  const initialPageId = input.initialPageId === undefined ? document.pages[0]?.id : input.initialPageId;
  if (typeof initialPageId !== 'string' || !document.pages.some((page) => page.id === initialPageId)) {
    return { success: false, diagnostics: [{ code: 'INITIAL_PAGE_NOT_FOUND', path: ['initialPageId'], message: `Initial page does not exist: ${String(initialPageId)}` }] };
  }
  const interactionReport = createInteractionReport(document);
  const viewportReport = createViewportReport(document);
  const validation = createValidationReport(document, assets, nodeCount, assetByteSize);
  const manifest = createManifest(document, initialPageId, assets, interactionReport, viewportReport, validation);
  const candidates = [
    ...createProjectFiles(document, assets, initialPageId),
    { path: 'public/design-manifest.json', content: `${canonicalJson(manifest)}\n`, mimeType: JSON_MIME },
    { path: 'reports/viewport-report.json', content: `${canonicalJson(viewportReport)}\n`, mimeType: JSON_MIME },
    { path: 'reports/interaction-report.json', content: `${canonicalJson(interactionReport)}\n`, mimeType: JSON_MIME },
    { path: 'reports/validation-report.json', content: `${canonicalJson(validation)}\n`, mimeType: JSON_MIME },
    ...[...assets.values()].map((asset) => ({ path: asset.relativePath, content: asset.outputBytes, mimeType: asset.mimeType }))
  ] satisfies CodegenFile[];

  const byPath = new Map<string, CodegenFile>();
  for (const file of candidates) {
    if (!isSafeRelativePath(file.path)) return { success: false, diagnostics: [{ code: 'UNSAFE_OUTPUT_PATH', path: ['files', file.path], message: `Generator attempted an unsafe output path: ${file.path}` }] };
    const previous = byPath.get(file.path);
    if (!previous) byPath.set(file.path, file);
    else {
      const previousBytes = typeof previous.content === 'string' ? fileUtf8(previous.content) : previous.content;
      const nextBytes = typeof file.content === 'string' ? fileUtf8(file.content) : file.content;
      if (previous.mimeType !== file.mimeType || previousBytes.byteLength !== nextBytes.byteLength || previousBytes.some((byte, index) => byte !== nextBytes[index])) {
        return { success: false, diagnostics: [{ code: 'OUTPUT_PATH_COLLISION', path: ['files', file.path], message: `Different generated files resolve to ${file.path}` }] };
      }
    }
  }
  const files = [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { success: true, files, manifest, viewportReport, interactionReport, validation };
}

export function isCodegenSuccess(result: CodegenResult): result is Extract<CodegenResult, { success: true }> {
  return result.success;
}
