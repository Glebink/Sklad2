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
  const db = { sklad_kv: [], kb_cells: [], parts_orders: [], user_avatars: [], files: {},
    profiles: [{ login: "hleb", name: "Заявитель", role: "requester" }, { login: "ivan", name: "Иван", role: "repair" }, { login: "petr", name: "Пётр", role: "repair" }] };
  const match = (row, filters) => filters.every(([k, op, v]) => (op === "in" ? v.includes(row[k]) : row[k] === v));
  // parts_orders — права как в RLS и триггере на сервере
  const ROLES = { hleb: "requester", sklad: "shift" };
  const roleOf = (l) => ROLES[l] || "repair";
  const ordSee = (r, login) => r.author === login || (login === "hleb" && !!r.sent_at);
  const ordEdit = (r, login) => roleOf(login) === "repair" ? r.author === login && (r.status === "new" || r.status === "picking") && !r.accounted_at : login === "hleb" && !!r.sent_at;
  function ordersQuery(q, login) {
    const rows = db.parts_orders, copy = (x) => JSON.parse(JSON.stringify(x));
    if (q.op === "insert") {
      if (roleOf(login) !== "repair") return { error: { message: "RLS: создаёт только ремонтник" } };
      const row = { id: "ord" + ++tick, author: login, items: [], status: "new", created_at: stamp(), sent_at: null, accounted_at: null, ...q.payload, updated_at: stamp() };
      rows.push(row);
      return { data: q.single ? copy(row) : [copy(row)] };
    }
    const hit = rows.filter((r) => match(r, q.filters) && ordSee(r, login));
    if (q.op === "update") {
      if (login !== "hleb" && ["status", "hleb_items", "base_items"].some((k) => k in q.payload)) return { error: { message: "Статус и сборку заказа меняет кладовщик." } };
      const ok = hit.filter((r) => ordEdit(r, login));
      ok.forEach((r) => {
        const p = copy(q.payload);
        if (p.sent_at) p.sent_at = r.sent_at || stamp();
        if (p.accounted_at) p.accounted_at = r.accounted_at || stamp();
        Object.assign(r, p, { updated_at: stamp() });
      });
      return { data: copy(ok) };
    }
    if (q.op === "delete") { const del = hit.filter((r) => (r.author === login && !r.sent_at) || (login === "hleb" && r.sent_at)); db.parts_orders = rows.filter((r) => !del.includes(r)); return { data: null }; }
    return { data: copy(hit) };
  }
  // user_avatars — читает свою и hleb все, пишет только ремонтник свою
  function avatarsQuery(q, login) {
    const mine = (r) => r.login === login && roleOf(login) === "repair";
    if (q.op === "upsert") {
      if (q.payload.login !== login || roleOf(login) !== "repair") return { error: { message: "RLS user_avatars" } };
      const r = db.user_avatars.find((x) => x.login === login);
      if (r) r.data = q.payload.data; else db.user_avatars.push({ login, data: q.payload.data });
      return { data: null };
    }
    if (q.op === "delete") { db.user_avatars = db.user_avatars.filter((r) => !(match(r, q.filters) && mine(r))); return { data: null }; }
    const out = db.user_avatars.filter((r) => match(r, q.filters) && (r.login === login || login === "hleb"));
    return { data: q.single ? out[0] || null : JSON.parse(JSON.stringify(out)) };
  }
  function query(q, login) {
    if (q.table === "parts_orders") return ordersQuery(q, login);
    if (q.table === "user_avatars") return avatarsQuery(q, login);
    if (q.table === "profiles" && q.op !== "select") return { error: { message: "RLS profiles" } };
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
  // функции сервера: «Аккаунты» (только hleb); остальные — «да»
  const passwords = { ivan: "ivan123", petr: "petr123" }, disabled = new Set();
  function rpc({ fn, args }, login) {
    if (!/^account/.test(fn)) return { data: true };
    if (login !== "hleb") return { error: { message: "Только hleb управляет аккаунтами" } };
    const prof = (l) => db.profiles.find((p) => p.login === l && p.role === "repair");
    if (fn === "accounts_list") return { data: db.profiles.map((p) => ({ login: p.login, name: p.name, role: p.role, disabled: disabled.has(p.login), password: passwords[p.login] || null })) };
    if (fn === "account_create") {
      const l = args.p_login.toLowerCase();
      if (db.profiles.some((p) => p.login === l)) return { error: { message: "Логин " + l + " уже занят" } };
      if (args.p_password.length < 6) return { error: { message: "Пароль — не меньше 6 символов" } };
      db.profiles.push({ login: l, name: args.p_name || args.p_login, role: "repair" }); passwords[l] = args.p_password.toLowerCase();
      return { data: null };
    }
    const p = prof(args.p_login);
    if (!p) return { error: { message: "Нет аккаунта ремонтника" } };
    if (fn === "account_set_password") passwords[p.login] = args.p_password.toLowerCase();
    if (fn === "account_set_name") p.name = args.p_name;
    if (fn === "account_set_disabled") { if (args.p_disabled) disabled.add(p.login); else disabled.delete(p.login); }
    return { data: null };
  }
  function handle({ op, login, args }) {
    if (op === "rpc") return rpc(args, login);
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

  async "подсказки: совпадение по коду выше совпадений по названию"() {
    const s = seededServer();
    // много деталей 9Bot с годами «21-25» в названии — запрос «25.21» совпадает с ними по словам
    const wh = s.db.sklad_kv.find((r) => r.key === "potreblenie_warehouse_v1").value.parts;
    for (let i = 1; i <= 15; i++) wh.push({ code: "AB.16.02.00.39" + String(i).padStart(2, "0"), name: `Деталь ${i} 21-25`, model: "9Bot", qty: 0 });
    wh.push({ code: "AB.50.0025.21", name: "Втулка-коннектор тормоза(22)", model: "9Bot", qty: 0 });
    const d = await device(s), p = await d.open("/uchet/"); await sync(p);
    await p.click("#ticketNewBtn"); await p.click("#newTicketYes"); await p.waitForTimeout(200);
    const first = async (q) => { await p.fill("#newItemName", q); await p.waitForTimeout(100); return p.$eval("#addSuggestBox .suggest-item .code", (e) => e.textContent); };
    eq(await first("25.21"), "AB.50.0025.21", "часть кода");
    eq(await first("AB.50.0025.21"), "AB.50.0025.21", "код целиком");
    eq(await first("втулка"), "AB.50.0025.21", "по названию по-прежнему находится");
    eq(d.errors, [], "ошибки страницы"); await d.close();
  },

  async "ключевые слова позиции склада: правка hleb, поиск везде"() {
    const s = seededServer(), d = await device(s), p = await d.open("/uchet/"); await sync(p);
    await p.click("#ticketNewBtn"); await p.click("#newTicketYes"); await p.waitForTimeout(200);
    await p.click("#tabWarehouseBtn"); await p.waitForTimeout(150);
    await p.evaluate(() => openWhEdit("parts", warehouse.parts.findIndex((x) => x.code === "333")));
    eq(await p.isVisible("#whEditKeys"), true, "поле видно hleb");
    await p.fill("#whEditKeys", " шина,покрышка ,, резина  передняя, Шина"); await p.click("#whEditSave"); await p.waitForTimeout(150);
    eq(await p.evaluate(() => warehouse.parts.find((x) => x.code === "333").keys), "шина, покрышка, резина передняя", "слова сохранены без повторов");
    const first = async (input, box, q) => { await p.fill(input, q); await p.waitForTimeout(100); return p.$$eval(box + " .suggest-item .code", (a) => a.map((e) => e.textContent)); };
    await sync(p); await p.waitForTimeout(300);
    await p.click("#tabConsumptionBtn"); await p.waitForSelector("#newItemName", { state: "visible", timeout: 3000 });
    eq(await first("#newItemName", "#addSuggestBox", "покрыш"), ["333"], "подсказка «Учёта» по слову");
    eq(await first("#newItemName", "#addSuggestBox", "резина пер"), ["333"], "по фразе");
    eq(await first("#newItemName", "#addSuggestBox", "шина колесо"), ["333"], "слово + название");
    eq(await first("#newItemName", "#addSuggestBox", "резина болт"), [], "слова из разных позиций не смешиваются");
    await p.fill("#newItemName", "");
    await p.click("#tabOneCBtn"); await p.waitForTimeout(150);
    const ocHits = await p.evaluate(() => { const i = document.getElementById("ocSearchInput"); i.value = "шина"; i.dispatchEvent(new Event("input"));
      return Array.from(document.querySelectorAll("#oc-body-parts tr.row-match")).map((t) => onec.parts[+t.dataset.index].code); });
    eq(ocHits, ["333"], "поиск по «1С» — через позицию склада");
    await sync(p);
    eq(s.kv("potreblenie_warehouse_v1").parts.find((x) => x.code === "333").keys, "шина, покрышка, резина передняя", "на сервере");
    // каталог для сменщика и ремонтников собирает сервер — здесь подкладываем как он
    s.seed("potreblenie_catalog_v1", { parts: STOCK.map((x) => ({ code: x.code, name: x.name, ocqty: x.qty, ...(x.code === "333" ? { keys: "шина, покрышка" } : {}) })), consumables: [] });
    const r = await device(s, { login: "ivan", role: "repair" }), z = await r.open("/zakaz/"); await z.waitForTimeout(200);
    await z.click("#zkNewBtn"); await z.waitForTimeout(200);
    await z.fill("#newItemName", "шина"); await z.waitForTimeout(100);
    eq(await z.$$eval("#addSuggestBox .suggest-item .code", (a) => a.map((e) => e.textContent)), ["333"], "подсказка ремонтника");
    const sh = await device(s, { login: "sklad", role: "shift" }), q = await sh.open("/uchet/"); await sync(q);
    await q.click("#ticketNewBtn"); await q.click("#newTicketYes"); await q.waitForTimeout(200);
    await q.fill("#newItemName", "покрышка"); await q.waitForTimeout(100);
    eq(await q.$$eval("#addSuggestBox .suggest-item .code", (a) => a.map((e) => e.textContent)), ["333"], "подсказка сменщика");
    eq(d.errors.concat(r.errors, sh.errors), [], "ошибки страницы"); await d.close(); await r.close(); await sh.close();
  },

  async "аккаунты: hleb создаёт ремонтника, меняет имя и пароль, отключает"() {
    const s = seededServer(), d = await device(s, { width: 390, touch: true }), p = await d.open("/uchet/"); await sync(p);
    await p.tap("#profileBtn"); await p.waitForTimeout(100);
    await p.tap("#accountsOpenBtn"); await p.waitForTimeout(200);
    const creds = () => p.$$eval("#accList .acc-cred", (a) => a.map((x) => x.textContent));
    eq((await creds()).includes("ivan / ivan123"), true, "логин / пароль в списке");
    await p.fill('#accNewForm [name="login"]', "Lev"); await p.fill('#accNewForm [name="password"]', "Lev123"); await p.fill('#accNewForm [name="name"]', "Лев");
    await p.tap('#accNewForm [type="submit"]'); await p.waitForTimeout(200);
    eq((await creds()).includes("lev / lev123"), true, "создан, пароль строчными");
    eq(await p.inputValue('#accNewForm [name="login"]'), "", "форма очищена");
    p.removeAllListeners("dialog");
    const row = '#accList .acc-row[data-login="lev"]';
    p.once("dialog", (dl) => dl.accept("Лев Толстой")); await p.tap(row + ' [data-act="name"]'); await p.waitForTimeout(200);
    p.once("dialog", (dl) => dl.accept("Новый1")); await p.tap(row + ' [data-act="pass"]'); await p.waitForTimeout(200);
    p.once("dialog", (dl) => dl.accept()); await p.tap(row + ' [data-act="toggle"]'); await p.waitForTimeout(200);
    eq([await p.textContent(row + " b"), await p.textContent(row + " .acc-cred"), await p.textContent(row + " .acc-role")], ["Лев Толстой", "lev / новый1", "отключён"], "имя, пароль, отключение");
    eq(await p.$$eval('#accList .acc-row[data-login="hleb"] [data-act]', (a) => a.length), 0, "свой и не ремонтников аккаунт не меняется");
    const b = await device(s, { login: "boss", role: "boss" }), q = await b.open("/uchet/"); await q.click("#profileBtn");
    eq(await q.isVisible("#accountsOpenBtn"), false, "у других нет «Аккаунтов»");
    eq(d.errors.concat(b.errors), [], "ошибки страницы"); await d.close(); await b.close();
  },

  async "шапка помещается на телефоне и ПК"() {
    const s = seededServer();
    for (const width of [360, 390, 1280]) {
      const d = await device(s, { width, height: 700 }), p = await d.open("/uchet/");
      const r = await p.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        return { over: document.documentElement.scrollWidth - innerWidth, gap: box("profileBtn").left - box("tabsStrip").right, ordShown: !document.getElementById("tabOrdersBtn").hidden,
          pairs: [box("tabConsumptionBtn").width + box("tabOrdersBtn").width, box("tabWarehouseBtn").width + box("tabOneCBtn").width], half: box("tabWarehouseBtn").width === box("tabOneCBtn").width };
      });
      assert(r.over <= 0, `ширина ${width}: страница шире экрана на ${r.over}`);
      assert(r.gap >= 0, `ширина ${width}: вкладки наезжают на профиль (${r.gap})`);
      assert(r.half, `ширина ${width}: половинки «Склад | 1С» разной ширины`);
      assert(r.ordShown, `ширина ${width}: у hleb нет вкладки «Заказы»`);
      assert(r.pairs[0] === r.pairs[1], `ширина ${width}: «Учёт | Заказы» и «Склад | 1С» разной ширины (${r.pairs})`);
      await d.close();
    }
  },

  async "заказы ремонтника: набор, отправка, сборка у hleb, перенос в учёт"() {
    const s = seededServer();
    s.seed("potreblenie_catalog_v1", { parts: STOCK.map((x) => ({ code: x.code, name: x.name, model: x.model || "", ocqty: x.qty })), consumables: [] });
    const r = await device(s, { login: "ivan", role: "repair", width: 390, touch: true });
    const u = await r.open("/uchet/"); await u.waitForTimeout(300);
    assert(u.url().includes("/zakaz/"), "ремонтника из учёта уводит в его заявки");
    const p = await r.open("/zakaz/"); await p.waitForTimeout(200);
    await p.tap("#zkNewBtn"); await p.waitForTimeout(200);
    await p.fill("#newItemName", "болт"); await p.waitForTimeout(100);
    eq(await p.$eval("#addSuggestBox .suggest-item .suggest-oc-qty", (e) => e.textContent), "5", "в подсказке остаток 1С");
    await p.tap("#addSuggestBox .suggest-item"); await p.fill("#newItemQty", "3"); await p.tap("#addItemBtn");
    await p.tap('#zkModel [data-model="YGW 4.0"]'); await p.fill("#newItemName", "колесо"); await p.waitForTimeout(100);
    eq(await p.$$eval("#addSuggestBox .suggest-item", (a) => a.length), 0, "фильтр 4.0: мотор-колеса 5.0 нет");
    await p.tap('#zkModel [data-model="YGW 5.0"]'); await p.waitForTimeout(100);
    await p.tap("#addSuggestBox .suggest-item"); await p.tap("#addItemBtn");
    await p.tap('#zkModel [data-model=""]');
    await p.fill("#newItemName", "Шайба 8"); await p.fill("#newItemQty", "2"); await p.tap("#addItemBtn");
    await p.waitForTimeout(800);
    eq(s.db.parts_orders[0].items, [{ code: "111", name: "Болт М6", qty: 3 }, { code: "333", name: "Мотор-колесо", qty: 1 }, { code: "", name: "Шайба 8", qty: 2 }], "черновик на сервере");
    eq(s.db.parts_orders[0].sent_at, null, "до «Отправить» hleb заявку не видит");
    await p.tap("#zkSendBtn"); await p.waitForTimeout(200);
    assert(s.db.parts_orders[0].sent_at, "отправлена");
    // после отправки, пока нет статуса, ещё можно поправить
    await p.fill("#zkBody tr[data-i=\"2\"] .zk-qty", "4"); await p.press("#zkBody tr[data-i=\"2\"] .zk-qty", "Tab"); await p.waitForTimeout(800);
    eq(s.db.parts_orders[0].items[2].qty, 4, "правка после отправки");
    // профиль: логин, имя (задаёт hleb), своё фото
    await p.tap("#profileBtn");
    eq([await p.textContent("#zkMeLogin"), await p.textContent("#zkMeName")], ["ivan", "Иван"], "логин и имя в профиле");
    await p.setInputFiles("#zkAvatarFile", { name: "я.png", mimeType: "image/png", buffer: fs.readFileSync(path.join(ROOT, "icon-512.png")) });
    await p.waitForTimeout(400);
    assert(/^data:image\/jpeg/.test((s.db.user_avatars[0] || {}).data || ""), "фото сохранено на сервере");
    eq(await p.isVisible("#profileAvatar"), true, "фото на кнопке профиля");
    await p.tap("#zkAccountClose");

    const h = await device(s), q = await h.open("/uchet/"); await sync(q); await q.waitForTimeout(200);
    eq(await q.textContent("#ordBadge"), "1", "у hleb — 1 новый заказ");
    await q.click("#tabOrdersBtn"); await q.waitForTimeout(150);
    eq(await q.textContent("#ordCards .ord-author"), "Иван", "автор — имя ремонтника");
    eq(await q.$$eval("#ordCards img.ord-ava", (a) => a.length), 1, "фото ремонтника на карточке");
    await q.click("#ordCards .t-card"); await q.waitForTimeout(150);
    eq(await q.isDisabled("#ordToTicketBtn"), true, "без статуса в учёт не переносится");
    const iss = q.locator('#ordBody tr[data-i="0"] .ord-iss-input');
    await iss.fill("2"); await iss.press("Tab"); await q.waitForTimeout(150);
    eq(await q.textContent('#ordBody tr[data-i="0"] .ord-ask'), "из 3", "в «Шт» — сколько выдаём, в углу — сколько просили");
    await q.click('#ordBody tr[data-i="1"] .chk-toggle'); await q.waitForTimeout(150);
    eq(s.db.parts_orders[0].hleb_items[1].done, true, "галочка «собрано»");
    eq(s.db.parts_orders[0].status, "picking", "«выдано» у нового заказа — началась сборка");
    // ремонтник правит во время сборки: у hleb список не меняется сам, у ⟳ — «!»
    await p.evaluate(() => loadOrders()); await p.waitForTimeout(100);   // на устройстве статус приходит через Realtime
    eq((await p.textContent("#zkStatus")).trim(), "Собирается", "ремонтник видит сборку");
    const zq = '#zkBody tr[data-i="2"] .zk-qty';
    await p.fill(zq, "5"); await p.press(zq, "Tab"); await p.waitForTimeout(800);
    eq(s.db.parts_orders[0].items[2].qty, 5, "правка во время сборки ушла");
    assert((await p.textContent("#zkFoot")).includes("ждут подтверждения"), "ремонтник видит, что правка ждёт");
    await q.evaluate(() => loadOrders()); await q.waitForTimeout(100);
    eq(await q.inputValue('#ordBody tr[data-i="2"] .ord-iss-input'), "4", "список сборки сам не обновился");
    eq(await q.$eval("#ordRefreshBtn", (b) => b.classList.contains("pending")), true, "«!» у кнопки обновления");
    await q.click("#ordRefreshBtn"); await q.waitForTimeout(100);
    eq(await q.$$eval("#ordChList li", (a) => a.map((x) => x.textContent)), ["~ Шайба 8 — было 4, стало 5"], "окно с изменениями");
    await q.click("#ordChAccept"); await q.waitForTimeout(150);
    eq(s.db.parts_orders[0].hleb_items.map((it) => [it.qty, it.issued]), [[3, 2], [1, undefined], [5, undefined]], "принято, «выдано» сохранилось");
    // убрал деталь — hleb отказывает: список ремонтника возвращается
    await p.tap('#zkBody tr[data-i="1"] .zk-del'); await p.waitForTimeout(800);
    await q.evaluate(() => loadOrders()); await q.click("#ordRefreshBtn"); await q.waitForTimeout(100);
    eq(await q.$$eval("#ordChList li", (a) => a.map((x) => x.textContent)), ["− Мотор-колесо 333 — убрал"], "удаление в окне");
    await q.click("#ordChReject"); await q.waitForTimeout(150);
    eq(s.db.parts_orders[0].items.length, 3, "отказ — список ремонтника вернулся");
    await p.evaluate(() => loadOrders()); await p.waitForTimeout(100);
    eq(await p.$$eval("#zkBody tr[data-i]", (a) => a.length), 3, "ремонтник видит вернувшийся список");
    await q.click('#ordStatusBtns [data-st="partial"]'); await q.waitForTimeout(150);
    eq(s.db.parts_orders[0].status, "partial", "статус на сервере");
    eq(await q.textContent("#ordAccState"), "Не учтено", "ещё не учтено");
    // ремонтник больше не может править
    await p.evaluate(() => { const o = orders[0]; o.status = "new"; o.items[0].qty = 9; saveItems(o); });
    await p.waitForTimeout(300);
    eq(s.db.parts_orders[0].items[0].qty, 3, "сервер не принял правку после статуса");
    await p.waitForTimeout(200);
    eq(await p.textContent("#zkStatus"), "~ Собрано частично", "ремонтник видит статус");
    eq(await p.isVisible("#zkAddPanel"), false, "строки добавления нет");
    eq(await p.$$eval("#zkBody tr.zk-part", (a) => a.length), 1, "частично выданная деталь — жёлтая");

    await q.click("#ordToTicketBtn"); await q.waitForTimeout(300);
    const key = await q.evaluate(() => ticketKeys().pop());
    eq(key, TODAY(), "заявка на сегодня создана");
    eq(await q.evaluate((k) => dataByDate[k].counts, key), { "code::111": 2, "code::333": 1, "parts::Шайба 8": 5 }, "выданное — в учёте");
    assert(s.db.parts_orders[0].accounted_at, "отметка «Учтено» на сервере");
    assert((await q.textContent("#ordToTicketBtn")).startsWith("✓ Учтено"), "кнопка показывает «Учтено»");
    eq(await q.isDisabled('#ordStatusBtns [data-st="ready"]'), true, "учтённый заказ не правится");
    // второй заказ за день идёт в ту же (последнюю сегодняшнюю) заявку
    s.db.parts_orders.push({ id: "ord2", author: "petr", author_name: "Пётр", items: [{ code: "111", name: "Болт М6", qty: 1 }], status: "ready", created_at: "2026-01-01T00:00:00Z", sent_at: "2026-01-01T00:00:01Z", accounted_at: null, updated_at: "2026-01-01T00:00:01Z" });
    await q.evaluate(() => loadOrders()); await q.click('#ordCards .t-card[data-id="ord2"]'); await q.click("#ordToTicketBtn"); await q.waitForTimeout(300);
    eq(await q.evaluate(() => ticketKeys().length), 1, "новая заявка не создаётся");
    eq(await q.evaluate((k) => dataByDate[k].counts["code::111"], key), 3, "прибавилось в сегодняшнюю");
    await sync(q);
    eq(s.kv("potreblenie_data_by_date_v3")[key].counts["code::111"], 3, "учёт ушёл на сервер");
    await q.click('#ordCards .t-card[data-id="ord2"] .ord-del'); await q.waitForTimeout(150);
    eq(s.db.parts_orders.map((o) => o.id).includes("ord2"), false, "корзина удаляет заказ");
    eq(await q.$$eval("#ordCards .t-card", (a) => a.length), 1, "и из списка");
    eq(r.errors.concat(h.errors), [], "ошибки страницы"); await r.close(); await h.close();
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
    catch (e) { failed++; console.log("✗ " + name + "\n    " + String(e.message).split("\n")[0] + (process.env.DBG ? "\n" + e.stack : "")); }
  }
  await browser.close(); srv.close();
  console.log(failed ? `\nНе прошло: ${failed}` : "\nВсе тесты прошли");
  process.exit(failed ? 1 : 0);
})();
