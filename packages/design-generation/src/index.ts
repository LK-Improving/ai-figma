import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import { assertValidDocument, createStarterDocument } from '@miaoma/editor-core';
import { renderDocumentScreenshot } from '@miaoma/renderer-canvas';
import { saveDesignProject, type SavedProject } from '@miaoma/storage';
import type { GeneratedFrameContent } from '@miaoma/shared-protocol';
import type { ScreenshotMetadata } from '@miaoma/shared-protocol';
import { readFile } from 'node:fs/promises';
import { screenshotMetadataSchema } from '@miaoma/shared-protocol';

export type FrameGenerationInput = { title: string; prompt: string };
export type FrameGenerationOptions = { signal?: AbortSignal };
export interface FrameProvider {
  readonly name: string;
  generateFrame(input: FrameGenerationInput, options?: FrameGenerationOptions): Promise<GeneratedFrameContent>;
}
export type FrameGenerationOutput = { document: DesignDocument; screenshot: ScreenshotMetadata; saved: SavedProject; previewSvg: string };

export class FakeFrameProvider implements FrameProvider {
  readonly name = 'local-fake';
  async generateFrame(input: FrameGenerationInput, options: FrameGenerationOptions = {}): Promise<GeneratedFrameContent> {
    if (options.signal?.aborted) throw new Error('Generation was cancelled');
    const headline = input.title.trim().slice(0, 256);
    const regionBrief = /^Region brief:\s*(.+?)(?:\r?\n|$)/m.exec(input.prompt)?.[1]?.trim();
    const description = regionBrief
      ? regionBrief.slice(0, 2_000)
      : 'Created by the local fake provider. Replace this adapter with an approved provider when model access is configured.';
    return { frameName: 'Generated frame', headline, description };
  }
}

export class S0GenerationService {
  constructor(private readonly provider: FrameProvider, private readonly outputRoot: string) {}

  async generateAndSave(input: FrameGenerationInput, projectId: string): Promise<FrameGenerationOutput> {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title || title.length > 256 || !prompt || prompt.length > 20_000) throw new Error('Title and prompt are required and must be within the size limits');
    const content = await this.provider.generateFrame({ title, prompt });
    const document = createStarterDocument(title, content.frameName);
    const frame = document.pages[0]!.root as Extract<DesignNode, { type: 'frame' }>;
    frame.children[0] = { ...frame.children[0]!, name: 'Headline', text: content.headline } as DesignNode;
    frame.children.push({
      id: 'text_description', type: 'text', name: 'Description', visible: true, locked: false,
      bounds: { x: 72, y: 190, width: 1000, height: 96 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { fills: [], strokes: [], effects: [], opacity: 1 }, text: content.description,
      typography: { fontFamily: 'Arial, sans-serif', fontSize: 22, fontWeight: 400, lineHeight: 1.5, letterSpacing: 0, textAlign: 'left', color: '#53655b' }, sizing: 'auto'
    });
    assertValidDocument(document);
    const rendered = renderDocumentScreenshot(document);
    const saved = await saveDesignProject(this.outputRoot, projectId, document, rendered.svg, rendered.metadata);
    const reloaded: unknown = JSON.parse(await readFile(saved.documentPath, 'utf8'));
    assertValidDocument(reloaded);
    if (reloaded.documentId !== document.documentId || reloaded.revision !== document.revision) throw new Error('Saved document did not round-trip at the expected revision');
    const savedScreenshot = await readFile(saved.screenshotPath, 'utf8');
    const savedMetadata = screenshotMetadataSchema.safeParse(JSON.parse(await readFile(saved.screenshotMetadataPath, 'utf8')) as unknown);
    if (savedScreenshot !== rendered.svg || !savedMetadata.success || savedMetadata.data.documentId !== document.documentId || savedMetadata.data.documentRevision !== document.revision) throw new Error('Saved screenshot evidence did not match the generated document');
    return { document, screenshot: rendered.metadata, saved, previewSvg: rendered.svg };
  }
}

export * from './generation-run';
export * from './dag-scheduler';
export * from './quality-loop';
