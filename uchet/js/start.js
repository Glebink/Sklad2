/* Учёт потребления — Меню разделов, запуск приложения и вход, поля количества, копирование кода, service worker.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
  // «Учёт потребления» — мы уже здесь: просто закрыть меню
  document.getElementById("modUchetBtn").addEventListener("click", () => panel.classList.remove("open"));
})();

/* ==================== Старт ==================== */
loadSortState();
reapplySavedSort();
renderAll();
renderTicketList();
updateAddPanelVisibility();
renderWarehouseAll();
// Вкладка из адреса (#warehouse / #onec / #inv) — открыта колесом мыши или после обновления страницы.
// Сменщику «Склад» и «1С» недоступны.
// #today (QR-код на складе): после входа и обмена с сервером открыть последнюю заявку за сегодня,
// а если её нет — создать (от имени вошедшего аккаунта).
// Кнопки только для hleb — сразу по роли, сохранённой на устройстве (core.js: Auth.cachedRole),
// а не после ответа сервера при входе: иначе они появлялись с задержкой в несколько секунд.
document.getElementById("tabInvBtn").hidden = !canInventory();
{ const qb = document.getElementById("qrShiftBtn"); if (qb) qb.hidden = MY_LOGIN !== "hleb"; }
let openTodayPending = false;
(function () {
  const h = (location.hash || "").replace("#", "");
  if (h === "today") openTodayPending = true;   // #today снимается после открытия заявки (вход может перезагрузить страницу)
  else if ((h === "warehouse" || h === "onec" || h === "inv") && !isShift()) switchTab(h);
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
        document.getElementById("tabInvBtn").hidden = !canInventory();   // инвентаризация — только hleb
        if (invOpen && !canInventory()) switchTab("onec");
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
