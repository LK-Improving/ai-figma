import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { generateReactProject } from '../src/index';
import { sanitizeSvg } from '../src/validation';
import { effectiveViewportWidth } from '../src/reports';
import { makeAssets, makeDocument, pngBytes, sha256 } from './fixture';

function generated() {
  const result = generateReactProject({ document: makeDocument(), assets: makeAssets() });
  assert.equal(result.success, true, JSON.stringify(result.success ? [] : result.diagnostics));
  if (!result.success) throw new Error('fixture did not generate');
  return result;
}

function textFile(result: ReturnType<typeof generated>, filePath: string): string {
  const file = result.files.find((item) => item.path === filePath);
  assert.ok(file, `missing ${filePath}`);
  assert.equal(typeof file.content, 'string', `${filePath} should be textual`);
  return file.content as string;
}

class PreviewElement {
  hidden = false;
  textContent = '';
  readonly listeners = new Map<string, Array<(event: PreviewEvent) => void>>();
  readonly children: PreviewElement[] = [];
  parent: PreviewElement | undefined;
  className = '';
  readonly classList = { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  constructor(readonly dataset: Record<string, string> = {}, readonly attributes: Record<string, string> = {}) {}
  append(child: PreviewElement): PreviewElement { child.parent = this; this.children.push(child); return child; }
  addEventListener(name: string, listener: (event: PreviewEvent) => void): void {
    const items = this.listeners.get(name) ?? []; items.push(listener); this.listeners.set(name, items);
  }
  closest(selector: string): PreviewElement | null {
    let current: PreviewElement | undefined = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parent;
    }
    return null;
  }
  matches(selector: string): boolean {
    const dataAttr = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (dataAttr) {
      const key = dataAttr[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    }
    const role = /^\[role=([^\]]+)\]$/.exec(selector);
    if (role) return this.attributes.role === role[1];
    return false;
  }
  querySelectorAll(selector: string): PreviewElement[] {
    const found: PreviewElement[] = [];
    const visit = (node: PreviewElement) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector: string): PreviewElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void {}
}

interface PreviewEvent { target: PreviewElement; key?: string; repeat?: boolean; preventDefault?: () => void; }

test('generates deterministic React project, manifest, all node types, and three viewport reports', () => {
  const first = generated();
  const second = generated();
  assert.deepEqual(first.files.map(({ path: filePath, content, mimeType }) => ({ filePath, content: Buffer.from(content).toString('base64'), mimeType })),
    second.files.map(({ path: filePath, content, mimeType }) => ({ filePath, content: Buffer.from(content).toString('base64'), mimeType })));
  assert.equal(first.manifest.documentId, 'document_01');
  assert.equal(first.manifest.revision, 4);
  assert.equal(first.manifest.initialPageId, 'home_page');
  assert.equal(first.validation.status, 'passed');
  assert.equal(first.validation.nodeCount, 14);
  assert.equal(first.manifest.components.length, 14);
  assert.deepEqual(first.viewportReport.viewports.map(({ width }) => width), [1440, 768, 390]);
  assert.equal(first.viewportReport.checks.length, 6);
  assert.deepEqual(first.viewportReport.checks.filter((check) => check.pageId === 'home_page').map((check) => check.viewport.width), [1440, 768, 390]);
  assert.deepEqual(first.interactionReport.bindings.map(({ interaction }) => interaction.action).sort(), ['navigate', 'openModal', 'submitMock', 'toggle']);
  assert.ok(first.interactionReport.missingInteractions.some(({ nodeId }) => nodeId === 'unbound_cta'));
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'preview.html'));
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'public/design-manifest.json'));
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'reports/interaction-report.json'));
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'public/assets/' + first.manifest.assets[0]?.outputSha256 + '.png'));
  for (const file of first.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.includes('\\') && !file.path.split('/').some((part) => part === '..' || part === '.' || part === ''), file.path);
  }
});

