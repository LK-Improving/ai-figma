import { createHash, randomUUID } from 'node:crypto';
import {
  designPlanSchema,
  generatedFrameContentSchema,
  generationCandidateSchema,
  generationEventSchema,
  generationRunCheckpointSchema,
  generationRequestSchema,
  generationRunSnapshotSchema,
  screenshotEvidenceContentSchema,
  type DesignPlan,
  type GenerationCandidate,
  type GenerationEvent,
  type GenerationRequest,
  type GenerationRunSnapshot,
  type GenerationRunState,
  type GenerationRunSummary,
  type AgentRunState,
  type AgentTask,
  type GenerationRunCheckpoint,
  type QualityLoopState,
  type ScreenshotEvidenceContent
} from '@miaoma/shared-protocol';
import { validateDesignDocument, type DesignDocument, type DesignNode, type DesignVariable } from '@miaoma/design-schema';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';
import type { FrameGenerationInput, FrameProvider } from './index';
import { runDagScheduler, type DagTaskEvent } from './dag-scheduler';
import { makeAgentRoster, RuleBasedRepairProvider, RuleBasedVisualReviewer, runQualityLoop, type RepairProposalProvider, type VisualReviewProvider } from './quality-loop';

export interface GenerationRunServiceOptions {
  providers: {
    'local-fake': FrameProvider;
    'codex-cli'?: FrameProvider;
  };
  /** Injectable only to make event-time tests deterministic. */
  now?: () => Date;
  /** Injectable ID source; values must satisfy the DSL node ID contract. */
  idFactory?: (kind: 'run' | 'attempt' | 'event' | 'candidate') => string;
  visualReviewer?: VisualReviewProvider;
  repairProvider?: RepairProposalProvider;
  /** Injectable render-environment readiness; production defaults to unverified. */
  fontsReady?: boolean;
  persistEvent?(projectId: string, event: GenerationEvent): Promise<unknown>;
  persistCheckpoint?(checkpoint: GenerationRunCheckpoint): Promise<{ checkpointId: string } | void>;
  persistEvidence?(projectId: string, content: ScreenshotEvidenceContent): Promise<unknown>;
  renderAssetDataUrls?(projectId: string, document: DesignDocument): Promise<Record<string, string>>;
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
  | 'RUN_NOT_RESUMABLE'
  | 'STALE_ATTEMPT'
  | 'RESUME_CONTEXT_MISMATCH'
  | 'WARNINGS_NOT_ACCEPTABLE'
  | 'EVIDENCE_UNAVAILABLE'
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
  collaboration: AgentRunState;
  loop: QualityLoopState;
  evidenceContent: Map<string, string>;
  projectId?: string;
  completedRegions: Record<string, RegionContent>;
  loopResumeRound?: number;
  checkpoint?: GenerationRunCheckpoint;
  persistenceChain: Promise<void>;
  persistenceError?: unknown;
};

