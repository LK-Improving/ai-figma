import { createHash, randomUUID } from 'node:crypto';
import {
  designPlanSchema,
  generatedFrameContentSchema,
  generationCandidateSchema,
  generationRequestSchema,
  generationRunSnapshotSchema,
  type DesignPlan,
  type GenerationCandidate,
  type GenerationEvent,
  type GenerationRequest,
  type GenerationRunSnapshot,
  type GenerationRunState,
  type GenerationRunSummary
} from '@miaoma/shared-protocol';
import { validateDesignDocument, type DesignDocument, type DesignNode, type DesignVariable } from '@miaoma/design-schema';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';
import type { FrameGenerationInput, FrameProvider } from './index';

export interface GenerationRunServiceOptions {
  providers: {
    'local-fake': FrameProvider;
    'codex-cli'?: FrameProvider;
  };
  /** Injectable only to make event-time tests deterministic. */
  now?: () => Date;
  /** Injectable ID source; values must satisfy the DSL node ID contract. */
  idFactory?: (kind: 'run' | 'attempt' | 'event' | 'candidate') => string;
}

export type GenerationRunErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_DOCUMENT'
  | 'DOCUMENT_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'PAGE_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'UNSUPPORTED_SCOPE'
  | 'ASSET_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_SCHEMA_INVALID'
  | 'PROVIDER_INPUT_TOO_LARGE'
  | 'CANDIDATE_INVALID'
  | 'RUN_ALREADY_ACTIVE'
  | 'RUN_NOT_FOUND'
  | 'INVALID_CURSOR';

export class GenerationRunError extends Error {
  constructor(
    readonly code: GenerationRunErrorCode,
    message: string,
    readonly path?: readonly (string | number)[],
    readonly retryable = false
  ) {
    super(message);
    this.name = 'GenerationRunError';
  }
}

type PlannedRegion = DesignPlan['regions'][number];
type RegionContent = { frameName: string; headline: string; description: string };
type RunRecord = {
  summary: GenerationRunSummary;
  request: GenerationRequest;
  baseDocument: DesignDocument;
  plan: DesignPlan;
  controller: AbortController;
  events: GenerationEvent[];
  candidate?: GenerationCandidate;
  fence: string;
};

const MAX_EVENTS = 10_000;
const MAX_RETAINED_RUNS = 10;
const TERMINAL_STATES = new Set<GenerationRunState>(['completed', 'cancelled', 'failed', 'conflict', 'needs_review']);
const COLOR = (id: string, fallback: string) => ({ kind: 'variable' as const, id, fallback });
const SOLID = (color: string | ReturnType<typeof COLOR>) => ({ type: 'solid' as const, color });
const EMPTY_STYLE = () => ({ fills: [], strokes: [], effects: [], opacity: 1 });

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (message || fallback).slice(0, 512);
}

function validationMessage(issues: readonly { path: readonly PropertyKey[]; message: string }[]): { path: (string | number)[]; message: string } {
  const issue = issues[0];
  return issue
    ? { path: issue.path.map((part) => typeof part === 'symbol' ? String(part) : part), message: issue.message }
    : { path: [], message: 'Value did not match the schema' };
}