test('viewport report uses the same responsive content width as both preview shells', () => {
  assert.equal(effectiveViewportWidth(1440), 1360);
  assert.equal(effectiveViewportWidth(768), 721.92);
  assert.equal(effectiveViewportWidth(390), 366);
  const document = makeDocument() as { pages: Array<{ root: { bounds: { width: number }; children: Array<Record<string, unknown>> } }> };
  const root = document.pages[0]!.root;
  root.bounds.width = 1000;
  root.children.push({
    id: 'edge_node', type: 'rectangle', name: 'Edge item', visible: true, locked: false,
    bounds: { x: 350, y: 300, width: 20, height: 20 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [], strokes: [], effects: [], opacity: 1 }, radius: 0
  });
  const result = generateReactProject({ document, assets: makeAssets() });
  assert.equal(result.success, true);
  if (!result.success) return;
  const mobile = result.viewportReport.checks.find((check) => check.pageId === 'home_page' && check.viewport.width === 390);
  const tablet = result.viewportReport.checks.find((check) => check.pageId === 'home_page' && check.viewport.width === 768);
  assert.equal(mobile?.effectiveWidth, 366);
  assert.equal(mobile?.issues.find((issue) => issue.nodeId === 'edge_node')?.overflowPx, 4);
  assert.equal(tablet?.issues.some((issue) => issue.nodeId === 'edge_node'), false);
  assert.match(textFile(result, 'src/styles.css'), /\.studio-app \{[^}]*padding: 20px clamp\(12px, 3vw, 40px\)/);
  assert.match(textFile(result, 'preview.css'), /body\{margin:0;padding:20px clamp\(12px,3vw,40px\)/);
});

test('viewport report allocates row fill children their actual shared width', () => {
  const document = makeDocument() as { pages: Array<{ root: Record<string, unknown> & { bounds: { width: number }; children: Array<Record<string, unknown>> } }> };
  const root = document.pages[0]!.root;
  root.bounds.width = 1000;
  root.children = [0, 1].map((index) => ({
    id: `fill_frame_${index}`, type: 'frame', name: `Fill frame ${index}`, visible: true, locked: false,
    bounds: { x: 0, y: 0, width: 220, height: 200 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [], strokes: [], effects: [], opacity: 1 },
    children: [{
      id: `fill_edge_${index}`, type: 'rectangle', name: 'Edge item', visible: true, locked: false,
      bounds: { x: 180, y: 0, width: 20, height: 20 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [], strokes: [], effects: [], opacity: 1 }, radius: 0
    }],
    layout: { mode: 'absolute' }, clipContent: false
  }));
  root.layout = { mode: 'flow', direction: 'row', gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 }, align: 'stretch', justify: 'start', childSizing: 'fill' };
  const result = generateReactProject({ document, assets: makeAssets() });
  assert.equal(result.success, true);
  if (!result.success) return;
  const mobile = result.viewportReport.checks.find((check) => check.pageId === 'home_page' && check.viewport.width === 390);
  assert.equal(mobile?.issues.find((issue) => issue.nodeId === 'fill_edge_0')?.overflowPx, 22);
});

test('initialPageId selects the same first page in React, static preview, and manifest; invalid values fail', () => {
  const selected = generateReactProject({ document: makeDocument(), assets: makeAssets(), initialPageId: 'details_page' });
  assert.equal(selected.success, true);
  if (!selected.success) return;
  assert.equal(selected.manifest.initialPageId, 'details_page');
  assert.match(textFile(selected, 'src/App.tsx'), /const INITIAL_PAGE_ID = "details_page"/);
  assert.match(textFile(selected, 'preview.html'), /<section class="preview-page" data-page-id="home_page" hidden>/);
  assert.match(textFile(selected, 'preview.html'), /<section class="preview-page" data-page-id="details_page">/);
  assert.match(textFile(selected, 'preview.js'), /showPage\("details_page"\)/);
  const invalid = generateReactProject({ document: makeDocument(), assets: makeAssets(), initialPageId: 'missing_page' });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.ok(invalid.diagnostics.some(({ code }) => code === 'INITIAL_PAGE_NOT_FOUND'));
});

