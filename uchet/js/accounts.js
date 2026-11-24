/* Учёт потребления — «Аккаунты» в окне профиля (только hleb).
   Список всех аккаунтов: имя, логин / пароль. Ремонтников hleb создаёт, меняет им имя и пароль,
   отключает и включает (отключённый не войдёт, его заказы остаются). Остальные роли — только в списке.
   Работает через функции сервера (accounts_list, account_create, account_set_password,
   account_set_name, account_set_disabled) — они же проверяют, что это hleb.
   Пароль хранится копией для hleb (account_passwords) — так решили 24.11; пароли — строчными.
   Файлы — обычные скрипты с общей областью видимости, подключаются по порядку (см. index.html). */
const ACC_ROLE = { requester: "Заявитель", boss: "Начальник", shift: "Сменщик", repair: "Ремонтник" };
let accRows = [];
function accMsg(text, err) {
  const el = document.getElementById("accMsg");
  el.textContent = text || ""; el.classList.toggle("err", !!err);
}
async function accRpc(fn, args) {
  const r = await Auth.withTimeout(Auth.sb.rpc(fn, args || {}), 15000);
  if (r.error) throw r.error;
  return r.data;
}
async function accLoad() {
  try { accRows = (await accRpc("accounts_list")) || []; accRender(); }
  catch (e) { document.getElementById("accList").innerHTML = `<div class="t-empty">Не загрузилось (нет связи?): ${escapeHtml(accErr(e))}</div>`; }
}
function accRender() {
  document.getElementById("accList").innerHTML = accRows.map((a) => {
    const repair = a.role === "repair";
    return `<div class="acc-row${a.disabled ? " off" : ""}" data-login="${escapeHtml(a.login)}">`
      + `<div class="acc-top"><b>${escapeHtml(a.name || a.login)}</b><span class="acc-role">${a.disabled ? "отключён" : ACC_ROLE[a.role] || a.role}</span></div>`
      + `<div class="acc-cred mono">${escapeHtml(a.login)} / ${a.password ? escapeHtml(a.password) : "—"}</div>`
      + (repair ? `<div class="acc-btns"><button class="util" data-act="name">Имя</button><button class="util" data-act="pass">Пароль</button>`
        + `<button class="util${a.disabled ? "" : " acc-off"}" data-act="toggle">${a.disabled ? "Включить" : "Отключить"}</button></div>` : "")
      + `</div>`;
  }).join("") || `<div class="t-empty">Аккаунтов нет.</div>`;
}
function accErr(e) { return (e && (e.message || e.error_description)) || String(e); }
async function accDo(fn, args, done) {
  accMsg("Сохраняю…");
  try { await accRpc(fn, args); accMsg(done); await accLoad(); }
  catch (e) { accMsg(accErr(e), true); }
}
document.getElementById("accList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = accRows.find((x) => x.login === b.closest(".acc-row").dataset.login);
  if (!a) return;
  if (b.dataset.act === "name") {
    const v = prompt("Имя для " + a.login + " (видно в заказах):", a.name || "");
    if (v != null && v.trim() && v.trim() !== a.name) accDo("account_set_name", { p_login: a.login, p_name: v.trim() }, "Имя изменено.");
  } else if (b.dataset.act === "pass") {
    const v = prompt("Новый пароль для " + a.login + " (от 6 символов, регистр не важен):", "");
    if (v != null && v.trim()) accDo("account_set_password", { p_login: a.login, p_password: v.trim() }, "Пароль изменён.");
  } else if (b.dataset.act === "toggle") {
    if (!a.disabled && !confirm("Отключить " + a.login + "? Войти он не сможет, заказы останутся.")) return;
    accDo("account_set_disabled", { p_login: a.login, p_disabled: !a.disabled }, a.disabled ? "Аккаунт включён." : "Аккаунт отключён.");
  }
});
document.getElementById("accNewForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target, login = f.login.value.trim();
  accDo("account_create", { p_login: login, p_password: f.password.value.trim(), p_name: f.name.value.trim() }, "Создан: " + login.toLowerCase() + ".")
    .then(() => { if (!document.getElementById("accMsg").classList.contains("err")) f.reset(); });
});
document.getElementById("accountsOpenBtn").addEventListener("click", () => {
  accMsg("");
  openModal("accountsOverlay");
  accLoad();
});
document.getElementById("accClose").addEventListener("click", () => closeModal("accountsOverlay"));
document.getElementById("accountsOverlay").addEventListener("click", (e) => { if (e.target.id === "accountsOverlay") closeModal("accountsOverlay"); });
