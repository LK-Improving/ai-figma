import type { DesignDocument, DesignNode, DesignVariable } from '@miaoma/design-schema';
import type { EditorCommand, HistoryState } from '@miaoma/editor-core';
import type { AgentRunState, DesignPlan, GenerationCandidate, GenerationEvent, GenerationRequest, GenerationRunResumeResult, GenerationRunSnapshot, GenerationRunState, GenerationRunSummary, GenerationWarningsAcceptanceResult, QualityLoopState, ScreenshotEvidenceContent } from '@miaoma/shared-protocol';
import {
  clientToWorld,
  commitDragDraft,
  createDragDraft,
  createViewport,
  getNodeLocalToWorldMatrix,
  hitTestDocument,
  invertMatrix,
  keyboardNudgeDelta,
  nodesIntersectingClientRect,
  panViewportBy,
  transformPoint,
  updateDragDraft,
  updateSelection,
  worldToCanvasCss,
  zoomViewportAt,
  type DragDraft,
  type Matrix2D,
  type NodeHit,
  type Point,
  type Rect,
  type Viewport
} from '@miaoma/editor-interaction';

type StudioFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };
type StudioSuccess<T> = { ok: true; data: T };
type StudioResult<T> = StudioSuccess<T> | StudioFailure;
type StudioState = {
  projectId: string;
  document: DesignDocument;
  history: HistoryState;
  durableRevision: number;
  recovery: { snapshotRevision: number; replayedCommits: number; ignoredTailBytes: number; diagnostics: Array<{ code: string; message: string; line?: number }> };
  assetDataUrls: Record<string, string>;
};
type StudioMutation = { document: DesignDocument; history: HistoryState; durableRevision: number; assetDataUrls?: Record<string, string>; asset?: { id: string; dataUrl: string; nodeId: string } };
type ExportResult = { exportPath: string; documentPath: string; imagePath: string; manifestPath: string; sha256: string; width: number; height: number };
type BridgeProjectContext = { projectId: string; documentId: string };
type RendererOperationContext = BridgeProjectContext & { generation: number };
type CandidateApplyResult = { kind: 'applied'; mutation: StudioMutation } | { kind: 'conflict'; currentRevision: number };

declare global {
  interface Window {
    miaoma: {
      generateAndSave(input: { title: string; prompt: string }): Promise<unknown>;
      studio: {
        setMcpSelection(input: BridgeProjectContext & { nodeIds: readonly string[] }): Promise<StudioResult<{ selectionIds: string[] }>>;
        getMcpStatus(context: BridgeProjectContext): Promise<StudioResult<{ active: boolean; endpointReady: boolean; toolNames: string[]; grant: { projectId: string; documentId: string; grantedAt: string } | null }>>;
        revokeMcpGrant(context: BridgeProjectContext): Promise<StudioResult<{ revoked: boolean }>>;
        configureMcp(input: BridgeProjectContext & { clientName: 'vscode' | 'claude-desktop' | 'cursor' }): Promise<StudioResult<{ clientName: string; toolNames: string[]; grant: { projectId: string; documentId: string; grantedAt: string }; config: string; configPathHint: string }>>;
        newProject(context: BridgeProjectContext): Promise<StudioResult<StudioState>>;
        openProject(context: BridgeProjectContext): Promise<StudioResult<StudioState | { cancelled: true }>>;
        load(): Promise<StudioResult<StudioState>>;
        execute(input: BridgeProjectContext & { baseRevision: number; commands: readonly EditorCommand[]; commandId?: string }): Promise<StudioResult<StudioMutation>>;
        undo(input: BridgeProjectContext & { baseRevision: number }): Promise<StudioResult<StudioMutation>>;
        redo(input: BridgeProjectContext & { baseRevision: number }): Promise<StudioResult<StudioMutation>>;
        save(context: BridgeProjectContext): Promise<StudioResult<{ snapshotPath: string; revision: number }>>;
        planGeneration(input: BridgeProjectContext & { request: GenerationRequest }): Promise<StudioResult<DesignPlan>>;
        startGeneration(input: BridgeProjectContext & { request: GenerationRequest }): Promise<StudioResult<{ runId: string; plan: DesignPlan }>>;
        getGenerationRun(input: BridgeProjectContext & { runId: string; afterSeq: number }): Promise<StudioResult<GenerationRunSnapshot>>;
        listGenerationRuns(context: BridgeProjectContext): Promise<StudioResult<GenerationRunSummary[]>>;
        resumeGenerationRun(input: BridgeProjectContext & { runId: string; expectedAttemptId: string }): Promise<StudioResult<GenerationRunResumeResult>>;
        acceptGenerationWarnings(input: BridgeProjectContext & { runId: string; expectedAttemptId: string; reason: string }): Promise<StudioResult<GenerationWarningsAcceptanceResult>>;
        getLoopEvidence(input: BridgeProjectContext & { runId: string; evidenceId: string }): Promise<StudioResult<ScreenshotEvidenceContent>>;
        cancelGeneration(input: BridgeProjectContext & { runId: string }): Promise<StudioResult<{ cancelled: boolean }>>;
        applyGenerationCandidate(input: BridgeProjectContext & { runId: string; expectedRevision: number; force: boolean }): Promise<StudioResult<CandidateApplyResult>>;
        copyGenerationCandidate(input: BridgeProjectContext & { runId: string }): Promise<StudioResult<StudioState>>;
        subscribeGeneration(listener: (event: GenerationEvent) => void): () => void;
        preflightPng(input: BridgeProjectContext & { baseRevision: number; bytes: Uint8Array }): Promise<StudioResult<{ width: number; height: number }>>;
        importPng(input: BridgeProjectContext & { baseRevision: number; name: string; bytes: Uint8Array }): Promise<StudioResult<StudioMutation>>;
        exportPng(input: BridgeProjectContext & { baseRevision: number; pageId: string; width: number; height: number; scale: number; bytes: Uint8Array }): Promise<StudioResult<ExportResult>>;
      };
    };
    __miaomaS1Poc?: { assetCacheState(assetId: string): { hasDataUrl: boolean; hasDecodedImage: boolean } };
  }
}

