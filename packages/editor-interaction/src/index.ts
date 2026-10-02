import type { DesignDocument, DesignNode } from '@miaoma/design-schema';

/** Affine matrix for column vectors: x'=a*x+c*y+e, y'=b*x+d*y+f. */
export interface Matrix2D { a: number; b: number; c: number; d: number; e: number; f: number }
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface CanvasClientRect { left: number; top: number; width: number; height: number }
export interface Viewport { zoom: number; panX: number; panY: number }

export const IDENTITY_MATRIX: Readonly<Matrix2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const DEFAULT_MIN_ZOOM = 0.02;
const DEFAULT_MAX_ZOOM = 16;

function assertFinitePoint(point: Point, label = 'Point'): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError(`${label} coordinates must be finite`);
}

function assertViewport(viewport: Viewport): void {
  if (!Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || !Number.isFinite(viewport.panX) || !Number.isFinite(viewport.panY)) {
    throw new RangeError('Viewport requires a positive finite zoom and finite pan');
  }
}

function assertDpr(dpr: number): void {
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError('Device pixel ratio must be positive and finite');
}

function assertCanvasRect(rect: CanvasClientRect): void {
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) {
    throw new RangeError('Canvas client rect must have finite coordinates and non-negative dimensions');
  }
}

export function createViewport(initial: Partial<Viewport> = {}): Viewport {
  const viewport = { zoom: initial.zoom ?? 1, panX: initial.panX ?? 0, panY: initial.panY ?? 0 };
  assertViewport(viewport);
  return viewport;
}

/** Pan values and anchors are CSS pixels; zoom is dimensionless. */
export function panViewportBy(viewport: Viewport, deltaCss: Point): Viewport {
  assertViewport(viewport);
  assertFinitePoint(deltaCss, 'Pan delta');
  return { ...viewport, panX: viewport.panX + deltaCss.x, panY: viewport.panY + deltaCss.y };
}

/** Zoom around a point measured from the canvas's top-left in CSS pixels. */
export function zoomViewportAt(
  viewport: Viewport,
  anchorCanvasCss: Point,
  factor: number,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM
): Viewport {
  assertViewport(viewport);
  assertFinitePoint(anchorCanvasCss, 'Zoom anchor');
  if (![factor, minZoom, maxZoom].every(Number.isFinite) || factor <= 0 || minZoom <= 0 || maxZoom < minZoom) {
    throw new RangeError('Zoom factor and limits must be finite and positive');
  }
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * factor));
  const worldAnchor = canvasCssToWorld(anchorCanvasCss, viewport);
  return { zoom, panX: anchorCanvasCss.x - worldAnchor.x * zoom, panY: anchorCanvasCss.y - worldAnchor.y * zoom };
}

export function worldToCanvasCss(world: Point, viewport: Viewport): Point {
  assertFinitePoint(world, 'World point');
  assertViewport(viewport);
  return { x: world.x * viewport.zoom + viewport.panX, y: world.y * viewport.zoom + viewport.panY };
}

export function canvasCssToWorld(canvasCss: Point, viewport: Viewport): Point {
  assertFinitePoint(canvasCss, 'Canvas CSS point');
  assertViewport(viewport);
  return { x: (canvasCss.x - viewport.panX) / viewport.zoom, y: (canvasCss.y - viewport.panY) / viewport.zoom };
}

/** Client coordinates and DOMRect origins are both CSS pixels; DPR is intentionally absent. */
export function clientToWorld(client: Point, canvasRect: CanvasClientRect, viewport: Viewport): Point {
  assertFinitePoint(client, 'Client point');
  assertCanvasRect(canvasRect);
  return canvasCssToWorld({ x: client.x - canvasRect.left, y: client.y - canvasRect.top }, viewport);
}

export function worldToClient(world: Point, canvasRect: CanvasClientRect, viewport: Viewport): Point {
  assertCanvasRect(canvasRect);
  const canvasCss = worldToCanvasCss(world, viewport);
  return { x: canvasCss.x + canvasRect.left, y: canvasCss.y + canvasRect.top };
}

/** Convert a canvas-local CSS point to its backing-store pixel coordinate exactly once. */
export function canvasCssToBackingStore(canvasCss: Point, dpr: number): Point {
  assertFinitePoint(canvasCss, 'Canvas CSS point');
  assertDpr(dpr);
  return { x: canvasCss.x * dpr, y: canvasCss.y * dpr };
}

export function backingStoreToCanvasCss(backing: Point, dpr: number): Point {
  assertFinitePoint(backing, 'Backing-store point');
  assertDpr(dpr);
  return { x: backing.x / dpr, y: backing.y / dpr };
}

