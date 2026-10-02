import { z } from 'zod';
import { designDocumentSchema, nodeIdSchema } from '@miaoma/design-schema';

export * from './generation-contract';

export const ipcChannels = ['frame:generateAndSave'] as const;
export const requestEnvelopeSchema = z.object({ requestId: nodeIdSchema, projectId: nodeIdSchema, payload: z.unknown() }).strict();
export const generateFrameRequestSchema = z.object({ requestId: nodeIdSchema, projectId: nodeIdSchema, payload: z.object({ title: z.string().trim().min(1).max(256), prompt: z.string().trim().min(1).max(20_000) }).strict() }).strict();
function isXml10Text(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (!(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || codePoint >= 0x20 && codePoint <= 0xd7ff
      || codePoint >= 0xe000 && codePoint <= 0xfffd
      || codePoint >= 0x10000 && codePoint <= 0x10ffff)) return false;
  }
  return true;
}
const xml10TextSchema = (max: number) => z.string().trim().min(1).max(max).refine(isXml10Text, 'Text contains characters that are not allowed in XML 1.0');
export const generatedFrameContentSchema = z.object({ frameName: xml10TextSchema(128), headline: xml10TextSchema(256), description: xml10TextSchema(2_000) }).strict();
export const screenshotMetadataSchema = z.object({ documentId: nodeIdSchema, documentRevision: z.number().int().nonnegative(), pageId: nodeIdSchema, nodeIds: z.array(nodeIdSchema).max(10_000), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096), scale: z.number().positive().max(2), mimeType: z.literal('image/svg+xml'), assets: z.enum(['ready', 'missing']) }).strict();
export const generateFrameResponseSchema = z.object({ ok: z.literal(true), data: z.object({ document: designDocumentSchema, documentPath: z.string().min(1), screenshotPath: z.string().min(1), screenshotMetadataPath: z.string().min(1), screenshot: screenshotMetadataSchema, previewSvg: z.string().max(2_000_000) }).strict(), revision: z.number().int().nonnegative() }).strict();
export const ipcErrorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.enum(['INVALID_ARGUMENT', 'GENERATION_FAILED', 'VALIDATION_FAILED', 'IO_ERROR', 'PROVIDER_UNAVAILABLE']), message: z.string().max(512), retryable: z.boolean() }).strict() }).strict();
export const generateFrameResultSchema = z.union([generateFrameResponseSchema, ipcErrorSchema]);
export type GenerateFrameRequest = z.infer<typeof generateFrameRequestSchema>;
export type GeneratedFrameContent = z.infer<typeof generatedFrameContentSchema>;
export type ScreenshotMetadata = z.infer<typeof screenshotMetadataSchema>;
export type GenerateFrameResult = z.infer<typeof generateFrameResultSchema>;
export type IpcChannel = typeof ipcChannels[number];

export class PocIpcRouter {
  private readonly handlers = new Map<IpcChannel, (request: unknown) => Promise<unknown>>();
  handle(channel: IpcChannel, handler: (request: unknown) => Promise<unknown>): void {
    if (!ipcChannels.includes(channel)) throw new Error(`IPC channel is not allowlisted: ${channel}`);
    if (this.handlers.has(channel)) throw new Error(`IPC handler already registered: ${channel}`);
    this.handlers.set(channel, handler);
  }
  async invoke(channel: string, request: unknown): Promise<GenerateFrameResult> {
    if (!ipcChannels.includes(channel as IpcChannel)) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'IPC channel is not allowlisted', retryable: false } };
    const handler = this.handlers.get(channel as IpcChannel);
    if (!handler) return { ok: false, error: { code: 'GENERATION_FAILED', message: 'IPC handler is not registered', retryable: false } };
    const parsedRequest = generateFrameRequestSchema.safeParse(request);
    if (!parsedRequest.success) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: parsedRequest.error.issues[0]?.message ?? 'Invalid IPC request', retryable: false } };
    try {
      const result = await handler(parsedRequest.data);
      const parsedResult = generateFrameResultSchema.safeParse(result);
      return parsedResult.success ? parsedResult.data : { ok: false, error: { code: 'GENERATION_FAILED', message: 'Main returned an invalid response', retryable: false } };
    } catch (error) {
      return { ok: false, error: { code: 'GENERATION_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : 'Unknown error', retryable: true } };
    }
  }
}
