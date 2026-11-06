// Run using agent-browser eval --stdin on the isolated test server after uploading a PNG fixture.
(async () => {
  if (location.port !== '8766') throw Error('Run only on the isolated test server');
  const box = document.querySelector('#detail-editor');
  const fixture = box.querySelector('img')?.src;
  if (!fixture) throw Error('Upload a PNG fixture into the test editor first');
  const valid = new File([await (await fetch(fixture)).blob()], 'clipboard.png', {type:'image/png'});
  const invalid = new File(['not an image'], 'broken.png', {type:'image/png'});
  const results = [];
  const assert = (ok, name) => { if (!ok) throw Error(name); results.push(name); };
  const paste = async file => {
    const data = new DataTransfer(); data.items.add(file);
    box.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true}));
    await detailEditor.pending;
  };
  box.replaceChildren(document.createTextNode('before|after'));
  box.focus();
  const range = document.createRange();range.setStart(box.firstChild,7);range.collapse(true);
  getSelection().removeAllRanges();getSelection().addRange(range);detailEditor.remember();
  await paste(valid);
  assert(box.querySelector('img')?.naturalWidth > 0, 'Clipboard PNG decodes and displays');
  assert(detailEditor.serialize().map(b=>b.type).join(',')==='text,image,text', 'Image stays between text segments');
  await paste(invalid);
  assert(box.querySelectorAll('img').length===1, 'Invalid clipboard bytes do not insert a broken image');
  assert(document.querySelector('#toast').textContent.includes('无法读取'), 'Invalid image produces a readable error');
  assert(box.textContent==='before|after', 'Failed insertion preserves surrounding text');
  const title = 'Image regression '+Date.now();
  document.querySelector('[name=title]').value=title;
  document.querySelector('#note-form').requestSubmit();
  for(let i=0;i<100 && document.querySelector('#editor').open;i++) await new Promise(r=>setTimeout(r,20));
  assert(!document.querySelector('#editor').open,'Valid content saves after a rejected image');
  let button;
  for(let i=0;i<100;i++) {
    button=[...document.querySelectorAll('.note-title')].find(b=>b.textContent===title);
    if(button) break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert(!!button,'Saved record appears in list');button.click();
  await Promise.all([...box.querySelectorAll('img')].map(i=>i.decode()));
  assert(box.querySelector('img')?.naturalWidth>0,'Saved image displays when editor reopens');
  assert(detailEditor.serialize().map(b=>b.type).join(',')==='text,image,text','Saved content preserves image position');
  // A previously saved broken image must not lock the Save button or clear the draft.
  const bad = document.createElement('img');bad.src='data:image/png;base64,AAAA';box.append(bad);
  await new Promise(r=>setTimeout(r,30));
  document.querySelector('#note-form').requestSubmit();
  await new Promise(r=>setTimeout(r,50));
  assert(document.querySelector('#editor').open && !document.querySelector('#note-form button[type=submit]').disabled,
    'Broken existing image blocks save without locking the editor');
  bad.remove();
  return results;
})()
