import { createHash, randomUUID } from 'node:crypto';
import {
  repairNodePatchSchema,
  repairProposalSchema,
  visualReviewReportSchema,
  type DesignPlan,
  type GenerationRequest,
  type QualityLoopState,
  type RepairProposal,
  type ScreenshotEvidence,
  type VisualIssue,
  type VisualReviewReport
} from '@miaoma/shared-protocol';
import { validateDesignDocument, type DesignDocument, type DesignNode } from '@miaoma/design-schema';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';
import { runDagScheduler } from './dag-scheduler';

export type VisualIssueDraft = Pick<VisualIssue, 'severity' | 'category' | 'summary' | 'message' | 'nodeIds'> & Partial<Pick<VisualIssue, 'bounds'>>;
export type RepairUpdateDraft = { nodeId: string; patch: { bounds?: Pick<DesignNode['bounds'], 'x' | 'y' | 'width' | 'height'>; text?: string; typography?: Extract<DesignNode, { type: 'text' }>['typography'] } };

export type VisualReviewInput = { document: DesignDocument; plan: DesignPlan; evidence: ScreenshotEvidence; previewSvg: string };

export interface VisualReviewProvider {
  readonly name: string;
  select?(input: VisualReviewInput): VisualReviewProvider;
  review(input: VisualReviewInput, options: { signal: AbortSignal }): Promise<{ structurePassed: boolean; issues: readonly VisualIssueDraft[] }>;
}

export interface RepairProposalProvider {
  readonly name: string;
  propose(input: {
    document: DesignDocument;
    report: VisualReviewReport;
    repairRound: number;
    ownerAgentId: VisualIssue['ownerAgentId'];
    allowedNodeIds: readonly string[];
    expectedHashes: Readonly<Record<string, string>>;
  }, options: { signal: AbortSignal }): Promise<readonly RepairUpdateDraft[]>;
}

export type QualityLoopEvent = Extract<
  import('@miaoma/shared-protocol').GenerationEvent['type'],
  'snapshotReady' | 'reviewStarted' | 'reviewCompleted' | 'repairDelegated' | 'patchProposed' | 'patchCommitted' | 'loopDecision'
>;

export interface QualityLoopOptions {
  runId: string;
  attemptId: string;
  request: GenerationRequest;
  plan: DesignPlan;
  candidateDocument: DesignDocument;
  assetDataUrls?: Readonly<Record<string, string>>;
  visualReviewer: VisualReviewProvider;
  repairProvider: RepairProposalProvider;
  maxParallel: 1 | 3 | 5;
  fontsReady: boolean;
  signal: AbortSignal;
  initialState?: QualityLoopState;
  startReviewRound?: number;
  onEvent?: (type: QualityLoopEvent, payload: Record<string, unknown>) => void;
  onEvidence?: (evidence: ScreenshotEvidence, previewSvg: string) => void | Promise<void>;
  onCheckpoint?: (snapshot: { document: DesignDocument; previewSvg: string; state: QualityLoopState }) => void | Promise<void>;
  now?: () => Date;
}

export type QualityLoopResult = {
  document: DesignDocument;
  previewSvg: string;
  state: QualityLoopState;
  evidenceContent: Map<string, string>;
};

const REGION_AGENTS = [
  { agentId: 'newton', displayName: 'Newton', color: '#4F76C8' },
  { agentId: 'tesla', displayName: 'Tesla', color: '#A15CC2' },
  { agentId: 'maxwell', displayName: 'Maxwell', color: '#D48B35' },
  { agentId: 'curie', displayName: 'Curie', color: '#3B9A80' },
  { agentId: 'faraday', displayName: 'Faraday', color: '#C15A6F' }
] as const;

function clone<T>(value: T): T { return structuredClone(value); }

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function designValueHash(value: unknown): string {
  return createHash('sha256').update(stableValue(value)).digest('hex');
}

function makeId(kind: string): string { return `${kind}_${randomUUID().replaceAll('-', '')}`; }

