/* ==================== Ключи хранения ==================== */
/* ==================== Панели поиска (Учёт/Склад/1С) ====================
   Разметка одинаковая для всех трёх вкладок — генерируем один раз вместо
   трёх копий в HTML. Должно выполниться раньше, чем что-либо ниже
   обратится к whSearchInput/caSearchClear и т.п. через getElementById. */
function searchBarHTML(prefix) {
  return `
    <span class="search-icon">🔍</span>
    <input type="text" id="${prefix}SearchInput" placeholder="Поиск" autocomplete="off" style="flex:1;">
    <button class="iconbtn clear" id="${prefix}SearchClear" title="Очистить поле">✕</button>
    <span class="search-count" id="${prefix}SearchCount"></span>
    <button class="iconbtn nav" id="${prefix}SearchPrev" title="Предыдущее совпадение">‹</button>
    <button class="iconbtn nav" id="${prefix}SearchNext" title="Следующее совпадение">›</button>
  `;
}
["wh", "ca", "oc"].forEach((prefix) => {
  const bar = document.getElementById(prefix + "SearchBar");
  if (bar) bar.innerHTML = searchBarHTML(prefix);
});

/* ==================== Страховка: переключение вкладок ====================
   Регистрируется в самом начале скрипта. Даже если ниже произойдёт ошибка
   загрузки, вкладки продолжат переключаться (функция switchTab всплывает
   благодаря hoisting объявлений функций). */
const suggestZones = [];               // { box, inputs[] } — закрываются кликом мимо
function registerSuggestZone(box, inputs) { if (box) suggestZones.push({ box, inputs }); }

let lastTabSwitch = 0;
function handleTabPress(e) {
  const btn = e.target && e.target.closest ? e.target.closest(".tab-btn") : null;
  if (!btn) return;
  // Вкладки — ссылки (#warehouse и т.п.): колесо мыши, Ctrl/Cmd/Shift+клик открывают в новой вкладке браузера
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const now = Date.now();
  if (now - lastTabSwitch < 400) return;   // click + pointerup на тачскрине
  lastTabSwitch = now;
  if (typeof switchTab === "function") switchTab(tabTargetFromId(btn.id));
}

/* Один обработчик на все глобальные реакции клика:
   переключение вкладок, снятие временной подсветки, закрытие подсказок. */
document.addEventListener("click", function (e) {
  handleTabPress(e);
  document.querySelectorAll(".row-flash").forEach((el) => el.classList.remove("row-flash"));
  suggestZones.forEach(({ box, inputs }) => {
    if (!box.contains(e.target) && inputs.indexOf(e.target) === -1) box.classList.remove("open");
  });
});
document.addEventListener("pointerup", handleTabPress);   // страховка для тачскрина

// Номер версии файлов — держим руками синхронно с CACHE_NAME в ../sw.js (общий для всего сервиса)
// (при каждом поднятии кэша меняем и тут). Просто отображается в углу
// шапки — чтобы проверить, долетело ли обновление до устройства.
// Версия только показывается и пишется в копию, как число не сравнивается.
const APP_VERSION = "v2.0";
{
  const el = document.getElementById("appVersionBadge");
  if (el) el.textContent = APP_VERSION;
}

const DATA_BY_DATE_KEY = "sklad2_data_by_date_v3";
const WAREHOUSE_KEY = "sklad2_warehouse_v1";
// Остатки второго склада («Бестужевская») — храним отдельно, в основной
// список 1С они не подмешиваются. Нужны для будущего сравнения остатков
// между складами.
const BEST_STOCK_KEY = "sklad2_best_stock_v1";
function loadBestStock() {
  try {
    const raw = localStorage.getItem(BEST_STOCK_KEY);
    return raw ? JSON.parse(raw) : null;   // { savedAt, rows: [{code,name,qty}] }
  } catch (e) { return null; }
}
function saveBestStock(data) {
  try { localStorage.setItem(BEST_STOCK_KEY, JSON.stringify(data)); } catch (e) {}
  scheduleSync();
}
let bestStock = loadBestStock();

// Список на перемещение — что нужно привезти со второго склада.
const TRANSFER_KEY = "sklad2_transfer_list_v1";
function loadTransferList() {
  try {
    const raw = localStorage.getItem(TRANSFER_KEY);
    return raw ? JSON.parse(raw) : [];    // [{code,name,mine,other}]
  } catch (e) { return []; }
}
function saveTransferList() {
  try { localStorage.setItem(TRANSFER_KEY, JSON.stringify(transferList)); } catch (e) {}
  scheduleSync();
}
let transferList = loadTransferList();

const MONTHS_FULL_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

/* Дата и время — по Москве (как на сервере), а не по часам и поясу устройства. */
function mskParts(offsetDays) {
  const d = new Date(Date.now() + 3 * 3600 * 1000 + (offsetDays || 0) * 86400000);   // МСК = UTC+3 круглый год
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
function mskDateStr(offsetDays) {
  const p = mskParts(offsetDays);
  return p.y + "-" + String(p.m).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}
function todayStr() { return mskDateStr(0); }
// До 04:00 МСК сменщик ещё может дописать свою вчерашнюю заявку (то же правило на сервере).
const SHIFT_GRACE_HOUR = 4;
function formatShort(dateStr) {
  if (!dateStr) return "—";
  dateStr = String(dateStr).slice(0, 10);   // у заявки на учёт ключ может быть «2026-10-16#2»
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return `${String(d).padStart(2,"0")}.${String(m).padStart(2,"0")}`;
}
function formatFull(dateStr) {
  if (!dateStr) return "";
  dateStr = String(dateStr).slice(0, 10);
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${MONTHS_FULL_GEN[m - 1]} ${y}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
/* Если код склеен из двух через "/", показываем вторым уровнем под первым */
function formatCodeDisplay(code) {
  const parts = escapeHtml(code).split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return escapeHtml(code);
  return `<span class="code-split">${parts.map((p) => `<span class="code-line">${p}</span>`).join("")}</span>`;
}

/* ==================== Модалки: открыть/закрыть ====================
   Раньше каждая из 17 модалок открывалась/закрывалась своей парой
   document.getElementById(id).classList.add/remove("open") — один и тот же
   код почти 50 раз. Принимает и id (строку), и уже найденный элемент —
   в паре мест элемент был закэширован в константу заранее. */
function openModal(idOrEl) {
  const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
  if (el) el.classList.add("open");
}
function closeModal(idOrEl) {
  const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
  if (el) el.classList.remove("open");
}

/* ==================== Загрузка/сохранение ==================== */
function loadDataByDate() {
  try {
    const raw = localStorage.getItem(DATA_BY_DATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (e) { return {}; }
}
function saveDataByDate() {
  try { localStorage.setItem(DATA_BY_DATE_KEY, JSON.stringify(dataByDate)); } catch (e) {}
  scheduleSync();
}
/* ==================== Роль (сменщик) ====================
   Роль приходит из profiles после входа и кэшируется на устройстве (Auth.loadRole).
   Сменщик: создаёт свои заявки и добавляет в них позиции; остальное — только просмотр.
   Это удобство интерфейса, настоящие ограничения проверяет сервер (RLS и триггер sklad_kv_shift_guard). */
const CATALOG_KEY = "sklad2_catalog_v1";           // названия и коды деталей для сменщика, без остатков
const CATALOG_REMOTE_KEY = "potreblenie_catalog_v1";
let ROLE = null, MY_LOGIN = "";
(function () {
  try { const c = window.Auth && Auth.cachedRole(); if (c) { ROLE = c.role; MY_LOGIN = c.login || ""; } } catch (e) {}
})();
function isShift() { return ROLE === "shift"; }
// Вход по QR (сменщик): только сегодняшняя заявка — без списка заявок, разделов и меню аккаунта.
// Режим запоминается на устройстве, чтобы экран сразу открывался закрытым; уточняется после входа.
const QR_KIOSK_KEY = "sklad2_qr_kiosk";
let QR_KIOSK = false;
try { QR_KIOSK = isShift() && localStorage.getItem(QR_KIOSK_KEY) === "1"; } catch (e) {}
function setQrKiosk(on) {
  QR_KIOSK = !!on;
  try { if (on) localStorage.setItem(QR_KIOSK_KEY, "1"); else localStorage.removeItem(QR_KIOSK_KEY); } catch (e) {}
  document.body.classList.toggle("qr-kiosk", QR_KIOSK);
  if (typeof updateLayoutClasses === "function") updateLayoutClasses();
}
document.body.classList.toggle("qr-kiosk", QR_KIOSK);
// Сменщик: hleb нажал «Сгенерировать новый» QR — устройства, вошедшие в sklad по QR раньше, выходят (по паролю — нет)
// (сервер перестаёт отдавать им данные). Проверка при входе, при возврате на вкладку и раз в минуту.
async function shiftSessionAlive() {
  if (!isShift() || !window.Auth) return true;
  let r;
  try { r = await Auth.sb.rpc("sklad_session_ok"); } catch (e) { return true; }   // нет связи — не выкидываем
  if (r.error || r.data !== false) return true;
  Auth.logout("Выдан новый QR-код — отсканируйте его, чтобы войти.");
  return false;
}
if (isShift()) {
  setInterval(() => { if (!document.hidden && syncUserOk) shiftSessionAlive(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && syncUserOk) shiftSessionAlive(); });
}
// Удалять заявки на учёт может только аккаунт hleb (так же проверяет сервер).
function canDeleteTickets() { return MY_LOGIN === "hleb"; }
document.body.classList.toggle("role-shift", isShift());
function loadCatalogLocal() {
  try {
    const c = JSON.parse(localStorage.getItem(CATALOG_KEY) || "null");
    if (c && Array.isArray(c.parts) && Array.isArray(c.consumables)) return c;
  } catch (e) {}
  return { parts: [], consumables: [] };
}
// Сменщик: остаток 1С из каталога; для ручной связки кодов (CODE_LINKS) — по связанному коду.
function shiftOcQty(r) {
  if (r.ocqty !== undefined) return r.ocqty;
  for (const c of codeVariants(r.code)) {
    for (const oc of (linkWhToOc[c] || [])) {
      for (const s of ["parts", "consumables"]) {
        const hit = warehouse[s].find((it) => it.ocqty !== undefined && codeVariants(it.code).includes(oc));
        if (hit) return hit.ocqty;
      }
    }
  }
  return undefined;
}
function warehouseFromCatalog() {
  const c = loadCatalogLocal();
  const conv = (a) => a.map((it) => {
    const o = { code: it.code || "", name: it.name || "", model: it.model || "", model2: it.model2 || "", qty: 0 };
    if (it.ocqty !== undefined) o.ocqty = it.ocqty;   // остаток 1С — считает сервер при сборке каталога
    if (it.ocName) o.ocName = it.ocName;
    return o;
  });
  return { parts: conv(c.parts), consumables: conv(c.consumables) };
}
function loadWarehouse() {
  if (isShift()) return warehouseFromCatalog();
  // Нет данных на устройстве — пусто: склад приходит с сервера при первом обмене.
  try {
    const parsed = JSON.parse(localStorage.getItem(WAREHOUSE_KEY));
    if (parsed && Array.isArray(parsed.parts) && Array.isArray(parsed.consumables)) return parsed;
  } catch (e) {}
  return { parts: [], consumables: [] };
}
function saveWarehouse() {
  if (isShift()) return;
  try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
  scheduleSync();
}
// Локально, без синхронизации — для чисто визуальных действий (сортировка),
// которые не должны считаться правкой данных и уходить на сервер.
function saveWarehouseLocalOnly() {
  if (isShift()) return;
  try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
}

let dataByDate = loadDataByDate();
let warehouse = loadWarehouse(); // { parts: [{code,name,qty,model}], consumables: [...] }
// Дата при каждом открытии приложения — всегда сегодняшняя (а не та, на которой
// остановились в прошлый раз): открыли на следующий день — календарь сам на нём.
/* Учёт ведётся ЗАЯВКАМИ: каждая — запись в dataByDate с ключом «ГГГГ-ММ-ДД» (первая за день)
   или «ГГГГ-ММ-ДД#2», «#3»… (следующие). Номер заявки не хранится: это порядковый номер среди
   всех заявок по возрастанию даты, поэтому на всех устройствах он одинаков. Не выбрана
   заявка (currentDate = null) — рабочее поле пустое. */
let currentDate = null;
const TICKET_KEY_RE = /^\d{4}-\d{2}-\d{2}(#\d+)?$/;
function emptyEntry() { return { sections: { parts: [], consumables: [] }, counts: {}, checked: {} }; }
function ticketCmp(a, b) {
  const da = a.slice(0, 10), db = b.slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  const na = a.indexOf("#") >= 0 ? parseInt(a.split("#")[1], 10) : 1;
  const nb = b.indexOf("#") >= 0 ? parseInt(b.split("#")[1], 10) : 1;
  return na - nb;
}
function ticketKeys() { return Object.keys(dataByDate).filter((k) => TICKET_KEY_RE.test(k)).sort(ticketCmp); }
function ticketNumberMap() { const m = {}; ticketKeys().forEach((k, i) => { m[k] = i + 1; }); return m; }
function entryItemCount(e) {
  const s = (e && e.sections) || {};
  return ((s.parts || []).length) + ((s.consumables || []).length);
}
// Пустые заявки за прошедшие дни (создали и забыли) убираем, чтобы не копились номера.
/* Пустые заявки удаляются сами на любом устройстве: через час после создания, если
   в них ничего не добавили (поле created ставится при создании). У старых заявок без
   created — если они за прошедший день. Сервер разрешает любому аккаунту удалять только
   пустые заявки, заявки с позициями — только hleb. */
const EMPTY_TICKET_TTL_MS = 60 * 60 * 1000;
function emptyTicketExpired(k, e) {
  if (!TICKET_KEY_RE.test(k) || entryItemCount(e) !== 0) return false;
  if (e && e.created) return Date.now() - e.created >= EMPTY_TICKET_TTL_MS;
  return k.slice(0, 10) < todayStr();
}
function cleanupEmptyTickets(sync) {
  let changed = false;
  Object.keys(dataByDate).forEach((k) => {
    if (k === currentDate && canEditCurrent() && document.activeElement && document.activeElement.id === "newItemName") return;   // прямо сейчас набирают позицию
    if (emptyTicketExpired(k, dataByDate[k])) { delete dataByDate[k]; changed = true; }
  });
  if (!changed) return false;
  if (sync) saveDataByDate();
  else { try { localStorage.setItem(DATA_BY_DATE_KEY, JSON.stringify(dataByDate)); } catch (e) {} }
  return true;
}
cleanupEmptyTickets(false);
try {
  const sel = sessionStorage.getItem("sklad2_sel_ticket");
  if (sel && dataByDate[sel]) currentDate = sel;
} catch (e) {}

function entryFor(date) {
  if (!dataByDate[date]) {
    dataByDate[date] = { sections: { parts: [], consumables: [] }, counts: {}, checked: {} };
  }
  if (!dataByDate[date].checked) dataByDate[date].checked = {};
  if (!dataByDate[date].sections) dataByDate[date].sections = { parts: [], consumables: [] };
  return dataByDate[date];
}

let sections, counts, checked;
// Галочки «учтено» — личные, только на этом устройстве и аккаунте: в синхронизацию не попадают.
const CHECKS_KEY = "sklad2_checks_v1_" + (MY_LOGIN || "");
let localChecks = {};
try { localChecks = JSON.parse(localStorage.getItem(CHECKS_KEY) || "{}") || {}; } catch (e) { localChecks = {}; }
function persistChecks() {
  if (!currentDate) return;
  localChecks[currentDate] = checked;
  try { localStorage.setItem(CHECKS_KEY, JSON.stringify(localChecks)); } catch (e) {}
}
// Привязывает рабочие переменные к выбранной заявке (или к пустой заглушке, если заявка не выбрана).
function bindCurrent() {
  if (currentDate && !dataByDate[currentDate]) currentDate = null;   // заявку удалили на другом устройстве
  const e = currentDate ? entryFor(currentDate) : emptyEntry();
  sections = e.sections; counts = e.counts;
  checked = currentDate ? (localChecks[currentDate] || (localChecks[currentDate] = {})) : {};
}
bindCurrent();

// Сменщик правит позиции любой заявки (чья бы ни была) за сегодня и вчерашней — до 04:00 МСК;
// более старые — только просмотр. Комментарий и удаление всей заявки — только hleb (меню «⋮»).
function canEditCurrent() {
  if (!isShift()) return true;
  const e = currentDate && dataByDate[currentDate];
  if (!e) return false;
  const day = currentDate.slice(0, 10);
  return day === todayStr() || (day === mskDateStr(-1) && mskParts(0).h < SHIFT_GRACE_HOUR);
}
function persistCurrent() {
  if (!currentDate) return;
  persistChecks();
  if (!canEditCurrent()) return;
  dataByDate[currentDate] = Object.assign({}, dataByDate[currentDate], { sections, counts, checked: {} });
  saveDataByDate();
}
// Локально, без синхронизации — используется при переключении даты
// (сохраняем то, что уже было введено, но само переключение — не правка).
function persistCurrentLocalOnly() {
  if (!currentDate) return;
  persistChecks();
  if (!canEditCurrent()) return;
  dataByDate[currentDate] = Object.assign({}, dataByDate[currentDate], { sections, counts, checked: {} });
  try { localStorage.setItem(DATA_BY_DATE_KEY, JSON.stringify(dataByDate)); } catch (e) {}
}

/* ==================== Общий механизм отмены/повтора (для всех 3 вкладок) ====================
   Раньше у «Учёта», «Склада» и «1С» было по три копии одного и того же:
   свой стек отмены, свой стек повтора, своя функция снимка состояния,
   своя привязка кнопок ↶/↷. Теперь это один универсальный конструктор —
   каждая вкладка просто передаёт «как снять снимок» и «как восстановить
   состояние из снимка» (там разная логика: разные глобальные переменные,
   разный рендер, разная подсветка изменившейся строки). */
function makeUndoRedo({ snapshotFn, restoreFn, undoBtnId, redoBtnId, limit }) {
  const undoStack = [];
  const redoStack = [];
  const undoBtn = document.getElementById(undoBtnId);
  const redoBtn = document.getElementById(redoBtnId);
  function updateButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }
  function push() {
    undoStack.push(snapshotFn());
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    updateButtons();
  }
  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(snapshotFn());
    restoreFn(undoStack.pop());
    updateButtons();
  }
  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshotFn());
    restoreFn(redoStack.pop());
    updateButtons();
  }
  function reset() {
    undoStack.length = 0;
    redoStack.length = 0;
    updateButtons();
  }
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  updateButtons();
  return { push, undo, redo, reset, updateButtons };
}

/* ==================== История (отмена/повтор) — вкладка «Учёт» ==================== */
const HISTORY_LIMIT = 50;
function snapshot() { return JSON.stringify({ sections, counts, checked }); }

/* ==================== Подсветка изменённой строки при отмене ====================
   Сравниваем состояние до и после отката и прыгаем к первой различающейся
   позиции, чтобы было видно, что именно изменилось. */
function firstDiffIndex(a, b) {
  a = a || []; b = b || [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return -1;
}

/* Ищет, в каком разделе и на какой строке произошло изменение */
function findChange(beforeLists, afterLists, beforeMap, afterMap, keyFn) {
  for (const section of ["parts", "consumables"]) {
    const i = firstDiffIndex(beforeLists[section], afterLists[section]);
    if (i >= 0) {
      const len = (afterLists[section] || []).length;
      if (len === 0) continue;
      return { section, index: Math.min(i, len - 1) };
    }
  }
  // списки совпали — значит изменилось значение по ключу (кол-во, галочка)
  if (beforeMap && afterMap) {
    const keys = new Set(Object.keys(beforeMap).concat(Object.keys(afterMap)));
    for (const k of keys) {
      if (beforeMap[k] === afterMap[k]) continue;
      for (const section of ["parts", "consumables"]) {
        const list = afterLists[section] || [];
        const idx = list.findIndex((it) => keyFn(section, it) === k);
        if (idx >= 0) return { section, index: idx };
      }
    }
  }
  return null;
}

/* Находит строку таблицы по её индексу в МАССИВЕ данных.
   Раньше по всему файлу писали tbody.querySelectorAll("tr")[index], то есть
   индекс в данных использовали как номер строки на экране. Пока фильтров не
   было, это совпадало. Но «Склад» фильтруется по модели, а «1С» — по
   разделу/остатку, и тогда на экране остаётся лишь подмножество строк:
   обращение по номеру попадало в чужую позицию — отсюда переходы «на
   случайную строку». Теперь у строк этих таблиц есть data-index с настоящим
   индексом, и ищем именно по нему.
   Возвращает null, если строка сейчас скрыта фильтром. */
function rowByDataIndex(tbodyId, index) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return null;
  const sec = tbodyId.replace(/^.*-/, "");
  const table = tbody.closest("table");
  if (table && table.querySelector("tr[data-section]")) {
    return table.querySelector(`tr[data-section="${sec}"][data-index="${index}"]`);
  }
  if (tbody.querySelector("tr[data-index]")) {
    return tbody.querySelector(`tr[data-index="${index}"]`);
  }
  // «Учёт» рисуется без фильтра — там номер строки и индекс совпадают.
  return tbody.querySelectorAll("tr")[index] || null;
}

/* Подсвечивает строку и прокручивает к ней */
function highlightAt(bodyPrefix, section, index) {
  const tr = rowByDataIndex(bodyPrefix + section, index);
  if (tr) highlightRows([tr]);
}

function restoreSnapshot(json) {
  const state = JSON.parse(json);
  const beforeLists = sections, beforeCounts = counts, beforeChecked = checked;
  sections = state.sections;
  counts = state.counts;
  checked = state.checked || {};
  persistCurrent();
  renderAll();
  const hit = findChange(beforeLists, sections, beforeCounts, counts, countKey)
           || findChange(beforeLists, sections, beforeChecked, checked, countKey);
  if (hit) highlightAt("body-", hit.section, hit.index);
}
const caHistory = makeUndoRedo({
  snapshotFn: snapshot,
  restoreFn: restoreSnapshot,
  undoBtnId: "undoBtn",
  redoBtnId: "redoBtn",
  limit: HISTORY_LIMIT
});
function pushHistory() { caHistory.push(); }

/* ==================== Ключ позиции ====================
   Если у позиции есть код склада — ключ общий по коду (для сквозного расчёта
   и для связи учёта со складом). Если кода нет — ключ локальный (раздел+название). */
function countKey(section, item) {
  return item.code ? ("code::" + item.code) : (section + "::" + item.name);
}

/* ==================== Выделение строк кликом/тапом (мульти-выбор) ==================== */
const selectedCA = { parts: new Set(), consumables: new Set() };
const selectedWH = { parts: new Set(), consumables: new Set() };

function toggleRowPick(store, section, key, tr) {
  if (store[section].has(key)) {
    store[section].delete(key);
    tr.classList.remove("row-picked");
  } else {
    store[section].add(key);
    tr.classList.add("row-picked");
  }
}
function applyPickHighlight(store, section, tbody, list, keyFn) {
  // Только строки позиций (у заголовков групп нет data-index) и только по
  // индексу в массиве: на «Учёте» строки идут группами по моделям, поэтому
  // позиция строки на экране ничего не значит.
  Array.from(tbody.querySelectorAll("tr[data-index]")).forEach((tr) => {
    const item = list[parseInt(tr.dataset.index, 10)];
    if (!item) return;
    tr.classList.toggle("row-picked", store[section].has(keyFn(item)));
  });
}

/* ==================== Временная жёлтая подсветка (новая/дублирующая позиция) ====================
   Держится до первого клика в любом месте страницы. */
function flashRow(tr) {
  if (!tr) return;
  setTimeout(() => tr.classList.add("row-flash"), 0);
}

/* ==================== Рендер: вкладка «Учёт» ==================== */
/* Порядок групп в «Учёте». Всё, чего здесь нет, идёт следом по алфавиту,
   а позиции без модели — в самом конце. */
const CA_MODEL_ORDER = ["9Bot", "YGW 4.0", "YGW 5.0"];
// Группа в «Учёте»: у детали с двумя моделями — YGW 5.0, если она среди них,
// иначе первая по порядку CA_MODEL_ORDER. В строке при этом видны обе модели.
function caModelOf(item) {
  const info = item.code ? warehouseInfoFor(item.code, item.name) : null;
  const ms = modelsOf(info);
  if (!ms.length) return "";
  if (ms.indexOf("YGW 5.0") !== -1) return "YGW 5.0";
  return ms.slice().sort((a, b) => {
    const ra = CA_MODEL_ORDER.indexOf(a), rb = CA_MODEL_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  })[0];
}
/* Раскладывает позиции раздела по моделям в нужном порядке.
   Возвращает [{ model, pairs: [{ item, i }] }] — i остаётся ИНДЕКСОМ В
   МАССИВЕ, а не номером строки на экране: на него завязаны кнопки строки,
   поиск, подсветка и переходы. */
function caGroups(section) {
  const byModel = new Map();
  sections[section].forEach((item, i) => {
    const m = caModelOf(item);
    if (!byModel.has(m)) byModel.set(m, []);
    byModel.get(m).push({ item, i });
  });
  const rank = (m) => {
    if (!m) return 3000;                                  // без модели — в конец
    const known = CA_MODEL_ORDER.indexOf(m);
    return known === -1 ? 2000 : known;                   // прочие — между
  };
  return [...byModel.keys()]
    .sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b, "ru"))
    .map((model) => ({ model, pairs: byModel.get(model) }));
}

