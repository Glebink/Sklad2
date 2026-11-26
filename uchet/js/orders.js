/* Учёт потребления — вкладка «Заказы» (только hleb): заказы деталей от ремонтников.
   Ремонтник (роль repair, ../zakaz/) набирает детали и отправляет заказ — он появляется здесь.
   hleb собирает: у каждой детали «выдано» (по умолчанию — сколько просили), статус заказа —
   ◷ сборка / ✓ готово / ~ собрано частично / ✕ отмена (ремонтник видит его у себя). «Перенести в учёт» кладёт
   выданное в последнюю сегодняшнюю заявку на учёт (нет — создаёт) и отмечает заказ «Учтено».
   Сборка: hleb работает со своей копией списка (hleb_items, с «выдано»), ремонтник ещё правит свой (items).
   Его правки сами не подмешиваются: у кнопки ⟳ появляется «!», hleb смотрит изменения и принимает
   (копия обновляется, base_items := items) или отказывает (items := base_items). На ✓ / ~ / ✕ список ремонтника
   становится списком сборки. Корзина на карточке — удалить заказ.
   Данные — таблица parts_orders (items: [{ code, name, qty, issued? }]), права — на сервере (RLS).
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
let orders = [], ordCurrent = null, ordChannel = null;
try { ordCurrent = sessionStorage.getItem("sklad2_sel_order"); } catch (e) {}
function canOrders() { return MY_LOGIN === "hleb"; }
function ordModeOn() { return currentTab === "orders" && canOrders(); }
function ordSelected() { return orders.find((o) => o.id === ordCurrent) || null; }
const ORD_STATUS = {
  new:     { icon: "●", text: "Новый", cls: "ord-st-new" },
  picking: { icon: `<svg class="st-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`, text: "Сборка", cls: "ord-st-picking" },
  ready:   { icon: "✓", text: "Готово", cls: "ord-st-ready" },
  partial: { icon: "~", text: "Собрано частично", cls: "ord-st-partial" },
  cancel:  { icon: "✕", text: "Отмена", cls: "ord-st-cancel" }
};
// Сколько выдано: число у детали; не поставлено — выдано всё, что просили (при отмене — ничего)
function ordIssued(o, it) { return it.issued != null ? it.issued : o.status === "cancel" ? 0 : it.qty; }
// Список, который видит и собирает hleb: при сборке — своя копия, иначе — список заказа
function ordItems(o) { return o.status === "picking" && Array.isArray(o.hleb_items) ? o.hleb_items : o.items; }
const ordKey = (it) => (it.code || "") + "\u0001" + it.name;
const ordBare = (list) => (list || []).map((it) => ({ code: it.code || "", name: it.name, qty: it.qty }));
// Ремонтник поменял список во время сборки, а hleb ещё не принял и не отказал
function ordPending(o) { return o.status === "picking" && JSON.stringify(ordBare(o.items)) !== JSON.stringify(ordBare(o.base_items)); }
function ordDiff(o) {
  const was = new Map(ordBare(o.base_items).map((it) => [ordKey(it), it])), now = ordBare(o.items), out = [];
  now.forEach((it) => {
    const b = was.get(ordKey(it));
    if (!b) out.push({ kind: "add", it });
    else if (b.qty !== it.qty) out.push({ kind: "qty", it, from: b.qty });
    was.delete(ordKey(it));
  });
  was.forEach((it) => out.push({ kind: "del", it }));
  return out;
}
// Имя и фото ремонтника: имя — profiles.name (задаёт hleb), фото — user_avatars (ставит сам ремонтник)
let ordPeople = {};
try { ordPeople = JSON.parse(localStorage.getItem("sklad2_order_people_v1") || "{}") || {}; } catch (e) {}
function ordAuthor(o) { return (ordPeople[o.author] && ordPeople[o.author].name) || o.author; }
function ordAva(o) {
  const p = ordPeople[o.author], name = ordAuthor(o);
  return p && p.avatar ? `<img class="ord-ava" src="${escapeHtml(p.avatar)}" alt="">`
    : `<span class="ord-ava ord-ava-none" aria-hidden="true">${escapeHtml(name.trim().charAt(0).toUpperCase())}</span>`;
}
async function loadPeople() {
  const [p, a] = await Promise.all([
    Auth.withTimeout(Auth.sb.from("profiles").select("login, name").eq("role", "repair"), 15000),
    Auth.withTimeout(Auth.sb.from("user_avatars").select("login, data"), 15000)
  ]);
  if (p.error || a.error) return;
  const next = {};
  (p.data || []).forEach((r) => { if (r.login) next[r.login] = { name: r.name || "", avatar: "" }; });
  (a.data || []).forEach((r) => { (next[r.login] = next[r.login] || { name: "", avatar: "" }).avatar = r.data; });
  ordPeople = next;
  try { localStorage.setItem("sklad2_order_people_v1", JSON.stringify(ordPeople)); } catch (e) {}
  if (ordModeOn()) ordRender();
}
function ordWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- загрузка ---------- */
async function loadOrders() {
  if (!canOrders() || !window.Auth) return;
  if (!orders.length || !Object.keys(ordPeople).length) loadPeople().catch(() => {});
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
      .on("postgres_changes", { event: "*", schema: "public", table: "user_avatars" }, () => { loadPeople().catch(() => {}); })
      .subscribe();
  } catch (e) { ordChannel = null; }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && syncUserOk && canOrders()) { loadPeople().catch(() => {}); loadOrders().catch(() => {}); }
});