const MAX_EVENTS = 10_000;
const MAX_RETAINED_RUNS = 50;
const TERMINAL_STATES = new Set<GenerationRunState>(['interrupted', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review']);
const COLLABORATOR_IDS = ['newton', 'tesla', 'maxwell', 'curie', 'faraday'] as const;
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
  const floral = includesAny(prompt, /花店|鲜花|花卉|花束|\bflowers?\b|\bbotanical\b/i);
  const compactPrompt = request.prompt.replace(/\s+/g, ' ').trim().slice(0, 340);
  const regionSpecs: Array<{ key: string; name: string; minHeight: number; brief: string }> = [
    { key: 'hero', name: chinese ? '首屏介绍' : 'Hero', minHeight: floral ? 680 : 340, brief: chinese ? '先说明页面的核心价值，用一句简洁文案补充，并给出明确的主要行动入口。' : 'Lead with the page promise, one clear supporting sentence, and a primary action.' },
    { key: 'features', name: chinese ? '核心优势' : 'Key benefits', minHeight: floral ? 520 : 380, brief: chinese ? '用清晰具体、便于浏览的文案说明主要功能或服务价值。' : 'Explain the main features or service value in scannable, concrete language.' }
  ];
  const landingPage = includesAny(prompt, /官网|品牌|生活方式|首页|网站|花店|落地页|\b(landing page|homepage|website)\b/i);
  const featuredContent = includesAny(prompt, /精选内容|精选产品|推荐内容|商品展示|产品展示|作品展示|\b(featured content|product collection)\b/i);
  const customerProof = includesAny(prompt, /\b(testimonial|review|case study|social proof|trust)\b|客户评价|评价|口碑|客户案例|信任|成功案例/i);
  if (featuredContent || customerProof || landingPage) {
    regionSpecs.push({ key: 'proof', name: chinese ? customerProof && !featuredContent ? '客户口碑' : '精选内容' : customerProof && !featuredContent ? 'Customer proof' : 'Featured content', minHeight: floral ? 840 : 280, brief: chinese ? featuredContent || landingPage ? '呈现需求指定的精选内容、产品或案例，并配上清晰的说明。' : '呈现简洁、真实可信的客户证据；不得编造数据或评价。' : featuredContent || landingPage ? 'Present the requested featured content, products, or cases with clear descriptions.' : 'Present concise customer evidence or an honest proof point; do not invent statistics.' });
  }
  if (landingPage || includesAny(prompt, /\b(story|about|company)\b|品牌故事|关于我们|团队介绍/i)) {
    regionSpecs.push({ key: 'story', name: chinese ? '品牌故事' : 'Story', minHeight: floral ? 900 : 300, brief: chinese ? '简要介绍与当前需求相关的产品、服务或团队故事。' : 'Give a short, relevant story about the product, service, or team.' });
  }
  if (includesAny(prompt, /\b(faq|questions?)\b|常见问题|常见疑问|问答/i)) {
    regionSpecs.push({ key: 'faq', name: chinese ? '常见问题' : 'FAQ', minHeight: 320, brief: chinese ? '回答需求中明确提出的问题，不要臆造服务政策或承诺。' : 'Address the questions explicitly requested by the brief without inventing policy details.' });
  }
  if (includesAny(prompt, /\b(pricing|plans?)\b|价格|套餐|定价/i)) {
    regionSpecs.push({ key: 'pricing', name: chinese ? '方案与价格' : 'Plans', minHeight: 340, brief: chinese ? '介绍需求中提到的方案或价格；没有给出具体金额时不要编造价格。' : 'Explain the requested pricing or plans without inventing exact prices that are absent from the brief.' });
  }
  regionSpecs.push({ key: 'cta', name: chinese ? '立即体验' : 'Call to action', minHeight: floral ? 660 : 250, brief: chinese ? '以符合产品或服务定位的明确下一步收尾。' : 'Close with a direct next step that matches the requested product or service.' });
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
  const ownershipMap = regions.map((region, index) => ({ regionId: region.id, agentId: COLLABORATOR_IDS[index % COLLABORATOR_IDS.length]! }));
  const rawPlan = {
    summary,
    pagePurpose: purpose.slice(0, 256),
    tokens,
    regions,
    dependencies: [],
    ownershipMap,
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
  const flowerAssets = {
    hero: 'demo_flower_hero',
    tulips: 'demo_flower_tulips',
    roses: 'demo_flower_roses',
    dahlias: 'demo_flower_dahlias'
  } as const;
  const floral = Object.values(flowerAssets).every((assetId) => !!document.assets[assetId]);
  let y = 0;
  const children: Extract<DesignNode, { type: 'frame' }>[] = [];
  const makeId = candidateIdFactory(namespace, plan.regions);
  const rectangle = (regionId: string, suffix: string, name: string, bounds: { x: number; y: number; width: number; height: number }, fill: DesignNode['style']['fills'][number], radius = 0, opacity = 1): Extract<DesignNode, { type: 'rectangle' }> => ({
    id: makeId(regionId, suffix), type: 'rectangle', name, visible: true, locked: false, bounds,
    transform: { rotation: 0, scaleX: 1, scaleY: 1 }, style: { fills: [fill], strokes: [], effects: [], opacity }, radius
  });
  for (const [index, region] of plan.regions.entries()) {
    const content = contents.get(region.id);
    if (!content) throw new GenerationRunError('CANDIDATE_INVALID', `Region ${region.id} has no generated content`, ['regions', region.id]);
    const sectionHeight = region.minHeight;
    const sectionId = makeId(region.id, 'section');
    let sectionFill = SOLID(index % 2 === 0 ? surface : '#F8FAF8');
    let childrenForSection: DesignNode[];
    const regionKey = region.id.startsWith(`${namespace}_`) ? region.id.slice(namespace.length + 1) : '';
    if (floral && ['hero', 'features', 'proof', 'story', 'cta'].includes(regionKey)) {
      const textNode = (suffix: string, name: string, text: string, bounds: { x: number; y: number; width: number; height: number }, fontSize: number, color: string, weight = 400, align: 'left' | 'center' | 'right' = 'left') => {
        const node = createTextNode(makeId(region.id, suffix), name, text, bounds, { fontSize, color, weight });
        node.typography.textAlign = align;
        node.typography.fontFamily = 'Microsoft YaHei, Arial, sans-serif';
        return node;
      };
      const textInk = '#283B2F';
      if (regionKey === 'hero') {
        sectionFill = SOLID('#102F28');
        childrenForSection = [
          rectangle(region.id, 'hero-image', '花田背景', { x: 0, y: 0, width, height: sectionHeight }, { type: 'asset', assetId: flowerAssets.hero }),
          rectangle(region.id, 'hero-shade', '深色背景遮罩', { x: 0, y: 0, width, height: sectionHeight }, SOLID('#08261F'), 0, 0.52),
          textNode('brand', '品牌名称', '花间 Flora Studio', { x: 88, y: 28, width: 340, height: 38 }, 23, '#FFFFFF', 700),
          textNode('nav', '导航', '鲜花系列     花艺灵感     关于花间', { x: 650, y: 38, width: 700, height: 26 }, 14, '#E8EFE8', 500, 'right'),
          textNode('eyebrow', '眉题', 'FLOWERS FOR EVERY MOMENT', { x: 96, y: 118, width: 590, height: 24 }, 12, '#D4E3D7', 700),
          textNode('hero-title', '首屏标题', '把这一季的花，\n送给想念的人', { x: 92, y: 160, width: 920, height: 150 }, 58, '#FFFFFF', 700),
          textNode('hero-body', '首屏说明', '用当季花材，留住值得分享的心意。\n自然花束与花艺灵感，为日常带来一份温柔。', { x: 98, y: 332, width: 680, height: 64 }, 18, '#E4ECE5'),
          rectangle(region.id, 'hero-action', '主要按钮', { x: 98, y: 426, width: 208, height: 54 }, SOLID('#39795F'), 27),
          textNode('hero-action-label', '按钮文案', '浏览当季花束  →', { x: 120, y: 442, width: 170, height: 26 }, 14, '#FFFFFF', 600),
          rectangle(region.id, 'hero-secondary-action', '次要按钮', { x: 322, y: 426, width: 164, height: 54 }, SOLID('#F6F7F3'), 27, 0.96),
          textNode('hero-secondary-label', '次要按钮文案', '预约花艺定制', { x: 338, y: 442, width: 136, height: 26 }, 13, '#254536', 600, 'center'),
          rectangle(region.id, 'hero-service-pill', '服务标签底色', { x: 98, y: 504, width: 540, height: 44 }, SOLID('#102D26'), 22, 0.86),
          textNode('hero-service-labels', '服务标签', '当季鲜花       花艺定制       暖心送达', { x: 116, y: 516, width: 500, height: 24 }, 13, '#F2F6F0', 500)
        ];
      } else if (regionKey === 'features') {
        sectionFill = SOLID('#FBFAF6');
        childrenForSection = [
          textNode('section-eyebrow', '眉题', 'FLOWERS FOR EVERY MOMENT', { x: 100, y: 42, width: 1240, height: 22 }, 12, '#52614F', 700, 'center'),
          textNode('section-title', '区域标题', '把这一季的花，送给想念的人', { x: 100, y: 76, width: 1240, height: 56 }, 34, textInk, 700, 'center'),
          textNode('section-body', '区域说明', '自然花材与用心设计，让每一次心意都值得被看见。', { x: 100, y: 140, width: 1240, height: 34 }, 16, '#53655B', 400, 'center'),
        ];
        const benefits = [
          { key: 'seasonal', title: '主题鲜花', copy: '跟着季节挑选花材', color: '#D6E8DE' },
          { key: 'gift', title: '暖心礼赠', copy: '为重要的人准备心意', color: '#F4DCE0' },
          { key: 'natural', title: '自然花材', copy: '新鲜花材每日精选', color: '#E8EEE7' },
          { key: 'design', title: '花艺定制', copy: '按你的想法手工搭配', color: '#D6E8DE' },
          { key: 'delivery', title: '暖心直送', copy: '把喜欢的花送到身边', color: '#F4DCE0' }
        ];
        benefits.forEach((benefit, benefitIndex) => {
          const x = 64 + benefitIndex * 266;
          childrenForSection.push(
            rectangle(region.id, `benefit-${benefit.key}-card`, `${benefit.title}卡片`, { x, y: 224, width: 248, height: 96 }, SOLID('#FFFFFF'), 12),
            rectangle(region.id, `benefit-${benefit.key}-mark`, `${benefit.title}标记`, { x: x + 18, y: 252, width: 38, height: 38 }, SOLID(benefit.color), 19),
            textNode(`benefit-${benefit.key}-title`, `${benefit.title}标题`, benefit.title, { x: x + 68, y: 239, width: 164, height: 27 }, 16, textInk, 700),
            textNode(`benefit-${benefit.key}-copy`, `${benefit.title}说明`, benefit.copy, { x: x + 68, y: 272, width: 164, height: 32 }, 12, '#667368')
          );
        });
        childrenForSection.push(textNode('feature-footnote', '服务说明', '从一束鲜花开始，把自然与心意带进日常。', { x: 100, y: 376, width: 1240, height: 26 }, 14, '#758176', 400, 'center'));
      } else if (regionKey === 'proof') {
        sectionFill = SOLID('#F5F1E7');
        const cardX = [72, 396, 720, 1044];
        const products = [
          { suffix: 'tulips', assetId: flowerAssets.tulips, title: '春日郁金香', description: '明亮的花色，为日常添一抹轻快。', price: '¥268', badge: '当季推荐' },
          { suffix: 'roses', assetId: flowerAssets.roses, title: '庭院玫瑰', description: '柔和层次与奶油色调，安静而温柔。', price: '¥238', badge: '人气花束' },
          { suffix: 'dahlias', assetId: flowerAssets.dahlias, title: '蜜桃花园', description: '以桃粉与浅杏色，留下温暖印象。', price: '¥298', badge: '花艺定制' },
          { suffix: 'garden', assetId: flowerAssets.hero, title: '日常花篮', description: '把花园里的自然气息，带回家中。', price: '¥258', badge: '暖心礼赠' }
        ];
        childrenForSection = [
          textNode('section-eyebrow', '眉题', 'SEASONAL COLLECTION', { x: 96, y: 52, width: 1248, height: 22 }, 12, '#52614F', 700),
          textNode('section-title', '区域标题', '当季精选', { x: 96, y: 82, width: 700, height: 52 }, 34, textInk, 700),
          textNode('section-body', '区域说明', '为重要时刻与平常日子，挑一束刚刚好的花。', { x: 100, y: 136, width: 900, height: 32 }, 16, '#53655B')
        ];
        products.forEach((product, productIndex) => {
          const x = cardX[productIndex]!;
          childrenForSection.push(
            rectangle(region.id, `product-${product.suffix}-card`, `${product.title}商品卡片`, { x, y: 192, width: 300, height: 580 }, SOLID('#FFFFFF'), 12),
            rectangle(region.id, `product-${product.suffix}-image`, `${product.title}花束照片`, { x, y: 192, width: 300, height: 250 }, { type: 'asset', assetId: product.assetId }),
            rectangle(region.id, `product-${product.suffix}-badge`, `${product.title}标签`, { x: x + 16, y: 208, width: 92, height: 26 }, SOLID('#F7F8F2'), 13),
            textNode(`product-${product.suffix}-badge-label`, `${product.title}标签文案`, product.badge, { x: x + 22, y: 212, width: 80, height: 20 }, 11, '#315A44', 700, 'center'),
            textNode(`product-${product.suffix}-title`, `${product.title}标题`, product.title, { x: x + 18, y: 458, width: 264, height: 32 }, 20, textInk, 700),
            textNode(`product-${product.suffix}-copy`, `${product.title}说明`, product.description, { x: x + 18, y: 498, width: 264, height: 38 }, 13, '#53655B'),
            textNode(`product-${product.suffix}-price`, `${product.title}价格`, product.price, { x: x + 18, y: 558, width: 108, height: 32 }, 22, '#23372C', 700),
            rectangle(region.id, `product-${product.suffix}-action`, `${product.title}操作按钮`, { x: x + 164, y: 554, width: 118, height: 42 }, SOLID('#39795F'), 21),
            textNode(`product-${product.suffix}-action-label`, `${product.title}按钮文案`, '去选花束', { x: x + 170, y: 564, width: 106, height: 22 }, 12, '#FFFFFF', 700, 'center')
          );
        });
      } else if (regionKey === 'story') {
        sectionFill = SOLID('#FBFAF6');
        childrenForSection = [
          rectangle(region.id, 'story-image', '花束故事照片', { x: 72, y: 104, width: 600, height: 660 }, { type: 'asset', assetId: flowerAssets.dahlias }),
          textNode('story-eyebrow', '眉题', 'ABOUT FLORA STUDIO', { x: 752, y: 132, width: 560, height: 24 }, 12, '#52614F', 700),
          textNode('story-title', '区域标题', '让花与心意，\n一起抵达。', { x: 748, y: 174, width: 590, height: 112 }, 38, textInk, 700),
          textNode('story-copy', '品牌故事', '花间从自然花园汲取灵感，关注花材本身的颜色、形态与季节变化。\n\n我们相信，花不必等待特别的日子；让喜欢的颜色留在身边，平常时刻也会变得明亮。', { x: 754, y: 314, width: 560, height: 124 }, 16, '#53655B'),
          rectangle(region.id, 'story-feature-one-mark', '新鲜花材标记', { x: 754, y: 504, width: 12, height: 12 }, SOLID('#8DA991'), 6),
          textNode('story-feature-one', '新鲜花材', '每日甄选当季花材，保留自然生长的色彩与层次。', { x: 782, y: 496, width: 510, height: 42 }, 15, '#405345'),
          rectangle(region.id, 'story-feature-two-mark', '手作设计标记', { x: 754, y: 574, width: 12, height: 12 }, SOLID('#D8A8A4'), 6),
          textNode('story-feature-two', '手作设计', '由花艺师细心搭配，让每一束都拥有自己的样子。', { x: 782, y: 566, width: 510, height: 42 }, 15, '#405345'),
          rectangle(region.id, 'story-feature-three-mark', '暖心送达标记', { x: 754, y: 644, width: 12, height: 12 }, SOLID('#D7C98D'), 6),
          textNode('story-feature-three', '暖心送达', '把喜欢的花送到身边，让每个日常都值得庆祝。', { x: 782, y: 636, width: 510, height: 42 }, 15, '#405345')
        ];
      } else {
        sectionFill = SOLID('#294434');
        childrenForSection = [
          textNode('cta-eyebrow', '眉题', 'BRING FLOWERS INTO YOUR DAY', { x: 160, y: 116, width: 1120, height: 22 }, 12, '#C7D4C2', 700, 'center'),
          textNode('cta-title', '区域标题', '从一束喜欢的花开始。', { x: 160, y: 162, width: 1120, height: 58 }, 36, '#FFFFFF', 700, 'center'),
          textNode('cta-copy', '区域说明', '看看本季花束，找到想带回家的那一束。', { x: 220, y: 236, width: 1000, height: 34 }, 16, '#E0E8DC', 400, 'center'),
          rectangle(region.id, 'cta-action', '主要按钮', { x: 594, y: 302, width: 252, height: 52 }, SOLID('#44634C'), 26),
          textNode('cta-action-label', '按钮文案', '浏览花束系列  →', { x: 620, y: 316, width: 200, height: 26 }, 14, '#FFFFFF', 700, 'center'),
          textNode('footer-brand', '页脚品牌', '花间 Flora Studio', { x: 96, y: 548, width: 340, height: 28 }, 18, '#FFFFFF', 700),
          textNode('footer-note', '页脚说明', '把自然花材与温柔心意，带进每一天。', { x: 96, y: 584, width: 560, height: 24 }, 13, '#D4E0D4'),
          textNode('footer-links', '页脚导航', '鲜花系列     花艺灵感     关于花间     联系我们', { x: 760, y: 566, width: 584, height: 24 }, 13, '#E5EEE6', 500, 'right')
        ];
      }
    } else {
      childrenForSection = [
        createTextNode(makeId(region.id, 'heading'), 'Heading', content.headline, { x: inset, y: 42, width: headingWidth, height: 68 }, { fontSize: index === 0 ? 40 : 30, color: '#20332B', weight: 700 }),
        createTextNode(makeId(region.id, 'body'), 'Body', content.description, { x: inset, y: 128, width: headingWidth, height: Math.max(64, sectionHeight - 168) }, { fontSize: 18, color: '#53655B', weight: 400 })
      ];
      if (index === 0) childrenForSection.push(rectangle(region.id, 'action', 'Primary action', { x: inset, y: sectionHeight - 74, width: Math.min(240, headingWidth), height: 48 }, SOLID(primaryColor), 12));
    }
    children.push({
      id: sectionId, type: 'frame', name: region.name, visible: true, locked: false,
      bounds: { x: 0, y, width, height: sectionHeight },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [sectionFill], strokes: [], effects: [], opacity: 1 },
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

function emptyQualityLoop(): QualityLoopState {
  return { stage: 'idle', quality: 'pending', reviewRound: 0, repairRound: 0, maxRepairRounds: 2, evidence: [], reports: [], proposals: [], diagnostics: [] };
}

function nextQualityReviewRound(loop: QualityLoopState): number {
  if (loop.stage === 'repairing') return Math.min(2, loop.reviewRound + 1);
  if (loop.stage === 'capturing' || loop.stage === 'reviewing') return loop.reviewRound;
  return 0;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function candidateRegionNodeIds(document: DesignDocument, regionId: string): string[] {
  const page = document.pages.find((item) => item.root.type === 'frame' && item.root.children.some((child) => child.id === `${regionId}_section`));
  if (!page || page.root.type !== 'frame') return [];
  const root = page.root.children.find((child) => child.id === `${regionId}_section`);
  if (!root) return [];
  const result: string[] = [];
  const stack: DesignNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node.id);
    if (node.type === 'frame') stack.push(...node.children);
  }
  return result;
}

function findDesignNode(document: DesignDocument, nodeId: string): DesignNode | undefined {
  for (const page of document.pages) {
    const stack: DesignNode[] = [page.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === nodeId) return node;
      if (node.type === 'frame') stack.push(...node.children);
    }
  }
  return undefined;
}

/**
 * S2 single-executor orchestration. Runs only return validated candidate snapshots;
 * the Main process/editor-core owns any explicit application to the live document.
 */
export class GenerationRunService {
  private readonly providers: GenerationRunServiceOptions['providers'];
  private readonly now: () => Date;
  private readonly idFactory: NonNullable<GenerationRunServiceOptions['idFactory']>;
  private readonly visualReviewer: VisualReviewProvider;
  private readonly repairProvider: RepairProposalProvider;
  private readonly fontsReady: boolean;
  private readonly persistEvent: GenerationRunServiceOptions['persistEvent'];
  private readonly persistCheckpoint: GenerationRunServiceOptions['persistCheckpoint'];
  private readonly persistEvidence: GenerationRunServiceOptions['persistEvidence'];
  private readonly renderAssetDataUrls: GenerationRunServiceOptions['renderAssetDataUrls'];
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<(event: GenerationEvent) => void>();

  constructor(options: GenerationRunServiceOptions) {
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID().replaceAll('-', '')}`);
    this.visualReviewer = options.visualReviewer ?? new RuleBasedVisualReviewer();
    this.repairProvider = options.repairProvider ?? new RuleBasedRepairProvider();
    this.fontsReady = options.fontsReady ?? false;
    this.persistEvent = options.persistEvent;
    this.persistCheckpoint = options.persistCheckpoint;
    this.persistEvidence = options.persistEvidence;
    this.renderAssetDataUrls = options.renderAssetDataUrls;
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

  start(requestInput: GenerationRequest, documentInput: DesignDocument, projectId?: string): GenerationRunSummary {
    const request = requestOrThrow(requestInput);
    const document = documentOrThrow(documentInput);
    assertRequestContext(request, document);
    if (projectId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(projectId)) throw new GenerationRunError('INVALID_REQUEST', 'Project ID is invalid', ['projectId']);
    if ([...this.runs.values()].some((record) => !terminal(record.summary.state))) {
      throw new GenerationRunError('RUN_ALREADY_ACTIVE', 'A generation Run is already active', undefined, true);
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
    const page = document.pages.find((item) => item.id === request.pageId)!;
    const sourceSubtreeHash = stableHash({ documentId: document.documentId, pageId: request.pageId, revision: document.revision, root: page.root });
    const collaboration = makeAgentRoster(plan, runId, attemptId, request.maxParallel);
    collaboration.tasks = plan.regions.map((region): AgentTask => ({
      taskId: region.id,
      attemptId,
      taskKind: 'generate',
      regionId: region.id,
      agentId: plan.ownershipMap.find((item) => item.regionId === region.id)!.agentId,
      namespace: region.id,
      state: 'queued',
      attempt: 1,
      round: 0,
      dependencies: plan.dependencies.filter((edge) => edge.to === region.id).map((edge) => edge.from),
      allowedNodeIds: [],
      issueIds: [],
      expectedSubtreeHash: sourceSubtreeHash
    }));
    const record: RunRecord = {
      summary, request, baseDocument: document, plan, controller: new AbortController(), events: [], fence: attemptId,
      collaboration, loop: emptyQualityLoop(), evidenceContent: new Map(), completedRegions: {},
      ...(projectId ? { projectId } : {}), persistenceChain: Promise.resolve()
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
      collaboration: clone(record.collaboration),
      loop: clone(record.loop),
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

  list(projectId?: string): GenerationRunSummary[] {
    return [...this.runs.values()].filter((record) => projectId === undefined || record.projectId === projectId).map((record) => clone(record.summary));
  }

  getEvidence(runId: string, evidenceId: string): ScreenshotEvidenceContent | undefined {
    const record = this.#getRecord(runId);
    const evidence = record.loop.evidence.find((item) => item.evidenceId === evidenceId);
    const previewSvg = record.evidenceContent.get(evidenceId);
    if (!evidence || !previewSvg || createHash('sha256').update(previewSvg).digest('hex') !== evidence.imageHash) return undefined;
    return { evidence: clone(evidence), previewSvg };
  }

  hydrateEvidence(runId: string, contentInput: ScreenshotEvidenceContent): void {
    const record = this.#getRecord(runId);
    const parsed = screenshotEvidenceContentSchema.safeParse(contentInput);
    if (!parsed.success || parsed.data.evidence.runId !== runId) throw new GenerationRunError('CANDIDATE_INVALID', 'Stored screenshot evidence does not match this run');
    const known = record.loop.evidence.find((item) => item.evidenceId === parsed.data.evidence.evidenceId);
    if (!known || known.imageHash !== parsed.data.evidence.imageHash) throw new GenerationRunError('CANDIDATE_INVALID', 'Stored screenshot evidence is not referenced by the run checkpoint');
    record.evidenceContent.set(parsed.data.evidence.evidenceId, parsed.data.previewSvg);
  }

  restore(checkpointInput: GenerationRunCheckpoint, eventInputs: readonly GenerationEvent[], baseDocumentInput: DesignDocument): GenerationRunSummary {
    const parsedCheckpoint = generationRunCheckpointSchema.safeParse(checkpointInput);
    if (!parsedCheckpoint.success) throw new GenerationRunError('CANDIDATE_INVALID', 'Stored generation checkpoint is invalid');
    const checkpoint = parsedCheckpoint.data;
    if (this.runs.has(checkpoint.runId)) return clone(this.#getRecord(checkpoint.runId).summary);
    const parsedEvents = eventInputs.map((event) => generationEventSchema.parse(event));
    if (parsedEvents.some((event, index) => event.runId !== checkpoint.runId || index === 0 && event.seq !== 1 || index > 0 && event.seq !== parsedEvents[index - 1]!.seq + 1)
      || checkpoint.eventSeq > (parsedEvents.at(-1)?.seq ?? 0)) {
      throw new GenerationRunError('CANDIDATE_INVALID', 'Stored generation event history is not contiguous for this run');
    }
    const document = documentOrThrow(baseDocumentInput);
    const plan = checkpoint.plan ?? checkpoint.candidate?.plan ?? this.plan(checkpoint.request, document);
    const candidate = checkpoint.candidate;
    const latestReport = checkpoint.loop.reports.at(-1);
    const reportEvidence = latestReport && checkpoint.loop.evidence.find((item) => item.evidenceId === latestReport.evidenceId);
    const candidateValidation = candidate ? validateDesignDocument(candidate.document) : undefined;
    const candidateMatchesCheckpoint = !!candidate && candidate.runId === checkpoint.runId && candidate.baseRevision === checkpoint.baseRevision
      && candidate.document.documentId === checkpoint.documentId && candidate.document.fileToken === document.fileToken
      && candidate.document.revision === checkpoint.baseRevision && candidate.plan && stableHash(candidate.plan) === stableHash(plan)
      && stableHash(candidate.document.assets) === stableHash(document.assets) && !!candidateValidation?.success;
    const reportMatchesCheckpoint = !!latestReport && latestReport.runId === checkpoint.runId && latestReport.attemptId === checkpoint.attemptId
      && latestReport.reviewRound === checkpoint.loop.reviewRound && latestReport.candidateRevision === checkpoint.loop.repairRound
      && latestReport.revision === checkpoint.baseRevision && !!reportEvidence && reportEvidence.runId === checkpoint.runId
      && reportEvidence.attemptId === checkpoint.attemptId && reportEvidence.candidateRevision === latestReport.candidateRevision
      && reportEvidence.reviewRound === latestReport.reviewRound;
    const unresolvedIssues = latestReport?.issues.filter((issue) => issue.status !== 'resolved') ?? [];
    const unresolvedWarningIds = unresolvedIssues.filter((issue) => issue.severity === 'warning').map((issue) => issue.issueId).sort();
    const validPassedCheckpoint = checkpoint.loop.stage === 'completed' && checkpoint.loop.quality === 'passed'
      && latestReport?.decision === 'pass' && latestReport.structurePassed
      && unresolvedIssues.every((issue) => issue.severity === 'info') && reportMatchesCheckpoint;
    const accepted = checkpoint.loop.warningAcceptance;
    const acceptedEvent = accepted && parsedEvents.find((event) => event.type === 'warningsAccepted' && event.runId === checkpoint.runId
      && event.attemptId === checkpoint.attemptId && event.payload['reportId'] === accepted.reportId
      && event.payload['evidenceId'] === accepted.evidenceId && event.payload['reason'] === accepted.reason);
    const eventWarningIds = acceptedEvent?.payload['issueIds'];
    const eventWarningIdsMatch = Array.isArray(eventWarningIds) && eventWarningIds.every((issueId): issueId is string => typeof issueId === 'string')
      && [...eventWarningIds].sort().join('|') === accepted?.issueIds.slice().sort().join('|');
    const validAcceptedWarningsCheckpoint = checkpoint.loop.stage === 'completed' && checkpoint.loop.quality === 'accepted_warnings'
      && !!accepted && accepted.reason.trim().length > 0 && latestReport?.reportId === accepted.reportId
      && latestReport.evidenceId === accepted.evidenceId && latestReport.decision === 'needs_review' && latestReport.structurePassed
      && !unresolvedIssues.some((issue) => issue.severity === 'blocker') && unresolvedWarningIds.length > 0
      && accepted.issueIds.slice().sort().join('|') === unresolvedWarningIds.join('|')
      && reportMatchesCheckpoint && !!acceptedEvent && eventWarningIdsMatch;
    const validCompletedCheckpoint = checkpoint.phase === 'completed' && candidateMatchesCheckpoint
      && (validPassedCheckpoint || validAcceptedWarningsCheckpoint);
    const phaseIsTerminal = ['completed', 'cancelled', 'failed', 'needs_review'].includes(checkpoint.phase);
    const postCheckpointEvents = parsedEvents.filter((event) => event.seq > checkpoint.eventSeq);
    const terminalTail = [...postCheckpointEvents].reverse().find((event) => event.type === 'stateChanged'
      && ['completed', 'cancelled', 'failed', 'needs_review', 'conflict', 'interrupted'].includes(String(event.payload['to'])));
    const terminalTailPhase = terminalTail?.payload['to'];
    const interruptedTail = !!terminalTail && terminalTail.attemptId === checkpoint.attemptId && terminalTailPhase === 'interrupted' && !phaseIsTerminal;
    const terminalTailDiverges = !!terminalTail && (terminalTail.attemptId !== checkpoint.attemptId
      || !phaseIsTerminal && !interruptedTail
      || terminalTailPhase !== checkpoint.phase && !interruptedTail && !(checkpoint.phase === 'needs_review' && terminalTailPhase === 'conflict'));
    const recoveryFailure = checkpoint.phase === 'completed' && !validCompletedCheckpoint || terminalTailDiverges
      || postCheckpointEvents.some((event) => event.attemptId !== checkpoint.attemptId);
    const recoveryFailureMessage = checkpoint.phase === 'completed' && !validCompletedCheckpoint
      ? 'The completed checkpoint does not contain an eligible candidate and matching review evidence'
      : 'The event log contains state newer than the recoverable checkpoint';
    const needsInterrupt = !recoveryFailure && !interruptedTail && !phaseIsTerminal && checkpoint.phase !== 'interrupted';
    const state: GenerationRunState = recoveryFailure ? 'failed' : needsInterrupt || interruptedTail ? 'interrupted' : checkpoint.phase as GenerationRunState;
    const loop = clone(checkpoint.loop);
    if (recoveryFailure) {
      loop.stage = 'blocked';
      loop.quality = 'blocked';
      loop.diagnostics.push(`Run recovery failed closed: ${recoveryFailureMessage}`.slice(0, 512));
    }
    const summary: GenerationRunSummary = {
      runId: checkpoint.runId,
      attemptId: checkpoint.attemptId,
      state,
      baseRevision: checkpoint.baseRevision,
      eventSeq: Math.max(checkpoint.eventSeq, parsedEvents.at(-1)?.seq ?? 0),
      startedAt: parsedEvents[0]?.timestamp ?? checkpoint.updatedAt,
      ...(phaseIsTerminal || state === 'interrupted' || recoveryFailure ? { completedAt: checkpoint.updatedAt } : {}),
      candidateAvailable: state === 'completed' && validCompletedCheckpoint,
      ...(recoveryFailure ? { error: { code: 'RUN_RECOVERY_FAILED', message: recoveryFailureMessage.slice(0, 512), retryable: false } } : {})
    };
    const collaboration = clone(checkpoint.collaboration);
    collaboration.runId = checkpoint.runId;
    collaboration.attemptId = checkpoint.attemptId;
    collaboration.activeCount = 0;
    collaboration.queuedCount = 0;
    for (const task of collaboration.tasks) {
      if (task.state === 'running') {
        task.state = 'stale';
        delete task.leaseId;
      }
      if (task.state === 'queued' || task.state === 'stale') collaboration.queuedCount++;
    }
    for (const agent of collaboration.agents) {
      delete agent.activeTaskId;
      const tasks = collaboration.tasks.filter((task) => task.agentId === agent.agentId);
      agent.state = tasks.some((task) => task.state === 'running') ? 'running'
        : tasks.some((task) => task.state === 'queued' || task.state === 'stale') ? 'queued'
          : tasks.some((task) => task.state === 'failed' || task.state === 'blocked') ? 'failed'
            : tasks.length && tasks.every((task) => task.state === 'cancelled') ? 'cancelled'
              : tasks.length ? 'completed' : 'idle';
    }
    collaboration.coordinator.state = state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'reviewing';
    const record: RunRecord = {
      summary, request: clone(checkpoint.request), baseDocument: document, plan: clone(plan), controller: new AbortController(),
      events: parsedEvents.map((event) => clone(event)), ...(checkpoint.candidate && !recoveryFailure ? { candidate: clone(checkpoint.candidate) } : {}),
      fence: checkpoint.attemptId, collaboration, loop, evidenceContent: new Map(),
      projectId: checkpoint.projectId, completedRegions: clone(checkpoint.completedRegions),
      ...(needsInterrupt || recoveryFailure ? { loopResumeRound: nextQualityReviewRound(checkpoint.loop) } : {}),
      checkpoint: { ...clone(checkpoint), phase: recoveryFailure ? 'failed' : needsInterrupt || interruptedTail ? 'interrupted' : checkpoint.phase }, persistenceChain: Promise.resolve()
    };
    this.runs.set(checkpoint.runId, record);
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const oldestTerminal = [...this.runs.entries()].find(([, item]) => terminal(item.summary.state));
      if (!oldestTerminal) break;
      this.runs.delete(oldestTerminal[0]);
    }
    if (needsInterrupt) {
      record.summary.state = 'interrupted';
      this.#appendEvent(record, 'runInterrupted', { previousPhase: checkpoint.phase, reason: 'The application closed before this attempt reached a terminal state' });
      this.#appendEvent(record, 'stateChanged', { from: checkpoint.phase, to: 'interrupted' });
      this.#scheduleCheckpoint(record);
    } else if (recoveryFailure) {
      this.#scheduleCheckpoint(record);
      this.#appendEvent(record, 'error', { code: 'RUN_RECOVERY_FAILED', message: recoveryFailureMessage, retryable: false });
    } else if (interruptedTail) {
      this.#scheduleCheckpoint(record);
    }
    return clone(summary);
  }

  async resume(runId: string, expectedAttemptId: string, currentDocumentInput: DesignDocument, projectId: string): Promise<GenerationRunSummary> {
    const record = this.#getRecord(runId);
    if (record.projectId !== projectId) throw new GenerationRunError('RUN_NOT_FOUND', `Generation run ${runId} was not found for this project`, ['runId']);
    if (record.summary.attemptId !== expectedAttemptId) throw new GenerationRunError('STALE_ATTEMPT', 'This run changed after it was selected; refresh the run list before resuming');
    if (record.summary.state !== 'interrupted' || !record.checkpoint) throw new GenerationRunError('RUN_NOT_RESUMABLE', 'Only an interrupted run with a durable checkpoint can be resumed');
    if ([...this.runs.entries()].some(([otherRunId, other]) => otherRunId !== runId && !terminal(other.summary.state))) {
      throw new GenerationRunError('RUN_ALREADY_ACTIVE', 'Another generation Run is already active', undefined, true);
    }
    const checkpoint = record.checkpoint;
    const currentDocument = documentOrThrow(currentDocumentInput);
    const provider = this.providers[checkpoint.request.providerRef];
    if (currentDocument.documentId !== checkpoint.documentId || currentDocument.revision !== checkpoint.baseRevision
      || stableHash(currentDocument) !== checkpoint.baseDocumentHash || stableHash(currentDocument.variables) !== checkpoint.tokenVersion
      || !provider || provider.name !== checkpoint.providerVersion) {
      throw new GenerationRunError('RESUME_CONTEXT_MISMATCH', 'The document, revision, design tokens, or provider changed since this run was checkpointed; start a new run instead');
    }
    const attemptId = this.#makeId('attempt');
    const previousAttemptId = record.summary.attemptId;
    record.request = clone(checkpoint.request);
    record.baseDocument = currentDocument;
    record.plan = clone(checkpoint.plan ?? checkpoint.candidate?.plan ?? this.plan(checkpoint.request, currentDocument));
    record.completedRegions = clone(checkpoint.completedRegions);
    if (checkpoint.candidate) record.candidate = clone(checkpoint.candidate);
    else delete record.candidate;
    record.loop = clone(checkpoint.loop);
    record.loop.stage = 'capturing';
    record.loopResumeRound = nextQualityReviewRound(checkpoint.loop);
    record.controller = new AbortController();
    record.fence = attemptId;
    record.summary.attemptId = attemptId;
    record.summary.state = 'queued';
    record.summary.startedAt = this.#timestamp();
    record.summary.candidateAvailable = false;
    delete record.summary.completedAt;
    delete record.summary.error;
    record.persistenceError = undefined;
    record.collaboration = clone(checkpoint.collaboration);
    record.collaboration.attemptId = attemptId;
    record.collaboration.activeCount = 0;
    record.collaboration.coordinator.state = 'planning';
    record.collaboration.queuedCount = 0;
    for (const task of record.collaboration.tasks) {
      task.attemptId = attemptId;
      delete task.leaseId;
      if (task.state !== 'completed') {
        task.state = 'queued';
        task.attempt++;
        delete task.startedAt;
        delete task.completedAt;
        delete task.error;
        delete task.candidateHash;
        record.collaboration.queuedCount++;
      }
    }
    for (const agent of record.collaboration.agents) {
      delete agent.activeTaskId;
      agent.state = record.collaboration.tasks.some((task) => task.agentId === agent.agentId && task.state === 'queued') ? 'queued' : 'completed';
    }
    this.#appendEvent(record, 'runResumed', { previousAttemptId, resumedAttemptId: attemptId, completedRegions: Object.keys(record.completedRegions).length });
    this.#appendEvent(record, 'stateChanged', { from: 'interrupted', to: 'queued' });
    this.#scheduleCheckpoint(record);
    try { await this.#flushPersistence(record); }
    catch (error) {
      this.#fail(record, error, 'RESUME_PERSISTENCE_FAILED');
      throw error;
    }
    const fence = record.fence;
    if (this.#isCurrent(record, fence)) {
      void Promise.resolve().then(() => this.#execute(record, fence)).catch((error: unknown) => {
        if (this.#isCurrent(record, fence)) this.#fail(record, error, 'RESUME_ERROR');
      });
    }
    return clone(record.summary);
  }

  async acceptWarnings(runId: string, expectedAttemptId: string, projectId: string, reasonInput: string): Promise<GenerationRunSummary> {
    const record = this.#getRecord(runId);
    if (record.projectId !== projectId) throw new GenerationRunError('RUN_NOT_FOUND', `Generation run ${runId} was not found for this project`, ['runId']);
    if (record.summary.attemptId !== expectedAttemptId) throw new GenerationRunError('STALE_ATTEMPT', 'This run changed after it was selected; refresh the run list before accepting warnings');
    if (record.summary.state !== 'needs_review' || record.loop.stage !== 'needs_review' || !record.candidate) {
      throw new GenerationRunError('WARNINGS_NOT_ACCEPTABLE', 'Only a reviewable candidate waiting for human inspection can accept warnings');
    }
    const report = record.loop.reports.at(-1);
    if (!report || report.runId !== runId || report.attemptId !== expectedAttemptId || !report.structurePassed) {
      throw new GenerationRunError('WARNINGS_NOT_ACCEPTABLE', 'The latest review report is missing, stale, or structurally invalid');
    }
    const unresolved = report.issues.filter((issue) => issue.status !== 'resolved');
    const warnings = unresolved.filter((issue) => issue.severity === 'warning');
    if (unresolved.some((issue) => issue.severity === 'blocker') || !warnings.length || report.decision === 'blocked') {
      throw new GenerationRunError('WARNINGS_NOT_ACCEPTABLE', 'Blockers cannot be accepted and at least one non-blocking warning must remain');
    }
    const evidence = record.loop.evidence.find((item) => item.evidenceId === report.evidenceId);
    const evidenceSvg = record.evidenceContent.get(report.evidenceId);
    if (!evidence || !evidenceSvg || evidence.runId !== runId || evidence.attemptId !== expectedAttemptId
      || createHash('sha256').update(evidenceSvg).digest('hex') !== evidence.imageHash) {
      throw new GenerationRunError('EVIDENCE_UNAVAILABLE', 'The latest review screenshot is unavailable or does not match its evidence hash');
    }
    const reason = reasonInput.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
    if (!reason) throw new GenerationRunError('INVALID_REQUEST', 'Provide a short reason before accepting warnings', ['reason']);

    record.loop.warningAcceptance = {
      reportId: report.reportId,
      evidenceId: report.evidenceId,
      issueIds: warnings.map((issue) => issue.issueId),
      reason,
      acceptedAt: this.#timestamp()
    };
    record.loop.quality = 'accepted_warnings';
    record.loop.stage = 'completed';
    record.collaboration.coordinator.state = 'completed';
    record.summary.candidateAvailable = true;
    this.#appendEvent(record, 'warningsAccepted', {
      reportId: report.reportId,
      evidenceId: report.evidenceId,
      issueIds: warnings.map((issue) => issue.issueId),
      reason
    });
    this.#transition(record, 'completed');
    try { await this.#flushPersistence(record); }
    catch (error) {
      if (record.checkpoint?.phase === 'completed' && record.checkpoint.attemptId === expectedAttemptId) return clone(record.summary);
      this.#markTerminalPersistenceFailure(record, error);
      throw error;
    }
    return clone(record.summary);
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
      await this.#flushPersistence(record);
      if (!this.#isCurrent(record, fence)) return;
      for (const region of record.plan.regions) this.#appendEvent(record, 'regionPlanned', this.#regionPayload(region));
      const provider = this.providers[record.request.providerRef];
      if (!provider) throw new GenerationRunError('PROVIDER_UNAVAILABLE', `Provider ${record.request.providerRef} is not configured`, ['providerRef'], false);
      let checkedCandidate: ReturnType<typeof generationCandidateSchema.safeParse>;
      if (record.candidate) {
        this.#transition(record, 'assembling');
        record.collaboration.coordinator.state = 'assembling';
        checkedCandidate = generationCandidateSchema.safeParse(record.candidate);
        if (checkedCandidate.success) {
          const checkpointCandidate = checkedCandidate.data;
          const candidateDocument = checkpointCandidate.document;
          const candidateValidation = validateDesignDocument(candidateDocument);
          if (checkpointCandidate.runId !== record.summary.runId || checkpointCandidate.baseRevision !== record.request.baseRevision
            || candidateDocument.documentId !== record.baseDocument.documentId || candidateDocument.fileToken !== record.baseDocument.fileToken
            || candidateDocument.revision !== record.request.baseRevision || stableHash(checkpointCandidate.plan) !== stableHash(record.plan)
            || stableHash(candidateDocument.assets) !== stableHash(record.baseDocument.assets) || !candidateValidation.success) {
            throw new GenerationRunError('CANDIDATE_INVALID', 'Checkpoint candidate does not match the validated Run, base document, plan, or local assets');
          }
        }
        this.#transition(record, 'validating');
      } else {
        this.#transition(record, 'designing');
        record.collaboration.coordinator.state = 'delegating';
        const contentByRegion = new Map<string, RegionContent>(Object.entries(record.completedRegions).map(([regionId, content]) => [regionId, clone(content)]));
        const pendingRegions = record.plan.regions.filter((region) => !contentByRegion.has(region.id));
        const scheduled = await runDagScheduler({
          tasks: pendingRegions.map((region) => ({
            taskId: region.id,
            order: region.order,
            dependencies: record.plan.dependencies.filter((edge) => edge.to === region.id && !contentByRegion.has(edge.from)).map((edge) => edge.from),
            input: region
          })),
          maxParallel: record.request.maxParallel,
          runId: record.summary.runId,
          attemptId: record.summary.attemptId,
          signal: record.controller.signal,
          worker: async (task, lease) => {
            const region = task.input;
            if (!lease.isCurrent()) throw new Error('Agent task lease is no longer current');
            this.#appendEvent(record, 'regionStarted', this.#regionPayload(region));
            const output = await provider.generateFrame(this.#providerInput(record.request, region), { signal: record.controller.signal });
            if (!lease.isCurrent() || !this.#isCurrent(record, fence)) throw new Error('Agent result was fenced before it could be recorded');
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
            record.completedRegions[region.id] = clone(parsedOutput.data);
            this.#appendEvent(record, 'regionDraft', { regionId: region.id, headline: parsedOutput.data.headline, description: parsedOutput.data.description });
            return parsedOutput.data;
          },
          onTaskEvent: (event) => this.#onAgentTaskEvent(record, event)
        });

        if (!this.#isCurrent(record, fence)) return;
        const unsuccessful = scheduled.tasks.find((task) => task.state !== 'completed');
        if (unsuccessful) {
          const error = unsuccessful.error ?? { code: 'AGENT_TASK_BLOCKED', message: 'A region task did not complete', retryable: false };
          throw new RegionRunFailure(unsuccessful.task.taskId, error);
        }
        if (record.plan.regions.some((region) => !contentByRegion.has(region.id))) throw new GenerationRunError('CANDIDATE_INVALID', 'A planned region has no recoverable generated content');
        this.#transition(record, 'assembling');
        record.collaboration.coordinator.state = 'assembling';
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
        const renderAssets = record.projectId && this.renderAssetDataUrls ? await this.renderAssetDataUrls(record.projectId, validation.data) : {};
        const rendered = renderDocumentScreenshot(validation.data, record.request.pageId, 1, 4096, undefined, renderAssets);
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
        checkedCandidate = generationCandidateSchema.safeParse(rawCandidate);
      }
      if (!checkedCandidate.success) {
        const issue = validationMessage(checkedCandidate.error.issues);
        this.#appendEvent(record, 'validationReported', {
          valid: false, scope: 'candidate', code: 'CANDIDATE_SCHEMA_INVALID', path: issue.path, message: issue.message
        });
        throw new GenerationRunError('CANDIDATE_INVALID', `Candidate is invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
      }
      if (!this.#isCurrent(record, fence)) return;
      record.candidate = checkedCandidate.data;
      for (const task of record.collaboration.tasks) {
        if (task.state !== 'completed') continue;
        const regionNodes = candidateRegionNodeIds(checkedCandidate.data.document, task.regionId);
        task.allowedNodeIds = regionNodes;
        task.candidateHash = stableHash(regionNodes.map((nodeId) => findDesignNode(checkedCandidate.data.document, nodeId)));
        this.#appendEvent(record, 'agentCandidateReady', { taskId: task.taskId, regionId: task.regionId, agentId: task.agentId, candidateHash: task.candidateHash, nodeIds: regionNodes });
      }
      record.collaboration.coordinator.state = 'reviewing';
      this.#transition(record, 'reviewing');
      const reviewAssetDataUrls = record.projectId && this.renderAssetDataUrls
        ? await this.renderAssetDataUrls(record.projectId, checkedCandidate.data.document)
        : {};
      const review = await runQualityLoop({
        runId: record.summary.runId,
        attemptId: record.summary.attemptId,
        request: record.request,
        plan: record.plan,
        candidateDocument: checkedCandidate.data.document,
        assetDataUrls: reviewAssetDataUrls,
        visualReviewer: this.visualReviewer,
        repairProvider: this.repairProvider,
        maxParallel: record.request.maxParallel,
        fontsReady: this.fontsReady,
        signal: record.controller.signal,
        initialState: record.loop,
        ...(record.loopResumeRound !== undefined ? { startReviewRound: record.loopResumeRound } : {}),
        onEvent: (type, payload) => {
          if (!this.#isCurrent(record, fence)) return;
          if (type === 'reviewStarted') {
            record.collaboration.coordinator.state = 'reviewing';
            if (record.summary.state !== 'reviewing') this.#transition(record, 'reviewing');
          } else if (type === 'repairDelegated') {
            record.collaboration.coordinator.state = 'reviewing';
            if (record.summary.state !== 'repairing') this.#transition(record, 'repairing');
          }
          this.#appendEvent(record, type, payload);
        },
        onEvidence: async (evidence, previewSvg) => {
          if (!this.#isCurrent(record, fence)) throw new Error('Run attempt was fenced before evidence could be stored');
          if (record.projectId && this.persistEvidence) await this.persistEvidence(record.projectId, { evidence, previewSvg });
          record.evidenceContent.set(evidence.evidenceId, previewSvg);
        },
        onCheckpoint: async (snapshot) => {
          if (!this.#isCurrent(record, fence)) throw new Error('Run attempt was fenced before the visual checkpoint could be stored');
          const candidateSnapshot = generationCandidateSchema.safeParse({
            ...(record.candidate ?? {}), document: snapshot.document, previewSvg: snapshot.previewSvg
          });
          if (!candidateSnapshot.success) {
            const issue = validationMessage(candidateSnapshot.error.issues);
            throw new GenerationRunError('CANDIDATE_INVALID', `Visual checkpoint candidate is invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
          }
          record.candidate = candidateSnapshot.data;
          record.loop = clone(snapshot.state);
          await this.#saveCheckpoint(record);
        },
        now: this.now
      });
      if (!this.#isCurrent(record, fence)) return;
      record.loop = review.state;
      delete record.loopResumeRound;
      record.collaboration.coordinator.state = review.state.quality === 'passed' ? 'completed' : 'reviewing';
      const reviewedCandidate = generationCandidateSchema.safeParse({ ...checkedCandidate.data, document: review.document, previewSvg: review.previewSvg || checkedCandidate.data.previewSvg });
      if (!reviewedCandidate.success) {
        const issue = validationMessage(reviewedCandidate.error.issues);
        throw new GenerationRunError('CANDIDATE_INVALID', `Reviewed candidate is invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
      }
      record.candidate = reviewedCandidate.data;
      const passed = review.state.quality === 'passed';
      record.summary.candidateAvailable = passed;
      this.#appendEvent(record, 'validationReported', { valid: true, scope: 'candidate-document', documentRevision: record.request.baseRevision, regionCount: record.plan.regions.length, visualQuality: review.state.quality });
      this.#appendEvent(record, 'candidateReady', {
        candidateId: reviewedCandidate.data.candidateId,
        baseRevision: reviewedCandidate.data.baseRevision,
        regionIds: record.plan.regions.map((region) => region.id),
        documentRevision: reviewedCandidate.data.document.revision,
        applyEligible: passed,
        quality: review.state.quality
      });
      if (!this.#isCurrent(record, fence)) return;
      this.#transition(record, passed ? 'completed' : 'needs_review');
      await this.#flushPersistence(record);
    } catch (error) {
      if (this.runs.get(record.summary.runId) !== record || record.fence !== fence || record.summary.attemptId !== fence) return;
      if (terminal(record.summary.state)) {
        const durableTerminal = record.checkpoint?.phase === record.summary.state && record.checkpoint.attemptId === fence;
        if (record.persistenceError && !durableTerminal && (record.summary.state === 'completed' || record.summary.state === 'needs_review')) this.#markTerminalPersistenceFailure(record, error);
        return;
      }
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

  #onAgentTaskEvent(record: RunRecord, event: DagTaskEvent): void {
    if (event.runId !== record.summary.runId || event.attemptId !== record.summary.attemptId) return;
    const task = record.collaboration.tasks.find((item) => item.taskId === event.taskId);
    if (!task) return;
    if (event.state === 'queued') return;
    if (event.state === 'running') {
      task.state = 'running';
      task.leaseId = event.leaseId;
      task.startedAt ??= this.#timestamp();
      record.collaboration.activeCount++;
      record.collaboration.queuedCount = Math.max(0, record.collaboration.queuedCount - 1);
    } else {
      if (task.state === 'running') record.collaboration.activeCount = Math.max(0, record.collaboration.activeCount - 1);
      else if (task.state === 'queued') record.collaboration.queuedCount = Math.max(0, record.collaboration.queuedCount - 1);
      const firstTerminal = task.state === 'queued' || task.state === 'running';
      task.state = event.state;
      task.leaseId = event.leaseId ?? task.leaseId;
      task.completedAt = this.#timestamp();
      if (event.error) task.error = { ...event.error };
      const agent = record.collaboration.agents.find((item) => item.agentId === task.agentId);
      if (agent && firstTerminal) {
        if (event.state === 'completed') agent.completedTasks++;
        else if (event.state === 'failed' || event.state === 'blocked') agent.failedTasks++;
      }
    }
    const ownerTasks = record.collaboration.tasks.filter((item) => item.agentId === task.agentId);
    const agent = record.collaboration.agents.find((item) => item.agentId === task.agentId);
    if (agent) {
      const running = ownerTasks.find((item) => item.state === 'running');
      delete agent.activeTaskId;
      if (running) {
        agent.state = 'running';
        agent.activeTaskId = running.taskId;
      } else if (ownerTasks.some((item) => item.state === 'queued')) agent.state = 'queued';
      else if (ownerTasks.some((item) => item.state === 'failed' || item.state === 'blocked')) agent.state = 'failed';
      else if (ownerTasks.length && ownerTasks.every((item) => item.state === 'cancelled')) agent.state = 'cancelled';
      else if (ownerTasks.length && ownerTasks.every((item) => item.state === 'completed')) agent.state = 'completed';
      else agent.state = 'idle';
    }
    if (event.state === 'running') this.#appendEvent(record, 'agentStarted', { taskId: task.taskId, regionId: task.regionId, agentId: task.agentId, leaseId: event.leaseId });
    else if (event.state === 'failed' || event.state === 'blocked') this.#appendEvent(record, 'agentFailed', { taskId: task.taskId, regionId: task.regionId, agentId: task.agentId, state: event.state, error: event.error });
    if (event.state === 'completed' || event.state === 'failed' || event.state === 'blocked' || event.state === 'cancelled' || event.state === 'stale') this.#scheduleCheckpoint(record);
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
    if (record.projectId && this.persistEvent) this.#queuePersistence(record, () => this.persistEvent!(record.projectId!, clone(event)));
    for (const listener of [...this.listeners]) {
      try { listener(clone(event)); } catch { /* A UI subscriber cannot fail the generation run. */ }
    }
  }

  #transition(record: RunRecord, state: GenerationRunState): void {
    const previous = record.summary.state;
    if (terminal(previous) && !(previous === 'needs_review' && state === 'completed')) return;
    record.summary.state = state;
    if (terminal(state)) record.summary.completedAt = this.#timestamp();
    if (terminal(state)) {
      this.#scheduleCheckpoint(record);
      this.#appendEvent(record, 'stateChanged', { from: previous, to: state });
    } else {
      this.#appendEvent(record, 'stateChanged', { from: previous, to: state });
      this.#scheduleCheckpoint(record);
    }
  }

  #queuePersistence(record: RunRecord, operation: () => Promise<unknown>): void {
    const next = record.persistenceChain.then(async () => {
      if (record.persistenceError) return;
      await operation();
    }).catch((error: unknown) => {
      record.persistenceError ??= error;
    });
    record.persistenceChain = next;
  }

  #scheduleCheckpoint(record: RunRecord): void {
    if (!record.projectId || !this.persistCheckpoint) return;
    const checkpointId = `cp_${randomUUID().replaceAll('-', '')}`;
    record.loop.checkpointId = checkpointId;
    const provider = this.providers[record.request.providerRef];
    const phase = record.summary.state === 'conflict' ? 'needs_review' : record.summary.state;
    const parsed = generationRunCheckpointSchema.safeParse({
      formatVersion: 1,
      projectId: record.projectId,
      documentId: record.request.documentId,
      runId: record.summary.runId,
      attemptId: record.summary.attemptId,
      request: clone(record.request),
      baseRevision: record.request.baseRevision,
      baseDocumentHash: stableHash(record.baseDocument),
      tokenVersion: stableHash(record.baseDocument.variables),
      providerVersion: provider?.name ?? record.request.providerRef,
      plan: clone(record.plan),
      phase,
      collaboration: clone(record.collaboration),
      loop: clone(record.loop),
      completedRegions: clone(record.completedRegions),
      ...(record.candidate ? { candidate: clone(record.candidate) } : {}),
      eventSeq: record.summary.eventSeq,
      updatedAt: this.#timestamp()
    });
    if (!parsed.success) {
      const issue = validationMessage(parsed.error.issues);
      record.persistenceError ??= new GenerationRunError('CANDIDATE_INVALID', `Run checkpoint invalid at ${issue.path.join('.') || '<root>'}: ${issue.message}`, issue.path);
      return;
    }
    const checkpoint = parsed.data;
    const next = record.persistenceChain.then(async () => {
      if (record.persistenceError) throw record.persistenceError;
      await this.persistCheckpoint!(checkpoint);
      if (record.summary.attemptId === checkpoint.attemptId && record.loop.checkpointId === checkpointId) {
        record.checkpoint = checkpoint;
        this.#appendEvent(record, 'checkpointSaved', { checkpointId, phase, eventSeq: checkpoint.eventSeq });
      }
    });
    record.persistenceChain = next.catch((error: unknown) => {
      record.persistenceError ??= error;
    });
  }

  async #saveCheckpoint(record: RunRecord): Promise<void> {
    this.#scheduleCheckpoint(record);
    await this.#flushPersistence(record);
  }

  async #flushPersistence(record: RunRecord): Promise<void> {
    while (true) {
      const pending = record.persistenceChain;
      await pending;
      if (pending === record.persistenceChain) break;
    }
    if (record.persistenceError) throw record.persistenceError;
  }

  #fail(record: RunRecord, error: unknown, fallbackCode: string): void {
    if (terminal(record.summary.state)) return;
    const typed = error instanceof GenerationRunError ? error : undefined;
    const suppliedCode = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    const code = fallbackCode !== 'RUN_ERROR' && /^[A-Z0-9_]{1,64}$/.test(fallbackCode)
      ? fallbackCode
      : typed?.code ?? (typeof suppliedCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(suppliedCode) ? suppliedCode : 'RUN_ERROR');
    const message = safeMessage(error, 'Generation failed');
    record.summary.error = { code, message, retryable: typed?.retryable ?? false };
    delete record.candidate;
    record.summary.candidateAvailable = false;
    if (!record.events.some((event) => event.type === 'error' && event.payload['code'] === code)) {
      this.#appendEvent(record, 'error', { code, message, retryable: record.summary.error.retryable, ...(typed?.path ? { path: [...typed.path] } : {}) });
    }
    this.#transition(record, 'failed');
  }

  #markTerminalPersistenceFailure(record: RunRecord, error: unknown): void {
    const previous = record.summary.state;
    const typedCode = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
    const code = typeof typedCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(typedCode) ? typedCode : 'PERSISTENCE_FAILED';
    const message = safeMessage(error, 'The Run could not be saved durably');
    record.summary.state = 'failed';
    record.summary.candidateAvailable = false;
    record.summary.error = { code, message, retryable: false };
    delete record.candidate;
    record.collaboration.coordinator.state = 'failed';
    record.loop.stage = 'blocked';
    record.loop.quality = 'blocked';
    record.loop.diagnostics.push(`Run completion was not acknowledged by durable storage: ${message}`.slice(0, 512));
    this.#appendEvent(record, 'error', { code, message, retryable: false });
    this.#appendEvent(record, 'stateChanged', { from: previous, to: 'failed' });
  }
}

class RegionRunFailure extends Error {
  constructor(readonly regionId: string, readonly original: unknown) {
    super(`Region ${regionId} failed`);
    this.name = 'RegionRunFailure';
  }
}
