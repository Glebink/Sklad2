'use strict';
/* База знаний: ячейки с названиями, в каждой — файлы (Word .docx, Excel .xlsx, PDF, картинки).
   Нажатие на ячейку показывает её файлы справа (на телефоне — отдельным экраном), друг под другом.
   hleb — админ: создаёт, переименовывает, двигает и удаляет ячейки, добавляет, двигает, удаляет
   и скачивает файлы. Остальные (boss, sklad) — только смотрят: кнопки скачивания у них нет,
   меню «сохранить картинку» отключено.
   Данные — таблица kb_cells (files: [{ path, name, type, size }]), файлы — закрытый бакет kb.
   Права проверяет сервер (RLS): менять может только hleb. Кнопки здесь — удобство.
   Просмотр файлов — библиотеки из ../lib/kb, грузятся только когда нужны.
   Открытые файлы запоминаются в кэше браузера: без связи ранее открытое тоже видно. */
const APP_VERSION = "v2.0";
const BUCKET = "kb";
const FILE_CACHE = "sklad2-kb-files";
const CELLS_CACHE_KEY = "sklad2_kb_cells_v1";   // список ячеек — для работы без связи
const LIB = "../lib/kb/";

let cells = [];
let currentId = null;
let MY_LOGIN = "", ROLE = null;
let query = "";
try { localStorage.setItem("sklad2_last_module", "baza"); } catch (e) {}
try { const c = window.Auth && Auth.cachedRole(); if (c) { ROLE = c.role; MY_LOGIN = c.login || ""; } } catch (e) {}
try { currentId = sessionStorage.getItem("sklad2_kb_sel") || null; } catch (e) {}
try { cells = JSON.parse(localStorage.getItem(CELLS_CACHE_KEY) || "[]") || []; } catch (e) { cells = []; }

const $ = (id) => document.getElementById(id);
function isAdmin() { return MY_LOGIN === "hleb"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function plural(n, a, b, c) { const m = n % 10, h = n % 100; return n + " " + (m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c)); }
function openModal(id) { $(id).classList.add("open"); }
function closeModal(id) { $(id).classList.remove("open"); }
function current() { return cells.find((c) => c.id === currentId) || null; }
function sb() { return window.Auth && Auth.sb; }
function errText(e) { return (e && (e.message || e.error_description || e.error)) || String(e); }

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
function fileKind(f) {
  const n = String(f.name || "").toLowerCase(), t = String(f.type || "");
  if (/\.docx$/.test(n) || /wordprocessingml/.test(t)) return "docx";
  if (/\.xlsx$/.test(n) || /spreadsheetml/.test(t)) return "xlsx";
  if (/\.pdf$/.test(n) || t === "application/pdf") return "pdf";
  if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif)$/.test(n)) return "image";
  return "";
}
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
  try { localStorage.setItem(CELLS_CACHE_KEY, JSON.stringify(cells)); } catch (e) {}
  if (JSON.stringify(cells) === before) return;
  if (currentId && !current()) currentId = null;
  renderList();
  updateLayout();
  renderView();
}
async function refresh() {
  try { await loadCells(); setStatus(""); }
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
  if (b) fileAction(b.dataset.fact, +b.dataset.idx);
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

/* ---------- получение файла: кэш браузера → сервер ---------- */
const blobMem = new Map();
async function getFileBlob(f) {
  if (blobMem.has(f.path)) return blobMem.get(f.path);
  const key = new Request(location.origin + "/__kb/" + f.path);
  let cache = null;
  try { cache = await caches.open(FILE_CACHE); } catch (e) {}
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const b = await hit.blob(); blobMem.set(f.path, b); return b; }
  }
  const r = await Auth.withTimeout(sb().storage.from(BUCKET).download(f.path), 120000);
  if (r.error) throw r.error;
  const blob = r.data;
  blobMem.set(f.path, blob);
  if (cache) { try { await cache.put(key, new Response(blob, { headers: { "Content-Type": f.type || "application/octet-stream" } })); } catch (e) {} }
  return blob;
}
function uncacheFile(path) {
  blobMem.delete(path);
  try { caches.open(FILE_CACHE).then((c) => c.delete(new Request(location.origin + "/__kb/" + path))); } catch (e) {}
}

