/* Поиск деталей по складу / 1С / каталогу — общий для учёта (uchet/js/*) и заказов ремонтников (../zakaz/).
   Чистые функции без обращений к странице: хранилище — { parts: [{ code, name, model, model2, ... }] }. */
// Разбивает текст на «слова» по любым не-буквенно-цифровым разделителям
// (пробел, /, -, скобки и т.п.) — одинаково и для кириллицы, и для латиницы.
function splitWords(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// Поиск «по слову»: каждое слово запроса должно быть НАЧАЛОМ какого-то
// слова в названии — иначе короткий запрос («мк») находил бы буквы внутри
// чужого слова («каМКа»). Код по-прежнему ищется подстрокой в любом месте —
// так удобнее находить позицию по фрагменту кода.
function nameMatchesQuery(name, query) {
  const qWords = splitWords(query);
  if (qWords.length === 0) return false;
  const nWords = splitWords(name);
  return qWords.every((qw) => nWords.some((nw) => nw.startsWith(qw)));
}
// Насколько позиция подходит: 0 — код совпал целиком, 1 — набранное есть в коде, 2 — совпало название, -1 — нет.
// Код всегда выше названия: «25.21» ищет AB.50.0025.21, а не десятки деталей 9Bot с годами «21-25» в названии.
function matchRank(item, q) {
  const code = (item.code || "").toLowerCase();
  if (code && code === q) return 0;
  if (code.includes(q)) return 1;
  if (nameMatchesQuery((item.name || "").toLowerCase(), q) || (item.alt && nameMatchesQuery(item.alt.toLowerCase(), q))) return 2;
  return -1;
}
function searchStore(store, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  store.parts.forEach((item) => {
    const match = matchRank(item, q);
    if (match >= 0) {
      const r = { section: "parts", code: item.code || "", name: item.name, model: item.model || "", model2: item.model2 || "", match };
      if (item.idx !== undefined) r.idx = item.idx;         // инвентаризация: номер строки; alt — название из 1С
      if (item.ocqty !== undefined) r.ocqty = item.ocqty;   // у сменщика — остаток 1С из каталога
      if (item.ocName) r.ocName = item.ocName;              // название в 1С — для кодов-заглушек
      results.push(r);
    }
  });
  // Порядок в подсказках: сначала совпадения по коду, потом по названию; внутри — YGW 4.0 → YGW 5.0 → 9Bot →
  // остальные (без серии), дальше — как в списке. Показываются первые 12.
  const rank = (m) => { const i = SUGGEST_MODEL_ORDER.indexOf(String(m || "").trim()); return i === -1 ? SUGGEST_MODEL_ORDER.length : i; };
  return results.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.match - b.r.match) || (rank(a.r.model) - rank(b.r.model)) || (a.i - b.i))
    .map((x) => x.r).slice(0, 12);
}
const SUGGEST_MODEL_ORDER = ["YGW 4.0", "YGW 5.0", "9Bot"];
