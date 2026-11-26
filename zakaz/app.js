'use strict';
/* Заявки ремонтника на детали (роль repair).
   Ремонтник создаёт заявку, набирает детали с подсказками (поиск и остаток 1С — как в «Учёте»)
   и нажимает «Отправить». Дописывать и править можно, пока заявка новая или собирается: во время сборки
   правку принимает hleb (или отказывает — тогда список возвращается к принятому, base_items).
   Статусы ставит hleb во вкладке «Заказы» учёта: ◷ сборка, ✓ готово, ~ собрано частично, ✕ отмена;
   у каждой детали он отмечает «выдано» — ремонтник видит, чего не хватило.
   Данные — таблица parts_orders (items: [{ code, name, qty, issued? }]); права проверяет сервер (RLS):
   ремонтник видит и меняет только свои заявки, и только пока они новые или собираются.
   Детали для подсказок — каталог potreblenie_catalog_v1 из sklad_kv (названия, коды, модели, остаток 1С). */
const APP_VERSION = "v2.0";   // меняется вместе с uchet/js/core.js, baza/app.js и CACHE_NAME в sw.js
const CATALOG_KEY = "sklad2_zakaz_catalog_v1";   // каталог и свои заявки — на устройстве, чтобы открывалось без связи
const ORDERS_KEY = "sklad2_zakaz_orders_v1";
const SAVE_DELAY_MS = 600;

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function plural(n, a, b, c) { const m = n % 10, h = n % 100; return n + " " + (m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c)); }
function sb() { return window.Auth && Auth.sb; }
function errText(e) { return (e && (e.message || e.error_description || e.error)) || String(e); }
function loadLocal(key, def) { try { return JSON.parse(localStorage.getItem(key) || "null") || def; } catch (e) { return def; } }
function saveLocal(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
function openModal(id) { $(id).classList.add("open"); }
function closeModal(id) { $(id).classList.remove("open"); }
function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- роль: сюда только ремонтник; остальных — в учёт ---------- */
let ROLE = null, LOGIN = "";
try { const c = window.Auth && Auth.cachedRole(); if (c) { ROLE = c.role; LOGIN = c.login || ""; } } catch (e) {}
function leaveIfNotRepair() {
  if (!ROLE || ROLE === "repair") return false;
  location.replace(LOGIN === "hleb" ? "../uchet/#orders" : "../uchet/");
  return true;
}
if (!leaveIfNotRepair()) { try { localStorage.setItem("sklad2_last_module", "zakaz"); } catch (e) {} }
$("appVersionBadge").textContent = APP_VERSION;

/* ---------- состояние ---------- */
let catalog = loadLocal(CATALOG_KEY, { parts: [] });
const ordersKey = () => ORDERS_KEY + "_" + LOGIN;   // у каждого ремонтника — свои (общий телефон)
let orders = loadLocal(ordersKey(), []);   // свои заявки по порядку создания
let currentId = null;
try { currentId = sessionStorage.getItem("sklad2_zakaz_sel"); } catch (e) {}
function current() { return orders.find((o) => o.id === currentId) || null; }
function orderNumber(o) { return orders.indexOf(o) + 1; }
// Править можно, пока заявка новая или собирается (то же правило на сервере)
function editable(o) { return !!o && (o.status === "new" || o.status === "picking"); }
// Во время сборки: правки после начала сборки ждут, пока hleb примет или откажет
const bare = (list) => JSON.stringify((list || []).map((it) => [it.code || "", it.name, it.qty]));
function waitsApproval(o) { return o.status === "picking" && bare(o.items) !== bare(o.base_items); }

const STATUS = {
  draft:   { icon: "", text: "Черновик", cls: "zk-st-draft" },
  sent:    { icon: "●", text: "Отправлена", cls: "zk-st-sent" },
  picking: { icon: `<svg class="st-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`, text: "Собирается", cls: "zk-st-picking" },
  ready:   { icon: "✓", text: "Готово", cls: "zk-st-ready" },
  partial: { icon: "~", text: "Собрано частично", cls: "zk-st-partial" },
  cancel:  { icon: "✕", text: "Отмена", cls: "zk-st-cancel" }
};
function statusOf(o) { return o.status !== "new" ? STATUS[o.status] || STATUS.sent : o.sent_at ? STATUS.sent : STATUS.draft; }

/* ---------- раскладка: список / заявка ---------- */
function updateLayout() {
  const o = current();
  document.body.classList.toggle("no-ticket", !o);
  document.body.classList.toggle("has-ticket", !!o);
  $("zkEmpty").hidden = !!o;
  $("zkView").hidden = !o;
  $("zkHeadTitle").textContent = o ? "Заявка № " + orderNumber(o) + " · " + fmtWhen(o.created_at) : "Заявки на детали";
}
function selectOrder(id) {
  currentId = id && orders.some((o) => o.id === id) ? id : null;
  try { if (currentId) sessionStorage.setItem("sklad2_zakaz_sel", currentId); else sessionStorage.removeItem("sklad2_zakaz_sel"); } catch (e) {}
  render();
  window.scrollTo(0, 0);
}
$("zkBackBtn").addEventListener("click", () => selectOrder(null));
function render() { renderList(); updateLayout(); renderView(); }

function renderList() {
  const list = orders.slice().reverse();   // новые сверху
  $("zkCards").innerHTML = list.length ? list.map((o) => {
    const st = statusOf(o), n = o.items.length;
    return `<button class="t-card${o.id === currentId ? " sel" : ""}" data-id="${esc(o.id)}">`
      + `<div class="t-row"><span class="mono">№ ${orderNumber(o)}</span>`
      + (st.icon ? `<span class="zk-badge ${st.cls}" title="${st.text}">${st.icon}</span>` : "")
      + `<span class="t-date">${fmtWhen(o.created_at)}</span></div>`
      + `<div class="t-row t-sub"><span>${plural(n, "позиция", "позиции", "позиций")}</span><span class="${st.cls}">${st.text}</span></div>`
      + `</button>`;
  }).join("") : `<div class="t-empty">Заявок нет. Создайте кнопкой «+».</div>`;
}
$("zkCards").addEventListener("click", (e) => {
  const card = e.target.closest(".t-card");
  if (card) selectOrder(card.dataset.id);
});

function renderView() {
  const o = current();
  if (!o) return;
  const st = statusOf(o), can = editable(o), done = o.status !== "new" && o.status !== "picking";
  $("zkViewTitle").textContent = "Заявка № " + orderNumber(o) + " · " + fmtWhen(o.created_at);
  $("zkStatus").className = "zk-status " + st.cls;
  // у черновика в заголовке статус не пишем (в списке — «Черновик»)
  $("zkStatus").innerHTML = st === STATUS.draft ? "" : (st.icon ? st.icon + " " : "") + esc(st.text);
  $("zkAddPanel").hidden = !can;
  document.body.classList.toggle("zk-done", done);
  document.body.classList.toggle("zk-editable", can);
  $("zkBody").innerHTML = o.items.length ? o.items.map((it, i) => {
    const issued = issuedOf(o, it), cls = !done || issued >= it.qty ? "" : issued <= 0 ? "zk-short" : "zk-part";
    return `<tr data-i="${i}"${cls ? ` class="${cls}"` : ""}><td class="zk-n">${i + 1}</td>`
      + `<td class="code">${it.code ? esc(it.code) : "—"}</td><td class="name">${esc(it.name)}</td>`
      + `<td class="zk-num">${can ? `<input type="text" class="zk-qty" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${it.qty}" aria-label="Количество">` : it.qty}</td>`
      + `<td class="zk-num zk-issued-col">${done ? issued : ""}</td>`
      + `<td class="zk-del-col">${can ? `<button class="iconbtn zk-del" title="Убрать из заявки" aria-label="Убрать">✕</button>` : ""}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="wh-empty">${can ? "Добавьте детали строкой сверху." : "Позиций нет."}</td></tr>`;
  renderFoot(o);
}
// Сколько выдано: hleb ставит число у детали; не поставил — выдано всё (при отмене — ничего)
function issuedOf(o, it) { return it.issued != null ? it.issued : o.status === "cancel" ? 0 : it.qty; }
function renderFoot(o) {
  const foot = $("zkFoot");
  if (o.status === "new" && !o.sent_at) {
    // круглые: корзина слева, «отправить» (самолётик) справа
    foot.innerHTML = `<button class="zk-round zk-drop" id="zkDropBtn" title="Удалить черновик" aria-label="Удалить черновик"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>`
      + `<button class="zk-round zk-send" id="zkSendBtn" title="Отправить" aria-label="Отправить"${o.items.length ? "" : " disabled"}><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.6 10.6 20.3 3.3c.9-.4 1.8.4 1.5 1.4l-4.2 15.6c-.3 1-1.4 1.4-2.2.8l-4.6-3.4-2.4 2.3c-.4.4-1.1.2-1.2-.4l-.6-4.3 9.7-8.6c.2-.2-.1-.5-.3-.3L5.9 13.1l-3.2-1.1c-.8-.3-.8-1.1-.1-1.4z"/></svg></button>`;
  } else if (o.status === "new") {
    foot.innerHTML = `<p class="zk-note">Отправлена ${fmtWhen(o.sent_at)}. Пока заявку не начали собирать, её можно дописать или поправить.</p>`;
  } else if (o.status === "picking") {
    foot.innerHTML = `<p class="zk-note${waitsApproval(o) ? " zk-wait" : ""}">${waitsApproval(o)
      ? "Изменения отправлены — ждут подтверждения кладовщика. Если он откажет, список вернётся к прежнему."
      : "Заявку собирают. Поправить ещё можно — изменения подтвердит кладовщик."}</p>`;
  } else {
    const short = o.items.filter((it) => issuedOf(o, it) < it.qty).length;
    foot.innerHTML = `<p class="zk-note">${o.status === "cancel" ? "Заявка отменена." : short ? "Выдано не всё: жёлтые строки — выдано частично, красные — не выдано." : "Всё выдано."}</p>`;
  }
}

/* ---------- правка заявки ---------- */
const saveTimers = {};
function scheduleSave(o) {
  saveLocal(ordersKey(), orders);
  clearTimeout(saveTimers[o.id]);
  saveTimers[o.id] = setTimeout(() => saveItems(o), SAVE_DELAY_MS);
  setDot("dirty");
}
async function saveItems(o) {
  delete saveTimers[o.id];
  try {
    const r = await Auth.withTimeout(sb().from("parts_orders").update({ items: o.items }).eq("id", o.id).select("id"), 15000);
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) {   // заявку уже собирают (стоит статус) — сервер правку не принял
      alert("Заявку уже собрали — изменить её нельзя. Если нужно что-то ещё, создайте новую заявку.");
      await loadOrders();
      return;
    }
    setDot("ok");
  } catch (e) {
    setDot("err", "Не сохранено: " + errText(e) + ". Повторю, когда появится связь.");
    saveTimers[o.id] = setTimeout(() => saveItems(o), 10000);
  }
}
function setDot(state, title) {
  const d = $("syncDot");
  d.className = "sync-dot" + (state === "ok" ? "" : " " + state);
  d.title = title || "";
}

$("zkNewBtn").addEventListener("click", async () => {
  const empty = orders.find((o) => !o.sent_at && !o.items.length);   // пустой черновик уже есть — открываем его
  if (empty) { selectOrder(empty.id); return; }
  try {
    const r = await Auth.withTimeout(sb().from("parts_orders").insert({ items: [] }).select("*").single(), 15000);
    if (r.error) throw r.error;
    orders.push(normalize(r.data));
    saveLocal(ordersKey(), orders);
    selectOrder(r.data.id);
    setTimeout(() => { try { $("newItemName").focus(); } catch (e) {} }, 50);
  } catch (e) { alert("Не удалось создать заявку (нет связи?): " + errText(e)); }
});

// модель для подсказок: Все / YGW 4.0 / YGW 5.0 / 9Bot (у детали модель — model или model2)
const MODEL_KEY = "sklad2_zakaz_model_v1";
let model = "";
try { model = localStorage.getItem(MODEL_KEY) || ""; } catch (e) {}
function setModel(m) {
  model = m;
  try { localStorage.setItem(MODEL_KEY, m); } catch (e) {}
  $("zkModel").querySelectorAll(".ms-opt").forEach((b) => b.classList.toggle("active", (b.dataset.model || "") === m));
}
setModel(model);
$("zkModel").addEventListener("click", (e) => {
  const b = e.target.closest(".ms-opt");
  if (!b) return;
  setModel(b.dataset.model || "");
  if (nameInput.value.trim()) renderSuggest();
});
function catalogForModel() {
  return model ? { parts: catalog.parts.filter((it) => it.model === model || it.model2 === model) } : catalog;
}

// строка добавления: деталь из подсказки (или своим текстом) + количество
let picked = null;
const nameInput = $("newItemName"), qtyInput = $("newItemQty"), box = $("addSuggestBox");
function closeSuggest() { box.classList.remove("open"); box.innerHTML = ""; }
function renderSuggest() {
  const q = nameInput.value;
  $("newItemClear").classList.toggle("show", !!q);
  if (!q.trim()) { closeSuggest(); return; }
  const found = searchStore(catalogForModel(), q);
  box.innerHTML = found.length ? found.map((r, i) => {
    const models = [r.model, r.model2].filter(Boolean).map((m) => `<span class="suggest-model">${esc(m)}</span>`).join("");
    const oc = r.ocqty != null ? `<span class="suggest-oc-qty">${r.ocqty}</span>` : "";
    return `<div class="suggest-item" data-i="${i}">${oc}<span class="code">${esc(r.code || "—")}</span> — ${esc(r.name)}${models}</div>`;
  }).join("") : `<div class="suggest-empty">${model ? "У " + esc(model) + " не найдено — выберите «Все»" : "В каталоге не найдено"} или добавьте своим названием.</div>`;
  box.classList.add("open");
  box.querySelectorAll(".suggest-item").forEach((el) => el.addEventListener("click", () => {
    const r = found[+el.dataset.i];
    picked = { code: r.code || "", name: r.name };
    nameInput.value = r.name;
    closeSuggest();
    qtyInput.focus();
  }));
}
nameInput.addEventListener("input", () => { picked = null; renderSuggest(); });
// крестик только чистит: фокус не ставим — иначе на телефоне снова вылезает клавиатура
$("newItemClear").addEventListener("click", () => { nameInput.value = ""; picked = null; renderSuggest(); nameInput.blur(); });
qtyInput.addEventListener("input", () => { const d = qtyInput.value.replace(/\D+/g, ""); if (d !== qtyInput.value) qtyInput.value = d; });
document.addEventListener("click", (e) => { if (!$("zkAddPanel").contains(e.target) && !$("zkModel").contains(e.target)) closeSuggest(); });
function addItem() {
  const o = current(), name = nameInput.value.trim();
  if (!editable(o) || !name) return;
  const it = picked && picked.name === name ? picked : { code: "", name };
  const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  const same = o.items.find((x) => x.code === it.code && x.name === it.name);   // та же деталь — количество прибавляется
  if (same) same.qty += qty; else o.items.push({ code: it.code, name: it.name, qty });
  nameInput.value = ""; qtyInput.value = ""; picked = null; closeSuggest();
  $("newItemClear").classList.remove("show");
  scheduleSave(o);
  render();
  nameInput.focus();
}
$("addItemBtn").addEventListener("click", addItem);
[nameInput, qtyInput].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); }));