type NodeLocation = { node: DesignNode; parent: Extract<DesignNode, { type: 'frame' }> | null; ancestors: Extract<DesignNode, { type: 'frame' }>[] };
type PointerGesture =
  | { kind: 'pan'; pointerId: number; last: Point }
  | { kind: 'drag'; pointerId: number; hit: NodeHit; parentMatrix: Matrix2D; draft: DragDraft; moved: boolean }
  | { kind: 'resize'; pointerId: number; nodeId: string; handle: 0 | 1 | 2 | 3; nodeMatrix: Matrix2D; startBounds: Rect; bounds: Rect; startPointer: Point; fixedParent: Point; moved: boolean }
  | { kind: 'marquee'; pointerId: number; start: Point; current: Point };

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing editor element: ${selector}`);
  return element;
};
const canvas = $('#design-canvas') as HTMLCanvasElement;
const canvasScroll = $('#canvas-scroll');
const layerTree = $('#layer-tree');
const viewport: Viewport = createViewport();
const selection: string[] = [];
const assetDataUrls: Record<string, string> = {};
const imageCache = new Map<string, HTMLImageElement>();
let design: DesignDocument | null = null;
let activeProjectId = '';
let contextGeneration = 0;
let projectTransitionPending = false;
let projectTransitionPreparing = false;
let textFlushPromise: Promise<boolean> | null = null;
let history: HistoryState = { revision: 0, canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };
let durableRevision = 0;
let currentPageId = '';
let activeCreateTool: DesignNode['type'] | 'select' = 'select';
let gesture: PointerGesture | null = null;
let spaceHeld = false;
let initialFit = false;
let textInputTimer: ReturnType<typeof setTimeout> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let imageImportPending = false;
let generationPanelOpen = false;
let generationEventUnsubscribe: (() => void) | null = null;
let generationPollTimer: ReturnType<typeof setTimeout> | null = null;
let generationRunId: string | null = null;
let generationAttemptId: string | null = null;
let generationRunState: GenerationRunState | null = null;
let generationRunError = '';
let generationAfterSeq = 0;
let generationEvents: GenerationEvent[] = [];
const generationEventIds = new Set<string>();
let generationFormVersion = 0;
let generationPlanBusy = false;
let generationStartBusy = false;
let generationCancelBusy = false;
let generationApplyBusy = false;
let generationRequest: GenerationRequest | null = null;
let generationPlan: DesignPlan | null = null;
let generationCandidate: GenerationCandidate | null = null;
let generationRuns: GenerationRunSummary[] = [];
let generationCollaboration: AgentRunState | null = null;
let generationLoop: QualityLoopState | null = null;
let generationReviewRound = 0;
let generationSelectedEvidenceId: string | null = null;
let generationEvidenceContent: ScreenshotEvidenceContent | null = null;
let generationEvidenceErrorId: string | null = null;
let generationEvidenceBusy = false;
let generationEvidenceUrl: string | null = null;
let generationRunListBusy = false;
let generationResumeBusy = false;
let generationResumePreparing = false;
let generationAcceptBusy = false;
let generationSelectedTab: 'overview' | 'collaboration' | 'review' = 'overview';
let generationFilterAgent = 'all';
let generationFilterTask = 'all';
let generationFilterRound = 'all';
let generationEventsRenderKey = '';
let generationRunHistoryRenderKey = '';
let generationLoopRenderKey = '';
let generationPreviewUrl: string | null = null;
let generationPreviewCandidateId: string | null = null;
let generationConflictRevision: number | null = null;
let generationPanelError = '';

if (new URLSearchParams(window.location.search).get('s1Poc') === '1') {
  Object.defineProperty(window, '__miaomaS1Poc', {
    value: Object.freeze({
      assetCacheState: (assetId: string) => ({ hasDataUrl: Object.hasOwn(assetDataUrls, assetId), hasDecodedImage: imageCache.has(assetId) })
    }),
    configurable: false
  });
}

function style(fills: DesignNode['style']['fills'] = []): DesignNode['style'] {
  return { fills, strokes: [], effects: [], opacity: 1 };
}

function makeText(id: string, name: string, text: string, x: number, y: number, width: number, height: number, size: number, color: string, weight = 400): Extract<DesignNode, { type: 'text' }> {
  return {
    id, type: 'text', name, text, visible: true, locked: false,
    bounds: { x, y, width, height }, transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: style(),
    typography: { fontFamily: 'Microsoft YaHei, Aptos, sans-serif', fontSize: size, fontWeight: weight, lineHeight: 1.35, letterSpacing: 0, textAlign: 'left', color }, sizing: 'auto'
  };
}

function setSaveStatus(state: 'saved' | 'saving' | 'error', message: string): void {
  const status = $('#save-status');
  status.dataset.state = state;
  status.lastElementChild!.textContent = message;
}

function showToast(message: string, error = false): void {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.error = error ? 'true' : 'false';
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : '操作失败';
  setSaveStatus('error', '保存失败');
  showToast(message, true);
}

function commitMutation(next: StudioMutation): void {
  design = next.document;
  history = next.history;
  durableRevision = next.durableRevision;
  if (generationRequest && generationRequest.baseRevision !== next.document.revision) {
    generationFormVersion++;
    generationRequest = null;
    generationPlan = null;
    generationPanelError = '文档已变化，旧计划已失效。请重新生成计划。';
  }
  const activeAssetIds = new Set(Object.keys(next.document.assets));
  for (const assetId of Object.keys(assetDataUrls)) {
    if (!activeAssetIds.has(assetId)) {
      delete assetDataUrls[assetId];
      imageCache.delete(assetId);
    }
  }
  Object.assign(assetDataUrls, next.assetDataUrls ?? {});
  if (next.asset) assetDataUrls[next.asset.id] = next.asset.dataUrl;
  $<HTMLInputElement>('#document-title').value = design.title;
  setSaveStatus('saved', '已保存');
  renderEditor();
  if (generationPanelOpen) renderGenerationPanel();
}

function assertLoaded(): DesignDocument {
  if (!design) throw new Error('设计文档尚未载入');
  return design;
}

function captureOperationContext(): RendererOperationContext | null {
  if (!design || projectTransitionPending || !activeProjectId) return null;
  return { projectId: activeProjectId, documentId: design.documentId, generation: contextGeneration };
}

function isCurrentOperationContext(context: RendererOperationContext): boolean {
  return !projectTransitionPending && context.generation === contextGeneration && !!design
    && context.projectId === activeProjectId && context.documentId === design.documentId;
}

function setProjectButtonsDisabled(disabled: boolean): void {
  ($('#new-project') as HTMLButtonElement).disabled = disabled;
  ($('#open-project') as HTMLButtonElement).disabled = disabled;
}

type ProjectTransition = { context: RendererOperationContext; generation: number };

async function beginProjectTransition(): Promise<ProjectTransition | null> {
  if (projectTransitionPending || projectTransitionPreparing) return null;
  projectTransitionPreparing = true;
  setProjectButtonsDisabled(true);
  if ((textInputTimer || textFlushPromise) && !(await flushTextEdit())) {
    projectTransitionPreparing = false;
    setProjectButtonsDisabled(false);
    return null;
  }
  const context = captureOperationContext();
  if (!context) {
    projectTransitionPreparing = false;
    setProjectButtonsDisabled(false);
    return null;
  }
  projectTransitionPreparing = false;
  projectTransitionPending = true;
  const generation = ++contextGeneration;
  return { context, generation };
}

function isCurrentProjectTransition(transition: ProjectTransition): boolean {
  return projectTransitionPending && contextGeneration === transition.generation;
}

function finishProjectTransition(transition: ProjectTransition): void {
  if (!isCurrentProjectTransition(transition)) return;
  projectTransitionPending = false;
  setProjectButtonsDisabled(false);
}

async function restoreProjectAfterTransition(transition: ProjectTransition): Promise<boolean> {
  if (!isCurrentProjectTransition(transition)) return false;
  try {
    const loaded = throwIfFailure(await window.miaoma.studio.load());
    if (!isCurrentProjectTransition(transition)) return false;
    applyStudioState(loaded);
    return true;
  } catch (error) {
    if (isCurrentProjectTransition(transition)) { finishProjectTransition(transition); reportError(error); }
    return false;
  }
}

function bridgeContext(context: RendererOperationContext): BridgeProjectContext {
  return { projectId: context.projectId, documentId: context.documentId };
}

function throwIfFailure<T>(result: StudioResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

async function execute(commands: readonly EditorCommand[], commandId?: string): Promise<StudioMutation | null> {
  const context = captureOperationContext();
  if (!context) return null;
  const current = assertLoaded();
  setSaveStatus('saving', '正在保存…');
  let response: StudioResult<StudioMutation>;
  try { response = await window.miaoma.studio.execute({ ...bridgeContext(context), baseRevision: current.revision, commands, ...(commandId ? { commandId } : {}) }); }
  catch (error) { if (!isCurrentOperationContext(context)) return null; throw error; }
  if (!isCurrentOperationContext(context)) return null;
  const result = throwIfFailure(response);
  commitMutation(result);
  return result;
}

function findNode(documentModel: DesignDocument, nodeId: string): NodeLocation | null {
  const visit = (node: DesignNode, parent: Extract<DesignNode, { type: 'frame' }> | null, ancestors: Extract<DesignNode, { type: 'frame' }>[] ): NodeLocation | null => {
    if (node.id === nodeId) return { node, parent, ancestors };
    if (node.type === 'frame') {
      for (const child of node.children) {
        const found = visit(child, node, [...ancestors, node]);
        if (found) return found;
      }
    }
    return null;
  };
  for (const page of documentModel.pages) {
    const found = visit(page.root, null, []);
    if (found) return found;
  }
  return null;
}

function parentWorldMatrix(location: NodeLocation): Matrix2D {
  return location.ancestors.reduce<Matrix2D>((matrix, frame) => getNodeLocalToWorldMatrix(frame, matrix), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
}

function allNodeLocations(documentModel: DesignDocument, pageId = currentPageId): Array<{ location: NodeLocation; depth: number }> {
  const page = documentModel.pages.find((candidate) => candidate.id === pageId) ?? documentModel.pages[0]!;
  const output: Array<{ location: NodeLocation; depth: number }> = [];
  const visit = (node: DesignNode, parent: Extract<DesignNode, { type: 'frame' }> | null, ancestors: Extract<DesignNode, { type: 'frame' }>[], depth: number) => {
    output.push({ location: { node, parent, ancestors }, depth });
    if (node.type === 'frame') for (const child of node.children) visit(child, node, [...ancestors, node], depth + 1);
  };
  visit(page.root, null, [], 0);
  return output;
}

function fillColor(documentModel: DesignDocument, fill: DesignNode['style']['fills'][number] | undefined): string {
  if (!fill) return 'rgba(255,255,255,0)';
  if (fill.type === 'asset') return '#D6DED6';
  if (typeof fill.color === 'string') return fill.color;
  const variable = documentModel.variables[fill.color.id];
  return typeof variable?.value === 'string' ? variable.value : String(fill.color.fallback);
}

function getNodeOverride(node: DesignNode, overrides: ReadonlyMap<string, Rect>): Rect {
  return overrides.get(node.id) ?? node.bounds;
}

function roundedRect(context: CanvasRenderingContext2D, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) context.rect(0, 0, width, height);
  else context.roundRect(0, 0, width, height, r);
}

function drawIcon(context: CanvasRenderingContext2D, node: Extract<DesignNode, { type: 'icon' }>, color: string): void {
  const { width, height } = node.bounds;
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = Math.max(2, Math.min(width, height) * 0.08);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const cx = width / 2, cy = height / 2, r = Math.min(width, height) * 0.43;
  context.beginPath();
  switch (node.iconKey) {
    case 'plus':
      context.moveTo(cx, height * 0.18); context.lineTo(cx, height * 0.82);
      context.moveTo(width * 0.18, cy); context.lineTo(width * 0.82, cy); context.stroke(); break;
    case 'check':
      context.moveTo(width * 0.15, cy); context.lineTo(width * 0.42, height * 0.75); context.lineTo(width * 0.86, height * 0.23); context.stroke(); break;
    case 'arrow-right':
      context.moveTo(width * 0.13, cy); context.lineTo(width * 0.82, cy);
      context.moveTo(width * 0.58, height * 0.24); context.lineTo(width * 0.84, cy); context.lineTo(width * 0.58, height * 0.76); context.stroke(); break;
    case 'leaf':
      context.moveTo(width * 0.18, height * 0.78);
      context.bezierCurveTo(width * 0.12, height * 0.3, width * 0.52, height * 0.11, width * 0.82, height * 0.17);
      context.bezierCurveTo(width * 0.8, height * 0.62, width * 0.56, height * 0.89, width * 0.18, height * 0.78); context.fill();
      context.beginPath(); context.moveTo(width * 0.2, height * 0.78); context.quadraticCurveTo(width * 0.47, height * 0.48, width * 0.73, height * 0.27); context.stroke(); break;
    case 'sparkle':
      context.moveTo(cx, cy - r); context.lineTo(cx + r * 0.18, cy - r * 0.18); context.lineTo(cx + r, cy);
      context.lineTo(cx + r * 0.18, cy + r * 0.18); context.lineTo(cx, cy + r); context.lineTo(cx - r * 0.18, cy + r * 0.18);
      context.lineTo(cx - r, cy); context.lineTo(cx - r * 0.18, cy - r * 0.18); context.closePath(); context.fill(); break;
  }
}

function imageForAsset(assetId: string): HTMLImageElement | null {
  const dataUrl = assetDataUrls[assetId];
  if (!dataUrl) return null;
  let image = imageCache.get(assetId);
  if (!image) {
    image = new Image();
    image.onload = () => renderCanvas();
    image.src = dataUrl;
    imageCache.set(assetId, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

function drawNode(
  context: CanvasRenderingContext2D,
  documentModel: DesignDocument,
  node: DesignNode,
  parentMatrix: Matrix2D,
  scale: number,
  offset: Point,
  overrides: ReadonlyMap<string, Rect>
): void {
  if (!node.visible) return;
  const drawBounds = getNodeOverride(node, overrides);
  const drawNodeModel = drawBounds === node.bounds ? node : { ...node, bounds: drawBounds } as DesignNode;
  const localMatrix = getNodeLocalToWorldMatrix(drawNodeModel, parentMatrix);
  context.save();
  context.setTransform(
    scale * localMatrix.a, scale * localMatrix.b, scale * localMatrix.c, scale * localMatrix.d,
    scale * localMatrix.e + offset.x, scale * localMatrix.f + offset.y
  );
  context.globalAlpha *= drawNodeModel.style.opacity;
  const width = drawBounds.width, height = drawBounds.height;
  const fill = drawNodeModel.style.fills[0];
  if (drawNodeModel.type === 'frame') {
    if (fill) {
      context.fillStyle = fillColor(documentModel, fill);
      roundedRect(context, width, height, 0);
      context.fill();
    }
    if (drawNodeModel.clipContent) { context.beginPath(); context.rect(0, 0, width, height); context.clip(); }
    for (const child of drawNodeModel.children) drawNode(context, documentModel, child, localMatrix, scale, offset, overrides);
  } else if (drawNodeModel.type === 'rectangle') {
    const radiusValue = typeof drawNodeModel.radius === 'number' ? drawNodeModel.radius : drawNodeModel.radius.fallback;
    const radius = typeof radiusValue === 'number' ? radiusValue : 0;
    if (fill?.type === 'asset') {
      const image = imageForAsset(fill.assetId);
      if (image) context.drawImage(image, 0, 0, width, height);
      else { context.fillStyle = '#D6DED6'; roundedRect(context, width, height, radius); context.fill(); }
    } else if (fill) { context.fillStyle = fillColor(documentModel, fill); roundedRect(context, width, height, radius); context.fill(); }
    else { context.beginPath(); roundedRect(context, width, height, radius); context.strokeStyle = '#D8DDE4'; context.stroke(); }
    const stroke = drawNodeModel.style.strokes[0];
    if (stroke && stroke.width > 0) { context.beginPath(); roundedRect(context, width, height, radius); context.lineWidth = stroke.width; context.strokeStyle = stroke.color; context.stroke(); }
  } else if (drawNodeModel.type === 'ellipse') {
    context.beginPath(); context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    if (fill) { context.fillStyle = fillColor(documentModel, fill); context.fill(); }
    if (drawNodeModel.style.strokes[0]) { context.lineWidth = drawNodeModel.style.strokes[0].width; context.strokeStyle = drawNodeModel.style.strokes[0].color; context.stroke(); }
  } else if (drawNodeModel.type === 'text') {
    context.fillStyle = drawNodeModel.typography.color;
    context.font = `${drawNodeModel.typography.fontWeight} ${drawNodeModel.typography.fontSize}px ${drawNodeModel.typography.fontFamily}`;
    context.textAlign = drawNodeModel.typography.textAlign;
    context.textBaseline = 'top';
    context.letterSpacing = `${drawNodeModel.typography.letterSpacing}px`;
    const x = drawNodeModel.typography.textAlign === 'center' ? width / 2 : drawNodeModel.typography.textAlign === 'right' ? width : 0;
    const lineHeight = drawNodeModel.typography.fontSize * drawNodeModel.typography.lineHeight;
    drawNodeModel.text.split(/\r?\n/).forEach((line, index) => context.fillText(line, x, index * lineHeight, width));
  } else drawIcon(context, drawNodeModel, fillColor(documentModel, fill));
  context.restore();
}

function nodeScreenCorners(node: DesignNode, parentMatrix: Matrix2D, override?: Rect): Point[] {
  const target = override ? { ...node, bounds: override } as DesignNode : node;
  const matrix = getNodeLocalToWorldMatrix(target, parentMatrix);
  const width = target.bounds.width, height = target.bounds.height;
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  return corners.map((corner) => worldToCanvasCss(transformPoint(matrix, corner), viewport));
}

function drawSelection(context: CanvasRenderingContext2D, documentModel: DesignDocument, rect: DOMRect, dpr: number, overrides: ReadonlyMap<string, Rect>): void {
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const page = documentModel.pages.find((item) => item.id === currentPageId)!;
  for (const id of selection) {
    const location = findNode(documentModel, id);
    if (!location) continue;
    const parentMatrix = parentWorldMatrix(location);
    const corners = nodeScreenCorners(location.node, parentMatrix, overrides.get(id));
    context.save();
    context.beginPath();
    corners.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
    context.closePath();
    context.lineWidth = 1;
    context.strokeStyle = '#315bea';
    context.setLineDash([]);
    context.stroke();
    const active = selection.length === 1 && id !== page.root.id;
    if (active) for (const point of corners) { context.fillStyle = '#fff'; context.fillRect(point.x - 3.5, point.y - 3.5, 7, 7); context.strokeStyle = '#315bea'; context.strokeRect(point.x - 3.5, point.y - 3.5, 7, 7); }
    context.restore();
  }
  if (gesture?.kind === 'marquee') {
    const left = Math.min(gesture.start.x, gesture.current.x), top = Math.min(gesture.start.y, gesture.current.y);
    context.fillStyle = '#315bea14'; context.strokeStyle = '#315bea'; context.setLineDash([4, 3]);
    context.fillRect(left, top, Math.abs(gesture.current.x - gesture.start.x), Math.abs(gesture.current.y - gesture.start.y));
    context.strokeRect(left, top, Math.abs(gesture.current.x - gesture.start.x), Math.abs(gesture.current.y - gesture.start.y));
  }
  void rect;
}

function fitDocument(): void {
  if (!design) return;
  const root = design.pages.find((item) => item.id === currentPageId)!.root;
  const bounds = canvas.getBoundingClientRect();
  const zoom = Math.max(0.08, Math.min(1, (bounds.width - 120) / root.bounds.width, (bounds.height - 110) / root.bounds.height));
  viewport.zoom = zoom;
  viewport.panX = (bounds.width - root.bounds.width * zoom) / 2;
  viewport.panY = (bounds.height - root.bounds.height * zoom) / 2;
  initialFit = true;
  renderCanvas();
}

function renderCanvas(): void {
  if (!design) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.dataset.zoom = String(viewport.zoom);
  canvas.dataset.panX = String(viewport.panX);
  canvas.dataset.panY = String(viewport.panY);
  const backingWidth = Math.max(1, Math.ceil(rect.width * dpr));
  const backingHeight = Math.max(1, Math.ceil(rect.height * dpr));
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) { canvas.width = backingWidth; canvas.height = backingHeight; }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const page = design.pages.find((item) => item.id === currentPageId);
  if (!page) return;
  const overrides = new Map<string, Rect>();
  if (gesture?.kind === 'drag') overrides.set(gesture.draft.nodeId, gesture.draft.draftBounds);
  else if (gesture?.kind === 'resize') overrides.set(gesture.nodeId, gesture.bounds);
  drawNode(context, design, page.root, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, dpr * viewport.zoom, { x: dpr * viewport.panX, y: dpr * viewport.panY }, overrides);
  drawSelection(context, design, rect, dpr, overrides);
  $('#canvas-empty').toggleAttribute('hidden', page.root.children.some((child) => child.visible));
}

function setSelection(ids: readonly string[]): void {
  selection.splice(0, selection.length, ...[...new Set(ids)].filter((id) => !!design && !!findNode(design, id)));
  if (design && !projectTransitionPending) void window.miaoma.studio.setMcpSelection({ projectId: activeProjectId, documentId: design.documentId, nodeIds: selection }).catch(() => undefined);
  renderEditor();
}

function topmostSelectedNodeIds(documentModel: DesignDocument): string[] {
  const selected = new Set(selection);
  const rootId = documentModel.pages.find((page) => page.id === currentPageId)!.root.id;
  return selection.filter((id) => {
    const location = findNode(documentModel, id);
    return !!location && !location.ancestors.some((ancestor) => ancestor.id !== rootId && selected.has(ancestor.id));
  });
}

function renderLayers(): void {
  if (!design) return;
  layerTree.replaceChildren();
  const page = design.pages.find((item) => item.id === currentPageId)!;
  const visit = (node: DesignNode, depth: number) => {
    const row = document.createElement('div');
    row.className = `layer-row${selection.includes(node.id) ? ' selected' : ''}${node.type === 'frame' && depth === 0 ? ' root' : ''}${node.visible ? '' : ' layer-hidden'}`;
    row.dataset.nodeId = node.id;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', String(selection.includes(node.id)));
    row.style.paddingLeft = `${6 + depth * 14}px`;
    const typeIcon = document.createElement('span');
    typeIcon.className = 'layer-type-icon';
    typeIcon.textContent = ({ frame: '▣', rectangle: '▭', ellipse: '◯', text: 'T', icon: '✦' })[node.type];
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = node.name;
    const lock = document.createElement('button');
    lock.className = 'layer-lock'; lock.type = 'button'; lock.title = node.locked ? '解锁图层' : '锁定图层'; lock.textContent = node.locked ? '⌑' : '·'; lock.setAttribute('aria-label', lock.title);
    lock.addEventListener('click', (event) => { event.stopPropagation(); void execute([{ type: 'update', nodeId: node.id, patch: { locked: !node.locked } }]).catch(reportError); });
    const visible = document.createElement('button');
    visible.className = 'layer-eye'; visible.type = 'button'; visible.title = node.visible ? '隐藏图层' : '显示图层'; visible.textContent = node.visible ? '◉' : '○'; visible.setAttribute('aria-label', visible.title);
    visible.addEventListener('click', (event) => { event.stopPropagation(); void execute([{ type: 'update', nodeId: node.id, patch: { visible: !node.visible } }]).catch(reportError); });
    row.append(typeIcon, name, lock, visible);
    row.addEventListener('click', (event) => setSelection(updateSelection(selection, node.id, event.shiftKey ? 'toggle' : selection.includes(node.id) ? 'add' : 'replace')));
    layerTree.append(row);
    if (node.type === 'frame') for (const child of [...node.children].reverse()) visit(child, depth + 1);
  };
  visit(page.root, 0);
  $('#node-count').textContent = String(allNodeLocations(design).length);
  $('#page-name').textContent = page.name;
  $('#page-name').nextElementSibling!.textContent = `${page.root.bounds.width} × ${page.root.bounds.height}`;
}

function updateInput(selector: string, value: string): void {
  const input = $(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

function currentFill(node: DesignNode): DesignNode['style']['fills'][number] | undefined { return node.style.fills[0]; }

function renderInspector(): void {
  const selected = design && selection.length === 1 ? findNode(design, selection[0]!)?.node : null;
  const inspector = $('#inspector');
  const empty = $('#inspector-empty');
  const kind = $('#selected-kind');
  inspector.hidden = !selected;
  empty.hidden = !!selected;
  kind.textContent = selected ? ({ frame: 'Frame', rectangle: '矩形', ellipse: '椭圆', icon: '图标', text: '文本' })[selected.type] : '—';
  if (!selected || !design) return;
  updateInput('#property-name', selected.name);
  updateInput('#property-x', String(Math.round(selected.bounds.x)));
  updateInput('#property-y', String(Math.round(selected.bounds.y)));
  updateInput('#property-width', String(Math.round(selected.bounds.width)));
  updateInput('#property-height', String(Math.round(selected.bounds.height)));
  updateInput('#property-rotation', String(Math.round(selected.transform.rotation)));
  const radiusValue = selected.type === 'rectangle' ? (typeof selected.radius === 'number' ? selected.radius : selected.radius.fallback) : 0;
  const radius = typeof radiusValue === 'number' ? radiusValue : 0;
  updateInput('#property-radius', String(Math.round(radius)));
  const fill = currentFill(selected);
  const color = selected.type === 'text' ? selected.typography.color : fill?.type === 'solid' ? fillColor(design, fill) : '#d6ded6';
  updateInput('#property-fill', /^#[0-9a-f]{6}$/i.test(color) ? color : '#d6ded6');
  $('#fill-label').textContent = color.toUpperCase();
  updateInput('#property-opacity', String(Math.round(selected.style.opacity * 100)));
  $('#opacity-value').textContent = `${Math.round(selected.style.opacity * 100)}%`;
  $('.opacity-label').textContent = `${Math.round(selected.style.opacity * 100)}%`;
  $('#text-properties').toggleAttribute('hidden', selected.type !== 'text');
  $('#icon-properties').toggleAttribute('hidden', selected.type !== 'icon');
  $('#frame-properties').toggleAttribute('hidden', selected.type !== 'frame');
  $('#property-radius').closest('.number-field')!.toggleAttribute('hidden', selected.type !== 'rectangle');
  $('#fill-properties').toggleAttribute('hidden', selected.type === 'text');
  if (selected.type === 'text') {
    updateInput('#property-text', selected.text);
    updateInput('#property-font-size', String(selected.typography.fontSize));
    updateInput('#property-font-weight', String(selected.typography.fontWeight));
    updateInput('#property-text-color', selected.typography.color);
    $('#text-color-label').textContent = selected.typography.color.toUpperCase();
  } else if (selected.type === 'icon') updateInput('#property-icon', selected.iconKey);
  else if (selected.type === 'frame') ($('#property-clip') as HTMLInputElement).checked = selected.clipContent;
  $('#toggle-visible').textContent = selected.visible ? '◉ 隐藏图层' : '○ 显示图层';
  $('#toggle-locked').textContent = selected.locked ? '⌑ 解锁图层' : '⌑ 锁定图层';
}

function renderEditor(): void {
  if (!design) return;
  $('#canvas-revision').textContent = `revision ${design.revision}`;
  $('#history-state').textContent = `撤销 ${history.undoDepth} · 重做 ${history.redoDepth}`;
  $('#undo').toggleAttribute('disabled', !history.canUndo);
  $('#redo').toggleAttribute('disabled', !history.canRedo);
  renderLayers();
  renderInspector();
  const names = selection.map((id) => findNode(design!, id)?.node.name).filter(Boolean);
  $('#selection-summary').textContent = names.length ? `已选择 ${names.join('、')}` : '未选择图层';
  if (!initialFit) fitDocument(); else renderCanvas();
}

function clientToCanvasPoint(client: Point): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: client.x - rect.left, y: client.y - rect.top };
}

function createNode(type: DesignNode['type'], x: number, y: number): DesignNode {
  const id = `node_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const base = { id, name: ({ frame: 'Frame', rectangle: '矩形', ellipse: '椭圆', text: '文本', icon: '图标' })[type], visible: true, locked: false, transform: { rotation: 0, scaleX: 1, scaleY: 1 } };
  const fillStyle = (color: string) => style([{ type: 'solid' as const, color }]);
  if (type === 'frame') return { ...base, type, bounds: { x, y, width: 340, height: 240 }, style: fillStyle('#FBFAF6'), children: [], layout: { mode: 'absolute' }, clipContent: true };
  if (type === 'rectangle') return { ...base, type, bounds: { x, y, width: 220, height: 140 }, style: fillStyle('#AFC1AE'), radius: 18 };
  if (type === 'ellipse') return { ...base, type, bounds: { x, y, width: 140, height: 140 }, style: fillStyle('#E6C27D') };
  if (type === 'text') return makeText(id, base.name, '双击属性修改文案', x, y, 340, 56, 28, '#263D32', 600);
  return { ...base, type, bounds: { x, y, width: 48, height: 48 }, style: fillStyle('#315bea'), iconKey: 'sparkle' };
}

