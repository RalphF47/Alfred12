// Alfred interface — talks to app/alfred_server.pl, which reads/writes the markdown files.
'use strict';
let S = null;                       // server state
let DONE = [];                      // finished tasks, cached per render (for fading finished Canvas items)
const UI = {
  tab: 'brief', day: null, weekOffset: 0, briefDate: null, briefOpen: pref('briefOpen', false),
  calView: pref('calView', 'week'), calWeekOffset: 0, calY: null, calM: null, selDate: null,
  filter: 'all', inboxOpen: null,
};
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
function pref(k, d) { try { const v = localStorage.getItem('alfred.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function savePref(k, v) { try { localStorage.setItem('alfred.' + k, JSON.stringify(v)); } catch (e) {} }

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(s) {
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  return h;
}
const plain = s => String(s || '').replace(/\*\*/g, '');
const D = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a, b) => Math.round((D(a) - D(b)) / 86400000);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortDate = s => { const d = D(s); return `${WD[d.getDay()]} ${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
const mondayOf = s => { const d = D(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return ymd(d); };
function dayName(d) {
  const n = diffDays(d, S.today);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : WD[D(d).getDay()];
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const m2t = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
function fmt12(t) {
  let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
}
function fmtRange(s, e) {
  if (!e) return fmt12(s);
  const a = fmt12(s), b = fmt12(e);
  return a.slice(-2) === b.slice(-2) ? a.slice(0, -3) + '–' + b : a + '–' + b;
}
const parseTime = s => { const m = String(s || '').match(/(\d{1,2}):(\d\d)/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };

// ---------- courses & labels ----------
const CODES = { ecmt: 'ECMT', econ: 'ECON', geol: 'GEOL', ansc: 'ANSC', pbsi: 'PBSI', lsat: 'LSAT', gym: 'GYM', band: 'BAND', other: '' };
function courseKey(s) {
  s = String(s || '').toLowerCase();
  for (const k of ['ecmt', 'econ', 'geol', 'ansc', 'pbsi']) if (s.includes(k)) return k;
  if (/lsat|7sage/.test(s)) return 'lsat';
  if (/\bgym\b/.test(s)) return 'gym';
  if (/\bband\b/.test(s)) return 'band';
  return 'other';
}
const COURSE_TAGS = { ecmt461: 'ECMT 461', econ410: 'ECON 410', geol207: 'GEOL 207', ansc107: 'ANSC 107', pbsi352: 'PBSI 352' };

// Canvas titles are long; keep the part that tells you what it is.
function shortTitle(t) {
  return String(t)
    .replace(/\s*-\s*Requires Respondus.*$/i, '')
    .replace(/\s*\[worth[^\]]*\]/i, '')
    .replace(/^Extra Credit Mini-Assignment\s*-\s*/i, 'Extra credit: ')
    .replace(/^Group Logistics for Major Assignment:.*$/i, 'Media video: group logistics')
    .replace(/^Group Evaluation and Reflection for .*$/i, 'Media video: group reflection')
    .replace(/^Major Assignment:\s*Team Video Report on\s*/i, 'Team video: ')
    .replace(/^Individual Assignment #(\d+):\s*/i, 'Assignment #$1: ')
    .replace(/^Mini[- ]Assignment:\s*/i, '')
    .replace(/^What is wrong with the\s*/i, '')
    .replace(/Video Reviews - Week (\d+)\s*(\(EXTRA CREDIT\))?/i, (m, n, ec) => `Video reviews wk ${n}${ec ? ' (extra credit)' : ''}`)
    .replace(/['"]/g, '');
}
const isExam = t => /\bexam\b/i.test(t) && !/exam\s*\d*\s*review/i.test(t);

// A Canvas item counts as finished when a checked-off task clearly names it.
const STOP = new Set(['the', 'and', 'for', 'with', 'due', 'mini', 'assignment', 'major', 'requires']);
const words = s => (String(s).toLowerCase().match(/[a-z0-9#]+/g) || []).filter(w => (/\d/.test(w) || w.length > 2) && !STOP.has(w));
function isDoneCanvas(c) {
  const key = courseKey(c.course), cw = words(c.title.replace(/\[.*?\]/g, ''));
  if (!cw.length) return false;
  return DONE.some(t => {
    if (courseKey(t.tags.join(' ') + ' ' + t.text) !== key) return false;
    const tw = new Set(words(t.text));
    return cw.filter(w => tw.has(w)).length / cw.length >= 0.6;
  });
}

function dueLabel(due) {
  if (!due) return '';
  const n = diffDays(due, S.today);
  if (n < 0) return `<span class="due over">overdue ${-n}d</span>`;
  if (n === 0) return `<span class="due over">due today</span>`;
  if (n === 1) return `<span class="due soon">due tomorrow</span>`;
  if (n <= 6) return `<span class="due soon">due ${WD[D(due).getDay()]}</span>`;
  return `<span class="due">due ${shortDate(due)}</span>`;
}
const tagChip = t => `<span class="tag c-${courseKey(t)}">${esc(COURSE_TAGS[t] || '#' + t)}</span>`;
function allTasks() { return S.tasks.flatMap(s => s.items.map(i => ({ ...i, section: s.name }))); }
function allTags() {
  const set = new Set(Object.keys(COURSE_TAGS));
  allTasks().forEach(t => t.tags.forEach(x => set.add(x)));
  return [...set];
}
function tagOptions(sel = '') {
  return `<option value="">No tag</option>` + allTags().map(t => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(COURSE_TAGS[t] || '#' + t)}</option>`).join('');
}
const sectionOptions = () => ['Auto', 'Today', 'This Week', 'Later', 'Waiting On'].map(s => `<option>${s}</option>`).join('');

// ---------- what's on a day ----------
// Recurring blocks from schedule.md that fall on a date (honours Skip/From/Until and day overrides).
function scheduleOn(date) {
  const sch = S.schedule; if (!sch) return [];
  const dow = sch.overrides[date] ?? D(date).getDay();
  return sch.sections.filter(s => !s.skip.includes(date) && (!s.from || date >= s.from) && (!s.until || date <= s.until))
    .flatMap(s => s.items.filter(i => i.days.includes(dow)))
    .map(b => ({ start: toMin(b.start), end: b.end ? toMin(b.end) : toMin(b.start) + 50, s: b.start, e: b.end,
                 label: b.text.replace(/\s*\(.*?\)/g, ''), key: courseKey(b.tags.join(' ') + ' ' + b.text) }))
    .sort((a, b) => a.start - b.start);
}
function dueOn(date) {
  return S.canvas.items.filter(c => c.date === date).map(c => ({
    key: courseKey(c.course), code: CODES[courseKey(c.course)] || c.course, label: shortTitle(c.title), full: c.title,
    url: c.url, exam: isExam(c.title), done: isDoneCanvas(c),
  })).sort((a, b) => (b.exam - a.exam) || (a.done - b.done));
}
function eventsOn(date) {
  return S.calendar.filter(e => e.date === date).map(e => {
    const t = parseTime(e.time);
    return { ref: e, time: t, start: t ? toMin(t) : null, label: plain(e.text), key: courseKey(e.tags.join(' ') + ' ' + e.text), exam: isExam(e.text) };
  });
}
// Open stretches of 1h+ between 8 AM and 9 PM (from now, if it's today). None on show/travel days.
function freeGaps(date) {
  const ev = eventsOn(date);
  if (ev.some(e => e.key === 'band' && e.start == null)) return [];
  const busy = [...scheduleOn(date).map(b => [b.start, b.end]), ...ev.filter(e => e.start != null).map(e => [e.start, e.start + 75])]
    .sort((a, b) => a[0] - b[0]);
  let t = 8 * 60; const end = 21 * 60, gaps = [];
  if (date === S.today) { const n = new Date(); t = Math.max(t, Math.ceil((n.getHours() * 60 + n.getMinutes()) / 15) * 15); }
  if (date < S.today) return [];
  for (const [s, e] of busy) { if (s - t >= 60) gaps.push([t, s]); t = Math.max(t, e); }
  if (end - t >= 60) gaps.push([t, end]);
  return gaps;
}

// Side-by-side lanes for overlapping blocks. Adds .lane and .lanes; returns inline left/width CSS per item.
function lanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  let cluster = [], ends = [], clusterEnd = -1;
  const flush = () => { const n = ends.length; cluster.forEach(it => it.lanes = n); cluster = []; ends = []; };
  for (const it of sorted) {
    if (it.start >= clusterEnd) { flush(); clusterEnd = -1; }
    let l = ends.findIndex(e => e <= it.start);
    if (l < 0) { l = ends.length; ends.push(it.end); } else ends[l] = it.end;
    it.lane = l; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return sorted;
}
const laneCSS = (it, pad) => it.lanes > 1
  ? `left:calc(${pad}px + (100% - ${pad * 2}px) * ${it.lane / it.lanes});width:calc((100% - ${pad * 2}px) / ${it.lanes} - 2px);right:auto;` : '';

// ---------- shared pieces ----------
function dueRow(d) {
  const inner = `<span class="code">${esc(d.code)}</span><span class="lbl">${esc(d.label)}</span>${d.exam ? '<span class="pill">Exam</span>' : ''}${d.done ? '<span class="chk">✓</span>' : ''}`;
  const cls = `drow c-${d.key} ${d.done ? 'done' : ''} ${d.exam ? 'exam' : ''}`;
  return d.url ? `<a class="${cls}" href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(d.full)}">${inner}</a>`
               : `<div class="${cls}" title="${esc(d.full)}">${inner}</div>`;
}
function eventRow(e, del) {
  return `<div class="drow event c-${e.key} ${e.exam ? 'exam' : ''}" title="${esc(e.label)}"><span class="code">${e.time ? esc(fmt12(e.time)) : '◆'}</span>
    <span class="lbl">${esc(e.label)}</span>${del ? `<button class="btn ghost x" data-act="cal-del" data-line="${e.ref.line}" title="Remove from calendar.md">×</button>` : ''}</div>`;
}
const chip = (label, key, cls = '', title = '', url = '') => url
  ? `<a class="chip-ev c-${key} ${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title || label)}">${esc(label)}</a>`
  : `<span class="chip-ev c-${key} ${cls}" title="${esc(title || label)}">${esc(label)}</span>`;

// ---------- server ----------
async function load() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  S = await r.json(); render();
}
async function post(path, body, msg) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    S = j; render(); if (msg) toast(msg);
  } catch (e) { toast(e.message, true); load(); }
}
function toast(m, err) {
  const t = $('#toast'); t.textContent = m; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.className = 'toast', 2600);
}

