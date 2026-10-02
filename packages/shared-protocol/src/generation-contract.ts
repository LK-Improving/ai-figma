import { z } from 'zod';
import { designDocumentSchema, designVariableSchema, nodeIdSchema } from '@miaoma/design-schema';

const shortText = (max: number) => z.string().trim().min(1).max(max);
const regionContentSchema = z.object({ frameName: shortText(128), headline: shortText(256), description: shortText(2_000) }).strict();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const collaboratorAgentSchema = z.enum(['newton', 'tesla', 'maxwell', 'curie', 'faraday']);
const repairBoundsSchema = z.object({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().positive().max(32_768),
  height: z.number().finite().positive().max(32_768)
}).strict();
const repairTypographySchema = z.object({
  fontFamily: shortText(128), fontSize: z.number().finite().positive().max(100_000),
  fontWeight: z.number().int().min(100).max(900), lineHeight: z.number().finite().positive().max(100_000),
  letterSpacing: z.number().finite().min(-1_000_000).max(1_000_000),
  textAlign: z.enum(['left', 'center', 'right']), color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
}).strict();

export const generationRequestSchema = z.object({
  documentId: nodeIdSchema,
  title: shortText(256),
  prompt: shortText(20_000),
  pageId: nodeIdSchema,
  targetNodeIds: z.array(nodeIdSchema).max(64).default([]),
  baseRevision: z.number().int().nonnegative().safe(),
  viewport: z.object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) }).strict(),
  themeRef: z.string().trim().max(128).optional(),
  referenceAssetIds: z.array(nodeIdSchema).max(64).default([]),
  providerRef: z.enum(['local-fake', 'codex-cli']).default('local-fake'),
  constraints: z.array(z.string().trim().min(1).max(512)).max(32).default([]),
  maxParallel: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1)
}).strict();

