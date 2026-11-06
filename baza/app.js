'use strict';
/* База знаний — список: слева ячейки с названиями, справа — файлы выбранной ячейки строками
   (на телефоне — отдельным экраном, как заявки в «Учёте»). Нажатие на файл открывает его
   на весь экран (view.html): на ПК — в новой вкладке, в приложении на главном экране — в том же окне.
   hleb — админ: создаёт, переименовывает, двигает и удаляет ячейки, добавляет, двигает, удаляет
   и скачивает файлы. Остальные (boss, sklad) — только смотрят.
   Общее со страницей просмотра — common.js. */
let cells = loadCellsLocal();
let currentId = null;
let MY_LOGIN = "", ROLE = null;
let query = "";
try { localStorage.setItem("sklad2_last_module", "baza"); } catch (e) {}
try { const c = window.Auth && Auth.cachedRole(); if (c) { ROLE = c.role; MY_LOGIN = c.login || ""; } } catch (e) {}
try { currentId = sessionStorage.getItem("sklad2_kb_sel") || null; } catch (e) {}

function isAdmin() { return MY_LOGIN === "hleb"; }
function openModal(id) { $(id).classList.add("open"); }
function closeModal(id) { $(id).classList.remove("open"); }
function current() { return cells.find((c) => c.id === currentId) || null; }

$("appVersionBadge").textContent = APP_VERSION;
function applyRole() {
  document.body.classList.toggle("role-shift", ROLE === "shift");
  document.body.classList.toggle("kb-admin", isAdmin());
  $("kbNewBtn").hidden = !isAdmin();
  $("kbAddFileBtn").hidden = !isAdmin();
}
applyRole();

/* ---------- раскладка: список / выбранная ячейка (как заявки в «Учёте») ---------- */
function updateLayout() {
  const c = current();
  document.body.classList.toggle("no-ticket", !c);
  document.body.classList.toggle("has-ticket", !!c);
  $("kbEmpty").hidden = !!c;
  $("kbView").hidden = !c;
  $("kbHeadTitle").textContent = c ? c.title : "База знаний";
}

/* ---------- список ячеек ---------- */
function renderList() {
  const q = query.trim().toLowerCase();
  const list = cells.filter((c) => !q || c.title.toLowerCase().includes(q)
    || (c.files || []).some((f) => String(f.name || "").toLowerCase().includes(q)));
  const admin = isAdmin();
  $("kbCards").innerHTML = list.length ? list.map((c) => {
    const i = cells.indexOf(c), n = (c.files || []).length;
    return `<button class="t-card${c.id === currentId ? " sel" : ""}" data-id="${esc(c.id)}">`
      + `<div class="t-row"><span class="kb-card-title">${esc(c.title)}</span></div>`
      + `<div class="t-sub">${n ? plural(n, "файл", "файла", "файлов") : "нет файлов"}</div>`
      + (admin ? `<div class="t-foot"><span class="t-menu-wrap"><span class="t-menu-btn" role="button" tabindex="0" title="Действия">⋮</span>`
        + `<span class="t-menu">`
        + `<span class="t-act" role="button" data-act="rename" data-id="${esc(c.id)}">✎ Переименовать</span>`
        + (i > 0 ? `<span class="t-act" role="button" data-act="up" data-id="${esc(c.id)}">↑ Выше</span>` : "")
        + (i < cells.length - 1 ? `<span class="t-act" role="button" data-act="down" data-id="${esc(c.id)}">↓ Ниже</span>` : "")
        + `<span class="t-act danger" role="button" data-act="del" data-id="${esc(c.id)}">🗑 Удалить</span>`
        + `</span></span><span></span></div>` : "")
      + `</button>`;
  }).join("") : `<div class="t-empty">${q ? "Ничего не найдено" : (admin ? "Ячеек нет. Создайте кнопкой «+»." : "Ячеек пока нет.")}</div>`;
}
function closeMenus() { document.querySelectorAll(".t-menu-wrap.open").forEach((w) => w.classList.remove("open")); }
document.addEventListener("click", (e) => { if (!e.target.closest(".t-menu-wrap")) closeMenus(); });

