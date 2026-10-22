/* Учёт потребления — Общее: ключи хранения, утилиты, модель данных (заявки, склад), роль, отмена/повтор, подсветка строк.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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

/* ==================== Один раздел позиций ====================
   Разделов «Детали / Расходники» больше нет: все позиции лежат в parts.
   Пустой consumables остаётся в данных только ради прежнего формата (сервер,
   резервные копии старого склада). Если в старых данных позиции ещё лежат
   в consumables, при чтении они переносятся в parts. */
function emptySections() { return { parts: [], consumables: [] }; }
function foldStock(v) {
  if (!v || !Array.isArray(v.parts)) return v;
  if (Array.isArray(v.consumables) && v.consumables.length) v.parts = v.parts.concat(v.consumables);
  v.consumables = [];
  return v;
}
function foldDay(e) {
  const s = e && e.sections;
  if (!s) return e;
  s.parts = s.parts || [];
  if (Array.isArray(s.consumables) && s.consumables.length) {
    const have = new Set(s.parts.map((it) => countKey("parts", it)));
    s.consumables.forEach((it) => { if (!have.has(countKey("parts", it))) s.parts.push(it); });
  }
  s.consumables = [];
  ["counts", "checked"].forEach((f) => {
    const m = e[f];
    if (!m) return;
    Object.keys(m).forEach((k) => {
      if (k.indexOf("consumables::") !== 0) return;
      const nk = "parts::" + k.slice("consumables::".length);
      m[nk] = f === "counts" ? (m[nk] || 0) + (m[k] || 0) : (m[nk] || m[k]);
      delete m[k];
    });
  });
  return e;
}
function foldDays(d) {
  if (d && typeof d === "object") Object.keys(d).forEach((k) => foldDay(d[k]));
  return d;
}
// Значение ключа синхронизации (как в sklad_kv) — к одному разделу.
function foldSyncValue(rk, v) {
  if (rk === "potreblenie_data_by_date_v3") return foldDays(v);
  if (rk === "potreblenie_warehouse_v1" || rk === "potreblenie_onec_v1") return foldStock(v);
  return v;
}
/* Ключ позиции: если у позиции есть код склада — общий по коду (для сквозного расчёта
   и связи учёта со складом), иначе — раздел + название. */
function countKey(section, item) {
  return item.code ? ("code::" + item.code) : (section + "::" + item.name);
}

/* ==================== Загрузка/сохранение ==================== */
function loadDataByDate() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DATA_BY_DATE_KEY));
    return (parsed && typeof parsed === "object") ? foldDays(parsed) : {};
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
    if (c && Array.isArray(c.parts)) return foldStock(c);
  } catch (e) {}
  return emptySections();
}
// Сменщик: остаток 1С из каталога; для ручной связки кодов (CODE_LINKS) — по связанному коду.
function shiftOcQty(r) {
  if (r.ocqty !== undefined) return r.ocqty;
  for (const c of codeVariants(r.code)) {
    for (const oc of (linkWhToOc[c] || [])) {
      const hit = warehouse.parts.find((it) => it.ocqty !== undefined && codeVariants(it.code).includes(oc));
      if (hit) return hit.ocqty;
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
  return { parts: conv(c.parts), consumables: [] };
}
function loadWarehouse() {
  if (isShift()) return warehouseFromCatalog();
  // Нет данных на устройстве — пусто: склад приходит с сервера при первом обмене.
  try {
    const parsed = JSON.parse(localStorage.getItem(WAREHOUSE_KEY));
    if (parsed && Array.isArray(parsed.parts)) return foldStock(parsed);
  } catch (e) {}
  return emptySections();
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
let warehouse = loadWarehouse(); // { parts: [{code,name,qty,model}], consumables: [] }
// Дата при каждом открытии приложения — всегда сегодняшняя (а не та, на которой
// остановились в прошлый раз): открыли на следующий день — календарь сам на нём.
/* Учёт ведётся ЗАЯВКАМИ: каждая — запись в dataByDate с ключом «ГГГГ-ММ-ДД» (первая за день)
   или «ГГГГ-ММ-ДД#2», «#3»… (следующие). Номер заявки не хранится: это порядковый номер среди
   всех заявок по возрастанию даты, поэтому на всех устройствах он одинаков. Не выбрана
   заявка (currentDate = null) — рабочее поле пустое. */
let currentDate = null;
const TICKET_KEY_RE = /^\d{4}-\d{2}-\d{2}(#\d+)?$/;
function emptyEntry() { return { sections: emptySections(), counts: {}, checked: {} }; }
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
  return ((e && e.sections && e.sections.parts) || []).length;
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
  if (!dataByDate[date]) dataByDate[date] = emptyEntry();
  if (!dataByDate[date].checked) dataByDate[date].checked = {};
  if (!dataByDate[date].sections) dataByDate[date].sections = emptySections();
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

/* Ищет, на какой строке произошло изменение */
function findChange(beforeLists, afterLists, beforeMap, afterMap, keyFn) {
  const section = "parts";
  const list = afterLists[section] || [];
  const i = firstDiffIndex(beforeLists[section], list);
  if (i >= 0 && list.length) return { section, index: Math.min(i, list.length - 1) };
  // списки совпали — значит изменилось значение по ключу (кол-во, галочка)
  if (beforeMap && afterMap) {
    const keys = new Set(Object.keys(beforeMap).concat(Object.keys(afterMap)));
    for (const k of keys) {
      if (beforeMap[k] === afterMap[k]) continue;
      const idx = list.findIndex((it) => keyFn(section, it) === k);
      if (idx >= 0) return { section, index: idx };
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

/* ==================== Выделение строк кликом/тапом (мульти-выбор) ==================== */
const selectedCA = { parts: new Set() };
const selectedWH = { parts: new Set() };

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
