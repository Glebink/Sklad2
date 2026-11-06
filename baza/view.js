'use strict';
/* База знаний — просмотр одного файла на весь экран (view.html?cell=…&path=…).
   Excel — сетка с буквами столбцов и номерами строк, листы вкладками внизу (без оформления: только данные).
   Word — постранично. PDF и картинки в браузере открываются его собственным просмотрщиком (ссылка на
   час); в приложении на главном экране (там нет кнопки «назад» браузера) — здесь же.
   Масштаб как Ctrl + колесо в браузере, но только содержимого: Ctrl + колесо (щипок на тачпаде),
   два пальца на тачскрине, кнопки − 100 % +. Вбок — полоса прокрутки, Shift + колесо, перетаскивание мышью. */
const params = new URLSearchParams(location.search);
const CELL_ID = params.get("cell") || "", PATH = params.get("path") || "";
const viewer = $("vwViewer");
let file = null;

function msg(text, err) { viewer.innerHTML = `<div class="vw-msg${err ? " err" : ""}">${esc(text)}</div>`; }
function findLocal(cells) {
  const c = cells.find((x) => x.id === CELL_ID);
  return c ? (c.files || []).find((f) => f.path === PATH) || null : null;
}
// Назад: к списку, откуда пришли (сохраняется выбранная ячейка); если файл открыт в новой вкладке — просто на список
$("vwBack").addEventListener("click", (e) => {
  if (document.referrer && new URL(document.referrer, location.href).pathname.replace(/index\.html$/, "") === new URL("./", location.href).pathname && history.length > 1) {
    e.preventDefault();
    history.back();
  }
});

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

/* ---------- открыть файл ---------- */
let opened = false;
async function openFile(f) {
  if (opened) return;
  opened = true;
  file = f;
  document.title = f.name;
  $("vwTitle").textContent = f.name;
  const kind = fileKind(f);
  try {
    if ((kind === "pdf" || kind === "image") && !isStandalone()) {
      // в браузере — его собственный просмотрщик; без связи — показываем здесь из кэша
      try {
        const r = await Auth.withTimeout(sb().storage.from(BUCKET).createSignedUrl(f.path, 3600), 15000);
        if (!r.error && r.data && r.data.signedUrl) { location.replace(r.data.signedUrl); return; }
      } catch (e) {}
    }
    msg("Загрузка…");
    const blob = await getFileBlob(f);
    if (kind === "xlsx") await showXlsx(blob);
    else if (kind === "docx") await showDocx(blob);
    else if (kind === "pdf") await showPdf(blob);
    else if (kind === "image") showImage(blob);
    else msg("Этот формат не показывается.", true);
  } catch (e) { msg("Не удалось открыть файл: " + errText(e), true); }
}
function inner() { return viewer.querySelector(".kb-zoom"); }
function setContent(node) {
  zoom = 1; updateZoomUI();
  const z = document.createElement("div");
  z.className = "kb-zoom";
  z.appendChild(node);
  viewer.replaceChildren(z);
  viewer.scrollTop = 0; viewer.scrollLeft = 0;
}