function indexNodes(document: DesignDocument): Map<string, { node: DesignNode; parent: DesignNode | null }> {
  const result = new Map<string, { node: DesignNode; parent: DesignNode | null }>();
  const stack: Array<{ node: DesignNode; parent: DesignNode | null }> = [];
  for (const page of document.pages) stack.push({ node: page.root, parent: null });
  while (stack.length) {
    const current = stack.pop()!;
    result.set(current.node.id, current);
    if (current.node.type === 'frame') for (const child of current.node.children) stack.push({ node: child, parent: current.node });
  }
  return result;
}

function nodesOnPage(document: DesignDocument, pageId: string): Set<string> {
  const page = document.pages.find((item) => item.id === pageId);
  if (!page) return new Set();
  const ids = new Set<string>();
  const stack: DesignNode[] = [page.root];
  while (stack.length) {
    const node = stack.pop()!;
    ids.add(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  return ids;
}

function expectedRegionRootId(regionId: string): string { return `${regionId}_section`; }

function getRegionRoot(document: DesignDocument, pageId: string, regionId: string): DesignNode | undefined {
  const page = document.pages.find((item) => item.id === pageId);
  if (!page || page.root.type !== 'frame') return undefined;
  return page.root.children.find((node) => node.id === expectedRegionRootId(regionId));
}

function nodesByRegion(document: DesignDocument, plan: DesignPlan, pageId: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const region of plan.regions) {
    const root = getRegionRoot(document, pageId, region.id);
    if (!root) continue;
    const ids = new Set<string>();
    const stack: DesignNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      ids.add(node.id);
      if (node.type === 'frame') stack.push(...node.children);
    }
    result.set(region.id, ids);
  }
  return result;
}

function regionForNode(nodeId: string, document: DesignDocument, plan: DesignPlan, pageId: string): string | undefined {
  for (const [regionId, ids] of nodesByRegion(document, plan, pageId)) if (ids.has(nodeId)) return regionId;
  return undefined;
}

function agentForNode(nodeId: string, document: DesignDocument, plan: DesignPlan, pageId: string): VisualIssue['ownerAgentId'] {
  const regionId = regionForNode(nodeId, document, plan, pageId);
  return plan.ownershipMap.find((item) => item.regionId === regionId)?.agentId;
}

function issueKey(draft: VisualIssueDraft): string {
  return `${draft.category}:${[...draft.nodeIds].sort().join(',')}:${draft.summary}`;
}

function issueId(runId: string, key: string): string {
  return `issue_${createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 24)}`;
}

