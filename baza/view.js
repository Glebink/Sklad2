'use strict';
/* База знаний — просмотр одного файла на весь экран (view.html?cell=…&path=…).
   Excel — сетка с буквами столбцов и номерами строк, листы вкладками внизу (без оформления: данные и картинки).
   Word — постранично. PDF и картинки в браузере открываются его собственным просмотрщиком (ссылка на
   час); в приложении на главном экране (там нет кнопки «назад» браузера) — здесь же.
   Масштаб как Ctrl + колесо в браузере, но только содержимого: Ctrl + колесо (щипок на тачпаде),
   два пальца на тачскрине, кнопки − 100 % +. Вбок — полоса прокрутки, Shift + колесо, перетаскивание мышью. */
const LIB = "../lib/kb/";   // библиотеки просмотра, грузятся по требованию
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
let renderSeq = 0;   // новый лист / файл — старые картинки не дорисовывать
function setContent(node) {
  renderSeq++;
  zoom = 1; updateZoomUI();
  const z = document.createElement("div");
  z.className = "kb-zoom";
  z.appendChild(node);
  viewer.replaceChildren(z);
  viewer.scrollTop = 0; viewer.scrollLeft = 0;
}

/* Excel: данные (без оформления) и картинки; листы — вкладками.
   Данные читает SheetJS, картинки он пропускает — их берём из самого файла (это zip) через JSZip:
   - плавающие («Вставка → Рисунки»): xl/drawings — привязка к ячейке «от» и «до» (или размер);
   - в ячейке (новый Excel: «Поместить в ячейку», ИЗОБРАЖЕНИЕ): xl/metadata.xml + xl/richData;
   - в ячейке из WPS Office (формула DISPIMG): xl/cellimages.xml.
   На листе с картинками ширина столбцов и высота строк — как в Excel, иначе картинкам негде поместиться. */