/* Excel: только данные (без оформления), листы — вкладками */
let wb = null, sheetIdx = 0;
async function showXlsx(blob) {
  await loadScript("xlsx-0.18.5.mini.min.js");
  wb = window.XLSX.read(await blob.arrayBuffer(), { type: "array" });
  const tabs = $("vwSheets");
  tabs.hidden = wb.SheetNames.length < 2;
  document.body.classList.toggle("vw-has-sheets", !tabs.hidden);
  tabs.innerHTML = wb.SheetNames.map((n, i) => `<button class="vw-sheet-tab" data-i="${i}">${esc(n)}</button>`).join("");
  showSheet(0);
}
$("vwSheets").addEventListener("click", (e) => {
  const b = e.target.closest(".vw-sheet-tab");
  if (b) showSheet(+b.dataset.i);
});
const MAX_ROWS = 20000;
function showSheet(i) {
  sheetIdx = i;
  document.querySelectorAll(".vw-sheet-tab").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
  const X = window.XLSX, ws = wb.Sheets[wb.SheetNames[i]];
  const wrap = document.createElement("div");
  if (!ws || !ws["!ref"]) { wrap.innerHTML = `<div class="vw-msg">Лист пустой.</div>`; setContent(wrap); return; }
  const R = X.utils.decode_range(ws["!ref"]);
  const r0 = 0, c0 = 0, r1 = Math.min(R.e.r, MAX_ROWS - 1), c1 = R.e.c;   // как в Excel — с A1
  // объединённые ячейки: верхняя левая растягивается, остальные пропускаются
  const span = {}, covered = new Set();
  (ws["!merges"] || []).forEach((m) => {
    span[m.s.r + "," + m.s.c] = { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 };
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + "," + c);
  });
  const out = [`<table class="vw-grid"><thead><tr><th class="vw-corner"></th>`];
  for (let c = c0; c <= c1; c++) out.push(`<th>${X.utils.encode_col(c)}</th>`);
  out.push(`</tr></thead><tbody>`);
  for (let r = r0; r <= r1; r++) {
    out.push(`<tr><th>${r + 1}</th>`);
    for (let c = c0; c <= c1; c++) {
      const k = r + "," + c;
      if (covered.has(k)) continue;
      const cell = ws[X.utils.encode_cell({ r, c })];
      const text = cell ? (cell.w != null ? cell.w : (cell.v != null ? String(cell.v) : "")) : "";
      const sp = span[k];
      out.push(`<td${cell && cell.t === "n" ? ` class="n"` : ""}${sp && sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}${sp && sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}>${esc(text)}</td>`);
    }
    out.push(`</tr>`);
  }
  out.push(`</tbody></table>`);
  if (R.e.r >= MAX_ROWS) out.push(`<div class="vw-msg">Показаны первые ${MAX_ROWS} строк из ${R.e.r + 1}.</div>`);
  wrap.innerHTML = out.join("");
  setContent(wrap);
}

/* Word — постранично; страница целиком по ширине экрана (дальше — масштаб) */
async function showDocx(blob) {
  await loadScript("jszip-3.10.1.min.js");
  await loadScript("docx-preview-0.4.1.min.js");
  const host = document.createElement("div");
  host.className = "vw-docx";
  setContent(host);
  await window.docx.renderAsync(blob, host, null, {
    className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
    renderHeaders: true, renderFooters: true, useBase64URL: true
  });
  fitWidth();
}
async function showPdf(blob) {
  await loadScript("pdf-3.11.174.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf-3.11.174.worker.min.js";
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const wrap = document.createElement("div");
  wrap.className = "vw-pdf";
  setContent(wrap);
  const width = Math.max(280, viewer.clientWidth - 24);
  const dpr = Math.min((window.devicePixelRatio || 1) * 2, 4);   // с запасом на увеличение
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / v1.width) * dpr });
    const cv = document.createElement("canvas");
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    cv.style.width = Math.floor(vp.width / dpr) + "px";
    wrap.appendChild(cv);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
  }
}
function showImage(blob) {
  const img = document.createElement("img");
  img.className = "vw-img";
  img.alt = file ? file.name : "";
  img.src = URL.createObjectURL(blob);
  setContent(img);
}

