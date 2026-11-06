// Store ordered text/image nodes rather than HTML. Pasted markup never enters saved content.
function noteContent(note) {
  if (Array.isArray(note?.detailContent)) return note.detailContent;
  return [
    ...(note?.detail ? [{ type: 'text', text: note.detail }] : []),
    ...(note?.images || []).map((src) => ({ type: 'image', src })),
  ];
}
function appendContent(target, blocks) {
  for (const block of blocks) {
    if (block.type === 'text') target.append(document.createTextNode(block.text));
    else if (block.type === 'image') {
      const image = document.createElement('img');
      image.src = block.src;
      image.alt = '详细信息插图';
      image.draggable = false;
      target.append(image);
    }
  }
}
function openImageViewer(source, returnToEditor) {
  if (!source.naturalWidth) return;
  const container = source.closest('.rich-detail, .rich-preview');
  const pictures = container ? [...container.querySelectorAll('img')] : [source];
  let currentIndex = Math.max(0, pictures.indexOf(source));
  let naturalWidth = source.naturalWidth,
    naturalHeight = source.naturalHeight;
  let navigationVersion = 0,
    loading = false;
  const dialog = document.createElement('dialog');
  dialog.className = 'image-viewer';
  dialog.setAttribute('aria-label', '图片放大查看');
  const toolbar = document.createElement('div');
  toolbar.className = 'image-viewer-toolbar';
  const title = document.createElement('strong');
  title.textContent = '查看图片';
  toolbar.append(title);
  const stage = document.createElement('div');
  stage.className = 'image-viewer-stage';
  stage.tabIndex = 0;
  stage.setAttribute('aria-label', '图片区域，可拖动查看，滚轮缩放');
  const surface = document.createElement('div');
  surface.className = 'image-viewer-surface';
  const image = new Image();
  image.src = source.src;
  image.alt = source.alt || '事项图片';
  image.draggable = false;
  surface.append(image);
  stage.append(surface);
  const label = document.createElement('output');
  label.setAttribute('aria-label', '缩放比例');
  let scale = 1,
    fitMode = true,
    dragging = null;
  const paint = (next) => {
    if (loading) return;
    const previous = scale;
    const centerX = (stage.scrollLeft + stage.clientWidth / 2 - image.offsetLeft) / previous;
    const centerY = (stage.scrollTop + stage.clientHeight / 2 - image.offsetTop) / previous;
    scale = Math.max(0.05, Math.min(8, next));
    const width = naturalWidth * scale,
      height = naturalHeight * scale;
    surface.style.width = Math.max(width, stage.clientWidth) + 'px';
    surface.style.height = Math.max(height, stage.clientHeight) + 'px';
    image.style.width = width + 'px';
    image.style.height = height + 'px';
    image.style.left = Math.max(0, (stage.clientWidth - width) / 2) + 'px';
    image.style.top = Math.max(0, (stage.clientHeight - height) / 2) + 'px';
    stage.scrollLeft = centerX * scale + image.offsetLeft - stage.clientWidth / 2;
    stage.scrollTop = centerY * scale + image.offsetTop - stage.clientHeight / 2;
    label.textContent = Math.round(scale * 100) + '%';
  };
  const fit = () => {
    fitMode = true;
    paint(
      Math.min(
        1,
        (stage.clientWidth - 30) / naturalWidth,
        (stage.clientHeight - 30) / naturalHeight,
      ),
    );
  };
  const zoom = (factor) => {
    fitMode = false;
    paint(scale * factor);
  };
  const button = (text, name, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', name);
    button.onclick = action;
    toolbar.append(button);
    return button;
  };
  const previous = button('‹ 上一张', '上一张图片', () => showPicture(currentIndex - 1));
  const page = document.createElement('output');
  page.className = 'image-viewer-page';
  page.setAttribute('aria-label', '图片序号');
  page.setAttribute('aria-live', 'polite');
  toolbar.append(page);
  const next = button('下一张 ›', '下一张图片', () => showPicture(currentIndex + 1));
  const message = document.createElement('div');
  message.className = 'image-viewer-message';
  message.setAttribute('role', 'status');
  message.hidden = true;
  stage.append(message);
  const updateNavigation = () => {
    const focused = document.activeElement;
    page.textContent = `${currentIndex + 1} / ${pictures.length}`;
    previous.disabled = currentIndex === 0;
    next.disabled = currentIndex === pictures.length - 1;
    if ((focused === previous && previous.disabled) || (focused === next && next.disabled))
      stage.focus();
  };
  async function showPicture(index) {
    if (index < 0 || index >= pictures.length || index === currentIndex) return;
    const version = ++navigationVersion;
    currentIndex = index;
    updateNavigation();
    loading = true;
    image.style.visibility = 'hidden';
    message.hidden = false;
    message.textContent = '正在加载图片…';
    image.src = pictures[index].src;
    image.alt = pictures[index].alt || '事项图片';
    try {
      await image.decode();
      if (version !== navigationVersion || !dialog.open) return;
      naturalWidth = image.naturalWidth;
      naturalHeight = image.naturalHeight;
      loading = false;
      image.style.visibility = '';
      message.hidden = true;
      scale = 1;
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
      fit();
    } catch {
      if (version !== navigationVersion || !dialog.open) return;
      loading = false;
      message.textContent = '这张图片无法加载，请切换其他图片。';
    }
  }
  updateNavigation();
  button('−', '缩小图片', () => zoom(1 / 1.25));
  toolbar.append(label);
  button('＋', '放大图片', () => zoom(1.25));
  button('原图 100%', '按原图尺寸查看', () => {
    fitMode = false;
    paint(1);
  });
  button('适应窗口', '图片适应窗口', fit);
  const close = button('关闭 ×', '关闭图片查看器', () => dialog.close());
  dialog.append(toolbar, stage);
  document.body.append(dialog);
  dialog.showModal();
  fit();
  close.focus();
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
    event.preventDefault();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    stage.scrollLeft = dragging.left - event.clientX + dragging.x;
    stage.scrollTop = dragging.top - event.clientY + dragging.y;
  });
  const endDrag = () => {
    dragging = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showPicture(currentIndex - 1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      showPicture(currentIndex + 1);
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoom(1.25);
    }
    if (event.key === '-') {
      event.preventDefault();
      zoom(1 / 1.25);
    }
  });
  const resize = () => (fitMode ? fit() : paint(scale));
  window.addEventListener('resize', resize);
  dialog.addEventListener(
    'close',
    () => {
      navigationVersion++;
      window.removeEventListener('resize', resize);
      dialog.remove();
      returnToEditor?.();
    },
    { once: true },
  );
}
class DetailEditor {
  constructor(element, notify) {
    this.element = element;
    this.notify = notify;
    this.range = null;
    this.pending = Promise.resolve();
    this.generation = 0;
    this.imageSources = new Map();
    element.addEventListener('input', () => this.restoreImageSources());
    document.addEventListener('selectionchange', () => this.remember());
    element.addEventListener('paste', (event) => {
      event.preventDefault();
      this.remember();
      const files = [...event.clipboardData.items]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile());
      if (files.length) this.addImages(files);
      else this.insertText(event.clipboardData.getData('text/plain'));
    });
    element.addEventListener('dragover', (event) => event.preventDefault());
    element.addEventListener('drop', (event) => {
      event.preventDefault();
      // Move the insertion point to where the user dropped the file.
      const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (range && element.contains(range.startContainer)) this.range = range;
      if (event.dataTransfer.files.length) this.addImages(event.dataTransfer.files);
      else this.insertText(event.dataTransfer.getData('text/plain'));
    });
    element.addEventListener('click', (event) => {
      if (event.target.tagName !== 'IMG') return;
      const range = document.createRange();
      range.selectNode(event.target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.remember();
    });
    element.addEventListener('dblclick', (event) => {
      if (event.target.tagName !== 'IMG') return;
      event.preventDefault();
      event.stopPropagation();
      this.remember();
      openImageViewer(event.target, () => this.restore());
    });
  }
  restoreImageSources() {
    // Undo/redo can recreate the native insertion placeholder; restore its source.
    for (const image of this.element.querySelectorAll('img[data-image-id]')) {
      const src = this.imageSources.get(image.dataset.imageId);
      if (src && image.getAttribute('src') !== src) image.src = src;
    }
  }
  remember() {
    const selection = getSelection();
    if (
      selection.rangeCount &&
      this.element.contains(selection.anchorNode) &&
      this.element.contains(selection.focusNode)
    ) {
      this.range = selection.getRangeAt(0).cloneRange();
    }
  }
  restore() {
    this.element.focus();
    const range = this.range;
    if (!range || !this.element.contains(range.commonAncestorContainer)) {
      this.range = document.createRange();
      this.range.selectNodeContents(this.element);
      this.range.collapse(false);
    }
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(this.range);
  }
  load(note) {
    this.generation++;
    this.range = null;
    this.element.replaceChildren();
    this.imageSources.clear();
    appendContent(this.element, noteContent(note));
  }
  insertText(text) {
    this.restore();
    document.execCommand('insertText', false, text);
    this.remember();
  }
  addImages(files) {
    const batch = [...files];
    const generation = this.generation;
    this.remember();
    // Freeze editing while reading files so text typed during a read cannot move the insertion point.
    this.element.contentEditable = 'false';
    this.pending = this.pending
      .then(async () => {
        for (const file of batch) {
          if (generation !== this.generation) break;
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
            this.notify('支持 PNG、JPEG、WebP、GIF 图片');
            continue;
          }
          if (this.element.querySelectorAll('img').length >= 6) {
            this.notify('每条事项最多6张图片');
            break;
          }
          if (file.size > 2.8 * 1024 * 1024) {
            this.notify('单张图片请小于2.8 MB');
            continue;
          }
          const src = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(Error('读取图片失败'));
            reader.readAsDataURL(file);
          });
          // A MIME label does not prove that clipboard/file bytes form a valid image.
          const decoded = new Image();
          decoded.src = src;
          try {
            await decoded.decode();
          } catch {
            this.notify('图片无法读取，请重新截图或选择有效的图片文件');
            continue;
          }
          if (!decoded.naturalWidth || !decoded.naturalHeight) {
            this.notify('图片内容为空，请重新截图');
            continue;
          }
          if (generation !== this.generation) break;
          this.element.contentEditable = 'true';
          this.restore();
          const id = crypto.randomUUID();
          this.imageSources.set(id, src);
          // Pass only a small placeholder through the native HTML insertion pipeline.
          // Assign the validated data URL directly, avoiding HTML source rewriting.
          const inserted = document.execCommand(
            'insertHTML',
            false,
            `<img data-image-id="${id}" alt="详细信息插图" draggable="false">`,
          );
          const image = this.element.querySelector(`img[data-image-id="${id}"]`);
          if (!inserted || !image) {
            this.imageSources.delete(id);
            this.notify('未能插入图片，请点击详细信息中的插入位置后重试');
            continue;
          }
          image.src = src;
          try {
            await image.decode();
          } catch {
            image.remove();
            this.imageSources.delete(id);
            this.notify('图片显示失败，请重新选择图片');
            continue;
          }
          this.remember();
          this.element.contentEditable = 'false';
        }
      })
      .catch((error) => this.notify(error.message))
      .finally(() => {
        this.element.contentEditable = 'true';
      });
    return this.pending;
  }
  serialize() {
    this.restoreImageSources();
    if (
      [...this.element.querySelectorAll('img')].some(
        (image) => !image.complete || !image.naturalWidth,
      )
    ) {
      throw new Error('详细信息中有未加载成功的图片，请删除后重新插入再保存');
    }
    const blocks = [];
    const text = (value) => {
      if (!value) return;
      const last = blocks.at(-1);
      if (last?.type === 'text') last.text += value;
      else blocks.push({ type: 'text', text: value });
    };
    const newline = () => {
      if (blocks.length && !blocks.at(-1).text?.endsWith('\n')) text('\n');
    };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return text(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'IMG') {
        blocks.push({ type: 'image', src: node.src });
        return;
      }
      if (node.tagName === 'BR') return text('\n');
      const block = ['DIV', 'P', 'LI'].includes(node.tagName);
      if (block) newline();
      const trailingPlaceholder =
        block &&
        !node.nextSibling &&
        node.childNodes.length === 1 &&
        node.firstChild.nodeName === 'BR';
      if (!trailingPlaceholder) [...node.childNodes].forEach(walk);
      if (block && node.nextSibling) newline();
    };
    [...this.element.childNodes].forEach(walk);
    return blocks;
  }
}
