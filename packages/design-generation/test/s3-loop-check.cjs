"use strict";

const assert = require('node:assert/strict');
const { createStarterDocument } = require('@miaoma/editor-core');
const { designPlanSchema } = require('@miaoma/shared-protocol');
const { GenerationRunService, FakeFrameProvider, RuleBasedVisualReviewer } = require('../dist/index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRequest(document, extra = {}) {
  const page = document.pages[0];
  return {
    documentId: document.documentId,
    title: 'S3 visual loop test',
    prompt: 'Create a concise product landing page with a clear call to action.',
    pageId: page.id,
    targetNodeIds: [],
    baseRevision: document.revision,
    viewport: { width: page.root.bounds.width, height: page.root.bounds.height },
    referenceAssetIds: [],
    providerRef: 'local-fake',
    constraints: [],
    maxParallel: 3,
    ...extra
  };
}

async function waitForTerminal(service, runId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = service.get(runId);
    if (['interrupted', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review'].includes(snapshot.run.state)) return snapshot;
    await delay(5);
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('Timed out waiting for a durable S3 checkpoint');
}

async function loopRepairsAreBoundedAndParallel() {
  const source = createStarterDocument('S3 test', 'Editable source');
  const untouched = structuredClone(source);
  let active = 0;
  let maxActive = 0;
  const provider = {
    name: 'parallel-test-provider',
    async generateFrame(input) {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(15 + Math.floor(Math.random() * 20));
      active--;
      return { frameName: 'Section', headline: input.title.slice(0, 80), description: 'A concise supporting description.' };
    }
  };
  let reviewCount = 0;
  const reviewer = {
    name: 'test-reviewer',
    async review({ document, plan }) {
      reviewCount++;
      if (reviewCount > 2) return { structurePassed: true, issues: [] };
      const regionRoot = document.pages[0].root.children.find((node) => node.id === `${plan.regions[0].id}_section`);
      const target = regionRoot.children.find((node) => node.type === 'text');
      return {
        structurePassed: true,
        issues: [{ severity: 'warning', category: 'contrast', summary: 'Test contrast warning', message: 'The fixture requires a bounded repair.', nodeIds: [target.id] }]
      };
    }
  };
  const repairProvider = {
    name: 'test-repair-provider',
    async propose({ document, report, allowedNodeIds }) {
      const issue = report.issues.find((item) => item.status !== 'resolved');
      assert.ok(issue);
      assert.ok(allowedNodeIds.includes(issue.nodeIds[0]));
      const target = document.pages[0].root.children.flatMap((region) => region.type === 'frame' ? region.children : []).find((node) => node.id === issue.nodeIds[0]);
      return [{ nodeId: target.id, patch: { typography: { ...target.typography, color: '#111111' } } }];
    }
  };
  const service = new GenerationRunService({
    providers: { 'local-fake': provider },
    visualReviewer: reviewer,
    repairProvider,
    fontsReady: true
  });
  const request = makeRequest(source, { maxParallel: 3 });
  const plan = service.plan(request, source);
  assert.equal(plan.ownershipMap.length, plan.regions.length);
  const duplicateOwner = designPlanSchema.safeParse({
    ...plan,
    ownershipMap: [...plan.ownershipMap, { ...plan.ownershipMap[0] }]
  });
  assert.equal(duplicateOwner.success, false, 'A region cannot be owned by two different agents');

  const started = service.start(request, source);
  const completed = await waitForTerminal(service, started.runId);
  assert.equal(completed.run.state, 'completed');
  assert.equal(completed.run.candidateAvailable, true);
  assert.equal(maxActive, 3, 'The provider worker pool honors the configured concurrency cap');
  assert.equal(completed.collaboration.maxParallel, 3);
  assert.equal(completed.collaboration.tasks.every((task) => task.state === 'completed' && task.leaseId), true);
  assert.equal(completed.loop.repairRound, 2);
  assert.deepEqual(completed.loop.reports.map((report) => report.reviewRound), [0, 1, 2]);
  assert.equal(completed.loop.evidence.length, 3);
  assert.equal(completed.loop.proposals.length, 2);
  assert.equal(completed.loop.proposals.every((proposal) => proposal.status === 'applied'), true);
  assert.equal(completed.events.filter((event) => event.type === 'patchCommitted').length, 2);
  assert.deepEqual(source, untouched, 'Review and repairs operate on an isolated candidate');
  assert.equal(completed.candidate.document.revision, source.revision, 'Candidate revisions stay virtual until explicit apply');
}

async function foreignPageNodesCannotBeRepairedByPrefix() {
  const source = createStarterDocument('S3 ownership test', 'Editable source');
  const initialRequest = makeRequest(source, { maxParallel: 1 });
  const planner = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: true });
  const plan = planner.plan(initialRequest, source);
  const foreignId = `${plan.regions[0].id}_foreign_text`;
  const missingRegions = await new RuleBasedVisualReviewer().review({
    document: source,
    plan,
    evidence: { pageId: source.pages[0].id },
    previewSvg: ''
  }, { signal: new AbortController().signal });
  assert.equal(missingRegions.structurePassed, false, 'Requirement validation checks planned region identities, not only child count');
  assert.equal(missingRegions.issues.some((issue) => issue.category === 'requirement'), true);
  const otherPage = {
    id: 'page_foreign',
    name: 'Other page',
    root: {
      id: 'frame_foreign_root', type: 'frame', name: 'Other page root', visible: true, locked: false,
      bounds: { x: 0, y: 0, width: 1280, height: 900 },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [], strokes: [], effects: [], opacity: 1 },
      layout: { mode: 'absolute' }, clipContent: true,
      children: [{
        id: foreignId, type: 'text', name: 'Foreign node', visible: true, locked: false,
        bounds: { x: 0, y: 0, width: 400, height: 48 },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 },
        style: { fills: [], strokes: [], effects: [], opacity: 1 },
        text: 'Foreign',
        typography: { fontFamily: 'Arial, sans-serif', fontSize: 20, fontWeight: 400, lineHeight: 1.4, letterSpacing: 0, textAlign: 'left', color: '#000000' },
        sizing: 'auto'
      }]
    }
  };
  const document = structuredClone(source);
  document.pages.push(otherPage);
  const reviewer = {
    name: 'foreign-node-reviewer',
    async review() {
      return { structurePassed: true, issues: [{ severity: 'blocker', category: 'overflow', summary: 'Foreign node issue', message: 'This node belongs to another page.', nodeIds: [foreignId] }] };
    }
  };
  const service = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, visualReviewer: reviewer, fontsReady: true });
  const started = service.start(makeRequest(document, { maxParallel: 1 }), document);
  const result = await waitForTerminal(service, started.runId);
  assert.equal(result.run.state, 'needs_review');
  assert.equal(result.loop.quality, 'blocked');
  assert.equal(result.events.some((event) => event.type === 'repairDelegated'), false, 'A matching ID prefix cannot grant cross-page repair authority');
}

