import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import { assertValidDocument } from '@miaoma/editor-core';
import type { ScreenshotMetadata } from '@miaoma/shared-protocol';

export type RenderedScreenshot = { svg: string; metadata: ScreenshotMetadata };

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const fillColor = (fill: DesignNode['style']['fills'][number]): string => fill.type === 'solid' ? typeof fill.color === 'string' ? fill.color : typeof fill.color.fallback === 'string' ? fill.color.fallback : '#000000' : 'none';

function renderNode(node: DesignNode, offsetX: number, offsetY: number, ids: string[]): string {
  if (!node.visible) return '';
  ids.push(node.id);
  const { x, y, width, height } = node.bounds;
  const left = offsetX + x, top = offsetY + y;
  const fill = node.style.fills[0] ? fillColor(node.style.fills[0]) : 'none';
  const stroke = node.style.strokes[0];
  const common = `opacity="${node.style.opacity}"${stroke ? ` stroke="${stroke.color}" stroke-width="${stroke.width}"` : ''}`;
  switch (node.type) {
    case 'frame': return `<g data-node-id="${escapeXml(node.id)}" ${common}>${node.style.fills[0] ? `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${escapeXml(fill)}"/>` : ''}${node.children.map((child) => renderNode(child, left, top, ids)).join('')}</g>`;
    case 'rectangle': { const radius = typeof node.radius === 'number' ? node.radius : typeof node.radius.fallback === 'number' ? node.radius.fallback : 0; return `<rect data-node-id="${escapeXml(node.id)}" x="${left}" y="${top}" width="${width}" height="${height}" rx="${radius}" fill="${escapeXml(fill)}" ${common}/>`; }
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

export function renderDocumentScreenshot(document: DesignDocument, pageId = document.pages[0]!.id, scale = 1, maxEdge = 4096): RenderedScreenshot {
  assertValidDocument(document);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 2) throw new RangeError('Screenshot scale must be in (0, 2]');
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 4096) throw new RangeError('Screenshot maxEdge must be an integer in [1, 4096]');
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  const ids: string[] = [];
  const root = page.root as DesignNode;
  const effectiveScale = Math.min(scale, maxEdge / Math.max(root.bounds.width, root.bounds.height));
  const outputWidth = Math.ceil(root.bounds.width * effectiveScale), outputHeight = Math.ceil(root.bounds.height * effectiveScale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${root.bounds.width} ${root.bounds.height}" role="img" aria-label="${escapeXml(document.title)}"><title>${escapeXml(document.title)}</title>${renderNode(root, 0, 0, ids)}</svg>`;
  if (svg.length > 2_000_000) throw new Error('Screenshot SVG exceeds 2 MB');
  let usesAssets = false;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (!node.visible) continue;
    if (node.style.fills.some((fill) => fill.type === 'asset')) { usesAssets = true; break; }
    if (node.type === 'frame') pending.push(...node.children);
  }
  return { svg, metadata: { documentId: document.documentId, documentRevision: document.revision, pageId, nodeIds: ids, width: outputWidth, height: outputHeight, scale: effectiveScale, mimeType: 'image/svg+xml', assets: usesAssets ? 'missing' : 'ready' } };
}
