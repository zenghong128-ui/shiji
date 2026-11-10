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
  exportingArchive = null,
  currentExportSummary = { count: 0, hasProtected: false };
async function loadArchives() {
  const response = await api('archives');
  archiveState = response.archives;
  currentExportSummary = response.current;
  $('#archive-current-count').textContent =
    `当前共 ${currentExportSummary.count} 条事项（包括已完成和受保护事项），导出不受页面筛选影响。`;
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
    const exportButton = el('button', '', '导出此历史快照');
    exportButton.type = 'button';
    exportButton.onclick = () => openArchiveExport(item);
    row.append(text, exportButton);
    list.append(row);
  }
}
function openArchiveExport(item) {
  exportingArchive = item;
  $('#archive-export-form').reset();
  updateExportRootLabel();
  const include = $('#archive-include-private');
  include.checked = item.scope === 'current' && item.hasProtected;
  include.disabled = item.scope === 'current' || !item.hasProtected;
  $('#archive-export-title').textContent =
    item.scope === 'current'
      ? `当前全部事项 · 当前共 ${item.count} 条。按点击导出时的最新数据生成，包括已完成事项；每个事项一份 HTML。`
      : `${item.title} · 历史快照 ${item.count} 条，并非当前全部事项。`;
  $('#archive-password-field').hidden = !include.checked;
  $('#archive-export-password').required = include.checked;
  $('#archive-export-error').textContent = '';
  $('#archive-export-dialog').showModal();
}
$('#archive-export-current').onclick = async () => {
  try {
    await loadArchives();
    openArchiveExport({ ...currentExportSummary, scope: 'current', id: 'current' });
  } catch (error) {
    toast(error.message);
  }
};
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
let archiveRoot = null,
  archiveRootRevision = 0,
  archiveExportBusy = false;
