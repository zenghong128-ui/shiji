// Run in an authenticated isolated browser on port 8774 with the note editor open.
(async () => {
  if (location.port !== '8774') throw Error('Use isolated test server');
  const results = [];
  const assert = (ok, label) => {
    if (!ok) throw Error(label);
    results.push(label);
  };
  const editor = document.querySelector('#editor');
  const box = document.querySelector('#detail-editor');
  const form = document.querySelector('#note-form');
  if (editor.classList.contains('detail-fullscreen')) setDetailFullscreen(false);
  form.elements.title.value = 'Fullscreen regression ' + Date.now();
  box.innerHTML =
    '<h1>Meeting title</h1><p>Selected words</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' +
    '<p>More content</p>'.repeat(60);
  const originalNode = box.firstChild;
  markEditorSaved();
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box.children[1]);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  detailEditor.remember();
  document.querySelector('#detail-fullscreen').click();
  assert(
    editor.classList.contains('detail-fullscreen') && box.firstChild === originalNode,
    'Fullscreen reuses the existing text and image DOM',
  );
  assert(!editorDirty(), 'Entering fullscreen does not mark unchanged content dirty');
  const bounds = editor.getBoundingClientRect();
  assert(
    bounds.x === 0 &&
      bounds.y === 0 &&
      bounds.width === innerWidth &&
      bounds.height === innerHeight,
    'Editor fills the application viewport',
  );
  document.querySelector('#format-bold').click();
  assert(
    !!box.children[1].querySelector('strong,b'),
    'Formatting preserves the selection in fullscreen',
  );
  box.scrollTop = box.scrollHeight;
  const saveBounds = document.querySelector('#detail-fullscreen-save').getBoundingClientRect();
  assert(
    saveBounds.y >= 0 && saveBounds.bottom < innerHeight,
    'Save remains visible while the document scrolls',
  );
  const beforeExit = box.innerHTML;
  editor.dispatchEvent(new Event('cancel', { cancelable: true }));
  assert(
    !editor.classList.contains('detail-fullscreen') && editor.open && box.innerHTML === beforeExit,
    'Escape exits fullscreen and preserves the draft',
  );
  editor.dispatchEvent(new Event('cancel', { cancelable: true }));
  assert(
    document.querySelector('#unsaved-dialog').open,
    'Closing the dirty editor still asks to save',
  );
  document.querySelector('#unsaved-cancel').click();
  document.querySelector('#detail-fullscreen').click();
  const title = form.elements.title.value;
  await document.querySelector('#detail-fullscreen-save').onclick();
  assert(
    !editor.open && !editor.classList.contains('detail-fullscreen'),
    'Fullscreen save persists and closes the item cleanly',
  );
  const note = state.notes.find((note) => note.title === title);
  await openEditor(note);
  assert(
    box.querySelector('h1')?.textContent === 'Meeting title' &&
      box.querySelectorAll('img').length === 1 &&
      !!box.querySelector('strong,b'),
    'Reopened item retains headings, bold text and images',
  );
  form.elements.title.value = '';
  document.querySelector('#detail-fullscreen').click();
  await document.querySelector('#detail-fullscreen-save').onclick();
  assert(
    editor.open &&
      !editor.classList.contains('detail-fullscreen') &&
      document.activeElement === form.elements.title,
    'Missing title returns to the form and focuses validation',
  );
  form.elements.title.value = title;
  form.elements.remind.checked = true;
  form.elements.time.value = '';
  document.querySelector('#detail-fullscreen').click();
  await document.querySelector('#detail-fullscreen-save').onclick();
  assert(
    editor.open &&
      !editor.classList.contains('detail-fullscreen') &&
      !document.querySelector('#save-error').hidden,
    'Invalid reminder returns to visible metadata and keeps the draft',
  );
  form.elements.remind.checked = false;
  document.querySelector('#detail-fullscreen').click();
  return results;
})();
