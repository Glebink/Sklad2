'use strict';
/* База знаний — общее для списка (app.js) и окна просмотра файла (view.js).
   Данные — таблица kb_cells (files: [{ path, name, type, size }]), файлы — закрытый бакет kb.
   Права проверяет сервер (RLS): смотрят все вошедшие, менять может только hleb. */
const BUCKET = "kb";
const FILE_CACHE = "sklad2-kb-files";            // открытые файлы — для просмотра без связи
const CELLS_CACHE_KEY = "sklad2_kb_cells_v1";    // список ячеек — для работы без связи

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function sb() { return window.Auth && Auth.sb; }
function errText(e) { return (e && (e.message || e.error_description || e.error)) || String(e); }
function loadCellsLocal() { try { return JSON.parse(localStorage.getItem(CELLS_CACHE_KEY) || "[]") || []; } catch (e) { return []; } }
// Приложение на главном экране (iPhone): новая вкладка открылась бы в Safari без входа — открываем в том же окне
function isStandalone() { try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch (e) { return false; } }

function fileKind(f) {
  const n = String(f.name || "").toLowerCase(), t = String(f.type || "");
  if (/\.docx$/.test(n) || /wordprocessingml/.test(t)) return "docx";
  if (/\.xlsx$/.test(n) || /spreadsheetml/.test(t)) return "xlsx";
  if (/\.pdf$/.test(n) || t === "application/pdf") return "pdf";
  if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif)$/.test(n)) return "image";
  return "";
}

/* ---------- получение файла: кэш браузера → сервер ---------- */
const blobMem = new Map();
function cacheKey(path) { return new Request(location.origin + "/__kb/" + path); }
async function getFileBlob(f) {
  if (blobMem.has(f.path)) return blobMem.get(f.path);
  let cache = null;
  try { cache = await caches.open(FILE_CACHE); } catch (e) {}
  if (cache) {
    const hit = await cache.match(cacheKey(f.path));
    if (hit) { const b = await hit.blob(); blobMem.set(f.path, b); return b; }
  }
  const r = await Auth.withTimeout(sb().storage.from(BUCKET).download(f.path), 120000);
  if (r.error) throw r.error;
  const blob = r.data;
  blobMem.set(f.path, blob);
  if (cache) { try { await cache.put(cacheKey(f.path), new Response(blob, { headers: { "Content-Type": f.type || "application/octet-stream" } })); } catch (e) {} }
  return blob;
}
