/* Учёт потребления — Импорт остатков 1С из .xlsx, остатки «Бестужевской», список на перемещение, сравнение остатков.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
/* ==================== Импорт остатков из Excel в 1С ====================
   Вставляем строки из Excel (Код / Наименование / Остаток — в любом
   порядке, заголовок распознаётся и пропускается). Правила слияния:
     • позиция уже есть в 1С (по коду, а если кода нет — по названию) →
       обновляем ТОЛЬКО остаток; название, код и связь со складом/учётом
       не трогаем;
     • позиции нет в 1С → добавляем новую (модель проставится
       автоматически по метке в названии);
     • склад не изменяется вообще — импорт только в 1С. */
/* ==================== Чтение .xlsx прямо в приложении ====================
   Файл .xlsx — это ZIP с XML внутри. Нужны только два файла:
   xl/sharedStrings.xml (тексты) и xl/worksheets/sheet1.xml (ячейки).
   Распаковываем встроенным DecompressionStream («deflate-raw») — без
   сторонних библиотек, чтобы приложение осталось автономным офлайн. */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function readZipEntries(buf, wanted) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // ищем End Of Central Directory с конца
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Это не похоже на файл .xlsx");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder("utf-8");
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wanted.indexOf(name) !== -1) {
      // локальный заголовок: смещение данных зависит от длин полей в нём
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + compSize);
      out[name] = (method === 0) ? raw : await inflateRaw(raw);
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return out;
}
function colToIndex(ref) {          // "AB12" -> 27 (1-based номер столбца)
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
/* Чтение таблицы .xlsx в «сетку»: массив строк, где строка — объект
   { номер_столбца: значение }. Общая часть для обоих разборов — выгрузки
   1С и простого файла склада. */
async function readXlsxGrid(file) {
  const buf = await file.arrayBuffer();
  const files = await readZipEntries(buf, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
  const dec = new TextDecoder("utf-8");
  const parser = new DOMParser();
  // общие строки
  let shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const doc = parser.parseFromString(dec.decode(files["xl/sharedStrings.xml"]), "application/xml");
    shared = Array.from(doc.getElementsByTagName("si")).map((si) =>
      Array.from(si.getElementsByTagName("t")).map((t) => t.textContent).join("")
    );
  }
  if (!files["xl/worksheets/sheet1.xml"]) throw new Error("В файле не найден лист с данными.");
  const doc = parser.parseFromString(dec.decode(files["xl/worksheets/sheet1.xml"]), "application/xml");
  const rows = [];
  Array.from(doc.getElementsByTagName("row")).forEach((row) => {
    const cells = {};
    Array.from(row.getElementsByTagName("c")).forEach((cEl) => {
      const idx = colToIndex(cEl.getAttribute("r"));
      const t = cEl.getAttribute("t");
      const vEl = cEl.getElementsByTagName("v")[0];
      let val = "";
      if (t === "s") {
        val = vEl ? (shared[parseInt(vEl.textContent, 10)] || "") : "";
      } else if (t === "inlineStr") {
        const isEl = cEl.getElementsByTagName("is")[0];
        val = isEl ? Array.from(isEl.getElementsByTagName("t")).map((x) => x.textContent).join("") : "";
      } else {
        val = vEl ? vEl.textContent : "";
      }
      cells[idx] = String(val).trim();
    });
    rows.push(cells);
  });
  return rows;
}
async function parseXlsxFile(file) {
  const rows = await readXlsxGrid(file);
  // Столбцы: A(1) — Артикул, D(4) — Номенклатура, H(8) — «В наличии».
  // Именно так устроена выгрузка «Остатки и доступность товаров» из УТ 11.
  // Заголовки ищем сами, чтобы не сломаться, если 1С сдвинет колонки.
  let iCode = 1, iName = 4, iQty = 8, dataStart = 0;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const vals = rows[r];
    let foundCode = 0, foundName = 0, foundQty = 0;
    Object.keys(vals).forEach((k) => {
      const v = (vals[k] || "").toLowerCase();
      if (/артикул|^код$/.test(v)) foundCode = +k;
      else if (/номенклатур|наимен|назван/.test(v)) foundName = +k;
      else if (/в наличии|остат/.test(v)) foundQty = +k;
    });
    if (foundCode && foundName && foundQty) {
      iCode = foundCode; iName = foundName; iQty = foundQty; dataStart = r + 1; break;
    }
  }
  const out = [];
  for (let r = dataStart; r < rows.length; r++) {
    const code = (rows[r][iCode] || "").trim();
    const name = (rows[r][iName] || "").trim();
    const qtyRaw = (rows[r][iQty] || "").replace(/\s|\u00a0/g, "").replace(",", ".");
    const qty = Math.max(0, Math.round(parseFloat(qtyRaw) || 0));
    if (!name) continue;                       // пустые и служебные строки
    if (!code && /^сервисн|^склад|^итог/i.test(name)) continue;  // строка-итог по складу
    out.push({ code, name, qty });
  }
  return out;
}

