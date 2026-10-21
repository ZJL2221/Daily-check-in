/* ============ app.js：业务逻辑 ============ */

/* ---------- 常量 ---------- */
const STORAGE_KEY = 'checkin_habits_v5';

/* ---------- 缓存 ---------- */
let habitsCache = [];
function getHabits() { return habitsCache; }

/* 所有项目都必须有稳定 id（通知定位、取消、去打卡都靠它） */
function ensureHabitIds(habits) {
  let changed = false;
  habits.forEach(h => {
    if (typeof h.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(h.id)) {
      h.id = newHabitId();
      changed = true;
    }
  });
  return changed;
}

/* ---------- 数据加载与保存 ---------- */
async function saveHabits(habits) {
  ensureHabitIds(habits);
  habits.forEach((h, i) => { h.order = i; });
  habitsCache = habits;
  try {
    const data = JSON.stringify(habits);
    await Storage.set(STORAGE_KEY, data);
  } catch (e) {
    alert('保存失败：' + e.message);
    console.error(e);
  }
}

async function loadHabitsFromStorage() {
  let habits = [];
  try {
    const data = await Storage.get(STORAGE_KEY);
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) habits = parsed;
        else if (parsed && typeof parsed === 'object') habits = [parsed];
      } catch (e) {
        console.warn('本地数据损坏:', e);
        try { await Storage.set(STORAGE_KEY + '_corrupt', data); } catch (_) {}
        alert('本地打卡数据已损坏，无法读取。\n原始数据已另存为 ' + STORAGE_KEY + '_corrupt，请先别继续操作，想办法导出。');
      }
    }
  } catch (e) {
    console.error('读取存储失败', e);
  }

  habits = habits.map((h, i) => normalizeHabit(h, i)).filter(Boolean);
  habits.forEach(ensureExpandedMonths);

  habits.sort((a, b) => (a.order || 0) - (b.order || 0));
  habitsCache = habits;
}

/* ---------- 通用确认弹窗（替代原生 confirm，按钮为 Yes / No） ---------- */
let confirmResolve = null;
let confirmOpenedAt = 0;

function showConfirm(text, title) {
  // 已经有一个确认框在等：直接忽略这次请求。
  // 否则后一次会覆盖 confirmResolve，前一个 promise 永远不 resolve（调用方卡死），
  // 而且弹窗文案会在用户眼皮底下被替换成另一个项目的名字。
  if (confirmResolve) return Promise.resolve(false);
  return new Promise(resolve => {
    confirmResolve = resolve;
    confirmOpenedAt = Date.now();
    document.getElementById('confirmTitle').textContent = title || '确认';
    document.getElementById('confirmText').textContent = text;
    document.getElementById('confirmModal').classList.add('active');
  });
}

function closeConfirm(result) {
  document.getElementById('confirmModal').classList.remove('active');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(result);
}

/* ---------- 导入方式选择弹窗（三选一，替代原来的"确定=合并/取消=替换"） ---------- */
let importResolve = null;
let importOpenedAt = 0;

function showImportChoice(existing, incoming) {
  // 同理：已经有一个导入弹窗在等时忽略重复请求
  if (importResolve) return Promise.resolve(null);
  return new Promise(resolve => {
    importResolve = resolve;
    importOpenedAt = Date.now();
    document.getElementById('importText').textContent =
      '当前已有 ' + existing + ' 个项目，备份文件里有 ' + incoming + ' 个。\n\n请选择导入方式：';
    document.getElementById('importModal').classList.add('active');
  });
}

function closeImportChoice(result) {
  document.getElementById('importModal').classList.remove('active');
  const r = importResolve;
  importResolve = null;
  if (r) r(result);
}

/* ---------- 打卡按钮：长按锁定 + 短按打卡（每日打卡） ---------- */
let btnPressTimer = null;
let btnPressFired = false;
let btnPressStartX = 0;
let btnPressStartY = 0;
let btnPressMoved = false;
let btnPressTouchTime = -Infinity;

function btnPressStart(i, dateStr, slotIndex, e) {
  if (e) {
    e.stopPropagation();
    if (e.type === 'mousedown') {
      // 关键修复：忽略触摸后浏览器补发的合成鼠标事件
      if (Date.now() - btnPressTouchTime < 700) return;
    } else if (e.type === 'touchstart') {
      btnPressTouchTime = Date.now();
    }
  }
  const t = e.touches ? e.touches[0] : e;
  btnPressStartX = t.clientX;
  btnPressStartY = t.clientY;
  btnPressMoved = false;
  btnPressFired = false;
  clearTimeout(btnPressTimer);
  btnPressTimer = setTimeout(() => {
    btnPressFired = true;
    toggleDateLock(i, dateStr);
  }, 500);
}

function btnPressMove(e) {
  if (!e) return;
  e.stopPropagation();
  if (e.type === 'mousemove' && Date.now() - btnPressTouchTime < 700) return;
  const t = e.touches ? e.touches[0] : e;
  if (Math.abs(t.clientX - btnPressStartX) > 10 || Math.abs(t.clientY - btnPressStartY) > 10) {
    btnPressMoved = true;
    clearTimeout(btnPressTimer);
  }
}

function btnPressEnd(i, dateStr, slotIndex, e) {
  if (e) {
    e.stopPropagation();
    // touchend 阻止默认行为，避免浏览器补发合成 mouse/click 造成二次切换
    if (e.type === 'touchend') e.preventDefault();
    if (e.type === 'mouseup' && Date.now() - btnPressTouchTime < 700) return;
  }
  clearTimeout(btnPressTimer);
  if (btnPressFired || btnPressMoved) {
    btnPressFired = false;
    btnPressMoved = false;
    return;
  }
  const h = getHabits();
  if (!h[i]) return;
  if (h[i].masterLocked) return;
  if (h[i].lockedDates && h[i].lockedDates.includes(dateStr)) return;
  if (slotIndex === -1) {
    toggleSingleCheck(i, dateStr);
  } else {
    toggleSlotCheck(i, dateStr, slotIndex);
  }
}

function btnPressCancel(e) {
  if (e) e.stopPropagation();
  clearTimeout(btnPressTimer);
  btnPressFired = false;
  btnPressMoved = false;
}

/* ---------- 删除按钮长按 ---------- */
let deletePressTimer = null;
let deletePressTriggered = false;
let deletePressActive = false;
let deletePressTouchTime = -Infinity;
let deletePressHabit = null;   // 按下时记住的目标对象，确认前若列表变动也不会删错

function startDeletePress(habitIndex, event) {
  if (event) {
    event.stopPropagation();
    if (event.type === 'mousedown') {
      // 忽略触摸后浏览器补发的合成鼠标事件
      if (Date.now() - deletePressTouchTime < 700) return;
    } else if (event.type === 'touchstart') {
      deletePressTouchTime = Date.now();
    }
  }
  if (deletePressActive) return;
  deletePressActive = true;
  deletePressTriggered = false;
  deletePressHabit = getHabits()[habitIndex] || null;
  clearTimeout(deletePressTimer);
  deletePressTimer = setTimeout(() => {
    deletePressTriggered = true;
    toggleDeleteLock(habitIndex);
  }, 550);
}

function cancelDeletePress(event) {
  if (event) event.stopPropagation();
  clearTimeout(deletePressTimer);
  deletePressActive = false;
}

function endDeletePress(habitIndex, event) {
  if (event) {
    event.stopPropagation();
    // 关键修复 1：touchend 阻止默认行为，避免浏览器补发 mouse / click 事件
    if (event.type === 'touchend') {
      event.preventDefault();
    }
    if (event.type === 'mouseup' && Date.now() - deletePressTouchTime < 700) return;
  }
  if (!deletePressActive) return;
  deletePressActive = false;
  clearTimeout(deletePressTimer);
  if (deletePressTriggered) { deletePressTriggered = false; return; }
  const habits = getHabits();
  const target = (deletePressHabit && habits.indexOf(deletePressHabit) !== -1)
    ? habits.indexOf(deletePressHabit)
    : habitIndex;
  if (!habits[target]) return;
  if (habits[target].deleteLocked) {
    alert('删除已锁定，长按可解锁');
    return;
  }
  // 关键修复 2：延迟 120ms 再弹 confirm，让整段鼠标 / 触摸事件序列先走完
  setTimeout(() => {
    deleteHabit(target, deletePressHabit);
  }, 120);
}

/* ---------- 交互操作 ---------- */
function toggleMasterLock(i, e) {
  e.stopPropagation();
  const h = getHabits();
  h[i].masterLocked = !h[i].masterLocked;
  saveHabits(h);
  renderHabits();
  // 锁定全部 = 不打扰，解锁后要把提醒排回来
  scheduleRemindersSoon();
}

function toggleDeleteLock(i) {
  const h = getHabits();
  h[i].deleteLocked = !h[i].deleteLocked;
  saveHabits(h);
  renderHabits();
}

function toggleDateLock(i, dateStr) {
  const h = getHabits();
  if (h[i].masterLocked) return;
  if (!h[i].lockedDates) h[i].lockedDates = [];
  const idx = h[i].lockedDates.indexOf(dateStr);
  if (idx > -1) h[i].lockedDates.splice(idx, 1);
  else h[i].lockedDates.push(dateStr);
  saveHabits(h);
  renderHabits();
}

function toggleExpand(i) {
  const h = getHabits();
  h[i].expanded = !h[i].expanded;
  saveHabits(h);
  renderHabits();
}

function toggleMonth(i, monthKey, e) {
  e.stopPropagation();
  const h = getHabits();
  const months = h[i].expandedMonths || [];
  const idx = months.indexOf(monthKey);
  if (idx > -1) months.splice(idx, 1);
  else months.push(monthKey);
  h[i].expandedMonths = months;
  saveHabits(h);
  renderHabits();
}

function toggleSingleCheck(i, dateStr, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[i] || getHabitType(h[i]) !== TYPE_DAILY) return;
  if (h[i].masterLocked) return;
  if (h[i].lockedDates && h[i].lockedDates.includes(dateStr)) return;
  if ((h[i].mode || 'single') !== 'single') return;
  const status = getDayStatus(h[i], dateStr);
  status[0] = !status[0];
  setDayStatus(h[i], dateStr, status);
  saveHabits(h);
  renderHabits();
  if (status[0]) cancelSlotReminders(h[i].id, dateStr, 0);
  else scheduleRemindersSoon();
}

function toggleSlotCheck(i, dateStr, slotIndex, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[i] || getHabitType(h[i]) !== TYPE_DAILY) return;
  if (h[i].masterLocked) return;
  if (h[i].lockedDates && h[i].lockedDates.includes(dateStr)) return;
  if ((h[i].mode || 'single') === 'single') return;
  const status = getDayStatus(h[i], dateStr);
  status[slotIndex] = !status[slotIndex];
  setDayStatus(h[i], dateStr, status);
  saveHabits(h);
  renderHabits();
  if (status[slotIndex]) cancelSlotReminders(h[i].id, dateStr, slotIndex);
  else scheduleRemindersSoon();
}

/* ---------- 长按检测（日期项）---------- */
let longPressTimer = null;
let isLongPress = false;
let hasMoved = false;
let lastTouchEndAt = 0;   // 最近一次 touchend 时间戳（替代原来的 window._lastTouchEnd）
const LONG_PRESS_DURATION = 500;

function startLongPress(callback) {
  isLongPress = false;
  hasMoved = false;
  longPressTimer = setTimeout(() => { isLongPress = true; callback(); }, LONG_PRESS_DURATION);
}

function cancelLongPress() { clearTimeout(longPressTimer); }

function handleTouchMove() { hasMoved = true; cancelLongPress(); }

function onDateTouchStart(e, i, dateStr) {
  startLongPress(() => toggleDateLock(i, dateStr));
}

function onDateTouchEnd(e, i, dateStr) {
  cancelLongPress();
  lastTouchEndAt = Date.now();
  if (isLongPress || hasMoved) { isLongPress = false; hasMoved = false; return; }
  const h = getHabits();
  if (h[i] && (h[i].mode || 'single') === 'single') {
    const locked = h[i].masterLocked || (h[i].lockedDates || []).includes(dateStr);
    if (!locked) toggleSingleCheck(i, dateStr, e);
  }
  isLongPress = false; hasMoved = false;
}

/* ---------- 桌面端点击空白区域（单次模式打卡） ---------- */
function onDateClick(e, i, dateStr) {
  // 触摸后的合成 click，忽略（800ms 内）
  if (Date.now() - lastTouchEndAt < 800) return;

  const h = getHabits();
  const target = e.target;

  // 点按钮、备注图标时忽略
  if (target.closest && (target.closest('.check-btn') || target.closest('.slot-btn') || target.closest('.note-btn'))) return;

  if (!h[i] || (h[i].mode || 'single') !== 'single') return;

  const locked = h[i].masterLocked || (h[i].lockedDates || []).includes(dateStr);
  if (!locked) toggleSingleCheck(i, dateStr);
}

