#!/usr/bin/env node
/* Тесты приложения в браузере (Playwright) с поддельным сервером — см. fake-auth.js.
   Запуск из корня репозитория:  node tests/run.js  [часть названия теста]
   Нужен Playwright с Chromium (в облачной сессии уже стоит). Настоящий Supabase не трогается. */
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ---------- поддельный сервер: sklad_kv, kb_cells, файлы ---------- */
function makeServer() {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++tick * 1000).toISOString();
  const db = { sklad_kv: [], kb_cells: [], files: {} };
  const match = (row, filters) => filters.every(([k, op, v]) => (op === "in" ? v.includes(row[k]) : row[k] === v));
  function query(q, login) {
    const rows = db[q.table];
    if (!rows) return { error: { message: "нет таблицы " + q.table } };
    if (q.table === "kb_cells" && q.op !== "select" && login !== "hleb") return { error: { message: "RLS: менять может только hleb" } };
    if (q.op === "insert") {
      if (q.table === "sklad_kv" && rows.some((r) => r.key === q.payload.key)) return { error: { code: "23505", message: "duplicate" } };
      const row = { id: "id" + ++tick, files: [], created_at: stamp(), updated_at: stamp(), ...q.payload };
      rows.push(row);
      return { data: q.single ? row : [row] };
    }
    if (q.op === "update") {
      const hit = rows.filter((r) => match(r, q.filters));
      hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(q.payload)), { updated_at: stamp() }));
      return { data: hit.map((r) => ({ updated_at: r.updated_at })) };
    }
    if (q.op === "delete") { db[q.table] = rows.filter((r) => !match(r, q.filters)); return { data: null }; }
    let out = rows.filter((r) => match(r, q.filters));
    if (q.table === "kb_cells") out = out.slice().sort((a, b) => a.position - b.position);
    out = JSON.parse(JSON.stringify(out));
    return { data: q.single ? out[0] || null : out };
  }
  function handle({ op, login, args }) {
    if (op === "query") return query(args, login);
    if (op === "upload") { if (login !== "hleb") return { error: { message: "denied" } }; db.files[args.path] = args.data; return { data: {} }; }
    if (op === "download") return db.files[args.path] ? { data: db.files[args.path] } : { error: { message: "not found" } };
    if (op === "remove") { args.paths.forEach((p) => delete db.files[p]); return { data: [] }; }
    return { error: { message: "неизвестная операция " + op } };
  }
  const kv = (key) => (db.sklad_kv.find((r) => r.key === key) || {}).value;
  const seed = (key, value) => db.sklad_kv.push({ key, value, updated_at: stamp() });
  return { handle, kv, seed, db };
}

/* ---------- раздача файлов репозитория ---------- */
function startStatic() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + s.address().port, close: () => s.close() }));
  });
}

