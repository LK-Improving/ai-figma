import type { DesignDocument, DesignNode } from '@miaoma/design-schema';
import type { CodegenFile } from './types';
import { collectNodes } from './reports';
import type { ValidatedAsset } from './validation';

const json = (value: unknown) => JSON.stringify(value, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function cssString(value: string): string {
  const safe = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || character === ' ' || character === '-' || character === '_') return character;
    return `\\${code.toString(16)} `;
  }).join('');
  return `"${safe}"`;
}

function variableTokenName(id: string): string {
  return `--token-${Buffer.from(id, 'utf8').toString('hex')}`;
}

function tokenCss(document: DesignDocument): string {
  const declarations: string[] = [];
  for (const [id, variable] of Object.entries(document.variables).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let value: string;
    if (variable.type === 'color') value = String(variable.value);
    else if (variable.type === 'font') value = cssString(String(variable.value));
    else value = `${String(variable.value)}px`;
    declarations.push(`  ${variableTokenName(id)}: ${value};`);
  }
  return `:root {\n${declarations.join('\n')}\n}\n`;
}

function createRuntimeFiles(document: DesignDocument, assets: Map<string, ValidatedAsset>, initialPageId: string): CodegenFile[] {
  const classByNodeId: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const record of collectNodes(document)) classByNodeId[record.node.id] = `n${record.classIndex}`;
  const assetUrls: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, asset] of [...assets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) assetUrls[id] = `./${asset.relativePath.slice('public/'.length)}`;
