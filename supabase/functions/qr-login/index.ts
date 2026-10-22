// QR-вход сменщика: по действующему токену из таблицы sklad_qr выдаёт одноразовый
// hashed_token для входа в аккаунт sklad (клиент обменивает его через verifyOtp).
// Токен действует 72 часа с момента выдачи (sklad_qr.created_at), потом нужен новый QR.
// Ключ service_role берётся из окружения функции и наружу не выходит.
// Развёрнута в Supabase (проект zayavki) как функция qr-login; здесь — копия исходника.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SHIFT_EMAIL = "sklad@zayavki.app";
const QR_TTL_MS = 72 * 3600 * 1000;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let token = "";
  try { token = String((await req.json()).token || ""); } catch (_) { /* пусто */ }
  if (!/^[0-9a-f]{48}$/.test(token)) return json({ error: "bad_token" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: row, error: e1 } = await admin.from("sklad_qr").select("token, created_at").eq("id", 1).maybeSingle();
  if (e1) return json({ error: "db" }, 500);
  const fresh = row && Date.now() - Date.parse(row.created_at) < QR_TTL_MS;
  if (!row || row.token !== token || !fresh) {
    await new Promise((r) => setTimeout(r, 500));   // против перебора
    return json({ error: "expired" }, 403);
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: SHIFT_EMAIL });
  if (error || !data?.properties?.hashed_token) return json({ error: "link" }, 500);
  return json({ token_hash: data.properties.hashed_token });
});
