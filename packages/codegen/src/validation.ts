import { createHash } from 'node:crypto';
import { validateDesignDocument } from '@miaoma/design-schema';
import type { DesignNode } from '@miaoma/design-schema';
import type { CodegenDiagnostic, CodegenInput, ValidatedDocument } from './types';

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 100 * 1024 * 1024;

export interface ValidatedAsset {
  assetId: string;
  mimeType: string;
  sourceSha256: string;
  outputSha256: string;
  sourceBytes: Uint8Array;
  outputBytes: Uint8Array;
  relativePath: string;
}

export interface ValidatedInput {
  document: ValidatedDocument;
  serializedDocument: string;
  assets: Map<string, ValidatedAsset>;
  nodeCount: number;
  assetByteSize: number;
}

export type InputValidation =
  | { success: true; value: ValidatedInput }
  | { success: false; diagnostics: CodegenDiagnostic[] };

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const own = (record: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(record, key);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function decodeSvgEntity(entity: string): string | undefined {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (own(named, entity)) return named[entity];
  const numeric = entity.startsWith('#x') || entity.startsWith('#X')
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith('#') ? Number.parseInt(entity.slice(1), 10) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return undefined;
  if (numeric === 0 || numeric === 0xfffe || numeric === 0xffff || (numeric < 0x20 && ![9, 10, 13].includes(numeric))) return undefined;
  return String.fromCodePoint(numeric);
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function decodeXml(value: string): string | undefined {
  let valid = true;
  const decoded = value.replace(/&([^;]{1,16});/g, (_match, entity: string) => {
    const result = decodeSvgEntity(entity);
    if (result === undefined) { valid = false; return ''; }
    return result;
  });
  if (!valid || /&/.test(decoded)) return undefined;
  return decoded;
}

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'symbol', 'use', 'title', 'desc'
]);
const SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'id', 'fill', 'fill-rule', 'clip-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
  'fill-opacity', 'stroke-opacity', 'transform', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy',
  'clipPathUnits', 'maskUnits', 'maskContentUnits', 'href', 'xlink:href', 'font-size', 'font-family', 'text-anchor'
]);
const XMLNS_SVG = 'http://www.w3.org/2000/svg';
const XMLNS_XLINK = 'http://www.w3.org/1999/xlink';

function safeSvgAttribute(name: string, value: string): boolean {
  if (!SVG_ATTRIBUTES.has(name)) return false;
  if (name === 'xmlns') return value === XMLNS_SVG;
  if (name === 'xmlns:xlink') return value === XMLNS_XLINK;
  if (name === 'href' || name === 'xlink:href') return /^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value);
  if (/url\s*\(/i.test(value) && !/^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/.test(value)) return false;
  if (/javascript:|data:|https?:|\/\//i.test(value)) return false;
  if (/^[\s\S]*[<>\u0000-\u001f\u007f][\s\S]*$/.test(value)) return false;
  return true;
}

/**
 * Retain a deliberately small, inert SVG subset. Rebuild every element and attribute,
 * rather than trusting the source XML after a few string replacements.
 */
export function sanitizeSvg(input: Uint8Array): Uint8Array | undefined {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/, ''); }
  catch { return undefined; }
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet/i.test(source)) return undefined;
  const xmlDeclaration = /^\s*<\?xml\s+version=(['"])1\.0\1(?:\s+encoding=(['"])UTF-8\2)?(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>\s*/i;
  if (/^\s*<\?xml/i.test(source)) {
    if (!xmlDeclaration.test(source)) return undefined;
    source = source.replace(xmlDeclaration, '');
  }
  const output: string[] = [];
  const stack: string[] = [];
  let index = 0;
  let sawRoot = false;
  let rootClosed = false;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open < 0) {
      const tail = source.slice(index);
      const decoded = decodeXml(tail);
      if (decoded === undefined || (!stack.length && decoded.trim())) return undefined;
      if (stack.length) output.push(escapeXml(decoded));
      index = source.length;
      break;
    }
    const text = source.slice(index, open);
    const decodedText = decodeXml(text);
    if (decodedText === undefined || (!stack.length && decodedText.trim())) return undefined;
    if (stack.length) output.push(escapeXml(decodedText));
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4);
      if (close < 0) return undefined;
      index = close + 3;
      continue;
    }
    let cursor = open + 1;
    let quote = '';
    for (; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (cursor >= source.length || quote) return undefined;
    const rawTag = source.slice(open + 1, cursor).trim();
    if (rawTag.startsWith('?') || rawTag.startsWith('!')) return undefined;
    const closing = rawTag.startsWith('/');
    const selfClosing = !closing && rawTag.endsWith('/');
    const body = (closing ? rawTag.slice(1) : selfClosing ? rawTag.slice(0, -1) : rawTag).trim();
    const nameMatch = /^([A-Za-z][A-Za-z0-9]*)/.exec(body);
    if (!nameMatch) return undefined;
    const tagName = nameMatch[1]!;
    if (!SVG_ELEMENTS.has(tagName)) return undefined;
    if (closing) {
      if (body.slice(tagName.length).trim() || stack.pop() !== tagName) return undefined;
      output.push(`</${tagName}>`);
      if (!stack.length) rootClosed = true;
    } else {
      if (rootClosed || (!stack.length && sawRoot) || (!stack.length && tagName !== 'svg')) return undefined;
      if (!stack.length) sawRoot = true;
      const attrSource = body.slice(tagName.length);
      const attributes: Array<[string, string]> = [];
      let rest = attrSource;
      while (rest.trim()) {
        const match = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"<>]*)"|'([^'<>]*)')/.exec(rest);
        if (!match) return undefined;
        const attrName = match[1]!;
        const rawValue = match[3] ?? match[4] ?? '';
        const decodedValue = decodeXml(rawValue);
        if (decodedValue === undefined || !safeSvgAttribute(attrName, decodedValue)) return undefined;
        if (attributes.some(([existing]) => existing === attrName)) return undefined;
        attributes.push([attrName, decodedValue]);
        rest = rest.slice(match[0].length);
      }
      attributes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      output.push(`<${tagName}${attributes.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('')}${selfClosing ? '/>' : '>'}`);
      if (!selfClosing) stack.push(tagName);
      else if (!stack.length) rootClosed = true;
    }
    index = cursor + 1;
  }
  if (!sawRoot || stack.length || !rootClosed) return undefined;
  const canonical = output.join('');
  return new TextEncoder().encode(canonical);
}

function detectMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512))).replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml\s+[^?]*\?>\s*)?(?:<!--(?:.|\r|\n)*?-->\s*)*<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return undefined;
}

function nodeCount(document: ValidatedDocument): number {
  let count = 0;
  const stack: DesignNode[] = document.pages.map((page) => page.root);
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    count++;
    if (node.type === 'frame') stack.push(...node.children);
  }
  return count;
}

function checkOwnReferences(document: ValidatedDocument): CodegenDiagnostic[] {
  const diagnostics: CodegenDiagnostic[] = [];
  const visit = (node: DesignNode, path: Array<string | number>) => {
    for (const fill of node.style.fills) {
      if (fill.type === 'asset' && !own(document.assets, fill.assetId)) diagnostics.push({ code: 'ASSET_NOT_FOUND', path, message: `Missing own asset record: ${fill.assetId}` });
      if (fill.type === 'solid' && typeof fill.color !== 'string' && !own(document.variables, fill.color.id)) diagnostics.push({ code: 'VARIABLE_NOT_FOUND', path, message: `Missing own variable record: ${fill.color.id}` });
    }
    if (node.type === 'rectangle' && typeof node.radius !== 'number' && !own(document.variables, node.radius.id)) diagnostics.push({ code: 'VARIABLE_NOT_FOUND', path: [...path, 'radius'], message: `Missing own variable record: ${node.radius.id}` });
    if (node.type === 'frame') node.children.forEach((child, index) => visit(child, [...path, 'children', index]));
  };
  document.pages.forEach((page, index) => visit(page.root, ['pages', index, 'root']));
  for (const [key, variable] of Object.entries(document.variables)) {
    if (key !== variable.id) diagnostics.push({ code: 'VARIABLE_KEY_MISMATCH', path: ['variables', key], message: 'Variable record keys must match their IDs' });
  }
  for (const [key, asset] of Object.entries(document.assets)) {
    if (key !== asset.id) diagnostics.push({ code: 'ASSET_KEY_MISMATCH', path: ['assets', key], message: 'Asset record keys must match their IDs' });
  }
  return diagnostics;
}

