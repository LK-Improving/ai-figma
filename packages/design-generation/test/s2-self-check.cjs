"use strict";

const assert = require('node:assert/strict');
const { createStarterDocument } = require('@miaoma/editor-core');
const { generatedFrameContentSchema, generationCandidateSchema } = require('@miaoma/shared-protocol');
const { renderDocumentScreenshot } = require('@miaoma/renderer-canvas');
const { FakeFrameProvider, GenerationRunError, GenerationRunService } = require('../dist/index.js');

function makeRequest(document, extra = {}) {
  return {
    documentId: document.documentId,
    title: '茶饮新品发布页',
    prompt: '制作一个清爽的茶饮产品介绍页面，包含客户评价、常见问题和套餐价格。重点展示天然原料。',
    pageId: document.pages[0].id,
    baseRevision: document.revision,
    viewport: { width: 1280, height: 900 },
    providerRef: 'local-fake',
    maxParallel: 1,
    targetNodeIds: [],
    referenceAssetIds: [],
    constraints: ['不要编造销量数据', '保留简洁清晰的文案'],
    ...extra
  };
}

function terminalSnapshot(service, runId) {
  const immediate = service.get(runId);
  if (['completed', 'cancelled', 'failed', 'conflict', 'needs_review'].includes(immediate.run.state)) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Run ${runId} did not reach a terminal state`));
    }, 5_000);
    const unsubscribe = service.subscribe((event) => {
      if (event.runId !== runId || event.type !== 'stateChanged') return;
      if (!['completed', 'cancelled', 'failed', 'conflict', 'needs_review'].includes(event.payload.to)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(service.get(runId));
    });
  });
}

function waitForProviderStart() {
  let signal;
  let resolveStarted;
  let resolveResult;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const provider = {
    name: 'deferred-provider',
    generateFrame(_input, options = {}) {
      signal = options.signal;
      resolveStarted();
      // Deliberately ignores AbortSignal so the run fence, not provider behavior, is tested.
      return result;
    }
  };
  return { provider, started, getSignal: () => signal, resolve: resolveResult };
}

async function main() {
  const source = createStarterDocument('S2 source design');
  const untouched = structuredClone(source);
  assert.equal(generatedFrameContentSchema.safeParse({ frameName: 'Frame', headline: 'bad\u0001headline', description: 'Valid text' }).success, false, 'Provider output rejects XML 1.0 control characters');
  const unsafePreviewDocument = structuredClone(source);
  unsafePreviewDocument.title = 'Design \u0001 <preview>';
  const unsafeText = unsafePreviewDocument.pages[0].root.children.find((node) => node.type === 'text');
  unsafeText.text = 'hello\u0001<design>';
  const safePreview = renderDocumentScreenshot(unsafePreviewDocument).svg;
  assert.equal(safePreview.includes('\u0001'), false, 'SVG output strips characters that XML 1.0 forbids');
  assert.equal(safePreview.includes('Design  &lt;preview&gt;'), true);
  assert.equal(safePreview.includes('hello&lt;design&gt;'), true);
  const request = makeRequest(source);
  const fake = new FakeFrameProvider();
  const service = new GenerationRunService({ providers: { 'local-fake': fake } });

  const planA = service.plan(request, source);
  const planB = service.plan(request, source);
  assert.deepEqual(planA, planB, 'Planner output must be deterministic for the same request and base snapshot');
  assert.deepEqual(planA.regions.map((region) => region.order), planA.regions.map((_, index) => index));
  assert.equal(planA.regions.some((region) => region.id.endsWith('_proof')), true);
  assert.equal(planA.regions.some((region) => region.id.endsWith('_faq')), true);
  assert.equal(planA.regions.some((region) => region.id.endsWith('_pricing')), true);
  assert.deepEqual(service.plan(makeRequest(source, { targetNodeIds: [source.pages[0].root.id] }), source), planA, 'The page root is an explicit full-page scope');
  assert.throws(() => service.plan(makeRequest(source, { targetNodeIds: ['text_title'] }), source), (error) => error instanceof GenerationRunError && error.code === 'UNSUPPORTED_SCOPE');
  assert.throws(() => service.plan(makeRequest(source, { prompt: 'x'.repeat(20_000) }), source), (error) => error instanceof GenerationRunError && error.code === 'PROVIDER_INPUT_TOO_LARGE', 'Combined provider prompt limits are reported during planning');

  const observed = [];
  service.subscribe((event) => observed.push(event));
  const queued = service.start(request, source);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.eventSeq, 1);
  const completed = await terminalSnapshot(service, queued.runId);
  assert.equal(completed.run.state, 'completed');
  assert.equal(completed.run.candidateAvailable, true);
  assert.equal(completed.run.eventSeq, observed.length);
  assert.deepEqual(observed.map((event) => event.seq), Array.from({ length: observed.length }, (_, index) => index + 1));
  const stateEvents = observed.filter((event) => event.type === 'stateChanged');
  assert.equal(stateEvents.at(-1).payload.to, 'completed', 'State transition events expose their destination state');
  assert.deepEqual(completed.events.map((event) => event.seq), observed.map((event) => event.seq));
  const replay = service.get(queued.runId, 4);
  assert.deepEqual(replay.events.map((event) => event.seq), observed.filter((event) => event.seq > 4).map((event) => event.seq));
  assert.equal(replay.run.eventSeq, completed.run.eventSeq, 'Snapshot cursor filters events but preserves the latest run sequence');

  const candidate = service.getCandidate(queued.runId);
  assert.ok(candidate);
  assert.equal(generationCandidateSchema.safeParse(candidate).success, true);
  assert.equal(candidate.baseRevision, source.revision);
  assert.equal(candidate.document.revision, source.revision, 'Candidate keeps its source revision until Main explicitly applies it');
  assert.equal(candidate.document.pages[0].root.children.length, candidate.plan.regions.length);
  assert.equal(candidate.previewSvg.startsWith('<svg'), true);
  assert.deepEqual(source, untouched, 'Generation must never write into the formal document');
  candidate.document.title = 'mutated caller copy';
  assert.notEqual(service.getCandidate(queued.runId).document.title, 'mutated caller copy', 'Candidate reads return detached snapshots');

  assert.throws(() => service.start(makeRequest(source, { baseRevision: source.revision + 1 }), source), (error) => error instanceof GenerationRunError && error.code === 'REVISION_CONFLICT');

  const deferred = waitForProviderStart();
  const cancelService = new GenerationRunService({ providers: { 'local-fake': deferred.provider } });
  const cancelRun = cancelService.start(request, source);
  await deferred.started;
  assert.throws(() => cancelService.start(request, source), (error) => error instanceof GenerationRunError && error.code === 'RUN_ALREADY_ACTIVE');
  assert.equal(cancelService.cancel(cancelRun.runId), true);
  assert.equal(deferred.getSignal().aborted, true, 'Cancellation must abort the provider signal');
  assert.equal(cancelService.get(cancelRun.runId).run.state, 'cancelled');
  assert.equal(cancelService.getCandidate(cancelRun.runId), undefined);
  deferred.resolve({ frameName: 'late', headline: 'Late candidate', description: 'This provider ignored cancellation.' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelService.get(cancelRun.runId).run.state, 'cancelled');
  assert.equal(cancelService.getCandidate(cancelRun.runId), undefined, 'A late provider result must be fenced');
  assert.equal(cancelService.get(cancelRun.runId).events.some((event) => event.type === 'candidateReady'), false);
  assert.equal(cancelService.cancel(cancelRun.runId), false, 'Terminal cancellation is idempotent');

  const retainedService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() } });
  let oldestRunId;
  for (let index = 0; index < 11; index++) {
    const run = retainedService.start(request, source);
    if (index === 0) oldestRunId = run.runId;
    await terminalSnapshot(retainedService, run.runId);
  }
  assert.throws(() => retainedService.get(oldestRunId), (error) => error instanceof GenerationRunError && error.code === 'RUN_NOT_FOUND', 'Old terminal runs are evicted after the retention cap');

  const invalidOutputProvider = {
    name: 'invalid-output',
    async generateFrame() { return { frameName: 'Frame', headline: '', description: 'Missing headline.' }; }
  };
  const invalidService = new GenerationRunService({ providers: { 'local-fake': invalidOutputProvider } });
  const invalidRun = invalidService.start(request, source);
  const invalidResult = await terminalSnapshot(invalidService, invalidRun.runId);
  assert.equal(invalidResult.run.state, 'failed');
  assert.equal(invalidResult.run.error.code, 'PROVIDER_SCHEMA_INVALID');
  const invalidEvent = invalidResult.events.find((event) => event.type === 'validationReported');
  assert.equal(invalidEvent.payload.regionId, planA.regions[0].id);
  assert.deepEqual(invalidEvent.payload.path, ['headline']);
  assert.match(invalidResult.run.error.message, new RegExp(planA.regions[0].id));
  assert.equal(invalidService.getCandidate(invalidRun.runId), undefined);

  const providerError = Object.assign(new Error('mock timeout'), { code: 'MODEL_TIMEOUT', retryable: true });
  const failingProvider = { name: 'failing-provider', async generateFrame() { throw providerError; } };
  const failedService = new GenerationRunService({ providers: { 'local-fake': failingProvider } });
  const failedRun = failedService.start(request, source);
  const failedResult = await terminalSnapshot(failedService, failedRun.runId);
  assert.equal(failedResult.run.state, 'failed');
  assert.equal(failedResult.run.error.code, 'MODEL_TIMEOUT');
  assert.equal(failedResult.run.error.retryable, true);
  const providerErrorEvent = failedResult.events.find((event) => event.type === 'error');
  assert.equal(providerErrorEvent.payload.regionId, planA.regions[0].id);
  assert.match(providerErrorEvent.payload.message, new RegExp(planA.regions[0].id));
  assert.equal(failedService.getCandidate(failedRun.runId), undefined);

  console.log('design-generation S2 self-check passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
