/* ============ app.js：业务逻辑 ============ */

/* ---------- 常量 ---------- */
const STORAGE_KEY = 'checkin_habits_v5';

/* ---------- 缓存 ---------- */
let habitsCache = [];
function getHabits() { return habitsCache; }

/* ---------- 数据加载与保存 ---------- */
async function saveHabits(habits) {
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
  if (!habits[habitIndex]) return;
  if (habits[habitIndex].deleteLocked) {
    alert('删除已锁定，长按可解锁');
    return;
  }
  // 关键修复 2：延迟 120ms 再弹 confirm，让整段鼠标 / 触摸事件序列先走完
  setTimeout(() => {
    deleteHabit(habitIndex);
  }, 120);
}

/* ---------- 交互操作 ---------- */
function toggleMasterLock(i, e) {
  e.stopPropagation();
  const h = getHabits();
  h[i].masterLocked = !h[i].masterLocked;
  saveHabits(h);
  renderHabits();
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
}

/* ---------- 长按检测（日期项）---------- */
let longPressTimer = null;
let isLongPress = false;
let hasMoved = false;
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
  window._lastTouchEnd = Date.now();
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
  if (Date.now() - (window._lastTouchEnd || 0) < 800) return;

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
}

async function deleteHabit(i) {
  const h = getHabits();
  if (!h[i]) return;
  if (!(await showConfirm('确定要删除「' + h[i].name + '」吗？', '删除项目'))) return;
  const removed = h.splice(i, 1)[0];
  saveHabits(h);
  renderHabits();
  showUndoBar(removed, i);
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
  noteHabitIndex = i;
  noteDateStr = dateStr;
  const d = parseDateStr(dateStr);
  document.getElementById('noteDateLabel').textContent =
    h[i].name + ' · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  const note = (h[i].notes && h[i].notes[dateStr]) || '';
  document.getElementById('noteInput').value = note;
  updateNoteCharCount();
  document.getElementById('noteModal').classList.add('active');
  setTimeout(() => document.getElementById('noteInput').focus(), 300);
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
  input.addEventListener('blur', () => commit(true));
  // 别让输入框里的点击被整行的"打勾"处理吃掉
  ['click', 'mousedown', 'touchstart', 'touchmove', 'touchend'].forEach(t =>
    input.addEventListener(t, ev => ev.stopPropagation()));
}

/* 添加一条：点卡片底部的按钮 → 弹出居中输入框。
   手机上这样键盘不会挤压卡片布局，也不用先滚到列表底部去点输入框。 */
let itemModalHabitIndex = -1;
let itemModalSavedCount = 0;

function openItemModal(i) {
  const h = getHabits();
  if (!h[i]) return;
  if (h[i].masterLocked) return;
  itemModalHabitIndex = i;
  itemModalSavedCount = 0;
  document.getElementById('itemModalLabel').textContent = '添加到「' + h[i].name + '」';
  document.getElementById('itemInput').value = '';
  document.getElementById('itemCharCount').textContent = '0';
  document.getElementById('itemModalHint').textContent = '保存后可以接着加下一条';
  document.getElementById('itemModal').classList.add('active');
  setTimeout(() => document.getElementById('itemInput').focus(), 320);
}

function closeItemModal() {
  document.getElementById('itemModal').classList.remove('active');
  itemModalHabitIndex = -1;
  itemModalSavedCount = 0;
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
  document.getElementById('itemModalHint').textContent =
    '已添加 ' + itemModalSavedCount + ' 条，可继续输入';
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
  selectedMode = mode;
  // 注意：必须限定在 #modeSelector 内，否则会误改上面的"类型"选择器
  document.querySelectorAll('#modeSelector .mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === mode);
  });
  renderSlotNameInputs();
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
  }
  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  editingIndex = -1;
  lockTypeSelector(false);
}

function saveHabit() {
  const name = document.getElementById('habitName').value.trim();
  const type = selectedType || TYPE_DAILY;
  const habits = getHabits();

  if (!name) { alert('请输入名称'); return; }

  /* ---- 记录清单：只要一个名称 ---- */
  if (type === TYPE_LIST) {
    if (editingIndex >= 0 && habits[editingIndex]) {
      habits[editingIndex].name = name;
      habits[editingIndex].type = TYPE_LIST;
    } else {
      habits.push({
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
    // 新建的清单直接把「添加一条」弹窗打开，省一次点击
    if (editingIndex < 0) {
      setTimeout(() => openItemModal(habits.length - 1), 300);
    }
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
    closeModal();
    renderHabits();
  } else {
    const created = {
      type: TYPE_DAILY,
      name, startDate, totalDays, mode, slotNames,
      completedDates: [], completedCounts: {}, notes: {},
      lockedDates: [], masterLocked: false, deleteLocked: false,
      expanded: true, expandedMonths: [], order: habits.length
    };
    ensureExpandedMonths(created);
    habits.push(created);
    saveHabits(habits);
    closeModal();
    renderHabits();
  }
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
                title="${isDeleteLocked ? '已锁定，长按解锁' : '短按删除，长按锁定'}">${isDeleteLocked ? '🔒' : '🗑️'}</button>
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
    <div class="card ${isArchived ? 'archived' : ''}">
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
        <div class="long-press-hint">💡 长按日期可锁定/解锁 · 点击 🗨️ 添加备注</div>
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

  const noteBtn = `<button class="note-btn ${hasNote ? 'has-note' : ''}"
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
    return `<button class="slot-btn ${checked ? 'checked' : ''} ${isLocked ? 'locked' : ''}"
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

/* ---------- 使用说明弹窗 ---------- */
function openHelpModal() {
  document.getElementById('helpModal').classList.add('active');
}

function closeHelpModal() {
  document.getElementById('helpModal').classList.remove('active');
}

/* ---------- 事件绑定 ---------- */
document.getElementById('noteInput').addEventListener('input', updateNoteCharCount);

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
  if (document.getElementById('confirmModal').classList.contains('active')) { closeConfirm(false); return true; }
  if (document.getElementById('importModal').classList.contains('active')) { closeImportChoice(null); return true; }
  if (document.getElementById('itemModal').classList.contains('active')) { closeItemModal(); return true; }
  if (document.getElementById('noteModal').classList.contains('active')) { closeNoteModal(); return true; }
  if (document.getElementById('modal').classList.contains('active')) { closeModal(); return true; }
  if (document.getElementById('exportModal').classList.contains('active')) { closeExportModal(); return true; }
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

/* ---------- 启动 ---------- */
document.addEventListener('DOMContentLoaded', async function () {
  await loadHabitsFromStorage();
  renderHabits(false);
  setupBackButton();

  setTimeout(() => {
    const data = JSON.stringify(habitsCache);
    const bytes = new Blob([data]).size;
    if (bytes > 4 * 1024 * 1024) {
      alert('本地存储已接近上限（约 5MB），建议导出备份后删除部分旧内容。');
    }
  }, 800);
});