async function interruptedRunsResumeFromDurableRegionalResults() {
  const source = createStarterDocument('S3 recovery test', 'Editable source');
  const request = makeRequest(source, { maxParallel: 1 });
  const persistedEvents = [];
  const persistedCheckpoints = [];
  let persistenceEnabled = true;
  let providerCalls = 0;
  let releaseBlocked;
  let notifyBlocked;
  const blockedStarted = new Promise((resolve) => { notifyBlocked = resolve; });
  const blockedResult = new Promise((resolve) => { releaseBlocked = resolve; });
  const provider = {
    name: 'recoverable-test-provider',
    async generateFrame(input) {
      providerCalls++;
      if (providerCalls === 2) {
        notifyBlocked();
        await blockedResult;
      }
      return { frameName: 'Section', headline: input.title.slice(0, 80), description: 'A recoverable supporting description.' };
    }
  };
  const persistence = {
    async persistEvent(_projectId, event) { if (persistenceEnabled) persistedEvents.push(structuredClone(event)); },
    async persistCheckpoint(checkpoint) {
      if (!persistenceEnabled) return;
      persistedCheckpoints.push(structuredClone(checkpoint));
      return { checkpointId: checkpoint.loop.checkpointId };
    },
    async persistEvidence() { return undefined; }
  };
  const firstService = new GenerationRunService({ providers: { 'local-fake': provider }, fontsReady: true, ...persistence });
  const started = firstService.start(request, source, 'project_recovery');
  await blockedStarted;
  const checkpoint = await waitFor(() => [...persistedCheckpoints].reverse().find((item) => Object.keys(item.completedRegions).length > 0));
  const eventsBeforeRestart = structuredClone(persistedEvents).sort((left, right) => left.seq - right.seq);
  assert.ok(eventsBeforeRestart.length > 0);
  persistenceEnabled = false;
  firstService.cancel(started.runId);
  releaseBlocked();

  persistenceEnabled = true;
  const resumedService = new GenerationRunService({ providers: { 'local-fake': provider }, fontsReady: true, ...persistence });
  const interrupted = resumedService.restore(structuredClone(checkpoint), eventsBeforeRestart, source);
  assert.equal(interrupted.state, 'interrupted');
  const resumed = await resumedService.resume(started.runId, interrupted.attemptId, source, 'project_recovery');
  assert.notEqual(resumed.attemptId, interrupted.attemptId, 'Resume creates a fresh attempt fence');
  const result = await waitForTerminal(resumedService, started.runId);
  assert.equal(result.run.state, 'completed');
  assert.equal(result.run.candidateAvailable, true);
  assert.equal(providerCalls, result.collaboration.tasks.length + 1, 'Completed regional outputs are reused and stale work is reissued once');
  assert.equal(result.events.some((event) => event.type === 'runResumed' && event.attemptId === resumed.attemptId), true);
  assert.equal(result.collaboration.tasks.every((task) => task.attemptId === resumed.attemptId && task.state === 'completed'), true);
}