function renderSection(section) {
  const tbody = document.getElementById("body-" + section);
  tbody.innerHTML = "";
  const groups = caGroups(section);
  // Заголовок модели показываем всегда, даже если вся заявка одной модели;
  // не нужен только единственный заголовок «Без модели».
  const showHeaders = groups.length > 1 || (groups.length === 1 && !!groups[0].model);
  groups.forEach(({ model, pairs }) => {
    let rowNo = 0;                     // нумерация своя внутри каждой модели
    if (showHeaders) {
      const head = document.createElement("tr");
      head.className = "group-row";
      head.innerHTML = `<td colspan="5">${escapeHtml(model || "Без модели")} · ${pairs.length}</td>`;
      tbody.appendChild(head);
    }
    pairs.forEach(({ item, i }) => {
    rowNo++;
    const key = countKey(section, item);
    if (counts[key] === undefined) counts[key] = 0;
    const isChecked = !!checked[key];
    const tr = document.createElement("tr");
    tr.dataset.key = key;
    tr.dataset.index = i;          // индекс в массиве: строки идут не по нему
    tr.innerHTML = `
      <td class="num">${rowNo}</td>
      <td class="code">${item.code ? `<span class="code-text" data-code="${escapeHtml(item.code)}">${formatCodeDisplay(item.code)}</span>` : "—"}</td>
      <td class="name">
        ${escapeHtml(item.name)}
        <button class="ca-del-badge" data-section="${section}" data-index="${i}" title="Удалить строку">🗑</button>
      </td>
      <td class="check">
        <button class="chk-toggle${isChecked ? " on" : ""}" data-section="${section}" data-index="${i}" title="Отметить как учтено">${isChecked ? "✓" : ""}</button>
      </td>
      <td class="count count-merged">
        <div class="count-tier count-tier-num">
          <input type="number" min="0" value="${counts[key]}" class="countInput"
            data-section="${section}" data-index="${i}"${!canEditCurrent() ? " readonly" : ""}>
        </div>
        <div class="count-tier count-tier-pm">
          <button class="btn minus" data-section="${section}" data-index="${i}" title="Указать количество">–</button>
          <button class="btn plus" data-section="${section}" data-index="${i}" title="Указать количество">+</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
    });
  });
  applyPickHighlight(selectedCA, section, tbody, sections[section], (it) => countKey(section, it));
  if (typeof applyCaSearch === "function") applyCaSearch();
}
function renderAll() {
  // Модели групп «Учёта» берутся со склада (у сменщика — из каталога): индекс должен быть свежим,
  // иначе у сменщика, который не открывает «Склад»/«1С», он оставался пустым и группы не показывались.
  rebuildCrossIndexes();
  renderSection("parts");
  renderSection("consumables");
  document.getElementById("dateDisplayText").textContent = currentDate ? formatShort(currentDate) : "—";
}

function itemAt(section, index) { return sections[section][index]; }

function handleCountClick(e) {
  const section = e.currentTarget.id.replace("body-", "");
  const btn = e.target.closest("button");
  if (btn) {
    const index = parseInt(btn.dataset.index, 10);
    const item = itemAt(section, index);
    if (!item) return;
    const key = countKey(section, item);
    // «–»/«+» обрабатывает setupQtyButtons (окно ввода количества).
    if (!btn.classList.contains("chk-toggle") && !canEditCurrent()) return;   // закрытая заявка — только отметки
    if (btn.classList.contains("chk-toggle")) {
      checked[key] = !checked[key];
      // Отметка «учтено» — рабочая пометка для себя, а не изменение данных:
      // сохраняем только локально, без запуска синхронизации. Иначе при
      // отметке позиций одна за другой каждый тап дёргал загрузку на сервер.
      persistCurrentLocalOnly();
      renderSection(section);
    } else if (btn.classList.contains("ca-del-badge")) {
      if (!confirm(`Удалить «${item.name}» из списка?`)) return;
      pushHistory();
      sections[section].splice(index, 1);
      delete counts[key];
      delete checked[key];
      selectedCA[section].delete(key);
      persistCurrent();
      renderSection(section);
    }
    return;
  }
  const nameTd = e.target.closest("td.name");
  if (nameTd) {
    const tr = nameTd.closest("tr");
    toggleRowPick(selectedCA, section, tr.dataset.key, tr);
  }
}
document.getElementById("body-parts").addEventListener("click", handleCountClick);
document.getElementById("body-consumables").addEventListener("click", handleCountClick);

/* ==================== Учёт: «–»/«+» открывают окно ввода количества ==================== */
function setupQtyButtons(tbody) {
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn.plus, .btn.minus");
    if (!btn) return;
    if (!canEditCurrent()) return;
    openQtyAdjust(btn.dataset.section, Number(btn.dataset.index), btn.classList.contains("plus") ? "plus" : "minus");
  });
}
setupQtyButtons(document.getElementById("body-parts"));
setupQtyButtons(document.getElementById("body-consumables"));

function handleCountEdit(e) {
  const input = e.target.closest(".countInput");
  if (!input) return;
  if (!canEditCurrent()) { renderSection(input.dataset.section); return; }
  const section = input.dataset.section;
  const index = parseInt(input.dataset.index, 10);
  const item = itemAt(section, index);
  if (!item) return;
  const key = countKey(section, item);
  const raw = input.value.trim();
  let val = parseInt(raw, 10);
  if (raw === "" || isNaN(val) || val <= 0) {
    // Стёрли количество (или поставили 0) — позиция целиком удаляется
    // из списка, как и при списании кнопкой «–» до нуля.
    pushHistory();
    sections[section].splice(index, 1);
    delete counts[key];
    delete checked[key];
    selectedCA[section].delete(key);
    persistCurrent();
    renderSection(section);
    return;
  }
  pushHistory();
  counts[key] = val;
  persistCurrent();
  renderSection(section);
}
document.getElementById("body-parts").addEventListener("change", handleCountEdit);
document.getElementById("body-consumables").addEventListener("change", handleCountEdit);
["body-parts","body-consumables"].forEach((id) => {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("countInput")) e.target.blur();
  });
});

/* ==================== Учёт: списать / добавить количество через модалку ====================
   Кнопки «–» и «+» больше не меняют количество напрямую на 1 — открывают
   модалку, где вводится сколько именно списать/добавить. Если после
   списания количество становится 0 или уходит в минус — позиция целиком
   удаляется из списка (отдельной кнопки удаления больше нет). */
let pendingQtyAdjust = null; // { section, index, mode: 'plus'|'minus' }
const qtyAdjustInput = document.getElementById("qtyAdjustInput");

function openQtyAdjust(section, index, mode) {
  const item = itemAt(section, index);
  if (!item || !canEditCurrent()) return;
  const key = countKey(section, item);
  const current = counts[key] || 0;
  pendingQtyAdjust = { section, index, mode };
  document.getElementById("qtyAdjustTitle").textContent = (mode === "plus" ? "Добавить: " : "Списать: ") + item.name;
  document.getElementById("qtyAdjustInfo").textContent = "Сейчас в учёте: " + current + " шт."
    + (mode === "minus" ? " Если списать всё (или больше) — позиция будет удалена из списка." : "");
  document.getElementById("qtyAdjustConfirm").textContent = mode === "plus" ? "Добавить" : "Списать";
  document.getElementById("qtyAdjustConfirm").style.background = mode === "plus" ? "var(--accent)" : "var(--danger)";
  qtyAdjustInput.value = "";
  openModal("qtyAdjustOverlay");
  // фокус сразу, в рамках нажатия: иначе iOS не показывает клавиатуру
  qtyAdjustInput.focus();
  setTimeout(() => qtyAdjustInput.focus(), 60);
}
function closeQtyAdjust() {
  pendingQtyAdjust = null;
  closeModal("qtyAdjustOverlay");
}
document.getElementById("qtyAdjustCancel").addEventListener("click", closeQtyAdjust);
document.getElementById("qtyAdjustOverlay").addEventListener("click", (e) => {
  if (e.target.id === "qtyAdjustOverlay") closeQtyAdjust();
});
function applyQtyAdjust() {
  if (!pendingQtyAdjust) return;
  const { section, index, mode } = pendingQtyAdjust;
  const item = itemAt(section, index);
  if (!item) { closeQtyAdjust(); return; }
  const key = countKey(section, item);
  const val = parseInt(qtyAdjustInput.value, 10);
  if (isNaN(val) || val <= 0) { qtyAdjustInput.focus(); return; }
  pushHistory();
  if (mode === "plus") {
    counts[key] = (counts[key] || 0) + val;
  } else {
    const newVal = (counts[key] || 0) - val;
    if (newVal <= 0) {
      sections[section].splice(index, 1);
      delete counts[key];
      delete checked[key];
      selectedCA[section].delete(key);
    } else {
      counts[key] = newVal;
    }
  }
  persistCurrent();
  renderSection(section);
  closeQtyAdjust();
}
document.getElementById("qtyAdjustConfirm").addEventListener("click", applyQtyAdjust);
qtyAdjustInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyQtyAdjust();
});

/* ==================== Подтверждение удаления (общее для Склада; в «Учёте» удаление
   теперь происходит автоматически при списании количества до 0, см. applyQtyAdjust) ==================== */
let pendingDelete = null; // { kind: 'reset'|'warehouse'|'onec'|'ticket', section, index }

/* ==================== Подтверждение удаления/обнуления (общее для 3 вкладок) ====================
   Раньше у каждого вида удаления (склад, 1С, обнулить учёт, обнулить склад,
   удалить всё) была своя копия «записать pendingDelete → показать текст →
   открыть модалку», а обработчик «Да» разруливал их через 5 почти
   одинаковых if. Теперь одна функция открытия + один конфиг действий. */
function openConfirmDelete(kind, text, section, index) {
  pendingDelete = { kind, section, index };
  document.getElementById("confirmText").textContent = text;
  openModal("confirmOverlay");
}
function openConfirmWarehouse(section, index) {
  const item = warehouse[section][index];
  openConfirmDelete("warehouse",
    `Удалить «${item.name}» (${item.code}) со склада? Прошлые записи в учёте сохранятся, но перестанут быть связаны со складом.`,
    section, index);
}
function closeConfirm() {
  pendingDelete = null;
  closeModal("confirmOverlay");
}
document.getElementById("confirmNo").addEventListener("click", closeConfirm);
document.getElementById("confirmOverlay").addEventListener("click", (e) => {
  if (e.target.id === "confirmOverlay") closeConfirm();
});

// Что делает каждый вид подтверждения. pendingDelete доступен внутри
// (section/index — если действие точечное, для «обнулить»/«удалить всё» не нужны).
const DELETE_ACTIONS = {
  warehouse: () => {
    pushWhHistory();
    const { section, index } = pendingDelete;
    const item = warehouse[section][index];
    const key = countKey(section, item);
    warehouse[section].splice(index, 1);
    selectedWH[section].delete(key);
    saveWarehouse();
    renderWarehouseAll();
  },
  onec: () => {
    pushOcHistory();
    const { section, index } = pendingDelete;
    onec[section].splice(index, 1);
    saveOneC();
    renderOneCAll();
  },
  ticket: () => {
    const key = pendingDelete.section;          // ключ заявки
    if (!canDeleteTickets() || !dataByDate[key]) return;
    delete dataByDate[key];
    if (localChecks[key]) { delete localChecks[key]; try { localStorage.setItem(CHECKS_KEY, JSON.stringify(localChecks)); } catch (e) {} }
    if (currentDate === key) {
      currentDate = null;
      try { sessionStorage.removeItem("sklad2_sel_ticket"); } catch (e) {}
    }
    bindCurrent();
    saveDataByDate();
    afterTicketChange();
  },
};
document.getElementById("confirmYes").addEventListener("click", () => {
  if (!pendingDelete) return;
  const action = DELETE_ACTIONS[pendingDelete.kind];
  if (action) action();
  closeConfirm();
});

/* ==================== Поиск по складу/1С (автоподбор для панелей добавления/редактирования) ====================
   Раньше searchWarehouse/searchOneC и renderSuggestions/renderOneCSuggestions
   были парами почти одинаковых функций — отличались только тем, в каком
   хранилище искать и что написать, если совпадений нет. Теперь один общий
   поиск и один общий рендер подсказок с этими двумя как параметрами. */
// Разбивает текст на «слова» по любым не-буквенно-цифровым разделителям
// (пробел, /, -, скобки и т.п.) — одинаково и для кириллицы, и для латиницы.
function splitWords(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// Поиск «по слову»: каждое слово запроса должно быть НАЧАЛОМ какого-то
// слова в названии — иначе короткий запрос («мк») находил бы буквы внутри
// чужого слова («каМКа»). Код по-прежнему ищется подстрокой в любом месте —
// так удобнее находить позицию по фрагменту кода.
function nameMatchesQuery(name, query) {
  const qWords = splitWords(query);
  if (qWords.length === 0) return false;
  const nWords = splitWords(name);
  return qWords.every((qw) => nWords.some((nw) => nw.startsWith(qw)));
}
function searchStore(store, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  ["parts", "consumables"].forEach((section) => {
    store[section].forEach((item) => {
      const name = (item.name || "").toLowerCase();
      const code = (item.code || "").toLowerCase();
      if (nameMatchesQuery(name, q) || code.includes(q)) {
        const r = { section, code: item.code || "", name: item.name, model: item.model || "", model2: item.model2 || "" };
        if (item.ocqty !== undefined) r.ocqty = item.ocqty;   // у сменщика — остаток 1С из каталога
        if (item.ocName) r.ocName = item.ocName;              // название в 1С — для кодов-заглушек
        results.push(r);
      }
    });
  });
  // Порядок в подсказках: YGW 4.0 → YGW 5.0 → 9Bot → остальные (без серии); внутри группы — как в списке.
  const rank = (m) => { const i = SUGGEST_MODEL_ORDER.indexOf(String(m || "").trim()); return i === -1 ? SUGGEST_MODEL_ORDER.length : i; };
  return results.map((r, i) => ({ r, i })).sort((a, b) => (rank(a.r.model) - rank(b.r.model)) || (a.i - b.i)).map((x) => x.r).slice(0, 12);
}
const SUGGEST_MODEL_ORDER = ["YGW 4.0", "YGW 5.0", "9Bot"];
function renderSuggestionsFrom(box, query, onPick, store, emptyText, opts) {
  const results = searchStore(store, query);
  if (!query.trim()) { box.classList.remove("open"); box.innerHTML = ""; return; }
  if (results.length === 0) {
    box.innerHTML = `<div class="suggest-empty">${emptyText}</div>`;
    box.classList.add("open");
    return;
  }
  const withOcQty = !!(opts && opts.ocQty);
  box.innerHTML = results.map((r, idx) => {
    // Остаток из «1С» в конце строки: сразу видно, есть ли деталь в наличии,
    // не выходя из формы добавления. Позиции без пары в «1С» остатка не
    // получают — там пусто, а не ноль: это разные вещи.
    let ocQty = "";
    if (withOcQty && r.code) {
      const q = isShift() ? shiftOcQty(r) : (oneCInfoFor(r.code, r) || {}).qty;
      if (q !== undefined && q !== null) ocQty = `<span class="suggest-oc-qty">${q}</span>`;
    }
    // Остаток стоит ПЕРВЫМ в разметке: он прижат к правому краю через float,
    // а float цепляется за ту строку, в которой объявлен. Иначе у названий,
    // переносящихся на две строки, число уезжало бы на вторую.
    return `<div class="suggest-item" data-idx="${idx}">${ocQty}
       <span class="code">${escapeHtml(r.code || "—")}</span> — ${escapeHtml(r.name)}${modelsOf(r).map((m) => `<span class="suggest-model">${escapeHtml(m)}</span>`).join("")}
     </div>`;
  }).join("");
  box.classList.add("open");
  Array.from(box.querySelectorAll(".suggest-item")).forEach((el) => {
    el.addEventListener("click", () => {
      onPick(results[parseInt(el.dataset.idx, 10)]);
      box.classList.remove("open");
      box.innerHTML = "";
    });
  });
}
function renderSuggestions(box, query, onPick, opts) {
  renderSuggestionsFrom(box, query, onPick, warehouse,
    "Совпадений на складе нет — можно добавить как новую позицию без кода.", opts);
}

/* --- Добавление новой позиции в дневной список --- */
let addPicked = null; // { code, name } если выбрано из подсказки
const newItemInput = document.getElementById("newItemName");
const addSuggestBox = document.getElementById("addSuggestBox");
// На iOS при открытии клавиатуры видимая область экрана уменьшается уже
// ПОСЛЕ того, как страница отрисовалась — из-за этого поле может оказаться
// под прилипающей шапкой. Подстраховываемся: после открытия клавиатуры
// прокручиваем поле в центр видимой области.
/* Крестик очистки поля названия: виден только когда есть что стирать. */
const newItemClearBtn = document.getElementById("newItemClear");
function updateNewItemClear() {
  if (newItemClearBtn) newItemClearBtn.classList.toggle("show", !!newItemInput.value);
}
if (newItemClearBtn) {
  newItemClearBtn.addEventListener("click", () => {
    newItemInput.value = "";
    addPicked = null;
    addSuggestBox.classList.remove("open");
    addSuggestBox.innerHTML = "";
    updateNewItemClear();
    newItemInput.focus();
  });
}
newItemInput.addEventListener("input", updateNewItemClear);
updateNewItemClear();

/* Тап по полю — курсор в конец набранного, как у полей количества. Только
   на фокус: повторным тапом внутри текста курсор можно поставить где нужно. */
newItemInput.addEventListener("focus", () => {
  const end = newItemInput.value.length;
  setTimeout(() => { try { newItemInput.setSelectionRange(end, end); } catch (e) {} }, 0);
  setTimeout(() => {
    newItemInput.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 300);
});
newItemInput.addEventListener("input", () => {
  addPicked = null;
  renderSuggestions(addSuggestBox, newItemInput.value, (r) => {
    addPicked = r;
    newItemInput.value = r.name;
    updateNewItemClear();
    newItemQtyInput.focus();   // после выбора из списка сразу ввод количества
  }, { ocQty: true });
});

registerSuggestZone(addSuggestBox, [newItemInput]);

/* Поле количества: только цифры; пустое = 1 (серая подсказка, не мешает вводу);
   при входе в поле содержимое выделяется, чтобы набор заменял его, а не дописывался. */
const newItemQtyInput = document.getElementById("newItemQty");
newItemQtyInput.addEventListener("input", () => {
  const d = newItemQtyInput.value.replace(/\D+/g, "");
  if (d !== newItemQtyInput.value) newItemQtyInput.value = d;
});
newItemQtyInput.addEventListener("focus", () => {
  setTimeout(() => { try { newItemQtyInput.select(); } catch (e) {} }, 0);
});

document.getElementById("addItemBtn").addEventListener("click", () => {
  if (!canEditCurrent()) return;
  // Разделов больше нет: всё идёт в один список (parts). В старой заявке
  // позиция могла остаться в consumables — тогда прибавляем туда, без дубля.
  const name = newItemInput.value.trim();
  if (!name) return;
  const code = (addPicked && addPicked.name === name) ? addPicked.code : "";
  const inOld = (it) => code ? it.code === code : (!it.code && it.name === name);
  const section = (sections.consumables || []).some(inOld) ? "consumables" : "parts";
  const qtyInput = document.getElementById("newItemQty");
  let qty = parseInt(qtyInput.value, 10);
  if (isNaN(qty) || qty < 1) qty = 1;   // не указали — считаем как 1
  const clearForm = () => {
    newItemInput.value = "";
    qtyInput.value = "";
    addPicked = null;
    addSuggestBox.classList.remove("open");
    updateNewItemClear();
  };
  // Уникальность позиции определяет КОД, а не название: одинаково
  // названные детали под разные модели (например «Подшипник вилки»
  // с кодами 456JY50-01-0 и 454LB40-01-0) — это разные позиции, и обе
  // должны добавляться. Совпадением считаем только одинаковый код;
  // если кода нет ни у новой, ни у существующей — сравниваем по названию.
  const dupIndex = sections[section].findIndex((it) =>
    code ? (it.code === code) : (!it.code && it.name === name)
  );
  if (dupIndex !== -1) {
    // Позиция уже в списке — прибавляем количество к набранному.
    const existing = sections[section][dupIndex];
    const key = countKey(section, existing);
    pushHistory();
    counts[key] = (counts[key] || 0) + qty;
    persistCurrent();
    clearForm();
    renderSection(section);
    flashRow(rowByDataIndex("body-" + section, dupIndex));
    return;
  }
  pushHistory();
  const newItem = { name, code };
  sections[section].push(newItem);
  counts[countKey(section, newItem)] = qty;
  persistCurrent();
  clearForm();
  renderSection(section);
  // Новая позиция уходит в свою группу по модели, а не в конец списка —
  // ищем её по индексу, иначе подсветилась бы чужая строка.
  flashRow(rowByDataIndex("body-" + section, sections[section].length - 1));
});
newItemInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addItemBtn").click();
});
document.getElementById("newItemQty").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addItemBtn").click();
});

/* ==================== История выдачи по позиции (только расход по дням) ==================== */
let historyTarget = null; // { key, name }

function collectHistoryEntries(key) {
  const map = {}; // date -> minus (кол-во выдано в этот день)
  Object.keys(dataByDate).forEach((date) => {
    const c = (dataByDate[date] && dataByDate[date].counts) || {};
    if (c[key]) map[date] = (map[date] || 0) + c[key];
  });
  return map;
}

function renderHistoryList() {
  if (!historyTarget) return;
  const from = document.getElementById("historyFrom").value;
  const to = document.getElementById("historyTo").value;
  const map = collectHistoryEntries(historyTarget.key);
  let dates = Object.keys(map).filter((d) => (!from || d >= from) && (!to || d <= to));
  dates.sort().reverse();
  const list = document.getElementById("historyList");
  if (dates.length === 0) {
    list.innerHTML = `<div class="history-empty">Нет данных о выдаче за выбранный период.</div>`;
    return;
  }
  list.innerHTML = dates.map((d) =>
    `<div class="history-row"><span class="h-date">${formatShort(d)}</span><span class="h-minus">−${map[d]} шт</span></div>`
  ).join("");
}

function openHistory(section, item) {
  const key = countKey(section, item);
  historyTarget = { key, name: item.name };
  document.getElementById("historyTitle").textContent = "История выдачи: " + item.name;
  document.getElementById("historyFrom").value = "";
  document.getElementById("historyTo").value = "";
  renderHistoryList();
  openModal("historyOverlay");
}
function closeHistory() {
  historyTarget = null;
  closeModal("historyOverlay");
}
document.getElementById("historyFrom").addEventListener("change", renderHistoryList);
document.getElementById("historyTo").addEventListener("change", renderHistoryList);
document.getElementById("historyClose").addEventListener("click", closeHistory);
document.getElementById("historyOverlay").addEventListener("click", (e) => {
  if (e.target.id === "historyOverlay") closeHistory();
});

/* ==================== Печать этикеток (эталон «большая») ====================
   90x45мм, 2x5=10 на лист. 4 условные строки высотой (10/10/10/15мм):
   1 — модель слева, «N шт» в правом углу; 2-3 — название (1 строка по
   центру обеих, длинное — переносом на 2); 4 — код, жирным, крупным
   шрифтом, растянутым под ширину/высоту строки. Единый дизайн — и для
   печати из меню строки «Склада».
   ВАЖНО: используем #printArea + window.print() — открытие через window.open() в установленном на «Домой»
   PWA виснет без адресной строки и кнопки закрытия. */
function fitCodeFontPt(text, maxWidthMm, startPt, minPt) {
  const canvas = fitCodeFontPt._canvas || (fitCodeFontPt._canvas = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  const mmToPx = 96 / 25.4;
  const maxWidthPx = maxWidthMm * mmToPx;
  let pt = startPt;
  while (pt > minPt) {
    const px = pt * 96 / 72;
    ctx.font = `700 ${px}px monospace`;
    if (ctx.measureText(text).width <= maxWidthPx) break;
    pt -= 1;
  }
  return pt;
}
function buildLabelHtmlV2(name, code, qty, model) {
  const qtyNum = parseInt(qty, 10);
  const showQty = qty && !isNaN(qtyNum) && qtyNum > 0; // "0" или пусто — не печатаем
  const codeSize = code ? fitCodeFontPt(code, 84, 26, 14) : 26; // 90мм - 2×3мм полей
  return `<div class="print-label v2">
    <div class="pl2-row1">
      <span class="pl2-model">${model ? escapeHtml(model) : ""}</span>
      <span class="pl2-qty">${showQty ? qtyNum + " шт" : ""}</span>
    </div>
    <div class="pl2-name">${escapeHtml(name)}</div>
    ${code ? `<div class="pl2-code" style="font-size:${codeSize}pt;">${escapeHtml(code)}</div>` : ""}
  </div>`;
}
const LABELS_V2_PER_PAGE = 10; // 2x5, 90x45мм
function printLabelsV2(entries) {
  const allLabels = [];
  entries.forEach((e) => {
    const html = buildLabelHtmlV2(e.name, e.code, e.qty, e.model);
    const copies = Math.max(1, e.copies || 1);
    for (let i = 0; i < copies; i++) allLabels.push(html);
  });
  const pages = [];
  for (let i = 0; i < allLabels.length; i += LABELS_V2_PER_PAGE) {
    const slice = allLabels.slice(i, i + LABELS_V2_PER_PAGE).join("");
    pages.push(`<div class="print-labels-page"><div class="print-labels-grid" style="grid-template-columns: repeat(2, 85mm);">${slice}</div></div>`);
  }
  document.getElementById("printArea").innerHTML = pages.join("");
  window.print();
}
function printWarehouseLabels(item) {
  printLabelsV2([{ name: item.name, code: item.code || "", model: item.model || "", copies: LABELS_V2_PER_PAGE }]);
}
/* ==================== Левый столбец: заявки на учёт ==================== */
let ticketQuery = "", ticketSearchOpen = false;
function pluralRu(n, a, b, c) {
  const m = n % 10, h = n % 100;
  return n + " " + (m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c));
}
function ticketDateLong(key) {
  const [y, m, d] = key.slice(0, 10).split("-");
  return d + "." + m + "." + String(y).slice(2);
}
function updateLayoutClasses() {
  const cons = currentTab === "consumption";
  document.body.classList.toggle("has-list", cons && !QR_KIOSK);
  document.body.classList.toggle("no-ticket", cons && !currentDate);
  document.body.classList.toggle("has-ticket", cons && !!currentDate);
}
function ticketMatches(key, e, q) {
  // возвращает null (не подходит), [] (подходит по номеру/дате) или список найденных позиций
  const num = ticketNumberMap()[key];
  const head = ("№" + num + " " + num + " " + ticketDateLong(key) + " " + formatShort(key) + " " + (e.note || "")).toLowerCase();
  const found = [];
  ["parts", "consumables"].forEach((s) => {
    ((e.sections && e.sections[s]) || []).forEach((it) => {
      const hay = ((it.name || "") + " " + (it.code || "")).toLowerCase();
      if (hay.indexOf(q) !== -1) found.push({ it, s });
    });
  });
  if (found.length) return found;
  return head.indexOf(q) !== -1 ? [] : null;
}
function authorLabel(login) { const l = String(login || ""); return l.charAt(0).toUpperCase() + l.slice(1); }
function renderTicketList() {
  const box = document.getElementById("ticketCards");
  if (!box) return;
  const nums = ticketNumberMap();
  const q = ticketQuery.trim().toLowerCase();
  const keys = ticketKeys().slice().reverse();   // новые сверху
  const out = [];
  keys.forEach((k) => {
    const e = dataByDate[k];
    let found = [];
    if (q) { const r = ticketMatches(k, e, q); if (r === null) return; found = r; }
    const cnt = entryItemCount(e);
    const shown = found.slice(0, 6).map((f) => {
      const qty = (e.counts || {})[countKey(f.s, f.it)] || 0;
      return `<div class="t-hit"><span class="t-hit-name">${escapeHtml(f.it.name || "")}</span>`
        + `<span class="t-hit-meta">${f.it.code ? escapeHtml(f.it.code) + " · " : ""}${qty} шт</span></div>`;
    }).join("");
    const more = found.length > 6 ? `<div class="t-hit-more">и ещё ${found.length - 6}</div>` : "";
    out.push(`<button class="t-card${k === currentDate ? " sel" : ""}" data-key="${escapeHtml(k)}">`
      + `<div class="t-row"><span class="mono">№ ${nums[k]}</span>${e.note ? `<span class="t-note">${escapeHtml(e.note)}</span>` : ""}<span class="t-date">${ticketDateLong(k)}</span></div>`
      + `<div class="t-sub">${pluralRu(cnt, "позиция", "позиции", "позиций")}</div>`
      + ((canDeleteTickets() || e.by) ? `<div class="t-foot">`
          + (canDeleteTickets() ? `<span class="t-menu-wrap"><span class="t-menu-btn" role="button" tabindex="0" title="Действия">⋮</span>`
              + `<span class="t-menu"><span class="t-act" role="button" data-act="note" data-key="${escapeHtml(k)}">✎ Комментарий</span>`
              + `<span class="t-act danger" role="button" data-act="del" data-key="${escapeHtml(k)}">🗑 Удалить</span></span></span>` : "<span></span>")
          + (e.by ? `<span class="t-author">${escapeHtml(authorLabel(e.by))}</span>` : "")
          + `</div>` : "")
      + `${shown}${more}`
      + `</button>`);
  });
  box.innerHTML = out.length ? out.join("")
    : `<div class="t-empty">${q ? "Ничего не найдено" : "Заявок на учёт нет. Создайте кнопкой «+»."}</div>`;
}
function afterTicketChange() {
  caHistory.reset();
  selectedCA.parts.clear(); selectedCA.consumables.clear();
  renderAll();
  renderTicketList();
  updateAddPanelVisibility();
  try { window.scrollTo(0, 0); } catch (e) {}
}
function selectTicket(key) {
  if (key === currentDate) { afterTicketChange(); return; }
  persistCurrentLocalOnly();
  currentDate = key && dataByDate[key] ? key : null;
  bindCurrent();
  try { if (currentDate) sessionStorage.setItem("sklad2_sel_ticket", currentDate); else sessionStorage.removeItem("sklad2_sel_ticket"); } catch (e) {}
  afterTicketChange();
}
function createTicket(note) {
  if (shiftTodayTicket()) return;
  persistCurrentLocalOnly();
  const d = todayStr();
  let key = d, n = 1;
  while (dataByDate[key]) { n++; key = d + "#" + n; }
  dataByDate[key] = emptyEntry();
  dataByDate[key].created = Date.now();          // пустая заявка удалится сама через час
  if (MY_LOGIN) dataByDate[key].by = MY_LOGIN;   // автор заявки (показывается в карточке)
  if (note) dataByDate[key].note = note;         // комментарий hleb — рядом с номером в карточке
  currentDate = key;
  bindCurrent();
  saveDataByDate();
  try { sessionStorage.setItem("sklad2_sel_ticket", currentDate); } catch (e) {}
  afterTicketChange();
}
// Одна заявка в день на аккаунт (кроме hleb): если своя за сегодня уже есть, открываем её, а не создаём новую.
function shiftTodayTicket() {
  if (!MY_LOGIN || MY_LOGIN === "hleb") return null;
  const t = todayStr();
  return ticketKeys().find((k) => k.slice(0, 10) === t && dataByDate[k].by === MY_LOGIN) || null;
}
document.getElementById("ticketNewBtn").addEventListener("click", () => {
  const own = shiftTodayTicket();
  if (own) { selectTicket(own); alert("На сегодня заявка уже есть. Добавляйте позиции в неё."); return; }
  const n = ticketKeys().length + 1;
  document.getElementById("newTicketText").textContent =
    "Создать новую заявку на учёт № " + n + " за " + formatFull(todayStr()) + "?";
  const note = document.getElementById("newTicketNote");
  note.value = "";
  note.hidden = MY_LOGIN !== "hleb";
  openModal("newTicketOverlay");
});
document.getElementById("newTicketNo").addEventListener("click", () => closeModal("newTicketOverlay"));
document.getElementById("newTicketOverlay").addEventListener("click", (e) => {
  if (e.target.id === "newTicketOverlay") closeModal("newTicketOverlay");
});
document.getElementById("newTicketYes").addEventListener("click", () => {
  closeModal("newTicketOverlay");
  createTicket(MY_LOGIN === "hleb" ? document.getElementById("newTicketNote").value.trim() : "");
});
document.getElementById("ticketBackBtn").addEventListener("click", () => { if (!QR_KIOSK) selectTicket(null); });
/* ==================== QR-вход для склада (только hleb) ====================
   Скан QR сразу входит в аккаунт sklad и открывает заявку на текущий день (#today).
   В QR — токен; сервер хранит один действующий, «Сгенерировать новый» отменяет старый. */
function qrShiftUrl(token) { return location.origin + location.pathname + "?qr=" + token + "#today"; }
function qrSvg(text) {
  const m = window.QRLib.matrix(text, "M"), b = 4, n = m.size + b * 2;
  let d = "";
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) d += `M${c + b} ${r + b}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
function showQrShift(info) {
  const box = document.getElementById("qrShiftBox"), line = document.getElementById("qrShiftInfo");
  if (info && info.token && window.QRLib) {
    box.innerHTML = qrSvg(qrShiftUrl(info.token));
    const d = info.created_at ? new Date(info.created_at) : null;
    line.textContent = "Скан сразу входит в аккаунт sklad и открывает заявку на текущий день." + (d ? " Код от " + d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) + "." : "");
  } else {
    box.innerHTML = `<div class="qr-empty">${info === null ? "QR-кода ещё нет — нажмите «Сгенерировать новый»." : "Не удалось загрузить QR-код (нет связи?)."}</div>`;
    line.textContent = "";
  }
}
async function qrShiftCall(fn) {
  const r = await Auth.withTimeout(Auth.sb.rpc(fn), 15000);
  if (r.error) throw r.error;
  return r.data || null;
}
{
  const qrBtn = document.getElementById("qrShiftBtn");
  if (qrBtn && MY_LOGIN === "hleb") qrBtn.hidden = false;
  if (qrBtn) qrBtn.addEventListener("click", async () => {
    if (MY_LOGIN !== "hleb" || !window.Auth) return;
    document.getElementById("qrShiftBox").innerHTML = `<div class="qr-empty">Загрузка…</div>`;
    document.getElementById("qrShiftInfo").textContent = "";
    openModal("qrShiftOverlay");
    try { showQrShift(await qrShiftCall("sklad_qr_get")); } catch (e) { showQrShift(undefined); }
  });
  document.getElementById("qrShiftClose").addEventListener("click", () => closeModal("qrShiftOverlay"));
  document.getElementById("qrShiftOverlay").addEventListener("click", (e) => { if (e.target.id === "qrShiftOverlay") closeModal("qrShiftOverlay"); });
  document.getElementById("qrShiftNew").addEventListener("click", async () => {
    if (!confirm("Сгенерировать новый QR-код? Старый сразу перестанет работать, а устройства, вошедшие в sklad по QR, выйдут из аккаунта (вошедшие по паролю останутся).")) return;
    try { showQrShift(await qrShiftCall("sklad_qr_new")); } catch (e) { alert("Не удалось создать QR-код: " + ((e && e.message) || e)); }
  });
}
function closeTicketMenus() { document.querySelectorAll(".t-menu-wrap.open").forEach((w) => w.classList.remove("open")); }
document.addEventListener("click", (e) => { if (!e.target.closest(".t-menu-wrap")) closeTicketMenus(); });
// Комментарий заявки (только hleb): правка в отдельном окне
let ticketNoteKey = null;
function openTicketNote(key) {
  ticketNoteKey = key;
  document.getElementById("ticketNoteTitle").textContent = "Комментарий к заявке № " + ticketNumberMap()[key];
  const inp = document.getElementById("ticketNoteInput");
  inp.value = (dataByDate[key] && dataByDate[key].note) || "";
  openModal("ticketNoteOverlay");
  setTimeout(() => { inp.focus(); const end = inp.value.length; inp.setSelectionRange(end, end); }, 50);
}
function closeTicketNote() { ticketNoteKey = null; closeModal("ticketNoteOverlay"); }
document.getElementById("ticketNoteCancel").addEventListener("click", closeTicketNote);
document.getElementById("ticketNoteOverlay").addEventListener("click", (e) => { if (e.target.id === "ticketNoteOverlay") closeTicketNote(); });
document.getElementById("ticketNoteSave").addEventListener("click", () => {
  const key = ticketNoteKey;
  if (!key || !dataByDate[key] || !canDeleteTickets()) { closeTicketNote(); return; }
  const v = document.getElementById("ticketNoteInput").value.trim();
  if (v) dataByDate[key].note = v; else delete dataByDate[key].note;
  saveDataByDate();
  closeTicketNote();
  renderTicketList();
});
document.getElementById("ticketCards").addEventListener("click", (e) => {
  const mb = e.target.closest(".t-menu-btn");
  if (mb) {
    e.stopPropagation();
    const w = mb.parentElement, was = w.classList.contains("open");
    closeTicketMenus();
    w.classList.toggle("open", !was);
    return;
  }
  const act = e.target.closest(".t-act");
  if (act) {
    e.stopPropagation();
    closeTicketMenus();
    if (!canDeleteTickets()) return;
    const key = act.dataset.key;
    const e2 = dataByDate[key];
    if (!e2) return;
    if (act.dataset.act === "note") { openTicketNote(key); return; }
    openConfirmDelete("ticket",
      `Удалить заявку на учёт № ${ticketNumberMap()[key]} за ${formatFull(key)} (${pluralRu(entryItemCount(e2), "позиция", "позиции", "позиций")})? Удаление уйдёт на сервер и на все устройства.`, key);
    return;
  }
  if (e.target.closest(".t-menu")) return;
  const c = e.target.closest(".t-card");
  if (c) selectTicket(c.dataset.key === currentDate ? null : c.dataset.key);   // повторный тап снимает выбор
});
document.getElementById("ticketSearchBtn").addEventListener("click", () => {
  ticketSearchOpen = !ticketSearchOpen;
  const box = document.getElementById("ticketSearchBox");
  box.hidden = !ticketSearchOpen;
  document.getElementById("ticketSearchBtn").classList.toggle("on", ticketSearchOpen);
  if (ticketSearchOpen) document.getElementById("ticketSearchInput").focus();
  else { ticketQuery = ""; document.getElementById("ticketSearchInput").value = ""; renderTicketList(); }
});
document.getElementById("ticketSearchInput").addEventListener("input", (e) => {
  ticketQuery = e.target.value;
  renderTicketList();
});

/* ==================== ВКЛАДКА СКЛАД: логика ==================== */
/* ==================== Модели самоката у позиции ====================
   У позиции до двух моделей: model (основная) и model2 (вторая, необязательная).
   Показываются одна под другой в правом верхнем углу ячейки названия. */
// Модели равноправны: всегда в одном порядке (4.0, 5.0, 9Bot, прочие), независимо от того, какая записана первой.
const MODEL_DISPLAY_ORDER = ["YGW 4.0", "YGW 5.0", "9Bot"];
function modelsOf(it) {
  const out = [];
  if (!it) return out;
  [it.model, it.model2].forEach((m) => { if (m && out.indexOf(m) === -1) out.push(m); });
  const r = (m) => { const k = MODEL_DISPLAY_ORDER.indexOf(m); return k === -1 ? 99 : k; };
  return out.sort((a, b) => r(a) - r(b));
}
function hasModel(it, m) { return modelsOf(it).indexOf(m) !== -1; }
// Модель позиции 1С: если она есть на складе — модель склада (одна на пару), иначе своя.
function ocModelsOf(it) {
  const w = it && it.code ? warehouseInfoFor(it.code, it.name) : null;
  return w ? modelsOf(w) : modelsOf(it);
}
function modelBadgesHtml(models, stripYgw) {
  if (!models || !models.length) return "";
  return `<span class="model-badges">${models.map((m) =>
    `<span>${escapeHtml(stripYgw ? String(m).replace(/^YGW\s*/i, "") : m)}</span>`).join("")}</span>`;
}

/* ==================== Категории склада ====================
   Фильтр: Самокаты (Все / YGW 5.0 / YGW 4.0 / 9Bot / Без модели), Инструменты,
   Расходники, Остальное. Категория позиции — поле cat (ставится в окне правки);
   если не задана, определяется правилами ниже по названию, коду и модели.
   Только просмотр: фильтр данные не меняет, выбор запоминается на устройстве. */
const WH_CATS = { scooter: "Самокаты", tool: "Инструменты", cons: "Расходники", other: "Остальное" };
// Правила по порядку: первое сработавшее решает. [категория, поле, выражение]
const WH_CAT_RULES = [
  ["cons", "name", /^(винт|болт|гайка|шайба|саморез|шуруп|заклепка|стяжка|screw|flat gasket|disk-lock|nylon cable|stainless steel collar|стопорная шайба|плоская шайба)/i],
  ["tool", "name", /(^бита|бокорез|^головка семиуг)/i],
  ["cons", "name", /(лента на липучке|^коробка|упаковочн|наклейк|qr-код|жидкий ключ|пломб|лезви)/i],
  ["scooter", "model", /./],
  ["scooter", "code", /^(\d{3}[a-z]{2}\d{2}-|ab|14\.01\.|nbr|6001|6003|16004|e05|врем|00000775|00-00002861|796$|zu001|234jy)/i],
  ["cons", "name", /(pla-пластик|пластик для 3d|пластик в катушке|филамент|масло|шампун|щетка для мой|щетка для мыть)/i],
  ["other", "name", /(внешний аккумулятор|ящик|органайзер|3d принтер)/i],
  ["tool", "name", /(дрел|шуруповерт|винтоверт|перфоратор|гайковерт|пила|шлифмаш|углошлиф|углоглиф|угловая шлиф|ушм|аккумулятор|удлинитель для бит|лопатка монтаж)/i],
  ["other", "name", /(станок|мойк|пылесос|сварочн|обогреват|пушка тепл|принтер|верстак|стул|кресло|весы|сканер|мышь|светильник|удлинитель|сетевой фильтр|фильтр удлинитель|тройник|картридер|перфопанел|подвес|полк[аи]|система хранения|колесо поворот|кран шаров|шланг|доска магнит|ограждение|знак |лопат|ледоруб|швабр|сгон|аппарат высокого|фильтр для моек|фильтр тонкой|набор для полива|компрессор|соединени|соединител|муфта|поддон|тарелка магнит|держатель инструмента магнит|страховочная подставка)/i],
  ["tool", "name", /(отверт|головок|сверел|насад|бит |бит$|бита|биты|бит-головк|ключ|головк|трещ|вороток|пинцет|нож|кусачк|плоскогуб|пассатиж|длинногуб|клещ|молот|киянк|кувалд|зажим|струбцин|тиски|заклепочник|напильник|рулетк|отсос припоя|фен|полировальная машина|сверл|набор инструмент|инструмент для|экстрактор|плашк|переходник|адаптер|держател[ья]? для бит|держатель бит|редуктор|стаместк|лом|горелк|точильн|гравер|насадк|кордщетк|щетка для дрели|щетка концев|щетка круглая|щетка дисков|щетка металлическая для ушм|ракель|валик|пистолет|опрыскиват|пульверизат|распылит|воронк|набор ремонтника|реанимат|диагностическ|магнитный держатель|шестигранник|борфрез)/i],
  ["cons", "name", /(заклепк|болт м|перчат|краги|респиратор|полумаск|очки|щиток|куртк|плащ|сапог|ботинк|чулок|костюм|стельк|скотч|лент|изолен|этикетк|бумаг|блокнот|картон|пакет|пленк|стрейч|клей|склеиван|активатор|герметик|смазк|обезжир|растворит|уайт|очистит|граффити|удалител|паст|диск|круг|наждач|абразив|губка|микрофибр|вафельн|протирочн|батаре|крона|маркер|резинк|припой|трубк|термоус|эмаль|жидкое стекло|газ |проволок|фум|оргстекло|прокладка|кисть|щетк|щётк|сальник)/i]
];
function guessWhCat(item) {
  for (const [cat, field, re] of WH_CAT_RULES) {
    if (re.test(String(item[field] || ""))) return cat;
  }
  return "other";
}
function whCatOf(item) { return WH_CATS[item.cat] ? item.cat : guessWhCat(item); }

const WH_FILTER_KEY = "sklad2_wh_filter_v2";
let whFilter = (function () {
  try {
    const f = JSON.parse(localStorage.getItem(WH_FILTER_KEY) || "null");
    if (f && WH_CATS[f.cat]) return { cat: f.cat, model: f.model || "all" };
  } catch (e) {}
  return { cat: "scooter", model: "all" };
})();
function saveWhFilter() {
  try { localStorage.setItem(WH_FILTER_KEY, JSON.stringify(whFilter)); } catch (e) {}
}
function whMatches(item) {
  if (whCatOf(item) !== whFilter.cat) return false;
  if (whFilter.cat !== "scooter" || whFilter.model === "all") return true;
  if (whFilter.model === "none") return modelsOf(item).length === 0;
  return hasModel(item, whFilter.model);
}
// Показать все позиции категории этой позиции (для перехода к строке, скрытой фильтром).
function whFilterShowItem(item) {
  whFilter = { cat: whCatOf(item), model: "all" };
  saveWhFilter();
}
function whFilterTitle() {
  if (whFilter.cat !== "scooter" || whFilter.model === "all") return WH_CATS[whFilter.cat];
  return "Самокаты · " + (whFilter.model === "none" ? "без модели" : whFilter.model);
}
// Пары { item, i } — исходный индекс нужен, иначе кнопки в строках стали бы
// указывать не на те позиции.
function whFilteredPairs(section) {
  return warehouse[section].map((item, i) => ({ item, i })).filter(({ item }) => whMatches(item));
}
// Разделы «Склада» и «1С» показываются одной таблицей, поэтому перерисовываются всегда вместе.
function renderWarehouseSection() { renderWarehouseAll(); }
function renderWhRows(section) {
  const tbody = document.getElementById("wh-body-" + section);
  const picked = selectedWH[section];
  tbody.innerHTML = whFilteredPairs(section).map(({ item, i }) => {
    const key = countKey(section, item);
    const ocInfo = oneCInfoFor(item.code, item);
    return `<tr data-key="${escapeHtml(key)}" data-index="${i}" data-section="${section}"${picked.has(key) ? ' class="row-picked"' : ""}>
      <td class="code">${item.code ? `<span class="code-text" data-code="${escapeHtml(item.code)}">${formatCodeDisplay(item.code)}</span>` : "—"}</td>
      <td class="name"><div class="main-name">${escapeHtml(item.name)}</div>${ocInfo ? altNameHtml(item.code, ocInfo, true) : ""}
        <span class="oc-side">
        <span class="wh-corner">${modelBadgesHtml(modelsOf(item), true)}<span class="wh-oc-qty" title="Остаток 1С">${ocInfo ? ocInfo.qty : "—"}</span></span>
        <span class="oc-btns">
        <div class="menu-wrap wh-menu-wrap">
          <button class="iconbtn wh-menu-btn" data-section="${section}" data-index="${i}" title="Действия">⋮</button>
          <div class="menu-panel wh-menu-panel">
            <button class="wh-edit" data-section="${section}" data-index="${i}" title="Редактировать">✎</button>
            <button class="wh-history" data-section="${section}" data-index="${i}" title="История выдачи">🕘</button>
            <button class="wh-print" data-section="${section}" data-index="${i}" title="Печать этикеток">🖨️</button>
            <button class="wh-del danger" data-section="${section}" data-index="${i}" title="Удалить со склада">✕</button>
          </div>
        </div>
        </span>
        </span>
      </td>
    </tr>`;
  }).join("");
}
/* При активной сортировке строки обоих разделов сливаются в общий порядок (в первый tbody),
   иначе сортировка шла внутри каждого раздела отдельно и детали всегда стояли выше расходников. */
function mergeSortedRows(table, prefix, store) {
  const st = sortState[table].parts;
  if (!st.col) return;
  const parts = document.getElementById(prefix + "parts");
  const rows = Array.from(document.querySelectorAll(`#${prefix}parts tr[data-index], #${prefix}consumables tr[data-index]`));
  const val = (tr) => getSortValue(table, tr.dataset.section, store[tr.dataset.section][+tr.dataset.index], st.col);
  const keyed = rows.map((tr, n) => ({ tr, n, v: val(tr) }));
  keyed.sort((a, b) => {
    const cmp = typeof a.v === "string" ? a.v.localeCompare(b.v, "ru") : (a.v - b.v);
    return (st.dir === "asc" ? cmp : -cmp) || (a.n - b.n);
  });
  keyed.forEach(({ tr }) => parts.appendChild(tr));
}
// Детали и расходники идут одной таблицей: сквозная нумерация, общий итог 1С, пустое состояние.
function whAfterRender() {
  const n = document.querySelectorAll("#wh-body-parts tr[data-index], #wh-body-consumables tr[data-index]").length;
  const empty = document.getElementById("wh-body-empty");
  if (empty) empty.hidden = n > 0;
  updateWhFilterUI();
}
function renderWarehouseAll() {
  // Индекс код→позиция должен быть свежим ДО построения строк (переход «Склад» ↔ «1С»).
  rebuildCrossIndexes();
  renderWhRows("parts");
  renderWhRows("consumables");
  mergeSortedRows("wh", "wh-body-", warehouse);
  whAfterRender();
  if (typeof applyWhSearch === "function") applyWhSearch();
}
function updateWhFilterUI() {
  const shown = document.querySelectorAll("#wh-body-parts tr[data-index], #wh-body-consumables tr[data-index]").length;
  const label = document.getElementById("whFilterLabel");
  if (label) label.textContent = String(shown);
  const title = document.getElementById("whTitle");
  if (title) title.textContent = whFilterTitle();
  document.querySelectorAll("#whFilterPanel [data-cat]").forEach((b) => {
    const on = b.dataset.cat === whFilter.cat && (!b.dataset.model || b.dataset.model === whFilter.model || b.dataset.cat !== "scooter");
    b.classList.toggle("primary", b.dataset.model ? on : b.dataset.cat === whFilter.cat);
  });
}
document.getElementById("whTitle").addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = document.getElementById("whFilterPanel");
  const open = panel.classList.toggle("open");
  if (open) document.getElementById("whScooterSub").hidden = whFilter.cat !== "scooter";
});
document.querySelectorAll("#whFilterPanel [data-cat]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.dataset.model) {   // «Самокаты ▸» — раскрыть выбор модели
      const sub = document.getElementById("whScooterSub");
      sub.hidden = !sub.hidden;
      return;
    }
    whFilter = { cat: btn.dataset.cat, model: btn.dataset.model };
    saveWhFilter();
    document.getElementById("whFilterPanel").classList.remove("open");
    renderWarehouseAll();      // только перерисовка, без синхронизации
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".wh-filter-wrap")) {
    const p = document.getElementById("whFilterPanel");
    if (p) p.classList.remove("open");
  }
});

