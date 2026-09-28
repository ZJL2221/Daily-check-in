/* ============ lib.js：工具函数 + 存储层 + 纯业务逻辑 ============ */

/* ---------- 基础工具 ---------- */
function parseDateStr(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function getSlotCount(mode) {
  return mode === 'single' ? 1 : mode === 'twice' ? 2 : 3;
}

function getDefaultSlotNames(mode) {
  if (mode === 'twice') return ['上午', '下午'];
  if (mode === 'thrice') return ['上午', '中午', '下午'];
  return [];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* 两种项目类型：daily = 每日打卡（按日期），list = 记录清单（一行一条） */
const TYPE_DAILY = 'daily';
const TYPE_LIST = 'list';

function getHabitType(habit) {
  return habit && habit.type === TYPE_LIST ? TYPE_LIST : TYPE_DAILY;
}

/* ---------- 存储适配器（Capacitor Preferences / localStorage） ---------- */
const Storage = (() => {
  function getPlugin() {
    if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.Preferences) {
      return Capacitor.Plugins.Preferences;
    }
    return null;
  }
  return {
    async get(key) {
      const plugin = getPlugin();
      if (plugin) {
        try {
          const { value } = await plugin.get({ key });
          return value;
        } catch (e) {
          console.warn('[Storage] Preferences.get 失败，回退到 localStorage', e);
          return localStorage.getItem(key);
        }
      }
      return localStorage.getItem(key);
    },
    async set(key, value) {
      const plugin = getPlugin();
      if (plugin) {
        try {
          await plugin.set({ key, value });
          return;
        } catch (e) {
          console.warn('[Storage] Preferences.set 失败，回退到 localStorage', e);
        }
      }
      localStorage.setItem(key, value);
    }
  };
})();

/* ---------- 文件保存（Capacitor Filesystem + Share） ---------- */
const FileSaver = (() => {
  function getFS() {
    if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.Filesystem) {
      return Capacitor.Plugins.Filesystem;
    }
    return null;
  }
  function getShare() {
    if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.Share) {
      return Capacitor.Plugins.Share;
    }
    return null;
  }

  async function saveTextFile(filename, content) {
    const FS = getFS();
    if (!FS) return { ok: false, reason: 'no-plugin' };

    let uri = null;
    try {
      const result = await FS.writeFile({
        path: filename,
        data: content,
        directory: 'CACHE',
        encoding: 'utf8'
      });
      uri = result.uri;
    } catch (e) {
      console.warn('写入 Cache 失败', e);
    }

    const SharePlugin = getShare();
    if (uri && SharePlugin) {
      try {
        await SharePlugin.share({
          title: filename,
          text: '打卡数据备份文件',
          url: uri,
          dialogTitle: '保存或分享备份'
        });
        return { ok: true, method: 'share' };
      } catch (e) {
        if (e && e.message && /cancel/i.test(e.message)) {
          return { ok: true, method: 'cancelled' };
        }
        console.warn('Share 失败，尝试直接写入 Documents', e);
      }
    }

    try {
      const result2 = await FS.writeFile({
        path: filename,
        data: content,
        directory: 'DOCUMENTS',
        encoding: 'utf8'
      });
      return { ok: true, method: 'documents', uri: result2.uri };
    } catch (e) {
      console.warn('写入 Documents 失败', e);
      return { ok: false, reason: e.message };
    }
  }

  return { saveTextFile };
})();

/* ---------- 日期缓存 ---------- */
const dateListCache = new Map();

/* ---------- 记录清单：条目读写 ---------- */
const LIST_ITEM_MAX = 60;

function newItemId() {
  return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const text = typeof it.text === 'string' ? it.text.trim().slice(0, LIST_ITEM_MAX) : '';
  if (!text) return null;
  return {
    id: (typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(it.id)) ? it.id : newItemId(),
    text,
    done: !!it.done,
    locked: !!it.locked,
    createdAt: (typeof it.createdAt === 'string' && it.createdAt) ? it.createdAt : formatDate(new Date())
  };
}

function getListItem(habit, itemId) {
  return (habit.items || []).find(it => it.id === itemId) || null;
}

function addListItem(habit, text) {
  if (!Array.isArray(habit.items)) habit.items = [];
  const t = String(text || '').trim().slice(0, LIST_ITEM_MAX);
  if (!t) return null;
  const item = { id: newItemId(), text: t, done: false, locked: false, createdAt: formatDate(new Date()) };
  habit.items.push(item);
  return item;
}

function removeListItem(habit, itemId) {
  if (!Array.isArray(habit.items)) return false;
  const idx = habit.items.findIndex(it => it.id === itemId);
  if (idx === -1) return false;
  habit.items.splice(idx, 1);
  return true;
}

