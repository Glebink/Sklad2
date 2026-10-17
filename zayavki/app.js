'use strict';
try { localStorage.setItem('sklad2_last_module', 'zayavki'); } catch (e) {}
/* Заявки на закупку — PWA на Supabase. Без сборки, один файл. */
const APP_VERSION = 'v2.0';
// Клиент Supabase и вход общие для всех сервисов: см. ../auth.js
const { sb, authStore, emailOf, doLogin } = Auth;

const STATUS = {
  new: { label: 'Новая', cls: 's-new' },
  rejected: { label: 'Отказ', cls: 's-rejected' },
  accepted: { label: 'Принято', cls: 's-accepted' },
  ordered: { label: 'Заказано', cls: 's-ordered' }
};
const ROLE_LABEL = { requester: 'заявитель', boss: 'начальник' };

const svg = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  cart: svg('<path d="M6 6h15l-1.5 9H8z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>', 20),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 18),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 18),
  back: svg('<path d="m15 5-7 7 7 7"/>', 22),
  cam: svg('<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/>', 22),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 18),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', 18),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', 22),
  archive: svg('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>', 22),
  box: svg('<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/>', 22),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 14),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 18)
};

/* ---------- состояние ---------- */
const S = {
  ready: false, me: null, role: null, profiles: {}, requests: [], catalog: [], views: {},
  photoUrls: {}, photoStamp: 0, hist: {}, histLoading: {},
  account: false, modOpen: false, bossViews: {}, q: '', filter: 'all', draft: null, sheet: null, confirm: null, photo: null
};