/* ---------- отрисовка ---------- */
function renderOrdersBadge() {
  const n = orders.filter((o) => o.status === "new" || ordPending(o)).length, b = document.getElementById("ordBadge");
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
    const st = ORD_STATUS[o.status] || ORD_STATUS.new, acc = o.status === "ready" || o.status === "partial";
    return `<button class="t-card${o.id === ordCurrent ? " sel" : ""}" data-id="${escapeHtml(o.id)}">`
      + `<div class="t-row">${ordAva(o)}<span class="ord-author">${escapeHtml(ordAuthor(o))}</span><span class="ord-badge ${st.cls}" title="${st.text}">${st.icon}</span><span class="t-date">${ordWhen(o.sent_at)}</span></div>`
      + `<div class="t-row t-sub"><span>${pluralRu(ordItems(o).length, "позиция", "позиции", "позиций")}</span>`
      + (ordPending(o) ? `<span class="ord-changed" title="Ремонтник изменил список">! изменён</span>` : "")
      + (acc ? `<span class="${o.accounted_at ? "ord-acc" : "ord-noacc"}">${o.accounted_at ? "Учтено" : "Не учтено"}</span>` : `<span class="${st.cls}">${st.text}</span>`)
      + `<span class="ord-del" role="button" tabindex="0" title="Удалить заказ" aria-label="Удалить заказ">${ORD_TRASH}</span>`
      + `</div></button>`;
  }).join("") : `<div class="t-empty">Заказов от ремонтников пока нет.</div>`;
}
const ORD_TRASH = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>`;
function renderOrderView() {
  const o = ordSelected();
  if (!o) return;
  const list = ordItems(o);
  const locked = !!o.accounted_at;   // перенесённый в учёт заказ больше не правится
  document.getElementById("ordTitle").innerHTML = ordAva(o) + `<span>${escapeHtml(ordAuthor(o) + " · " + ordWhen(o.sent_at))}</span>`;
  document.querySelectorAll("#ordStatusBtns [data-st]").forEach((b) => {
    b.classList.toggle("on", b.dataset.st === o.status);
    b.disabled = locked;
  });
  document.getElementById("ordBody").innerHTML = list.length ? list.map((it, i) => {
    const w = it.code ? oneCInfoFor(it.code, it) : null, iss = ordIssued(o, it);
    return `<tr data-i="${i}"${iss <= 0 ? ` class="ord-short"` : iss < it.qty ? ` class="ord-part"` : ""}>`
      + `<td class="code">${it.code ? `<span class="code-text" data-code="${escapeHtml(it.code)}">${formatCodeDisplay(it.code)}</span>` : "—"}</td>`
      // ✓ «собрано» — слева в ячейке названия (без своего столбца)
      + `<td class="name"><div class="ord-name-row"><button class="chk-toggle ord-chk${it.done ? " on" : ""}" title="Собрано"${locked ? " disabled" : ""}>${it.done ? "✓" : ""}</button>`
      + `<div class="main-name">${escapeHtml(it.name)}</div></div>${w && w.qty != null ? `<span class="ord-oc" title="Остаток 1С">${w.qty}</span>` : ""}</td>`
      // «Шт» — сколько выдаём: сначала сколько просили, нет столько — вписываем, сколько есть (в углу — сколько просили)
      + `<td class="ord-num ord-iss"><input type="text" class="ord-iss-input${iss !== it.qty ? " has-ask" : ""}" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${iss}"${locked ? " disabled" : ""} aria-label="Шт, выдаём">`
      + (iss !== it.qty ? `<span class="ord-ask" title="Просили">из ${it.qty}</span>` : "") + `</td></tr>`;
  }).join("") : `<tr><td colspan="3" class="wh-empty">Позиций нет.</td></tr>`;   // Код, Наименование (с ✓), Шт
  const canMove = (o.status === "ready" || o.status === "partial") && !locked && o.items.some((it) => ordIssued(o, it) > 0);
  document.getElementById("ordRefreshBtn").classList.toggle("pending", ordPending(o));
  const btn = document.getElementById("ordToTicketBtn");
  btn.disabled = !canMove;
  btn.textContent = locked ? "✓ Учтено " + ordWhen(o.accounted_at) : "Перенести в учёт";
  document.getElementById("ordAccState").textContent = locked ? "" : (o.status === "ready" || o.status === "partial") ? "Не учтено"
    : o.status === "new" ? "Нажмите «Сборка», потом ✓ или ~ — и перенесите в учёт."
    : o.status === "picking" ? (ordPending(o) ? "Ремонтник изменил список — нажмите «!» у кнопки обновления." : "Идёт сборка. Собрали — ✓ или ~.") : "";
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
const ordCopy = (x) => JSON.parse(JSON.stringify(x || []));
function ordStatusPatch(o, st) {
  if (st === "picking") return { status: st, hleb_items: ordCopy(o.items), base_items: ordBare(o.items) };   // начало сборки — своя копия
  if (o.status === "picking") return { status: st, items: ordCopy(ordItems(o)), base_items: null };          // итог сборки — ремонтнику
  return { status: st, items: o.items };
}
document.getElementById("ordStatusBtns").addEventListener("click", (e) => {
  const b = e.target.closest("[data-st]"), o = ordSelected();
  if (!b || !o || o.accounted_at || b.dataset.st === o.status) return;
  if (o.status === "picking" && ordPending(o) && !confirm("Ремонтник изменил список, а вы изменения не приняли. Они будут отклонены. Продолжить?")) return;
  ordSave(o, ordStatusPatch(o, b.dataset.st));
});
document.getElementById("ordBody").addEventListener("input", (e) => {
  const inp = e.target.closest(".ord-iss-input");
  if (inp) { const d = inp.value.replace(/\D+/g, ""); if (d !== inp.value) inp.value = d; }
});
document.getElementById("ordBody").addEventListener("change", (e) => {
  const inp = e.target.closest(".ord-iss-input"), o = ordSelected();
  if (!inp || !o || o.accounted_at) return;
  const v = parseInt(inp.value, 10);
  ordEditItem(o, +inp.closest("tr").dataset.i, (it) => { it.issued = isNaN(v) ? it.qty : Math.max(0, v); });
});
// Правка строки у hleb (сколько выдаём, галочка «собрано»): у нового заказа — значит, сборка началась
function ordEditItem(o, i, change) {
  const set = (list) => { change(list[i]); return list; };
  if (o.status === "new") ordSave(o, { status: "picking", hleb_items: set(ordCopy(o.items)), base_items: ordBare(o.items) });
  else if (o.status === "picking") ordSave(o, { hleb_items: set(ordCopy(ordItems(o))) });
  else ordSave(o, { items: set(o.items) });
}
document.getElementById("ordBody").addEventListener("click", (e) => {
  const b = e.target.closest(".chk-toggle"), o = ordSelected();
  if (!b || !o || o.accounted_at) return;
  b.classList.toggle("on"); b.textContent = b.classList.contains("on") ? "✓" : "";   // сразу, не дожидаясь сервера
  ordEditItem(o, +b.closest("tr").dataset.i, (it) => { if (it.done) delete it.done; else it.done = true; });
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

/* ---------- ⟳: обновить; при «!» — правки ремонтника: принять / отказать ---------- */
function ordRenderChanges(o) {
  const rows = ordDiff(o).map((d) => {
    const name = `<b>${escapeHtml(d.it.name)}</b>${d.it.code ? ` <span class="mono">${escapeHtml(d.it.code)}</span>` : ""}`;
    return d.kind === "add" ? `<li class="ord-ch-add">+ ${name} — ${d.it.qty} шт</li>`
      : d.kind === "del" ? `<li class="ord-ch-del">− ${name} — убрал</li>`
      : `<li class="ord-ch-qty">~ ${name} — было ${d.from}, стало ${d.it.qty}</li>`;
  });
  document.getElementById("ordChTitle").textContent = ordAuthor(o) + " изменил список";
  document.getElementById("ordChList").innerHTML = rows.join("");
}
document.getElementById("ordRefreshBtn").addEventListener("click", () => {
  const o = ordSelected();
  if (o && ordPending(o)) { ordRenderChanges(o); openModal("ordChangesOverlay"); return; }
  loadPeople().catch(() => {}); loadOrders().catch(() => {});
});
document.getElementById("ordChAccept").addEventListener("click", () => {
  const o = ordSelected();
  closeModal("ordChangesOverlay");
  if (!o || !ordPending(o)) return;
  // список сборки — по новому списку ремонтника; уже поставленное «выдано» сохраняется (не больше, чем просят)
  const had = new Map(ordItems(o).map((it) => [ordKey(it), it]));
  const next = ordBare(o.items).map((it) => {
    const h = had.get(ordKey(it));
    if (!h) return it;
    const n = { ...it };
    if (h.issued != null) n.issued = Math.min(h.issued, it.qty);
    if (h.done) n.done = true;
    return n;
  });
  ordSave(o, { hleb_items: next, base_items: ordBare(o.items) });
});
document.getElementById("ordChReject").addEventListener("click", () => {
  const o = ordSelected();
  closeModal("ordChangesOverlay");
  if (o && ordPending(o)) ordSave(o, { items: ordCopy(o.base_items) });
});
document.getElementById("ordChClose").addEventListener("click", () => closeModal("ordChangesOverlay"));
document.getElementById("ordChangesOverlay").addEventListener("click", (e) => { if (e.target.id === "ordChangesOverlay") closeModal("ordChangesOverlay"); });

/* ---------- удаление заказа ---------- */
async function ordDelete(id) {
  const o = orders.find((x) => x.id === id);
  if (!o || !confirm("Удалить заказ " + ordAuthor(o) + " от " + ordWhen(o.sent_at) + "? Ремонтник его тоже больше не увидит.")) return;
  try {
    const r = await Auth.withTimeout(Auth.sb.from("parts_orders").delete().eq("id", id), 15000);
    if (r.error) throw r.error;
    orders = orders.filter((x) => x.id !== id);
    if (ordCurrent === id) selectOrder(null); else ordRender();
    renderOrdersBadge();
  } catch (e) { alert("Не удалось удалить (нет связи?): " + ((e && e.message) || e)); }
}

/* ---------- список, назад ---------- */
document.getElementById("ordCards").addEventListener("click", (e) => {
  const del = e.target.closest(".ord-del");
  if (del) { e.preventDefault(); e.stopPropagation(); ordDelete(del.closest(".t-card").dataset.id); return; }
  const c = e.target.closest(".t-card");
  if (c) selectOrder(c.dataset.id);
});
document.getElementById("ordBackBtn").addEventListener("click", () => selectOrder(null));
