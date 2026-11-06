const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const parseDay = (s) => new Date(s + 'T12:00:00');
let state = { notes: [], completions: [] },
  view = 'list',
  status = 'all',
  category = '',
  month = new Date(),
  selected = today(),
  editing = null,
  busy = false;
let visibilityToken = '',
  visibilityDeadline = 0,
  visibilityTimer,
  visibilityWarning;
let editorCategories = new Set();
const expandedCategories = new Set(['']);
let toastTimer,
  privateAccess = '',
  privateAccessAt = 0,
  privateCompletedDays = [],
  privateContextDay = '';
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').style.display = 'none'), 4500);
}
async function api(path, body, privacyToken = '') {
  const r = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(privacyToken ? { 'X-Privacy-Token': privacyToken } : {}),
      ...(visibilityToken ? { 'X-Visibility-Token': visibilityToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 401 && !$('#login').open) $('#login').showModal();
    throw Error(data.error || '请求失败');
  }
  return data;
}
const occurs = (n, day) =>
  n.repeat === 'none'
    ? n.date === day
    : day >= n.date &&
      (!n.until || day <= n.until) &&
      (['daily', 'range'].includes(n.repeat) ||
        n.weekdays.includes((parseDay(day).getDay() + 6) % 7));
const done = (n, day) => state.completions.some((c) => c.note_id === n.id && c.day === day);
function occurrence(n) {
  if (n.repeat === 'none') return n.date;
  // Show today's/next occurrence; once the schedule ends, keep its last occurrence visible.
  const expired = n.until && n.until < today();
  let day = parseDay(expired ? n.until : today() > n.date ? today() : n.date);
  for (let i = 0; i < 8; i++) {
    if (occurs(n, iso(day))) return iso(day);
    day.setDate(day.getDate() + (expired ? -1 : 1));
  }
  if (n.until) {
    day = parseDay(n.until);
    for (let i = 0; i < 7; i++) {
      if (occurs(n, iso(day))) return iso(day);
      day.setDate(day.getDate() - 1);
    }
  }
  return n.date;
}
function late(n, day) {
  return (
    !done(n, day) &&
    (day < today() ||
      (day === today() &&
        !!(n.end || n.time) &&
        (n.end || n.time) < new Date().toTimeString().slice(0, 5)))
  );
}
function itemStateClass(n, day) {
  return n.private ? '' : done(n, day) ? 'done' : late(n, day) ? 'overdue' : 'pending';
}
function matches(n, day, filter = status) {
  const q = $('#search').value.toLowerCase();
  if (n.private)
    return (
      (!category || n.category === category) &&
      (!q || n.title.toLowerCase().includes(q)) &&
      filter === 'all'
    );
  return (
    (!category || n.category === category) &&
    (!q || (n.title + ' ' + n.detail).toLowerCase().includes(q)) &&
    (filter === 'all' ||
      (filter === 'done' && done(n, day)) ||
      (filter === 'pending' && !done(n, day)) ||
      (filter === 'overdue' && late(n, day)))
  );
}
function repeatLabel(n) {
  if (n.repeat === 'range') return `${n.date} 至 ${n.until} 每天`;
  const label =
    n.repeat === 'daily'
      ? '每天'
      : n.repeat === 'weekly'
        ? '每周' + n.weekdays.map((d) => '一二三四五六日'[d]).join('、')
        : '单次';
  return label + (n.repeat !== 'none' && n.until ? `（至 ${n.until}）` : '');
}
function card(n, day) {
  if (n.private) {
    const root = el('article', 'note private-note');
    const title = el('button', 'note-title', n.title);
    title.onclick = () => openEditor(n, day);
    root.append(title);
    return root;
  }
  const root = el('article', 'note ' + itemStateClass(n, day));
  const check = el('input', 'complete');
  check.type = 'checkbox';
  check.checked = done(n, day);
  check.setAttribute('aria-label', `${n.title} ${day} 标记完成`);
  check.onchange = async () => {
    check.disabled = true;
    try {
      await api('complete', { id: n.id, day, done: check.checked });
      await refresh();
    } catch (e) {
      check.checked = !check.checked;
      toast(e.message);
    } finally {
      check.disabled = false;
    }
  };
  root.append(check);
  const content = el('div', 'note-content'),
    title = el('button', 'note-title', n.title);
  title.onclick = () => openEditor(n, day);
  content.append(title);
  const blocks = noteContent(n);
  if (blocks.length) {
    const detail = el('div', 'detail rich-preview');
    appendContent(detail, blocks);
    content.append(detail);
    const expand = el('button', 'expand-detail', '展开详情');
    expand.onclick = () => {
      const expanded = detail.classList.toggle('expanded');
      expand.textContent = expanded ? '收起详情' : '展开详情';
    };
    content.append(expand);
    detail.querySelectorAll('img').forEach((img) => {
      img.onclick = () => openImageViewer(img);
      img.title = '点击放大查看';
    });
  }
  const meta = el('div', 'meta');
  meta.append(
    el('span', 'tag', n.category),
    el(
      'span',
      late(n, day) ? 'late' : '',
      day + (n.time ? '　' + n.time + (n.end ? '–' + n.end : '') : ''),
    ),
    el('span', '', repeatLabel(n)),
    el('span', '', done(n, day) ? '✓ 已完成' : late(n, day) ? '已逾期' : '待完成'),
  );
  if (n.remind) meta.append(el('span', '', '♧ 到时提醒'));
  content.append(meta);
  root.append(content);
  return root;
}
function empty(target) {
  const box = el('div', 'empty');
  box.append(
    el('strong', '', '留一点空间，记下一件事。'),
    el('span', '', '点击「记一件事」，或直接在上方输入。'),
  );
  target.append(box);
}
function renderCategories() {
  const box = $('#categories');
  box.replaceChildren();
  const names = [...new Set([...(state.categories || []), ...state.notes.map((n) => n.category)])]
    .filter(Boolean)
    .sort();
  const groups = [
    { key: '', label: '所有分类', notes: state.notes },
    ...names.map((name) => ({
      key: name,
      label: name,
      notes: state.notes.filter((n) => n.category === name),
    })),
  ];
  groups.forEach(({ key, label, notes }, index) => {
    const group = el('div', 'category-group'),
      row = el('div', 'category-row'),
      items = el('div', 'category-items');
    items.id = `category-items-${index}`;
    items.hidden = !expandedCategories.has(key);
    items.setAttribute('aria-label', label + '下的事项');
    if (notes.length) {
      const toggle = el('button', 'category-toggle', items.hidden ? '▸' : '▾');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(!items.hidden));
      toggle.setAttribute('aria-controls', items.id);
      const updateLabel = () =>
        toggle.setAttribute('aria-label', (items.hidden ? '展开' : '收起') + label + '事项列表');
      updateLabel();
      toggle.onclick = () => {
        items.hidden = !items.hidden;
        if (items.hidden) expandedCategories.delete(key);
        else expandedCategories.add(key);
        toggle.textContent = items.hidden ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', String(!items.hidden));
        updateLabel();
      };
      row.append(toggle);
    } else {
      row.append(el('span', 'category-toggle-spacer'));
      items.hidden = true;
      expandedCategories.delete(key);
    }
    const filter = el('button', 'category-filter' + (category === key ? ' active' : ''));
    filter.type = 'button';
    filter.title = label;
    filter.append(
      el('span', 'category-name', label),
      el('span', 'category-count', String(notes.length)),
    );
    filter.onclick = () => {
      category = key;
      render();
    };
    row.append(filter);
    for (const note of notes) {
      const child = el('button', 'category-child', note.title);
      child.type = 'button';
      child.title = note.title;
      child.setAttribute('aria-label', label + '：' + note.title + ' 查看详情');
      child.onclick = () => openEditor(note, occurrence(note));
      items.append(child);
    }
    group.append(row, items);
    box.append(group);
  });
}
function renderStatusCounts() {
  const labels = { all: '全部', pending: '待完成', done: '已完成', overdue: '已逾期' };
  const occurrences = state.notes.map((n) => ({ n, day: occurrence(n) }));
  document.querySelectorAll('[data-status]').forEach((button) => {
    const key = button.dataset.status,
      count = occurrences.filter(({ n, day }) => matches(n, day, key)).length;
    button.replaceChildren(
      document.createTextNode(labels[key]),
      el('span', 'status-count', String(count)),
    );
    button.setAttribute('aria-label', `${labels[key]}，${count}件事项`);
    if (key === 'pending') button.title = '所有未完成事项，包含已逾期事项';
  });
}
function render() {
  $('#today-label').textContent = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  renderCategories();
  updateCategoryOptions();
  renderStatusCounts();
  const rows = state.notes
    .map((n) => ({ n, day: occurrence(n) }))
    .filter(({ n, day }) => matches(n, day))
    .sort((a, b) => (a.day + (a.n.time || '99')).localeCompare(b.day + (b.n.time || '99')));
  $('#count').textContent = `${rows.length} 件事项`;
  $('#notes').replaceChildren();
  if (!rows.length) empty($('#notes'));
  rows.forEach(({ n, day }) => $('#notes').append(card(n, day)));
  $('#list-view').hidden = view !== 'list';
  $('#calendar-view').hidden = view !== 'calendar';
  $('#heading').textContent = view === 'calendar' ? '给每一天，留个位置。' : '把日常，安放好。';
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document
    .querySelectorAll('[data-status]')
    .forEach((b) => b.classList.toggle('active', b.dataset.status === status));
  renderCalendar();
}
function renderCalendar() {
  $('#month-label').textContent = `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`;
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const grid = $('#calendar');
  grid.replaceChildren();
  for (let i = 0; i < 42; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    const day = iso(d);
    const cell = el(
      'div',
      'day' +
        (d.getMonth() !== month.getMonth() ? ' other' : '') +
        (day === today() ? ' today' : '') +
        (day === selected ? ' selected' : ''),
    );
    cell.setAttribute('role', 'group');
    cell.setAttribute('aria-label', day + ' 查看事项');
    const dateButton = el('button', 'day-number', d.getDate());
    dateButton.type = 'button';
    dateButton.setAttribute('aria-label', day + ' 查看当天事项');
    cell.dataset.day = day;
    const header = el('div', 'calendar-date-header'),
      add = el('button', 'calendar-add', '＋');
    add.type = 'button';
    add.title = day + ' 添加事项';
    add.setAttribute('aria-label', day + ' 添加事项');
    add.onclick = (event) => {
      event.stopPropagation();
      selectCalendarDay(day);
      openEditor(null, day);
    };
    header.append(dateButton, add);
    cell.append(header);
    const notes = state.notes
      .filter((n) => occurs(n, day) && matches(n, day))
      .sort((a, b) => a.time.localeCompare(b.time));
    for (const n of notes.slice(0, 3)) {
      const event = el(
        'button',
        'event ' + itemStateClass(n, day),
        (!n.private && n.time ? n.time + ' ' : '') + n.title,
      );
      event.type = 'button';
      event.title = n.title;
      event.setAttribute('aria-label', `${day} ${n.title} 查看详情`);
      event.onclick = (e) => {
        e.stopPropagation();
        selected = day;
        renderCalendar();
        openEditor(n, day);
      };
      cell.append(event);
    }
    if (notes.length > 3) cell.append(el('div', 'event', `另有 ${notes.length - 3} 件`));
    cell.onclick = () => selectCalendarDay(day);
    cell.ondblclick = (event) => {
      if (event.target.closest('button')) return;
      event.preventDefault();
      selectCalendarDay(day);
      openEditor(null, day);
    };
    grid.append(cell);
  }
  renderDayPanel();
}
function selectCalendarDay(day) {
  selected = day;
  document
    .querySelectorAll('#calendar .day')
    .forEach((cell) => cell.classList.toggle('selected', cell.dataset.day === day));
  renderDayPanel();
}
function renderDayPanel() {
  const panel = $('#day-panel');
  panel.replaceChildren(el('h2', '', `${selected} 的事项`));
  const add = el('button', '', '＋ 在这一天记录');
  add.onclick = () => openEditor(null, selected);
  panel.append(add);
  const notes = state.notes.filter((n) => occurs(n, selected) && matches(n, selected));
  notes.forEach((n) => panel.append(card(n, selected)));
  if (!notes.length) empty(panel);
}
async function refresh() {
  const requestToken = visibilityToken;
  const next = await api('state');
  if (requestToken !== visibilityToken) return;
  if (visibilityToken && !next.visibility?.enabled)
    clearVisibility('显示授权已结束，受保护事项已隐藏');
  state = next;
  render();
}
function updateVisibilityIcon() {
  const button = $('#visibility-toggle'),
    enabled = !!visibilityToken;
  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('enabled', enabled);
  button.setAttribute('aria-label', enabled ? '隐藏受保护事项' : '显示受保护事项');
  button.title = enabled
    ? `已显示，剩余 ${Math.max(1, Math.ceil((visibilityDeadline - Date.now()) / 60000))} 分钟；点击关闭`
    : '显示受保护事项';
}
function clearVisibility(message) {
  visibilityToken = '';
  visibilityDeadline = 0;
  clearTimeout(visibilityTimer);
  clearTimeout(visibilityWarning);
  document.querySelectorAll('.image-viewer').forEach((dialog) => dialog.close());
  if ($('#privacy-unlock').open) $('#privacy-unlock').close();
  if ($('#editor').open && ($('#note-form').elements.private.checked || editing?.private))
    $('#editor').close();
  state.notes = state.notes.filter((note) => !note.private);
  const ids = new Set(state.notes.map((note) => note.id));
  state.completions = state.completions.filter((c) => ids.has(c.note_id));
  updateVisibilityIcon();
  render();
  if (message) toast(message);
}
function enableVisibility(access) {
  visibilityToken = access.visibilityToken;
  visibilityDeadline = Date.now() + access.remainingSeconds * 1000;
  clearTimeout(visibilityTimer);
  clearTimeout(visibilityWarning);
  visibilityTimer = setTimeout(() => {
    api('privacy/visibility/close', {}).catch(() => {});
    clearVisibility('显示授权已结束，受保护事项已隐藏');
  }, access.remainingSeconds * 1000);
  visibilityWarning = setTimeout(
    () => toast('显示授权将在1分钟后结束，请保存正在编辑的事项'),
    Math.max(0, access.remainingSeconds - 60) * 1000,
  );
  updateVisibilityIcon();
}
$('#visibility-toggle').onclick = async () => {
  try {
    if (visibilityToken) {
      const close = api('privacy/visibility/close', {});
      clearVisibility('受保护事项已隐藏');
      await close;
      return;
    }
    if (!(await api('privacy/settings')).configured) {
      await openPrivacySettings();
      toast('请先设置密码，再开启显示');
      return;
    }
    const access = await unlockPrivate(null);
    if (!access) return;
    enableVisibility(access);
    await refresh();
  } catch (error) {
    toast(error.message);
  }
};
setInterval(() => {
  if (visibilityToken) {
    if (Date.now() >= visibilityDeadline) clearVisibility('显示授权已结束，受保护事项已隐藏');
    else updateVisibilityIcon();
  }
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && visibilityToken) {
    if (Date.now() >= visibilityDeadline) clearVisibility('显示授权已结束，受保护事项已隐藏');
    else refresh().catch(() => clearVisibility('连接中断，受保护事项已隐藏'));
  }
});