async function createAtClient(type: DesignNode['type'], client: Point): Promise<void> {
  const current = assertLoaded();
  const page = current.pages.find((item) => item.id === currentPageId)!;
  const rootMatrix = getNodeLocalToWorldMatrix(page.root, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  const world = clientToWorld(client, canvas.getBoundingClientRect(), viewport);
  const local = transformPoint(invertMatrix(rootMatrix), world);
  const width = type === 'frame' ? 340 : type === 'ellipse' ? 140 : type === 'icon' ? 48 : type === 'text' ? 340 : 220;
  const height = type === 'frame' ? 240 : type === 'ellipse' ? 140 : type === 'icon' ? 48 : type === 'text' ? 56 : 140;
  const node = createNode(type, Math.max(0, local.x - width / 2), Math.max(0, local.y - height / 2));
  const mutation = await execute([{ type: 'create', parentId: page.root.id, node }]);
  if (!mutation) return;
  setSelection([node.id]);
  activeCreateTool = 'select';
  document.querySelectorAll('[data-create]').forEach((button) => button.classList.remove('active'));
  document.querySelector('[data-tool="select"]')?.classList.add('active');
}

function applyHitSelection(hit: NodeHit | undefined, shift: boolean): void {
  if (!hit) { if (!shift) setSelection([]); return; }
  setSelection(updateSelection(selection, hit.node.id, shift ? 'toggle' : selection.includes(hit.node.id) ? 'add' : 'replace'));
}

canvas.addEventListener('pointerdown', (event) => {
  if (!design || event.button > 1) return;
  canvas.focus();
  try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer events are used by the local Electron POC */ }
  const client = { x: event.clientX, y: event.clientY };
  if (spaceHeld || event.button === 1) {
    canvasScroll.dataset.mode = 'panning';
    gesture = { kind: 'pan', pointerId: event.pointerId, last: client };
    return;
  }
  if (activeCreateTool !== 'select') {
    void createAtClient(activeCreateTool, client).catch(reportError);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (selection.length === 1) {
    const selectedNodeId = selection[0]!;
    const selectedLocation = findNode(design, selectedNodeId);
    const pageRootId = design.pages.find((item) => item.id === currentPageId)!.root.id;
    if (selectedLocation && selectedNodeId !== pageRootId && !selectedLocation.node.locked) {
      const parentMatrix = parentWorldMatrix(selectedLocation);
      const corners = nodeScreenCorners(selectedLocation.node, parentMatrix);
      const handle = corners.findIndex((point) => Math.abs(point.x + rect.left - client.x) <= 8 && Math.abs(point.y + rect.top - client.y) <= 8);
      if (handle >= 0) {
        const nodeMatrix = getNodeLocalToWorldMatrix(selectedLocation.node, parentMatrix);
        const left = handle === 0 || handle === 3, top = handle === 0 || handle === 1;
        const fixedCorner = { x: left ? selectedLocation.node.bounds.width : 0, y: top ? selectedLocation.node.bounds.height : 0 };
        const fixedWorld = transformPoint(nodeMatrix, fixedCorner);
        const startPointer = transformPoint(invertMatrix(nodeMatrix), clientToWorld(client, rect, viewport));
        gesture = {
          kind: 'resize', pointerId: event.pointerId, nodeId: selectedNodeId, handle: handle as 0 | 1 | 2 | 3,
          nodeMatrix, startBounds: { ...selectedLocation.node.bounds }, bounds: { ...selectedLocation.node.bounds }, startPointer,
          fixedParent: transformPoint(invertMatrix(parentMatrix), fixedWorld), moved: false
        };
        canvasScroll.dataset.mode = 'resizing';
        return;
      }
    }
  }
  const hits = hitTestDocument(design, currentPageId, client, rect, viewport, { includeFrames: true });
  const hit = hits.find((candidate) => candidate.node.id !== design!.pages.find((item) => item.id === currentPageId)!.root.id) ?? hits[0];
  if (!hit) {
    if (!event.shiftKey) setSelection([]);
    gesture = { kind: 'marquee', pointerId: event.pointerId, start: client, current: client };
  } else {
    const wasSelected = selection.includes(hit.node.id);
    const next = updateSelection(selection, hit.node.id, event.shiftKey ? 'toggle' : wasSelected ? 'add' : 'replace');
    setSelection(next);
    const root = design.pages.find((item) => item.id === currentPageId)!.root;
    if (next.includes(hit.node.id) && hit.node.id !== root.id && !hit.node.locked) {
      const location = findNode(design, hit.node.id)!;
      const parentMatrix = parentWorldMatrix(location);
      gesture = { kind: 'drag', pointerId: event.pointerId, hit, parentMatrix, draft: createDragDraft(hit.node, parentMatrix, design.revision, client, rect, viewport), moved: false };
    }
  }
  canvasScroll.dataset.mode = gesture?.kind === 'drag' ? 'dragging' : '';
});

canvas.addEventListener('pointermove', (event) => {
  if (!gesture || gesture.pointerId !== event.pointerId || !design) return;
  const client = { x: event.clientX, y: event.clientY };
  if (gesture.kind === 'pan') {
    const delta = { x: client.x - gesture.last.x, y: client.y - gesture.last.y };
    Object.assign(viewport, panViewportBy(viewport, delta));
    gesture.last = client;
    renderCanvas(); updateZoomLabel();
  } else if (gesture.kind === 'drag') {
    const next = updateDragDraft(gesture.draft, client, canvas.getBoundingClientRect(), viewport, gesture.parentMatrix);
    gesture.moved ||= Math.abs(next.delta.x) > 0.01 || Math.abs(next.delta.y) > 0.01;
    gesture.draft = next;
    renderCanvas();
  } else if (gesture.kind === 'resize') {
    const location = findNode(design, gesture.nodeId);
    if (!location) return;
    const local = transformPoint(invertMatrix(gesture.nodeMatrix), clientToWorld(client, canvas.getBoundingClientRect(), viewport));
    const left = gesture.handle === 0 || gesture.handle === 3, top = gesture.handle === 0 || gesture.handle === 1;
    const dragX = left ? 0 : gesture.startBounds.width, dragY = top ? 0 : gesture.startBounds.height;
    const fixedX = left ? gesture.startBounds.width : 0, fixedY = top ? gesture.startBounds.height : 0;
    const width = Math.max(1, left ? fixedX - (dragX + local.x - gesture.startPointer.x) : (dragX + local.x - gesture.startPointer.x) - fixedX);
    const height = Math.max(1, top ? fixedY - (dragY + local.y - gesture.startPointer.y) : (dragY + local.y - gesture.startPointer.y) - fixedY);
    const anchorX = left ? width : 0, anchorY = top ? height : 0;
    const centerX = width / 2, centerY = height / 2;
    const radians = location.node.transform.rotation * Math.PI / 180;
    const scaledX = (anchorX - centerX) * location.node.transform.scaleX;
    const scaledY = (anchorY - centerY) * location.node.transform.scaleY;
    const rotatedX = Math.cos(radians) * scaledX - Math.sin(radians) * scaledY;
    const rotatedY = Math.sin(radians) * scaledX + Math.cos(radians) * scaledY;
    const bounds = { x: gesture.fixedParent.x - centerX - rotatedX, y: gesture.fixedParent.y - centerY - rotatedY, width, height };
    gesture.moved ||= Math.abs(bounds.x - gesture.startBounds.x) > 0.01 || Math.abs(bounds.y - gesture.startBounds.y) > 0.01 || Math.abs(width - gesture.startBounds.width) > 0.01 || Math.abs(height - gesture.startBounds.height) > 0.01;
    gesture.bounds = bounds;
    renderCanvas();
  } else {
    gesture.current = client;
    renderCanvas();
  }
});

async function finishGesture(event: PointerEvent, cancel = false): Promise<void> {
  const active = gesture;
  if (!active || active.pointerId !== event.pointerId || !design) return;
  gesture = null;
  canvasScroll.dataset.mode = '';
  try {
    if (active.kind === 'drag' && active.moved && !cancel) {
      const commit = commitDragDraft(active.draft);
      await execute([{ type: 'update', nodeId: commit.nodeId, patch: { bounds: commit.to } }]);
    } else if (active.kind === 'resize' && active.moved && !cancel) {
      await execute([{ type: 'update', nodeId: active.nodeId, patch: { bounds: active.bounds } }]);
    } else if (active.kind === 'marquee' && !cancel) {
      const rect = { x: Math.min(active.start.x, active.current.x), y: Math.min(active.start.y, active.current.y), width: Math.abs(active.current.x - active.start.x), height: Math.abs(active.current.y - active.start.y) };
      if (rect.width > 4 || rect.height > 4) {
        const hits = nodesIntersectingClientRect(design, currentPageId, rect, canvas.getBoundingClientRect(), viewport, { includeFrames: false });
        setSelection(hits.map((item) => item.node.id));
      }
    }
  } catch (error) { reportError(error); }
  renderCanvas();
}

canvas.addEventListener('pointerup', (event) => { void finishGesture(event); });
canvas.addEventListener('pointercancel', (event) => { void finishGesture(event, true); });
canvas.addEventListener('lostpointercapture', (event) => { if (gesture?.pointerId === event.pointerId) void finishGesture(event as PointerEvent, true); });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  Object.assign(viewport, zoomViewportAt(viewport, anchor, Math.exp(-event.deltaY * 0.001)));
  renderCanvas(); updateZoomLabel();
}, { passive: false });

function updateZoomLabel(): void { $('#zoom-value').textContent = `${Math.round(viewport.zoom * 100)}%`; }
$('#zoom-in').addEventListener('click', () => { const rect = canvas.getBoundingClientRect(); Object.assign(viewport, zoomViewportAt(viewport, { x: rect.width / 2, y: rect.height / 2 }, 1.2)); renderCanvas(); updateZoomLabel(); });
$('#zoom-out').addEventListener('click', () => { const rect = canvas.getBoundingClientRect(); Object.assign(viewport, zoomViewportAt(viewport, { x: rect.width / 2, y: rect.height / 2 }, 1 / 1.2)); renderCanvas(); updateZoomLabel(); });
$('#zoom-value').addEventListener('click', fitDocument);

document.querySelectorAll<HTMLButtonElement>('[data-create]').forEach((button) => button.addEventListener('click', () => {
  activeCreateTool = button.dataset.create as DesignNode['type'];
  document.querySelectorAll('.tool').forEach((tool) => tool.classList.remove('active'));
  button.classList.add('active');
}));
document.querySelector('[data-tool="select"]')!.addEventListener('click', () => {
  activeCreateTool = 'select';
  document.querySelectorAll('.tool').forEach((tool) => tool.classList.remove('active'));
  document.querySelector('[data-tool="select"]')!.classList.add('active');
});
$('#add-node').addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  const centerClient = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  void createAtClient('rectangle', centerClient).catch(reportError);
});

function selectedNode(): DesignNode | null {
  const current = assertLoaded();
  return selection.length === 1 ? findNode(current, selection[0]!)?.node ?? null : null;
}

function updateGeometry(): void {
  const node = selectedNode();
  if (!node) return;
  const values = { x: Number($<HTMLInputElement>('#property-x').value), y: Number($<HTMLInputElement>('#property-y').value), width: Number($<HTMLInputElement>('#property-width').value), height: Number($<HTMLInputElement>('#property-height').value) };
  if (!Object.values(values).every(Number.isFinite) || values.width <= 0 || values.height <= 0) { renderInspector(); return; }
  const rotation = Number($<HTMLInputElement>('#property-rotation').value);
  const bounds = { ...node.bounds, ...values };
  const transform = Number.isFinite(rotation) ? { ...node.transform, rotation } : node.transform;
  const commands: EditorCommand[] = [];
  if (JSON.stringify(bounds) !== JSON.stringify(node.bounds)) commands.push({ type: 'update', nodeId: node.id, patch: { bounds } });
  if (JSON.stringify(transform) !== JSON.stringify(node.transform)) commands.push({ type: 'update', nodeId: node.id, patch: { transform } });
  if (node.type === 'rectangle') {
    const radius = Math.max(0, Number($<HTMLInputElement>('#property-radius').value));
    if (Number.isFinite(radius) && radius !== (typeof node.radius === 'number' ? node.radius : node.radius.fallback)) commands.push({ type: 'update', nodeId: node.id, patch: { radius } });
  }
  if (commands.length) void execute(commands).catch(reportError);
}

for (const selector of ['#property-x', '#property-y', '#property-width', '#property-height', '#property-rotation', '#property-radius']) $(selector).addEventListener('change', updateGeometry);
$('#property-name').addEventListener('change', () => { const node = selectedNode(); if (node) void execute([{ type: 'update', nodeId: node.id, patch: { name: ($('#property-name') as HTMLInputElement).value || '未命名图层' } }]).catch(reportError); });

function updatedStyle(node: DesignNode, patch: Partial<DesignNode['style']>): DesignNode['style'] { return { ...node.style, ...patch }; }
$('#property-fill').addEventListener('change', () => {
  const node = selectedNode(); if (!node) return;
  const color = ($('#property-fill') as HTMLInputElement).value;
  if (node.type === 'text') {
    void execute([{ type: 'update', nodeId: node.id, patch: { typography: { ...node.typography, color } } }]).catch(reportError);
    return;
  }
  const fills = [...node.style.fills];
  if (fills[0]?.type === 'solid') fills[0] = { type: 'solid', color };
  else fills.unshift({ type: 'solid', color });
  void execute([{ type: 'update', nodeId: node.id, patch: { style: updatedStyle(node, { fills }) } }]).catch(reportError);
});
$('#toggle-fill').addEventListener('click', () => {
  const node = selectedNode(); if (!node) return;
  const fills = node.style.fills.length ? [] : [{ type: 'solid' as const, color: '#AFC1AE' }];
  void execute([{ type: 'update', nodeId: node.id, patch: { style: updatedStyle(node, { fills }) } }]).catch(reportError);
});
$('#property-opacity').addEventListener('input', () => {
  const node = selectedNode(); if (!node) return;
  const opacity = Number(($('#property-opacity') as HTMLInputElement).value) / 100;
  $('#opacity-value').textContent = `${Math.round(opacity * 100)}%`;
});
$('#property-opacity').addEventListener('change', () => {
  const node = selectedNode(); if (!node) return;
  const opacity = Number(($('#property-opacity') as HTMLInputElement).value) / 100;
  void execute([{ type: 'update', nodeId: node.id, patch: { style: updatedStyle(node, { opacity }) } }]).catch(reportError);
});

function flushTextEdit(): Promise<boolean> {
  if (textFlushPromise) return textFlushPromise;
  const operation = (async (): Promise<boolean> => {
  if (textInputTimer) clearTimeout(textInputTimer);
  textInputTimer = null;
  const node = selectedNode();
  if (!node || node.type !== 'text') return true;
  const textValue = ($('#property-text') as HTMLTextAreaElement).value;
  const size = Number(($('#property-font-size') as HTMLInputElement).value);
  const weight = Number(($('#property-font-weight') as HTMLSelectElement).value);
  const color = ($('#property-text-color') as HTMLInputElement).value;
  const typography = { ...node.typography, ...(Number.isFinite(size) && size > 0 ? { fontSize: size } : {}), ...(Number.isFinite(weight) ? { fontWeight: weight } : {}), color };
  const commands: EditorCommand[] = [];
  if (textValue !== node.text) commands.push({ type: 'update', nodeId: node.id, patch: { text: textValue } });
  if (JSON.stringify(typography) !== JSON.stringify(node.typography)) commands.push({ type: 'update', nodeId: node.id, patch: { typography } });
  if (commands.length) {
    try { return !!(await execute(commands)); }
    catch (error) { reportError(error); return false; }
  }
  return true;
  })();
  textFlushPromise = operation;
  void operation.then(() => { if (textFlushPromise === operation) textFlushPromise = null; }, () => { if (textFlushPromise === operation) textFlushPromise = null; });
  return operation;
}
for (const selector of ['#property-text', '#property-font-size', '#property-font-weight', '#property-text-color']) $(selector).addEventListener('input', () => {
  const node = selectedNode();
  if (node?.type === 'text') {
    if (selector === '#property-text') { if (textInputTimer) clearTimeout(textInputTimer); textInputTimer = setTimeout(flushTextEdit, 500); }
    else renderCanvas();
  }
});
for (const selector of ['#property-text', '#property-font-size', '#property-font-weight', '#property-text-color']) $(selector).addEventListener('change', flushTextEdit);
$('#property-text-color').addEventListener('input', () => { $('#text-color-label').textContent = ($('#property-text-color') as HTMLInputElement).value.toUpperCase(); });
$('#property-icon').addEventListener('change', () => { const node = selectedNode(); if (node?.type === 'icon') void execute([{ type: 'update', nodeId: node.id, patch: { iconKey: ($('#property-icon') as HTMLSelectElement).value as Extract<DesignNode, { type: 'icon' }>['iconKey'] } }]).catch(reportError); });
$('#property-clip').addEventListener('change', () => { const node = selectedNode(); if (node?.type === 'frame') void execute([{ type: 'update', nodeId: node.id, patch: { clipContent: ($('#property-clip') as HTMLInputElement).checked } }]).catch(reportError); });
$('#toggle-visible').addEventListener('click', () => { const node = selectedNode(); if (node) void execute([{ type: 'update', nodeId: node.id, patch: { visible: !node.visible } }]).catch(reportError); });
$('#toggle-locked').addEventListener('click', () => { const node = selectedNode(); if (node) void execute([{ type: 'update', nodeId: node.id, patch: { locked: !node.locked } }]).catch(reportError); });