const appTsx = `import { useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import rawDocument from './design-document.json';
import './tokens.css';
import './styles.css';

type Bounds = { x: number; y: number; width: number; height: number };
type Fill = { type: 'solid'; color: string | { kind: 'variable'; id: string; fallback: string | number } } | { type: 'asset'; assetId: string };
type Interaction =
  | { trigger: 'click'; action: 'navigate'; targetPageId: string }
  | { trigger: 'click'; action: 'openModal'; targetNodeId: string }
  | { trigger: 'click'; action: 'toggle'; targetNodeId: string }
  | { trigger: 'click'; action: 'submitMock'; successMessage: string };
type NodeData = {
  id: string; name: string; visible: boolean; bounds: Bounds; transform: { rotation: number; scaleX: number; scaleY: number };
  style: { fills: Fill[]; strokes: Array<{ color: string; width: number; align: string }>; effects: Array<{ type: string; x?: number; y?: number; blur?: number; radius?: number; color?: string }>; opacity: number };
  interaction?: Interaction; type: 'frame' | 'rectangle' | 'ellipse' | 'icon' | 'text'; children?: NodeData[];
  layout?: { mode: 'absolute' } | { mode: 'flow'; direction: 'row' | 'column'; gap: number; padding: { top: number; right: number; bottom: number; left: number }; align: string; justify: string; childSizing: 'fixed' | 'fill' | 'hug' };
  clipContent?: boolean; radius?: number | { kind: 'variable'; id: string; fallback: string | number };
  iconKey?: 'sparkle' | 'arrow-right' | 'leaf' | 'check' | 'plus'; text?: string;
  typography?: { fontFamily: string; fontSize: number; fontWeight: number; lineHeight: number; letterSpacing: number; textAlign: 'left' | 'center' | 'right'; color: string };
  sizing?: 'fixed' | 'auto';
};
type PageData = { id: string; name: string; root: NodeData };
type GeneratedDocument = { title: string; pages: PageData[]; variables: Record<string, { value: string | number }>; assets: Record<string, { relativePath: string }> };
const design = rawDocument as unknown as GeneratedDocument;
const CLASS_BY_NODE_ID: Record<string, string> = ${json(classByNodeId)};
const ASSET_URL_BY_ID: Record<string, string> = ${json(assetUrls)};
const TOKEN_NAME_BY_ID: Record<string, string> = ${json(Object.fromEntries(Object.keys(document.variables).map((id) => [id, variableTokenName(id)])))};
const INITIAL_PAGE_ID = ${json(initialPageId)};
const ICONS = { sparkle: '✦', 'arrow-right': '→', leaf: '❧', check: '✓', plus: '+' } as const;

function findNode(nodeId: string): NodeData | undefined {
  const stack = design.pages.map((page) => page.root);
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === nodeId) return node;
    if (node.children) stack.push(...node.children);
  }
  return undefined;
}

const MODAL_NODE_IDS = (() => {
  const ids = new Set<string>();
  const stack = design.pages.map((page) => page.root);
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.interaction?.action === 'openModal') ids.add(node.interaction.targetNodeId);
    if (node.children) stack.push(...node.children);
  }
  return ids;
})();

function resolvedColor(value: string | { kind: 'variable'; id: string; fallback: string | number }): string {
  if (typeof value === 'string') return value;
  const tokenName = Object.hasOwn(TOKEN_NAME_BY_ID, value.id) ? TOKEN_NAME_BY_ID[value.id] : undefined;
  return tokenName ? \`var(\${tokenName}, \${String(value.fallback)})\` : String(value.fallback);
}

function resolvedRadius(value: number | { kind: 'variable'; id: string; fallback: string | number } | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const variable = Object.hasOwn(design.variables, value.id) ? design.variables[value.id] : undefined;
  return Number(variable?.value ?? value.fallback);
}

function cssFont(value: string): string {
  const safe = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || character === ' ' || character === '-' || character === '_') return character;
    return \`\\\\\${code.toString(16)} \`;
  }).join('');
  return \`"\${safe}"\`;
}

function styleFor(node: NodeData, isRoot: boolean, parentFlow: boolean, childSizing?: 'fixed' | 'fill' | 'hug'): CSSProperties {
  const style: CSSProperties = { boxSizing: 'border-box', opacity: node.style.opacity };
  if (isRoot) {
    style.position = 'relative'; style.width = '100%'; style.maxWidth = node.bounds.width; style.minHeight = node.bounds.height;
  } else if (parentFlow) {
    style.position = 'relative'; style.height = node.bounds.height;
    if (childSizing === 'fill') { style.width = undefined; style.flex = '1 1 0'; style.minWidth = 0; }
    else if (childSizing === 'hug') { style.width = 'auto'; style.flex = '0 1 auto'; }
    else { style.width = node.bounds.width; style.flex = '0 0 auto'; }
  } else {
    style.position = 'absolute'; style.left = node.bounds.x; style.top = node.bounds.y; style.width = node.bounds.width; style.height = node.bounds.height;
  }
  if (node.transform.rotation !== 0 || node.transform.scaleX !== 1 || node.transform.scaleY !== 1) style.transform = \`rotate(\${node.transform.rotation}deg) scale(\${node.transform.scaleX}, \${node.transform.scaleY})\`;
  const backgrounds = node.style.fills.map((fill) => fill.type === 'solid'
    ? resolvedColor(fill.color)
    : Object.hasOwn(ASSET_URL_BY_ID, fill.assetId) ? \`url("\${ASSET_URL_BY_ID[fill.assetId]}")\` : 'none');
  if (backgrounds.length) style.background = backgrounds.join(', ');
  const stroke = node.style.strokes[0];
  if (stroke) style.border = \`\${stroke.width}px solid \${stroke.color}\`;
  if (node.type === 'rectangle') style.borderRadius = resolvedRadius(node.radius);
  if (node.type === 'ellipse') style.borderRadius = '50%';
  const shadow = node.style.effects.find((effect) => effect.type === 'shadow');
  if (shadow && shadow.x !== undefined && shadow.y !== undefined && shadow.blur !== undefined && shadow.color) style.boxShadow = \`\${shadow.x}px \${shadow.y}px \${shadow.blur}px \${shadow.color}\`;
  const blur = node.style.effects.find((effect) => effect.type === 'blur');
  if (blur?.radius !== undefined) style.filter = \`blur(\${blur.radius}px)\`;
  if (node.type === 'frame') {
    if (node.clipContent) style.overflow = 'hidden';
    if (node.layout?.mode === 'flow') {
      style.display = 'flex'; style.flexDirection = node.layout.direction; style.gap = node.layout.gap;
      style.padding = \`\${node.layout.padding.top}px \${node.layout.padding.right}px \${node.layout.padding.bottom}px \${node.layout.padding.left}px\`;
      style.alignItems = node.layout.align === 'start' ? 'flex-start' : node.layout.align === 'end' ? 'flex-end' : node.layout.align;
      style.justifyContent = node.layout.justify === 'start' ? 'flex-start' : node.layout.justify === 'end' ? 'flex-end' : node.layout.justify;
      style.flexWrap = 'wrap';
    }
  }
  if (node.type === 'text' && node.typography) {
    style.fontFamily = cssFont(node.typography.fontFamily); style.fontSize = node.typography.fontSize;
    style.fontWeight = node.typography.fontWeight; style.lineHeight = node.typography.lineHeight;
    style.letterSpacing = node.typography.letterSpacing; style.textAlign = node.typography.textAlign; style.color = node.typography.color;
    style.whiteSpace = node.sizing === 'fixed' ? 'pre-wrap' : 'normal';
  }
  return style;
}

function NodeView({ node, isRoot = false, parentFlow = false, childSizing, toggles, onInteract, modal = false }: {
  node: NodeData; isRoot?: boolean; parentFlow?: boolean; childSizing?: 'fixed' | 'fill' | 'hug';
  toggles: Record<string, boolean>; onInteract: (interaction: Interaction, sourceNodeId: string) => void; modal?: boolean;
}) {
  if (MODAL_NODE_IDS.has(node.id) && !modal) return null;
  const interaction = node.interaction;
  const click = interaction ? (event: MouseEvent<HTMLDivElement>) => { event.stopPropagation(); onInteract(interaction, node.id); } : undefined;
  const key = interaction ? (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onInteract(interaction, node.id); }
  } : undefined;
  const childrenFlow = node.type === 'frame' && node.layout?.mode === 'flow';
  const content = node.type === 'frame' ? node.children?.map((child) => <NodeView key={child.id} node={child} parentFlow={childrenFlow} childSizing={childrenFlow ? node.layout?.mode === 'flow' ? node.layout.childSizing : undefined : undefined} toggles={toggles} onInteract={onInteract} />)
    : node.type === 'text' ? node.text
      : node.type === 'icon' ? <span aria-hidden="true">{ICONS[node.iconKey ?? 'sparkle']}</span> : null;
  const rendered = <div className={\`node \${CLASS_BY_NODE_ID[node.id] ?? ''}\`} style={styleFor(node, isRoot, parentFlow, childSizing)}
    role={interaction ? 'button' : undefined} tabIndex={interaction ? 0 : undefined} aria-label={interaction ? node.name : undefined}
    onClick={click} onKeyDown={key} hidden={!node.visible || toggles[node.id] === false}>
    {content}
    {interaction?.action === 'submitMock' && <span className="mock-result" role="status">{undefined}</span>}
  </div>;
  return rendered;
}

export default function App() {
  const [pageId, setPageId] = useState(INITIAL_PAGE_ID);
  const [modalId, setModalId] = useState<string | undefined>(undefined);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const page = design.pages.find((candidate) => candidate.id === pageId) ?? design.pages[0];
  const onInteract = (interaction: Interaction, sourceNodeId: string) => {
    if (interaction.action === 'navigate') setPageId(interaction.targetPageId);
    else if (interaction.action === 'openModal') setModalId(interaction.targetNodeId);
    else if (interaction.action === 'toggle') setToggles((current) => {
      const target = findNode(interaction.targetNodeId);
      const previous = Object.hasOwn(current, interaction.targetNodeId) ? current[interaction.targetNodeId] : Boolean(target?.visible);
      return { ...current, [interaction.targetNodeId]: !previous };
    });
    else setMessages((current) => ({ ...current, [sourceNodeId]: interaction.successMessage }));
  };
  const modal = modalId ? findNode(modalId) : undefined;
  return <main className="studio-app">
    <header className="studio-header"><strong>{design.title}</strong><span>演示原型 · 数据提交为本地模拟</span></header>
    <nav className="page-nav" aria-label="页面导航">{design.pages.map((candidate) => <button key={candidate.id} type="button" aria-current={candidate.id === page?.id ? 'page' : undefined} onClick={() => setPageId(candidate.id)}>{candidate.name}</button>)}</nav>
    <section className="page-shell" aria-label={page?.name ?? '设计页面'}>{page && <NodeView node={page.root} isRoot toggles={toggles} onInteract={onInteract} />}</section>
    {Object.entries(messages).map(([sourceNodeId, message]) => <p className="mock-message" key={sourceNodeId} role="status">{message}</p>)}
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalId(undefined); }}>
      <section className="modal-dialog" role="dialog" aria-modal="true" aria-label={modal.name}>
        <button className="modal-close" type="button" onClick={() => setModalId(undefined)}>关闭</button>
        <NodeView node={modal} isRoot toggles={toggles} onInteract={onInteract} modal />
      </section>
    </div>}
  </main>;
}
`;
  const files: CodegenFile[] = [
    { path: 'src/App.tsx', content: appTsx, mimeType: 'text/typescript' },
    { path: 'src/main.tsx', content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './styles.css';\n\nconst root = document.getElementById('root');\nif (!root) throw new Error('Missing app root');\ncreateRoot(root).render(<React.StrictMode><App /></React.StrictMode>);\n`, mimeType: 'text/typescript' },
    { path: 'src/design-document.json', content: `${json(document)}\n`, mimeType: 'application/json' },
    { path: 'src/tokens.css', content: tokenCss(document), mimeType: 'text/css' },
    { path: 'src/styles.css', content: APP_CSS, mimeType: 'text/css' },
    { path: 'package.json', content: `${json({
      name: 'myfigma-generated-project', private: true, version: '1.0.0', type: 'module',
      scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
      dependencies: { react: '19.1.0', 'react-dom': '19.1.0' },
      devDependencies: { '@types/react': '19.1.2', '@types/react-dom': '19.1.2', '@vitejs/plugin-react': '4.5.0', typescript: '5.9.3', vite: '6.3.5' }
    })}\n`, mimeType: 'application/json' },
    { path: 'index.html', content: `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta name="referrer" content="no-referrer"/><title>${escapeHtml(document.title)}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`, mimeType: 'text/html' },
    { path: 'tsconfig.json', content: `${json({ files: [], references: [{ path: './tsconfig.app.json' }] })}\n`, mimeType: 'application/json' },
    { path: 'tsconfig.app.json', content: `${json({ compilerOptions: { target: 'ES2022', useDefineForClassFields: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'Bundler', allowImportingTsExtensions: true, verbatimModuleSyntax: true, moduleDetection: 'force', noEmit: true, jsx: 'react-jsx', strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, resolveJsonModule: true }, include: ['src'] })}\n`, mimeType: 'application/json' },
    { path: 'vite.config.ts', content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()], base: './' });\n`, mimeType: 'text/typescript' },
    { path: 'README.md', content: README_CONTENT, mimeType: 'text/markdown' }
  ];
  return files;
}

