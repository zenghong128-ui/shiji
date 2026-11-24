// Evaluate as UTF-8 in an authenticated isolated browser on port 8774.
(async () => {
  if (location.port !== '8774') throw Error('Use the isolated formatting test server');
  const results = [];
  const assert = (ok, label) => {
    if (!ok) throw Error(label);
    results.push(label);
  };
  const box = document.querySelector('#detail-editor');
  const select = (node, collapsed = true) => {
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    if (collapsed) range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    detailEditor.remember();
  };
  box.innerHTML = '<h1>Meeting title</h1><h1>Section one</h1><h2>Section two</h2>';
  box.focus();
  const boundary = document.createRange();
  boundary.setStart(box, 1);
  boundary.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(boundary);
  detailEditor.remember();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    document.querySelector('#format-heading').value === 'h1',
    'Heading state is correct at a block boundary',
  );
  box.innerHTML =
    '<h1>Meeting title</h1><h2><span style="font-size:27px;font-weight:700">Section one</span></h2><p>Untouched text</p>';
  select(box.children[1].firstChild);
  detailEditor.format('formatBlock', 'p');
  assert(
    box.children[1].tagName === 'P' &&
      getComputedStyle(box.children[1].firstChild).fontSize === '15px',
    'Body format removes inherited inline font size',
  );
  assert(
    getComputedStyle(box.children[1].firstChild).fontWeight === '400',
    'Body format removes stale inline font weight',
  );
  assert(
    box.children[0].tagName === 'H1' && box.children[2].textContent === 'Untouched text',
    'Formatting stays within the current paragraph',
  );
  for (const [tag, size] of [
    ['h1', '27px'],
    ['h2', '23px'],
    ['h3', '19px'],
    ['p', '15px'],
  ]) {
    select(box.children[1]);
    detailEditor.format('formatBlock', tag);
    assert(
      box.children[1].tagName.toLowerCase() === tag &&
        getComputedStyle(box.children[1]).fontSize === size &&
        document.querySelector('#format-heading').value === tag,
      `Switch to ${tag} updates size and toolbar`,
    );
  }
  select(box.children[1], false);
  detailEditor.format('bold');
  assert(
    !!box.children[1].querySelector('b,strong') &&
      document.querySelector('#format-bold').getAttribute('aria-pressed') === 'true',
    'Bold applies to selected body text and updates toolbar',
  );
  detailEditor.format('bold');
  assert(!box.children[1].querySelector('b,strong'), 'Bold toggles off');
  box.innerHTML =
    '<h1>Meeting title</h1><h2><strong>Section one</strong><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></h2><p>Untouched text</p>';
  select(box.children[1].firstChild);
  document.querySelector('#format-clear').click();
  assert(
    box.children[1].tagName === 'P' && !box.children[1].querySelector('strong,b'),
    'Clear formatting converts current heading to normal body',
  );
  assert(
    box.querySelectorAll('img').length === 1 && box.children[0].tagName === 'H1',
    'Clear formatting preserves images and other headings',
  );
  select(box.children[1]);
  detailEditor.format('formatBlock', 'h3');
  document.execCommand('undo');
  assert(box.children[1].tagName === 'P', 'Heading change supports native undo');
  const title = 'Formatting regression ' + Date.now();
  document.querySelector('#note-form').elements.title.value = title;
  assert(await saveEditor(), 'Formatted note saves successfully');
  const note = state.notes.find((n) => n.title === title);
  await openEditor(note);
  assert(
    box.children[0].tagName === 'H1' &&
      box.children[1].tagName === 'P' &&
      box.querySelectorAll('img').length === 1,
    'Saved and reopened note preserves corrected formatting and images',
  );
  document.querySelector('#editor').close();
  return results;
})();
