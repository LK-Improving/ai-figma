import path from 'node:path';
import { PocIpcRouter } from '@miaoma/shared-protocol';
import { FakeFrameProvider, S0GenerationService } from '@miaoma/design-generation';

async function main() {
  const projectRoot = path.resolve(process.argv[2] ?? 'artifacts/s0-poc');
  const service = new S0GenerationService(new FakeFrameProvider(), projectRoot);
  const router = new PocIpcRouter();
  router.handle('frame:generateAndSave', async (raw) => {
    const request = raw as { projectId: string; payload: { title: string; prompt: string } };
    const result = await service.generateAndSave(request.payload, request.projectId);
    return { ok: true, data: { document: result.document, documentPath: result.saved.documentPath, screenshotPath: result.saved.screenshotPath, screenshotMetadataPath: result.saved.screenshotMetadataPath, screenshot: result.screenshot, previewSvg: result.previewSvg }, revision: result.document.revision };
  });
  const response = await router.invoke('frame:generateAndSave', {
    requestId: 's0-poc-run', projectId: 'demo-project',
    payload: { title: 'S0 Starter Frame', prompt: 'Create a clean welcome page for a nature-inspired design studio.' }
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  console.log(JSON.stringify({
    provider: 'local-fake (no model request)', channel: 'frame:generateAndSave',
    documentId: response.data.document.documentId, revision: response.revision,
    rootType: response.data.document.pages[0]?.root.type,
    nodeCount: response.data.document.pages[0]?.root.type === 'frame' ? 1 + response.data.document.pages[0].root.children.length : 0,
    screenshot: { path: response.data.screenshotPath, metadataPath: response.data.screenshotMetadataPath, metadata: response.data.screenshot },
    document: response.data.documentPath
  }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
