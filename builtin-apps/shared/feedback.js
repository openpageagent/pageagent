let dismiss;

document.addEventListener('copy-result', event => {
  if (event.target.localName !== 'page-code-editor') return;
  const error = event.detail.error;
  void notify(error ? '复制失败：' + error : '已复制', !!error);
});

export async function notify(text, error = false) {
  try {
    const feedback = await PageAgent.ui.load('feedback');
    dismiss?.();
    dismiss = feedback.toast(text, { kind: error ? 'error' : 'info', duration: 2600 });
  } catch {
    const status = document.getElementById('status');
    status.textContent = text; status.className = error ? 'status-error error' : 'status-pending';
  }
}

export async function copyText(value, notice = '已复制') {
  try { await navigator.clipboard.writeText(value); }
  catch (error) { await notify('复制失败：' + (error.message || '无法写入剪贴板'), true); return; }
  await notify(notice);
}