/* ---------- библиотеки просмотра (по требованию) ---------- */
const libLoads = {};
function loadScript(src) {
  if (!libLoads[src]) libLoads[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = LIB + src;
    s.onload = res;
    s.onerror = () => { delete libLoads[src]; rej(new Error("не загрузилась библиотека просмотра " + src)); };
    document.head.appendChild(s);
  });
  return libLoads[src];
}
async function needDocx() { await loadScript("jszip-3.10.1.min.js"); await loadScript("docx-preview-0.4.1.min.js"); }
async function needXlsx() { await loadScript("xlsx-0.18.5.mini.min.js"); }
async function needPdf() {
  await loadScript("pdf-3.11.174.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf-3.11.174.worker.min.js";
}

/* ---------- показ файлов ---------- */
let renderSeq = 0;
function renderView() {
  const c = current();
  const box = $("kbFiles");
  const seq = ++renderSeq;
  if (!c) { box.innerHTML = ""; box.dataset.sig = ""; return; }
  $("kbViewTitle").textContent = c.title;
  const files = c.files || [];
  // список и порядок файлов не менялись — не перерисовываем (иначе сбивалась бы прокрутка)
  const sig = c.id + "|" + files.map((f) => f.path).join(",") + "|" + isAdmin();
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!files.length) {
    box.innerHTML = `<div class="kb-empty">${isAdmin() ? "Файлов нет. Добавьте кнопкой «+ Файл»: Word (.docx), Excel (.xlsx), PDF или картинки." : "В этой ячейке пока нет файлов."}</div>`;
    return;
  }
  const admin = isAdmin();
  box.innerHTML = files.map((f, i) => `<section class="kb-file" data-idx="${i}">`
    + `<div class="kb-file-head"><span class="kb-file-name">${esc(f.name)}</span>`
    + (admin ? `<span class="kb-file-acts">`
      + (i > 0 ? `<button class="iconbtn" data-fact="up" data-idx="${i}" title="Выше">↑</button>` : "")
      + (i < files.length - 1 ? `<button class="iconbtn" data-fact="down" data-idx="${i}" title="Ниже">↓</button>` : "")
      + `<button class="iconbtn" data-fact="dl" data-idx="${i}" title="Скачать">⬇</button>`
      + `<button class="iconbtn danger" data-fact="del" data-idx="${i}" title="Удалить файл">🗑</button></span>` : "")
    + `</div><div class="kb-file-body"><div class="kb-loading">Загрузка…</div></div></section>`).join("");
  files.forEach((f, i) => {
    const body = box.querySelector(`.kb-file[data-idx="${i}"] .kb-file-body`);
    showFile(f, body, seq).catch((e) => {
      if (seq !== renderSeq) return;
      body.innerHTML = `<div class="kb-error">Не удалось открыть файл: ${esc(errText(e))}</div>`;
    });
  });
}
async function showFile(f, body, seq) {
  const kind = fileKind(f);
  const blob = await getFileBlob(f);
  if (seq !== renderSeq) return;
  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "kb-img";
    img.alt = f.name;
    img.draggable = false;
    img.src = URL.createObjectURL(blob);
    body.replaceChildren(img);
    return;
  }
  if (kind === "docx") {
    await needDocx();
    if (seq !== renderSeq) return;
    const host = document.createElement("div");
    host.className = "kb-docx";
    body.replaceChildren(host);
    // ширина страницы Word не навязывается: текст и картинки подстраиваются под экран телефона
    await window.docx.renderAsync(blob, host, null, {
      className: "docx", inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false,
      ignoreLastRenderedPageBreak: true, renderHeaders: false, renderFooters: false, useBase64URL: true
    });
    host.querySelectorAll("img").forEach((im) => { im.draggable = false; });
    // пустые абзацы (ими в инструкциях разносят шаги по страницам) на экране не нужны
    host.querySelectorAll("p").forEach((p) => { if (!p.textContent.trim() && !p.querySelector("img, table")) p.classList.add("kb-blank"); });
    return;
  }
  if (kind === "xlsx") {
    await needXlsx();
    if (seq !== renderSeq) return;
    const wb = window.XLSX.read(await blob.arrayBuffer(), { type: "array" });
    const wrap = document.createElement("div");
    wrap.className = "kb-xlsx";
    wb.SheetNames.forEach((name) => {
      if (wb.SheetNames.length > 1) {
        const h = document.createElement("div");
        h.className = "kb-sheet-name";
        h.textContent = name;
        wrap.appendChild(h);
      }
      const sc = document.createElement("div");
      sc.className = "kb-sheet";
      sc.innerHTML = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" });
      wrap.appendChild(sc);
    });
    body.replaceChildren(wrap);
    return;
  }
  if (kind === "pdf") {
    await needPdf();
    if (seq !== renderSeq) return;
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const wrap = document.createElement("div");
    wrap.className = "kb-pdf";
    body.replaceChildren(wrap);
    const width = Math.max(280, wrap.clientWidth || body.clientWidth || 600);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let p = 1; p <= pdf.numPages; p++) {
      if (seq !== renderSeq) return;
      const page = await pdf.getPage(p);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / v1.width) * dpr });
      const cv = document.createElement("canvas");
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      cv.className = "kb-pdf-page";
      wrap.appendChild(cv);
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    }
    return;
  }
  body.innerHTML = `<div class="kb-error">Этот формат не показывается.</div>`;
}
// Не админ: без «Сохранить картинку» по долгому нажатию или правой кнопке
document.addEventListener("contextmenu", (e) => { if (!isAdmin() && e.target.closest("#kbFiles")) e.preventDefault(); });
document.addEventListener("dragstart", (e) => { if (!isAdmin() && e.target.closest("#kbFiles")) e.preventDefault(); });

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
        if (r) {
          ROLE = r.role; MY_LOGIN = r.login;
          applyRole();
          if (currentId) $("kbFiles").dataset.sig = "";   // права могли смениться — кнопки у файлов перерисовать
        }
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
