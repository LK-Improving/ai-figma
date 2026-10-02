const form = document.querySelector('#form');
const button = document.querySelector('#submit');
const notice = document.querySelector('#notice');
document.querySelector('#provider').textContent = new URLSearchParams(location.search).get('provider') === 'codex-cli' ? 'Codex CLI Provider' : '本地 Fake Provider';
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  notice.textContent = '正在生成、校验 DSL、渲染截图并保存…';
  try {
    const result = await window.miaoma.generateAndSave({ title: document.querySelector('#title').value, prompt: document.querySelector('#prompt').value });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    document.querySelector('#result').hidden = false;
    document.querySelector('#revision').textContent = `revision ${result.revision} · ${result.data.document.pages[0].root.children.length + 1} nodes`;
    document.querySelector('#preview').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.data.previewSvg)}`;
    document.querySelector('#document-path').textContent = result.data.documentPath;
    document.querySelector('#screenshot-path').textContent = result.data.screenshotPath;
    document.querySelector('#screenshot-metadata-path').textContent = result.data.screenshotMetadataPath;
    document.querySelector('#summary').textContent = JSON.stringify(result.data.document, null, 2);
    notice.textContent = 'DSL 校验通过，Frame 和同 revision 截图已保存。';
  } catch (error) { notice.textContent = error instanceof Error ? error.message : '生成失败'; }
  finally { button.disabled = false; }
});
if (new URLSearchParams(location.search).get('autopoc') === '1') form.requestSubmit();
