import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexCliFrameProvider } from '@miaoma/codex-provider';
import { listLocalProjects } from './project-catalog';
import { DeepSeekVisualReviewer, FakeFrameProvider, GenerationRunService, RuleBasedVisualReviewer, S0GenerationService, type FrameProvider, type VisualReviewInput, type VisualReviewProvider } from '@miaoma/design-generation';
import { createStarterDocument, CommandService, DocumentStore, type EditorCommand, type PreparedTransaction } from '@miaoma/editor-core';
import { validateDesignDocument, type DesignDocument, type DesignNode } from '@miaoma/design-schema';
import { generateReactProject } from '@miaoma/codegen';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';
import { testDeepSeekConnection, VisionProviderSettingsStore, type VisionReviewProviderId } from './vision-provider-settings';
import { McpMainBridge, McpBridgeError, MCP_TOOL_NAMES, type McpStudioSource } from './mcp-main-bridge';
import {
  generationEventSchema,
  generationRunListSchema,
  generationRunResumeResultSchema,
  generationWarningsAcceptanceRequestSchema,
  generationWarningsAcceptanceResultSchema,
  generationRequestSchema,
  PocIpcRouter,
  type GenerationEvent,
  type GenerationRequest
} from '@miaoma/shared-protocol';
import {
  appendDesignJournalCommit,
  accumulateProjectAssetBytes,
  accumulateProjectAssetPixels,
  appendGenerationRunEvent,
  listGenerationRunCheckpoints,
  listGenerationRunIds,
  loadGenerationRunCheckpoint,
  getPngDimensions,
  loadRecoverableDesignDocument,
  MAX_PROJECT_ASSET_BYTES,
  MAX_PROJECT_ASSET_PIXELS,
  readLocalDesignPackage,
  readPortableProjectExport,
  readDesignAssetMetadata,
  readDesignAsset,
  readGenerationRunEvents,
  readScreenshotEvidence,
  saveDesignAsset,
  saveGenerationRunCheckpoint,
  saveScreenshotEvidence,
  saveDesignSnapshot,
  StoragePersistenceError,
  writeProjectExport,
  type RecoveryResult
} from '@miaoma/storage';

const DEFAULT_PROJECT_ID = 'miaoma-studio';
const DEFAULT_DOCUMENT_ID = 'doc_miaoma_studio';
const PREVIEW_SCHEME = 'myfigma-preview';
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } }]);
const previewBundles = new Map<string, Map<string, { body: Uint8Array; mimeType: string }>>();
const MAX_ACTIVE_PREVIEW_BUNDLES = 4;
const projectIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const s2PocMode = process.argv.includes('--s2-poc');
const s2PocRoot = path.resolve(process.env.MIAOMA_S2_POC_DIR ?? path.join(process.cwd(), 'artifacts', 's2-poc'));
const s5PocMode = process.argv.includes('--s5-poc');
const s5PocRoot = path.resolve(process.env.MIAOMA_S5_POC_DIR ?? path.join(process.cwd(), 'artifacts', 's5-poc'));
const s5SourceRoot = path.resolve(process.env.MIAOMA_S2_POC_DIR ?? path.join(process.cwd(), 'artifacts', 's2-poc'));
const s6PocMode = process.argv.includes('--s6-poc');
const s6PocRoot = path.resolve(process.env.MYFIGMA_S6_POC_DIR ?? path.join(process.cwd(), 'artifacts', 's6-poc'));
let activeProjectId = DEFAULT_PROJECT_ID;
let activeDocumentId = DEFAULT_DOCUMENT_ID;
let activeAssetPixels = 0;
let activeAssetBytes = 0;
let activeAssetPixelsById = new Map<string, number>();
const s1PocMode = process.argv.some((argument) => argument.startsWith('--s1-poc-'));
const s1PocWrite = process.argv.includes('--s1-poc-write');
const s1PocReopen = process.argv.includes('--s1-poc-reopen');
const s1PocProjectReopen = process.argv.includes('--s1-poc-project-reopen');
const s1PocNewProjectReopen = process.argv.includes('--s1-poc-new-project-reopen');
const s1PocRoot = path.resolve(process.env.MIAOMA_S1_POC_DIR ?? path.join(process.cwd(), 'artifacts', 's1-poc'));
app.setName('MyFigma');
if (s1PocMode) app.setPath('userData', path.join(s1PocRoot, 'user-data'));
if (s2PocMode) app.setPath('userData', path.join(s2PocRoot, 'user-data'));
if (s5PocMode) app.setPath('userData', path.join(s5SourceRoot, 'user-data'));
if (s6PocMode) app.setPath('userData', path.join(s6PocRoot, 'user-data'));
let window: BrowserWindow | null = null;
const router = new PocIpcRouter();
const useCodex = process.env.MIAOMA_PROVIDER === 'codex';
const headlessPoc = process.argv.includes('--s0-poc');
if (!s1PocMode && !s2PocMode && !s5PocMode && !s6PocMode && !headlessPoc) {
  const currentUserData = app.getPath('userData');
  const hasCurrentDesigns = existsSync(path.join(currentUserData, 'active-project.json')) || existsSync(path.join(currentUserData, 'projects'));
  if (!hasCurrentDesigns) {
    const appData = app.getPath('appData');
    const legacyUserData = [path.join(appData, 'Miaoma Studio'), path.join(appData, 'miaoma-studio')].find(existsSync);
    if (legacyUserData) app.setPath('userData', legacyUserData);
  }
}
let providerName = 'local-fake';
let service: S0GenerationService;
let generationRuns: GenerationRunService | null = null;
let visionProviderSettings: VisionProviderSettingsStore | null = null;
let cloudVisualConsentActive = false;
const activeDeepSeekReviewControllers = new Set<AbortController>();
const generationRunContexts = new Map<string, { projectId: string; documentId: string }>();
const MAX_GENERATION_RUN_CONTEXTS = 50;
const MAX_RETAINED_GENERATION_RUNS = 50;
const appliedGenerationRuns = new Set<string>();
let projectRoot = '';
let documentStore: DocumentStore | null = null;
let commandService: CommandService | null = null;
let startupRecovery: RecoveryResult | null = null;
let lastSnapshotRevision = 0;
let snapshotTimer: NodeJS.Timeout | null = null;
let operationQueue: Promise<void> = Promise.resolve();
let quittingAfterSnapshot = false;
let mcpBridge: McpMainBridge | null = null;
let selectedNodeIds: string[] = [];
let studioStartupComplete = false;

function style(fills: DesignNode['style']['fills'] = []): DesignNode['style'] {
  return { fills, strokes: [], effects: [], opacity: 1 };
}

function seedText(id: string, name: string, text: string, x: number, y: number, width: number, height: number, size: number, color: string, weight = 400): Extract<DesignNode, { type: 'text' }> {
  return {
    id, type: 'text', name, text, visible: true, locked: false,
    bounds: { x, y, width, height }, transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style(),
    typography: { fontFamily: 'Microsoft YaHei, Aptos, sans-serif', fontSize: size, fontWeight: weight, lineHeight: 1.35, letterSpacing: 0, textAlign: 'left', color }, sizing: 'auto'
  };
}

