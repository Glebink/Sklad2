/* Учёт потребления — вкладка «Заказы» (только hleb): заказы деталей от ремонтников.
   Ремонтник (роль repair, ../zakaz/) набирает детали и отправляет заказ — он появляется здесь.
   hleb собирает: у каждой детали «выдано» (по умолчанию — сколько просили), статус заказа —
   ✓ готово / ~ собрано частично / ✕ отмена (ремонтник видит его у себя). «Перенести в учёт» кладёт
   выданное в последнюю сегодняшнюю заявку на учёт (нет — создаёт) и отмечает заказ «Учтено».
   Данные — таблица parts_orders (items: [{ code, name, qty, issued? }]), права — на сервере (RLS).
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
let orders = [], ordCurrent = null, ordChannel = null;
try { ordCurrent = sessionStorage.getItem("sklad2_sel_order"); } catch (e) {}
function canOrders() { return MY_LOGIN === "hleb"; }
function ordModeOn() { return currentTab === "orders" && canOrders(); }
function ordSelected() { return orders.find((o) => o.id === ordCurrent) || null; }
const ORD_STATUS = {
  new:     { icon: "●", text: "Новый", cls: "ord-st-new" },
  ready:   { icon: "✓", text: "Готово", cls: "ord-st-ready" },
  partial: { icon: "~", text: "Собрано частично", cls: "ord-st-partial" },
  cancel:  { icon: "✕", text: "Отмена", cls: "ord-st-cancel" }
};
// Сколько выдано: число у детали; не поставлено — выдано всё, что просили (при отмене — ничего)
function ordIssued(o, it) { return it.issued != null ? it.issued : o.status === "cancel" ? 0 : it.qty; }
function ordAuthor(o) { return o.author_name || o.author; }
function ordWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- загрузка ---------- */
async function loadOrders() {
  if (!canOrders() || !window.Auth) return;
  const r = await Auth.withTimeout(Auth.sb.from("parts_orders").select("*").order("sent_at"), 15000);
  if (r.error) throw r.error;
  orders = (r.data || []).filter((o) => o.sent_at).map((o) => ({ ...o, items: Array.isArray(o.items) ? o.items : [] }));
  if (ordCurrent && !ordSelected()) ordCurrent = null;
  renderOrdersBadge();
  if (ordModeOn()) ordRender();
}
function startOrdersRealtime() {   // новый заказ или правка ремонтника приходят сразу
  if (ordChannel || !canOrders() || !window.Auth || !Auth.sb.channel) return;
  try {
    ordChannel = Auth.sb.channel("parts_orders_all")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_orders" }, () => { loadOrders().catch(() => {}); })
      .subscribe();
  } catch (e) { ordChannel = null; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && syncUserOk) loadOrders().catch(() => {}); });