$("kbCards").addEventListener("click", (e) => {
  const mb = e.target.closest(".t-menu-btn");
  if (mb) {
    e.stopPropagation();
    const w = mb.parentElement, was = w.classList.contains("open");
    closeMenus();
    w.classList.toggle("open", !was);
    return;
  }
  const act = e.target.closest(".t-act");
  if (act) {
    e.stopPropagation();
    closeMenus();
    cellAction(act.dataset.act, act.dataset.id);
    return;
  }
  if (e.target.closest(".t-menu")) return;
  const card = e.target.closest(".t-card");
  if (card) selectCell(card.dataset.id);
});
$("kbSearchBtn").addEventListener("click", () => {
  const box = $("kbSearchBox"), open = box.hidden;
  box.hidden = !open;
  $("kbSearchBtn").classList.toggle("on", open);
  if (open) $("kbSearchInput").focus();
  else { $("kbSearchInput").value = ""; query = ""; renderList(); }
});
$("kbSearchInput").addEventListener("input", (e) => { query = e.target.value; renderList(); });

function selectCell(id) {
  currentId = id && cells.some((c) => c.id === id) ? id : null;
  try { if (currentId) sessionStorage.setItem("sklad2_kb_sel", currentId); else sessionStorage.removeItem("sklad2_kb_sel"); } catch (e) {}
  renderList();
  updateLayout();
  renderView();
  window.scrollTo(0, 0);
}
$("kbBackBtn").addEventListener("click", () => selectCell(null));

/* ---------- загрузка с сервера ---------- */
async function loadCells() {
  if (!sb()) return;
  const r = await Auth.withTimeout(sb().from("kb_cells").select("id, title, position, files, updated_at").order("position").order("created_at"), 15000);
  if (r.error) throw r.error;
  const before = JSON.stringify(cells);
  cells = (r.data || []).map((c) => ({ ...c, files: Array.isArray(c.files) ? c.files : [] }));
  saveCellsLocal(cells);
  if (JSON.stringify(cells) === before) return;
  if (currentId && !current()) currentId = null;
  renderList();
  updateLayout();
  renderView();
}
async function refresh() {
  try { await loadCells(); }
  catch (e) { if (!cells.length) $("kbCards").innerHTML = `<div class="t-empty">Нет связи с сервером — список не загрузился.</div>`; }
}

