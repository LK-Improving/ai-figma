import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DeepSeekVisualReviewer } = require('../dist/deepseek-reviewer.js');
const API_KEY = 'test-only-secret-key';
const PAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><text>Sample title</text></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function frame(id, children = [], text = '') {
  return {
    id, type: 'frame', name: id, visible: true, locked: false,
    bounds: { x: 0, y: 0, width: 640, height: 480 },
    transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [], strokes: [], effects: [], opacity: 1 },
    layout: { mode: 'absolute' }, clipContent: true,
    ...(text ? { children: [...children, textNode(`${id}_label`, text)] } : { children })
  };
}

function textNode(id, text) {
  return {
    id, type: 'text', name: id, visible: true, locked: false,
    bounds: { x: 16, y: 24, width: 300, height: 40 },
    transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [], strokes: [], effects: [], opacity: 1 },
    text,
    typography: { fontFamily: 'Arial', fontSize: 24, fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, textAlign: 'left', color: '#222222' },
    sizing: 'fixed'
  };
}

function makeInput({ svg = PAGE_SVG, document = undefined, pageId = 'target_page', assetStatus = 'ready' } = {}) {
  const design = document ?? {
    documentVersion: '1.0', documentId: 'document_test', fileToken: 'file_token_for_tests', revision: 7,
    title: 'Visual review fixture', variables: {}, assets: {},
    pages: [
      { id: 'target_page', name: 'Target', root: frame('target_root', [textNode('title_node', 'Sample title'), textNode('body_node', 'Readable body copy')]) },
      { id: 'other_page', name: 'Other', root: frame('other_root', [textNode('private_other_page_node', 'Other page confidential content')]) }
    ]
  };
  const target = design.pages.find((page) => page.id === pageId);
  const nodeIds = [];
  const stack = target ? [target.root] : [];
  while (stack.length) {
    const node = stack.pop();
    nodeIds.push(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  return {
    document: design,
    plan: { summary: 'A clean single page', pagePurpose: 'Show a simple product landing page', regions: [], acceptanceCriteria: [] },
    evidence: {
      evidenceId: 'evidence_1', runId: 'run_1', attemptId: 'attempt_1', reviewRound: 0,
      documentId: design.documentId, revision: design.revision, candidateRevision: 0, pageId,
      imageHash: createHash('sha256').update(svg).digest('hex'), width: 640, height: 480, scale: 1,
      mimeType: 'image/svg+xml', nodeIds, fontsReady: true, assetStatus
    },
    previewSvg: svg
  };
}

function report(overrides = {}) {
  return {
    structurePassed: true,
    issues: [{ severity: 'warning', category: 'readability', summary: 'Body text is small', message: 'Increase the body text size for comfortable reading.', nodeIds: ['body_node'] }],
    ...overrides
  };
}

function completionResponse(content, init = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init
  });
}

function reviewer({ fetchImpl, content = JSON.stringify(report()), getApiKey = async () => API_KEY, rasterizeSvg = async () => PNG, ...options } = {}) {
  return new DeepSeekVisualReviewer({
    getApiKey,
    rasterizeSvg,
    fetchImpl: fetchImpl ?? (async () => completionResponse(content)),
    baseUrl: 'https://api.deepseek.example/v1',
    ...options
  });
}

async function doReview(provider, input = makeInput(), signal = new AbortController().signal) {
  return provider.review(input, { signal });
}

test('sends OpenAI-compatible PNG vision request with only target-page evidence and returns a valid report', async () => {
  let requestUrl;
  let requestInit;
  let rasterizedSvg;
  const provider = reviewer({
    rasterizeSvg: async (svg) => { rasterizedSvg = svg; return PNG; },
    fetchImpl: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return completionResponse(JSON.stringify(report()));
    }
  });
  const result = await doReview(provider);

  assert.equal(requestUrl, 'https://api.deepseek.example/v1/chat/completions');
  assert.equal(requestInit.method, 'POST');
  assert.equal(requestInit.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(requestInit.headers['content-type'], 'application/json');
  assert.equal(rasterizedSvg, PAGE_SVG);
  const body = JSON.parse(requestInit.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /untrusted design data/);
  assert.match(body.messages[0].content, /never instructions/);
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content[0].type, 'text');
  const promptData = JSON.parse(body.messages[1].content[0].text);
  assert.equal(promptData.targetPageId, 'target_page');
  assert.ok(promptData.nodes.some((node) => node.id === 'title_node'));
  assert.ok(!body.messages[1].content[0].text.includes('Other page confidential content'));
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(body.messages[1].content[1].image_url.detail, 'high');
  assert.deepEqual(result, report());
});

test('rejects invalid JSON, malformed structures, unsupported enum values, oversized text, and foreign-page node IDs', async (t) => {
  const badOutputs = [
    ['non-JSON output', 'Not JSON'],
    ['missing structurePassed', JSON.stringify({ issues: [] })],
    ['unsupported top-level property', JSON.stringify({ ...report(), extra: true })],
    ['invalid category', JSON.stringify(report({ issues: [{ severity: 'warning', category: 'pixel-perfect', summary: 'Issue', message: 'Message', nodeIds: [] }] }))],
    ['invalid severity', JSON.stringify(report({ issues: [{ severity: 'critical', category: 'contrast', summary: 'Issue', message: 'Message', nodeIds: [] }] }))],
    ['overlong summary', JSON.stringify(report({ issues: [{ severity: 'info', category: 'other', summary: 'x'.repeat(257), message: 'Message', nodeIds: [] }] }))],
    ['overlong message', JSON.stringify(report({ issues: [{ severity: 'info', category: 'other', summary: 'Issue', message: 'x'.repeat(1_001), nodeIds: [] }] }))],
    ['foreign page node ID', JSON.stringify(report({ issues: [{ severity: 'warning', category: 'other', summary: 'Issue', message: 'Message', nodeIds: ['private_other_page_node'] }] }))]
  ];
  for (const [name, content] of badOutputs) {
    await t.test(name, async () => {
      const provider = reviewer({ content });
      await assert.rejects(doReview(provider), /DeepSeek visual review failed/);
    });
  }
});