// ---------- render ----------
function render() {
  if (!S) return;
  DONE = allTasks().filter(t => t.done);
  if (!UI.day) UI.day = S.today;
  if (!UI.selDate) UI.selDate = S.today;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === UI.tab));
  $('#today-label').textContent = shortDate(S.today) + ', ' + D(S.today).getFullYear();
  $('#inbox-count').textContent = S.inbox.length || '';
  const r = { brief: renderBrief, calendar: renderCalendar, tasks: renderTasks, inbox: renderInbox, projects: renderProjects }[UI.tab];
  view.innerHTML = r();
  if (UI.tab === 'brief') wireBriefFrame();
}

// ===== Brief tab =====
function weekStrip() {
  const start = addDays(mondayOf(S.today), UI.weekOffset * 7);
  const label = UI.weekOffset === 0 ? 'This week' : UI.weekOffset === 1 ? 'Next week' : UI.weekOffset === -1 ? 'Last week' : 'Week of ' + shortDate(start);
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), due = dueOn(d), ev = eventsOn(d);
    const open = due.filter(x => !x.done), exam = open.some(x => x.exam) || ev.some(e => e.exam), band = ev.some(e => e.key === 'band');
    const dots = open.map(x => `<i class="dot c-${x.key} ${x.exam ? 'diamond' : ''}"></i>`).join('') + ev.filter(e => e.key !== 'band').map(() => '<i class="dot ev"></i>').join('');
    const sum = band ? 'Show' : exam ? 'Exam' : open.length ? `${open.length} due` : due.length ? 'All done' : ev.length ? 'Event' : 'Clear';
    const cls = ['wk', d === UI.day ? 'sel' : '', d === S.today ? 'is-today' : '', d < S.today ? 'past' : '', exam ? 'has-exam' : '', band ? 'has-band' : ''].join(' ');
    cells += `<button class="${cls}" data-act="pick-day" data-d="${d}"><span class="wk-dow">${WD[D(d).getDay()]}</span><span class="wk-num">${D(d).getDate()}</span>
      <span class="wk-dots">${dots}</span><span class="wk-sum">${sum}</span></button>`;
  }
  return `<section class="week">
    <div class="week-head"><h2>${label}</h2><span class="spacer"></span>
      <button class="btn ghost" data-act="week" data-n="-1" aria-label="Previous week">‹</button>
      <button class="btn ghost" data-act="week" data-n="0">Today</button>
      <button class="btn ghost" data-act="week" data-n="1" aria-label="Next week">›</button></div>
    <div class="wk-grid">${cells}</div></section>`;
}

