import { contextBridge, ipcRenderer } from 'electron';
import type { EditorCommand } from '@miaoma/editor-core';
import type { DesignPlan, GenerationEvent, GenerationRequest, GenerationRunResumeResult, GenerationRunSnapshot, GenerationRunSummary, GenerationWarningsAcceptanceResult, ScreenshotEvidenceContent } from '@miaoma/shared-protocol';

type BridgeFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };
type BridgeResult<T> = { ok: true; data: T } | BridgeFailure;
type ProjectContext = { projectId: string; documentId: string };
type McpStatus = { active: boolean; endpointReady: boolean; toolNames: string[]; grant: { projectId: string; documentId: string; grantedAt: string } | null };
type McpClientName = 'vscode' | 'claude-desktop' | 'cursor';
type McpConfiguration = { clientName: McpClientName; toolNames: string[]; grant: { projectId: string; documentId: string; grantedAt: string }; config: string; configPathHint: string };
type GenerateFrameResult = { ok: true; data: { document: { pages: Array<{ root: { children: unknown[] } }> }; documentPath: string; screenshotPath: string; screenshotMetadataPath: string; screenshot: { documentRevision: number; nodeIds: string[] }; previewSvg: string }; revision: number } | BridgeFailure;
type CandidateApplyResult = { kind: 'applied'; mutation: { document: unknown; history: unknown; durableRevision: number } } | { kind: 'conflict'; currentRevision: number };
type ReactProjectPreparation = { documentId: string; revision: number; pageId: string; viewportWidth: 1440 | 768 | 390; previewUrl: string; filePaths: string[]; report: unknown };
type ReactProjectExport = { directory: string; fileCount: number; revision: number; report: unknown } | { cancelled: true };
type VisionReviewProvider = 'local-rules' | 'deepseek';
type VisionModelSettings = { provider: VisionReviewProvider; configured: boolean; model: 'deepseek-flash' };

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
  if (value.maxParallel !== 1 && value.maxParallel !== 3 && value.maxParallel !== 5) issues.push('maxParallel');
  return issues;
}
function isGenerationEvent(value: unknown): value is GenerationEvent {
  return isRecord(value) && isDesignId(value.eventId) && isDesignId(value.runId) && isDesignId(value.attemptId)
    && Number.isSafeInteger(value.seq) && (value.seq as number) > 0 && typeof value.timestamp === 'string'
    && ['stateChanged', 'regionPlanned', 'regionStarted', 'regionDraft', 'candidateReady', 'validationReported', 'agentAssigned', 'agentStarted', 'agentCandidateReady', 'agentFailed', 'snapshotReady', 'reviewStarted', 'reviewCompleted', 'repairDelegated', 'patchProposed', 'patchCommitted', 'loopDecision', 'checkpointSaved', 'runInterrupted', 'runResumed', 'warningsAccepted', 'error'].includes(String(value.type))
    && Number.isSafeInteger(value.documentRevision) && (value.documentRevision as number) >= 0 && isRecord(value.payload);
}
function invalidContext(): BridgeFailure { return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Project and document identity are required', retryable: false } }; }
function validStudioResult<T>(value: unknown): BridgeResult<T> {
  if (isRecord(value) && value.ok === true && isRecord(value.data)) return value as BridgeResult<T>;
  if (isRecord(value) && value.ok === false && isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string' && typeof value.error.retryable === 'boolean') return value as BridgeFailure;
  return { ok: false, error: { code: 'GENERATION_FAILED', message: 'Invalid Main process response', retryable: false } };
}
function validStudioArrayResult<T>(value: unknown): BridgeResult<T[]> {
  if (isRecord(value) && value.ok === true && Array.isArray(value.data)) return value as BridgeResult<T[]>;
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
    async listProjects(): Promise<BridgeResult<unknown[]>> {
      return validStudioArrayResult(await ipcRenderer.invoke('studio:listProjects'));
    },
    async switchProject(input: ProjectContext & { targetProjectId: string; targetDocumentId: string }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(input) || !isProjectContext({ projectId: input.targetProjectId, documentId: input.targetDocumentId })) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:switchProject', input));
    },
    async getVisionModelSettings(): Promise<BridgeResult<VisionModelSettings>> {
      return validStudioResult(await ipcRenderer.invoke('studio:getVisionModelSettings'));
    },
    async saveDeepSeekApiKey(input: { apiKey: string }): Promise<BridgeResult<{ configured: true }>> {
      if (!input || typeof input.apiKey !== 'string' || input.apiKey.trim().length < 8 || input.apiKey.trim().length > 512 || /[^\x21-\x7e]/.test(input.apiKey.trim())) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'DeepSeek API key must contain 8 to 512 printable non-space characters', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:saveDeepSeekApiKey', { apiKey: input.apiKey }));
    },
    async clearDeepSeekApiKey(): Promise<BridgeResult<{ configured: false }>> {
      return validStudioResult(await ipcRenderer.invoke('studio:clearDeepSeekApiKey'));
    },
    async setVisionReviewProvider(input: { provider: VisionReviewProvider; cloudConsent: boolean }): Promise<BridgeResult<{ provider: VisionReviewProvider }>> {
      if (!input || (input.provider !== 'local-rules' && input.provider !== 'deepseek') || typeof input.cloudConsent !== 'boolean') return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Vision review provider selection is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:setVisionReviewProvider', input));
    },
    async testDeepSeekConnection(): Promise<BridgeResult<{ model: 'deepseek-flash'; latencyMs: number }>> {
      return validStudioResult(await ipcRenderer.invoke('studio:testDeepSeekConnection'));
    },
    async setMcpSelection(input: ProjectContext & { nodeIds: readonly string[] }): Promise<BridgeResult<{ selectionIds: string[] }>> {
      if (!isProjectContext(input) || !Array.isArray(input.nodeIds) || input.nodeIds.length > 500 || !input.nodeIds.every(isDesignId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'MCP selection is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:setMcpSelection', { ...input, nodeIds: [...input.nodeIds] }));
    },
    async getMcpStatus(input: ProjectContext): Promise<BridgeResult<McpStatus>> {
      if (!isProjectContext(input)) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:mcpStatus', input));
    },
    async revokeMcpGrant(input: ProjectContext): Promise<BridgeResult<{ revoked: boolean }>> {
      if (!isProjectContext(input)) return invalidContext();
      return validStudioResult(await ipcRenderer.invoke('studio:revokeMcpGrant', input));
    },
    async configureMcp(input: ProjectContext & { clientName: McpClientName }): Promise<BridgeResult<McpConfiguration>> {
      if (!isProjectContext(input) || !['vscode', 'claude-desktop', 'cursor'].includes(input.clientName)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'MCP client configuration request is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:configureMcp', input));
    },
    async newProject(context: ProjectContext & { template?: 'floral' }): Promise<BridgeResult<unknown>> {
      if (!isProjectContext(context) || context.template !== undefined && context.template !== 'floral') return invalidContext();
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
    async prepareReactProject(input: ProjectContext & { expectedRevision: number; pageId: string; viewportWidth: 1440 | 768 | 390 }): Promise<BridgeResult<ReactProjectPreparation>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !isDesignId(input.pageId) || ![1440, 768, 390].includes(input.viewportWidth)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'React preview request is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:prepareReactProject', input));
    },
    async exportReactProject(input: ProjectContext & { expectedRevision: number; projectName: string }): Promise<BridgeResult<ReactProjectExport>> {
      if (!isProjectContext(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.projectName !== 'string' || !input.projectName.trim() || input.projectName.length > 128) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'React export request is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:exportReactProject', { ...input, projectName: input.projectName.trim() }));
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
    async listGenerationRuns(input: ProjectContext): Promise<BridgeResult<GenerationRunSummary[]>> {
      if (!isProjectContext(input)) return invalidContext();
      return validStudioArrayResult(await ipcRenderer.invoke('studio:listGenerationRuns', input));
    },
    async resumeGenerationRun(input: ProjectContext & { runId: string; expectedAttemptId: string }): Promise<BridgeResult<GenerationRunResumeResult>> {
      if (!isProjectContext(input) || !isDesignId(input.runId) || !isDesignId(input.expectedAttemptId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Run identity or expected attempt is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:resumeGenerationRun', input));
    },
    async acceptGenerationWarnings(input: ProjectContext & { runId: string; expectedAttemptId: string; reason: string }): Promise<BridgeResult<GenerationWarningsAcceptanceResult>> {
      if (!isProjectContext(input) || !isDesignId(input.runId) || !isDesignId(input.expectedAttemptId) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 512) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Run identity, attempt, and a 1 to 512 character reason are required', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:acceptGenerationWarnings', { ...input, reason: input.reason.trim() }));
    },
    async getLoopEvidence(input: ProjectContext & { runId: string; evidenceId: string }): Promise<BridgeResult<ScreenshotEvidenceContent>> {
      if (!isProjectContext(input) || !isDesignId(input.runId) || !isDesignId(input.evidenceId)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Run or evidence identity is invalid', retryable: false } };
      return validStudioResult(await ipcRenderer.invoke('studio:getLoopEvidence', input));
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
