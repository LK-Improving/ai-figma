import { z } from 'zod';

export const NODE_TYPES = ['frame', 'rectangle', 'ellipse', 'icon', 'text'] as const;
export const nodeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/);
export const documentIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const positive = z.number().finite().positive().max(100_000);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const boundsSchema = z.object({ x: coordinate, y: coordinate, width: positive.max(32_768), height: positive.max(32_768) }).strict();
const transformSchema = z.object({ rotation: coordinate, scaleX: positive, scaleY: positive }).strict();
const variableRefSchema = z.object({ kind: z.literal('variable'), id: nodeIdSchema, fallback: z.union([z.string(), z.number()]) }).strict();
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const fillSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: z.union([colorSchema, variableRefSchema]) }).strict(),
  z.object({ type: z.literal('asset'), assetId: nodeIdSchema }).strict()
]);
const strokeSchema = z.object({ color: colorSchema, width: z.number().finite().nonnegative(), align: z.enum(['inside', 'center', 'outside']) }).strict();
const effectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shadow'), x: coordinate, y: coordinate, blur: z.number().finite().nonnegative(), color: colorSchema }).strict(),
  z.object({ type: z.literal('blur'), radius: z.number().finite().nonnegative() }).strict()
]);
const styleSchema = z.object({ fills: z.array(fillSchema).max(32), strokes: z.array(strokeSchema).max(16), effects: z.array(effectSchema).max(16), opacity: z.number().finite().min(0).max(1) }).strict();
export const prototypeInteractionSchema = z.discriminatedUnion('action', [
  z.object({ trigger: z.literal('click'), action: z.literal('navigate'), targetPageId: nodeIdSchema }).strict(),
  z.object({ trigger: z.literal('click'), action: z.literal('openModal'), targetNodeId: nodeIdSchema }).strict(),
  z.object({ trigger: z.literal('click'), action: z.literal('toggle'), targetNodeId: nodeIdSchema }).strict(),
  z.object({ trigger: z.literal('click'), action: z.literal('submitMock'), successMessage: z.string().min(1).max(256) }).strict()
]);
export type PrototypeInteraction = z.infer<typeof prototypeInteractionSchema>;
type NodeStyle = z.infer<typeof styleSchema>;
type NodeBounds = z.infer<typeof boundsSchema>;
type NodeTransform = z.infer<typeof transformSchema>;
const baseNodeShape = {
  id: nodeIdSchema,
  type: z.enum(NODE_TYPES),
  name: z.string().min(1).max(128),
  visible: z.boolean(),
  locked: z.boolean(),
  bounds: boundsSchema,
  transform: transformSchema,
  style: styleSchema,
  interaction: prototypeInteractionSchema.optional()
};
const layoutSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('absolute') }).strict(),
  z.object({ mode: z.literal('flow'), direction: z.enum(['row', 'column']), gap: z.number().finite().nonnegative(), padding: z.object({ top: z.number().nonnegative(), right: z.number().nonnegative(), bottom: z.number().nonnegative(), left: z.number().nonnegative() }).strict(), align: z.enum(['start', 'center', 'end', 'stretch']), justify: z.enum(['start', 'center', 'end', 'space-between']), childSizing: z.enum(['fixed', 'fill', 'hug']) }).strict()
]);
const typographySchema = z.object({ fontFamily: z.string().min(1).max(128), fontSize: positive, fontWeight: z.number().int().min(100).max(900), lineHeight: positive, letterSpacing: coordinate, textAlign: z.enum(['left', 'center', 'right']), color: colorSchema }).strict();
export type DesignNodeBase = { id: string; name: string; visible: boolean; locked: boolean; bounds: NodeBounds; transform: NodeTransform; style: NodeStyle; interaction?: PrototypeInteraction };
export type FrameNode = DesignNodeBase & { type: 'frame'; children: DesignNode[]; layout: z.infer<typeof layoutSchema>; clipContent: boolean };
export type DesignNode = FrameNode
  | (DesignNodeBase & { type: 'rectangle'; radius: number | z.infer<typeof variableRefSchema> })
  | (DesignNodeBase & { type: 'ellipse' })
  | (DesignNodeBase & { type: 'icon'; iconKey: 'sparkle' | 'arrow-right' | 'leaf' | 'check' | 'plus' })
  | (DesignNodeBase & { type: 'text'; text: string; typography: z.infer<typeof typographySchema>; sizing: 'fixed' | 'auto' });
