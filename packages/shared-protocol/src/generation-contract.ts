import { z } from 'zod';
import { designDocumentSchema, designVariableSchema, nodeIdSchema } from '@miaoma/design-schema';

const shortText = (max: number) => z.string().trim().min(1).max(max);

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
  maxParallel: z.literal(1).default(1)
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
  acceptanceCriteria: z.array(shortText(256)).min(1).max(32)
}).strict();

export const generationRunStateSchema = z.enum([
  'queued', 'preparing', 'designing', 'assembling', 'validating', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review'
]);

export const generationEventSchema = z.object({
  eventId: nodeIdSchema,
  runId: nodeIdSchema,
  attemptId: nodeIdSchema,
  seq: z.number().int().positive().safe(),
  timestamp: z.string().datetime(),
  type: z.enum(['stateChanged', 'regionPlanned', 'regionStarted', 'regionDraft', 'candidateReady', 'validationReported', 'error']),
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

export const generationRunSnapshotSchema = z.object({
  run: generationRunSummarySchema,
  events: z.array(generationEventSchema).max(10_000),
  candidate: generationCandidateSchema.optional()
}).strict();

export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type DesignPlan = z.infer<typeof designPlanSchema>;
export type GenerationRunState = z.infer<typeof generationRunStateSchema>;
export type GenerationEvent = z.infer<typeof generationEventSchema>;
export type GenerationRunSummary = z.infer<typeof generationRunSummarySchema>;
export type GenerationCandidate = z.infer<typeof generationCandidateSchema>;
export type GenerationRunSnapshot = z.infer<typeof generationRunSnapshotSchema>;
