// Run with agent-browser eval --stdin after logging into an isolated server on 8774.
(async () => {
  if (location.port !== '8774') throw Error('Use an isolated test server on port 8774');
  const results = [];
  const assert = (condition, label) => {
    if (!condition) throw Error(label);
    results.push(label);
  };
  const suffix = Date.now();
  const day = today();
  const tomorrow = parseDay(day);
  tomorrow.setDate(tomorrow.getDate() + 1);
  await api('save', {
    title: `已完成回归 ${suffix}`,
    category: '测试工作',
    date: day,
    repeat: 'daily',
    time: '',
    end: '',
    remind: false,
    detail: '保留在月历中的完成记录',
  });
  await api('save', {
    title: `待完成回归 ${suffix}`,
    category: '测试生活',
    date: day,
    repeat: 'none',
    time: '',
    end: '',
    remind: false,
    detail: '',
  });
  await refresh();
  const note = state.notes.find((n) => n.title === `已完成回归 ${suffix}`);
  await api('complete', { id: note.id, day, done: true });
  await refresh();
  category = '测试生活';
  status = 'pending';
  $('#search').value = '待完成';
  render();
  document.querySelector('[data-view="calendar"]').click();
  const cell = document.querySelector(`[data-day="${day}"]`);
  const completed = [...cell.querySelectorAll('.event.done')].find((e) =>
    e.textContent.includes(suffix),
  );
  assert(!!completed, 'Entering month view restores completed items from another category');
  assert(
    !category && status === 'all' && !$('#search').value,
    'Calendar opens with all categories and statuses',
  );
  assert(
    getComputedStyle(completed).textDecorationLine === 'none',
    'Completed calendar items have no strikethrough',
  );
  assert(
    getComputedStyle(completed).backgroundColor !==
      getComputedStyle(cell.querySelector('.event.pending')).backgroundColor,
    'Completed and pending items use different backgrounds',
  );
  selectCalendarDay(day);
  assert(
    $('#day-panel').textContent.includes(note.title),
    'Selected day includes the completed item',
  );
  assert(!done(note, iso(tomorrow)), 'Completing one occurrence leaves the next date incomplete');
  category = '测试生活';
  render();
  assert(
    $('#calendar-filter-summary').textContent.includes('测试生活'),
    'Active category is explicitly shown',
  );
  assert(
    ![...document.querySelectorAll('#calendar .event')].some((e) =>
      e.textContent.includes(note.title),
    ),
    'Explicit category filters still apply',
  );
  $('#calendar-filter-summary button').click();
  assert(
    [...document.querySelectorAll('#calendar .event.done')].some((e) =>
      e.textContent.includes(note.title),
    ),
    'Clear filters restores completed items',
  );
  status = 'done';
  render();
  assert(
    !document.querySelector('#calendar .event.pending'),
    'Completed-only filter excludes unfinished occurrences',
  );
  const event = [...document.querySelectorAll('#calendar .event.done')].find((e) =>
    e.textContent.includes(note.title),
  );
  event.click();
  for (let i = 0; i < 100 && !$('#editor').open; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(
    $('#editor').open && $('#note-form').elements.title.value === note.title,
    'Completed calendar item opens its details',
  );
  $('#editor').close();
  return results;
})();