function requestOrThrow(input: GenerationRequest): GenerationRequest {
  const parsed = generationRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = validationMessage(parsed.error.issues);
    throw new GenerationRunError('INVALID_REQUEST', `Invalid generation request at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
  }
  return parsed.data;
}

function documentOrThrow(input: DesignDocument): DesignDocument {
  const parsed = validateDesignDocument(input);
  if (!parsed.success) {
    const first = parsed.diagnostics[0];
    const path = first?.path ?? [];
    throw new GenerationRunError('INVALID_DOCUMENT', `Invalid base document at ${path.join('.') || '<root>'}: ${first?.message ?? 'Schema validation failed'}`, path);
  }
  return clone(parsed.data);
}

function assertRequestContext(request: GenerationRequest, document: DesignDocument): DesignDocument['pages'][number] {
  if (request.documentId !== document.documentId) {
    throw new GenerationRunError('DOCUMENT_MISMATCH', `Generation request targets document ${request.documentId}, but the supplied snapshot is ${document.documentId}`, ['documentId']);
  }
  if (request.baseRevision !== document.revision) {
    throw new GenerationRunError('REVISION_CONFLICT', `Generation request is based on revision ${request.baseRevision}; current snapshot is revision ${document.revision}`, ['baseRevision']);
  }
  const page = document.pages.find((item) => item.id === request.pageId);
  if (!page) throw new GenerationRunError('PAGE_NOT_FOUND', `Page ${request.pageId} is not part of the base document`, ['pageId']);
  if (request.targetNodeIds.length) {
    const pageNodeIds = new Set<string>();
    const stack: DesignNode[] = [page.root];
    while (stack.length) {
      const node = stack.pop()!;
      pageNodeIds.add(node.id);
      if (node.type === 'frame') stack.push(...node.children);
    }
    for (let index = 0; index < request.targetNodeIds.length; index++) {
      const targetId = request.targetNodeIds[index]!;
      if (!pageNodeIds.has(targetId)) throw new GenerationRunError('NODE_NOT_FOUND', `Target node ${targetId} is not part of page ${request.pageId}`, ['targetNodeIds', index]);
      if (request.targetNodeIds.length !== 1 || targetId !== page.root.id) {
        throw new GenerationRunError('UNSUPPORTED_SCOPE', 'S2 generation accepts a full page or its root Frame; partial subtree generation is not supported yet', ['targetNodeIds', index]);
      }
    }
  }
  for (let index = 0; index < request.referenceAssetIds.length; index++) {
    const assetId = request.referenceAssetIds[index]!;
    if (!document.assets[assetId]) throw new GenerationRunError('ASSET_NOT_FOUND', `Reference asset ${assetId} does not exist in the base document`, ['referenceAssetIds', index]);
  }
  return page;
}

function documentNodeIds(document: DesignDocument): Set<string> {
  const ids = new Set<string>([document.documentId]);
  for (const page of document.pages) {
    ids.add(page.id);
    const stack: DesignNode[] = [page.root];
    while (stack.length) {
      const node = stack.pop()!;
      ids.add(node.id);
      if (node.type === 'frame') stack.push(...node.children);
    }
  }
  Object.keys(document.variables).forEach((id) => ids.add(id));
  Object.keys(document.assets).forEach((id) => ids.add(id));
  return ids;
}

function chooseNamespace(document: DesignDocument, pageId: string): string {
  const digest = createHash('sha256').update(`${document.documentId}:${pageId}`).digest('hex').slice(0, 12);
  const reserved = documentNodeIds(document);
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const prefix = `ai_${digest}_${attempt.toString(36)}`;
    const ids = ['root', 'hero', 'features', 'proof', 'story', 'faq', 'pricing', 'cta', 'primary', 'surface', 'background', 'text', 'spacing', 'radius',
      'hero_section', 'hero_heading', 'hero_body', 'hero_action', 'features_section', 'features_heading', 'features_body',
      'proof_section', 'proof_heading', 'proof_body', 'story_section', 'story_heading', 'story_body', 'faq_section', 'faq_heading', 'faq_body',
      'pricing_section', 'pricing_heading', 'pricing_body', 'cta_section', 'cta_heading', 'cta_body'].map((part) => `${prefix}_${part}`);
    if (ids.every((id) => !reserved.has(id))) return prefix;
  }
  throw new GenerationRunError('INVALID_DOCUMENT', 'Could not allocate collision-free candidate IDs');
}

function currentPrimaryColor(request: GenerationRequest, document: DesignDocument): string {
  const reference = request.themeRef?.trim();
  if (reference && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(reference)) return reference;
  const variable = reference ? document.variables[reference] : undefined;
  if (variable?.type === 'color' && typeof variable.value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(variable.value)) return variable.value;
  if (reference?.toLowerCase().includes('dark')) return '#74C69D';
  return '#2F6B50';
}

function includesAny(text: string, expression: RegExp): boolean {
  return expression.test(text);
}

function makePlan(request: GenerationRequest, document: DesignDocument, namespace: string): DesignPlan {
  const prompt = `${request.title}\n${request.prompt}`;
  const chinese = /[\u3400-\u9fff]/.test(prompt);
  const compactPrompt = request.prompt.replace(/\s+/g, ' ').trim().slice(0, 340);
  const regionSpecs: Array<{ key: string; name: string; minHeight: number; brief: string }> = [
    { key: 'hero', name: chinese ? '首屏介绍' : 'Hero', minHeight: 340, brief: chinese ? '先说明页面的核心价值，用一句简洁文案补充，并给出明确的主要行动入口。' : 'Lead with the page promise, one clear supporting sentence, and a primary action.' },
    { key: 'features', name: chinese ? '核心优势' : 'Key benefits', minHeight: 380, brief: chinese ? '用清晰具体、便于浏览的文案说明主要功能或服务价值。' : 'Explain the main features or service value in scannable, concrete language.' }
  ];
  if (includesAny(prompt, /\b(testimonial|review|case study|social proof|trust)\b|客户评价|评价|口碑|客户案例|信任|成功案例/i)) {
    regionSpecs.push({ key: 'proof', name: chinese ? '客户口碑' : 'Customer proof', minHeight: 280, brief: chinese ? '呈现简洁、真实可信的客户证据；不得编造数据或评价。' : 'Present concise customer evidence or an honest proof point; do not invent statistics.' });
  }
  if (includesAny(prompt, /\b(story|about|company)\b|品牌故事|关于我们|团队介绍/i)) {
    regionSpecs.push({ key: 'story', name: chinese ? '品牌故事' : 'Story', minHeight: 300, brief: chinese ? '简要介绍与当前需求相关的产品、服务或团队故事。' : 'Give a short, relevant story about the product, service, or team.' });
  }
  if (includesAny(prompt, /\b(faq|questions?)\b|常见问题|常见疑问|问答/i)) {
    regionSpecs.push({ key: 'faq', name: chinese ? '常见问题' : 'FAQ', minHeight: 320, brief: chinese ? '回答需求中明确提出的问题，不要臆造服务政策或承诺。' : 'Address the questions explicitly requested by the brief without inventing policy details.' });
  }
  if (includesAny(prompt, /\b(pricing|plans?)\b|价格|套餐|定价/i)) {
    regionSpecs.push({ key: 'pricing', name: chinese ? '方案与价格' : 'Plans', minHeight: 340, brief: chinese ? '介绍需求中提到的方案或价格；没有给出具体金额时不要编造价格。' : 'Explain the requested pricing or plans without inventing exact prices that are absent from the brief.' });
  }
  regionSpecs.push({ key: 'cta', name: chinese ? '立即体验' : 'Call to action', minHeight: 250, brief: chinese ? '以符合产品或服务定位的明确下一步收尾。' : 'Close with a direct next step that matches the requested product or service.' });
  const regions = regionSpecs.map((region, order) => ({
    id: `${namespace}_${region.key}`,
    name: region.name,
    order,
    minHeight: region.minHeight,
    brief: `${region.brief}${compactPrompt ? ` User brief: ${compactPrompt}` : ''}`.slice(0, 1_000)
  }));
  const freeTokenSlots = Math.max(0, 500 - Object.keys(document.variables).length);
  const proposedTokens: DesignVariable[] = [
    { id: `${namespace}_primary`, type: 'color', value: currentPrimaryColor(request, document), description: 'Generated candidate primary brand color' },
    { id: `${namespace}_surface`, type: 'color', value: '#FFFFFF', description: 'Generated candidate surface color' },
    { id: `${namespace}_background`, type: 'color', value: '#F3F7F4', description: 'Generated candidate page background' },
    { id: `${namespace}_text`, type: 'color', value: '#20332B', description: 'Generated candidate text color' },
    { id: `${namespace}_spacing`, type: 'spacing', value: 24, description: 'Generated candidate standard spacing' },
    { id: `${namespace}_radius`, type: 'radius', value: 16, description: 'Generated candidate standard corner radius' }
  ];
  const tokens = proposedTokens.slice(0, Math.min(proposedTokens.length, freeTokenSlots));
  const purpose = includesAny(prompt, /\b(dashboard|admin|back.?office)\b|后台|管理平台|管理系统/i)
    ? chinese ? '单页管理工作台' : 'A single-page management dashboard'
    : includesAny(prompt, /\b(store|shop|commerce|product|service)\b|商城|商店|产品|商品|服务/i)
      ? chinese ? '产品或服务落地页' : 'A product or service landing page'
      : chinese ? '围绕当前需求构建的单页设计' : 'A single-page design for the requested brief';
  const summary = `${request.title}: ${compactPrompt || 'Create a clear, polished first-page experience.'}`.slice(0, 512);
  const fixedAcceptance = [
    'All planned regions appear in the requested order with readable content.',
    'The generated DSL passes schema, reference, identity, and geometry validation.',
    'The candidate remains separate from the formal document until explicitly applied.'
  ];
  const rawPlan = {
    summary,
    pagePurpose: purpose.slice(0, 256),
    tokens,
    regions,
    dependencies: [],
    acceptanceCriteria: fixedAcceptance
  };
  const parsed = designPlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    const issue = validationMessage(parsed.error.issues);
    throw new GenerationRunError('INVALID_REQUEST', `Planner output invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
  }
  return parsed.data;
}