async function checkAll(i, check) {
  const h = getHabits();
  if (!h[i] || getHabitType(h[i]) !== TYPE_DAILY) return;
  if (h[i].masterLocked) return;
  const locked = h[i].lockedDates || [];
  const action = check ? '全部打卡' : '全部取消';
  let msg = '确定要「' + action + '」？共 ' + h[i].totalDays + ' 天';
  if (locked.length > 0) msg += '（已锁定 ' + locked.length + ' 天将跳过）';
  msg += '。';
  if (!(await showConfirm(msg, action))) return;

  const dates = getDates(h[i].startDate, h[i].totalDays);
  const mode = h[i].mode || 'single';
  if (mode === 'single') {
    if (check) h[i].completedDates = dates.filter(d => !locked.includes(d.dateStr)).map(d => d.dateStr);
    else h[i].completedDates = (h[i].completedDates || []).filter(d => locked.includes(d));
  } else {
    if (!h[i].completedCounts) h[i].completedCounts = {};
    dates.forEach(d => {
      if (locked.includes(d.dateStr)) return;
      if (check) h[i].completedCounts[d.dateStr] = Array(getSlotCount(mode)).fill(true);
      else delete h[i].completedCounts[d.dateStr];
    });
  }
  saveHabits(h);
  renderHabits();
  // 全部打卡后当天剩余提醒要撤掉；全部取消后要重新排回来
  scheduleRemindersSoon();
}

async function deleteHabit(i, habitRef) {
  const h = getHabits();
  // 优先按对象引用定位：长按到确认之间项目可能被移动或删除，纯索引会张冠李戴
  let idx = habitRef ? h.indexOf(habitRef) : -1;
  if (idx === -1) idx = i;
  if (!h[idx]) return;
  if (!(await showConfirm('确定要删除「' + h[idx].name + '」吗？', '删除项目'))) return;
  const removed = h.splice(idx, 1)[0];
  if (removed && removed.id) {
    cancelHabitReminders(removed.id);
  }
  saveHabits(h);
  renderHabits();
  showUndoBar(removed, idx);
  scheduleRemindersSoon();
}

/* ---------- 天数增减（仅每日打卡） ---------- */
function addDays(i, days) {
  const h = getHabits();
  if (!h[i] || getHabitType(h[i]) !== TYPE_DAILY) return;
  if (h[i].masterLocked) return;
  const newTotal = h[i].totalDays + days;
  if (newTotal > 3650) { alert('总天数不能超过 3650 天'); return; }
  h[i].totalDays = newTotal;
  // 新加的日期若落在新月份，顺手展开，否则用户以为没加上
  const last = getDates(h[i].startDate, newTotal).slice(-1)[0];
  if (last) {
    if (!Array.isArray(h[i].expandedMonths)) h[i].expandedMonths = [];
    const monthKey = last.dateStr.substring(0, 7);
    if (!h[i].expandedMonths.includes(monthKey)) h[i].expandedMonths.push(monthKey);
  }
  saveHabits(h);
  renderHabits();
  // 新增的日期也要有提醒
  scheduleRemindersSoon();
}

async function reduceDays(i, days) {
  const h = getHabits();
  if (!h[i] || getHabitType(h[i]) !== TYPE_DAILY) return;
  if (h[i].masterLocked) return;
  const newTotal = h[i].totalDays - days;
  if (newTotal < 1) { alert('总天数不能少于 1 天'); return; }
  if (!(await showConfirm('将删除最后 ' + days + ' 天的所有打卡记录、备注和锁定状态，是否继续？', '减少天数'))) return;

  const validDates = new Set(getDates(h[i].startDate, newTotal).map(d => d.dateStr));

  if ((h[i].mode || 'single') === 'single') {
    h[i].completedDates = (h[i].completedDates || []).filter(d => validDates.has(d));
  } else {
    const newCounts = {};
    for (const k in (h[i].completedCounts || {})) {
      if (validDates.has(k)) newCounts[k] = h[i].completedCounts[k];
    }
    h[i].completedCounts = newCounts;
  }
  h[i].lockedDates = (h[i].lockedDates || []).filter(d => validDates.has(d));

  const newNotes = {};
  for (const k in (h[i].notes || {})) {
    if (validDates.has(k)) newNotes[k] = h[i].notes[k];
  }
  h[i].notes = newNotes;

  const validMonths = new Set([...validDates].map(d => d.substring(0, 7)));
  h[i].expandedMonths = (h[i].expandedMonths || []).filter(m => validMonths.has(m));

  h[i].totalDays = newTotal;
  saveHabits(h);
  renderHabits();
  // 被删掉的日期不能再留提醒
  scheduleRemindersSoon();
}

function moveHabit(i, delta, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  const j = i + delta;
  if (j < 0 || j >= h.length) return;
  [h[i], h[j]] = [h[j], h[i]];
  saveHabits(h);
  renderHabits();
}

/* ---------- 撤销删除 ---------- */
let undoBarEl = null;
let undoTimer = null;

function showUndoBar(habit, index) {
  if (undoBarEl) { undoBarEl.remove(); clearTimeout(undoTimer); }
  const bar = document.createElement('div');
  bar.className = 'undo-bar';
  bar.innerHTML = '<span>已删除「' + escapeHtml(habit.name) + '」</span><button>撤销</button>';
  bar.querySelector('button').onclick = () => {
    const h = getHabits();
    const idx = Math.min(index, h.length);
    h.splice(idx, 0, habit);
    saveHabits(h);
    renderHabits();
    bar.remove();
    undoBarEl = null;
    clearTimeout(undoTimer);
    // 删的时候提醒被撤了，撤销后要排回来
    scheduleRemindersSoon();
  };
  document.body.appendChild(bar);
  undoBarEl = bar;
  undoTimer = setTimeout(() => { bar.remove(); undoBarEl = null; }, 5000);
}

/* ---------- 备注（仅每日打卡） ---------- */
let noteHabitIndex = -1;
let noteDateStr = '';

function openNoteModal(i, dateStr) {
  const h = getHabits();
  if (!h[i]) return;
  if (h[i].masterLocked) return;
  if (h[i].lockedDates && h[i].lockedDates.includes(dateStr)) return;
  noteHabitIndex = i;
  noteDateStr = dateStr;
  const d = parseDateStr(dateStr);
  document.getElementById('noteDateLabel').textContent =
    h[i].name + ' · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  const note = (h[i].notes && h[i].notes[dateStr]) || '';
  document.getElementById('noteInput').value = note;
  updateNoteCharCount();
  document.getElementById('noteModal').classList.add('active');
  // 不再自动聚焦，避免一点开就弹输入法
}

function updateNoteCharCount() {
  const v = document.getElementById('noteInput').value;
  document.getElementById('noteCharCount').textContent = v.length;
}

function closeNoteModal() {
  document.getElementById('noteModal').classList.remove('active');
}

function saveNote() {
  const h = getHabits();
  if (noteHabitIndex < 0 || !h[noteHabitIndex]) return;
  if (!h[noteHabitIndex].notes) h[noteHabitIndex].notes = {};
  const text = document.getElementById('noteInput').value.trim().slice(0, 200);
  if (text) h[noteHabitIndex].notes[noteDateStr] = text;
  else delete h[noteHabitIndex].notes[noteDateStr];
  saveHabits(h);
  closeNoteModal();
  renderHabits();
}

/* ============ 记录清单：条目交互 ============ */
let itemPressTimer = null;
let itemPressFired = false;
let itemPressMoved = false;
let itemPressStartX = 0;
let itemPressStartY = 0;
let itemPressTouchTime = -Infinity;

function itemPressStart(habitIndex, itemId, e) {
  if (e) {
    e.stopPropagation();
    if (e.type === 'mousedown') {
      // 同打卡按钮：忽略触摸后补发的合成鼠标事件
      if (Date.now() - itemPressTouchTime < 700) return;
    } else if (e.type === 'touchstart') {
      itemPressTouchTime = Date.now();
    }
  }
  const t = e.touches ? e.touches[0] : e;
  itemPressStartX = t.clientX;
  itemPressStartY = t.clientY;
  itemPressMoved = false;
  itemPressFired = false;
  clearTimeout(itemPressTimer);
  // 500ms 长按 → 锁定/解锁该条
  itemPressTimer = setTimeout(() => {
    itemPressFired = true;
    toggleItemLock(habitIndex, itemId);
  }, 500);
}

function itemPressMove(e) {
  if (!e) return;
  e.stopPropagation();
  if (e.type === 'mousemove' && Date.now() - itemPressTouchTime < 700) return;
  const t = e.touches ? e.touches[0] : e;
  if (Math.abs(t.clientX - itemPressStartX) > 10 || Math.abs(t.clientY - itemPressStartY) > 10) {
    itemPressMoved = true;
    clearTimeout(itemPressTimer);
  }
}

function itemPressEnd(habitIndex, itemId, e) {
  if (e) {
    e.stopPropagation();
    if (e.type === 'touchend') e.preventDefault();
    if (e.type === 'mouseup' && Date.now() - itemPressTouchTime < 700) return;
  }
  clearTimeout(itemPressTimer);
  if (itemPressFired || itemPressMoved) {
    itemPressFired = false;
    itemPressMoved = false;
    return;
  }
  const h = getHabits();
  const habit = h[habitIndex];
  if (!habit) return;
  const item = getListItem(habit, itemId);
  if (!item) return;
  if (habit.masterLocked || item.locked) return;
  toggleItemDone(habitIndex, itemId);
}

function itemPressCancel(e) {
  if (e) e.stopPropagation();
  clearTimeout(itemPressTimer);
  itemPressFired = false;
  itemPressMoved = false;
}

function toggleItemDone(i, itemId) {
  const h = getHabits();
  if (!h[i]) return;
  if (!toggleListItemDone(h[i], itemId)) return;
  saveHabits(h);
  renderHabits();
}

function toggleItemLock(i, itemId) {
  const h = getHabits();
  if (!h[i]) return;
  if (!toggleListItemLock(h[i], itemId)) return;
  saveHabits(h);
  renderHabits();
}

/* 删除单条记录：先弹确认，再删 */
async function deleteListItem(i, itemId, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[i]) return;
  const item = getListItem(h[i], itemId);
  if (!item) return;
  if (h[i].masterLocked || item.locked) return;
  if (!(await showConfirm('确定要删除「' + item.text + '」吗？', '删除这条记录'))) return;
  const hh = getHabits();
  if (!hh[i]) return;
  removeListItem(hh[i], itemId);
  saveHabits(hh);
  renderHabits();
}

/* 改文字：把该行原地换成输入框，回车保存、Esc 放弃 */
function startItemEdit(i, itemId, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[i]) return;
  const item = getListItem(h[i], itemId);
  if (!item) return;
  if (h[i].masterLocked || item.locked) return;

  const row = document.querySelector('.list-row[data-item="' + itemId + '"]');
  if (!row) return;
  const textEl = row.querySelector('.item-text');
  if (!textEl || textEl.querySelector('input')) return;

  const old = item.text;
  textEl.innerHTML = '<input class="item-edit-input" type="text" maxlength="' + LIST_ITEM_MAX +
    '" value="' + escapeHtml(old) + '">';
  const input = textEl.querySelector('input');
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}

  let finished = false;
  const commit = (save) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (save && v && v !== old) {
      const hh = getHabits();
      if (hh[i]) {
        setListItemText(hh[i], itemId, v);
        saveHabits(hh);
      }
    }
    renderHabits();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  // 失焦 = 放弃修改（避免只是滑动/点别处就把内容改了）：只有回车才算保存
  input.addEventListener('blur', () => commit(false));
  // 别让输入框里的点击被整行的"打勾"处理吃掉
  ['click', 'mousedown', 'touchstart', 'touchmove', 'touchend'].forEach(t =>
    input.addEventListener(t, ev => ev.stopPropagation()));
}

/* 添加一条：点卡片底部的按钮 → 弹出居中输入框。
   手机上这样键盘不会挤压卡片布局，也不用先滚到列表底部去点输入框。 */
let itemModalHabitIndex = -1;
let itemModalSavedCount = 0;
let itemHintTimer = null;

function openItemModal(i) {
  const h = getHabits();
  if (!h[i]) return;
  if (h[i].masterLocked) return;
  itemModalHabitIndex = i;
  itemModalSavedCount = 0;
  document.getElementById('itemModalLabel').textContent = '添加到「' + h[i].name + '」';
  document.getElementById('itemInput').value = '';
  document.getElementById('itemCharCount').textContent = '0';
  document.getElementById('itemModalHint').textContent = '确定后可以接着加下一条';
  document.getElementById('itemModal').classList.add('active');
  setTimeout(() => document.getElementById('itemInput').focus(), 320);
}

function closeItemModal() {
  document.getElementById('itemModal').classList.remove('active');
  itemModalHabitIndex = -1;
  itemModalSavedCount = 0;
  clearTimeout(itemHintTimer);
}

