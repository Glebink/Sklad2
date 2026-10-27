/* Учёт потребления — Переключение вкладок, сортировка по заголовкам, строки поиска вкладок.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
    if (target === "onec") { renderOneCAll(); invRender(); }
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
  ca: { parts: { col: null, dir: null } },
  wh: { parts: { col: null, dir: null } },
  oc: { parts: { col: null, dir: null } }
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
      if (saved[t] && saved[t].parts) sortState[t].parts = saved[t].parts;
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
    applySortToList(t, "parts");
    updateSortArrows(t, "parts");
  });
}
function sortTable(table, section, col) {
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
    renderOneCAll();
  } else {
    saveWarehouseLocalOnly();
    renderWarehouseAll();
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
  // инвентаризация (в «1С»): строки — позиции выбранной инвентаризации
  { key: "inv", bodyPrefix: "inv-body-", getStore: () => invSearchStore() },
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