test('escapes text, titles, attributes, and font values and keeps the preview under a restrictive CSP', () => {
  const document = makeDocument() as { pages: Array<{ root: { children: Array<Record<string, unknown>> } }>; title: string };
  document.pages[0]!.root.children[0] = {
    ...document.pages[0]!.root.children[0],
    text: '</script><img src=x onerror=alert(1)>',
    typography: { fontFamily: '";background:url(https://evil.invalid)', fontSize: 16, fontWeight: 400, lineHeight: 1.4, letterSpacing: 0, textAlign: 'left', color: '#111111' }
  };
  const result = generateReactProject({ document, assets: makeAssets() });
  assert.equal(result.success, true);
  if (!result.success) return;
  const html = textFile(result, 'preview.html');
  const indexHtml = textFile(result, 'index.html');
  const css = textFile(result, 'preview.css');
  const app = textFile(result, 'src/App.tsx');
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /style\s*=/i);
  assert.match(html, /&lt;\/script&gt;&lt;img/);
  assert.doesNotMatch(html, /<img src=x onerror=/i);
  assert.match(indexHtml, /&lt;\/title&gt;&lt;script&gt;/);
  assert.doesNotMatch(indexHtml, /<title><\/title><script>/i);
  assert.match(css, /\\22 /);
  assert.doesNotMatch(css, /font-family:";background:url\(https:/);
  assert.doesNotMatch(app, /<script>/i);
  assert.match(textFile(result, 'preview.js'), /textContent\s*=/);
  assert.doesNotMatch(textFile(result, 'preview.js'), /innerHTML|eval\s*\(/);
});

test('rejects invalid asset digest, size, MIME, and undeclared relative asset input', () => {
  const wrongHashDoc = makeDocument() as { assets: Record<string, { sha256: string }> };
  wrongHashDoc.assets.photo_asset!.sha256 = '0'.repeat(64);
  const wrongHash = generateReactProject({ document: wrongHashDoc, assets: makeAssets() });
  assert.equal(wrongHash.success, false);
  if (!wrongHash.success) assert.ok(wrongHash.diagnostics.some(({ code }) => code === 'ASSET_HASH_MISMATCH'));

  const wrongSizeDoc = makeDocument() as { assets: Record<string, { byteSize: number }> };
  wrongSizeDoc.assets.photo_asset!.byteSize++;
  const wrongSize = generateReactProject({ document: wrongSizeDoc, assets: makeAssets() });
  assert.equal(wrongSize.success, false);
  if (!wrongSize.success) assert.ok(wrongSize.diagnostics.some(({ code }) => code === 'ASSET_SIZE_MISMATCH'));

  const spoofed = generateReactProject({ document: makeDocument(), assets: { photo_asset: new Uint8Array([1, 2, 3, 4]) } });
  assert.equal(spoofed.success, false);
  if (!spoofed.success) assert.ok(spoofed.diagnostics.some(({ code }) => code === 'ASSET_HASH_MISMATCH' || code === 'ASSET_MIME_MISMATCH'));

  const undeclared = generateReactProject({ document: makeDocument(), assets: { ...makeAssets(), '../../escape': pngBytes } });
  assert.equal(undeclared.success, false);
  if (!undeclared.success) assert.ok(undeclared.diagnostics.some(({ code }) => code === 'UNDECLARED_ASSET_BYTES'));
});

test('rejects unknown prototype binding targets at the design-schema boundary', () => {
  const document = makeDocument() as { pages: Array<{ root: { children: Array<Record<string, unknown>> } }> };
  document.pages[0]!.root.children[0]!.interaction = { trigger: 'click', action: 'navigate', targetPageId: 'missing_page' };
  const result = generateReactProject({ document, assets: makeAssets() });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.diagnostics.some(({ code }) => code === 'INTERACTION_TARGET_NOT_FOUND'));
});

