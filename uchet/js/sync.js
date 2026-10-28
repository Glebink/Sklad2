/* Учёт потребления — Резервная копия и синхронизация с Supabase: обмен, слияние правок, история сохранений, Realtime, окно аккаунта.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
  "potreblenie_inventory_v1",
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
   Сервер к тому же хранит предыдущие версии каждого ключа (sklad_kv_log): за 7 дней,
   не чаще одной в 10 минут. */
// Сменщик синхронизирует только данные учёта по дням; остальные ключи ему сервер не отдаёт.
// Галочки «учтено» у hleb синхронизируются между его устройствами (у остальных — только на устройстве).
// В браузере это тот же ключ, что и раньше: sklad2_checks_v1_hleb (= CHECKS_KEY).
const CHECKS_SYNC_KEY = "potreblenie_checks_v1_hleb";
const SYNC_KEYS = isShift() ? ["potreblenie_data_by_date_v3"]
  : BACKUP_KEYS.slice(0, 6).concat(MY_LOGIN === "hleb" ? [CHECKS_SYNC_KEY] : []);   // в бэкапе они названы по-старому (potreblenie_*)
const MERGE_NO_BASE = [CHECKS_SYNC_KEY, "potreblenie_inventory_v1"];   // сливаются и без базы — см. runSync
const SYNC_FIELD = {
  potreblenie_data_by_date_v3: "dataByDate",
  potreblenie_warehouse_v1: "warehouse",
  potreblenie_onec_v1: "onec",
  potreblenie_transfer_list_v1: "transferList",
  potreblenie_best_stock_v1: "bestStock",
  potreblenie_inventory_v1: "inventory",
  potreblenie_checks_v1_hleb: "checks"
};
const SYNC_LABEL = {
  potreblenie_data_by_date_v3: "Учёт",
  potreblenie_warehouse_v1: "Склад",
  potreblenie_onec_v1: "1С",
  potreblenie_transfer_list_v1: "Список перемещения",
  potreblenie_best_stock_v1: "Остатки Бестужевской",
  potreblenie_inventory_v1: "Инвентаризация",
  potreblenie_checks_v1_hleb: "Галочки «учтено»"
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

function setSyncStatus(state, text) {
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
  const { added, removed, changed } = diffItemList(oldStore && oldStore.parts, newStore && newStore.parts, (it) => it.qty);
  added.forEach((it) => lines.push("+ " + labelItem(it) + " (" + it.qty + ")"));
  removed.forEach((it) => lines.push("− " + labelItem(it)));
  changed.forEach((c) => lines.push("~ " + labelItem(c.item) + "  " + c.from + " → " + c.to));
  return lines;
}
// Диф для одного дня «Учёта» — там количество лежит отдельно, в counts,
// под ключом countKey(section, item).
function diffDateEntry(oldEntry, newEntry) {
  const lines = [];
  const oldCounts = (oldEntry && oldEntry.counts) || {};
  const newCounts = (newEntry && newEntry.counts) || {};
  const sec = "parts";
  const oldList = (oldEntry && oldEntry.sections && oldEntry.sections[sec]) || [];
  const newList = (newEntry && newEntry.sections && newEntry.sections[sec]) || [];
  const { added, removed } = diffItemList(oldList, newList, null);
  added.forEach((it) => lines.push("+ " + labelItem(it) + " (" + (newCounts[countKey(sec, it)] || 0) + ")"));
  removed.forEach((it) => lines.push("− " + labelItem(it)));
  const oldMap = new Map(oldList.map((it) => [itemDiffKey(it), it]));
  newList.forEach((it) => {
    const oldItem = oldMap.get(itemDiffKey(it));
    if (!oldItem) return;
    const a = oldCounts[countKey(sec, oldItem)] || 0;
    const b = newCounts[countKey(sec, it)] || 0;
    if (a !== b) lines.push("~ " + labelItem(it) + "  " + a + " → " + b);
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
    if (payload.warehouse && Array.isArray(payload.warehouse.parts)) {
      warehouse = payload.warehouse;
      try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
    }
    if (payload.onec && Array.isArray(payload.onec.parts)) {
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
    if (payload.checks && typeof payload.checks === "object" && !Array.isArray(payload.checks)) {
      localChecks = payload.checks;    // bindCurrent ниже привяжет галочки выбранной заявки
      saveChecksLocal();
    }
    if (payload.inventory && typeof payload.inventory === "object" && !Array.isArray(payload.inventory)) {
      inventory = payload.inventory;
      try { localStorage.setItem(INV_KEY, JSON.stringify(inventory)); } catch (e) {}
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
    selectedWH.parts.clear();
    selectedOC.parts.clear();
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
    if (!isTypingNow()) invRender();   // во время ввода количества таблицу не перерисовываем
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
  try { return foldSyncValue(rk, JSON.parse(raw)); } catch (e) { return undefined; }
}
// Присланное с сервера значение должно быть нужной формы — иначе не применяем.
function isValidRemote(rk, v) {
  if (rk === "potreblenie_data_by_date_v3") return !!v && typeof v === "object" && !Array.isArray(v);
  if (rk === "potreblenie_warehouse_v1" || rk === "potreblenie_onec_v1") {
    return !!v && Array.isArray(v.parts);
  }
  if (rk === "potreblenie_transfer_list_v1") return Array.isArray(v);
  if (rk === "potreblenie_best_stock_v1") return !!v && Array.isArray(v.rows);
  if (rk === "potreblenie_inventory_v1" || rk === CHECKS_SYNC_KEY) return !!v && typeof v === "object" && !Array.isArray(v);
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
  b = b || emptyEntry();
  const out = mergeObj(b, l, r, null);
  const sb = b.sections || {}, sl = l.sections || {}, sr = r.sections || {};
  out.sections = emptySections();
  out.sections.parts = mergeItemList("parts", sb.parts, sl.parts, sr.parts, (bi, li, ri) => mergeObj(bi, li, ri, null));
  const alive = new Set(out.sections.parts.map((it) => countKey("parts", it)));
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
// Объект «id → запись» (инвентаризации, галочки по заявкам): удалённая с одной стороны и не тронутая
// с другой запись удаляется; изменённую с обеих сторон сливает mergeOne(база, моя, серверная).
function mergeById(B, L, R, mergeOne) {
  const out = {};
  new Set([].concat(Object.keys(B), Object.keys(L), Object.keys(R))).forEach((id) => {
    const inL = id in L, inR = id in R, inB = id in B;
    if (inL && inR) { out[id] = mEq(L[id], R[id]) ? L[id] : mergeOne(B[id] || {}, L[id], R[id]); return; }
    if (inL) { if (inB && mEq(L[id], B[id])) return; out[id] = L[id]; return; }
    if (inR) { if (inB && mEq(R[id], B[id])) return; out[id] = R[id]; }
  });
  return out;
}
/* Инвентаризация: количества «Склад» хранятся по номеру строки, но после «Обновить из 1С»
   строки сдвигаются — поэтому сливаем по самой позиции (код + название; одинаковые строки
   различаем по порядку), а не по номеру. Список позиций — та сторона, что его обновила.
   Без базы (base = {}) ничего не теряем: позиции, введённые только у меня, добавляются,
   а при разных числах остаётся число сервера. */
function invFactKeys(items) {
  const seen = {};
  return (items || []).map((it) => {
    const k = normItemName(it.code) + "|" + normItemName(it.name);
    seen[k] = (seen[k] || 0) + 1;
    return k + "#" + seen[k];
  });
}
function invFactsByKey(inv) {
  const keys = invFactKeys(inv && inv.items), out = {};
  Object.keys((inv && inv.fact) || {}).forEach((i) => { if (keys[i] !== undefined) out[keys[i]] = inv.fact[i]; });
  return out;
}
function invFactsToIndex(items, byKey) {
  const out = {};
  invFactKeys(items).forEach((k, i) => { if (byKey[k] !== undefined) out[i] = byKey[k]; });
  return out;
}
function mergeInventory(B, L, R) {
  const noBase = Object.keys(B || {}).length === 0;
  return mergeById(B || {}, L, R, (b, l, r) => {
    const out = mergeObj(b, l, r, null);
    out.items = mEq(l.items, r.items) ? l.items : (b.items && mEq(l.items, b.items) ? r.items : (b.items && mEq(r.items, b.items) ? l.items : r.items));
    const bk = invFactsByKey(b), lk = invFactsByKey(l), rk = invFactsByKey(r);
    const fk = noBase ? Object.assign({}, lk, rk) : mergeObj(bk, lk, rk, null);
    out.fact = invFactsToIndex(out.items, fk);
    return out;
  });
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
      out.parts = mergeItemList("parts", B.parts, L.parts, R.parts, mergeStockItem);
      out.consumables = [];
      return out;
    }
    if (rk === "potreblenie_transfer_list_v1") {
      return mergeItemList("t", B, L, R, (b, l, r) => r);
    }
    if (rk === "potreblenie_best_stock_v1") {
      return ((L && L.savedAt) || 0) > ((R && R.savedAt) || 0) ? L : R;   // это выгрузка целиком: берём более свежую
    }
    if (rk === "potreblenie_inventory_v1") return mergeInventory(B, L, R);
    if (rk === CHECKS_SYNC_KEY) {
      // галочки сливаются по позициям заявки
      return mergeById(B, L, R, (b, l, r) => mergeObj(b, l, r, null));
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
  const local = {}, raw0 = {};
  for (const rk of SYNC_KEYS) {
    raw0[rk] = localStorage.getItem(bkToLocal(rk));   // для проверки «не правили ли, пока шёл обмен»
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
    for (const r of (full.data || [])) {
      const value = foldSyncValue(r.key, r.value);
      remote[r.key] = { value, at: r.updated_at, h: await hashValue(value) };
    }
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
    // Галочки — исключение: отметки с этого устройства и с сервера объединяются (база — пусто).
    if (!m && policy === "safe" && MERGE_NO_BASE.indexOf(rk) !== -1 && R) { toMerge.push({ rk, value: mergeSyncValue(rk, {}, L.v, R.value), at: cur }); continue; }
    if (!m && policy === "safe" && !isRestoredPending()) { if (R) toPull.push(rk); continue; }
    const remoteChanged = !m || m.at !== cur;
    const localChanged = !m || m.h !== L.h;
    if (policy === "mine") toPush.push({ rk, at: cur, force: true });
    else if (policy === "server") { if (R) toPull.push(rk); }
    else if (remoteChanged && localChanged) {
      // Галочки и инвентаризация сливаются и без сохранённой базы (тогда база — пусто): введённое не теряется.
      const b0 = base[rk] === undefined && MERGE_NO_BASE.indexOf(rk) !== -1 ? {} : foldSyncValue(rk, base[rk]);
      const mv = (R && m) ? mergeSyncValue(rk, b0, L.v, R.value) : null;
      if (mv === null || mv === undefined) res.conflicts.push(rk);
      else toMerge.push({ rk, value: mv, at: cur });
    }
    else if (remoteChanged) { if (R) toPull.push(rk); }
    else if (localChanged) toPush.push({ rk, at: cur });
    else if (m && m.h === L.h && m.at === cur) bases[rk] = L.v;   // ничего не менялось — запоминаем базу для будущих слияний
  }

  // 5) Пока шли запросы, на устройстве могли что-то поправить. Такие ключи не трогаем
  // (иначе правка затрётся данными сервера) — обмен повторится и учтёт её.
  // Проверка и применение идут подряд без await — правка не может вклиниться между ними.
  const mergedH = {};
  for (const mg of toMerge) mergedH[mg.rk] = await hashValue(mg.value);
  const untouched = (rk) => {
    if (localStorage.getItem(bkToLocal(rk)) === raw0[rk]) return true;
    res.raced = true;
    return false;
  };
  const pull = toPull.filter(untouched), merge = toMerge.filter((mg) => untouched(mg.rk));
  if (pull.length || merge.length) {
    const payload = {};
    pull.forEach((rk) => { payload[SYNC_FIELD[rk]] = remote[rk].value; });
    merge.forEach((mg) => { payload[SYNC_FIELD[mg.rk]] = mg.value; local[mg.rk] = { v: mg.value, h: mergedH[mg.rk] }; });
    applySyncPayload(payload);
  }
  // забрали с сервера
  pull.forEach((rk) => { meta[rk] = { at: remote[rk].at, h: remote[rk].h }; bases[rk] = remote[rk].value; res.pulled.push(rk); });
  // слили правки с обеих сторон — результат отправляем на сервер
  merge.forEach((mg) => { toPush.push({ rk: mg.rk, at: mg.at, merged: true }); res.merged.push(mg.rk); });

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
    if (v && Array.isArray(v.parts)) {
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