/* Меню строки лежит внутри таблицы, а у контейнера таблицы overflow-x:auto —
   браузер при этом обрезает и по вертикали, поэтому у нижних строк меню
   уходило под край и было не видно. Если снизу не хватает места —
   раскрываем меню вверх. */
/* Меню строки лежит внутри таблицы, а контейнер таблицы обрезает всё, что
   выходит за его край (из-за overflow-x:auto браузер обрезает и по
   вертикали). Раскрытия «вверх» не хватало: у предпоследних строк меню всё
   равно упиралось в край. Поэтому переводим панель в режим «поверх
   страницы» (position: fixed) и сами считаем координаты — обрезать её
   тогда физически нечем. */
function placeRowMenu(panel) {
  // Панель на время показа переезжает в <body>. Причина: таблицы лежат внутри
  // .table-scroll с -webkit-overflow-scrolling: touch, а у самой таблицы стоит
  // overflow: hidden. Safari на iPhone такой контейнер и обрезает вложенное
  // меню, и рисует его в СВОЁМ слое — поэтому у последней строки раздела
  // нижняя половина меню оказывалась под таблицей следующего раздела, и никакой
  // z-index не помогал. В <body> перекрывать и обрезать его нечем.
  const wrap = panel.parentElement;                 // .menu-wrap с кнопкой «⋮»
  const r = wrap.getBoundingClientRect();           // координаты — ДО переезда
  panel._homeWrap = wrap;
  document.body.appendChild(panel);
  panel.classList.add("floating", "portaled");
  panel.style.position = "fixed";
  panel.style.top = "0px";
  panel.style.left = "0px";
  panel.style.bottom = "auto";
  panel.style.right = "auto";
  const w = panel.offsetWidth || 150;
  const h = panel.offsetHeight || 150;
  const pad = 8;
  // по горизонтали — прижимаем правый край панели к правому краю кнопки
  let left = r.right - w;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  // по вертикали — под кнопкой, а если не помещается, то над ней
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - pad) {
    const above = r.top - h - 6;
    top = (above >= pad) ? above : Math.max(pad, window.innerHeight - h - pad);
  }
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}
/* Возвращаем панель в обычное состояние при закрытии, иначе она осталась бы
   висеть в углу экрана. */
function resetRowMenu(panel) {
  panel.classList.remove("floating", "drop-up", "portaled");
  panel.style.position = "";
  panel.style.top = panel.style.left = panel.style.bottom = panel.style.right = "";
  const home = panel._homeWrap;
  panel._homeWrap = null;
  if (!home) return;
  // Таблицу могли перерисовать, пока меню было открыто (пришли данные с
  // сервера, сменилась сортировка) — тогда возвращать панель некуда, и она
  // осталась бы висеть поверх страницы. Такую просто убираем.
  if (home.isConnected) home.appendChild(panel);
  else panel.remove();
}
/* Общая для «Склада» и «1С»: закрывает все открытые меню строк заданного
   класса, кроме `except` (обычно — только что открытое). */
function closeAllRowMenus(panelClass, except) {
  document.querySelectorAll("." + panelClass + ".open").forEach((p) => {
    if (p !== except) { p.classList.remove("open"); resetRowMenu(p); }
  });
}
function closeAllWhMenus(except) { closeAllRowMenus("wh-menu-panel", except); }
/* Общая для «Склада» и «1С»: открывает/закрывает меню строки по кнопке «⋮»,
   предварительно закрыв остальные такие же меню. */
function toggleRowMenu(btn, panelClass, closeAllFn) {
  const panel = btn.parentElement.querySelector("." + panelClass);
  const willOpen = !panel.classList.contains("open");
  closeAllFn();
  panel.classList.toggle("open", willOpen);
  if (willOpen) placeRowMenu(panel); else resetRowMenu(panel);
}
/* Действия строки «Склада» вынесены отдельно: их запускает и обработчик
   таблицы, и обработчик меню, вынесенного в <body> (см. placeRowMenu) —
   до таблицы клик оттуда уже не доходит. */
function runWhRowAction(section, index, btn) {
  if (btn.classList.contains("wh-del")) {
    openConfirmWarehouse(section, index);
  } else if (btn.classList.contains("wh-edit")) {
    openWhEdit(section, index);
  } else if (btn.classList.contains("wh-history")) {
    openHistory(section, warehouse[section][index]);
  } else if (btn.classList.contains("wh-print")) {
    printWarehouseLabels(warehouse[section][index]);
  }
}
/* Клик по кнопке внутри вынесенного меню. Ловим на перехвате, чтобы сработать
   раньше общего «клик мимо меню — закрыть»: то закрытие возвращает панель в
   таблицу и сняло бы с неё классы до того, как мы прочитали, что нажали. */
document.addEventListener("click", (e) => {
  const panel = e.target.closest(".menu-panel.portaled");
  if (!panel) return;
  const btn = e.target.closest("button");
  if (!btn) return;
  const section = btn.dataset.section;
  const index = parseInt(btn.dataset.index, 10);
  if (panel.classList.contains("wh-menu-panel")) {
    closeAllWhMenus();
    runWhRowAction(section, index, btn);
  } else {
    closeAllOcMenus();
    runOcRowAction(section, index, btn);
  }
}, true);

function handleWarehouseClick(e) {
  const row = e.target.closest("tr[data-section]");
  const section = row ? row.dataset.section : e.currentTarget.id.replace("wh-body-", "");
  const btn = e.target.closest("button");
  if (btn) {
    const index = parseInt(btn.dataset.index, 10);
    if (btn.classList.contains("wh-menu-btn")) {
      e.stopPropagation();
      toggleRowMenu(btn, "wh-menu-panel", closeAllWhMenus);
      return;
    }
    closeAllWhMenus();
    runWhRowAction(section, index, btn);
    return;
  }
  const link = e.target.closest(".alt-link");
  if (link) {
    // Индекс берём из самой строки, а НЕ из её позиции среди отрисованных:
    // при включённом фильтре по модели на экране лишь часть склада, и позиция
    // указывала бы на чужую позицию массива.
    const tr = link.closest("tr");
    const index = parseInt(tr.dataset.index, 10);
    const item = warehouse[section][index];
    if (!item) return;
    jumpToOneC(item.code, section, index);
    return;
  }
  const nameTd = e.target.closest("td.name");
  if (nameTd) {
    if (String(window.getSelection())) return;      // идёт выделение текста — не переключаем
    const tr = nameTd.closest("tr");
    toggleRowPick(selectedWH, section, tr.dataset.key, tr);
  }
}
document.getElementById("wh-body-parts").addEventListener("click", handleWarehouseClick);
document.getElementById("wh-body-consumables").addEventListener("click", handleWarehouseClick);
document.addEventListener("click", (e) => {
  // Меню лежит в <body>, поэтому клик внутри него не считается «мимо».
  if (!e.target.closest(".wh-menu-wrap") && !e.target.closest(".wh-menu-panel")) closeAllWhMenus();
  if (!e.target.closest(".oc-menu-wrap") && !e.target.closest(".oc-menu-panel")) closeAllOcMenus();
});

/* ==================== Переключатель модели (3 положения) ====================
   Общие функции для .model-switch: читаем/ставим значение и подсвечиваем
   активную кнопку. Используется и в модалке редактирования склада, и в
   панели добавления. */
function setModelSwitch(el, value) {
  const v = value || "";
  el.dataset.value = v;
  el.querySelectorAll(".ms-opt").forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.model || "") === v);
  });
}
function getModelSwitch(el) { return el.dataset.value || ""; }
// Переключатель с data-multi="2": можно отметить до двух моделей (порядок нажатия:
// первая — основная модель, вторая — model2); повторное нажатие снимает отметку.
function setModelsSwitch(el, models) {
  const list = (models || []).filter(Boolean).slice(0, 2);
  el.dataset.value = list.join("|");
  el.querySelectorAll(".ms-opt").forEach((btn) => {
    btn.classList.toggle("active", list.indexOf(btn.dataset.model || "") !== -1);
  });
}
// Отмеченные модели в постоянном порядке (4.0, 5.0, 9Bot): ни одна не «основная».
function getModelsSwitch(el) { return modelsOf({ model: (el.dataset.value || "").split("|")[0], model2: (el.dataset.value || "").split("|")[1] }); }
function rawModelsSwitch(el) { return (el.dataset.value || "").split("|").filter(Boolean); }
document.querySelectorAll(".model-switch").forEach((el) => {
  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".ms-opt");
    if (!btn) return;
    e.preventDefault();
    const m = btn.dataset.model || "";
    if (el.dataset.multi) {
      let list = rawModelsSwitch(el);
      if (list.indexOf(m) !== -1) list = list.filter((x) => x !== m);
      else { list.push(m); if (list.length > 2) list.shift(); }
      setModelsSwitch(el, list);
    } else setModelSwitch(el, m);
  });
  if (el.dataset.multi) setModelsSwitch(el, []); else setModelSwitch(el, "");
});

/* --- Редактирование позиции склада (код/название/кол-во) --- */
let whEditingTarget = null;
function openWhEdit(section, index) {
  whEditingTarget = { section, index };
  const item = warehouse[section][index];
  document.getElementById("whEditSection").value = section;
  document.getElementById("whEditCode").value = item.code;
  document.getElementById("whEditName").value = item.name;
  document.getElementById("whEditQty").value = item.qty || 0;
  setModelsSwitch(document.getElementById("whEditModel"), modelsOf(item));
  setModelSwitch(document.getElementById("whEditCat"), whCatOf(item));
  const box = document.getElementById("whEditSuggestBox");
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
  openModal("whEditOverlay");
}
function closeWhEdit() {
  whEditingTarget = null;
  const box = document.getElementById("whEditSuggestBox");
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
  closeModal("whEditOverlay");
}
document.getElementById("whEditCancel").addEventListener("click", closeWhEdit);
document.getElementById("whEditOverlay").addEventListener("click", (e) => {
  if (e.target.id === "whEditOverlay") closeWhEdit();
});
document.getElementById("whEditSave").addEventListener("click", () => {
  if (!whEditingTarget) return;
  const { section, index } = whEditingTarget;
  const newSection = document.getElementById("whEditSection").value;
  const code = document.getElementById("whEditCode").value.trim();
  const name = document.getElementById("whEditName").value.trim();
  let qty = parseInt(document.getElementById("whEditQty").value, 10);
  if (isNaN(qty) || qty < 0) qty = 0;
  const [model = "", model2 = ""] = getModelsSwitch(document.getElementById("whEditModel"));
  if (!name) { closeWhEdit(); return; }
  const sectionChanged = newSection !== section;

  // проверка дублей по коду (у кодов-заглушек 1С одинаковый код у разных позиций — можно)
  if (code && !isAmbiguousCode(code)) {
    const clash = warehouse[newSection].some((it, i) => {
      if (!sectionChanged && i === index) return false;
      return it.code === code;
    });
    if (clash) {
      alert(`Позиция с кодом «${code}» уже есть на складе.`);
      return;
    }
  }

  pushWhHistory();
  const oldItem = warehouse[section][index];
  const oldKey = countKey(section, oldItem);
  const newItem = Object.assign({}, oldItem, { code, name, qty, model });
  if (model2) newItem.model2 = model2; else delete newItem.model2;
  // Код-заглушка: при переименовании запоминаем название 1С, иначе пара потеряется
  if (!newItem.ocName && name !== oldItem.name && code === oldItem.code && isAmbiguousCode(code)) {
    rebuildCrossIndexes();
    const m = oneCMatchesFor(code, oldItem);
    if (m.length) newItem.ocName = onec[m[0].section][m[0].index].name;
  }
  const cat = getModelSwitch(document.getElementById("whEditCat"));
  if (WH_CATS[cat]) newItem.cat = cat;
  const newKey = countKey(newSection, newItem);
  const wasPicked = selectedWH[section].has(oldKey);

  if (sectionChanged) {
    warehouse[section].splice(index, 1);
    warehouse[newSection].push(newItem);
  } else {
    warehouse[section][index] = newItem;
  }

  selectedWH[section].delete(oldKey);
  if (wasPicked) selectedWH[newSection].add(newKey);

  syncModelByCode(code, model, model2, [name, newItem.ocName]);   // модели едины для склада и 1С
  saveWarehouse();
  saveOneCLocalOnly();
  renderOneCAll();
  if (sectionChanged) {
    renderWarehouseAll();
    // подсветим, куда переехала позиция
    const rows = document.querySelectorAll(`#viewWarehouse tr[data-section="${newSection}"]`);
    flashRow(rows[rows.length - 1]);
  } else {
    renderWarehouseSection(section);
  }
  closeWhEdit();
});