test('SVG sanitizer preserves a safe vector subset and rejects script, event, and external references', () => {
  const safe = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10" fill="#123456"/></svg>');
  const sanitized = sanitizeSvg(safe);
  assert.ok(sanitized);
  assert.match(new TextDecoder().decode(sanitized), /<svg/);
  assert.equal(sanitizeSvg(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), undefined);
  assert.equal(sanitizeSvg(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>')), undefined);
  assert.equal(sanitizeSvg(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.invalid/x.png"/></svg>')), undefined);
});

test('preview runtime executes navigate, openModal, toggle, submitMock, and close behavior', () => {
  const root = new PreviewElement();
  const app = root.append(new PreviewElement());
  const pageA = app.append(new PreviewElement({ pageId: 'home_page' }));
  const pageB = app.append(new PreviewElement({ pageId: 'details_page' }));
  const navButton = app.append(new PreviewElement({ previewPage: 'details_page' }));
  const navigate = pageA.append(new PreviewElement({ action: 'navigate', targetPage: 'home_page' }));
  const openModal = pageA.append(new PreviewElement({ action: 'openModal', targetNode: 'modal_frame' }));
  const toggle = pageA.append(new PreviewElement({ action: 'toggle', targetNode: 'hidden_target' }));
  const hiddenTarget = pageA.append(new PreviewElement({ nodeId: 'hidden_target' })); hiddenTarget.hidden = true;
  const submit = pageA.append(new PreviewElement({ action: 'submitMock', nodeId: 'submit_control', successMessage: 'Saved for demo' }));
  const status = pageA.append(new PreviewElement({ submitFor: 'submit_control' }));
  const overlay = root.append(new PreviewElement({ modalOverlayFor: 'modal_frame' })); overlay.hidden = true;
  overlay.attributes.role = 'presentation';
  overlay.append(new PreviewElement({}, { role: 'dialog' }));
  const close = overlay.append(new PreviewElement()); close.dataset.closeModal = '';
  const documentListeners = new Map<string, Array<(event: PreviewEvent) => void>>();
  const document = {
    getElementById: (id: string) => id === 'preview-app' ? app : null,
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    addEventListener: (name: string, listener: (event: PreviewEvent) => void) => {
      const listeners = documentListeners.get(name) ?? []; listeners.push(listener); documentListeners.set(name, listeners);
    }
  };
  runInNewContext(textFile(generated(), 'preview.js'), { document, Element: PreviewElement });
  const click = (element: PreviewElement) => {
    const event = { target: element };
    for (const listener of app.listeners.get('click') ?? []) listener(event);
    for (const listener of documentListeners.get('click') ?? []) listener(event);
  };
  assert.equal(pageA.hidden, false);
  assert.equal(pageB.hidden, true);
  click(navButton);
  assert.equal(pageA.hidden, true);
  assert.equal(pageB.hidden, false);
  let defaultPrevented = false;
  for (const listener of app.listeners.get('keydown') ?? []) listener({ target: navigate, key: 'Enter', preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true);
  assert.equal(pageA.hidden, false);
  assert.equal(pageB.hidden, true);
  defaultPrevented = false;
  for (const listener of app.listeners.get('keydown') ?? []) listener({ target: openModal, key: ' ', preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true);
  assert.equal(overlay.hidden, false);
  click(close);
  assert.equal(overlay.hidden, true);
  defaultPrevented = false;
  for (const listener of app.listeners.get('keydown') ?? []) listener({ target: toggle, key: ' ', preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true);
  assert.equal(hiddenTarget.hidden, false);
  click(toggle);
  assert.equal(hiddenTarget.hidden, true);
  for (const listener of app.listeners.get('keydown') ?? []) listener({ target: submit, key: 'Enter', preventDefault: () => {} });
  assert.equal(status.textContent, 'Saved for demo');
  click(openModal);
  for (const listener of documentListeners.get('keydown') ?? []) listener({ target: overlay, key: 'Escape' });
  assert.equal(overlay.hidden, true);
});

test('fixture asset hash is the source digest used by the manifest', () => {
  assert.equal(sha256(pngBytes), '64b2d09c0958f04cf921d5ab402e99e5ce9cfb8dc60ac79f257f566e300cdfe7');
});