$('#document-title').addEventListener('change', () => {
  const current = assertLoaded();
  const title = ($('#document-title') as HTMLInputElement).value.trim();
  if (!title) { ($('#document-title') as HTMLInputElement).value = current.title; return; }
  if (title !== current.title) void execute([{ type: 'rename-document', title }]).catch(reportError);
});

$('#undo').addEventListener('click', async () => {
  const context = captureOperationContext();
  if (!context || !design) return;
  try {
    setSaveStatus('saving', '正在撤销…');
    const response = await window.miaoma.studio.undo({ ...bridgeContext(context), baseRevision: design.revision });
    if (!isCurrentOperationContext(context)) return;
    commitMutation(throwIfFailure(response));
  }
  catch (error) { if (isCurrentOperationContext(context)) reportError(error); }
});
$('#redo').addEventListener('click', async () => {
  const context = captureOperationContext();
  if (!context || !design) return;
  try {
    setSaveStatus('saving', '正在重做…');
    const response = await window.miaoma.studio.redo({ ...bridgeContext(context), baseRevision: design.revision });
    if (!isCurrentOperationContext(context)) return;
    commitMutation(throwIfFailure(response));
  }
  catch (error) { if (isCurrentOperationContext(context)) reportError(error); }
});
$('#save').addEventListener('click', async () => {
  const context = captureOperationContext();
  if (!context) return;
  try {
    if (textInputTimer && !(await flushTextEdit())) return;
    if (!isCurrentOperationContext(context)) return;
    setSaveStatus('saving', '正在写入快照…');
    const response = await window.miaoma.studio.save(bridgeContext(context));
    if (!isCurrentOperationContext(context)) return;
    const result = throwIfFailure(response);
    durableRevision = result.revision;
    setSaveStatus('saved', `已保存 · r${result.revision}`);
    showToast('设计快照已保存');
  } catch (error) { if (isCurrentOperationContext(context)) reportError(error); }
});

function loadAssetImage(assetId: string, dataUrl: string): Promise<void> {
  assetDataUrls[assetId] = dataUrl;
  const image = imageForAsset(assetId) ?? imageCache.get(assetId);
  if (!image) return Promise.reject(new Error('PNG 图片无法解码'));
  if (image.complete) return image.naturalWidth > 0 ? Promise.resolve() : Promise.reject(new Error('PNG 图片无法解码'));
  return new Promise((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => reject(new Error('PNG 图片无法解码')), { once: true });
  });
}

$('#import-image').addEventListener('click', () => ($('#image-file') as HTMLInputElement).click());
$('#image-file').addEventListener('change', async () => {
  const input = $('#image-file') as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const context = captureOperationContext();
  if (!file || !design || !context) return;
  if (imageImportPending) { showToast('请等待当前图片导入完成', true); return; }
  const baseRevision = design.revision;
  if (file.type !== 'image/png' || file.size > 25 * 1024 * 1024) { showToast('请选择小于 25 MiB 的 PNG 文件', true); return; }
  imageImportPending = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrentOperationContext(context)) return;
    setSaveStatus('saving', '正在检查图片尺寸…');
    const preflight = throwIfFailure(await window.miaoma.studio.preflightPng({ ...bridgeContext(context), baseRevision, bytes }));
    if (!isCurrentOperationContext(context)) return;
    await validatePngDecodable(bytes, preflight);
    if (!isCurrentOperationContext(context)) return;
    setSaveStatus('saving', '正在导入图片…');
    const response = await window.miaoma.studio.importPng({ ...bridgeContext(context), baseRevision, name: file.name, bytes });
    if (!isCurrentOperationContext(context)) return;
    const result = throwIfFailure(response);
    let previewFailed = false;
    if (result.asset) {
      try { await loadAssetImage(result.asset.id, result.asset.dataUrl); }
      catch {
        delete assetDataUrls[result.asset.id];
        imageCache.delete(result.asset.id);
        previewFailed = true;
      }
      if (!isCurrentOperationContext(context)) { delete assetDataUrls[result.asset.id]; imageCache.delete(result.asset.id); return; }
    }
    commitMutation(result);
    if (result.asset) setSelection([result.asset.nodeId]);
    showToast(previewFailed ? 'PNG 已保存，但预览暂时无法解码' : 'PNG 已作为图层导入，资产与设计已保存', previewFailed);
  } catch (error) { if (isCurrentOperationContext(context)) reportError(error); }
  finally { imageImportPending = false; }
});

async function validatePngDecodable(bytes: Uint8Array, expected: { width: number; height: number }): Promise<void> {
  if (typeof createImageBitmap !== 'function') throw new Error('当前运行环境无法验证 PNG 解码');
  const stableBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stableBuffer).set(bytes);
  const bitmap = await createImageBitmap(new Blob([stableBuffer], { type: 'image/png' }));
  try {
    if (bitmap.width !== expected.width || bitmap.height !== expected.height) throw new Error('PNG 解码尺寸与文件头声明不一致');
  } finally { bitmap.close(); }
}

function renderExportCanvas(documentModel: DesignDocument, pageId: string, scale: number): HTMLCanvasElement {
  const page = documentModel.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error('当前页面不存在');
  const width = Math.ceil(page.root.bounds.width * scale), height = Math.ceil(page.root.bounds.height * scale);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('PNG 导出尺寸必须在 1 到 4096 像素之间');
  const output = document.createElement('canvas');
  output.width = width; output.height = height;
  const context = output.getContext('2d');
  if (!context) throw new Error('无法创建 PNG 导出画布');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  drawNode(context, documentModel, page.root, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, scale, { x: 0, y: 0 }, new Map());
  return output;
}

$('#export-png').addEventListener('click', async () => {
  const context = captureOperationContext();
  if (!design || !context) return;
  try {
    if (textInputTimer && !(await flushTextEdit())) return;
    if (!isCurrentOperationContext(context) || !design) return;
    const exportDocument = design;
    const exportRevision = exportDocument.revision;
    const scale = Number(($('#export-scale') as HTMLSelectElement).value);
    const page = exportDocument.pages.find((candidate) => candidate.id === currentPageId)!;
    const width = Math.ceil(page.root.bounds.width * scale), height = Math.ceil(page.root.bounds.height * scale);
    if (width > 4096 || height > 4096) throw new Error(`所选倍率会生成 ${width} × ${height} PNG，超过 4096px 上限`);
    setSaveStatus('saving', '正在渲染 PNG…');
    delete $('#export-message').dataset.exportPath;
    await Promise.all(Object.keys(assetDataUrls).map((assetId) => {
      const image = imageForAsset(assetId);
      if (!image) return Promise.reject(new Error(`图像资产无法读取：${assetId}`));
      return image.complete && image.naturalWidth > 0 ? Promise.resolve() : new Promise<void>((resolve, reject) => { image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => reject(new Error(`图像资产无法解码：${assetId}`)), { once: true }); });
    }));
    if (!isCurrentOperationContext(context)) return;
    const exportCanvas = renderExportCanvas(exportDocument, page.id, scale);
    const blob = await new Promise<Blob>((resolve, reject) => exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const response = await window.miaoma.studio.exportPng({ ...bridgeContext(context), baseRevision: exportRevision, pageId: page.id, width, height, scale, bytes });
    if (!isCurrentOperationContext(context)) return;
    const result = throwIfFailure(response);
    setSaveStatus('saved', `已保存 · r${exportRevision}`);
    $('#export-message').dataset.exportPath = result.exportPath;
    $('#export-message').textContent = `${result.width} × ${result.height} · ${result.exportPath}`;
    showToast(`PNG 已导出：${result.width} × ${result.height}`);
  } catch (error) { if (isCurrentOperationContext(context)) reportError(error); }
});

function isTextEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
}

function moveSelected(direction: 'left' | 'right' | 'up' | 'down', large: boolean): void {
  if (!design || selection.length === 0) return;
  const delta = keyboardNudgeDelta(direction, large);
  const commands: EditorCommand[] = [];
  const rootId = design.pages.find((page) => page.id === currentPageId)!.root.id;
  for (const id of topmostSelectedNodeIds(design)) {
    if (id === rootId) continue;
    const location = findNode(design, id);
    if (!location || location.node.locked) continue;
    const matrix = parentWorldMatrix(location);
    const origin = transformPoint(invertMatrix(matrix), { x: 0, y: 0 });
    const vectorEnd = transformPoint(invertMatrix(matrix), delta);
    const localDelta = { x: vectorEnd.x - origin.x, y: vectorEnd.y - origin.y };
    commands.push({ type: 'update', nodeId: id, patch: { bounds: { ...location.node.bounds, x: location.node.bounds.x + localDelta.x, y: location.node.bounds.y + localDelta.y } } });
  }
  if (commands.length) void execute(commands).catch(reportError);
}

document.addEventListener('keydown', (event) => {
  if (isTextEditing(event.target)) return;
  if (event.code === 'Space') { spaceHeld = true; if (event.target === canvas) event.preventDefault(); }
  const commandKey = event.ctrlKey || event.metaKey;
  if (commandKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    const button = event.shiftKey ? $('#redo') as HTMLButtonElement : $('#undo') as HTMLButtonElement;
    if (!button.disabled) button.click();
  } else if (commandKey && event.key.toLowerCase() === 'y') { event.preventDefault(); if (!($('#redo') as HTMLButtonElement).disabled) ($('#redo') as HTMLButtonElement).click(); }
  else if (event.key === 'Escape') {
    if (gesture) { const active = gesture; gesture = null; if (canvas.hasPointerCapture(active.pointerId)) canvas.releasePointerCapture(active.pointerId); renderCanvas(); }
    activeCreateTool = 'select'; document.querySelector('[data-tool="select"]')?.dispatchEvent(new MouseEvent('click'));
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    const current = assertLoaded(); const rootId = current.pages.find((page) => page.id === currentPageId)!.root.id;
    const commands = topmostSelectedNodeIds(current).filter((id) => id !== rootId && !!findNode(current, id)).map((nodeId) => ({ type: 'delete' as const, nodeId }));
    if (commands.length) { event.preventDefault(); void execute(commands).then((result) => { if (result) setSelection([]); }).catch(reportError); }
  } else if (event.key.startsWith('Arrow') && selection.length) {
    const direction = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'];
    if (direction) { event.preventDefault(); moveSelected(direction, event.shiftKey); }
  } else if (event.key.toLowerCase() === 'v') { activeCreateTool = 'select'; document.querySelector('[data-tool="select"]')?.dispatchEvent(new MouseEvent('click')); }
});
document.addEventListener('keyup', (event) => { if (event.code === 'Space') spaceHeld = false; });
window.addEventListener('blur', () => {
  spaceHeld = false;
  if (gesture) { gesture = null; canvasScroll.dataset.mode = ''; renderCanvas(); }
  if (textInputTimer) void flushTextEdit();
});
window.addEventListener('resize', () => { if (!initialFit) fitDocument(); else renderCanvas(); });

function applyStudioState(loaded: StudioState): void {
  resetGenerationSession();
  activeProjectId = loaded.projectId;
  document.body.dataset.projectId = loaded.projectId;
  document.body.dataset.documentId = loaded.document.documentId;
  contextGeneration++;
  projectTransitionPending = false;
  projectTransitionPreparing = false;
  setProjectButtonsDisabled(false);
  design = loaded.document;
  history = loaded.history;
  durableRevision = loaded.durableRevision;
  currentPageId = design.pages[0]!.id;
  $<HTMLInputElement>('#generation-title').value = design.title;
  $<HTMLTextAreaElement>('#generation-prompt').value = '';
  $<HTMLInputElement>('#generation-width').value = String(Math.max(64, Math.min(4096, Math.round(design.pages[0]!.root.bounds.width))));
  $<HTMLInputElement>('#generation-height').value = String(Math.max(64, Math.min(4096, Math.round(design.pages[0]!.root.bounds.height))));
  $<HTMLSelectElement>('#generation-provider').value = 'local-fake';
  setSelection([]);
  for (const key of Object.keys(assetDataUrls)) delete assetDataUrls[key];
  Object.assign(assetDataUrls, loaded.assetDataUrls);
  imageCache.clear();
  viewport.zoom = 1; viewport.panX = 0; viewport.panY = 0;
  initialFit = false;
  if (loaded.recovery.diagnostics.length || loaded.recovery.ignoredTailBytes) {
    const details = loaded.recovery.diagnostics.map((item) => item.message).join('；');
    showToast(details || `恢复了日志尾部 ${loaded.recovery.ignoredTailBytes} 字节`, true);
  } else if (loaded.recovery.replayedCommits > 0) showToast(`已从日志恢复 ${loaded.recovery.replayedCommits} 个已提交操作`);
  setSaveStatus('saved', `已保存 · r${durableRevision}`);
  renderEditor();
}

const generationStateLabels: Record<GenerationRunState, string> = {
  queued: '排队中', preparing: '准备中', designing: '设计中', assembling: '组装中', validating: '校验中',
  reviewing: '视觉审查中', repairing: '定点修复中', interrupted: '等待恢复', completed: '已完成', cancelled: '已取消', failed: '失败', conflict: '版本冲突', needs_review: '等待人工检查'
};
const generationEventLabels: Record<GenerationEvent['type'], string> = {
  stateChanged: '状态更新', regionPlanned: '区域已规划', regionStarted: '开始生成区域', regionDraft: '区域草稿更新',
  candidateReady: '候选稿已就绪', validationReported: '校验结果', agentAssigned: '已委派 Agent', agentStarted: 'Agent 开始执行',
  agentCandidateReady: 'Agent 候选已就绪', agentFailed: 'Agent 失败', snapshotReady: '截图已就绪', reviewStarted: '开始视觉审查',
  reviewCompleted: '视觉审查完成', repairDelegated: '已委派定点修复', patchProposed: 'Patch 候选已提出', patchCommitted: 'Patch 已提交',
  loopDecision: '审查决策', checkpointSaved: '检查点已保存', runInterrupted: 'Run 已中断', runResumed: 'Run 已恢复', warningsAccepted: '人工接受警告', error: '错误'
};

const generationAgentNames: Record<string, string> = {
  miaoma: 'Miaoma · 总控', newton: 'Newton · 首屏', tesla: 'Tesla · 品牌与分类', maxwell: 'Maxwell · 精选内容', curie: 'Curie · 品牌故事', faraday: 'Faraday · CTA 与页脚'
};