export function validateCodegenInput(input: CodegenInput): InputValidation {
  const checked = validateDesignDocument(input.document);
  if (!checked.success) return { success: false, diagnostics: checked.diagnostics };
  const document = checked.data;
  const diagnostics = checkOwnReferences(document);
  if (diagnostics.length) return { success: false, diagnostics };
  const serializedDocument = canonicalJson(document);
  if (new TextEncoder().encode(serializedDocument).byteLength > MAX_DOCUMENT_BYTES) {
    return { success: false, diagnostics: [{ code: 'DOCUMENT_TOO_LARGE', path: [], message: `Canonical design document exceeds ${MAX_DOCUMENT_BYTES} bytes` }] };
  }

  const supplied = input.assets ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || !(Object.getPrototypeOf(supplied) === Object.prototype || Object.getPrototypeOf(supplied) === null)) {
    return { success: false, diagnostics: [{ code: 'INVALID_ASSET_MAP', path: ['assets'], message: 'Assets must be a plain record of asset IDs to Uint8Array bytes' }] };
  }
  const suppliedKeys = Object.keys(supplied).sort();
  const metadataKeys = Object.keys(document.assets).sort();
  const extra = suppliedKeys.filter((key) => !own(document.assets, key));
  const missing = metadataKeys.filter((key) => !own(supplied, key));
  for (const key of extra) diagnostics.push({ code: 'UNDECLARED_ASSET_BYTES', path: ['assets', key], message: `Bytes were supplied for undeclared asset ${key}` });
  for (const key of missing) diagnostics.push({ code: 'ASSET_BYTES_MISSING', path: ['assets', key], message: `Bytes are missing for declared asset ${key}` });
  if (diagnostics.length) return { success: false, diagnostics };

  let totalBytes = 0;
  const assets = new Map<string, ValidatedAsset>();
  for (const [assetId, metadata] of Object.entries(document.assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const provided = supplied[assetId];
    if (!(provided instanceof Uint8Array)) {
      diagnostics.push({ code: 'INVALID_ASSET_BYTES', path: ['assets', assetId], message: 'Asset bytes must be a Uint8Array' });
      continue;
    }
    const sourceBytes = new Uint8Array(provided);
    totalBytes += sourceBytes.byteLength;
    if (sourceBytes.byteLength !== metadata.byteSize) diagnostics.push({ code: 'ASSET_SIZE_MISMATCH', path: ['assets', assetId], message: `Asset size is ${sourceBytes.byteLength}, expected ${metadata.byteSize}` });
    if (sourceBytes.byteLength > 25 * 1024 * 1024) diagnostics.push({ code: 'ASSET_TOO_LARGE', path: ['assets', assetId], message: 'An asset exceeds the 25 MiB schema limit' });
    const sourceSha256 = hex(sourceBytes);
    if (sourceSha256 !== metadata.sha256) diagnostics.push({ code: 'ASSET_HASH_MISMATCH', path: ['assets', assetId], message: 'Asset SHA-256 does not match its manifest metadata' });
    const sniffed = detectMime(sourceBytes);
    if (sniffed !== metadata.mimeType) diagnostics.push({ code: 'ASSET_MIME_MISMATCH', path: ['assets', assetId], message: `Asset bytes identify as ${sniffed ?? 'unknown'}, expected ${metadata.mimeType}` });
    let outputBytes: Uint8Array<ArrayBufferLike> = sourceBytes;
    if (metadata.mimeType === 'image/svg+xml') {
      const sanitized = sanitizeSvg(sourceBytes);
      if (!sanitized) diagnostics.push({ code: 'UNSAFE_SVG', path: ['assets', assetId], message: 'SVG contains unsupported, active, external, malformed, or unsafe XML content' });
      else outputBytes = sanitized;
    }
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as const)[metadata.mimeType];
    const outputSha256 = hex(outputBytes);
    assets.set(assetId, {
      assetId, mimeType: metadata.mimeType, sourceSha256, outputSha256,
      sourceBytes, outputBytes, relativePath: `public/assets/${outputSha256}.${extension}`
    });
  }
  if (totalBytes > MAX_TOTAL_ASSET_BYTES) diagnostics.push({ code: 'ASSET_BUNDLE_TOO_LARGE', path: ['assets'], message: `Assets exceed the ${MAX_TOTAL_ASSET_BYTES} byte project export limit` });
  if (diagnostics.length) return { success: false, diagnostics };

  const generatedDocument = JSON.parse(serializedDocument) as ValidatedDocument;
  for (const [assetId, asset] of assets) {
    const meta = generatedDocument.assets[assetId];
    if (!meta) continue;
    meta.relativePath = `assets/${asset.outputSha256}.${asset.relativePath.slice(asset.relativePath.lastIndexOf('.') + 1)}`;
    meta.sha256 = asset.outputSha256;
    meta.byteSize = asset.outputBytes.byteLength;
  }
  return {
    success: true,
    value: {
      document: generatedDocument,
      serializedDocument: canonicalJson(generatedDocument),
      assets,
      nodeCount: nodeCount(document),
      assetByteSize: totalBytes
    }
  };
}