/* ==================== Переключение вкладок ==================== */
const TAB_LABELS = { consumption: "Учёт", warehouse: "Склад", onec: "1C" };
function switchTab(target) {
  // 1) Сначала — гарантированное переключение вида. Ничего, что может упасть.
  const map = {
    consumption: ["tabConsumptionBtn", "viewConsumption"],
    warehouse:   ["tabWarehouseBtn",   "viewWarehouse"],
    onec:        ["tabOneCBtn",        "viewOneC"],
  };
  if (!map[target]) target = "consumption";
  Object.keys(map).forEach((k) => {
    const [btnId, viewId] = map[k];
    const on = (k === target);
    document.getElementById(btnId).classList.toggle("active", on);
    document.getElementById(viewId).classList.toggle("active", on);
  });
  const label = document.querySelector("#modMenuBtn .brand-label");
  if (label) label.textContent = TAB_LABELS[target];
  const panel = document.getElementById("tabsMenuPanel");
  if (panel) panel.classList.remove("open");
  const modPanel = document.getElementById("modMenuPanel");
  if (modPanel) modPanel.classList.remove("open");
  const modBtn = document.getElementById("modUchetBtn");
  if (modBtn) modBtn.setAttribute("aria-expanded", "false");

  // 2) Остальное — в защищённом блоке: даже если что-то упадёт,
  //    вкладка уже переключилась и экран не «залипнет».
  try {
    showSearchBarFor(target);
    if (backTarget && target !== backTarget.dest) hideBackBtn();
    if (target === "warehouse") renderWarehouseAll();
    if (target === "onec") renderOneCAll();
    // Вкладка — в адресе (#warehouse), чтобы её можно было открыть в новой вкладке и обновить страницу на ней
    try { history.replaceState(null, "", target === "consumption" ? location.pathname + location.search : "#" + target); } catch (e) {}
    // Возврат в «Учёт» — всегда с начала списка (а не с места прокрутки «Склада»/«1С»)
    if (target === "consumption") {
      window.scrollTo(0, 0);
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
  } catch (err) {
    console.error("Ошибка при переключении вкладки:", err);
  }
}

function tabTargetFromId(id) {
  if (id === "tabWarehouseBtn") return "warehouse";
  if (id === "tabOneCBtn") return "onec";
  return "consumption";
}
// «Учёт потребления» в меню разделов раскрывает вложенный выбор: Учёт / Склад / 1С.
document.getElementById("modUchetBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const sub = document.getElementById("tabsMenuPanel");
  const open = sub.classList.toggle("open");
  e.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
});

/* ==================== Сортировка по клику на заголовок столбца ====================
   Учёт: Наименование (алфавит), Код (по первым 3 цифрам), Кол-во (числовое).
   Склад: то же + На складе / Выдано / Остаток (числовые). */
const sortState = {
  ca: { parts: { col: null, dir: null }, consumables: { col: null, dir: null } },
  wh: { parts: { col: null, dir: null }, consumables: { col: null, dir: null } },
  oc: { parts: { col: null, dir: null }, consumables: { col: null, dir: null } }
};

function codeSortValue(code) {
  const digits = (code || "").replace(/\D/g, "");
  return digits ? parseInt(digits.slice(0, 3), 10) : -1;
}
function defaultDirFor(col) {
  return (col === "name" || col === "code") ? "asc" : "desc";
}
function getSortValue(table, section, item, col) {
  if (col === "name") return item.name.toLowerCase();
  if (col === "code") return codeSortValue(item.code);
  if (table === "ca" && col === "count") return counts[countKey(section, item)] || 0;
  if ((table === "wh" || table === "oc") && col === "qty") return item.qty || 0;
  if (table === "wh" && col === "ocqty") {
    const info = oneCInfoFor(item.code, item);
    return info ? info.qty : -1;
  }
  return 0;
}
function updateSortArrows(table, section) {
  document.querySelectorAll(`.sortable[data-table="${table}"][data-section="${section}"]`).forEach((th) => {
    const col = th.dataset.col;
    const state = sortState[table][section];
    const arrow = th.querySelector(".sort-arrow");
    th.classList.toggle("sort-active", state.col === col);
    arrow.textContent = state.col === col ? (state.dir === "asc" ? "↑" : "↓") : "↕";
  });
}
/* Порядок сортировки запоминается между запусками: сама сортировка меняет
   порядок в массиве и сохраняется ЛОКАЛЬНО (на сервер не уходит, чтобы не
   дёргать синхронизацию). Но данные с сервера приходят в своём порядке и
   затирали результат — со стороны это выглядело как «сортировка не
   срабатывает». Поэтому выбор храним отдельно и переприменяем после
   каждого получения данных (см. reapplySavedSort). */
const SORT_STATE_KEY = "sklad2_sort_state_v1";
function saveSortState() {
  try { localStorage.setItem(SORT_STATE_KEY, JSON.stringify(sortState)); } catch (e) {}
}
function loadSortState() {
  try {
    const raw = localStorage.getItem(SORT_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    ["ca", "wh", "oc"].forEach((t) => {
      ["parts", "consumables"].forEach((s) => {
        if (saved[t] && saved[t][s]) sortState[t][s] = saved[t][s];
      });
    });
  } catch (e) {}
}
function applySortToList(table, section) {
  const state = sortState[table][section];
  if (!state.col) return false;
  const list = table === "ca" ? sections[section] : (table === "oc" ? onec[section] : warehouse[section]);
  if (!list) return false;
  list.sort((a, b) => {
    const va = getSortValue(table, section, a, state.col);
    const vb = getSortValue(table, section, b, state.col);
    const cmp = (typeof va === "string") ? va.localeCompare(vb, "ru") : (va - vb);
    return state.dir === "asc" ? cmp : -cmp;
  });
  return true;
}
// Переприменяет сохранённый порядок ко всем таблицам — вызывается после
// получения данных с сервера.
function reapplySavedSort() {
  ["ca", "wh", "oc"].forEach((t) => {
    ["parts", "consumables"].forEach((s) => applySortToList(t, s));
  });
  ["ca", "wh", "oc"].forEach((t) => {
    ["parts", "consumables"].forEach((s) => updateSortArrows(t, s));
  });
}
function sortTable(table, section, col) {
  if ((table === "wh" || table === "oc") && section !== "consumables") {
    // «Склад» — одна таблица: одинаково сортируем оба раздела
    const st = sortState[table].parts;
    const dir = st.col === col ? (st.dir === "asc" ? "desc" : "asc") : defaultDirFor(col);
    if (table === "wh") pushWhHistory(); else pushOcHistory();
    ["parts", "consumables"].forEach((s) => { sortState[table][s].col = col; sortState[table][s].dir = dir; applySortToList(table, s); });
    saveSortState();
    if (table === "wh") { saveWarehouseLocalOnly(); renderWarehouseAll(); }
    else { saveOneCLocalOnly(); renderOneCAll(); }
    updateSortArrows(table, "parts");
    return;
  }
  const state = sortState[table][section];
  const dir = state.col === col ? (state.dir === "asc" ? "desc" : "asc") : defaultDirFor(col);
  if (table === "ca") pushHistory();
  if (table === "wh") pushWhHistory();
  if (table === "oc") pushOcHistory();
  state.col = col;
  state.dir = dir;
  saveSortState();
  applySortToList(table, section);
  if (table === "ca") {
    persistCurrentLocalOnly();
    renderSection(section);
  } else if (table === "oc") {
    saveOneCLocalOnly();
    renderOneCSection(section);
  } else {
    saveWarehouseLocalOnly();
    renderWarehouseSection(section);
  }
  updateSortArrows(table, section);
}
document.querySelectorAll(".sortable").forEach((th) => {
  th.addEventListener("click", (e) => {
    e.stopPropagation();   // «1С» внутри заголовка «Наименование» на «Складе»
    sortTable(th.dataset.table, th.dataset.section, th.dataset.col);
  });
});

/* ==================== Поиск: панель активной вкладки видна всегда ====================
   Раньше applyCaSearch/applyWhSearch/applyOcSearch были тремя отдельными
   функциями-обёртками над runSearch(), каждая со своей подпиской на
   ввод текста. Теперь один конфиг на все три вкладки; сами функции
   applyCaSearch/applyWhSearch/applyOcSearch оставлены (их вызывают из
   других мест файла), но внутри — тонкие обёртки. */
const SEARCH_TABS = [
  { key: "ca", bodyPrefix: "body-",    getStore: () => sections },
  { key: "wh", bodyPrefix: "wh-body-", getStore: () => warehouse },
  { key: "oc", bodyPrefix: "oc-body-", getStore: () => onec },
];
const searchBars = {};
const searchInputs = {};
const applySearchFns = {};
SEARCH_TABS.forEach(({ key, bodyPrefix, getStore }) => {
  const bar = document.getElementById(key + "SearchBar");
  const input = document.getElementById(key + "SearchInput");
  searchBars[key] = bar;
  searchInputs[key] = input;
  const apply = () => runSearch(key, bodyPrefix, getStore(), nameOrCode);
  applySearchFns[key] = apply;
  input.addEventListener("input", apply);
});
/* Поиск по заявке в «Учёте» свёрнут до одной кнопки с лупой; по нажатию раскрывается вся строка,
   а когда поле пустое и фокус ушёл — снова сворачивается. */
(function () {
  const bar = document.getElementById("caSearchBar");
  const input = searchInputs.ca;
  if (!bar || !input) return;
  const mk = (id, cls) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.id = id; btn.className = "iconbtn ca-search-toggle " + cls;
    btn.title = "Поиск по заявке"; btn.setAttribute("aria-label", "Поиск по заявке");
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
    return btn;
  };
  // Лупа — в одной строке с вводом; строка поиска раскрывается под строкой ввода.
  // Если панели ввода нет (заявка только для просмотра), лупа стоит отдельно.
  const panel = document.getElementById("addPanelConsumption");
  const inRow = mk("caSearchToggle", "in-row");
  panel.insertBefore(inRow, panel.firstChild);
  panel.parentNode.insertBefore(bar, panel.nextSibling);
  const btn = inRow;
  document.body.dataset.tab = "consumption";
  document.body.classList.add("ca-search-collapsed");
  const setOpen = (o) => {
    document.body.classList.toggle("ca-search-collapsed", !o);
    if (o) setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
    try { syncStickyTopHeight(true); } catch (e) {}
  };
  btn.addEventListener("click", () => setOpen(true));
  input.addEventListener("blur", () => setTimeout(() => {
    if (!input.value && !bar.contains(document.activeElement)) setOpen(false);
  }, 250));
  window.caSearchCollapse = () => setOpen(false);
})();
function applyCaSearch() { applySearchFns.ca(); }
function applyWhSearch() { applySearchFns.wh(); }
function applyOcSearch() { applySearchFns.oc(); }

/* Панель добавления (в общей шапке) — только на «Учёте» и не в режиме
   просмотра; после смены пересчитываем распорку под шапкой. */
let currentTab = "consumption";
function updateAddPanelVisibility() {
  const panel = document.getElementById("addPanelConsumption");
  if (!panel) return;
  panel.style.display = (currentTab === "consumption" && currentDate && canEditCurrent()) ? "flex" : "none";
  document.body.classList.toggle("shift-ro", isShift() && !canEditCurrent());
  updateLayoutClasses();
  syncStickyTopHeight(true);   // раскладка могла смениться (выбрали/сняли заявку) — пересчитываем даже при фокусе в поле
}

/* Показывает строку поиска нужной вкладки, остальные прячет и очищает */
function showSearchBarFor(tab) {
  currentTab = tab;
  document.body.dataset.tab = tab;
  const map = {
    consumption: "ca",
    warehouse: "wh",
    onec: "oc",
  };
  Object.keys(map).forEach((tabName) => {
    const key = map[tabName];
    const bar = searchBars[key];
    const input = searchInputs[key];
    if (tabName === tab) {
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
      if (input.value) { input.value = ""; applySearchFns[key](); }
    }
  });
  updateAddPanelVisibility();
  updateStickySearch();
}

/* ==================== Импорт остатков из Excel в 1С ====================
   Вставляем строки из Excel (Код / Наименование / Остаток — в любом
   порядке, заголовок распознаётся и пропускается). Правила слияния:
     • позиция уже есть в 1С (по коду, а если кода нет — по названию) →
       обновляем ТОЛЬКО остаток; название, код и связь со складом/учётом
       не трогаем;
     • позиции нет в 1С → добавляем новую (модель проставится
       автоматически по метке в названии);
     • склад не изменяется вообще — импорт только в 1С. */
/* ==================== Чтение .xlsx прямо в приложении ====================
   Файл .xlsx — это ZIP с XML внутри. Нужны только два файла:
   xl/sharedStrings.xml (тексты) и xl/worksheets/sheet1.xml (ячейки).
   Распаковываем встроенным DecompressionStream («deflate-raw») — без
   сторонних библиотек, чтобы приложение осталось автономным офлайн. */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readZipEntries(buf, wanted) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // ищем End Of Central Directory с конца
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Это не похоже на файл .xlsx");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder("utf-8");
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wanted.indexOf(name) !== -1) {
      // локальный заголовок: смещение данных зависит от длин полей в нём
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + compSize);
      out[name] = (method === 0) ? raw : await inflateRaw(raw);
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return out;
}
function colToIndex(ref) {          // "AB12" -> 27 (1-based номер столбца)
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
/* Чтение таблицы .xlsx в «сетку»: массив строк, где строка — объект
   { номер_столбца: значение }. Общая часть для обоих разборов — выгрузки
   1С и простого файла склада. */
async function readXlsxGrid(file) {
  const buf = await file.arrayBuffer();
  const files = await readZipEntries(buf, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  const dec = new TextDecoder("utf-8");
  const parser = new DOMParser();
  // общие строки
  let shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const doc = parser.parseFromString(dec.decode(files["xl/sharedStrings.xml"]), "application/xml");
    shared = Array.from(doc.getElementsByTagName("si")).map((si) =>
      Array.from(si.getElementsByTagName("t")).map((t) => t.textContent).join("")
    );
  }
  if (!files["xl/worksheets/sheet1.xml"]) throw new Error("В файле не найден лист с данными.");
  const doc = parser.parseFromString(dec.decode(files["xl/worksheets/sheet1.xml"]), "application/xml");
  const rows = [];
  Array.from(doc.getElementsByTagName("row")).forEach((row) => {
    const cells = {};
    Array.from(row.getElementsByTagName("c")).forEach((cEl) => {
      const idx = colToIndex(cEl.getAttribute("r"));
      const t = cEl.getAttribute("t");
      const vEl = cEl.getElementsByTagName("v")[0];
      let val = "";
      if (t === "s") {
        val = vEl ? (shared[parseInt(vEl.textContent, 10)] || "") : "";
      } else if (t === "inlineStr") {
        const isEl = cEl.getElementsByTagName("is")[0];
        val = isEl ? Array.from(isEl.getElementsByTagName("t")).map((x) => x.textContent).join("") : "";
      } else {
        val = vEl ? vEl.textContent : "";
      }
      cells[idx] = String(val).trim();
    });
    rows.push(cells);
  });
  return rows;
}
async function parseXlsxFile(file) {
  const rows = await readXlsxGrid(file);
  // Столбцы: A(1) — Артикул, D(4) — Номенклатура, H(8) — «В наличии».
  // Именно так устроена выгрузка «Остатки и доступность товаров» из УТ 11.
  // Заголовки ищем сами, чтобы не сломаться, если 1С сдвинет колонки.
  let iCode = 1, iName = 4, iQty = 8, dataStart = 0;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const vals = rows[r];
    let foundCode = 0, foundName = 0, foundQty = 0;
    Object.keys(vals).forEach((k) => {
      const v = (vals[k] || "").toLowerCase();
      if (/артикул|^код$/.test(v)) foundCode = +k;
      else if (/номенклатур|наимен|назван/.test(v)) foundName = +k;
      else if (/в наличии|остат/.test(v)) foundQty = +k;
    });
    if (foundCode && foundName && foundQty) {
      iCode = foundCode; iName = foundName; iQty = foundQty; dataStart = r + 1; break;
    }
  }
  const out = [];
  for (let r = dataStart; r < rows.length; r++) {
    const code = (rows[r][iCode] || "").trim();
    const name = (rows[r][iName] || "").trim();
    const qtyRaw = (rows[r][iQty] || "").replace(/\s|\u00a0/g, "").replace(",", ".");
    const qty = Math.max(0, Math.round(parseFloat(qtyRaw) || 0));
    if (!name) continue;                       // пустые и служебные строки
    if (!code && /^сервисн|^склад|^итог/i.test(name)) continue;  // строка-итог по складу
    out.push({ code, name, qty });
  }
  return out;
}

// Поиск позиции 1С отдельно по коду и отдельно по названию — так импорт
// может сначала разобрать все совпадения по коду (приоритет), и только
// потом добирать оставшиеся по названию.
function findOcItemByCode(code) {
  if (!code) return null;
  const want = codeVariants(code);
  for (const section of ["parts", "consumables"]) {
    const list = onec[section];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.code && codeVariants(it.code).some((v) => want.includes(v))) {
        return { section, index: i };
      }
    }
  }
  return null;
}
function findOcItemByName(name) {
  if (!name) return null;
  const target = String(name).toLowerCase().replace(/\s+/g, " ").trim();
  for (const section of ["parts", "consumables"]) {
    const list = onec[section];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].name || "").toLowerCase().replace(/\s+/g, " ").trim() === target) {
        return { section, index: i };
      }
    }
  }
  return null;
}
function openOcImport() {
  document.getElementById("ocImportFile").value = "";
  document.getElementById("ocImportFileBest").value = "";
  ocImportFileRows = null;
  document.getElementById("ocImportFileInfo").textContent = "";
  // Показываем, что уже загружено по второму складу и когда
  const bestInfo = document.getElementById("ocImportFileBestInfo");
  if (bestStock && bestStock.rows) {
    const d = new Date(bestStock.savedAt);
    bestInfo.textContent = `Загружено ${bestStock.rows.length} позиций (${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0,5)}).`;
  } else {
    bestInfo.textContent = "";
  }
  openModal("ocImportOverlay");
}
function closeOcImport() {
  closeModal("ocImportOverlay");
}
document.getElementById("ocImportBtn").addEventListener("click", openOcImport);
document.getElementById("ocImportClose").addEventListener("click", closeOcImport);
document.getElementById("ocImportOverlay").addEventListener("click", (e) => {
  if (e.target.id === "ocImportOverlay") closeOcImport();
});
// Файл .xlsx, выбранный пользователем (если выбран — он в приоритете
// перед ручной вставкой в текстовое поле).
let ocImportFileRows = null;
document.getElementById("ocImportFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const info = document.getElementById("ocImportFileInfo");
  ocImportFileRows = null;
  if (!file) { info.textContent = ""; return; }
  info.textContent = "Читаю файл…";
  try {
    const rows = await parseXlsxFile(file);
    ocImportFileRows = rows;
    const withQty = rows.filter((r) => r.qty > 0).length;
    info.textContent = `Файл прочитан: ${rows.length} строк (с остатком — ${withQty}). Нажмите «Импортировать».`;
  } catch (err) {
    info.textContent = "Не удалось прочитать файл: " + err.message;
    alert("Не удалось прочитать файл .xlsx: " + err.message +
          "\nМожно вставить строки вручную в поле ниже.");
  }
});

// Второй склад «Бестужевская»: файл только сохраняется отдельно, в список
// 1С ничего не подмешивается. Пригодится для сравнения остатков между
// складами — обрабатываем сразу при выборе файла, кнопка не нужна.
document.getElementById("ocImportFileBest").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const info = document.getElementById("ocImportFileBestInfo");
  if (!file) { info.textContent = ""; return; }
  info.textContent = "Читаю файл…";
  try {
    const rows = await parseXlsxFile(file);
    bestStock = { savedAt: Date.now(), rows };
    saveBestStock(bestStock);
    const withQty = rows.filter((r) => r.qty > 0).length;
    info.textContent = `Сохранено: ${rows.length} позиций (с остатком — ${withQty}). Список 1С не изменён.`;
  } catch (err) {
    info.textContent = "Не удалось прочитать файл: " + err.message;
    alert("Не удалось прочитать файл .xlsx: " + err.message);
  }
});

/* ==================== Список на перемещение ====================
   Что нужно привезти со второго склада. Пополняется кнопкой «+» из окна
   сравнения; остаток на «Бестужевской» подтягивается заново при открытии,
   чтобы список не устаревал после новой выгрузки. */
/* Добавление позиции в список на перемещение из вкладки «1С»
   (кнопка 🚚 в меню строки). Остаток на «Бестужевской» подтягивается
   автоматически по коду, при отсутствии кода — по названию. */