const frameNodeSchema: z.ZodType<FrameNode> = z.lazy(() => z.object({ ...baseNodeShape, type: z.literal('frame'), children: z.array(designNodeSchema).max(10_000), layout: layoutSchema, clipContent: z.boolean() }).strict()) as z.ZodType<FrameNode>;
export const designNodeSchema: z.ZodType<DesignNode> = z.lazy(() => z.union([
  frameNodeSchema,
  z.object({ ...baseNodeShape, type: z.literal('rectangle'), radius: z.union([z.number().finite().nonnegative(), variableRefSchema]) }).strict(),
  z.object({ ...baseNodeShape, type: z.literal('ellipse') }).strict(),
  z.object({ ...baseNodeShape, type: z.literal('icon'), iconKey: z.enum(['sparkle', 'arrow-right', 'leaf', 'check', 'plus']) }).strict(),
  z.object({ ...baseNodeShape, type: z.literal('text'), text: z.string().max(100_000), typography: typographySchema, sizing: z.enum(['fixed', 'auto']) }).strict()
] as const) as z.ZodType<DesignNode>);
export const designVariableSchema = z.object({ id: nodeIdSchema, type: z.enum(['color', 'font', 'spacing', 'radius']), value: z.union([colorSchema, z.string().min(1).max(128), z.number().finite().nonnegative()]), modes: z.record(z.string(), z.union([z.string(), z.number()])).optional(), description: z.string().max(512).optional() }).strict();
export const assetMetaSchema = z.object({ id: nodeIdSchema, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']), relativePath: z.string().min(1).max(512).refine((value) => !value.includes('\\') && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Asset path must be a normalized project-relative path'), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative().max(25 * 1024 * 1024) }).strict();
export const designPageSchema = z.object({ id: nodeIdSchema, name: z.string().min(1).max(128), root: frameNodeSchema }).strict();
export const designDocumentSchema = z.object({
  documentVersion: z.literal('1.0'), documentId: documentIdSchema, fileToken: z.string().min(16).max(128), revision: z.number().int().nonnegative(), title: z.string().min(1).max(256),
  pages: z.array(designPageSchema).min(1).max(100), variables: z.record(nodeIdSchema, designVariableSchema).refine((items) => Object.keys(items).length <= 500, 'At most 500 variables'),
  assets: z.record(nodeIdSchema, assetMetaSchema).refine((items) => Object.keys(items).length <= 1000, 'At most 1000 assets')
}).strict();
export type DesignDocument = z.infer<typeof designDocumentSchema>;
export type DesignVariable = z.infer<typeof designVariableSchema>;
export type DesignPage = z.infer<typeof designPageSchema>;
export type ValidationDiagnostic = { code: string; path: (string | number)[]; message: string };

function preflightTree(input: unknown): ValidationDiagnostic[] {
  if (!input || typeof input !== 'object' || !('pages' in input) || !Array.isArray((input as { pages?: unknown }).pages)) return [];
  const record = input as { variables?: unknown; assets?: unknown };
  if (record.variables && typeof record.variables === 'object' && Object.keys(record.variables).length > 500) return [{ code: 'MAX_VARIABLES', path: ['variables'], message: 'A document can contain at most 500 variables' }];
  if (record.assets && typeof record.assets === 'object' && Object.keys(record.assets).length > 1_000) return [{ code: 'MAX_ASSETS', path: ['assets'], message: 'A document can contain at most 1,000 assets' }];
  if ((input as { pages: unknown[] }).pages.length > 100) return [{ code: 'MAX_PAGES', path: ['pages'], message: 'A document can contain at most 100 pages' }];
  const stack: Array<{ node: unknown; path: (string | number)[]; depth: number }> = [];
  const pages = (input as { pages: unknown[] }).pages;
  pages.forEach((page, index) => { if (page && typeof page === 'object' && 'root' in page) stack.push({ node: (page as { root: unknown }).root, path: ['pages', index, 'root'], depth: 1 }); });
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (!current.node || typeof current.node !== 'object') continue;
    if (seen.has(current.node)) return [{ code: 'CYCLIC_INPUT', path: current.path, message: 'Design documents must be acyclic JSON data' }];
    seen.add(current.node);
    if (++count > 10_000) return [{ code: 'MAX_NODES', path: current.path, message: 'A document can contain at most 10,000 nodes' }];
    if (current.depth > 64) return [{ code: 'MAX_DEPTH', path: current.path, message: 'Node depth cannot exceed 64' }];
    const children = (current.node as { children?: unknown }).children;
    if (Array.isArray(children)) children.forEach((child, index) => stack.push({ node: child, path: [...current.path, 'children', index], depth: current.depth + 1 }));
  }
  return [];
}