function seedStudioDocument(documentId = DEFAULT_DOCUMENT_ID, title = 'MyFigma · 设计工作台'): DesignDocument {
  const design = createStarterDocument(title, 'Design canvas');
  design.documentId = documentId;
  const root = design.pages[0]!.root;
  root.style.fills = [{ type: 'solid', color: { kind: 'variable', id: 'color_canvas', fallback: '#F4F3ED' } }];
  const navigation: Extract<DesignNode, { type: 'frame' }> = {
    id: 'frame_navigation', type: 'frame', name: 'Navigation', visible: true, locked: false,
    bounds: { x: 0, y: 0, width: 1440, height: 92 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: style([{ type: 'solid', color: '#FBFAF6' }]), layout: { mode: 'absolute' }, clipContent: true,
    children: [
      seedText('text_brand', '品牌名称', 'MyFigma', 72, 25, 190, 42, 25, '#263D32', 700),
      { id: 'icon_brand_leaf', type: 'icon', name: '品牌符号', visible: true, locked: false, bounds: { x: 253, y: 28, width: 30, height: 30 }, transform: { rotation: -12, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#79967E' }]), iconKey: 'leaf' },
      seedText('text_navigation', '导航链接', '灵感   模板   设计系统', 885, 34, 360, 26, 13, '#657166', 500),
      seedText('text_profile', '工作区', '工作区  ↗', 1260, 34, 110, 26, 12, '#263D32', 600)
    ]
  };
  const heroArt: Extract<DesignNode, { type: 'frame' }> = {
    id: 'frame_hero_art', type: 'frame', name: '视觉卡片', visible: true, locked: false,
    bounds: { x: 842, y: 157, width: 520, height: 610 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: style([{ type: 'solid', color: '#DDE7DA' }]), layout: { mode: 'absolute' }, clipContent: true,
    children: [
      { id: 'ellipse_sun', type: 'ellipse', name: '暖阳', visible: true, locked: false, bounds: { x: 257, y: 72, width: 180, height: 180 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#E9C982' }]) },
      { id: 'rectangle_hill_back', type: 'rectangle', name: '远山', visible: true, locked: false, bounds: { x: 33, y: 292, width: 465, height: 200 }, transform: { rotation: -5, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#A9BEA7' }]), radius: 110 },
      { id: 'rectangle_hill_front', type: 'rectangle', name: '近山', visible: true, locked: false, bounds: { x: 55, y: 373, width: 445, height: 190 }, transform: { rotation: 6, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#78957D' }]), radius: 100 },
      { id: 'icon_sparkle', type: 'icon', name: '星芒', visible: true, locked: false, bounds: { x: 91, y: 98, width: 46, height: 46 }, transform: { rotation: 12, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#FBFAF6' }]), iconKey: 'sparkle' },
      seedText('text_art_caption', '卡片说明', 'A quiet place to begin', 44, 530, 420, 34, 16, '#FBFAF6', 500)
    ]
  };
  root.children = [
    navigation,
    seedText('text_eyebrow', '眉题', 'MYFIGMA DESIGN STUDIO   ·   2026', 82, 197, 590, 24, 11, '#718576', 700),
    seedText('text_hero_title', '主标题', '让想法，先成为\n可编辑的设计。', 78, 247, 690, 166, 52, '#263D32', 700),
    seedText('text_hero_subtitle', '说明文案', '从一句需求出发，和 AI 一起搭建画面。\n每个图层、每种颜色，都可以继续修改。', 84, 438, 630, 80, 18, '#758176'),
    { id: 'rectangle_primary_action', type: 'rectangle', name: '主要按钮', visible: true, locked: false, bounds: { x: 82, y: 565, width: 197, height: 53 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#263D32' }]), radius: 10 },
    seedText('text_primary_action', '按钮文案', '开始一个新设计  →', 103, 580, 165, 25, 13, '#FBFAF6', 600),
    { id: 'ellipse_orbit', type: 'ellipse', name: '装饰圆形', visible: true, locked: false, bounds: { x: 648, y: 632, width: 78, height: 78 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style([{ type: 'solid', color: '#E6C27D' }]) },
    heroArt
  ];
  design.variables = {
    color_canvas: { id: 'color_canvas', type: 'color', value: '#F4F3ED', description: '页面画布底色' },
    color_ink: { id: 'color_ink', type: 'color', value: '#263D32', description: '深绿色文字与强调色' },
    space_panel: { id: 'space_panel', type: 'spacing', value: 24, description: '面板基础间距' },
    radius_card: { id: 'radius_card', type: 'radius', value: 28, description: '卡片圆角' }
  };
  return design;
}

function studioError(code: string, message: string, retryable = false) {
  return { ok: false as const, error: { code, message: message.slice(0, 512), retryable } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isActiveProjectContext(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.projectId === 'string' && projectIdPattern.test(value.projectId)
    && typeof value.documentId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value.documentId)
    && value.projectId === activeProjectId && value.documentId === activeDocumentId;
}

function staleProjectContext() {
  return studioError('PROJECT_CONTEXT_CHANGED', 'The active design changed before this operation could be applied');
}

function errorResponse(error: unknown) {
  let code = 'GENERATION_FAILED';
  if (error instanceof StoragePersistenceError) code = error.code;
  else if (error instanceof Error && 'code' in error && typeof (error as Error & { code?: unknown }).code === 'string') code = (error as Error & { code: string }).code;
  const retryable = code === 'IO_ERROR' || code === 'GENERATION_FAILED' || code === 'JOURNAL_WRITE_FAILED'
    || (error instanceof Error && 'retryable' in error && (error as Error & { retryable?: unknown }).retryable === true);
  return studioError(code, error instanceof Error ? error.message : 'Unknown studio error', retryable);
}

function activeProjectPointerPath(): string {
  return path.join(app.getPath('userData'), 'active-project.json');
}

async function readActiveProjectPointer(): Promise<{ projectId: string; documentId: string } | null> {
  try {
    const input: unknown = JSON.parse(await readFile(activeProjectPointerPath(), 'utf8'));
    if (!isRecord(input) || typeof input.projectId !== 'string' || !projectIdPattern.test(input.projectId) || typeof input.documentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.documentId)) return null;
    return { projectId: input.projectId, documentId: input.documentId };
  } catch { return null; }
}

async function writeActiveProjectPointer(projectId: string, documentId: string): Promise<void> {
  const target = activeProjectPointerPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ projectId, documentId }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(temporary, target); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

function withStudioLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function getStore(): { store: DocumentStore; commands: CommandService } {
  if (!documentStore || !commandService) throw new Error('Studio document is not initialized');
  return { store: documentStore, commands: commandService };
}

function createMcpStudioSource(): McpStudioSource {
  return {
    getDocumentContext() {
      const document = getStore().store.getSnapshot();
      const nodesById = new Map<string, unknown>();
      const pageIdByNode = new Map<string, string>();
      for (const page of document.pages) {
        const stack: DesignNode[] = [page.root];
        while (stack.length) {
          const node = stack.pop()!;
          nodesById.set(node.id, node);
          pageIdByNode.set(node.id, page.id);
          if (node.type === 'frame') stack.push(...node.children);
        }
      }
      return {
        projectId: activeProjectId,
        documentId: document.documentId,
        title: document.title,
        revision: document.revision,
        pages: document.pages.map((page) => ({ id: page.id, name: page.name, width: page.root.bounds.width, height: page.root.bounds.height })),
        variables: document.variables,
        selectionIds: selectedNodeIds.filter((id) => nodesById.has(id)),
        nodesById,
        pageIdByNode,
        assets: Object.fromEntries(Object.values(document.assets).map((asset) => [asset.id, { id: asset.id, mimeType: asset.mimeType, byteSize: asset.byteSize, sha256: asset.sha256 }]))
      };
    },
    async getAsset(projectId, documentId, assetId, expectedRevision) {
      const document = getStore().store.getSnapshot();
      if (projectId !== activeProjectId || documentId !== activeDocumentId || document.documentId !== documentId || document.revision !== expectedRevision) throw new McpBridgeError('INVALID_ARGUMENT', 'The design changed before the asset was read');
      const expected = document.assets[assetId];
      if (!expected) throw new McpBridgeError('ASSET_NOT_FOUND', 'Asset does not exist in the granted document');
      const stored = await readDesignAsset(projectRoot, projectId, documentId, assetId);
      if (stored.asset.sha256 !== expected.sha256 || stored.asset.mimeType !== expected.mimeType || stored.bytes.byteLength !== expected.byteSize) {
        throw new McpBridgeError('APP_UNAVAILABLE', 'Asset verification did not match the active revision');
      }
      return { mimeType: stored.asset.mimeType, base64: Buffer.from(stored.bytes).toString('base64') };
    },
    renderScreenshot({ pageId, nodeIds, scale, maxEdge }) {
      const document = getStore().store.getSnapshot();
      const screenshot = renderDocumentScreenshot(document, pageId, scale, maxEdge, nodeIds);
      return { metadata: screenshot.metadata as unknown as Record<string, unknown>, svg: screenshot.svg };
    }
  };
}

function syncActiveAssetUsage(document: DesignDocument): void {
  let totalPixels = 0;
  let totalBytes = 0;
  let completePixelCount = true;
  for (const assetId of Object.keys(document.assets)) {
    const asset = document.assets[assetId]!;
    totalBytes = accumulateProjectAssetBytes(totalBytes, asset.byteSize);
    const assetPixels = activeAssetPixelsById.get(assetId);
    if (!Number.isSafeInteger(assetPixels) || assetPixels! < 1) {
      completePixelCount = false;
      continue;
    }
    totalPixels = accumulateProjectAssetPixels(totalPixels, { width: assetPixels!, height: 1 });
  }
  activeAssetPixels = completePixelCount ? totalPixels : MAX_PROJECT_ASSET_PIXELS;
  activeAssetBytes = totalBytes;
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function cancelActiveDeepSeekReviews(): void {
  for (const controller of activeDeepSeekReviewControllers) controller.abort();
}

async function runCancellableDeepSeekReview(
  reviewer: DeepSeekVisualReviewer,
  input: VisualReviewInput,
  parentSignal: AbortSignal
): ReturnType<DeepSeekVisualReviewer['review']> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  activeDeepSeekReviewControllers.add(controller);
  try { return await reviewer.review(input, { signal: controller.signal }); }
  finally {
    parentSignal.removeEventListener('abort', abortFromParent);
    activeDeepSeekReviewControllers.delete(controller);
  }
}

async function rasterizeVisualReviewSvg(svg: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new Error('Visual review was cancelled');
  if (Buffer.byteLength(svg, 'utf8') > 8 * 1024 * 1024) throw new Error('Visual review screenshot exceeds the input size limit');
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
  if (image.isEmpty()) throw new Error('Visual review screenshot could not be decoded');
  const size = image.getSize();
  if (size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw new Error('Visual review screenshot dimensions are invalid');
  const scale = Math.min(1, 2048 / size.width, 2048 / size.height);
  const normalized = scale < 1
    ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
    : image;
  if (signal.aborted) throw new Error('Visual review was cancelled');
  const png = normalized.toPNG();
  if (png.byteLength < 1 || png.byteLength > 8 * 1024 * 1024) throw new Error('Visual review screenshot exceeds the PNG size limit');
  return new Uint8Array(png);
}

function scheduleSnapshot(): void {
  if (s1PocMode) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    void withStudioLock(async () => {
      const { store } = getStore();
      const current = store.getSnapshot();
      if (current.revision <= lastSnapshotRevision) return;
      const saved = await saveDesignSnapshot(projectRoot, activeProjectId, current);
      lastSnapshotRevision = saved.revision;
    }).catch((error) => console.error('Studio snapshot failed:', error));
  }, 500);
}

type JournalCommandOverride = { commands: readonly unknown[]; metadata?: unknown };

async function persistPrepared(prepared: PreparedTransaction, commandId?: string, origin: 'human' | 'agent' | 'import' = 'human', journalOverride?: JournalCommandOverride) {
  const { commands } = getStore();
  if (!prepared.changed) return { ...commands.commitPrepared(prepared), durableRevision: prepared.baseRevision };
  const journalCommandId = commandId ?? `cmd_${randomUUID().replaceAll('-', '')}`;
  const journalCommands = journalOverride?.commands ?? prepared.commands ?? [{ type: 'history', direction: prepared.kind, transactionId: prepared.transactionId }];
  const appended = await appendDesignJournalCommit(projectRoot, activeProjectId, {
    commandId: journalCommandId,
    baseRevision: prepared.baseRevision,
    nextRevision: prepared.revision,
    commands: journalCommands,
    origin,
    metadata: journalOverride?.metadata ?? (prepared.commands ? undefined : { kind: prepared.kind, transactionId: prepared.transactionId }),
    document: prepared.document
  });
  const result = commands.commitPrepared(prepared);
  syncActiveAssetUsage(result.document);
  scheduleSnapshot();
  return { ...result, durableRevision: appended.revision };
}

function validateCommandPayload(input: unknown): { projectId: string; documentId: string; baseRevision: number; commands: EditorCommand[]; commandId?: string } | null {
  if (!isRecord(input) || typeof input.projectId !== 'string' || typeof input.documentId !== 'string' || !Number.isSafeInteger(input.baseRevision) || (input.baseRevision as number) < 0 || !Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 1000) return null;
  if (input.commands.some((command) => !isRecord(command)) || Buffer.byteLength(JSON.stringify(input.commands), 'utf8') > 32 * 1024 * 1024) return null;
  if (input.commandId !== undefined && (typeof input.commandId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(input.commandId))) return null;
  return { projectId: input.projectId, documentId: input.documentId, baseRevision: input.baseRevision as number, commands: input.commands as EditorCommand[], ...(typeof input.commandId === 'string' ? { commandId: input.commandId } : {}) };
}

function parseGenerationInput(input: unknown): { projectId: string; documentId: string; request: GenerationRequest } | null {
  if (!isActiveProjectContext(input) || !isRecord(input) || !isRecord(input.request)) return null;
  const parsed = generationRequestSchema.safeParse(input.request);
  if (!parsed.success || parsed.data.documentId !== input.documentId) return null;
  return { projectId: input.projectId as string, documentId: input.documentId as string, request: parsed.data };
}

function isWholePageGenerationScope(document: DesignDocument, request: GenerationRequest): boolean {
  const page = document.pages.find((candidate) => candidate.id === request.pageId);
  return !!page && (request.targetNodeIds.length === 0 || (request.targetNodeIds.length === 1 && request.targetNodeIds[0] === page.root.id));
}

function collectNodeIds(page: DesignDocument['pages'][number]): string[] {
  const ids: string[] = [];
  const stack: DesignNode[] = [page.root];
  while (stack.length) {
    const node = stack.pop()!;
    ids.push(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  return ids;
}

async function loadAssetDataUrls(document: DesignDocument, projectId = activeProjectId, selectedAssetIds: readonly string[] = Object.keys(document.assets)): Promise<{ assetDataUrls: Record<string, string>; assetPixelsById: Record<string, number>; totalAssetPixels: number; totalAssetBytes: number }> {
  const assetDataUrls: Record<string, string> = {};
  const assetPixelsById: Record<string, number> = {};
  let totalAssetPixels = 0;
  let totalAssetBytes = 0;
  for (const assetId of selectedAssetIds) {
    if (!document.assets[assetId]) continue;
    const stored = await readDesignAssetMetadata(projectRoot, projectId, document.documentId, document.assets[assetId]);
    const dimensions = getPngDimensions(stored.bytes);
    totalAssetPixels = accumulateProjectAssetPixels(totalAssetPixels, dimensions);
    totalAssetBytes = accumulateProjectAssetBytes(totalAssetBytes, stored.bytes.byteLength);
    assetPixelsById[assetId] = dimensions.width * dimensions.height;
    assetDataUrls[assetId] = `data:${stored.asset.mimeType};base64,${Buffer.from(stored.bytes).toString('base64')}`;
  }
  return { assetDataUrls, assetPixelsById, totalAssetPixels, totalAssetBytes };
}

async function makeReviewAssetDataUrls(projectId: string, document: DesignDocument): Promise<Record<string, string>> {
  const usedAssetIds = new Set<string>();
  const stack: DesignNode[] = document.pages.map((page) => page.root);
  while (stack.length) {
    const node = stack.pop()!;
    for (const fill of node.style.fills) if (fill.type === 'asset') usedAssetIds.add(fill.assetId);
    if (node.type === 'frame') stack.push(...node.children);
  }
  const previews: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const assetId of usedAssetIds) {
    const asset = document.assets[assetId];
    if (!asset) continue;
    const stored = await readDesignAssetMetadata(projectRoot, projectId, document.documentId, asset);
    const source = nativeImage.createFromBuffer(Buffer.from(stored.bytes));
    if (source.isEmpty()) continue;
    const size = source.getSize();
    const ratio = Math.min(1, 960 / Math.max(size.width, size.height));
    const preview = source.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' }).toJPEG(72);
    previews[assetId] = `data:image/jpeg;base64,${preview.toString('base64')}`;
  }
  return previews;
}

async function makeProjectPreviewAssetDataUrls(projectId: string, document: DesignDocument): Promise<Record<string, string>> {
  const page = document.pages[0];
  if (!page) return {};
  const usedAssetIds = new Set<string>();
  const stack: DesignNode[] = [page.root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const fill of node.style.fills) if (fill.type === 'asset') usedAssetIds.add(fill.assetId);
    if (node.type === 'frame') stack.push(...node.children);
  }
  const previews: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const assetId of usedAssetIds) {
    const asset = document.assets[assetId];
    if (!asset) continue;
    const stored = await readDesignAssetMetadata(projectRoot, projectId, document.documentId, asset);
    const source = nativeImage.createFromBuffer(Buffer.from(stored.bytes));
    if (source.isEmpty()) continue;
    const size = source.getSize();
    const ratio = Math.min(1, 480 / Math.max(size.width, size.height));
    const preview = source.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' }).toJPEG(58);
    previews[assetId] = `data:image/jpeg;base64,${preview.toString('base64')}`;
  }
  return previews;
}

async function generateCodegenProject(document: DesignDocument, projectId: string, initialPageId?: string) {
  const assets: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let totalBytes = 0;
  for (const [assetId, metadata] of Object.entries(document.assets)) {
    totalBytes = accumulateProjectAssetBytes(totalBytes, metadata.byteSize);
    const stored = await readDesignAssetMetadata(projectRoot, projectId, document.documentId, metadata);
    if (stored.asset.id !== assetId || stored.asset.sha256 !== metadata.sha256 || stored.asset.byteSize !== metadata.byteSize || stored.asset.mimeType !== metadata.mimeType) {
      throw new StoragePersistenceError('ASSET_HASH_MISMATCH', `Stored asset ${assetId} does not match the active document revision`);
    }
    assets[assetId] = stored.bytes;
  }
  return generateReactProject({ document, assets, ...(initialPageId ? { initialPageId } : {}) });
}

function codegenReport(result: Extract<ReturnType<typeof generateReactProject>, { success: true }>): {
  validation: Extract<ReturnType<typeof generateReactProject>, { success: true }>['validation'];
  viewportReport: { viewports: Extract<ReturnType<typeof generateReactProject>, { success: true }>['viewportReport']['viewports']; checks: Array<Record<string, unknown>> };
  interactionReport: { supportedActions: Extract<ReturnType<typeof generateReactProject>, { success: true }>['interactionReport']['supportedActions']; bindingCount: number; bindings: unknown[]; missingInteractionCount: number; missingInteractions: unknown[] };
  manifest: { documentId: string; revision: number; title: string; initialPageId: string; pageCount: number; componentCount: number; assetCount: number; reportFile: string };
  warningCount: number;
  previewWarning?: string;
} {
  const manifest = result.manifest;
  return {
    validation: result.validation,
    viewportReport: {
      viewports: result.viewportReport.viewports,
      checks: result.viewportReport.checks.map((check) => ({
        pageId: check.pageId, pageName: check.pageName, viewport: check.viewport, status: check.status,
        effectiveWidth: check.effectiveWidth, visibleNodeCount: check.visibleNodeCount, issueCount: check.issues.length, issues: check.issues.slice(0, 100)
      }))
    },
    interactionReport: {
      supportedActions: result.interactionReport.supportedActions,
      bindingCount: result.interactionReport.bindings.length,
      bindings: result.interactionReport.bindings.slice(0, 100),
      missingInteractionCount: result.interactionReport.missingInteractions.length,
      missingInteractions: result.interactionReport.missingInteractions.slice(0, 100)
    },
    manifest: {
      documentId: manifest.documentId, revision: manifest.revision, title: manifest.title, initialPageId: manifest.initialPageId,
      pageCount: manifest.pages.length, componentCount: manifest.components.length, assetCount: manifest.assets.length,
      reportFile: 'public/design-manifest.json'
    },
    warningCount: result.viewportReport.checks.filter((check) => check.status === 'warning').length + result.interactionReport.missingInteractions.length
  };
}

function buildIsolatedPreview(files: readonly { path: string; content: string | Uint8Array; mimeType: string }[]): { files: Map<string, { body: Uint8Array; mimeType: string }>; omittedAssetCount: number } {
  const htmlFile = files.find((file) => file.path === 'preview.html');
  const cssFile = files.find((file) => file.path === 'preview.css');
  const scriptFile = files.find((file) => file.path === 'preview.js');
  if (!htmlFile || typeof htmlFile.content !== 'string' || !cssFile || typeof cssFile.content !== 'string' || !scriptFile || typeof scriptFile.content !== 'string') {
    throw new StoragePersistenceError('CODEGEN_PREVIEW_MISSING', 'Generated project is missing its static preview files');
  }
  if (htmlFile.content.length > 2 * 1024 * 1024 || cssFile.content.length > 4 * 1024 * 1024 || scriptFile.content.length > 4 * 1024 * 1024) {
    throw new StoragePersistenceError('CODEGEN_PREVIEW_TOO_LARGE', 'The generated preview exceeds the safe display limit');
  }
  const PREVIEW_ASSET_BUDGET = 8 * 1024 * 1024;
  let inlinedAssetBytes = 0;
  const omittedAssetPaths = new Set<string>();
  const previewFiles = new Map<string, { body: Uint8Array; mimeType: string }>();
  previewFiles.set('preview.html', { body: Buffer.from(htmlFile.content, 'utf8'), mimeType: 'text/html; charset=utf-8' });
  previewFiles.set('preview.js', { body: Buffer.from(scriptFile.content, 'utf8'), mimeType: 'text/javascript; charset=utf-8' });
  for (const file of files) {
    if (!file.path.startsWith('public/assets/') || !(file.content instanceof Uint8Array)) continue;
    if (file.content.byteLength > PREVIEW_ASSET_BUDGET - inlinedAssetBytes) {
      omittedAssetPaths.add(file.path);
      continue;
    }
    inlinedAssetBytes += file.content.byteLength;
    previewFiles.set(file.path, { body: file.content, mimeType: file.mimeType });
  }
  let css = cssFile.content;
  css = css.replace(/url\(["']?\.\/(public\/assets\/[a-f0-9]+\.(?:png|jpg|webp|svg))["']?\)/gi, (match, assetPath: string) => {
    if (previewFiles.has(assetPath)) return match;
    if (files.some((file) => file.path === assetPath)) omittedAssetPaths.add(assetPath);
    return 'url("data:,")';
  });
  previewFiles.set('preview.css', { body: Buffer.from(css, 'utf8'), mimeType: 'text/css; charset=utf-8' });
  return { files: previewFiles, omittedAssetCount: omittedAssetPaths.size };
}

function servePreviewFile(request: Request): Response {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  let url: URL;
  try { url = new URL(request.url); }
  catch { return new Response('Not found', { status: 404 }); }
  const token = url.hostname;
  let relativePath = '';
  try { relativePath = decodeURIComponent(url.pathname.replace(/^\//, '')); }
  catch { return new Response('Not found', { status: 404 }); }
  if (!/^[0-9a-f-]{36}$/.test(token) || !relativePath || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return new Response('Not found', { status: 404 });
  }
  const file = previewBundles.get(token)?.get(relativePath);
  if (!file) return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
  return new Response(Buffer.from(file.body), { headers: {
    'Content-Type': file.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...(relativePath === 'preview.html' ? { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'none'" } : {})
  } });
}

function validExportProjectName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && value === value.trim()
    && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && value !== '.' && value !== '..'
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}

function codegenPathSegments(relativePath: unknown): string[] | null {
  if (typeof relativePath !== 'string' || relativePath.length < 1 || relativePath.length > 512 || relativePath.startsWith('/') || relativePath.includes('\\') || /^[a-zA-Z]:/.test(relativePath)) return null;
  const segments = relativePath.split('/');
  if (segments.length > 32 || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) return null;
  return segments;
}

async function writeGeneratedProject(parentDirectory: string, projectName: string, files: readonly { path: string; content: string | Uint8Array }[]): Promise<string> {
  const parentInfo = await lstat(parentDirectory);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_EXPORT_DIRECTORY', 'Choose a real, non-symbolic-link output folder');
  const parentReal = await realpath(parentDirectory);
  const finalDirectory = path.join(parentReal, projectName);
  const stageDirectory = path.join(parentReal, `.myfigma-export-${randomUUID()}`);
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  if (files.length < 1 || files.length > 2_000) throw new StoragePersistenceError('CODEGEN_FILE_LIMIT', 'Generated project file count is outside the safe limit');
  await mkdir(stageDirectory, { recursive: false });
  try {
    for (const file of files) {
      const segments = codegenPathSegments(file.path);
      if (!segments) throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Generated project contains an unsafe relative path');
      const normalizedKey = segments.join('/').toLocaleLowerCase('en-US');
      if (seenPaths.has(normalizedKey)) throw new StoragePersistenceError('DUPLICATE_EXPORT_PATH', `Generated project contains a duplicate file: ${file.path}`);
      seenPaths.add(normalizedKey);
      const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PROJECT_ASSET_BYTES + 16 * 1024 * 1024) throw new StoragePersistenceError('CODEGEN_OUTPUT_TOO_LARGE', 'Generated project exceeds the 116 MiB export limit');
      let directory = stageDirectory;
      for (const segment of segments.slice(0, -1)) {
        const next = path.join(directory, segment);
        try { await mkdir(next, { recursive: false }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const details = await lstat(next);
        if (!details.isDirectory() || details.isSymbolicLink()) throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Generated project directory is not a regular directory');
        const actual = await realpath(next);
        if (path.dirname(actual) !== directory) throw new StoragePersistenceError('UNSAFE_EXPORT_PATH', 'Generated project path escaped its staging directory');
        directory = actual;
      }
      const target = path.join(directory, segments.at(-1)!);
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    }
    try {
      await lstat(finalDirectory);
      throw new StoragePersistenceError('EXPORT_PATH_EXISTS', `A folder named "${projectName}" already exists at the selected location`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(stageDirectory, finalDirectory);
    return finalDirectory;
  } catch (error) {
    const resolvedStage = path.resolve(stageDirectory);
    if (path.dirname(resolvedStage) === parentReal && path.basename(resolvedStage).startsWith('.myfigma-export-')) {
      await rm(resolvedStage, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function restoreGenerationRuns(projectId: string, activeDocument: DesignDocument): Promise<void> {
  if (!generationRuns) return;
  const existing = new Set(generationRuns.list(projectId).map((run) => run.runId));
  const runIds = await listGenerationRunIds(projectRoot, projectId);
  const candidates: Array<{ runId: string; checkpointId: string; updatedAt: string; eventSeq: number }> = [];
  for (const runId of runIds) {
    if (existing.has(runId)) {
      generationRunContexts.set(runId, { projectId, documentId: activeDocument.documentId });
      continue;
    }
    try {
      const checkpoints = await listGenerationRunCheckpoints(projectRoot, projectId, runId);
      const latest = checkpoints[0];
      if (!latest) continue;
      candidates.push({ runId, checkpointId: latest.checkpointId, updatedAt: latest.updatedAt, eventSeq: latest.eventSeq });
    } catch (error) {
      startupRecovery?.diagnostics.push({ code: 'RUN_RECOVERY_FAILED', message: `Run ${runId} checkpoints could not be listed: ${error instanceof Error ? error.message : 'unknown storage error'}` });
    }
  }
  candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.eventSeq - left.eventSeq || left.runId.localeCompare(right.runId));
  let restoredCount = existing.size;
  for (const latest of candidates) {
    if (restoredCount >= MAX_RETAINED_GENERATION_RUNS) break;
    const { runId } = latest;
    const context = { projectId, documentId: activeDocument.documentId };
    try {
      const checkpoint = await loadGenerationRunCheckpoint(projectRoot, projectId, runId, latest.checkpointId);
      if (checkpoint.projectId !== projectId || checkpoint.runId !== runId || checkpoint.loop.checkpointId !== latest.checkpointId) {
        throw new StoragePersistenceError('RUN_IDENTITY_MISMATCH', 'Stored generation checkpoint identity does not match its project, run, or checkpoint path');
      }
      const eventLog = await readGenerationRunEvents(projectRoot, projectId, runId, 0);
      generationRuns.restore(checkpoint, eventLog.events, activeDocument);
      generationRunContexts.set(runId, context);
      restoredCount++;
      if (eventLog.ignoredTailBytes) startupRecovery?.diagnostics.push({ code: 'RUN_EVENT_TAIL_IGNORED', message: `Run ${runId} has ${eventLog.ignoredTailBytes} incomplete trailing event bytes` });
      for (const evidence of checkpoint.loop.evidence) {
        try { generationRuns.hydrateEvidence(runId, await readScreenshotEvidence(projectRoot, projectId, runId, evidence.evidenceId)); }
        catch (error) {
          startupRecovery?.diagnostics.push({ code: 'RUN_EVIDENCE_UNAVAILABLE', message: `Run ${runId} evidence ${evidence.evidenceId} could not be loaded: ${error instanceof Error ? error.message : 'unknown storage error'}` });
        }
      }
    } catch (error) {
      startupRecovery?.diagnostics.push({ code: 'RUN_RECOVERY_FAILED', message: `Run ${runId} could not be restored: ${error instanceof Error ? error.message : 'unknown storage error'}` });
    }
  }
}

function generationCandidateIsEligible(snapshot: ReturnType<GenerationRunService['get']>): boolean {
  return snapshot.run.state === 'completed' && snapshot.run.candidateAvailable
    && (snapshot.loop?.quality === 'passed' || snapshot.loop?.quality === 'accepted_warnings')
    && !!snapshot.candidate && snapshot.candidate.runId === snapshot.run.runId;
}

async function activateStudioProject(projectId: string, document: DesignDocument, recovery: RecoveryResult): Promise<{
  projectId: string;
  document: DesignDocument;
  history: ReturnType<DocumentStore['getHistoryState']>;
  durableRevision: number;
  recovery: { snapshotRevision: number; replayedCommits: number; ignoredTailBytes: number; diagnostics: RecoveryResult['diagnostics'] };
  assetDataUrls: Record<string, string>;
}> {
  for (const [runId, context] of generationRunContexts) {
    if (context.projectId !== projectId || context.documentId !== document.documentId) generationRuns?.cancel(runId);
  }
  if (activeProjectId !== projectId || activeDocumentId !== document.documentId) mcpBridge?.revokeGrant();
  selectedNodeIds = [];
  const assets = await loadAssetDataUrls(document, projectId);
  await writeActiveProjectPointer(projectId, document.documentId);
  const store = new DocumentStore(document);
  activeProjectId = projectId;
  activeDocumentId = document.documentId;
  activeAssetPixels = assets.totalAssetPixels;
  activeAssetBytes = assets.totalAssetBytes;
  activeAssetPixelsById = new Map(Object.entries(assets.assetPixelsById));
  documentStore = store;
  commandService = new CommandService(store);
  startupRecovery = recovery;
  lastSnapshotRevision = recovery.snapshotRevision;
  await restoreGenerationRuns(projectId, document);
  return {
    projectId,
    document,
    history: store.getHistoryState(),
    durableRevision: document.revision,
    recovery: { snapshotRevision: recovery.snapshotRevision, replayedCommits: recovery.replayedCommits, ignoredTailBytes: recovery.ignoredTailBytes, diagnostics: recovery.diagnostics },
    assetDataUrls: assets.assetDataUrls
  };
}

function registerStudioHandlers(): void {
  ipcMain.handle('studio:listProjects', async (event) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    try {
      return await withStudioLock(async () => {
        const document = getStore().store.getSnapshot();
        if (document.revision !== lastSnapshotRevision) {
          const saved = await saveDesignSnapshot(projectRoot, activeProjectId, document);
          lastSnapshotRevision = saved.revision;
        }
        return { ok: true as const, data: await listLocalProjects(projectRoot, makeProjectPreviewAssetDataUrls) };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:switchProject', async (event, input: unknown) => {
    if (!trustedSender(event) || !isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || typeof input.targetProjectId !== 'string' || !projectIdPattern.test(input.targetProjectId)
      || typeof input.targetDocumentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.targetDocumentId)) {
      return studioError('INVALID_ARGUMENT', 'Target project identity is invalid');
    }
    const projectId = input.targetProjectId;
    const documentId = input.targetDocumentId;
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        await saveDesignSnapshot(projectRoot, activeProjectId, getStore().store.getSnapshot());
        const recovery = await loadRecoverableDesignDocument(projectRoot, projectId, documentId);
        return { ok: true as const, data: await activateStudioProject(projectId, recovery.document, recovery) };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:getVisionModelSettings', async (event) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!visionProviderSettings) return studioError('APP_UNAVAILABLE', 'Secure vision model settings are unavailable', true);
    try { return { ok: true as const, data: visionProviderSettings.getView() }; }
    catch { return studioError('APP_UNAVAILABLE', 'Vision model settings could not be loaded', true); }
  });

  ipcMain.handle('studio:saveDeepSeekApiKey', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isRecord(input) || typeof input.apiKey !== 'string') return studioError('INVALID_ARGUMENT', 'DeepSeek API key is invalid');
    if (!visionProviderSettings) return studioError('APP_UNAVAILABLE', 'Secure vision model settings are unavailable', true);
    try {
      await visionProviderSettings.saveApiKey(input.apiKey);
      return { ok: true as const, data: { configured: true as const } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DeepSeek API key could not be saved';
      const invalidInput = message.startsWith('API key must contain');
      return studioError(invalidInput ? 'INVALID_ARGUMENT' : 'APP_UNAVAILABLE', message, !invalidInput);
    }
  });

  ipcMain.handle('studio:clearDeepSeekApiKey', async (event) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!visionProviderSettings) return studioError('APP_UNAVAILABLE', 'Secure vision model settings are unavailable', true);
    cloudVisualConsentActive = false;
    cancelActiveDeepSeekReviews();
    try {
      await visionProviderSettings.clearApiKey();
      return { ok: true as const, data: { configured: false as const } };
    } catch {
      cloudVisualConsentActive = visionProviderSettings.getView().provider === 'deepseek';
      return studioError('APP_UNAVAILABLE', 'DeepSeek API key could not be removed', true);
    }
  });

  ipcMain.handle('studio:setVisionReviewProvider', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isRecord(input) || (input.provider !== 'local-rules' && input.provider !== 'deepseek') || typeof input.cloudConsent !== 'boolean') return studioError('INVALID_ARGUMENT', 'Vision review provider selection is invalid');
    if (input.provider === 'deepseek' && input.cloudConsent !== true) return studioError('CONSENT_REQUIRED', 'Confirm before sending design screenshots to DeepSeek');
    if (!visionProviderSettings) return studioError('APP_UNAVAILABLE', 'Secure vision model settings are unavailable', true);
    if (input.provider === 'local-rules') {
      cloudVisualConsentActive = false;
      cancelActiveDeepSeekReviews();
    }
    try {
      await visionProviderSettings.setProvider(input.provider as VisionReviewProviderId);
      cloudVisualConsentActive = input.provider === 'deepseek';
      return { ok: true as const, data: { provider: input.provider as VisionReviewProviderId } };
    } catch (error) {
      cloudVisualConsentActive = visionProviderSettings.getView().provider === 'deepseek';
      const message = error instanceof Error ? error.message : 'Vision review provider could not be changed';
      return studioError(message.includes('Save a DeepSeek API key') ? 'API_KEY_REQUIRED' : 'APP_UNAVAILABLE', message, true);
    }
  });

  ipcMain.handle('studio:testDeepSeekConnection', async (event) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!visionProviderSettings) return studioError('APP_UNAVAILABLE', 'Secure vision model settings are unavailable', true);
    try {
      const apiKey = await visionProviderSettings.getApiKey();
      if (!apiKey) return studioError('API_KEY_REQUIRED', 'Save a DeepSeek API key before testing the connection');
      return { ok: true as const, data: await testDeepSeekConnection(apiKey) };
    } catch (error) {
      return studioError('PROVIDER_UNAVAILABLE', error instanceof Error ? error.message : 'DeepSeek connection could not be completed', true);
    }
  });

  ipcMain.handle('studio:setMcpSelection', async (event, input: unknown) => {
    if (!trustedSender(event) || !isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Array.isArray(input.nodeIds) || input.nodeIds.length > 500 || input.nodeIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(id))) return studioError('INVALID_ARGUMENT', 'MCP selection is invalid');
    const document = getStore().store.getSnapshot();
    const known = new Set<string>();
    const stack: DesignNode[] = document.pages.map((page) => page.root);
    while (stack.length) {
      const node = stack.pop()!;
      known.add(node.id);
      if (node.type === 'frame') stack.push(...node.children);
    }
    const unique = [...new Set(input.nodeIds as string[])];
    if (unique.some((id) => !known.has(id))) return studioError('INVALID_ARGUMENT', 'MCP selection contains a node outside the active document');
    selectedNodeIds = unique;
    return { ok: true as const, data: { selectionIds: selectedNodeIds } };
  });

  ipcMain.handle('studio:mcpStatus', (event, input: unknown) => {
    if (!trustedSender(event) || !isActiveProjectContext(input)) return staleProjectContext();
    if (!mcpBridge) return studioError('APP_UNAVAILABLE', 'MCP sidecar bridge is not available', true);
    return { ok: true as const, data: mcpBridge.getStatus() };
  });

  ipcMain.handle('studio:revokeMcpGrant', (event, input: unknown) => {
    if (!trustedSender(event) || !isActiveProjectContext(input)) return staleProjectContext();
    mcpBridge?.revokeGrant();
    return { ok: true as const, data: { revoked: true } };
  });

  ipcMain.handle('studio:configureMcp', async (event, input: unknown) => {
    if (!trustedSender(event) || !isActiveProjectContext(input)) return staleProjectContext();
    if (!mcpBridge) return studioError('APP_UNAVAILABLE', 'MCP sidecar bridge is not available', true);
    if (!isRecord(input) || !['vscode', 'claude-desktop', 'cursor'].includes(String(input.clientName))) return studioError('INVALID_ARGUMENT', 'MCP client is not supported');
    try {
      const grant = await mcpBridge.setGrant(activeProjectId, activeDocumentId);
      const sidecarEntry = path.resolve(__dirname, '..', '..', 'mcp-sidecar', 'dist', 'stdio.js');
      const endpointPath = mcpBridge.getEndpointPath();
      const command = process.env.MIAOMA_MCP_NODE_EXECUTABLE?.trim() || 'node';
      const args = [sidecarEntry, '--endpoint-file', endpointPath];
      const clientName = input.clientName as 'vscode' | 'claude-desktop' | 'cursor';
      const server = clientName === 'vscode'
        ? { type: 'stdio', command, args }
        : { command, args };
      const config = clientName === 'vscode'
        ? { servers: { miaoma: server } }
        : { mcpServers: { miaoma: server } };
      const configPathHint = clientName === 'vscode'
        ? '<workspace>/.vscode/mcp.json'
        : clientName === 'claude-desktop'
          ? path.join(process.env.APPDATA ?? '%APPDATA%', 'Claude', 'claude_desktop_config.json')
          : path.join(os.homedir(), '.cursor', 'mcp.json');
      return { ok: true as const, data: { clientName, toolNames: MCP_TOOL_NAMES, grant, config: JSON.stringify(config, null, 2), configPathHint } };
    } catch (error) {
      const failure = error instanceof McpBridgeError ? error : new McpBridgeError('APP_UNAVAILABLE', 'MCP client configuration could not be prepared');
      return studioError(failure.code, failure.message);
    }
  });

  ipcMain.handle('studio:load', async (event) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    try {
      return await withStudioLock(async () => {
        const { store } = getStore();
        const document = store.getSnapshot();
        const loadedAssets = await loadAssetDataUrls(document).catch((error) => {
          if (error instanceof StoragePersistenceError && ['ASSET_PIXEL_BUDGET_EXCEEDED', 'ASSET_BYTES_BUDGET_EXCEEDED'].includes(error.code)) throw error;
          startupRecovery?.diagnostics.push({ code: 'ASSET_READ_FAILED', message: error instanceof Error ? error.message : 'An image asset could not be loaded' });
          activeAssetPixels = MAX_PROJECT_ASSET_PIXELS;
          activeAssetBytes = MAX_PROJECT_ASSET_BYTES;
          activeAssetPixelsById = new Map();
          return { assetDataUrls: {}, assetPixelsById: {}, totalAssetPixels: MAX_PROJECT_ASSET_PIXELS, totalAssetBytes: MAX_PROJECT_ASSET_BYTES };
        });
        activeAssetPixels = loadedAssets.totalAssetPixels;
        activeAssetBytes = loadedAssets.totalAssetBytes;
        for (const [assetId, assetPixels] of Object.entries(loadedAssets.assetPixelsById)) activeAssetPixelsById.set(assetId, assetPixels);
        const recovery = startupRecovery ?? { document, snapshotRevision: document.revision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics: [] };
        return { ok: true as const, data: { projectId: activeProjectId, document, history: store.getHistoryState(), durableRevision: document.revision, recovery: { snapshotRevision: recovery.snapshotRevision, replayedCommits: recovery.replayedCommits, ignoredTailBytes: recovery.ignoredTailBytes, diagnostics: recovery.diagnostics }, assetDataUrls: loadedAssets.assetDataUrls } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:newProject', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (isRecord(input) && input.template !== undefined && input.template !== 'floral') return studioError('INVALID_ARGUMENT', 'New project template is invalid');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const projectId = `project_${randomUUID().replaceAll('-', '')}`;
        const documentId = `doc_${randomUUID().replaceAll('-', '')}`;
        const document = seedStudioDocument(documentId, '未命名设计');
        if (isRecord(input) && input.template === 'floral') {
          const bundledAssets = [
            ['demo_flower_hero', 'flower-hero.png'],
            ['demo_flower_tulips', 'flower-tulips.png'],
            ['demo_flower_roses', 'flower-roses.png'],
            ['demo_flower_dahlias', 'flower-dahlias.png']
          ] as const;
          for (const [assetId, fileName] of bundledAssets) {
            const bytes = await readFile(path.join(__dirname, 'assets', 'demo', 'flowers', fileName));
            const asset = await saveDesignAsset(projectRoot, projectId, documentId, assetId, 'image/png', bytes);
            document.assets[assetId] = asset;
          }
        }
        const saved = await saveDesignSnapshot(projectRoot, projectId, document);
        const recovery: RecoveryResult = { document, snapshotRevision: saved.revision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics: [] };
        return { ok: true as const, data: await activateStudioProject(projectId, document, recovery) };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:openProject', async (event, input: unknown) => {
    if (!trustedSender(event) || !window) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    const testPackage = s1PocMode ? process.env.MIAOMA_S1_IMPORT_PACKAGE : undefined;
    const chosen = testPackage ? { canceled: false, filePaths: [path.join(path.resolve(testPackage), 'manifest.json')] } : await dialog.showOpenDialog(window, {
      title: '打开 MyFigma 设计文件或导出包',
      properties: ['openFile'],
      filters: [{ name: 'MyFigma 设计文件', extensions: ['json'] }]
    });
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: true as const, data: { cancelled: true as const } };
    const selectedPath = chosen.filePaths[0];
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const source = path.basename(selectedPath).toLowerCase() === 'manifest.json'
          ? await readPortableProjectExport(path.dirname(selectedPath))
          : await readLocalDesignPackage(selectedPath);
        const projectId = `project_${randomUUID().replaceAll('-', '')}`;
        const importedDocument: DesignDocument = { ...source.document, assets: {} };
        for (const { asset, bytes } of source.assets) {
          const stored = await saveDesignAsset(projectRoot, projectId, source.document.documentId, asset.id, 'image/png', bytes);
          importedDocument.assets[asset.id] = { ...asset, relativePath: stored.relativePath, sha256: stored.sha256, byteSize: stored.byteSize };
        }
        const validation = validateDesignDocument(importedDocument);
        if (!validation.success) throw new StoragePersistenceError('INVALID_DOCUMENT', `Imported project failed validation: ${validation.diagnostics.map((item) => item.message).join('; ')}`);
        const saved = await saveDesignSnapshot(projectRoot, projectId, validation.data);
        const recovery: RecoveryResult = { document: validation.data, snapshotRevision: saved.revision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics: [] };
        return { ok: true as const, data: await activateStudioProject(projectId, validation.data, recovery) };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:execute', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    const request = validateCommandPayload(input);
    if (!request) return studioError('INVALID_ARGUMENT', 'Command request is invalid or exceeds the size limit');
    if (request.commands.some((command) => isRecord(command) && ['add-asset', 'replace-content'].includes(String(command.type)))) return studioError('INVALID_ARGUMENT', 'Assets and generated candidate content must use their dedicated operations');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(request)) return staleProjectContext();
        const { commands } = getStore();
        const prepared = commands.prepare(request);
        const result = await persistPrepared(prepared, request.commandId);
        return { ok: true as const, data: { document: result.document, history: result.history, durableRevision: result.durableRevision } };
      });
    } catch (error) { return errorResponse(error); }
  });

  for (const direction of ['undo', 'redo'] as const) {
    ipcMain.handle(`studio:${direction}`, async (event, input: unknown) => {
      if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
      if (!isRecord(input) || typeof input.projectId !== 'string' || typeof input.documentId !== 'string' || !Number.isSafeInteger(input.baseRevision) || (input.baseRevision as number) < 0) return studioError('INVALID_ARGUMENT', 'Revision or active project identity is invalid');
      if (!isActiveProjectContext(input)) return staleProjectContext();
      try {
        return await withStudioLock(async () => {
          if (!isActiveProjectContext(input)) return staleProjectContext();
          const { commands, store } = getStore();
          const before = store.getSnapshot();
          const prepared = direction === 'undo' ? commands.prepareUndo(input.baseRevision as number) : commands.prepareRedo(input.baseRevision as number);
          const addedAssetIds = Object.keys(prepared.document.assets).filter((assetId) => !before.assets[assetId]);
          const restoredAssets = addedAssetIds.length ? await loadAssetDataUrls(prepared.document, activeProjectId, addedAssetIds) : null;
          const result = await persistPrepared(prepared);
          if (restoredAssets) for (const [assetId, pixels] of Object.entries(restoredAssets.assetPixelsById)) activeAssetPixelsById.set(assetId, pixels);
          return { ok: true as const, data: { document: result.document, history: result.history, durableRevision: result.durableRevision, ...(restoredAssets ? { assetDataUrls: restoredAssets.assetDataUrls } : {}) } };
        });
      } catch (error) { return errorResponse(error); }
    });
  }

  ipcMain.handle('studio:preflightPng', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Number.isSafeInteger(input.baseRevision) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 25 * 1024 * 1024) return studioError('INVALID_ARGUMENT', 'PNG preflight request is invalid or too large');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const { store } = getStore();
        const current = store.getSnapshot();
        if (input.baseRevision !== current.revision) return studioError('REVISION_CONFLICT', `Expected revision ${current.revision}, received ${String(input.baseRevision)}`);
        const dimensions = getPngDimensions(input.bytes as Uint8Array);
        accumulateProjectAssetPixels(activeAssetPixels, dimensions);
        accumulateProjectAssetBytes(activeAssetBytes, (input.bytes as Uint8Array).byteLength);
        return { ok: true as const, data: dimensions };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:save', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const { store } = getStore();
        const saved = await saveDesignSnapshot(projectRoot, activeProjectId, store.getSnapshot());
        lastSnapshotRevision = saved.revision;
        return { ok: true as const, data: { snapshotPath: saved.snapshotPath, revision: saved.revision } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:importPng', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Number.isSafeInteger(input.baseRevision) || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 256 || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 25 * 1024 * 1024) return studioError('INVALID_ARGUMENT', 'PNG import request is invalid or too large');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const { store, commands } = getStore();
        const current = store.getSnapshot();
        if (input.baseRevision !== current.revision) return studioError('REVISION_CONFLICT', `Expected revision ${current.revision}, received ${String(input.baseRevision)}`);
        const dimensions = getPngDimensions(input.bytes as Uint8Array);
        const nextAssetPixels = accumulateProjectAssetPixels(activeAssetPixels, dimensions);
        const nextAssetBytes = accumulateProjectAssetBytes(activeAssetBytes, (input.bytes as Uint8Array).byteLength);
        let decodedImage;
        try { decodedImage = nativeImage.createFromBuffer(Buffer.from(input.bytes as Uint8Array)); }
        catch { throw new StoragePersistenceError('INVALID_PNG', 'PNG image data could not be decoded'); }
        const decodedSize = decodedImage.getSize();
        if (decodedImage.isEmpty() || decodedSize.width !== dimensions.width || decodedSize.height !== dimensions.height) throw new StoragePersistenceError('INVALID_PNG', 'PNG image data could not be decoded');
        const assetId = `asset_${randomUUID().replaceAll('-', '').slice(0, 28)}`;
        const asset = await saveDesignAsset(projectRoot, activeProjectId, current.documentId, assetId, 'image/png', input.bytes as Uint8Array);
        const root = current.pages[0]!.root;
        const nodeId = `image_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
        const cleanName = path.basename(input.name as string).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'Imported image.png';
        const imageNode: DesignNode = {
          id: nodeId, type: 'rectangle', name: cleanName, visible: true, locked: false,
          bounds: { x: 80, y: 660, width: 520, height: 270 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
          style: { fills: [{ type: 'asset', assetId }], strokes: [], effects: [], opacity: 1 }, radius: 12
        };
        const prepared = commands.prepare({ baseRevision: current.revision, commands: [
          { type: 'add-asset', asset },
          { type: 'create', parentId: root.id, node: imageNode }
        ] });
        const result = await persistPrepared(prepared, undefined, 'import');
        activeAssetPixelsById.set(assetId, dimensions.width * dimensions.height);
        activeAssetPixels = nextAssetPixels;
        activeAssetBytes = nextAssetBytes;
        return { ok: true as const, data: { document: result.document, history: result.history, durableRevision: result.durableRevision, asset: { id: assetId, nodeId, dataUrl: `data:image/png;base64,${Buffer.from(input.bytes as Uint8Array).toString('base64')}` } } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:exportPng', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Number.isSafeInteger(input.baseRevision) || typeof input.pageId !== 'string' || !Number.isInteger(input.width) || !Number.isInteger(input.height) || (input.scale !== 1 && input.scale !== 2) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > 32 * 1024 * 1024) return studioError('INVALID_ARGUMENT', 'PNG export request is invalid or too large');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const { store } = getStore();
        const document = store.getSnapshot();
        if (input.baseRevision !== document.revision) return studioError('REVISION_CONFLICT', `Expected revision ${document.revision}, received ${String(input.baseRevision)}`);
        const page = document.pages.find((candidate) => candidate.id === input.pageId);
        if (!page) return studioError('INVALID_ARGUMENT', 'Export page was not found');
        const expectedWidth = Math.ceil(page.root.bounds.width * (input.scale as number));
        const expectedHeight = Math.ceil(page.root.bounds.height * (input.scale as number));
        if (input.width !== expectedWidth || input.height !== expectedHeight || expectedWidth > 4096 || expectedHeight > 4096) return studioError('EXPORT_DIMENSIONS_MISMATCH', 'PNG dimensions must match the selected page and 1×/2× export scale');
        const metadata = { documentId: document.documentId, documentRevision: document.revision, pageId: page.id, nodeIds: collectNodeIds(page), width: input.width as number, height: input.height as number, scale: input.scale as number, mimeType: 'image/png' as const };
        const exportId = `export_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const saved = await writeProjectExport(projectRoot, activeProjectId, exportId, document, input.bytes as Uint8Array, metadata);
        return { ok: true as const, data: { ...saved, width: metadata.width, height: metadata.height } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:prepareReactProject', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0
      || typeof input.pageId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(input.pageId)
      || ![1440, 768, 390].includes(input.viewportWidth as number)) return studioError('INVALID_ARGUMENT', 'React preview request is invalid');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const document = getStore().store.getSnapshot();
        if (document.revision !== input.expectedRevision) return studioError('REVISION_CONFLICT', `Expected revision ${document.revision}, received ${String(input.expectedRevision)}`);
        const page = document.pages.find((candidate) => candidate.id === input.pageId);
        if (!page) return studioError('INVALID_ARGUMENT', 'Preview page was not found in the current revision');
        const generated = await generateCodegenProject(document, activeProjectId, page.id);
        if (!generated.success) return studioError('CODEGEN_VALIDATION_FAILED', generated.diagnostics.slice(0, 8).map((item) => `${item.code}: ${item.message}`).join('; ') || 'The design cannot be exported');
        const preview = buildIsolatedPreview(generated.files);
        const previewToken = randomUUID();
        previewBundles.set(previewToken, preview.files);
        while (previewBundles.size > MAX_ACTIVE_PREVIEW_BUNDLES) {
          const oldestToken = previewBundles.keys().next().value;
          if (oldestToken) previewBundles.delete(oldestToken);
          else break;
        }
        const report = codegenReport(generated);
        if (preview.omittedAssetCount > 0) {
          report.previewWarning = `${preview.omittedAssetCount} large image asset(s) were omitted from the isolated preview to keep IPC payloads bounded; the exported React project includes them.`;
          report.warningCount++;
        }
        return { ok: true as const, data: {
          documentId: document.documentId, revision: document.revision, pageId: page.id,
          viewportWidth: input.viewportWidth as 1440 | 768 | 390,
          previewUrl: `${PREVIEW_SCHEME}://${previewToken}/preview.html`,
          filePaths: generated.files.map((file) => file.path),
          report
        } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:exportReactProject', async (event, input: unknown) => {
    if (!trustedSender(event) || !window) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (!isRecord(input) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || !validExportProjectName(input.projectName)) return studioError('INVALID_ARGUMENT', 'React export request is invalid');
    const projectName = input.projectName.normalize('NFKC');
    if (!validExportProjectName(projectName)) return studioError('INVALID_ARGUMENT', 'Project name contains unsupported filesystem characters');
    const testExportParent = s6PocMode ? path.join(s6PocRoot, 'chosen-output') : null;
    if (testExportParent) await mkdir(testExportParent, { recursive: true });
    const chosen = testExportParent
      ? { canceled: false, filePaths: [testExportParent] }
      : await dialog.showOpenDialog(window, {
          title: '选择 MyFigma React 项目的保存位置',
          defaultPath: path.join(app.getPath('documents'), 'MyFigma'),
          properties: ['openDirectory', 'createDirectory']
        });
    if (!isActiveProjectContext(input)) return staleProjectContext();
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: true as const, data: { cancelled: true as const } };
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const document = getStore().store.getSnapshot();
        if (document.revision !== input.expectedRevision) return studioError('REVISION_CONFLICT', `Expected revision ${document.revision}, received ${String(input.expectedRevision)}`);
        const generated = await generateCodegenProject(document, activeProjectId);
        if (!generated.success) return studioError('CODEGEN_VALIDATION_FAILED', generated.diagnostics.slice(0, 8).map((item) => `${item.code}: ${item.message}`).join('; ') || 'The design cannot be exported');
        const directory = await writeGeneratedProject(chosen.filePaths[0]!, projectName, generated.files);
        return { ok: true as const, data: { directory, fileCount: generated.files.length, revision: document.revision, report: codegenReport(generated) } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:planGeneration', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    const parsed = parseGenerationInput(input);
    if (!parsed) return studioError('INVALID_ARGUMENT', 'Generation request is invalid or outside the single-page scope');
    try {
      const { store } = getStore();
      const document = store.getSnapshot();
      if (parsed.request.baseRevision !== document.revision) return studioError('REVISION_CONFLICT', `Expected revision ${document.revision}, received ${parsed.request.baseRevision}`);
      if (!isWholePageGenerationScope(document, parsed.request)) return studioError('INVALID_ARGUMENT', 'Generation currently accepts the whole page or its root frame only');
      const plan = generationRuns?.plan(parsed.request, document);
      if (!plan) return studioError('GENERATION_UNAVAILABLE', 'The generation service is not ready', true);
      return { ok: true as const, data: plan };
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:startGeneration', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    const parsed = parseGenerationInput(input);
    if (!parsed) return studioError('INVALID_ARGUMENT', 'Generation request is invalid or outside the single-page scope');
    try {
      const { store } = getStore();
      const document = store.getSnapshot();
      if (parsed.request.baseRevision !== document.revision) return studioError('REVISION_CONFLICT', `Expected revision ${document.revision}, received ${parsed.request.baseRevision}`);
      if (!isWholePageGenerationScope(document, parsed.request)) return studioError('INVALID_ARGUMENT', 'S2 generation currently accepts the whole page or its root frame only');
      if (!generationRuns) return studioError('GENERATION_UNAVAILABLE', 'The generation service is not ready', true);
      const plan = generationRuns.plan(parsed.request, document);
      const run = generationRuns.start(parsed.request, document, parsed.projectId);
      while (generationRunContexts.size >= MAX_GENERATION_RUN_CONTEXTS) {
        const oldestRunId = generationRunContexts.keys().next().value;
        if (typeof oldestRunId !== 'string') break;
        generationRunContexts.delete(oldestRunId);
        appliedGenerationRuns.delete(oldestRunId);
      }
      generationRunContexts.set(run.runId, { projectId: parsed.projectId, documentId: parsed.documentId });
      return { ok: true as const, data: { runId: run.runId, plan } };
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:getGenerationRun', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string' || !Number.isSafeInteger(input.afterSeq) || (input.afterSeq as number) < 0) return studioError('INVALID_ARGUMENT', 'Run identity or event cursor is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId || !generationRuns) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      return { ok: true as const, data: generationRuns.get(input.runId, input.afterSeq as number) };
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:listGenerationRuns', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !generationRuns) return staleProjectContext();
    const summaries = generationRunListSchema.safeParse(generationRuns.list(input.projectId as string));
    if (!summaries.success) return studioError('RUN_HISTORY_INVALID', 'Stored generation run summaries are invalid');
    return { ok: true as const, data: summaries.data };
  });

  ipcMain.handle('studio:resumeGenerationRun', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string' || typeof input.expectedAttemptId !== 'string' || !generationRuns) return studioError('INVALID_ARGUMENT', 'Run resume request is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const document = getStore().store.getSnapshot();
        const resumed = await generationRuns!.resume(input.runId as string, input.expectedAttemptId as string, document, input.projectId as string);
        generationRunContexts.set(resumed.runId, { projectId: input.projectId as string, documentId: input.documentId as string });
        const checked = generationRunResumeResultSchema.safeParse({ runId: resumed.runId, attemptId: resumed.attemptId, state: resumed.state });
        if (!checked.success) return studioError('RUN_HISTORY_INVALID', 'Resumed generation run failed protocol validation');
        return { ok: true as const, data: checked.data };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:acceptGenerationWarnings', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || !generationRuns) return studioError('INVALID_ARGUMENT', 'Warning acceptance request is invalid');
    const parsed = generationWarningsAcceptanceRequestSchema.safeParse({
      runId: input.runId,
      expectedAttemptId: input.expectedAttemptId,
      reason: input.reason
    });
    if (!parsed.success) return studioError('INVALID_ARGUMENT', 'A Run, attempt, and 1 to 512 character acceptance reason are required');
    const context = generationRunContexts.get(parsed.data.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const accepted = await generationRuns!.acceptWarnings(parsed.data.runId, parsed.data.expectedAttemptId, input.projectId as string, parsed.data.reason);
        const checked = generationWarningsAcceptanceResultSchema.safeParse({ runId: accepted.runId, attemptId: accepted.attemptId, state: accepted.state });
        if (!checked.success) return studioError('RUN_HISTORY_INVALID', 'Warning acceptance result failed protocol validation');
        return { ok: true as const, data: checked.data };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:getLoopEvidence', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string' || typeof input.evidenceId !== 'string' || !generationRuns) return studioError('INVALID_ARGUMENT', 'Run or evidence identity is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      const snapshot = generationRuns.get(input.runId, 0);
      const known = snapshot.loop?.evidence.find((item) => item.evidenceId === input.evidenceId);
      if (!known) return studioError('EVIDENCE_NOT_FOUND', 'This evidence is not referenced by the selected Run snapshot');
      const inMemory = generationRuns.getEvidence(input.runId, input.evidenceId);
      if (inMemory) return { ok: true as const, data: inMemory };
      const evidence = await readScreenshotEvidence(projectRoot, input.projectId as string, input.runId as string, input.evidenceId as string);
      if (evidence.evidence.imageHash !== known.imageHash || evidence.evidence.attemptId !== known.attemptId || evidence.evidence.candidateRevision !== known.candidateRevision) return studioError('EVIDENCE_MISMATCH', 'Stored screenshot evidence does not match the Run report');
      return { ok: true as const, data: evidence };
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:cancelGeneration', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string') return studioError('INVALID_ARGUMENT', 'Run identity is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId || !generationRuns) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    return { ok: true as const, data: { cancelled: generationRuns.cancel(input.runId) } };
  });

  ipcMain.handle('studio:applyGenerationCandidate', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || typeof input.force !== 'boolean') return studioError('INVALID_ARGUMENT', 'Candidate application request is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId || !generationRuns) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const { store, commands } = getStore();
        const current = store.getSnapshot();
        if (appliedGenerationRuns.has(input.runId as string)) return studioError('CANDIDATE_ALREADY_APPLIED', 'This AI candidate has already been applied');
        if (input.expectedRevision !== current.revision) return { ok: true as const, data: { kind: 'conflict' as const, currentRevision: current.revision } };
        const snapshot = generationRuns!.get(input.runId as string, 0);
        const candidate = snapshot.candidate;
        if (!generationCandidateIsEligible(snapshot)) return studioError('CANDIDATE_NOT_READY', 'The AI candidate has not passed visual review or had its non-blocking warnings accepted');
        if (!candidate) return studioError('CANDIDATE_NOT_READY', 'The AI candidate is not ready to apply');
        if (candidate.runId !== input.runId || candidate.baseRevision !== snapshot.run.baseRevision || candidate.document.documentId !== current.documentId || candidate.document.fileToken !== current.fileToken || candidate.document.revision !== candidate.baseRevision) return studioError('INVALID_CANDIDATE', 'The AI candidate does not match this document or run');
        const validation = validateDesignDocument(candidate.document);
        if (!validation.success) return studioError('INVALID_CANDIDATE', 'The AI candidate failed design document validation');
        if (current.revision !== candidate.baseRevision && input.force !== true) return { ok: true as const, data: { kind: 'conflict' as const, currentRevision: current.revision } };
        if (JSON.stringify(candidate.document.assets) !== JSON.stringify(current.assets)) return studioError('INVALID_CANDIDATE', 'This S2 candidate cannot add, remove, or replace local image assets');
        const prepared = commands.prepare({
          baseRevision: current.revision,
          commandId: `apply_${String(input.runId).replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
          commands: [{ type: 'replace-content', title: candidate.document.title, pages: candidate.document.pages, variables: candidate.document.variables, assets: candidate.document.assets }]
        });
        const result = await persistPrepared(prepared, prepared.transactionId ?? undefined, 'agent', {
          commands: [{ type: 'apply-generation-candidate', runId: input.runId, candidateId: candidate.candidateId }],
          metadata: { kind: 'generation-candidate', baseRevision: candidate.baseRevision }
        });
        appliedGenerationRuns.add(input.runId as string);
        return { ok: true as const, data: { kind: 'applied' as const, mutation: { document: result.document, history: result.history, durableRevision: result.durableRevision } } };
      });
    } catch (error) { return errorResponse(error); }
  });

  ipcMain.handle('studio:copyGenerationCandidate', async (event, input: unknown) => {
    if (!trustedSender(event)) return studioError('INVALID_ARGUMENT', 'Untrusted IPC sender');
    if (!isActiveProjectContext(input) || !isRecord(input) || typeof input.runId !== 'string') return studioError('INVALID_ARGUMENT', 'Candidate copy request is invalid');
    const context = generationRunContexts.get(input.runId);
    if (!context || context.projectId !== input.projectId || context.documentId !== input.documentId || !generationRuns) return studioError('RUN_NOT_FOUND', 'The generation run is not available for this project');
    try {
      return await withStudioLock(async () => {
        if (!isActiveProjectContext(input)) return staleProjectContext();
        const current = getStore().store.getSnapshot();
        const snapshot = generationRuns!.get(input.runId as string, 0);
        const candidate = snapshot.candidate;
        if (!generationCandidateIsEligible(snapshot)) return studioError('CANDIDATE_NOT_READY', 'The AI candidate has not passed visual review or had its non-blocking warnings accepted');
        if (!candidate) return studioError('CANDIDATE_NOT_READY', 'The AI candidate is not ready to copy');
        if (candidate.runId !== input.runId || candidate.baseRevision !== snapshot.run.baseRevision || candidate.document.documentId !== current.documentId || candidate.document.fileToken !== current.fileToken) return studioError('INVALID_CANDIDATE', 'The AI candidate does not match this document or run');
        const validation = validateDesignDocument(candidate.document);
        if (!validation.success) return studioError('INVALID_CANDIDATE', 'The AI candidate failed design document validation');
        const sourceAssets = Object.values(validation.data.assets);
        if (sourceAssets.some((asset) => asset.mimeType !== 'image/png')) return studioError('UNSUPPORTED_ASSET_TYPE', 'The copied AI plan contains a local asset type that cannot be copied by the current desktop editor');
        let variantAssetBytes = 0;
        let variantAssetPixels = 0;
        for (const asset of sourceAssets) {
          const stored = await readDesignAssetMetadata(projectRoot, activeProjectId, current.documentId, asset);
          const dimensions = getPngDimensions(stored.bytes);
          variantAssetBytes = accumulateProjectAssetBytes(variantAssetBytes, stored.bytes.byteLength);
          variantAssetPixels = accumulateProjectAssetPixels(variantAssetPixels, dimensions);
        }

        let projectId: string;
        let reservedProjectDirectory: string | null = null;
        while (true) {
          projectId = `project_${randomUUID().replaceAll('-', '')}`;
          const candidateProjectDirectory = path.join(projectRoot, projectId);
          try {
            await mkdir(candidateProjectDirectory, { recursive: false });
            reservedProjectDirectory = candidateProjectDirectory;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
          }
        }
        const documentId = `doc_${randomUUID().replaceAll('-', '')}`;
        try {
          const variant = structuredClone(validation.data);
          variant.documentId = documentId;
          variant.fileToken = randomBytes(24).toString('base64url');
          variant.revision = 1;
          variant.title = `AI 方案 · ${current.title}`.slice(0, 256);
          variant.assets = {};
          for (const asset of sourceAssets) {
            const stored = await readDesignAssetMetadata(projectRoot, activeProjectId, current.documentId, asset);
            variant.assets[asset.id] = await saveDesignAsset(projectRoot, projectId, documentId, asset.id, 'image/png', stored.bytes);
          }
          const variantValidation = validateDesignDocument(variant);
          if (!variantValidation.success) throw new StoragePersistenceError('INVALID_CANDIDATE', 'The copied AI candidate failed design document validation');
          const saved = await saveDesignSnapshot(projectRoot, projectId, variantValidation.data);
          const recovery: RecoveryResult = { document: variantValidation.data, snapshotRevision: saved.revision, replayedCommits: 0, ignoredTailBytes: 0, diagnostics: [] };
          const activated = await activateStudioProject(projectId, variantValidation.data, recovery);
          reservedProjectDirectory = null;
          return { ok: true as const, data: activated };
        } finally {
          if (reservedProjectDirectory) await rm(reservedProjectDirectory, { recursive: true, force: true });
        }
      });
    } catch (error) { return errorResponse(error); }
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: headlessPoc ? 1100 : 1480,
    height: headlessPoc ? 760 : 960,
    minWidth: headlessPoc ? 760 : 1180,
    minHeight: headlessPoc ? 560 : 720,
    show: !headlessPoc && !s1PocMode && !s2PocMode && !s5PocMode && !s6PocMode,
    backgroundColor: '#f5f6f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const rendererFile = headlessPoc ? 'renderer.html' : 'studio.html';
  const rendererPath = path.join(__dirname, rendererFile);
  const rendererUrl = pathToFileURL(rendererPath).toString();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (target.split('?')[0] !== rendererUrl) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event) => {
    const isStudioDocument = event.isMainFrame && event.url.split('?')[0] === rendererUrl;
    let previewToken = '';
    try {
      const previewUrl = new URL(event.url);
      if (previewUrl.protocol === `${PREVIEW_SCHEME}:` && previewUrl.pathname === '/preview.html' && !previewUrl.search && !previewUrl.hash) previewToken = previewUrl.hostname;
    } catch { /* deny malformed frame URLs */ }
    const isIsolatedPreview = !event.isMainFrame && !!previewToken && previewBundles.has(previewToken)
      && event.frame?.name === 'myfigma-react-preview' && event.frame.parent === window?.webContents.mainFrame;
    if (!isStudioDocument && !isIsolatedPreview) event.preventDefault();
  });
  if (s1PocMode) window.webContents.once('did-finish-load', () => { void runS1PocSuite(); });
  if (s2PocMode) window.webContents.once('did-finish-load', () => { void runS2PocSuite(); });
  if (s5PocMode) window.webContents.once('did-finish-load', () => { void runS5PocSuite(); });
  if (s6PocMode) window.webContents.once('did-finish-load', () => { void runS6PocSuite(); });
  void window.loadFile(rendererPath, { query: { provider: providerName, ...(headlessPoc ? { autopoc: '1' } : {}), ...(s1PocMode ? { s1Poc: '1' } : {}), ...(s1PocMode || s2PocMode || s5PocMode || s6PocMode ? { editorOnly: '1' } : {}) } });
  window.on('closed', () => { window = null; });
}

async function runS1PocSuite(): Promise<void> {
  if (!window || !s1PocMode) return;
  const resultName = s1PocWrite ? 'write-result.json' : s1PocReopen ? 'reopen-result.json' : s1PocProjectReopen ? 'project-reopen-result.json' : 'new-project-reopen-result.json';
  const resultPath = path.join(s1PocRoot, resultName);
  try {
    await mkdir(s1PocRoot, { recursive: true });
    if (s1PocWrite) {
      const firstPass = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (check, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out waiting for the studio UI (revision=' + document.querySelector('#canvas-revision')?.textContent + ', status=' + document.querySelector('#save-status')?.textContent + ', toast=' + document.querySelector('#toast')?.textContent + ')'); };
        const assert = (value, message) => { if (!value) throw new Error(message); };
        const good = result => { if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.code + ': ' + result.error.message : 'Studio API call failed'); return result.data; };
        const readRevision = () => Number((document.querySelector('#canvas-revision')?.textContent || '').match(/revision (\\d+)/)?.[1] || 0);
        await wait(() => readRevision() > 0);
        const initial = good(await window.miaoma.studio.load());
        const projectContext = { projectId: initial.projectId, documentId: initial.document.documentId };
        const flatten = node => [node, ...(node.type === 'frame' ? node.children.flatMap(flatten) : [])];
        const nodes = initial.document.pages.flatMap(page => flatten(page.root));
        const types = [...new Set(nodes.map(node => node.type))].sort();
        assert(['frame', 'rectangle', 'ellipse', 'icon', 'text'].every(type => types.includes(type)), 'Initial document does not include all five node types');
        assert(Object.keys(initial.document.variables).length > 0, 'Initial document has no design tokens');
        const pixelCanvas = document.createElement('canvas'); pixelCanvas.width = 1; pixelCanvas.height = 1;
        const pixelBase64 = pixelCanvas.toDataURL('image/png').split(',')[1];
        const pixelBytes = Uint8Array.from(atob(pixelBase64), character => character.charCodeAt(0));
        const wrongSizeExport = await window.miaoma.studio.exportPng({ ...projectContext, baseRevision: initial.document.revision, pageId: initial.document.pages[0].id, width: 1, height: 1, scale: 1, bytes: pixelBytes });
        assert(!wrongSizeExport.ok && wrongSizeExport.error.code === 'EXPORT_DIMENSIONS_MISMATCH', 'Main accepted a PNG size that does not match the selected page');
        await new Promise(resolve => setTimeout(resolve, 250));
        const titleRow = document.querySelector('[data-node-id="text_hero_title"]');
        assert(titleRow, 'Starter title layer is missing');
        titleRow.click();
        const titleInput = document.querySelector('#property-text');
        assert(titleInput && !document.querySelector('#text-properties').hidden, 'Text inspector did not open for the selected layer');
        const originalText = titleInput.value;
        titleInput.value = 'S1 可编辑画布验证';
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(() => readRevision() === initial.document.revision + 1);
        const afterText = good(await window.miaoma.studio.load());
        assert(afterText.document.pages[0].root.children.find(node => node.id === 'text_hero_title').text === 'S1 可编辑画布验证', 'Text property change was not committed');
        document.querySelector('#undo').click();
        await wait(() => readRevision() === afterText.document.revision + 1);
        const afterUndo = good(await window.miaoma.studio.load());
        assert(afterUndo.document.pages[0].root.children.find(node => node.id === 'text_hero_title').text === originalText, 'Undo did not restore the prior text');
        document.querySelector('#redo').click();
        await wait(() => readRevision() === afterUndo.document.revision + 1);
        const afterRedo = good(await window.miaoma.studio.load());
        const titleNode = afterRedo.document.pages[0].root.children.find(node => node.id === 'text_hero_title');
        const dragCanvas = document.querySelector('#design-canvas');
        const bounds = dragCanvas.getBoundingClientRect();
        const zoom = Number(dragCanvas.dataset.zoom), panX = Number(dragCanvas.dataset.panX), panY = Number(dragCanvas.dataset.panY);
        const start = { x: bounds.left + panX + zoom * (titleNode.bounds.x + titleNode.bounds.width / 2), y: bounds.top + panY + zoom * (titleNode.bounds.y + titleNode.bounds.height / 2) };
        const pointer = (type, point, buttons, pointerId = 41) => dragCanvas.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'mouse', isPrimary: true, clientX: point.x, clientY: point.y, button: 0, buttons, bubbles: true }));
        const historyDepthBeforeDrag = afterRedo.history.undoDepth;
        pointer('pointerdown', start, 1);
        pointer('pointermove', { x: start.x + 18, y: start.y + 11 }, 1);
        pointer('pointerup', { x: start.x + 18, y: start.y + 11 }, 0);
        await wait(() => readRevision() === afterRedo.document.revision + 1);
        const afterDrag = good(await window.miaoma.studio.load());
        const movedTitle = afterDrag.document.pages[0].root.children.find(node => node.id === 'text_hero_title');
        assert(movedTitle.bounds.x > titleNode.bounds.x + 10, 'Canvas pointer drag did not update the selected node position');
        assert(afterDrag.history.undoDepth === historyDepthBeforeDrag + 1, 'One drag did not produce exactly one history entry');
        const resizeStart = { x: bounds.left + panX + zoom * (movedTitle.bounds.x + movedTitle.bounds.width), y: bounds.top + panY + zoom * movedTitle.bounds.y };
        pointer('pointerdown', resizeStart, 1, 42);
        pointer('pointermove', { x: resizeStart.x + 18, y: resizeStart.y - 11 }, 1, 42);
        pointer('pointerup', { x: resizeStart.x + 18, y: resizeStart.y - 11 }, 0, 42);
        await wait(() => readRevision() === afterDrag.document.revision + 1);
        const afterResize = good(await window.miaoma.studio.load());
        const resizedTitle = afterResize.document.pages[0].root.children.find(node => node.id === 'text_hero_title');
        assert(resizedTitle.bounds.width > movedTitle.bounds.width + 10 && resizedTitle.bounds.height > movedTitle.bounds.height + 5, 'Canvas resize handle did not resize the selected node');
        assert(Number(document.querySelector('#property-width').value) === Math.round(resizedTitle.bounds.width), 'Resize did not synchronize the properties panel');
        assert(afterResize.history.undoDepth === afterDrag.history.undoDepth + 1, 'One resize gesture did not produce exactly one history entry');
        document.querySelector('#save').click();
        await wait(() => (document.querySelector('#save-status')?.textContent || '').includes('r' + readRevision()));
        const snapshot = good(await window.miaoma.studio.save(projectContext));
        const beforeImport = good(await window.miaoma.studio.load());
        const imageCanvas = document.createElement('canvas'); imageCanvas.width = 4; imageCanvas.height = 4;
        const imageContext = imageCanvas.getContext('2d'); imageContext.fillStyle = '#DDE7DA'; imageContext.fillRect(0, 0, 4, 4);
        const base64 = imageCanvas.toDataURL('image/png').split(',')[1];
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const crc32 = input => { let crc = 0xffffffff; for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; };
        const rewriteChunkCrc = (png, offset) => { const view = new DataView(png.buffer, png.byteOffset, png.byteLength); const length = view.getUint32(offset); view.setUint32(offset + 8 + length, crc32(png.subarray(offset + 4, offset + 8 + length))); };
        const oversizedPng = bytes.slice(); const oversizedView = new DataView(oversizedPng.buffer); oversizedView.setUint32(16, 8192); oversizedView.setUint32(20, 8192); rewriteChunkCrc(oversizedPng, 8);
        const oversizedCheck = await window.miaoma.studio.preflightPng({ projectId: beforeImport.projectId, documentId: beforeImport.document.documentId, baseRevision: beforeImport.document.revision, bytes: oversizedPng });
        assert(!oversizedCheck.ok && oversizedCheck.error.code === 'INVALID_PNG', 'PNG preflight accepted dimensions above the 4096px decode limit');
        const invalidFormatPng = bytes.slice(); invalidFormatPng[24] = 3; rewriteChunkCrc(invalidFormatPng, 8);
        const bypassAttempt = await window.miaoma.studio.importPng({ projectId: beforeImport.projectId, documentId: beforeImport.document.documentId, baseRevision: beforeImport.document.revision, name: 'invalid-format.png', bytes: invalidFormatPng });
        assert(!bypassAttempt.ok && bypassAttempt.error.code === 'INVALID_PNG', 'Main IPC accepted an undecodable PNG that bypassed the renderer preflight');
        const imageInput = document.querySelector('#image-file');
        const invalidTransfer = new DataTransfer(); invalidTransfer.items.add(new File([new Uint8Array([1, 2, 3])], 'invalid.png', { type: 'image/png' }));
        imageInput.files = invalidTransfer.files; imageInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(() => document.querySelector('#save-status')?.dataset.state === 'error');
        const afterInvalidPng = good(await window.miaoma.studio.load());
        assert(afterInvalidPng.document.revision === beforeImport.document.revision, 'An undecodable PNG changed the durable document before validation');
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 's1-reference.png', { type: 'image/png' }));
        imageInput.files = transfer.files; imageInput.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(() => readRevision() === beforeImport.document.revision + 1, 20000);
        const imported = good(await window.miaoma.studio.load());
        const importedAssetId = Object.keys(imported.document.assets)[0];
        const importedNode = imported.document.pages[0].root.children.find(node => node.style?.fills?.some(fill => fill.type === 'asset' && fill.assetId === importedAssetId));
        assert(importedAssetId && imported.assetDataUrls[importedAssetId] && importedNode, 'Imported asset data, metadata, and layer do not agree');
        document.querySelector('#undo').click();
        await wait(() => readRevision() === imported.document.revision + 1, 20000);
        const afterAssetUndo = good(await window.miaoma.studio.load());
        assert(!afterAssetUndo.document.assets[importedAssetId], 'Undo did not remove the image asset from the document');
        const cacheAfterUndo = window.__miaomaS1Poc.assetCacheState(importedAssetId);
        assert(!cacheAfterUndo.hasDataUrl && !cacheAfterUndo.hasDecodedImage, 'Undo left the removed asset in the renderer image caches');
        document.querySelector('#redo').click();
        await wait(() => readRevision() === afterAssetUndo.document.revision + 1, 20000);
        const afterAssetRedo = good(await window.miaoma.studio.load());
        assert(afterAssetRedo.document.assets[importedAssetId] && afterAssetRedo.assetDataUrls[importedAssetId], 'Redo did not restore the image asset and its bytes');
        const restoredImagePixel = () => {
          const canvas = document.querySelector('#design-canvas');
          const pixelX = Math.floor((window.devicePixelRatio || 1) * (Number(canvas.dataset.panX) + Number(canvas.dataset.zoom) * 340));
          const pixelY = Math.floor((window.devicePixelRatio || 1) * (Number(canvas.dataset.panY) + Number(canvas.dataset.zoom) * 795));
          const pixel = canvas.getContext('2d').getImageData(pixelX, pixelY, 1, 1).data;
          return Math.abs(pixel[0] - 221) <= 4 && Math.abs(pixel[1] - 231) <= 4 && Math.abs(pixel[2] - 218) <= 4;
        };
        await wait(restoredImagePixel, 5000);
        assert(restoredImagePixel(), 'Redo restored the asset metadata but not the rendered image bytes');
        const importedNodeId = importedNode.id;
        assert(imported.document.revision === beforeImport.document.revision + 1, 'Image import should be one document transaction');
        return { projectId: initial.projectId, documentId: imported.document.documentId, initialRevision: initial.document.revision, editedRevision: afterText.document.revision, dragRevision: afterDrag.document.revision, resizedRevision: afterResize.document.revision, resizedBounds: resizedTitle.bounds, savedRevision: snapshot.revision, importedRevision: afterAssetRedo.document.revision, importedAssetId, importedNodeId, nodeTypes: types, undoDepthAfterDrag: afterDrag.history.undoDepth, undoDepthAfterResize: afterResize.history.undoDepth };
      })()`);
      const screenshotPath = path.join(s1PocRoot, 'editor-initial.png');
      const canvasImage = await window.webContents.capturePage();
      await writeFile(screenshotPath, canvasImage.toPNG());
      const exportPass = await new Promise<unknown>((resolve, reject) => {
        const onLoaded = () => {
          window?.webContents.removeListener('did-finish-load', onLoaded);
          void window?.webContents.executeJavaScript(`(async () => {
            const wait = async (check, timeout = 20000, label = 'PNG export') => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('Timed out waiting for ' + label + ' (status=' + document.querySelector('#save-status')?.textContent + ', message=' + document.querySelector('#export-message')?.textContent + ', toast=' + document.querySelector('#toast')?.textContent + ')'); };
            const revision = () => Number((document.querySelector('#canvas-revision')?.textContent || '').match(/revision (\\d+)/)?.[1] || 0);
            await wait(() => revision() > 0);
            document.querySelector('#export-scale').value = '1';
            document.querySelector('#export-png').click();
            await wait(() => (document.querySelector('#export-message')?.textContent || '').includes('export_'), 20000, '1× PNG export');
            const exportPath1x = document.querySelector('#export-message').dataset.exportPath;
            const exportMessage1x = document.querySelector('#export-message').textContent;
            document.querySelector('#export-scale').value = '2';
            document.querySelector('#export-png').click();
            await wait(() => document.querySelector('#export-message').dataset.exportPath && document.querySelector('#export-message').dataset.exportPath !== exportPath1x, 20000, '2× PNG export');
            const exportMessage2x = document.querySelector('#export-message').textContent;
            if (!exportMessage2x.startsWith('2880 × 1800 · ')) throw new Error('2× export dimensions do not match the document size');
            const loaded = await window.miaoma.studio.load();
            if (!loaded.ok) throw new Error(loaded.error.message);
            return { revision: loaded.data.document.revision, exportMessage: exportMessage1x, exportPath: exportPath1x, export2xMessage: exportMessage2x, assetDataLoaded: !!loaded.data.assetDataUrls['${firstPass.importedAssetId}'] };
          })()`).then(resolve, reject);
        };
        window?.webContents.once('did-finish-load', onLoaded);
        window?.webContents.reload();
      });
      const finalResult = { ...firstPass, screenshotPath, export: exportPass };
      await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(JSON.stringify({ s1Poc: 'write-passed', documentId: firstPass.documentId, savedRevision: firstPass.savedRevision, importedRevision: firstPass.importedRevision, screenshotPath }));
    } else if (s1PocReopen) {
      const expected = JSON.parse(await readFile(path.join(s1PocRoot, 'write-result.json'), 'utf8')) as { projectId: string; documentId: string; importedRevision: number; importedAssetId: string; importedNodeId: string; savedRevision: number };
      const reopened = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (check, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out waiting for studio reopen'); };
        await wait(() => /revision \\d+/.test(document.querySelector('#canvas-revision')?.textContent || ''));
        const result = await window.miaoma.studio.load();
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      })()`);
      const reopenedDocument = reopened.document as DesignDocument;
      const imageNode = reopenedDocument.pages[0]!.root.children.find((node) => node.id === expected.importedNodeId);
      if (reopenedDocument.documentId !== expected.documentId || reopenedDocument.revision !== expected.importedRevision) throw new Error('Reopened document identity or revision differs from the durable import commit');
      if (!reopenedDocument.assets[expected.importedAssetId] || !imageNode || imageNode.type !== 'rectangle' || imageNode.style.fills[0]?.type !== 'asset' || imageNode.style.fills[0]?.assetId !== expected.importedAssetId) throw new Error('Reopened image node and asset metadata do not agree');
      if (!reopened.assetDataUrls[expected.importedAssetId]) throw new Error('Imported PNG bytes could not be reloaded from the content-addressed project asset');
      if (reopened.recovery.replayedCommits < 1 || reopened.recovery.snapshotRevision !== expected.savedRevision) throw new Error('The post-snapshot journal commit was not recovered');
      const exported = JSON.parse(await readFile(path.join(s1PocRoot, 'write-result.json'), 'utf8')) as { export?: { exportPath?: string } };
      if (!exported.export?.exportPath) throw new Error('PNG export did not report its portable package directory');
      const importedProject = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (check, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out waiting for the imported project to open'); };
        const current = await window.miaoma.studio.load();
        if (!current.ok) throw new Error(current.error.message);
        document.querySelector('#open-project').click();
        await wait(() => document.body.dataset.projectId && document.body.dataset.projectId !== current.data.projectId);
        const result = await window.miaoma.studio.load();
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      })()`);
      if (importedProject.projectId === expected.projectId || importedProject.document.documentId !== expected.documentId || importedProject.document.revision !== expected.importedRevision || !importedProject.assetDataUrls[expected.importedAssetId]) throw new Error('Portable export did not import as a complete new project');
      const finalResult = { originalProjectId: expected.projectId, importedProjectId: importedProject.projectId, documentId: importedProject.document.documentId, revision: importedProject.document.revision, snapshotRevision: reopened.recovery.snapshotRevision, replayedCommits: reopened.recovery.replayedCommits, importedAssetId: expected.importedAssetId, importedNodeId: expected.importedNodeId, assetDataLoaded: true };
      await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(JSON.stringify({ s1Poc: 'reopen-and-import-passed', revision: finalResult.revision, replayedCommits: finalResult.replayedCommits, importedProjectId: finalResult.importedProjectId, assetDataLoaded: true }));
    } else if (s1PocProjectReopen) {
      const expected = JSON.parse(await readFile(path.join(s1PocRoot, 'reopen-result.json'), 'utf8')) as { importedProjectId: string; documentId: string; revision: number; importedAssetId: string };
      const result = await window.webContents.executeJavaScript(`(async () => {
        const loaded = await window.miaoma.studio.load();
        if (!loaded.ok) throw new Error(loaded.error.message);
        return loaded.data;
      })()`);
      if (result.projectId !== expected.importedProjectId || result.document.documentId !== expected.documentId || result.document.revision !== expected.revision || !result.assetDataUrls[expected.importedAssetId]) throw new Error('Imported project did not reopen with its document and asset');
      const newProject = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (check, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timed out waiting for the new project'); };
        const previous = await window.miaoma.studio.load();
        if (!previous.ok) throw new Error(previous.error.message);
        document.querySelector('#new-project').click();
        await wait(() => document.body.dataset.projectId && document.body.dataset.projectId !== previous.data.projectId);
        const createdResult = await window.miaoma.studio.load();
        if (!createdResult.ok) throw new Error(createdResult.error.message);
        const created = createdResult.data;
        const flatten = node => [node, ...(node.type === 'frame' ? node.children.flatMap(flatten) : [])];
        const nodes = created.document.pages.flatMap(page => flatten(page.root));
        if (!['frame', 'rectangle', 'ellipse', 'icon', 'text'].every(type => nodes.some(node => node.type === type))) throw new Error('New project omitted one of the five supported node types');
        const staleContext = { projectId: previous.data.projectId, documentId: previous.data.document.documentId };
        const pixelCanvas = document.createElement('canvas'); pixelCanvas.width = 1; pixelCanvas.height = 1;
        const bytes = Uint8Array.from(atob(pixelCanvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
        const staleResponses = await Promise.all([
          window.miaoma.studio.newProject(staleContext),
          window.miaoma.studio.openProject(staleContext),
          window.miaoma.studio.execute({ ...staleContext, baseRevision: previous.data.document.revision, commands: [{ type: 'rename-document', title: 'STALE WRITE' }] }),
          window.miaoma.studio.undo({ ...staleContext, baseRevision: previous.data.document.revision }),
          window.miaoma.studio.redo({ ...staleContext, baseRevision: previous.data.document.revision }),
          window.miaoma.studio.save(staleContext),
          window.miaoma.studio.importPng({ ...staleContext, baseRevision: previous.data.document.revision, name: 'stale.png', bytes }),
          window.miaoma.studio.exportPng({ ...staleContext, baseRevision: previous.data.document.revision, pageId: previous.data.document.pages[0].id, width: 1, height: 1, scale: 1, bytes })
        ]);
        if (!staleResponses.every(response => response.ok === false && response.error.code === 'PROJECT_CONTEXT_CHANGED')) throw new Error('A write or project action accepted a stale project identity');
        const stillActive = await window.miaoma.studio.load();
        if (!stillActive.ok || stillActive.data.projectId !== created.projectId || stillActive.data.document.documentId !== created.document.documentId || stillActive.data.document.title === 'STALE WRITE') throw new Error('A stale request changed the new active project');
        return { previousProjectId: previous.data.projectId, previousDocumentId: previous.data.document.documentId, projectId: created.projectId, documentId: created.document.documentId, revision: created.document.revision, tokenCount: Object.keys(created.document.variables).length, staleWritesRejected: staleResponses.length };
      })()`);
      const finalResult = { importedProjectId: expected.importedProjectId, reopenedImportedDocument: expected.documentId, newProjectId: newProject.projectId, newDocumentId: newProject.documentId, newRevision: newProject.revision, staleWritesRejected: newProject.staleWritesRejected };
      await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(JSON.stringify({ s1Poc: 'project-reopen-passed', newProjectId: newProject.projectId, newRevision: newProject.revision }));
    } else if (s1PocNewProjectReopen) {
      const expected = JSON.parse(await readFile(path.join(s1PocRoot, 'project-reopen-result.json'), 'utf8')) as { newProjectId: string; newDocumentId: string; newRevision: number };
      const result = await window.webContents.executeJavaScript(`(async () => {
        const loaded = await window.miaoma.studio.load();
        if (!loaded.ok) throw new Error(loaded.error.message);
        return loaded.data;
      })()`);
      if (result.projectId !== expected.newProjectId || result.document.documentId !== expected.newDocumentId || result.document.revision !== expected.newRevision || Object.keys(result.document.variables).length === 0) throw new Error('New project did not reopen with its saved design and tokens');
      const types = new Set(result.document.pages.flatMap((page: { root: DesignNode }) => {
        const flatten = (node: DesignNode): DesignNode[] => [node, ...(node.type === 'frame' ? node.children.flatMap(flatten) : [])];
        return flatten(page.root).map((node) => node.type);
      }));
      if (!['frame', 'rectangle', 'ellipse', 'icon', 'text'].every((type) => types.has(type))) throw new Error('Reopened new project omitted one of the five node types');
      const finalResult = { projectId: result.projectId, documentId: result.document.documentId, revision: result.document.revision, tokenCount: Object.keys(result.document.variables).length };
      await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(JSON.stringify({ s1Poc: 'new-project-reopen-passed', projectId: finalResult.projectId, revision: finalResult.revision }));
    }
    app.quit();
  } catch (error) {
    const failure = { s1Poc: 'failed', error: error instanceof Error ? error.message : 'Unknown S1 POC failure' };
    await mkdir(s1PocRoot, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify(failure));
    app.exit(1);
  }
}

async function runS2PocSuite(): Promise<void> {
  if (!window || !s2PocMode) return;
  const resultPath = path.join(s2PocRoot, 's2-result.json');
  try {
    await mkdir(s2PocRoot, { recursive: true });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async (check, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('Timed out waiting for the S2 generation run'); };
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const good = result => { if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.code + ': ' + result.error.message : 'Studio API call failed'); return result.data; };
      const studio = window.miaoma.studio;
      const initial = good(await studio.load());
      const context = { projectId: initial.projectId, documentId: initial.document.documentId };
      const pixelCanvas = document.createElement('canvas'); pixelCanvas.width = 1; pixelCanvas.height = 1;
      const pixelBytes = Uint8Array.from(atob(pixelCanvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
      const imported = good(await studio.importPng({ ...context, baseRevision: initial.document.revision, name: 'candidate-copy.png', bytes: pixelBytes }));
      const baseDocument = imported.document;
      const page = baseDocument.pages[0];
      const request = { documentId: baseDocument.documentId, title: 'S2 单页生成验收', prompt: '为 MyFigma 设计工作台生成一页清新、可编辑的品牌首页，包含导航、主视觉、功能介绍和页脚。', pageId: page.id, targetNodeIds: [], baseRevision: baseDocument.revision, viewport: { width: page.root.bounds.width, height: page.root.bounds.height }, referenceAssetIds: [], providerRef: 'local-fake', constraints: [], maxParallel: 1 };
      const plan = good(await studio.planGeneration({ ...context, request }));
      assert(plan.regions.length >= 3 && plan.acceptanceCriteria.length > 0, 'Planner did not return a useful single-page plan');
      const observedEvents = [];
      const unsubscribe = studio.subscribeGeneration(event => observedEvents.push(event));
      const started = good(await studio.startGeneration({ ...context, request }));
      const duplicateRun = await studio.startGeneration({ ...context, request });
      assert(!duplicateRun.ok && duplicateRun.error.code === 'RUN_ALREADY_ACTIVE', 'Main accepted more than one active single-executor Run');
      let snapshot;
      await wait(async () => {
        snapshot = good(await studio.getGenerationRun({ ...context, runId: started.runId, afterSeq: 0 }));
        if (snapshot.run.state === 'failed') throw new Error(snapshot.run.error?.message || 'Generation failed');
        return snapshot.run.state === 'completed' && !!snapshot.candidate;
      });
      unsubscribe();
      const candidate = snapshot.candidate;
      assert(candidate.document.revision === baseDocument.revision, 'Candidate changed the live document revision');
      assert(Object.keys(candidate.document.variables).length > 0, 'Candidate has no design tokens');
      const seqs = snapshot.events.map(event => event.seq);
      assert(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]), 'Run event sequence is not strictly increasing');
      assert(snapshot.events.some(event => event.type === 'candidateReady'), 'Run did not report candidateReady');
      assert(observedEvents.some(event => event.type === 'stateChanged' && event.payload.to === 'completed'), 'Live state events did not expose their destination state');

      const titleNode = page.root.children.find(node => node.id === 'text_hero_title' && node.type === 'text');
      assert(titleNode, 'Starter document is missing its editable hero title');
      const manualText = 'S2 人工修改应受保护';
      const manual = good(await studio.execute({ ...context, baseRevision: baseDocument.revision, commands: [{ type: 'update', nodeId: titleNode.id, patch: { text: manualText } }] }));
      const conflict = good(await studio.applyGenerationCandidate({ ...context, runId: started.runId, expectedRevision: manual.document.revision, force: false }));
      assert(conflict.kind === 'conflict' && conflict.currentRevision === manual.document.revision, 'Manual edit did not produce an explicit candidate conflict');
      const retained = good(await studio.load());
      assert(retained.document.pages[0].root.children.find(node => node.id === titleNode.id).text === manualText, 'The conflict path overwrote manual content');

      const bypass = await studio.execute({ ...context, baseRevision: manual.document.revision, commands: [{ type: 'replace-content', title: candidate.document.title, pages: candidate.document.pages, variables: candidate.document.variables, assets: candidate.document.assets }] });
      assert(!bypass.ok, 'Renderer command IPC bypassed the candidate acceptance boundary');
      const applied = good(await studio.applyGenerationCandidate({ ...context, runId: started.runId, expectedRevision: manual.document.revision, force: true }));
      assert(applied.kind === 'applied' && applied.mutation.document.revision === manual.document.revision + 1, 'Explicit candidate apply did not create one revision');
      assert(applied.mutation.history.undoDepth > manual.history.undoDepth, 'AI candidate was not recorded as one undoable transaction');
      const undone = good(await studio.undo({ ...context, baseRevision: applied.mutation.document.revision }));
      assert(undone.document.pages[0].root.children.find(node => node.id === titleNode.id).text === manualText, 'Undo did not restore the pre-apply manual design');
      const locked = good(await studio.execute({ ...context, baseRevision: undone.document.revision, commands: [{ type: 'update', nodeId: titleNode.id, patch: { locked: true } }] }));
      const lockedRequest = { ...request, baseRevision: locked.document.revision };
      const lockedRun = good(await studio.startGeneration({ ...context, request: lockedRequest }));
      let lockedSnapshot;
      await wait(async () => {
        lockedSnapshot = good(await studio.getGenerationRun({ ...context, runId: lockedRun.runId, afterSeq: 0 }));
        if (lockedSnapshot.run.state === 'failed') throw new Error(lockedSnapshot.run.error?.message || 'Locked-node candidate generation failed');
        return lockedSnapshot.run.state === 'completed' && !!lockedSnapshot.candidate;
      });
      const lockedApply = await studio.applyGenerationCandidate({ ...context, runId: lockedRun.runId, expectedRevision: locked.document.revision, force: false });
      assert(!lockedApply.ok && lockedApply.error.code === 'NODE_LOCKED', 'Candidate replacement bypassed a locked node');
      const afterLockedApply = good(await studio.load());
      assert(afterLockedApply.document.pages[0].root.children.find(node => node.id === titleNode.id).locked === true, 'Rejected candidate changed the locked node');
      const variant = good(await studio.copyGenerationCandidate({ ...context, runId: started.runId }));
      assert(variant.projectId !== context.projectId && variant.document.documentId !== context.documentId, 'Copying an AI candidate must create a distinct project and document identity');
      assert(variant.document.revision === 1 && variant.document.title.startsWith('AI 方案 · '), 'Copied AI plan did not start as a separate named document');
      const sourceAssetId = Object.keys(baseDocument.assets)[0];
      assert(sourceAssetId && variant.document.assets[sourceAssetId] && variant.assetDataUrls[sourceAssetId], 'Copied AI plan did not preserve and load its source image asset');
      const countNodes = node => 1 + (node.type === 'frame' ? node.children.reduce((sum, child) => sum + countNodes(child), 0) : 0);
      return { projectId: context.projectId, documentId: context.documentId, originalRevision: afterLockedApply.document.revision, variantProjectId: variant.projectId, variantDocumentId: variant.document.documentId, runId: started.runId, baseRevision: baseDocument.revision, planRegions: plan.regions.length, eventCount: snapshot.events.length, observedEventCount: observedEvents.length, candidateNodeCount: candidate.document.pages.reduce((count, item) => count + countNodes(item.root), 0), manualRevision: manual.document.revision, appliedRevision: applied.mutation.document.revision, undoRevision: undone.document.revision, explicitConflict: conflict.kind, bypassRejected: !bypass.ok, duplicateRunRejected: !duplicateRun.ok, lockedCandidateRejected: !lockedApply.ok, copiedAssetId: sourceAssetId };
    })()`);
    const originalAfterBranch = await loadRecoverableDesignDocument(projectRoot, result.projectId, result.documentId);
    if (originalAfterBranch.document.revision !== result.originalRevision || originalAfterBranch.document.pages[0]!.root.children.find((node) => node.id === 'text_hero_title')?.locked !== true) throw new Error('Copying the AI candidate changed the original conflicted project');
    const copiedVariant = await loadRecoverableDesignDocument(projectRoot, result.variantProjectId, result.variantDocumentId);
    if (copiedVariant.document.revision !== 1 || !copiedVariant.document.title.startsWith('AI 方案 · ')) throw new Error('Copied AI candidate could not be recovered as a separate project');
    const journalPath = path.join(app.getPath('userData'), 'projects', result.projectId, 'journal', `${result.documentId}.jsonl`);
    const journalLines = (await readFile(journalPath, 'utf8')).trimEnd().split('\n');
    const journalRecords = journalLines.map((line) => JSON.parse(line) as { origin?: string; commandId?: string; commands?: unknown[]; metadata?: { kind?: string; baseRevision?: number } });
    const candidateCommit = journalRecords.find((record) => record.origin === 'agent' && record.metadata?.kind === 'generation-candidate');
    if (!candidateCommit || candidateCommit.commands?.length !== 1 || !candidateCommit.commands[0] || typeof candidateCommit.commands[0] !== 'object' || (candidateCommit.commands[0] as { type?: unknown }).type !== 'apply-generation-candidate') throw new Error('AI candidate journal record contains no compact generation operation');
    result.journalCommandBytes = Buffer.byteLength(JSON.stringify(candidateCommit.commands), 'utf8');
    if (result.journalCommandBytes > 1024) throw new Error('AI candidate journal command unexpectedly contains the full replacement payload');
    await writeFile(resultPath, `${JSON.stringify({ s2Poc: 'passed', ...result }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ s2Poc: 'passed', runId: result.runId, planRegions: result.planRegions, eventCount: result.eventCount, appliedRevision: result.appliedRevision }));
  } catch (error) {
    const failure = { s2Poc: 'failed', error: error instanceof Error ? error.message : 'Unknown S2 POC failure' };
    await mkdir(s2PocRoot, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify(failure));
    app.exit(1);
    return;
  }
  app.quit();
}

async function runS5PocSuite(): Promise<void> {
  if (!window || !s5PocMode) return;
  const readyPath = path.join(s5PocRoot, 'ready.json');
  const clientResultPath = path.join(s5PocRoot, 'client-result.json');
  const resultPath = path.join(s5PocRoot, 's5-result.json');
  try {
    await mkdir(s5PocRoot, { recursive: true });
    const ready = await window.webContents.executeJavaScript(`(async () => {
      const good = result => { if (!result || result.ok !== true) throw new Error(result && result.error ? result.error.code + ': ' + result.error.message : 'Studio API call failed'); return result.data; };
      const studio = window.miaoma.studio;
      const loaded = good(await studio.load());
      const context = { projectId: loaded.projectId, documentId: loaded.document.documentId };
      const flatten = node => [node, ...(node.type === 'frame' ? node.children.flatMap(flatten) : [])];
      const nodes = loaded.document.pages.flatMap(page => flatten(page.root));
      const editable = nodes.find(node => node.type === 'text');
      if (!editable) throw new Error('The generated project has no editable text node');
      const assetId = Object.keys(loaded.document.assets)[0];
      if (!assetId) throw new Error('The generated project has no portable image asset');
      const updatedText = 'S5 外部还原验证：' + editable.text;
      const mutation = good(await studio.execute({ ...context, baseRevision: loaded.document.revision, commands: [{ type: 'update', nodeId: editable.id, patch: { text: updatedText } }] }));
      const saved = good(await studio.save(context));
      const selected = good(await studio.setMcpSelection({ ...context, nodeIds: [editable.id] }));
      const configured = good(await studio.configureMcp({ ...context, clientName: 'cursor' }));
      const status = good(await studio.getMcpStatus(context));
      const parsedConfig = JSON.parse(configured.config);
      const server = parsedConfig.mcpServers && parsedConfig.mcpServers.miaoma;
      if (!server || !Array.isArray(server.args) || server.args.length !== 3) throw new Error('MCP client configuration is incomplete');
      if (!status.endpointReady || status.grant?.documentId !== context.documentId) throw new Error('MCP consent grant was not activated for the active document');
      return {
        projectId: context.projectId,
        documentId: mutation.document.documentId,
        revision: mutation.document.revision,
        pageId: mutation.document.pages[0].id,
        selectedNodeId: editable.id,
        expectedText: updatedText,
        assetId,
        assetSha256: mutation.document.assets[assetId].sha256,
        savedRevision: saved.revision,
        selectionIds: selected.selectionIds,
        endpointPath: server.args[server.args.length - 1],
        sidecarEntry: server.args[0]
      };
    })()`);
    await writeFile(readyPath, `${JSON.stringify(ready, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ s5Poc: 'awaiting-external-client', documentId: ready.documentId, revision: ready.revision }));

    const deadline = Date.now() + 90_000;
    let clientResult: { s5ExternalClient?: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      try {
        clientResult = JSON.parse(await readFile(clientResultPath, 'utf8')) as { s5ExternalClient?: string; error?: string };
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (!clientResult || clientResult.s5ExternalClient !== 'passed') throw new Error(clientResult?.error ?? 'Timed out waiting for the external MCP client');
    const finalResult = {
      s5Poc: 'passed',
      projectId: ready.projectId,
      documentId: ready.documentId,
      revision: ready.revision,
      savedRevision: ready.savedRevision,
      generatedAndEditedProjectOpened: true,
      externalReadTools: ['get_app_state', 'get_selected_node', 'get_nodes', 'get_screenshot', 'get_assets'],
      externalClient: clientResult.s5ExternalClient
    };
    await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ s5Poc: 'passed', documentId: finalResult.documentId, revision: finalResult.revision, externalClient: finalResult.externalClient }));
    app.quit();
  } catch (error) {
    const failure = { s5Poc: 'failed', error: error instanceof Error ? error.message : 'Unknown S5 POC failure' };
    await mkdir(s5PocRoot, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify(failure));
    await mcpBridge?.stop().catch(() => undefined);
    app.exit(1);
  }
}

async function runS6PocSuite(): Promise<void> {
  if (!window || !s6PocMode) return;
  const resultPath = path.join(s6PocRoot, 's6-result.json');
  try {
    await mkdir(s6PocRoot, { recursive: true });
    let result: Record<string, unknown>;
    try { result = await window.webContents.executeJavaScript(`(async () => {
      const wait = async (check, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('Timed out waiting for the S6 Studio UI'); };
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const good = response => { if (!response || response.ok !== true) throw new Error(response && response.error ? response.error.code + ': ' + response.error.message : 'Studio API call failed'); return response.data; };
      const studio = window.miaoma.studio;
      await wait(() => /revision \\d+/.test(document.querySelector('#canvas-revision')?.textContent || ''));
      assert(document.querySelector('.brand-name')?.textContent?.includes('MyFigma'), 'The desktop brand label was not renamed to MyFigma');
      const initial = good(await studio.load());
      const context = { projectId: initial.projectId, documentId: initial.document.documentId };
      const page = initial.document.pages[0];
      const flatten = node => [node, ...(node.type === 'frame' ? node.children.flatMap(flatten) : [])];
      const target = initial.document.pages.flatMap(item => flatten(item.root)).find(node => node.type === 'text' && node.id !== page.root.id);
      assert(page && target, 'The starter document is missing a page or a text node');
      const interaction = { trigger: 'click', action: 'submitMock', successMessage: 'MyFigma S6 mock submit' };
      const invalidTarget = await studio.execute({ ...context, baseRevision: initial.document.revision, commands: [{ type: 'update', nodeId: target.id, patch: { interaction: { trigger: 'click', action: 'toggle', targetNodeId: 's6_missing_target' } } }] });
      assert(!invalidTarget.ok && invalidTarget.error.code === 'INVALID_DOCUMENT', 'The editor accepted an interaction bound to a missing node');
      const waitForRevision = async (revision, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { const current = good(await studio.load()); if (current.document.revision >= revision) return current; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('Timed out waiting for prototype interaction revision ' + revision); };
      const targetLayer = Array.from(document.querySelectorAll('.layer-row')).find(row => row.dataset.nodeId === target.id);
      assert(targetLayer, 'The selected prototype target is missing from the layer panel');
      targetLayer.click();
      const actionSelect = document.querySelector('#prototype-action');
      actionSelect.value = 'submitMock';
      actionSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await waitForRevision(initial.document.revision + 1);
      const messageInput = document.querySelector('#prototype-message');
      messageInput.value = interaction.successMessage;
      messageInput.dispatchEvent(new Event('change', { bubbles: true }));
      const bound = await waitForRevision(initial.document.revision + 2);
      const prepared = good(await studio.prepareReactProject({ ...context, expectedRevision: bound.document.revision, pageId: page.id, viewportWidth: 1440 }));
      assert(prepared.documentId === context.documentId && prepared.revision === bound.document.revision && prepared.pageId === page.id, 'React preview was not bound to the requested document revision');
      assert(prepared.previewUrl.startsWith('myfigma-preview://') && prepared.previewUrl.endsWith('/preview.html') && prepared.filePaths.includes('preview.css') && prepared.filePaths.includes('preview.js'), 'React preview did not receive a private local preview URL and its runtime files');
      assert(prepared.report.validation.status === 'passed' && prepared.report.viewportReport.checks.length === 3, 'Codegen report omitted schema or three-viewport checks');
      assert(prepared.report.interactionReport.bindingCount >= 1 && prepared.report.manifest.revision === bound.document.revision, 'The manifest or interaction report lost the bound revision/action');
      const previewFrameElement = document.querySelector('#react-preview-frame');
      assert(previewFrameElement?.getAttribute('sandbox') === 'allow-scripts', 'The preview iframe sandbox must not enable same-origin access');
      let previewLoaded = false;
      previewFrameElement.addEventListener('load', () => { if (previewFrameElement.src.startsWith('myfigma-preview://')) previewLoaded = true; });
      document.querySelector('#open-react-preview').click();
      await wait(() => document.querySelector('#react-preview-dialog')?.open && previewLoaded, 20000).catch(() => {
        const frame = document.querySelector('#react-preview-frame');
        throw new Error('Preview frame did not load: ' + JSON.stringify({ dialogOpen: document.querySelector('#react-preview-dialog')?.open, previewLoaded, previewUrl: frame?.src, status: document.querySelector('#react-preview-status')?.textContent, panelError: document.querySelector('#react-panel-error')?.textContent, frameReady: document.querySelector('#react-preview-surface')?.getAttribute('data-ready') }));
      });
      const stale = await studio.prepareReactProject({ ...context, expectedRevision: initial.document.revision, pageId: page.id, viewportWidth: 768 });
      assert(!stale.ok && stale.error.code === 'REVISION_CONFLICT', 'React preview accepted a stale document revision');
      const cleared = good(await studio.execute({ ...context, baseRevision: bound.document.revision, commands: [{ type: 'update', nodeId: target.id, patch: { interaction: null } }] }));
      const clearedNode = flatten(cleared.document.pages[0].root).find(node => node.id === target.id);
      assert(!Object.hasOwn(clearedNode, 'interaction'), 'Clearing a prototype binding did not omit the optional interaction field');
      const exported = good(await studio.exportReactProject({ ...context, expectedRevision: cleared.document.revision, projectName: 'MyFigma-S6-Poc' }));
      assert(exported.revision === cleared.document.revision && exported.fileCount >= 12, 'React project export did not report the pinned revision and expected files');
      const collision = await studio.exportReactProject({ ...context, expectedRevision: cleared.document.revision, projectName: 'MyFigma-S6-Poc' });
      assert(!collision.ok && collision.error.code === 'EXPORT_PATH_EXISTS', 'React export overwrote a previously generated project directory');
      const invalidName = await studio.exportReactProject({ ...context, expectedRevision: cleared.document.revision, projectName: '..' });
      assert(!invalidName.ok && invalidName.error.code === 'INVALID_ARGUMENT', 'React export accepted an unsafe project name');
      return { projectId: context.projectId, documentId: context.documentId, targetNodeId: target.id, initialRevision: initial.document.revision, interactionRevision: bound.document.revision, clearedRevision: cleared.document.revision, previewWidth: prepared.viewportWidth, viewportChecks: prepared.report.viewportReport.checks.length, interactionBindings: prepared.report.interactionReport.bindingCount, isolatedPreviewLoaded: previewLoaded, previewUrl: previewFrameElement.src, generatedDirectory: exported.directory, generatedFileCount: exported.fileCount, staleRevisionRejected: !stale.ok, exportCollisionRejected: !collision.ok, unsafeNameRejected: !invalidName.ok };
    })().catch(error => ({ __s6Failure: error && (error.stack || error.message) ? String(error.stack || error.message) : String(error) }))`); }
    catch (error) {
      const details = await window.webContents.executeJavaScript(`JSON.stringify({ readyState: document.readyState, previewDialog: document.querySelector('#react-preview-dialog')?.open, previewSrc: document.querySelector('#react-preview-frame')?.src, previewStatus: document.querySelector('#react-preview-status')?.textContent, previewError: document.querySelector('#react-panel-error')?.textContent })`).catch(() => 'renderer no longer available');
      throw new Error(`Renderer script rejected: ${error instanceof Error ? error.message : String(error)}; state=${details}`);
    }
    if (result && typeof result === 'object' && '__s6Failure' in result) throw new Error(String((result as { __s6Failure: unknown }).__s6Failure));
    const generatedDirectory = path.resolve(result.generatedDirectory as string);
    const exportParent = path.resolve(s6PocRoot, 'chosen-output');
    if (path.dirname(generatedDirectory) !== exportParent || path.basename(generatedDirectory) !== 'MyFigma-S6-Poc') throw new Error('React export escaped its selected test output directory');
    const expectedPreviewUrl = String(result.previewUrl);
    const isolatedPreviewFrame = window?.webContents.mainFrame.framesInSubtree.find((frame) => frame.name === 'myfigma-react-preview' && frame.url === expectedPreviewUrl);
    if (!isolatedPreviewFrame || isolatedPreviewFrame.parent !== window?.webContents.mainFrame || isolatedPreviewFrame.origin !== 'null') throw new Error('The named sandboxed preview iframe was not allowed to load as an isolated opaque-origin local preview frame');
    const mockActionResult = await isolatedPreviewFrame.executeJavaScript(`(() => {
      const trigger = Array.from(document.querySelectorAll('[data-node-id][data-action="submitMock"]')).find(node => node.dataset.nodeId === ${JSON.stringify(result.targetNodeId)});
      if (!trigger) return null;
      trigger.click();
      return { text: trigger.querySelector('[data-submit-for]')?.textContent ?? null, action: trigger.dataset.action, successMessage: trigger.dataset.successMessage, readyState: document.readyState, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '' };
    })()`);
    if ((mockActionResult as { text?: string; csp?: string } | null)?.text !== 'MyFigma S6 mock submit') throw new Error(`The isolated preview returned an unexpected mock interaction result: ${JSON.stringify(mockActionResult)}`);
    if (!(mockActionResult as { csp?: string }).csp?.includes("script-src 'self'") || !(mockActionResult as { csp?: string }).csp?.includes("default-src 'none'")) throw new Error('The isolated preview document did not apply its restrictive resource policy');
    const manifest = JSON.parse(await readFile(path.join(generatedDirectory, 'public', 'design-manifest.json'), 'utf8')) as { documentId?: string; revision?: number; interactionReport?: { bindings?: unknown[] } };
    if (manifest.documentId !== result.documentId || manifest.revision !== result.clearedRevision || !Array.isArray(manifest.interactionReport?.bindings)) throw new Error('Exported manifest does not match the expected source revision');
    const generatedApp = await readFile(path.join(generatedDirectory, 'src', 'App.tsx'), 'utf8');
    if (!generatedApp.includes('submitMock') || !generatedApp.includes('navigate') || !generatedApp.includes('openModal') || !generatedApp.includes('toggle')) throw new Error('Generated React runtime is missing a supported mock interaction action');
    const finalResult = { s6Poc: 'passed', ...result, isolatedPreviewFrameName: isolatedPreviewFrame.name, previewFrameOrigin: isolatedPreviewFrame.origin, previewMockActionExecuted: true, manifestMatchedRevision: manifest.revision, generatedRuntimeActions: ['navigate', 'openModal', 'toggle', 'submitMock'] } as unknown as Record<string, unknown> & { clearedRevision: number; generatedFileCount: number; viewportChecks: number };
    await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({ s6Poc: 'passed', revision: finalResult.clearedRevision, files: finalResult.generatedFileCount, viewportChecks: finalResult.viewportChecks }));
    app.quit();
  } catch (error) {
    const failure = { s6Poc: 'failed', error: error instanceof Error ? (error.stack ?? error.message) : 'Unknown S6 POC failure' };
    await mkdir(s6PocRoot, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
    console.error(JSON.stringify(failure));
    app.exit(1);
  }
}

async function initializeStudio(): Promise<void> {
  projectRoot = path.join(app.getPath('userData'), 'projects');
  await mkdir(projectRoot, { recursive: true });
  const pointer = await readActiveProjectPointer();
  activeProjectId = pointer?.projectId ?? DEFAULT_PROJECT_ID;
  activeDocumentId = pointer?.documentId ?? DEFAULT_DOCUMENT_ID;
  let recovery: RecoveryResult;
  try {
    recovery = await loadRecoverableDesignDocument(projectRoot, activeProjectId, activeDocumentId);
  } catch (error) {
    if (!(error instanceof StoragePersistenceError) || error.code !== 'SNAPSHOT_NOT_FOUND') throw error;
    const initial = seedStudioDocument(activeDocumentId, activeProjectId === DEFAULT_PROJECT_ID ? 'MyFigma · 设计工作台' : '未命名设计');
    await saveDesignSnapshot(projectRoot, activeProjectId, initial);
    recovery = await loadRecoverableDesignDocument(projectRoot, activeProjectId, initial.documentId);
    await writeActiveProjectPointer(activeProjectId, initial.documentId);
  }
  documentStore = new DocumentStore(recovery.document);
  commandService = new CommandService(documentStore);
  activeDocumentId = recovery.document.documentId;
  startupRecovery = recovery;
  lastSnapshotRevision = recovery.snapshotRevision;
  await restoreGenerationRuns(activeProjectId, recovery.document);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (headlessPoc || s1PocMode || s2PocMode || s5PocMode || s6PocMode) return;
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else if (app.isReady() && studioStartupComplete) createWindow();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await protocol.handle(PREVIEW_SCHEME, servePreviewFile);
  visionProviderSettings = new VisionProviderSettingsStore(app.getPath('userData'), safeStorage);
  try {
    await visionProviderSettings.initialize();
    cloudVisualConsentActive = visionProviderSettings.getView().provider === 'deepseek';
  }
  catch {
    visionProviderSettings = null;
    cloudVisualConsentActive = false;
    console.error('Secure vision model settings could not be loaded; visual reviews will use local rules.');
  }
  const outputRoot = headlessPoc ? path.resolve(process.cwd(), 'artifacts/s0-poc') : path.join(app.getPath('userData'), 's0-projects');
  const fakeProvider = new FakeFrameProvider();
  const codexProvider = new CodexCliFrameProvider();
  const localVisualReviewer = new RuleBasedVisualReviewer();
  const deepseekVisualReviewer = new DeepSeekVisualReviewer({
    getApiKey: async () => visionProviderSettings?.getApiKey() ?? null,
    rasterizeSvg: rasterizeVisualReviewSvg,
    isAllowed: () => cloudVisualConsentActive && visionProviderSettings?.getView().provider === 'deepseek'
  });
  const guardedDeepSeekVisualReviewer: VisualReviewProvider = {
    name: deepseekVisualReviewer.name,
    review(input, options) { return runCancellableDeepSeekReview(deepseekVisualReviewer, input, options.signal); }
  };
  const chooseVisualReviewer = (input: VisualReviewInput): VisualReviewProvider =>
    cloudVisualConsentActive && visionProviderSettings?.getView().provider === 'deepseek' && input.evidence.assetStatus === 'ready'
      ? guardedDeepSeekVisualReviewer
      : localVisualReviewer;
  const selectedVisualReviewer: VisualReviewProvider = {
    get name() { return cloudVisualConsentActive && visionProviderSettings?.getView().provider === 'deepseek' ? deepseekVisualReviewer.name : localVisualReviewer.name; },
    select: chooseVisualReviewer,
    review(input, options) { return chooseVisualReviewer(input).review(input, options); }
  };
  const provider = useCodex ? codexProvider : fakeProvider;
  providerName = provider.name;
  service = new S0GenerationService(provider, outputRoot);
  const generationFakeProvider: FrameProvider = s2PocMode ? {
    name: fakeProvider.name,
    async generateFrame(input, options) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return fakeProvider.generateFrame(input, options);
    }
  } : fakeProvider;
  generationRuns = new GenerationRunService({
    providers: { 'local-fake': generationFakeProvider, 'codex-cli': codexProvider },
    visualReviewer: selectedVisualReviewer,
    fontsReady: s2PocMode,
    persistEvent: (projectId, event) => appendGenerationRunEvent(projectRoot, projectId, event),
    persistCheckpoint: (checkpoint) => saveGenerationRunCheckpoint(projectRoot, checkpoint, checkpoint.loop.checkpointId),
    persistEvidence: (projectId, content) => saveScreenshotEvidence(projectRoot, projectId, content),
    renderAssetDataUrls: makeReviewAssetDataUrls
  });
  generationRuns.subscribe((event: GenerationEvent) => {
    const parsed = generationEventSchema.safeParse(event);
    if (!parsed.success) return;
    const context = generationRunContexts.get(parsed.data.runId);
    if (!context || context.projectId !== activeProjectId || context.documentId !== activeDocumentId) return;
    window?.webContents.send('studio:generation:event', parsed.data);
  });
  router.handle('frame:generateAndSave', async (raw) => {
    const request = raw as { payload: { title: string; prompt: string } };
    const generated = await service.generateAndSave(request.payload, 's0-demo');
    return { ok: true, data: { document: generated.document, documentPath: generated.saved.documentPath, screenshotPath: generated.saved.screenshotPath, screenshotMetadataPath: generated.saved.screenshotMetadataPath, screenshot: generated.screenshot, previewSvg: generated.previewSvg }, revision: generated.document.revision };
  });
  ipcMain.handle('frame:generateAndSave', async (event, payload: unknown) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Untrusted IPC sender', retryable: false } };
    const result = await router.invoke('frame:generateAndSave', { requestId: `req_${randomUUID().replaceAll('-', '')}`, projectId: 's0-demo', payload });
    if (headlessPoc) {
      const pocResult = result.ok
        ? { s0Ipc: 'passed', documentId: result.data.document.documentId, revision: result.revision, rootType: result.data.document.pages[0]?.root.type, screenshot: result.data.screenshot, documentPath: result.data.documentPath, screenshotPath: result.data.screenshotPath, screenshotMetadataPath: result.data.screenshotMetadataPath }
        : { s0Ipc: 'failed', error: result.error };
      await mkdir(outputRoot, { recursive: true });
      await writeFile(path.join(outputRoot, 'poc-result.json'), `${JSON.stringify(pocResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (result.ok) console.log(JSON.stringify({ s0Ipc: 'passed', documentId: result.data.document.documentId, revision: result.revision, rootType: result.data.document.pages[0]?.root.type, screenshot: result.data.screenshot, documentPath: result.data.documentPath, screenshotPath: result.data.screenshotPath, screenshotMetadataPath: result.data.screenshotMetadataPath }));
      else console.error(JSON.stringify({ s0Ipc: 'failed', error: result.error }));
      setTimeout(() => app.quit(), 250);
    }
    return result;
  });
  if (!headlessPoc) {
    await initializeStudio();
    registerStudioHandlers();
    if (!s1PocMode && !s2PocMode && !s6PocMode) {
      mcpBridge = new McpMainBridge(app.getPath('userData'), createMcpStudioSource());
      try { await mcpBridge.start(); }
      catch { console.error('MCP local bridge could not start; the editor will continue without MCP.'); }
    }
  }
  createWindow();
  studioStartupComplete = true;
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', (event) => {
  if (headlessPoc || s1PocMode || quittingAfterSnapshot || !documentStore) return;
  event.preventDefault();
  quittingAfterSnapshot = true;
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  void withStudioLock(async () => {
    const document = documentStore?.getSnapshot();
    if (document && document.revision > lastSnapshotRevision) {
      const saved = await saveDesignSnapshot(projectRoot, activeProjectId, document);
      lastSnapshotRevision = saved.revision;
    }
  }).catch((error) => console.error('Final studio snapshot failed:', error)).finally(async () => {
    await mcpBridge?.stop();
    app.quit();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
