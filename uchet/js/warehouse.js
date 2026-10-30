/* Учёт потребления — Вкладка «Склад»: модели и категории, фильтр, таблица, меню строки, правка позиции, отмена/повтор.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
   Фильтр: Все (вся таблица), Самокаты (Все / YGW 5.0 / YGW 4.0 / 9Bot / Без модели), Инструменты,
   Расходники, Одежда, Остальное. Категория позиции — поле cat (ставится в окне правки);
   если не задана, определяется правилами ниже по названию, коду и модели.
   Только просмотр: фильтр данные не меняет, выбор запоминается на устройстве. */
const WH_CATS = { scooter: "Самокаты", tool: "Инструменты", cons: "Расходники", cloth: "Одежда", other: "Остальное" };
// Правила по порядку: первое сработавшее решает. [категория, поле, выражение]
const WH_CAT_RULES = [
  ["cons", "name", /^(винт|болт|гайка|шайба|саморез|шуруп|заклепка|стяжка|screw|flat gasket|disk-lock|nylon cable|stainless steel collar|стопорная шайба|плоская шайба)/i],
  ["tool", "name", /(^бита|бокорез|^головка семиуг)/i],
  ["cons", "name", /(лента на липучке|^коробка|упаковочн|наклейк|qr-код|жидкий ключ|пломб|лезви)/i],
  ["scooter", "model", /./],
  ["scooter", "code", /^(\d{3}[a-z]{2}\d{2}-|ab|14\.01\.|nbr|6001|6003|16004|e05|врем|00000775|00-00002861|796$|zu001|234jy)/i],
  ["cloth", "name", /(перчат|краги|рукавиц|варежк|куртк|плащ|дождевик|жилет|костюм|комбинезон|брюк|штаны|шорты|футболк|рубашк|свитер|толстовк|халат|фартук|сапог|ботин|кроссовк|обувь|стельк|чулок|носки|носок|шапк|кепк|бейсболк|балаклав|подшлемник|шарф|термобель|бахил)/i],
  ["cons", "name", /(pla-пластик|пластик для 3d|пластик в катушке|филамент|масло|шампун|щетка для мой|щетка для мыть)/i],
  ["other", "name", /(внешний аккумулятор|ящик|органайзер|3d принтер)/i],
  ["tool", "name", /(дрел|шуруповерт|винтоверт|перфоратор|гайковерт|пила|шлифмаш|углошлиф|углоглиф|угловая шлиф|ушм|аккумулятор|удлинитель для бит|лопатка монтаж)/i],
  ["other", "name", /(станок|мойк|пылесос|сварочн|обогреват|пушка тепл|принтер|верстак|стул|кресло|весы|сканер|мышь|светильник|удлинитель|сетевой фильтр|фильтр удлинитель|тройник|картридер|перфопанел|подвес|полк[аи]|система хранения|колесо поворот|кран шаров|шланг|доска магнит|ограждение|знак |лопат|ледоруб|швабр|сгон|аппарат высокого|фильтр для моек|фильтр тонкой|набор для полива|компрессор|соединени|соединител|муфта|поддон|тарелка магнит|держатель инструмента магнит|страховочная подставка)/i],
  ["tool", "name", /(отверт|головок|сверел|насад|бит |бит$|бита|биты|бит-головк|ключ|головк|трещ|вороток|пинцет|нож|кусачк|плоскогуб|пассатиж|длинногуб|клещ|молот|киянк|кувалд|зажим|струбцин|тиски|заклепочник|напильник|рулетк|отсос припоя|фен|полировальная машина|сверл|набор инструмент|инструмент для|экстрактор|плашк|переходник|адаптер|держател[ья]? для бит|держатель бит|редуктор|стаместк|лом|горелк|точильн|гравер|насадк|кордщетк|щетка для дрели|щетка концев|щетка круглая|щетка дисков|щетка металлическая для ушм|ракель|валик|пистолет|опрыскиват|пульверизат|распылит|воронк|набор ремонтника|реанимат|диагностическ|магнитный держатель|шестигранник|борфрез)/i],
  ["cons", "name", /(заклепк|болт м|респиратор|полумаск|очки|щиток|скотч|лент|изолен|этикетк|бумаг|блокнот|картон|пакет|пленк|стрейч|клей|склеиван|активатор|герметик|смазк|обезжир|растворит|уайт|очистит|граффити|удалител|паст|диск|круг|наждач|абразив|губка|микрофибр|вафельн|протирочн|батаре|крона|маркер|резинк|припой|трубк|термоус|эмаль|жидкое стекло|газ |проволок|фум|оргстекло|прокладка|кисть|щетк|щётк|сальник)/i]
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
    if (f && (f.cat === "all" || WH_CATS[f.cat])) return { cat: f.cat, model: f.model || "all" };
  } catch (e) {}
  return { cat: "scooter", model: "all" };
})();
function saveWhFilter() {
  try { localStorage.setItem(WH_FILTER_KEY, JSON.stringify(whFilter)); } catch (e) {}
}
function whMatches(item) {
  if (whFilter.cat === "all") return true;
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
  if (whFilter.cat === "all") return "Все";
  if (whFilter.cat !== "scooter" || whFilter.model === "all") return WH_CATS[whFilter.cat];
  return "Самокаты · " + (whFilter.model === "none" ? "без модели" : whFilter.model);
}
// Пары { item, i } — исходный индекс нужен, иначе кнопки в строках стали бы
// указывать не на те позиции.
function whFilteredPairs(section) {
  return warehouse[section].map((item, i) => ({ item, i })).filter(({ item }) => whMatches(item));
}
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
// Пустое состояние и заголовок фильтра.
function whAfterRender() {
  const n = document.querySelectorAll("#wh-body-parts tr[data-index]").length;
  const empty = document.getElementById("wh-body-empty");
  if (empty) empty.hidden = n > 0;
  updateWhFilterUI();
}
function renderWarehouseAll() {
  // Индекс код→позиция должен быть свежим ДО построения строк (переход «Склад» ↔ «1С»).
  rebuildCrossIndexes();
  renderWhRows("parts");
  whAfterRender();
  if (typeof applyWhSearch === "function") applyWhSearch();
}
function updateWhFilterUI() {
  const shown = document.querySelectorAll("#wh-body-parts tr[data-index]").length;
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
  const code = document.getElementById("whEditCode").value.trim();
  const name = document.getElementById("whEditName").value.trim();
  let qty = parseInt(document.getElementById("whEditQty").value, 10);
  if (isNaN(qty) || qty < 0) qty = 0;
  const [model = "", model2 = ""] = getModelsSwitch(document.getElementById("whEditModel"));
  if (!name) { closeWhEdit(); return; }

  // проверка дублей по коду (у кодов-заглушек 1С одинаковый код у разных позиций — можно)
  if (code && !isAmbiguousCode(code)) {
    const clash = warehouse[section].some((it, i) => i !== index && it.code === code);
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
  const wasPicked = selectedWH[section].has(oldKey);
  warehouse[section][index] = newItem;
  selectedWH[section].delete(oldKey);
  if (wasPicked) selectedWH[section].add(countKey(section, newItem));

  syncModelByCode(code, model, model2, [name, newItem.ocName]);   // модели едины для склада и 1С
  saveWarehouse();
  saveOneCLocalOnly();
  renderOneCAll();
  renderWarehouseAll();
  closeWhEdit();
});

/* ==================== Отмена / повтор на «Складе» ==================== */
const WH_HISTORY_LIMIT = 50;

function whSnapshot() { return JSON.stringify(warehouse); }
function restoreWhSnapshot(json) {
  const before = warehouse;
  warehouse = JSON.parse(json);
  selectedWH.parts.clear();
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
