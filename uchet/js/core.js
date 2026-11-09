/* Учёт потребления — Общее: ключи хранения, утилиты, модель данных (заявки, склад), роль, отмена/повтор, подсветка строк.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
/* ==================== Панели поиска (Учёт / Склад / 1С / Инвентаризация) ====================
   Разметка у всех одинаковая — создаётся здесь. Должно выполниться до того, как код ниже
   обратится к whSearchInput, caSearchClear и т.п. через getElementById. */
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
["wh", "ca", "oc", "inv"].forEach((prefix) => {
  const bar = document.getElementById(prefix + "SearchBar");
  if (bar) bar.innerHTML = searchBarHTML(prefix);
});

/* ==================== Переключение вкладок, клик мимо подсказок ====================
   Обработчик вкладок ставится в самом начале: даже если ниже при загрузке что-то упадёт,
   вкладки продолжат переключаться. */
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

// Версия: меняется вместе с CACHE_NAME в ../sw.js и APP_VERSION в ../baza/app.js.
// Только показывается в шапке и пишется в резервную копию, как число не сравнивается.
const APP_VERSION = "v2.0";
{
  const el = document.getElementById("appVersionBadge");
  if (el) el.textContent = APP_VERSION;
}

const DATA_BY_DATE_KEY = "sklad2_data_by_date_v3";
const WAREHOUSE_KEY = "sklad2_warehouse_v1";
// Остатки второго склада («Бестужевская») — отдельно от списка 1С; нужны для сравнения остатков.
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

/* ==================== Модалки: открыть/закрыть (по id или по элементу) ==================== */
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
// «LocalOnly» здесь и ниже — записать на устройство, не считая это правкой для отправки на сервер
// (сортировка, смена выбранной заявки и т.п.).
function saveDataByDateLocalOnly() {
  try { localStorage.setItem(DATA_BY_DATE_KEY, JSON.stringify(dataByDate)); } catch (e) {}
}
function saveDataByDate() {
  saveDataByDateLocalOnly();
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
// Сменщик: сервер отдаёт данные только сессии, начатой входом по паролю (sklad_session_ok); иная — выходит.
// Проверка при входе, при возврате на вкладку и раз в минуту.
async function shiftSessionAlive() {
  if (!isShift() || !window.Auth) return true;
  let r;
  try { r = await Auth.sb.rpc("sklad_session_ok"); } catch (e) { return true; }   // нет связи — не выкидываем
  if (r.error || r.data !== false) return true;
  Auth.logout("Этот вход больше не действует — войдите по логину и паролю.");
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
function saveWarehouseLocalOnly() {
  if (isShift()) return;   // у сменщика склад — каталог с сервера, не сохраняется
  try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
}
function saveWarehouse() {
  if (isShift()) return;
  saveWarehouseLocalOnly();
  scheduleSync();
}

let dataByDate = loadDataByDate();
let warehouse = loadWarehouse(); // { parts: [{code,name,qty,model}], consumables: [] }
/* Учёт ведётся ЗАЯВКАМИ: каждая — запись в dataByDate с ключом «ГГГГ-ММ-ДД» (первая за день)
   или «ГГГГ-ММ-ДД#2», «#3»… (следующие). Номер заявки не хранится: это порядковый номер среди
   всех заявок в порядке создания (поле created; у старых заявок без него — по дате), поэтому
   на всех устройствах он одинаков. Заявка, созданная задним числом (hleb выбирает дату),
   получает следующий номер и стоит в списке сверху, а не уходит вниз к своей дате. Не выбрана
   заявка (currentDate = null) — рабочее поле пустое. */
let currentDate = null;
const TICKET_KEY_RE = /^\d{4}-\d{2}-\d{2}(#\d+)?$/;
function emptyEntry() { return { sections: emptySections(), counts: {}, checked: {} }; }
// Момент создания заявки: поле created, у старых заявок без него — полночь МСК её даты (+ номер за день).
function ticketCreatedAt(k) {
  const e = dataByDate[k];
  if (e && e.created) return e.created;
  return Date.parse(k.slice(0, 10) + "T00:00:00+03:00") + (k.indexOf("#") >= 0 ? parseInt(k.split("#")[1], 10) : 1);
}
function ticketCmp(a, b) { return (ticketCreatedAt(a) - ticketCreatedAt(b)) || (a < b ? -1 : a > b ? 1 : 0); }
function ticketKeys() { return Object.keys(dataByDate).filter((k) => TICKET_KEY_RE.test(k)).sort(ticketCmp); }
function ticketNumberMap() { const m = {}; ticketKeys().forEach((k, i) => { m[k] = i + 1; }); return m; }
function entryItemCount(e) {
  return ((e && e.sections && e.sections.parts) || []).length;
}
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
  if (sync) saveDataByDate(); else saveDataByDateLocalOnly();
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
// Галочки «учтено» — личные для аккаунта: у hleb синхронизируются между его устройствами
// (ключ potreblenie_checks_v1_hleb, см. sync.js), у остальных — только на этом устройстве.
const CHECKS_KEY = "sklad2_checks_v1_" + (MY_LOGIN || "");
let localChecks = {};
try { localChecks = JSON.parse(localStorage.getItem(CHECKS_KEY) || "{}") || {}; } catch (e) { localChecks = {}; }
let checksSaved = JSON.stringify(localChecks);
function saveChecksLocal() {
  checksSaved = JSON.stringify(localChecks);
  try { localStorage.setItem(CHECKS_KEY, checksSaved); } catch (e) {}
}
function persistChecks() {
  if (!currentDate) return;
  localChecks[currentDate] = checked;
  if (typeof renderTicketList === "function") renderTicketList();   // кружок «всё учтено» (меняют и галочки, и состав заявки)
  if (JSON.stringify(localChecks) === checksSaved) return;   // отметки не менялись (например, просто сменили заявку)
  saveChecksLocal();
  if (MY_LOGIN === "hleb") scheduleSync();
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
// Записывает рабочие переменные обратно в выбранную заявку. false — записывать нечего или нельзя.
function storeCurrent() {
  if (!currentDate) return false;
  persistChecks();
  if (!canEditCurrent()) return false;
  dataByDate[currentDate] = Object.assign({}, dataByDate[currentDate], { sections, counts, checked: {} });
  return true;
}
function persistCurrent() { if (storeCurrent()) saveDataByDate(); }
// При смене выбранной заявки: введённое сохраняется, но само переключение — не правка.
function persistCurrentLocalOnly() { if (storeCurrent()) saveDataByDateLocalOnly(); }

/* ==================== Отмена/повтор — общий механизм для «Учёта», «Склада» и «1С» ====================
   Вкладка передаёт, как снять снимок состояния и как восстановить его из снимка, и id кнопок ↶/↷. */
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

/* Находит строку таблицы по индексу позиции в МАССИВЕ данных (data-index), а не по номеру строки
   на экране: таблицы фильтруются и группируются, и номер строки с индексом не совпадает.
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