function saveItemModal() {
  const h = getHabits();
  const i = itemModalHabitIndex;
  if (i < 0 || !h[i]) { closeItemModal(); return; }
  const inp = document.getElementById('itemInput');
  const v = inp.value.trim();
  if (!v) { inp.focus(); return; }
  addListItem(h[i], v);
  saveHabits(h);
  renderHabits();
  // 故意不关弹窗：清空并保持焦点，方便接着记下一条；点「完成」才收起来
  inp.value = '';
  document.getElementById('itemCharCount').textContent = '0';
  itemModalSavedCount++;
  const hint = document.getElementById('itemModalHint');
  hint.textContent = '已添加';
  clearTimeout(itemHintTimer);
  itemHintTimer = setTimeout(() => {
    hint.textContent = '已添加 ' + itemModalSavedCount + ' 条，可继续输入';
  }, 1200);
  inp.focus();
}

/* ---------- 导入导出 ---------- */
let exportDataStr = '';

async function exportData() {
  if (habitsCache.length === 0) {
    alert('还没有任何项目');
    return;
  }
  const data = JSON.stringify(habitsCache, null, 2);
  const filename = '打卡备份_' + formatDate(new Date()) + '_全部.json';
  await doSaveFile(filename, data, '全部内容（共 ' + habitsCache.length + ' 项）');
}

async function exportSingleHabit(index, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[index]) return;
  const data = JSON.stringify([h[index]], null, 2);
  const safeName = h[index].name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 20);
  const filename = '打卡备份_' + formatDate(new Date()) + '_' + safeName + '.json';
  await doSaveFile(filename, data, h[index].name);
}

async function doSaveFile(filename, data, title) {
  const result = await FileSaver.saveTextFile(filename, data);
  if (result.ok) {
    if (result.method === 'documents') {
      alert('✅ 已保存\n\n文件位置：手机存储 → Documents → ' + filename);
    }
    return;
  }
  exportDataStr = data;
  document.getElementById('exportTitle').textContent = title + ' · ' + data.length + ' 字符';
  document.getElementById('exportData').value = data;
  document.getElementById('exportModal').classList.add('active');
}

function closeExportModal() {
  document.getElementById('exportModal').classList.remove('active');
}

async function copyExportData() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(exportDataStr);
      alert('✅ 已复制到剪贴板');
      return;
    } catch (e) {
      console.warn('Clipboard API 失败，尝试 execCommand', e);
    }
  }
  const ta = document.getElementById('exportData');
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, exportDataStr.length);
  try {
    const ok = document.execCommand('copy');
    if (ok) alert('✅ 已复制到剪贴板');
    else alert('复制失败，请手动长按文本选择复制');
  } catch (err) {
    alert('复制失败，请手动长按文本选择复制');
  }
}

/* ---------- 导入（支持合并或替换） ---------- */
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const arr = JSON.parse(e.target.result);
      if (!Array.isArray(arr)) throw new Error('文件格式不正确，应为 JSON 数组');

      const normalized = arr.map((h, i) => normalizeHabit(h, i)).filter(Boolean);
      if (normalized.length === 0) throw new Error('文件中没有有效的项目');
      normalized.forEach(ensureExpandedMonths);

      // 没有数据、或只剩一个从没动过的默认项目时，直接导入
      if (habitsCache.length === 0 || habitsCache.every(isUntouchedDefault)) {
        habitsCache = normalized;
        await saveHabits(normalized);
        dateListCache.clear();
        renderHabits();
        alert('导入成功，共 ' + normalized.length + ' 个项目。');
        scheduleRemindersSoon();
        return;
      }

      // 有现有数据时，让用户选导入方式（三个按钮，「取消」不再兼职当"替换"）
      const choice = await showImportChoice(habitsCache.length, normalized.length);

      if (choice === 'merge') {
        // 合并导入：跳过已存在的同一项目，避免同一份备份被导入两次
        const seen = new Set(habitsCache.map(habitSignature));
        const fresh = normalized.filter(h => !seen.has(habitSignature(h)));
        if (fresh.length === 0) {
          alert('这些项目已经存在，没有重复导入。');
          return;
        }
        const merged = [...habitsCache, ...fresh];
        merged.forEach((h, i) => { h.order = i; });
        habitsCache = merged;
        await saveHabits(merged);
        dateListCache.clear();
        renderHabits();
        alert('✅ 合并导入成功\n\n共 ' + merged.length + ' 个项目（原有 ' +
              (merged.length - fresh.length) + ' + 新增 ' + fresh.length + '）');
        scheduleRemindersSoon();
      } else if (choice === 'replace') {
        // 替换会清空现有数据且不可撤销，第二道确认保留
        const ok = await showConfirm(
          '⚠️ 确定要完全替换吗？\n\n现有的 ' + habitsCache.length + ' 个项目将全部丢失，此操作不可撤销。',
          '完全替换'
        );
        if (!ok) return;
        habitsCache = normalized;
        await saveHabits(normalized);
        dateListCache.clear();
        renderHabits();
        alert('已替换，共 ' + normalized.length + ' 个项目。');
        scheduleRemindersSoon();
      }
      // choice === null：用户点了「取消」，什么都不做
    } catch (err) {
      alert('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

/* ============ 添加/编辑弹窗 ============ */
let selectedMode = 'single';      // 每日打卡的频率
let selectedType = 'daily';       // 项目类型：daily / list
let typeLocked = false;           // 编辑时类型不可改
let editingIndex = -1;

function selectMode(mode) {
  const prevTimes = currentReminderValues();   // 切频率前先记住已填的时间
  selectedMode = mode;
  // 注意：必须限定在 #modeSelector 内，否则会误改上面的"类型"选择器
  document.querySelectorAll('#modeSelector .mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === mode);
  });
  renderSlotNameInputs();
  renderReminderInputs(prevTimes);
}

function selectType(type, force) {
  if (typeLocked && !force) return;
  selectedType = (type === TYPE_LIST) ? TYPE_LIST : TYPE_DAILY;
  document.querySelectorAll('#typeSelector .mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === selectedType);
  });
  applyTypeFields();
}

function applyTypeFields() {
  const isDaily = selectedType === TYPE_DAILY;
  document.getElementById('dailyFields').style.display = isDaily ? '' : 'none';
  document.getElementById('listHint').style.display = isDaily ? 'none' : '';
}

function lockTypeSelector(locked) {
  typeLocked = locked;
  document.getElementById('typeSelector').classList.toggle('locked', locked);
  document.getElementById('typeHint').textContent = locked ? '（创建后不可更改）' : '';
}

function renderSlotNameInputs(presetNames) {
  const group = document.getElementById('slotNamesGroup');
  const wrap = document.getElementById('slotNamesInputs');
  if (selectedMode === 'single') { group.style.display = 'none'; return; }
  group.style.display = 'block';
  const n = getSlotCount(selectedMode);
  const defaults = presetNames && presetNames.length === n ? presetNames : getDefaultSlotNames(selectedMode);
  let html = '';
  for (let i = 0; i < n; i++) {
    const val = defaults[i] || '';
    html += '<input type="text" id="slotName' + i + '" placeholder="' + getDefaultSlotNames(selectedMode)[i] + '" value="' + escapeHtml(val) + '" maxlength="6">';
  }
  wrap.innerHTML = html;
  // 改时段名时，下面提醒行的标签跟着改
  for (let i = 0; i < n; i++) {
    const input = document.getElementById('slotName' + i);
    if (input && input.addEventListener) input.addEventListener('input', syncReminderLabels);
  }
}

/* 取当前输入框里的时段名，空的话退回默认名 */
function currentSlotNames() {
  const n = getSlotCount(selectedMode);
  const defaults = getDefaultSlotNames(selectedMode);
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = document.getElementById('slotName' + i);
    const v = el && el.value ? el.value.trim() : '';
    out.push(v || defaults[i] || ('时段' + (i + 1)));
  }
  return out;
}

function syncReminderLabels() {
  const names = currentSlotNames();
  names.forEach((name, i) => {
    const el = document.getElementById('reminderLabel' + i);
    if (el) el.textContent = name;
  });
}

/* ---------- 打卡提醒时间输入：每个时段一个，可留空 ---------- */
function currentReminderValues() {
  const n = getSlotCount(selectedMode);
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = document.getElementById('reminderTime' + i);
    out.push(el && el.value ? el.value : '');
  }
  return out;
}

function renderReminderInputs(presetTimes) {
  const wrap = document.getElementById('reminderInputs');
  if (!wrap) return;
  const n = getSlotCount(selectedMode);
  // 单次模式写「设置时间」（原来「打卡提醒」四个字会被挤掉）；多次模式跟随时段名
  const names = selectedMode === 'single' ? [] : currentSlotNames();
  let html = '';
  for (let i = 0; i < n; i++) {
    const val = (presetTimes && presetTimes[i]) || '';
    const label = selectedMode === 'single' ? '设置时间' : (names[i] || ('时段' + (i + 1)));
    html += '<div class="reminder-row">' +
      '<span class="reminder-label" id="reminderLabel' + i + '">' + escapeHtml(label) + '</span>' +
      '<input type="text" class="reminder-time" readonly placeholder="选填：未设置" id="reminderTime' + i + '" value="' + escapeHtml(val) + '" onclick="openTimePicker(' + i + ')">' +
      '<button type="button" class="reminder-clear" onclick="clearReminderTime(' + i + ')" aria-label="不提醒">✕</button>' +
      '</div>';
  }
  wrap.innerHTML = html;
}

function clearReminderTime(i) {
  const el = document.getElementById('reminderTime' + i);
  if (el) el.value = '';
}

/* ---------- 时间选择器：上面输入，下面双针表盘（外圈时 / 内圈分） ---------- */
const TP_C = 130;              // 表盘圆心
const TP_RING_SPLIT = 90;      // 半径大于它算外圈（时），小于算内圈（分）
let tpSlot = -1;               // 正在设置第几个时段，-1 表示没开
let tpHourVal = 0;
let tpMinuteVal = 0;
let tpDragMode = null;         // 'hour' | 'min' | null
let tpBuilt = false;
let tpBound = false;

function tpNode(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
  return el;
}

/* 刻度只建一次，后面只转指针 */
function buildTpDial() {
  if (tpBuilt) return;
  const hourTicks = document.getElementById('tpHourTicks');
  const minTicks = document.getElementById('tpMinTicks');
  const hourNums = document.getElementById('tpHourNums');
  const minNums = document.getElementById('tpMinNums');
  if (!hourTicks || !minTicks || !hourNums || !minNums) return;

  const rad = deg => (deg - 90) * Math.PI / 180;

  // 外圈：24 格小时刻度，偶数点加粗
  for (let h = 0; h < 24; h++) {
    const a = rad(h * 15);
    const major = h % 2 === 0;
    const r1 = major ? 111 : 116;
    hourTicks.appendChild(tpNode('line', {
      x1: TP_C + Math.cos(a) * r1, y1: TP_C + Math.sin(a) * r1,
      x2: TP_C + Math.cos(a) * 126, y2: TP_C + Math.sin(a) * 126,
      class: major ? 'tp-tick-hour tp-major' : 'tp-tick-hour'
    }));
  }
  for (let h = 0; h < 24; h += 2) {
    const a = rad(h * 15);
    const t = tpNode('text', {
      x: TP_C + Math.cos(a) * 100, y: TP_C + Math.sin(a) * 100,
      class: 'tp-num-hour', 'text-anchor': 'middle', 'dominant-baseline': 'central'
    });
    t.textContent = String(h);
    hourNums.appendChild(t);
  }

  // 内圈：60 格分钟刻度，5 的倍数加粗
  for (let m = 0; m < 60; m++) {
    const a = rad(m * 6);
    const major = m % 5 === 0;
    const r1 = major ? 72 : 75;
    minTicks.appendChild(tpNode('line', {
      x1: TP_C + Math.cos(a) * r1, y1: TP_C + Math.sin(a) * r1,
      x2: TP_C + Math.cos(a) * 80, y2: TP_C + Math.sin(a) * 80,
      class: major ? 'tp-tick-min tp-major' : 'tp-tick-min'
    }));
  }
  for (let m = 0; m < 60; m += 10) {
    const a = rad(m * 6);
    const t = tpNode('text', {
      x: TP_C + Math.cos(a) * 64, y: TP_C + Math.sin(a) * 64,
      class: 'tp-num-min', 'text-anchor': 'middle', 'dominant-baseline': 'central'
    });
    t.textContent = String(m);
    minNums.appendChild(t);
  }

  tpBuilt = true;
}

function renderTpHands() {
  const rot = (id, deg) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('transform', 'rotate(' + deg + ' ' + TP_C + ' ' + TP_C + ')');
  };
  rot('tpHourHand', tpHourVal * 15);
  rot('tpHourDot', tpHourVal * 15);
  rot('tpMinHand', tpMinuteVal * 6);
  rot('tpMinDot', tpMinuteVal * 6);
}

function syncTpInputs(force) {
  const h = document.getElementById('tpHour');
  const m = document.getElementById('tpMinute');
  if (h && (force || document.activeElement !== h)) h.value = String(tpHourVal).padStart(2, '0');
  if (m && (force || document.activeElement !== m)) m.value = String(tpMinuteVal).padStart(2, '0');
}