function addOcItemToTransfer(section, index) {
  const it = onec[section][index];
  if (!it) return;
  if (isInTransfer({ code: it.code, name: it.name })) {
    alert("Эта позиция уже в списке на перемещение.");
    return;
  }
  const idx = buildBestIndex();
  let found = null;
  if (it.code) {
    for (const v of codeVariants(it.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
  }
  if (!found) {
    const n = String(it.name || "").toLowerCase().replace(/\s+/g, " ").trim();
    found = idx.byName[n] || null;
  }
  const other = found ? (found.qty || 0) : 0;
  const mine = it.qty || 0;   // остаток по 1С — это и есть моя «Ферма»

  transferList.push({ code: it.code || "", name: it.name, model: it.model || "", mine, other });
  saveTransferList();
  alert(!bestStock
    ? `«${it.name}» добавлена. Данные «Бестужевской» ещё не загружены — остаток появится после загрузки файла.`
    : `«${it.name}» добавлена в список на перемещение. На Бестужевской: ${other}.`);
}
function renderTransferList() {
  const idx = buildBestIndex();
  const summary = document.getElementById("ocTransferSummary");
  const list = document.getElementById("ocTransferList");
  // освежаем цифры по актуальной выгрузке второго склада
  transferList.forEach((t) => {
    let found = null;
    if (t.code) {
      for (const v of codeVariants(t.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
    }
    if (!found) {
      const n = String(t.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      found = idx.byName[n] || null;
    }
    t.other = found ? (found.qty || 0) : 0;
    // и свой остаток — из текущего списка 1С
    const mineItem = (t.code ? findOcItemByCode(t.code) : null) || findOcItemByName(t.name);
    if (mineItem) t.mine = onec[mineItem.section][mineItem.index].qty || 0;
  });
  // Цифры производные (считаются из 1С и Бестужевской при каждом показе), поэтому
  // здесь НЕ сохраняем: иначе простое открытие окна меняло бы данные и давало
  // ложный конфликт синхронизации. Сохранятся вместе со следующей реальной правкой.

  summary.textContent = transferList.length
    ? `Позиций в списке: ${transferList.length}.`
    : "";
  list.innerHTML = transferList.length === 0
    ? '<div class="sync-history-empty">Список пуст. Добавьте позиции кнопкой «+» в окне сравнения остатков.</div>'
    : transferList.map((t, i) => cmpCardHtml(t, i, false, true)).join("");
  Array.from(list.querySelectorAll(".cmp-add")).forEach((btn) => {
    btn.addEventListener("click", () => {
      transferList.splice(parseInt(btn.dataset.idx, 10), 1);
      saveTransferList();
      renderTransferList();
    });
  });
}
function transferAsText() {
  return "Список на перемещение (с Бестужевской)\n" + transferList.map((t) =>
    `${t.code ? t.code + " — " : ""}${t.name}: у меня ${t.mine}, там ${t.other}`
  ).join("\n");
}
document.getElementById("ocTransferBtn").addEventListener("click", () => {
  openModal("ocTransferOverlay");
  renderTransferList();
});
document.getElementById("ocTransferClose").addEventListener("click", () => {
  closeModal("ocTransferOverlay");
});
document.getElementById("ocTransferClear").addEventListener("click", () => {
  if (transferList.length === 0) return;
  if (!confirm("Очистить весь список на перемещение?")) return;
  transferList = [];
  saveTransferList();
  renderTransferList();
});
document.getElementById("ocTransferCopy").addEventListener("click", async () => {
  if (transferList.length === 0) { alert("Список пуст."); return; }
  try {
    await navigator.clipboard.writeText(transferAsText());
    alert("Список скопирован.");
  } catch (e) { alert("Не удалось скопировать."); }
});
document.getElementById("ocTransferPrint").addEventListener("click", () => {
  if (transferList.length === 0) { alert("Список пуст."); return; }
  const rows = transferList.map((t) => `<tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.code || "—")}</td>
      <td style="text-align:center">${t.mine}</td>
      <td style="text-align:center">${t.other}</td>
    </tr>`).join("");
  document.getElementById("printArea").innerHTML = `
    <h1>Список на перемещение</h1>
    <div class="print-date">С «Бестужевской» · позиций: ${transferList.length}</div>
    <table>
      <thead><tr><th>Наименование</th><th style="width:130px;">Код</th><th style="width:70px;">У меня</th><th style="width:90px;">Бестуж.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  window.print();
});

/* ==================== Сравнение остатков между складами ====================
   Берём свои позиции 1С с остатком меньше порога и ищем их на втором
   складе («Бестужевская», загружается отдельным файлом). Сопоставляем по
   коду, при отсутствии кода — по названию. */
let ocCompareRows = [];
function buildBestIndex() {
  const byCode = {}, byName = {};
  if (!bestStock || !bestStock.rows) return { byCode, byName };
  bestStock.rows.forEach((r) => {
    if (r.code) {
      codeVariants(r.code).forEach((v) => { if (!(v in byCode)) byCode[v] = r; });
    }
    const n = String(r.name || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (n && !(n in byName)) byName[n] = r;
  });
  return { byCode, byName };
}
function runOcCompare() {
  const limit = Math.max(1, parseInt(document.getElementById("ocCompareLimit").value, 10) || 40);
  const mode = document.getElementById("ocCompareMode").value;
  const sectionMode = document.getElementById("ocCompareSection").value;
  const modelMode = document.getElementById("ocCompareModel").value;
  const idx = buildBestIndex();
  const out = [];
  // По умолчанию сравниваем только «Детали»: расходники (химия, спецодежда,
  // инструмент) возить между складами обычно незачем.
  const sectionsToScan = sectionMode === "all" ? ["parts", "consumables"] : [sectionMode];
  sectionsToScan.forEach((section) => {
    onec[section].forEach((it) => {
      const mine = it.qty || 0;
      if (mine >= limit) return;
      // фильтр по модели: «Без версии» — позиции, у которых модель не задана
      if (modelMode !== "all") {
        const m = it.model || "";
        if (modelMode === "none" ? m !== "" : m !== modelMode) return;
      }
      let found = null;
      if (it.code) {
        for (const v of codeVariants(it.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
      }
      if (!found) {
        const n = String(it.name || "").toLowerCase().replace(/\s+/g, " ").trim();
        found = idx.byName[n] || null;
      }
      const other = found ? (found.qty || 0) : 0;
      // «Бестужевская > 0» — всё, что там есть в наличии.
      if (mode === "more" && !(other > 0)) return;
      out.push({ code: it.code || "", name: it.name, model: it.model || "", mine, other, missing: !found });
    });
  });
  out.sort((a, b) => (b.other - b.mine) - (a.other - a.mine));
  ocCompareRows = out;

  const summary = document.getElementById("ocCompareSummary");
  const list = document.getElementById("ocCompareList");
  if (!bestStock || !bestStock.rows) {
    summary.textContent = "Файл склада «Бестужевская» ещё не загружен — загрузите его в окне импорта.";
    list.innerHTML = "";
    return;
  }
  renderOcCompareList();
}
/* Отрисовка списка сравнения с учётом строки поиска. Вынесено отдельно,
   чтобы при вводе в поиск не пересчитывать всё сравнение заново.
   ВАЖНО: в data-idx кладём индекс в ИСХОДНОМ массиве ocCompareRows, а не
   в отфильтрованном — иначе кнопка «+» добавляла бы не ту позицию. */
function renderOcCompareList() {
  const list = document.getElementById("ocCompareList");
  const summary = document.getElementById("ocCompareSummary");
  const limit = document.getElementById("ocCompareLimit").value;
  const q = (document.getElementById("ocCompareSearch").value || "").toLowerCase().trim();
  const shown = ocCompareRows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !q ||
      String(r.name || "").toLowerCase().includes(q) ||
      String(r.code || "").toLowerCase().includes(q));

  const secName = { parts: "Детали", consumables: "Расходники", all: "все позиции" }[
    document.getElementById("ocCompareSection").value] || "";
  const mdl = document.getElementById("ocCompareModel").value;
  const mdlName = mdl === "all" ? "" : " · " + (mdl === "none" ? "без версии" : mdl);
  summary.textContent = q
    ? `Показано: ${shown.length} из ${ocCompareRows.length} (${secName}, порог < ${limit}).`
    : `${secName}${mdlName} · найдено: ${ocCompareRows.length} (порог < ${limit}, данные Бестужевской от ${new Date(bestStock.savedAt).toLocaleDateString()}).`;
  list.innerHTML = shown.length === 0
    ? '<div class="sync-history-empty">Ничего не найдено.</div>'
    : shown.map(({ r, i }) => cmpCardHtml(r, i, isInTransfer(r))).join("");
  // кнопки «+» — добавляют позицию в список на перемещение
  Array.from(list.querySelectorAll(".cmp-add")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = ocCompareRows[parseInt(btn.dataset.idx, 10)];
      if (!r || isInTransfer(r)) return;
      transferList.push({ code: r.code, name: r.name, model: r.model || "", mine: r.mine, other: r.other });
      saveTransferList();
      btn.textContent = "✓";
      btn.classList.add("added");
    });
  });
}
/* Карточка позиции в сравнении/перемещении:
     код слева сверху · модель справа сверху
     название по центру
     снизу два блока с остатками (Ферма / Бестужевская) и кнопка действия */
function cmpCardHtml(r, idx, added, removeMode) {
  return `<div class="cmp-card">
    <div class="cmp-top">
      <span class="cmp-code">${r.code ? escapeHtml(r.code) : "—"}</span>
      <span class="cmp-model">${r.model ? escapeHtml(r.model) : ""}</span>
    </div>
    <div class="cmp-name">${escapeHtml(r.name)}</div>
    <div class="cmp-bottom">
      <div class="cmp-cell">
        <div class="cmp-cell-label">Ферма</div>
        <div class="cmp-cell-val">${r.mine}</div>
      </div>
      <div class="cmp-cell">
        <div class="cmp-cell-label">Бестуж.</div>
        <div class="cmp-cell-val">${r.other}${r.missing ? " *" : ""}</div>
      </div>
      ${removeMode
        ? `<button class="cmp-add danger" data-idx="${idx}" title="Убрать из списка">✕</button>`
        : `<button class="cmp-add${added ? " added" : ""}" data-idx="${idx}" title="Добавить в список на перемещение">${added ? "✓" : "+"}</button>`}
    </div>
  </div>`;
}
function isInTransfer(r) {
  return transferList.some((t) =>
    (r.code && t.code === r.code) || (!r.code && !t.code && t.name === r.name)
  );
}
function ocCompareAsText() {
  const limit = document.getElementById("ocCompareLimit").value;
  const head = `Сравнение остатков (порог < ${limit})\nМоё / Бестужевская\n`;
  return head + ocCompareRows.map((r) =>
    `${r.code ? r.code + " — " : ""}${r.name}: ${r.mine} / ${r.other}${r.missing ? " (нет в выгрузке)" : ""}`
  ).join("\n");
}
document.getElementById("ocCompareBtn").addEventListener("click", () => {
  document.getElementById("ocCompareSearch").value = "";
  openModal("ocCompareOverlay");
  runOcCompare();
});
document.getElementById("ocCompareLimit").addEventListener("change", runOcCompare);
document.getElementById("ocCompareMode").addEventListener("change", runOcCompare);
document.getElementById("ocCompareSection").addEventListener("change", runOcCompare);
document.getElementById("ocCompareModel").addEventListener("change", runOcCompare);
// Поиск по уже посчитанному списку — пересчитывать сравнение заново не нужно,
// только перерисовать с фильтром.
document.getElementById("ocCompareSearch").addEventListener("input", renderOcCompareList);
document.getElementById("ocCompareSearchClear").addEventListener("click", () => {
  const input = document.getElementById("ocCompareSearch");
  input.value = "";
  renderOcCompareList();
  input.focus();
});
document.getElementById("ocCompareX").addEventListener("click", () => {
  closeModal("ocCompareOverlay");
});
document.getElementById("ocCompareClose").addEventListener("click", () => {
  closeModal("ocCompareOverlay");
});
document.getElementById("ocCompareCopy").addEventListener("click", async () => {
  const text = ocCompareAsText();
  try {
    await navigator.clipboard.writeText(text);
    alert("Список скопирован.");
  } catch (e) {
    window.prompt("Не удалось скопировать автоматически. Скопируйте текст вручную:", text);
  }
});
document.getElementById("ocComparePrint").addEventListener("click", () => {
  const limit = document.getElementById("ocCompareLimit").value;
  const rows = ocCompareRows.map((r) => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.code || "—")}</td>
      <td style="text-align:center">${r.mine}</td>
      <td style="text-align:center">${r.other}${r.missing ? " *" : ""}</td>
    </tr>`).join("");
  document.getElementById("printArea").innerHTML = `
    <h1>Сравнение остатков</h1>
    <div class="print-date">Порог: меньше ${escapeHtml(String(limit))} · позиций: ${ocCompareRows.length}</div>
    <table>
      <thead><tr><th>Наименование</th><th style="width:130px;">Код</th><th style="width:70px;">У меня</th><th style="width:90px;">Бестуж.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  window.print();
});

document.getElementById("ocImportRun").addEventListener("click", () => {
  const rows = ocImportFileRows;
  if (!rows) { alert("Выберите файл .xlsx."); return; }
  if (rows.length === 0) { alert("Не удалось распознать ни одной строки."); return; }

  // Импорт только обновляет остаток имеющихся позиций и добавляет новые;
  // названия, модели и категории не трогает. Ключ строки — код + название:
  // в 1С бывают «коды-заглушки» (ВРЕМЕННЫЙ, Б210426…) у разных товаров, их
  // нельзя сливать. Строки с одинаковыми кодом и названием складываются.
  // Позиция 1С с тем же кодом и названием получает остаток (все дубли);
  // если код в файле у одного названия, а в списке названия другие — это
  // переименование в 1С, обновляем по коду. Без кода — только по названию.
  const normName = (n) => String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
  const codeKey = (c) => codeVariants(c).join("/");
  const merged = new Map();
  const namesByCode = new Map();
  rows.forEach((r) => {
    const ck = r.code ? codeKey(r.code) : "";
    const k = ck + "|" + normName(r.name);
    const m = merged.get(k);
    if (m) m.qty += r.qty; else merged.set(k, { code: r.code, name: r.name, qty: r.qty });
    if (ck) { if (!namesByCode.has(ck)) namesByCode.set(ck, new Set()); namesByCode.get(ck).add(normName(r.name)); }
  });
  const all = [];
  ["parts", "consumables"].forEach((section) => onec[section].forEach((it, index) => all.push({ section, index, it })));
  const claimed = new Set();
  const pending = [];
  let updated = 0, added = 0;
  merged.forEach((r) => {
    let found;
    if (r.code) {
      const want = codeVariants(r.code);
      const byCode = all.filter(({ it }) => it.code && codeVariants(it.code).some((v) => want.includes(v)));
      found = byCode.filter(({ it }) => normName(it.name) === normName(r.name));
      if (!found.length && namesByCode.get(codeKey(r.code)).size === 1 &&
          new Set(byCode.map(({ it }) => normName(it.name))).size === 1) found = byCode;
    } else {
      found = all.filter(({ it }) => !it.code && normName(it.name) === normName(r.name));
    }
    if (found.length) {
      updated++;
      found.forEach(({ section, index }) => {
        const key = section + "|" + index;
        if (claimed.has(key)) return;
        claimed.add(key);
        pending.push({ type: "update", found: { section, index }, qty: r.qty });
      });
    } else {
      added++; pending.push({ type: "add", row: r });
    }
  });
  // Позиции, которых в свежей выгрузке нет вообще: 1С не выводит их, когда
  // остаток нулевой. Раньше они оставались со старым числом — например
  // «Задний барабан (Wind 5.0)» так и висел с 20 штуками, хотя в 1С уже 0.
  const zeroed = [];
  ["parts", "consumables"].forEach((section) => {
    onec[section].forEach((it, index) => {
      const key = section + "|" + index;
      if (claimed.has(key)) return;          // позиция была в файле — уже обновлена
      if ((it.qty || 0) === 0) return;       // и так ноль, трогать нечего
      zeroed.push({ section, index, name: it.name, was: it.qty });
    });
  });

  // Страховка от неполной выгрузки: если обнулять пришлось бы больше
  // половины позиций с остатком — почти наверняка отчёт выгружен с
  // отбором (по группе, складу или товару), а не по всей номенклатуре.
  // Такой импорт молча обнулил бы почти весь список.
  const withStock = ["parts", "consumables"]
    .reduce((n, s) => n + onec[s].filter((it) => (it.qty || 0) > 0).length, 0);
  const suspicious = withStock > 0 && zeroed.length > withStock / 2;
  if (suspicious) {
    const ok = confirm(
      `⚠️ Похоже, выгрузка неполная.\n\n` +
      `В файле ${rows.length} строк, а обнулить пришлось бы ${zeroed.length} из ${withStock} позиций с остатком.\n\n` +
      `Обычно так бывает, когда отчёт выгружен с отбором — по группе, складу или конкретному товару, а не по всей номенклатуре.\n\n` +
      `Импортировать только остатки из файла, НЕ обнуляя остальные?`
    );
    if (!ok) return;
    zeroed.length = 0;      // обнуление отменяем, обновляем только то, что в файле
  }

  const zeroMsg = zeroed.length
    ? `\n\nЕщё ${zeroed.length} поз. есть в списке, но отсутствуют в файле — их остаток будет обнулён.`
    : "";
  if (!confirm(`Импорт: обновить остаток у ${updated} поз., добавить новых в 1С — ${added}.${zeroMsg}\n\nСклад не изменится. Продолжить?`)) return;

  rebuildCrossIndexes();
  pushOcHistory();
  pending.forEach((p) => {
    if (p.type === "update") {
      onec[p.found.section][p.found.index].qty = p.qty;   // только остаток
    } else {
      const item = { code: p.row.code, name: p.row.name, qty: p.row.qty };
      // Модель — как у позиции склада с этим кодом, иначе по метке в названии
      const w = p.row.code ? warehouseInfoFor(p.row.code, p.row.name) : null;
      const wi = w && warehouse[w.section][w.index];
      if (wi && wi.model) { item.model = wi.model; if (wi.model2) item.model2 = wi.model2; }
      else { const model = detectModelFromName(p.row.name); if (model) item.model = model; }
      onec.parts.push(item);
    }
  });
  zeroed.forEach((z) => { onec[z.section][z.index].qty = 0; });
  saveOneC();
  renderOneCAll();
  closeOcImport();
  alert(`Готово: обновлено ${updated}, добавлено ${added}` + (zeroed.length ? `, обнулено ${zeroed.length}` : "") + ".");
});

/* ==================== Резервная копия ====================
   Выгружает все данные приложения в один файл и восстанавливает из него.
   Файл содержит только данные приложения (без логина и пароля) — его можно
   спокойно хранить в почте или облаке. */
const BACKUP_KEYS = [
  "potreblenie_data_by_date_v3",
  "potreblenie_warehouse_v1",
  "potreblenie_onec_v1",
  "potreblenie_transfer_list_v1",
  "potreblenie_best_stock_v1",
  "potreblenie_sort_state_v1",
  "potreblenie_sync_history_v1"
];
// Имена ключей в файле копии остаются прежними (potreblenie_*) — так копии
// взаимозаменяемы со старым складом. В самом браузере ключи у склада2 свои
// (sklad2_*): склад и склад2 лежат на одном адресе github.io и иначе делили
// бы одно хранилище.
function bkToLocal(k) { return k.replace(/^potreblenie_/, "sklad2_"); }
function makeBackup() {
  const data = {};
  BACKUP_KEYS.forEach((k) => {
    const v = localStorage.getItem(bkToLocal(k));
    if (v !== null) data[k] = v;
  });
  return { app: "sklad", version: APP_VERSION, savedAt: new Date().toISOString(), data };
}
function downloadBackup() {
  const backup = makeBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const d = new Date();
  const stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sklad-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  const size = (JSON.stringify(backup).length / 1024).toFixed(0);
  setSyncStatus("ok", `Копия сохранена (${size} КБ)`);
}
async function restoreBackup(file) {
  let backup;
  try { backup = JSON.parse(await file.text()); }
  catch (e) { alert("Не удалось прочитать файл: это не резервная копия."); return; }
  if (!backup || backup.app !== "sklad" || !backup.data) {
    alert("Это не резервная копия приложения."); return;
  }
  const when = backup.savedAt ? new Date(backup.savedAt).toLocaleString() : "неизвестно когда";
  if (!confirm(`Восстановить данные из копии от ${when}?\n\nВСЕ текущие данные на этом устройстве будут заменены.`)) return;
  Object.keys(backup.data).forEach((k) => {
    if (BACKUP_KEYS.indexOf(k) === -1) return;   // чужие ключи не трогаем
    try { localStorage.setItem(bkToLocal(k), backup.data[k]); } catch (e) {}
  });
  try { localStorage.setItem(RESTORED_KEY, "1"); } catch (e) {}   // первый обмен спросит, а не заберёт данные сервера молча
  alert("Данные восстановлены. Приложение перезагрузится.");
  location.reload();
}
document.getElementById("backupSaveBtn").addEventListener("click", downloadBackup);
document.getElementById("backupLoadBtn").addEventListener("click", () => {
  document.getElementById("backupFileInput").click();
});
document.getElementById("backupFileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) restoreBackup(file);
  e.target.value = "";
});

/* ==================== ВКЛАДКА 1C: справочник номенклатуры ====================
   Только код + наименование. Отдельное хранилище, не связано со складом. */
const ONEC_KEY = "sklad2_onec_v1";

function loadOneC() {
  // Нет данных на устройстве — пусто: 1С приходит с сервера при первом обмене.
  try {
    const parsed = JSON.parse(localStorage.getItem(ONEC_KEY));
    if (parsed && Array.isArray(parsed.parts) && Array.isArray(parsed.consumables)) {
      ["parts", "consumables"].forEach((sec) => {
        parsed[sec].forEach((it) => { if (typeof it.qty !== "number") it.qty = 0; });
      });
      return parsed;
    }
  } catch (e) {}
  return { parts: [], consumables: [] };
}
function saveOneC() {
  try { localStorage.setItem(ONEC_KEY, JSON.stringify(onec)); } catch (e) {}
  scheduleSync();
}
// Локально, без синхронизации — та же логика, что у saveWarehouseLocalOnly.
function saveOneCLocalOnly() {
  try { localStorage.setItem(ONEC_KEY, JSON.stringify(onec)); } catch (e) {}
}
let onec = loadOneC();

/* ==================== Одноразовая простановка моделей ====================
   Ищем в названиях метку версии (wind/ygw 5.0 или 4.0) и проставляем поле
   model. На СКЛАДЕ метку из названия дополнительно вырезаем (она переехала
   в отдельное поле), в 1С — оставляем как есть, только проставляем модель.
   Важно: «wind 25» и подобное НЕ трогаем — это не версия 4.0/5.0, там
   модель остаётся пустой (дефолт «без версии»).
   Выполняется один раз, факт запуска помечаем в localStorage. */
/* ==================== Автоопределение модели по названию ====================
   Метки версии в названиях: «wind/ygw 5.0», «wind/ygw 25» и просто «(25)»
   в скобках → YGW 5.0; «wind/ygw 4.0» → YGW 4.0. Где метки нет — модель
   пустая (без версии). Голое «25» вне скобок НЕ считается меткой, иначе
   ловились бы размеры вроде «Винт M6x25».
   Используется и при автопростановке, и при добавлении новых позиций
   (в т.ч. при импорте остатков из Excel). */
const MODEL_TAG_RE = /[\(\[]\s*25\s*[\)\]]|[\(\[]?\s*(?:wind|ygw)\s*(25|[45][.,]0)\s*[\)\]]?/i;
const BOT_TAG_RE = /\b9\s*[-]?\s*bot\b|ninebot|найнбот/i;
function detectModelFromName(name) {
  // 9Bot определяем отдельно — метка не по шаблону wind/ygw
  if (BOT_TAG_RE.test(name || "")) return "9Bot";
  const m = MODEL_TAG_RE.exec(name || "");
  if (!m) return "";
  if (!m[1]) return "YGW 5.0";           // сработала ветка «(25)» без слова wind/ygw
  const tag = m[1].replace(",", ".");
  if (tag === "25" || tag === "5.0") return "YGW 5.0";
  if (tag === "4.0") return "YGW 4.0";
  return "";
}
function stripModelTag(name) {
  return (name || "").replace(MODEL_TAG_RE, "").replace(/\s{2,}/g, " ").trim().replace(/[\s\-–—]+$/, "");
}
function runModelMigrationOnce() {
  // Проходим при каждом запуске и после получения данных с сервера:
  // иначе синхронизация привозила старые названия с метками обратно и
  // затирала результат разовой миграции.
  // Трогаем только позиции, у которых поле model ещё НИ РАЗУ не задавалось
  // (undefined) — явно выбранное «без версии» (пустая строка) не перетираем.
  let touched = false;
  ["parts", "consumables"].forEach((section) => {
    warehouse[section].forEach((it) => {
      const model = detectModelFromName(it.name);
      if (model && it.model === undefined) { it.model = model; touched = true; }
      // Метку из названия на СКЛАДЕ убираем всегда — она живёт в поле model
      const cleaned = stripModelTag(it.name);
      if (cleaned && cleaned !== it.name) { it.name = cleaned; touched = true; }
    });
    onec[section].forEach((it) => {
      const model = detectModelFromName(it.name);
      if (model && it.model === undefined) { it.model = model; touched = true; } // название в 1С не чистим
    });
  });
  if (touched) {
    try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
    try { localStorage.setItem(ONEC_KEY, JSON.stringify(onec)); } catch (e) {}
  }
  return touched;
}
const migrationTouchedAtStartup = runModelMigrationOnce();

const selectedOC = { parts: new Set(), consumables: new Set() };

/* ==================== Связь Склад <-> 1C по коду ====================
   Один код на складе может быть составным («A / B») — сверяем по каждой части.
   Дубли в 1C не удаляются: один код может встречаться в нескольких строках. */
function codeVariants(code) {
  return String(code || "").split("/").map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/* ==================== Ручные связки кодов Склад <-> 1C ====================
   Один и тот же товар, но артикулы в системах разные. Коды НЕ меняются —
   в каждой вкладке остаётся свой, связь учитывается только при сопоставлении.
   Чтобы добавить новую связку — допишите строку { wh: "код склада", oc: "код 1C" }. */
const CODE_LINKS = [
  { wh: "00-00002861", oc: "796" },   // Защитная пластина номера
];

const linkWhToOc = {};
const linkOcToWh = {};
CODE_LINKS.forEach((l) => {
  const w = String(l.wh).trim().toLowerCase();
  const o = String(l.oc).trim().toLowerCase();
  (linkWhToOc[w] = linkWhToOc[w] || []).push(o);
  (linkOcToWh[o] = linkOcToWh[o] || []).push(w);
});

/* code -> [{section, index, name}] по справочнику 1C */
function buildOneCIndex() {
  const map = {};
  ["parts", "consumables"].forEach((section) => {
    onec[section].forEach((it, index) => {
      codeVariants(it.code).forEach((c) => {
        (map[c] = map[c] || []).push({ section, index, name: it.name });
      });
    });
  });
  return map;
}

/* code -> название позиции на складе */
function buildWarehouseIndex() {
  const map = {};
  ["parts", "consumables"].forEach((section) => {
    warehouse[section].forEach((it, index) => {
      codeVariants(it.code).forEach((c) => {
        (map[c] = map[c] || []).push({ name: it.name, ocName: it.ocName || "", qty: it.qty || 0, code: it.code, model: it.model || "", model2: it.model2 || "", section, index });
      });
    });
  });
  return map;
}

let oneCIndex = {};
let warehouseIndex = {};
// Коды-заглушки: в 1С под одним кодом несколько разных названий
// (ВРЕМЕННЫЙ, Б210426…). Для них связь «Склад ↔ 1С» — по коду И названию.
let ambiguousCodes = new Set();
function rebuildCrossIndexes() {
  oneCIndex = buildOneCIndex();
  warehouseIndex = buildWarehouseIndex();
  ambiguousCodes = new Set();
  Object.keys(oneCIndex).forEach((c) => {
    if (new Set(oneCIndex[c].map((m) => normItemName(m.name))).size > 1) ambiguousCodes.add(c);
  });
}
function normItemName(n) { return String(n || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function isAmbiguousCode(code) { return codeVariants(code).some((c) => ambiguousCodes.has(c)); }
// Название позиции склада, по которому ищется пара в 1С: сохранённое при «+» или своё.
function whOcName(w) { return normItemName((w && (w.ocName || w.name)) || ""); }

/* Позиции 1C, совпадающие с данным кодом склада. wh — позиция склада
   (нужна для кодов-заглушек: тогда сверяется и название). */
function oneCMatchesFor(code, wh) {
  const out = [];
  const seen = new Set();
  const lookup = (c) => {
    (oneCIndex[c] || []).forEach((m) => {
      const k = m.section + "#" + m.index;
      if (!seen.has(k)) { seen.add(k); out.push(m); }
    });
  };
  codeVariants(code).forEach((c) => {
    lookup(c);
    (linkWhToOc[c] || []).forEach(lookup);   // ручная связка
  });
  if (isAmbiguousCode(code)) {
    const want = whOcName(wh);
    return want ? out.filter((m) => normItemName(m.name) === want) : [];
  }
  return out;
}

/* Название со склада для данного кода 1C */
/* Модель — свойство самой детали, а не списка, поэтому держим её
   одинаковой на «Складе» и в «1С». Меняешь в одном месте — меняется в
   обоих; сопоставляем по коду. */
// model2 === undefined — вторую модель не трогаем.
// names — названия этой позиции (склад: своё и 1С; 1С: своё): для кодов-заглушек
// модель меняется только у позиций с этими названиями, а не у всех с тем же кодом.
function syncModelByCode(code, model, model2, names) {
  if (!code) return 0;
  const want = codeVariants(code);
  rebuildCrossIndexes();
  const only = isAmbiguousCode(code) && names ? new Set(names.filter(Boolean).map(normItemName)) : null;
  let changed = 0;
  [["warehouse", warehouse], ["onec", onec]].forEach(([kind, store]) => {
    ["parts", "consumables"].forEach((section) => {
      store[section].forEach((it) => {
        if (!it.code) return;
        if (!codeVariants(it.code).some((v) => want.includes(v))) return;
        if (only && !only.has(normItemName(it.name)) && !(kind === "warehouse" && it.ocName && only.has(normItemName(it.ocName)))) return;
        let ch = false;
        if ((it.model || "") !== (model || "")) { it.model = model; ch = true; }
        if (model2 !== undefined && (it.model2 || "") !== (model2 || "")) {
          if (model2) it.model2 = model2; else delete it.model2;
          ch = true;
        }
        if (ch) changed++;
      });
    });
  });
  return changed;
}
/* Позиция склада для кода 1С. name — название позиции 1С: для кодов-заглушек
   (и если на складе несколько позиций с этим кодом) сверяется и оно. */
function warehouseInfoFor(code, name) {
  const pick = (list) => {
    if (!list || !list.length) return null;
    if (isAmbiguousCode(code) || list.length > 1) {
      if (name === undefined) return isAmbiguousCode(code) ? null : list[0];
      const want = normItemName(name);
      return list.find((w) => whOcName(w) === want || normItemName(w.name) === want) || (isAmbiguousCode(code) ? null : list[0]);
    }
    return list[0];
  };
  for (const c of codeVariants(code)) {
    const hit = pick(warehouseIndex[c]);
    if (hit) return hit;
    const linked = linkOcToWh[c] || [];
    for (const w of linked) {
      const h = pick(warehouseIndex[w]);
      if (h) return h;
    }
  }
  return null;
}

/* Первая позиция 1C, связанная с данным кодом склада */
function oneCInfoFor(code, wh) {
  const m = oneCMatchesFor(code, wh);
  if (m.length === 0) return null;
  const item = onec[m[0].section][m[0].index];
  return item ? { name: item.name, code: item.code, qty: item.qty || 0 } : null;
}

/* Вторая строка в ячейке наименования: код другой системы (если отличается) + название */
function altNameHtml(selfCode, info, clickable) {
  if (!info) return "";
  const a = codeVariants(selfCode).join("/");
  const b = codeVariants(info.code).join("/");
  const codePart = (a === b) ? "" : `<span class="alt-code">${escapeHtml(info.code)}</span> `;
  const cls = "alt-name" + (clickable ? " alt-link" : "");
  // Зелёный дубль названия печатаем сокращённо — только первое слово и
  // многоточие, чтобы не раздувать строку. Полное название остаётся в
  // подсказке (title), переход по клику между вкладками не меняется.
  const full = info.name || "";
  const firstWord = full.split(/\s+/)[0] || "";
  const short = (full.trim() === firstWord) ? firstWord : firstWord + "…";
  return `<div class="${cls}" title="${escapeHtml(full)}">${codePart}${escapeHtml(short)}</div>`;
}

/* Прокрутка к строке с учётом закреплённой шапки.
   scrollIntoView({block:"center"}) не годится: на телефоне он центрирует по
   ВИДИМОЙ области (при открытой клавиатуре она низкая), и строка уезжала под
   шапку — особенно после того, как в шапку добавилась панель добавления.
   Здесь строка ставится по центру свободной полосы НИЖЕ шапки. */
function scrollRowIntoView(tr) {
  if (!tr || !tr.getBoundingClientRect) return;
  const head = document.getElementById("stickyTop");
  const top = head ? Math.max(0, head.getBoundingClientRect().bottom) : 0;
  const vv = window.visualViewport;
  const vh = (vv && vv.height) || window.innerHeight;
  const free = Math.max(60, vh - top);            // сколько видно под шапкой
  const r = tr.getBoundingClientRect();
  const pad = Math.max(0, (free - r.height) / 2); // центр этой полосы
  const y = window.pageYOffset + r.top - top - pad;
  window.scrollTo(0, Math.max(0, y));
}

/* Подсветить строки и прокрутить к первой из них */
function highlightRows(rows) {
  document.querySelectorAll(".row-flash").forEach((el) => el.classList.remove("row-flash"));
  let first = null;
  rows.forEach((tr) => { if (tr && !first) first = tr; });
  scrollRowIntoView(first);
  // ВАЖНО: подсветку ставим следующим тактом. Иначе клик, которым вызвана
  // сама операция (например ↶), долетит до общего обработчика документа
  // и тут же снимет её.
  setTimeout(() => {
    rows.forEach((tr) => { if (tr) tr.classList.add("row-flash"); });
  }, 0);
}

/* Кнопка возврата: помнит, из какой позиции склада был переход */
let backTarget = null;   // { tab, section, index, dest }
const backBtn = document.getElementById("backBtn");
const bodyPrefix = { warehouse: "wh-body-", onec: "oc-body-" };

function showBackBtn(tab, section, index, dest) {
  backTarget = { tab, section, index, dest };
  backBtn.classList.add("show");
}
function hideBackBtn() {
  backTarget = null;
  backBtn.classList.remove("show");
}
backBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!backTarget) { hideBackBtn(); return; }
  const { tab, section, index } = backTarget;
  hideBackBtn();
  switchTab(tab);
  setTimeout(() => {
    const tab2 = tab === "warehouse" ? "wh" : "oc";
    highlightRows([revealRow(tab2, section, index)]);
  }, 60);
});

/* Показывает строку, даже если её прячет фильтр вкладки: тогда фильтр
   сбрасывается на «все» и таблица перерисовывается. Иначе переход по ссылке
   выглядел бы как «ничего не произошло» — позиция есть, но она отфильтрована. */
function revealRow(tab, section, index) {
  const tbodyId = (tab === "wh" ? "wh-body-" : "oc-body-") + section;
  let tr = rowByDataIndex(tbodyId, index);
  if (tr) return tr;
  if (tab === "wh") {
    const it = warehouse[section] && warehouse[section][index];
    if (it) whFilterShowItem(it);
    renderWarehouseAll();
  } else {
    const it = onec[section] && onec[section][index];
    if (it) ocFilterShowItem(it);
    renderOneCAll();
  }
  return rowByDataIndex(tbodyId, index);
}

/* Переход «Склад» -> 1C с подсветкой */
function jumpToOneC(code, fromSection, fromIndex) {
  const matches = oneCMatchesFor(code, warehouse[fromSection] && warehouse[fromSection][fromIndex]);
  if (matches.length === 0) return;
  switchTab("onec");
  showBackBtn("warehouse", fromSection, fromIndex, "onec");
  setTimeout(() => {
    highlightRows(matches.map((m) => revealRow("oc", m.section, m.index)));
  }, 60);
}

/* Переход 1C -> «Склад» с подсветкой */
function jumpToWarehouse(code, fromSection, fromIndex) {
  const it = onec[fromSection] && onec[fromSection][fromIndex];
  const info = warehouseInfoFor(code, it ? it.name : undefined);
  if (!info) return;
  switchTab("warehouse");
  showBackBtn("onec", fromSection, fromIndex, "warehouse");
  setTimeout(() => {
    highlightRows([revealRow("wh", info.section, info.index)]);
  }, 60);
}

/* ==================== Фильтр списка 1С ====================
   Как на «Складе»: одна таблица (детали и расходники подряд), выбор по
   заголовку — Самокаты (Все / YGW 4.0 / YGW 5.0 / 9Bot / Без модели),
   Инструменты, Расходники, Остальное. Категория позиции 1С — как у связанной
   позиции склада, иначе по тем же правилам. Дополнительно: «Остаток меньше N».
   Только просмотр, выбор запоминается на устройстве. */
const OC_FILTER_KEY = "sklad2_oc_filter_v2";
// Категории «1С» = категории «Склада» + «Не на складе» (позиции, не добавленные на склад «+»).
const OC_CATS = Object.assign({}, WH_CATS, { nowh: "Не на складе" });
let ocFilter = loadOcFilter();
function loadOcFilter() {
  try {
    const f = JSON.parse(localStorage.getItem(OC_FILTER_KEY) || "null");
    if (f && OC_CATS[f.cat]) return { cat: f.cat, model: f.model || "all", stock: !!f.stock, qty: Number.isFinite(f.qty) ? f.qty : 20 };
  } catch (e) {}
  return { cat: "scooter", model: "all", stock: false, qty: 20 };
}
function saveOcFilter() {
  try { localStorage.setItem(OC_FILTER_KEY, JSON.stringify(ocFilter)); } catch (e) {}
}
function ocCatOf(item) {
  const w = item.code ? warehouseInfoFor(item.code, item.name) : null;
  const wi = w && warehouse[w.section] && warehouse[w.section][w.index];
  return wi ? whCatOf(wi) : whCatOf(item);
}
function ocMatches(item) {
  if (ocFilter.cat === "nowh") {
    if (item.code && warehouseInfoFor(item.code, item.name)) return false;
  } else if (ocCatOf(item) !== ocFilter.cat) return false;
  if (ocFilter.stock && !((item.qty || 0) < (ocFilter.qty || 0))) return false;
  if (ocFilter.cat !== "scooter" || ocFilter.model === "all") return true;
  if (ocFilter.model === "none") return ocModelsOf(item).length === 0;
  return ocModelsOf(item).indexOf(ocFilter.model) !== -1;
}
function ocFilterShowItem(item) {
  ocFilter = { cat: ocCatOf(item), model: "all", stock: false, qty: ocFilter.qty };
  saveOcFilter();
}
// Пары { item, i } — исходный индекс обязателен, иначе кнопки в строках указывали бы не на те позиции.
function ocFilteredPairs(section) {
  return onec[section].map((item, i) => ({ item, i })).filter(({ item }) => ocMatches(item));
}
function renderOneCSection() { renderOneCAll(); }
function renderOcRows(section) {
  const tbody = document.getElementById("oc-body-" + section);
  const picked = selectedOC[section];
  tbody.innerHTML = ocFilteredPairs(section).map(({ item, i }) => {
    const key = section + "::" + item.code + "::" + item.name;
    const whInfo = warehouseInfoFor(item.code, item.name);
    return `<tr data-key="${escapeHtml(key)}" data-index="${i}" data-section="${section}"${picked.has(key) ? ' class="row-picked"' : ""}>
      <td class="code">${item.code ? `<span class="code-text" data-code="${escapeHtml(item.code)}">${formatCodeDisplay(item.code)}</span>` : "—"}</td>
      <td class="name">
        <div class="main-name">${escapeHtml(item.name)}</div>
        ${altNameHtml(item.code, whInfo, true)}
        <span class="oc-side">
        <span class="wh-corner">${modelBadgesHtml(ocModelsOf(item), true)}<span class="wh-oc-qty" title="Остаток 1С">${item.qty || 0}</span></span>
        <span class="oc-btns">
        ${whInfo ? "" : `<button class="oc-addwh oc-addwh-badge" data-section="${section}" data-index="${i}" title="Добавить эту позицию на склад">+</button>`}
        <div class="menu-wrap oc-menu-wrap">
          <button class="iconbtn oc-menu-btn" data-section="${section}" data-index="${i}" title="Действия">⋮</button>
          <div class="menu-panel oc-menu-panel">
            <button class="oc-edit" data-section="${section}" data-index="${i}" title="Редактировать">✎</button>
            <button class="oc-transfer" data-section="${section}" data-index="${i}" title="В список на перемещение">🚚</button>
            <button class="oc-del danger" data-section="${section}" data-index="${i}" title="Удалить из 1C">✕</button>
          </div>
        </div>
        </span>
        </span>
      </td>
    </tr>`;
  }).join("");
}
// Одна таблица: сквозная нумерация, общий итог, пустое состояние, заголовок.
function ocAfterRender() {
  const n = document.querySelectorAll("#oc-body-parts tr[data-index], #oc-body-consumables tr[data-index]").length;
  const empty = document.getElementById("oc-body-empty");
  if (empty) empty.hidden = n > 0;
  updateOcFilterUI();
}
function renderOneCAll() {
  // Индекс код→позиция должен быть свежим ДО построения строк (переход «1С» ↔ «Склад»).
  rebuildCrossIndexes();
  renderOcRows("parts");
  renderOcRows("consumables");
  mergeSortedRows("oc", "oc-body-", onec);
  ocAfterRender();
  if (typeof applyOcSearch === "function") applyOcSearch();
}
function ocFilterTitle() {
  let t = OC_CATS[ocFilter.cat];
  if (ocFilter.cat === "scooter" && ocFilter.model !== "all") t += " · " + (ocFilter.model === "none" ? "без модели" : ocFilter.model);
  if (ocFilter.stock) t += " · < " + ocFilter.qty;
  return t;
}
function updateOcFilterUI() {
  const shown = document.querySelectorAll("#oc-body-parts tr[data-index], #oc-body-consumables tr[data-index]").length;
  const label = document.getElementById("ocFilterLabel");
  if (label) label.textContent = String(shown);
  const title = document.getElementById("ocTitle");
  if (title) title.textContent = ocFilterTitle();
  document.querySelectorAll("#ocFilterPanel [data-cat]").forEach((b) => {
    const on = b.dataset.cat === ocFilter.cat && (b.dataset.cat !== "scooter" || b.dataset.model === ocFilter.model);
    b.classList.toggle("primary", b.dataset.model ? on : b.dataset.cat === ocFilter.cat);
  });
  const st = document.getElementById("ocStockToggle");
  if (st) st.classList.toggle("primary", ocFilter.stock);
  const q = document.getElementById("ocFilterQty");
  if (q && document.activeElement !== q) q.value = ocFilter.qty;
}
document.getElementById("ocTitle").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = document.getElementById("ocFilterPanel").classList.toggle("open");
  if (open) document.getElementById("ocScooterSub").hidden = ocFilter.cat !== "scooter";
});
document.querySelectorAll("#ocFilterPanel [data-cat]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.dataset.model) {   // «Самокаты ▸» — раскрыть выбор модели
      const sub = document.getElementById("ocScooterSub");
      sub.hidden = !sub.hidden;
      return;
    }
    ocFilter.cat = btn.dataset.cat;
    ocFilter.model = btn.dataset.model;
    saveOcFilter();
    document.getElementById("ocFilterPanel").classList.remove("open");
    renderOneCAll();          // только перерисовка, без синхронизации
  });
});
// Инвентаризация — заготовка кнопки, функционал добавим позже.
document.getElementById("ocInventoryBtn").addEventListener("click", () => {
  alert("Инвентаризация — в разработке.");
});
document.getElementById("ocStockToggle").addEventListener("click", (e) => {
  e.stopPropagation();
  ocFilter.stock = !ocFilter.stock;
  saveOcFilter();
  renderOneCAll();
});
document.getElementById("ocFilterQty").addEventListener("click", (e) => e.stopPropagation());
document.getElementById("ocFilterQty").addEventListener("input", (e) => {
  ocFilter.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  saveOcFilter();
  if (ocFilter.stock) renderOneCAll();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".oc-filter-wrap")) {
    const p = document.getElementById("ocFilterPanel");
    if (p) p.classList.remove("open");
  }
});

/* --- клики по строкам 1C --- */
function closeAllOcMenus(except) { closeAllRowMenus("oc-menu-panel", except); }
/* Парная к runWhRowAction — см. комментарий там. */
function runOcRowAction(section, index, btn) {
  if (btn.classList.contains("oc-del")) {
    openConfirmOneC(section, index);
  } else if (btn.classList.contains("oc-edit")) {
    openOcEdit(section, index);
  } else if (btn.classList.contains("oc-addwh")) {
    openOcToWh(section, index);
  } else if (btn.classList.contains("oc-transfer")) {
    addOcItemToTransfer(section, index);
  }
}
function handleOneCClick(e) {
  const row = e.target.closest("tr[data-section]");
  const section = row ? row.dataset.section : e.currentTarget.id.replace("oc-body-", "");
  const btn = e.target.closest("button");
  if (btn) {
    const index = parseInt(btn.dataset.index, 10);
    if (btn.classList.contains("oc-menu-btn")) {
      e.stopPropagation();
      toggleRowMenu(btn, "oc-menu-panel", closeAllOcMenus);
      return;
    }
    closeAllOcMenus();
    runOcRowAction(section, index, btn);
    return;
  }
  const link = e.target.closest(".alt-link");
  if (link) {
    // См. комментарий в handleWarehouseClick: в «1С» фильтр по разделу/остатку
    // точно так же оставляет на экране лишь часть списка.
    const tr = link.closest("tr");
    const index = parseInt(tr.dataset.index, 10);
    const item = onec[section][index];
    if (!item) return;
    jumpToWarehouse(item.code, section, index);
    return;
  }
  const nameTd = e.target.closest("td.name");
  if (nameTd) {
    if (String(window.getSelection())) return;      // идёт выделение текста
    const tr = nameTd.closest("tr");
    const key = tr.dataset.key;
    if (selectedOC[section].has(key)) {
      selectedOC[section].delete(key);
      tr.classList.remove("row-picked");
    } else {
      selectedOC[section].add(key);
      tr.classList.add("row-picked");
    }
  }
}
document.getElementById("oc-body-parts").addEventListener("click", handleOneCClick);
document.getElementById("oc-body-consumables").addEventListener("click", handleOneCClick);

/* --- удаление позиции 1C --- */
function openConfirmOneC(section, index) {
  const item = onec[section][index];
  openConfirmDelete("onec",
    `Удалить «${item.name}» (${item.code || "без кода"}) из справочника 1C?`,
    section, index);
}

/* --- редактирование позиции 1C --- */
let ocEditingTarget = null;
function openOcEdit(section, index) {
  ocEditingTarget = { section, index };
  const item = onec[section][index];
  document.getElementById("ocEditSection").value = section;
  document.getElementById("ocEditCode").value = item.code || "";
  document.getElementById("ocEditName").value = item.name;
  setModelsSwitch(document.getElementById("ocEditModel"), ocModelsOf(item));
  setModelSwitch(document.getElementById("ocEditCat"), ocCatOf(item));
  openModal("ocEditOverlay");
}
function closeOcEdit() {
  ocEditingTarget = null;
  closeModal("ocEditOverlay");
}
document.getElementById("ocEditCancel").addEventListener("click", closeOcEdit);
document.getElementById("ocEditOverlay").addEventListener("click", (e) => {
  if (e.target.id === "ocEditOverlay") closeOcEdit();
});
document.getElementById("ocEditSave").addEventListener("click", () => {
  if (!ocEditingTarget) return;
  const { section, index } = ocEditingTarget;
  const newSection = document.getElementById("ocEditSection").value;
  const code = document.getElementById("ocEditCode").value.trim();
  const name = document.getElementById("ocEditName").value.trim();
  if (!name) { closeOcEdit(); return; }
  const sectionChanged = newSection !== section;
  // проверка дубля кода в целевом разделе
  if (code) {
    const dup = onec[newSection].some((it, i) =>
      it.code === code && !(!sectionChanged && i === index));
    if (dup) { alert("Позиция с таким кодом уже есть в этом разделе 1C."); return; }
  }
  const [model = "", model2 = ""] = getModelsSwitch(document.getElementById("ocEditModel"));
  pushOcHistory();
  // остаток не правится вручную — только импортом из 1С
  const updated = Object.assign({}, onec[section][index], { code, name, model });
  if (model2) updated.model2 = model2; else delete updated.model2;
  // Категория: у позиции 1С своя (для «Не на складе»), у связанной позиции склада — та же
  const cat = getModelSwitch(document.getElementById("ocEditCat"));
  if (WH_CATS[cat]) {
    updated.cat = cat;
    const w = warehouseInfoFor(onec[section][index].code, onec[section][index].name);
    const wi = w && warehouse[w.section][w.index];
    if (wi && wi.cat !== cat) { wi.cat = cat; saveWarehouseLocalOnly(); }
  }
  if (sectionChanged) {
    onec[section].splice(index, 1);
    onec[newSection].push(updated);
  } else {
    onec[section][index] = updated;
  }
  syncModelByCode(code, model, model2, [updated.name]);   // модель едина для склада и 1С
  saveOneC();
  saveWarehouseLocalOnly();
  renderWarehouseAll();
  if (sectionChanged) {
    renderOneCAll();
    const rows = document.querySelectorAll(`#viewOneC tr[data-section="${newSection}"]`);
    flashRow(rows[rows.length - 1]);
  } else {
    renderOneCSection(section);
  }
  closeOcEdit();
});

/* ==================== Подсказки из 1C для вкладки «Склад» ====================
   Работают как автоподсказка склада в «Учёте» (см. searchStore/renderSuggestionsFrom
   выше), но источник — справочник 1C. Искать можно и по названию, и по коду. */
function renderOneCSuggestions(box, query, onPick) {
  renderSuggestionsFrom(box, query, onPick, onec,
    "В 1C совпадений нет — можно добавить позицию вручную.");
}

/* --- модалка редактирования позиции склада --- */
const whEditCodeInput = document.getElementById("whEditCode");
const whEditNameInput = document.getElementById("whEditName");
const whEditSuggestBox = document.getElementById("whEditSuggestBox");

function pickIntoWhEdit(r) {
  whEditCodeInput.value = r.code;
  whEditNameInput.value = r.name;
}
[whEditCodeInput, whEditNameInput].forEach((input) => {
  input.addEventListener("input", () => {
    renderOneCSuggestions(whEditSuggestBox, input.value, pickIntoWhEdit);
  });
});
registerSuggestZone(whEditSuggestBox, [whEditCodeInput, whEditNameInput]);

/* ==================== Кнопка «наверх» ==================== */
const topBtn = document.getElementById("topBtn");
window.addEventListener("scroll", () => {
  topBtn.classList.toggle("show", window.scrollY > 400);
}, { passive: true });
topBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.scrollTo(0, 0);          // мгновенно, без плавной анимации
  updateStickySearch();
});

/* ==================== Навигация по совпадениям поиска ====================
   Работает одинаково для «Учёта», «Склада» и 1C: счётчик «N / всего»
   и стрелки ‹ › для быстрого перехода между найденными строками. */
const searchState = {
  ca: { rows: [], pos: -1 },
  wh: { rows: [], pos: -1 },
  oc: { rows: [], pos: -1 },
};

function updateSearchCounter(k) {
  const st = searchState[k];
  const el = document.getElementById(k + "SearchCount");
  const q = document.getElementById(k + "SearchInput").value.trim();
  if (!q) { el.textContent = ""; return; }
  if (st.rows.length === 0) { el.textContent = "нет"; return; }
  el.textContent = `${st.pos < 0 ? 1 : st.pos + 1} / ${st.rows.length}`;
}

/* Собирает совпадения по разделам таблицы: fn(item, q) -> boolean */
function runSearch(k, bodyPrefix, store, matchFn) {
  const q = document.getElementById(k + "SearchInput").value.trim().toLowerCase();
  const st = searchState[k];
  st.rows = [];
  st.pos = -1;
  ["parts", "consumables"].forEach((section) => {
    const tbody = document.getElementById(bodyPrefix + section);
    if (!tbody) return;
    // У каждой строки есть свой индекс в массиве — берём позицию по нему.
    // Раньше здесь номер строки на экране использовался как индекс в данных,
    // и приходилось отдельно пересчитывать отфильтрованные списки склада и
    // 1С. Теперь это не нужно и работает при любом порядке строк: и с
    // фильтром, и с группировкой по моделям на «Учёте». Заголовки групп
    // пропускаются сами — у них нет data-index.
    Array.prototype.forEach.call(tbody.querySelectorAll("tr[data-index]"), (tr) => {
      const item = store[tr.dataset.section || section][parseInt(tr.dataset.index, 10)];
      if (!item) return;
      const hit = q.length > 0 && matchFn(item, q);
      tr.classList.toggle("row-match", hit);
      tr.classList.remove("row-current");
      if (hit) st.rows.push(tr);
    });
  });
  updateSearchCounter(k);
}

function goToMatch(k, delta) {
  const st = searchState[k];
  if (st.rows.length === 0) return;
  st.pos = (st.pos + delta + st.rows.length) % st.rows.length;
  st.rows.forEach((tr) => tr.classList.remove("row-current"));
  const tr = st.rows[st.pos];
  tr.classList.add("row-current");
  scrollRowIntoView(tr);
  setTimeout(updateStickySearch, 350);
  updateSearchCounter(k);
}

["ca", "wh", "oc"].forEach((k) => {
  document.getElementById(k + "SearchClear").addEventListener("click", () => {
    const input = document.getElementById(k + "SearchInput");
    input.value = "";
    ({ ca: applyCaSearch, wh: applyWhSearch, oc: applyOcSearch })[k]();
    // Фокус в поле НЕ возвращаем: на телефоне это поднимало клавиатуру
    // сразу после того, как нужную строку уже нашли. Крестик только чистит
    // текст. Если фокус на поле всё-таки был — снимаем его.
    if (document.activeElement === input) input.blur();
  });
  document.getElementById(k + "SearchPrev").addEventListener("click", () => goToMatch(k, -1));
  document.getElementById(k + "SearchNext").addEventListener("click", () => goToMatch(k, 1));
  document.getElementById(k + "SearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); goToMatch(k, e.shiftKey ? -1 : 1); }
  });
});