export function clientToBackingStore(client: Point, canvasRect: CanvasClientRect, dpr: number): Point {
  assertFinitePoint(client, 'Client point');
  assertCanvasRect(canvasRect);
  return canvasCssToBackingStore({ x: client.x - canvasRect.left, y: client.y - canvasRect.top }, dpr);
}

export function backingStoreToWorld(backing: Point, dpr: number, viewport: Viewport): Point {
  return canvasCssToWorld(backingStoreToCanvasCss(backing, dpr), viewport);
}

export function worldToBackingStore(world: Point, viewport: Viewport, dpr: number): Point {
  return canvasCssToBackingStore(worldToCanvasCss(world, viewport), dpr);
}

export function clientToBackingStoreWorld(client: Point, canvasRect: CanvasClientRect, dpr: number, viewport: Viewport): Point {
  return backingStoreToWorld(clientToBackingStore(client, canvasRect, dpr), dpr, viewport);
}

export function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

export function transformPoint(matrix: Matrix2D, point: Point): Point {
  assertFinitePoint(point);
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
}

export function invertMatrix(matrix: Matrix2D): Matrix2D {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) throw new RangeError('Cannot invert a singular matrix');
  const reciprocal = 1 / determinant;
  return {
    a: matrix.d * reciprocal,
    b: -matrix.b * reciprocal,
    c: -matrix.c * reciprocal,
    d: matrix.a * reciprocal,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) * reciprocal,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) * reciprocal
  };
}

function translation(x: number, y: number): Matrix2D { return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }; }

/**
 * Bounds are expressed in the parent Frame's local coordinates. Rotation is in
 * degrees; rotation and scale pivot around the node box center. The returned matrix maps local box coordinates
 * [0,width] x [0,height] into world coordinates. Pass a Frame's matrix as the
 * parentContentToWorld value when mapping one of its children.
 */
export function getNodeLocalToWorldMatrix(node: DesignNode, parentContentToWorld: Matrix2D = IDENTITY_MATRIX): Matrix2D {
  const { x, y, width, height } = node.bounds;
  const { rotation, scaleX, scaleY } = node.transform;
  const radians = rotation * Math.PI / 180;
  const localTransform: Matrix2D = multiplyMatrices(
    translation(x, y),
    multiplyMatrices(
      translation(width / 2, height / 2),
      multiplyMatrices(
        { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 },
        multiplyMatrices({ a: scaleX, b: 0, c: 0, d: scaleY, e: 0, f: 0 }, translation(-width / 2, -height / 2))
      )
    )
  );
  return multiplyMatrices(parentContentToWorld, localTransform);
}

function transformedCorners(matrix: Matrix2D, width: number, height: number): Point[] {
  return [transformPoint(matrix, { x: 0, y: 0 }), transformPoint(matrix, { x: width, y: 0 }), transformPoint(matrix, { x: width, y: height }), transformPoint(matrix, { x: 0, y: height })];
}