$("zkBody").addEventListener("change", (e) => {
  const inp = e.target.closest(".zk-qty"), o = current();
  if (!inp || !editable(o)) return;
  const it = o.items[+inp.closest("tr").dataset.i];
  const q = parseInt(inp.value, 10);
  if (q > 0) it.qty = q; else inp.value = it.qty;
  scheduleSave(o);
  renderFoot(o);
});
$("zkBody").addEventListener("input", (e) => {
  const inp = e.target.closest(".zk-qty");
  if (inp) { const d = inp.value.replace(/\D+/g, ""); if (d !== inp.value) inp.value = d; }
});
$("zkBody").addEventListener("click", (e) => {
  const del = e.target.closest(".zk-del"), o = current();
  if (!del || !editable(o)) return;
  o.items.splice(+del.closest("tr").dataset.i, 1);
  scheduleSave(o);
  render();
});
$("zkFoot").addEventListener("click", async (e) => {
  const o = current();
  if (!o) return;
  if (e.target.closest("#zkSendBtn")) {
    if (!o.items.length) return;
    clearTimeout(saveTimers[o.id]);
    try {
      const r = await Auth.withTimeout(sb().from("parts_orders").update({ items: o.items, sent_at: new Date().toISOString() }).eq("id", o.id).select("*"), 15000);
      if (r.error) throw r.error;
      if (r.data && r.data[0]) Object.assign(o, normalize(r.data[0]));
      saveLocal(ordersKey(), orders);
      setDot("ok");
      render();
    } catch (err) { alert("Не удалось отправить (нет связи?): " + errText(err)); }
  }
  if (e.target.closest("#zkDropBtn")) {
    if (o.items.length && !confirm("Удалить черновик заявки № " + orderNumber(o) + "?")) return;
    try {
      const r = await Auth.withTimeout(sb().from("parts_orders").delete().eq("id", o.id), 15000);
      if (r.error) throw r.error;
      orders = orders.filter((x) => x.id !== o.id);
      saveLocal(ordersKey(), orders);
      selectOrder(null);
    } catch (err) { alert("Не удалось удалить: " + errText(err)); }
  }
});