let wb = null, pics = null;
async function showXlsx(blob) {
  await loadScript("xlsx-0.18.5.mini.min.js");
  const buf = await blob.arrayBuffer();
  wb = window.XLSX.read(buf, { type: "array" });
  try { await loadScript("jszip-3.10.1.min.js"); pics = await readXlsxPictures(buf); }
  catch (e) { pics = null; console.warn("картинки Excel не прочитались", e); }   // данные всё равно покажем
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

/* ---------- картинки из файла Excel ---------- */
const EMU_PX = 9525;
function xmlDoc(text) { return new DOMParser().parseFromString(text, "application/xml"); }
function els(node, name) { return node ? Array.from(node.getElementsByTagNameNS("*", name)) : []; }
function el(node, name) { return els(node, name)[0] || null; }
function attrNS(node, local) {   // атрибут без учёта приставки (r:id, r:embed)
  if (!node) return null;
  for (const a of node.attributes) if (a.localName === local) return a.value;
  return null;
}
function resolvePath(base, target) {   // base — файл, относительно папки которого target
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/"); parts.pop();
  target.split("/").forEach((p) => { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); });
  return parts.join("/");
}
function relsPath(path) { const i = path.lastIndexOf("/"); return path.slice(0, i) + "/_rels/" + path.slice(i + 1) + ".rels"; }
async function readRels(zip, path) {
  const f = zip.file(relsPath(path));
  const map = {};
  if (!f) return map;
  els(xmlDoc(await f.async("string")), "Relationship").forEach((r) => {
    map[r.getAttribute("Id")] = { target: r.getAttribute("TargetMode") === "External" ? null : resolvePath(path, r.getAttribute("Target")), type: r.getAttribute("Type") || "" };
  });
  return map;
}
function cellRC(ref) {   // "B12" → { r: 11, c: 1 }
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return { r: +m[2] - 1, c: c - 1 };
}
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };
async function readXlsxPictures(buf) {
  const zip = await window.JSZip.loadAsync(buf);
  const text = async (p) => { const f = zip.file(p); return f ? f.async("string") : null; };
  // медиа — в адрес для <img> по требованию (браузер не покажет emf/wmf — такие пропускаем)
  const urls = {};
  const mediaUrl = async (p) => {
    if (!p) return null;
    if (urls[p] !== undefined) return urls[p];
    const f = zip.file(p), mime = IMG_MIME[(p.split(".").pop() || "").toLowerCase()];
    urls[p] = f && mime ? URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type: mime })) : null;
    return urls[p];
  };
  // картинки «в ячейке» нового Excel: номер vm у ячейки → путь к картинке
  const richByVm = {};
  const meta = await text("xl/metadata.xml");
  if (meta) {
    const md = xmlDoc(meta);
    const fut = els(md, "futureMetadata").find((f) => f.getAttribute("name") === "XLRICHVALUE");
    const futBk = fut ? els(fut, "bk") : [];
    const rv = await text("xl/richData/rdrichvalue.xml");
    const rvs = rv ? els(xmlDoc(rv), "rv") : [];
    const st = await text("xl/richData/rdrichvaluestructure.xml");
    const structs = st ? els(xmlDoc(st), "s").map((s) => els(s, "k").map((k) => k.getAttribute("n"))) : [];
    const relX = await text("xl/richData/richValueRel.xml");
    const relIds = relX ? els(xmlDoc(relX), "rel").map((r) => attrNS(r, "id")) : [];
    const relMap = await readRels(zip, "xl/richData/richValueRel.xml");
    const vmBk = els(el(md, "valueMetadata"), "bk");
    vmBk.forEach((bk, i) => {
      const rc = el(bk, "rc");
      const fb = futBk[rc ? +rc.getAttribute("v") : i];
      const rvb = fb ? el(fb, "rvb") : null;
      const v = rvs[rvb ? +rvb.getAttribute("i") : i];
      if (!v) return;
      const keys = structs[+v.getAttribute("s")] || [];
      const vals = els(v, "v").map((x) => x.textContent);
      const ki = keys.indexOf("_rvRel:LocalImageIdentifier");
      const rel = relMap[relIds[+(ki >= 0 ? vals[ki] : vals[0])]];
      if (rel && rel.target) richByVm[i + 1] = rel.target;
    });
  }
  // картинки «в ячейке» WPS: имя ID_… → путь к картинке
  const wpsById = {};
  const ci = await text("xl/cellimages.xml");
  if (ci) {
    const relMap = await readRels(zip, "xl/cellimages.xml");
    els(xmlDoc(ci), "pic").forEach((p) => {
      const name = attrNS(el(p, "cNvPr"), "name"), rel = relMap[attrNS(el(p, "blip"), "embed")];
      if (name && rel && rel.target) wpsById[name] = rel.target;
    });
  }
  // листы — в порядке книги (как у SheetJS)
  const wbXml = xmlDoc(await text("xl/workbook.xml"));
  const wbRels = await readRels(zip, "xl/workbook.xml");
  const sheets = [];
  for (const sh of els(wbXml, "sheet")) {
    const rel = wbRels[attrNS(sh, "id")];
    const out = { cols: {}, rows: {}, defCol: 64, defRow: 20, cells: {}, floating: [] };
    sheets.push(out);
    if (!rel || !rel.target) continue;
    const sx = await text(rel.target);
    if (!sx) continue;
    const sd = xmlDoc(sx);
    // размеры столбцов и строк (ширина — в «символах», высота — в пунктах)
    const fmt = el(sd, "sheetFormatPr");
    if (fmt) {
      const dc = fmt.getAttribute("defaultColWidth") || (fmt.getAttribute("baseColWidth") ? +fmt.getAttribute("baseColWidth") + 1.71 : null);
      if (dc) out.defCol = Math.round(+dc * 7);
      if (fmt.getAttribute("defaultRowHeight")) out.defRow = Math.round(+fmt.getAttribute("defaultRowHeight") * 4 / 3);
    }
    els(sd, "col").forEach((c) => {
      const w = c.getAttribute("hidden") === "1" ? 0 : Math.round(+c.getAttribute("width") * 7);
      for (let k = +c.getAttribute("min"); k <= +c.getAttribute("max") && k < 1000; k++) out.cols[k - 1] = w;
    });
    els(sd, "row").forEach((r) => {
      const n = +r.getAttribute("r") - 1;
      if (r.getAttribute("hidden") === "1") out.rows[n] = 0;
      else if (r.getAttribute("ht")) out.rows[n] = Math.round(+r.getAttribute("ht") * 4 / 3);
    });
    // картинки в ячейках
    els(sd, "c").forEach((c) => {
      let p = null;
      const vm = c.getAttribute("vm");
      if (vm && richByVm[vm]) p = richByVm[vm];
      else {
        const f = el(c, "f");
        const m = f && /DISPIMG\(\s*"([^"]+)"/i.exec(f.textContent || "");
        if (m && wpsById[m[1]]) p = wpsById[m[1]];
      }
      const rc = p && cellRC(c.getAttribute("r"));
      if (rc) out.cells[rc.r + "," + rc.c] = p;
    });
    // плавающие картинки
    const sRels = await readRels(zip, rel.target);
    for (const d of Object.values(sRels)) {
      if (!/\/drawing$/.test(d.type) || !d.target) continue;
      const dx = await text(d.target);
      if (!dx) continue;
      const dRels = await readRels(zip, d.target);
      const dd = xmlDoc(dx);
      const anchors = els(dd, "twoCellAnchor").concat(els(dd, "oneCellAnchor"), els(dd, "absoluteAnchor"))
        .filter((a) => !a.parentElement || !/Anchor$/.test(a.parentElement.localName));
      anchors.forEach((a) => {
        const blip = el(a, "blip");
        const r = blip && dRels[attrNS(blip, "embed")];
        if (!r || !r.target) return;   // фигуры, стрелки, диаграммы — не картинки
        const pt = (n) => n && { c: +el(n, "col").textContent, dx: +el(n, "colOff").textContent / EMU_PX, r: +el(n, "row").textContent, dy: +el(n, "rowOff").textContent / EMU_PX };
        const ext = el(a, "ext"), pos = el(a, "pos");
        out.floating.push({
          from: pt(el(a, "from")), to: a.localName === "twoCellAnchor" ? pt(el(a, "to")) : null,
          w: ext ? +ext.getAttribute("cx") / EMU_PX : 0, h: ext ? +ext.getAttribute("cy") / EMU_PX : 0,
          x: pos ? +pos.getAttribute("x") / EMU_PX : 0, y: pos ? +pos.getAttribute("y") / EMU_PX : 0,
          media: r.target
        });
      });
    }
  }
  return { sheets, mediaUrl };
}