test('rejects model HTTP errors without exposing the key or response body', async () => {
  const privateBody = `Provider echoed ${API_KEY} and account details`;
  const provider = reviewer({ fetchImpl: async () => new Response(privateBody, { status: 401 }) });
  await assert.rejects(doReview(provider), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /test-only-secret-key|account details|Provider echoed/);
    return true;
  });
});

test('timeout aborts the request and external cancellation is propagated', async (t) => {
  await t.test('finite timeout', async () => {
    let requestSignal;
    const provider = reviewer({
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        init.signal.addEventListener('abort', () => reject(new Error('fetch aborted')));
      })
    });
    await assert.rejects(doReview(provider), /request timed out/);
    assert.equal(requestSignal.aborted, true);
  });

  await t.test('caller cancellation', async () => {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let requestSignal;
    const provider = reviewer({
      timeoutMs: 2_000,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        markStarted();
        init.signal.addEventListener('abort', () => reject(new Error('fetch aborted')));
      })
    });
    const controller = new AbortController();
    const pending = doReview(provider, makeInput(), controller.signal);
    await started;
    controller.abort();
    await assert.rejects(pending, /request was cancelled/);
    assert.equal(requestSignal.aborted, true);
  });
});

test('missing API key never rasterizes or sends a request', async () => {
  let rasterizeCount = 0;
  let fetchCount = 0;
  const provider = reviewer({
    getApiKey: async () => null,
    rasterizeSvg: async () => { rasterizeCount++; return PNG; },
    fetchImpl: async () => { fetchCount++; return completionResponse(JSON.stringify(report())); }
  });
  await assert.rejects(doReview(provider), /API key is not configured/);
  assert.equal(rasterizeCount, 0);
  assert.equal(fetchCount, 0);
});

test('cloud review fails closed before sending when image assets are missing or consent is revoked', async (t) => {
  await t.test('missing image assets', async () => {
    let keyReads = 0;
    let rasterizeCount = 0;
    let fetchCount = 0;
    const provider = reviewer({
      getApiKey: async () => { keyReads++; return API_KEY; },
      rasterizeSvg: async () => { rasterizeCount++; return PNG; },
      fetchImpl: async () => { fetchCount++; return completionResponse(JSON.stringify(report())); }
    });
    await assert.rejects(doReview(provider, makeInput({ assetStatus: 'missing' })), /missing image assets/);
    assert.equal(keyReads, 0);
    assert.equal(rasterizeCount, 0);
    assert.equal(fetchCount, 0);
  });

  await t.test('authorization revoked while decrypting the key', async () => {
    let allowed = true;
    let rasterizeCount = 0;
    let fetchCount = 0;
    const provider = reviewer({
      isAllowed: () => allowed,
      getApiKey: async () => { allowed = false; return API_KEY; },
      rasterizeSvg: async () => { rasterizeCount++; return PNG; },
      fetchImpl: async () => { fetchCount++; return completionResponse(JSON.stringify(report())); }
    });
    await assert.rejects(doReview(provider), /no longer authorized/);
    assert.equal(rasterizeCount, 0);
    assert.equal(fetchCount, 0);
  });

  await t.test('authorization revoked during rasterization', async () => {
    let allowed = true;
    let fetchCount = 0;
    const provider = reviewer({
      isAllowed: () => allowed,
      rasterizeSvg: async () => { allowed = false; return PNG; },
      fetchImpl: async () => { fetchCount++; return completionResponse(JSON.stringify(report())); }
    });
    await assert.rejects(doReview(provider), /no longer authorized/);
    assert.equal(fetchCount, 0);
  });
});

test('enforces PNG and response-size limits', async (t) => {
  await t.test('oversized raster output', async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    oversized.set(PNG.subarray(0, 8));
    const provider = reviewer({ rasterizeSvg: async () => oversized });
    await assert.rejects(doReview(provider), /invalid or oversized PNG/);
  });

  await t.test('oversized model response', async () => {
    const provider = reviewer({ fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1), { status: 200 }) });
    await assert.rejects(doReview(provider), /response exceeded the size limit/);
  });

  await t.test('oversized serialized request is not sent', async () => {
    const largePage = { id: 'target_page', name: 'Target', root: frame('target_root', Array.from({ length: 499 }, (_, index) => textNode(`node_${index}`, '😀'.repeat(512)))) };
    const input = makeInput({ document: {
      documentVersion: '1.0', documentId: 'large_document', fileToken: 'file_token_for_tests', revision: 1,
      title: 'Large request', variables: {}, assets: {}, pages: [largePage]
    } });
    const largePng = new Uint8Array(8 * 1024 * 1024);
    largePng.set(PNG.subarray(0, 8));
    let fetchCount = 0;
    const provider = reviewer({
      rasterizeSvg: async () => largePng,
      fetchImpl: async () => { fetchCount++; return completionResponse(JSON.stringify(report())); }
    });
    await assert.rejects(doReview(provider, input), /request exceeded the size limit/);
    assert.equal(fetchCount, 0);
  });
});
