import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import type {
  CodegenInteractionBinding, CodegenInteractionReport, CodegenManifest, CodegenMissingInteraction,
  CodegenViewport, CodegenViewportCheck, CodegenViewportIssue, CodegenViewportReport, CodegenValidationReport
} from './types';
import type { ValidatedAsset } from './validation';

export const VIEWPORTS: CodegenViewport[] = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 }
];

/** Matches the horizontal CSS padding used by both the React preview shell and static preview body. */
export function effectiveViewportWidth(viewportWidth: number): number {
  const horizontalPadding = Math.min(40, Math.max(12, viewportWidth * 0.03));
  return Math.max(0, viewportWidth - horizontalPadding * 2);
}

export interface NodeRecord {
  node: DesignNode;
  pageId: string;
  path: Array<string | number>;
  classIndex: number;
}

export function collectNodes(document: DesignDocument): NodeRecord[] {
  const records: NodeRecord[] = [];
  const visit = (node: DesignNode, pageId: string, path: Array<string | number>) => {
    records.push({ node, pageId, path, classIndex: records.length });
    if (node.type === 'frame') node.children.forEach((child, index) => visit(child, pageId, [...path, 'children', index]));
  };
  document.pages.forEach((page, index) => visit(page.root, page.id, ['pages', index, 'root']));
  return records;
}

function textLabel(node: DesignNode): string {
  return node.type === 'text' ? node.text : node.name;
}

function likelyAction(node: DesignNode): boolean {
  return /\b(?:button|cta|submit|action|link|buy|purchase|sign\s*up|log\s*in|start|continue|next|back|open|download)\b|按钮|提交|购买|注册|登录|开始|立即|了解|查看|预约|加入|确认|下一步|返回|打开|下载/i.test(`${node.name} ${textLabel(node)}`);
}

function mockBehavior(node: DesignNode): string {
  const action = node.interaction;
  if (!action) return '';
  switch (action.action) {
    case 'navigate': return `Switches to page ${action.targetPageId} inside the generated prototype.`;
    case 'openModal': return `Opens frame ${action.targetNodeId} in an in-page modal.`;
    case 'toggle': return `Toggles visibility of node ${action.targetNodeId}.`;
    case 'submitMock': return `Shows a local success message: ${action.successMessage}`;
  }
}

export function createInteractionReport(document: DesignDocument): CodegenInteractionReport {
  const bindings: CodegenInteractionBinding[] = [];
  const missingInteractions: CodegenMissingInteraction[] = [];
  for (const record of collectNodes(document)) {
    const { node, pageId } = record;
    if (node.interaction) bindings.push({ pageId, nodeId: node.id, nodeName: node.name, interaction: node.interaction, mockBehavior: mockBehavior(node) });
    else if (likelyAction(node)) missingInteractions.push({ pageId, nodeId: node.id, nodeName: node.name, label: textLabel(node).slice(0, 256), reason: 'action-like node has no prototype interaction' });
  }
  return { supportedActions: ['navigate', 'openModal', 'toggle', 'submitMock'], bindings, missingInteractions };
}

function flowChildWidths(node: Extract<DesignNode, { type: 'frame' }>, children: readonly DesignNode[], ownWidth: number): Map<string, number> {
  const widths = new Map<string, number>();
  if (node.layout.mode !== 'flow') return widths;
  const contentWidth = Math.max(0, ownWidth - node.layout.padding.left - node.layout.padding.right);
  if (node.layout.direction === 'row' && node.layout.childSizing === 'fill' && children.length) {
    const widthPerChild = Math.max(0, contentWidth - Math.max(0, children.length - 1) * node.layout.gap) / children.length;
    for (const child of children) widths.set(child.id, widthPerChild);
  } else if (node.layout.direction === 'column' && node.layout.align === 'stretch' && node.layout.childSizing !== 'fixed') {
    for (const child of children) widths.set(child.id, contentWidth);
  }
  return widths;
}