const generationAgentStateLabels: Record<string, string> = { idle: '空闲', planning: '规划中', delegating: '委派中', reviewing: '复审中', assembling: '组装中', queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const generationTaskStateLabels: Record<string, string> = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', blocked: '被阻塞', stale: '已过期' };
const generationQualityLabels: Record<string, string> = { pending: '等待审查', passed: '审查通过', issues_found: '发现问题', blocked: '存在阻断项', conflict: '版本冲突', accepted_warnings: '人工接受警告' };
const generationDecisionLabels: Record<string, string> = { pass: '通过', repair: '进入修复', needs_review: '需要人工检查', blocked: '阻断' };
const generationLoopStageLabels: Record<string, string> = { idle: '尚未开始', capturing: '截图中', reviewing: '视觉审查中', repairing: '定点修复中', completed: '已完成', needs_review: '等待人工检查', blocked: '已阻断', conflict: '版本冲突', interrupted: '等待恢复' };

function generationIsTerminal(state: GenerationRunState | null): boolean {
  return state !== null && ['interrupted', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review'].includes(state);
}

function showGenerationPanel(): void {
  if (!design || projectTransitionPending) return;
  generationPanelOpen = true;
  $('#generation-backdrop').hidden = false;
  const panel = $('#generation-panel');
  panel.hidden = false;
  panel.setAttribute('aria-modal', 'true');
  const page = design.pages.find((item) => item.id === currentPageId) ?? design.pages[0]!;
  const titleInput = $<HTMLInputElement>('#generation-title');
  if (!titleInput.value.trim()) titleInput.value = design.title;
  const widthInput = $<HTMLInputElement>('#generation-width');
  const heightInput = $<HTMLInputElement>('#generation-height');
  if (!widthInput.value) widthInput.value = String(Math.max(64, Math.min(4096, Math.round(page.root.bounds.width))));
  if (!heightInput.value) heightInput.value = String(Math.max(64, Math.min(4096, Math.round(page.root.bounds.height))));
  ensureGenerationSubscription();
  renderGenerationPanel();
  void refreshGenerationRuns();
  $<HTMLTextAreaElement>('#generation-prompt').focus();
}

function closeGenerationPanel(): void {
  generationPanelOpen = false;
  $('#generation-backdrop').hidden = true;
  $('#generation-panel').hidden = true;
  if (!generationRunId || generationIsTerminal(generationRunState)) {
    generationEventUnsubscribe?.();
    generationEventUnsubscribe = null;
  }
  ($('#open-generation-panel') as HTMLButtonElement).focus();
}

function resetGenerationSession(): void {
  if (generationPollTimer) clearTimeout(generationPollTimer);
  generationPollTimer = null;
  generationEventUnsubscribe?.();
  generationEventUnsubscribe = null;
  generationRunId = null;
  generationAttemptId = null;
  generationRunState = null;
  generationRunError = '';
  generationAfterSeq = 0;
  generationEvents = [];
  generationEventIds.clear();
  generationRuns = [];
  generationFormVersion++;
  generationPlanBusy = false;
  generationStartBusy = false;
  generationCancelBusy = false;
  generationApplyBusy = false;
  generationRequest = null;
  generationPlan = null;
  generationCandidate = null;
  generationCollaboration = null;
  generationLoop = null;
  generationReviewRound = 0;
  generationSelectedEvidenceId = null;
  generationEvidenceContent = null;
  generationEvidenceErrorId = null;
  generationEvidenceBusy = false;
  generationRunListBusy = false;
  generationResumeBusy = false;
  generationAcceptBusy = false;
  $<HTMLTextAreaElement>('#generation-warning-reason').value = '';
  generationSelectedTab = 'overview';
  generationFilterAgent = 'all';
  generationFilterTask = 'all';
  generationFilterRound = 'all';
  if (generationPreviewUrl) URL.revokeObjectURL(generationPreviewUrl);
  generationPreviewUrl = null;
  generationPreviewCandidateId = null;
  if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
  generationEvidenceUrl = null;
  generationConflictRevision = null;
  generationPanelError = '';
  generationPanelOpen = false;
  $('#generation-backdrop').hidden = true;
  $('#generation-panel').hidden = true;
  renderGenerationPanel();
}

function ensureGenerationSubscription(): void {
  if (generationEventUnsubscribe) return;
  generationEventUnsubscribe = window.miaoma.studio.subscribeGeneration((event) => {
    if (event.runId !== generationRunId || (generationAttemptId && event.attemptId !== generationAttemptId)) return;
    addGenerationEvent(event);
    if (event.type === 'stateChanged' && typeof event.payload.to === 'string') {
      const nextState = event.payload.to as GenerationRunState;
      if (Object.hasOwn(generationStateLabels, nextState)) generationRunState = nextState;
    }
    if (event.type === 'error') {
      const detail = generationEventDetail(event);
      generationRunError = detail;
    }
    if (event.type === 'runInterrupted') generationRunState = 'interrupted';
    if (event.type === 'runResumed' && typeof event.payload.resumedAttemptId === 'string') generationAttemptId = event.payload.resumedAttemptId;
    renderGenerationPanel();
  });
}

function setGenerationCandidate(candidate: GenerationCandidate | null): void {
  if (!candidate) {
    generationCandidate = null;
    generationConflictRevision = null;
    if (generationPreviewUrl) URL.revokeObjectURL(generationPreviewUrl);
    generationPreviewUrl = null;
    generationPreviewCandidateId = null;
    return;
  }
  if (generationPreviewCandidateId !== candidate.candidateId) {
    if (generationPreviewUrl) URL.revokeObjectURL(generationPreviewUrl);
    generationPreviewUrl = URL.createObjectURL(new Blob([candidate.previewSvg], { type: 'image/svg+xml' }));
    generationPreviewCandidateId = candidate.candidateId;
  }
  generationCandidate = candidate;
}

function generationPayloadText(payload: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 180);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function generationEventAgentId(event: GenerationEvent): string {
  return generationPayloadText(event.payload, ['agentId', 'ownerAgentId']);
}

function generationEventTaskId(event: GenerationEvent): string {
  return generationPayloadText(event.payload, ['taskId']);
}

function generationEventRound(event: GenerationEvent): string {
  const round = generationPayloadText(event.payload, ['reviewRound', 'repairRound', 'round']);
  return round ? `round-${round}` : 'unassigned';
}

function generationEventDetail(event: GenerationEvent): string {
  const payload = event.payload;
  const agentId = generationEventAgentId(event);
  const taskId = generationEventTaskId(event);
  const region = generationPayloadText(payload, ['regionName', 'name', 'regionId']);
  const status = generationPayloadText(payload, ['state', 'status', 'decision', 'quality', 'code']);
  const count = generationPayloadText(payload, ['issueCount', 'regionCount', 'changedNodeCount']);
  const reason = generationPayloadText(payload, ['reason']);
  const parts = [
    agentId ? generationAgentNames[agentId] ?? agentId : '',
    taskId ? `Task ${taskId}` : '', region, status, count, reason ? `理由：${reason}` : ''
  ].filter(Boolean);
  return safeRunText(parts.join(' · ')).slice(0, 260);
}

function syncGenerationFilter(select: HTMLSelectElement, values: string[], selected: string, label: (value: string) => string): string {
  const unique = [...new Set(values.filter(Boolean))].sort();
  const signature = JSON.stringify(unique);
  if (select.dataset.optionValues !== signature) {
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = '全部';
    select.append(all);
    for (const value of unique) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = safeRunText(label(value));
      select.append(option);
    }
    select.dataset.optionValues = signature;
  }
  const next = selected === 'all' || unique.includes(selected) ? selected : 'all';
  select.value = next;
  return next;
}

function addGenerationEvent(event: GenerationEvent): void {
  if (generationEventIds.has(event.eventId)) return;
  generationEventIds.add(event.eventId);
  generationEvents.push(event);
  generationEvents.sort((a, b) => a.seq - b.seq);
  if (generationEvents.length > 250) generationEvents.splice(0, generationEvents.length - 250);
  generationAfterSeq = Math.max(generationAfterSeq, event.seq);
  renderGenerationEvents();
}

function renderGenerationEvents(): void {
  const list = $('#generation-events');
  const agentFilter = $<HTMLSelectElement>('#generation-filter-agent');
  const taskFilter = $<HTMLSelectElement>('#generation-filter-task');
  const roundFilter = $<HTMLSelectElement>('#generation-filter-round');
  generationFilterAgent = syncGenerationFilter(agentFilter, generationEvents.map(generationEventAgentId), generationFilterAgent, (value) => generationAgentNames[value] ?? value);
  generationFilterTask = syncGenerationFilter(taskFilter, generationEvents.map(generationEventTaskId), generationFilterTask, (value) => value);
  generationFilterRound = syncGenerationFilter(roundFilter, generationEvents.map(generationEventRound), generationFilterRound, (value) => value === 'unassigned' ? '未标记轮次' : `Round ${value.slice(6)}`);
  const visibleEvents = generationEvents.filter((event) =>
    (generationFilterAgent === 'all' || generationEventAgentId(event) === generationFilterAgent)
    && (generationFilterTask === 'all' || generationEventTaskId(event) === generationFilterTask)
    && (generationFilterRound === 'all' || generationEventRound(event) === generationFilterRound)
  );
  const renderKey = `${generationRunId ?? ''}|${generationEvents.map((event) => event.eventId).join(',')}|${generationFilterAgent}|${generationFilterTask}|${generationFilterRound}`;
  if (renderKey === generationEventsRenderKey) return;
  generationEventsRenderKey = renderKey;
  list.replaceChildren();
  if (visibleEvents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'generation-event-empty';
    empty.textContent = generationEvents.length ? '当前筛选没有匹配事件' : '运行事件会显示在这里';
    list.append(empty);
    return;
  }
  for (const event of visibleEvents) {
    const item = document.createElement('li');
    item.className = `generation-event generation-event-${event.type}`;
    const time = document.createElement('time');
    const date = new Date(event.timestamp);
    time.textContent = Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString();
    const content = document.createElement('span');
    const detail = generationEventDetail(event);
    const safeType = generationEventLabels[event.type] ?? '运行事件';
    content.textContent = detail ? `${safeType} · ${detail}` : safeType;
    item.append(time, content);
    list.append(item);
  }
}

function appendGenerationPlanSection(parent: HTMLElement, title: string, content: string): void {
  const section = document.createElement('section');
  section.className = 'generation-plan-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = safeRunText(content);
  section.append(heading, body);
  parent.append(section);
}

function renderGenerationPlan(): void {
  const root = $('#generation-plan-content');
  root.replaceChildren();
  if (!generationPlan) {
    const placeholder = document.createElement('p');
    placeholder.className = 'generation-placeholder';
    placeholder.textContent = generationPlanBusy ? '正在分析提示词并整理页面计划…' : '先生成计划，检查页面分区、设计变量和验收标准，再启动 Run。';
    root.append(placeholder);
    return;
  }
  appendGenerationPlanSection(root, '计划摘要', generationPlan.summary);
  appendGenerationPlanSection(root, '页面用途', generationPlan.pagePurpose);

  const regions = document.createElement('section');
  regions.className = 'generation-plan-section';
  const regionsTitle = document.createElement('h4');
  regionsTitle.textContent = `页面分区 · ${generationPlan.regions.length}`;
  const regionList = document.createElement('ol');
  regionList.className = 'generation-plan-list';
  for (const region of [...generationPlan.regions].sort((a, b) => a.order - b.order)) {
    const item = document.createElement('li');
    const heading = document.createElement('b');
    heading.textContent = `${region.order + 1}. ${region.name}`;
    const brief = document.createElement('p');
    brief.textContent = `${region.minHeight}px 起 · ${safeRunText(region.brief)}`;
    item.append(heading, brief);
    regionList.append(item);
  }
  regions.append(regionsTitle, regionList);
  root.append(regions);

  if (generationPlan.tokens.length) {
    const tokens = document.createElement('section');
    tokens.className = 'generation-plan-section';
    const title = document.createElement('h4');
    title.textContent = `设计变量 · ${generationPlan.tokens.length}`;
    const list = document.createElement('ul');
    list.className = 'generation-inline-list';
    for (const token of generationPlan.tokens as DesignVariable[]) {
      const item = document.createElement('li');
      const description = token.description ? ` · ${token.description}` : '';
      item.textContent = `${token.type} · ${token.id} · ${String(token.value)}${description}`;
      list.append(item);
    }
    tokens.append(title, list);
    root.append(tokens);
  }
  if (generationPlan.dependencies.length) {
    const dependencies = document.createElement('section');
    dependencies.className = 'generation-plan-section';
    const title = document.createElement('h4');
    title.textContent = '分区依赖';
    const list = document.createElement('ul');
    list.className = 'generation-inline-list';
    for (const dependency of generationPlan.dependencies) {
      const item = document.createElement('li');
      item.textContent = `${dependency.from} → ${dependency.to}`;
      list.append(item);
    }
    dependencies.append(title, list);
    root.append(dependencies);
  }
  if (generationPlan.ownershipMap.length) {
    const ownership = document.createElement('section');
    ownership.className = 'generation-plan-section';
    const title = document.createElement('h4');
    title.textContent = '区域负责人';
    const list = document.createElement('ul');
    list.className = 'generation-inline-list';
    for (const item of generationPlan.ownershipMap) {
      const region = generationPlan.regions.find((entry) => entry.id === item.regionId);
      const row = document.createElement('li');
      row.textContent = `${region?.name ?? item.regionId} → ${generationAgentNames[item.agentId] ?? item.agentId}`;
      list.append(row);
    }
    ownership.append(title, list);
    root.append(ownership);
  }
  const criteria = document.createElement('section');
  criteria.className = 'generation-plan-section';
  const criteriaTitle = document.createElement('h4');
  criteriaTitle.textContent = '验收标准';
  const criteriaList = document.createElement('ul');
  criteriaList.className = 'generation-inline-list';
  for (const criterion of generationPlan.acceptanceCriteria) {
    const item = document.createElement('li');
    item.textContent = criterion;
    criteriaList.append(item);
  }
  criteria.append(criteriaTitle, criteriaList);
  root.append(criteria);
}

function renderGenerationCandidate(): void {
  const section = $('#generation-candidate');
  section.hidden = !generationCandidate;
  const applyButton = $('#generation-apply') as HTMLButtonElement;
  if (!generationCandidate) return;
  $('#generation-candidate-summary').textContent = safeRunText(generationCandidate.summary);
  $('#generation-candidate-revision').textContent = `候选基于 revision ${generationCandidate.baseRevision}`;
  const preview = $<HTMLImageElement>('#generation-preview-image');
  if (generationPreviewUrl && preview.src !== generationPreviewUrl) preview.src = generationPreviewUrl;
  if (generationPreviewUrl) preview.alt = `候选稿预览：${generationCandidate.summary}`;
  const candidateEligible = generationRunState === 'completed' && (generationLoop?.quality === 'passed' || generationLoop?.quality === 'accepted_warnings');
  applyButton.disabled = generationApplyBusy || generationAcceptBusy || !design || !candidateEligible;
  applyButton.title = candidateEligible ? '' : '通过视觉检查或接受非阻断警告后，才能应用候选稿';
  applyButton.textContent = generationApplyBusy ? '正在应用…' : '应用候选';
  const conflict = $('#generation-conflict');
  conflict.hidden = generationConflictRevision === null;
  if (generationConflictRevision !== null) {
    $('#generation-conflict-message').textContent = `候选基于 revision ${generationCandidate.baseRevision}，当前文档已到 revision ${generationConflictRevision}。选择如何处理：`;
    ($('#generation-replace') as HTMLButtonElement).disabled = generationApplyBusy || generationAcceptBusy || !design;
    ($('#generation-copy-variant') as HTMLButtonElement).disabled = generationApplyBusy || generationAcceptBusy || !design;
    renderGenerationDifference(design!, generationCandidate);
  }
}

type GenerationNodeLocation = { node: DesignNode; pageId: string; pageName: string; parentId: string; index: number };
type GenerationDiffItem = { state: '新增' | '删除' | '变更'; text: string };

function indexGenerationNodes(documentModel: DesignDocument): Map<string, GenerationNodeLocation> {
  const nodes = new Map<string, GenerationNodeLocation>();
  const visit = (node: DesignNode, pageId: string, pageName: string, parentId: string, index: number): void => {
    nodes.set(node.id, { node, pageId, pageName, parentId, index });
    if (node.type === 'frame') node.children.forEach((child, childIndex) => visit(child, pageId, pageName, node.id, childIndex));
  };
  for (const page of documentModel.pages) visit(page.root, page.id, page.name, '', 0);
  return nodes;
}

function stableGenerationValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableGenerationValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableGenerationValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function generationNodeDifferences(before: GenerationNodeLocation, after: GenerationNodeLocation): string[] {
  const left = before.node;
  const right = after.node;
  const fields: string[] = [];
  const changed = (a: unknown, b: unknown): boolean => stableGenerationValue(a) !== stableGenerationValue(b);
  if (left.type !== right.type) fields.push('图层类型');
  if (left.name !== right.name) fields.push('图层名称');
  if (changed(left.bounds, right.bounds)) fields.push('位置与尺寸');
  if (changed(left.transform, right.transform)) fields.push('旋转与缩放');
  if (changed(left.style, right.style)) fields.push('填充、描边或效果');
  if (left.visible !== right.visible || left.locked !== right.locked) fields.push('可见或锁定状态');
  if (before.pageId !== after.pageId || before.parentId !== after.parentId || before.index !== after.index) fields.push('所在页面或图层顺序');
  const commonKeys = new Set(['id', 'type', 'name', 'visible', 'locked', 'bounds', 'transform', 'style', 'children']);
  const specificLabels: Record<string, string> = {
    text: '文字内容', typography: '文字排版', sizing: '文字尺寸策略', radius: '圆角', iconKey: '图标', layout: '容器布局', clipContent: '内容裁切'
  };
  const specificKeys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => !commonKeys.has(key)));
  for (const key of specificKeys) if (changed((left as unknown as Record<string, unknown>)[key], (right as unknown as Record<string, unknown>)[key])) fields.push(specificLabels[key] ?? '结构属性');
  return [...new Set(fields)];
}