function toggleListItemDone(habit, itemId) {
  const item = getListItem(habit, itemId);
  if (!item) return false;
  item.done = !item.done;
  return true;
}

function toggleListItemLock(habit, itemId) {
  const item = getListItem(habit, itemId);
  if (!item) return false;
  item.locked = !item.locked;
  return true;
}

function setListItemText(habit, itemId, text) {
  const item = getListItem(habit, itemId);
  if (!item) return false;
  const t = String(text || '').trim().slice(0, LIST_ITEM_MAX);
  if (!t) return false;
  item.text = t;
  return true;
}

/* 清单进度：只给纯数字，不带任何场景化文案 */
function getListStats(habit) {
  const items = habit.items || [];
  return { total: items.length, done: items.filter(it => it.done).length };
}

/* ---------- 数据规范化 ---------- */
function normalizeHabit(habit, index) {
  if (!habit || typeof habit !== 'object') return null;
  if (habit.dailyTwice === true && !habit.mode) habit.mode = 'twice';
  // 老数据没有 type → 一律当每日打卡，行为完全不变
  habit.type = (habit.type === TYPE_LIST) ? TYPE_LIST : TYPE_DAILY;
  if (!habit.mode || !['single', 'twice', 'thrice'].includes(habit.mode)) habit.mode = 'single';
  if (typeof habit.name !== 'string' || !habit.name.trim()) habit.name = '未命名';
  if (typeof habit.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(habit.startDate)) {
    habit.startDate = formatDate(new Date());
  }
  habit.totalDays = Math.max(1, Math.min(3650, parseInt(habit.totalDays, 10) || 30));
  if (!Array.isArray(habit.completedDates)) habit.completedDates = [];
  if (!habit.completedCounts || typeof habit.completedCounts !== 'object') habit.completedCounts = {};
  if (!Array.isArray(habit.lockedDates)) habit.lockedDates = [];
  if (typeof habit.expanded !== 'boolean') habit.expanded = true;
  if (typeof habit.masterLocked !== 'boolean') habit.masterLocked = false;
  if (typeof habit.deleteLocked !== 'boolean') habit.deleteLocked = false;
  if (!habit.notes || typeof habit.notes !== 'object') habit.notes = {};
  if (!Array.isArray(habit.slotNames) || habit.slotNames.length !== getSlotCount(habit.mode)) {
    habit.slotNames = getDefaultSlotNames(habit.mode);
  }
  if (habit.order === undefined || typeof habit.order !== 'number') habit.order = index;
  if (!Array.isArray(habit.expandedMonths)) habit.expandedMonths = [];
  if (habit.type === TYPE_LIST) {
    if (!Array.isArray(habit.items)) habit.items = [];
    habit.items = habit.items.map(normalizeItem).filter(Boolean);
  }
  delete habit.dailyTwice;
  delete habit._dateCache;
  return habit;
}

/* ---------- 折叠月份补全 / 频率迁移 / 去重指纹 ---------- */
function ensureExpandedMonths(habit) {
  if (getHabitType(habit) === TYPE_LIST) return;   // 记录清单没有月份概念
  if (Array.isArray(habit.expandedMonths) && habit.expandedMonths.length > 0) return;
  const dates = getDates(habit.startDate, habit.totalDays);
  const todayMonth = formatDate(new Date()).substring(0, 7);
  habit.expandedMonths = dates.some(d => d.dateStr.startsWith(todayMonth))
    ? [todayMonth]
    : (dates.length > 0 ? [dates[0].dateStr.substring(0, 7)] : []);
}

/* 单次 ↔ 多次 互转时尽量保留已有记录，避免"改频率后进度看起来清零" */
function migrateModeData(habit, newMode, newSlotNames) {
  const oldMode = habit.mode || 'single';
  if (oldMode === newMode) return;
  const oldDates = habit.completedDates || [];
  const oldCounts = habit.completedCounts || {};

  if (newMode === 'single') {
    const oldPer = getSlotCount(oldMode);
    const done = Object.keys(oldCounts).filter(k => {
      const v = oldCounts[k];
      return Array.isArray(v) && v.filter(Boolean).length >= oldPer;
    });
    habit.completedDates = Array.from(new Set([...oldDates, ...done]));
    return;
  }

  const newPer = getSlotCount(newMode);
  const counts = {};
  // 单次 → 多次：当天打过卡就视为各时段都完成
  oldDates.forEach(d => { counts[d] = Array(newPer).fill(true); });
  if (oldMode !== 'single') {
    const oldNames = habit.slotNames || getDefaultSlotNames(oldMode);
    const newNames = newSlotNames || getDefaultSlotNames(newMode);
    // 多次 → 多次：先按时段名对齐（上午/下午 → 上午/中午/下午），名字对不上再按位置
    Object.keys(oldCounts).forEach(d => {
      const v = oldCounts[d];
      if (!Array.isArray(v)) return;
      const arr = counts[d] || Array(newPer).fill(false);
      for (let i = 0; i < v.length; i++) {
        if (!v[i]) continue;
        let j = newNames.indexOf(oldNames[i]);
        if (j === -1) j = i;
        if (j >= 0 && j < newPer) arr[j] = true;
      }
      counts[d] = arr;
    });
  }
  habit.completedCounts = counts;
}