/* ---------- действия hleb с ячейками ---------- */
let nameMode = null;   // { kind: "new" } | { kind: "rename", id }
function askName(mode, value) {
  nameMode = mode;
  $("kbNameTitle").textContent = mode.kind === "new" ? "Новая ячейка" : "Переименовать ячейку";
  $("kbNameInput").value = value || "";
  openModal("kbNameOverlay");
  setTimeout(() => { try { $("kbNameInput").focus(); $("kbNameInput").select(); } catch (e) {} }, 50);
}
$("kbNewBtn").addEventListener("click", () => askName({ kind: "new" }, ""));
$("kbNameNo").addEventListener("click", () => closeModal("kbNameOverlay"));
$("kbNameOverlay").addEventListener("click", (e) => { if (e.target.id === "kbNameOverlay") closeModal("kbNameOverlay"); });
$("kbNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("kbNameYes").click(); });
$("kbNameYes").addEventListener("click", async () => {
  const title = $("kbNameInput").value.trim();
  if (!title || !nameMode) return;
  closeModal("kbNameOverlay");
  try {
    if (nameMode.kind === "new") {
      const pos = cells.reduce((m, c) => Math.max(m, c.position || 0), 0) + 1;
      const r = await sb().from("kb_cells").insert({ title, position: pos }).select("id").single();
      if (r.error) throw r.error;
      await loadCells();
      selectCell(r.data.id);
    } else {
      const r = await sb().from("kb_cells").update({ title }).eq("id", nameMode.id);
      if (r.error) throw r.error;
      await loadCells();
    }
  } catch (e) { alert("Не удалось сохранить: " + errText(e)); }
});
async function cellAction(act, id) {
  const c = cells.find((x) => x.id === id);
  if (!c) return;
  try {
    if (act === "rename") { askName({ kind: "rename", id }, c.title); return; }
    if (act === "up" || act === "down") {
      const i = cells.indexOf(c), j = act === "up" ? i - 1 : i + 1;
      const o = cells[j];
      if (!o) return;
      // меняем местами; если позиции совпадали — разводим
      let pc = o.position, po = c.position;
      if (pc === po) { pc = act === "up" ? po - 0.5 : po + 0.5; }
      const r1 = await sb().from("kb_cells").update({ position: pc }).eq("id", c.id);
      if (r1.error) throw r1.error;
      const r2 = await sb().from("kb_cells").update({ position: po }).eq("id", o.id);
      if (r2.error) throw r2.error;
      await loadCells();
      return;
    }
    if (act === "del") {
      const n = (c.files || []).length;
      if (!confirm("Удалить ячейку «" + c.title + "»" + (n ? " и " + plural(n, "файл", "файла", "файлов") + " в ней" : "") + "? Это нельзя отменить.")) return;
      const paths = (c.files || []).map((f) => f.path);
      if (paths.length) { const rs = await sb().storage.from(BUCKET).remove(paths); if (rs.error) throw rs.error; }
      const r = await sb().from("kb_cells").delete().eq("id", c.id);
      if (r.error) throw r.error;
      paths.forEach(uncacheFile);
      if (currentId === c.id) currentId = null;
      await loadCells();
      selectCell(currentId);
    }
  } catch (e) { alert("Не удалось: " + errText(e)); }
}

/* ---------- файлы ячейки: добавление (hleb) ---------- */
const MAX_SIZE = 50 * 1024 * 1024;
const TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif"
};
function setStatus(t) { const s = $("kbStatus"); s.textContent = t || ""; s.hidden = !t; }
$("kbAddFileBtn").addEventListener("click", () => $("kbFileInput").click());
$("kbFileInput").addEventListener("change", async (e) => {
  const list = Array.from(e.target.files || []);
  e.target.value = "";
  const c = current();
  if (!c || !list.length) return;
  const added = [], bad = [];
  for (let k = 0; k < list.length; k++) {
    const f = list[k];
    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const type = TYPES[String(ext || "").toLowerCase()];
    if (!type) { bad.push(f.name + " — формат не поддерживается (нужен .docx, .xlsx, .pdf или картинка)"); continue; }
    if (f.size > MAX_SIZE) { bad.push(f.name + " — больше 50 МБ"); continue; }
    setStatus("Загрузка " + (k + 1) + " из " + list.length + ": " + f.name + "…");
    // в адресе файла — только латиница: хранилище не принимает русские буквы; имя для показа — в name
    const path = c.id + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext.toLowerCase();
    const r = await sb().storage.from(BUCKET).upload(path, f, { contentType: type, upsert: false });
    if (r.error) { bad.push(f.name + " — " + errText(r.error)); continue; }
    added.push({ path, name: f.name, type, size: f.size });
  }
  if (added.length) {
    // берём свежий список файлов с сервера, чтобы не потерять добавленное с другого устройства
    const fresh = await sb().from("kb_cells").select("files").eq("id", c.id).single();
    const files = (!fresh.error && Array.isArray(fresh.data.files) ? fresh.data.files : c.files || []).concat(added);
    const r = await sb().from("kb_cells").update({ files }).eq("id", c.id);
    if (r.error) bad.push("Не удалось сохранить список файлов: " + errText(r.error));
  }
  setStatus("");
  await refresh();
  if (bad.length) alert("Не загружено:\n" + bad.join("\n"));
});
async function fileAction(act, idx) {
  const c = current();
  if (!c) return;
  const files = (c.files || []).slice(), f = files[idx];
  if (!f) return;
  try {
    if (act === "dl") { downloadFile(f); return; }
    if (act === "up" || act === "down") {
      const j = act === "up" ? idx - 1 : idx + 1;
      if (!files[j]) return;
      [files[idx], files[j]] = [files[j], files[idx]];
      const r = await sb().from("kb_cells").update({ files }).eq("id", c.id);
      if (r.error) throw r.error;
      await loadCells();
      return;
    }
    if (act === "del") {
      if (!confirm("Удалить файл «" + f.name + "» из ячейки «" + c.title + "»?")) return;
      const rs = await sb().storage.from(BUCKET).remove([f.path]);
      if (rs.error) throw rs.error;
      files.splice(idx, 1);
      const r = await sb().from("kb_cells").update({ files }).eq("id", c.id);
      if (r.error) throw r.error;
      uncacheFile(f.path);
      await loadCells();
    }
  } catch (e) { alert("Не удалось: " + errText(e)); }
}
$("kbFiles").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fact]");
  if (b) { e.preventDefault(); fileAction(b.dataset.fact, +b.dataset.idx); }
});
async function downloadFile(f) {
  if (!isAdmin()) return;
  try {
    const blob = await getFileBlob(f);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { alert("Не удалось скачать: " + errText(e)); }
}

/* ---------- файлы выбранной ячейки — строками; нажатие открывает файл ---------- */
function renderView() {
  const c = current();
  const box = $("kbFiles");
  if (!c) { box.innerHTML = ""; return; }
  $("kbViewTitle").textContent = c.title;
  const files = c.files || [];
  if (!files.length) {
    box.innerHTML = `<div class="kb-empty">${isAdmin() ? "Файлов нет. Добавьте кнопкой «+ Файл»: Excel (.xlsx), Word (.docx), PDF или картинки." : "В этой ячейке пока нет файлов."}</div>`;
    return;
  }
  const admin = isAdmin(), target = isStandalone() ? "" : ` target="_blank"`;
  box.innerHTML = files.map((f, i) => {
    const kind = fileKind(f);
    return `<a class="kb-row" href="${esc(viewUrl(c.id, f.path))}"${target} title="Открыть">`
      + `<span class="kb-ico kb-ico-${kind || "other"}">${KIND_LABEL[kind] || "?"}</span>`
      + `<span class="kb-row-main"><span class="kb-row-name">${esc(f.name)}</span>`
      + `<span class="kb-row-sub">${fmtSize(f.size)}</span></span>`
      + (admin ? `<span class="kb-file-acts">`
        + (i > 0 ? `<button class="iconbtn" data-fact="up" data-idx="${i}" title="Выше">↑</button>` : "")
        + (i < files.length - 1 ? `<button class="iconbtn" data-fact="down" data-idx="${i}" title="Ниже">↓</button>` : "")
        + `<button class="iconbtn" data-fact="dl" data-idx="${i}" title="Скачать">⬇</button>`
        + `<button class="iconbtn danger" data-fact="del" data-idx="${i}" title="Удалить файл">🗑</button></span>` : "")
      + `</a>`;
  }).join("");
}

/* ---------- меню разделов, аккаунт ---------- */
(function () {
  const btn = $("modMenuBtn"), panel = $("modMenuPanel");
  btn.addEventListener("click", (e) => { e.stopPropagation(); panel.classList.toggle("open"); });
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("open")) return;
    if (e.target.closest("#modMenuPanel") || e.target.closest("#modMenuBtn")) return;
    panel.classList.remove("open");
  });
  $("modKbBtn").addEventListener("click", () => panel.classList.remove("open"));
})();
$("profileBtn").addEventListener("click", () => {
  $("kbAccountLine").textContent = MY_LOGIN ? "Вы вошли как " + MY_LOGIN + (isAdmin() ? " — можно добавлять и менять ячейки и файлы." : " — только просмотр.") : "Вход не выполнен.";
  openModal("kbAccountOverlay");
});
$("kbAccountClose").addEventListener("click", () => closeModal("kbAccountOverlay"));
$("kbAccountOverlay").addEventListener("click", (e) => { if (e.target.id === "kbAccountOverlay") closeModal("kbAccountOverlay"); });
$("kbLogoutBtn").addEventListener("click", () => { closeModal("kbAccountOverlay"); if (window.Auth) Auth.logout(); });

/* ---------- старт ---------- */
if (currentId && !current()) currentId = null;
renderList();
updateLayout();
renderView();
if (window.Auth) {
  Auth.gate({
    onLogin: async () => {
      try {
        const r = await Auth.loadRole();
        if (r) { ROLE = r.role; MY_LOGIN = r.login; applyRole(); }
      } catch (e) {}
      await refresh();
      renderList();
      renderView();
    },
    onLogout: () => {}
  });
} else {
  $("kbCards").innerHTML = `<div class="t-empty">Не загрузилась библиотека входа — нет связи с сервером.</div>`;
}
// Возврат в приложение — свежий список (hleb мог что-то добавить с другого устройства)
document.addEventListener("visibilitychange", () => { if (!document.hidden && window.Auth) refresh(); });