/* ---------- загрузка с сервера ---------- */
function normalize(o) { return { ...o, items: Array.isArray(o.items) ? o.items : [] }; }
async function loadOrders() {
  const r = await Auth.withTimeout(sb().from("parts_orders").select("id, items, base_items, status, created_at, sent_at, updated_at").order("created_at"), 15000);
  if (r.error) throw r.error;
  const fresh = (r.data || []).map(normalize);
  // несохранённая правка на устройстве важнее того, что пришло
  fresh.forEach((f) => { const mine = orders.find((o) => o.id === f.id); if (mine && saveTimers[f.id]) f.items = mine.items; });
  orders = fresh;
  saveLocal(ordersKey(), orders);
  if (currentId && !current()) currentId = null;
  render();
}
async function loadCatalog() {
  const r = await Auth.withTimeout(sb().from("sklad_kv").select("value").eq("key", "potreblenie_catalog_v1").maybeSingle(), 15000);
  if (r.error || !r.data || !r.data.value || !Array.isArray(r.data.value.parts)) return;
  catalog = { parts: r.data.value.parts.map((it) => ({ code: it.code || "", name: it.name || "", model: it.model || "", model2: it.model2 || "", ocqty: it.ocqty, keys: it.keys || "" })) };
  saveLocal(CATALOG_KEY, catalog);
}
async function refresh() {
  try { await Promise.all([loadOrders(), loadCatalog(), loadMe()]); setDot("ok"); }
  catch (e) { setDot("err", "Нет связи с сервером — показаны сохранённые на устройстве заявки."); }
}
let channel = null;
function startRealtime() {   // статус от hleb приходит сразу
  if (channel || !sb() || !sb().channel) return;
  try {
    channel = sb().channel("parts_orders_mine")
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_orders" }, () => { loadOrders().catch(() => {}); })
      .subscribe();
  } catch (e) { channel = null; }
}