function clippedGenerationValue(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value);
  if (!text) return '空';
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function collectGenerationDifferences(current: DesignDocument, candidate: GenerationCandidate): { pages: GenerationDiffItem[]; nodes: GenerationDiffItem[]; tokens: GenerationDiffItem[]; assets: GenerationDiffItem[] } {
  const pages: GenerationDiffItem[] = [];
  const nodes: GenerationDiffItem[] = [];
  const tokens: GenerationDiffItem[] = [];
  const assets: GenerationDiffItem[] = [];
  if (current.title !== candidate.document.title) pages.push({ state: '变更', text: `文档标题：${current.title} → ${candidate.document.title}` });
  const oldPages = new Map(current.pages.map((page, index) => [page.id, { page, index }]));
  const newPages = new Map(candidate.document.pages.map((page, index) => [page.id, { page, index }]));
  for (const [id, entry] of oldPages) {
    const next = newPages.get(id);
    if (!next) pages.push({ state: '删除', text: `页面「${entry.page.name}」` });
    else {
      if (entry.page.name !== next.page.name) pages.push({ state: '变更', text: `页面名称：${entry.page.name} → ${next.page.name}` });
      if (entry.index !== next.index) pages.push({ state: '变更', text: `页面「${next.page.name}」顺序改变` });
    }
  }
  for (const [id, entry] of newPages) if (!oldPages.has(id)) pages.push({ state: '新增', text: `页面「${entry.page.name}」` });

  const oldNodes = indexGenerationNodes(current);
  const newNodes = indexGenerationNodes(candidate.document);
  for (const id of new Set([...oldNodes.keys(), ...newNodes.keys()])) {
    const before = oldNodes.get(id);
    const after = newNodes.get(id);
    if (!before && after) nodes.push({ state: '新增', text: `${after.node.type}「${after.node.name}」· ${after.pageName}（${id}）` });
    else if (before && !after) nodes.push({ state: '删除', text: `${before.node.type}「${before.node.name}」· ${before.pageName}（${id}）` });
    else if (before && after) {
      const changedFields = generationNodeDifferences(before, after);
      if (changedFields.length) {
        const label = `${after.node.type}「${after.node.name}」· ${after.pageName}（${id}）`;
        const textDelta = before.node.type === 'text' && after.node.type === 'text' && before.node.text !== after.node.text
          ? `；文字：${clippedGenerationValue(before.node.text)} → ${clippedGenerationValue(after.node.text)}` : '';
        nodes.push({ state: '变更', text: `${label}：${changedFields.join('、')}${textDelta}` });
      }
    }
  }

  const oldTokens = current.variables;
  const newTokens = candidate.document.variables;
  for (const id of new Set([...Object.keys(oldTokens), ...Object.keys(newTokens)])) {
    const before = oldTokens[id];
    const after = newTokens[id];
    if (!before && after) tokens.push({ state: '新增', text: `${after.type} Token「${id}」=${clippedGenerationValue(after.value)}` });
    else if (before && !after) tokens.push({ state: '删除', text: `${before.type} Token「${id}」` });
    else if (before && after && stableGenerationValue(before) !== stableGenerationValue(after)) {
      const details: string[] = [];
      if (before.type !== after.type) details.push(`类型 ${before.type} → ${after.type}`);
      if (stableGenerationValue(before.value) !== stableGenerationValue(after.value)) details.push(`值 ${clippedGenerationValue(before.value)} → ${clippedGenerationValue(after.value)}`);
      if (stableGenerationValue(before.modes ?? {}) !== stableGenerationValue(after.modes ?? {})) details.push('模式值改变');
      if (before.description !== after.description) details.push('说明改变');
      tokens.push({ state: '变更', text: `${after.type} Token「${id}」：${details.join('、')}` });
    }
  }

  const oldAssets = current.assets;
  const newAssets = candidate.document.assets;
  for (const id of new Set([...Object.keys(oldAssets), ...Object.keys(newAssets)])) {
    const before = oldAssets[id];
    const after = newAssets[id];
    if (!before && after) assets.push({ state: '新增', text: `图片「${id}」· ${after.mimeType} · ${after.byteSize} 字节` });
    else if (before && !after) assets.push({ state: '删除', text: `图片「${id}」· ${before.mimeType} · ${before.byteSize} 字节` });
    else if (before && after && stableGenerationValue(before) !== stableGenerationValue(after)) {
      const details: string[] = [];
      if (before.mimeType !== after.mimeType) details.push(`格式 ${before.mimeType} → ${after.mimeType}`);
      if (before.byteSize !== after.byteSize) details.push(`大小 ${before.byteSize} → ${after.byteSize} 字节`);
      if (before.sha256 !== after.sha256) details.push('图片内容改变');
      if (before.relativePath !== after.relativePath) details.push('存储路径改变');
      assets.push({ state: '变更', text: `图片「${id}」：${details.join('、')}` });
    }
  }
  return { pages, nodes, tokens, assets };
}

function appendGenerationDiffSection(root: HTMLElement, title: string, items: GenerationDiffItem[]): void {
  const section = document.createElement('section');
  section.className = 'generation-diff-changes';
  const heading = document.createElement('h5');
  heading.textContent = `${title}（${items.length}）`;
  const list = document.createElement('ul');
  for (const change of items.slice(0, 100)) {
    const item = document.createElement('li');
    item.className = `generation-diff-item is-${change.state === '新增' ? 'added' : change.state === '删除' ? 'removed' : 'changed'}`;
    item.textContent = `${change.state} · ${change.text}`;
    list.append(item);
  }
  if (items.length > 100) {
    const item = document.createElement('li');
    item.className = 'generation-diff-overflow';
    item.textContent = `另有 ${items.length - 100} 项未展开`;
    list.append(item);
  }
  if (!items.length) {
    const item = document.createElement('li');
    item.textContent = '没有差异';
    list.append(item);
  }
  section.append(heading, list);
  root.append(section);
}

function summarizeGenerationDocument(documentModel: DesignDocument): { pageCount: number; nodeCount: number; textCount: number; tokenCount: number } {
  let nodeCount = 0;
  let textCount = 0;
  const visit = (node: DesignNode): void => {
    nodeCount++;
    if (node.type === 'text') textCount++;
    if (node.type === 'frame') for (const child of node.children) visit(child);
  };
  for (const page of documentModel.pages) visit(page.root);
  return { pageCount: documentModel.pages.length, nodeCount, textCount, tokenCount: Object.keys(documentModel.variables).length };
}

function renderGenerationDifference(current: DesignDocument, candidate: GenerationCandidate): void {
  const root = $('#generation-diff-content');
  root.replaceChildren();
  const sides = [
    { title: `当前文档 · r${current.revision}`, summary: summarizeGenerationDocument(current), model: current },
    { title: `AI 候选 · 基于 r${candidate.baseRevision}`, summary: summarizeGenerationDocument(candidate.document), model: candidate.document }
  ];
  for (const sideData of sides) {
    const side = document.createElement('section');
    side.className = 'generation-diff-side';
    const heading = document.createElement('h5');
    heading.textContent = sideData.title;
    const metrics = document.createElement('p');
    metrics.textContent = `「${sideData.model.title}」· ${sideData.summary.pageCount} 页 · ${sideData.summary.nodeCount} 个图层（${sideData.summary.textCount} 个文本）· ${sideData.summary.tokenCount} 个 Token`;
    side.append(heading, metrics);
    root.append(side);
  }
  const differences = collectGenerationDifferences(current, candidate);
  const total = differences.pages.length + differences.nodes.length + differences.tokens.length + differences.assets.length;
  const summary = document.createElement('p');
  summary.className = 'generation-diff-summary';
  summary.textContent = total ? `发现 ${total} 项差异；下方列出页面、图层、Token 和图片资产的具体变化。` : '两个文档内容一致。';
  root.append(summary);
  appendGenerationDiffSection(root, '页面与标题', differences.pages);
  appendGenerationDiffSection(root, '图层变化', differences.nodes);
  appendGenerationDiffSection(root, 'Token 变化', differences.tokens);
  appendGenerationDiffSection(root, '图片资产变化', differences.assets);
}

