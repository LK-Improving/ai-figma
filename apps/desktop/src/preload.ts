import { contextBridge, ipcRenderer } from 'electron';
import type { EditorCommand } from '@miaoma/editor-core';
import type { DesignPlan, GenerationEvent, GenerationRequest, GenerationRunSnapshot } from '@miaoma/shared-protocol';

type BridgeFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };
type BridgeResult<T> = { ok: true; data: T } | BridgeFailure;
type ProjectContext = { projectId: string; documentId: string };
type GenerateFrameResult = { ok: true; data: { document: { pages: Array<{ root: { children: unknown[] } }> }; documentPath: string; screenshotPath: string; screenshotMetadataPath: string; screenshot: { documentRevision: number; nodeIds: string[] }; previewSvg: string }; revision: number } | BridgeFailure;
type CandidateApplyResult = { kind: 'applied'; mutation: { document: unknown; history: unknown; durableRevision: number } } | { kind: 'conflict'; currentRevision: number };

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function isBytes(value: unknown, min: number, max: number): value is Uint8Array { return value instanceof Uint8Array && value.byteLength >= min && value.byteLength <= max; }
function isProjectContext(value: unknown): value is ProjectContext {
  return isRecord(value) && typeof value.projectId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.projectId)
    && typeof value.documentId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value.documentId);
}
function isDesignId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value); }
function generationRequestIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['request'];
  const issues: string[] = [];
  if (!isDesignId(value.documentId)) issues.push('documentId');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 256) issues.push('title');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 20_000) issues.push('prompt');
  if (!isDesignId(value.pageId)) issues.push('pageId');
  if (!Array.isArray(value.targetNodeIds) || value.targetNodeIds.length > 64 || !value.targetNodeIds.every(isDesignId)) issues.push('targetNodeIds');
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) issues.push('baseRevision');
  if (!isRecord(value.viewport) || !Number.isInteger(value.viewport.width) || (value.viewport.width as number) < 64 || (value.viewport.width as number) > 4096 || !Number.isInteger(value.viewport.height) || (value.viewport.height as number) < 64 || (value.viewport.height as number) > 4096) issues.push('viewport');
  if (value.themeRef !== undefined && (typeof value.themeRef !== 'string' || value.themeRef.length > 128)) issues.push('themeRef');
  if (!Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 64 || !value.referenceAssetIds.every(isDesignId)) issues.push('referenceAssetIds');
  if (value.providerRef !== 'local-fake' && value.providerRef !== 'codex-cli') issues.push('providerRef');
  if (!Array.isArray(value.constraints) || value.constraints.length > 32 || !value.constraints.every((item) => typeof item === 'string' && !!item.trim() && item.length <= 512)) issues.push('constraints');
  if (value.maxParallel !== 1) issues.push('maxParallel');
  return issues;
}
function isGenerationEvent(value: unknown): value is GenerationEvent {
  return isRecord(value) && isDesignId(value.eventId) && isDesignId(value.runId) && isDesignId(value.attemptId)
    && Number.isSafeInteger(value.seq) && (value.seq as number) > 0 && typeof value.timestamp === 'string'
    && ['stateChanged', 'regionPlanned', 'regionStarted', 'regionDraft', 'candidateReady', 'validationReported', 'error'].includes(String(value.type))
    && Number.isSafeInteger(value.documentRevision) && (value.documentRevision as number) >= 0 && isRecord(value.payload);
}
function invalidContext(): BridgeFailure { return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Project and document identity are required', retryable: false } }; }
function validStudioResult<T>(value: unknown): BridgeResult<T> {
  if (isRecord(value) && value.ok === true && isRecord(value.data)) return value as BridgeResult<T>;
  if (isRecord(value) && value.ok === false && isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string' && typeof value.error.retryable === 'boolean') return value as BridgeFailure;
  return { ok: false, error: { code: 'GENERATION_FAILED', message: 'Invalid Main process response', retryable: false } };
}

const api = Object.freeze({
  async generateAndSave(input: { title: string; prompt: string }): Promise<GenerateFrameResult> {
    if (!input || typeof input.title !== 'string' || typeof input.prompt !== 'string' || !input.title.trim() || !input.prompt.trim() || input.title.length > 256 || input.prompt.length > 20_000) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Title and prompt are required and must be within the size limits', retryable: false } };
    const result: unknown = await ipcRenderer.invoke('frame:generateAndSave', { title: input.title.trim(), prompt: input.prompt.trim() });
    if (!isRecord(result) || typeof result.ok !== 'boolean') return { ok: false, error: { code: 'GENERATION_FAILED', message: 'Invalid Main process response', retryable: false } };
    return result as GenerateFrameResult;
  },
  studio: Object.freeze({
    async newProject(context: ProjectContext): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(context)) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:newProject', context));
    },
    async openProject(context: ProjectContext): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(context)) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:openProject', context));
    },
    async load(): Promise<BridgeResult<unknown>> {
      return validStudioResult(await ipcRenderer.invoke('studio:load'));
    },
    async execute(input: ProjectContext & { baseRevision: number; commands: readonly EditorCommand[]; commandId?: string }): Promise<BridgeResult<unknown>> {
      let bytes = 0;
      try { bytes = new TextEncoder().encode(JSON.stringify(input?.commands)).byteLength; } catch { bytes = Number.POSITIVE_INFINITY; }
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 1000 || bytes > 32 * 1024 * 1024 || input.commandId !== undefined && (typeof input.commandId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(input.commandId))) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Command request is invalid or exceeds the size limit', retryable: false } };
      }
      return validStudioResult(await ipcRenderer.invoke('studio:execute', input));
    },
    async undo(input: ProjectContext & { baseRevision: number }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Revision or active project identity is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:undo', input));
    },
    async redo(input: ProjectContext & { baseRevision: number }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Revision or active project identity is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:redo', input));
    },
    async save(context: ProjectContext): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(context)) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:save', context));
    },
    async preflightPng(input: ProjectContext & { baseRevision: number; bytes: Uint8Array }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || !isBytes(input.bytes, 1, 25 * 1024 * 1024)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'PNG preflight request is invalid or too large', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:preflightPng', input));
    },
    async importPng(input: ProjectContext & { baseRevision: number; name: string; bytes: Uint8Array }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 256 || !isBytes(input.bytes, 1, 25 * 1024 * 1024)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'PNG import request is invalid or too large', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:importPng', input));
    },
    async exportPng(input: ProjectContext & { baseRevision: number; pageId: string; width: number; height: number; scale: number; bytes: Uint8Array }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || typeof input.pageId !== 'string' || !Number.isInteger(input.width) || !Number.isInteger(input.height) || !Number.isFinite(input.scale) || !isBytes(input.bytes, 1, 32 * 1024 * 1024)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'PNG export request is invalid or too large', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:exportPng', input));
    },
    async planGeneration(input: ProjectContext & { request: GenerationRequest }): Promise<BridgeResult<DesignPlan>> {
      if (!isProjectContext(input)) return invalidContext();
      const issues = generationRequestIssues(input.request);
      if (issues.length) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `Generation request fields are invalid: ${issues.join(', ')}`, retryable: false } };
      if (input.request.documentId !== input.documentId) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Generation request document ID does not match the active document', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:planGeneration', input));
    },
    async startGeneration(input: ProjectContext & { request: GenerationRequest }): Promise<BridgeResult<{ runId: string; plan: DesignPlan }>> {
      if (!isProjectContext(input)) return invalidContext();
      const issues = generationRequestIssues(input.request);
      if (issues.length) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: `Generation request fields are invalid: ${issues.join(', ')}`, retryable: false } };
      if (input.request.documentId !== input.documentId) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Generation request document ID does not match the active document', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:startGeneration', input));
    },
    async getGenerationRun(input: ProjectContext & { runId: string; afterSeq: number }): Promise<BridgeResult<GenerationRunSnapshot>> {
      if (!isProjectContext(input) || typeof input.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(input.runId) || !Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Run identity or event cursor is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:getGenerationRun', input));
    },
    async cancelGeneration(input: ProjectContext & { runId: string }): Promise<BridgeResult<{ cancelled: boolean }>> {
      if (!isProjectContext(input) || typeof input.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(input.runId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Run identity is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:cancelGeneration', input));
    },
    async applyGenerationCandidate(input: ProjectContext & { runId: string; expectedRevision: number; force: boolean }): Promise<BridgeResult<CandidateApplyResult>> {
      if (!isProjectContext(input) || typeof input.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(input.runId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.force !== 'boolean') return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Candidate application request is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:applyGenerationCandidate', input));
    },
    async copyGenerationCandidate(input: ProjectContext & { runId: string }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || typeof input.runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(input.runId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Candidate copy request is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:copyGenerationCandidate', input));
    },
    subscribeGeneration(listener: (event: GenerationEvent) => void): () => void {
      if (typeof listener !== 'function') return () => undefined;
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        if (!isGenerationEvent(raw)) return;
        try { listener(raw); } catch { /* Isolate renderer callbacks from Electron's event loop. */ }
      };
      ipcRenderer.on('studio:generation:event', handler);
      return () => ipcRenderer.removeListener('studio:generation:event', handler);
    }
  })
});

contextBridge.exposeInMainWorld('miaoma', api);