export function getNodeWorldBounds(node: DesignNode, parentContentToWorld: Matrix2D = IDENTITY_MATRIX): Rect {
  const matrix = getNodeLocalToWorldMatrix(node, parentContentToWorld);
  const corners = transformedCorners(matrix, node.bounds.width, node.bounds.height);
  const xs = corners.map((point) => point.x), ys = corners.map((point) => point.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export interface HitTestOptions {
  /** Locked nodes and all their descendants are omitted by default. */
  includeLocked?: boolean;
  /** Include a Frame itself after checking its descendants. Defaults to true. */
  includeFrames?: boolean;
}

export interface NodeHit { pageId: string; node: DesignNode; path: readonly DesignNode[]; worldPoint: Point }

function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

function nodeContainsWorldPoint(node: DesignNode, point: Point, parentMatrix: Matrix2D): boolean {
  const local = transformPoint(invertMatrix(getNodeLocalToWorldMatrix(node, parentMatrix)), point);
  const { width, height } = node.bounds;
  if (local.x < 0 || local.y < 0 || local.x > width || local.y > height) return false;
  if (node.type === 'ellipse') {
    const dx = (local.x - width / 2) / (width / 2), dy = (local.y - height / 2) / (height / 2);
    return dx * dx + dy * dy <= 1;
  }
  // Rectangle, icon, text, and Frame use their transformed box for MVP selection.
  return true;
}

function visitHits(
  node: DesignNode,
  pageId: string,
  point: Point,
  parentMatrix: Matrix2D,
  parentPath: readonly DesignNode[],
  options: Required<HitTestOptions>,
  output: NodeHit[]
): void {
  if (!node.visible || (!options.includeLocked && node.locked)) return;
  const matrix = getNodeLocalToWorldMatrix(node, parentMatrix);
  const path = [...parentPath, node];
  if (node.type === 'frame') {
    const localPoint = transformPoint(invertMatrix(matrix), point);
    const withinClip = !node.clipContent || containsPoint({ x: 0, y: 0, width: node.bounds.width, height: node.bounds.height }, localPoint);
    if (withinClip) {
      // Children are painted in array order, so hit testing checks them in reverse.
      for (let index = node.children.length - 1; index >= 0; index--) {
        visitHits(node.children[index]!, pageId, point, matrix, path, options, output);
      }
    }
  }
  if ((!options.includeFrames && node.type === 'frame') || !nodeContainsWorldPoint(node, point, parentMatrix)) return;
  output.push({ pageId, node, path, worldPoint: point });
}

/** Topmost-first hit list. Pointer position is in browser client/CSS coordinates. */
export function hitTestDocument(
  document: DesignDocument,
  pageId: string,
  clientPoint: Point,
  canvasRect: CanvasClientRect,
  viewport: Viewport,
  options: HitTestOptions = {}
): NodeHit[] {
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  const output: NodeHit[] = [];
  visitHits(page.root, pageId, clientToWorld(clientPoint, canvasRect, viewport), IDENTITY_MATRIX, [], {
    includeLocked: options.includeLocked ?? false,
    includeFrames: options.includeFrames ?? true
  }, output);
  return output;
}

function normalizeRect(rect: Rect): Rect {
  const x = Math.min(rect.x, rect.x + rect.width), y = Math.min(rect.y, rect.y + rect.height);
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

function polygonArea(points: readonly Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!, next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function cross(first: Point, second: Point): number { return first.x * second.y - first.y * second.x; }

function clipPolygon(subject: readonly Point[], clip: readonly Point[]): Point[] {
  if (subject.length === 0 || clip.length < 3) return [];
  const orientation = polygonArea(clip) >= 0 ? 1 : -1;
  let result = [...subject];
  for (let edgeIndex = 0; edgeIndex < clip.length && result.length; edgeIndex++) {
    const edgeStart = clip[edgeIndex]!, edgeEnd = clip[(edgeIndex + 1) % clip.length]!;
    const edge = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
    const inside = (point: Point) => orientation * cross(edge, { x: point.x - edgeStart.x, y: point.y - edgeStart.y }) >= -1e-9;
    const intersection = (start: Point, end: Point): Point => {
      const segment = { x: end.x - start.x, y: end.y - start.y };
      const denominator = cross(segment, edge);
      if (Math.abs(denominator) < 1e-12) return { ...start };
      const amount = cross({ x: edgeStart.x - start.x, y: edgeStart.y - start.y }, edge) / denominator;
      return { x: start.x + amount * segment.x, y: start.y + amount * segment.y };
    };
    const output: Point[] = [];
    let previous = result[result.length - 1]!;
    let previousInside = inside(previous);
    for (const current of result) {
      const currentInside = inside(current);
      if (currentInside !== previousInside) output.push(intersection(previous, current));
      if (currentInside) output.push(current);
      previous = current;
      previousInside = currentInside;
    }
    result = output;
  }
  return result;
}

/** Returns topmost-first nodes whose transformed boxes overlap a client-space marquee and their ancestor clips. */
export function nodesIntersectingClientRect(
  document: DesignDocument,
  pageId: string,
  clientRect: Rect,
  canvasRect: CanvasClientRect,
  viewport: Viewport,
  options: HitTestOptions = {}
): NodeHit[] {
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  const worldMarquee = normalizeRect({
    x: (clientRect.x - canvasRect.left - viewport.panX) / viewport.zoom,
    y: (clientRect.y - canvasRect.top - viewport.panY) / viewport.zoom,
    width: clientRect.width / viewport.zoom,
    height: clientRect.height / viewport.zoom
  });
  const marqueePolygon = [
    { x: worldMarquee.x, y: worldMarquee.y },
    { x: worldMarquee.x + worldMarquee.width, y: worldMarquee.y },
    { x: worldMarquee.x + worldMarquee.width, y: worldMarquee.y + worldMarquee.height },
    { x: worldMarquee.x, y: worldMarquee.y + worldMarquee.height }
  ];
  const hits: NodeHit[] = [];
  const visit = (node: DesignNode, parent: Matrix2D, path: readonly DesignNode[], ancestorClips: readonly Point[][]) => {
    if (!node.visible || (!(options.includeLocked ?? false) && node.locked)) return;
    const matrix = getNodeLocalToWorldMatrix(node, parent), nodePath = [...path, node];
    if (node.type === 'frame') {
      const childClips = node.clipContent ? [...ancestorClips, transformedCorners(matrix, node.bounds.width, node.bounds.height)] : ancestorClips;
      for (let index = node.children.length - 1; index >= 0; index--) visit(node.children[index]!, matrix, nodePath, childClips);
    }
    if ((options.includeFrames ?? true) || node.type !== 'frame') {
      let visibleShape = transformedCorners(matrix, node.bounds.width, node.bounds.height);
      for (const clip of ancestorClips) visibleShape = clipPolygon(visibleShape, clip);
      visibleShape = clipPolygon(visibleShape, marqueePolygon);
      if (visibleShape.length > 0) hits.push({ pageId, node, path: nodePath, worldPoint: { x: worldMarquee.x, y: worldMarquee.y } });
    }
  };
  visit(page.root, IDENTITY_MATRIX, [], []);
  return hits;
}

export type SelectionModifier = 'replace' | 'add' | 'toggle';

export function updateSelection(current: readonly string[], nodeId: string, modifier: SelectionModifier = 'replace'): string[] {
  const unique = [...new Set(current)];
  if (modifier === 'replace') return [nodeId];
  const exists = unique.includes(nodeId);
  if (modifier === 'toggle') return exists ? unique.filter((id) => id !== nodeId) : [...unique, nodeId];
  return exists ? unique : [...unique, nodeId];
}

export type NudgeDirection = 'left' | 'right' | 'up' | 'down';

export function keyboardNudgeDelta(direction: NudgeDirection, shiftKey = false): Point {
  const distance = shiftKey ? 10 : 1;
  switch (direction) {
    case 'left': return { x: -distance, y: 0 };
    case 'right': return { x: distance, y: 0 };
    case 'up': return { x: 0, y: -distance };
    case 'down': return { x: 0, y: distance };
  }
}

export interface DragDraft {
  readonly nodeId: string;
  readonly baseRevision: number;
  readonly originalBounds: Rect;
  readonly draftBounds: Rect;
  readonly startParentPoint: Point;
  readonly delta: Point;
}

export interface DragUpdateOptions { snapToGrid?: boolean; gridSize?: number }
export interface DragCommit { nodeId: string; baseRevision: number; from: Rect; to: Rect; delta: Point }

function parentLocalPoint(client: Point, canvasRect: CanvasClientRect, viewport: Viewport, parentToWorld: Matrix2D): Point {
  return transformPoint(invertMatrix(parentToWorld), clientToWorld(client, canvasRect, viewport));
}

/** Start a pure drag draft. Pass the selected node's containing Frame matrix, or identity for a page root. */
export function createDragDraft(
  node: DesignNode,
  parentContentToWorld: Matrix2D,
  baseRevision: number,
  startClient: Point,
  canvasRect: CanvasClientRect,
  viewport: Viewport
): DragDraft {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new RangeError('Base revision must be a non-negative safe integer');
  return {
    nodeId: node.id,
    baseRevision,
    originalBounds: { ...node.bounds },
    draftBounds: { ...node.bounds },
    startParentPoint: parentLocalPoint(startClient, canvasRect, viewport, parentContentToWorld),
    delta: { x: 0, y: 0 }
  };
}

export function updateDragDraft(
  draft: DragDraft,
  currentClient: Point,
  canvasRect: CanvasClientRect,
  viewport: Viewport,
  parentContentToWorld: Matrix2D,
  options: DragUpdateOptions = {}
): DragDraft {
  const currentParentPoint = parentLocalPoint(currentClient, canvasRect, viewport, parentContentToWorld);
  let x = draft.originalBounds.x + currentParentPoint.x - draft.startParentPoint.x;
  let y = draft.originalBounds.y + currentParentPoint.y - draft.startParentPoint.y;
  if (options.snapToGrid) {
    const gridSize = options.gridSize ?? 8;
    if (!Number.isFinite(gridSize) || gridSize <= 0) throw new RangeError('Grid size must be positive and finite');
    x = Math.round(x / gridSize) * gridSize;
    y = Math.round(y / gridSize) * gridSize;
  }
  const delta = { x: x - draft.originalBounds.x, y: y - draft.originalBounds.y };
  return { ...draft, draftBounds: { ...draft.originalBounds, x, y }, delta };
}

/** Produce a commit descriptor; persistence/revision checking remains a Main-process concern. */
export function commitDragDraft(draft: DragDraft): DragCommit {
  return { nodeId: draft.nodeId, baseRevision: draft.baseRevision, from: { ...draft.originalBounds }, to: { ...draft.draftBounds }, delta: { ...draft.delta } };
}