async function staleCheckpointAfterTerminalEventFailsClosed() {
  const source = createStarterDocument('S3 terminal recovery test', 'Editable source');
  const durableEvents = [];
  let staleCheckpoint;
  let finalCheckpoint;
  const service = new GenerationRunService({
    providers: { 'local-fake': new FakeFrameProvider() },
    visualReviewer: { name: 'terminal-recovery-reviewer', async review() { return { structurePassed: true, issues: [] }; } },
    fontsReady: true,
    async persistEvent(_projectId, event) { durableEvents.push(structuredClone(event)); },
    async persistCheckpoint(checkpoint) {
      if (checkpoint.phase === 'completed') finalCheckpoint = structuredClone(checkpoint);
      else staleCheckpoint = structuredClone(checkpoint);
      return { checkpointId: checkpoint.loop.checkpointId };
    },
    async persistEvidence() { return undefined; }
  });
  const started = service.start(makeRequest(source, { maxParallel: 1 }), source, 'project_terminal_gap');
  const finished = await waitForTerminal(service, started.runId);
  assert.equal(finished.run.state, 'completed');
  assert.ok(staleCheckpoint);
  assert.notEqual(staleCheckpoint.phase, 'completed');
  assert.ok(durableEvents.some((event) => event.type === 'stateChanged' && event.payload.to === 'completed'));

  const restoredService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: true });
  const recovered = restoredService.restore(staleCheckpoint, structuredClone(durableEvents), source);
  const snapshot = restoredService.get(started.runId);
  assert.equal(recovered.state, 'failed', 'A terminal event newer than its checkpoint cannot turn an unverified candidate into an interrupted run');
  assert.equal(recovered.candidateAvailable, false);
  assert.equal(snapshot.candidate, undefined);
  assert.equal(recovered.error.code, 'RUN_RECOVERY_FAILED');

  assert.ok(finalCheckpoint);
  const inconsistentCheckpoint = structuredClone(finalCheckpoint);
  inconsistentCheckpoint.loop.stage = 'blocked';
  inconsistentCheckpoint.loop.quality = 'blocked';
  const inconsistentService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: true });
  const inconsistent = inconsistentService.restore(inconsistentCheckpoint, structuredClone(durableEvents), source);
  assert.equal(inconsistent.state, 'failed', 'A completed checkpoint with blocked review quality cannot expose an applicable candidate');
  assert.equal(inconsistent.candidateAvailable, false);
  assert.equal(inconsistentService.get(started.runId).candidate, undefined);

  const reportMismatchCheckpoint = structuredClone(finalCheckpoint);
  reportMismatchCheckpoint.loop.reports.at(-1).issues.push({
    issueId: 'issue_recovery_blocker_1', severity: 'blocker', category: 'structure', summary: 'Unresolved structure issue',
    message: 'This issue contradicts the completed pass decision.', nodeIds: [], firstSeenRound: reportMismatchCheckpoint.loop.reviewRound, status: 'open'
  });
  const reportMismatchService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: true });
  const reportMismatch = reportMismatchService.restore(reportMismatchCheckpoint, structuredClone(durableEvents), source);
  assert.equal(reportMismatch.state, 'failed', 'A pass report containing an open blocker cannot restore an applicable candidate');
  assert.equal(reportMismatch.candidateAvailable, false);
}

