import { createHash } from 'node:crypto';

export const pngBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/VZ0AAAAASUVORK5CYII=', 'base64'));
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const style = (fills: unknown[] = []) => ({ fills, strokes: [], effects: [], opacity: 1 });
const base = (id: string, name = id) => ({
  id, name, visible: true, locked: false,
  bounds: { x: 0, y: 0, width: 160, height: 48 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: style()
});
const text = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  ...base(id, label), type: 'text', text: label,
  typography: { fontFamily: 'Microsoft YaHei', fontSize: 16, fontWeight: 400, lineHeight: 1.4, letterSpacing: 0, textAlign: 'left', color: '#202820' },
  sizing: 'auto', ...extra
});
const frame = (id: string, children: unknown[], extra: Record<string, unknown> = {}) => ({
  ...base(id), type: 'frame', children, layout: { mode: 'absolute' }, clipContent: false, ...extra
});

export function makeDocument(): Record<string, unknown> {
  const targetHidden = { ...base('hidden_target', 'Toggle target'), type: 'rectangle', radius: 4, visible: false };
  const modal = frame('modal_frame', [text('modal_label', 'Example modal')]);
  const png = { id: 'photo_asset', mimeType: 'image/png', relativePath: 'uploads/ignored.png', sha256: sha256(pngBytes), byteSize: pngBytes.byteLength };
  return {
    documentVersion: '1.0', documentId: 'document_01', fileToken: 'token-for-codegen-001', revision: 4, title: '</title><script>window.pwned=1</script>',
    pages: [
      { id: 'home_page', name: 'Home', root: frame('home_root', [
        { ...text('nav_action', 'Open details', { interaction: { trigger: 'click', action: 'navigate', targetPageId: 'details_page' } }), bounds: { x: 16, y: 12, width: 150, height: 40 } },
        { ...base('open_modal', 'Open modal'), type: 'rectangle', radius: 8, interaction: { trigger: 'click', action: 'openModal', targetNodeId: 'modal_frame' }, bounds: { x: 16, y: 62, width: 180, height: 48 } },
        { ...base('toggle_control', 'Toggle content'), type: 'icon', iconKey: 'plus', interaction: { trigger: 'click', action: 'toggle', targetNodeId: 'hidden_target' }, bounds: { x: 16, y: 118, width: 40, height: 40 } },
        targetHidden,
        { ...text('submit_control', 'Submit <img src=x onerror=alert(1)>', { interaction: { trigger: 'click', action: 'submitMock', successMessage: '<svg onload=alert(1)>mock ok</svg>' } }), bounds: { x: 16, y: 166, width: 280, height: 48 } },
        { ...base('photo', 'Photo'), type: 'rectangle', radius: 0, style: style([{ type: 'asset', assetId: 'photo_asset' }]), bounds: { x: 220, y: 12, width: 48, height: 48 } },
        { ...base('ellipse_sample', 'Circle'), type: 'ellipse', bounds: { x: 280, y: 12, width: 48, height: 48 } },
        { ...base('icon_sample', 'Sparkle'), type: 'icon', iconKey: 'sparkle', bounds: { x: 340, y: 12, width: 48, height: 48 } },
        text('unbound_cta', '立即开始'),
        modal
      ]) },
      { id: 'details_page', name: 'Details', root: frame('details_root', [text('details_text', 'Detail page')]) }
    ],
    variables: { brand: { id: 'brand', type: 'color', value: '#1a7a50', description: 'Brand color' } },
    assets: { photo_asset: png }
  };
}

export function makeAssets(): Record<string, Uint8Array> { return { photo_asset: new Uint8Array(pngBytes) }; }