function viewportIssues(root: DesignNode, effectiveWidth: number): { issues: CodegenViewportIssue[]; visibleNodeCount: number } {
  const issues: CodegenViewportIssue[] = [];
  let visibleNodeCount = 0;
  const visit = (node: DesignNode, pageRoot: boolean, assignedWidth?: number) => {
    if (!node.visible) return;
    visibleNodeCount++;
    if (node.type !== 'frame') return;
    const ownWidth = pageRoot ? Math.min(effectiveWidth, node.bounds.width) : assignedWidth ?? node.bounds.width;
    const children = node.children.filter((child) => child.visible);
    if (node.layout.mode === 'absolute') {
      for (const child of children) {
        const right = child.bounds.x + child.bounds.width;
        const overflow = Math.max(0, -child.bounds.x, right - ownWidth);
        if (overflow > 0.5) issues.push({ nodeId: child.id, nodeName: child.name, overflowPx: Math.ceil(overflow), cause: 'absolute-child-overflow' });
      }
    } else {
      const contentWidth = Math.max(0, ownWidth - node.layout.padding.left - node.layout.padding.right);
      const childWidths = flowChildWidths(node, children, ownWidth);
      const tooWide = children.filter((child) => (childWidths.get(child.id) ?? child.bounds.width) > contentWidth + 0.5);
      for (const child of tooWide) {
        const childWidth = childWidths.get(child.id) ?? child.bounds.width;
        issues.push({ nodeId: child.id, nodeName: child.name, overflowPx: Math.ceil(childWidth - contentWidth), cause: 'flow-child-too-wide' });
      }
      if (node.layout.mode === 'flow' && node.layout.direction === 'row' && node.layout.childSizing === 'fixed') {
        const requiredWidth = children.reduce((sum, child) => sum + child.bounds.width, 0)
          + Math.max(0, children.length - 1) * node.layout.gap + node.layout.padding.left + node.layout.padding.right;
        if (requiredWidth > ownWidth + 0.5 && children.length) {
          const first = children[0];
          if (first && !issues.some((issue) => issue.nodeId === first.id && issue.cause === 'flow-child-too-wide')) {
            issues.push({ nodeId: first.id, nodeName: first.name, overflowPx: Math.ceil(requiredWidth - ownWidth), cause: 'flow-child-too-wide' });
          }
        }
      }
    }
    if (node.layout.mode === 'absolute') {
      for (const child of children) visit(child, false);
    } else {
      const childWidths = flowChildWidths(node, children, ownWidth);
      for (const child of children) visit(child, false, childWidths.get(child.id));
    }
  };
  visit(root, true);
  return { issues, visibleNodeCount };
}

export function createViewportReport(document: DesignDocument): CodegenViewportReport {
  const checks: CodegenViewportCheck[] = [];
  for (const page of document.pages) {
    for (const viewport of VIEWPORTS) {
      const contentWidth = effectiveViewportWidth(viewport.width);
      const result = viewportIssues(page.root, contentWidth);
      checks.push({ pageId: page.id, pageName: page.name, viewport, effectiveWidth: contentWidth, status: result.issues.length ? 'warning' : 'passed', ...result });
    }
  }
  return { viewports: VIEWPORTS, checks };
}

export function createValidationReport(document: DesignDocument, assets: Map<string, ValidatedAsset>, nodeCount: number, assetByteSize: number): CodegenValidationReport {
  return {
    status: 'passed', nodeCount, pageCount: document.pages.length, assetCount: assets.size, checkedAssetBytes: assetByteSize,
    checks: [
      'design-schema and cross-reference validation',
      'duplicate node, page, variable, and asset ID validation',
      'asset byte-size, SHA-256, MIME signature, and safe-name validation',
      'SVG active-content and external-reference filtering',
      'output relative-path validation',
      'deterministic file and manifest generation'
    ]
  };
}

export function createManifest(
  document: DesignDocument,
  initialPageId: string,
  assets: Map<string, ValidatedAsset>,
  interactions: CodegenInteractionReport,
  viewports: CodegenViewportReport,
  validation: CodegenValidationReport
): CodegenManifest {
  return {
    manifestVersion: '1.0', generator: '@miaoma/codegen', documentId: document.documentId, revision: document.revision, title: document.title, initialPageId,
    pages: document.pages.map((page) => ({ pageId: page.id, name: page.name, rootNodeId: page.root.id })),
    components: collectNodes(document).map(({ node, pageId }) => ({ nodeId: node.id, pageId, component: 'GeneratedNode', file: 'src/App.tsx' })),
    tokens: Object.entries(document.variables).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, token]) => ({
      id, type: token.type, value: token.value,
      ...(token.modes ? { modes: token.modes } : {}),
      ...(token.description ? { description: token.description } : {})
    })),
    assets: [...assets.values()].map((asset) => ({
      assetId: asset.assetId, path: asset.relativePath.slice('public/'.length), mimeType: asset.mimeType,
      sourceSha256: asset.sourceSha256, outputSha256: asset.outputSha256,
      sourceByteSize: asset.sourceBytes.byteLength, outputByteSize: asset.outputBytes.byteLength
    })),
    missingInteractions: interactions.missingInteractions,
    viewportReport: viewports,
    interactionReport: interactions,
    validation
  };
}