/* ---------- отрисовка ---------- */
function renderOrdersBadge() {
  const n = orders.filter((o) => o.status === "new").length, b = document.getElementById("ordBadge");
  b.textContent = n; b.hidden = !n;
}
function selectOrder(id) {
  ordCurrent = id && orders.some((o) => o.id === id) ? id : null;
  try { if (ordCurrent) sessionStorage.setItem("sklad2_sel_order", ordCurrent); else sessionStorage.removeItem("sklad2_sel_order"); } catch (e) {}
  ordRender();
  window.scrollTo(0, 0);
}
function ordRender() {
  updateLayoutClasses();
  syncStickyTopHeight(true);
  if (!ordModeOn()) return;
  renderOrdersList();
  renderOrderView();
}
function renderOrdersList() {
  // новые — сверху (раньше отправленные — выше); остальные — свежие сверху
  const list = orders.slice().sort((a, b) => ((a.status === "new") === (b.status === "new")
    ? (a.status === "new" ? a.sent_at.localeCompare(b.sent_at) : b.sent_at.localeCompare(a.sent_at))
    : (a.status === "new" ? -1 : 1)));
  document.getElementById("ordCards").innerHTML = list.length ? list.map((o) => {
    const st = ORD_STATUS[o.status], acc = o.status === "ready" || o.status === "partial";
    return `<button class="t-card${o.id === ordCurrent ? " sel" : ""}" data-id="${escapeHtml(o.id)}">`
      + `<div class="t-row"><span class="ord-author">${escapeHtml(ordAuthor(o))}</span><span class="ord-badge ${st.cls}" title="${st.text}">${st.icon}</span><span class="t-date">${ordWhen(o.sent_at)}</span></div>`
      + `<div class="t-row t-sub"><span>${pluralRu(o.items.length, "позиция", "позиции", "позиций")}</span>`
      + (acc ? `<span class="${o.accounted_at ? "ord-acc" : "ord-noacc"}">${o.accounted_at ? "Учтено" : "Не учтено"}</span>` : `<span class="${st.cls}">${st.text}</span>`)
      + `</div></button>`;
  }).join("") : `<div class="t-empty">Заказов от ремонтников пока нет.</div>`;
}
function renderOrderView() {
  const o = ordSelected();
  if (!o) return;
  const locked = !!o.accounted_at;   // перенесённый в учёт заказ больше не правится
  document.getElementById("ordTitle").textContent = ordAuthor(o) + " · " + ordWhen(o.sent_at);
  document.querySelectorAll("#ordStatusBtns [data-st]").forEach((b) => {
    b.classList.toggle("on", b.dataset.st === o.status);
    b.disabled = locked;
  });
  document.getElementById("ordBody").innerHTML = o.items.length ? o.items.map((it, i) => {
    const w = it.code ? oneCInfoFor(it.code, it) : null, iss = ordIssued(o, it);
    return `<tr data-i="${i}"${iss < it.qty ? ` class="ord-short"` : ""}>`
      + `<td class="code">${it.code ? `<span class="code-text" data-code="${escapeHtml(it.code)}">${formatCodeDisplay(it.code)}</span>` : "—"}</td>`
      + `<td class="name"><div class="main-name">${escapeHtml(it.name)}</div>${w && w.qty != null ? `<span class="ord-oc" title="Остаток 1С">${w.qty}</span>` : ""}</td>`
      + `<td class="ord-num">${it.qty}</td>`
      + `<td class="ord-num ord-iss"><input type="text" class="ord-iss-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${iss}"${locked ? " disabled" : ""} aria-label="Выдано"></td></tr>`;
  }).join("") : `<tr><td colspan="4" class="wh-empty">Позиций нет.</td></tr>`;
  const canMove = (o.status === "ready" || o.status === "partial") && !locked && o.items.some((it) => ordIssued(o, it) > 0);
  const btn = document.getElementById("ordToTicketBtn");
  btn.disabled = !canMove;
  btn.textContent = locked ? "✓ Учтено " + ordWhen(o.accounted_at) : "Перенести в учёт";
  document.getElementById("ordAccState").textContent = locked ? "" : (o.status === "ready" || o.status === "partial") ? "Не учтено" : o.status === "new" ? "Поставьте статус, потом перенесите в учёт." : "";
}