// Поиск позиции 1С отдельно по коду и отдельно по названию — так импорт
// может сначала разобрать все совпадения по коду (приоритет), и только
// потом добирать оставшиеся по названию.
function findOcItemByCode(code) {
  if (!code) return null;
  const want = codeVariants(code);
  const i = onec.parts.findIndex((it) => it.code && codeVariants(it.code).some((v) => want.includes(v)));
  return i === -1 ? null : { section: "parts", index: i };
}
function findOcItemByName(name) {
  if (!name) return null;
  const target = normItemName(name);
  const i = onec.parts.findIndex((it) => normItemName(it.name) === target);
  return i === -1 ? null : { section: "parts", index: i };
}
function openOcImport() {
  document.getElementById("ocImportFile").value = "";
  document.getElementById("ocImportFileBest").value = "";
  ocImportFileRows = null;
  document.getElementById("ocImportFileInfo").textContent = "";
  // Показываем, что уже загружено по второму складу и когда
  const bestInfo = document.getElementById("ocImportFileBestInfo");
  if (bestStock && bestStock.rows) {
    const d = new Date(bestStock.savedAt);
    bestInfo.textContent = `Загружено ${bestStock.rows.length} позиций (${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0,5)}).`;
  } else {
    bestInfo.textContent = "";
  }
  openModal("ocImportOverlay");
}
function closeOcImport() {
  closeModal("ocImportOverlay");
}
document.getElementById("ocImportBtn").addEventListener("click", openOcImport);
document.getElementById("ocImportClose").addEventListener("click", closeOcImport);
document.getElementById("ocImportOverlay").addEventListener("click", (e) => {
  if (e.target.id === "ocImportOverlay") closeOcImport();
});
// Файл .xlsx, выбранный пользователем (если выбран — он в приоритете
// перед ручной вставкой в текстовое поле).
let ocImportFileRows = null;
document.getElementById("ocImportFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const info = document.getElementById("ocImportFileInfo");
  ocImportFileRows = null;
  if (!file) { info.textContent = ""; return; }
  info.textContent = "Читаю файл…";
  try {
    const rows = await parseXlsxFile(file);
    ocImportFileRows = rows;
    const withQty = rows.filter((r) => r.qty > 0).length;
    info.textContent = `Файл прочитан: ${rows.length} строк (с остатком — ${withQty}). Нажмите «Импортировать».`;
  } catch (err) {
    info.textContent = "Не удалось прочитать файл: " + err.message;
    alert("Не удалось прочитать файл .xlsx: " + err.message +
          "\nМожно вставить строки вручную в поле ниже.");
  }
});