const nameOrCode = (item, q) =>
  nameMatchesQuery(item.name, q) || (item.code && item.code.toLowerCase().includes(q));

/* ==================== Закрепление общей шапки (дата/вкладки/⋮ + поиск) ====================
   Шапка ВСЕГДА position:fixed (см. .sticky-top в style.css) — без
   переключения между sticky/fixed по прокрутке. Раньше здесь была
   пороговая логика «прилипает после прокрутки мимо точки N» — именно она
   раз за разом ломалась в установленном на «Домой» PWA (то не липла
   вообще, то наезжала на панель добавления). Теперь состояния нет вообще:
   шапка просто всегда наверху, а распорка (stickyTopPlaceholder) всегда
   резервирует под неё место в потоке, чтобы контент под ней никогда не
   перекрывался. Единственное, что делает JS — держит высоту распорки в
   актуальном состоянии (высота шапки чуть меняется между вкладками). */
const stickyTopEl = document.getElementById("stickyTop");
let stickyTopPlaceholder = null;
if (stickyTopEl) {
  stickyTopPlaceholder = document.createElement("div");
  stickyTopPlaceholder.className = "sticky-top-placeholder";
  stickyTopPlaceholder.style.marginBottom = "14px";
  stickyTopEl.parentNode.insertBefore(stickyTopPlaceholder, stickyTopEl);
}
function isTypingNow() {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}
function syncStickyTopHeight(force) {
  if (!stickyTopEl || !stickyTopPlaceholder) return;
  if (!force && isTypingNow()) return; // не пересчитываем во время анимации клавиатуры
  const tb = document.getElementById("topbar");
  stickyTopPlaceholder.style.height = (stickyTopEl.offsetHeight + (tb ? tb.offsetHeight : 0)) + "px";
}
window.addEventListener("resize", syncStickyTopHeight);
// Оставлено под старым именем, чтобы не переписывать остальные места
// файла, которые уже вызывают updateStickySearch() после смены вкладки,
// поиска и т.д. — здесь она просто пересчитывает высоту распорки.
function updateStickySearch() { syncStickyTopHeight(); }
syncStickyTopHeight();

/* iOS: после резкой прокрутки (тап по верхней кромке экрана, рывок пальцем
   от края, инерционный «бросок» списка) WebKit оставляет у position:fixed
   старую область нажатий. Визуально шапка наверху, а тапы попадают туда, где
   она была ДО прокрутки — то есть «мимо, ниже по экрану». Само чинится, только
   если оттянуть страницу вниз и отпустить.

   Лечится принудительным пересчётом раскладки самой шапки: на миг убираем
   position:fixed, синхронно читаем размер (это и заставляет браузер пересчитать
   геометрию и область нажатий) и возвращаем обратно. Всё внутри одной задачи —
   между двумя состояниями кадр не рисуется, поэтому шапка не дёргается. */
function recalibrateStickyTop() {
  if (!stickyTopEl) return;
  const prev = stickyTopEl.style.position;
  stickyTopEl.style.position = "static";
  void stickyTopEl.offsetHeight;          // синхронная раскладка — без неё браузер склеит обе строки
  stickyTopEl.style.position = prev;      // пусто = обратно к fixed из CSS
  void stickyTopEl.offsetHeight;
  syncStickyTopHeight();
}