/* ---------- масштаб ---------- */
const ZMIN = 0.25, ZMAX = 5;
let zoom = 1;
function updateZoomUI() {
  $("vwZoomReset").textContent = Math.round(zoom * 100) + "%";
  viewer.classList.toggle("vw-zoomed", zoom > 1 || viewer.scrollWidth > viewer.clientWidth);
}
function setZoom(s, px, py) {
  const z = inner();
  s = Math.min(ZMAX, Math.max(ZMIN, Math.round(s * 100) / 100));
  if (!z || s === zoom) return;
  const s0 = zoom;
  if (px === undefined) { px = viewer.clientWidth / 2; py = viewer.clientHeight / 2; }
  // ширина содержимого фиксируется (по окну или по самому широкому — странице Word, таблице), а zoom
  // растягивает его целиком — как щипок на телефоне
  if (s0 === 1) z.style.width = Math.max(z.clientWidth, z.scrollWidth) + "px";
  const cx = viewer.scrollLeft + px, cy = viewer.scrollTop + py;
  zoom = s;
  z.style.zoom = s;
  if (s === 1) z.style.width = "";
  viewer.scrollLeft = cx * s / s0 - px;
  viewer.scrollTop = cy * s / s0 - py;
  updateZoomUI();
}
// Word: страница целиком по ширине экрана (на телефоне — мельче, дальше увеличивают пальцами)
function fitWidth() {
  const z = inner();
  if (!z) return;
  const w = z.scrollWidth, avail = viewer.clientWidth;
  if (w > avail + 4) setZoom(avail / w, 0, 0);
  else updateZoomUI();
}
function relPoint(x, y) { const r = viewer.getBoundingClientRect(); return [x - r.left, y - r.top]; }
viewer.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;   // без Ctrl — обычная прокрутка (с Shift — вбок)
  e.preventDefault();
  const [px, py] = relPoint(e.clientX, e.clientY);
  setZoom(zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), px, py);
}, { passive: false });
let pinch = null, pinchRaf = 0;
function touchDist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
viewer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) { pinch = { d: touchDist(e.touches), s: zoom }; e.preventDefault(); }
}, { passive: false });
viewer.addEventListener("touchmove", (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const t = e.touches, d = touchDist(t);
  const [px, py] = relPoint((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
  cancelAnimationFrame(pinchRaf);
  pinchRaf = requestAnimationFrame(() => setZoom(pinch ? pinch.s * d / pinch.d : zoom, px, py));
}, { passive: false });
viewer.addEventListener("touchend", (e) => { if (e.touches.length < 2) pinch = null; });
viewer.addEventListener("touchcancel", () => { pinch = null; });
// Safari: щипок увеличивает содержимое окна, а не всю страницу
["gesturestart", "gesturechange"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
// перетаскивание мышью, когда содержимое больше окна
let drag = null;
viewer.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !viewer.classList.contains("vw-zoomed") || e.target.closest("button, a, input")) return;
  drag = { x: e.clientX, y: e.clientY, l: viewer.scrollLeft, t: viewer.scrollTop };
  viewer.classList.add("vw-dragging");
  e.preventDefault();
});
document.addEventListener("mousemove", (e) => {
  if (!drag) return;
  viewer.scrollLeft = drag.l - (e.clientX - drag.x);
  viewer.scrollTop = drag.t - (e.clientY - drag.y);
});
document.addEventListener("mouseup", () => { if (drag) { drag = null; viewer.classList.remove("vw-dragging"); } });
$("vwZoomIn").addEventListener("click", () => setZoom(zoom * 1.25));
$("vwZoomOut").addEventListener("click", () => setZoom(zoom / 1.25));
$("vwZoomReset").addEventListener("click", () => setZoom(1));
window.addEventListener("resize", () => { if (inner() && zoom !== 1) { const s = zoom; setZoom(1); setZoom(s); } else updateZoomUI(); });

/* ---------- старт ---------- */
(function () {
  const f = findLocal(loadCellsLocal());
  if (f) $("vwTitle").textContent = f.name;
})();
if (!CELL_ID || !PATH) msg("Файл не указан.", true);
else if (window.Auth) {
  Auth.gate({
    onLogin: async () => {
      let f = null;
      try {
        const r = await Auth.withTimeout(sb().from("kb_cells").select("files").eq("id", CELL_ID).maybeSingle(), 15000);
        if (r.error) throw r.error;
        f = r.data && Array.isArray(r.data.files) ? r.data.files.find((x) => x.path === PATH) || null : null;
        if (!f) { msg("Файл не найден — его могли удалить.", true); return; }
      } catch (e) {
        f = findLocal(loadCellsLocal());   // нет связи — из списка на устройстве, файл — из кэша
        if (!f) { msg("Нет связи с сервером.", true); return; }
      }
      openFile(f);
    },
    onLogout: () => {}
  });
} else msg("Не загрузилась библиотека входа — нет связи с сервером.", true);