function safeRunText(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[本地路径]')
    .replace(/\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\s"'<>]+)?/g, '[本地路径]')
    .replace(/(^|\s)\/(?:[^\s"'<>]+\/)+[^\s"'<>]*/g, '$1[本地路径]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[已隐藏]')
    .slice(0, 512);
}

function generationAgentName(agentId: string): string {
  return generationAgentNames[agentId] ?? agentId;
}

function generationRegionName(regionId: string): string {
  return generationPlan?.regions.find((region) => region.id === regionId)?.name ?? regionId;
}

function renderGenerationRunHistory(): void {
  const list = $('#generation-run-history');
  const renderKey = `${generationRunListBusy}|${generationResumeBusy}|${generationResumePreparing}|${generationAcceptBusy}|${generationApplyBusy}|${generationStartBusy}|${generationCancelBusy}|${generationRunId ?? ''}|${generationRuns.map((run) => `${run.runId}:${run.attemptId}:${run.state}:${run.candidateAvailable}`).join(',')}`;
  if (renderKey === generationRunHistoryRenderKey) return;
  generationRunHistoryRenderKey = renderKey;
  list.replaceChildren();
  if (generationRunListBusy) {
    const item = document.createElement('li');
    item.className = 'generation-event-empty';
    item.textContent = '正在读取最近运行…';
    list.append(item);
    return;
  }
  if (!generationRuns.length) {
    const item = document.createElement('li');
    item.className = 'generation-event-empty';
    item.textContent = '当前设计还没有已保存的运行记录。';
    list.append(item);
    return;
  }
  for (const run of generationRuns) {
    const item = document.createElement('li');
    item.className = 'generation-run-history-item';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'generation-run-history-select';
    select.disabled = generationResumeBusy || generationResumePreparing || generationAcceptBusy || generationApplyBusy || generationStartBusy || generationCancelBusy;
    select.setAttribute('aria-current', run.runId === generationRunId ? 'true' : 'false');
    const started = new Date(run.startedAt);
    const when = Number.isNaN(started.valueOf()) ? '' : started.toLocaleString();
    const title = document.createElement('span');
    title.textContent = `${generationStateLabels[run.state]} · ${when}`;
    const detail = document.createElement('small');
    detail.textContent = `Run ${run.runId} · 基于 r${run.baseRevision}${run.candidateAvailable ? ' · 有候选稿' : ''}`;
    select.append(title, detail);
    select.addEventListener('click', () => { void selectGenerationRun(run.runId); });
    item.append(select);
    if (run.state === 'interrupted') {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'secondary-button generation-history-resume';
      resume.textContent = '恢复';
      resume.disabled = generationResumeBusy || generationResumePreparing || generationAcceptBusy || generationApplyBusy || generationStartBusy || generationCancelBusy;
      resume.setAttribute('aria-label', `恢复中断的 Run ${run.runId}`);
      resume.addEventListener('click', () => { void resumeGenerationRunFromHistory(run.runId); });
      item.append(resume);
    }
    list.append(item);
  }
}

function renderGenerationCollaboration(): void {
  const state = generationCollaboration;
  const summary = $('#generation-capacity-summary');
  const capacity = $('#generation-run-capacity');
  const coordinator = $('#generation-coordinator');
  const agents = $('#generation-agent-list');
  const taskList = $('#generation-task-list');
  const dependencyList = $('#generation-dependency-list');
  coordinator.replaceChildren();
  agents.replaceChildren();
  taskList.replaceChildren();
  dependencyList.replaceChildren();
  $('#generation-task-count').textContent = String(state?.tasks.length ?? 0);

  if (!state) {
    summary.textContent = '等待协作快照';
    capacity.textContent = '并发 0 / 1';
    const empty = document.createElement('p');
    empty.className = 'generation-placeholder';
    empty.textContent = '当前 Run 尚未提供 Agent 任务快照。';
    coordinator.append(empty);
    const taskEmpty = document.createElement('li');
    taskEmpty.className = 'generation-event-empty';
    taskEmpty.textContent = '任务列表将在总控委派区域后显示。';
    taskList.append(taskEmpty);
  } else {
    summary.textContent = `区域执行中 ${state.activeCount} / ${state.maxParallel} · 排队 ${state.queuedCount}`;
    capacity.textContent = `并发 ${state.activeCount} / ${state.maxParallel}`;
    const coordinatorName = document.createElement('strong');
    coordinatorName.textContent = state.coordinator.displayName || generationAgentName('miaoma');
    const coordinatorState = document.createElement('span');
    coordinatorState.className = 'generation-agent-state';
    coordinatorState.textContent = generationAgentStateLabels[state.coordinator.state] ?? state.coordinator.state;
    const coordinatorCaption = document.createElement('p');
    coordinatorCaption.textContent = '统一规划、管理共享 Token、组装候选并决定质量闭环。';
    coordinator.append(coordinatorName, coordinatorState, coordinatorCaption);

    for (const agent of state.agents) {
      const card = document.createElement('article');
      card.className = 'generation-agent-card';
      const marker = document.createElement('span');
      marker.className = 'generation-agent-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(agent.color) ? agent.color : '#7d8795';
      const name = document.createElement('strong');
      name.textContent = agent.displayName || generationAgentName(agent.agentId);
      const status = document.createElement('span');
      status.className = 'generation-agent-state';
      status.textContent = generationAgentStateLabels[agent.state] ?? agent.state;
      const totals = document.createElement('small');
      totals.textContent = `完成 ${agent.completedTasks} · 失败 ${agent.failedTasks}`;
      card.append(marker, name, status, totals);
      if (agent.activeTaskId) {
        const active = document.createElement('small');
        active.textContent = `当前 Task ${agent.activeTaskId}`;
        card.append(active);
      }
      agents.append(card);
    }

    const taskCount = $('#generation-task-count');
    taskCount.textContent = String(state.tasks.length);
    for (const task of state.tasks.slice(0, 250)) {
      const item = document.createElement('li');
      item.className = 'generation-task-item';
      const heading = document.createElement('strong');
      const kind = task.taskKind === 'repair' ? `修复 Round ${task.round}` : '生成';
      heading.textContent = `${generationRegionName(task.regionId)} · ${kind}`;
      const status = document.createElement('span');
      status.className = 'generation-agent-state';
      status.textContent = generationTaskStateLabels[task.state] ?? task.state;
      const details = document.createElement('p');
      const dependencyNames = task.dependencies.map(generationRegionName);
      details.textContent = `${generationAgentName(task.agentId)} · namespace ${task.namespace} · 第 ${task.attempt} 次尝试${dependencyNames.length ? ` · 依赖 ${dependencyNames.join('、')}` : ''}`;
      const ownership = document.createElement('small');
      ownership.textContent = `授权节点 ${task.allowedNodeIds.length} · 关联问题 ${task.issueIds.length}${task.candidateHash ? ` · 候选 ${task.candidateHash.slice(0, 12)}…` : ''}`;
      item.append(heading, status, details, ownership);
      if (task.error) {
        const error = document.createElement('small');
        error.className = 'generation-run-error';
        error.textContent = `${task.error.code}: ${safeRunText(task.error.message)}`;
        item.append(error);
      }
      taskList.append(item);
    }
    if (state.tasks.length > 250) {
      const more = document.createElement('li');
      more.className = 'generation-event-empty';
      more.textContent = `另有 ${state.tasks.length - 250} 个任务未展开。`;
      taskList.append(more);
    } else if (!state.tasks.length) {
      const empty = document.createElement('li');
      empty.className = 'generation-event-empty';
      empty.textContent = '总控尚未委派区域任务。';
      taskList.append(empty);
    }
  }

  const plan = generationPlan;
  if (plan) {
    const owners = new Map(plan.ownershipMap.map((entry) => [entry.regionId, entry.agentId]));
    for (const region of [...plan.regions].sort((a, b) => a.order - b.order)) {
      const owner = owners.get(region.id);
      const dependencies = plan.dependencies.filter((item) => item.to === region.id).map((item) => generationRegionName(item.from));
      const item = document.createElement('li');
      item.textContent = `${region.order + 1}. ${region.name}${owner ? ` · ${generationAgentName(owner)}` : ' · 待分配'}${dependencies.length ? ` · 依赖 ${dependencies.join('、')}` : ''}`;
      dependencyList.append(item);
    }
    if (!plan.regions.length) {
      const empty = document.createElement('li');
      empty.textContent = '暂无区域计划。';
      dependencyList.append(empty);
    }
  } else if (state?.tasks.length) {
    const taskRegions = new Map(state.tasks.map((task) => [task.regionId, task]));
    for (const [regionId, task] of taskRegions) {
      const item = document.createElement('li');
      const dependencies = task.dependencies.map((id) => taskRegions.has(id) ? generationRegionName(id) : id);
      item.textContent = `${generationRegionName(regionId)} · ${generationAgentName(task.agentId)}${dependencies.length ? ` · 依赖 ${dependencies.join('、')}` : ''}`;
      dependencyList.append(item);
    }
  } else if (!state) {
    const empty = document.createElement('p');
    empty.className = 'generation-placeholder';
    empty.textContent = '生成计划后显示区域依赖与 Agent 归属。';
    dependencyList.append(empty);
  }
}

function renderGenerationLoop(): void {
  const loop = generationLoop;
  const stateLabel = $('#generation-quality-state');
  const summary = $('#generation-loop-summary');
  const reportRoot = $('#generation-review-report');
  const issueList = $('#generation-issue-list');
  const proposalList = $('#generation-proposal-list');
  const warningReasonPresent = !!$<HTMLTextAreaElement>('#generation-warning-reason').value.trim();
  const reports = loop?.reports ?? [];
  const evidenceList = loop?.evidence ?? [];
  const report = reports.find((entry) => entry.reviewRound === generationReviewRound) ?? null;
  const loopKey = `${generationRunId ?? ''}|${loop?.stage ?? ''}|${loop?.quality ?? ''}|${reports.map((entry) => `${entry.reportId}:${entry.revision}:${entry.decision}:${entry.issues.length}`).join(',')}|${loop?.proposals.map((entry) => `${entry.proposalId}:${entry.status}`).join(',') ?? ''}|${generationReviewRound}|${generationEvidenceBusy}|${generationEvidenceContent?.evidence.evidenceId ?? ''}|${generationEvidenceErrorId ?? ''}|reason:${warningReasonPresent}`;
  if (loopKey === generationLoopRenderKey) return;
  generationLoopRenderKey = loopKey;
  reportRoot.replaceChildren();
  issueList.replaceChildren();
  proposalList.replaceChildren();
  const roundTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-review-round]'));
  for (const tab of roundTabs) {
    const round = Number(tab.dataset.reviewRound);
    const exists = reports.some((entry) => entry.reviewRound === round);
    tab.disabled = !exists;
    tab.classList.toggle('is-active', round === generationReviewRound);
    tab.setAttribute('aria-pressed', round === generationReviewRound ? 'true' : 'false');
    const count = reports.find((entry) => entry.reviewRound === round)?.issues.length;
    tab.textContent = `${round === 0 ? '初检' : '复审'} ${round}${count === undefined ? '' : ` · ${count} 问题`}`;
  }

  if (!loop) {
    stateLabel.textContent = '等待审查';
    stateLabel.dataset.quality = 'pending';
    summary.textContent = '视觉 Harness 尚未提供 Loop 快照。';
  } else {
    stateLabel.textContent = generationQualityLabels[loop.quality] ?? loop.quality;
    stateLabel.dataset.quality = loop.quality;
    summary.textContent = `阶段：${generationLoopStageLabels[loop.stage] ?? loop.stage} · 已完成修复 ${loop.repairRound} / ${loop.maxRepairRounds} · 审查报告 ${reports.length} / 3${loop.checkpointId ? ` · 检查点 ${loop.checkpointId}` : ''}`;
  }
  $('#generation-issue-count').textContent = String(report?.issues.length ?? 0);

  if (!report) {
    const empty = document.createElement('p');
    empty.className = 'generation-placeholder';
    empty.textContent = loop ? `Round ${generationReviewRound} 暂无审查报告。` : '完成候选组装后，这里会显示截图证据、审查问题与修复轮次。';
    reportRoot.append(empty);
  } else {
    const decision = document.createElement('strong');
    decision.textContent = `Round ${report.reviewRound} · revision ${report.revision} · ${generationDecisionLabels[report.decision] ?? report.decision}`;
    const details = document.createElement('p');
    const date = new Date(report.createdAt);
    details.textContent = `结构校验：${report.structurePassed ? '通过' : '未通过'} · ${report.issues.length} 个问题 · ${Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()}`;
    const evidenceButton = document.createElement('button');
    evidenceButton.type = 'button';
    evidenceButton.className = 'secondary-button generation-evidence-open';
    evidenceButton.textContent = '查看本轮绑定截图';
    evidenceButton.disabled = !evidenceList.some((entry) => entry.evidenceId === report.evidenceId) || generationEvidenceBusy;
    evidenceButton.addEventListener('click', () => { void loadGenerationEvidence(report.evidenceId); });
    reportRoot.append(decision, details, evidenceButton);

    for (const issue of report.issues) {
      const item = document.createElement('li');
      item.className = `generation-issue generation-issue-${issue.severity}`;
      const issueHeading = document.createElement('strong');
      issueHeading.textContent = safeRunText(`${issue.severity === 'blocker' ? '阻断' : issue.severity === 'warning' ? '警告' : '提示'} · ${issue.category} · ${issue.summary}`);
      const issueDetails = document.createElement('p');
      issueDetails.textContent = safeRunText(`${issue.message} · ${issue.status === 'open' ? '未解决' : issue.status === 'resolved' ? '已解决' : '回归'} · 首次出现在 Round ${issue.firstSeenRound}`);
      const location = document.createElement('small');
      const bounds = issue.bounds ? ` · 区域 x${issue.bounds.x}, y${issue.bounds.y}, ${issue.bounds.width} × ${issue.bounds.height}` : '';
      location.textContent = `节点 ${issue.nodeIds.join(', ') || '未关联'}${bounds}${issue.ownerAgentId ? ` · 负责人 ${generationAgentName(issue.ownerAgentId)}` : ''}`;
      item.append(issueHeading, issueDetails, location);
      const target = issue.nodeIds.find((id) => !!design && !!findNode(design, id));
      if (target) {
        const locate = document.createElement('button');
        locate.type = 'button';
        locate.className = 'text-action generation-issue-locate';
        locate.textContent = '在画布中选择相关图层';
        locate.addEventListener('click', () => {
          if (!design) return;
          const ids = issue.nodeIds.filter((id) => !!findNode(design!, id));
          const page = design.pages.find((entry) => {
            let found = false;
            const visit = (node: DesignNode): void => {
              if (ids.includes(node.id)) found = true;
              if (node.type === 'frame') for (const child of node.children) visit(child);
            };
            visit(entry.root);
            return found;
          });
          if (page) currentPageId = page.id;
          setSelection(ids);
          closeGenerationPanel();
          canvas.focus();
        });
        item.append(locate);
      }
      issueList.append(item);
    }
    if (!report.issues.length) {
      const passed = document.createElement('li');
      passed.className = 'generation-event-empty';
      passed.textContent = '本轮未发现问题。';
      issueList.append(passed);
    }
    $('#generation-issue-count').textContent = String(report.issues.length);
  }

  if (loop) {
    for (const proposal of loop.proposals) {
      const item = document.createElement('li');
      const heading = document.createElement('strong');
      heading.textContent = `修复 Round ${proposal.repairRound} · ${generationAgentName(proposal.ownerAgentId)} · ${proposal.status}`;
      const changed = document.createElement('p');
      changed.textContent = `revision ${proposal.expectedRevision} · 授权 ${proposal.allowedNodeIds.length} 节点 · Patch ${proposal.updates.length} 项（${proposal.updates.map((update) => `${update.nodeId}: ${Object.keys(update.patch).join('、')}`).join('；')}）`;
      const result = document.createElement('small');
      result.textContent = proposal.decision ? safeRunText(proposal.decision) : `关联问题 ${proposal.issueIds.join(', ')}`;
      item.append(heading, changed, result);
      proposalList.append(item);
    }
  }
  if (!proposalList.childElementCount) {
    const empty = document.createElement('li');
    empty.className = 'generation-event-empty';
    empty.textContent = '尚无定点修复 Patch。';
    proposalList.append(empty);
  }

  const expectedEvidence = report?.evidenceId ?? null;
  if (expectedEvidence !== generationSelectedEvidenceId) {
    generationSelectedEvidenceId = expectedEvidence;
    generationEvidenceContent = null;
    generationEvidenceErrorId = null;
    if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
    generationEvidenceUrl = null;
  }
  if (expectedEvidence && evidenceList.some((entry) => entry.evidenceId === expectedEvidence) && !generationEvidenceContent && !generationEvidenceBusy && generationEvidenceErrorId !== expectedEvidence) void loadGenerationEvidence(expectedEvidence);

  const image = $<HTMLImageElement>('#generation-evidence-image');
  const placeholder = $('#generation-evidence-placeholder');
  if (generationEvidenceContent && generationEvidenceUrl) {
    image.hidden = false;
    image.src = generationEvidenceUrl;
    image.alt = `视觉审查截图：Round ${generationEvidenceContent.evidence.reviewRound}，revision ${generationEvidenceContent.evidence.revision}`;
    placeholder.hidden = true;
    const evidence = generationEvidenceContent.evidence;
    $('#generation-evidence-meta').textContent = `Round ${evidence.reviewRound} · revision ${evidence.revision} · ${evidence.width} × ${evidence.height} @${evidence.scale}× · 字体${evidence.fontsReady ? '就绪' : '未就绪'} · 资产${evidence.assetStatus === 'ready' ? '就绪' : '缺失'} · SHA ${evidence.imageHash.slice(0, 16)}…`;
  } else {
    image.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = generationEvidenceBusy ? '正在读取截图证据…' : expectedEvidence ? '此轮截图证据暂不可用。' : '选择一轮查看与该报告绑定的截图。';
    $('#generation-evidence-meta').textContent = '';
  }

  const unresolvedBlocker = !!report?.issues.some((issue) => issue.severity === 'blocker' && issue.status !== 'resolved');
  const unresolvedWarning = !!report?.issues.some((issue) => issue.severity === 'warning' && issue.status !== 'resolved');
  const latestReport = reports.at(-1) ?? null;
  const latestHasBlocker = !!latestReport?.issues.some((issue) => issue.severity === 'blocker' && issue.status !== 'resolved');
  const latestHasWarning = !!latestReport?.issues.some((issue) => issue.severity === 'warning' && issue.status !== 'resolved');
  const latestReportSelected = report?.reportId === latestReport?.reportId;
  const latestEvidenceViewed = !!latestReport && generationEvidenceContent?.evidence.evidenceId === latestReport.evidenceId;
  const warningReason = $<HTMLTextAreaElement>('#generation-warning-reason');
  const acceptance = $('#generation-warning-acceptance');
  acceptance.hidden = (loop?.stage !== 'needs_review' && loop?.stage !== 'blocked') || (!latestHasBlocker && !latestHasWarning);
  const accept = $<HTMLButtonElement>('#generation-accept-warnings');
  accept.disabled = generationAcceptBusy || generationRunState !== 'needs_review' || !latestHasWarning || latestHasBlocker
    || !latestReportSelected || !latestEvidenceViewed || !warningReason.value.trim();
  accept.textContent = generationAcceptBusy ? '正在记录接受决定…' : latestHasBlocker ? '存在阻断项，不能人工接受' : '人工接受最新一轮警告';
  warningReason.disabled = generationAcceptBusy || generationRunState !== 'needs_review' || !latestHasWarning || latestHasBlocker || !latestReportSelected || !latestEvidenceViewed;
  $('#generation-warning-blocker').textContent = latestHasBlocker
    ? '当前报告包含阻断项。必须修复问题或启动新 Run，不能将其标记为通过。'
    : latestHasWarning && !latestReportSelected ? '切换到最新审查轮次后，才能对当前警告作接受决定。'
      : latestHasWarning && !latestEvidenceViewed ? '先查看最新一轮绑定的截图，再填写接受理由。'
        : latestHasWarning ? '填写理由后标记为人工接受；原审查报告仍保留“需要人工检查”的结论。'
          : unresolvedBlocker || unresolvedWarning ? '此历史轮次不代表最新 Run 状态。' : '';
}

async function loadGenerationEvidence(evidenceId: string): Promise<void> {
  const runId = generationRunId;
  const context = captureOperationContext();
  if (!runId || !context || generationEvidenceBusy || generationEvidenceContent?.evidence.evidenceId === evidenceId) return;
  generationSelectedEvidenceId = evidenceId;
  generationEvidenceBusy = true;
  renderGenerationLoop();
  try {
    const result = throwIfFailure(await window.miaoma.studio.getLoopEvidence({ ...bridgeContext(context), runId, evidenceId }));
    if (!isCurrentOperationContext(context) || runId !== generationRunId || evidenceId !== generationSelectedEvidenceId) return;
    const report = generationLoop?.reports.find((entry) => entry.evidenceId === evidenceId);
    if (result.evidence.evidenceId !== evidenceId || result.evidence.runId !== runId
      || !report || report.attemptId !== result.evidence.attemptId || report.revision !== result.evidence.revision || report.reviewRound !== result.evidence.reviewRound) {
      throw new Error('截图证据与当前审查报告的 Run、轮次或 revision 不匹配');
    }
    generationEvidenceContent = result;
    generationEvidenceErrorId = null;
    if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
    generationEvidenceUrl = URL.createObjectURL(new Blob([result.previewSvg], { type: 'image/svg+xml' }));
  } catch (error) {
    if (!isCurrentOperationContext(context) || runId !== generationRunId || evidenceId !== generationSelectedEvidenceId) return;
    generationPanelError = `读取截图证据失败：${safeRunText(error instanceof Error ? error.message : '未知错误')}`;
    generationEvidenceErrorId = evidenceId;
  } finally {
    generationEvidenceBusy = false;
    renderGenerationLoop();
  }
}

function renderGenerationTabs(): void {
  for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-generation-tab]'))) {
    const selected = tab.dataset.generationTab === generationSelectedTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const view of Array.from(document.querySelectorAll<HTMLElement>('[data-generation-view]'))) view.hidden = view.dataset.generationView !== generationSelectedTab;
}

async function refreshGenerationRuns(): Promise<void> {
  const context = captureOperationContext();
  if (!context || generationRunListBusy) return;
  generationRunListBusy = true;
  renderGenerationRunHistory();
  try {
    const runs = throwIfFailure(await window.miaoma.studio.listGenerationRuns(bridgeContext(context)));
    if (!isCurrentOperationContext(context)) return;
    generationRuns = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = `读取运行列表失败：${safeRunText(error instanceof Error ? error.message : '未知错误')}`;
  } finally {
    generationRunListBusy = false;
    renderGenerationPanel();
  }
}

async function selectGenerationRun(runId: string, fromResumeAction = false): Promise<void> {
  if ((!fromResumeAction && (generationResumeBusy || generationResumePreparing)) || generationAcceptBusy || generationApplyBusy || generationStartBusy || generationCancelBusy) return;
  const listedRun = generationRuns.find((run) => run.runId === runId);
  if (!listedRun) return;
  if (runId === generationRunId) {
    if (listedRun.attemptId === generationAttemptId && listedRun.state === generationRunState) return;
    if (listedRun.attemptId !== generationAttemptId) {
      generationAfterSeq = 0;
      generationEvents = [];
      generationEventIds.clear();
    }
    generationAttemptId = listedRun.attemptId;
    generationRunState = listedRun.state;
    await pollGenerationRun();
    return;
  }
  generationRunId = runId;
  generationAttemptId = generationRuns.find((run) => run.runId === runId)?.attemptId ?? null;
  generationRunState = generationRuns.find((run) => run.runId === runId)?.state ?? null;
  generationRunError = '';
  generationAfterSeq = 0;
  generationEvents = [];
  generationEventIds.clear();
  generationCandidate = null;
  generationConflictRevision = null;
  generationCollaboration = null;
  generationLoop = null;
  generationPlan = null;
  generationReviewRound = 0;
  $<HTMLTextAreaElement>('#generation-warning-reason').value = '';
  generationSelectedEvidenceId = null;
  generationEvidenceContent = null;
  generationEvidenceErrorId = null;
  if (generationPreviewUrl) URL.revokeObjectURL(generationPreviewUrl);
  generationPreviewUrl = null;
  generationPreviewCandidateId = null;
  if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
  generationEvidenceUrl = null;
  generationPanelError = '';
  ensureGenerationSubscription();
  generationSelectedTab = 'overview';
  await pollGenerationRun();
}

function renderGenerationPanel(): void {
  const panel = document.querySelector('#generation-panel');
  if (!panel) return;
  renderGenerationTabs();
  renderGenerationPlan();
  renderGenerationEvents();
  renderGenerationCandidate();
  renderGenerationRunHistory();
  renderGenerationCollaboration();
  renderGenerationLoop();
  const running = !!generationRunId && !generationIsTerminal(generationRunState);
  const runState = $('#generation-run-state');
  runState.textContent = generationRunId
    ? (generationRunState ? generationStateLabels[generationRunState] : '正在启动…')
    : '尚未启动';
  runState.dataset.state = generationRunState ?? 'idle';
  $('#generation-run-error').textContent = safeRunText(generationRunError);
  $('#generation-run-id').textContent = generationRunId
    ? `Run ${generationRunId}${generationAttemptId ? ` · attempt ${generationAttemptId}` : ''} · base r${generationCandidate?.baseRevision ?? generationRequest?.baseRevision ?? '—'}`
    : '尚未启动';
  const maxParallel = generationCollaboration?.maxParallel ?? generationRequest?.maxParallel ?? 1;
  const activeCount = generationCollaboration?.activeCount ?? (running ? 1 : 0);
  $('#generation-run-capacity').textContent = `并发 ${activeCount} / ${maxParallel}`;
  const message = $('#generation-message');
  message.textContent = safeRunText(generationPanelError);
  message.dataset.error = generationPanelError ? 'true' : 'false';
  const planButton = $('#generation-plan') as HTMLButtonElement;
  planButton.disabled = !design || generationPlanBusy || generationStartBusy || generationAcceptBusy;
  planButton.textContent = generationPlanBusy ? '正在生成计划…' : '生成计划';
  const startButton = $('#generation-start') as HTMLButtonElement;
  startButton.disabled = !generationPlan || !generationRequest || generationPlanBusy || generationStartBusy || generationCancelBusy || generationAcceptBusy || running;
  startButton.textContent = generationStartBusy ? '正在启动…' : '启动 Run';
  const cancelButton = $('#generation-cancel') as HTMLButtonElement;
  cancelButton.hidden = !running;
  cancelButton.disabled = generationCancelBusy;
  cancelButton.textContent = generationCancelBusy ? '正在取消…' : '取消 Run';
  const resumeButton = $('#generation-resume') as HTMLButtonElement;
  resumeButton.hidden = generationRunState !== 'interrupted';
  resumeButton.disabled = generationResumeBusy || generationResumePreparing || generationAcceptBusy || !generationRunId || !generationAttemptId;
  resumeButton.textContent = generationResumeBusy ? '正在恢复…' : '从检查点恢复';
  $<HTMLButtonElement>('#generation-refresh-runs').disabled = generationRunListBusy;
}

function buildGenerationRequest(): GenerationRequest {
  const current = assertLoaded();
  const page = current.pages.find((item) => item.id === currentPageId);
  if (!page) throw new Error('当前页面不存在');
  const title = $<HTMLInputElement>('#generation-title').value.trim();
  const prompt = $<HTMLTextAreaElement>('#generation-prompt').value.trim();
  const width = $<HTMLInputElement>('#generation-width').valueAsNumber;
  const height = $<HTMLInputElement>('#generation-height').valueAsNumber;
  const provider = $<HTMLSelectElement>('#generation-provider').value;
  const maxParallel = Number($<HTMLSelectElement>('#generation-max-parallel').value);
  if (!title || title.length > 256) throw new Error('请输入 1 到 256 个字符的设计标题');
  if (!prompt || prompt.length > 20_000) throw new Error('请输入 1 到 20,000 个字符的页面需求');
  if (!Number.isInteger(width) || width < 64 || width > 4096 || !Number.isInteger(height) || height < 64 || height > 4096) throw new Error('画布宽高必须是 64 到 4096 之间的整数');
  if (provider !== 'local-fake' && provider !== 'codex-cli') throw new Error('请选择有效的生成服务');
  if (maxParallel !== 1 && maxParallel !== 3 && maxParallel !== 5) throw new Error('请选择 1、3 或 5 个区域的并发上限');
  return {
    documentId: current.documentId,
    title,
    prompt,
    pageId: page.id,
    targetNodeIds: [],
    baseRevision: current.revision,
    viewport: { width, height },
    referenceAssetIds: [],
    providerRef: provider,
    constraints: [],
    maxParallel
  };
}

async function makeGenerationPlan(): Promise<void> {
  if (generationPlanBusy || !design) return;
  const formVersion = generationFormVersion;
  generationPanelError = '';
  generationPlan = null;
  generationRequest = null;
  generationPlanBusy = true;
  renderGenerationPanel();
  let context = captureOperationContext();
  try {
    if ((textInputTimer || textFlushPromise) && !(await flushTextEdit())) return;
    context = captureOperationContext();
    if (!context) return;
    const request = buildGenerationRequest();
    generationRequest = request;
    renderGenerationPanel();
    const result = throwIfFailure(await window.miaoma.studio.planGeneration({ ...bridgeContext(context), request }));
    if (!isCurrentOperationContext(context)) return;
    if (generationFormVersion !== formVersion) {
      generationRequest = null;
      generationPanelError = '计划返回时表单已修改，请重新生成计划。';
      return;
    }
    if (!design || design.revision !== request.baseRevision) {
      generationRequest = null;
      generationPanelError = '生成计划期间文档发生变化，请重新生成计划。';
      return;
    }
    generationPlan = result;
  } catch (error) {
    if (context && !isCurrentOperationContext(context)) return;
    generationRequest = null;
    generationPanelError = error instanceof Error ? error.message : '生成计划失败';
  } finally {
    generationPlanBusy = false;
    renderGenerationPanel();
  }
}

function queueGenerationPoll(delay = 1200): void {
  if (generationPollTimer) clearTimeout(generationPollTimer);
  if (!generationRunId || generationIsTerminal(generationRunState)) return;
  generationPollTimer = setTimeout(() => { void pollGenerationRun(); }, delay);
}

async function pollGenerationRun(): Promise<void> {
  generationPollTimer = null;
  const runId = generationRunId;
  const context = captureOperationContext();
  if (!runId || !context) return;
  const previousState = generationRunState;
  try {
    let snapshot = throwIfFailure(await window.miaoma.studio.getGenerationRun({ ...bridgeContext(context), runId, afterSeq: generationAfterSeq }));
    if (generationAttemptId && snapshot.run.attemptId !== generationAttemptId) {
      generationAfterSeq = 0;
      generationEvents = [];
      generationEventIds.clear();
      snapshot = throwIfFailure(await window.miaoma.studio.getGenerationRun({ ...bridgeContext(context), runId, afterSeq: 0 }));
    }
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    const firstSnapshotForRun = generationCollaboration === null && generationLoop === null;
    generationAttemptId = snapshot.run.attemptId;
    generationRunState = snapshot.run.state;
    generationRunError = snapshot.run.error?.message ?? '';
    for (const event of snapshot.events) if (event.attemptId === generationAttemptId) addGenerationEvent(event);
    generationAfterSeq = Math.max(generationAfterSeq, snapshot.run.eventSeq);
    if (snapshot.candidate) setGenerationCandidate(snapshot.candidate);
    else if (!snapshot.run.candidateAvailable) setGenerationCandidate(null);
    generationCollaboration = snapshot.collaboration ?? null;
    generationLoop = snapshot.loop ?? null;
    if (snapshot.candidate) generationPlan = snapshot.candidate.plan;
    if (firstSnapshotForRun && generationLoop?.reports.length) generationReviewRound = Math.max(...generationLoop.reports.map((item) => item.reviewRound));
    renderGenerationPanel();
    if (!generationIsTerminal(previousState) && generationIsTerminal(generationRunState)) void refreshGenerationRuns();
    queueGenerationPoll();
  } catch (error) {
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    generationPanelError = safeRunText(error instanceof Error ? error.message : '读取 Run 状态失败');
    renderGenerationPanel();
    queueGenerationPoll(2400);
  }
}

async function resumeSelectedGenerationRun(): Promise<void> {
  const runId = generationRunId;
  const expectedAttemptId = generationAttemptId;
  const context = captureOperationContext();
  if (!runId || !expectedAttemptId || !context || generationRunState !== 'interrupted' || generationResumeBusy || generationAcceptBusy) return;
  generationResumeBusy = true;
  generationPanelError = '';
  renderGenerationPanel();
  try {
    const result = throwIfFailure(await window.miaoma.studio.resumeGenerationRun({ ...bridgeContext(context), runId, expectedAttemptId }));
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    if (result.runId !== runId) throw new Error('恢复结果与当前 Run 不匹配');
    generationAttemptId = result.attemptId;
    generationRunState = result.state;
    generationAfterSeq = 0;
    generationEvents = [];
    generationEventIds.clear();
    generationLoop = null;
    generationCollaboration = null;
    generationReviewRound = 0;
    generationSelectedEvidenceId = null;
    generationEvidenceContent = null;
    generationEvidenceErrorId = null;
    if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
    generationEvidenceUrl = null;
    generationPanelError = '';
    await refreshGenerationRuns();
    await pollGenerationRun();
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = `恢复 Run 失败：${safeRunText(error instanceof Error ? error.message : '未知错误')}`;
  } finally {
    generationResumeBusy = false;
    renderGenerationPanel();
    queueGenerationPoll();
  }
}

async function resumeGenerationRunFromHistory(runId: string): Promise<void> {
  if (generationResumeBusy || generationResumePreparing || generationAcceptBusy || generationApplyBusy || generationStartBusy || generationCancelBusy) return;
  generationResumePreparing = true;
  renderGenerationRunHistory();
  try {
    await selectGenerationRun(runId, true);
    if (generationRunId === runId && generationRunState === 'interrupted') await resumeSelectedGenerationRun();
  } finally {
    generationResumePreparing = false;
    renderGenerationPanel();
  }
}

async function acceptGenerationWarnings(): Promise<void> {
  const runId = generationRunId;
  const expectedAttemptId = generationAttemptId;
  const context = captureOperationContext();
  const reasonInput = $<HTMLTextAreaElement>('#generation-warning-reason');
  const reason = reasonInput.value.trim();
  if (!runId || !expectedAttemptId || !context || generationRunState !== 'needs_review' || generationAcceptBusy) return;
  if (!reason || reason.length > 512) {
    generationPanelError = '请填写 1 到 512 个字符的接受理由。';
    renderGenerationPanel();
    return;
  }
  generationAcceptBusy = true;
  generationPanelError = '';
  renderGenerationPanel();
  try {
    const accepted = throwIfFailure(await window.miaoma.studio.acceptGenerationWarnings({
      ...bridgeContext(context), runId, expectedAttemptId, reason
    }));
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    if (accepted.runId !== runId || accepted.attemptId !== expectedAttemptId || accepted.state !== 'completed') {
      throw new Error('人工接受结果与当前 Run 不匹配');
    }
    generationRunState = 'completed';
    reasonInput.value = '';
    await pollGenerationRun();
    await refreshGenerationRuns();
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = `记录人工接受失败：${safeRunText(error instanceof Error ? error.message : '未知错误')}`;
  } finally {
    generationAcceptBusy = false;
    renderGenerationPanel();
  }
}

async function startGenerationRun(): Promise<void> {
  const request = generationRequest;
  const context = captureOperationContext();
  if (!request || !generationPlan || !context || generationStartBusy || generationAcceptBusy || (generationRunId && !generationIsTerminal(generationRunState))) return;
  if (design?.revision !== request.baseRevision) {
    generationPanelError = '文档 revision 已变化，请重新生成计划后再启动。';
    generationPlan = null;
    generationRequest = null;
    renderGenerationPanel();
    return;
  }
  generationPanelError = '';
  generationStartBusy = true;
  ensureGenerationSubscription();
  renderGenerationPanel();
  try {
    const started = throwIfFailure(await window.miaoma.studio.startGeneration({ ...bridgeContext(context), request }));
    if (!isCurrentOperationContext(context)) return;
    generationRunId = started.runId;
    generationAttemptId = null;
    generationRunState = 'queued';
    generationRunError = '';
    generationAfterSeq = 0;
    generationEvents = [];
    generationEventIds.clear();
    setGenerationCandidate(null);
    generationCollaboration = null;
    generationLoop = null;
    generationReviewRound = 0;
    $<HTMLTextAreaElement>('#generation-warning-reason').value = '';
    generationSelectedEvidenceId = null;
    generationEvidenceContent = null;
    generationEvidenceErrorId = null;
    if (generationEvidenceUrl) URL.revokeObjectURL(generationEvidenceUrl);
    generationEvidenceUrl = null;
    generationConflictRevision = null;
    generationPlan = started.plan;
    generationSelectedTab = 'overview';
    generationPanelError = '';
    await pollGenerationRun();
    void refreshGenerationRuns();
    showToast('设计生成 Run 已启动');
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = error instanceof Error ? error.message : '启动生成 Run 失败';
  } finally {
    generationStartBusy = false;
    renderGenerationPanel();
  }
}

async function cancelGenerationRun(): Promise<void> {
  const runId = generationRunId;
  const context = captureOperationContext();
  if (!runId || !context || generationCancelBusy) return;
  generationCancelBusy = true;
  generationPanelError = '';
  renderGenerationPanel();
  try {
    const result = throwIfFailure(await window.miaoma.studio.cancelGeneration({ ...bridgeContext(context), runId }));
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    if (!result.cancelled) generationPanelError = '当前阶段无法取消，Run 将继续到结束。';
    await pollGenerationRun();
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = error instanceof Error ? error.message : '取消 Run 失败';
  } finally {
    generationCancelBusy = false;
    renderGenerationPanel();
  }
}

async function submitGenerationCandidate(force: boolean): Promise<void> {
  const candidate = generationCandidate;
  const runId = generationRunId;
  let context = captureOperationContext();
  if (!candidate || !runId || !context || generationAcceptBusy || generationApplyBusy || !design) return;
  generationPanelError = '';
  if ((textInputTimer || textFlushPromise) && !(await flushTextEdit())) return;
  context = captureOperationContext();
  if (!context || !design || candidate.runId !== runId) return;
  const expectedRevision = design.revision;
  if (!force && candidate.baseRevision !== expectedRevision) {
    generationConflictRevision = expectedRevision;
    generationPanelError = '应用前检测到版本冲突。请保留当前文档，或明确选择替换当前文档。';
    renderGenerationPanel();
    return;
  }
  generationApplyBusy = true;
  renderGenerationPanel();
  try {
    const result = throwIfFailure(await window.miaoma.studio.applyGenerationCandidate({
      ...bridgeContext(context), runId, expectedRevision: design.revision, force
    }));
    if (!isCurrentOperationContext(context) || runId !== generationRunId) return;
    if (result.kind === 'conflict') {
      generationConflictRevision = result.currentRevision;
      generationPanelError = '文档 revision 已变化。候选未应用，请重新确认保留当前文档或替换当前文档。';
      return;
    }
    generationConflictRevision = null;
    commitMutation(result.mutation);
    setGenerationCandidate(null);
    generationPanelError = '';
    showToast(force ? '候选已替换当前文档' : '候选已应用');
  } catch (error) {
    if (!isCurrentOperationContext(context)) return;
    generationPanelError = error instanceof Error ? error.message : '应用候选失败';
  } finally {
    generationApplyBusy = false;
    renderGenerationPanel();
  }
}

async function copyGenerationCandidateAsVariant(): Promise<void> {
  const runId = generationRunId;
  if (!generationCandidate || !runId || generationAcceptBusy || generationApplyBusy || !design) return;
  generationPanelError = '';
  generationApplyBusy = true;
  renderGenerationPanel();
  const transition = await beginProjectTransition();
  if (!transition) {
    generationApplyBusy = false;
    renderGenerationPanel();
    return;
  }
  try {
    setSaveStatus('saving', '正在复制 AI 方案…');
    const response = await window.miaoma.studio.copyGenerationCandidate({ ...bridgeContext(transition.context), runId });
    if (!isCurrentProjectTransition(transition)) return;
    applyStudioState(throwIfFailure(response));
    showToast('已复制为新方案；原文档仍保留在原项目中');
  } catch (error) {
    if (await restoreProjectAfterTransition(transition)) reportError(error);
  } finally {
    generationApplyBusy = false;
    renderGenerationPanel();
  }
}

function invalidateGenerationPlanFromForm(): void {
  generationFormVersion++;
  if (generationPlan || generationRequest) {
    generationPlan = null;
    generationRequest = null;
    generationPanelError = '输入已修改，请重新生成计划。';
  } else generationPanelError = '';
  renderGenerationPanel();
}

$('#open-generation-panel').addEventListener('click', showGenerationPanel);
$('#generation-close').addEventListener('click', closeGenerationPanel);
$('#generation-backdrop').addEventListener('click', closeGenerationPanel);
$('#generation-plan').addEventListener('click', () => { void makeGenerationPlan(); });
$('#generation-start').addEventListener('click', () => { void startGenerationRun(); });
$('#generation-cancel').addEventListener('click', () => { void cancelGenerationRun(); });
$('#generation-resume').addEventListener('click', () => { void resumeSelectedGenerationRun(); });
$('#generation-accept-warnings').addEventListener('click', () => { void acceptGenerationWarnings(); });
$('#generation-refresh-runs').addEventListener('click', () => { void refreshGenerationRuns(); });
$('#generation-warning-reason').addEventListener('input', () => renderGenerationLoop());
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-generation-tab]'))) {
  tab.addEventListener('click', () => {
    const next = tab.dataset.generationTab;
    if (next === 'overview' || next === 'collaboration' || next === 'review') generationSelectedTab = next;
    renderGenerationPanel();
  });
  tab.addEventListener('keydown', (event: KeyboardEvent) => {
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-generation-tab]'));
    const index = tabs.indexOf(tab);
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[nextIndex]!.click();
    tabs[nextIndex]!.focus();
  });
}
$('#generation-filter-agent').addEventListener('change', (event) => { generationFilterAgent = (event.currentTarget as HTMLSelectElement).value; renderGenerationEvents(); });
$('#generation-filter-task').addEventListener('change', (event) => { generationFilterTask = (event.currentTarget as HTMLSelectElement).value; renderGenerationEvents(); });
$('#generation-filter-round').addEventListener('change', (event) => { generationFilterRound = (event.currentTarget as HTMLSelectElement).value; renderGenerationEvents(); });
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-review-round]'))) {
  tab.addEventListener('click', () => {
    const round = Number(tab.dataset.reviewRound);
    if (round < 0 || round > 2 || !generationLoop?.reports.some((item) => item.reviewRound === round)) return;
    generationReviewRound = round;
    renderGenerationLoop();
  });
}
$('#generation-apply').addEventListener('click', () => { void submitGenerationCandidate(false); });
$('#generation-keep-current').addEventListener('click', () => {
  generationConflictRevision = null;
  generationPanelError = '已保留当前文档，候选仍可预览。';
  renderGenerationPanel();
});
$('#generation-replace').addEventListener('click', () => { void submitGenerationCandidate(true); });
$('#generation-copy-variant').addEventListener('click', () => { void copyGenerationCandidateAsVariant(); });
$('#generation-form').addEventListener('submit', (event) => { event.preventDefault(); void makeGenerationPlan(); });
$('#generation-form').addEventListener('input', invalidateGenerationPlanFromForm);
$('#generation-form').addEventListener('change', invalidateGenerationPlanFromForm);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && generationPanelOpen) {
    event.preventDefault();
    closeGenerationPanel();
  }
}, true);