/* 手指位置 → 角度；角度 → 时/分 */
function tpPoint(ev) {
  const svg = document.getElementById('tpDial');
  const rect = svg.getBoundingClientRect();
  const w = rect.width || 260;
  const h = rect.height || 260;
  const x = (ev.clientX - rect.left) * 260 / w;
  const y = (ev.clientY - rect.top) * 260 / h;
  const dx = x - TP_C;
  const dy = y - TP_C;
  return {
    r: Math.sqrt(dx * dx + dy * dy),
    a: (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360
  };
}

function tpApplyPoint(ev, mode) {
  const p = tpPoint(ev);
  if (mode === 'hour') {
    tpHourVal = dialAngleToHour(p.a);
  } else {
    tpMinuteVal = dialAngleToMinute(p.a);
  }
  renderTpHands();
  syncTpInputs(false);
}

function bindTpPointer() {
  if (tpBound) return;
  const svg = document.getElementById('tpDial');
  if (!svg || !svg.addEventListener) return;
  const end = () => { tpDragMode = null; };

  svg.addEventListener('pointerdown', ev => {
    const p = tpPoint(ev);
    tpDragMode = p.r < TP_RING_SPLIT ? 'min' : 'hour';
    if (svg.setPointerCapture) {
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 老 WebView 不支持就算了 */ }
    }
    if (ev.preventDefault) ev.preventDefault();
    tpApplyPoint(ev, tpDragMode);
  });
  svg.addEventListener('pointermove', ev => {
    if (!tpDragMode) return;
    if (ev.preventDefault) ev.preventDefault();
    tpApplyPoint(ev, tpDragMode);
  });
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', () => { if (tpDragMode) tpDragMode = null; });
  tpBound = true;
}

function onTpInput(isHour) {
  const el = document.getElementById(isHour ? 'tpHour' : 'tpMinute');
  if (!el) return;
  const raw = String(el.value || '').replace(/[^0-9]/g, '').slice(0, 2);
  el.value = raw;
  const max = isHour ? 23 : 59;
  const v = raw === '' ? 0 : Math.min(parseInt(raw, 10) || 0, max);
  if (isHour) tpHourVal = v; else tpMinuteVal = v;
  renderTpHands();
}

function normalizeTpInput(isHour) {
  const el = document.getElementById(isHour ? 'tpHour' : 'tpMinute');
  if (!el) return;
  const max = isHour ? 23 : 59;
  const v = Math.min(Math.max(parseInt(el.value, 10) || 0, 0), max);
  if (isHour) tpHourVal = v; else tpMinuteVal = v;
  el.value = String(v).padStart(2, '0');
  renderTpHands();
}

function openTimePicker(i) {
  const el = document.getElementById('reminderTime' + i);
  tpSlot = i;
  if (el && isValidTimeStr(el.value)) {
    tpHourVal = parseInt(el.value.substring(0, 2), 10);
    tpMinuteVal = parseInt(el.value.substring(3, 5), 10);
  } else {
    const now = new Date();
    tpHourVal = now.getHours();
    tpMinuteVal = now.getMinutes();
  }
  buildTpDial();
  bindTpPointer();
  renderTpHands();
  syncTpInputs(true);
  document.getElementById('timePickerModal').classList.add('active');
}

function closeTimePicker() {
  document.getElementById('timePickerModal').classList.remove('active');
  tpSlot = -1;
  tpDragMode = null;
}

function confirmTimePicker() {
  const slot = tpSlot;
  closeTimePicker();
  if (slot < 0) return;
  const el = document.getElementById('reminderTime' + slot);
  if (!el) return;
  el.value = String(tpHourVal).padStart(2, '0') + ':' + String(tpMinuteVal).padStart(2, '0');
}

function openModal() {
  editingIndex = -1;
  document.getElementById('modalTitle').textContent = '添加';
  document.getElementById('habitName').value = '';
  document.getElementById('totalDays').value = '30';
  document.getElementById('startDate').value = formatDate(new Date());
  lockTypeSelector(false);
  selectType(TYPE_DAILY, true);
  selectMode('single');
  renderSlotNameInputs();
  renderReminderInputs([]);
  document.getElementById('modal').classList.add('active');
}

/* ---------- 编辑（不自动聚焦，避免弹出输入法） ---------- */
function openEditModal(i, e) {
  if (e) e.stopPropagation();
  const h = getHabits();
  if (!h[i]) return;
  editingIndex = i;
  const type = getHabitType(h[i]);
  document.getElementById('modalTitle').textContent = '编辑';
  document.getElementById('habitName').value = h[i].name;
  lockTypeSelector(true);
  selectType(type, true);
  if (type === TYPE_DAILY) {
    document.getElementById('startDate').value = h[i].startDate;
    document.getElementById('totalDays').value = h[i].totalDays;
    selectMode(h[i].mode);
    renderSlotNameInputs(h[i].slotNames);
    renderReminderInputs(h[i].reminderTimes || []);
  }
  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  editingIndex = -1;
  lockTypeSelector(false);
}

async function saveHabit() {
  const name = document.getElementById('habitName').value.trim();
  const type = selectedType || TYPE_DAILY;
  const habits = getHabits();
  let savedId = '';

  if (!name) { alert('请输入名称'); return; }

  /* ---- 记录清单：只要一个名称 ---- */
  if (type === TYPE_LIST) {
    if (editingIndex >= 0 && habits[editingIndex]) {
      habits[editingIndex].name = name;
      habits[editingIndex].type = TYPE_LIST;
    } else {
      habits.push({
        id: newHabitId(),
        type: TYPE_LIST,
        name,
        items: [],
        expanded: true,
        order: habits.length
      });
    }
    saveHabits(habits);
    closeModal();
    renderHabits();
    // 新建的清单不再自动弹「添加一条」，避免打断用户
    return;
  }

  /* ---- 每日打卡 ---- */
  const startDate = document.getElementById('startDate').value;
  const totalDays = parseInt(document.getElementById('totalDays').value, 10) || 30;
  const mode = selectedMode || 'single';

  if (!startDate) { alert('请选择开始日期'); return; }
  if (totalDays < 1 || totalDays > 3650) { alert('总天数需在 1 至 3650 之间'); return; }

  let slotNames = getDefaultSlotNames(mode);
  if (mode !== 'single') {
    const n = getSlotCount(mode);
    slotNames = [];
    for (let i = 0; i < n; i++) {
      const el = document.getElementById('slotName' + i);
      const v = el ? el.value.trim().slice(0, 6) : '';
      slotNames.push(v || getDefaultSlotNames(mode)[i]);
    }
  }

  // 提醒时间：每个时段一个，留空 = 不提醒
  const reminderTimes = [];
  for (let i = 0; i < getSlotCount(mode); i++) {
    const el = document.getElementById('reminderTime' + i);
    reminderTimes.push(el && isValidTimeStr(el.value) ? el.value : '');
  }

  if (editingIndex >= 0 && habits[editingIndex]) {
    const old = habits[editingIndex];
    // 必须在改写 mode/slotNames 之前迁移，否则读不到旧频率和旧时段名
    migrateModeData(old, mode, slotNames);
    old.type = TYPE_DAILY;
    old.name = name;
    old.startDate = startDate;
    old.totalDays = totalDays;
    old.mode = mode;
    old.slotNames = slotNames;
    old.reminderTimes = reminderTimes;
    const validDates = new Set(getDates(startDate, totalDays).map(d => d.dateStr));
    if (mode === 'single') {
      old.completedDates = (old.completedDates || []).filter(d => validDates.has(d));
    } else {
      const newCounts = {};
      for (const k in (old.completedCounts || {})) {
        if (validDates.has(k)) newCounts[k] = old.completedCounts[k];
      }
      old.completedCounts = newCounts;
    }
    old.lockedDates = (old.lockedDates || []).filter(d => validDates.has(d));
    const newNotes = {};
    for (const k in (old.notes || {})) {
      if (validDates.has(k)) newNotes[k] = old.notes[k];
    }
    old.notes = newNotes;
    // 保留用户手工展开的月份，只清掉已不存在的月份
    const validMonths = new Set([...validDates].map(d => d.substring(0, 7)));
    old.expandedMonths = (old.expandedMonths || []).filter(m => validMonths.has(m));
    ensureExpandedMonths(old);
    saveHabits(habits);
    savedId = old.id;
    closeModal();
    renderHabits();
  } else {
    const created = {
      id: newHabitId(),
      type: TYPE_DAILY,
      name, startDate, totalDays, mode, slotNames, reminderTimes,
      completedDates: [], completedCounts: {}, notes: {},
      lockedDates: [], masterLocked: false, deleteLocked: false,
      expanded: true, expandedMonths: [], order: habits.length
    };
    ensureExpandedMonths(created);
    habits.push(created);
    saveHabits(habits);
    savedId = created.id;
    closeModal();
    renderHabits();
  }

  await applyReminders(reminderTimes, savedId);
}

/* ============ 渲染 ============ */
function renderHabits(preserveScroll) {
  if (preserveScroll === undefined) preserveScroll = true;
  const scrollY = preserveScroll ? window.scrollY : 0;

  const habits = getHabits();
  const container = document.getElementById('habitList');

  if (habits.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📝</div><p>还没有内容<br>点下面按钮添加打卡或记录</p></div>';
    if (preserveScroll) window.scrollTo(0, scrollY);
    return;
  }

  container.innerHTML = habits.map((habit, habitIndex) => (
    getHabitType(habit) === TYPE_LIST
      ? renderListCard(habit, habitIndex, habits.length)
      : renderDailyCard(habit, habitIndex, habits.length)
  )).join('');

  if (preserveScroll) window.scrollTo(0, scrollY);
}

/* 卡片公共的右上角操作区（上移/下移/锁定全部/编辑/删除/展开） */
function renderCardActions(habit, habitIndex, total) {
  const isExpanded = habit.expanded !== false;
  const isMasterLocked = habit.masterLocked || false;
  const isDeleteLocked = habit.deleteLocked || false;
  return `
    <div class="habit-stats">
      <div class="habit-stats-row">
        <button class="icon-btn move-btn" onclick="moveHabit(${habitIndex}, -1, event)" title="上移" ${habitIndex === 0 ? 'disabled' : ''}>上移</button>
        <button class="icon-btn move-btn" onclick="moveHabit(${habitIndex}, 1, event)" title="下移" ${habitIndex === total - 1 ? 'disabled' : ''}>下移</button>
      </div>
      <div class="habit-stats-row">
        <button class="icon-btn ${isMasterLocked ? 'locked' : ''}"
                onclick="toggleMasterLock(${habitIndex}, event)"
                title="${isMasterLocked ? '已锁定，点击解锁' : '锁定全部'}">${isMasterLocked ? '🔒' : '🔓'}</button>
        <button class="icon-btn" onclick="openEditModal(${habitIndex}, event)" title="编辑">✏️</button>
        <button class="icon-btn delete-btn ${isDeleteLocked ? 'locked' : ''}"
                onclick="event.stopPropagation()"
                ontouchstart="startDeletePress(${habitIndex}, event)"
                ontouchend="endDeletePress(${habitIndex}, event)"
                ontouchmove="cancelDeletePress(event)"
                onmousedown="startDeletePress(${habitIndex}, event)"
                onmouseup="endDeletePress(${habitIndex}, event)"
                onmouseleave="cancelDeletePress(event)"
                title="${isDeleteLocked ? '已锁定，长按解锁' : '短按删除，长按锁定'}">🗑️</button>
        <span class="arrow ${isExpanded ? 'expanded' : ''}">▼</span>
      </div>
    </div>`;
}