// Дёргаем не на каждый пиксель прокрутки, а когда она остановилась, и только
// если позиция действительно менялась — лишний пересчёт раскладки на длинном
// списке стоит дорого.
let stickyCalibTimer = null;
let stickyCalibAtY = -1;
function scheduleStickyRecalibrate() {
  // Пока курсор в поле, шапку не трогаем: на iOS снятие position:fixed у
  // предка сфокусированного поля заставляет браузер «догонять» его прокруткой.
  if (isTypingNow()) return;
  if (Math.round(window.pageYOffset) === stickyCalibAtY) return;
  clearTimeout(stickyCalibTimer);
  stickyCalibTimer = setTimeout(() => {
    stickyCalibAtY = Math.round(window.pageYOffset);
    recalibrateStickyTop();
  }, 150);
}
window.addEventListener("scroll", scheduleStickyRecalibrate, { passive: true });
window.addEventListener("touchend", scheduleStickyRecalibrate, { passive: true });
window.addEventListener("pageshow", () => { stickyCalibAtY = -1; scheduleStickyRecalibrate(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { stickyCalibAtY = -1; scheduleStickyRecalibrate(); }
});
if (window.visualViewport) {
  // Клавиатура и смена масштаба тоже сдвигают видимую область.
  window.visualViewport.addEventListener("resize", () => { stickyCalibAtY = -1; scheduleStickyRecalibrate(); });
}

/* ==================== Отмена / повтор на «Складе» ==================== */
const WH_HISTORY_LIMIT = 50;

function whSnapshot() { return JSON.stringify(warehouse); }
function restoreWhSnapshot(json) {
  const before = warehouse;
  warehouse = JSON.parse(json);
  selectedWH.parts.clear();
  selectedWH.consumables.clear();
  saveWarehouse();
  renderWarehouseAll();
  const hit = findChange(before, warehouse);
  if (hit) highlightAt("wh-body-", hit.section, hit.index);
}
const whHistory = makeUndoRedo({
  snapshotFn: whSnapshot,
  restoreFn: restoreWhSnapshot,
  undoBtnId: "whUndoBtn",
  redoBtnId: "whRedoBtn",
  limit: WH_HISTORY_LIMIT
});
function pushWhHistory() { whHistory.push(); }
/* ==================== Чистое копирование и вставка ====================
   Наименование выводится двумя блочными строками, поэтому браузер
   добавляет в копию перенос строки — в поле ввода он превращается
   в лишний пробел. Здесь копия и вставка нормализуются. */
function normalizeText(str) {
  return String(str).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

document.addEventListener("copy", (e) => {
  const src = e.target;
  // из полей ввода копируем как есть (там может быть JSON переноса списков)
  if (src && (src.tagName === "INPUT" || src.tagName === "TEXTAREA")) return;
  const sel = String(window.getSelection() || "");
  if (!sel) return;
  const clean = normalizeText(sel);
  if (clean === sel) return;
  if (e.clipboardData) {
    e.clipboardData.setData("text/plain", clean);
    e.preventDefault();
  }
});

document.addEventListener("paste", (e) => {
  const el = e.target;
  if (!el || el.tagName !== "INPUT") return;          // textarea не трогаем
  if (el.type !== "text" && el.type !== "search") return;
  const data = e.clipboardData && e.clipboardData.getData("text/plain");
  if (!data) return;
  const clean = normalizeText(data);
  if (clean === data) return;
  e.preventDefault();
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + clean + el.value.slice(end);
  const pos = start + clean.length;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

/* ==================== Отмена / повтор во вкладке 1C ==================== */
function ocSnapshot() { return JSON.stringify(onec); }
function restoreOcSnapshot(json) {
  const before = onec;
  onec = JSON.parse(json);
  selectedOC.parts.clear();
  selectedOC.consumables.clear();
  saveOneC();
  renderOneCAll();
  renderWarehouseAll();   // на складе показывается «1C остаток»
  const hit = findChange(before, onec);
  if (hit) highlightAt("oc-body-", hit.section, hit.index);
}
const ocHistory = makeUndoRedo({
  snapshotFn: ocSnapshot,
  restoreFn: restoreOcSnapshot,
  undoBtnId: "ocUndoBtn",
  redoBtnId: "ocRedoBtn",
  limit: WH_HISTORY_LIMIT
});
function pushOcHistory() { ocHistory.push(); }

/* ==================== Ноль в числовых полях ====================
   При установке курсора в поле со значением 0 оно очищается,
   чтобы ввод не превращался в «0129». Если ушли, ничего не введя,
   ноль возвращается. Программная правка value не вызывает change,
   поэтому лишних сохранений не происходит. */
function isNumberField(el) {
  return el && el.tagName === "INPUT" && el.type === "number";
}
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (isNumberField(el) && el.value === "0") el.value = "";
});
document.addEventListener("focusout", (e) => {
  const el = e.target;
  if (isNumberField(el) && el.value.trim() === "") el.value = "0";
});

/* ==================== Перенос позиции 1C на склад ====================
   Кнопка «+» есть только у позиций без связи со складом. Код берётся из 1C —
   именно по нему связь и возникает; название на складе можно задать своё. */
let ocToWhTarget = null;

function openOcToWh(section, index) {
  const item = onec[section][index];
  if (!item) return;
  if (warehouseInfoFor(item.code, item.name)) {          // связь уже есть — нечего добавлять
    alert("Эта позиция уже есть на складе.");
    return;
  }
  ocToWhTarget = { section, index };
  document.getElementById("ocToWhCode").value = item.code || "";
  document.getElementById("ocToWhName").value = item.name;
  // Модель берём из позиции 1С; если там пусто — пробуем определить по
  // названию (метка wind/ygw в тексте), чтобы не выбирать руками.
  setModelsSwitch(document.getElementById("ocToWhModel"),
    modelsOf(item).length ? modelsOf(item) : [detectModelFromName(item.name)]);
  setModelSwitch(document.getElementById("ocToWhCat"), whCatOf(item));
  openModal("ocToWhOverlay");
  setTimeout(() => {
    const n = document.getElementById("ocToWhName");
    n.focus();
    const end = n.value.length; n.setSelectionRange(end, end);   // курсор в конец, без выделения всего названия
  }, 50);
}
function closeOcToWh() {
  ocToWhTarget = null;
  closeModal("ocToWhOverlay");
}
document.getElementById("ocToWhCancel").addEventListener("click", closeOcToWh);
document.getElementById("ocToWhOverlay").addEventListener("click", (e) => {
  if (e.target.id === "ocToWhOverlay") closeOcToWh();
});
document.getElementById("ocToWhSave").addEventListener("click", () => {
  if (!ocToWhTarget) return;
  const { section, index } = ocToWhTarget;
  const item = onec[section][index];
  if (!item) { closeOcToWh(); return; }
  const name = document.getElementById("ocToWhName").value.trim();
  const qty = 0;   // количество склада больше не ведётся
  if (!name) { alert("Укажите наименование для склада."); return; }
  const code = item.code || "";
  if (code && warehouseInfoFor(code, item.name)) { alert("Эта позиция уже есть на складе."); closeOcToWh(); return; }

  const [model = "", model2 = ""] = getModelsSwitch(document.getElementById("ocToWhModel"));
  pushWhHistory();
  const newWh = { code, name, qty, model };
  if (name !== item.name) newWh.ocName = item.name;   // по нему ищется пара в 1С, если склад переименован
  if (model2) newWh.model2 = model2;
  const cat = getModelSwitch(document.getElementById("ocToWhCat"));
  if (WH_CATS[cat]) { newWh.cat = cat; item.cat = cat; }
  warehouse.parts.push(newWh);
  // ту же модель проставляем и позиции в 1С, чтобы не расходились
  if (model || model2) {
    syncModelByCode(code, model, model2, [name, item.name]);
    saveOneCLocalOnly();
  }
  saveWarehouse();
  renderWarehouseAll();
  renderOneCAll();
  closeOcToWh();

  // подсветим строку 1C — у неё появилась зелёная связь со складом
  // (в фильтре «Не на складе» строка уже скрыта — фильтр не переключаем)
  const ocRow = rowByDataIndex("oc-body-" + section, index);
  if (ocRow) flashRow(ocRow);
});
document.getElementById("ocToWhName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("ocToWhSave").click();
});

/* ==================== Итоги по колонкам ====================
   Под заголовком показывается сумма по разделу. Позиции без связи
   в сумму «чужой» колонки не попадают (там прочерк, а не ноль). */
function fmtTotal(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function setTotal(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = fmtTotal(value);
}



/* ==================== Синхронизация через Supabase ====================
   Данные лежат в таблице sklad_kv: одна строка на ключ (учёт по датам, склад,
   1С, список перемещения, остатки Бестужевской). Локальная копия в localStorage
   остаётся основной — приложение работает и без связи.

   Как не потерять данные. Для каждого ключа запоминаем «метку» последней
   синхронизации: время изменения строки на сервере (updated_at) и хэш значения.
     • на сервере не менялось, у нас менялось — отправляем (запись только если
       updated_at строки всё ещё прежний, иначе это гонка и мы не затираем);
     • на сервере менялось, у нас нет — забираем;
     • менялось и там, и тут — «расхождение»: ничего не трогаем и спрашиваем
       (тап по облачку: оставить мои данные или серверные);
     • совпадают — просто запоминаем метку.
   Сервер к тому же хранит последние 20 версий каждого ключа (sklad_kv_log). */
// Сменщик синхронизирует только данные учёта по дням; остальные ключи ему сервер не отдаёт.
const SYNC_KEYS = isShift() ? ["potreblenie_data_by_date_v3"] : BACKUP_KEYS.slice(0, 5);   // в бэкапе они названы по-старому (potreblenie_*)
const SYNC_FIELD = {
  potreblenie_data_by_date_v3: "dataByDate",
  potreblenie_warehouse_v1: "warehouse",
  potreblenie_onec_v1: "onec",
  potreblenie_transfer_list_v1: "transferList",
  potreblenie_best_stock_v1: "bestStock"
};
const SYNC_LABEL = {
  potreblenie_data_by_date_v3: "Учёт",
  potreblenie_warehouse_v1: "Склад",
  potreblenie_onec_v1: "1С",
  potreblenie_transfer_list_v1: "Список перемещения",
  potreblenie_best_stock_v1: "Остатки Бестужевской"
};
const SYNC_META_KEY = "sklad2_sync_meta_v1";     // { ключ: { at: updated_at сервера, h: хэш значения } }
const SYNC_AUTO_KEY = "sklad2_sync_auto_v1";     // "0" — автосинхронизация выключена
// Ждём 3 секунды ПОСЛЕ ПОСЛЕДНЕГО действия, прежде чем отправлять правки (debounce).
// При сворачивании вкладки отправка идёт сразу (см. flushSyncNow).
const SYNC_DEBOUNCE_MS = 3000;
const LOCAL_UPDATED_AT_KEY = "sklad2_local_updated_v1";
const SYNC_LAST_SYNCED_AT_KEY = "sklad2_last_synced_v1";
// Копия восстановлена и ещё не согласована с сервером (снимается после успешного обмена).
const RESTORED_KEY = "sklad2_restored_v1";
function isRestoredPending() { return localStorage.getItem(RESTORED_KEY) === "1"; }

function isAutoSyncOff() { return localStorage.getItem(SYNC_AUTO_KEY) === "0"; }
function setAutoSyncOff(off) {
  try { localStorage.setItem(SYNC_AUTO_KEY, off ? "0" : "1"); } catch (e) {}
}
// Автоматика разрешена: выполнен вход и режим не ручной.
function isAutoSyncActive() { return isSyncConfigured() && !isAutoSyncOff(); }

/* ==================== Обмен с сервером (кнопки в окне «Синхронизация и аккаунт») ==================== */
function manualModeStatusText() {
  return isAutoSyncOff() ? "Автосинхронизация выключена." : "Синхронизация включена.";
}
function formatSyncMoment(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function manualSyncBusy(on) {
  ["manualSyncBtn", "manualPushBtn", "manualPullBtn"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.disabled = on;
  });
}
function showManualResult(text, isErr) {
  const el = document.getElementById("manualSyncInfo");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}
async function manualRun(policy, waitText) {
  manualSyncBusy(true);
  showManualResult(waitText, false);
  const r = await syncNow(policy, { manual: true });
  manualSyncBusy(false);
  showManualResult(r.text, !r.ok);
}
function manualSync() { return manualRun("safe", "Обмениваемся с сервером…"); }
function manualPush() {
  if (!confirm("Данные на сервере будут ЗАМЕНЕНЫ данными этого устройства.\n\nПродолжить?")) return;
  return manualRun("mine", "Выгружаем данные на сервер…");
}
function manualPull() {
  if (!confirm("Данные на этом устройстве будут ЗАМЕНЕНЫ данными с сервера"
      + (isDirty() ? " (в том числе неотправленные правки пропадут)" : "") + ".\n\nПродолжить?")) return;
  return manualRun("server", "Загружаем данные с сервера…");
}
document.getElementById("manualSyncBtn").addEventListener("click", manualSync);
document.getElementById("manualPushBtn").addEventListener("click", manualPush);
document.getElementById("manualPullBtn").addEventListener("click", manualPull);
function refreshAfterSyncChange() {
  bindCurrent();
  updateAddPanelVisibility();
  renderAll();
  renderTicketList();
}

let syncTimer = null;
let syncQueued = false; // изменение пришло, пока предыдущая отправка ещё была в процессе — досылаем её сразу после
let applyingRemote = false;

/* ---- Отслеживание "есть ли несохранённые на сервере изменения" ---- */
function getLocalUpdatedAt() { return Number(localStorage.getItem(LOCAL_UPDATED_AT_KEY) || 0); }
function getLastSyncedAt() { return Number(localStorage.getItem(SYNC_LAST_SYNCED_AT_KEY) || 0); }

// Вызывается при КАЖДОМ локальном изменении данных (см. scheduleSync ниже).
function markLocalChange() {
  try { localStorage.setItem(LOCAL_UPDATED_AT_KEY, String(Date.now())); } catch (e) {}
  updateDirtyIndicator();
}
// Вызывается после того, как мы точно знаем, что локальные данные и данные
// на сервере совпадают (успешный push или успешный pull). Если передан
// dataSnapshot (сами синхронизированные данные), заодно сравниваем их с
// состоянием на момент предыдущей синхронизации и пишем запись в историю.
function markSyncedTo(updatedAt, dataSnapshot, kind) {
  const t = updatedAt || Date.now();
  try {
    localStorage.setItem(SYNC_LAST_SYNCED_AT_KEY, String(t));
    // Правка, сделанная во время обмена, новее t — её «грязной» отметки не сбрасываем.
    if (getLocalUpdatedAt() <= t) localStorage.setItem(LOCAL_UPDATED_AT_KEY, String(t));
  } catch (e) {}
  if (dataSnapshot) {
    const firstSync = !loadSyncLastState();
    const lines = describeSyncAttempt(dataSnapshot);
    // Диф (не первая синхронизация) пишем в историю только если реально
    // что-то изменилось — иначе на пустом холостом сохранении появлялась бы
    // запись без единой строки.
    if (firstSync || lines.length > 0) addSyncHistoryEntry(kind || "push", lines, "ok");
    saveSyncLastState(dataSnapshot);
  }
  updateDirtyIndicator();
}
// Есть ли на этом устройстве правки, которые ещё не долетели до сервера?
function isDirty() {
  return isSyncConfigured() && getLocalUpdatedAt() > getLastSyncedAt();
}
function updateDirtyIndicator() {
  const dot = document.getElementById("syncDot");
  if (!dot) return;
  dot.classList.toggle("dirty", isDirty());
}

// Вход выполнен (или сессия сохранена на устройстве) — обмен с сервером возможен.
let syncUserOk = false;
function isSyncConfigured() { return syncUserOk; }

// Текст последней ошибки обмена. Нужен, чтобы окно обмена показало ПРИЧИНУ,
// а не только восклицательный знак на облачке.
let lastSyncErrorText = "";
function setSyncStatus(state, text) {
  if (state === "err") lastSyncErrorText = text || "";
  else if (state === "ok") lastSyncErrorText = "";
  const dot = document.getElementById("syncDot");
  const line = document.getElementById("syncStatusLine");
  if (dot) {
    dot.classList.toggle("err", state === "err" || state === "off");
    dot.classList.toggle("busy", state === "syncing");
  }
  if (line) {
    line.textContent = text || "";
    line.classList.toggle("err", state === "err");
  }
}

function buildSyncPayload() {
  return {
    updatedAt: Date.now(),
    dataByDate,
    warehouse,
    onec,
    currentDate
  };
}

/* ==================== История сохранений ====================
   Отдельный локальный журнал (не уходит на сервер): при каждой успешной
   отправке на сервер или загрузке с сервера сравниваем новые данные с
   теми, что были на момент предыдущей синхронизации, и запоминаем время
   + краткое описание того, что изменилось (какие позиции добавлены,
   удалены, у каких изменилось количество). Хранится только на этом
   устройстве и нужна, чтобы можно было понять, что и когда сохранилось. */
const SYNC_LAST_STATE_KEY = "sklad2_sync_laststate_v1";
const SYNC_HISTORY_KEY = "sklad2_sync_history_v1";
const SYNC_HISTORY_LIMIT = 40;

function loadSyncLastState() {
  try {
    const raw = localStorage.getItem(SYNC_LAST_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveSyncLastState(data) {
  try {
    localStorage.setItem(SYNC_LAST_STATE_KEY, JSON.stringify({
      dataByDate: data.dataByDate, warehouse: data.warehouse, onec: data.onec
    }));
  } catch (e) {}
}
function loadSyncHistory() {
  try {
    const raw = localStorage.getItem(SYNC_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveSyncHistoryList() {
  try { localStorage.setItem(SYNC_HISTORY_KEY, JSON.stringify(syncHistory)); } catch (e) {}
}
let syncHistory = loadSyncHistory();

function addSyncHistoryEntry(kind, lines, status) {
  syncHistory.unshift({ time: Date.now(), kind, lines, status: status || "ok", by: MY_LOGIN || "" });
  if (syncHistory.length > SYNC_HISTORY_LIMIT) syncHistory.length = SYNC_HISTORY_LIMIT;
  saveSyncHistoryList();
  renderSyncHistory();
}
// Строки-описание того, что изменилось — сравнивает dataSnapshot с
// последним ИЗВЕСТНО-СОХРАНЁННЫМ состоянием. Общая часть для успешной
// записи в историю (markSyncedTo) и для неудачной попытки (logSyncFailure) —
// в обоих случаях интересно "что именно не долетело/долетело".
function describeSyncAttempt(dataSnapshot) {
  const prev = loadSyncLastState();
  if (!prev) return ["Первая синхронизация — сохранено текущее состояние"];
  return buildChangeSummary(prev, dataSnapshot);
}
// Неудачная отправка/загрузка — запись в истории с красной точкой; данные
// остаются «грязными», следующая попытка отправит их снова.
function logSyncFailure(kind, dataSnapshot, errorMessage) {
  const lines = dataSnapshot ? describeSyncAttempt(dataSnapshot) : [];
  lines.push("Ошибка: " + errorMessage);
  addSyncHistoryEntry(kind, lines, "failed");
}
// Ключ позиции для сравнения "было/стало" — так же, как countKey: по коду,
// если он есть, иначе по названию.
function itemDiffKey(item) {
  return item.code ? ("code::" + item.code) : ("name::" + item.name);
}
function labelItem(item) {
  return item.code ? (item.name + " (" + item.code + ")") : item.name;
}
// Сравнивает два списка позиций (например warehouse.parts до/после) и
// возвращает добавленные / удалённые / те, у кого изменилось количество.
function diffItemList(oldList, newList, qtyOf) {
  const oldMap = new Map((oldList || []).map((it) => [itemDiffKey(it), it]));
  const newMap = new Map((newList || []).map((it) => [itemDiffKey(it), it]));
  const added = [], removed = [], changed = [];
  newMap.forEach((item, key) => { if (!oldMap.has(key)) added.push(item); });
  oldMap.forEach((item, key) => { if (!newMap.has(key)) removed.push(item); });
  if (qtyOf) {
    newMap.forEach((item, key) => {
      const oldItem = oldMap.get(key);
      if (!oldItem) return;
      const a = qtyOf(oldItem), b = qtyOf(item);
      if (a !== b) changed.push({ item, from: a, to: b });
    });
  }
  return { added, removed, changed };
}
// Диф для «Склада» и «1С» — там количество лежит прямо в самой позиции (qty).
function diffStore(oldStore, newStore) {
  const lines = [];
  ["parts", "consumables"].forEach((sec) => {
    const oldList = oldStore ? oldStore[sec] : [];
    const newList = newStore ? newStore[sec] : [];
    const { added, removed, changed } = diffItemList(oldList, newList, (it) => it.qty);
    added.forEach((it) => lines.push("+ " + labelItem(it) + " (" + it.qty + ")"));
    removed.forEach((it) => lines.push("− " + labelItem(it)));
    changed.forEach((c) => lines.push("~ " + labelItem(c.item) + "  " + c.from + " → " + c.to));
  });
  return lines;
}
// Диф для одного дня «Учёта» — там количество лежит отдельно, в counts,
// под ключом countKey(section, item).
function diffDateEntry(oldEntry, newEntry) {
  const lines = [];
  const oldCounts = (oldEntry && oldEntry.counts) || {};
  const newCounts = (newEntry && newEntry.counts) || {};
  ["parts", "consumables"].forEach((sec) => {
    const oldList = (oldEntry && oldEntry.sections && oldEntry.sections[sec]) || [];
    const newList = (newEntry && newEntry.sections && newEntry.sections[sec]) || [];
    const { added, removed } = diffItemList(oldList, newList, null);
    added.forEach((it) => lines.push("+ " + labelItem(it) + " (" + (newCounts[countKey(sec, it)] || 0) + ")"));
    removed.forEach((it) => lines.push("− " + labelItem(it)));
    const oldMap = new Map(oldList.map((it) => [itemDiffKey(it), it]));
    newList.forEach((it) => {
      const key = itemDiffKey(it);
      const oldItem = oldMap.get(key);
      if (!oldItem) return;
      const a = oldCounts[countKey(sec, oldItem)] || 0;
      const b = newCounts[countKey(sec, it)] || 0;
      if (a !== b) lines.push("~ " + labelItem(it) + "  " + a + " → " + b);
    });
  });
  return lines;
}
// Диф по всем датам «Учёта» — показываем не более 5 дат в одной записи истории.
function diffDataByDate(oldData, newData) {
  const lines = [];
  const oldD = oldData || {};
  const newD = newData || {};
  const dates = Array.from(new Set([...Object.keys(oldD), ...Object.keys(newD)])).sort();
  let shown = 0, skipped = 0;
  dates.forEach((date) => {
    const dLines = diffDateEntry(oldD[date], newD[date]);
    if (dLines.length === 0) return;
    if (shown >= 5) { skipped++; return; }
    lines.push("Учёт за " + formatShort(date) + ":");
    dLines.forEach((l) => lines.push("  " + l));
    shown++;
  });
  if (skipped > 0) lines.push("…и ещё изменения за " + skipped + " дат(у/ы)");
  return lines;
}
function buildChangeSummary(oldSnap, newSnap) {
  const lines = [];
  const caLines = diffDataByDate(oldSnap && oldSnap.dataByDate, newSnap.dataByDate);
  lines.push(...caLines);
  const whLines = diffStore(oldSnap && oldSnap.warehouse, newSnap.warehouse);
  if (whLines.length) { lines.push("Склад:"); whLines.forEach((l) => lines.push("  " + l)); }
  const ocLines = diffStore(oldSnap && oldSnap.onec, newSnap.onec);
  if (ocLines.length) { lines.push("1С:"); ocLines.forEach((l) => lines.push("  " + l)); }
  return lines;
}
function formatHistoryTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
// Фильтр истории по действию: "+" добавление, "−" удаление, "~" изменение количества, "" — всё.
// Оставляем только строки этого действия и заголовки («Учёт за 20.10:», «Склад:»), под которыми они есть.
let syncHistoryFilter = "";
function filterHistoryLines(lines, f) {
  const out = [];
  let head = null;
  (lines || []).forEach((l) => {
    const t = l.trim();
    if (/^[+−~] /.test(t)) {
      if (t[0] !== f) return;
      if (head !== null) { out.push(head); head = null; }
      out.push(l);
    } else if (!t.startsWith("…")) head = l;
  });
  return out;
}
function renderSyncHistory() {
  const box = document.getElementById("syncHistoryList");
  if (!box) return;
  if (syncHistory.length === 0) {
    box.innerHTML = "<div class=\"sync-history-empty\">Пока нет записей — появятся после первого сохранения.</div>";
    return;
  }
  const f = syncHistoryFilter;
  const list = f ? syncHistory.map((e) => Object.assign({}, e, { lines: filterHistoryLines(e.lines, f) })).filter((e) => e.lines.length) : syncHistory;
  if (!list.length) { box.innerHTML = "<div class=\"sync-history-empty\">Таких действий в истории нет.</div>"; return; }
  box.innerHTML = list.map((entry) => {
    const isLocal = entry.kind === "local";
    const failed = entry.status === "failed";
    const skipped = entry.status === "skipped";
    const kindLabel = isLocal
      ? "✎ сохранено на устройстве"
      : failed
        ? (entry.kind === "pull" ? "⚠ не удалось загрузить" : "⚠ не удалось сохранить")
        : skipped
          ? "⊘ пропущено (данные защищены)"
          : (entry.kind === "pull" ? "⇩ загружено с сервера" : "⇧ сохранено на сервер");
    const body = entry.lines && entry.lines.length
      ? entry.lines.map((l) => escapeHtml(l)).join("\n")
      : "(первая запись — состояние на момент подключения синхронизации)";
    // Маленькая точка в углу записи: зелёная — сохранилось, красная — не
    // долетело (данные при этом никуда не делись, просто ждут следующей
    // попытки — см. logSyncFailure).
    const dotTitle = isLocal ? "Сохранено на этом устройстве"
                   : failed ? "Не удалось отправить"
                   : skipped ? "Устаревшие данные с сервера не применены"
                   : "Сохранено";
    const dotClass = isLocal ? "local" : failed ? "err" : skipped ? "warn" : "ok";
    return "<div class=\"sync-history-entry\">"
      + "<div class=\"sync-history-head\"><b>" + formatHistoryTime(entry.time) + "</b><span>" + kindLabel + "</span></div>"
      + "<pre class=\"sync-history-body\">" + body + "</pre>"
      + (entry.by ? `<span class="sync-history-by">${escapeHtml(authorLabel(entry.by))}</span>` : "")
      + `<span class="sync-history-dot ${dotClass}" title="${dotTitle}"></span>`
      + "</div>";
  }).join("");
}

/* ==================== Журнал локальных сохранений ====================
   В историю попадают не только обмены с сервером, но и обычная работа на
   устройстве: добавили позицию, изменили количество, поправили склад/1С.
   Записи ГРУППИРУЮТСЯ: всё, что сделано в пределах минуты, показывается
   одной записью и пересчитывается целиком от состояния на начало группы —
   поэтому три тапа «+» подряд дают «20 → 23», а не три отдельные строки.

   Как считается разница. Держим два снимка:
     • базовый (baseline) — состояние на НАЧАЛО текущей группы, лежит в
       localStorage, чтобы группа пережила перезагрузку приложения;
     • последний (localLogLastState) — состояние на момент прошлой записи,
       живёт в памяти. Когда минута истекает и открывается новая группа,
       именно он становится её базовым: на конец прошлой группы состояние
       было ровно таким.
   Сортировка сюда не попадает — она сохраняется мимо scheduleSync(). */
const LOCAL_LOG_GROUP_MS = 60000;      // окно группировки — одна минута
const LOCAL_LOG_DEBOUNCE_MS = 1200;    // подряд идущие тапы сводим в одну запись
const LOCAL_LOG_BASELINE_KEY = "sklad2_local_log_baseline_v1";
let localLogTimer = null;
let localLogLastState = null;

function snapshotForLog() {
  return JSON.parse(JSON.stringify({ dataByDate, warehouse, onec }));
}
function loadLocalLogBaseline() {
  try {
    const raw = localStorage.getItem(LOCAL_LOG_BASELINE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveLocalLogBaseline(snap) {
  try { localStorage.setItem(LOCAL_LOG_BASELINE_KEY, JSON.stringify(snap)); } catch (e) {}
}

function logLocalChange() {
  if (localLogTimer) clearTimeout(localLogTimer);
  localLogTimer = setTimeout(flushLocalLog, LOCAL_LOG_DEBOUNCE_MS);
}

function flushLocalLog() {
  localLogTimer = null;
  const current = snapshotForLog();
  // Первый вызов до готовности приложения — просто запоминаем точку отсчёта.
  if (!localLogLastState) { localLogLastState = current; return; }

  const now = Date.now();
  const top = syncHistory[0];
  const inGroup = top && top.kind === "local"
                  && (top.by || "") === (MY_LOGIN || "")
                  && (now - (top.groupStart || top.time)) < LOCAL_LOG_GROUP_MS;

  let baseline;
  if (inGroup) {
    baseline = loadLocalLogBaseline() || localLogLastState;
  } else {
    baseline = localLogLastState;      // состояние на конец предыдущей группы
    saveLocalLogBaseline(baseline);
  }

  const lines = buildChangeSummary(baseline, current);
  localLogLastState = current;
  if (lines.length === 0) return;      // менялось что-то, чего не показываем

  if (inGroup) {
    top.lines = lines;                 // пересчитали группу целиком
    top.time = now;
  } else {
    syncHistory.unshift({ time: now, groupStart: now, kind: "local", lines, status: "local", by: MY_LOGIN || "" });
    if (syncHistory.length > SYNC_HISTORY_LIMIT) syncHistory.length = SYNC_HISTORY_LIMIT;
  }
  saveSyncHistoryList();
  renderSyncHistory();
}

function applySyncPayload(payload) {
  applyingRemote = true;
  try {
    if (payload.dataByDate && typeof payload.dataByDate === "object") {
      dataByDate = payload.dataByDate;
      try { localStorage.setItem(DATA_BY_DATE_KEY, JSON.stringify(dataByDate)); } catch (e) {}
    }
    if (payload.warehouse && Array.isArray(payload.warehouse.parts) && Array.isArray(payload.warehouse.consumables)) {
      warehouse = payload.warehouse;
      try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
    }
    if (payload.onec && Array.isArray(payload.onec.parts) && Array.isArray(payload.onec.consumables)) {
      onec = payload.onec;
      try { localStorage.setItem(ONEC_KEY, JSON.stringify(onec)); } catch (e) {}
    }
    if (Array.isArray(payload.transferList)) {
      transferList = payload.transferList;
      try { localStorage.setItem(TRANSFER_KEY, JSON.stringify(transferList)); } catch (e) {}
    }
    if (payload.bestStock && Array.isArray(payload.bestStock.rows)) {
      bestStock = payload.bestStock;
      saveBestStock(bestStock);
    }
    bindCurrent();   // выбранная заявка остаётся своей на каждом устройстве
    // С сервера могли прийти позиции со старыми названиями (метка версии
    // ещё в тексте) — сразу прогоняем автопростановку модели, иначе
    // результат локальной миграции затирался каждым получением данных.
    runModelMigrationOnce();
    // Сервер присылает данные в своём порядке — возвращаем сохранённый
    // локально порядок сортировки, иначе он сбрасывался после каждой
    // синхронизации и выглядело это как «сортировка не срабатывает».
    reapplySavedSort();
    selectedCA.parts.clear();
    selectedCA.consumables.clear();
    selectedWH.parts.clear();
    selectedWH.consumables.clear();
    selectedOC.parts.clear();
    selectedOC.consumables.clear();
    caHistory.reset();
    whHistory.reset();
    ocHistory.reset();
    rebuildCrossIndexes();
    renderAll();
    renderTicketList();
    updateAddPanelVisibility();
    renderWarehouseAll();
    renderOneCAll();
    try { renderTransferList(); } catch (e) {}
  } finally {
    applyingRemote = false;
  }
}

/* ==================== Обмен с Supabase ==================== */
function loadSyncMeta() {
  try { const m = JSON.parse(localStorage.getItem(SYNC_META_KEY)); return m && typeof m === "object" ? m : {}; }
  catch (e) { return {}; }
}
function saveSyncMeta(m) {
  try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(m)); } catch (e) {}
}
// Одинаковый текст для одинаковых данных независимо от порядка ключей
// (Postgres хранит jsonb со своим порядком ключей) — по нему считаем хэш.
function canonJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
async function hashValue(v) {
  const s = canonJson(v);
  if (window.crypto && crypto.subtle && window.TextEncoder) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return "d" + h.toString(16) + "_" + s.length;
}
function readLocalValue(rk) {
  const raw = localStorage.getItem(bkToLocal(rk));
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch (e) { return undefined; }
}
// Присланное с сервера значение должно быть нужной формы — иначе не применяем.
function isValidRemote(rk, v) {
  if (rk === "potreblenie_data_by_date_v3") return !!v && typeof v === "object" && !Array.isArray(v);
  if (rk === "potreblenie_warehouse_v1" || rk === "potreblenie_onec_v1") {
    return !!v && Array.isArray(v.parts) && Array.isArray(v.consumables);
  }
  if (rk === "potreblenie_transfer_list_v1") return Array.isArray(v);
  if (rk === "potreblenie_best_stock_v1") return !!v && Array.isArray(v.rows);
  return false;
}
function syncErrText(e) {
  const m = String((e && e.message) || e || "");
  if (/failed to fetch|network|load failed/i.test(m)) return "Нет связи с сервером";
  if (e && (e.status === 401 || /jwt|expired/i.test(m))) return "Сессия закончилась. Войдите снова";
  if (e && (e.code === "42501" || e.status === 403)) return "Нет прав на запись";
  return m || "неизвестная ошибка";
}

// policy: "safe" — без потерь, расхождения не трогаем; "mine" — данные этого
// устройства главнее; "server" — данные сервера главнее.

/* ==================== Автоматическое слияние правок ====================
   Если данные изменились и здесь, и на сервере, пробуем объединить их «по трём
   сторонам»: БАЗА (то, что было при последнем обмене), МОИ и СЕРВЕРНЫЕ.
   Правки разных позиций складываются; количества, которые изменили оба,
   складываются как разницы (база 10, у меня 9, на сервере 8 → 7). Позиция,
   удалённая одной стороной и не тронутая другой, удаляется. Правка важнее
   удаления: изменённая позиция не пропадает. Если базы нет или формат
   неожиданный — слияние не делаем, остаётся вопрос «чьи данные оставить». */
const SYNC_BASE_KEY = "sklad2_sync_base_v1";
function loadSyncBase() {
  try { const b = JSON.parse(localStorage.getItem(SYNC_BASE_KEY)); return b && typeof b === "object" ? b : {}; }
  catch (e) { return {}; }
}
function saveSyncBase(b) {
  try { localStorage.setItem(SYNC_BASE_KEY, JSON.stringify(b)); }
  catch (e) { try { localStorage.removeItem(SYNC_BASE_KEY); } catch (e2) {} }   // не влезло — слияния не будет, остаётся ручной выбор
}
function mEq(a, b) { return canonJson(a) === canonJson(b); }
function mClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
// Одно поле: кто поменял относительно базы — того и значение. Оба — числа: складываем разницы.
function mergeField(b, l, r, numeric) {
  if (mEq(l, r)) return l;
  if (mEq(l, b)) return r;
  if (mEq(r, b)) return l;
  if (numeric && typeof l === "number" && typeof r === "number") return Math.max(0, l + r - (typeof b === "number" ? b : 0));
  return l;   // оба поменяли по-разному, не числа — остаётся моё
}
function mergeObj(b, l, r, numericKeys) {
  b = b || {};
  const out = {};
  const keys = new Set([].concat(Object.keys(b), Object.keys(l), Object.keys(r)));
  keys.forEach((k) => {
    const inL = k in l, inR = k in r;
    if (!inL && !inR) return;
    if (inL && !inR) { if (k in b && mEq(l[k], b[k])) return; out[k] = l[k]; return; }
    if (!inL && inR) { if (k in b && mEq(r[k], b[k])) return; out[k] = r[k]; return; }
    out[k] = mergeField(b[k], l[k], r[k], numericKeys && numericKeys.indexOf(k) !== -1);
  });
  return out;
}
// Список позиций. Порядок — как на сервере, мои новые дописываются в конец.
function mergeItemList(section, bl, ll, rl, mergeItem) {
  const idOf = (it) => countKey(section, it);
  const map = (arr) => { const m = new Map(); (arr || []).forEach((it) => { const k = idOf(it); if (!m.has(k)) m.set(k, it); }); return m; };
  const bm = map(bl), lm = map(ll), rm = map(rl);
  const out = [];
  (rl || []).forEach((r) => {
    const k = idOf(r);
    if (lm.has(k)) { out.push(mergeItem(bm.get(k), lm.get(k), r)); return; }
    if (bm.has(k) && mEq(bm.get(k), r)) return;     // я удалил, на сервере не трогали — удаляем
    out.push(r);                                      // новая на сервере или там правили — оставляем
  });
  (ll || []).forEach((l) => {
    const k = idOf(l);
    if (rm.has(k)) return;
    if (bm.has(k) && mEq(bm.get(k), l)) return;     // на сервере удалили, у меня не трогали — удаляем
    out.push(l);                                      // моя новая или я правил — оставляем
  });
  return out;
}
function mergeStockItem(b, l, r) { return mergeObj(b, l, r, ["qty"]); }
function mergeDayEntry(b, l, r) {
  b = b || { sections: { parts: [], consumables: [] }, counts: {}, checked: {} };
  const out = mergeObj(b, l, r, null);
  const sb = b.sections || {}, sl = l.sections || {}, sr = r.sections || {};
  out.sections = {};
  ["parts", "consumables"].forEach((s) => {
    out.sections[s] = mergeItemList(s, sb[s], sl[s], sr[s], (bi, li, ri) => mergeObj(bi, li, ri, null));
  });
  const alive = new Set();
  ["parts", "consumables"].forEach((s) => out.sections[s].forEach((it) => alive.add(countKey(s, it))));
  const counts = {}, chk = {};
  const ck = new Set([].concat(Object.keys(b.counts || {}), Object.keys(l.counts || {}), Object.keys(r.counts || {})));
  ck.forEach((k) => {
    if (!alive.has(k)) return;
    const lc = (l.counts || {})[k], rc = (r.counts || {})[k], bc = (b.counts || {})[k];
    const v = mergeField(bc, lc, rc, true);
    if (v !== undefined) counts[k] = v;
  });
  const kk = new Set([].concat(Object.keys(b.checked || {}), Object.keys(l.checked || {}), Object.keys(r.checked || {})));
  kk.forEach((k) => {
    if (!alive.has(k)) return;
    const v = mergeField((b.checked || {})[k], (l.checked || {})[k], (r.checked || {})[k], false);
    if (v !== undefined) chk[k] = v;
  });
  out.counts = counts; out.checked = chk;
  return out;
}
// Возвращает слитое значение или null, если слить нельзя.
function mergeSyncValue(rk, B, L, R) {
  try {
    if (B === undefined || B === null || L === undefined || R === undefined) return null;
    if (rk === "potreblenie_data_by_date_v3") {
      const out = {};
      const dates = new Set([].concat(Object.keys(B), Object.keys(L), Object.keys(R)));
      dates.forEach((d) => {
        const inL = d in L, inR = d in R, inB = d in B;
        if (inL && inR) { out[d] = mEq(L[d], R[d]) ? L[d] : (mEq(L[d], B[d]) ? R[d] : (mEq(R[d], B[d]) ? L[d] : mergeDayEntry(B[d], L[d], R[d]))); return; }
        if (inL) { if (inB && mEq(L[d], B[d])) return; out[d] = L[d]; return; }
        if (inR) { if (inB && mEq(R[d], B[d])) return; out[d] = R[d]; }
      });
      return out;
    }
    if (rk === "potreblenie_warehouse_v1" || rk === "potreblenie_onec_v1") {
      const out = mergeObj(B, L, R, null);
      ["parts", "consumables"].forEach((s) => {
        out[s] = mergeItemList(s, B[s], L[s], R[s], mergeStockItem);
      });
      return out;
    }
    if (rk === "potreblenie_transfer_list_v1") {
      return mergeItemList("t", B, L, R, (b, l, r) => r);
    }
    if (rk === "potreblenie_best_stock_v1") {
      return ((L && L.savedAt) || 0) > ((R && R.savedAt) || 0) ? L : R;   // это выгрузка целиком: берём более свежую
    }
  } catch (e) {}
  return null;
}

async function runSync(policy) {
  const sbc = Auth.sb;
  const meta = loadSyncMeta();
  const res = { pushed: [], pulled: [], conflicts: [], skipped: [], merged: [], raced: false };
  const base = loadSyncBase(), bases = {};

  // 1) что есть на сервере (только ключи и время)
  const head = await sbc.from("sklad_kv").select("key, updated_at").in("key", SYNC_KEYS);
  if (head.error) throw head.error;
  const remoteAt = {};
  (head.data || []).forEach((r) => { remoteAt[r.key] = r.updated_at; });

  // 2) что есть у нас
  const local = {};
  for (const rk of SYNC_KEYS) {
    const v = readLocalValue(rk);
    if (v !== undefined) local[rk] = { v, h: await hashValue(v) };
  }

  // 3) значения с сервера читаем только там, где они нужны для решения
  const need = SYNC_KEYS.filter((rk) => {
    if (!remoteAt[rk]) return false;
    const m = meta[rk];
    return policy === "server" || !local[rk] || !m || m.at !== remoteAt[rk];
  });
  const remote = {};
  if (need.length) {
    const full = await sbc.from("sklad_kv").select("key, value, updated_at").in("key", need);
    if (full.error) throw full.error;
    for (const r of (full.data || [])) remote[r.key] = { value: r.value, at: r.updated_at, h: await hashValue(r.value) };
  }

  // 4) решаем по каждому ключу
  const toPush = [], toPull = [], toMerge = [];
  for (const rk of SYNC_KEYS) {
    const L = local[rk], at = remoteAt[rk], m = meta[rk], R = remote[rk];
    if (!at) { if (L) toPush.push({ rk, insert: true }); continue; }   // на сервере ещё нет — ничего не теряем
    const cur = R ? R.at : at;
    if (R && L && R.h === L.h) { meta[rk] = { at: R.at, h: L.h }; bases[rk] = L.v; continue; }   // совпадают
    if (R && !isValidRemote(rk, R.value)) { res.skipped.push(rk); continue; }
    if (!L) { if (R && policy !== "mine") toPull.push(rk); continue; }   // у нас этого ключа нет
    // Устройство ещё ни разу не обменивалось этим ключом (новое) — только принимает данные сервера.
    // Исключение — восстановленная копия: там спрашиваем, чьи данные оставить.
    if (!m && policy === "safe" && !isRestoredPending()) { if (R) toPull.push(rk); continue; }
    const remoteChanged = !m || m.at !== cur;
    const localChanged = !m || m.h !== L.h;
    if (policy === "mine") toPush.push({ rk, at: cur, force: true });
    else if (policy === "server") { if (R) toPull.push(rk); }
    else if (remoteChanged && localChanged) {
      const mv = (R && m) ? mergeSyncValue(rk, base[rk], L.v, R.value) : null;
      if (mv === null || mv === undefined) res.conflicts.push(rk);
      else toMerge.push({ rk, value: mv, at: cur });
    }
    else if (remoteChanged) { if (R) toPull.push(rk); }
    else if (localChanged) toPush.push({ rk, at: cur });
    else if (m && m.h === L.h && m.at === cur) bases[rk] = L.v;   // ничего не менялось — запоминаем базу для будущих слияний
  }

  // 5) забираем с сервера
  if (toPull.length) {
    const payload = {};
    toPull.forEach((rk) => { payload[SYNC_FIELD[rk]] = remote[rk].value; });
    applySyncPayload(payload);
    toPull.forEach((rk) => { meta[rk] = { at: remote[rk].at, h: remote[rk].h }; bases[rk] = remote[rk].value; res.pulled.push(rk); });
  }

  // 5б) сливаем правки с обеих сторон: применяем результат у себя и отправляем на сервер
  if (toMerge.length) {
    const payload = {};
    for (const mg of toMerge) {
      payload[SYNC_FIELD[mg.rk]] = mg.value;
      local[mg.rk] = { v: mg.value, h: await hashValue(mg.value) };
    }
    applySyncPayload(payload);
    toMerge.forEach((mg) => { toPush.push({ rk: mg.rk, at: mg.at, merged: true }); res.merged.push(mg.rk); });
  }

  // 6) отправляем на сервер
  for (const p of toPush) {
    const L = local[p.rk];
    let r;
    if (p.insert) r = await sbc.from("sklad_kv").insert({ key: p.rk, value: L.v }).select("updated_at");
    else if (p.force) r = await sbc.from("sklad_kv").update({ value: L.v }).eq("key", p.rk).select("updated_at");
    else r = await sbc.from("sklad_kv").update({ value: L.v }).eq("key", p.rk).eq("updated_at", p.at).select("updated_at");
    if (r.error) {
      if (r.error.code === "23505") { res.raced = true; continue; }   // строку успели создать — повторим обмен
      throw r.error;
    }
    if (!r.data || !r.data.length) { res.raced = true; continue; }    // строку успели изменить — повторим обмен
    meta[p.rk] = { at: r.data[0].updated_at, h: L.h };
    bases[p.rk] = L.v;
    res.pushed.push(p.rk);
  }
  saveSyncMeta(meta);
  Object.keys(bases).forEach((k) => { base[k] = mClone(bases[k]); });
  saveSyncBase(base);
  return res;
}

let syncBusy = false;
async function syncNow(policy, opts) {
  opts = opts || {};
  if (!isSyncConfigured() || !window.Auth) return { ok: false, text: "Нужен вход в аккаунт" };
  if (syncBusy) {
    syncQueued = true;   // правка пришла во время обмена — повторим сразу после него
    return { ok: false, busy: true, text: "Обмен уже идёт, повторите через несколько секунд" };
  }
  syncBusy = true;
  const startedAt = Date.now();
  const names = (list) => list.map((k) => SYNC_LABEL[k] || k).join(", ");
  setSyncStatus("syncing", "Обмен с сервером…");
  let out;
  try {
    // Если сервер успели изменить между чтением и записью, повторяем обмен (до 3 раз):
    // при повторе правки сольются или подтянутся, спрашивать пользователя не нужно.
    let r = await runSync(policy || "safe");
    for (let i = 0; i < 3 && r.raced; i++) {
      const r2 = await runSync(policy || "safe");
      ["pushed", "pulled", "merged", "skipped"].forEach((f) => { r2[f] = r[f].concat(r2[f]); });
      r = r2;
    }
    if (r.raced) throw new Error("данные на сервере часто меняются, повторим позже");
    if (r.conflicts.length) {
      const meta0 = loadSyncMeta();
      const firstTime = r.conflicts.every((k) => !meta0[k]);
      out = { ok: false, conflict: true,
        text: (firstTime
          ? "Первая синхронизация: данные здесь и на сервере разные (" + names(r.conflicts) + "). "
            + "Если здесь пусто или это новое устройство — оставьте данные сервера. Если вы только что восстановили копию — оставьте мои данные."
          : "Данные расходятся с сервером: " + names(r.conflicts) + ". Выберите, чьи данные оставить.")
        + " Меню ⋮ → Синхронизация." };
      setSyncStatus("err", out.text);
    } else {
      try { localStorage.removeItem(RESTORED_KEY); } catch (e) {}
      markSyncedTo(startedAt, (r.pushed.length || r.pulled.length) ? buildSyncPayload() : null,
                   r.pulled.length && !r.pushed.length ? "pull" : "push");
      const parts = [];
      if (r.merged.length) parts.push("объединено с правками другого устройства: " + names(r.merged));
      if (r.pushed.length) parts.push("отправлено: " + names(r.pushed));
      if (r.pulled.length) parts.push("загружено: " + names(r.pulled));
      if (r.skipped.length) parts.push("пропущено (неверный формат на сервере): " + names(r.skipped));
      out = { ok: true, text: parts.length ? "Готово — " + parts.join("; ") : "Всё актуально" };
      setSyncStatus("ok", "Синхронизировано: " + new Date().toLocaleTimeString().slice(0, 5));
    }
  } catch (e) {
    const t = syncErrText(e);
    out = { ok: false, text: "Не удалось выполнить обмен: " + t };
    setSyncStatus("err", out.text);
    if (!/Нет связи/.test(t)) logSyncFailure("push", null, t);
  } finally {
    syncBusy = false;
    if (syncQueued) {
      syncQueued = false;
      if (isAutoSyncActive()) setTimeout(() => syncNow("safe", { auto: true }), 300);
    }
  }
  return out;
}

function scheduleSync() {
  if (applyingRemote) return;          // это мы сами только что применили данные с сервера
  logLocalChange();                    // пишем правку в историю (работает и без синхронизации)
  markLocalChange();                   // запоминаем: на этом устройстве есть свежая правка
  if (!isAutoSyncActive()) return;     // ручной режим — отправляем только по кнопке
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow("safe", { auto: true }); }, SYNC_DEBOUNCE_MS);
}

// Немедленно (без ожидания debounce) пытается отправить несохранённые правки.
// Используется, когда пользователь сворачивает/закрывает вкладку.
function flushSyncNow() {
  if (!isAutoSyncActive() || !isDirty()) return;
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (!syncBusy) syncNow("safe", { auto: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushSyncNow();
  } else if (document.visibilityState === "visible") {
    // Возврат в приложение: тихо сверяемся с сервером (только если не открыта модалка).
    const modalOpen = document.querySelector(".modal-overlay.open");
    if (isAutoSyncActive() && !syncBusy && !modalOpen) syncNow("safe", { auto: true });
  }
});
window.addEventListener("pagehide", flushSyncNow);
// Связь восстановилась — если остались неотправленные правки, пробуем сразу.
window.addEventListener("online", () => {
  if (isAutoSyncActive() && isDirty() && !syncBusy) syncNow("safe", { auto: true });
});

/* ==================== Живое обновление (Supabase Realtime) ====================
   Сервер сообщает о каждой записи в sklad_kv — правка с другого устройства
   доезжает без перезагрузки. На сообщение отвечаем обычной «безопасной»
   сверкой (она сама решит, что забрать, а что оставить). Если открыто окно или
   идёт ввод — ждём, чтобы не выдернуть форму из-под рук. */
let rtChannel = null, rtTimer = null, rtWasDown = false;
function scheduleRemoteSync() {
  if (rtTimer) clearTimeout(rtTimer);
  rtTimer = setTimeout(function tick() {
    rtTimer = null;
    if (!isAutoSyncActive()) return;
    if (document.querySelector(".modal-overlay.open") || isTypingNow() || syncBusy) { rtTimer = setTimeout(tick, 3000); return; }
    syncNow("safe", { auto: true });
  }, 1500);
}
function startRealtime() {
  if (rtChannel || !window.Auth) return;
  try {
    rtChannel = Auth.sb.channel("sklad_kv_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "sklad_kv" }, (msg) => {
        const row = msg && msg.new;
        if (!row || SYNC_KEYS.indexOf(row.key) === -1) return;
        const m = loadSyncMeta()[row.key];
        if (m && m.at === row.updated_at) return;      // это наша собственная запись
        scheduleRemoteSync();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (rtWasDown) { rtWasDown = false; scheduleRemoteSync(); }   // связь вернулась — догоняем пропущенное
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          rtWasDown = true;
        }
      });
  } catch (e) { rtChannel = null; }
}
function stopRealtime() {
  if (rtTimer) { clearTimeout(rtTimer); rtTimer = null; }
  if (rtChannel) { try { Auth.sb.removeChannel(rtChannel); } catch (e) {} rtChannel = null; }
}

// Сменщику: названия, коды и модели деталей (без остатков) — готовая выжимка на сервере.
async function loadCatalogFromServer() {
  try {
    const r = await Auth.sb.from("sklad_kv").select("value").eq("key", CATALOG_REMOTE_KEY).maybeSingle();
    const v = r && r.data && r.data.value;
    if (v && Array.isArray(v.parts) && Array.isArray(v.consumables)) {
      localStorage.setItem(CATALOG_KEY, JSON.stringify(v));
      warehouse = warehouseFromCatalog();
      renderAll();
    }
  } catch (e) {}
}

/* ==================== Окно «Синхронизация и аккаунт» ==================== */
async function refreshAccountLine() {
  const el = document.getElementById("syncAccountLine");
  if (!el || !window.Auth) return;
  const u = await Auth.getUser();
  el.textContent = u ? String(u.email || "").replace(/@zayavki\.app$/, "")
                     : (isSyncConfigured() ? "нет связи (работа офлайн)" : "вход не выполнен");
}
function openSyncModal() {
  const auto = document.getElementById("syncAutoToggle");
  if (auto) auto.checked = !isAutoSyncOff();
  const info = document.getElementById("manualSyncInfo");
  if (info) {
    info.classList.remove("err");
    info.textContent = "Последний обмен с сервером: " + formatSyncMoment(getLastSyncedAt())
      + (isDirty() ? " · есть неотправленные правки" : "");
  }
  manualSyncBusy(false);
  refreshAccountLine();
  openModal("syncOverlay");
}
function closeSyncModal() {
  closeModal("syncOverlay");
}
document.getElementById("profileBtn").addEventListener("click", openSyncModal);
document.getElementById("syncClose").addEventListener("click", closeSyncModal);
document.getElementById("syncOverlay").addEventListener("click", (e) => {
  if (e.target.id === "syncOverlay") closeSyncModal();
});
document.getElementById("syncAutoToggle").addEventListener("change", (e) => {
  setAutoSyncOff(!e.target.checked);
  updateDirtyIndicator();
  setSyncStatus(isSyncConfigured() ? "idle" : "off", isSyncConfigured() ? manualModeStatusText() : "Нужен вход в аккаунт.");
  if (e.target.checked && isSyncConfigured()) syncNow("safe", { auto: true });
});
document.getElementById("syncLogoutBtn").addEventListener("click", () => {
  if (!confirm("Выйти из аккаунта? Данные на этом устройстве останутся, но обмен с сервером остановится до нового входа.")) return;
  closeSyncModal();
  if (window.Auth) Auth.logout();
});
// Выбор действия; повторное нажатие на выбранное снимает выбор (снова вся история).
// Перехват на погружении (capture) — раньше общего обработчика .model-switch, который выбор не снимает.
document.getElementById("syncHistoryFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".ms-opt");
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  const m = btn.dataset.model || "";
  syncHistoryFilter = syncHistoryFilter === m ? "" : m;
  setModelSwitch(e.currentTarget, syncHistoryFilter);
  renderSyncHistory();
  document.getElementById("syncHistoryList").scrollTop = 0;
}, true);
document.getElementById("syncHistoryBtn").addEventListener("click", () => {
  renderSyncHistory();
  openModal("syncHistoryOverlay");
});
document.getElementById("syncHistoryClose").addEventListener("click", () => {
  closeModal("syncHistoryOverlay");
});
document.getElementById("syncHistoryOverlay").addEventListener("click", (e) => {
  if (e.target.id === "syncHistoryOverlay") closeModal("syncHistoryOverlay");
});

/* ==================== Меню разделов (Учёт потребления / Заявки на закупку) ==================== */
(function () {
  const btn = document.getElementById("modMenuBtn");
  const panel = document.getElementById("modMenuPanel");
  if (!btn || !panel) return;
  try { localStorage.setItem("sklad2_last_module", "uchet"); } catch (e) {}
  btn.addEventListener("click", (e) => { e.stopPropagation(); panel.classList.toggle("open"); });
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("open")) return;
    if (e.target.closest("#modMenuPanel") || e.target.closest("#modMenuBtn")) return;
    panel.classList.remove("open");
  });
})();

/* ==================== Старт ==================== */
loadSortState();
reapplySavedSort();
renderAll();
renderTicketList();
updateAddPanelVisibility();
renderWarehouseAll();
// Вкладка из адреса (#warehouse / #onec) — открыта колесом мыши или после обновления страницы.
// Сменщику «Склад» и «1С» недоступны.
// #today (QR-код на складе): после входа и обмена с сервером открыть последнюю заявку за сегодня,
// а если её нет — создать (от имени вошедшего аккаунта).
let openTodayPending = false;
(function () {
  const h = (location.hash || "").replace("#", "");
  if (h === "today") openTodayPending = true;   // #today снимается после открытия заявки (вход может перезагрузить страницу)
  else if ((h === "warehouse" || h === "onec") && !isShift()) switchTab(h);
  else if (h) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
})();
function openTodayTicket() {
  openTodayPending = false;
  switchTab("consumption");
  const t = todayStr();
  const keys = ticketKeys().filter((k) => k.slice(0, 10) === t);
  if (keys.length) selectTicket(keys[keys.length - 1]);
  else createTicket();
}
renderOneCAll();

updateDirtyIndicator();
// Точка отсчёта для журнала локальных правок. Ставится ПОСЛЕ загрузки данных
// и автопростановки моделей — иначе первое изменение сравнивать было бы не с
// чем, а сама миграция попала бы в историю как правка пользователя.
localLogLastState = snapshotForLog();
// Если при запуске автопростановка модели что-то изменила (например, впервые
// после обновления приложения) — помечаем это как локальную правку, чтобы
// очищенные названия и проставленные модели ушли на сервер, а не остались
// только на этом устройстве.
if (migrationTouchedAtStartup) markLocalChange();
// Вход: общий экран входа (auth.js) закрывает страницу, пока нет сессии.
// После входа включается обмен с сервером.
setSyncStatus("off", "Нужен вход в аккаунт.");
if (window.Auth) {
  Auth.gate({
    onLogin: async () => {
      // Роль: если изменилась (другой аккаунт на этом устройстве) — перезагружаем страницу в нужном режиме.
      try {
        const r = await Auth.loadRole();
        if (r && r.role !== ROLE) { location.reload(); return; }
        if (r) MY_LOGIN = r.login;
        setQrKiosk(isShift() && /^(otp|magiclink)$/.test((await Auth.loginMethod()) || ""));
        { const qb = document.getElementById("qrShiftBtn"); if (qb) qb.hidden = MY_LOGIN !== "hleb"; }
      } catch (e) {}
      if (isShift()) { if (!(await shiftSessionAlive())) return; await loadCatalogFromServer(); }
      syncUserOk = true;
      updateDirtyIndicator();
      setSyncStatus("idle", manualModeStatusText());
      refreshAccountLine();
      if (openTodayPending || QR_KIOSK) {
        // сначала забираем заявки с сервера — иначе можно создать вторую заявку на сегодня
        if (!isAutoSyncOff()) { try { await syncNow("safe", { auto: true }); } catch (e) {} }
        openTodayTicket();
      } else if (!isAutoSyncOff()) syncNow("safe", { auto: true });
      startRealtime();
    },
    onLogout: () => {
      syncUserOk = false;
      setQrKiosk(false);
      stopRealtime();
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      updateDirtyIndicator();
      setSyncStatus("off", "Нужен вход в аккаунт.");
    }
  });
} else {
  setSyncStatus("err", "Не загрузилась библиотека входа — обмен с сервером недоступен.");
}
refreshAfterSyncChange();
// Раз в минуту убираем пустые заявки старше часа (на любом устройстве и аккаунте).
setInterval(() => {
  if (applyingRemote) return;
  if (cleanupEmptyTickets(true)) { bindCurrent(); renderTicketList(); renderAll(); updateAddPanelVisibility(); }
}, 60000);
// Вход по QR: всегда открыта заявка за текущий день (после полуночи — новая; пустую могла убрать очистка).
function kioskKeepToday() {
  if (!QR_KIOSK || !syncUserOk || applyingRemote) return;
  if (!currentDate || !dataByDate[currentDate] || currentDate.slice(0, 10) !== todayStr()) openTodayTicket();
}
setInterval(kioskKeepToday, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) kioskKeepToday(); });
// Сменщик: в полночь и в 04:00 МСК меняется, какую заявку можно править — раз в минуту обновляем режим.
if (isShift()) {
  let lastEditable = canEditCurrent();
  setInterval(() => {
    const now = canEditCurrent();
    if (now !== lastEditable) { lastEditable = now; renderAll(); renderTicketList(); updateAddPanelVisibility(); }
  }, 60000);
}

