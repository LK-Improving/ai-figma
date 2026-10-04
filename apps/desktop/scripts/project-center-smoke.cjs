const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const directory = process.env.MYFIGMA_PROJECT_CENTER_SMOKE_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error('An isolated absolute smoke directory is required');
mkdirSync(path.join(directory, 'user-data', 'projects'), { recursive: true });
app.setPath('userData', path.join(directory, 'user-data'));
const timeout = setTimeout(() => { console.error('Project center smoke timed out'); app.exit(1); }, 180000);
app.on('browser-window-created', (_event, window) => {
  window.show();
  window.focus();
  window.webContents.once('did-finish-load', async () => {
    try {
      const script = `(async () => {
        let phase = 'startup';
        const markPhase = next => { phase = next; console.log('SMOKE_PHASE ' + next); };
        const wait = async (check, timeout = 30000) => { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('UI timeout at ' + phase + ': center=' + document.querySelector('#project-center')?.hidden + ' / run=' + document.querySelector('#generation-run-id')?.textContent + ' / state=' + document.querySelector('#generation-run-state')?.dataset.state + ' / assistantState=' + document.querySelector('#assistant-run-state-chip')?.dataset.state + ' / runError=' + document.querySelector('#assistant-run-error')?.textContent + ' / panelError=' + document.querySelector('#generation-panel-error')?.textContent); await new Promise(resolve => setTimeout(resolve, 60)); } };
        const assert = (value, message) => { if (!value) throw new Error(message); };
        const good = result => { if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message); return result.data; };
        await wait(() => !document.querySelector('#project-center').hidden && document.querySelectorAll('.project-center-card').length >= 1);
        assert(document.querySelector('#design-setup') === null, 'The removed setup page must not exist in the app');
        const grid = document.querySelector('.project-center-grid');
        assert(grid.getBoundingClientRect().width > 0, 'Project center grid is not visible');
        const initial = good(await window.miaoma.studio.load());
        markPhase('create-direct-to-editor');
        document.querySelector('#project-center-new-button').click();
        await wait(() => document.querySelector('#project-center').hidden && !document.querySelector('.studio-shell').hidden && document.body.dataset.projectId !== initial.projectId);
        let created = good(await window.miaoma.studio.load());
        assert(created.projectId !== initial.projectId, 'New Project reused the existing project');
        const newTitle = 'Smoke 新建项目';
        document.querySelector('#document-title').value = newTitle;
        document.querySelector('#document-title').dispatchEvent(new Event('change', { bubbles: true }));
        await wait(async () => good(await window.miaoma.studio.load()).document.title === newTitle);
        created = good(await window.miaoma.studio.load());
        assert(!document.querySelector('#assistant-panel-content').hidden, 'A new project must open with the assistant tab selected');
        assert(document.querySelector('#assistant-run-card').parentElement === document.querySelector('#assistant-conversation'), 'Run controls must be embedded in the assistant conversation');
        assert(document.querySelector('.assistant-history-section').parentElement === document.querySelector('#assistant-conversation'), 'Generation history must remain in the assistant conversation');
        document.querySelector('[data-panel="layers"]').click();
        assert(!document.querySelector('#layer-panel-content').hidden, 'Layers tab did not open');
        document.querySelector('[data-panel="assistant"]').click();
        assert(!document.querySelector('#assistant-panel-content').hidden, 'Assistant tab did not reopen');
        document.querySelector('#open-generation-panel').click();
        assert(document.querySelector('#generation-panel').hidden, 'Topbar AI entry must stay in the assistant conversation');
        const editor = document.querySelector('#design-canvas');
        assert(editor.getBoundingClientRect().width > 0 && !document.querySelector('#inspector').hidden, 'Editor canvas and right properties panel must be visible');
        assert(document.querySelectorAll('#canvas-ruler-x .canvas-ruler-mark').length > 0 && document.querySelectorAll('#canvas-ruler-y .canvas-ruler-mark').length > 0, 'Canvas rulers did not render');

        markPhase('send-assistant-prompt');
        const prompt = '设计一个清新自然的花店品牌官网，包含花店首屏、花卉特色、精选鲜花产品、品牌故事和立即体验入口，使用柔和植物绿色与留白。';
        document.querySelector('#assistant-provider').value = 'local-fake';
        document.querySelector('#assistant-provider').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#assistant-parallel').value = '3';
        document.querySelector('#assistant-parallel').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#assistant-prompt').value = prompt;
        document.querySelector('#assistant-prompt-send').click();
        await wait(() => document.querySelector('#generation-run-id').textContent.startsWith('Run '), 60000);
        const runId = document.querySelector('#generation-run-id').textContent.substring(4).split(' ')[0];
        await wait(() => ['interrupted', 'completed', 'cancelled', 'failed', 'conflict', 'needs_review'].includes(document.querySelector('#generation-run-state').dataset.state), 90000);
        let terminalRunState = document.querySelector('#generation-run-state').dataset.state;
        if (terminalRunState === 'failed') {
          const failedRun = good(await window.miaoma.studio.getGenerationRun({ projectId: created.projectId, documentId: created.document.documentId, runId, afterSeq: 0 }));
          throw new Error('Assistant generation failed: ' + JSON.stringify(failedRun));
        }
        assert(terminalRunState === 'completed' || terminalRunState === 'needs_review', 'Assistant run did not reach a reviewable state: ' + terminalRunState);
        if (terminalRunState === 'needs_review') {
          markPhase('review-in-chat');
          await wait(() => !document.querySelector('#assistant-review-reason-wrap').hidden && !document.querySelector('#assistant-review-evidence').hidden, 30000);
          document.querySelector('#assistant-review-reason').value = '隔离环境冒烟测试：已检查本轮截图和非阻断警告。';
          document.querySelector('#assistant-review-reason').dispatchEvent(new Event('input', { bubbles: true }));
          const accept = [...document.querySelectorAll('#assistant-run-actions button')].find(button => button.textContent.includes('接受提示并应用候选'));
          assert(accept && !accept.disabled, 'Inline review acceptance should be available after evidence and reason are provided');
          accept.click();
          await wait(() => document.querySelector('#generation-run-state').dataset.state === 'completed' && document.querySelector('#generation-candidate').hidden, 45000);
          terminalRunState = 'completed';
        } else {
          markPhase('apply-in-chat');
          await wait(() => [...document.querySelectorAll('#assistant-run-actions button')].some(button => button.textContent.includes('应用到画布') && !button.disabled));
          [...document.querySelectorAll('#assistant-run-actions button')].find(button => button.textContent.includes('应用到画布')).click();
          await wait(() => document.querySelector('#generation-candidate').hidden, 45000);
        }
        const applied = good(await window.miaoma.studio.load());
        const generatedRegionCount = applied.document.pages[0].root.children.length;
        assert(generatedRegionCount > 0, 'Applying the assistant candidate did not create editable canvas regions');
        assert(document.querySelector('#generation-panel').hidden, 'Generation operations should remain in chat, without a separate Run window');
        assert(document.querySelector('#assistant-run-state-chip').textContent === '已完成', 'Assistant conversation did not show the completed run state');
        assert(document.querySelector('#assistant-conversation').textContent.includes('候选已应用'), 'Conversation is missing its applied generation record');
        const editorCanvasScreenshot = document.querySelector('#design-canvas').toDataURL('image/png');
        window.__editorCanvasScreenshot = editorCanvasScreenshot;
        window.__projectCenterSmokeProjects = { initial, created };

        window.__editorWorkspaceCaptureRequested = true;
        await new Promise(resolve => { window.__releaseEditorWorkspaceCapture = resolve; });
        markPhase('reopen-project-center');
        document.querySelector('#open-project-center').click();
        await wait(() => document.querySelector('#project-center-status').dataset.state === 'ready' && document.querySelectorAll('.project-center-card').length === 2);
        document.querySelector('#project-center-search').value = 'NO_MATCH';
        document.querySelector('#project-center-search').dispatchEvent(new Event('input'));
        assert(document.querySelectorAll('.project-center-card').length === 0, 'Project search did not filter the project list');
        document.querySelector('#project-center-search').value = '';
        document.querySelector('#project-center-search').dispatchEvent(new Event('input'));
        const firstCard = [...document.querySelectorAll('.project-center-card')].find(card => card.querySelector('strong').textContent === initial.document.title);
        assert(firstCard, 'Existing project is missing from project center');
        firstCard.click();
        await wait(() => document.querySelector('#project-center').hidden && document.body.dataset.projectId === initial.projectId);
        const reopened = good(await window.miaoma.studio.load());
        assert(reopened.projectId === initial.projectId, 'Opening an existing project selected the wrong project');
        const stale = await window.miaoma.studio.switchProject({ projectId: created.projectId, documentId: created.document.documentId, targetProjectId: initial.projectId, targetDocumentId: initial.document.documentId });
        assert(!stale.ok, 'A stale project context was accepted');
        document.querySelector('#open-project-center').click();
        await wait(() => !document.querySelector('#project-center').hidden && document.querySelector('#project-center-status').dataset.state === 'ready' && document.querySelectorAll('.project-center-card').length === 2);
        await wait(() => [...document.querySelectorAll('.project-center-cover')].every(image => image.complete && image.naturalWidth > 0));
        const projectCenter = document.querySelector('#project-center');
        const projectCenterBounds = projectCenter.getBoundingClientRect();
        const projectCenterColumns = getComputedStyle(document.querySelector('.project-center-grid')).gridTemplateColumns.trim().split(' ').filter(Boolean).length;
        assert(projectCenterBounds.width > 0 && projectCenterBounds.height > 0, 'Project center was not visible at screenshot capture');
        return { passed: true, initialProjectId: initial.projectId, newProjectId: created.projectId, existingProjectReopened: reopened.projectId === initial.projectId, projectCount: 2, assistantRunId: runId, terminalRunState, generatedRegionCount, leftTabs: true, topbarAIEntryOpensChat: true, runControlsEmbeddedInConversation: true, generationPanelHidden: true, projectCenterColumns, projectCenterBounds: { x: projectCenterBounds.x, y: projectCenterBounds.y, width: projectCenterBounds.width, height: projectCenterBounds.height }, staleContextRejected: true };
      })()`;
      const smokeExecution = window.webContents.executeJavaScript(script);
      const captureDeadline = Date.now() + 90000;
      while (!await window.webContents.executeJavaScript('window.__editorWorkspaceCaptureRequested === true')) {
        if (Date.now() > captureDeadline) throw new Error('Editor workspace screenshot checkpoint timed out');
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      await new Promise(resolve => setTimeout(resolve, 180));
      const editorWorkspaceImage = await window.webContents.capturePage();
      writeFileSync(path.join(directory, 'editor-workspace.png'), editorWorkspaceImage.toPNG());
      await window.webContents.executeJavaScript('window.__releaseEditorWorkspaceCapture?.()');
      const result = await smokeExecution;
      const editorCanvasScreenshot = await window.webContents.executeJavaScript('window.__editorCanvasScreenshot');
      if (!editorCanvasScreenshot?.startsWith('data:image/png;base64,')) throw new Error('Editor canvas screenshot could not be captured');
      writeFileSync(path.join(directory, 'editor-canvas.png'), Buffer.from(editorCanvasScreenshot.slice('data:image/png;base64,'.length), 'base64'));
      await new Promise(resolve => setTimeout(resolve, 250));
      const dashboardImage = await window.webContents.capturePage();
      writeFileSync(path.join(directory, 'project-center-final.png'), dashboardImage.toPNG());
      const summary = { ...result, editorWorkspaceScreenshot: 'editor-workspace.png', projectCenterScreenshot: 'project-center-final.png', editorCanvasScreenshot: 'editor-canvas.png' };
      writeFileSync(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../dist/main.js');