async function visualResumeUsesTheDurablePatchedCandidate() {
  const source = createStarterDocument('S3 visual resume test', 'Editable source');
  let releaseSecondReview;
  let signalSecondReview;
  const secondReviewBlocked = new Promise((resolve) => { signalSecondReview = resolve; });
  const releaseReview = new Promise((resolve) => { releaseSecondReview = resolve; });
  let blockSecondReview = true;
  let repairCalls = 0;
  const reviewCalls = [];
  const durableEvents = [];
  const durableCheckpoints = [];
  const evidenceById = new Map();
  const provider = new FakeFrameProvider();
  const visualReviewer = {
    name: 'resume-round-reviewer',
    async review({ document, plan, evidence }) {
      reviewCalls.push({ attemptId: evidence.attemptId, round: evidence.reviewRound });
      if (evidence.reviewRound === 0) {
        const region = document.pages[0].root.children.find((node) => node.id === `${plan.regions[0].id}_section`);
        const text = region.children.find((node) => node.type === 'text');
        return { structurePassed: true, issues: [{ severity: 'warning', category: 'contrast', summary: 'Test contrast', message: 'Repair this text color.', nodeIds: [text.id] }] };
      }
      if (blockSecondReview) {
        signalSecondReview();
        await releaseReview;
      }
      return { structurePassed: true, issues: [] };
    }
  };
  const repairProvider = {
    name: 'resume-repair-provider',
    async propose({ document, report }) {
      repairCalls++;
      const targetId = report.issues.find((issue) => issue.status !== 'resolved').nodeIds[0];
      const stack = document.pages.map((page) => page.root);
      let target;
      while (stack.length) {
        const node = stack.pop();
        if (node.id === targetId) { target = node; break; }
        if (node.type === 'frame') stack.push(...node.children);
      }
      assert.ok(target && target.type === 'text');
      return [{ nodeId: target.id, patch: { typography: { ...target.typography, color: '#111111' } } }];
    }
  };
  const makeService = () => new GenerationRunService({
    providers: { 'local-fake': provider },
    visualReviewer,
    repairProvider,
    fontsReady: true,
    async persistEvent(_projectId, event) { durableEvents.push(structuredClone(event)); },
    async persistCheckpoint(checkpoint) { durableCheckpoints.push(structuredClone(checkpoint)); return { checkpointId: checkpoint.loop.checkpointId }; },
    async persistEvidence(_projectId, content) { evidenceById.set(content.evidence.evidenceId, structuredClone(content)); }
  });
  const firstService = makeService();
  const started = firstService.start(makeRequest(source, { maxParallel: 1 }), source, 'project_visual_resume');
  await secondReviewBlocked;
  const checkpoint = await waitFor(() => [...durableCheckpoints].reverse().find((item) => item.loop.stage === 'capturing' && item.loop.reviewRound === 1 && item.loop.repairRound === 1));
  assert.ok(checkpoint.candidate);
  assert.equal(checkpoint.loop.proposals.length, 1);
  const patchedRegion = checkpoint.candidate.document.pages[0].root.children.find((node) => node.id === `${checkpoint.plan.regions[0].id}_section`);
  const patchedText = patchedRegion.children.find((node) => node.type === 'text');
  assert.equal(patchedText.typography.color, '#111111', 'The checkpoint candidate includes the committed repair');
  const eventsAtCheckpoint = structuredClone(durableEvents.filter((event) => event.seq <= checkpoint.eventSeq));

  firstService.cancel(started.runId);
  releaseSecondReview();
  const resumedService = makeService();
  const restored = resumedService.restore(checkpoint, eventsAtCheckpoint, source);
  assert.equal(restored.state, 'interrupted');
  for (const evidence of checkpoint.loop.evidence) {
    const content = evidenceById.get(evidence.evidenceId);
    if (content) resumedService.hydrateEvidence(started.runId, content);
  }
  blockSecondReview = false;
  const resumed = await resumedService.resume(started.runId, restored.attemptId, source, 'project_visual_resume');
  const completed = await waitForTerminal(resumedService, started.runId);
  assert.equal(completed.run.state, 'completed');
  assert.equal(completed.loop.repairRound, 1);
  assert.equal(completed.loop.reports.length, 2);
  assert.equal(repairCalls, 1, 'Resume continues after the committed repair instead of proposing it again');
  assert.equal(completed.loop.reports.at(-1).attemptId, resumed.attemptId);
  const finalRegion = completed.candidate.document.pages[0].root.children.find((node) => node.id === `${checkpoint.plan.regions[0].id}_section`);
  const finalText = finalRegion.children.find((node) => node.type === 'text');
  assert.equal(finalText.typography.color, '#111111');
}