export function validateDesignDocument(input: unknown): { success: true; data: DesignDocument } | { success: false; diagnostics: ValidationDiagnostic[] } {
  const preflight = preflightTree(input);
  if (preflight.length) return { success: false, diagnostics: preflight };
  const parsed = designDocumentSchema.safeParse(input);
  if (!parsed.success) return { success: false, diagnostics: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map((part) => typeof part === 'symbol' ? String(part) : part), message: issue.message })) };
  const diagnostics: ValidationDiagnostic[] = [];
  const ids = new Set<string>([parsed.data.documentId]);
  for (const [key, variable] of Object.entries(parsed.data.variables)) {
    if (key !== variable.id) diagnostics.push({ code: 'VARIABLE_KEY_MISMATCH', path: ['variables', key, 'id'], message: 'Variable record key must match variable.id' });
    const values = [variable.value, ...Object.values(variable.modes ?? {})];
    for (const value of values) {
      const valid = variable.type === 'color' ? typeof value === 'string' && colorSchema.safeParse(value).success
        : variable.type === 'spacing' || variable.type === 'radius' ? typeof value === 'number' && Number.isFinite(value) && value >= 0
          : typeof value === 'string' && value.length > 0;
      if (!valid) diagnostics.push({ code: 'VARIABLE_VALUE_TYPE', path: ['variables', key], message: `Invalid value for ${variable.type} variable` });
    }
  }
  for (const [key, asset] of Object.entries(parsed.data.assets)) if (key !== asset.id) diagnostics.push({ code: 'ASSET_KEY_MISMATCH', path: ['assets', key, 'id'], message: 'Asset record key must match asset.id' });
  let nodeCount = 0;
  const nodeLocations = new Map<string, { node: DesignNode; path: (string | number)[] }>();
  const visit = (node: DesignNode, path: (string | number)[], depth: number) => {
    nodeCount++;
    nodeLocations.set(node.id, { node, path });
    if (depth > 64) diagnostics.push({ code: 'MAX_DEPTH', path, message: 'Node depth cannot exceed 64' });
    if (ids.has(node.id)) diagnostics.push({ code: 'DUPLICATE_ID', path: [...path, 'id'], message: `Duplicate id: ${node.id}` }); else ids.add(node.id);
    for (const fill of node.style.fills) {
      if (fill.type === 'asset' && !parsed.data.assets[fill.assetId]) diagnostics.push({ code: 'ASSET_NOT_FOUND', path, message: `Missing asset: ${fill.assetId}` });
      if (fill.type === 'solid' && typeof fill.color !== 'string') {
        const variable = parsed.data.variables[fill.color.id];
        if (!variable) diagnostics.push({ code: 'VARIABLE_NOT_FOUND', path, message: `Missing variable: ${fill.color.id}` });
        else if (variable.type !== 'color') diagnostics.push({ code: 'VARIABLE_TYPE_MISMATCH', path, message: `Color fill cannot reference ${variable.type} variable: ${fill.color.id}` });
        if (!colorSchema.safeParse(fill.color.fallback).success) diagnostics.push({ code: 'VARIABLE_FALLBACK_TYPE', path, message: 'Color variable fallback must be a hex color' });
      }
    }
    if (node.type === 'rectangle' && typeof node.radius !== 'number') {
      const variable = parsed.data.variables[node.radius.id];
      if (!variable) diagnostics.push({ code: 'VARIABLE_NOT_FOUND', path: [...path, 'radius'], message: `Missing variable: ${node.radius.id}` });
      else if (variable.type !== 'radius' && variable.type !== 'spacing') diagnostics.push({ code: 'VARIABLE_TYPE_MISMATCH', path: [...path, 'radius'], message: `Radius cannot reference ${variable.type} variable: ${node.radius.id}` });
      if (typeof node.radius.fallback !== 'number' || !Number.isFinite(node.radius.fallback) || node.radius.fallback < 0) diagnostics.push({ code: 'VARIABLE_FALLBACK_TYPE', path: [...path, 'radius'], message: 'Radius variable fallback must be a non-negative number' });
    }
    if (node.type === 'frame') node.children.forEach((child, index) => visit(child, [...path, 'children', index], depth + 1));
  };
  parsed.data.pages.forEach((page, index) => { if (ids.has(page.id)) diagnostics.push({ code: 'DUPLICATE_ID', path: ['pages', index, 'id'], message: `Duplicate id: ${page.id}` }); else ids.add(page.id); visit(page.root, ['pages', index, 'root'], 1); });
  const pageIds = new Set(parsed.data.pages.map((page) => page.id));
  for (const { node, path } of nodeLocations.values()) {
    const interaction = node.interaction;
    if (!interaction) continue;
    if (interaction.action === 'navigate' && !pageIds.has(interaction.targetPageId)) {
      diagnostics.push({ code: 'INTERACTION_TARGET_NOT_FOUND', path: [...path, 'interaction', 'targetPageId'], message: `Navigation target page does not exist: ${interaction.targetPageId}` });
    } else if (interaction.action === 'openModal' || interaction.action === 'toggle') {
      const target = nodeLocations.get(interaction.targetNodeId)?.node;
      if (!target) diagnostics.push({ code: 'INTERACTION_TARGET_NOT_FOUND', path: [...path, 'interaction', 'targetNodeId'], message: `Interaction target node does not exist: ${interaction.targetNodeId}` });
      else if (interaction.action === 'openModal' && target.type !== 'frame') diagnostics.push({ code: 'INTERACTION_TARGET_TYPE', path: [...path, 'interaction', 'targetNodeId'], message: 'A modal target must be a frame' });
      else if (interaction.action === 'toggle' && target.id === node.id) diagnostics.push({ code: 'INTERACTION_SELF_TARGET', path: [...path, 'interaction', 'targetNodeId'], message: 'A node cannot toggle itself' });
    }
  }
  if (nodeCount > 10_000) diagnostics.push({ code: 'MAX_NODES', path: [], message: 'A document can contain at most 10,000 nodes' });
  return diagnostics.length ? { success: false, diagnostics } : { success: true, data: parsed.data };
}