const APP_CSS = `:root { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; color: #17211b; background: #f2f4f2; font-synthesis: none; text-rendering: optimizeLegibility; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button { font: inherit; }
.studio-app { min-height: 100vh; padding: 20px clamp(12px, 3vw, 40px) 48px; }
.studio-header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; max-width: 1440px; margin: 0 auto 12px; }
.studio-header strong { font-size: 18px; }
.studio-header span { color: #69736c; font-size: 12px; }
.page-nav { display: flex; flex-wrap: wrap; gap: 8px; max-width: 1440px; margin: 0 auto 20px; }
.page-nav button { border: 1px solid #d6ddd7; border-radius: 8px; background: white; color: #26332a; padding: 8px 12px; cursor: pointer; }
.page-nav button[aria-current="page"] { border-color: #269366; background: #e5f5ec; color: #155c3b; }
.page-shell { width: 100%; max-width: 1440px; margin: 0 auto; overflow: auto; }
.node { box-sizing: border-box; }
.node[role="button"] { cursor: pointer; }
.node[role="button"]:focus-visible { outline: 2px solid #267d5b; outline-offset: 2px; }
.mock-message { max-width: 1440px; margin: 16px auto; border-radius: 8px; padding: 12px; color: #155c3b; background: #e5f5ec; }
.modal-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 24px; background: rgb(15 23 18 / 55%); }
.modal-dialog { position: relative; max-width: min(100%, 1000px); max-height: 90vh; overflow: auto; border-radius: 12px; padding: 40px 20px 20px; background: white; box-shadow: 0 24px 70px rgb(0 0 0 / 25%); }
.modal-close { position: absolute; top: 8px; right: 8px; z-index: 1; border: 0; border-radius: 6px; padding: 6px 10px; background: #eef2ef; color: #26332a; cursor: pointer; }
@media (max-width: 600px) { .studio-header { align-items: flex-start; flex-direction: column; gap: 4px; } .studio-app { padding-top: 12px; } }
`;

