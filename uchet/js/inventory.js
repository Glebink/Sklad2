/* Учёт потребления — Инвентаризация во вкладке «1С» (только hleb).
   Слева список инвентаризаций (как заявки в «Учёте»), «+» создаёт новую с выбранной датой.
   Инвентаризация запоминает список и остатки 1С на момент создания («Обновить из 1С» берёт
   текущие, введённое не пропадает). В столбик «Склад» вводится фактическое количество;
   пустое поле — посчитано «как в 1С», без расхождения. «Итого» — сводка по всему списку:
   «Списать» (в 1С больше, чем по факту) и «Выдать» (по факту больше) с порогом расхождения
   в штуках; выгрузка в Excel и список «Списать» — новой заявкой в «Учёт».
   Хранится в sklad_kv (ключ potreblenie_inventory_v1), синхронизируется как склад и 1С.
   Остатки 1С в приложении инвентаризация не меняет.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
const INV_KEY = "sklad2_inventory_v1";   // { id: { date, created, by, items: [{code,name,qty,model?,model2?,cat?}], fact: { индекс: шт } } }
function loadInventory() {
  try {
    const v = JSON.parse(localStorage.getItem(INV_KEY));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
let inventory = loadInventory();
function saveInventory() {
  try { localStorage.setItem(INV_KEY, JSON.stringify(inventory)); }
  catch (e) {
    // Не сохранилось на устройстве — синхронизация этого не увидит, и число пропадёт. Говорим сразу.
    alert("Не удалось сохранить инвентаризацию на этом устройстве (память браузера заполнена). Последнее введённое число может пропасть — сообщите об этом.");
    return;
  }
  scheduleSync();
}

let invOpen = false, invCurrent = null;
try {
  invOpen = sessionStorage.getItem("sklad2_inv_open") === "1";
  invCurrent = sessionStorage.getItem("sklad2_sel_inv");
} catch (e) {}
function canInventory() { return MY_LOGIN === "hleb"; }
function invModeOn() { return invOpen && currentTab === "onec" && canInventory(); }
function invSelected() { return invCurrent && inventory[invCurrent] ? inventory[invCurrent] : null; }
function invIds() { return Object.keys(inventory).sort((a, b) => (inventory[a].created || 0) - (inventory[b].created || 0)); }
function invNumberOf(id) { return invIds().indexOf(id) + 1; }
function invDateText(d) { const [y, m, dd] = String(d || "").split("-"); return dd ? dd + "." + m + "." + String(y).slice(2) : "—"; }
function invSnapshot() {
  return onec.parts.map((it) => {
    const o = { code: it.code || "", name: it.name || "", qty: it.qty || 0 };
    if (it.model) o.model = it.model;
    if (it.model2) o.model2 = it.model2;
    if (it.cat) o.cat = it.cat;
    return o;
  });
}
// Строки с введённым фактом и расхождением: diff > 0 — по факту больше (выдать), < 0 — меньше (списать).
function invDiffRows(inv) {
  const out = [];
  inv.items.forEach((it, i) => {
    const f = inv.fact[i];
    if (f === undefined) return;
    const diff = f - (it.qty || 0);
    if (diff) out.push({ it, i, fact: f, diff });
  });
  return out;
}

function setInvOpen(on) {
  invOpen = !!on && canInventory();
  try { sessionStorage.setItem("sklad2_inv_open", invOpen ? "1" : "0"); } catch (e) {}
  invRender();
  window.scrollTo(0, 0);
}
function selectInv(id) {
  invCurrent = id && inventory[id] ? id : null;
  try { if (invCurrent) sessionStorage.setItem("sklad2_sel_inv", invCurrent); else sessionStorage.removeItem("sklad2_sel_inv"); } catch (e) {}
  invRender();
  window.scrollTo(0, 0);
}

/* ---------- отрисовка ---------- */
function invRender() {
  updateLayoutClasses();
  syncStickyTopHeight(true);
  if (!invModeOn()) return;
  renderInvList();
  renderInvTable();
}
function renderInvList() {
  const box = document.getElementById("invCards");
  const ids = invIds().reverse();   // новые сверху
  box.innerHTML = ids.length ? ids.map((id) => {
    const inv = inventory[id], n = invNumberOf(id);
    const counted = Object.keys(inv.fact || {}).length, diffs = invDiffRows(inv).length;
    return `<button class="t-card${id === invCurrent ? " sel" : ""}" data-id="${escapeHtml(id)}">`
      + `<div class="t-row"><span class="mono">№ ${n}</span><span class="t-date">${invDateText(inv.date)}</span></div>`
      + `<div class="t-sub">посчитано ${counted} из ${inv.items.length}${diffs ? " · расхождений " + diffs : ""}</div>`
      + `<div class="t-foot"><span class="t-menu-wrap"><span class="t-menu-btn" role="button" tabindex="0" title="Действия">⋮</span>`
      + `<span class="t-menu"><span class="t-act danger" role="button" data-act="del" data-id="${escapeHtml(id)}">🗑 Удалить</span></span></span>`
      + (inv.by ? `<span class="t-author">${escapeHtml(authorLabel(inv.by))}</span>` : "") + `</div>`
      + `</button>`;
  }).join("") : `<div class="t-empty">Инвентаризаций нет. Создайте кнопкой «+».</div>`;
}
/* Фильтр — как в «1С» (меню по заголовку): Все / Самокаты (модели) / Инструменты / Расходники /
   Остальное / Не на складе + «Остаток < N» (по остатку 1С инвентаризации). Хранится на устройстве. */