$('#new-project').addEventListener('click', async () => {
  const transition = await beginProjectTransition();
  if (!transition) return;
  try {
    setSaveStatus('saving', '正在创建设计…');
    const response = await window.miaoma.studio.newProject(bridgeContext(transition.context));
    if (!isCurrentProjectTransition(transition)) return;
    applyStudioState(throwIfFailure(response));
    showToast('新设计已创建，当前项目已保留');
  } catch (error) {
    if (await restoreProjectAfterTransition(transition)) reportError(error);
  }
});

$('#open-project').addEventListener('click', async () => {
  const transition = await beginProjectTransition();
  if (!transition) return;
  try {
    setSaveStatus('saving', '正在打开设计…');
    const response = await window.miaoma.studio.openProject(bridgeContext(transition.context));
    if (!isCurrentProjectTransition(transition)) return;
    const result = throwIfFailure(response);
    if ('cancelled' in result) {
      if (await restoreProjectAfterTransition(transition)) setSaveStatus('saved', `已保存 · r${durableRevision}`);
      return;
    }
    applyStudioState(result);
    showToast('设计已导入为新项目；原文件未修改');
  } catch (error) {
    if (await restoreProjectAfterTransition(transition)) reportError(error);
  }
});

async function start(): Promise<void> {
  setSaveStatus('saving', '正在打开…');
  try {
    const loaded = throwIfFailure(await window.miaoma.studio.load());
    applyStudioState(loaded);
  } catch (error) { setSaveStatus('error', '打开失败'); showToast(error instanceof Error ? error.message : '无法打开设计文档', true); }
}

void start();