function candidateIdFactory(namespace: string, regions: readonly PlannedRegion[]): (regionId: string, suffix: string) => string {
  const known = new Set(regions.map((region) => region.id));
  return (regionId, suffix) => `${namespace}_${known.has(regionId) ? regionId.slice(namespace.length + 1) : 'page'}_${suffix}`;
}

function createTextNode(
  id: string,
  name: string,
  text: string,
  bounds: { x: number; y: number; width: number; height: number },
  options: { fontSize: number; color: string; weight: number }
): Extract<DesignNode, { type: 'text' }> {
  return {
    id, type: 'text', name, visible: true, locked: false, bounds,
    transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: EMPTY_STYLE(), text,
    typography: { fontFamily: 'Arial, sans-serif', fontSize: options.fontSize, fontWeight: options.weight, lineHeight: 1.4, letterSpacing: 0, textAlign: 'left', color: options.color }, sizing: 'auto'
  };
}

function assembleCandidateDocument(
  request: GenerationRequest,
  sourceDocument: DesignDocument,
  plan: DesignPlan,
  contents: ReadonlyMap<string, RegionContent>,
  namespace: string
): DesignDocument {
  const document = clone(sourceDocument);
  const page = document.pages.find((item) => item.id === request.pageId);
  if (!page) throw new GenerationRunError('PAGE_NOT_FOUND', `Page ${request.pageId} is not part of the base document`, ['pageId']);
  for (const token of plan.tokens) document.variables[token.id] = clone(token);

  const tokenId = (suffix: string) => `${namespace}_${suffix}`;
  const colorValue = (suffix: string, fallback: string): string | ReturnType<typeof COLOR> =>
    plan.tokens.some((token) => token.id === tokenId(suffix)) ? COLOR(tokenId(suffix), fallback) : fallback;
  const background = colorValue('background', '#F3F7F4');
  const surface = colorValue('surface', '#FFFFFF');
  const primary = plan.tokens.find((token) => token.id === tokenId('primary'))?.value;
  const primaryColor = typeof primary === 'string' ? primary : '#2F6B50';
  const width = request.viewport.width;
  const totalContentHeight = plan.regions.reduce((sum, region) => sum + region.minHeight, 0);
  const height = Math.max(request.viewport.height, totalContentHeight);
  const inset = Math.min(48, Math.max(8, Math.floor(width * 0.055)));
  const headingWidth = Math.max(1, width - inset * 2);
  let y = 0;
  const children: Extract<DesignNode, { type: 'frame' }>[] = [];
  const makeId = candidateIdFactory(namespace, plan.regions);
  for (const [index, region] of plan.regions.entries()) {
    const content = contents.get(region.id);
    if (!content) throw new GenerationRunError('CANDIDATE_INVALID', `Region ${region.id} has no generated content`, ['regions', region.id]);
    const sectionHeight = region.minHeight;
    const sectionId = makeId(region.id, 'section');
    const childrenForSection: DesignNode[] = [
      createTextNode(makeId(region.id, 'heading'), 'Heading', content.headline, { x: inset, y: 42, width: headingWidth, height: 68 }, { fontSize: index === 0 ? 40 : 30, color: '#20332B', weight: 700 }),
      createTextNode(makeId(region.id, 'body'), 'Body', content.description, { x: inset, y: 128, width: headingWidth, height: Math.max(64, sectionHeight - 168) }, { fontSize: 18, color: '#53655B', weight: 400 })
    ];
    if (index === 0) {
      childrenForSection.push({
        id: makeId(region.id, 'action'), type: 'rectangle', name: 'Primary action', visible: true, locked: false,
        bounds: { x: inset, y: sectionHeight - 74, width: Math.min(240, headingWidth), height: 48 },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: { fills: [SOLID(primaryColor)], strokes: [], effects: [], opacity: 1 }, radius: 12
      });
    }
    children.push({
      id: sectionId, type: 'frame', name: region.name, visible: true, locked: false,
      bounds: { x: 0, y, width, height: sectionHeight },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [SOLID(index % 2 === 0 ? surface : '#F8FAF8')], strokes: [], effects: [], opacity: 1 },
      children: childrenForSection, layout: { mode: 'absolute' }, clipContent: true
    });
    y += sectionHeight;
  }
  const rootId = `${namespace}_root`;
  const root: Extract<DesignNode, { type: 'frame' }> = {
    id: rootId, type: 'frame', name: 'AI candidate', visible: true, locked: false,
    bounds: { x: 0, y: 0, width, height },
    transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [SOLID(background)], strokes: [], effects: [], opacity: 1 },
    children, layout: { mode: 'absolute' }, clipContent: true
  };
  page.root = root;
  // A candidate is still based on the submitted revision. Main/editor-core assigns a new revision only after explicit apply.
  document.revision = request.baseRevision;
  return document;
}