const README_CONTENT = `# Generated MyFigma prototype\n\nThis React + TypeScript project was generated deterministically from a validated MyFigma design snapshot.\n\n## Run locally\n\n1. Install a supported Node.js release (22.12 or newer).\n2. Run \`npm install\`.\n3. Run \`npm run dev\` to preview or \`npm run build\` to produce \`dist/\`.\n\nPrototype interactions are local demonstrations only. Form submissions show the design's mock success text; no service, account, or external API is contacted. Review \`public/design-manifest.json\`, \`reports/\`, and \`preview.html\` before using the export.\n`;

function nodeDeclarations(node: DesignNode, root: boolean, parentFlow: boolean, childSizing: string | undefined, assets: Map<string, ValidatedAsset>): string[] {
  const declarations: string[] = ['box-sizing:border-box', `opacity:${node.style.opacity}`];
  if (root) declarations.push('position:relative', `width:min(100%, ${node.bounds.width}px)`, `min-height:${node.bounds.height}px`, 'margin-inline:auto');
  else if (parentFlow) {
    declarations.push('position:relative', `height:${node.bounds.height}px`);
    if (childSizing === 'fill') declarations.push('width:auto', 'flex:1 1 0', 'min-width:0');
    else if (childSizing === 'hug') declarations.push('width:auto', 'flex:0 1 auto');
    else declarations.push(`width:${node.bounds.width}px`, 'flex:0 0 auto');
  } else declarations.push('position:absolute', `left:${node.bounds.x}px`, `top:${node.bounds.y}px`, `width:${node.bounds.width}px`, `height:${node.bounds.height}px`);
  if (node.transform.rotation || node.transform.scaleX !== 1 || node.transform.scaleY !== 1) declarations.push(`transform:rotate(${node.transform.rotation}deg) scale(${node.transform.scaleX},${node.transform.scaleY})`);
  const fills = node.style.fills.map((fill) => {
    if (fill.type === 'solid') return typeof fill.color === 'string' ? fill.color : `var(${variableTokenName(fill.color.id)}, ${String(fill.color.fallback)})`;
    const asset = assets.get(fill.assetId);
    return asset ? `url("./${asset.relativePath}")` : 'none';
  });
  if (fills.length) declarations.push(`background:${fills.join(',')}`);
  const stroke = node.style.strokes[0];
  if (stroke) declarations.push(`border:${stroke.width}px solid ${stroke.color}`);
  if (node.type === 'rectangle') declarations.push(`border-radius:${typeof node.radius === 'number' ? node.radius : node.radius ? `var(${variableTokenName(node.radius.id)},${String(node.radius.fallback)}px)` : '0px'}`);
  if (node.type === 'ellipse') declarations.push('border-radius:50%');
  for (const effect of node.style.effects) {
    if (effect.type === 'shadow') declarations.push(`box-shadow:${effect.x}px ${effect.y}px ${effect.blur}px ${effect.color}`);
    else declarations.push(`filter:blur(${effect.radius}px)`);
  }
  if (node.type === 'frame') {
    if (node.clipContent) declarations.push('overflow:hidden');
    if (node.layout.mode === 'flow') {
      declarations.push('display:flex', `flex-direction:${node.layout.direction}`, `gap:${node.layout.gap}px`, `padding:${node.layout.padding.top}px ${node.layout.padding.right}px ${node.layout.padding.bottom}px ${node.layout.padding.left}px`);
      declarations.push(`align-items:${node.layout.align === 'start' ? 'flex-start' : node.layout.align === 'end' ? 'flex-end' : node.layout.align}`);
      declarations.push(`justify-content:${node.layout.justify === 'start' ? 'flex-start' : node.layout.justify === 'end' ? 'flex-end' : node.layout.justify}`);
      declarations.push('flex-wrap:wrap');
    }
  }
  if (node.type === 'text') {
    declarations.push(`font-family:${cssString(node.typography.fontFamily)}`, `font-size:${node.typography.fontSize}px`, `font-weight:${node.typography.fontWeight}`, `line-height:${node.typography.lineHeight}`, `letter-spacing:${node.typography.letterSpacing}px`, `text-align:${node.typography.textAlign}`, `color:${node.typography.color}`, `white-space:${node.sizing === 'fixed' ? 'pre-wrap' : 'normal'}`);
  }
  return declarations;
}