function timeline(date, { compact = false } = {}) {
  const blocks = scheduleOn(date).map(b => ({ ...b, time: fmtRange(b.s, b.e) }));
  const timed = eventsOn(date).filter(e => e.start != null).map(e => ({ start: e.start, end: e.start + 75, label: e.label, key: e.key, time: fmt12(e.time), event: true, exam: e.exam }));
  const all = [...blocks, ...timed], gaps = freeGaps(date);
  let h0 = 8, h1 = 21;
  all.forEach(b => { h0 = Math.min(h0, Math.floor(b.start / 60)); h1 = Math.max(h1, Math.ceil(b.end / 60)); });
  const PX = compact ? 34 : 40, top = m => (m - h0 * 60) / 60 * PX;
  let html = '';
  for (let h = h0; h <= h1; h++) html += `<div class="hr" style="top:${(h - h0) * PX}px"><span>${h === 12 ? '12 PM' : h > 12 ? h - 12 + ' PM' : h + ' AM'}</span></div>`;
  gaps.forEach(([s, e]) => {
    html += `<div class="gap" style="top:${top(s) + 1}px;height:${(e - s) / 60 * PX - 2}px"><span>Free · ${fmtRange(m2t(s), m2t(e))}</span></div>`;
  });
  lanes(all).forEach(b => {
    const h = Math.max(20, (b.end - b.start) / 60 * PX - 2);
    html += `<div class="blk c-${b.key} ${b.event ? 'event' : ''} ${b.exam ? 'exam' : ''} ${h < 34 ? 'short' : ''}" style="top:${top(b.start) + 1}px;height:${h}px;${laneCSS(b, 6)}" title="${esc(b.time + ' · ' + b.label)}">
      <b>${esc(b.label)}</b><span>${esc(b.time)}</span></div>`;
  });
  if (date === S.today) {
    const n = new Date(), m = n.getHours() * 60 + n.getMinutes();
    if (m >= h0 * 60 && m <= h1 * 60) html += `<div class="now" style="top:${top(m)}px"></div>`;
  }
  return `<div class="tl" style="height:${(h1 - h0) * PX + 8}px">${html}</div>`;
}