async function warningAcceptanceIsAuditedAndCannotBypassBlockers() {
  const source = createStarterDocument('S3 acceptance test', 'Editable source');
  const warningReviewer = {
    name: 'human-acceptance-test-reviewer',
    async review() {
      return { structurePassed: true, issues: [{ severity: 'warning', category: 'readability', summary: 'Font environment pending', message: 'The production font environment has not been verified.', nodeIds: [] }] };
    }
  };
  const persistedEvents = [];
  const persistedCheckpoints = [];
  const persistence = {
    async persistEvent(_projectId, event) { persistedEvents.push(structuredClone(event)); },
    async persistCheckpoint(checkpoint) {
      assert.ok(checkpoint.loop.checkpointId, 'Persisted checkpoints must carry their own checkpoint ID');
      persistedCheckpoints.push(structuredClone(checkpoint));
      return { checkpointId: checkpoint.loop.checkpointId };
    },
    async persistEvidence() { return undefined; }
  };
  const service = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, visualReviewer: warningReviewer, fontsReady: false, ...persistence });
  const started = service.start(makeRequest(source, { maxParallel: 1 }), source, 'project_acceptance');
  const reviewable = await waitForTerminal(service, started.runId);
  assert.equal(reviewable.run.state, 'needs_review');
  assert.equal(reviewable.loop.stage, 'needs_review');
  assert.equal(reviewable.run.candidateAvailable, false);
  await assert.rejects(
    service.acceptWarnings(started.runId, reviewable.run.attemptId, 'project_acceptance', '  '),
    (error) => error.code === 'INVALID_REQUEST'
  );
  const accepted = await service.acceptWarnings(started.runId, reviewable.run.attemptId, 'project_acceptance', 'Verified the layout in the target environment.');
  assert.equal(accepted.state, 'completed');
  assert.equal(accepted.candidateAvailable, true);
  const acceptedSnapshot = service.get(started.runId);
  assert.equal(acceptedSnapshot.loop.quality, 'accepted_warnings');
  assert.equal(acceptedSnapshot.loop.stage, 'completed');
  assert.equal(acceptedSnapshot.events.some((event) => event.type === 'warningsAccepted' && event.payload.reason === 'Verified the layout in the target environment.'), true);
  assert.equal(acceptedSnapshot.candidate.runId, started.runId);
  const durable = persistedCheckpoints.at(-1);
  assert.equal(durable.phase, 'completed');
  assert.equal(durable.loop.quality, 'accepted_warnings');
  assert.ok(durable.loop.checkpointId);
  const restoredService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: false });
  const restored = restoredService.restore(structuredClone(durable), structuredClone(persistedEvents), source);
  assert.equal(restored.state, 'completed');
  assert.equal(restored.candidateAvailable, true, 'Accepted-warning eligibility survives a restart');
  const acceptedWithBlocker = structuredClone(durable);
  acceptedWithBlocker.loop.reports.at(-1).issues.push({
    issueId: 'issue_accepted_blocker_1', severity: 'blocker', category: 'structure', summary: 'Unresolved blocker',
    message: 'A blocker cannot be accepted as a warning.', nodeIds: [], firstSeenRound: acceptedWithBlocker.loop.reviewRound, status: 'open'
  });
  const blockedAcceptanceRestore = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, fontsReady: false });
  const blockedAcceptedSummary = blockedAcceptanceRestore.restore(acceptedWithBlocker, structuredClone(persistedEvents), source);
  assert.equal(blockedAcceptedSummary.state, 'failed');
  assert.equal(blockedAcceptedSummary.candidateAvailable, false, 'Warning acceptance cannot override a blocker added to a malformed checkpoint');

  const blockerReviewer = {
    name: 'blocker-acceptance-test-reviewer',
    async review() {
      return { structurePassed: true, issues: [{ severity: 'blocker', category: 'structure', summary: 'Required section missing', message: 'A required section must be restored.', nodeIds: [] }] };
    }
  };
  const blockedService = new GenerationRunService({ providers: { 'local-fake': new FakeFrameProvider() }, visualReviewer: blockerReviewer, fontsReady: true });
  const blockedStarted = blockedService.start(makeRequest(source, { maxParallel: 1 }), source, 'project_blocked');
  const blocked = await waitForTerminal(blockedService, blockedStarted.runId);
  assert.equal(blocked.run.state, 'needs_review');
  assert.equal(blocked.loop.quality, 'blocked');
  await assert.rejects(
    blockedService.acceptWarnings(blockedStarted.runId, blocked.run.attemptId, 'project_blocked', 'I accept it.'),
    (error) => error.code === 'WARNINGS_NOT_ACCEPTABLE'
  );
  assert.equal(blockedService.get(blockedStarted.runId).events.some((event) => event.type === 'warningsAccepted'), false);
}