async function openEditor(n = null, day = today()) {
  try {
    if (n?.private) {
      if (!visibilityToken) {
        toast('请先点击眼睛图标开启显示');
        return;
      }
      const access = await unlockPrivate(n);
      if (!access) return;
      privateAccess = access.accessToken;
      privateAccessAt = Date.now();
      privateCompletedDays = access.completedDays;
      n = access.note;
    } else privateAccess = '';
    showEditor(n, day);
  } catch (error) {
    toast(error.message);
  }
}
function showEditor(n = null, day = today()) {
  editing = n;
  privateContextDay = n && occurs(n, day) ? day : n ? occurrence(n) : day;
  updatePrivateCompletion();
  detailEditor.load(n);
  const f = $('#note-form');
  f.reset();
  editorCategories = new Set(n?.category ? [n.category] : []);
  updateCategoryOptions(n?.category || '未分类');
  $('#new-category-row').hidden = true;
  $('#new-category-name').value = '';
  $('#editor-title').textContent = n ? '编辑事项' : '记一件事';
  for (const key of ['title', 'category', 'date', 'until', 'repeat', 'time', 'end'])
    f.elements[key].value = n
      ? (n[key] ?? '')
      : key === 'date'
        ? day
        : key === 'repeat'
          ? 'none'
          : key === 'category'
            ? category || '未分类'
            : key === 'title'
              ? $('#quick-title').value
              : '';
  f.elements.remind.checked = n ? n.remind : false;
  f.elements.private.checked = !!n?.private;
  $('#weekdays').replaceChildren();
  for (let i = 0; i < 7; i++) {
    const label = el('label', '', '周' + '一二三四五六日'[i]);
    const input = el('input');
    input.type = 'checkbox';
    input.value = i;
    input.checked = n ? n.weekdays.includes(i) : i === (parseDay(day).getDay() + 6) % 7;
    label.prepend(input);
    $('#weekdays').append(label);
  }
  updateRepeatFields();
  $('#delete-note').hidden = !n;
  $('#editor').showModal();
  f.elements.title.focus();
}
function updateCategoryOptions(selectedValue) {
  const select = $('#category-select'),
    selectedCategory = selectedValue ?? select.value ?? '未分类';
  const categories = new Set([
    '未分类',
    ...(state.categories || []),
    ...state.notes.map((n) => n.category),
    ...editorCategories,
  ]);
  const names = [...categories]
    .filter(Boolean)
    .sort((a, b) => (a === '未分类' ? -1 : b === '未分类' ? 1 : a.localeCompare(b, 'zh-CN')));
  if (JSON.stringify([...select.options].map((option) => option.value)) !== JSON.stringify(names)) {
    select.replaceChildren();
    for (const name of names) {
      const option = el('option', '', name);
      option.value = name;
      select.append(option);
    }
  }
  const nextValue = categories.has(selectedCategory) ? selectedCategory : '未分类';
  if (select.value !== nextValue) select.value = nextValue;
}
$('#new-category').onclick = () => {
  $('#new-category-row').hidden = false;
  $('#new-category-name').focus();
};
$('#cancel-category').onclick = () => {
  $('#new-category-row').hidden = true;
  $('#new-category-name').value = '';
  $('#category-select').focus();
};
$('#add-category').onclick = async () => {
  const input = $('#new-category-name'),
    name = input.value.trim(),
    button = $('#add-category');
  if (!name) {
    toast('请输入分类名称');
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    await api('categories', { name });
    state.categories = [...new Set([...(state.categories || []), name])];
    editorCategories.add(name);
    updateCategoryOptions(name);
    $('#new-category-row').hidden = true;
    input.value = '';
    $('#category-select').focus();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
$('#new-category-name').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('#add-category').click();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    $('#cancel-category').click();
  }
};
function updatePrivateCompletion() {
  $('#private-completion').hidden = !editing?.private;
  $('#private-completion-day').textContent = privateContextDay + ' 的完成状态';
  $('#private-complete').textContent = privateCompletedDays.includes(privateContextDay)
    ? '取消这次完成'
    : '标记这次完成';
}
$('#private-complete').onclick = async () => {
  const button = $('#private-complete');
  button.disabled = true;
  try {
    const complete = !privateCompletedDays.includes(privateContextDay);
    await api(
      'complete',
      { id: editing.id, day: privateContextDay, done: complete },
      privateAccess,
    );
    privateCompletedDays = privateCompletedDays.filter((day) => day !== privateContextDay);
    if (complete) privateCompletedDays.push(privateContextDay);
    updatePrivateCompletion();
    toast(complete ? '这次事项已完成' : '已取消这次完成');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
};
function updateRepeatFields() {
  const f = $('#note-form'),
    range = f.elements.repeat.value === 'range',
    single = f.elements.repeat.value === 'none';
  $('#weekdays').hidden = f.elements.repeat.value !== 'weekly';
  $('#repeat-dates').hidden = single;
  f.elements.until.required = range;
  f.elements.until.disabled = single;
  f.elements.until.min = f.elements.date.value;
  $('#until-label').textContent = range ? '结束日期（包含当天）' : '重复截止日期（可选，包含当天）';
  $('#repeat-date-hint').textContent = range
    ? '从开始日期到结束日期，每天发生一次，包含首尾两天。'
    : '留空表示持续重复；截止日期当天仍按所选规则执行。';
}
const detailEditor = new DetailEditor($('#detail-editor'), toast);
$('#new').onclick = () => openEditor(null, view === 'calendar' ? selected : today());
$('#details').onclick = () => openEditor(null, view === 'calendar' ? selected : today());
$('#close-editor').onclick = () => $('#editor').close();
$('#note-form').elements.repeat.onchange = updateRepeatFields;
$('#note-form').elements.date.onchange = updateRepeatFields;
$('#editor').addEventListener('close', () => {
  const token = privateAccess;
  privateAccess = '';
  editing = null;
  privateCompletedDays = [];
  editorCategories.clear();
  $('#new-category-name').value = '';
  $('#new-category-row').hidden = true;
  detailEditor.load(null);
  $('#note-form').reset();
  if (token) api('privacy/close', {}, token).catch(() => {});
});
$('#note-form').elements.private.onchange = async (event) => {
  if (!event.target.checked) return;
  try {
    const settings = await api('privacy/settings');
    if (!settings.configured) {
      event.target.checked = false;
      await openPrivacySettings();
      toast('请先设置隐私密码，再开启隐私事项');
    }
  } catch (error) {
    event.target.checked = false;
    toast(error.message);
  }
};
$('#insert-image').onmousedown = (e) => {
  e.preventDefault();
  detailEditor.remember();
};
$('#insert-image').onclick = () => $('#images').click();
$('#images').onchange = (e) => {
  detailEditor.addImages(e.target.files);
  e.target.value = '';
};
$('#note-form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = event.submitter || $('#note-form button[type="submit"]');
  button.disabled = true;
  try {
    const form = event.target,
      n = {};
    for (const key of ['title', 'category', 'date', 'until', 'repeat', 'time', 'end'])
      n[key] = form.elements[key].value;
    n.remind = form.elements.remind.checked;
    n.private = form.elements.private.checked;
    n.weekdays = [...$('#weekdays').querySelectorAll('input:checked')].map((x) => +x.value);
    await detailEditor.pending;
    n.detailContent = detailEditor.serialize();
    n.detail = n.detailContent
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    n.images = n.detailContent.filter((b) => b.type === 'image').map((b) => b.src);
    if (editing) {
      n.id = editing.id;
      n.updated = editing.updated;
    }
    if (editing?.private && Date.now() - privateAccessAt > 540000) {
      const access = await unlockPrivate(editing);
      if (!access) return;
      privateAccess = access.accessToken;
      privateAccessAt = Date.now();
    }
    await api('save', n, privateAccess);
    $('#editor').close();
    $('#quick-title').value = '';
    await refresh();
    toast('已保存到本机');
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    button.disabled = false;
  }
};
$('#delete-note').onclick = async () => {
  if (!editing || !confirm('删除此事项及所有日期的完成记录？')) return;
  try {
    await api('delete', { id: editing.id }, privateAccess);
    $('#editor').close();
    await refresh();
    toast('事项已删除');
  } catch (e) {
    toast(e.message);
  }
};
async function quickAdd() {
  const input = $('#quick-title');
  if (!input.value.trim()) return input.focus();
  if (busy) return;
  busy = true;
  try {
    await api('save', {
      title: input.value,
      detail: '',
      category: category || '未分类',
      date: view === 'calendar' ? selected : today(),
      repeat: 'none',
      weekdays: [],
      time: '',
      end: '',
      remind: false,
      images: [],
    });
    input.value = '';
    await refresh();
    toast('已记录');
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}
$('#quick-add').onclick = quickAdd;
$('#quick-title').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) quickAdd();
};
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!$('#editor').open && !$('#login').open) openEditor();
  }
});
document.querySelectorAll('[data-view]').forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view;
      render();
    }),
);
document.querySelectorAll('[data-status]').forEach(
  (b) =>
    (b.onclick = () => {
      status = b.dataset.status;
      render();
    }),
);
$('#search').oninput = render;
$('#prev').onclick = () => {
  month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
  renderCalendar();
};
$('#next').onclick = () => {
  month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  renderCalendar();
};
$('#this-month').onclick = () => {
  month = new Date();
  selected = today();
  renderCalendar();
};
$('#connect').onclick = async () => {
  try {
    const c = await api('connection');
    const box = $('#connection-content');
    box.replaceChildren();
    box.append(
      el(
        'p',
        '',
        c.lan
          ? '已开启局域网连接。让手机与电脑接入同一 Wi-Fi，在手机浏览器打开下列链接。'
          : '当前仅允许本机访问。请关闭当前后台，再运行项目目录中的「手机同步版.cmd」以开启局域网访问。',
      ),
    );
    if (c.lan) {
      for (const url of c.urls) {
        const a = el('a', '', url.split('/#')[0]);
        a.href = url;
        box.append(a, el('br'));
      }
      box.append(el('p', '', '连接码（链接无法自动登录时填写）：'), el('code', '', c.token));
    }
    box.append(
      el(
        'p',
        '',
        '手机和电脑共用电脑上的同一份数据，页面每10秒更新。电脑需开机并运行后台；切勿将端口暴露到公网。局域网使用 HTTP，请仅在可信网络使用，连接链接与连接码等同于访问权限。',
      ),
    );
    box.append(
      el(
        'p',
        '',
        '当前版本不包含跨网络云同步、手机后台推送。手机页面关闭后不能提醒；事项提醒由电脑后台弹窗。',
      ),
    );
    $('#connection').showModal();
  } catch (e) {
    toast(e.message);
  }
};
$('#close-connect').onclick = () => $('#connection').close();
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('login', { token: $('#token').value.trim() });
    $('#login').close();
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
async function openPrivacySettings() {
  const settings = await api('privacy/settings');
  const form = $('#privacy-password-form');
  form.reset();
  $('#current-password-field').hidden = !settings.configured;
  form.elements.currentPassword.required = settings.configured;
  $('#privacy-settings-error').textContent = '';
  $('#privacy-password').showModal();
  (settings.configured ? form.elements.currentPassword : form.elements.newPassword).focus();
}
$('#privacy-settings').onclick = () => openPrivacySettings().catch((error) => toast(error.message));
$('#close-privacy-settings').onclick = () => $('#privacy-password').close();
$('#privacy-password').addEventListener('close', () => {
  $('#privacy-password-form').reset();
  $('#privacy-settings-error').textContent = '';
});
$('#privacy-password-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.target,
    button = event.submitter;
  if (form.elements.newPassword.value !== form.elements.confirmation.value) {
    $('#privacy-settings-error').textContent = '两次输入的密码不一致';
    return;
  }
  button.disabled = true;
  try {
    await api('privacy/password', {
      currentPassword: form.elements.currentPassword.value,
      newPassword: form.elements.newPassword.value,
    });
    $('#privacy-password').close();
    clearVisibility();
    toast('隐私密码已保存');
  } catch (error) {
    $('#privacy-settings-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
function unlockPrivate(note) {
  if ($('#privacy-unlock').open) return Promise.resolve(null);
  return new Promise((resolve) => {
    const dialog = $('#privacy-unlock'),
      form = $('#privacy-unlock-form');
    let result = null;
    form.reset();
    $('#privacy-unlock-title').textContent = note
      ? note.title
      : '开启后显示受保护事项，15分钟后自动关闭。';
    $('#privacy-unlock-error').textContent = '';
    dialog.addEventListener(
      'close',
      () => {
        form.reset();
        form.onsubmit = null;
        $('#privacy-unlock-title').textContent = '';
        $('#privacy-unlock-error').textContent = '';
        resolve(result);
      },
      { once: true },
    );
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        const access = await api(
          note ? 'privacy/open' : 'privacy/visibility/open',
          note
            ? { id: note.id, password: form.elements.password.value }
            : { password: form.elements.password.value },
        );
        if (!dialog.open) {
          if (note) api('privacy/close', {}, access.accessToken).catch(() => {});
          else
            fetch('/api/privacy/visibility/close', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Visibility-Token': access.visibilityToken,
              },
              body: '{}',
            }).catch(() => {});
          return;
        }
        result = access;
        dialog.close();
      } catch (error) {
        $('#privacy-unlock-error').textContent = error.message;
        form.elements.password.select();
      } finally {
        button.disabled = false;
      }
    };
    dialog.showModal();
    form.elements.password.focus();
  });
}
$('#close-privacy-unlock').onclick = () => $('#privacy-unlock').close();
async function start() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token) {
    history.replaceState(null, '', location.pathname);
    try {
      await api('login', { token });
    } catch (e) {
      toast(e.message);
    }
  }
  try {
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}
updateVisibilityIcon();
start();
setInterval(() => {
  if (!$('#login').open) refresh().catch(() => toast('暂时无法连接后台，正在等待恢复'));
}, 10000);