function dayHeadline(date) {
  const due = dueOn(date).filter(d => !d.done), gaps = freeGaps(date), ev = eventsOn(date);
  const freeMin = gaps.reduce((a, [s, e]) => a + e - s, 0);
  const bits = [];
  if (ev.some(e => e.key === 'band')) bits.push('Show day');
  if (due.length) bits.push(`${due.length} due`);
  if (freeMin) bits.push(`${Math.floor(freeMin / 60)}h${freeMin % 60 ? ' ' + (freeMin % 60) + 'm' : ''} free`);
  return bits.join(' · ') || 'Nothing scheduled';
}

function comingUp(start) {
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), due = dueOn(d), ev = eventsOn(d);
    if (!due.length && !ev.length) continue;
    html += `<div class="cu-day"><div class="cu-head"><b>${dayName(d)}</b><span>${shortDate(d)}</span></div>${ev.map(e => eventRow(e)).join('')}${due.map(dueRow).join('')}</div>`;
  }
  return html || '<p class="muted">Nothing due in the next 7 days.</p>';
}

function renderBrief() {
  const d = UI.day;
  const b = S.briefs;
  if (!UI.briefDate || !b.includes(UI.briefDate)) UI.briefDate = b[0] || null;
  const brief = !b.length ? '' : `<details class="panel brief-box" id="brief-box" ${UI.briefOpen ? 'open' : ''}>
      <summary><span class="sum-title">Morning brief</span><span class="muted">${UI.briefDate === S.today ? 'Today' : shortDate(UI.briefDate)}</span>
        ${UI.briefDate !== S.today ? `<span class="muted">· today's hasn't run yet</span>` : ''}</summary>
      <div class="brief-bar"><span class="spacer"></span><select data-act="brief-date">${b.map(x => `<option value="${x}" ${x === UI.briefDate ? 'selected' : ''}>${shortDate(x)}</option>`).join('')}</select></div>
      <iframe class="brief-frame" id="brief-frame" src="/briefs/${esc(UI.briefDate)}.html" title="Morning brief"></iframe></details>`;
  return weekStrip() + `<div class="today-grid">
      <section class="panel"><div class="ph"><h2>${dayName(d)} <span class="muted">${shortDate(d)}</span></h2><span class="muted">${dayHeadline(d)}</span></div>${timeline(d)}</section>
      <section class="panel"><div class="ph"><h2>Coming up</h2><span class="muted">next 7 days</span></div>${comingUp(d)}</section>
    </div>` + brief;
}

// Briefs are written as light pages; restyle them dark when shown inside the interface.
const BRIEF_DARK = `
  html,body{background:#1C1B19 !important;color:#ECEAE3 !important}
  .top{background:#242320 !important;border-bottom-color:#3A3934 !important}
  h1,h2,.t,.act b{color:#ECEAE3 !important}
  .date,.s,.s a,.act p{color:#A9A79E !important}
  .n{color:#6E6C64 !important}
  li,.act{border-color:#3A3934 !important}
  svg [stroke="#2E2C27"]{stroke:#ECEAE3}
  svg [fill="#2E2C27"]{fill:#ECEAE3}
  svg [fill="#B4B3A8"]{fill:#6E6C64}
  svg [fill="#FCFCFB"]{fill:#1C1B19}`;
function wireBriefFrame() {
  const f = $('#brief-frame'), box = $('#brief-box'); if (!f) return;
  const size = () => { try { if (box.open) f.style.height = f.contentDocument.documentElement.scrollHeight + 4 + 'px'; } catch (e) {} };
  f.addEventListener('load', () => {
    try { const st = f.contentDocument.createElement('style'); st.textContent = BRIEF_DARK; f.contentDocument.head.appendChild(st); } catch (e) {}
    size();
  });
  box.addEventListener('toggle', () => { UI.briefOpen = box.open; savePref('briefOpen', box.open); size(); });
}