async function finalCheckpointFailureCannotLeaveAnUndurableCandidateComplete() {
  const source = createStarterDocument('S3 storage failure test', 'Editable source');
  const fakeProvider = new FakeFrameProvider();
  let providerCalls = 0;
  const service = new GenerationRunService({
    providers: { 'local-fake': {
      name: fakeProvider.name,
      async generateFrame(input, options) { providerCalls++; return fakeProvider.generateFrame(input, options); }
    } },
    visualReviewer: { name: 'pass-reviewer', async review() { return { structurePassed: true, issues: [] }; } },
    fontsReady: true,
    async persistEvent() { return undefined; },
    async persistCheckpoint(checkpoint) {
      if (checkpoint.phase === 'completed') throw Object.assign(new Error('disk write failed'), { code: 'IO_ERROR' });
      return { checkpointId: checkpoint.loop.checkpointId };
    },
    async persistEvidence() { return undefined; }
  });
  const started = service.start(makeRequest(source, { maxParallel: 1 }), source, 'project_disk_failure');
  const result = await waitForTerminal(service, started.runId);
  assert.equal(result.run.state, 'failed');
  assert.equal(result.run.candidateAvailable, false, 'A Run without a durable final checkpoint cannot advertise an applicable candidate');
  assert.equal(result.run.error.code, 'IO_ERROR');
  assert.equal(result.loop.quality, 'blocked');
  assert.ok(providerCalls > 0, 'The run reaches candidate review before the final checkpoint fails');
}

async function main() {
  await loopRepairsAreBoundedAndParallel();
  await foreignPageNodesCannotBeRepairedByPrefix();
  await interruptedRunsResumeFromDurableRegionalResults();
  await staleCheckpointAfterTerminalEventFailsClosed();
  await visualResumeUsesTheDurablePatchedCandidate();
  await warningAcceptanceIsAuditedAndCannotBypassBlockers();
  await finalCheckpointFailureCannotLeaveAnUndurableCandidateComplete();
  console.log('design-generation S3 loop/recovery checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
