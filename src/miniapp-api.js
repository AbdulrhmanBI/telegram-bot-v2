// ============================================================================
// miniapp-api.js — Telegram Mini App backend ("library cart") for the content bot
//
//   GET  /api/content?v=<cachedVersion>   -> slim content tree read from the published KV snapshot
//   POST /api/send   {items:[{n,k}]}      -> sends up to 10 records + 10 files to the user's private chat
//
// Design goals (Cloudflare FREE plan):
//   * ZERO extra KV/D1 reads in the normal path: content comes from the bot's RAM -> edge -> KV
//     cache (loadContent), the slim JSON is built ONCE per isolate per content version.
//   * ZERO subrequests for validation: Telegram initData is verified with WebCrypto (CPU only),
//     cart items are validated against the in-memory snapshot (no D1).
//   * Few Telegram calls per send: all compatible photos/videos, documents, or audios in the
//     each compatible category is grouped into ONE sendMediaGroup call; the cart allows up to 10 records + 10 files.
//   * Telegram file_ids are NEVER sent to the browser. The client only knows a short hash (k).
// ============================================================================

import { normalizeSearchMeta } from "../public/app/search-core.js";

export const MAX_RECORD_ITEMS = 10;
export const MAX_FILE_ITEMS = 10;
export const MAX_TOTAL_ITEMS = MAX_RECORD_ITEMS + MAX_FILE_ITEMS;

const INITDATA_MAX_AGE_SEC = 24 * 60 * 60;     // reopen the app from the bot after 24h
const SEND_COOLDOWN_MS = 5000;                 // min gap between two sends of the same user (per isolate)
const SEND_HOURLY_CAP = 40;                    // max sends / user / hour (per isolate)
const GAP_BETWEEN_TG_CALLS_MS = 350;           // wall-clock pause only (no CPU), keeps Telegram flood limits happy
const SLIM_BUILD_REV = 5;                      // rev 5: `sm` preserves arbitrary value.field metadata and field order

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const enc = new TextEncoder();

function jsonRes(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });
}

// ----------------------------------------------------------------------------
// Hashing (same algorithm family the bot already uses): short stable key per Telegram file_id
// ----------------------------------------------------------------------------
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const fileKey = (fileId) => cyrb53(String(fileId));

// ----------------------------------------------------------------------------
// Telegram initData verification (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
// ----------------------------------------------------------------------------
async function hmacRaw(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN) — derived once per isolate
let SECRET_CACHE = { token: "", promise: null };
function webAppSecret(botToken) {
  if (SECRET_CACHE.token !== botToken || !SECRET_CACHE.promise) {
    SECRET_CACHE = { token: botToken, promise: hmacRaw(enc.encode("WebAppData"), enc.encode(botToken)) };
  }
  return SECRET_CACHE.promise;
}