function supportsDirectoryExport() {
  return typeof window.showDirectoryPicker === 'function';
}
function updateExportRootLabel() {
  $('#archive-export-root').textContent = archiveRoot ? archiveRoot.name : '尚未选择目录';
  $('#archive-choose-root').disabled = !supportsDirectoryExport() || archiveExportBusy;
  $('#archive-export-submit').disabled = !supportsDirectoryExport() || archiveExportBusy;
  $('#archive-export-location-hint').textContent = supportsDirectoryExport()
    ? '将在所选位置新建独立存档文件夹，按分类生成子目录，每个事项一份 HTML，并附 index.html 总目录。'
    : '当前浏览器无法直接选择目录，请下载完整目录 ZIP，解压到需要的位置。';
}
function storeExportRoot(handle) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiji-export-preferences', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('directories');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        transaction = db.transaction('directories', handle ? 'readwrite' : 'readonly');
      const operation = handle
        ? transaction.objectStore('directories').put(handle, 'archiveRoot')
        : transaction.objectStore('directories').get('archiveRoot');
      transaction.oncomplete = () => {
        db.close();
        resolve(operation.result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
const initialRootRevision = archiveRootRevision;
storeExportRoot(null)
  .then((handle) => {
    if (handle && archiveRootRevision === initialRootRevision) {
      archiveRoot = handle;
      updateExportRootLabel();
    }
  })
  .catch(() => {});
async function chooseExportRoot() {
  const handle = await window.showDirectoryPicker({
    id: 'shiji-archive-export',
    mode: 'readwrite',
    ...(archiveRoot ? { startIn: archiveRoot } : { startIn: 'documents' }),
  });
  archiveRoot = handle;
  archiveRootRevision++;
  updateExportRootLabel();
  storeExportRoot(handle).catch(() => {});
  return handle;
}
$('#archive-choose-root').onclick = async () => {
  try {
    await chooseExportRoot();
    $('#archive-export-error').textContent = '';
  } catch (error) {
    if (error.name !== 'AbortError')
      $('#archive-export-error').textContent = '无法选择目录，请重新选择或下载目录 ZIP。';
  }
};
async function writeArchiveDirectory(root, bundle) {
  const paths = bundle.files.map((item) => {
    const parts = item.name.split('/');
    if (
      parts.length > 2 ||
      parts.some(
        (part) => !part || part === '.' || part === '..' || /[\\:*?"<>|\x00-\x1f]/.test(part),
      )
    )
      throw Error('导出文件路径不正确');
    return parts;
  });
  let name = bundle.directory;
  for (let suffix = 0; suffix < 1000; suffix++) {
    name = bundle.directory + (suffix ? '-' + (suffix + 1) : '');
    try {
      await root.getDirectoryHandle(name);
      continue;
    } catch (error) {
      if (error.name === 'TypeMismatchError') continue;
      if (error.name !== 'NotFoundError') throw error;
    }
    const directory = await root.getDirectoryHandle(name, { create: true });
    for (const [index, item] of bundle.files.entries()) {
      const parts = paths[index];
      const parent =
        parts.length === 2
          ? await directory.getDirectoryHandle(parts[0], { create: true })
          : directory;
      const file = await parent.getFileHandle(parts.at(-1), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(item.html);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    }
    return name;
  }
  throw Error('同名存档目录过多，请选择其他根目录');
}
function downloadExport(blob, filename) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function exportArchive(mode) {
  if (archiveExportBusy || !$('#archive-export-form').reportValidity()) return;
  archiveExportBusy = true;
  $('#archive-export-submit').disabled = true;
  $('#archive-export-zip').disabled = true;
  $('#archive-choose-root').disabled = true;
  $('#archive-export-error').textContent = '';
  try {
    // Request directory permission while still handling the click, before network/HTML work.
    let root = null;
    if (mode === 'directory') {
      if (!supportsDirectoryExport()) throw Error('请使用下载目录 ZIP');
      root = archiveRoot || (await chooseExportRoot());
      if ((await root.requestPermission({ mode: 'readwrite' })) !== 'granted')
        throw Error('需要所选目录的写入权限，也可以下载目录 ZIP');
    }
    if ($('#archive-include-private').checked && !visibilityToken) {
      if (exportingArchive.scope !== 'current') throw Error('请先开启眼睛开关，再导出受保护内容');
      const access = await api('privacy/visibility/open', {
        password: $('#archive-export-password').value,
      });
      enableVisibility(access);
    }
    const body = {
      id: exportingArchive.id,
      scope: exportingArchive.scope,
      includePrivate: $('#archive-include-private').checked,
      password: $('#archive-export-password').value,
      format: mode,
    };
    if (mode === 'zip') {
      const response = await fetch('/api/archives/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(visibilityToken ? { 'X-Visibility-Token': visibilityToken } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error((await response.json()).error || '导出失败');
      downloadExport(
        await response.blob(),
        'Shiji_导出_' + new Date().toISOString().replace(/[:.]/g, '-') + '.zip',
      );
      $('#archive-export-dialog').close();
      toast('完整目录 ZIP 已下载，解压后打开 index.html 查看');
    } else {
      const bundle = await api('archives/export', body);
      const name = await writeArchiveDirectory(root, bundle);
      $('#archive-export-dialog').close();
      toast(`已导出 ${bundle.count} 条事项到「${root.name}/${name}」，打开 index.html 查看`);
    }
  } catch (error) {
    if (error.name !== 'AbortError')
      $('#archive-export-error').textContent =
        error.message + '。若目录已部分写入，可重新导出；新导出不会覆盖旧目录。';
  } finally {
    archiveExportBusy = false;
    $('#archive-export-zip').disabled = false;
    updateExportRootLabel();
  }
}
$('#archive-export-form').onsubmit = async (event) => {
  event.preventDefault();
  await exportArchive('directory');
};
$('#archive-export-zip').onclick = () => exportArchive('zip');
updateExportRootLabel();

// Keep the resize handle outside the scrolling sidebar so it is always reachable.
(() => {
  const sidebar = document.querySelector('aside');
  sidebar.id = 'sidebar';
  const handle = el('div', 'sidebar-resizer');
  handle.id = 'sidebar-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-controls', 'sidebar');
  handle.setAttribute('aria-label', '调整左侧栏宽度');
  handle.title = '左右拖动调整宽度；双击恢复默认；方向键微调';
  sidebar.after(handle);
  const key = 'shiji-sidebar-width';
  let preferred = null,
    drag = null;
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored >= 175 && stored <= 560) preferred = stored;
  } catch {}
  const limits = () => ({ min: 175, max: Math.max(175, Math.min(560, innerWidth - 320)) });
  function applyWidth(width = preferred ?? (innerWidth <= 800 ? 175 : 236)) {
    const { min, max } = limits();
    const value = Math.round(Math.max(min, Math.min(max, width)));
    document.documentElement.style.setProperty('--sidebar-width', value + 'px');
    sidebar.classList.toggle('sidebar-compact', value < 230);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', value + ' 像素');
    return value;
  }
  function remember() {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch {}
  }
  handle.onpointerdown = (event) => {
    if (event.button !== 0 || innerWidth <= 560) return;
    event.preventDefault();
    handle.focus();
    drag = { x: event.clientX, width: sidebar.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-sidebar');
  };
  handle.onpointermove = (event) => {
    if (!drag) return;
    preferred = applyWidth(drag.width + event.clientX - drag.x);
  };
  function finishDrag() {
    if (!drag) return;
    drag = null;
    document.body.classList.remove('resizing-sidebar');
    remember();
  }
  handle.onpointerup = finishDrag;
  handle.onpointercancel = finishDrag;
  handle.onlostpointercapture = finishDrag;
  handle.ondblclick = () => {
    preferred = null;
    applyWidth();
    remember();
  };
  handle.onkeydown = (event) => {
    const { min, max } = limits();
    const current = sidebar.getBoundingClientRect().width;
    const values = { ArrowLeft: current - 16, ArrowRight: current + 16, Home: min, End: max };
    if (!(event.key in values)) return;
    event.preventDefault();
    preferred = applyWidth(values[event.key]);
    remember();
  };
  addEventListener('resize', () => {
    finishDrag();
    applyWidth();
  });
  applyWidth();
})();

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
