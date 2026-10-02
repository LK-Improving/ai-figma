import { randomBytes, randomUUID } from 'node:crypto';
import { validateDesignDocument, type DesignDocument, type DesignNode } from '@miaoma/design-schema';

const emptyStyle = () => ({ fills: [], strokes: [], effects: [], opacity: 1 });
export function createStarterDocument(title: string, frameLabel = 'Generated frame'): DesignDocument {
  const frame: Extract<DesignNode, { type: 'frame' }> = {
    id: 'frame_root', type: 'frame', name: frameLabel, visible: true, locked: false,
    bounds: { x: 0, y: 0, width: 1440, height: 900 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fills: [{ type: 'solid', color: '#f5f7f3' }], strokes: [], effects: [], opacity: 1 },
    children: [{
      id: 'text_title', type: 'text', name: 'Title', visible: true, locked: false,
      bounds: { x: 72, y: 72, width: 960, height: 96 }, transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: emptyStyle(), text: title.slice(0, 256), typography: { fontFamily: 'Arial, sans-serif', fontSize: 48, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0, textAlign: 'left', color: '#20332b' }, sizing: 'auto'
    }], layout: { mode: 'absolute' }, clipContent: true
  };
  const document: DesignDocument = { documentVersion: '1.0', documentId: `doc_${randomUUID().replaceAll('-', '')}`, fileToken: randomBytes(24).toString('base64url'), revision: 1, title: title.trim(), pages: [{ id: 'page_1', name: 'Page 1', root: frame }], variables: {}, assets: {} };
  const validation = validateDesignDocument(document);
  if (!validation.success) throw new Error(`Starter document is invalid: ${validation.diagnostics.map((item) => item.message).join('; ')}`);
  return validation.data;
}

export function assertValidDocument(document: unknown): asserts document is DesignDocument {
  const validation = validateDesignDocument(document);
  if (!validation.success) throw new Error(`Invalid design document: ${validation.diagnostics.map((item) => `${item.code} ${item.path.join('.')}: ${item.message}`).join('; ')}`);
}

export * from './commands';
