/* Учёт потребления — Левый столбец: список заявок на учёт, создание, комментарий, удаление; QR-вход для склада.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
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
  const inv = typeof invModeOn === "function" && invModeOn();   // раздел «Инвентаризация» (в виде «1С»)
  document.body.classList.toggle("inv-mode", inv);
  document.body.classList.toggle("inv-none", inv && !invSelected());
  document.body.classList.toggle("has-list", (cons && !QR_KIOSK) || inv);
  document.body.classList.toggle("no-ticket", cons && !currentDate);
  document.body.classList.toggle("has-ticket", cons && !!currentDate);
}
function ticketMatches(key, e, q) {
  // возвращает null (не подходит), [] (подходит по номеру/дате) или список найденных позиций
  const num = ticketNumberMap()[key];
  const head = ("№" + num + " " + num + " " + ticketDateLong(key) + " " + formatShort(key) + " " + (e.note || "")).toLowerCase();
  const found = [];
  ((e.sections && e.sections.parts) || []).forEach((it) => {
    const hay = ((it.name || "") + " " + (it.code || "")).toLowerCase();
    if (hay.indexOf(q) !== -1) found.push({ it, s: "parts" });
  });
  if (found.length) return found;
  return head.indexOf(q) !== -1 ? [] : null;
}
// Личная пометка «всё учтено»: сколько позиций заявки отмечено галочкой на этом устройстве и аккаунте.
// null — в заявке нет позиций (кружок не показываем).
function ticketCheckState(k, e) {
  const items = (e && e.sections && e.sections.parts) || [];
  if (!items.length) return null;
  const ch = localChecks[k] || {};
  return { done: items.filter((it) => ch[countKey("parts", it)]).length, total: items.length };
}
function checkDot(st) {
  if (!st || MY_LOGIN !== "hleb") return "";   // пометка только для аккаунта hleb
  const all = st.done === st.total;
  return `<span class="t-check-dot ${all ? "ok" : "todo"}" title="${all ? "Все позиции отмечены" : "Отмечено " + st.done + " из " + st.total}"></span>`;
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
      + `<div class="t-row"><span class="t-num"><span class="mono">№ ${nums[k]}</span>${checkDot(ticketCheckState(k, e))}</span>${e.note ? `<span class="t-note">${escapeHtml(e.note)}</span>` : ""}<span class="t-date">${ticketDateLong(k)}</span></div>`
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
  selectedCA.parts.clear();
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
// date — дата заявки «ГГГГ-ММ-ДД» (hleb выбирает при создании), по умолчанию сегодня.
function createTicket(note, date) {
  if (shiftTodayTicket()) return;
  persistCurrentLocalOnly();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : todayStr();
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
  const hleb = MY_LOGIN === "hleb";
  const note = document.getElementById("newTicketNote"), date = document.getElementById("newTicketDate");
  note.value = "";
  note.hidden = !hleb;
  date.value = todayStr();
  date.hidden = !hleb;            // дату заявки выбирает только hleb, у остальных — сегодня
  updateNewTicketText();
  openModal("newTicketOverlay");
});
function updateNewTicketText() {
  const d = document.getElementById("newTicketDate").value || todayStr();
  document.getElementById("newTicketText").textContent =
    "Создать новую заявку на учёт № " + (ticketKeys().length + 1) + " за " + formatFull(d) + "?";
}
document.getElementById("newTicketDate").addEventListener("input", updateNewTicketText);
document.getElementById("newTicketNo").addEventListener("click", () => closeModal("newTicketOverlay"));
document.getElementById("newTicketOverlay").addEventListener("click", (e) => {
  if (e.target.id === "newTicketOverlay") closeModal("newTicketOverlay");
});
document.getElementById("newTicketYes").addEventListener("click", () => {
  closeModal("newTicketOverlay");
  const hleb = MY_LOGIN === "hleb";
  createTicket(hleb ? document.getElementById("newTicketNote").value.trim() : "",
               hleb ? document.getElementById("newTicketDate").value : "");
});
document.getElementById("ticketBackBtn").addEventListener("click", () => { if (!QR_KIOSK) selectTicket(null); });
/* ==================== QR-вход для склада (только hleb) ====================
   Скан QR сразу входит в аккаунт sklad и открывает заявку на текущий день (#today).
   В QR — токен; сервер хранит один действующий, «Сгенерировать новый» отменяет старый,
   а через 72 часа код перестаёт действовать сам. */
// Код действует 72 часа с момента выдачи — так же проверяет сервер (функция qr-login).
const QR_TTL_MS = 72 * 3600 * 1000;
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
    const until = d ? new Date(d.getTime() + QR_TTL_MS) : null;
    const fmt = (x) => x.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    line.textContent = until && until <= new Date()
      ? "Срок действия кода истёк " + fmt(until) + " — нажмите «Сгенерировать новый»."
      : "Скан сразу входит в аккаунт sklad и открывает заявку на текущий день." + (until ? " Действует до " + fmt(until) + "." : "");
    box.classList.toggle("qr-expired", !!until && until <= new Date());
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
