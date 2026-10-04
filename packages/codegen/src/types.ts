import type { DesignDocument, DesignNode, PrototypeInteraction } from '@miaoma/design-schema';

export interface CodegenInput {
  /** Parsed or raw DesignDocument. It is always validated again at the codegen boundary. */
  document: unknown;
  /** Raw asset bytes, keyed by the asset IDs in document.assets. */
  assets?: Readonly<Record<string, Uint8Array>>;
  /** Page shown when the prototype starts. Defaults to the first document page. */
  initialPageId?: string;
}

export interface CodegenFile {
  /** Normalized project-relative POSIX path. Absolute paths and traversal are never emitted. */
  path: string;
  content: string | Uint8Array;
  mimeType: string;
}

export interface CodegenDiagnostic {
  code: string;
  path: Array<string | number>;
  message: string;
}

export interface CodegenValidationReport {
  status: 'passed';
  nodeCount: number;
  pageCount: number;
  assetCount: number;
  checkedAssetBytes: number;
  checks: string[];
}

export interface CodegenViewport {
  width: 1440 | 768 | 390;
  height: 900 | 1024 | 844;
}

export interface CodegenViewportIssue {
  nodeId: string;
  nodeName: string;
  overflowPx: number;
  cause: 'absolute-child-overflow' | 'flow-child-too-wide';
}

export interface CodegenViewportCheck {
  pageId: string;
  pageName: string;
  viewport: CodegenViewport;
  effectiveWidth: number;
  status: 'passed' | 'warning';
  issues: CodegenViewportIssue[];
  visibleNodeCount: number;
}

export interface CodegenViewportReport {
  viewports: CodegenViewport[];
  checks: CodegenViewportCheck[];
}

export interface CodegenInteractionBinding {
  pageId: string;
  nodeId: string;
  nodeName: string;
  interaction: PrototypeInteraction;
  mockBehavior: string;
}

export interface CodegenMissingInteraction {
  pageId: string;
  nodeId: string;
  nodeName: string;
  label: string;
  reason: 'action-like node has no prototype interaction';
}

export interface CodegenInteractionReport {
  supportedActions: Array<'navigate' | 'openModal' | 'toggle' | 'submitMock'>;
  bindings: CodegenInteractionBinding[];
  missingInteractions: CodegenMissingInteraction[];
}

export interface CodegenManifest {
  manifestVersion: '1.0';
  generator: '@miaoma/codegen';
  documentId: string;
  revision: number;
  title: string;
  initialPageId: string;
  pages: Array<{ pageId: string; name: string; rootNodeId: string }>;
  components: Array<{ nodeId: string; pageId: string; component: 'GeneratedNode'; file: 'src/App.tsx' }>;
  tokens: Array<{ id: string; type: 'color' | 'font' | 'spacing' | 'radius'; value: string | number; modes?: Record<string, string | number>; description?: string }>;
  assets: Array<{
    assetId: string;
    path: string;
    mimeType: string;
    sourceSha256: string;
    outputSha256: string;
    sourceByteSize: number;
    outputByteSize: number;
  }>;
  missingInteractions: CodegenMissingInteraction[];
  viewportReport: CodegenViewportReport;
  interactionReport: CodegenInteractionReport;
  validation: CodegenValidationReport;
}

export interface CodegenProject {
  files: CodegenFile[];
  manifest: CodegenManifest;
  viewportReport: CodegenViewportReport;
  interactionReport: CodegenInteractionReport;
  validation: CodegenValidationReport;
}

export type CodegenResult =
  | ({ success: true } & CodegenProject)
  | { success: false; diagnostics: CodegenDiagnostic[] };

export type ValidatedDocument = DesignDocument;
export type AnyDesignNode = DesignNode;