const INV_FILTER_KEY = "sklad2_inv_filter_v1";
let invFilter = (function () {
  try {
    const f = JSON.parse(localStorage.getItem(INV_FILTER_KEY) || "null");
    if (f && (f.cat === "all" || OC_CATS[f.cat])) return { cat: f.cat, model: f.model || "all", stock: !!f.stock, qty: Number.isFinite(f.qty) ? f.qty : 20 };
  } catch (e) {}
  return { cat: "all", model: "all", stock: false, qty: 20 };
})();
function saveInvFilter() { try { localStorage.setItem(INV_FILTER_KEY, JSON.stringify(invFilter)); } catch (e) {} }
function invFilterTitle() {
  let t = invFilter.cat === "all" ? "Все" : OC_CATS[invFilter.cat];
  if (invFilter.cat === "scooter" && invFilter.model !== "all") t += " · " + (invFilter.model === "none" ? "без модели" : invFilter.model);
  if (invFilter.stock) t += " · < " + invFilter.qty;
  return t;
}
function invMatches(it) {
  if (invFilter.stock && !((it.qty || 0) < (invFilter.qty || 0))) return false;
  if (invFilter.cat === "nowh") { if (it.code && warehouseInfoFor(it.code, it.name)) return false; }
  else if (invFilter.cat !== "all" && ocCatOf(it) !== invFilter.cat) return false;
  if (invFilter.cat !== "scooter" || invFilter.model === "all") return true;
  if (invFilter.model === "none") return ocModelsOf(it).length === 0;
  return ocModelsOf(it).indexOf(invFilter.model) !== -1;
}
function invRowState(inv, i) {
  const f = inv.fact[i];
  if (f === undefined) return { cls: "", diff: "" };
  const d = f - (inv.items[i].qty || 0);
  return { cls: d > 0 ? "inv-more" : d < 0 ? "inv-less" : "inv-equal", diff: d ? (d > 0 ? "+" + d : "−" + -d) : "✓" };
}
// Название в таблице — как на «Складе», если позиция там есть, иначе из 1С.
// Для поиска запоминаем оба: находится и по названию склада, и по названию 1С.
let invShownNames = [];
function invNameOf(it) {
  const w = it.code ? warehouseInfoFor(it.code, it.name) : null;
  return w && w.name ? w.name : it.name;
}
function invSearchStore() {
  const inv = invSelected();
  if (!inv) return { parts: [] };
  return { parts: inv.items.map((it, i) => {
    const shown = invShownNames[i] || it.name;
    return { code: it.code, name: shown === it.name ? shown : shown + " " + it.name };
  }) };
}
function renderInvTable() {
  const inv = invSelected();
  const body = document.getElementById("inv-body-parts");
  if (!inv) { body.innerHTML = ""; return; }
  rebuildCrossIndexes();
  invShownNames = inv.items.map(invNameOf);
  const rows = [];
  inv.items.forEach((it, i) => {
    if (!invMatches(it)) return;
    const st = invRowState(inv, i);
    const f = inv.fact[i];
    rows.push(`<tr data-index="${i}" data-section="parts" class="${st.cls}">
      <td class="code">${it.code ? `<span class="code-text" data-code="${escapeHtml(it.code)}">${formatCodeDisplay(it.code)}</span>` : "—"}</td>
      <td class="name"><div class="main-name">${escapeHtml(invShownNames[i])}</div>${modelBadgesHtml(ocModelsOf(it), true)}</td>
      <td class="inv-num inv-oc">${it.qty || 0}</td>
      <td class="inv-num inv-fact"><input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" class="inv-input" value="${f === undefined ? "" : f}" placeholder="${it.qty || 0}" aria-label="Фактическое количество"><span class="inv-diff">${st.diff}</span></td>
    </tr>`);
  });
  body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="4" class="wh-empty">В этой категории ничего нет</td></tr>`;
  updateInvFilterUI(rows.length);
  updateInvProgress();
  applySearchFns.inv();
}
function updateInvProgress() {
  const inv = invSelected();
  if (!inv) return;
  const el = document.getElementById("invTitle");
  el.textContent = "№ " + invNumberOf(invCurrent) + " · " + invDateText(inv.date) + " · " + Object.keys(inv.fact).length + "/" + inv.items.length;
  el.title = "Инвентаризация № " + invNumberOf(invCurrent) + " от " + invDateText(inv.date) + ": посчитано " + Object.keys(inv.fact).length + " из " + inv.items.length;
}
function updateInvFilterUI(shown) {
  document.getElementById("invFilterTitle").textContent = invFilterTitle();
  document.getElementById("invFilterLabel").textContent = String(shown);
  document.querySelectorAll("#invFilterPanel [data-cat]").forEach((b) => {
    const on = b.dataset.cat === invFilter.cat && (b.dataset.cat !== "scooter" || b.dataset.model === invFilter.model);
    b.classList.toggle("primary", b.dataset.model ? on : b.dataset.cat === invFilter.cat);
  });
  document.getElementById("invStockToggle").classList.toggle("primary", invFilter.stock);
  const q = document.getElementById("invFilterQty");
  if (document.activeElement !== q) q.value = invFilter.qty;
}

/* ---------- ввод факта ---------- */
const invBody = document.getElementById("inv-body-parts");
function invInputRow(input) { return input.closest("tr[data-index]"); }
function invApplyRowState(tr) {
  const inv = invSelected(), i = +tr.dataset.index;
  const st = invRowState(inv, i);
  tr.classList.remove("inv-more", "inv-less", "inv-equal");
  if (st.cls) tr.classList.add(st.cls);
  tr.querySelector(".inv-diff").textContent = st.diff;
}
invBody.addEventListener("input", (e) => {
  const input = e.target.closest(".inv-input");
  if (!input) return;
  const d = input.value.replace(/\D+/g, "");
  if (d !== input.value) input.value = d;
});
invBody.addEventListener("change", (e) => {
  const input = e.target.closest(".inv-input");
  const inv = invSelected();
  if (!input || !inv) return;
  const i = +invInputRow(input).dataset.index;
  const v = input.value.trim();
  if (v === "") delete inv.fact[i]; else inv.fact[i] = parseInt(v, 10);
  saveInventory();
  invApplyRowState(invInputRow(input));
  updateInvProgress();
  renderInvList();
});
// Enter — к следующей позиции, чтобы считать подряд
invBody.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList.contains("inv-input")) return;
  e.preventDefault();
  const inputs = Array.from(invBody.querySelectorAll(".inv-input"));
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) { next.focus(); scrollRowIntoView(next.closest("tr")); } else e.target.blur();
});
invBody.addEventListener("focusin", (e) => {
  if (e.target.classList.contains("inv-input")) setTimeout(() => { try { e.target.select(); } catch (err) {} }, 0);
});

/* ---------- добавление найденного (как в «Учёте») ----------
   Выбрал позицию, ввёл сколько нашёл сейчас — число прибавляется к «Склад».
   Нашёл ещё коробку той же детали — добавляешь ещё, сумма растёт. */
const invAddName = document.getElementById("invAddName");
const invAddQty = document.getElementById("invAddQty");
const invAddBox = document.getElementById("invAddSuggestBox");
const invAddClear = document.getElementById("invAddClear");
let invAddPicked = null;   // { idx, name } — выбранная из подсказки строка инвентаризации
function invAddStore() {
  const inv = invSelected();
  if (!inv) return { parts: [] };
  return { parts: inv.items.map((it, i) => {
    const shown = invShownNames[i] || invNameOf(it);
    return { idx: i, code: it.code, name: shown, alt: shown === it.name ? "" : it.name, model: it.model, model2: it.model2 };
  }) };
}
function invAddReset() {
  invAddName.value = ""; invAddQty.value = ""; invAddPicked = null;
  invAddBox.classList.remove("open"); invAddBox.innerHTML = "";
  invAddClear.classList.remove("show");
}
invAddName.addEventListener("input", () => {
  invAddPicked = null;
  invAddClear.classList.toggle("show", !!invAddName.value);
  renderSuggestionsFrom(invAddBox, invAddName.value, (r) => {
    invAddPicked = r;
    invAddName.value = r.name;
    invAddQty.focus();
  }, invAddStore(), "В этой инвентаризации такой позиции нет.");
});
registerSuggestZone(invAddBox, [invAddName]);
invAddClear.addEventListener("click", () => { invAddReset(); invAddName.focus(); });
invAddQty.addEventListener("input", () => {
  const d = invAddQty.value.replace(/\D+/g, "");
  if (d !== invAddQty.value) invAddQty.value = d;
});
invAddQty.addEventListener("focus", () => setTimeout(() => { try { invAddQty.select(); } catch (e) {} }, 0));
function invAddCommit() {
  const inv = invSelected();
  const name = invAddName.value.trim();
  if (!inv || !name) return;
  let i = invAddPicked && invAddPicked.name === name ? invAddPicked.idx : -1;
  if (i === -1) {
    // набрали без выбора из подсказки — берём, только если совпадение одно
    const found = searchStore(invAddStore(), name);
    if (found.length !== 1) { invAddName.dispatchEvent(new Event("input")); invAddName.focus(); return; }
    i = found[0].idx;
  }
  let qty = parseInt(invAddQty.value, 10);
  if (isNaN(qty) || qty < 1) qty = 1;
  inv.fact[i] = (inv.fact[i] || 0) + qty;
  saveInventory();
  invAddReset();
  renderInvTable();
  renderInvList();
  const tr = rowByDataIndex("inv-body-parts", i);
  if (tr) { scrollRowIntoView(tr); flashRow(tr); }
}
document.getElementById("invAddBtn").addEventListener("click", invAddCommit);
[invAddName, invAddQty].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") invAddCommit(); }));
// Поиск по инвентаризации свёрнут до лупы в строке добавления (как в «Учёте»)
document.body.classList.add("inv-search-collapsed");
(function () {
  const input = document.getElementById("invSearchInput");
  const setOpen = (o) => {
    document.body.classList.toggle("inv-search-collapsed", !o);
    if (o) setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
    try { syncStickyTopHeight(true); } catch (e) {}
  };
  document.getElementById("invSearchToggle").addEventListener("click", () => setOpen(true));
  input.addEventListener("blur", () => setTimeout(() => {
    if (!input.value && !document.getElementById("invSearchBar").contains(document.activeElement)) setOpen(false);
  }, 250));
})();

/* ---------- список, создание, удаление ---------- */
document.getElementById("ocInventoryBtn").addEventListener("click", () => setInvOpen(true));
document.getElementById("invExitBtn").addEventListener("click", () => {
  searchInputs.inv.value = "";   // строка поиска инвентаризации — пустой при следующем открытии
  setInvOpen(false);
});
document.getElementById("invBackBtn").addEventListener("click", () => selectInv(null));
document.getElementById("invNewBtn").addEventListener("click", () => {
  document.getElementById("invNewDate").value = todayStr();
  openModal("invNewOverlay");
});
document.getElementById("invNewNo").addEventListener("click", () => closeModal("invNewOverlay"));
document.getElementById("invNewOverlay").addEventListener("click", (e) => { if (e.target.id === "invNewOverlay") closeModal("invNewOverlay"); });
document.getElementById("invNewYes").addEventListener("click", () => {
  closeModal("invNewOverlay");
  if (!canInventory()) return;
  if (!onec.parts.length) { alert("Список 1С пуст — сначала импортируйте остатки."); return; }
  const date = document.getElementById("invNewDate").value || todayStr();
  const id = "inv" + Date.now().toString(36);
  inventory[id] = { date, created: Date.now(), by: MY_LOGIN, items: invSnapshot(), fact: {} };
  saveInventory();
  selectInv(id);
});
document.getElementById("invCards").addEventListener("click", (e) => {
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
    const id = act.dataset.id, inv = inventory[id];
    if (!inv || !confirm("Удалить инвентаризацию № " + invNumberOf(id) + " от " + invDateText(inv.date) + "? Удаление уйдёт на сервер и на все устройства.")) return;
    delete inventory[id];
    if (invCurrent === id) invCurrent = null;
    saveInventory();
    invRender();
    return;
  }
  if (e.target.closest(".t-menu")) return;
  const c = e.target.closest(".t-card");
  if (c) selectInv(c.dataset.id === invCurrent ? null : c.dataset.id);
});
document.getElementById("invRefreshBtn").addEventListener("click", () => {
  const inv = invSelected();
  if (!inv || !confirm("Обновить список и остатки из текущей вкладки «1С»? Введённые количества сохранятся.")) return;
  const byKey = invFactsByKey(inv);   // по позиции, одинаковые строки — по порядку (см. sync.js)
  inv.items = invSnapshot();
  inv.fact = invFactsToIndex(inv.items, byKey);
  saveInventory();
  invRender();
});
// меню фильтра — как в «1С»
document.getElementById("invFilterTitle").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = document.getElementById("invFilterPanel").classList.toggle("open");
  if (open) document.getElementById("invScooterSub").hidden = invFilter.cat !== "scooter";
});
document.querySelectorAll("#invFilterPanel [data-cat]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!btn.dataset.model) {   // «Самокаты ▸» — раскрыть выбор модели
      const sub = document.getElementById("invScooterSub");
      sub.hidden = !sub.hidden;
      return;
    }
    invFilter.cat = btn.dataset.cat;
    invFilter.model = btn.dataset.model;
    saveInvFilter();
    document.getElementById("invFilterPanel").classList.remove("open");
    renderInvTable();
  });
});
document.getElementById("invStockToggle").addEventListener("click", (e) => {
  e.stopPropagation();
  invFilter.stock = !invFilter.stock;
  saveInvFilter();
  renderInvTable();
});
document.getElementById("invFilterQty").addEventListener("click", (e) => e.stopPropagation());
document.getElementById("invFilterQty").addEventListener("input", (e) => {
  invFilter.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
  saveInvFilter();
  if (invFilter.stock) renderInvTable();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#invFilterPanel") && !e.target.closest("#invFilterTitle")) document.getElementById("invFilterPanel").classList.remove("open");
});

/* ---------- Итого ---------- */
function invTotalRows() {
  const inv = invSelected();
  if (!inv) return [];
  const mode = document.getElementById("invTotalMode").dataset.value || "write";
  const min = Math.max(1, parseInt(document.getElementById("invThreshold").value, 10) || 1);
  return invDiffRows(inv)
    .filter((r) => (mode === "write" ? r.diff < 0 : r.diff > 0) && Math.abs(r.diff) >= min)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}
function renderInvTotal() {
  const inv = invSelected();
  if (!inv) return;
  const mode = document.getElementById("invTotalMode").dataset.value || "write";
  const rows = invTotalRows();
  const sum = rows.reduce((s, r) => s + Math.abs(r.diff), 0);
  document.getElementById("invTotalTitle").textContent = "Итого · инвентаризация № " + invNumberOf(invCurrent) + " · " + invDateText(inv.date);
  document.getElementById("invTotalSummary").textContent = (mode === "write" ? "Списать" : "Выдать")
    + ": позиций " + rows.length + ", штук " + sum + " · посчитано " + Object.keys(inv.fact).length + " из " + inv.items.length;
  document.getElementById("invTotalList").innerHTML = rows.length
    ? `<table class="inv-total-table"><thead><tr><th>Код</th><th>Наименование</th><th>1С</th><th>Факт</th><th>${mode === "write" ? "Списать" : "Выдать"}</th></tr></thead><tbody>`
      + rows.map((r) => `<tr><td class="mono">${escapeHtml(r.it.code || "—")}</td><td>${escapeHtml(r.it.name)}</td><td>${r.it.qty || 0}</td><td>${r.fact}</td><td><b>${Math.abs(r.diff)}</b></td></tr>`).join("")
      + `</tbody></table>`
    : `<div class="sync-history-empty">Расхождений нет.</div>`;
  document.getElementById("invToTicketBtn").hidden = mode !== "write";
  document.getElementById("invToTicketBtn").disabled = !rows.length;
  document.getElementById("invExcelBtn").disabled = !rows.length;
}
document.getElementById("invTotalBtn").addEventListener("click", () => {
  if (!invSelected()) return;
  setModelSwitch(document.getElementById("invTotalMode"), document.getElementById("invTotalMode").dataset.value || "write");
  renderInvTotal();
  openModal("invTotalOverlay");
});
document.getElementById("invTotalMode").addEventListener("click", () => setTimeout(renderInvTotal, 0));
document.getElementById("invThreshold").addEventListener("input", renderInvTotal);
document.getElementById("invTotalClose").addEventListener("click", () => closeModal("invTotalOverlay"));
document.getElementById("invTotalOverlay").addEventListener("click", (e) => { if (e.target.id === "invTotalOverlay") closeModal("invTotalOverlay"); });

document.getElementById("invExcelBtn").addEventListener("click", () => {
  const inv = invSelected(), rows = invTotalRows();
  if (!inv || !rows.length) return;
  const write = (document.getElementById("invTotalMode").dataset.value || "write") === "write";
  const head = ["Код", "Наименование", "1С", "Факт", write ? "Списать" : "Выдать"];
  const data = rows.map((r) => [r.it.code || "", r.it.name, r.it.qty || 0, r.fact, Math.abs(r.diff)]);
  const blob = buildXlsx(write ? "Списать" : "Выдать", [head].concat(data), [18, 50, 8, 8, 10]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "inventarizaciya-" + inv.date + "-" + (write ? "spisat" : "vydat") + ".xlsx";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

// Весь список «Списать» — заявкой на сегодня в «Учёт» с комментарием «Списание инвента».
// Если такая заявка за сегодня уже есть — список в ней заменяется, новая не создаётся.
const INV_TICKET_NOTE = "Списание инвента";
document.getElementById("invToTicketBtn").addEventListener("click", () => {
  const rows = invTotalRows().filter((r) => r.diff < 0);
  if (!rows.length) return;
  const d = todayStr();
  const existing = ticketKeys().find((k) => k.slice(0, 10) === d && dataByDate[k].note === INV_TICKET_NOTE) || null;
  if (!confirm(existing
    ? "Обновить сегодняшнюю заявку «" + INV_TICKET_NOTE + "» в «Учёте»: список заменится, позиций " + rows.length + "?"
    : "Создать в «Учёте» заявку на сегодня «" + INV_TICKET_NOTE + "»: позиций " + rows.length + "?")) return;
  rebuildCrossIndexes();
  persistCurrentLocalOnly();
  const e = emptyEntry();
  rows.forEach((r) => {
    // в «Учёте» позиция — как на «Складе» (код и название склада), если она там есть
    const w = r.it.code ? warehouseInfoFor(r.it.code, r.it.name) : null;
    const item = { code: w ? w.code : (r.it.code || ""), name: w ? w.name : r.it.name };
    const k = countKey("parts", item);
    if (e.counts[k] === undefined) { e.sections.parts.push(item); e.counts[k] = 0; }
    e.counts[k] += -r.diff;
  });
  let key = existing;
  if (existing) {
    dataByDate[existing].sections = e.sections;   // номер, автор и дата создания остаются прежними
    dataByDate[existing].counts = e.counts;
    if (currentDate === existing) bindCurrent();
  } else {
    key = d;
    for (let n = 2; dataByDate[key]; n++) key = d + "#" + n;
    e.created = Date.now();
    if (MY_LOGIN) e.by = MY_LOGIN;
    e.note = INV_TICKET_NOTE;
    dataByDate[key] = e;
  }
  saveDataByDate();
  closeModal("invTotalOverlay");
  switchTab("consumption");
  selectTicket(key);
});

/* ---------- выгрузка .xlsx без сторонних библиотек ----------
   Минимальная книга: один лист, текст — встроенными строками, числа — числами.
   ZIP без сжатия (метод «stored»), контрольные суммы CRC-32. */
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    let c = (crc ^ bytes[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStored(files, type) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  files.forEach((f) => {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), n = data.length;
    const lh = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, s]) => (s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true)));
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, n, 4], [24, n, 4], [28, name.length, 2], [42, offset, 4]]
      .forEach(([o, v, s]) => (s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true)));
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + n;
  });
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type });
}
function buildXlsx(sheetName, rows, widths) {
  const x = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const col = (i) => String.fromCharCode(65 + i);
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><cols>`
    + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + `</cols><sheetData>`
    + rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => typeof v === "number"
      ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`).join("") + `</row>`).join("")
    + `</sheetData></worksheet>`;
  return zipStored([
    { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="${x(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", text: sheet }
  ], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