function rgb(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function luminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string): number | null {
  const left = rgb(foreground); const right = rgb(background);
  if (!left || !right) return null;
  const a = 0.2126 * luminance(left[0]) + 0.7152 * luminance(left[1]) + 0.0722 * luminance(left[2]);
  const b = 0.2126 * luminance(right[0]) + 0.7152 * luminance(right[1]) + 0.0722 * luminance(right[2]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function localBackground(node: DesignNode, parentBackground: string): string {
  const fill = node.style.fills.find((item) => item.type === 'solid');
  if (!fill || fill.type !== 'solid') return parentBackground;
  if (typeof fill.color === 'string') return fill.color.slice(0, 7);
  return typeof fill.color.fallback === 'string' ? fill.color.fallback.slice(0, 7) : parentBackground;
}

/**
 * Deterministic local reviewer for DSL geometry and text contrast. It does not
 * claim semantic, pixel-level or multimodal model review; the provider port can
 * be replaced without changing the run/repair safety checks.
 */
export class RuleBasedVisualReviewer implements VisualReviewProvider {
  readonly name = 'local-rules';

  async review(input: { document: DesignDocument; plan: DesignPlan; evidence: ScreenshotEvidence }, options: { signal: AbortSignal }): Promise<{ structurePassed: boolean; issues: readonly VisualIssueDraft[] }> {
    if (options.signal.aborted) throw new Error('Visual review was cancelled');
    const validation = validateDesignDocument(input.document);
    const page = input.document.pages.find((item) => item.id === input.evidence.pageId);
    const issues: VisualIssueDraft[] = [];
    if (!validation.success || !page) {
      issues.push({ severity: 'blocker', category: 'structure', summary: '设计结构无法验证', message: '候选文档或目标页面未通过结构校验。', nodeIds: [] });
      return { structurePassed: false, issues };
    }
    const actualRegionRoots = new Set(page.root.children.map((node) => node.id));
    const missingRegions = input.plan.regions.filter((region) => !actualRegionRoots.has(`${region.id}_section`));
    if (missingRegions.length) {
      issues.push({ severity: 'blocker', category: 'requirement', summary: '计划分区缺失', message: `候选缺少计划区域：${missingRegions.map((region) => region.name).join('、').slice(0, 900)}。`, nodeIds: [page.root.id] });
    }
    const visit = (node: DesignNode, parent: Extract<DesignNode, { type: 'frame' }> | null, background: string): void => {
      const effectiveBackground = localBackground(node, background);
      if (parent && node.visible) {
        const overflow = node.bounds.x < 0 || node.bounds.y < 0 || node.bounds.x + node.bounds.width > parent.bounds.width || node.bounds.y + node.bounds.height > parent.bounds.height;
        if (overflow) issues.push({ severity: 'blocker', category: 'overflow', summary: `${node.name} 超出父级区域`, message: '图层边界超出了所属 Frame，需要调整节点位置或尺寸。', nodeIds: [node.id], bounds: { ...node.bounds } });
      }
      if (node.type === 'text' && node.visible) {
        const ratio = contrastRatio(node.typography.color, effectiveBackground);
        if (ratio !== null && ratio < 4.5) issues.push({ severity: 'warning', category: 'contrast', summary: `${node.name} 对比度偏低`, message: `当前前景/背景对比度约 ${ratio.toFixed(1)}:1，建议提高到 4.5:1。`, nodeIds: [node.id] });
      }
      if (node.type === 'frame') for (const child of node.children) visit(child, node, effectiveBackground);
    };
    visit(page.root, null, '#FFFFFF');
    return { structurePassed: missingRegions.length === 0, issues };
  }
}

export class RuleBasedRepairProvider implements RepairProposalProvider {
  readonly name = 'local-rule-repair';

  async propose(input: { document: DesignDocument; report: VisualReviewReport; allowedNodeIds: readonly string[] }, options: { signal: AbortSignal }): Promise<readonly RepairUpdateDraft[]> {
    if (options.signal.aborted) throw new Error('Repair proposal was cancelled');
    const nodes = indexNodes(input.document);
    const allowed = new Set(input.allowedNodeIds);
    const updates: RepairUpdateDraft[] = [];
    for (const issue of input.report.issues) {
      for (const nodeId of issue.nodeIds) {
        if (!allowed.has(nodeId)) continue;
        const node = nodes.get(nodeId)?.node;
        if (!node || node.locked || node.type !== 'text') continue;
        if (issue.category === 'contrast') updates.push({ nodeId, patch: { typography: { ...node.typography, color: '#1F2937' } } });
        else if (issue.category === 'overflow') {
          const parent = nodes.get(nodeId)?.parent;
          if (!parent || parent.type !== 'frame') continue;
          const width = Math.min(node.bounds.width, parent.bounds.width);
          const height = Math.min(Math.max(node.bounds.height, (node.typography.fontSize * node.typography.lineHeight) + 8), parent.bounds.height);
          const x = Math.max(0, Math.min(node.bounds.x, parent.bounds.width - width));
          const y = Math.max(0, Math.min(node.bounds.y, parent.bounds.height - height));
          if (x !== node.bounds.x || y !== node.bounds.y || width !== node.bounds.width || height !== node.bounds.height) {
            updates.push({ nodeId, patch: { bounds: { x, y, width, height } } });
          }
        }
      }
    }
    const byNode = new Map<string, RepairUpdateDraft>();
    for (const update of updates) byNode.set(update.nodeId, update);
    return [...byNode.values()];
  }
}

function emptyLoopState(): QualityLoopState {
  return { stage: 'idle', quality: 'pending', reviewRound: 0, repairRound: 0, maxRepairRounds: 2, evidence: [], reports: [], proposals: [], diagnostics: [] };
}

function stopResult(document: DesignDocument, previewSvg: string, state: QualityLoopState, evidenceContent: Map<string, string>, stage: QualityLoopState['stage'], quality: QualityLoopState['quality'], diagnostic?: string): QualityLoopResult {
  state.stage = stage;
  state.quality = quality;
  if (diagnostic) state.diagnostics.push(diagnostic.slice(0, 512));
  return { document, previewSvg, state, evidenceContent };
}

function buildEvidence(input: QualityLoopOptions, document: DesignDocument, candidateRevision: number, reviewRound: number, previewSvg: string, metadata: ReturnType<typeof renderDocumentScreenshot>['metadata']): ScreenshotEvidence {
  const evidenceId = makeId('evidence');
  return {
    evidenceId,
    runId: input.runId,
    attemptId: input.attemptId,
    reviewRound,
    documentId: document.documentId,
    revision: input.request.baseRevision,
    candidateRevision,
    pageId: input.request.pageId,
    imageHash: createHash('sha256').update(previewSvg).digest('hex'),
    width: metadata.width,
    height: metadata.height,
    scale: metadata.scale,
    mimeType: 'image/svg+xml',
    nodeIds: metadata.nodeIds,
    fontsReady: input.fontsReady,
    assetStatus: metadata.assets
  };
}

function buildIssues(input: QualityLoopOptions, document: DesignDocument, round: number, drafts: readonly VisualIssueDraft[], previous: readonly VisualIssue[]): VisualIssue[] {
  const previousByKey = new Map(previous.map((issue) => [issueKey(issue), issue]));
  return drafts.map((draft) => {
    const old = previousByKey.get(issueKey(draft));
    const ownerAgentId = draft.nodeIds.map((id) => agentForNode(id, document, input.plan, input.request.pageId)).find((id) => id !== undefined);
    return {
      issueId: old?.issueId ?? issueId(input.runId, issueKey(draft)),
      ...clone(draft),
      ...(ownerAgentId ? { ownerAgentId } : {}),
      firstSeenRound: old?.firstSeenRound ?? round,
      status: old && old.status === 'resolved' ? 'regressed' as const : 'open' as const
    };
  });
}

function ownedNodeIds(document: DesignDocument, regionId: string, plan: DesignPlan, pageId: string): string[] {
  return [...(nodesByRegion(document, plan, pageId).get(regionId) ?? [])];
}

function applyPatch(document: DesignDocument, updates: readonly RepairUpdateDraft[], ownerAgentId: string, plan: DesignPlan, pageId: string): { document: DesignDocument; proposal: RepairProposal } {
  const result = clone(document);
  const index = indexNodes(result);
  const currentHashes = new Map([...index].map(([id, item]) => [id, designValueHash(item.node)]));
  const allowedByOwner = new Set(plan.ownershipMap.filter((owner) => owner.agentId === ownerAgentId).flatMap((owner) => ownedNodeIds(result, owner.regionId, plan, pageId)));
  const seen = new Set<string>();
  const normalizedUpdates: RepairProposal['updates'] = [];
  for (const update of updates) {
    if (seen.has(update.nodeId)) throw new Error(`Repair proposal changes ${update.nodeId} more than once`);
    seen.add(update.nodeId);
    const item = index.get(update.nodeId);
    if (!item || !allowedByOwner.has(update.nodeId)) throw new Error(`Repair proposal escaped its owner namespace: ${update.nodeId}`);
    if (item.node.locked) throw new Error(`Repair proposal targets a locked node: ${update.nodeId}`);
    if ((update.patch.text !== undefined || update.patch.typography !== undefined) && item.node.type !== 'text') throw new Error(`Repair proposal applies text fields to a non-text node: ${update.nodeId}`);
    const expectedHash = currentHashes.get(update.nodeId)!;
    const checkedUpdate = repairNodePatchSchema.safeParse({ nodeId: update.nodeId, expectedHash, patch: update.patch });
    if (!checkedUpdate.success) throw new Error(`Repair proposal contains an unsupported patch: ${checkedUpdate.error.issues[0]?.message ?? 'invalid patch'}`);
    const patch = clone(checkedUpdate.data.patch);
    Object.assign(item.node, patch);
    normalizedUpdates.push(checkedUpdate.data);
  }
  const validation = validateDesignDocument(result);
  if (!validation.success) throw new Error(`Repair proposal produced invalid DSL: ${validation.diagnostics[0]?.message ?? 'schema validation failed'}`);
  const preservedNodeHashes = Object.fromEntries([...index.keys()].filter((id) => !seen.has(id)).map((id) => [id, designValueHash(index.get(id)!.node)]));
  const now = new Date().toISOString();
  const rawProposal = {
    proposalId: makeId('proposal'), reportId: '', repairRound: 1, ownerAgentId,
    expectedRevision: document.revision, issueIds: [], allowedNodeIds: [...seen], updates: normalizedUpdates,
    preservedNodeHashes, status: 'proposed' as const, createdAt: now
  };
  return { document: validation.data, proposal: rawProposal as unknown as RepairProposal };
}

/** Runs review and repair entirely against a Run-local candidate. The live document is never mutated here. */
export async function runQualityLoop(options: QualityLoopOptions): Promise<QualityLoopResult> {
  const state = options.initialState ? clone(options.initialState) : emptyLoopState();
  const evidenceContent = new Map<string, string>();
  let document = clone(options.candidateDocument);
  let previewSvg = '';
  let priorIssues: VisualIssue[] = [...(state.reports.at(-1)?.issues ?? [])];
  const now = options.now ?? (() => new Date());
  const emit = (type: QualityLoopEvent, payload: Record<string, unknown>) => options.onEvent?.(type, payload);
  const startReviewRound = options.startReviewRound ?? (state.stage === 'repairing' ? state.reviewRound + 1 : state.reviewRound);

  for (let reviewRound = startReviewRound; reviewRound <= 2; reviewRound++) {
    if (options.signal.aborted) return stopResult(document, previewSvg, state, evidenceContent, 'interrupted', 'conflict', 'Run was cancelled during visual review');
    state.stage = 'capturing';
    state.reviewRound = reviewRound;
    const validation = validateDesignDocument(document);
    if (!validation.success) return stopResult(document, previewSvg, state, evidenceContent, 'blocked', 'blocked', `Candidate failed structural validation: ${validation.diagnostics[0]?.message ?? 'invalid document'}`);
    let rendered: ReturnType<typeof renderDocumentScreenshot>;
    try { rendered = renderDocumentScreenshot(document, options.request.pageId, 1, 4096, undefined, options.assetDataUrls); }
    catch (error) { return stopResult(document, previewSvg, state, evidenceContent, 'blocked', 'blocked', error instanceof Error ? error.message : 'Screenshot rendering failed'); }
    previewSvg = rendered.svg;
    const candidateRevision = state.repairRound;
    const evidence = buildEvidence(options, document, candidateRevision, reviewRound, previewSvg, rendered.metadata);
    state.evidence.push(evidence);
    evidenceContent.set(evidence.evidenceId, previewSvg);
    try { await options.onEvidence?.(evidence, previewSvg); }
    catch (error) { return stopResult(document, previewSvg, state, evidenceContent, 'blocked', 'blocked', error instanceof Error ? error.message : 'Evidence persistence failed'); }
    await options.onCheckpoint?.({ document: clone(document), previewSvg, state: clone(state) });
    emit('snapshotReady', { evidenceId: evidence.evidenceId, reviewRound, candidateRevision, revision: evidence.revision, imageHash: evidence.imageHash, width: evidence.width, height: evidence.height, assetStatus: evidence.assetStatus });

    state.stage = 'reviewing';
    const reviewInput = { document: clone(document), plan: options.plan, evidence, previewSvg };
    const visualReviewer = options.visualReviewer.select?.(reviewInput) ?? options.visualReviewer;
    emit('reviewStarted', { evidenceId: evidence.evidenceId, reviewRound, candidateRevision, reviewer: visualReviewer.name });
    let reviewed: Awaited<ReturnType<VisualReviewProvider['review']>>;
    try { reviewed = await visualReviewer.review(reviewInput, { signal: options.signal }); }
    catch (error) {
      if (options.signal.aborted) return stopResult(document, previewSvg, state, evidenceContent, 'interrupted', 'conflict', 'Run was cancelled during visual review');
      return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', 'issues_found', error instanceof Error ? error.message : 'Visual review provider failed');
    }
    const indexed = indexNodes(document);
    const pageNodeIds = nodesOnPage(document, options.request.pageId);
    const drafts: VisualIssueDraft[] = [...reviewed.issues];
    if (!reviewed.structurePassed) drafts.push({ severity: 'blocker', category: 'structure', summary: '结构检查未通过', message: '视觉审查发现文档结构或计划范围不符合交付条件。', nodeIds: [] });
    if (evidence.assetStatus !== 'ready') drafts.push({ severity: 'blocker', category: 'asset', summary: '图片资产未就绪', message: '存在未能加载的图片资产，当前证据不能通过检查。', nodeIds: [] });
    if (!evidence.fontsReady) drafts.push({ severity: 'warning', category: 'readability', summary: '字体环境未核验', message: '当前本地 SVG 检查没有确认运行环境安装了候选使用的字体；需要视觉复核后才能接受。', nodeIds: [] });
    for (const draft of drafts) {
      if (draft.nodeIds.some((nodeId) => !pageNodeIds.has(nodeId))) return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', 'blocked', `Visual report referred to a node outside the reviewed page: ${draft.nodeIds.find((nodeId) => !pageNodeIds.has(nodeId))}`);
    }
    const activeIssues = buildIssues(options, document, reviewRound, drafts, priorIssues);
    const activeKeys = new Set(activeIssues.map(issueKey));
    const resolvedPrior = priorIssues.filter((issue) => !activeKeys.has(issueKey(issue))).map((issue) => ({ ...issue, status: 'resolved' as const }));
    const currentIssues = [...activeIssues, ...resolvedPrior].slice(0, 500);
    const unresolved = activeIssues.filter((issue) => issue.severity !== 'info');
    const repairableIssues = unresolved.filter((issue) => issue.ownerAgentId && issue.nodeIds.length > 0);
    const unrepairableBlocker = unresolved.some((issue) => issue.severity === 'blocker' && (!issue.ownerAgentId || issue.nodeIds.length === 0));
    const fontVerificationPending = !evidence.fontsReady;
    const report: VisualReviewReport = {
      reportId: makeId('report'), runId: options.runId, attemptId: options.attemptId,
      reviewRound, revision: evidence.revision, candidateRevision, evidenceId: evidence.evidenceId,
      structurePassed: reviewed.structurePassed && validation.success,
      issues: currentIssues,
      decision: !reviewed.structurePassed || unrepairableBlocker ? 'blocked'
        : unresolved.length ? reviewRound < 2 && repairableIssues.length ? 'repair' : 'needs_review'
          : fontVerificationPending ? 'needs_review' : 'pass',
      createdAt: now().toISOString()
    };
    const reportValidation = visualReviewReportSchema.safeParse(report);
    if (!reportValidation.success) return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', 'blocked', `Visual report schema rejected: ${reportValidation.error.issues[0]?.message ?? 'invalid report'}`);
    state.reports.push(reportValidation.data);
    state.reports = state.reports.slice(-3);
    state.quality = reportValidation.data.issues.some((item) => item.status !== 'resolved' && item.severity === 'blocker') ? 'blocked'
      : reportValidation.data.issues.some((item) => item.status !== 'resolved' && item.severity === 'warning') ? 'issues_found' : 'passed';
    emit('reviewCompleted', { reportId: report.reportId, evidenceId: report.evidenceId, reviewRound, candidateRevision, revision: report.revision, issueCount: report.issues.filter((item) => item.status !== 'resolved').length, decision: report.decision });

    if (report.decision === 'pass') {
      state.quality = 'passed';
      emit('loopDecision', { stage: 'completed', quality: 'passed', reviewRound, repairRound: state.repairRound, reportId: report.reportId });
      return stopResult(document, previewSvg, state, evidenceContent, 'completed', 'passed');
    }
    if (report.decision !== 'repair' || state.repairRound >= 2) {
      const blocked = report.issues.some((item) => item.severity === 'blocker') || !report.structurePassed;
      emit('loopDecision', { stage: 'needs_review', quality: blocked ? 'blocked' : 'issues_found', reviewRound, repairRound: state.repairRound, reportId: report.reportId });
      return stopResult(document, previewSvg, state, evidenceContent, blocked ? 'blocked' : 'needs_review', blocked ? 'blocked' : 'issues_found');
    }

    const repairable = report.issues.filter((item) => item.status !== 'resolved' && item.severity !== 'info' && item.ownerAgentId && item.nodeIds.length > 0);
    if (repairable.length === 0) return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', 'issues_found', 'No visual issue can be safely delegated to an owning region agent');
    state.repairRound++;
    state.stage = 'repairing';
    const groups = new Map<string, VisualIssue[]>();
    for (const issue of repairable) {
      const owner = issue.ownerAgentId!;
      const list = groups.get(owner) ?? [];
      list.push(issue); groups.set(owner, list);
    }
    const expectedHashes = Object.fromEntries([...indexed].map(([id, item]) => [id, designValueHash(item.node)]));
    const repairTasks = [...groups].map(([ownerAgentId, ownerIssues], order) => ({
      taskId: `repair_${ownerAgentId}_r${state.repairRound}`,
      order,
      input: { ownerAgentId, ownerIssues }
    }));
    const scheduledRepairs = await runDagScheduler({
      tasks: repairTasks,
      maxParallel: options.maxParallel,
      runId: options.runId,
      attemptId: options.attemptId,
      signal: options.signal,
      worker: async (task) => {
        if (options.signal.aborted) throw new Error('Run was cancelled before repair proposal');
        const { ownerAgentId, ownerIssues } = task.input;
        const regionIds = options.plan.ownershipMap.filter((item) => item.agentId === ownerAgentId).map((item) => item.regionId);
        const ownerNodes = new Set(regionIds.flatMap((regionId) => ownedNodeIds(document, regionId, options.plan, options.request.pageId)));
        const allowed = [...new Set(ownerIssues.flatMap((issue) => issue.nodeIds).filter((nodeId) => ownerNodes.has(nodeId)))];
        if (!allowed.length) throw new Error(`Repair issues do not map to the owner namespace ${ownerAgentId}`);
        emit('repairDelegated', { agentId: ownerAgentId, issueIds: ownerIssues.map((issue) => issue.issueId), allowedNodeIds: allowed, repairRound: state.repairRound, reviewRound });
        const updates = await options.repairProvider.propose({ document: clone(document), report, repairRound: state.repairRound, ownerAgentId: ownerAgentId as VisualIssue['ownerAgentId'], allowedNodeIds: allowed, expectedHashes }, { signal: options.signal });
        if (!updates.length) throw new Error(`Repair owner ${ownerAgentId} returned no patch for its assigned issues`);
        const rawProposal = applyPatch(document, updates, ownerAgentId, options.plan, options.request.pageId).proposal;
        const proposal: RepairProposal = {
          ...rawProposal,
          reportId: report.reportId,
          repairRound: state.repairRound,
          ownerAgentId: ownerAgentId as RepairProposal['ownerAgentId'],
          issueIds: ownerIssues.map((issue) => issue.issueId),
          allowedNodeIds: allowed
        };
        const parsed = repairProposalSchema.safeParse(proposal);
        if (!parsed.success) throw new Error(`Repair proposal failed validation: ${parsed.error.issues[0]?.message ?? 'invalid proposal'}`);
        return { proposal: parsed.data, updates };
      }
    });
    if (options.signal.aborted) return stopResult(document, previewSvg, state, evidenceContent, 'interrupted', 'conflict', 'Run was cancelled while repair tasks were running');
    const proposals = scheduledRepairs.tasks.filter((task) => task.state === 'completed' && task.result).map((task) => task.result!);
    for (const failed of scheduledRepairs.tasks.filter((task) => task.state === 'failed' || task.state === 'blocked')) {
      state.diagnostics.push(`Repair agent ${failed.task.input.ownerAgentId} did not return a safe patch: ${failed.error?.message ?? 'prerequisite failed'}`.slice(0, 512));
    }
    if (!proposals.length) return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', unresolved.some((issue) => issue.severity === 'blocker') ? 'blocked' : 'issues_found', 'No repair proposal was produced');
    const mergedUpdates = proposals.flatMap((item) => item.updates);
    if (new Set(mergedUpdates.map((item) => item.nodeId)).size !== mergedUpdates.length) return stopResult(document, previewSvg, state, evidenceContent, 'conflict', 'conflict', 'Two repair proposals targeted the same node');
    let nextDocument: DesignDocument;
    try {
      const merged = clone(document);
      const nextIndex = indexNodes(merged);
      for (const { proposal, updates } of proposals) {
        emit('patchProposed', { proposalId: proposal.proposalId, reportId: proposal.reportId, agentId: proposal.ownerAgentId, nodeIds: proposal.updates.map((item) => item.nodeId), repairRound: proposal.repairRound });
        for (const update of updates) {
          const node = nextIndex.get(update.nodeId)?.node;
          if (!node || node.locked || proposal.allowedNodeIds.includes(update.nodeId) === false) throw new Error(`Repair patch scope changed before merge: ${update.nodeId}`);
          if (designValueHash(node) !== proposal.updates.find((item) => item.nodeId === update.nodeId)?.expectedHash) throw new Error(`Repair target hash changed before merge: ${update.nodeId}`);
          Object.assign(node, clone(update.patch));
        }
      }
      const checked = validateDesignDocument(merged);
      if (!checked.success) throw new Error(`Merged repair failed DSL validation: ${checked.diagnostics[0]?.message ?? 'invalid document'}`);
      nextDocument = checked.data;
    } catch (error) {
      state.proposals.push(...proposals.map((item) => ({ ...item.proposal, status: 'rejected' as const, decision: error instanceof Error ? error.message.slice(0, 512) : 'Patch merge failed' })));
      emit('loopDecision', { stage: 'conflict', quality: 'conflict', reviewRound, repairRound: state.repairRound, reason: state.proposals.at(-1)?.decision });
      return stopResult(document, previewSvg, state, evidenceContent, 'conflict', 'conflict', error instanceof Error ? error.message : 'Repair patch was rejected');
    }
    state.proposals.push(...proposals.map((item) => ({ ...item.proposal, status: 'applied' as const, decision: 'Run-local candidate patch applied; live document remains unchanged.' })));
    priorIssues = currentIssues;
    document = nextDocument;
    previewSvg = renderDocumentScreenshot(document, options.request.pageId, 1, 4096, undefined, options.assetDataUrls).svg;
    await options.onCheckpoint?.({ document: clone(document), previewSvg, state: clone(state) });
    for (const proposal of proposals) {
      emit('patchCommitted', { proposalId: proposal.proposal.proposalId, reportId: proposal.proposal.reportId, repairRound: proposal.proposal.repairRound, candidateRevision: state.repairRound, nodeIds: proposal.proposal.updates.map((item) => item.nodeId), liveDocumentChanged: false });
    }
  }
  return stopResult(document, previewSvg, state, evidenceContent, 'needs_review', 'issues_found', 'Visual review reached the repair-round limit');
}

export function makeAgentRoster(plan: DesignPlan, runId: string, attemptId: string, maxParallel: 1 | 3 | 5): NonNullable<import('@miaoma/shared-protocol').GenerationRunSnapshot['collaboration']> {
  const used = new Set(plan.ownershipMap.map((item) => item.agentId));
  return {
    runId,
    attemptId,
    maxParallel,
    activeCount: 0,
    queuedCount: plan.regions.length,
    coordinator: { agentId: 'miaoma', displayName: 'MyFigma', state: 'planning' },
    agents: REGION_AGENTS.filter((item) => used.has(item.agentId)).map((item) => ({ ...item, state: 'queued' as const, completedTasks: 0, failedTasks: 0 })),
    tasks: []
  };
}