// Второй склад «Бестужевская»: файл только сохраняется отдельно, в список
// 1С ничего не подмешивается. Пригодится для сравнения остатков между
// складами — обрабатываем сразу при выборе файла, кнопка не нужна.
document.getElementById("ocImportFileBest").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const info = document.getElementById("ocImportFileBestInfo");
  if (!file) { info.textContent = ""; return; }
  info.textContent = "Читаю файл…";
  try {
    const rows = await parseXlsxFile(file);
    bestStock = { savedAt: Date.now(), rows };
    saveBestStock(bestStock);
    const withQty = rows.filter((r) => r.qty > 0).length;
    info.textContent = `Сохранено: ${rows.length} позиций (с остатком — ${withQty}). Список 1С не изменён.`;
  } catch (err) {
    info.textContent = "Не удалось прочитать файл: " + err.message;
    alert("Не удалось прочитать файл .xlsx: " + err.message);
  }
});

/* ==================== Список на перемещение ====================
   Что нужно привезти со второго склада. Пополняется кнопкой «+» из окна
   сравнения; остаток на «Бестужевской» подтягивается заново при открытии,
   чтобы список не устаревал после новой выгрузки. */
/* Добавление позиции в список на перемещение из вкладки «1С»
   (кнопка 🚚 в меню строки). Остаток на «Бестужевской» подтягивается
   автоматически по коду, при отсутствии кода — по названию. */
