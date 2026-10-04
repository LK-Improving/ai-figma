import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import { assertValidDocument } from '@miaoma/editor-core';
import type { ScreenshotMetadata } from '@miaoma/shared-protocol';

export type RenderedScreenshot = { svg: string; metadata: ScreenshotMetadata };

function stripInvalidXml10Characters(text: string): string {
  let safe = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || codePoint >= 0x20 && codePoint <= 0xd7ff
      || codePoint >= 0xe000 && codePoint <= 0xfffd
      || codePoint >= 0x10000 && codePoint <= 0x10ffff) safe += character;
  }
  return safe;
}

const escapeXml = (text: string) => stripInvalidXml10Characters(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const fillColor = (fill: DesignNode['style']['fills'][number]): string => fill.type === 'solid' ? typeof fill.color === 'string' ? fill.color : typeof fill.color.fallback === 'string' ? fill.color.fallback : '#000000' : 'none';

function renderNode(node: DesignNode, offsetX: number, offsetY: number, ids: string[], includedIds?: ReadonlySet<string>, assetDataUrls: Readonly<Record<string, string>> = {}): string {
  if (!node.visible || includedIds && !includedIds.has(node.id)) return '';
  ids.push(node.id);
  const { x, y, width, height } = node.bounds;
  const left = offsetX + x, top = offsetY + y;
  const fill = node.style.fills[0] ? fillColor(node.style.fills[0]) : 'none';
  const stroke = node.style.strokes[0];
  const common = `opacity="${node.style.opacity}"${stroke ? ` stroke="${stroke.color}" stroke-width="${stroke.width}"` : ''}`;
  switch (node.type) {
    case 'frame': return `<g data-node-id="${escapeXml(node.id)}" ${common}>${node.style.fills[0] ? `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${escapeXml(fill)}"/>` : ''}${node.children.map((child) => renderNode(child, left, top, ids, includedIds, assetDataUrls)).join('')}</g>`;
    case 'rectangle': {
      const radius = typeof node.radius === 'number' ? node.radius : typeof node.radius.fallback === 'number' ? node.radius.fallback : 0;
      const assetFill = node.style.fills.find((item) => item.type === 'asset');
      const imageUrl = assetFill?.type === 'asset' ? assetDataUrls[assetFill.assetId] : undefined;
      if (imageUrl) return `<image data-node-id="${escapeXml(node.id)}" x="${left}" y="${top}" width="${width}" height="${height}" href="${imageUrl}" preserveAspectRatio="none" opacity="${node.style.opacity}"/>`;
      return `<rect data-node-id="${escapeXml(node.id)}" x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" fill="${escapeXml(fill)}" ${common}/>`;
    }
    case 'ellipse': return `<ellipse data-node-id="${escapeXml(node.id)}" cx="${left + width / 2}" cy="${top + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${escapeXml(fill)}" ${common}/>`;
    case 'icon': return `<text data-node-id="${escapeXml(node.id)}" x="${left}" y="${top + height * 0.8}" font-family="Arial,sans-serif" font-size="${Math.min(width, height)}" fill="${escapeXml(fill === 'none' ? '#22352c' : fill)}" ${common}>${escapeXml(({ sparkle: '✦', 'arrow-right': '→', leaf: '❧', check: '✓', plus: '+' } as const)[node.iconKey])}</text>`;
    case 'text': {
      const lines = node.text.split(/\r?\n/);
      const anchor = node.typography.textAlign === 'center' ? 'middle' : node.typography.textAlign === 'right' ? 'end' : 'start';
      const textX = anchor === 'middle' ? left + width / 2 : anchor === 'end' ? left + width : left;
      return `<text data-node-id="${escapeXml(node.id)}" x="${textX}" y="${top + node.typography.fontSize}" fill="${node.typography.color}" font-family="${escapeXml(node.typography.fontFamily)}" font-size="${node.typography.fontSize}" font-weight="${node.typography.fontWeight}" text-anchor="${anchor}" ${common}>${lines.map((line, index) => `<tspan x="${textX}" dy="${index === 0 ? 0 : node.typography.fontSize * node.typography.lineHeight}">${escapeXml(line)}</tspan>`).join('')}</text>`;
    }
  }
}

export function renderDocumentScreenshot(document: DesignDocument, pageId = document.pages[0]!.id, scale = 1, maxEdge = 4096, targetNodeIds?: readonly string[], assetDataUrls: Readonly<Record<string, string>> = {}): RenderedScreenshot {
  assertValidDocument(document);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new RangeError('Screenshot scale must be in (0, 2]');
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) throw new RangeError('Screenshot maxEdge must be an integer in [1, 4096]');
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  if (targetNodeIds && (!targetNodeIds.length || targetNodeIds.length > 500 || targetNodeIds.some((id) => typeof id !== 'string') || new Set(targetNodeIds).size !== targetNodeIds.length)) throw new RangeError('Screenshot target node IDs must contain 1–500 unique IDs');
  const ids: string[] = [];
  const root = page.root as DesignNode;
  const nodeById = new Map<string, DesignNode>();
  const parentById = new Map<string, string>();
  const boundsById = new Map<string, { x: number; y: number; width: number; height: number }>();
  const indexNodes = (node: DesignNode, parentX: number, parentY: number, parentId?: string) => {
    const x = parentX + node.bounds.x;
    const y = parentY + node.bounds.y;
    nodeById.set(node.id, node);
    boundsById.set(node.id, { x, y, width: node.bounds.width, height: node.bounds.height });
    if (parentId) parentById.set(node.id, parentId);
    if (node.type === 'frame') for (const child of node.children) indexNodes(child, x, y, node.id);
  };
  indexNodes(root, 0, 0);
  let crop = { x: 0, y: 0, width: root.bounds.width, height: root.bounds.height };
  let includedIds: Set<string> | undefined;
  if (targetNodeIds) {
    includedIds = new Set<string>();
    const targetBounds = targetNodeIds.map((id) => {
      const bounds = boundsById.get(id);
      if (!bounds) throw new Error(`Screenshot target node not found: ${id}`);
      let ancestor = id;
      while (ancestor) {
        includedIds!.add(ancestor);
        ancestor = parentById.get(ancestor) ?? '';
      }
      const addSubtree = (node: DesignNode) => {
        includedIds!.add(node.id);
        if (node.type === 'frame') for (const child of node.children) addSubtree(child);
      };
      addSubtree(nodeById.get(id)!);
      return bounds;
    });
    const minX = Math.min(...targetBounds.map((bounds) => bounds.x));
    const minY = Math.min(...targetBounds.map((bounds) => bounds.y));
    const maxX = Math.max(...targetBounds.map((bounds) => bounds.x + bounds.width));
    const maxY = Math.max(...targetBounds.map((bounds) => bounds.y + bounds.height));
    crop = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  const effectiveScale = Math.min(scale, maxEdge / Math.max(crop.width, crop.height));
  const outputWidth = Math.ceil(crop.width * effectiveScale), outputHeight = Math.ceil(crop.height * effectiveScale);
  const safeAssetDataUrls: Record<string, string> = {};
  for (const [assetId, dataUrl] of Object.entries(assetDataUrls)) {
    if (document.assets[assetId] && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) safeAssetDataUrls[assetId] = dataUrl;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}" role="img" aria-label="${escapeXml(document.title)}"><title>${escapeXml(document.title)}</title>${renderNode(root, 0, 0, ids, includedIds, safeAssetDataUrls)}</svg>`;
  if (svg.length > 2_000_000) throw new Error('Screenshot SVG exceeds 2 MB');
  const requiredAssetIds = new Set(ids.flatMap((id) => nodeById.get(id)!.style.fills.flatMap((fill) => fill.type === 'asset' ? [fill.assetId] : [])));
  const assetsReady = [...requiredAssetIds].every((assetId) => !!safeAssetDataUrls[assetId]);
  return { svg, metadata: { documentId: document.documentId, documentRevision: document.revision, pageId, nodeIds: ids, width: outputWidth, height: outputHeight, scale: effectiveScale, mimeType: 'image/svg+xml', assets: assetsReady ? 'ready' : 'missing' } };
}
