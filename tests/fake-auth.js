/* Подделка auth.js для тестов: вместо Supabase — «сервер» в памяти тестового процесса (run.js),
   общий для всех «устройств» (контекстов браузера). Страница ходит к нему через fetch("/__srv").
   Логин и роль ниже подставляет run.js. */
(function () {
  const LOGIN = "__LOGIN__", ROLE = "__ROLE__";
  async function srv(op, args) {
    const r = await fetch("/__srv", { method: "POST", body: JSON.stringify({ op, login: LOGIN, args }) });
    return r.json();
  }
  // построитель запросов в объёме, который использует приложение
  function from(table) {
    const q = { table, op: "select", filters: [], payload: null, single: false };
    const api = {
      select() { return api; }, order() { return api; },
      eq(k, v) { q.filters.push([k, "eq", v]); return api; },
      in(k, v) { q.filters.push([k, "in", v]); return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      update(p) { q.op = "update"; q.payload = p; return api; },
      delete() { q.op = "delete"; return api; },
      single() { q.single = true; return api; }, maybeSingle() { q.single = true; return api; },
      then(res, rej) { srv("query", q).then(res, rej); }
    };
    return api;
  }
  const toDataUrl = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  const storage = { from() { return {
    async upload(path, file) { return srv("upload", { path, data: await toDataUrl(file) }); },
    async download(path) { const r = await srv("download", { path }); return r.error ? r : { data: await (await fetch(r.data)).blob() }; },
    async createSignedUrl(path) { const r = await srv("download", { path }); return r.error ? r : { data: { signedUrl: URL.createObjectURL(await (await fetch(r.data)).blob()) } }; },
    async remove(paths) { return srv("remove", { paths }); }
  }; } };
  const channel = { on() { return channel; }, subscribe() { return channel; } };
  window.Auth = {
    cachedRole() { return { role: ROLE, login: LOGIN }; },
    async loadRole() { return { role: ROLE, login: LOGIN }; },
    async getUser() { return { email: LOGIN + "@zayavki.app" }; },
    async gate(o) { setTimeout(() => o.onLogin(), 20); },
    withTimeout(p) { return p; },
    logout(msg) { window.__loggedOut = msg || true; },
    sb: { from, storage, rpc: async () => ({ data: true }), channel: () => channel, removeChannel() {} }
  };
})();