function addOcItemToTransfer(section, index) {
  const it = onec[section][index];
  if (!it) return;
  if (isInTransfer({ code: it.code, name: it.name })) {
    alert("Эта позиция уже в списке на перемещение.");
    return;
  }
  const idx = buildBestIndex();
  let found = null;
  if (it.code) {
    for (const v of codeVariants(it.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
  }
  if (!found) {
    const n = String(it.name || "").toLowerCase().replace(/\s+/g, " ").trim();
    found = idx.byName[n] || null;
  }
  const other = found ? (found.qty || 0) : 0;
  const mine = it.qty || 0;   // остаток по 1С — это и есть моя «Ферма»

  transferList.push({ code: it.code || "", name: it.name, model: it.model || "", mine, other });
  saveTransferList();
  alert(!bestStock
    ? `«${it.name}» добавлена. Данные «Бестужевской» ещё не загружены — остаток появится после загрузки файла.`
    : `«${it.name}» добавлена в список на перемещение. На Бестужевской: ${other}.`);
}
function renderTransferList() {
  const idx = buildBestIndex();
  const summary = document.getElementById("ocTransferSummary");
  const list = document.getElementById("ocTransferList");
  // освежаем цифры по актуальной выгрузке второго склада
  transferList.forEach((t) => {
    let found = null;
    if (t.code) {
      for (const v of codeVariants(t.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
    }
    if (!found) {
      const n = String(t.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      found = idx.byName[n] || null;
    }
    t.other = found ? (found.qty || 0) : 0;
    // и свой остаток — из текущего списка 1С
    const mineItem = (t.code ? findOcItemByCode(t.code) : null) || findOcItemByName(t.name);
    if (mineItem) t.mine = onec[mineItem.section][mineItem.index].qty || 0;
  });
  // Цифры производные (считаются из 1С и Бестужевской при каждом показе), поэтому
  // здесь НЕ сохраняем: иначе простое открытие окна меняло бы данные и давало
  // ложный конфликт синхронизации. Сохранятся вместе со следующей реальной правкой.

  summary.textContent = transferList.length
    ? `Позиций в списке: ${transferList.length}.`
    : "";
  list.innerHTML = transferList.length === 0
    ? '<div class="sync-history-empty">Список пуст. Добавьте позиции кнопкой «+» в окне сравнения остатков.</div>'
    : transferList.map((t, i) => cmpCardHtml(t, i, false, true)).join("");
  Array.from(list.querySelectorAll(".cmp-add")).forEach((btn) => {
    btn.addEventListener("click", () => {
      transferList.splice(parseInt(btn.dataset.idx, 10), 1);
      saveTransferList();
      renderTransferList();
    });
  });
}
function transferAsText() {
  return "Список на перемещение (с Бестужевской)\n" + transferList.map((t) =>
    `${t.code ? t.code + " — " : ""}${t.name}: у меня ${t.mine}, там ${t.other}`
  ).join("\n");
}
document.getElementById("ocTransferBtn").addEventListener("click", () => {
  openModal("ocTransferOverlay");
  renderTransferList();
});
document.getElementById("ocTransferClose").addEventListener("click", () => {
  closeModal("ocTransferOverlay");
});
document.getElementById("ocTransferClear").addEventListener("click", () => {
  if (transferList.length === 0) return;
  if (!confirm("Очистить весь список на перемещение?")) return;
  transferList = [];
  saveTransferList();
  renderTransferList();
});
document.getElementById("ocTransferCopy").addEventListener("click", async () => {
  if (transferList.length === 0) { alert("Список пуст."); return; }
  try {
    await navigator.clipboard.writeText(transferAsText());
    alert("Список скопирован.");
  } catch (e) { alert("Не удалось скопировать."); }
});
document.getElementById("ocTransferPrint").addEventListener("click", () => {
  if (transferList.length === 0) { alert("Список пуст."); return; }
  const rows = transferList.map((t) => `<tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.code || "—")}</td>
      <td style="text-align:center">${t.mine}</td>
      <td style="text-align:center">${t.other}</td>
    </tr>`).join("");
  document.getElementById("printArea").innerHTML = `
    <h1>Список на перемещение</h1>
    <div class="print-date">С «Бестужевской» · позиций: ${transferList.length}</div>
    <table>
      <thead><tr><th>Наименование</th><th style="width:130px;">Код</th><th style="width:70px;">У меня</th><th style="width:90px;">Бестуж.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  window.print();
});

/* ==================== Сравнение остатков между складами ====================
   Берём свои позиции 1С с остатком меньше порога и ищем их на втором
   складе («Бестужевская», загружается отдельным файлом). Сопоставляем по
   коду, при отсутствии кода — по названию. */
let ocCompareRows = [];
function buildBestIndex() {
  const byCode = {}, byName = {};
  if (!bestStock || !bestStock.rows) return { byCode, byName };
  bestStock.rows.forEach((r) => {
    if (r.code) {
      codeVariants(r.code).forEach((v) => { if (!(v in byCode)) byCode[v] = r; });
    }
    const n = String(r.name || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (n && !(n in byName)) byName[n] = r;
  });
  return { byCode, byName };
}
function runOcCompare() {
  const limit = Math.max(1, parseInt(document.getElementById("ocCompareLimit").value, 10) || 40);
  const mode = document.getElementById("ocCompareMode").value;
  const modelMode = document.getElementById("ocCompareModel").value;
  const idx = buildBestIndex();
  const out = [];
  onec.parts.forEach((it) => {
      const mine = it.qty || 0;
      if (mine >= limit) return;
      // фильтр по модели: «Без версии» — позиции, у которых модель не задана
      if (modelMode !== "all") {
        const m = it.model || "";
        if (modelMode === "none" ? m !== "" : m !== modelMode) return;
      }
      let found = null;
      if (it.code) {
        for (const v of codeVariants(it.code)) { if (idx.byCode[v]) { found = idx.byCode[v]; break; } }
      }
      if (!found) {
        const n = String(it.name || "").toLowerCase().replace(/\s+/g, " ").trim();
        found = idx.byName[n] || null;
      }
      const other = found ? (found.qty || 0) : 0;
      // «Бестужевская > 0» — всё, что там есть в наличии.
      if (mode === "more" && !(other > 0)) return;
      out.push({ code: it.code || "", name: it.name, model: it.model || "", mine, other, missing: !found });
  });
  out.sort((a, b) => (b.other - b.mine) - (a.other - a.mine));
  ocCompareRows = out;

  const summary = document.getElementById("ocCompareSummary");
  const list = document.getElementById("ocCompareList");
  if (!bestStock || !bestStock.rows) {
    summary.textContent = "Файл склада «Бестужевская» ещё не загружен — загрузите его в окне импорта.";
    list.innerHTML = "";
    return;
  }
  renderOcCompareList();
}
/* Отрисовка списка сравнения с учётом строки поиска. Вынесено отдельно,
   чтобы при вводе в поиск не пересчитывать всё сравнение заново.
   ВАЖНО: в data-idx кладём индекс в ИСХОДНОМ массиве ocCompareRows, а не
   в отфильтрованном — иначе кнопка «+» добавляла бы не ту позицию. */
function renderOcCompareList() {
  const list = document.getElementById("ocCompareList");
  const summary = document.getElementById("ocCompareSummary");
  const limit = document.getElementById("ocCompareLimit").value;
  const q = (document.getElementById("ocCompareSearch").value || "").toLowerCase().trim();
  const shown = ocCompareRows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !q ||
      String(r.name || "").toLowerCase().includes(q) ||
      String(r.code || "").toLowerCase().includes(q));

  const secName = "все позиции";
  const mdl = document.getElementById("ocCompareModel").value;
  const mdlName = mdl === "all" ? "" : " · " + (mdl === "none" ? "без версии" : mdl);
  summary.textContent = q
    ? `Показано: ${shown.length} из ${ocCompareRows.length} (${secName}, порог < ${limit}).`
    : `${secName}${mdlName} · найдено: ${ocCompareRows.length} (порог < ${limit}, данные Бестужевской от ${new Date(bestStock.savedAt).toLocaleDateString()}).`;
  list.innerHTML = shown.length === 0
    ? '<div class="sync-history-empty">Ничего не найдено.</div>'
    : shown.map(({ r, i }) => cmpCardHtml(r, i, isInTransfer(r))).join("");
  // кнопки «+» — добавляют позицию в список на перемещение
  Array.from(list.querySelectorAll(".cmp-add")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = ocCompareRows[parseInt(btn.dataset.idx, 10)];
      if (!r || isInTransfer(r)) return;
      transferList.push({ code: r.code, name: r.name, model: r.model || "", mine: r.mine, other: r.other });
      saveTransferList();
      btn.textContent = "✓";
      btn.classList.add("added");
    });
  });
}
/* Карточка позиции в сравнении/перемещении:
     код слева сверху · модель справа сверху
     название по центру
     снизу два блока с остатками (Ферма / Бестужевская) и кнопка действия */
function cmpCardHtml(r, idx, added, removeMode) {
  return `<div class="cmp-card">
    <div class="cmp-top">
      <span class="cmp-code">${r.code ? escapeHtml(r.code) : "—"}</span>
      <span class="cmp-model">${r.model ? escapeHtml(r.model) : ""}</span>
    </div>
    <div class="cmp-name">${escapeHtml(r.name)}</div>
    <div class="cmp-bottom">
      <div class="cmp-cell">
        <div class="cmp-cell-label">Ферма</div>
        <div class="cmp-cell-val">${r.mine}</div>
      </div>
      <div class="cmp-cell">
        <div class="cmp-cell-label">Бестуж.</div>
        <div class="cmp-cell-val">${r.other}${r.missing ? " *" : ""}</div>
      </div>
      ${removeMode
        ? `<button class="cmp-add danger" data-idx="${idx}" title="Убрать из списка">✕</button>`
        : `<button class="cmp-add${added ? " added" : ""}" data-idx="${idx}" title="Добавить в список на перемещение">${added ? "✓" : "+"}</button>`}
    </div>
  </div>`;
}
function isInTransfer(r) {
  return transferList.some((t) =>
    (r.code && t.code === r.code) || (!r.code && !t.code && t.name === r.name)
  );
}
function ocCompareAsText() {
  const limit = document.getElementById("ocCompareLimit").value;
  const head = `Сравнение остатков (порог < ${limit})\nМоё / Бестужевская\n`;
  return head + ocCompareRows.map((r) =>
    `${r.code ? r.code + " — " : ""}${r.name}: ${r.mine} / ${r.other}${r.missing ? " (нет в выгрузке)" : ""}`
  ).join("\n");
}
document.getElementById("ocCompareBtn").addEventListener("click", () => {
  document.getElementById("ocCompareSearch").value = "";
  openModal("ocCompareOverlay");
  runOcCompare();
});
document.getElementById("ocCompareLimit").addEventListener("change", runOcCompare);
document.getElementById("ocCompareMode").addEventListener("change", runOcCompare);
document.getElementById("ocCompareModel").addEventListener("change", runOcCompare);
// Поиск по уже посчитанному списку — пересчитывать сравнение заново не нужно,
// только перерисовать с фильтром.
document.getElementById("ocCompareSearch").addEventListener("input", renderOcCompareList);
document.getElementById("ocCompareSearchClear").addEventListener("click", () => {
  const input = document.getElementById("ocCompareSearch");
  input.value = "";
  renderOcCompareList();
  input.focus();
});
document.getElementById("ocCompareX").addEventListener("click", () => {
  closeModal("ocCompareOverlay");
});
document.getElementById("ocCompareClose").addEventListener("click", () => {
  closeModal("ocCompareOverlay");
});
document.getElementById("ocCompareCopy").addEventListener("click", async () => {
  const text = ocCompareAsText();
  try {
    await navigator.clipboard.writeText(text);
    alert("Список скопирован.");
  } catch (e) {
    window.prompt("Не удалось скопировать автоматически. Скопируйте текст вручную:", text);
  }
});
document.getElementById("ocComparePrint").addEventListener("click", () => {
  const limit = document.getElementById("ocCompareLimit").value;
  const rows = ocCompareRows.map((r) => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.code || "—")}</td>
      <td style="text-align:center">${r.mine}</td>
      <td style="text-align:center">${r.other}${r.missing ? " *" : ""}</td>
    </tr>`).join("");
  document.getElementById("printArea").innerHTML = `
    <h1>Сравнение остатков</h1>
    <div class="print-date">Порог: меньше ${escapeHtml(String(limit))} · позиций: ${ocCompareRows.length}</div>
    <table>
      <thead><tr><th>Наименование</th><th style="width:130px;">Код</th><th style="width:70px;">У меня</th><th style="width:90px;">Бестуж.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  window.print();
});

document.getElementById("ocImportRun").addEventListener("click", () => {
  const rows = ocImportFileRows;
  if (!rows) { alert("Выберите файл .xlsx."); return; }
  if (rows.length === 0) { alert("Не удалось распознать ни одной строки."); return; }

  // Импорт только обновляет остаток имеющихся позиций и добавляет новые;
  // названия, модели и категории не трогает. Ключ строки — код + название:
  // в 1С бывают «коды-заглушки» (ВРЕМЕННЫЙ, Б210426…) у разных товаров, их
  // нельзя сливать. Строки с одинаковыми кодом и названием складываются.
  // Позиция 1С с тем же кодом и названием получает остаток (все дубли);
  // если код в файле у одного названия, а в списке названия другие — это
  // переименование в 1С, обновляем по коду. Без кода — только по названию.
  const normName = (n) => String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
  const codeKey = (c) => codeVariants(c).join("/");
  const merged = new Map();
  const namesByCode = new Map();
  rows.forEach((r) => {
    const ck = r.code ? codeKey(r.code) : "";
    const k = ck + "|" + normName(r.name);
    const m = merged.get(k);
    if (m) m.qty += r.qty; else merged.set(k, { code: r.code, name: r.name, qty: r.qty });
    if (ck) { if (!namesByCode.has(ck)) namesByCode.set(ck, new Set()); namesByCode.get(ck).add(normName(r.name)); }
  });
  const all = onec.parts.map((it, index) => ({ section: "parts", index, it }));
  const claimed = new Set();
  const pending = [];
  let updated = 0, added = 0;
  merged.forEach((r) => {
    let found;
    if (r.code) {
      const want = codeVariants(r.code);
      const byCode = all.filter(({ it }) => it.code && codeVariants(it.code).some((v) => want.includes(v)));
      found = byCode.filter(({ it }) => normName(it.name) === normName(r.name));
      if (!found.length && namesByCode.get(codeKey(r.code)).size === 1 &&
          new Set(byCode.map(({ it }) => normName(it.name))).size === 1) found = byCode;
    } else {
      found = all.filter(({ it }) => !it.code && normName(it.name) === normName(r.name));
    }
    if (found.length) {
      updated++;
      found.forEach(({ section, index }) => {
        const key = section + "|" + index;
        if (claimed.has(key)) return;
        claimed.add(key);
        pending.push({ type: "update", found: { section, index }, qty: r.qty });
      });
    } else {
      added++; pending.push({ type: "add", row: r });
    }
  });
  // Позиции, которых в свежей выгрузке нет вообще: 1С не выводит их, когда
  // остаток нулевой. Раньше они оставались со старым числом — например
  // «Задний барабан (Wind 5.0)» так и висел с 20 штуками, хотя в 1С уже 0.
  const zeroed = [];
  onec.parts.forEach((it, index) => {
    if (claimed.has("parts|" + index)) return;   // позиция была в файле — уже обновлена
    if ((it.qty || 0) === 0) return;             // и так ноль, трогать нечего
    zeroed.push({ section: "parts", index, name: it.name, was: it.qty });
  });

  // Страховка от неполной выгрузки: если обнулять пришлось бы больше
  // половины позиций с остатком — почти наверняка отчёт выгружен с
  // отбором (по группе, складу или товару), а не по всей номенклатуре.
  // Такой импорт молча обнулил бы почти весь список.
  const withStock = onec.parts.filter((it) => (it.qty || 0) > 0).length;
  const suspicious = withStock > 0 && zeroed.length > withStock / 2;
  if (suspicious) {
    const ok = confirm(
      `⚠️ Похоже, выгрузка неполная.\n\n` +
      `В файле ${rows.length} строк, а обнулить пришлось бы ${zeroed.length} из ${withStock} позиций с остатком.\n\n` +
      `Обычно так бывает, когда отчёт выгружен с отбором — по группе, складу или конкретному товару, а не по всей номенклатуре.\n\n` +
      `Импортировать только остатки из файла, НЕ обнуляя остальные?`
    );
    if (!ok) return;
    zeroed.length = 0;      // обнуление отменяем, обновляем только то, что в файле
  }

  const zeroMsg = zeroed.length
    ? `\n\nЕщё ${zeroed.length} поз. есть в списке, но отсутствуют в файле — их остаток будет обнулён.`
    : "";
  if (!confirm(`Импорт: обновить остаток у ${updated} поз., добавить новых в 1С — ${added}.${zeroMsg}\n\nСклад не изменится. Продолжить?`)) return;

  rebuildCrossIndexes();
  pushOcHistory();
  pending.forEach((p) => {
    if (p.type === "update") {
      onec[p.found.section][p.found.index].qty = p.qty;   // только остаток
    } else {
      const item = { code: p.row.code, name: p.row.name, qty: p.row.qty };
      // Модель — как у позиции склада с этим кодом, иначе по метке в названии
      const w = p.row.code ? warehouseInfoFor(p.row.code, p.row.name) : null;
      const wi = w && warehouse[w.section][w.index];
      if (wi && wi.model) { item.model = wi.model; if (wi.model2) item.model2 = wi.model2; }
      else { const model = detectModelFromName(p.row.name); if (model) item.model = model; }
      onec.parts.push(item);
    }
  });
  zeroed.forEach((z) => { onec[z.section][z.index].qty = 0; });
  saveOneC();
  renderOneCAll();
  closeOcImport();
  alert(`Готово: обновлено ${updated}, добавлено ${added}` + (zeroed.length ? `, обнулено ${zeroed.length}` : "") + ".");
});
