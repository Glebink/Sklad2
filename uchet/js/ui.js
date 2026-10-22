/* Учёт потребления — Общее поведение интерфейса: «наверх», навигация по совпадениям поиска, закреплённая шапка, копирование/вставка, ноль в числовых полях.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
  {
    const section = "parts";
    const tbody = document.getElementById(bodyPrefix + section);
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
  }
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
