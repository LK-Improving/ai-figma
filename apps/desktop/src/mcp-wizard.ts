type McpClientName = 'vscode' | 'claude-desktop' | 'cursor';
type McpContext = { projectId: string; documentId: string };
type McpStatusResult = Awaited<ReturnType<typeof window.miaoma.studio.getMcpStatus>>;
type McpStatus = Extract<McpStatusResult, { ok: true }>['data'];

const mcp$ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing MCP wizard element: ${selector}`);
  return element;
};

const mcpDialog = mcp$<HTMLDialogElement>('#mcp-wizard');
const mcpOpenButton = mcp$<HTMLButtonElement>('#open-mcp-wizard');
const mcpCloseButton = mcp$<HTMLButtonElement>('#mcp-close');
const mcpConsent = mcp$<HTMLInputElement>('#mcp-consent');
const mcpConfigureButton = mcp$<HTMLButtonElement>('#mcp-configure');
const mcpRevokeButton = mcp$<HTMLButtonElement>('#mcp-revoke');
const mcpRevokeConfirmButton = mcp$<HTMLButtonElement>('#mcp-revoke-confirm-button');
const mcpRevokeCancelButton = mcp$<HTMLButtonElement>('#mcp-revoke-cancel');
const mcpError = mcp$<HTMLParagraphElement>('#mcp-error');
const mcpMessage = mcp$<HTMLParagraphElement>('#mcp-message');
const mcpStatusBadge = mcp$<HTMLSpanElement>('#mcp-bridge-badge');
const mcpStatusDetail = mcp$<HTMLParagraphElement>('#mcp-bridge-detail');
const mcpToolDetails = mcp$<HTMLDetailsElement>('#mcp-tools-details');
const mcpToolList = mcp$<HTMLUListElement>('#mcp-tool-list');
const mcpConfigCard = mcp$<HTMLElement>('#mcp-config-card');
const mcpConfigPath = mcp$<HTMLParagraphElement>('#mcp-config-path');
const mcpConfigOutput = mcp$<HTMLPreElement>('#mcp-config-output');
const mcpGrantCard = mcp$<HTMLElement>('#mcp-grant-card');
const mcpGrantDetail = mcp$<HTMLParagraphElement>('#mcp-grant-detail');
const mcpRevokeConfirm = mcp$<HTMLDivElement>('#mcp-revoke-confirm');

let mcpContext: McpContext | null = null;
let mcpStatusLoaded = false;
let mcpBusy = false;
let mcpStatusRequest = 0;
let mcpRevokeBusy = false;

const clientLabels: Record<McpClientName, string> = {
  vscode: 'VS Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor'
};

function currentMcpContext(): McpContext | null {
  const { projectId, documentId } = document.body.dataset;
  return projectId && documentId ? { projectId, documentId } : null;
}

function sameMcpContext(left: McpContext | null, right: McpContext | null): boolean {
  return !!left && !!right && left.projectId === right.projectId && left.documentId === right.documentId;
}

function selectedMcpClient(): McpClientName {
  const selected = document.querySelector<HTMLInputElement>('input[name="mcp-client"]:checked')?.value;
  return selected === 'claude-desktop' || selected === 'cursor' ? selected : 'vscode';
}

function setMcpError(message: string): void {
  mcpError.textContent = safeMcpMessage(message);
  mcpError.hidden = !message;
  if (message) mcpMessage.textContent = '';
}

function safeMcpMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏密钥]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[已隐藏密钥]')
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/g, '[已隐藏密钥]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已隐藏令牌]')
    .replace(/(([\w-]*key|access[-_]?token|token|secret|password|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/(--?[\w-]*(?:key|token|secret|password)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]');
}

function setMcpStatusBadge(state: 'loading' | 'active' | 'unavailable' | 'error', label: string): void {
  mcpStatusBadge.dataset.state = state;
  mcpStatusBadge.textContent = label;
}

function renderMcpContext(context: McpContext | null): void {
  if (!sameMcpContext(mcpContext, context)) {
    mcpConfigCard.hidden = true;
    mcpConfigOutput.textContent = '';
    mcpConfigPath.textContent = '';
    mcpConsent.checked = false;
    clearMcpGrant();
  }
  mcpContext = context;
  const title = document.querySelector<HTMLInputElement>('#document-title')?.value.trim();
  mcp$<HTMLElement>('#mcp-document-name').textContent = title || (context ? '当前设计文档' : '尚无已打开的文档');
  mcp$<HTMLElement>('#mcp-context-ids').textContent = context
    ? `项目 ${context.projectId}  ·  文档 ${context.documentId}`
    : '请先打开一个设计项目。';
  mcp$<HTMLElement>('#mcp-context-heading').textContent = context ? '当前项目与文档' : '未打开设计文档';
}

function updateMcpConsentLabel(): void {
  mcp$<HTMLElement>('#mcp-consent-client').textContent = clientLabels[selectedMcpClient()];
  const contextIsCurrent = sameMcpContext(mcpContext, currentMcpContext());
  mcpConfigureButton.disabled = !mcpConsent.checked || !contextIsCurrent || !mcpStatusLoaded || mcpBusy;
  mcpConfigureButton.textContent = mcpBusy ? '正在生成配置…' : '生成客户端配置';
}

function clearMcpGrant(): void {
  mcpGrantCard.hidden = true;
  mcpRevokeConfirm.hidden = true;
}

function renderMcpGrant(grant: McpStatus['grant'], context: McpContext): void {
  if (!grant || grant.projectId !== context.projectId || grant.documentId !== context.documentId) {
    clearMcpGrant();
    return;
  }
  const grantedAt = new Date(grant.grantedAt);
  const date = Number.isNaN(grantedAt.valueOf()) ? '' : grantedAt.toLocaleString('zh-CN');
  mcpGrantDetail.textContent = date ? `只读范围：当前文档 · 授权时间 ${date}` : '只读范围：当前项目与文档';
  mcpGrantCard.hidden = false;
}

function renderMcpTools(toolNames: readonly string[]): void {
  mcpToolList.replaceChildren();
  for (const name of toolNames) {
    const item = document.createElement('li');
    item.textContent = name;
    mcpToolList.append(item);
  }
  mcpToolDetails.hidden = toolNames.length === 0;
  mcpToolDetails.open = false;
}

async function refreshMcpStatus(): Promise<void> {
  const context = currentMcpContext();
  renderMcpContext(context);
  mcpStatusLoaded = false;
  mcpStatusRequest++;
  const requestId = mcpStatusRequest;
  mcpToolDetails.hidden = true;
  clearMcpGrant();
  setMcpStatusBadge(context ? 'loading' : 'unavailable', context ? '检查中' : '无活动文档');
  mcpStatusDetail.textContent = context ? '正在读取桥接状态…' : '打开设计文档后即可配置客户端。';
  setMcpError('');
  updateMcpConsentLabel();
  if (!context) return;

  try {
    const result = await window.miaoma.studio.getMcpStatus(context);
    if (!mcpDialog.open || requestId !== mcpStatusRequest) return;
    if (!sameMcpContext(context, currentMcpContext())) {
      renderMcpContext(currentMcpContext());
      setMcpStatusBadge('unavailable', '项目已切换');
      mcpStatusDetail.textContent = '当前设计已变化，请刷新状态并重新确认授权范围。';
      setMcpError('项目或文档已切换。请刷新状态后重新确认授权。');
      mcpConsent.checked = false;
      return;
    }
    if (!result.ok) {
      setMcpStatusBadge('error', '状态读取失败');
      mcpStatusDetail.textContent = '无法读取本地桥接状态。';
      setMcpError(result.error.message || '读取 MCP 状态失败。');
      return;
    }

    const data = result.data;
    const toolCount = data.toolNames.length;
    const ready = data.active && data.endpointReady;
    setMcpStatusBadge(ready ? 'active' : data.active ? 'loading' : 'unavailable', ready ? '桥接可用' : data.active ? '正在启动' : '未启动');
    mcpStatusDetail.textContent = `${ready ? '本地服务已就绪' : data.active ? '本地服务正在准备' : '本地服务当前不可用'} · ${toolCount} 个工具`;
    renderMcpTools(data.toolNames);
    renderMcpGrant(data.grant, context);
    mcpStatusLoaded = true;
    updateMcpConsentLabel();
  } catch (error) {
    if (!mcpDialog.open || requestId !== mcpStatusRequest) return;
    setMcpStatusBadge('error', '状态读取失败');
    mcpStatusDetail.textContent = '无法连接到本地桥接服务。';
    setMcpError(error instanceof Error ? error.message : '读取 MCP 状态失败。');
  }
}

function redactMcpConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMcpConfigValue);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /(?:key|token|secret|password|authorization|credential|^env(?:ironment)?$)/i.test(key)
        ? '[已隐藏]'
        : redactMcpConfigValue(item);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏密钥]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[已隐藏密钥]')
      .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/g, '[已隐藏密钥]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已隐藏令牌]')
      .replace(/([?&](?:[\w-]*key|access[-_]?token|token|secret|password)=)[^&\s"']+/gi, '$1[已隐藏]')
      .replace(/(--?[\w-]*(?:key|token|secret|password)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
      .replace(/(([\w-]*key|access[-_]?token|token|secret|password|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]');
  }
  return value;
}

function safeMcpConfig(rawConfig: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    throw new Error('服务返回的配置不是有效 JSON，出于安全考虑未显示配置内容。');
  }
  return JSON.stringify(redactMcpConfigValue(parsed), null, 2);
}

function showMcpConfig(config: string, pathHint: string): void {
  mcpConfigOutput.textContent = safeMcpConfig(config);
  mcpConfigPath.textContent = pathHint ? `建议配置位置：${safeMcpMessage(pathHint)}` : '';
  mcpConfigCard.hidden = false;
}

async function configureMcp(): Promise<void> {
  const context = currentMcpContext();
  if (!mcpConsent.checked) {
    setMcpError('请先勾选授权确认，再生成客户端配置。');
    return;
  }
  if (!sameMcpContext(mcpContext, context)) {
    mcpConsent.checked = false;
    updateMcpConsentLabel();
    setMcpError('项目或文档已切换。请刷新状态后重新确认授权。');
    await refreshMcpStatus();
    return;
  }
  if (!context || !mcpStatusLoaded || mcpBusy) return;

  mcpBusy = true;
  setMcpError('');
  mcpMessage.textContent = '正在为选定客户端准备配置…';
  updateMcpConsentLabel();
  try {
    const clientName = selectedMcpClient();
    const result = await window.miaoma.studio.configureMcp({ ...context, clientName });
    if (!sameMcpContext(context, currentMcpContext())) {
      mcpConsent.checked = false;
      throw new Error('项目或文档已切换。授权结果未显示，请刷新状态确认当前范围。');
    }
    if (!result.ok) throw new Error(result.error.message || '生成客户端配置失败。');
    if (result.data.grant.projectId !== context.projectId || result.data.grant.documentId !== context.documentId) {
      throw new Error('服务返回的授权范围与当前文档不一致，配置未显示。');
    }
    renderMcpGrant(result.data.grant, context);
    showMcpConfig(result.data.config, result.data.configPathHint);
    mcpMessage.textContent = `已为 ${clientLabels[clientName]} 生成配置。授权仍仅限当前项目和文档。`;
    mcpConsent.checked = false;
  } catch (error) {
    setMcpError(error instanceof Error ? error.message : '生成客户端配置失败。');
  } finally {
    mcpBusy = false;
    updateMcpConsentLabel();
  }
}

async function revokeMcpGrant(): Promise<void> {
  const context = currentMcpContext();
  if (!sameMcpContext(mcpContext, context) || !context) {
    setMcpError('项目或文档已切换。请刷新状态后再操作。');
    mcpConsent.checked = false;
    await refreshMcpStatus();
    return;
  }
  if (mcpRevokeBusy) return;
  mcpRevokeBusy = true;
  mcpRevokeConfirmButton.disabled = true;
  mcpRevokeConfirmButton.textContent = '正在撤销…';
  setMcpError('');
  mcpMessage.textContent = '';
  try {
    const result = await window.miaoma.studio.revokeMcpGrant(context);
    if (!result.ok) throw new Error(result.error.message || '撤销 MCP 授权失败。');
    if (!sameMcpContext(context, currentMcpContext())) throw new Error('项目或文档已切换，请刷新状态确认授权。');
    mcpGrantCard.hidden = true;
    mcpRevokeConfirm.hidden = true;
    mcpConfigCard.hidden = true;
    mcpMessage.textContent = result.data.revoked ? '只读授权已撤销。' : '当前项目和文档没有活动授权。';
    await refreshMcpStatus();
  } catch (error) {
    setMcpError(error instanceof Error ? error.message : '撤销 MCP 授权失败。');
  } finally {
    mcpRevokeBusy = false;
    mcpRevokeConfirmButton.disabled = false;
    mcpRevokeConfirmButton.textContent = '确认撤销';
  }
}

async function copyMcpConfig(): Promise<void> {
  const text = mcpConfigOutput.textContent ?? '';
  if (!text) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    mcpMessage.textContent = '配置 JSON 已复制。请在客户端设置中手动粘贴并保存。';
    setMcpError('');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(mcpConfigOutput);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    mcpConfigOutput.focus();
    mcpMessage.textContent = '无法直接访问剪贴板。配置已选中，请按 Ctrl+C 复制，再到客户端设置中手动粘贴。';
  }
}

function openMcpWizard(): void {
  if (mcpDialog.open) return;
  mcpDialog.showModal();
  setMcpError('');
  mcpMessage.textContent = '';
  mcpConsent.checked = false;
  mcpRevokeConfirm.hidden = true;
  renderMcpContext(currentMcpContext());
  mcp$<HTMLInputElement>('input[name="mcp-client"]:checked').focus();
  void refreshMcpStatus();
}

function closeMcpWizard(): void {
  if (mcpDialog.open) mcpDialog.close();
}

mcpOpenButton.addEventListener('click', openMcpWizard);
mcpCloseButton.addEventListener('click', closeMcpWizard);
mcp$<HTMLButtonElement>('#mcp-refresh').addEventListener('click', () => { void refreshMcpStatus(); });
mcpConsent.addEventListener('change', () => {
  setMcpError('');
  updateMcpConsentLabel();
});
for (const option of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mcp-client"]'))) {
  option.addEventListener('change', updateMcpConsentLabel);
}
mcpConfigureButton.addEventListener('click', () => { void configureMcp(); });
mcp$<HTMLButtonElement>('#mcp-copy-config').addEventListener('click', () => { void copyMcpConfig(); });
mcpRevokeButton.addEventListener('click', () => {
  mcpRevokeConfirm.hidden = false;
  mcp$<HTMLButtonElement>('#mcp-revoke-cancel').focus();
});
mcpRevokeCancelButton.addEventListener('click', () => {
  mcpRevokeConfirm.hidden = true;
  mcpRevokeButton.focus();
});
mcpRevokeConfirmButton.addEventListener('click', () => { void revokeMcpGrant(); });
mcpDialog.addEventListener('close', () => {
  mcpConsent.checked = false;
  mcpRevokeConfirm.hidden = true;
  updateMcpConsentLabel();
});
mcpDialog.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(mcpDialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"]),summary'
  )).filter((element) => !element.closest('[hidden]') && element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
