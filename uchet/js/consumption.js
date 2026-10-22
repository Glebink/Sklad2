/* Учёт потребления — Вкладка «Учёт»: таблица позиций заявки, количество, добавление позиции, подсказки, история выдачи, этикетки.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
document.getElementById("body-parts").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("countInput")) e.target.blur();
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
  store.parts.forEach((item) => {
    const name = (item.name || "").toLowerCase();
    const code = (item.code || "").toLowerCase();
    if (nameMatchesQuery(name, q) || code.includes(q)) {
      const r = { section: "parts", code: item.code || "", name: item.name, model: item.model || "", model2: item.model2 || "" };
      if (item.ocqty !== undefined) r.ocqty = item.ocqty;   // у сменщика — остаток 1С из каталога
      if (item.ocName) r.ocName = item.ocName;              // название в 1С — для кодов-заглушек
      results.push(r);
    }
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
  const name = newItemInput.value.trim();
  if (!name) return;
  const code = (addPicked && addPicked.name === name) ? addPicked.code : "";
  const section = "parts";
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
