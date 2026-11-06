// Formatting, unsaved-change protection, and immutable archive management.
let editorBaseline = '',
  protectedDraft = null;
function editorValues() {
  const form = $('#note-form');
  return {
    fields: Object.fromEntries(
      ['title', 'category', 'date', 'until', 'repeat', 'time', 'end'].map((key) => [
        key,
        form.elements[key].value,
      ]),
    ),
    private: form.elements.private.checked,
    remind: form.elements.remind.checked,
    weekdays: [...$('#weekdays').querySelectorAll('input:checked')].map((input) => input.value),
    html: $('#detail-editor').innerHTML,
    newCategory: $('#new-category-name').value,
  };
}
window.markEditorSaved = () => {
  editorBaseline = JSON.stringify(editorValues());
};
function editorDirty() {
  return (
    $('#editor').open &&
    (JSON.stringify(editorValues()) !== editorBaseline || detailEditor.pendingImages > 0)
  );
}

$('#format-bold').onmousedown = (event) => {
  event.preventDefault();
  detailEditor.remember();
};
$('#format-bold').onclick = () => detailEditor.format('bold');
$('#format-heading').onmousedown = () => detailEditor.remember();
$('#format-heading').onchange = (event) => detailEditor.format('formatBlock', event.target.value);

let pendingClose = null;
function requestEditorClose() {
  if (!editorDirty()) {
    $('#editor').close();
    return Promise.resolve(true);
  }
  if (pendingClose) return pendingClose;
  pendingClose = new Promise((resolve) => {
    const dialog = $('#unsaved-dialog');
    dialog.addEventListener(
      'close',
      () => {
        const leave = ['saved', 'discard'].includes(dialog.returnValue);
        if (dialog.returnValue === 'discard') {
          protectedDraft = null;
          $('#restore-draft').hidden = true;
          $('#editor').close();
        }
        pendingClose = null;
        resolve(leave);
      },
      { once: true },
    );
    dialog.returnValue = 'cancel';
    dialog.showModal();
    $('#unsaved-cancel').focus();
  });
  return pendingClose;
}
$('#close-editor').onclick = requestEditorClose;
$('#editor').addEventListener('cancel', (event) => {
  event.preventDefault();
  requestEditorClose();
});
$('#unsaved-cancel').onclick = () => $('#unsaved-dialog').close('cancel');
$('#unsaved-discard').onclick = () => $('#unsaved-dialog').close('discard');
$('#unsaved-save').onclick = async () => {
  const button = $('#unsaved-save');
  button.disabled = true;
  try {
    if (!$('#note-form').checkValidity()) {
      $('#unsaved-dialog').close('cancel');
      $('#note-form').reportValidity();
      return;
    }
    if (await saveEditor()) $('#unsaved-dialog').close('saved');
  } finally {
    button.disabled = false;
  }
};
window.addEventListener('beforeunload', (event) => {
  if (editorDirty() || protectedDraft || $('#quick-title').value.trim()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
const visibilityClick = $('#visibility-toggle').onclick;
$('#visibility-toggle').onclick = async (event) => {
  if (
    visibilityToken &&
    ($('#note-form').elements.private.checked || editing?.private) &&
    editorDirty()
  ) {
    if (!(await requestEditorClose())) return;
  }
  return visibilityClick(event);
};
const originalClearVisibility = clearVisibility;
clearVisibility = function (message) {
  if (editorDirty() && ($('#note-form').elements.private.checked || editing?.private)) {
    protectedDraft = {
      values: editorValues(),
      note: editing ? structuredClone(editing) : null,
      day: privateContextDay,
      baseline: editorBaseline,
      nodes: [...$('#detail-editor').childNodes].map((node) => node.cloneNode(true)),
    };
    $('#restore-draft').hidden = false;
  }
  if ($('#unsaved-dialog').open) $('#unsaved-dialog').close('cancel');
  if ($('#archive-export-dialog').open) $('#archive-export-dialog').close();
  originalClearVisibility(message);
};
window.clearRecoveredDraft = () => {
  protectedDraft = null;
  $('#restore-draft').hidden = true;
};
$('#restore-draft').onclick = async () => {
  if (!protectedDraft) return;
  if (!visibilityToken) {
    toast('请先点击眼睛图标并验证密码，再恢复修改');
    return;
  }
  if ($('#editor').open && !(await requestEditorClose())) return;
  const draft = protectedDraft;
  await openEditor(draft.note, draft.day);
  if (!$('#editor').open) return;
  // Keep the draft's original revision so a later save cannot silently overwrite another window.
  if (draft.note && editing) editing.updated = draft.note.updated;
  const form = $('#note-form');
  editorCategories.add(draft.values.fields.category);
  updateCategoryOptions(draft.values.fields.category);
  for (const [key, value] of Object.entries(draft.values.fields)) form.elements[key].value = value;
  form.elements.private.checked = draft.values.private;
  form.elements.remind.checked = draft.values.remind;
  $('#weekdays')
    .querySelectorAll('input')
    .forEach((input) => (input.checked = draft.values.weekdays.includes(input.value)));
  $('#detail-editor').replaceChildren(...draft.nodes.map((node) => node.cloneNode(true)));
  detailEditor.range = null;
  updateRepeatFields();
  editorBaseline = draft.baseline;
  protectedDraft = null;
  $('#restore-draft').hidden = true;
  toast('未保存修改已恢复，请确认后保存');
};

let archiveState = [],
  exportingArchive = null;
async function loadArchives() {
  const response = await api('archives');
  archiveState = response.archives;
  $('#archive-frequency').value = response.schedule.frequency;
  const list = $('#archive-list');
  list.replaceChildren();
  if (!archiveState.length) {
    list.append(el('p', 'hint', '还没有存档。点击「立即存档全部事项」创建第一份快照。'));
    return;
  }
  for (const item of archiveState) {
    const row = el('div', 'archive-row'),
      text = el('div'),
      title = el('strong', '', item.title);
    text.append(title, el('p', 'hint', `${item.created.replace('T', ' ')} · ${item.count} 条事项`));
    const exportButton = el('button', '', '导出 HTML');
    exportButton.type = 'button';
    exportButton.onclick = () => {
      exportingArchive = item;
      $('#archive-export-form').reset();
      $('#archive-export-title').textContent = item.title;
      $('#archive-password-field').hidden = true;
      $('#archive-export-password').required = false;
      $('#archive-export-error').textContent = '';
      $('#archive-include-private').disabled = !item.hasProtected;
      $('#archive-export-dialog').showModal();
    };
    row.append(text, exportButton);
    list.append(row);
  }
}
$('#archives-open').onclick = async () => {
  try {
    await loadArchives();
    $('#archives-dialog').showModal();
  } catch (error) {
    toast(error.message);
  }
};
$('#archives-close').onclick = () => $('#archives-dialog').close();
$('#archive-create').onclick = async () => {
  const button = $('#archive-create');
  button.disabled = true;
  try {
    await api('archives/create', {});
    await loadArchives();
    toast('总体存档已生成，当前事项保持不变');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$('#archive-save-schedule').onclick = async () => {
  try {
    await api('archives/schedule', { frequency: $('#archive-frequency').value });
    toast('定期存档计划已保存');
  } catch (error) {
    toast(error.message);
  }
};
$('#archive-include-private').onchange = (event) => {
  if (event.target.checked && !visibilityToken) {
    event.target.checked = false;
    $('#archive-export-error').textContent =
      '请先关闭此面板，点击眼睛图标开启显示，再导出受保护事项';
  }
  $('#archive-password-field').hidden = !event.target.checked;
  $('#archive-export-password').required = event.target.checked;
};
$('#archive-export-close').onclick = () => $('#archive-export-dialog').close();
$('#archive-export-dialog').addEventListener('close', () => {
  $('#archive-export-form').reset();
  $('#archive-export-error').textContent = '';
});
$('#archive-export-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('archives/export', {
      id: exportingArchive.id,
      includePrivate: $('#archive-include-private').checked,
      password: $('#archive-export-password').value,
    });
    const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' })),
      link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('#archive-export-dialog').close();
    toast('HTML 已导出，图片已内嵌，可离线查看');
  } catch (error) {
    $('#archive-export-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

document.addEventListener('selectionchange', () => {
  const selection = getSelection();
  if (!selection.anchorNode || !$('#detail-editor').contains(selection.anchorNode)) return;
  const element =
    selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
  $('#format-heading').value = element.closest('h1,h2,h3')?.tagName.toLowerCase() || 'p';
  $('#format-bold').setAttribute('aria-pressed', String(document.queryCommandState('bold')));
});