/* ---------- утилиты ---------- */
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const fmt = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtShort = (s) => { const d = new Date(s); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const fmtFull = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ERR_MAP = [
  [/row-level security|violates row-level|permission denied|not allowed|forbidden|\b403\b/i, 'Нет прав на это действие. Возможно, вы вошли под другим пользователем — обновите страницу.'],
  [/failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|offline/i, 'Нет связи с сервером. Проверьте интернет и повторите.'],
  [/jwt|token.*(expired|invalid)|invalid.*token|not authenticated|session.*(missing|expired)|refresh token/i, 'Сессия закончилась. Войдите снова.'],
  [/invalid login credentials|invalid.*credentials/i, 'Неверный логин или пароль.'],
  [/password should be at least|at least \d+ characters|weak password/i, 'Пароль слишком короткий. Нужно не меньше 6 символов.'],
  [/different from the old|same as the old|should be different/i, 'Новый пароль должен отличаться от старого.'],
  [/payload too large|exceeded the maximum|too large|\b413\b|file size/i, 'Файл слишком большой. Максимум 2 МБ.'],
  [/mime type|not supported|invalid file type|unsupported/i, 'Этот формат файла не поддерживается. Нужен JPG, PNG или WebP.'],
  [/duplicate key|already exists|unique constraint/i, 'Такая запись уже есть.'],
  [/violates check constraint|invalid input|null value|not-null|violates not-null/i, 'Некорректные данные. Проверьте поля и повторите.'],
  [/foreign key/i, 'Связанная запись не найдена. Обновите страницу.'],
  [/bucket not found|object not found|not found|\b404\b/i, 'Данные не найдены. Обновите страницу.'],
  [/too many requests|rate limit|\b429\b/i, 'Слишком много запросов. Подождите немного.'],
  [/\b5\d\d\b|internal server error|bad gateway|unavailable/i, 'Ошибка сервера. Повторите позже.']
];
const errMsg = (e) => {
  const m = String((e && (e.message || e.error_description || e.error)) || e || '');
  if (/[а-яё]/i.test(m)) return m;
  for (const [re, ru] of ERR_MAP) if (re.test(m)) return ru;
  return 'Что-то пошло не так. Повторите попытку.';
};
const isDone = (i) => i.status === 'rejected' || i.status === 'ordered';
const isReq = () => S.role === 'requester';
const isBoss = () => S.role === 'boss';
const nameOf = (id) => (S.profiles[id] && S.profiles[id].name) || 'Пользователь';

function shopHref(u) {
  if (!u) return null;
  const t = String(u).trim();
  if (!t) return null;
  const full = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  try { const x = new URL(full); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; } catch (e) { return null; }
}
function shopLabel(u) {
  const h = shopHref(u);
  if (!h) return esc(u);
  try { return esc(new URL(h).host.replace(/^www\./, '')); } catch (e) { return esc(u); }
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- маршруты ---------- */
function getRoute() {
  const h = location.hash.replace(/^#/, '');
  let m;
  if ((m = h.match(/^\/r\/([0-9a-f-]{36})$/i))) return { name: 'detail', id: m[1] };
  if (h === '/archive') return { name: 'archive' };
  if (h === '/catalog') return { name: 'catalog' };
  if (h === '/new') return { name: 'new' };
  return { name: 'list' };
}

/* ---------- данные ---------- */
async function loadAll() {
  const [rq, cat, pr, vw] = await Promise.all([
    sb.from('requests').select('*, request_items(*)').order('number', { ascending: false }),
    sb.from('catalog_items').select('*').order('name'),
    sb.from('profiles').select('*'),
    sb.from('request_views').select('*')
  ]);
  const err = rq.error || cat.error || pr.error || vw.error;
  if (err) throw err;
  if (!pr.data.some((p) => p.user_id === S.me.id)) throw new Error('Для этой ссылки не назначена роль.');
  S.requests = rq.data.map((r) => ({
    ...r,
    items: (r.request_items || []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  }));
  S.catalog = cat.data;
  S.profiles = Object.fromEntries(pr.data.map((p) => [p.user_id, p]));
  S.views = Object.fromEntries(vw.data.filter((v) => v.user_id === S.me.id).map((v) => [v.request_id, v]));
  S.bossViews = Object.fromEntries(vw.data.filter((v) => S.profiles[v.user_id] && S.profiles[v.user_id].role === 'boss').map((v) => [v.request_id, v]));
  S.role = S.profiles[S.me.id] && S.profiles[S.me.id].role;
  await signPhotos();
}
async function signPhotos() {
  if (Date.now() - S.photoStamp > 45 * 60 * 1000) { S.photoUrls = {}; S.photoStamp = Date.now(); }
  const need = new Set();
  S.requests.forEach((r) => r.items.forEach((i) => { if (i.photo_path && !S.photoUrls[i.photo_path]) need.add(i.photo_path); }));
  S.catalog.forEach((c) => { if (c.photo_path && !S.photoUrls[c.photo_path]) need.add(c.photo_path); });
  if (!need.size) return;
  const { data } = await sb.storage.from('photos').createSignedUrls([...need], 3600);
  (data || []).forEach((x) => { if (x.signedUrl) S.photoUrls[x.path] = x.signedUrl; });
}
async function loadHist(id) {
  if (S.histLoading[id]) return;
  S.histLoading[id] = true;
  try {
    const [a, b] = await Promise.all([
      sb.from('status_history').select('*').eq('request_id', id).order('changed_at', { ascending: false }),
      sb.from('item_history').select('*').eq('request_id', id).order('changed_at', { ascending: false })
    ]);
    S.hist[id] = { st: a.data || [], it: b.data || [] };
  } finally { S.histLoading[id] = false; }
  const r = getRoute();
  if (r.name === 'detail' && r.id === id) render();
}
async function refresh() {
  try {
    await loadAll();
    render();
    const r = getRoute();
    if (r.name === 'detail') loadHist(r.id);
  } catch (e) {
    if (/Сессия закончилась/.test(errMsg(e))) showLogin('Сессия закончилась. Войдите снова.');
    else toast('Не удалось обновить: ' + errMsg(e));
  }
}
let refreshTimer = null;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); }
function subscribe() {
  sb.channel('zayavki-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'request_items' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'request_views' }, (p) => { const u = (p.new && p.new.user_id) || (p.old && p.old.user_id); if (u !== (S.me && S.me.id)) scheduleRefresh(); })
    .subscribe();
}

function isUnread(r) {
  if (r.last_activity_by === S.me.id) return false;
  if (S.seen && S.seen[r.id] === r.last_activity_at) return false;
  const v = S.views[r.id];
  return !v || Date.parse(r.last_activity_at) > Date.parse(v.seen_at);
}
function bossSeen(r) {
  // состояние просмотра заявки начальником (для заявителя)
  if (r.last_activity_by && S.profiles[r.last_activity_by] && S.profiles[r.last_activity_by].role === 'boss') return { ok: true, when: fmtShort(r.last_activity_at) };
  const v = S.bossViews[r.id];
  if (!v) return { ok: false, when: 'Начальник ещё не открывал заявку' };
  if (Date.parse(v.seen_at) >= Date.parse(r.last_activity_at)) return { ok: true, when: fmtShort(v.seen_at) };
  return { ok: false, when: 'Есть изменения после просмотра ' + fmtShort(v.seen_at) };
}
S.seenOpen = {};
const eyeTag = (r) => {
  const b = bossSeen(r), open = !!S.seenOpen[r.id];
  return `<span class="seen-wrap"><button type="button" class="seen ${b.ok ? 'ok' : ''}" data-act="seen-toggle" data-id="${r.id}" aria-expanded="${open}">${ICON.eye}${b.ok ? 'Просмотрено' : 'Не просмотрено'}</button>${open ? `<span class="seen-when">${esc(b.when)}</span>` : ''}</span>`;
};
function counts(items) {
  const c = { new: 0, rejected: 0, accepted: 0, ordered: 0 };
  items.forEach((i) => { c[i.status]++; });
  return c;
}

/* ---------- отрисовка ---------- */
const deskMQ = window.matchMedia('(min-width: 900px)');
const isDesk = () => deskMQ.matches;
function render() {
  if (!S.ready) return;
  const y = window.scrollY;
  const r = getRoute();
  const unread = S.requests.filter((x) => !x.archived_at && isUnread(x)).length;
  const tabs = [
    ['#/', 'list', 'Активные', ICON.list, unread],
    ['#/archive', 'archive', 'Архив', ICON.archive, 0],
    ['#/catalog', 'catalog', 'Каталог', ICON.box, 0]
  ];
  const activeTab = r.name === 'detail'
    ? ((S.requests.find((x) => x.id === r.id) || {}).archived_at ? 'archive' : 'list')
    : (r.name === 'new' ? 'list' : r.name);
  const tabsHTML = tabs.filter((t) => t[1] !== 'list').map((t) => `<a class="tab ${t[1] === activeTab ? 'active' : ''}" href="${t[1] === activeTab ? '#/' : t[0]}">${t[2]}</a>`).join('');
  const navHTML = tabs.map((t) => `<a class="${t[1] === activeTab ? 'active' : ''}" href="${t[0]}">${t[3]}${t[2]}${t[4] ? `<span class="count">${t[4]}</span>` : ''}</a>`).join('');

  const desk = isDesk();
  let body = '';
  if (desk) {
    const sreq = r.name === 'detail' ? S.requests.find((x) => x.id === r.id) : null;
    let right;
    if (r.name === 'detail') right = sreq ? detailHTML(sreq) : '<div class="empty">Заявка не найдена</div>';
    else if (r.name === 'archive') right = '<div class="narrow" style="max-width:none"><h1>Архив</h1><div id="archlist" style="display:flex;flex-direction:column;gap:10px;max-width:680px"></div></div>';
    else if (r.name === 'catalog') right = catalogHTML();
    else if (r.name === 'new') right = newHTML();
    else right = '<div class="empty">Выберите заявку слева</div>';
    body = `<div class="layout">${listPane(false, sreq && !sreq.archived_at ? r.id : null, false)}<section class="pane-detail">${right}</section></div>`;
  } else if (r.name === 'new') body = newHTML();
  else if (r.name === 'catalog') body = catalogHTML();
  else if (r.name === 'detail') {
    const req = S.requests.find((x) => x.id === r.id);
    body = `<div class="layout">${listPane(!!(req && req.archived_at), r.id, true)}<section class="pane-detail">${req ? detailHTML(req) : '<div class="empty">Заявка не найдена</div>'}</section></div>`;
  } else {
    body = `<div class="layout">${listPane(r.name === 'archive', null, false)}<section class="pane-detail hide-mobile"><div class="empty">Выберите заявку слева</div></section></div>`;
  }

  const showBar = desk ? false : r.name !== 'new';
  $('#app').innerHTML = `
    <header class="header">
      <div class="brand mod-wrap">
        <button class="brand-btn" data-act="mod-menu" aria-haspopup="true" aria-expanded="${S.modOpen}"><span class="brand-mark">${ICON.cart.replace('<svg', '<svg stroke="#fff"')}</span>Заявки на закупку<svg class="brand-caret" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
        ${S.modOpen ? `<div class="mod-panel"><a class="mod-item" href="../uchet/">Учёт потребления</a><a class="mod-item active" href="./#/">Заявки на закупку</a></div>` : ''}
      </div>
      <nav class="tabs" aria-label="Разделы">${tabsHTML}</nav>
      ${isReq() ? `<a class="btn primary btn-new" href="#/new">${ICON.plus}Новая заявка</a>` : ''}
      <button class="role-chip" data-act="account" aria-label="Аккаунт">Вы: ${esc(ROLE_LABEL[S.role] || '—')} ▾</button>
    </header>
    <main class="main ${desk || r.name === 'list' || r.name === 'archive' || r.name === 'detail' ? 'two' : ''}">${body}<div class="version">${APP_VERSION}</div></main>
    ${showBar ? `<nav class="bottom-nav" aria-label="Разделы">${navHTML}</nav>` : ''}
    ${showBar && isReq() && r.name !== 'detail' && r.name !== 'catalog' ? `<a class="fab" href="#/new">${ICON.plus}Новая заявка</a>` : ''}`;

  if (desk) {
    renderList();
    if (r.name === 'archive') { const box = $('#archlist'); const l = visibleRequests(true); box.innerHTML = l.length ? l.map((x) => reqCard(x, false)).join('') : '<div class="empty">В архиве пусто</div>'; }
  } else if (r.name === 'list' || r.name === 'archive' || r.name === 'detail') renderList();
  if (r.name === 'new') renderNewSuggest();
  if (r.name === 'catalog') renderCatalogList();
  window.scrollTo(0, y);

  if (r.name === 'detail') {
    const req = S.requests.find((x) => x.id === r.id);
    if (req) {
      if (isUnread(req)) markSeen(req);
      if (!S.hist[r.id]) loadHist(r.id);
    }
  }
}

function markSeen(req) {
  // seen_at не меньше времени последней активности, чтобы не мешали расхождения часов
  const now = new Date(Math.max(Date.now(), Date.parse(req.last_activity_at)) + 1).toISOString();
  S.seen = S.seen || {};
  S.seen[req.id] = req.last_activity_at;
  S.views[req.id] = { request_id: req.id, seen_at: now };
  sb.from('request_views').upsert({ request_id: req.id, seen_at: now }, { onConflict: 'user_id,request_id' }).then(() => {});
  setTimeout(render, 0);
}

/* ----- список заявок ----- */
function listPane(archived, selId, hideMobile) {
  const open = S.searchOpen || !!S.q;
  return `<section class="pane-list ${hideMobile ? 'hide-mobile' : ''}" data-archived="${archived ? 1 : 0}" data-sel="${esc(selId || '')}">
    <div class="pane-tools">
      <button class="icon-btn tool-btn ${open ? 'on' : ''}" data-act="search-toggle" aria-label="Поиск" aria-expanded="${open}">${ICON.search}</button>
      ${isReq() ? `<a class="icon-btn tool-btn tool-new" href="#/new" aria-label="Новая заявка">${ICON.plus}</a>` : ''}
    </div>
    ${open ? `<label class="search">${ICON.search}<input type="search" id="q" placeholder="Поиск по заявкам и товарам" value="${esc(S.q)}" autocomplete="off"></label>` : ''}
    <div id="reqlist" style="display:flex;flex-direction:column;gap:10px"></div>
  </section>`;
}
function visibleRequests(archived) {
  const q = S.q.trim().toLowerCase();
  return S.requests.filter((r) => !!r.archived_at === archived).filter((r) => {
    if (S.filter !== 'all' && !r.items.some((i) => i.status === S.filter)) return false;
    if (!q) return true;
    const hay = ('№' + r.number + ' ' + r.number + ' ' + r.items.map((i) => [i.name, i.shop_url, i.comment, i.boss_comment].join(' ')).join(' ')).toLowerCase();
    return hay.includes(q);
  });
}
function renderList() {
  const pane = document.querySelector('.pane-list');
  const box = $('#reqlist');
  if (!pane || !box) return;
  const archived = pane.dataset.archived === '1';
  const sel = pane.dataset.sel;
  const list = visibleRequests(archived);
  box.innerHTML = list.length ? list.map((r) => reqCard(r, r.id === sel)).join('')
    : `<div class="empty">${archived ? 'В архиве пусто' : 'Заявок нет'}</div>`;
}
function reqCard(r, sel) {
  const c = counts(r.items);
  const allDone = r.items.length > 0 && r.items.every(isDone);
  const chips = ['new', 'accepted', 'ordered', 'rejected'].filter((k) => c[k]).map((k) => `<span class="mini ${STATUS[k].cls}">${STATUS[k].label} ${c[k]}</span>`).join('');
  const n = r.items.length;
  return `<a class="req-card ${sel ? 'sel' : ''}" href="${sel ? (r.archived_at ? '#/archive' : '#/') : '#/r/' + r.id}">
    <div class="row between"><span class="mono">№ ${r.number}</span>
      <span class="row" style="gap:8px">${isUnread(r) ? '<span class="badge-new">Новое</span>' : ''}${isReq() ? eyeTag(r) : ''}</span>
    </div>
    <div class="muted" style="font-size:13px;margin-top:4px">${fmt(r.created_at)} · ${plural(n, 'позиция', 'позиции', 'позиций')}</div>
    <div class="minis">${chips}</div></a>`;
}

/* ----- карточка заявки ----- */
function thumb(path) {
  const url = path && S.photoUrls[path];
  if (url) return `<button class="thumb" data-act="photo" data-path="${esc(path)}" aria-label="Открыть фото"><img src="${esc(url)}" alt="Фото товара" loading="lazy"></button>`;
  return `<div class="thumb">${ICON.cam}</div>`;
}
function thumbPlain(path) {
  const url = path && S.photoUrls[path];
  return url ? `<span class="thumb"><img src="${esc(url)}" alt="" loading="lazy"></span>` : `<span class="thumb">${ICON.cam}</span>`;
}
function plural(n, a, b, c) {
  const m = n % 10, h = n % 100;
  return n + ' ' + (m === 1 && h !== 11 ? a : (m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c));
}
function pill(st) { const s = STATUS[st]; return `<span class="pill ${s.cls}"><i></i>${s.label}</span>`; }

function itemHTML(r, i) {
  const href = shopHref(i.shop_url);
  const canEdit = isReq() && i.status === 'new' && !r.archived_at;
  let side = pill(i.status);
  if (canEdit) side += `<div class="row"><button class="icon-btn" data-act="edit-item" data-id="${i.id}" aria-label="Редактировать позицию">${ICON.edit}</button>
    <button class="icon-btn" data-act="del-item" data-id="${i.id}" aria-label="Удалить позицию" style="color:var(--danger)">${ICON.trash}</button></div>`;
  const bossBlock = isBoss() ? `<div class="boss-ctl">
      <div class="seg" role="group" aria-label="Статус позиции">
        ${['rejected', 'accepted', 'ordered'].map((k) => `<button class="b-${k} ${i.status === k ? 'on' : ''}" data-act="set-status" data-id="${i.id}" data-status="${k}" aria-pressed="${i.status === k}">${i.status === k ? '✓ ' : ''}${STATUS[k].label}</button>`).join('')}
      </div>
      <label class="field"><span>Комментарий (необязательно)</span>
        <input class="input" id="bc-${i.id}" data-act="bc" data-id="${i.id}" value="${esc(i.boss_comment || '')}" maxlength="300"></label>
    </div>` : '';
  return `<div class="item">
    ${thumb(i.photo_path)}
    <div class="item-main">
      <div class="item-name">${esc(i.name)}</div>
      ${i.shop_url ? (href ? `<a class="item-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${shopLabel(i.shop_url)}</a>` : `<div class="item-link muted">${esc(i.shop_url)}</div>`) : ''}
      ${i.comment ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(i.comment)}</div>` : ''}
      ${!isBoss() && i.boss_comment ? `<div class="note boss"><strong>Начальник:</strong> ${esc(i.boss_comment)}</div>` : ''}
    </div>
    <div class="qty">${i.qty} шт.</div>
    ${isBoss() ? `<div class="item-side">${pill(i.status)}</div>` : `<div class="item-side">${side}</div>`}
    ${bossBlock}
  </div>`;
}

function detailHTML(r) {
  const allDone = r.items.length > 0 && r.items.every(isDone);
  let acts = '';
  if (isReq()) {
    acts = `<button class="btn ghost" data-act="add-item" data-req="${r.id}">${ICON.plus}Добавить позицию</button>
      <button class="btn" data-act="repeat" data-req="${r.id}">Повторить заявку</button>
      ${r.archived_at
        ? `<button class="btn" data-act="unarchive" data-req="${r.id}">Вернуть из архива</button>`
        : `<button class="btn" data-act="archive" data-req="${r.id}" ${allDone ? '' : 'disabled title="В архив можно, когда все позиции заказаны или отклонены"'}>В архив</button>`}`;
  }
  const h = S.hist[r.id];
  const stRows = h ? h.st.map((x) => `<div class="log-row ${STATUS[x.to_status].cls}"><div class="log-when">${fmtFull(x.changed_at)} · ${esc(nameOf(x.changed_by))}</div>
      <div>«${esc(x.item_name)}»: ${x.from_status === x.to_status ? `комментарий, статус «${STATUS[x.to_status].label}»` : `${STATUS[x.from_status].label} → <strong>${STATUS[x.to_status].label}</strong>`}</div>
      ${x.comment ? `<div class="muted" style="font-size:13px">«${esc(x.comment)}»</div>` : ''}</div>`).join('') : '';
  const itRows = h ? h.it.map((x) => `<div class="log-row"><div class="log-when">${fmtFull(x.changed_at)} · ${esc(nameOf(x.changed_by))}</div>
      <div>${x.action === 'added' ? 'Добавлено' : x.action === 'removed' ? 'Удалено' : 'Изменено'} «${esc(x.item_name)}»${x.action !== 'edited' && x.qty ? `, ${x.qty} шт.` : ''}${x.details ? `<div class="muted" style="font-size:13px">${esc(x.details)}</div>` : ''}</div></div>`).join('') : '';
  return `
    <a class="btn back-mobile" href="#/${r.archived_at ? 'archive' : ''}" style="align-self:flex-start">${ICON.back}Назад</a>
    <div class="head-card">
      <div style="flex:1;min-width:0"><div class="row between" style="align-items:flex-start"><h1>Заявка № ${r.number}</h1>${isReq() ? eyeTag(r) : ''}</div>
        <div class="muted" style="font-size:14px;margin-top:4px">Создана ${fmtFull(r.created_at)} · автор: ${esc(nameOf(r.created_by))}${r.archived_at ? ' · в архиве' : ''}</div></div>
      <div class="actions">${acts}</div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Позиции <span class="mono muted">${r.items.length}</span></h2></div>
      ${r.items.length ? r.items.map((i) => itemHTML(r, i)).join('') : '<div class="empty">Позиций нет</div>'}</div>
    <div class="cols">
      <div class="card"><h2>История позиций</h2><div class="log">${h ? (itRows || '<div class="muted">Пока пусто</div>') : '<div class="muted">Загрузка…</div>'}</div></div>
    </div>`;
}

/* ----- каталог ----- */
function catalogHTML() {
  return `<div class="narrow"><h1>Каталог товаров</h1>
    <p class="muted" style="margin:0">Все товары, которые когда-либо добавляли в заявки.</p>
    <label class="search">${ICON.search}<input type="search" id="catq" placeholder="Найти товар" value="${esc(S.catq || '')}" autocomplete="off"></label>
    ${isReq() ? `<button class="btn ghost block" data-act="cat-new">${ICON.plus}Добавить новый товар</button>` : ''}
    <div id="catlist" style="display:flex;flex-direction:column;gap:10px"></div></div>`;
}
function renderCatalogList() {
  const q = (S.catq || '').trim().toLowerCase();
  const list = S.catalog.filter((c) => !q || (c.name + ' ' + (c.shop_url || '')).toLowerCase().includes(q));
  $('#catlist').innerHTML = list.length ? list.map((c) => {
    const href = shopHref(c.shop_url);
    return `<div class="draft-item">${thumb(c.photo_path)}<div class="grow"><div class="item-name">${esc(c.name)}</div>
      ${c.shop_url ? (href ? `<a class="item-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${shopLabel(c.shop_url)}</a>` : `<span class="muted">${esc(c.shop_url)}</span>`) : ''}</div>
      ${isReq() ? `<button class="btn ghost" data-act="cat-add" data-id="${c.id}">В заявку</button>` : ''}</div>`;
  }).join('') : '<div class="empty">Ничего не найдено</div>';
}

/* ----- создание заявки ----- */
function ensureDraft() { if (!S.draft) S.draft = { requestId: null, items: [] }; return S.draft; }
function addToDraft(c, qty) {
  const d = ensureDraft();
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const ex = d.items.find((x) => x.catalog_item_id === c.id);
  if (ex) { ex.qty += qty; return; }
  d.items.push({ name: c.name, shop_url: c.shop_url || '', qty, comment: '', photo_path: c.photo_path || null, catalog_item_id: c.id });
}
function newHTML() {
  if (!isReq()) return '<div class="empty">Заявки создаёт заявитель</div>';
  const d = ensureDraft();
  return `<div class="narrow" style="padding-bottom:84px">
    <div class="row"><a class="icon-btn" href="#/" aria-label="Назад">${ICON.back}</a><h1>Новая заявка</h1></div>
    <div class="field"><span>Добавить из каталога</span>
      <label class="search" style="border:2px solid var(--accent)">${ICON.search}<input type="search" id="nvq" placeholder="Начните вводить название" autocomplete="off"></label></div>
    <div id="nvsug"></div>
    <button class="btn ghost block" data-act="draft-new">${ICON.plus}Добавить новый товар</button>
    <div class="muted" style="font-size:13px;font-weight:600">В заявке <span class="mono">${d.items.length}</span></div>
    <div id="draftlist" style="display:flex;flex-direction:column;gap:10px">${draftItemsHTML()}</div>
  </div>
  <div class="submit-bar"><button class="btn primary block" data-act="submit" ${d.items.length ? '' : 'disabled'}>Отправить</button></div>`;
}
function draftItemsHTML() {
  const d = ensureDraft();
  if (!d.items.length) return '<div class="empty">Пока ничего не добавлено</div>';
  return d.items.map((i, idx) => `<div class="draft-item">${thumb(i.photo_path)}
    <div class="grow"><div class="item-name">${esc(i.name)}</div><div class="muted" style="font-size:12px">${i.shop_url ? shopLabel(i.shop_url) + ' · ' : ''}${i.qty} шт.${i.comment ? ' · ' + esc(i.comment) : ''}</div></div>
    <button class="icon-btn" data-act="draft-edit" data-idx="${idx}" aria-label="Редактировать">${ICON.edit}</button>
    <button class="icon-btn" data-act="draft-del" data-idx="${idx}" aria-label="Убрать" style="color:var(--danger)">${ICON.trash}</button></div>`).join('');
}
function suggestHTML(q, act, withQty) {
  const t = q.trim().toLowerCase();
  const list = (t ? S.catalog.filter((c) => c.name.toLowerCase().includes(t)) : S.catalog.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))).slice(0, 6);
  if (!list.length) return t ? '<div class="muted" style="font-size:13px">В каталоге такого нет. Добавьте новый товар.</div>' : '';
  if (withQty) return `<div class="suggest">${list.map((c, n) => `<div class="sug-row" style="display:flex;align-items:center;flex-wrap:nowrap;gap:8px;padding:0 12px 0 0;min-height:56px;background:var(--surface);${n ? 'border-top:1px solid var(--line);' : ''}"><button type="button" class="sug-main" data-act="${act}" data-id="${c.id}" style="flex:1 1 auto;width:auto;min-width:0;min-height:56px;display:flex;align-items:center;gap:12px;padding:8px 0 8px 12px;border:0;background:transparent;text-align:left">${thumbPlain(c.photo_path)}
    <span class="grow" style="flex:1;min-width:0"><span class="item-name" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span><span class="muted" style="display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.shop_url ? shopLabel(c.shop_url) : 'без ссылки'}</span></span></button>
    <input type="number" min="1" inputmode="numeric" value="1" data-qty-for="${c.id}" aria-label="Количество" style="flex:none;width:44px;min-width:0;height:32px;padding:0;text-align:center;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);color:inherit;font-size:14px">
    <button type="button" class="sug-add" data-act="${act}" data-id="${c.id}" style="flex:none;width:auto;min-height:0;padding:6px 0;border:0;background:transparent;white-space:nowrap;color:var(--accent);font-weight:600;font-size:13px">Добавить</button></div>`).join('')}</div>`;
  return `<div class="suggest">${list.map((c) => `<button type="button" data-act="${act}" data-id="${c.id}">${thumbPlain(c.photo_path)}
    <span class="grow"><span class="item-name" style="display:block">${esc(c.name)}</span><span class="muted" style="font-size:12px">${c.shop_url ? shopLabel(c.shop_url) : 'без ссылки'}</span></span>
    <span style="color:var(--accent);font-weight:600;font-size:13px">Добавить</span></button>`).join('')}</div>`;
}
function renderNewSuggest() { const q = $('#nvq'); const box = $('#nvsug'); if (box) box.innerHTML = suggestHTML(q ? q.value : '', 'draft-add-cat', true); }

async function submitDraft() {
  const d = S.draft;
  if (!d || !d.items.length) return toast('Добавьте хотя бы одну позицию');
  const btn = document.querySelector('[data-act="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Отправка…'; }
  try {
    if (!d.requestId) {
      const id = uid();
      const { error } = await sb.from('requests').insert({ id });
      if (error) throw error;
      d.requestId = id;
    }
    const rows = d.items.map((i) => ({
      request_id: d.requestId, catalog_item_id: i.catalog_item_id || null, name: i.name,
      shop_url: i.shop_url || null, qty: i.qty, comment: i.comment || null, photo_path: i.photo_path || null
    }));
    const { error: e2 } = await sb.from('request_items').insert(rows);
    if (e2) throw e2;
    const id = d.requestId;
    S.draft = null;
    await loadAll();
    location.hash = '#/r/' + id;
    toast('Заявка отправлена');
  } catch (e) {
    toast(errMsg(e));
    render();
  }
}

/* ---------- окно позиции ---------- */
function openSheet(cfg) {
  S.sheet = { ...cfg, blob: null, previewUrl: null, busy: false, d: { name: '', shop_url: '', qty: 1, comment: '', photo_path: null, catalog_item_id: null, ...(cfg.data || {}) } };
  S.sheet.orig = { ...S.sheet.d };
  renderModal();
}
function renderModal() {
  const m = $('#modal');
  if (S.confirm) {
    m.hidden = false;
    m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p style="margin:0;font-size:16px">${esc(S.confirm.text)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-act="confirm-no">${esc(S.confirm.no || 'Отмена')}</button><button class="btn danger" data-act="confirm-yes">${esc(S.confirm.yes || 'Удалить')}</button></div></div>`;
    return;
  }
  if (S.account) {
    m.hidden = false;
    m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Аккаунт">
      <div class="row between"><h2>Аккаунт</h2><button class="icon-btn" data-act="close-modal" aria-label="Закрыть">${ICON.close}</button></div>
      <div class="muted" style="font-size:14px">Вы: ${esc(ROLE_LABEL[S.role] || '—')} · логин <strong>${esc((S.me.email || '').split('@')[0])}</strong></div>
      <form id="pwform" class="stack" autocomplete="off">
        <label class="field"><span>Новый пароль</span><input class="input" id="pw1" type="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>Повторите пароль</span><input class="input" id="pw2" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn primary" type="submit" id="pwbtn">Сменить пароль</button>
      </form>
      <button class="btn danger" data-act="logout">Выйти</button>
    </div>`;
    return;
  }
  if (S.photo) {
    m.hidden = false;
    m.innerHTML = `<div class="modal photo" data-act="close-modal"><img src="${esc(S.photo)}" alt="Фото товара"></div>`;
    return;
  }
  if (S.sheet) {
    const s = S.sheet, d = s.d;
    const prev = s.previewUrl || (d.photo_path && S.photoUrls[d.photo_path]) || null;
    m.hidden = false;
    m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Позиция">
      <div class="row between"><h2>${esc(s.title)}</h2><button class="icon-btn" data-act="sheet-cancel" aria-label="Закрыть">${ICON.close}</button></div>
      <div class="row" style="align-items:flex-start">
        <button type="button" class="photo-pick" data-act="sh-photo" aria-label="Добавить фото">${prev ? `<img src="${esc(prev)}" alt="Фото">` : `${ICON.cam}Фото`}</button>
        <input type="file" id="sh-file" accept="image/*" hidden>
        <label class="field" style="flex:1;min-width:0"><span>Название</span>
          <input class="input" id="sh-name" data-field="name" value="${esc(d.name)}" maxlength="200" autocomplete="off"></label>
      </div>
      ${prev ? '<button type="button" class="btn" data-act="sh-photo-clear" style="align-self:flex-start;min-height:36px">Убрать фото</button>' : ''}
      <div id="sh-sug"></div>
      <label class="field"><span>Ссылка на магазин</span><input class="input" data-field="shop_url" value="${esc(d.shop_url)}" inputmode="url" autocapitalize="off" maxlength="500"></label>
      ${s.mode === 'catalog' ? '' : `<div class="row" style="align-items:flex-end">
        <div class="field"><span>Количество</span><div class="stepper"><button type="button" data-act="qty-minus" aria-label="Меньше">−</button>
          <input id="sh-qty" data-field="qty" type="number" min="1" inputmode="numeric" value="${d.qty}" aria-label="Количество"><button type="button" data-act="qty-plus" aria-label="Больше">+</button></div></div>
        <label class="field" style="flex:1;min-width:0"><span>Комментарий</span><input class="input" data-field="comment" value="${esc(d.comment)}" maxlength="300"></label>
      </div>`}
      <div class="row" style="justify-content:flex-end;margin-top:4px"><button class="btn" data-act="sheet-cancel">Отмена</button><button class="btn primary" data-act="sheet-save" id="sh-save">Сохранить</button></div>
    </div>`;
    return;
  }
  m.hidden = true; m.innerHTML = '';
}
function sheetDirty() {
  const s = S.sheet; if (!s) return false;
  const d = s.d, o = s.orig || {};
  return !!s.blob || ['name', 'shop_url', 'comment'].some((k) => String(d[k] || '') !== String(o[k] || '')) || String(d.qty) !== String(o.qty) || (d.photo_path || null) !== (o.photo_path || null);
}
function requestClose() {
  if (S.confirm || S.photo || S.account) return closeModal();
  if (S.sheet && !S.sheet.busy && sheetDirty()) {
    const keep = S.sheet;
    S.confirm = { text: 'Закрыть окно? Введённые данные не сохранятся.', yes: 'Закрыть', no: 'Продолжить', onYes: null, back: keep };
    return renderModal();
  }
  closeModal();
}
function closeModal() { S.account = false; S.sheet = null; S.confirm = null; S.photo = null; renderModal(); }

async function compressImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, 1280 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Не удалось обработать фото'))), 'image/jpeg', 0.8));
}

async function saveSheet() {
  const s = S.sheet; if (!s || s.busy) return;
  const d = s.d;
  const name = d.name.trim();
  const qty = parseInt(d.qty, 10);
  if (!name) return toast('Введите название');
  if (s.mode !== 'catalog' && !(qty >= 1)) return toast('Количество должно быть не меньше 1');
  s.busy = true;
  const btn = $('#sh-save'); if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }
  try {
    if (s.blob) {
      const path = S.me.id + '/' + uid() + '.jpg';
      const { error } = await sb.storage.from('photos').upload(path, s.blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      d.photo_path = path;
      const { data } = await sb.storage.from('photos').createSignedUrl(path, 3600);
      if (data) S.photoUrls[path] = data.signedUrl;
    }
    const item = { name, shop_url: d.shop_url.trim() || null, qty, comment: d.comment.trim() || null, photo_path: d.photo_path || null };
    if (s.mode === 'catalog') {
      const { error } = await sb.from('catalog_items').insert({ name, shop_url: item.shop_url, photo_path: item.photo_path });
      if (error) { if (error.code === '23505') throw new Error('Такой товар уже есть в каталоге.'); throw error; }
      closeModal(); await refresh(); toast('Товар добавлен в каталог');
    } else if (s.mode === 'draft') {
      const row = { name, shop_url: item.shop_url || '', qty, comment: item.comment || '', photo_path: item.photo_path, catalog_item_id: d.catalog_item_id };
      const dr = ensureDraft();
      if (s.idx != null) dr.items[s.idx] = row; else dr.items.push(row);
      closeModal(); render();
    } else if (s.mode === 'req-new') {
      const { error } = await sb.from('request_items').insert({ request_id: s.reqId, catalog_item_id: d.catalog_item_id, ...item });
      if (error) throw error;
      closeModal(); await refresh();
    } else {
      const { data, error } = await sb.from('request_items').update(item).eq('id', s.itemId).select();
      if (error) throw error;
      if (!data || !data.length) throw new Error('Не удалось сохранить: позицию уже нельзя менять');
      closeModal(); await refresh();
    }
  } catch (e) {
    s.busy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
    toast(errMsg(e));
  }
}

/* ---------- действия ---------- */
async function setStatus(id, status) {
  const item = S.requests.flatMap((r) => r.items).find((i) => i.id === id);
  if (!item) return;
  const next = item.status === status ? 'new' : status;
  const inp = document.getElementById('bc-' + id);
  const comment = inp ? inp.value.trim() : (item.boss_comment || '');
  const { data, error } = await sb.from('request_items').update({ status: next, boss_comment: comment || null }).eq('id', id).select();
  if (error) return toast(errMsg(error));
  if (!data || !data.length) return toast('Не удалось изменить статус');
  await refresh();
}
async function saveBossComment(id, value) {
  const item = S.requests.flatMap((r) => r.items).find((i) => i.id === id);
  if (!item || (item.boss_comment || '') === value.trim()) return;
  const { error } = await sb.from('request_items').update({ boss_comment: value.trim() || null }).eq('id', id);
  if (error) return toast(errMsg(error));
  await refresh();
}
async function setArchived(reqId, on) {
  const { data, error } = await sb.from('requests').update({ archived_at: on ? new Date().toISOString() : null }).eq('id', reqId).select();
  if (error) return toast(errMsg(error));
  if (!data || !data.length) return toast('Не удалось изменить заявку');
  await refresh();
  if (on) toast('Заявка в архиве');
}
function askConfirm(text, yes, onYes) { S.confirm = { text, yes, onYes }; renderModal(); }

document.addEventListener('click', async (e) => {
  if (S.modOpen && !e.target.closest('.mod-wrap')) { S.modOpen = false; render(); }
  const el = e.target.closest('[data-act]');
  if (!el) { if (e.target.id === 'modal') requestClose(); return; }
  const act = el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'filter': S.filter = el.dataset.f; render(); break;
    case 'search-toggle': { const open = S.searchOpen || !!S.q; S.searchOpen = !open; if (open) S.q = ''; render(); if (S.searchOpen) { const q = $('#q'); if (q) q.focus(); } break; }
    case 'seen-toggle': e.preventDefault(); S.seenOpen[id] = !S.seenOpen[id]; render(); break;
    case 'mod-menu': S.modOpen = !S.modOpen; render(); break;
    case 'account': S.account = true; renderModal(); break;
    case 'logout': logout(); break;
    case 'photo': S.photo = S.photoUrls[el.dataset.path]; if (S.photo) renderModal(); break;
    case 'close-modal': closeModal(); break;
    case 'set-status': setStatus(id, el.dataset.status); break;
    case 'add-item': openSheet({ mode: 'req-new', reqId: el.dataset.req, title: 'Новая позиция' }); break;
    case 'edit-item': {
      const it = S.requests.flatMap((r) => r.items).find((i) => i.id === id);
      if (it) openSheet({ mode: 'req-edit', itemId: id, title: 'Позиция', data: { name: it.name, shop_url: it.shop_url || '', qty: it.qty, comment: it.comment || '', photo_path: it.photo_path, catalog_item_id: it.catalog_item_id } });
      break;
    }
    case 'del-item': {
      const it = S.requests.flatMap((r) => r.items).find((i) => i.id === id);
      askConfirm(`Удалить позицию «${it ? it.name : ''}» из заявки?`, 'Удалить', async () => {
        const { data, error } = await sb.from('request_items').delete().eq('id', id).select();
        if (error) return toast(errMsg(error));
        if (!data || !data.length) return toast('Позицию уже нельзя удалить');
        await refresh();
      });
      break;
    }
    case 'archive': setArchived(el.dataset.req, true); break;
    case 'unarchive': setArchived(el.dataset.req, false); break;
    case 'repeat': {
      const r = S.requests.find((x) => x.id === el.dataset.req);
      if (!r) break;
      S.draft = { requestId: null, items: r.items.map((i) => ({ name: i.name, shop_url: i.shop_url || '', qty: i.qty, comment: i.comment || '', photo_path: i.photo_path, catalog_item_id: i.catalog_item_id })) };
      location.hash = '#/new';
      break;
    }
    case 'cat-new': openSheet({ mode: 'catalog', title: 'Новый товар в каталог' }); break;
    case 'cat-add': {
      const c = S.catalog.find((x) => x.id === id);
      if (c) { addToDraft(c); toast('Добавлено в новую заявку'); }
      break;
    }
    case 'draft-add-cat': {
      const c = S.catalog.find((x) => x.id === id);
      if (c) { const qi = document.querySelector('[data-qty-for="' + id + '"]'); addToDraft(c, qi ? qi.value : 1); const q = $('#nvq'); if (q) q.value = ''; render(); }
      break;
    }
    case 'draft-new': openSheet({ mode: 'draft', title: 'Новый товар' }); break;
    case 'draft-edit': {
      const idx = +el.dataset.idx, it = S.draft.items[idx];
      openSheet({ mode: 'draft', idx, title: 'Позиция', data: { ...it } });
      break;
    }
    case 'draft-del': S.draft.items.splice(+el.dataset.idx, 1); render(); break;
    case 'submit': submitDraft(); break;
    case 'sheet-cancel': requestClose(); break;
    case 'sheet-save': saveSheet(); break;
    case 'confirm-no': { const b = S.confirm && S.confirm.back; S.confirm = null; if (b) S.sheet = b; renderModal(); break; }
    case 'confirm-yes': { const fn = S.confirm && S.confirm.onYes; S.confirm = null; closeModal(); if (fn) fn(); break; }
    case 'qty-minus': case 'qty-plus': {
      const d = S.sheet.d; const cur = parseInt(d.qty, 10) || 1;
      d.qty = Math.max(1, cur + (act === 'qty-plus' ? 1 : -1));
      $('#sh-qty').value = d.qty; break;
    }
    case 'sh-photo': $('#sh-file').click(); break;
    case 'sh-photo-clear': S.sheet.blob = null; S.sheet.previewUrl = null; S.sheet.d.photo_path = null; renderModal(); break;
    case 'sh-pick': {
      const c = S.catalog.find((x) => x.id === id);
      if (c) { const s = S.sheet; s.d.name = c.name; s.d.shop_url = c.shop_url || ''; s.d.photo_path = c.photo_path || null; s.d.catalog_item_id = c.id; s.blob = null; s.previewUrl = null; renderModal(); }
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { S.q = t.value; renderList(); return; }
  if (t.id === 'catq') { S.catq = t.value; renderCatalogList(); return; }
  if (t.id === 'nvq') { renderNewSuggest(); return; }
  if (t.dataset.field && S.sheet) {
    const f = t.dataset.field;
    S.sheet.d[f] = t.value;
    if (f === 'name') {
      S.sheet.d.catalog_item_id = null;
      const box = $('#sh-sug');
      if (box) box.innerHTML = (S.sheet.mode === 'req-edit' || S.sheet.mode === 'catalog') ? '' : suggestHTML(t.value, 'sh-pick').replace(/Добавить<\/span>/g, 'Выбрать</span>');
    }
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.act === 'bc') { saveBossComment(t.dataset.id, t.value); return; }
  if (t.id === 'sh-file' && t.files && t.files[0] && S.sheet) {
    try {
      const blob = await compressImage(t.files[0]);
      S.sheet.blob = blob;
      S.sheet.previewUrl = URL.createObjectURL(blob);
      renderModal();
    } catch (err) { toast(errMsg(err)); }
  }
});
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'pwform') {
    e.preventDefault();
    const a = $('#pw1').value, b = $('#pw2').value;
    if (a.length < 6) return toast('Пароль слишком короткий. Нужно не меньше 6 символов.');
    if (a !== b) return toast('Пароли не совпадают.');
    const btn = $('#pwbtn'); btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: a });
    btn.disabled = false;
    if (error) return toast(errMsg(error));
    closeModal(); toast('Пароль изменён');
  }
});
deskMQ.addEventListener('change', () => render());
window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.ready) refresh(); });

