// Run in an authenticated, isolated server on port 8774 with an empty database.
(async () => {
  if (location.port !== '8774') throw Error('Use the isolated export test server');
  const assert = (value, label) => {
    if (!value) throw Error(label);
  };
  if ((await api('archives')).current.count === 0) {
    await api('privacy/password', { newPassword: 'synthetic-test-password' });
    for (let i = 0; i < 9; i++) {
      await api('save', {
        title: `示例事项 ${i + 1}`,
        detail: `仅用于测试的正文 ${i + 1}`,
        category: i % 2 ? '测试工作' : '测试生活',
        date: today(),
        repeat: 'none',
        time: '',
        end: '',
        remind: false,
        private: i === 8,
        images: [],
        detailHtml: `<h2>测试标题</h2><p><strong>示例内容 ${i + 1}</strong></p>`,
      });
      if (i === 3) await api('archives/create', {});
    }
  }
  await refresh();
  const completed = state.notes[0];
  await api('complete', { id: completed.id, day: completed.date, done: true });
  await refresh();
  category = '测试生活';
  status = 'pending';
  $('#search').value = '不存在的文本';
  render();
  $('#archives-open').click();
  for (let i = 0; i < 100 && !$('#archives-dialog').open; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert($('#archive-current-count').textContent.includes('9 条'), 'Current total must be nine');
  assert(archiveState[0].count === 4, 'Historical snapshot must retain four');
  $('#archive-export-current').click();
  for (let i = 0; i < 100 && !$('#archive-export-dialog').open; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert(
    $('#archive-include-private').checked && $('#archive-include-private').disabled,
    'Full export must include protected items',
  );
  assert($('#archive-export-password').required, 'Full export must require the password');
  window.exportRegressionRoot = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('Export-Regression', { create: true });
  window.originalDirectoryPicker = window.showDirectoryPicker;
  window.showDirectoryPicker = async () => exportRegressionRoot;
  return 'Nine current notes, four-note historical snapshot and complete-export dialog prepared';
})();
