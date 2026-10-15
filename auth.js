'use strict';
/* Общий вход для всех сервисов «Склада» (Учёт потребления, Заявки на закупку).
   Один клиент Supabase и одна сессия на оба сервиса: вошли в одном — открыт и другой.
   Подключается после библиотеки supabase-js и до app.js модуля. */
(function () {
  if (!window.supabase) return;   // библиотека не загрузилась: приложение работает локально
  var SUPABASE_URL = 'https://okgzagezzeeglkyrwbzv.supabase.co';
  // Публичный (anon) ключ: его безопасно хранить в коде, доступ ограничивают правила RLS на сервере.
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rZ3phZ2V6emVlZ2xreXJ3Ynp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3MzkyNjksImV4cCI6MjEwNzMxNTI2OX0.aVPwcJI4dtXEDhfy9pLXKH_nVVcsNgg69vC9mRqrPGU';
  var LOGIN_DOMAIN = 'zayavki.app';

  // Хранилище сессии: «только это окно» (sessionStorage) или «запомнить на устройстве» (localStorage).
  var authStore = {
    mode: 'local',
    getItem: function (k) { try { var a = sessionStorage.getItem(k); return a !== null ? a : localStorage.getItem(k); } catch (e) { return null; } },
    setItem: function (k, v) { try { if (authStore.mode === 'session' || sessionStorage.getItem(k) !== null) sessionStorage.setItem(k, v); else localStorage.setItem(k, v); } catch (e) {} },
    removeItem: function (k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {} }
  };
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    // lock: свой «замок» вместо navigator.locks. Общая блокировка между окнами/страницами могла
    // оставаться занятой предыдущей страницей (учёт → заявки) и вешать вход в соседнем сервисе.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: authStore,
            lock: function (name, acquireTimeout, fn) { return fn(); } }
  });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function emailOf(login) { var l = String(login || '').trim().toLowerCase(); return l.indexOf('@') >= 0 ? l : l + '@' + LOGIN_DOMAIN; }
  function sbKeys(store) { try { return Object.keys(store).filter(function (k) { return k.indexOf('sb-') === 0; }); } catch (e) { return []; } }
  function clearTabSession() { sbKeys(sessionStorage).forEach(function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }); }
  function hasStoredSession() { return sbKeys(localStorage).length > 0 || sbKeys(sessionStorage).length > 0; }
  function errText(e) {
    var m = String((e && e.message) || e || '');
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи с сервером. Проверьте интернет.';
    return 'Не удалось войти' + (m ? ' (' + m + ')' : '');
  }

  async function doLogin(login, password, remember) {
    if (!String(login || '').trim() || !password) return 'Введите логин и пароль.';
    if (remember) { authStore.mode = 'local'; clearTabSession(); } else authStore.mode = 'session';
    try {
      var r = await sb.auth.signInWithPassword({ email: emailOf(login), password: password });
      if (r.error) return /invalid/i.test(r.error.message) ? false : errText(r.error);
      return true;
    } catch (e) { return errText(e); }
  }
  // Выходим сразу, не дожидаясь сервера: при плохой связи запрос на выход может висеть долго.
  function clearSession() {
    sbKeys(localStorage).concat(sbKeys(sessionStorage)).forEach(function (k) { authStore.removeItem(k); });
    try { sb.removeAllChannels(); } catch (e) {}
    Promise.resolve().then(function () { return sb.auth.signOut({ scope: 'local' }); }).catch(function () {});
  }

  var MARK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
  function loginHTML(msg) {
    return '<div class="auth-wrap"><form class="auth-card" id="authform" autocomplete="on">'
      + '<div class="auth-mark">' + MARK + '</div>'
      + '<h1>Склад</h1>'
      + '<p class="auth-sub">Учёт потребления · Заявки на закупку</p>'
      + (msg ? '<p class="auth-msg">' + esc(msg) + '</p>' : '')
      + '<label class="auth-field"><span>Логин</span><input class="auth-input" name="login" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>'
      + '<label class="auth-field"><span>Пароль</span><input class="auth-input" name="password" type="password" autocomplete="current-password" required></label>'
      + '<label class="auth-check"><input type="checkbox" name="remember" checked><span>Запомнить на этом устройстве<small>Если снять галочку, вход действует только в этом окне.</small></span></label>'
      + '<div class="auth-err" id="authErr" role="alert"></div>'
      + '<button class="auth-btn" type="submit" id="authBtn">Войти</button>'
      + '</form></div>';
  }
  // Рисует форму входа в контейнер; после успешного входа вызывает opts.onSuccess().
  function renderLogin(box, opts) {
    opts = opts || {};
    box.innerHTML = loginHTML(opts.msg);
    var f = box.querySelector('#authform');
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      var err = box.querySelector('#authErr'), btn = box.querySelector('#authBtn');
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Вход…';
      var ok = await doLogin(f.login.value, f.password.value, f.remember.checked);
      if (ok === true) { if (opts.onSuccess) opts.onSuccess(); return; }
      btn.disabled = false; btn.textContent = 'Войти';
      err.textContent = ok === false ? 'Неверный логин или пароль.' : ok;
    });
    var first = f.login; if (first && !opts.noFocus) { try { first.focus(); } catch (e) {} }
  }

  // Ответ дольше timeoutMs считаем зависанием (например, блокировка входа занята другим окном).
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('network timeout')); }, ms); })]);
  }
  async function getUser() {
    try {
      var r = await sb.auth.getSession();
      return r && r.data && r.data.session ? r.data.session.user : null;
    } catch (e) { return null; }
  }

  /* Экран-«шлюз» поверх страницы для модулей без собственного входа (Учёт).
     Если сессия есть — сразу пропускает. Если нет связи и сессия сохранена на устройстве —
     тоже пропускает (работа офлайн), синхронизация сама скажет, что связи нет.
     Если сессия закончилась или вышли в другом окне — показывает вход снова. */
  var gateEl = null, gateReady = false, gateOpts = null;
  function showGate(msg) {
    if (!gateEl) {
      gateEl = document.createElement('div');
      gateEl.className = 'auth-gate';
      document.body.appendChild(gateEl);
    }
    gateEl.hidden = false;
    renderLogin(gateEl, { msg: msg, onSuccess: function () { hideGate(); if (gateOpts && gateOpts.onLogin) gateOpts.onLogin(); } });
  }
  function hideGate() { if (gateEl) { gateEl.hidden = true; gateEl.innerHTML = ''; } }
  async function gate(opts) {
    gateOpts = opts || {};
    var r;
    try { r = await withTimeout(sb.auth.getSession(), 10000); } catch (e) { r = { data: { session: null }, error: e }; }
    var session = r && r.data && r.data.session;
    var offlineOk = !session && hasStoredSession() && (!navigator.onLine || (r.error && /fetch|network/i.test(r.error.message || '')));
    if (!session && !offlineOk) showGate();
    else if (gateOpts.onLogin) gateOpts.onLogin();
    // ВАЖНО: внутри обработчика нельзя ждать другие вызовы supabase.auth (getSession и т.п.):
    // библиотека держит блокировку, пока обработчик не вернётся, и всё зависает навсегда
    // (в том числе вход в соседнем сервисе). Поэтому работу уносим в setTimeout.
    sb.auth.onAuthStateChange(function (event) {
      if (event !== 'SIGNED_OUT') return;
      setTimeout(async function () {
        var c = await getUser();
        if (!c) { if (gateOpts.onLogout) gateOpts.onLogout(); showGate('Сессия закончилась. Войдите снова.'); }
      }, 0);
    });
    gateReady = true;
  }
  function logout() { clearSession(); if (gateOpts) { if (gateOpts.onLogout) gateOpts.onLogout(); showGate(); } }

  window.Auth = {
    sb: sb, authStore: authStore, emailOf: emailOf, doLogin: doLogin, renderLogin: renderLogin,
    getUser: getUser, withTimeout: withTimeout, gate: gate, logout: logout, clearSession: clearSession, hasStoredSession: hasStoredSession
  };
})();