/* ---------- правка: статус, «выдано» ---------- */
async function ordSave(o, patch) {
  try {
    const r = await Auth.withTimeout(Auth.sb.from("parts_orders").update(patch).eq("id", o.id).select("*"), 15000);
    if (r.error) throw r.error;
    if (r.data && r.data[0]) Object.assign(o, r.data[0], { items: Array.isArray(r.data[0].items) ? r.data[0].items : [] });
    return true;
  } catch (e) {
    alert("Не удалось сохранить заказ (нет связи?): " + ((e && e.message) || e));
    await loadOrders().catch(() => {});
    return false;
  } finally {
    renderOrdersBadge();
    if (ordModeOn()) { renderOrdersList(); renderOrderView(); }
  }
}
document.getElementById("ordStatusBtns").addEventListener("click", (e) => {
  const b = e.target.closest("[data-st]"), o = ordSelected();
  if (!b || !o || o.accounted_at || b.dataset.st === o.status) return;
  ordSave(o, { status: b.dataset.st, items: o.items });
});
document.getElementById("ordBody").addEventListener("input", (e) => {
  const inp = e.target.closest(".ord-iss-input");
  if (inp) { const d = inp.value.replace(/\D+/g, ""); if (d !== inp.value) inp.value = d; }
});
document.getElementById("ordBody").addEventListener("change", (e) => {
  const inp = e.target.closest(".ord-iss-input"), o = ordSelected();
  if (!inp || !o || o.accounted_at) return;
  const it = o.items[+inp.closest("tr").dataset.i], v = parseInt(inp.value, 10);
  it.issued = isNaN(v) ? it.qty : Math.max(0, v);
  ordSave(o, { items: o.items });
});
document.getElementById("ordBody").addEventListener("keydown", (e) => {   // Enter — к следующей детали
  if (e.key !== "Enter" || !e.target.classList.contains("ord-iss-input")) return;
  e.preventDefault();
  const all = Array.from(document.querySelectorAll("#ordBody .ord-iss-input"));
  const next = all[all.indexOf(e.target) + 1];
  if (next) next.focus(); else e.target.blur();
});
document.getElementById("ordBody").addEventListener("focusin", (e) => {
  if (e.target.classList.contains("ord-iss-input")) setTimeout(() => { try { e.target.select(); } catch (err) {} }, 0);
});

/* ---------- перенос в учёт ---------- */
// Последняя сегодняшняя заявка на учёт; нет — создаётся новая (от hleb).
function todayTicketKey() {
  const d = todayStr(), keys = ticketKeys().filter((k) => k.slice(0, 10) === d);
  if (keys.length) return keys[keys.length - 1];
  let key = d;
  for (let n = 2; dataByDate[key]; n++) key = d + "#" + n;
  dataByDate[key] = emptyEntry();
  dataByDate[key].created = Date.now();
  if (MY_LOGIN) dataByDate[key].by = MY_LOGIN;
  return key;
}
document.getElementById("ordToTicketBtn").addEventListener("click", async () => {
  const o = ordSelected();
  if (!o || o.accounted_at) return;
  const lines = o.items.map((it) => ({ it, qty: ordIssued(o, it) })).filter((l) => l.qty > 0);
  if (!lines.length) return;
  if (!confirm("Перенести в учёт за сегодня: " + pluralRu(lines.length, "позицию", "позиции", "позиций") + " из заказа " + ordAuthor(o) + "?")) return;
  // сначала отметка на сервере — без связи перенос не выполняется, иначе можно перенести дважды
  if (!(await ordSave(o, { accounted_at: new Date().toISOString(), items: o.items })) || !o.accounted_at) return;
  rebuildCrossIndexes();
  persistCurrentLocalOnly();
  const key = todayTicketKey(), e = entryFor(key);
  lines.forEach(({ it, qty }) => {
    // в «Учёте» позиция — как на «Складе» (код и название склада), если она там есть
    const w = it.code ? warehouseInfoFor(it.code, it.name) : null;
    const item = { code: w ? w.code : (it.code || ""), name: w ? w.name : it.name };
    const k = countKey("parts", item);
    if (e.counts[k] === undefined) { e.sections.parts.push(item); e.counts[k] = 0; }
    e.counts[k] += qty;
  });
  if (currentDate === key) bindCurrent();
  saveDataByDate();
  renderTicketList();
  document.getElementById("ordAccState").textContent = "Перенесено в заявку № " + ticketNumberMap()[key] + " за сегодня.";
});

/* ---------- список, назад ---------- */
document.getElementById("ordCards").addEventListener("click", (e) => {
  const c = e.target.closest(".t-card");
  if (c) selectOrder(c.dataset.id);
});
document.getElementById("ordBackBtn").addEventListener("click", () => selectOrder(null));