// ===== Calendar tab =====
function renderCalendar() {
  const viewSw = `<div class="seg"><button class="${UI.calView === 'week' ? 'on' : ''}" data-act="cal-view" data-v="week">Week</button><button class="${UI.calView === 'month' ? 'on' : ''}" data-act="cal-view" data-v="month">Month</button></div>`;
  const body = UI.calView === 'week' ? calWeek() : calMonth();
  return `<div class="cal-head">
      <button class="btn ghost" data-act="cal-nav" data-n="-1" aria-label="Previous">‹</button>
      <div class="title">${calTitle()}</div>
      <button class="btn ghost" data-act="cal-nav" data-n="1" aria-label="Next">›</button>
      <button class="btn" data-act="cal-nav" data-n="0">Today</button><span class="spacer"></span>${viewSw}</div>
    <div class="cal-wrap">${body}${dayPanel(UI.selDate)}</div>`;
}
function calTitle() {
  if (UI.calView === 'month') { ensureMonth(); return `${MON[UI.calM]} ${UI.calY}`; }
  const s = addDays(mondayOf(S.today), UI.calWeekOffset * 7), e = addDays(s, 6), a = D(s), b = D(e);
  return a.getMonth() === b.getMonth() ? `${MON[a.getMonth()].slice(0, 3)} ${a.getDate()}–${b.getDate()}, ${b.getFullYear()}`
    : `${MON[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${MON[b.getMonth()].slice(0, 3)} ${b.getDate()}, ${b.getFullYear()}`;
}
function ensureMonth() { if (UI.calY == null) { const t = D(S.today); UI.calY = t.getFullYear(); UI.calM = t.getMonth(); } }

function calWeek() {
  const start = addDays(mondayOf(S.today), UI.calWeekOffset * 7), days = [...Array(7)].map((_, i) => addDays(start, i));
  let h0 = 8, h1 = 21;
  days.forEach(d => scheduleOn(d).forEach(b => { h0 = Math.min(h0, Math.floor(b.start / 60)); h1 = Math.max(h1, Math.ceil(b.end / 60)); }));
  const PX = 38, top = m => (m - h0 * 60) / 60 * PX, H = (h1 - h0) * PX;
  const head = days.map(d => `<button class="wh ${d === S.today ? 'is-today' : ''} ${d === UI.selDate ? 'sel' : ''}" data-act="sel" data-d="${d}"><span>${WD[D(d).getDay()]}</span><b>${D(d).getDate()}</b></button>`).join('');
  const allday = days.map(d => {
    const ev = eventsOn(d).filter(e => e.start == null), due = dueOn(d);
    return `<div class="ad ${d === S.today ? 'is-today' : ''}" data-act="sel" data-d="${d}">
      ${ev.map(e => chip(e.label, e.key, 'event' + (e.exam ? ' exam' : ''))).join('')}
      ${due.map(x => chip(`${x.code} · ${x.label}`, x.key, (x.done ? 'done' : '') + (x.exam ? ' exam' : ''), x.full, x.url)).join('')}</div>`;
  }).join('');
  let gutter = '';
  for (let h = h0; h < h1; h++) gutter += `<div class="gh" style="top:${(h - h0) * PX}px">${h === 12 ? '12 PM' : h > 12 ? h - 12 + ' PM' : h + ' AM'}</div>`;
  const cols = days.map(d => {
    let inner = '';
    for (let h = h0; h < h1; h++) inner += `<div class="gl" style="top:${(h - h0) * PX}px"></div>`;
    const items = [
      ...scheduleOn(d).map(b => ({ ...b, time: fmtRange(b.s, b.e) })),
      ...eventsOn(d).filter(e => e.start != null).map(e => ({ start: e.start, end: e.start + 75, label: e.label, key: e.key, time: fmt12(e.time), event: true, exam: e.exam })),
    ];
    lanes(items).forEach(b => {
      const h = Math.max(18, (b.end - b.start) / 60 * PX - 2);
      inner += `<div class="blk c-${b.key} ${b.event ? 'event' : ''} ${b.exam ? 'exam' : ''} ${h < 30 ? 'short' : ''}" style="top:${top(b.start) + 1}px;height:${h}px;${laneCSS(b, 3)}" title="${esc(b.time + ' · ' + b.label)}"><b>${esc(b.label)}</b><span>${esc(b.time)}</span></div>`;
    });
    if (d === S.today) { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); if (m >= h0 * 60 && m <= h1 * 60) inner += `<div class="now" style="top:${top(m)}px"></div>`; }
    return `<div class="col ${d === S.today ? 'is-today' : ''}" data-act="sel" data-d="${d}">${inner}</div>`;
  }).join('');
  return `<div class="wkview panel">
    <div class="wv-row wv-head"><div class="gut"></div>${head}</div>
    <div class="wv-row wv-allday"><div class="gut lab">Due</div>${allday}</div>
    <div class="wv-row wv-grid" style="height:${H}px"><div class="gut" style="position:relative">${gutter}</div>${cols}</div></div>`;
}