/* ---------- «устройство»: отдельный контекст браузера со своим логином ---------- */
let browser, base;
const FAKE_AUTH = fs.readFileSync(path.join(__dirname, "fake-auth.js"), "utf8");
async function device(server, { login = "hleb", role = "requester", width = 1280, height = 800, touch = false, standalone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, serviceWorkers: "block" });
  const errors = [];
  await ctx.route(/\/auth\.js/, (r) => r.fulfill({ contentType: "application/javascript", body: FAKE_AUTH.replace("__LOGIN__", login).replace("__ROLE__", role) }));
  await ctx.route(/\/__srv$/, (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(server.handle(JSON.parse(r.request().postData()))) }));
  if (standalone) await ctx.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
  ctx.on("page", (pg) => {
    pg.on("pageerror", (e) => errors.push(e.message));
    pg.on("dialog", (d) => d.accept());
  });
  const open = async (url) => { const p = await ctx.newPage(); await p.goto(base + url); await p.waitForTimeout(350); return p; };
  return { ctx, open, errors, close: () => ctx.close() };
}
const sync = (p) => p.evaluate(() => syncNow("safe"));
const names = (p, key) => p.evaluate((k) => dataByDate[k].sections.parts.map((x) => x.name), key);
// позиция выбирается из подсказки — так она получает код склада
async function addItem(p, name, qty) {
  await p.fill("#newItemName", name);
  await p.click("#addSuggestBox .suggest-item");
  await p.fill("#newItemQty", String(qty));
  await p.click("#addItemBtn");
  await p.waitForTimeout(150);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
// сравнение по значению; порядок ключей объекта не важен, порядок массива — важен
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
function eq(a, b, msg) { assert(JSON.stringify(canon(a)) === JSON.stringify(canon(b)), `${msg}: получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`); }

const STOCK = [
  { code: "111", name: "Болт М6", qty: 5 }, { code: "222", name: "Куртка рабочая", qty: 30 },
  { code: "333", name: "Мотор-колесо", qty: 12, model: "YGW 5.0" }, { code: "444", name: "Отвертка крестовая", qty: 2 }
];
function seededServer() {
  const s = makeServer();
  s.seed("potreblenie_onec_v1", { parts: STOCK.map((x) => ({ ...x })), consumables: [] });
  s.seed("potreblenie_warehouse_v1", { parts: STOCK.map((x) => ({ code: x.code, name: x.name, model: x.model || "", qty: 0 })), consumables: [] });
  s.seed("potreblenie_data_by_date_v3", {});
  return s;
}
const TODAY = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // по Москве, как в приложении

/* ---------- тесты ---------- */
const tests = {
  async "учёт: заявка, позиции, количество, отмена, обмен с сервером"() {
    const s = seededServer(), d = await device(s), p = await d.open("/uchet/");
    await sync(p);
    eq(await p.evaluate(() => warehouse.parts.length), 4, "склад пришёл с сервера");
    await p.click("#ticketNewBtn"); await p.click("#newTicketYes"); await p.waitForTimeout(200);
    const key = await p.evaluate(() => currentDate);
    eq(key, TODAY(), "заявка на сегодня по Москве");
    await addItem(p, "Болт М6", 3);
    await addItem(p, "Болт М6", 2);
    await addItem(p, "Мотор-колесо", 1);
    eq(await p.evaluate((k) => dataByDate[k].counts, key), { "code::111": 5, "code::333": 1 }, "повторный ввод прибавляет количество");
    await p.click("#undoBtn"); await p.waitForTimeout(100);
    eq(await names(p, key), ["Болт М6"], "отмена убирает последнюю позицию");
    await p.click("#redoBtn"); await p.waitForTimeout(100);
    await sync(p);
    eq(s.kv("potreblenie_data_by_date_v3")[key].sections.parts.length, 2, "заявка ушла на сервер");
    eq(await p.$$eval("#ticketCards .t-card", (a) => a.length), 1, "карточка в списке");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "синхронизация: правки двух устройств сливаются по позициям"() {
    const s = seededServer();
    const d1 = await device(s), d2 = await device(s);
    const a = await d1.open("/uchet/"); await sync(a);
    await a.click("#ticketNewBtn"); await a.click("#newTicketYes"); await a.waitForTimeout(200);
    const key = await a.evaluate(() => currentDate);
    await addItem(a, "Болт М6", 1); await sync(a);
    const b = await d2.open("/uchet/"); await sync(b);
    await b.click("#ticketCards .t-card"); await b.waitForTimeout(200);
    // оба правят одну заявку, не видя друг друга
    await addItem(a, "Куртка рабочая", 2); await addItem(a, "Болт М6", 4);
    await addItem(b, "Отвертка крестовая", 1); await addItem(b, "Болт М6", 10);
    await sync(a); await sync(b); await sync(a);
    const want = { "code::111": 15, "code::222": 2, "code::444": 1 };
    eq(await a.evaluate((k) => dataByDate[k].counts, key), want, "устройство 1");
    eq(await b.evaluate((k) => dataByDate[k].counts, key), want, "устройство 2");
    eq(s.kv("potreblenie_data_by_date_v3")[key].counts, want, "сервер");
    eq(d1.errors.concat(d2.errors), [], "ошибки страницы"); await d1.close(); await d2.close();
  },

  async "синхронизация: коды-заглушки 1С не склеиваются"() {
    const s = seededServer();
    const stub = (n) => ({ code: "Б210426", name: n, qty: 1 });
    s.db.sklad_kv.find((r) => r.key === "potreblenie_onec_v1").value.parts.push(stub("Стелька"), stub("Костюм 56-58"));
    const d1 = await device(s), d2 = await device(s);
    const a = await d1.open("/uchet/#onec"), b = await d2.open("/uchet/#onec");
    await sync(a); await sync(b);
    const bump = (p, name, q) => p.evaluate(([n, q]) => { onec.parts.find((x) => x.name === n).qty = q; saveOneC(); }, [name, q]);
    await bump(a, "Стелька", 7); await bump(b, "Костюм 56-58", 9);
    await sync(a); await sync(b); await sync(a);
    const got = s.kv("potreblenie_onec_v1").parts.filter((x) => x.code === "Б210426").map((x) => x.name + ":" + x.qty);
    eq(got, ["Стелька:7", "Костюм 56-58:9"], "обе правки на месте, копий нет");
    await d1.close(); await d2.close();
  },

  async "две вкладки одного устройства видят правки друг друга"() {
    const s = seededServer(), d = await device(s);
    const a = await d.open("/uchet/"); await sync(a);
    await a.click("#ticketNewBtn"); await a.click("#newTicketYes"); await a.waitForTimeout(200);
    const key = await a.evaluate(() => currentDate);
    const b = await d.open("/uchet/"); await b.click("#ticketCards .t-card"); await b.waitForTimeout(200);
    await addItem(b, "Болт М6", 1); await addItem(a, "Куртка рабочая", 1); await addItem(b, "Мотор-колесо", 1);
    await a.waitForTimeout(200);
    eq(await names(a, key), ["Болт М6", "Куртка рабочая", "Мотор-колесо"], "вкладка А");
    eq(await a.$$eval("#body-parts tr[data-index]", (t) => t.length), 3, "строки на экране вкладки А");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "вкладки и фильтры «Склада» и «1С»"() {
    const s = seededServer(), d = await device(s), p = await d.open("/uchet/"); await sync(p);
    const rows = (id) => p.$$eval(`#${id} tr[data-index]`, (t) => t.length);
    const pick = async (panel, title, cat) => { await p.click("#" + title); await p.click(`#${panel} [data-cat="${cat}"][data-model="all"]`); await p.waitForTimeout(100); };
    await p.click("#tabWarehouseBtn"); await p.waitForTimeout(150);
    await pick("whFilterPanel", "whTitle", "all"); eq(await rows("wh-body-parts"), 4, "склад: все");
    await pick("whFilterPanel", "whTitle", "cloth"); eq(await rows("wh-body-parts"), 1, "склад: одежда");
    await pick("whFilterPanel", "whTitle", "tool"); eq(await rows("wh-body-parts"), 1, "склад: инструменты");
    await p.click("#tabOneCBtn"); await p.waitForTimeout(150);
    await pick("ocFilterPanel", "ocTitle", "all"); eq(await rows("oc-body-parts"), 4, "1С: все");
    await p.click("#ocTitle"); await p.click("#ocStockToggle"); await p.fill("#ocFilterQty", "10"); await p.waitForTimeout(150);
    eq(await rows("oc-body-parts"), 2, "1С: остаток < 10");
    eq(await p.evaluate(() => location.hash), "#onec", "вкладка в адресе");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "инвентаризация: создание, факт, сортировка, заявка на списание"() {
    const s = seededServer(), d = await device(s), p = await d.open("/uchet/"); await sync(p);
    await p.click("#tabInvBtn"); await p.waitForTimeout(150);
    await p.click("#invNewBtn"); await p.click("#invNewYes"); await p.waitForTimeout(200);
    const shown = () => p.$$eval("#inv-body-parts tr .main-name", (a) => a.map((x) => x.textContent));
    eq((await shown()).length, 4, "снимок 1С");
    const fact = async (i, v) => { const el = await p.$(`#inv-body-parts tr[data-index="${i}"] .inv-input`); await el.fill(String(v)); await el.press("Tab"); };
    await fact(0, 2); await fact(1, 40);   // болтов меньше, курток больше
    await p.click('th.inv-sort[data-col="fact"]'); await p.waitForTimeout(100);
    eq((await shown())[0], "Куртка рабочая", "сортировка по «Склад» по убыванию");
    await fact(2, 12);
    eq(await p.evaluate(() => invSelected().fact), { 0: 2, 1: 40, 2: 12 }, "ввод при сортировке попал в свою позицию");
    await p.fill("#invAddName", "Болт М6"); await p.fill("#invAddQty", "1"); await p.click("#invAddBtn"); await p.waitForTimeout(150);
    eq(await p.evaluate(() => invSelected().fact[0]), 3, "найденное прибавляется");
    await p.click("#invTotalBtn"); await p.click("#invToTicketBtn"); await p.waitForTimeout(200);
    const t = await p.evaluate(() => { const k = ticketKeys().pop(), e = dataByDate[k]; return { note: e.note, counts: e.counts }; });
    eq(t, { note: "Списание инвента", counts: { "code::111": 2 } }, "заявка на списание");
    await sync(p);
    eq(Object.keys(s.kv("potreblenie_inventory_v1")).length, 1, "инвентаризация на сервере");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "сменщик: только учёт, одна заявка в день"() {
    const s = seededServer();
    s.seed("potreblenie_catalog_v1", { parts: STOCK.map((x) => ({ code: x.code, name: x.name })), consumables: [] });
    const d = await device(s, { login: "sklad", role: "shift" }), p = await d.open("/uchet/#onec"); await sync(p);
    eq(await p.isVisible("#tabsStrip"), false, "строки вкладок нет");
    eq(await p.isVisible("#viewOneC"), false, "«1С» не открывается по адресу");
    await p.click("#ticketNewBtn"); await p.click("#newTicketYes"); await p.waitForTimeout(200);
    await addItem(p, "Болт М6", 2);
    await p.evaluate(() => selectTicket(null)); await p.click("#ticketNewBtn"); await p.waitForTimeout(200);
    eq(await p.evaluate(() => ticketKeys().length), 1, "вторая заявка за день не создаётся");
    eq(await p.$$eval(".t-menu-btn", (a) => a.length), 0, "меню «⋮» нет");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "шапка помещается на телефоне и ПК"() {
    const s = seededServer();
    for (const width of [360, 390, 1280]) {
      const d = await device(s, { width, height: 700 }), p = await d.open("/uchet/");
      const r = await p.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        return { over: document.documentElement.scrollWidth - innerWidth, gap: box("profileBtn").left - box("tabInvBtn").right, half: box("tabWarehouseBtn").width === box("tabOneCBtn").width };
      });
      assert(r.over <= 0, `ширина ${width}: страница шире экрана на ${r.over}`);
      assert(r.gap >= 0, `ширина ${width}: вкладки наезжают на профиль (${r.gap})`);
      assert(r.half, `ширина ${width}: половинки «Склад | 1С» разной ширины`);
      await d.close();
    }
  },

  async "база знаний: ячейки, файлы, просмотр Excel с картинками, роли"() {
    const s = makeServer(), d = await device(s), p = await d.open("/baza/");
    await p.click("#kbNewBtn"); await p.fill("#kbNameInput", "Каталог"); await p.click("#kbNameYes"); await p.waitForTimeout(300);
    await p.setInputFiles("#kbFileInput", [
      { name: "Каталог.xlsx", mimeType: XLSX_MIME, buffer: fs.readFileSync(path.join(__dirname, "fixtures", "pictures.xlsx")) },
      { name: "старый.doc", mimeType: "application/msword", buffer: Buffer.from("x") }]);
    await p.waitForSelector(".kb-row"); 
    eq(await p.$$eval(".kb-row-name", (a) => a.map((x) => x.textContent)), ["Каталог.xlsx"], ".doc отклонён, .xlsx загружен");
    const [v] = await Promise.all([d.ctx.waitForEvent("page"), p.click(".kb-row-name")]);
    await v.waitForSelector(".vw-grid"); await v.waitForTimeout(600);
    eq(await v.$$eval(".vw-sheet-tab", (a) => a.map((t) => t.textContent)), ["Каталог", "Схема"], "листы вкладками");
    eq(await v.$$eval(".vw-floatpic", (a) => a.filter((i) => i.naturalWidth > 0).length), 4, "картинки на листе");
    await v.click('.vw-sheet-tab[data-i="1"]'); await v.waitForTimeout(400);
    eq(await v.$$eval(".vw-floatpic", (a) => a.filter((i) => i.naturalWidth > 0).length), 1, "картинка на втором листе");
    await v.mouse.move(300, 300); await v.keyboard.down("Control"); await v.mouse.wheel(0, -200); await v.keyboard.up("Control"); await v.waitForTimeout(100);
    assert(parseInt(await v.textContent("#vwZoomReset"), 10) > 100, "Ctrl + колесо увеличивает");
    // сменщик на телефоне (приложение на главном экране): только просмотр, файл — в том же окне
    const d2 = await device(s, { login: "sklad", role: "shift", width: 390, touch: true, standalone: true }), q = await d2.open("/baza/");
    eq(await q.isVisible("#kbNewBtn"), false, "сменщик: нет «+»");
    await q.tap(".t-card"); await q.waitForTimeout(200);
    eq(await q.$$eval("[data-fact], .t-menu-btn", (a) => a.length), 0, "сменщик: нет кнопок правки");
    await q.tap(".kb-row"); await q.waitForSelector(".vw-grid");
    await q.tap("#vwBack"); await q.waitForTimeout(400);
    eq(await q.isVisible(".kb-row"), true, "«назад» возвращает в ячейку");
    eq(d.errors.concat(d2.errors), [], "ошибки страницы"); await d.close(); await d2.close();
  }
};

(async () => {
  const only = process.argv[2];
  const srv = await startStatic(); base = srv.url;
  browser = await chromium.launch();
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !name.includes(only)) continue;
    try { await fn(); console.log("✓ " + name); }
    catch (e) { failed++; console.log("✗ " + name + "\n    " + String(e.message).split("\n")[0]); }
  }
  await browser.close(); srv.close();
  console.log(failed ? `\nНе прошло: ${failed}` : "\nВсе тесты прошли");
  process.exit(failed ? 1 : 0);
})();