function renderNodeHtml(node: DesignNode, classById: Record<string, string>, assets: Map<string, ValidatedAsset>, modalIds: Set<string>, parentFlow = false, childSizing?: string, modal = false): string {
  if (modalIds.has(node.id) && !modal) return '';
  const indexClass = classById[node.id] ?? 'n0';
  const interaction = node.interaction;
  const attrs = [
    `class="node ${indexClass}"`, `data-node-id="${escapeHtml(node.id)}"`, `data-node-type="${node.type}"`
  ];
  if (!node.visible) attrs.push('hidden');
  if (interaction) {
    attrs.push('role="button"', 'tabindex="0"', `aria-label="${escapeHtml(node.name)}"`, `data-action="${interaction.action}"`);
    if (interaction.action === 'navigate') attrs.push(`data-target-page="${escapeHtml(interaction.targetPageId)}"`);
    else if (interaction.action === 'openModal' || interaction.action === 'toggle') attrs.push(`data-target-node="${escapeHtml(interaction.targetNodeId)}"`);
    else attrs.push(`data-success-message="${escapeHtml(interaction.successMessage)}"`);
  }
  let content = '';
  if (node.type === 'frame') {
    const flow = node.layout.mode === 'flow';
    content = node.children.map((child) => renderNodeHtml(child, classById, assets, modalIds, flow, flow ? node.layout.mode === 'flow' ? node.layout.childSizing : undefined : undefined)).join('');
  } else if (node.type === 'text') content = escapeHtml(node.text);
  else if (node.type === 'icon') content = `<span aria-hidden="true">${({ sparkle: '✦', 'arrow-right': '→', leaf: '❧', check: '✓', plus: '+' } as const)[node.iconKey]}</span>`;
  if (interaction?.action === 'submitMock') content += `<span class="mock-result" role="status" data-submit-for="${escapeHtml(node.id)}"></span>`;
  return `<div ${attrs.join(' ')}>${content}</div>`;
}