export const designPlanSchema = z.object({
  summary: shortText(512),
  pagePurpose: shortText(256),
  tokens: z.array(designVariableSchema).max(100),
  regions: z.array(z.object({
    id: nodeIdSchema,
    name: shortText(128),
    order: z.number().int().nonnegative().max(31),
    minHeight: z.number().int().positive().max(4096),
    brief: shortText(1_000)
  }).strict()).min(1).max(32),
  dependencies: z.array(z.object({ from: nodeIdSchema, to: nodeIdSchema }).strict()).max(128),
  ownershipMap: z.array(z.object({ regionId: nodeIdSchema, agentId: collaboratorAgentSchema }).strict()).max(32).default([]),
  acceptanceCriteria: z.array(shortText(256)).min(1).max(32)
}).strict().superRefine((plan, context) => {
  const regions = new Set(plan.regions.map((region) => region.id));
  const assigned = new Set<string>();
  plan.ownershipMap.forEach((owner, index) => {
    if (!regions.has(owner.regionId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ownershipMap', index, 'regionId'], message: 'Ownership must refer to a planned region' });
    if (assigned.has(owner.regionId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ownershipMap', index, 'regionId'], message: 'A region may have only one owner' });
    assigned.add(owner.regionId);
  });
});

export const generationRunStateSchema = z.enum([
  'queued', 'preparing', 'designing', 'assembling', 'validating', 'reviewing', 'repairing', 'interrupted', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review'
]);

export const agentTaskStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'stale']);
export const agentTaskSchema = z.object({
  taskId: nodeIdSchema,
  attemptId: nodeIdSchema,
  leaseId: nodeIdSchema.optional(),
  taskKind: z.enum(['generate', 'repair']),
  regionId: nodeIdSchema,
  agentId: collaboratorAgentSchema,
  namespace: nodeIdSchema,
  state: agentTaskStateSchema,
  attempt: z.number().int().positive().max(100),
  round: z.number().int().min(0).max(2),
  dependencies: z.array(nodeIdSchema).max(32),
  allowedNodeIds: z.array(nodeIdSchema).max(10_000),
  issueIds: z.array(nodeIdSchema).max(128),
  expectedSubtreeHash: hashSchema,
  candidateHash: hashSchema.optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.object({ code: shortText(64), message: shortText(512), retryable: z.boolean() }).strict().optional()
}).strict();

export const collaboratorAgentStateSchema = z.object({
  agentId: collaboratorAgentSchema,
  displayName: shortText(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  state: z.enum(['idle', 'queued', 'running', 'completed', 'failed', 'cancelled']),
  activeTaskId: nodeIdSchema.optional(),
  completedTasks: z.number().int().nonnegative().max(10_000),
  failedTasks: z.number().int().nonnegative().max(10_000)
}).strict();

export const agentRunStateSchema = z.object({
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  maxParallel: z.union([z.literal(1), z.literal(3), z.literal(5)]),
  activeCount: z.number().int().min(0).max(5),
  queuedCount: z.number().int().min(0).max(10_000),
  coordinator: z.object({ agentId: z.literal('miaoma'), displayName: shortText(64), state: z.enum(['planning', 'delegating', 'assembling', 'reviewing', 'completed', 'failed', 'cancelled']) }).strict(),
  agents: z.array(collaboratorAgentStateSchema).max(5),
  tasks: z.array(agentTaskSchema).max(10_000)
}).strict();

export const visualIssueSchema = z.object({
  issueId: nodeIdSchema,
  severity: z.enum(['blocker', 'warning', 'info']),
  category: z.enum(['overflow', 'readability', 'contrast', 'hierarchy', 'spacing', 'asset', 'requirement', 'structure', 'other']),
  summary: shortText(256),
  message: shortText(1_000),
  nodeIds: z.array(nodeIdSchema).max(64),
  bounds: repairBoundsSchema.optional(),
  ownerAgentId: collaboratorAgentSchema.optional(),
  firstSeenRound: z.number().int().min(0).max(2),
  status: z.enum(['open', 'resolved', 'regressed'])
}).strict();

export const screenshotEvidenceSchema = z.object({
  evidenceId: nodeIdSchema,
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  reviewRound: z.number().int().min(0).max(2),
  documentId: nodeIdSchema,
  revision: z.number().int().nonnegative().safe(),
  candidateRevision: z.number().int().min(0).max(2),
  pageId: nodeIdSchema,
  imageHash: hashSchema,
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  scale: z.number().finite().positive().max(2),
  mimeType: z.literal('image/svg+xml'),
  nodeIds: z.array(nodeIdSchema).max(10_000),
  fontsReady: z.boolean(),
  assetStatus: z.enum(['ready', 'missing'])
}).strict();

export const visualReviewReportSchema = z.object({
  reportId: nodeIdSchema,
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  reviewRound: z.number().int().min(0).max(2),
  revision: z.number().int().nonnegative().safe(),
  candidateRevision: z.number().int().min(0).max(2),
  evidenceId: nodeIdSchema,
  structurePassed: z.boolean(),
  issues: z.array(visualIssueSchema).max(500),
  decision: z.enum(['pass', 'repair', 'needs_review', 'blocked']),
  createdAt: z.string().datetime()
}).strict();

export const repairNodePatchSchema = z.object({
  nodeId: nodeIdSchema,
  expectedHash: hashSchema,
  patch: z.object({
    bounds: repairBoundsSchema.optional(),
    text: z.string().max(100_000).optional(),
    typography: repairTypographySchema.optional()
  }).strict().refine((patch) => Object.keys(patch).length > 0, 'Repair patch must change at least one supported field')
}).strict();

export const repairProposalSchema = z.object({
  proposalId: nodeIdSchema,
  reportId: nodeIdSchema,
  repairRound: z.number().int().min(1).max(2),
  ownerAgentId: collaboratorAgentSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
  issueIds: z.array(nodeIdSchema).min(1).max(128),
  allowedNodeIds: z.array(nodeIdSchema).min(1).max(10_000),
  updates: z.array(repairNodePatchSchema).min(1).max(1_000),
  preservedNodeHashes: z.record(nodeIdSchema, hashSchema),
  status: z.enum(['proposed', 'applied', 'rejected', 'conflict']),
  createdAt: z.string().datetime(),
  decision: shortText(512).optional()
}).strict();

export const qualityLoopStateSchema = z.object({
  stage: z.enum(['idle', 'capturing', 'reviewing', 'repairing', 'completed', 'needs_review', 'blocked', 'conflict', 'interrupted']),
  quality: z.enum(['pending', 'passed', 'issues_found', 'blocked', 'conflict', 'accepted_warnings']),
  reviewRound: z.number().int().min(0).max(2),
  repairRound: z.number().int().min(0).max(2),
  maxRepairRounds: z.literal(2),
  evidence: z.array(screenshotEvidenceSchema).max(3),
  reports: z.array(visualReviewReportSchema).max(3),
  proposals: z.array(repairProposalSchema).max(2),
  warningAcceptance: z.object({
    reportId: nodeIdSchema,
    evidenceId: nodeIdSchema,
    issueIds: z.array(nodeIdSchema).min(1).max(500),
    reason: shortText(512),
    acceptedAt: z.string().datetime()
  }).strict().optional(),
  checkpointId: nodeIdSchema.optional(),
  diagnostics: z.array(shortText(512)).max(100)
}).strict();

export const screenshotEvidenceContentSchema = z.object({
  evidence: screenshotEvidenceSchema,
  previewSvg: z.string().max(2_000_000)
}).strict();

export const generationEventSchema = z.object({
  eventId: nodeIdSchema,
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  seq: z.number().int().positive().safe(),
  timestamp: z.string().datetime(),
  type: z.enum(['stateChanged', 'regionPlanned', 'regionStarted', 'regionDraft', 'candidateReady', 'validationReported', 'agentAssigned', 'agentStarted', 'agentCandidateReady', 'agentFailed', 'snapshotReady', 'reviewStarted', 'reviewCompleted', 'repairDelegated', 'patchProposed', 'patchCommitted', 'loopDecision', 'checkpointSaved', 'runInterrupted', 'runResumed', 'warningsAccepted', 'error']),
  documentRevision: z.number().int().nonnegative().safe(),
  payload: z.record(z.string(), z.unknown())
}).strict();

export const generationRunSummarySchema = z.object({
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  state: generationRunStateSchema,
  baseRevision: z.number().int().nonnegative().safe(),
  eventSeq: z.number().int().nonnegative().safe(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  candidateAvailable: z.boolean(),
  error: z.object({ code: shortText(64), message: shortText(512), retryable: z.boolean() }).strict().optional()
}).strict();

export const generationCandidateSchema = z.object({
  candidateId: nodeIdSchema,
  runId: nodeIdSchema,
  baseRevision: z.number().int().nonnegative().safe(),
  createdAt: z.string().datetime(),
  summary: shortText(512),
  plan: designPlanSchema,
  document: designDocumentSchema,
  previewSvg: z.string().max(2_000_000)
}).strict();

export const generationRunCheckpointSchema = z.object({
  formatVersion: z.literal(1),
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  documentId: nodeIdSchema,
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  request: generationRequestSchema,
  baseRevision: z.number().int().nonnegative().safe(),
  baseDocumentHash: hashSchema,
  tokenVersion: hashSchema,
  providerVersion: shortText(128),
  plan: designPlanSchema.optional(),
  phase: z.enum(['queued', 'preparing', 'designing', 'assembling', 'validating', 'capturing', 'reviewing', 'repairing', 'interrupted', 'completed', 'cancelled', 'failed', 'needs_review']),
  collaboration: agentRunStateSchema,
  loop: qualityLoopStateSchema,
  completedRegions: z.record(nodeIdSchema, regionContentSchema),
  candidate: generationCandidateSchema.optional(),
  eventSeq: z.number().int().nonnegative().safe(),
  updatedAt: z.string().datetime()
}).strict();

export const generationRunSnapshotSchema = z.object({
  run: generationRunSummarySchema,
  events: z.array(generationEventSchema).max(10_000),
  candidate: generationCandidateSchema.optional(),
  collaboration: agentRunStateSchema.optional(),
  loop: qualityLoopStateSchema.optional()
}).strict();

export const generationRunListSchema = z.array(generationRunSummarySchema).max(50);
export const generationRunResumeResultSchema = z.object({ runId: nodeIdSchema, attemptId: nodeIdSchema, state: generationRunStateSchema }).strict();
export const generationWarningsAcceptanceRequestSchema = z.object({
  runId: nodeIdSchema,
  expectedAttemptId: nodeIdSchema,
  reason: z.string().trim().min(1).max(512)
}).strict();
export const generationWarningsAcceptanceResultSchema = z.object({ runId: nodeIdSchema, attemptId: nodeIdSchema, state: z.literal('completed') }).strict();

export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type DesignPlan = z.infer<typeof designPlanSchema>;
export type GenerationRunState = z.infer<typeof generationRunStateSchema>;
export type GenerationEvent = z.infer<typeof generationEventSchema>;
export type GenerationRunSummary = z.infer<typeof generationRunSummarySchema>;
export type GenerationCandidate = z.infer<typeof generationCandidateSchema>;
export type GenerationRunSnapshot = z.infer<typeof generationRunSnapshotSchema>;
export type AgentTask = z.infer<typeof agentTaskSchema>;
export type AgentRunState = z.infer<typeof agentRunStateSchema>;
export type VisualIssue = z.infer<typeof visualIssueSchema>;
export type ScreenshotEvidence = z.infer<typeof screenshotEvidenceSchema>;
export type VisualReviewReport = z.infer<typeof visualReviewReportSchema>;
export type RepairProposal = z.infer<typeof repairProposalSchema>;
export type QualityLoopState = z.infer<typeof qualityLoopStateSchema>;
export type GenerationRunCheckpoint = z.infer<typeof generationRunCheckpointSchema>;
export type ScreenshotEvidenceContent = z.infer<typeof screenshotEvidenceContentSchema>;
export type GenerationRunResumeResult = z.infer<typeof generationRunResumeResultSchema>;
export type GenerationWarningsAcceptanceRequest = z.infer<typeof generationWarningsAcceptanceRequestSchema>;
export type GenerationWarningsAcceptanceResult = z.infer<typeof generationWarningsAcceptanceResultSchema>;