function calMonth() {
  ensureMonth();
  const first = ymd(new Date(UI.calY, UI.calM, 1)), lastOfMonth = ymd(new Date(UI.calY, UI.calM + 1, 0));
  let d = mondayOf(first);
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="dh">${x}</div>`).join('');
  while (d <= lastOfMonth || D(d).getDay() !== 1) {
    const items = [
      ...eventsOn(d).map(e => chip(e.label, e.key, 'event' + (e.exam ? ' exam' : ''))),
      ...dueOn(d).map(x => chip(`${x.code} · ${x.label}`, x.key, (x.done ? 'done' : '') + (x.exam ? ' exam' : ''), x.full)),
    ];
    const cls = [D(d).getMonth() === UI.calM ? '' : 'other', d === S.today ? 'is-today' : '', d === UI.selDate ? 'sel' : ''].join(' ');
    cells += `<div class="cell ${cls}" data-act="sel" data-d="${d}"><span class="num">${D(d).getDate()}</span>
      ${items.slice(0, 3).join('')}${items.length > 3 ? `<div class="more">+${items.length - 3} more</div>` : ''}</div>`;
    d = addDays(d, 1);
  }
  return `<div class="month panel">${cells}</div>`;
}

function dayPanel(sel) {
  const ev = eventsOn(sel), due = dueOn(sel), blocks = scheduleOn(sel), gaps = freeGaps(sel);
  const sched = blocks.length ? `<h3>Schedule</h3><div class="sched-list">${blocks.map(b => `<div class="sline c-${b.key}"><i class="dot c-${b.key}"></i><span class="t">${esc(fmtRange(b.s, b.e))}</span>${esc(b.label)}</div>`).join('')}</div>` : '';
  const free = gaps.length ? `<h3>Free</h3>${gaps.map(([s, e]) => `<div class="sline free"><span class="t">${esc(fmtRange(m2t(s), m2t(e)))}</span></div>`).join('')}` : '';
  const items = ev.map(e => eventRow(e, true)).join('') + due.map(dueRow).join('');
  return `<aside class="panel day-panel"><h2>${dayName(sel)} <span class="muted">${shortDate(sel)}</span></h2>
    ${items ? `<h3>Due &amp; events</h3>${items}` : '<p class="muted">Nothing due.</p>'}${sched}${free}
    <form data-form="cal-add"><h3>Add to calendar</h3>
      <input type="date" name="date" value="${sel}" required>
      <input type="text" name="time" placeholder="Time (optional), e.g. 14:00">
      <input type="text" name="text" placeholder="What's happening?" required>
      <select name="tag">${tagOptions()}</select>
      <button class="btn primary">Add event</button></form>
    ${S.canvas.synced ? `<p class="muted small">Canvas synced ${esc(S.canvas.synced)} CT</p>` : ''}</aside>`;
}

// ===== Tasks tab =====
function taskRow(t) {
  const cls = [t.done ? 'done' : '', t.flag && !t.done ? 'flag' : ''].join(' ');
  return `<div class="item ${cls}"><input type="checkbox" data-act="toggle" data-line="${t.line}" ${t.done ? 'checked' : ''} aria-label="Mark done">
    <div class="body"><div class="txt">${md(t.text)}</div>
    <div class="meta">${t.done ? (t.done_on ? `<span class="due">done ${shortDate(t.done_on)}</span>` : '') : dueLabel(t.due)}${t.tags.map(tagChip).join('')}</div></div>
    <button class="btn ghost del" data-act="task-del" data-line="${t.line}" title="Delete task">×</button></div>`;
}
function renderTasks() {
  const f = UI.filter;
  const match = t => f === 'all' || t.tags.includes(f);
  const used = [...new Set(allTasks().filter(t => !t.done).flatMap(t => t.tags))];
  const chips = [`<button class="chip ${f === 'all' ? 'on' : ''}" data-act="filter" data-f="all">All</button>`]
    .concat(used.map(t => `<button class="chip ${f === t ? 'on' : ''}" data-act="filter" data-f="${esc(t)}"><span class="dot c-${courseKey(t)}"></span>${esc(COURSE_TAGS[t] || '#' + t)}</button>`)).join('');
  const secs = S.tasks.filter(s => s.name !== 'Done').map(s => {
    const items = s.items.filter(t => !t.done && match(t));
    if (!items.length && f !== 'all') return '';
    return `<section class="panel sec ${s.name === 'Today' ? 'today-sec' : ''}"><h2>${esc(s.name)} <span class="n">${items.length}</span></h2>
      ${items.map(taskRow).join('') || '<p class="muted">Clear.</p>'}</section>`;
  }).join('');
  const done = (S.tasks.find(s => s.name === 'Done') || { items: [] }).items.filter(match);
  return `<form class="add panel" data-form="task-add">
      <input type="text" name="text" placeholder="Add homework or a task…" required>
      <input type="date" name="due" title="Due date">
      <select name="tag">${tagOptions(f !== 'all' ? f : '')}</select>
      <select name="section" title="Section">${sectionOptions()}</select>
      <button class="btn primary">Add</button></form>
    <div class="filters">${chips}</div>
    <div class="sections">${secs}</div>
    <details class="done-box"><summary>Done (${done.length})</summary><div class="panel" style="margin-top:10px">${done.map(taskRow).join('') || '<p class="muted">Nothing checked off yet.</p>'}</div></details>`;
}

// ===== Inbox tab =====
function renderInbox() {
  const items = S.inbox.map(i => {
    const open = UI.inboxOpen === i.line;
    return `<div class="inbox-item"><div>${md(i.text)}</div>
      ${open ? `<form class="add" data-form="inbox-task" data-line="${i.line}" style="margin-top:8px">
          <input type="text" name="text" value="${esc(i.text)}" required>
          <input type="date" name="due"><select name="tag">${tagOptions()}</select><select name="section">${sectionOptions()}</select>
          <button class="btn primary">Make task</button><button type="button" class="btn ghost" data-act="inbox-open" data-line="-1">Cancel</button></form>`
        : `<div class="row"><button class="btn" data-act="inbox-open" data-line="${i.line}">→ Task</button>
           <button class="btn ghost" data-act="inbox-del" data-line="${i.line}">Delete</button></div>`}</div>`;
  }).join('');
  const waiting = (S.tasks.find(s => s.name === 'Waiting On') || { items: [] }).items.filter(t => !t.done);
  return `<div class="inbox-wrap">
    <form class="add capture" data-form="inbox-add" style="margin-bottom:16px">
      <input type="text" name="text" placeholder="Capture anything — sort it later" required autofocus>
      <button class="btn primary">Capture</button></form>
    <section class="panel"><h2>Inbox <span class="muted" style="font-weight:400">${S.inbox.length}</span></h2>
      ${items || '<p class="muted">Inbox zero. Anything you capture lands here until it’s sorted.</p>'}</section>
    ${waiting.length ? `<section class="panel" style="margin-top:16px"><h2>Waiting on others</h2>${waiting.map(taskRow).join('')}</section>` : ''}
  </div>`;
}

// ===== Projects tab =====
// Project README prose: show only sections that have content (milestones render separately).
function notesHTML(notes) {
  const parts = ('\n' + (notes || '')).split(/\n## /).map(s => s.trim()).filter(Boolean);
  const html = parts.map(p => {
    const nl = p.indexOf('\n'), title = nl < 0 ? p : p.slice(0, nl), body = nl < 0 ? '' : p.slice(nl + 1).trim();
    if (!body || title === 'Milestones' || /^_.*_$/.test(body)) return '';
    return `<h3>${esc(title)}</h3><div>${md(body)}</div>`;
  }).join('');
  return html ? `<div class="notes">${html}</div>` : '';
}
function renderProjects() {
  const tasks = allTasks().filter(t => !t.done);
  const cards = S.projects.map(p => {
    const ms = p.milestones, doneN = ms.filter(m => m.done).length;
    const pct = ms.length ? Math.round(100 * doneN / ms.length) : 0;
    const kw = (p.meta.keywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const related = kw.length ? tasks.filter(t => kw.some(k => t.text.toLowerCase().includes(k))) : [];
    const tag = (p.meta.tag || '').replace('#', '');
    return `<section class="panel proj">
      <h2>${esc(p.title)}</h2>
      <div class="facts">${tag ? tagChip(tag) : ''}${p.meta.status ? `<span>${esc(p.meta.status)}</span>` : ''}
        ${p.meta.due ? dueLabel(p.meta.due) : ''}${p.meta.team ? `<span>Team: ${esc(p.meta.team)}</span>` : ''}
        ${p.meta.link && /^https:/.test(p.meta.link) ? `<a href="${esc(p.meta.link)}" target="_blank" rel="noopener">link</a>` : ''}</div>
      ${ms.length ? `<div class="muted" style="font-size:12px">${doneN} of ${ms.length} milestones</div><div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${ms.map(m => `<div class="item ${m.done ? 'done' : ''}"><input type="checkbox" data-act="ms-toggle" data-slug="${esc(p.slug)}" data-line="${m.line}" ${m.done ? 'checked' : ''}>
        <div class="body"><div class="txt">${md(m.text)}</div><div class="meta">${m.done ? '' : dueLabel(m.due)}</div></div></div>`).join('')}
      <form class="add" data-form="ms-add" data-slug="${esc(p.slug)}"><input type="text" name="text" placeholder="Add a milestone…" required><input type="date" name="due"><button class="btn">Add</button></form>
      ${related.length ? `<h3 style="margin-top:14px">Related tasks</h3>${related.map(taskRow).join('')}` : ''}
      ${notesHTML(p.notes)}
    </section>`;
  }).join('');
  return `<details class="panel" style="margin-bottom:16px"><summary style="cursor:pointer;font-weight:600">New project</summary>
      <form class="add" data-form="proj-add" style="margin-top:12px">
        <input type="text" name="name" placeholder="Project name" required>
        <select name="tag">${tagOptions()}</select><input type="date" name="due" title="Final due date">
        <input type="text" name="team" placeholder="Team (optional)" style="flex:0 1 200px">
        <button class="btn primary">Create</button></form></details>
    <div class="projects">${cards || '<div class="panel empty">No projects yet.</div>'}</div>`;
}