function previewFiles(document: DesignDocument, assets: Map<string, ValidatedAsset>, initialPageId: string): CodegenFile[] {
  const records = collectNodes(document);
  const classById: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const record of records) classById[record.node.id] = `n${record.classIndex}`;
  const modalIds = new Set(records.flatMap(({ node }) => node.interaction?.action === 'openModal' ? [node.interaction.targetNodeId] : []));
  const nav = document.pages.map((page) => `<button type="button" data-preview-page="${escapeHtml(page.id)}">${escapeHtml(page.name)}</button>`).join('');
  const pages = document.pages.map((page) => `<section class="preview-page" data-page-id="${escapeHtml(page.id)}"${page.id !== initialPageId ? ' hidden' : ''}><h2 class="visually-hidden">${escapeHtml(page.name)}</h2>${renderNodeHtml(page.root, classById, assets, modalIds, false, undefined, false)}</section>`).join('');
  const modals = records.filter(({ node }) => modalIds.has(node.id)).map(({ node }) => `<div class="modal-overlay" data-modal-overlay-for="${escapeHtml(node.id)}" hidden><section class="modal-content" role="dialog" aria-modal="true" aria-label="${escapeHtml(node.name)}"><button type="button" class="modal-close" data-close-modal>关闭</button>${renderNodeHtml(node, classById, assets, modalIds, false, undefined, true)}</section></div>`).join('');
  // The page roots participate in responsive flow; children use the precise parent layout rule.
  const pageRules: string[] = [];
  for (const page of document.pages) {
    const rootClass = classById[page.root.id];
    if (rootClass) pageRules.push(`.${rootClass}{${nodeDeclarations(page.root, true, false, undefined, assets).join(';')}}`);
    const addChildren = (node: DesignNode) => {
      if (node.type !== 'frame') return;
      const flow = node.layout.mode === 'flow';
      node.children.forEach((child) => {
        const className = classById[child.id];
        if (className) pageRules.push(`.${className}{${nodeDeclarations(child, false, flow, flow ? node.layout.mode === 'flow' ? node.layout.childSizing : undefined : undefined, assets).join(';')}}`);
        addChildren(child);
      });
    };
    addChildren(page.root);
  }
  for (const { node } of records) {
    if (!modalIds.has(node.id)) continue;
    const className = classById[node.id];
    if (className) pageRules.push(`.modal-content > .${className}{position:relative!important;left:auto!important;top:auto!important;width:min(100%,${node.bounds.width}px)!important;height:auto!important;min-height:${node.bounds.height}px}`);
  }
  const css = `${tokenCss(document)}${PREVIEW_CSS}\n${[...new Set(pageRules)].join('\n')}\n`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'none'"><title>${escapeHtml(document.title)} · 安全预览</title><link rel="stylesheet" href="./preview.css"></head>