/* ---------- аккаунт: логин, имя (задаёт hleb в profiles.name), фото (user_avatars) ---------- */
const ME_KEY = "sklad2_zakaz_me_v1";   // имя и фото — на устройстве, чтобы показывались сразу
let me = loadLocal(ME_KEY + "_" + LOGIN, { name: "", avatar: "" });
function renderMe() {
  const a = me.avatar || "";
  $("profileAvatar").hidden = !a; $("profileIcon").style.display = a ? "none" : "";
  if (a) $("profileAvatar").src = a;
  $("zkAvatarBig").hidden = !a; $("zkAvatarNone").style.display = a ? "none" : "";
  if (a) $("zkAvatarBig").src = a;
  $("zkAvatarDel").hidden = !a;
  $("zkMeLogin").textContent = LOGIN || "—";
  $("zkMeName").textContent = me.name || "—";
}
async function loadMe() {
  const [p, a] = await Promise.all([
    Auth.withTimeout(sb().from("profiles").select("name").eq("login", LOGIN).maybeSingle(), 15000),
    Auth.withTimeout(sb().from("user_avatars").select("data").eq("login", LOGIN).maybeSingle(), 15000)
  ]);
  if (p.error || a.error) return;
  me = { name: (p.data && p.data.name) || "", avatar: (a.data && a.data.data) || "" };
  saveLocal(ME_KEY + "_" + LOGIN, me);
  renderMe();
}
// Фото: обрезка по центру в квадрат 256 px, JPEG — около 20–40 КБ
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const n = 256, s = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas");
      c.width = c.height = n;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, n, n);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("не удалось прочитать картинку")); };
    img.src = url;
  });
}
$("zkAvatarPick").addEventListener("click", () => $("zkAvatarFile").click());
$("zkAvatarFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = await shrinkImage(f);
    const r = await Auth.withTimeout(sb().from("user_avatars").upsert({ login: LOGIN, data }), 15000);
    if (r.error) throw r.error;
    me.avatar = data; saveLocal(ME_KEY + "_" + LOGIN, me); renderMe();
  } catch (err) { alert("Не удалось сохранить фото (нет связи?): " + errText(err)); }
});
$("zkAvatarDel").addEventListener("click", async () => {
  if (!confirm("Убрать фото?")) return;
  try {
    const r = await Auth.withTimeout(sb().from("user_avatars").delete().eq("login", LOGIN), 15000);
    if (r.error) throw r.error;
    me.avatar = ""; saveLocal(ME_KEY + "_" + LOGIN, me); renderMe();
  } catch (err) { alert("Не удалось убрать фото: " + errText(err)); }
});
$("profileBtn").addEventListener("click", () => {
  $("zkAccountLine").textContent = LOGIN ? "" : "Вход не выполнен.";
  renderMe();
  openModal("zkAccountOverlay");
});
$("zkAccountClose").addEventListener("click", () => closeModal("zkAccountOverlay"));
$("zkAccountOverlay").addEventListener("click", (e) => { if (e.target.id === "zkAccountOverlay") closeModal("zkAccountOverlay"); });
$("zkLogoutBtn").addEventListener("click", () => { closeModal("zkAccountOverlay"); if (window.Auth) Auth.logout(); });

/* ---------- старт ---------- */
if (currentId && !current()) currentId = null;
render();
renderMe();
if (window.Auth) {
  Auth.gate({
    onLogin: async () => {
      try {
        const r = await Auth.loadRole();
        if (r) { ROLE = r.role; LOGIN = r.login; if (leaveIfNotRepair()) return; }
        if (!orders.length) { orders = loadLocal(ordersKey(), []); render(); }
        me = loadLocal(ME_KEY + "_" + LOGIN, me); renderMe();
      } catch (e) {}
      await refresh();
      startRealtime();
    },
    onLogout: () => {}
  });
} else {
  $("zkCards").innerHTML = `<div class="t-empty">Не загрузилась библиотека входа — нет связи с сервером.</div>`;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && window.Auth) refresh(); });
