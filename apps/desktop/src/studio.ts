import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import type { EditorCommand, HistoryState } from '@miaoma/editor-core';
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

declare global {
  interface Window {
    miaoma: {
      generateAndSave(input: { title: string; prompt: string }): Promise<unknown>;
      studio: {
        newProject(context: BridgeProjectContext): Promise<StudioResult<StudioState>>;
        openProject(context: BridgeProjectContext): Promise<StudioResult<StudioState | { cancelled: true }>>;
        load(): Promise<StudioResult<StudioState>>;
        execute(input: BridgeProjectContext & { baseRevision: number; commands: readonly EditorCommand[]; commandId?: string }): Promise<StudioResult<StudioMutation>>;
        undo(input: BridgeProjectContext & { baseRevision: number }): Promise<StudioResult<StudioMutation>>;
        redo(input: BridgeProjectContext & { baseRevision: number }): Promise<StudioResult<StudioMutation>>;
        save(context: BridgeProjectContext): Promise<StudioResult<{ snapshotPath: string; revision: number }>>;
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
  selection.splice(0);
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