// ---------- events ----------
const findTask = line => allTasks().find(t => t.line === +line);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (a === 'week') {
    UI.weekOffset = +el.dataset.n === 0 ? 0 : UI.weekOffset + +el.dataset.n;
    if (+el.dataset.n === 0) UI.day = S.today;
    render();
  }
  else if (a === 'pick-day') { UI.day = el.dataset.d; render(); }
  else if (a === 'cal-view') { UI.calView = el.dataset.v; savePref('calView', UI.calView); render(); }
  else if (a === 'cal-nav') {
    const n = +el.dataset.n;
    if (n === 0) { UI.calWeekOffset = 0; UI.calY = null; UI.selDate = S.today; }
    else if (UI.calView === 'week') UI.calWeekOffset += n;
    else { ensureMonth(); const d = new Date(UI.calY, UI.calM + n, 1); UI.calY = d.getFullYear(); UI.calM = d.getMonth(); }
    render();
  }
  else if (a === 'sel') { if (e.target.closest('a')) return; UI.selDate = el.dataset.d; render(); }
  else if (a === 'filter') { UI.filter = el.dataset.f; render(); }
  else if (a === 'task-del') {
    const t = findTask(el.dataset.line);
    if (t && confirm('Delete this task?\n\n' + t.text)) post('/api/tasks/delete', { line: t.line, raw: t.raw }, 'Task deleted');
  }
  else if (a === 'cal-del') {
    e.stopPropagation();
    const ev = S.calendar.find(x => x.line === +el.dataset.line);
    if (ev && confirm('Remove from calendar?\n\n' + ev.text)) post('/api/calendar/delete', { line: ev.line, raw: ev.raw }, 'Removed');
  }
  else if (a === 'inbox-open') { UI.inboxOpen = +el.dataset.line; render(); }
  else if (a === 'inbox-del') {
    const i = S.inbox.find(x => x.line === +el.dataset.line);
    if (i && confirm('Delete from inbox?\n\n' + i.text)) post('/api/inbox/remove', { line: i.line, raw: i.raw }, 'Deleted');
  }
});
document.addEventListener('change', e => {
  const el = e.target; const a = el.dataset.act;
  if (a === 'toggle') {
    const t = findTask(el.dataset.line);
    if (t) post('/api/tasks/toggle', { line: t.line, raw: t.raw }, t.done ? 'Back on the list' : 'Done ✓');
  } else if (a === 'ms-toggle') {
    const p = S.projects.find(x => x.slug === el.dataset.slug); const m = p && p.milestones.find(x => x.line === +el.dataset.line);
    if (m) post('/api/projects/toggle', { slug: p.slug, line: m.line, raw: m.raw });
  } else if (a === 'brief-date') { UI.briefDate = el.value; render(); }
});
document.addEventListener('submit', e => {
  const f = e.target; const kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  if (kind === 'task-add') post('/api/tasks/add', v, 'Task added');
  else if (kind === 'cal-add') { UI.selDate = v.date; post('/api/calendar/add', v, 'Added to calendar'); }
  else if (kind === 'inbox-add') post('/api/inbox/add', v, 'Captured');
  else if (kind === 'inbox-task') {
    const i = S.inbox.find(x => x.line === +f.dataset.line); UI.inboxOpen = null;
    if (i) post('/api/inbox/to-task', { ...v, line: i.line, raw: i.raw }, 'Moved to tasks');
  }
  else if (kind === 'ms-add') post('/api/projects/milestone', { ...v, slug: f.dataset.slug }, 'Milestone added');
  else if (kind === 'proj-add') post('/api/projects/add', v, 'Project created');
});

function route() {
  const t = location.hash.slice(1);
  UI.tab = ['brief', 'calendar', 'tasks', 'inbox', 'projects'].includes(t) ? t : 'brief';
  render();
}
window.addEventListener('hashchange', route);
// Pick up edits Alfred makes to the files while the page is open.
window.addEventListener('focus', () => { if (!document.activeElement || !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) load(); });
route(); load();