/* ---------- вход и запуск ---------- */
function logout() {
  closeModal();
  S.ready = false; S.me = null; S.role = null; S.draft = null; S.requests = []; S.catalog = [];
  started = false;
  Auth.clearSession();
  showLogin();
}
function showLogin(msg) {
  Auth.renderLogin($('#app'), { msg, onSuccess: () => { history.replaceState(null, '', location.pathname + location.search + '#/'); startApp(); } });
}
let started = false, authBound = false;
async function startApp() {
  let session;
  try { ({ data: { session } } = await Auth.withTimeout(sb.auth.getSession(), 10000)); }
  catch (e) {
    $('#app').innerHTML = '<div class="locked"><div><p class="muted">Не удалось проверить вход. Проверьте связь.</p><button class="btn primary" onclick="location.reload()">Повторить</button></div></div>';
    return;
  }
  if (!session) return showLogin();
  S.me = session.user;
  $('#app').innerHTML = '<div class="locked"><div class="muted">Загрузка…</div></div>';
  try { await Auth.withTimeout(loadAll(), 25000); } catch (e) { return showLogin('Не удалось загрузить данные: ' + errMsg(e)); }
  if (!S.role) return showLogin('Для этого аккаунта не назначена роль.');
  if (S.role === 'shift') { try { localStorage.setItem('sklad2_last_module', 'uchet'); } catch (e) {} location.replace('../uchet/'); return; }   // сменщику заявки на закупку недоступны
  S.ready = true;
  if (!started) { started = true; subscribe(); }
  if (!authBound) {
    authBound = true;
    {
    // Внутри обработчика нельзя ждать другие вызовы supabase.auth (зависает навсегда), поэтому через setTimeout.
    sb.auth.onAuthStateChange(() => {
      setTimeout(async () => {
        // сверяем со своей сессией: события из других вкладок не должны ломать эту
        const { data: { session: cur } } = await sb.auth.getSession();
        if (!S.ready) return;
        if (!cur) { S.ready = false; showLogin('Сессия закончилась. Войдите снова.'); }
        else if (cur.user.id !== S.me.id) location.reload();
      }, 0);
    });
    }
  }
  render();
}
async function boot() {
  $('#app').innerHTML = '<div class="locked"><div class="muted">Загрузка…</div></div>';
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const u = p.get('u'), k = p.get('k');
  if (u && k) { // старые личные ссылки продолжают работать
    history.replaceState(null, '', location.pathname + location.search + '#/');
    const ok = await doLogin(u, k, true);
    if (ok !== true) return showLogin('Ссылка не подошла. Войдите по логину и паролю.');
  }
  startApp();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('../sw.js').catch(() => {});
boot();

/* без масштабирования на мобильных */
['gesturestart', 'gesturechange', 'gestureend'].forEach((n) => document.addEventListener(n, (e) => e.preventDefault()));
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 300 && !e.target.closest('input,textarea,button,a')) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