/* ---------- 记录清单卡片 ---------- */
function renderListCard(habit, habitIndex, total) {
  const isExpanded = habit.expanded !== false;
  const isMasterLocked = habit.masterLocked || false;
  const stats = getListStats(habit);
  const items = habit.items || [];

  const rows = items.length === 0
    ? '<div class="list-empty">还没有条目，在下面输入框里加一条</div>'
    : items.map(it => {
        const locked = isMasterLocked || it.locked;
        return `
          <div class="list-row ${it.done ? 'done' : ''} ${locked ? 'locked' : ''}"
               data-item="${it.id}"
               ontouchstart="itemPressStart(${habitIndex}, '${it.id}', event)"
               ontouchmove="itemPressMove(event)"
               ontouchend="itemPressEnd(${habitIndex}, '${it.id}', event)"
               onmousedown="itemPressStart(${habitIndex}, '${it.id}', event)"
               onmousemove="itemPressMove(event)"
               onmouseup="itemPressEnd(${habitIndex}, '${it.id}', event)"
               onmouseleave="itemPressCancel(event)">
            <div class="item-box ${it.done ? 'checked' : ''}">${it.done ? '✓' : ''}</div>
            <div class="item-text">${escapeHtml(it.text)}</div>
            <button class="item-btn item-edit" title="修改文字"
                    ontouchstart="event.stopPropagation()" ontouchend="event.stopPropagation()"
                    onmousedown="event.stopPropagation()"
                    onclick="startItemEdit(${habitIndex}, '${it.id}', event)">✏️</button>
            <button class="item-btn item-del" title="删除这条"
                    ontouchstart="event.stopPropagation()" ontouchend="event.stopPropagation()"
                    onmousedown="event.stopPropagation()"
                    onclick="deleteListItem(${habitIndex}, '${it.id}', event)">🗑️</button>
            ${locked ? '<div class="item-lock-icon">🔒</div>' : ''}
          </div>`;
      }).join('');

  return `
    <div class="card list-card">
      <div class="habit-header" onclick="toggleExpand(${habitIndex})">
        <div class="habit-info">
          <div class="habit-title-row">
            <h3>${escapeHtml(habit.name)}</h3>
            <span class="progress-text">${stats.done} / ${stats.total}</span>
          </div>
          <div class="date-info">
            <div>记录清单</div>
            <div>${stats.total - stats.done} 条待完成 · 共 ${stats.total} 条</div>
          </div>
        </div>
        ${renderCardActions(habit, habitIndex, total)}
      </div>

      <div class="date-list ${isExpanded ? 'expanded' : ''}">
        <div class="long-press-hint">💡 点条目打勾 · 长按锁定 · 右侧可改字或删除</div>
        <div class="list-body">${rows}</div>
        <div class="list-add-row">
          <button class="list-add-open" ${isMasterLocked ? 'disabled' : ''}
                  onclick="event.stopPropagation(); openItemModal(${habitIndex})">＋ 添加一条</button>
        </div>
        <div class="habit-footer">
          <button class="btn-small btn-export-one" onclick="exportSingleHabit(${habitIndex}, event)">📤 导出此项</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------- 每日打卡卡片 ---------- */
function renderDailyCard(habit, habitIndex, total) {
  const mode = habit.mode || 'single';
  const dates = getDates(habit.startDate, habit.totalDays);
  const totalSlots = getTotalSlots(habit);
  const completedCount = getTotalCompletedCount(habit);
  const progress = totalSlots > 0 ? Math.round(completedCount / totalSlots * 100) : 0;
  const isExpanded = habit.expanded || false;
  const isMasterLocked = habit.masterLocked || false;
  const lockedDates = habit.lockedDates || [];
  const isArchived = progress >= 100 && totalSlots > 0;

  const perDayLabel = mode === 'single' ? '每日1次' : mode === 'twice' ? '每日2次' : '每日3次';

  return `
    <div class="card ${isArchived ? 'archived' : ''}" data-habit-id="${escapeHtml(habit.id || '')}" data-habit-index="${habitIndex}">
      <div class="habit-header" onclick="toggleExpand(${habitIndex})">
        <div class="habit-info">
          <div class="habit-title-row">
            <h3>${escapeHtml(habit.name)} ${isArchived ? '✅' : ''}</h3>
            <span class="progress-text">${completedCount}/${totalSlots}</span>
          </div>
          <div class="date-info">
            <div>${habit.startDate} 开始</div>
            <div>${habit.totalDays}天 · ${perDayLabel}</div>
          </div>
          <div class="progress-bar-small">
            <div class="progress-fill-small" style="width:${Math.min(progress, 100)}%"></div>
          </div>
        </div>
        ${renderCardActions(habit, habitIndex, total)}
      </div>

      <div class="date-list ${isExpanded ? 'expanded' : ''}">
        <div class="long-press-hint">💡 长按整行可锁定/解锁 · 点击 🗨️ 添加备注 · 点击卡片上的🔓 ：一键锁定全部打卡（锁定期间不再收到该打卡通知）</div>
        ${renderDateSection(habit, habitIndex, dates, mode, lockedDates, isMasterLocked)}
        <div class="habit-footer">
          <button class="btn-small btn-check-all" onclick="checkAll(${habitIndex}, true)" ${isMasterLocked ? 'disabled' : ''}>全部打卡</button>
          <button class="btn-small btn-uncheck-all" onclick="checkAll(${habitIndex}, false)" ${isMasterLocked ? 'disabled' : ''}>全部取消</button>
          <button class="btn-small btn-export-one" onclick="exportSingleHabit(${habitIndex}, event)">📤 导出此项</button>
        </div>
        <div class="habit-footer add-days-footer">
          <button class="btn-small btn-add-days" onclick="addDays(${habitIndex}, 1)" ${isMasterLocked ? 'disabled' : ''}>+1天</button>
          <button class="btn-small btn-add-days" onclick="addDays(${habitIndex}, 7)" ${isMasterLocked ? 'disabled' : ''}>+7天</button>
          <button class="btn-small btn-add-days" onclick="addDays(${habitIndex}, 30)" ${isMasterLocked ? 'disabled' : ''}>+30天</button>
          <button class="btn-small btn-sub-days" onclick="reduceDays(${habitIndex}, 1)" ${isMasterLocked ? 'disabled' : ''}>-1天</button>
          <button class="btn-small btn-sub-days" onclick="reduceDays(${habitIndex}, 7)" ${isMasterLocked ? 'disabled' : ''}>-7天</button>
          <button class="btn-small btn-sub-days" onclick="reduceDays(${habitIndex}, 30)" ${isMasterLocked ? 'disabled' : ''}>-30天</button>
        </div>
      </div>
    </div>
  `;
}

function renderDateSection(habit, habitIndex, dates, mode, lockedDates, isMasterLocked) {
  // 只要日期跨了月份就按月折叠（原来是 totalDays > 60 才折，多数项目永远折不到）
  const groups = groupByMonth(dates);
  if (groups.length <= 1) {
    return dates.map(d => renderDateItem(habit, habitIndex, d, mode, lockedDates, isMasterLocked)).join('');
  }
  const expandedMonths = habit.expandedMonths || [];
  return groups.map(g => {
    const isOpen = expandedMonths.includes(g.monthKey);
    const bodyContent = isOpen
      ? g.dates.map(d => renderDateItem(habit, habitIndex, d, mode, lockedDates, isMasterLocked)).join('')
      : '';
    return `
      <div class="month-group">
        <div class="month-header" onclick="toggleMonth(${habitIndex}, '${g.monthKey}', event)">
          <span>${g.monthLabel}（${g.dates.length} 天）</span>
          <span class="month-arrow">${isOpen ? '▼' : '▶'}</span>
        </div>
        <div class="month-body" style="${isOpen ? '' : 'display:none'}">${bodyContent}</div>
      </div>
    `;
  }).join('');
}

function renderDateItem(habit, habitIndex, d, mode, lockedDates, isMasterLocked) {
  const isLocked = isMasterLocked || lockedDates.includes(d.dateStr);
  const status = getDayStatus(habit, d.dateStr);
  const dayCount = status.filter(Boolean).length;
  const hasNote = habit.notes && habit.notes[d.dateStr];
  const noteIcon = hasNote ? '📝' : '🗨️';

  const noteBtn = isLocked
    ? `<span class="note-btn locked-note" title="已锁定">${noteIcon}</span>`
    : `<button class="note-btn ${hasNote ? 'has-note' : ''}"
      ontouchstart="event.stopPropagation()"
      ontouchend="event.stopPropagation()"
      onmousedown="event.stopPropagation()"
      onclick="event.stopPropagation(); openNoteModal(${habitIndex}, '${d.dateStr}')"
      title="${hasNote ? escapeHtml(hasNote) : '添加备注'}">${noteIcon}</button>`;

  const baseAttrs = `
    data-date="${d.dateStr}"
    ontouchstart="onDateTouchStart(event, ${habitIndex}, '${d.dateStr}')"
    ontouchmove="handleTouchMove()"
    ontouchend="onDateTouchEnd(event, ${habitIndex}, '${d.dateStr}')"
    onmousedown="startLongPress(() => toggleDateLock(${habitIndex}, '${d.dateStr}'))"
    onmouseup="cancelLongPress()"
    onmouseleave="cancelLongPress()"
    onclick="onDateClick(event, ${habitIndex}, '${d.dateStr}')"`;

  if (mode === 'single') {
    const checked = status[0] || false;
    return `
      <div class="date-item ${isLocked ? 'locked' : ''}" ${baseAttrs}>
        <div class="date-number ${isLocked ? 'locked' : ''}">${d.count}</div>
        <div class="date-text">${d.display}${noteBtn}</div>
        <div class="check-btn ${checked ? 'checked' : ''} ${isLocked ? 'locked' : ''}"
             ontouchstart="btnPressStart(${habitIndex}, '${d.dateStr}', -1, event)"
             ontouchmove="btnPressMove(event)"
             ontouchend="btnPressEnd(${habitIndex}, '${d.dateStr}', -1, event)"
             onmousedown="btnPressStart(${habitIndex}, '${d.dateStr}', -1, event)"
             onmousemove="btnPressMove(event)"
             onmouseup="btnPressEnd(${habitIndex}, '${d.dateStr}', -1, event)"
             onmouseleave="btnPressCancel(event)">
          ${checked ? '✓' : ''}
        </div>
        ${isLocked ? '<div class="date-lock-icon">🔒</div>' : ''}
      </div>`;
  }

  const slotCount = getSlotCount(mode);
  const progressLabel = dayCount === slotCount ? '✅' : (dayCount > 0 ? dayCount + '/' + slotCount : '');
  const slots = Array.from({ length: slotCount }, (_, i) => {
    const checked = status[i] || false;
    const label = getSlotShort(mode, i);
    const sub = getSlotLabel(habit, i);
    return `<button class="slot-btn ${checked ? 'checked' : ''} ${isLocked ? 'locked' : ''}" data-slot="${i}"
        ontouchstart="btnPressStart(${habitIndex}, '${d.dateStr}', ${i}, event)"
        ontouchmove="btnPressMove(event)"
        ontouchend="btnPressEnd(${habitIndex}, '${d.dateStr}', ${i}, event)"
        onmousedown="btnPressStart(${habitIndex}, '${d.dateStr}', ${i}, event)"
        onmousemove="btnPressMove(event)"
        onmouseup="btnPressEnd(${habitIndex}, '${d.dateStr}', ${i}, event)"
        onmouseleave="btnPressCancel(event)"
        title="${escapeHtml(sub)}">
        <span class="label">${label}</span><span class="sub-label">${escapeHtml(sub)}</span>
      </button>`;
  }).join('');

  return `
    <div class="date-item multi-mode ${isLocked ? 'locked' : ''}" ${baseAttrs}>
      <div class="date-number ${isLocked ? 'locked' : ''}">${d.count}</div>
      <div class="date-text">${d.display}${noteBtn}</div>
      <div class="date-progress ${dayCount === slotCount ? 'done' : ''}">${progressLabel}</div>
      <div class="slot-group">${slots}</div>
      ${isLocked ? '<div class="date-lock-icon">🔒</div>' : ''}
    </div>`;
}

/* ---------- 兼容旧版本自动生成的「我的打卡」 ---------- */
// 新版不再自动创建任何项目：一个都没有时就显示空状态，等用户自己添加。
// 这个判断只用于兼容老安装 —— 如果仅剩一条从没动过的「我的打卡」，
// 导入备份时直接导入，不必再问合并还是替换。
function isUntouchedDefault(h) {
  return h.name === '我的打卡' &&
    (h.completedDates || []).length === 0 &&
    Object.keys(h.completedCounts || {}).length === 0 &&
    Object.keys(h.notes || {}).length === 0 &&
    (h.items || []).length === 0;
}

/* ---------- 使用说明弹窗：两张卡片（使用说明 / 功能） ---------- */
function openHelpModal() {
  switchHelpTab('guide');
  document.getElementById('helpModal').classList.add('active');
}

function closeHelpModal() {
  document.getElementById('helpModal').classList.remove('active');
}

function switchHelpTab(which) {
  const guide = which !== 'tools';
  document.getElementById('helpPaneGuide').style.display = guide ? '' : 'none';
  document.getElementById('helpPaneTools').style.display = guide ? 'none' : '';
  document.getElementById('helpTabGuide').classList.toggle('active', guide);
  document.getElementById('helpTabTools').classList.toggle('active', !guide);
}

/* 字号缩放：Android WebView 支持 -webkit-text-size-adjust，只放大文字、不动布局 */
const UI_SCALES = [70, 80, 90, 100, 110, 120, 130];
const UI_SCALE_KEY = 'checkin_ui_scale_v1';
let uiScaleIndex = UI_SCALES.indexOf(100);   // 默认 100%

function applyUiScale() {
  const pct = UI_SCALES[uiScaleIndex];
  const v = pct + '%';
  [document.documentElement, document.body].forEach(el => {
    if (!el || !el.style) return;
    el.style.webkitTextSizeAdjust = v;
    el.style.textSizeAdjust = v;
  });
  const label = document.getElementById('fontScaleVal');
  if (label) label.textContent = pct === 100 ? '默认' : pct + '%';
}

function loadUiScale() {
  try {
    const saved = parseInt(localStorage.getItem(UI_SCALE_KEY), 10);
    const idx = UI_SCALES.indexOf(saved);
    if (idx > -1) uiScaleIndex = idx;
  } catch (e) { /* 读不到就用默认 */ }
  applyUiScale();
}

function changeUiScale(delta) {
  uiScaleIndex = Math.max(0, Math.min(UI_SCALES.length - 1, uiScaleIndex + delta));
  try { localStorage.setItem(UI_SCALE_KEY, String(UI_SCALES[uiScaleIndex])); } catch (e) { /* 忽略 */ }
  applyUiScale();
}

/* 开屏动画开关：判断放在这里，读标记的早脚本在 index.html 的 head 里（防闪绿） */
const SPLASH_KEY = 'checkin_splash_off_v1';

function isSplashOff() {
  try { return localStorage.getItem(SPLASH_KEY) === '1'; } catch (e) { return false; }
}

function applySplashSetting() {
  const off = isSplashOff();
  if (document.documentElement && document.documentElement.classList) {
    document.documentElement.classList.toggle('no-splash', off);
  }
  if (off) {
    const el = document.getElementById('splash');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  const toggle = document.getElementById('splashToggle');
  if (toggle && toggle.classList) {
    toggle.classList.toggle('on', !off);
    if (toggle.setAttribute) toggle.setAttribute('aria-checked', off ? 'false' : 'true');
  }
}

function toggleSplash() {
  try { localStorage.setItem(SPLASH_KEY, isSplashOff() ? '0' : '1'); } catch (e) { /* 忽略 */ }
  applySplashSetting();
  showToast(isSplashOff() ? '已关闭开屏动画' : '已开启开屏动画', 2000);
}

/* 主题：CSS 变量驱动，data-theme 挂在 <html> 上；head 早脚本先读一次防闪色 */
const THEME_KEY = 'checkin_theme_v1';
const THEMES = ['default', 'green', 'ocean', 'sunset', 'sakura', 'teal',
  'peach', 'taro', 'matcha', 'mist', 'dusk', 'aurora'];
const THEME_LABELS = {
  default: '经典紫', green: '森林绿', ocean: '海盐蓝', sunset: '落日橙',
  sakura: '樱花粉', teal: '薄荷青', peach: '蜜桃乌龙', taro: '香芋拿铁',
  matcha: '抹茶奶绿', mist: '雾灰蓝', dusk: '晚霞', aurora: '极光'
};

function getTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.indexOf(v) > -1 ? v : 'default';
  } catch (e) { return 'default'; }
}

function applyTheme() {
  const name = getTheme();
  const root = document.documentElement;
  if (root && root.setAttribute) {
    if (name === 'default') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
  }
  const cur = document.getElementById('themeCurrent');
  if (cur) cur.textContent = THEME_LABELS[name] || '经典紫';
  THEMES.forEach(t => {
    const el = document.getElementById('themeItem_' + t);
    if (!el || !el.classList) return;
    el.classList.toggle('active', t === name);
    if (el.setAttribute) el.setAttribute('aria-pressed', t === name ? 'true' : 'false');
  });
}

function setTheme(name) {
  if (THEMES.indexOf(name) === -1) return;
  try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* 忽略 */ }
  applyTheme();
  showToast('已切换到「' + THEME_LABELS[name] + '」主题', 2000);
}

/* ---------- 使用说明底部「问题总览」 ----------
   一次性弹的提示容易被划走，改成常驻入口。以后有新问题往这里加一条即可 */
const TROUBLE_GUIDE = {
  'no-notify': {
    title: '到设置的提醒时间后未收到通知？',
    html: '<p>请按顺序检查：</p>'
      + '<p><b>① 检查【通知权限】</b><br>未开启【通知权限】，提醒无法弹出。<br>'
      + '设置 → 应用 → 打卡工具 → 通知 → 允许通知。</p>'
      + '<p><b>② 检查【自启动】</b><br>未开启该应用的【自启动】，退出 App 后系统无法发送通知。<br>'
      + '设置 → 应用 → 打卡工具 → 打开「自启动」。</p>'
      + '<p><b>③ 检查【省电策略】</b><br>未将【省电策略】设为「无限制」，App 挂在后台会被系统冻结，无法收到通知。<br>'
      + '设置 → 应用 → 打卡工具 → 省电策略 → 选择「无限制」。</p>'
  }
};

function showTrouble(id) {
  const item = TROUBLE_GUIDE[id];
  if (!item) return;
  document.getElementById('troubleTitle').textContent = item.title;
  document.getElementById('troubleBody').innerHTML = item.html;
  document.getElementById('troubleModal').classList.add('active');
}

function closeTroubleModal() {
  document.getElementById('troubleModal').classList.remove('active');
}
document.getElementById('troubleModal').addEventListener('click', function (e) {
  if (e.target === this) closeTroubleModal();
});

/* ---------- 通用提示弹窗（比原生 alert 醒目、可读） ---------- */
function showNotice(title, html) {
  document.getElementById('noticeTitle').textContent = title;
  document.getElementById('noticeBody').innerHTML = html;
  document.getElementById('noticeModal').classList.add('active');
}

function closeNoticeModal() {
  document.getElementById('noticeModal').classList.remove('active');
}
document.getElementById('noticeModal').addEventListener('click', function (e) {
  if (e.target === this) closeNoticeModal();
});

/* ---------- 事件绑定 ---------- */
document.getElementById('noteInput').addEventListener('input', updateNoteCharCount);

/* 卡片内长按已有自己的交互，别让系统再弹「复制 / 全选」菜单 */
document.addEventListener('contextmenu', function (e) {
  const t = e.target;
  if (t && t.closest && t.closest('.card') && !t.closest('input, textarea')) {
    e.preventDefault();
  }
});

/* 添加清单条目的弹窗 */
document.getElementById('itemInput').addEventListener('input', function () {
  document.getElementById('itemCharCount').textContent = this.value.length;
});
document.getElementById('itemInput').addEventListener('keydown', function (ev) {
  // 中文输入法敲回车是确认候选词，不能当提交
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  saveItemModal();
});
document.getElementById('itemDone').onclick = closeItemModal;
document.getElementById('itemSave').onclick = saveItemModal;
document.getElementById('itemModal').addEventListener('click', function (e) {
  if (e.target === this) closeItemModal();
});

document.getElementById('modal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});
document.getElementById('noteModal').addEventListener('click', function (e) {
  if (e.target === this) closeNoteModal();
});
document.getElementById('exportModal').addEventListener('click', function (e) {
  if (e.target === this) closeExportModal();
});
document.getElementById('helpModal').addEventListener('click', function (e) {
  if (e.target === this) closeHelpModal();
});

document.getElementById('confirmYes').onclick = () => closeConfirm(true);
document.getElementById('confirmNo').onclick = () => closeConfirm(false);
document.getElementById('confirmModal').addEventListener('click', function (e) {
  // 刚弹出的 400ms 内忽略遮罩点击：防止删除/打卡那一串合成事件把弹窗顺手关掉
  if (e.target === this && Date.now() - confirmOpenedAt > 400) closeConfirm(false);
});

document.getElementById('importCancel').onclick = () => closeImportChoice(null);
document.getElementById('importReplace').onclick = () => closeImportChoice('replace');
document.getElementById('importMerge').onclick = () => closeImportChoice('merge');
document.getElementById('importModal').addEventListener('click', function (e) {
  if (e.target === this && Date.now() - importOpenedAt > 400) closeImportChoice(null);
});

/* ---------- 返回键：有弹窗先关弹窗，没弹窗才退出 App ---------- */
function closeTopModal() {
  if (document.getElementById('syncModal').classList.contains('active')) { closeSyncModal(); return true; }
  if (document.getElementById('reminderStatusModal').classList.contains('active')) { closeReminderStatus(); return true; }
  if (document.getElementById('timePickerModal').classList.contains('active')) { closeTimePicker(); return true; }
  if (document.getElementById('confirmModal').classList.contains('active')) { closeConfirm(false); return true; }
  if (document.getElementById('importModal').classList.contains('active')) { closeImportChoice(null); return true; }
  if (document.getElementById('itemModal').classList.contains('active')) { closeItemModal(); return true; }
  if (document.getElementById('noteModal').classList.contains('active')) { closeNoteModal(); return true; }
  if (document.getElementById('modal').classList.contains('active')) { closeModal(); return true; }
  if (document.getElementById('exportModal').classList.contains('active')) { closeExportModal(); return true; }
  if (document.getElementById('noticeModal').classList.contains('active')) { closeNoticeModal(); return true; }
  if (document.getElementById('troubleModal').classList.contains('active')) { closeTroubleModal(); return true; }
  if (document.getElementById('helpModal').classList.contains('active')) { closeHelpModal(); return true; }
  return false;
}

function setupBackButton() {
  const AppPlugin = (typeof Capacitor !== 'undefined' && Capacitor.Plugins) ? Capacitor.Plugins.App : null;
  if (!AppPlugin || !AppPlugin.addListener) return;   // 浏览器里没有这个插件，跳过
  AppPlugin.addListener('backButton', () => {
    if (!closeTopModal() && AppPlugin.exitApp) AppPlugin.exitApp();
  });
}

/* ============ 打卡提醒（本地通知） ============ */
const REMIND_DAYS = 14;          // 每次打开 App 往后预排的天数
const REMIND_GAP_MIN = 10;       // 没打卡时重复提醒的间隔（分钟）
const REMIND_MAX_TIMES = 3;      // 每个时段最多提醒几次（含第一次）
const REMIND_MAX_TOTAL = 300;    // 一次最多排多少条，防止通知过多
const REMIND_ACTION_TYPE = 'CHECKIN_REMIND';
const REMIND_CHANNEL = 'checkin-remind-v2';   // 自己的高优先级通道，才会横幅弹出
const REMIND_CHANNEL_OLD = 'checkin-remind';  // 上一版建错的（无声音），启动时清掉
const REMIND_ID_BASE = 20000;

let notifyPermission = false;
let reminderTimer = null;
let exactAlarmOk = true;        // 「精确闹钟」权限；默认 true，免得没查就骚扰用户
let exactAlarmWarned = false;   // 每次启动只提示一次
let lastScheduleInfo = null;    // 最近一次排提醒的结果，诊断页要用

function getNotifyPlugin() {
  if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
    return Capacitor.Plugins.LocalNotifications;
  }
  return null;
}

async function ensureNotifyPermission(silent) {
  const LN = getNotifyPlugin();
  if (!LN) return false;
  try {
    const cur = await LN.checkPermissions();
    if (cur && cur.display === 'granted') { notifyPermission = true; return true; }
    if (silent) { notifyPermission = false; return false; }
    const asked = await LN.requestPermissions();
    notifyPermission = !!(asked && asked.display === 'granted');
    return notifyPermission;
  } catch (e) {
    console.warn('[提醒] 权限检查失败', e);
    return false;
  }
}

/* 「精确闹钟」权限：Android 13+ 默认拒绝，没开时闹钟会被降级成不精确闹钟，
   息屏进 Doze 后系统攒着不发，表现就是「只有开着 App 才提醒」 */
async function refreshExactAlarm() {
  const LN = getNotifyPlugin();
  if (!LN || typeof LN.checkExactNotificationSetting !== 'function') { exactAlarmOk = true; return true; }
  try {
    const st = await LN.checkExactNotificationSetting();
    if (!st || st.exact_alarm === undefined) { exactAlarmOk = true; return true; }
    exactAlarmOk = st.exact_alarm === 'granted';
    return exactAlarmOk;
  } catch (e) {
    exactAlarmOk = true;   // 查不了就当没问题，别乱弹提示
    return true;
  }
}

/* 跳到系统「闹钟和提醒」设置页，用户回来后重新读状态 */
async function openExactAlarmSetting() {
  const LN = getNotifyPlugin();
  if (!LN || typeof LN.changeExactNotificationSetting !== 'function') return false;
  try {
    await LN.changeExactNotificationSetting();
  } catch (e) {
    console.warn('[提醒] 打开精确闹钟设置失败', e);
  }
  return await refreshExactAlarm();
}

/* 需要精确闹钟却还没开时，问一次要不要去开 */
async function askExactAlarmIfNeeded(force) {
  if (!getNotifyPlugin() || !notifyPermission) return;
  if (exactAlarmWarned && !force) return;
  if (await refreshExactAlarm()) return;
  exactAlarmWarned = true;
  const yes = await showConfirm(
    '系统没给「精确闹钟」权限，息屏后提醒会被手机攒着发，可能晚几十分钟甚至不发。\n\n去设置里打开吗？',
    '提醒可能不准'
  );
  if (yes) {
    const ok = await openExactAlarmSetting();
    alert(ok ? '已打开，提醒会准时了' : '还没打开。之后可以在 右上角 ! → 提醒设置 里再试');
    if (ok) scheduleRemindersSoon();
  }
}

/* 帮助弹窗里的「提醒设置」：把当前状态一次性说清楚，并且能现场重排 */
function fmtStamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 读「打卡提醒」这个通知通道的真实设置：重要性低或没声音，就会「响了你也听不见」 */
async function getChannelInfo() {
  const LN = getNotifyPlugin();
  if (!LN || typeof LN.listChannels !== 'function') return null;
  try {
    const res = await LN.listChannels();
    const list = (res && res.channels) || [];
    return list.filter(c => c.id === REMIND_CHANNEL)[0] || null;
  } catch (e) {
    console.warn('[提醒] 读取通知通道失败', e);
    return null;
  }
}

async function rebuildChannel() {
  const LN = getNotifyPlugin();
  if (!LN) return;
  try {
    if (typeof LN.deleteChannel === 'function') await LN.deleteChannel({ id: REMIND_CHANNEL });
  } catch (e) { /* 没有就算了 */ }
  try {
    await LN.createChannel({
      id: REMIND_CHANNEL,
      name: '打卡提醒',
      description: '到点提醒你打卡',
      importance: 5,
      visibility: 1,
      vibration: true
    });
  } catch (e) {
    alert('重建通道失败：' + (e && e.message ? e.message : e));
  }
}

/* 帮助弹窗里的「提醒设置」：面板式，四个环节各自一行，
   哪个环节有问题一眼看出，当场就能修，不再让用户读一大段技术字 */
async function showReminderStatus() {
  const LN = getNotifyPlugin();
  // 说明弹窗盖着确认框，先收起来
  closeHelpModal();
  if (!LN) { alert('浏览器里没有本地通知，装到手机上才能看'); return; }

  let perm = null;
  try { perm = await LN.checkPermissions(); } catch (e) { /* 忽略 */ }
  const permOk = !!(perm && perm.display === 'granted');
  await refreshExactAlarm();
  const ch = await getChannelInfo();
  const soundOk = !!ch && ch.importance >= 4 && !!ch.sound;

  let count = 0;
  let nextAt = null;
  try {
    const res = await LN.getPending();
    const list = ((res && res.notifications) || []).filter(n => n.extra && n.extra.checkinHabitId);
    count = list.length;
    const ats = list
      .map(n => (n.schedule && n.schedule.at) ? new Date(n.schedule.at).getTime() : 0)
      .filter(t => t > 0).sort((a, b) => a - b);
    if (ats.length) nextAt = ats[0];
  } catch (e) { /* 忽略 */ }

  // 0 条到底是「本来就没设」还是「设了没排上」，必须分开说，否则白折腾
  const hasAnyTime = getHabits().some(h =>
    getHabitType(h) === TYPE_DAILY && (h.reminderTimes || []).some(t => isValidTimeStr(t))
  );
  const lastOk = lastScheduleInfo ? lastScheduleInfo.scheduled : 0;

  // 每行：[标记, 名称, 人话状态, 修复按钮文字, 修复动作]
  const rows = [];
  rows.push(permOk
    ? ['✅', '通知权限', '已允许', null, null]
    : ['❌', '通知权限', '没开，提醒发不出来', '去开启', fixNotifyPermission]);
  rows.push(soundOk
    ? ['✅', '提醒声音', '会响铃、会震动', null, null]
    : ['⚠️', '提醒声音', '被系统调成了无声，响了也听不见', '一键修复', fixChannel]);
  if (count > 0) {
    rows.push(['✅', '已排提醒', count + ' 条，最早 ' + fmtStamp(nextAt) + ' 响', null, null]);
  } else if (!hasAnyTime) {
    rows.push(['ℹ️', '已排提醒', '还没用过：到项目「编辑」里，给时段填一个时间即可', null, null]);
  } else if (lastOk > 0) {
    rows.push(['⏳', '已排提醒', '刚排了 ' + lastOk + ' 条，系统确认中；稍等再看，或点「刷新」', null, null]);
  } else {
    rows.push(['❌', '已排提醒', '设了提醒时间，但一条都没排上', '刷新', fixReschedule]);
  }

  // 顶部一句话总结
  let summary;
  if (!permOk) summary = '❌ 提醒目前不会响：先开通知权限';
  else if (count === 0 && hasAnyTime && lastOk === 0) summary = '❌ 提醒没排上，点「刷新」试试';
  else if (count === 0 && hasAnyTime) summary = '⏳ 提醒刚排上，系统确认中';
  else if (count === 0) summary = 'ℹ️ 还没使用提醒';
  else summary = '✅ 提醒已就位' + (nextAt ? '，下一次 ' + fmtStamp(nextAt) : '');

  // 技术细节收进折叠区，想查的人再展开
  // 「系统」一行是运行时从浏览器指纹（userAgent）里读出来的真实安卓版本，不是写死的
  const ua = (navigator.userAgent || '').match(/Android\s+([\d.]+)/);
  const detail = ['系统：' + (ua ? 'Android ' + ua[1] : '非安卓')];
  if (lastScheduleInfo) {
    detail.push('未通知数/总通知数：' + lastScheduleInfo.scheduled + '/' + lastScheduleInfo.planned);
    if (lastScheduleInfo.warning) detail.push('⚠️ ' + lastScheduleInfo.warning);
    if (lastScheduleInfo.error) detail.push('❌ 报错：' + lastScheduleInfo.error);
  }

  document.getElementById('rsSummary').textContent = summary;
  document.getElementById('rsItems').innerHTML = rows.map((r, i) =>
    '<div class="rs-row"><span class="rs-mark">' + r[0] + '</span><span class="rs-name">' + r[1]
    + '</span><span class="rs-val">' + r[2] + '</span>'
    + (r[3] ? '<button class="btn btn-mini" id="rsFix' + i + '">' + r[3] + '</button>' : '')
    + '</div>').join('');
  rows.forEach((r, i) => {
    if (!r[3]) return;
    document.getElementById('rsFix' + i).onclick = async () => { await r[4](); showReminderStatus(); };
  });
  document.getElementById('rsDetailText').textContent = detail.join('\n');
  document.getElementById('reminderStatusModal').classList.add('active');
}

function closeReminderStatus() {
  document.getElementById('reminderStatusModal').classList.remove('active');
}
document.getElementById('reminderStatusModal').addEventListener('click', function (e) {
  if (e.target === this) closeReminderStatus();
});

/* 面板上每个「去开启 / 一键修复」对应的动作 */
async function fixNotifyPermission() {
  if (await ensureNotifyPermission(false)) {
    await rescheduleAllReminders();   // 权限刚开，顺手把提醒排上
    return;
  }
  alert('通知权限没开成。\n可以到 系统设置 → 应用 → 打卡工具 → 通知 里手动打开。');
}
async function fixChannel() {
  await rebuildChannel();
  await rescheduleAllReminders();
}
async function fixReschedule() {
  await rescheduleAllReminders();
}

/* 面板底部「刷新」：先重排，等排完再读一次，否则读到的是旧数字；连点只跑一次 */
let refreshingStatus = false;
async function refreshReminderStatus() {
  if (refreshingStatus) return;
  refreshingStatus = true;
  try {
    await fixReschedule();
    await showReminderStatus();
  } finally {
    refreshingStatus = false;
  }
}

/* ---------- 点通知「去打卡」：滚到对应项目的那个时段，并微微闪一下 ---------- */
let glowTimer = null;

function focusHabit(habitId, dateStr, slot) {
  const habits = getHabits();
  const idx = habits.findIndex(h => h.id === habitId);
  if (idx < 0) return;
  const h = habits[idx];

  // 卡片没展开就展开；所在月份收着也展开，否则 DOM 里根本没有那一天
  if (h.expanded === false) h.expanded = true;
  if (getHabitType(h) === TYPE_DAILY && dateStr) {
    const monthKey = dateStr.substring(0, 7);
    const months = h.expandedMonths || [];
    if (!months.includes(monthKey)) { months.push(monthKey); h.expandedMonths = months; }
  }
  saveHabits(habits);
  renderHabits(false);

  // 等一次重绘（innerHTML 刚换完）再滚
  setTimeout(() => {
    const card = document.querySelector('.card[data-habit-id="' + habitId + '"]');
    if (!card) return;
    const target = dateStr
      ? card.querySelector('.date-item[data-date="' + dateStr + '"]')
      : card;
    const slotEl = (target && slot !== undefined && slot !== null && slot >= 0)
      ? target.querySelector('.slot-btn[data-slot="' + slot + '"]')
      : null;

    if (target && target.scrollIntoView) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    [target || card, slotEl].forEach(el => {
      if (el && el.classList) el.classList.add('checkin-glow');
    });
    clearTimeout(glowTimer);
    glowTimer = setTimeout(() => {
      document.querySelectorAll('.checkin-glow').forEach(el => el.classList.remove('checkin-glow'));
    }, 12000);
  }, 80);
}

async function setupReminderChannel() {
  const LN = getNotifyPlugin();
  if (!LN) return;
  // 插件自带的 Default 通道是「普通」级别，只在通知栏躺着、不弹横幅。
  // 自己建一个高级别通道，到点会亮屏弹出来，才不会被当成没提醒。
  // 注意：不要传 sound —— 插件会把 sound 直接拼成 android.resource://包名/raw/<名字>，
  // 传 'default' 会指向一个不存在的资源，通道反而被设成无声。不传才是系统默认铃声。
  try {
    if (typeof LN.createChannel === 'function') {
      await LN.createChannel({
        id: REMIND_CHANNEL,
        name: '打卡提醒',
        description: '到点提醒你打卡',
        importance: 5,          // 5 = 高，允许横幅与提示音
        visibility: 1,          // 锁屏上显示
        vibration: true
      });
    }
  } catch (e) {
    console.warn('[提醒] 创建通知通道失败（可能已存在）', e);
  }
  // 清掉上一版建错的无声通道（Android 通道属性建好就不能改，只能换 id）
  try {
    if (typeof LN.deleteChannel === 'function') await LN.deleteChannel({ id: REMIND_CHANNEL_OLD });
  } catch (e) { /* 没有就算了 */ }
  try {
    await LN.registerActionTypes({
      types: [{
        id: REMIND_ACTION_TYPE,
        actions: [
          { id: 'open', title: '去打卡', foreground: true }
        ]
      }]
    });
  } catch (e) {
    console.warn('[提醒] 注册通知按钮失败', e);
  }
  try {
    LN.addListener('localNotificationActionPerformed', ev => {
      const extra = (ev && ev.notification && ev.notification.extra) || {};
      if (!extra.checkinHabitId) return;
      // 点通知本体、或点「去打卡」：直接滚到该项目的这一天/这个时段
      focusHabit(extra.checkinHabitId, extra.checkinDate, extra.checkinSlot);
    });
  } catch (e) {
    console.warn('[提醒] 注册通知动作失败', e);
  }
}

async function getCheckinPending() {
  const LN = getNotifyPlugin();
  if (!LN) return [];
  try {
    const res = await LN.getPending();
    return ((res && res.notifications) || []).filter(n => n.extra && n.extra.checkinHabitId);
  } catch (e) {
    console.warn('[提醒] 读取待发通知失败', e);
    return [];
  }
}

async function cancelNotifications(list) {
  const LN = getNotifyPlugin();
  if (!LN || !list.length) return;
  try {
    await LN.cancel({ notifications: list.map(n => ({ id: n.id })) });
  } catch (e) {
    console.warn('[提醒] 取消通知失败', e);
  }
}

async function cancelAllCheckinReminders() {
  const LN = getNotifyPlugin();
  if (!LN) return;
  let list = [];
  try {
    const res = await LN.getPending();
    list = (res && res.notifications) || [];
  } catch (e) {
    return;
  }
  // 连同旧版本遗留的「无 habit id」孤儿通知一起清掉：
  // 本应用的提醒 id 固定在 20000~20299，落在这个区间就一定是我们的
  const targets = list.filter(n => {
    const inRange = typeof n.id === 'number'
      && n.id >= REMIND_ID_BASE && n.id < REMIND_ID_BASE + REMIND_MAX_TOTAL;
    return inRange || !!(n.extra && n.extra.checkinHabitId);
  });
  await cancelNotifications(targets);
}

async function cancelHabitReminders(habitId) {
  if (!habitId) return;
  const targets = (await getCheckinPending()).filter(n => n.extra.checkinHabitId === habitId);
  await cancelNotifications(targets);
}

/* 打卡后：只取消该时段当天剩余提醒 */
async function cancelSlotReminders(habitId, dateStr, slotIndex) {
  if (!habitId) return;
  const targets = (await getCheckinPending()).filter(n =>
    n.extra.checkinHabitId === habitId &&
    n.extra.checkinDate === dateStr &&
    n.extra.checkinSlot === slotIndex);
  await cancelNotifications(targets);
}

function isDateInHabit(habit, dateStr) {
  if (!habit.startDate || !habit.totalDays) return false;
  if (dateStr < habit.startDate) return false;
  const [y, m, d] = habit.startDate.split('-').map(Number);
  const end = new Date(y, m - 1, d + habit.totalDays - 1);
  return dateStr <= formatDate(end);
}

/* 所有重排串行执行：连点「刷新」或同时触发续排时，
   避免 cancel/schedule 交叉执行把系统里的提醒搅乱 */
let rescheduleChain = Promise.resolve();
function rescheduleAllReminders() {
  rescheduleChain = rescheduleChain
    .then(() => doRescheduleAllReminders())
    .catch(e => { console.warn('[提醒] 重排失败', e); });
  return rescheduleChain;
}

async function doRescheduleAllReminders() {
  const LN = getNotifyPlugin();
  if (!LN) return;
  const habits = getHabits();
  // 历史数据可能缺 id：排程前补齐并落库，否则通知无法取消/定位
  if (ensureHabitIds(habits)) saveHabits(habits);
  lastScheduleInfo = {
    at: Date.now(), planned: 0, scheduled: 0,
    warning: '', error: '', nextAt: null, byHabit: {}
  };
  await cancelAllCheckinReminders();

  const now = Date.now();
  const items = [];
  habits.forEach(h => {
    if (getHabitType(h) !== TYPE_DAILY) return;
    if (h.masterLocked) return;                       // 全部锁定 = 不打扰
    const slots = getSlotCount(h.mode || 'single');
    for (let s = 0; s < slots; s++) {
      const t = getSlotReminderTime(h, s);
      if (!t) continue;
      const hh = parseInt(t.substring(0, 2), 10);
      const mm = parseInt(t.substring(3, 5), 10);
      if (isNaN(hh) || isNaN(mm)) continue;
      for (let d = 0; d < REMIND_DAYS; d++) {
        const base = new Date();
        base.setHours(0, 0, 0, 0);
        base.setDate(base.getDate() + d);
        const dateStr = formatDate(base);
        if (!isDateInHabit(h, dateStr)) continue;
        if (getDayStatus(h, dateStr)[s]) continue;     // 该时段已经打过卡
        for (let k = 0; k < REMIND_MAX_TIMES; k++) {
          const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm + k * REMIND_GAP_MIN, 0, 0);
          if (at.getTime() <= now + 20000) continue;   // 已经过点/马上到，跳过
          items.push({ habit: h, dateStr, slot: s, attempt: k, at });
        }
      }
    }
  });

  items.sort((a, b) => a.at - b.at);
  const picked = items.slice(0, REMIND_MAX_TOTAL);
  lastScheduleInfo.planned = picked.length;

  // 按项目统计：弹窗要显示「刚保存的项目」排了几条、下一次几点
  const byHabit = {};
  picked.forEach(it => {
    const hid = it.habit.id;
    if (!hid) return;
    if (!byHabit[hid]) byHabit[hid] = { count: 0, nextAt: null };
    byHabit[hid].count++;
    if (byHabit[hid].nextAt === null) byHabit[hid].nextAt = it.at.getTime();
  });
  lastScheduleInfo.byHabit = byHabit;

  const notifications = picked.map((it, idx) => {
    const multi = getSlotCount(it.habit.mode || 'single') > 1;
    const label = multi ? getSlotLabel(it.habit, it.slot) : '';
    return {
      id: REMIND_ID_BASE + idx,
      title: '该打卡了：' + it.habit.name + (label ? ' · ' + label : ''),
      body: it.attempt === 0 ? '点开完成今天的打卡' : '还没打卡，第 ' + (it.attempt + 1) + ' 次提醒',
      channelId: REMIND_CHANNEL,
      schedule: { at: it.at, allowWhileIdle: true },
      // 精确闹钟没开时显式声明不需要精确：否则插件（默认 exact=true）会在
      // 每一批 schedule 时弹一次系统设置页，300 条会弹 6 次
      isExactNotification: exactAlarmOk !== false,
      actionTypeId: REMIND_ACTION_TYPE,
      extra: {
        checkinHabitId: it.habit.id,
        checkinDate: it.dateStr,
        checkinSlot: it.slot,
        checkinAttempt: it.attempt
      }
    };
  });

  for (let i = 0; i < notifications.length; i += 50) {
    const batch = notifications.slice(i, i + 50);
    try {
      const res = await LN.schedule({ notifications: batch });
      lastScheduleInfo.scheduled += batch.length;
      if (res && res.warning) {
        // 插件明确告诉我们「降级成不精确闹钟了」
        lastScheduleInfo.warning = '系统把闹钟降级成不精确的了（精确闹钟没开）';
        exactAlarmOk = false;
      }
    } catch (e) {
      lastScheduleInfo.error = (e && e.message) ? e.message : String(e);
      console.warn('[提醒] 排提醒失败', e);
      break;
    }
  }
  lastScheduleInfo.nextAt = picked.length ? picked[0].at.getTime() : null;
}

/* ---------- 保存后的收尾：居中缓冲弹窗 + 回查 ---------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let toastTimer = null;
function showToast(text, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, ms || 3000);
}

/* 首次使用提醒：把权限一口气都要到手。通知和准点闹钟系统给了申请入口。
   自启动/省电策略这类厂商限制没有 API 可代开，放在 使用说明 → 问题总览 里常驻，
   不再弹一次性提示（容易被划走，也容易忘） */
async function ensureReminderPermissions() {
  if (!getNotifyPlugin()) return false;
  if (!await ensureNotifyPermission(false)) {
    const yes = await showConfirm(
      '提醒要在通知栏弹出来，需要「通知」权限。\n下一步系统会弹授权框，请点「允许」。',
      '开启打卡提醒'
    );
    if (!yes) return false;
    if (!await ensureNotifyPermission(false)) {
      alert('通知权限没开成，提醒不会响。\n可以到 系统设置 → 应用 → 打卡工具 → 通知 里打开，\n再到 右上角 ! → 提醒设置 里重排一次。');
      return false;
    }
  }
  if (!await refreshExactAlarm()) {
    const yes = await showConfirm(
      '还差一个「闹钟和提醒」权限：没开的话，锁屏或退出 App 后\n提醒可能晚几十分钟才来。\n\n现在去开吗？就一个开关，开完会自动回来。',
      '让提醒准点'
    );
    if (yes) {
      const ok = await openExactAlarmSetting();
      if (ok) showToast('准点闹钟已打开，提醒会准时响', 3000);
    }
    // 没开也继续排：只是不准时，不该拦着用户用
  }
  return true;
}

/* 居中缓冲弹窗：阶段一转圈「正在排入」，阶段二报结果 */
let syncRunId = 0;   // 连续保存时，只让最后一次收尾，避免旧的一次覆盖新弹窗

function openSyncModal() {
  document.getElementById('syncSpinner').style.display = '';
  document.getElementById('syncBtns').style.display = 'none';
  document.getElementById('syncTitle').textContent = '正在向系统排入通知';
  document.getElementById('syncText').textContent = '请等待几秒…';
  document.getElementById('syncModal').classList.add('active');
}

function finishSyncModal(mainHtml, hintHtml) {
  document.getElementById('syncSpinner').style.display = 'none';
  document.getElementById('syncTitle').textContent = '提醒已排入';
  document.getElementById('syncText').innerHTML =
    '<div class="sync-count">' + mainHtml + '</div>'
    + (hintHtml ? '<div class="sync-hint">' + hintHtml + '</div>' : '');
  document.getElementById('syncBtns').style.display = '';
}

function closeSyncModal() {
  document.getElementById('syncModal').classList.remove('active');
}

/* 排完跟系统核对：500ms 一查、最多 5 秒。对不上也照常报数，不拦用户 */
async function verifyScheduleSoon() {
  const want = lastScheduleInfo.scheduled;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if ((await getCheckinPending()).length >= want) return true;
  }
  return false;
}

/* 保存/修改完项目后走这一条：权限要全 → 排 → 居中缓冲弹窗两阶段报结果 */
async function applyReminders(reminderTimes, habitId) {
  const hasTime = Array.isArray(reminderTimes) && reminderTimes.some(t => t);
  if (!hasTime) { await rescheduleAllReminders(); return; }

  if (!await ensureReminderPermissions()) return;

  // 弹窗在真正开始排程前就出来，用户看到的是「正在排入」，不是「排完了还在转」
  const runId = ++syncRunId;
  openSyncModal();
  await rescheduleAllReminders();
  if (runId !== syncRunId) return;          // 期间又保存了一次，交给后一次收尾
  if (lastScheduleInfo.error) {
    closeSyncModal();
    alert('排提醒失败：' + lastScheduleInfo.error + '\n\n稍后可以到右上角 ! → 提醒设置 里重排一次。');
    return;
  }

  if (lastScheduleInfo.scheduled > 0) await verifyScheduleSoon();
  if (runId !== syncRunId) return;

  // 刚保存这个项目本次排了几条、下一次是几点；总数用系统实际待发数
  const stat = (lastScheduleInfo.byHabit && lastScheduleInfo.byHabit[habitId])
    || { count: 0, nextAt: null };
  let total = 0;
  try { total = (await getCheckinPending()).length; } catch (e) { total = 0; }
  if (!total) total = lastScheduleInfo.scheduled;

  let main;
  if (stat.count > 0) {
    main = '已添加 ' + stat.count + ' 项通知，当前总通知数为 ' + total + '。'
      + (stat.nextAt ? '最早 ' + fmtStamp(stat.nextAt) + ' 响应。' : '');
  } else {
    main = '本次没有为该项目新增通知（时间已过或已全部打卡）。当前总通知数为 ' + total + '。';
  }
  finishSyncModal(main, '可在右上角【!】里查看通知提醒状态和【问题总览】');

  // 面板正开着就顺手刷新，避免停留在旧数字
  const rs = document.getElementById('reminderStatusModal');
  if (rs && rs.classList.contains('active')) showReminderStatus();
}

function scheduleRemindersSoon() {
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(async () => {
    const ok = notifyPermission || await ensureNotifyPermission(true);
    if (!ok) return;
    await rescheduleAllReminders();
  }, 600);
}

async function initReminders() {
  const LN = getNotifyPlugin();
  if (!LN) return;
  await setupReminderChannel();
  // 旧版本的「今天不再提醒」静音记录已废弃，清掉避免影响当天排程
  try { await Storage.set('checkin_mutes_v1', '{}'); } catch (e) { /* 忽略 */ }
  notifyPermission = await ensureNotifyPermission(true);
  if (notifyPermission) {
    await refreshExactAlarm();
    await rescheduleAllReminders();
    // 排上了但精确闹钟没开：开局提示一次，否则用户只会觉得「提醒时灵时不灵」
    if (!exactAlarmOk) setTimeout(() => { askExactAlarmIfNeeded(); }, 1500);
  }
}

function setupResumeReschedule() {
  const AppPlugin = (typeof Capacitor !== 'undefined' && Capacitor.Plugins) ? Capacitor.Plugins.App : null;
  if (!AppPlugin || !AppPlugin.addListener) return;
  AppPlugin.addListener('appStateChange', async st => {
    if (!st || !st.isActive) return;
    // 从系统设置回来可能刚开了「精确闹钟」，先刷新再排，否则会继续按不精确排
    await refreshExactAlarm();
    scheduleRemindersSoon();
    // 提醒设置面板开着时从系统设置回来，各项状态自动刷新（随系统实时变）
    const rs = document.getElementById('reminderStatusModal');
    if (rs && rs.classList.contains('active')) showReminderStatus();
  });
}

/* 问系统要一份「当前真正排进闹钟队的 id 列表」，用来确认排没排上 */
async function pendingIds() {
  const LN = getNotifyPlugin();
  if (!LN) return [];
  try {
    const res = await LN.getPending();
    return ((res && res.notifications) || []).map(n => n.id);
  } catch (e) {
    return [];
  }
}

/* 测试用：10 秒后弹一条，排上之后会先确认一遍再让你锁屏 */
async function testReminder() {
  const LN = getNotifyPlugin();
  closeHelpModal();
  if (!LN) { alert('浏览器里没有本地通知，装到手机上才能测'); return; }
  const ok = await ensureNotifyPermission(false);
  if (!ok) { alert('通知权限没开。\n请到 系统设置 → 应用 → 打卡工具 → 通知，允许通知后重试。'); return; }
  await refreshExactAlarm();
  if (!exactAlarmOk) await askExactAlarmIfNeeded(true);

  try {
    await LN.schedule({
      notifications: [{
        id: 19999,
        title: '测试成功',
        body: '通知已正常送达，打卡提醒功能可用',
        channelId: REMIND_CHANNEL,
        schedule: { at: new Date(Date.now() + 10000), allowWhileIdle: true },
        isExactNotification: exactAlarmOk !== false
      }]
    });
  } catch (e) {
    alert('排提醒失败：' + (e && e.message ? e.message : e));
    return;
  }

  // 关键：问系统确认这条真的进去了，再放用户走。
  const ids = await pendingIds();
  if (ids.indexOf(19999) === -1) {
    showNotice('系统里没查到这条闹钟',
      '<p>等于没排上，先别清除后台。</p>'
      + '<p>请再点一次「测试提醒功能」；如果还是查不到，<br>请看右上角【!】→【问题总览】。</p>');
    return;
  }
  showNotice('10 秒后会发出通知提醒',
    '<p class="notice-em">现在可以退出并清除软件后台</p>'
    + '<p>收到通知 = 测试成功<br>未收到通知 = 查看右上角【!】→【问题总览】</p>');
}

/* ---------- 启动动画：等首屏渲染完再淡出，避免看到白底 ---------- */
function hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 800);
}

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', async function () {
  loadUiScale();
  applySplashSetting();
  applyTheme();
  await loadHabitsFromStorage();
  renderHabits(false);
  setupBackButton();
  setupResumeReschedule();
  // 先把首屏铺好，再收启动动画（1.3s：对勾画完后略停一下）
  setTimeout(hideSplash, 1300);
  await initReminders();

  setTimeout(() => {
    const data = JSON.stringify(habitsCache);
    const bytes = new Blob([data]).size;
    if (bytes > 4 * 1024 * 1024) {
      alert('本地存储已接近上限（约 5MB），建议导出备份后删除部分旧内容。');
    }
  }, 800);
});