async function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== "string" || initData.length > 4096 || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (_) { return null; }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const dcs = [...params.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = await webAppSecret(botToken);
  const sig = toHex(await hmacRaw(secret, enc.encode(dcs)));
  if (!safeEqual(sig, hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date")) || 0;
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || age > INITDATA_MAX_AGE_SEC || age < -300) return { expired: true };

  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch (_) {}
  if (!user || !user.id) return null;
  return { user };
}

// ----------------------------------------------------------------------------
// Slim content (built once per isolate per version, then served as a ready string)
// ----------------------------------------------------------------------------
function buildSlim(db) {
  const nodes = db.nodes || {};
  const rootId = String(db.root_id || 1);
  const out = {};
  const ids = new Set();
  const queue = [rootId];
  let fileCount = 0;

  while (queue.length) {
    const id = String(queue.shift());
    if (ids.has(id)) continue;
    const n = nodes[id];
    if (!n) continue;
    ids.add(id);

    const hidden = new Set((n.children_hidden || []).map(String));
    const rows = (n.children_rows || [])
      .map((row) => (row || []).filter((c) => !hidden.has(String(c)) && nodes[String(c)]).map(Number))
      .filter((row) => row.length);
    for (const row of rows) for (const c of row) queue.push(String(c));

    // files in the admin's display order (F:<index> tags), then any leftovers
    const files = n.files || [];
    const order = [];
    const used = new Set();
    for (const tag of n.display || []) {
      const [kind, s] = String(tag).split(":");
      const ix = parseInt(s || "0", 10);
      if (kind === "F" && files[ix] && !used.has(ix)) { used.add(ix); order.push(ix); }
    }
    for (let i = 0; i < files.length; i++) if (!used.has(i)) order.push(i);

    const slimFiles = [];
    for (const ix of order) {
      const f = files[ix];
      if (!f || !f.id) continue;
      const item = { k: fileKey(f.id), t: f.type || "document" };
      if (f.caption) item.c = String(f.caption).slice(0, 300);
      if (f.file_name) item.nm = String(f.file_name).slice(0, 200);
      if (f.file_size) item.s = Number(f.file_size) || undefined;
      // Generic structured search metadata (all registered fields). Optional for legacy files.
      // Only the normalized machine data is shipped (the admin's raw search_name stays server-side),
      // and Telegram file_ids are still never exposed.
      const sm = normalizeSearchMeta(f.search_meta);
      if (sm) item.sm = sm;
      slimFiles.push(item);
      fileCount++;
    }

    const node = { n: String(n.name || "") };
    if (rows.length) node.r = rows;
    if (slimFiles.length) node.f = slimFiles;
    if ((n.notes || []).length) node.o = n.notes.map(String);
    if ((n.urls || []).length) node.u = n.urls.map(String);
    out[id] = node;
  }

  const v = Number(db._v) || 0;
  const payload = { ok: true, v: v + "." + SLIM_BUILD_REV, root: Number(rootId), max: MAX_TOTAL_ITEMS, nodes: out, files: fileCount };
  return { v: payload.v, json: JSON.stringify(payload), ids };
}

async function getSlim(db) {
  const g = globalThis;
  const v = (Number(db && db._v) || 0) + "." + SLIM_BUILD_REV;
  if (g.__MINI_SLIM && g.__MINI_SLIM.v === v && g.__MINI_SLIM.src === db) return g.__MINI_SLIM;
  const slim = buildSlim(db);
  slim.src = db;
  g.__MINI_SLIM = slim;
  return slim;
}

// ----------------------------------------------------------------------------
// Light per-isolate throttling
// ----------------------------------------------------------------------------
function throttleCheck(uid) {
  const g = globalThis;
  if (!g.__MINI_RL) g.__MINI_RL = new Map();
  const now = Date.now();
  if (g.__MINI_RL.size > 2000) {
    for (const [k, rec] of g.__MINI_RL) if (now - rec.last > 3600_000) g.__MINI_RL.delete(k);
  }
  const rec = g.__MINI_RL.get(uid) || { last: 0, hour: [], busy: false };
  rec.hour = rec.hour.filter((t) => now - t < 3600_000);
  if (rec.busy) return { ok: false, reason: "busy", rec };
  if (now - rec.last < SEND_COOLDOWN_MS) return { ok: false, reason: "cooldown", retry: Math.ceil((SEND_COOLDOWN_MS - (now - rec.last)) / 1000), rec };
  if (rec.hour.length >= SEND_HOURLY_CAP) return { ok: false, reason: "hourly", rec };
  g.__MINI_RL.set(uid, rec);
  return { ok: true, rec };
}

// ----------------------------------------------------------------------------
// Auth + access gates (same rules as the bot: ban, required group membership)
// ----------------------------------------------------------------------------
async function authorize(request, env, ctx, deps) {
  if (!env.BOT_TOKEN) return { res: jsonRes({ ok: false, error: "server_misconfigured" }, 503) };
  const initData = request.headers.get("x-tg-init") || "";
  const v = await verifyInitData(initData, String(env.BOT_TOKEN));
  if (!v) return { res: jsonRes({ ok: false, error: "unauthorized" }, 401) };
  if (v.expired) return { res: jsonRes({ ok: false, error: "expired" }, 401) };
  const user = v.user;
  const uid = Number(user.id);

  let blocked = 0;
  try { blocked = await deps.getBlockedMode(env, uid, ctx); } catch (_) {}
  if (blocked) return { res: jsonRes({ ok: false, error: "banned" }, 403) };

  const isAdmin = deps.isAdmin(env, uid);
  if (!isAdmin && deps.membershipConfigured(env)) {
    const m = await deps.checkMembership(env, uid);
    if (!m.ok) return { res: jsonRes({ ok: false, error: "membership_unavailable" }, 503) };
    if (!m.member) return { res: jsonRes({ ok: false, error: "not_member" }, 403) };
  }
  return { user, uid, isAdmin };
}

// ----------------------------------------------------------------------------
// GET /api/content
// ----------------------------------------------------------------------------
async function handleContent(request, env, ctx, url, deps) {
  const auth = await authorize(request, env, ctx, deps);
  if (auth.res) return auth.res;

  // Successful authorization of GET /api/content is the Mini App open signal.
  // The monitor runs in the Worker and is fire-and-forget so it does not delay the UI response.
  try {
    if (ctx && typeof ctx.waitUntil === "function" && deps && typeof deps.monitorMiniAppOpen === "function") {
      ctx.waitUntil(deps.monitorMiniAppOpen(env, auth.user).catch(() => {}));
    }
  } catch (_) {}

  const db = await deps.loadContent(env, ctx);
  if (!db || !deps.integrity(db)) return jsonRes({ ok: false, error: "content_unavailable" }, 503);
  const slim = await getSlim(db);

  if (url.searchParams.get("v") === slim.v) return jsonRes({ ok: true, same: true, v: slim.v });
  return new Response(slim.json, { status: 200, headers: JSON_HEADERS });
}

// ----------------------------------------------------------------------------
// POST /api/send
// ----------------------------------------------------------------------------
const isRecordType = (type) => type === "voice" || type === "audio";

function mediaCategory(f) {
  if (f.type === "photo" || f.type === "video") return "pv";
  if (f.type === "document") return "doc";
  if (f.type === "audio") return "audio";
  return null; // voice notes and other unsupported media are sent individually
}

// One Telegram sendMediaGroup per compatible media category.
// Each compatible category is capped at 10 items by the 10-record + 10-file cart limits, so each category fits in one album.
// Photo + video share one group; documents and audio each get their own group.
// Unsupported types (for example stickers/voice) are sent individually.
function planSends(files) {
  const groups = new Map();
  const singletons = [];
  for (const f of files) {
    const cat = mediaCategory(f);
    if (!cat) {
      singletons.push([f]);
      continue;
    }
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }
  return [...groups.values(), ...singletons];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleSend(request, env, ctx, deps) {
  if (request.method !== "POST") return jsonRes({ ok: false, error: "method_not_allowed" }, 405);
  const auth = await authorize(request, env, ctx, deps);
  if (auth.res) return auth.res;

  let body = null;
  try {
    const text = await request.text();
    if (text.length > 4000) return jsonRes({ ok: false, error: "bad_request" }, 400);
    body = JSON.parse(text);
  } catch (_) { return jsonRes({ ok: false, error: "bad_request" }, 400); }

  const rawItems = Array.isArray(body && body.items) ? body.items : null;
  if (!rawItems || !rawItems.length) return jsonRes({ ok: false, error: "empty_cart" }, 400);
  if (rawItems.length > MAX_TOTAL_ITEMS) return jsonRes({ ok: false, error: "too_many", max: MAX_TOTAL_ITEMS }, 400);

  // sanitize + dedupe
  const wanted = [];
  const seen = new Set();
  for (const it of rawItems) {
    const n = String(it && it.n || "");
    const k = String(it && it.k || "");
    if (!/^\d{1,9}$/.test(n) || !/^[a-z0-9]{4,16}$/.test(k)) return jsonRes({ ok: false, error: "bad_request" }, 400);
    const key = n + "|" + k;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ n, k });
  }

  const db = await deps.loadContent(env, ctx);
  if (!db || !deps.integrity(db)) return jsonRes({ ok: false, error: "content_unavailable" }, 503);
  const slim = await getSlim(db);

  // Resolve against the published snapshot (visible nodes only). file_ids stay server-side.
  const resolved = [];
  const missing = [];
  for (const w of wanted) {
    const node = slim.ids.has(w.n) ? db.nodes[w.n] : null;
    const f = node && (node.files || []).find((x) => x && x.id && fileKey(x.id) === w.k);
    if (f) resolved.push({ id: f.id, type: f.type || "document", caption: f.caption || null, ref: w });
    else missing.push(w);
  }
  if (!resolved.length) return jsonRes({ ok: false, error: "none_available", missing }, 409);

  // Independent cart limits: up to 10 records (voice/audio) + up to 10 other files.
  const recordCount = resolved.filter((f) => isRecordType(f.type)).length;
  const fileCount = resolved.length - recordCount;
  if (recordCount > MAX_RECORD_ITEMS) {
    return jsonRes({ ok: false, error: "too_many_records", max: MAX_RECORD_ITEMS, records: recordCount, files: fileCount }, 400);
  }
  if (fileCount > MAX_FILE_ITEMS) {
    return jsonRes({ ok: false, error: "too_many_files", max: MAX_FILE_ITEMS, records: recordCount, files: fileCount }, 400);
  }

  const gate = throttleCheck(auth.uid);
  if (!gate.ok) {
    return jsonRes({ ok: false, error: gate.reason === "hourly" ? "rate_limited" : gate.reason, retry: gate.retry || 0 }, 429);
  }
  const rec = gate.rec;
  rec.busy = true;

  const chatId = auth.uid; // private chat with the bot == user id
  let sentFiles = 0;
  let messages = 0;
  const failed = [];

  try {
    const steps = planSends(resolved);
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      if (s > 0) await sleep(GAP_BETWEEN_TG_CALLS_MS);

      if (step.length >= 2) {
        const ok = await deps.sendGroup(env, chatId, step);
        if (ok) { sentFiles += step.length; messages += 1; continue; }
        // album rejected (e.g. one dead file_id): fall back to one-by-one so the rest still arrives
        for (const f of step) {
          await sleep(GAP_BETWEEN_TG_CALLS_MS);
          const mid = await deps.sendOne(env, chatId, f);
          if (mid) { sentFiles++; messages++; } else failed.push(f.ref);
        }
      } else {
        const f = step[0];
        const mid = await deps.sendOne(env, chatId, f);
        if (mid) { sentFiles++; messages++; } else failed.push(f.ref);
      }
    }
  } catch (e) {
    console.error("MINI_SEND_ERROR", e && e.message ? e.message : String(e));
  } finally {
    rec.busy = false;
    if (sentFiles > 0) { rec.last = Date.now(); rec.hour.push(Date.now()); }
  }

  if (sentFiles === 0) {
    // Most common cause: the user never pressed Start / blocked the bot.
    return jsonRes({ ok: false, error: "delivery_failed", failed, missing }, 502);
  }
  return jsonRes({ ok: true, sent: sentFiles, messages, failed, missing });
}

// ----------------------------------------------------------------------------
// Router (called by the Worker for every /api/* request)
// ----------------------------------------------------------------------------
export async function handleMiniApi(request, env, ctx, url, deps) {
  try {
    if (url.pathname === "/api/content" && request.method === "GET") return await handleContent(request, env, ctx, url, deps);
    if (url.pathname === "/api/send") return await handleSend(request, env, ctx, deps);
    return jsonRes({ ok: false, error: "not_found" }, 404);
  } catch (e) {
    console.error("MINI_API_ERROR", e && e.message ? e.message : String(e));
    return jsonRes({ ok: false, error: "server_error" }, 500);
  }
}