<body><header><h1>${escapeHtml(document.title)}</h1><p>原型预览 · 表单仅显示本地模拟结果，不连接业务服务</p><nav aria-label="页面导航">${nav}</nav></header><main id="preview-app">${pages}</main><div id="modal-root">${modals}</div><script src="./preview.js" defer></script></body></html>
`;
  return [
    { path: 'preview.html', content: html, mimeType: 'text/html' },
    { path: 'preview.css', content: css, mimeType: 'text/css' },
    { path: 'preview.js', content: previewScript(initialPageId), mimeType: 'text/javascript' }
  ];
}

const PREVIEW_CSS = `*{box-sizing:border-box}body{margin:0;padding:20px clamp(12px,3vw,40px);background:#f2f4f2;color:#17211b;font:14px/1.45 Inter,"Segoe UI","Microsoft YaHei",sans-serif}header,#preview-app{max-width:1440px;margin:0 auto}header{margin-bottom:20px}header h1{font-size:20px;margin:0 0 4px}header p{color:#69736c;margin:0 0 12px}nav{display:flex;flex-wrap:wrap;gap:8px}nav button,.modal-close{border:1px solid #d6ddd7;border-radius:8px;background:#fff;color:#26332a;padding:7px 11px;cursor:pointer}.preview-page{position:relative;min-height:50vh}.preview-page[hidden],[hidden]{display:none!important}.node{box-sizing:border-box}.node[role=button]{cursor:pointer}.node[role=button]:focus-visible{outline:2px solid #267d5b;outline-offset:2px}.modal-overlay{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:24px;background:rgb(15 23 18 / 55%)}.modal-content{position:relative;max-width:min(100%,1000px);max-height:90vh;overflow:auto;border-radius:12px;padding:40px 20px 20px;background:white;box-shadow:0 24px 70px rgb(0 0 0 / 25%)}.modal-close{position:absolute;right:8px;top:8px;z-index:1}.mock-result{display:block;color:#155c3b}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}`;

function previewScript(initialPageId: string): string { return `(function(){
  var app=document.getElementById('preview-app');
  if(!app)return;
  function all(selector,root){return Array.prototype.slice.call((root||document).querySelectorAll(selector));}
  function showPage(pageId){all('[data-page-id]',app).forEach(function(page){page.hidden=page.dataset.pageId!==pageId;});}
  function findNode(nodeId){return all('[data-node-id]').find(function(node){return node.dataset.nodeId===nodeId;});}
  function closeModal(overlay){if(overlay)overlay.hidden=true;}
  function runAction(actionNode){
    var action=actionNode.dataset.action||'';
    if(action==='navigate')showPage(actionNode.dataset.targetPage||'');
    else if(action==='openModal'){
      var overlay=all('[data-modal-overlay-for]').find(function(item){return item.dataset.modalOverlayFor===actionNode.dataset.targetNode;});
      if(overlay){overlay.hidden=false;var dialog=overlay.querySelector('[role=dialog]');if(dialog)dialog.focus();}
    }else if(action==='toggle'){
      var node=findNode(actionNode.dataset.targetNode||'');if(node)node.hidden=!node.hidden;
    }else if(action==='submitMock'){
      var status=all('[data-submit-for]').find(function(item){return item.dataset.submitFor===actionNode.dataset.nodeId;});
      if(status)status.textContent=actionNode.dataset.successMessage||'演示提交成功';
    }
  }
  app.addEventListener('click',function(event){
    var target=event.target;
    if(!(target instanceof Element))return;
    var pageButton=target.closest('[data-preview-page]');
    if(pageButton){showPage(pageButton.dataset.previewPage||'');return;}
    var actionNode=target.closest('[data-action]');
    if(actionNode)runAction(actionNode);
  });
  app.addEventListener('keydown',function(event){
    if(event.key!=='Enter'&&event.key!==' ')return;
    var target=event.target;
    if(!(target instanceof Element))return;
    var actionNode=target.closest('[data-action]');
    if(!actionNode)return;
    event.preventDefault();
    if(event.repeat)return;
    runAction(actionNode);
  });
  document.addEventListener('click',function(event){
    var target=event.target;
    if(!(target instanceof Element))return;
    var close=target.closest('[data-close-modal]');if(close){closeModal(close.closest('[data-modal-overlay-for]'));return;}
    if(target.classList.contains('modal-overlay'))closeModal(target);
  });
  document.addEventListener('keydown',function(event){if(event.key==='Escape')all('[data-modal-overlay-for]').forEach(function(overlay){closeModal(overlay);});});
  showPage(${json(initialPageId)});
})();\n`; }

export function createProjectFiles(document: DesignDocument, assets: Map<string, ValidatedAsset>, initialPageId: string): CodegenFile[] {
  const files = [...createRuntimeFiles(document, assets, initialPageId), ...previewFiles(document, assets, initialPageId)];
  return files;
}