const MAX_ROWS = 20000;
function showSheet(i) {
  document.querySelectorAll(".vw-sheet-tab").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
  const X = window.XLSX, ws = wb.Sheets[wb.SheetNames[i]];
  const sp = pics && pics.sheets[i];
  const hasPics = !!sp && (sp.floating.length > 0 || Object.keys(sp.cells).length > 0);
  const wrap = document.createElement("div");
  wrap.className = "vw-sheet";
  if ((!ws || !ws["!ref"]) && !hasPics) { wrap.innerHTML = `<div class="vw-msg">Лист пустой.</div>`; setContent(wrap); return; }
  const R = ws && ws["!ref"] ? X.utils.decode_range(ws["!ref"]) : { e: { r: 0, c: 0 } };
  let r1 = R.e.r, c1 = R.e.c;   // как в Excel — с A1
  if (hasPics) {   // сетка должна захватить и картинки за пределами данных
    sp.floating.forEach((f) => { const p = f.to || f.from; if (p) { r1 = Math.max(r1, p.r); c1 = Math.max(c1, p.c); } });
    Object.keys(sp.cells).forEach((k) => { const [r, c] = k.split(",").map(Number); r1 = Math.max(r1, r); c1 = Math.max(c1, c); });
  }
  r1 = Math.min(r1, MAX_ROWS - 1);
  const colW = (c) => (sp && sp.cols[c] !== undefined ? sp.cols[c] : sp ? sp.defCol : 64);
  const rowH = (r) => (sp && sp.rows[r] !== undefined ? sp.rows[r] : sp ? sp.defRow : 20);
  // объединённые ячейки: верхняя левая растягивается, остальные пропускаются
  const span = {}, covered = new Set();
  ((ws && ws["!merges"]) || []).forEach((m) => {
    span[m.s.r + "," + m.s.c] = { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 };
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + "," + c);
  });
  const out = [`<table class="vw-grid${hasPics ? " vw-fixed" : ""}">`];
  if (hasPics) {
    out.push(`<colgroup><col style="width:44px">`);
    for (let c = 0; c <= c1; c++) out.push(`<col style="width:${colW(c)}px">`);
    out.push(`</colgroup>`);
  }
  out.push(`<thead><tr><th class="vw-corner"></th>`);
  for (let c = 0; c <= c1; c++) out.push(`<th${hasPics && !colW(c) ? ` class="vw-hid"` : ""}>${X.utils.encode_col(c)}</th>`);
  out.push(`</tr></thead><tbody>`);
  for (let r = 0; r <= r1; r++) {
    const h = hasPics ? rowH(r) : 0;
    out.push(`<tr${hasPics ? (h ? ` style="height:${h}px"` : ` class="vw-hid"`) : ""}><th>${r + 1}</th>`);
    for (let c = 0; c <= c1; c++) {
      const k = r + "," + c;
      if (covered.has(k)) continue;
      const cell = ws && ws[X.utils.encode_cell({ r, c })];
      const pic = sp && sp.cells[k];
      const text = pic ? "" : cell ? (cell.w != null ? cell.w : (cell.v != null ? String(cell.v) : "")) : "";
      const m = span[k];
      out.push(`<td${cell && cell.t === "n" && !pic ? ` class="n"` : ""}${m && m.rs > 1 ? ` rowspan="${m.rs}"` : ""}${m && m.cs > 1 ? ` colspan="${m.cs}"` : ""}`
        + `${pic ? ` data-pic="${esc(pic)}"` : ""}>${esc(text)}</td>`);
    }
    out.push(`</tr>`);
  }
  out.push(`</tbody></table>`);
  if (R.e.r >= MAX_ROWS) out.push(`<div class="vw-msg">Показаны первые ${MAX_ROWS} строк из ${R.e.r + 1}.</div>`);
  wrap.innerHTML = out.join("");
  setContent(wrap);
  if (hasPics) placePictures(wrap, sp, r1, c1);
}
// Картинки ставятся по месту в нарисованной сетке (координаты ячеек берутся из таблицы на экране)
function placePictures(wrap, sp, r1, c1) {
  const table = wrap.querySelector("table");
  const heads = table.tHead.rows[0].cells, rows = table.tBodies[0].rows;
  const colX = (c) => (c <= c1 ? heads[c + 1].offsetLeft : table.offsetWidth);
  const rowY = (r) => (r <= r1 ? rows[r].offsetTop : table.offsetHeight);
  const seq = renderSeq;
  // в ячейке — вписать в ячейку
  wrap.querySelectorAll("td[data-pic]").forEach((td) => {
    pics.mediaUrl(td.dataset.pic).then((url) => {
      if (!url || seq !== renderSeq) return;
      const img = document.createElement("img");
      img.className = "vw-cellpic";
      img.loading = "lazy";
      img.src = url;
      td.appendChild(img);
    });
  });
  // плавающие — поверх сетки
  const layer = document.createElement("div");
  layer.className = "vw-piclayer";
  wrap.appendChild(layer);
  sp.floating.forEach((f) => {
    let x, y, w, h;
    if (f.from) {
      if (f.from.r > r1) return;
      x = colX(f.from.c) + f.from.dx; y = rowY(f.from.r) + f.from.dy;
      if (f.to) { w = colX(f.to.c) + f.to.dx - x; h = rowY(Math.min(f.to.r, r1 + 1)) + (f.to.r <= r1 ? f.to.dy : 0) - y; }
      else { w = f.w; h = f.h; }
    } else { x = heads[1].offsetLeft + f.x; y = rowY(0) + f.y; w = f.w; h = f.h; }
    if (!(w > 1 && h > 1)) return;
    const img = document.createElement("img");
    img.className = "vw-floatpic";
    img.loading = "lazy";
    img.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    layer.appendChild(img);
    pics.mediaUrl(f.media).then((url) => { if (url && seq === renderSeq) img.src = url; else img.remove(); });
  });
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