function providerCode(error: unknown): { code: string; retryable: boolean } {
  if (!error || typeof error !== 'object') return { code: 'PROVIDER_ERROR', retryable: false };
  const record = error as { code?: unknown; retryable?: unknown };
  const code = typeof record.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(record.code) ? record.code : 'PROVIDER_ERROR';
  return { code, retryable: typeof record.retryable === 'boolean' ? record.retryable : false };
}

function terminal(state: GenerationRunState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * S2 single-executor orchestration. Runs only return validated candidate snapshots;
 * the Main process/editor-core owns any explicit application to the live document.
 */
export class GenerationRunService {
  private readonly providers: GenerationRunServiceOptions['providers'];
  private readonly now: () => Date;
  private readonly idFactory: NonNullable<GenerationRunServiceOptions['idFactory']>;
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<(event: GenerationEvent) => void>();

  constructor(options: GenerationRunServiceOptions) {
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID().replaceAll('-', '')}`);
  }

  plan(requestInput: GenerationRequest, documentInput: DesignDocument): DesignPlan {
    const request = requestOrThrow(requestInput);
    const document = documentOrThrow(documentInput);
    assertRequestContext(request, document);
    const namespace = chooseNamespace(document, request.pageId);
    const plan = makePlan(request, document, namespace);
    for (const region of plan.regions) this.#providerInput(request, region);
    return plan;
  }

  start(requestInput: GenerationRequest, documentInput: DesignDocument): GenerationRunSummary {
    const request = requestOrThrow(requestInput);
    const document = documentOrThrow(documentInput);
    assertRequestContext(request, document);
    if ([...this.runs.values()].some((record) => !terminal(record.summary.state))) {
      throw new GenerationRunError('RUN_ALREADY_ACTIVE', 'A single-executor generation Run is already active', undefined, true);
    }
    const plan = this.plan(request, document);
    const runId = this.#makeId('run');
    if (this.runs.has(runId)) throw new GenerationRunError('INVALID_REQUEST', `ID factory returned a duplicate run ID: ${runId}`);
    const attemptId = this.#makeId('attempt');
    const startedAt = this.#timestamp();
    while (this.runs.size >= MAX_RETAINED_RUNS) {
      const oldestTerminal = [...this.runs.entries()].find(([, record]) => terminal(record.summary.state));
      if (!oldestTerminal) throw new GenerationRunError('RUN_ALREADY_ACTIVE', 'Generation Run capacity is temporarily full', undefined, true);
      this.runs.delete(oldestTerminal[0]);
    }
    const summary: GenerationRunSummary = {
      runId, attemptId, state: 'queued', baseRevision: request.baseRevision,
      eventSeq: 0, startedAt, candidateAvailable: false
    };
    const record: RunRecord = {
      summary, request, baseDocument: document, plan, controller: new AbortController(), events: [], fence: attemptId
    };
    this.runs.set(runId, record);
    this.#appendEvent(record, 'stateChanged', { from: 'created', to: 'queued' });
    const fence = record.fence;
    void Promise.resolve().then(() => this.#execute(record, fence)).catch((error: unknown) => {
      if (this.#isCurrent(record, fence)) this.#fail(record, error, 'RUN_ERROR');
    });
    return clone(summary);
  }

  get(runId: string, afterSeq = 0): GenerationRunSnapshot {
    const record = this.#getRecord(runId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new GenerationRunError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer', ['afterSeq']);
    const snapshot = {
      run: clone(record.summary),
      events: record.events.filter((event) => event.seq > afterSeq).map((event) => clone(event)),
      ...(record.candidate ? { candidate: clone(record.candidate) } : {})
    };
    const parsed = generationRunSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      const issue = validationMessage(parsed.error.issues);
      throw new GenerationRunError('CANDIDATE_INVALID', `Run snapshot invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
    }
    return parsed.data;
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record || terminal(record.summary.state)) return false;
    record.controller.abort();
    delete record.candidate;
    record.summary.candidateAvailable = false;
    delete record.summary.error;
    this.#transition(record, 'cancelled');
    return true;
  }

  getCandidate(runId: string): GenerationCandidate | undefined {
    const record = this.#getRecord(runId);
    return record.candidate ? clone(record.candidate) : undefined;
  }

  subscribe(listener: (event: GenerationEvent) => void): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  async #execute(record: RunRecord, fence: string): Promise<void> {
    if (!this.#isCurrent(record, fence)) return;
    try {
      this.#transition(record, 'preparing');
      if (!this.#isCurrent(record, fence)) return;
      for (const region of record.plan.regions) this.#appendEvent(record, 'regionPlanned', this.#regionPayload(region));
      const provider = this.providers[record.request.providerRef];
      if (!provider) throw new GenerationRunError('PROVIDER_UNAVAILABLE', `Provider ${record.request.providerRef} is not configured`, ['providerRef'], false);

      const providerInputs = record.plan.regions.map((region) => ({ region, input: this.#providerInput(record.request, region) }));
      this.#transition(record, 'designing');
      const contentByRegion = new Map<string, RegionContent>();
      for (const { region, input } of providerInputs) {
        if (!this.#isCurrent(record, fence)) return;
        this.#appendEvent(record, 'regionStarted', this.#regionPayload(region));
        let output: unknown;
        try {
          output = await provider.generateFrame(input, { signal: record.controller.signal });
        } catch (error) {
          if (!this.#isCurrent(record, fence)) return;
          throw new RegionRunFailure(region.id, error);
        }
        if (!this.#isCurrent(record, fence)) return;
        const parsedOutput = generatedFrameContentSchema.safeParse(output);
        if (!parsedOutput.success) {
          const issue = validationMessage(parsedOutput.error.issues);
          this.#appendEvent(record, 'validationReported', {
            valid: false, scope: 'provider-output', regionId: region.id,
            path: issue.path, code: 'PROVIDER_SCHEMA_INVALID', message: issue.message
          });
          throw new GenerationRunError('PROVIDER_SCHEMA_INVALID', `Provider output for region ${region.id} is invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, ['regions', region.id, ...issue.path], true);
        }
        contentByRegion.set(region.id, parsedOutput.data);
        this.#appendEvent(record, 'regionDraft', { regionId: region.id, headline: parsedOutput.data.headline, description: parsedOutput.data.description });
      }

      if (!this.#isCurrent(record, fence)) return;
      this.#transition(record, 'assembling');
      const namespace = chooseNamespace(record.baseDocument, record.request.pageId);
      const candidateDocument = assembleCandidateDocument(record.request, record.baseDocument, record.plan, contentByRegion, namespace);
      const validation = validateDesignDocument(candidateDocument);
      if (!validation.success) {
        const first = validation.diagnostics[0];
        const path = first?.path ?? [];
        this.#appendEvent(record, 'validationReported', {
          valid: false, scope: 'candidate-document', code: first?.code ?? 'INVALID_DOCUMENT', path, message: first?.message ?? 'Candidate document is invalid'
        });
        throw new GenerationRunError('CANDIDATE_INVALID', `Candidate document is invalid at ${path.join('.') || '<root>'}: ${first?.message ?? 'DSL validation failed'}`, path);
      }
      this.#transition(record, 'validating');
      const rendered = renderDocumentScreenshot(validation.data, record.request.pageId, 1, 4096);
      const rawCandidate: GenerationCandidate = {
        candidateId: this.#makeId('candidate'),
        runId: record.summary.runId,
        baseRevision: record.request.baseRevision,
        createdAt: this.#timestamp(),
        summary: record.plan.summary,
        plan: clone(record.plan),
        document: validation.data,
        previewSvg: rendered.svg
      };
      const checkedCandidate = generationCandidateSchema.safeParse(rawCandidate);
      if (!checkedCandidate.success) {
        const issue = validationMessage(checkedCandidate.error.issues);
        this.#appendEvent(record, 'validationReported', {
          valid: false, scope: 'candidate', code: 'CANDIDATE_SCHEMA_INVALID', path: issue.path, message: issue.message
        });
        throw new GenerationRunError('CANDIDATE_INVALID', `Candidate is invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
      }
      if (!this.#isCurrent(record, fence)) return;
      this.#appendEvent(record, 'validationReported', { valid: true, scope: 'candidate-document', documentRevision: record.request.baseRevision, regionCount: record.plan.regions.length });
      record.candidate = checkedCandidate.data;
      record.summary.candidateAvailable = true;
      this.#appendEvent(record, 'candidateReady', {
        candidateId: checkedCandidate.data.candidateId,
        baseRevision: checkedCandidate.data.baseRevision,
        regionIds: record.plan.regions.map((region) => region.id),
        documentRevision: checkedCandidate.data.document.revision
      });
      if (!this.#isCurrent(record, fence)) return;
      this.#transition(record, 'completed');
    } catch (error) {
      if (!this.#isCurrent(record, fence)) return;
      if (error instanceof RegionRunFailure) {
        const failure = error.original;
        const mapped = providerCode(failure);
        const message = `Provider failed for region ${error.regionId}: ${safeMessage(failure, 'Provider request failed')}`;
        this.#appendEvent(record, 'error', { code: mapped.code, message, retryable: mapped.retryable, regionId: error.regionId });
        this.#fail(record, new GenerationRunError('PROVIDER_UNAVAILABLE', message, ['regions', error.regionId], mapped.retryable), mapped.code);
        return;
      }
      this.#fail(record, error, error instanceof GenerationRunError ? error.code : 'RUN_ERROR');
    }
  }

  #providerInput(request: GenerationRequest, region: PlannedRegion): FrameGenerationInput {
    const title = `${request.title.slice(0, 160)} — ${region.name}`.slice(0, 256);
    const prompt = [
      `Region brief: ${region.brief}`,
      `User design request: ${request.prompt}`,
      ...(request.constraints.length ? [`Constraints: ${request.constraints.map((item) => `- ${item}`).join('\n')}`] : []),
      ...(request.themeRef ? [`Theme reference: ${request.themeRef}`] : []),
      ...(request.referenceAssetIds.length ? [`Reference asset IDs: ${request.referenceAssetIds.join(', ')}`] : []),
      ...(request.targetNodeIds.length ? [`Target node IDs: ${request.targetNodeIds.join(', ')}`] : []),
      `Viewport: ${request.viewport.width} by ${request.viewport.height}.`
    ].join('\n');
    if (prompt.length > 20_000) {
      throw new GenerationRunError('PROVIDER_INPUT_TOO_LARGE', `Combined region prompt is ${prompt.length} characters; reduce the request or constraints so it stays within the 20,000-character provider limit`, ['prompt', 'constraints']);
    }
    return { title, prompt };
  }

  #regionPayload(region: PlannedRegion): Record<string, unknown> {
    return { regionId: region.id, name: region.name, order: region.order, minHeight: region.minHeight };
  }

  #makeId(kind: 'run' | 'attempt' | 'event' | 'candidate'): string {
    const id = this.idFactory(kind);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(id)) throw new GenerationRunError('INVALID_REQUEST', `ID factory returned an invalid ${kind} ID`);
    return id;
  }

  #timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new GenerationRunError('INVALID_REQUEST', 'Clock returned an invalid date');
    return date.toISOString();
  }

  #getRecord(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new GenerationRunError('RUN_NOT_FOUND', `Generation run ${runId} was not found`, ['runId']);
    return record;
  }

  #isCurrent(record: RunRecord, fence: string): boolean {
    return this.runs.get(record.summary.runId) === record && record.fence === fence && record.summary.attemptId === fence && !terminal(record.summary.state);
  }

  #appendEvent(record: RunRecord, type: GenerationEvent['type'], payload: Record<string, unknown>): void {
    if (record.events.length >= MAX_EVENTS) throw new GenerationRunError('CANDIDATE_INVALID', 'Generation run exceeded its event limit');
    const event: GenerationEvent = {
      eventId: this.#makeId('event'), runId: record.summary.runId, attemptId: record.summary.attemptId,
      seq: record.summary.eventSeq + 1, timestamp: this.#timestamp(), type,
      documentRevision: record.request.baseRevision, payload: clone(payload)
    };
    record.events.push(event);
    record.summary.eventSeq = event.seq;
    for (const listener of [...this.listeners]) {
      try { listener(clone(event)); } catch { /* A UI subscriber cannot fail the generation run. */ }
    }
  }

  #transition(record: RunRecord, state: GenerationRunState): void {
    const previous = record.summary.state;
    if (terminal(previous)) return;
    record.summary.state = state;
    if (terminal(state)) record.summary.completedAt = this.#timestamp();
    this.#appendEvent(record, 'stateChanged', { from: previous, to: state });
  }

  #fail(record: RunRecord, error: unknown, fallbackCode: string): void {
    if (terminal(record.summary.state)) return;
    const typed = error instanceof GenerationRunError ? error : undefined;
    const code = fallbackCode !== 'RUN_ERROR' && /^[A-Z0-9_]{1,64}$/.test(fallbackCode)
      ? fallbackCode
      : typed?.code ?? 'RUN_ERROR';
    const message = safeMessage(error, 'Generation failed');
    record.summary.error = { code, message, retryable: typed?.retryable ?? false };
    delete record.candidate;
    record.summary.candidateAvailable = false;
    if (!record.events.some((event) => event.type === 'error' && event.payload['code'] === code)) {
      this.#appendEvent(record, 'error', { code, message, retryable: record.summary.error.retryable, ...(typed?.path ? { path: [...typed.path] } : {}) });
    }
    this.#transition(record, 'failed');
  }
}

class RegionRunFailure extends Error {
  constructor(readonly regionId: string, readonly original: unknown) {
    super(`Region ${regionId} failed`);
    this.name = 'RegionRunFailure';
  }
}