/* ==================== Поля количества: авто-ширина + курсор в конец ====================
   Ширина поля растёт вслед за введённым числом (не обрезает 1000+), а при
   тапе по уже заполненному полю курсор сразу встаёт после последней цифры. */
const QTY_INPUT_SELECTOR = ".countInput";
function autoSizeQtyInput(input) {
  const len = String(input.value || "").length;
  input.style.width = Math.max(len + 1.4, 2.4) + "ch";
}
document.addEventListener("input", (e) => {
  const input = e.target.closest(QTY_INPUT_SELECTOR);
  if (!input) return;
  autoSizeQtyInput(input);
});
document.addEventListener("focus", (e) => {
  const input = e.target.closest(QTY_INPUT_SELECTOR);
  if (!input) return;
  autoSizeQtyInput(input);
  const end = input.value.length;
  setTimeout(() => { try { input.setSelectionRange(end, end); } catch (err) {} }, 0);
}, true);
document.querySelectorAll(QTY_INPUT_SELECTOR).forEach(autoSizeQtyInput);
new MutationObserver((mutations) => {
  mutations.forEach((m) => {
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      if (node.matches && node.matches(QTY_INPUT_SELECTOR)) autoSizeQtyInput(node);
      if (node.querySelectorAll) node.querySelectorAll(QTY_INPUT_SELECTOR).forEach(autoSizeQtyInput);
    });
  });
}).observe(document.body, { childList: true, subtree: true });

/* ==================== Копирование кода товара по одному тапу ====================
   Один тап (или клик на ПК) на код детали/расходника сразу копирует его
   в буфер обмена — без выделения и без "—" у пустых значений. */
function copyCodeText(span) {
  if (!span) return;
  const text = span.getAttribute("data-code") || span.textContent || "";
  if (!text) return;
  const done = () => {
    span.classList.add("code-copied");
    setTimeout(() => span.classList.remove("code-copied"), 450);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      fallbackCopy(text);
      done();
    });
  } else {
    fallbackCopy(text);
    done();
  }
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}
document.addEventListener("click", (e) => {
  const span = e.target.closest(".code-text");
  if (!span) return;
  copyCodeText(span);
});

/* ==================== PWA: регистрация service worker ====================
   Нужно для установки на главный экран телефона и офлайн-работы.
   Работает только при открытии по https (или через GitHub Pages) —
   на file:// service worker браузером не регистрируется, но это не мешает
   основной работе программы, просто эта функция не активируется. */
/* Автообновление. Раньше здесь была только регистрация: новые файлы
   подхватывались лишь при полной перезагрузке страницы. На телефоне это
   происходило само (система постоянно выгружает приложение из памяти), а на
   рабочем столе окно PWA живёт неделями и не перезагружается — поэтому там
   обновление "не доезжало". Теперь сами спрашиваем сервер, не появилась ли
   новая версия, и перезагружаем страницу, когда она приехала. */
const SW_UPDATE_CHECK_MS = 30 * 60 * 1000;   // раз в полчаса, пока окно открыто

// Перезагружаем не мгновенно: если открыта модалка или пользователь что-то
// набирает — ждём, иначе перезагрузка выдернула бы форму из-под рук.
// Данные не теряются в любом случае (они пишутся в localStorage сразу), но
// прерывать ввод всё равно незачем.
function reloadForUpdateWhenSafe() {
  const tryReload = () => {
    if (document.querySelector(".modal-overlay.open") || isTypingNow()) {
      setTimeout(tryReload, 3000);
      return;
    }
    location.reload();
  };
  tryReload();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Смена управляющего service worker = приехала новая версия файлов.
    // Исключение — самая первая установка: там controllerchange срабатывает
    // от clients.claim(), хотя обновляться не с чего. Поэтому первый такой
    // сигнал только запоминаем, а перезагружаемся начиная со второго.
    let hasController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hasController) { hasController = true; return; }
      if (reloading) return;
      reloading = true;
      reloadForUpdateWhenSafe();
    });

    navigator.serviceWorker.register("../sw.js").then((reg) => {
      const check = () => reg.update().catch(() => {});
      check();                                   // сразу при запуске
      setInterval(check, SW_UPDATE_CHECK_MS);    // и дальше периодически
      // Возврат к приложению — самый частый момент, когда стоит проверить.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.addEventListener("focus", check);
    }).catch(() => {});
  });
}
