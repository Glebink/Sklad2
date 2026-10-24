/* Учёт потребления — Вкладка «1С»: справочник, модели по названию, связь со складом по коду, переходы, фильтр, правка, отмена/повтор, перенос на склад.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
/* ==================== ВКЛАДКА 1C: справочник номенклатуры ====================
   Только код + наименование. Отдельное хранилище, не связано со складом. */
const ONEC_KEY = "sklad2_onec_v1";

function loadOneC() {
  // Нет данных на устройстве — пусто: 1С приходит с сервера при первом обмене.
  try {
    const parsed = JSON.parse(localStorage.getItem(ONEC_KEY));
    if (parsed && Array.isArray(parsed.parts)) {
      foldStock(parsed).parts.forEach((it) => { if (typeof it.qty !== "number") it.qty = 0; });
      return parsed;
    }
  } catch (e) {}
  return emptySections();
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
  warehouse.parts.forEach((it) => {
    const model = detectModelFromName(it.name);
    if (model && it.model === undefined) { it.model = model; touched = true; }
    // Метку из названия на СКЛАДЕ убираем всегда — она живёт в поле model
    const cleaned = stripModelTag(it.name);
    if (cleaned && cleaned !== it.name) { it.name = cleaned; touched = true; }
  });
  onec.parts.forEach((it) => {
    const model = detectModelFromName(it.name);
    if (model && it.model === undefined) { it.model = model; touched = true; } // название в 1С не чистим
  });
  if (touched) {
    try { localStorage.setItem(WAREHOUSE_KEY, JSON.stringify(warehouse)); } catch (e) {}
    try { localStorage.setItem(ONEC_KEY, JSON.stringify(onec)); } catch (e) {}
  }
  return touched;
}
const migrationTouchedAtStartup = runModelMigrationOnce();

const selectedOC = { parts: new Set() };

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
  onec.parts.forEach((it, index) => {
    codeVariants(it.code).forEach((c) => {
      (map[c] = map[c] || []).push({ section: "parts", index, name: it.name });
    });
  });
  return map;
}

/* code -> название позиции на складе */
function buildWarehouseIndex() {
  const map = {};
  warehouse.parts.forEach((it, index) => {
    codeVariants(it.code).forEach((c) => {
      (map[c] = map[c] || []).push({ name: it.name, ocName: it.ocName || "", qty: it.qty || 0, code: it.code, model: it.model || "", model2: it.model2 || "", section: "parts", index });
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
    store.parts.forEach((it) => {
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
// Пустое состояние и заголовок фильтра.
function ocAfterRender() {
  const n = document.querySelectorAll("#oc-body-parts tr[data-index]").length;
  const empty = document.getElementById("oc-body-empty");
  if (empty) empty.hidden = n > 0;
  updateOcFilterUI();
}
function renderOneCAll() {
  // Индекс код→позиция должен быть свежим ДО построения строк (переход «1С» ↔ «Склад»).
  rebuildCrossIndexes();
  renderOcRows("parts");
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
  const shown = document.querySelectorAll("#oc-body-parts tr[data-index]").length;
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
  const code = document.getElementById("ocEditCode").value.trim();
  const name = document.getElementById("ocEditName").value.trim();
  if (!name) { closeOcEdit(); return; }
  // проверка дубля кода
  if (code && onec[section].some((it, i) => i !== index && it.code === code)) {
    alert("Позиция с таким кодом уже есть в 1C."); return;
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
  onec[section][index] = updated;
  syncModelByCode(code, model, model2, [updated.name]);   // модель едина для склада и 1С
  saveOneC();
  saveWarehouseLocalOnly();
  renderWarehouseAll();
  renderOneCAll();
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

/* ==================== Отмена / повтор во вкладке 1C ==================== */
function ocSnapshot() { return JSON.stringify(onec); }
function restoreOcSnapshot(json) {
  const before = onec;
  onec = JSON.parse(json);
  selectedOC.parts.clear();
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