/* 稳定序列化：递归排序对象键，避免「导出→手改→再导入」时因键序不同被误判为不同项目 */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/* 导入时判断"这条记录是否已存在"，忽略 order 等易变字段 */
function habitSignature(h) {
  if (getHabitType(h) === TYPE_LIST) {
    return stableStringify([
      TYPE_LIST, h.name,
      (h.items || []).map(it => [it.text, !!it.done])
    ]);
  }
  return stableStringify([
    TYPE_DAILY, h.name, h.startDate, h.totalDays, h.mode,
    h.slotNames || [], h.completedDates || [],
    h.completedCounts || {}, h.notes || {}
  ]);
}

/* ---------- 日期生成 ---------- */
function getDates(startDate, totalDays) {
  const key = startDate + '|' + totalDays;
  let dates = dateListCache.get(key);
  if (!dates) {
    dates = generateDateList(startDate, totalDays);
    dateListCache.set(key, dates);
    if (dateListCache.size > 30) {
      const firstKey = dateListCache.keys().next().value;
      dateListCache.delete(firstKey);
    }
  }
  return dates;
}

function generateDateList(startDate, totalDays) {
  const dates = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const day = d.getDate();
    dates.push({
      dateStr: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
      display: month + '月' + day + '日',
      weekday: weekdays[d.getDay()],
      count: i + 1
    });
  }
  return dates;
}

/* ---------- 打卡状态读写 ---------- */
function getDayStatus(habit, dateStr) {
  const mode = habit.mode || 'single';
  if (mode === 'single') {
    return [(habit.completedDates || []).includes(dateStr)];
  }
  const slotCount = getSlotCount(mode);
  const val = (habit.completedCounts || {})[dateStr];
  const arr = Array(slotCount).fill(false);
  // 长度对不上（改过频率 / 导入的旧数据）时按位置对齐，而不是整条当没打过卡
  if (Array.isArray(val)) {
    for (let i = 0; i < Math.min(val.length, slotCount); i++) arr[i] = !!val[i];
  }
  return arr;
}

function setDayStatus(habit, dateStr, status) {
  const mode = habit.mode || 'single';
  if (mode === 'single') {
    if (!habit.completedDates) habit.completedDates = [];
    const idx = habit.completedDates.indexOf(dateStr);
    const checked = !!status[0];
    if (checked && idx === -1) habit.completedDates.push(dateStr);
    else if (!checked && idx > -1) habit.completedDates.splice(idx, 1);
  } else {
    if (!habit.completedCounts) habit.completedCounts = {};
    const slotCount = getSlotCount(mode);
    let arr = habit.completedCounts[dateStr];
    if (!Array.isArray(arr) || arr.length !== slotCount) arr = Array(slotCount).fill(false);
    for (let i = 0; i < Math.min(status.length, slotCount); i++) arr[i] = !!status[i];
    // 全 false 就不落库，避免 completedCounts 无限膨胀
    if (arr.some(Boolean)) habit.completedCounts[dateStr] = arr;
    else delete habit.completedCounts[dateStr];
  }
}

function getPerDayCount(habit) {
  return getSlotCount(habit.mode || 'single');
}

function getTotalCompletedCount(habit) {
  const mode = habit.mode || 'single';
  if (mode === 'single') return (habit.completedDates || []).length;
  let total = 0;
  const counts = habit.completedCounts || {};
  for (const k in counts) {
    const v = counts[k];
    if (Array.isArray(v)) total += v.filter(Boolean).length;
  }
  return total;
}

function getTotalSlots(habit) {
  return habit.totalDays * getPerDayCount(habit);
}

function getSlotLabel(habit, index) {
  const names = habit.slotNames || getDefaultSlotNames(habit.mode);
  return names[index] || '';
}

function getSlotShort(mode, index) {
  if (mode === 'twice') return index === 0 ? '①' : '②';
  if (mode === 'thrice') return ['①', '②', '③'][index] || '';
  return '';
}

function groupByMonth(dates) {
  const groups = [];
  let lastKey = '';
  let g = null;
  dates.forEach(d => {
    const key = d.dateStr.substring(0, 7);
    if (key !== lastKey) {
      lastKey = key;
      g = { monthKey: key, monthLabel: parseInt(key.substring(5), 10) + '月', dates: [] };
      groups.push(g);
    }
    g.dates.push(d);
  });
  return groups;
}
