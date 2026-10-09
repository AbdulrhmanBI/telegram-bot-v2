// Storage contract:
//   - KV DB namespace stores ONLY global published content keys: "db" and "db:backup:last".
//   - No per-user KV keys are read or written by this Worker.
//   - USER navigation paths remain durably persisted in D1, with RAM as the hot cache.
//   - ADMIN content viewing/editing uses the published KV snapshot plus a per-admin D1 draft/session.
//   - Authoritative content-table writes occur on explicit admin Save/Force Save (and recovery/admin operations).
//   - Block status: RAM (2 min) -> Cache API -> D1 primary-key read on a miss (bans are authoritative; a D1 error is never cached).
// ============================================================================
// Cloudflare Worker (Modules) — Production Content Engine
// Authoritative Store: Cloudflare D1 (SQL)
// Fast Edge Cache: Cloudflare KV (DB: key "db")
// Features: Atomic Commits, Version-Checked Drafts, Non-Destructive Edits, Safe Navigation,
//           Strict Admin Auth, Self-Healing Sync, Disaster Recovery /restore,
//           Full Telegram Media Browser, Built-in Calculator.
//           ADMIN CONTENT FLOW: published cache -> per-admin D1 draft/session -> D1 Save -> published cache sync.
// ============================================================================
// Bindings (wrangler.toml):
//   KV Namespaces:
//     DB                 // Global Content Cache (keys: "db", "db:backup:last")
//   D1 Databases:
//     SQL                // Primary D1 Database (users, paths, content)
//   Environment Variables / Secrets:
//     BOT_TOKEN               // Main Telegram Bot Token (Secret)
//     MEMBERSHIP_BOT_TOKEN    // Separate checker bot token (Secret); no webhook required
//     REQUIRED_CHAT_ID        // Required group/supergroup ID (accepts -100... or raw t.me/c/... numeric ID)
//     ADMIN_IDS               // Comma-separated Admin Telegram IDs
//     WEBHOOK_SECRET          // (REQUIRED) Secret token for x-telegram-bot-api-secret-token. The Worker refuses every update (503) when it is missing.
//     FILE_PROXY_TOKEN        // (Optional) Protects the Telegram file-streaming route /file/<id>; this is NOT a website proxy
//     SCHEMA_MANAGED          // "1" = schema.sql was applied; skip the Worker's own CREATE TABLE checks on cold start
//     PERF_LOG                // (Optional) "1" to print one [PERF] log line per webhook (off by default to save log volume)
//     POLL_CHAT_ID             // Legacy/unused for managed audience polls; polls are delivered to D1 users
//     MON_ADMIN_ID            // (Optional) Admin ID to receive monitor forwards
//     MON_ENABLED             // (Optional) "1" or "true" to enable live monitoring
// ============================================================================

import { handleMiniApi } from "./miniapp-api.js";
import {
  parseAdminSearchInput, normalizeSearchMeta, serializeSearchMeta, describeMeta, shortMeta, codesHelpText
} from "../public/app/search-core.js";

// Dependencies handed to the Mini App API (all are the bot's own helpers, so the Mini App obeys
// exactly the same ban / membership / cache rules as the chat). Built lazily to avoid TDZ issues.
let __MINI_DEPS = null;
function miniDeps() {
  if (__MINI_DEPS) return __MINI_DEPS;
  __MINI_DEPS = {
    loadContent: (env, ctx) => loadUserContentCacheOnly(env, ctx, makeCounters()),
    integrity: (db) => contentCacheIntegrity(db),
    getBlockedMode: (env, uid, ctx) => getBlockedModeUserFast(env, uid, ctx),
    isAdmin: (env, uid) => parseAdmins(env).includes(Number(uid)),
    membershipConfigured: (env) => membershipCheckerConfigured(env),
    checkMembership: (env, uid) => checkRequiredMembership(env, uid),
    sendGroup: (env, chatId, files) => tgSendMediaGroup(env, chatId, files.map((f) => ({ id: f.id, type: f.type, caption: f.caption }))),
    sendOne: (env, chatId, f) => sendMediaItem(env, chatId, { id: f.id, type: f.type, caption: f.caption }, { skipBlockCheck: true }),
    monitorMiniAppOpen: (env, user) => monitorMiniAppOpen(env, user)
  };
  return __MINI_DEPS;
}

export default {
  async fetch(request, env, ctx) {
    const counters = makeCounters();
    const url = new URL(request.url);

    // IMPORTANT: External websites are NEVER fetched through this Worker.
    // The Mini App embeds them directly in its iframe. This keeps website
    // browsing off the Worker's request/subrequest path and preserves the
    // Free-plan cost profile. The only /file/ proxy below is for Telegram
    // files that are already registered in the bot content database.

    // --- Misc Routes: Telegram file streaming proxy only (NOT an external web proxy) ---
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      return await handleFileProxy(request, env, url);
    }

    // --- Mini App API (library cart): /api/content and /api/send ---
    if (url.pathname.startsWith("/api/")) {
      return await handleMiniApi(request, env, ctx, url, miniDeps());
    }

    try {
      // --- Health check endpoint ---
      if (url.pathname === "/health") {
        return json({ ok: true, kv_db: !!env.DB, d1: !!env.SQL, webhook_secret: !!env.WEBHOOK_SECRET });
      }

      // --- Webhook entry point ---
      if (request.method === "POST" && url.pathname === "/webhook") {
        const perf = {
          t0: performance.now(),
          blk: 0,
          db: 0,
          path: 0,
          q_wait: 0,
          tg_edit: 0,
          action: "unknown"
        };
        const ok = (tag) => {
          const tot = performance.now() - perf.t0;
          const serverTiming = `tot;dur=${tot.toFixed(1)}, tg;dur=${perf.tg_edit.toFixed(1)}, q;dur=${perf.q_wait.toFixed(1)}, blk;dur=${perf.blk.toFixed(1)}, db;dur=${perf.db.toFixed(1)}, path;dur=${perf.path.toFixed(1)}`;
          const logTag = tag || perf.action || "webhook";
          if (env.PERF_LOG === "1") console.log(`[PERF] ${logTag} | tot: ${tot.toFixed(1)}ms | tg_edit: ${perf.tg_edit.toFixed(1)}ms | q_wait: ${perf.q_wait.toFixed(1)}ms | blk: ${perf.blk.toFixed(1)}ms | db: ${perf.db.toFixed(1)}ms | d1: ${(counters && counters.d1_reads) || 0}r/${(counters && counters.d1_writes) || 0}w | kv: ${(counters && counters.kv_reads) || 0}r/${(counters && counters.kv_writes) || 0}w`);
          return new Response('{"ok":true}', {
            headers: {
              "content-type": "application/json",
              "Server-Timing": serverTiming
            }
          });
        };

        // 1. Security: the secret token is MANDATORY (fail closed).
        if (!env.WEBHOOK_SECRET) {
          console.error("WEBHOOK_SECRET_MISSING: refusing to process unauthenticated updates");
          return new Response("webhook secret not configured", { status: 503 });
        }
        const gotSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
        if (!timingSafeEqualStr(gotSecret, String(env.WEBHOOK_SECRET))) {
          return new Response("forbidden", { status: 403 });
        }

        const update = await safeJson(request) || {};

        // Edited messages must never re-run navigation, pending admin input or /start.
        if (update.edited_message && !update.message) return ok("edited_ignored");

        // Duplicate update deduplication (per isolate). Runs BEFORE the early /start path.
        if (!globalThis.SEEN_UPDATE_IDS) globalThis.SEEN_UPDATE_IDS = new Map();
        const __updateId = update && update.update_id;
        if (__updateId != null) {
          const __nowMs = Date.now();
          if (globalThis.SEEN_UPDATE_IDS.size > 500) {
            for (const [k, exp] of globalThis.SEEN_UPDATE_IDS) {
              if (exp < __nowMs) globalThis.SEEN_UPDATE_IDS.delete(k);
            }
          }
          const __prevExp = globalThis.SEEN_UPDATE_IDS.get(__updateId);
          if (__prevExp && __prevExp > __nowMs) return ok("dedup");
          globalThis.SEEN_UPDATE_IDS.set(__updateId, __nowMs + 5 * 60 * 1000);
        }

        // ====================================================================
        // ABSOLUTE EARLY /start PATH
        // IMPORTANT: this runs immediately after JSON parsing and BEFORE
        // dedup, block checks, profile sync, D1 content loading, monitor,
        // or any other user pipeline. Only the global content-cache KV key
        // `db` is read. No user KV keys are touched.
        // ====================================================================
        const earlyMsg = update.message || null
        const earlyText = (earlyMsg && earlyMsg.text ? String(earlyMsg.text) : '').trim()
        // ====================================================================
        // /app  ->  inline button that opens the Mini App (library cart).
        // Same gates as /start: private chat only, silent for banned / non-members.
        // ====================================================================
        if (earlyMsg && earlyText && /^\/app(@\w+)?$/i.test(earlyText)) {
          const appChatType = String((earlyMsg.chat && earlyMsg.chat.type) || '').toLowerCase()
          const appFrom = earlyMsg.from || null
          const appChatId = earlyMsg.chat && earlyMsg.chat.id
          if (appChatType !== 'private' || !appFrom) return ok('app_non_private_ignored')
          try {
            const appBlock = await getBlockedModeUserFast(env, appFrom.id, ctx)
            if (appBlock) return ok('app_blocked')
            if (!parseAdmins(env).includes(Number(appFrom.id)) && membershipCheckerConfigured(env)) {
              const mm = await checkRequiredMembership(env, appFrom.id)
              if (!mm.ok || !mm.member) return ok('app_membership_denied')
            }
            const appUrl = String(env.MINIAPP_URL || (url.origin + '/app/'))
            const appSend = await tgFetchWithTimeout(TG(env) + '/sendMessage', {
              method: 'POST', headers: CTH,
              body: JSON.stringify({
                chat_id: appChatId,
                text: 'Open the app, pick your files, and get everything in one go.',
                reply_markup: { inline_keyboard: [[{ text: '📚 Open Library', web_app: { url: appUrl } }]] }
              })
            }, 8000)
            const appSendJson = await appSend.json().catch(() => null)
            if (appSendJson && appSendJson.ok && appSendJson.result && appSendJson.result.message_id && ctx && typeof ctx.waitUntil === 'function') {
              ctx.waitUntil(monitorOutgoingMessages(env, appChatId, [appSendJson.result.message_id]).catch(() => {}))
            }
          } catch (e) { console.error('APP_CMD_ERROR', e && e.message ? e.message : String(e)) }
          return ok('app_cmd')
        }

        if (earlyMsg && earlyText && (earlyText.startsWith('/start') || earlyText.toLowerCase() === 'open sesame')) {
          const start0 = performance.now()
          const earlyChatId = earlyMsg.chat && earlyMsg.chat.id
          const earlyChatType = String((earlyMsg.chat && earlyMsg.chat.type) || '').toLowerCase()
          const earlyFrom = earlyMsg.from || null
          if (earlyChatType !== "private") {
            return ok("start_non_private_ignored");
          }

          // Monitor /start before membership and block checks so denied/blocked users
          // are still visible to the monitor without receiving any bot response.
          queueMonitorUpdate(env, ctx, update, earlyMsg, earlyFrom, earlyChatId);

          if (earlyFrom && !parseAdmins(env).includes(Number(earlyFrom.id)) && membershipCheckerConfigured(env)) {
            const membership = await checkRequiredMembership(env, earlyFrom.id);
            // Non-members stay completely silent. No gate message, no join prompt.
            // They ARE registered in the users table though, so the admin can see and message them.
            if (!membership.ok || !membership.member) {
              registerGatedUser(env, ctx, earlyFrom, earlyMsg, counters, !!membership.ok);
              return ok(membership.ok ? "membership_denied_start" : "membership_check_error_start");
            }
            markUserInGroup(env, ctx, earlyFrom.id);
          }

          __dbg('START_EARLY_ENTER', JSON.stringify({
            update_id: update && update.update_id,
            chat_id: earlyChatId,
            chat_type: earlyChatType,
            has_db_binding: !!(env && env.DB),
          }))

          try {
            if (!env || !env.BOT_TOKEN || !env.DB || typeof env.DB.get !== 'function') {
              console.error('START_EARLY_CONFIG_MISSING', JSON.stringify({
                bot_token: !!(env && env.BOT_TOKEN),
                db: !!(env && env.DB),
              }))
              return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
            }

            // RAM -> Edge -> KV (single-flight, integrity-checked, backup fallback).
            // Reading the shared RAM/edge copy first avoids one KV read per /start.
            let startDb = null
            try {
              startDb = await loadUserContentCacheOnly(env, ctx, counters)
            } catch (e) {
              console.error('START_EARLY_LOAD_ERROR', e && e.message ? e.message : String(e))
            }
            if (!startDb || !contentCacheIntegrity(startDb)) {
              console.error('START_EARLY_CACHE_UNAVAILABLE', JSON.stringify(contentCacheSummary(startDb)))
              return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
            }

            const rootId = Number(startDb && startDb.root_id) || 1
            const root = startDb && startDb.nodes && startDb.nodes[String(rootId)]
            if (!root) {
              console.error('START_EARLY_ROOT_MISSING', JSON.stringify({ rootId }))
              return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
            }

            let earlyBlockMode = 0;
            try {
              earlyBlockMode = await getBlockedModeUserFast(env, earlyFrom && earlyFrom.id, ctx);
            } catch (_) {}
            if (earlyBlockMode === 1) return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
            if (earlyBlockMode === 2) {
              ctx && typeof ctx.waitUntil === 'function'
                ? ctx.waitUntil(tgSend(env, earlyChatId, BAN_NOTICE_TEXT, { skipBlockCheck: true, skipLog: true }).catch(() => {}))
                : await tgSend(env, earlyChatId, BAN_NOTICE_TEXT, { skipBlockCheck: true, skipLog: true }).catch(() => {});
              return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
            }

            const welcome = safeTelegramHtml(personalizeText(getWelcome(startDb), earlyFrom))
            // Private chats use the real Telegram reply keyboard (buttons above the input).
            // The normal message handler already resolves these button texts against the
            // user's current path, so no callback_query is needed for user navigation.
            // Main bot is private-chat only; non-private /start updates are discarded above.
            const keyboard = (earlyChatType === 'private')
              ? replyKbFromNode(startDb, root, false)
              : userInlineKbFromNode(startDb, root, false)
            const keyboardRows = (keyboard && Array.isArray(keyboard.keyboard))
              ? keyboard.keyboard
              : (keyboard && Array.isArray(keyboard.inline_keyboard) ? keyboard.inline_keyboard : [])
            const keyboardButtonCount = keyboardRows.reduce((n, row) => n + (Array.isArray(row) ? row.length : 0), 0)
            __dbg('START_EARLY_KEYBOARD', JSON.stringify({
              root_id: rootId,
              kind: (earlyChatType === 'private') ? 'reply' : 'inline',
              rows: keyboardRows.length,
              buttons: keyboardButtonCount,
              first_labels: keyboardRows.slice(0, 3).map(row => (row || []).map(b => String((b && b.text) || '')))
            }))

            // Reliable delivery: call Telegram's Bot API directly and record the
            // real result. We still return HTTP 200 to Telegram even if the Bot API
            // rejects the send, preventing webhook retry amplification.
            let tgJson = null;
            try {
              const res = await tgFetchWithTimeout(
                TG(env) + '/sendMessage',
                {
                  method: 'POST',
                  headers: CTH,
                  body: JSON.stringify({
                    chat_id: earlyChatId,
                    text: welcome || 'Please choose from the buttons below.',
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                  }),
                },
                8000,
              );
              tgJson = await res.json().catch(() => null);
              if (!(tgJson && tgJson.ok) && tgJson && /parse entities|can't parse/i.test(String(tgJson.description || ''))) {
                // Admin welcome text broke the HTML parser: resend as plain text.
                const res2 = await tgFetchWithTimeout(
                  TG(env) + '/sendMessage',
                  { method: 'POST', headers: CTH, body: JSON.stringify({ chat_id: earlyChatId, text: stripTelegramHtml(welcome) || 'Please choose from the buttons below.', reply_markup: keyboard }) },
                  8000,
                );
                tgJson = await res2.json().catch(() => null);
              }
              if (tgJson && tgJson.ok && tgJson.result && tgJson.result.message_id && ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(monitorOutgoingMessages(env, earlyChatId, [tgJson.result.message_id]).catch(() => {}))
              }
              __dbg('START_EARLY_RESULT', JSON.stringify({
                status: res.status,
                ok: !!(tgJson && tgJson.ok),
                error_code: tgJson && tgJson.error_code,
                description: tgJson && tgJson.description,
                ms: (performance.now() - start0).toFixed(1),
              }));
            } catch (e) {
              console.error('START_EARLY_TG_EXCEPTION', e && e.message ? e.message : String(e));
            }

            if (tgJson && tgJson.ok && update && update.update_id != null) {
              if (!globalThis.SEEN_UPDATE_IDS) globalThis.SEEN_UPDATE_IDS = new Map();
              globalThis.SEEN_UPDATE_IDS.set(update.update_id, Date.now() + 5 * 60 * 1000);
            }

            // Everything below the first menu is strictly non-critical.
            try {
              if (ctx && typeof ctx.waitUntil === 'function') {
                if (typeof d1SetPath === 'function' && earlyChatId != null) {
                  ctx.waitUntil(Promise.resolve().then(() => d1SetPath(env, 'path:user:' + earlyChatId, [rootId], counters, ctx, { force: true })).catch(() => {}))
                }
                if (typeof d1SyncUserProfile === 'function') {
                  ctx.waitUntil(Promise.resolve().then(() => d1SyncUserProfile(env, earlyFrom, earlyMsg, counters, ctx)).catch(() => {}))
                }
                const wObj = startDb && startDb.settings && startDb.settings.welcome_obj
                if (wObj && ((wObj.notes && wObj.notes.length) || (wObj.files && wObj.files.length) || (wObj.urls && wObj.urls.length))) {
                  ctx.waitUntil(sendAllContents(env, earlyChatId, wObj).catch((e) => console.error('START_EARLY_CONTENT_ERROR', e && e.message ? e.message : String(e))))
                }
              }
            } catch (e) {
              console.error('START_EARLY_BG_ERROR', e && e.message ? e.message : String(e))
            }

            return ok("start_early");
          } catch (e) {
            console.error('START_EARLY_FATAL', e && e.message ? e.message : String(e))
            return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
          }
        }

        // 2. (Duplicate update deduplication now runs right after JSON parsing.)

        // ====================================================================
        // Native Telegram Poll updates
        // `poll_answer` is the important one here: it contains the real user
        // and the currently selected 0-based option IDs for non-anonymous polls.
        // Handle it before the normal private-chat pipeline because this update
        // does not contain a Message/chat object.
        // ====================================================================
        if (update && update.poll_answer) {
          try {
            await handleManagedPollAnswer(env, update.poll_answer);
          } catch (e) {
            console.error("POLL_ANSWER_ERROR:", e && e.message ? e.message : String(e));
          }
          return ok("poll_answer");
        }

        if (update && update.poll) {
          try {
            await handleManagedPollState(env, update.poll);
          } catch (e) {
            console.error("POLL_STATE_ERROR:", e && e.message ? e.message : String(e));
          }
          return ok("poll_state");
        }

        const msg  = update.message || update.edited_message || (update.callback_query ? update.callback_query.message : null);
        const from = (update.message && update.message.from) || (update.edited_message && update.edited_message.from) || (update.callback_query && update.callback_query.from) || null;


        // Ignore Telegram service messages
        if (update.message && (
          update.message.new_chat_members || update.message.left_chat_member ||
          update.message.pinned_message || update.message.new_chat_title ||
          update.message.new_chat_photo || update.message.delete_chat_photo ||
          update.message.group_chat_created || update.message.supergroup_chat_created ||
          update.message.channel_chat_created || update.message.migrate_to_chat_id ||
          update.message.migrate_from_chat_id || update.message.video_chat_started ||
          update.message.video_chat_ended
        )) {
          return ok("service_msg");
        }

        // Ignore unhandled updates without user interaction (e.g. channel_post, my_chat_member)
        if (!msg && !update.callback_query) {
          return ok("unhandled");
        }

        const chat_id = msg && msg.chat ? msg.chat.id : (update.callback_query && update.callback_query.message && update.callback_query.message.chat ? update.callback_query.message.chat.id : null);
        const rawText = (msg && msg.text ? String(msg.text) : "");
        const replyButtonMeta = decodeReplyButtonText(rawText);
        const text = replyButtonMeta.label;
        const admins = parseAdmins(env);
        const isAdmin = from ? admins.includes(from.id) : false;
        const chatType = String((msg && msg.chat && msg.chat.type) || (update.callback_query && update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.type) || "").toLowerCase();

        if (chatType !== "private") {
          return ok("non_private_ignored");
        }

        const isCq = !!update.callback_query;

        // Monitor all private user activity before membership/block/content gates.
        // This is deliberately fire-and-forget, so monitoring never delays the bot.
        queueMonitorUpdate(env, ctx, update, msg, from, chat_id);

        // /check is the explicit, immediate membership verification command.
        // It always bypasses the 30-second cache. Non-members receive no response.
        if (!isCq && /^\/check(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
          const uid = from && from.id;
          if (!uid) return ok("membership_check_no_user");
          if (admins.includes(Number(uid))) {
            await tgSend(env, chat_id, "✅ <b>Membership check bypassed for admin.</b>", { parse_mode: "HTML", skipBlockCheck: true, skipLog: true });
            return ok("membership_check_admin");
          }
          if (!membershipCheckerConfigured(env)) return ok("membership_check_not_configured");
          const membership = await checkRequiredMembership(env, uid, { forceRefresh: true });
          if (!membership.ok || !membership.member) {
            if (!isCq) registerGatedUser(env, ctx, from, msg, counters, !!membership.ok);
            return ok(membership.ok ? "membership_check_not_member" : "membership_check_error");
          }
          markUserInGroup(env, ctx, from.id);
          await tgSend(env, chat_id, "✅ <b>Membership verified.</b>", { parse_mode: "HTML", skipBlockCheck: true, skipLog: true });
          return ok("membership_verified");
        }

        if (from && !admins.includes(Number(from.id)) && membershipCheckerConfigured(env)) {
          const membership = await checkRequiredMembership(env, from.id);
          // Completely silent for non-members (and fail-closed if Telegram check fails).
          if (!membership.ok || !membership.member) {
            registerGatedUser(env, ctx, from, isCq ? null : msg, counters, !!membership.ok);
            return ok(membership.ok ? "membership_denied" : "membership_check_error");
          }
          markUserInGroup(env, ctx, from.id);
        }

        // 1. Register the update immediately so older concurrent user updates
        // cannot overwrite a newer navigation state.
        let thisUpdateId = null;
        if (chat_id) {
          const rawUserData = isCq
            ? String((update.callback_query && update.callback_query.data) || "")
            : String(text || "");
          perf.action = isCq ? rawUserData : (rawUserData ? rawUserData.slice(0, 20) : (msg ? "message" : "other"));
          thisUpdateId = getNextUpdateId(update);
          registerUserClick(chat_id, thisUpdateId);
          if (isCq) {
            if (rawUserData.startsWith("U|") && update.callback_query.id && ctx && typeof ctx.waitUntil === "function") {
              ctx.waitUntil(fetch(TG(env) + "/answerCallbackQuery", {
                method: "POST",
                headers: CTH,
                body: JSON.stringify({ callback_query_id: update.callback_query.id })
              }).catch(() => {}));
            }
          }
        }

        if (!env || !env.BOT_TOKEN || !env.DB || !env.SQL) {
          if (chat_id) await tgSend(env, chat_id, "⚠️ The bot is not fully configured. Please check database settings.");
          return ok("not_configured");
        }

        // ====================================================================
        // /start is handled by the absolute early path above.
        // Keeping it out of the generic pipeline guarantees zero D1 content scans.

        // FAST PATH: inline user navigation (U|...)
        // Do not run the generic pipeline before handling a menu button.
        // Navigation is derived from the cached content tree + callback payload;
        // user-path persistence and monitoring stay off the critical path.
        if (isCq && String((update.callback_query && update.callback_query.data) || "").startsWith("U|")) {
          return await handleFastUserInlineCallback({
            env, ctx, update, cq: update.callback_query, chatId: chat_id, from,
            updateId: thisUpdateId, counters, perf, ok
          });
        }

        // Admin entry points are handled before the generic content loader.
        if (!isCq && text === "/admin") {
          if (!isAdmin) {
            await tgSend(env, chat_id, "Not authorized.", { skipBlockCheck: true });
            return ok("admin_denied");
          }
          try {
            // Opening the admin panel is a read-only operation. Do not acquire the
            // cross-isolate D1 lock and do not persist a path just for opening Home.
            let adminView = null;
            try {
              adminView = await __contentGetAdminViewDb(env, chat_id);
            } catch (e) {
              console.error("ADMIN_OPEN_ERROR:", e && e.message ? e.message : String(e));
            }
            if (!adminView || !adminView.db) {
              await tgSend(env, chat_id, "⚠️ Admin content cache is temporarily unavailable.", { skipBlockCheck: true });
              return ok("admin_unavailable");
            }
            const adminDb = adminView.db;
            try {
              cachePut(MEM.paths, String(adminPathId(chat_id)), [adminDb.root_id]);
            } catch (_) {}
            await showAdminNode(env, chat_id, adminDb, null, adminView.session);
            return ok("admin_open");
          } catch (e) {
            if (e && e.message === "ADMIN_OPERATION_BUSY") {
              await tgSend(env, chat_id, "⏳ Another admin operation is still running. Please try again in a moment.", { skipBlockCheck: true });
              return ok("admin_busy");
            }
            throw e;
          }
        }

        // ====================================================================
        // ADMIN TEXT FAST LANE
        // Broadcast control commands are read/operational flows that do not need
        // the generic user block/profile/content pipeline. Keeping them here
        // prevents needless D1 reads before we even reach broadcast_jobs.
        // ====================================================================
        if (!isCq && isAdmin) {
          const lowerAdmin = String(text || "").trim().toLowerCase();

          if (lowerAdmin === "/broadcast") {
            await showBroadcastMenu(env, chat_id);
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_send") {
            const r = await __withAdminSessionLock(env, from.id, () => startBroadcastJob(env, from.id));
            await tgSend(env, chat_id, formatBroadcastResult(r), { skipBlockCheck: true });
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_tick") {
            const r = await __withAdminSessionLock(env, from.id, () => resumeAndRunBroadcastBatch(env, from.id, BROADCAST_BATCH_SIZE));
            await tgSend(env, chat_id, formatBroadcastResult(r), { skipBlockCheck: true });
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_pause") {
            const r = await __withAdminSessionLock(env, from.id, () => pauseBroadcastJob(env, from.id));
            await tgSend(env, chat_id, r.ok ? "⏸️ Broadcast paused. Use /broadcast_tick or Resume to continue." : `⚠️ ${r.reason || "Nothing to pause."}`, { skipBlockCheck: true });
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_resume") {
            const r = await __withAdminSessionLock(env, from.id, () => resumeAndRunBroadcastBatch(env, from.id, BROADCAST_BATCH_SIZE));
            await tgSend(env, chat_id, formatBroadcastResult(r), { skipBlockCheck: true });
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_status") {
            const job = await d1BroadcastGet(env, from.id);
            await tgSend(env, chat_id, formatBroadcastStatus(job), { skipBlockCheck: true });
            return json({ ok: true });
          }
          if (lowerAdmin === "/broadcast_cancel") {
            await __withAdminSessionLock(env, from.id, async () => {
              await d1BroadcastClear(env, from.id);
              await tgSend(env, chat_id, "🛑 Broadcast cancelled and cleared.", { skipBlockCheck: true });
            });
            return json({ ok: true });
          }
        }

        if (isCq && String((update.callback_query && update.callback_query.data) || "").startsWith("A|")) {
          if (!isAdmin) {
            await answerCallbackQuery(env, update.callback_query.id, "⛔ You are not authorized to use these buttons.");
            return ok("admin_callback_denied");
          }

          // ACK the Telegram callback immediately. The actual admin work may
          // include D1 reads/writes and several Telegram API calls; none of that
          // should keep the button in the spinning/loading state.
          const ackAdminCallback = answerCallbackQuery(env, update.callback_query.id, "").catch(() => {});
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(ackAdminCallback);
          } else {
            await ackAdminCallback;
          }

          const processAdminCallback = (async () => {
            const adminCb = update.callback_query;
            const adminIdForError = Number(adminCb && adminCb.from && adminCb.from.id || chat_id || 0);
            const callbackDataForError = String(adminCb && adminCb.data || "");
            try {
              const handled = await handleAdminCallback(env, adminCb, { counters, ctx });

              // A valid A| callback should be handled by exactly one dispatcher branch.
              // If no branch handled it, do not fail silently: tell the admin.
              if (handled === false) {
                console.error("ADMIN_CALLBACK_UNHANDLED:", JSON.stringify({
                  admin_id: adminIdForError,
                  callback_data: callbackDataForError
                }));
                await tgSend(
                  env,
                  adminIdForError,
                  "⚠️ This admin action was not handled. Please try the button again.",
                  { skipBlockCheck: true }
                );
              }
            } catch (e) {
              const errMsg = e && e.message ? e.message : String(e);
              console.error("ADMIN_CALLBACK_TOPLEVEL_ERROR:", JSON.stringify({
                admin_id: adminIdForError,
                callback_data: callbackDataForError,
                error: errMsg,
                stack: e && e.stack ? String(e.stack).slice(0, 4000) : undefined
              }));

              // The callback was already ACKed to Telegram, so send a normal admin
              // message here. This prevents an internal exception from becoming a
              // completely silent failure. Do not expose raw internal error details.
              try {
                await tgSend(
                  env,
                  adminIdForError,
                  "❌ The admin action failed. Your changes were not confirmed as saved. Please try again.",
                  { skipBlockCheck: true }
                );
              } catch (notifyErr) {
                console.error("ADMIN_CALLBACK_ERROR_NOTIFY_FAILED:", JSON.stringify({
                  admin_id: adminIdForError,
                  error: notifyErr && notifyErr.message ? notifyErr.message : String(notifyErr)
                }));
              }
            }
          })();

          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(processAdminCallback);
          } else {
            await processAdminCallback;
          }
          return ok("admin_callback");
        }

        // ====================================================================
        // ADMIN POLL COMMANDS
        // /poll question | option 1 | option 2 | ... [#multi] [#quiz]
        // Polls are deliberately NON-ANONYMOUS so Telegram sends poll_answer
        // updates containing the voter identity. Polls are delivered to the
        // active users in D1, one native poll per user. REQUIRED_CHAT_ID and
        // group membership configuration are not used for poll delivery.
        // ====================================================================
        if (!isCq && isAdmin && /^\/polls?(?:@[^ ]+)?(?:\s|$)/i.test(text)) {
          if (/^\/polls(?:@[^\s]+)?$/i.test(String(text || "").trim())) {
            await showManagedPollList(env, chat_id, 1);
            return ok("poll_list");
          }
          if (/^\/poll(?:@[^ ]+)?$/i.test(String(text || "").trim())) {
            await tgSend(env, chat_id,
              "📊 <b>Create a trackable poll</b>\n\n" +
              "Format:\n<code>/poll Question | Option 1 | Option 2 | Option 3</code>\n\n" +
              "Optional: <code>#multi</code> or <code>#quiz</code>\n" +
              "Tracking is automatic. The bot delivers a separate native poll to every active user saved in D1, then records who chose what.",
              { parse_mode: "HTML", skipBlockCheck: true });
            return ok("poll_help");
          }
          try {
            const created = await createManagedPollFromCommand(env, text, chat_id);
            await tgSend(env, chat_id, created.message, {
              parse_mode: created.parse_mode || undefined,
              reply_markup: created.reply_markup,
              skipBlockCheck: true
            });
          } catch (e) {
            const errMsg = e && e.message ? String(e.message) : String(e);
            console.error("POLL_CREATE_ERROR:", errMsg, e && e.stack ? String(e.stack).slice(0, 3000) : "");

            // Do not hide the real Telegram/D1 reason behind a generic error.
            // The message is intentionally compact so the admin can fix the
            // target/permission/configuration immediately.
            const safeReason = errMsg.replace(/\s+/g, " ").slice(0, 700);
            await tgSend(
              env,
              chat_id,
              `❌ Could not create the poll.\n\n<b>Reason:</b> <code>${htmlEscape(safeReason)}</code>`,
              { parse_mode: "HTML", skipBlockCheck: true }
            );
          }
          return ok("poll_create");
        }

        // 3. Blocked users check (RAM + Cache API + D1; no KV on user path)
        try {
          const t_blk_start = performance.now();
          const __uid = (from && from.id) || (msg && msg.chat && msg.chat.id) || null;
          if (__uid) {
            const __mode = await (isAdmin ? getBlockedModeCached(env, __uid, ctx) : getBlockedModeUserFast(env, __uid, ctx));
            perf.blk = performance.now() - t_blk_start;
            if (__mode === 1) {
              return ok("blocked_silent"); // Silent drop
            }
            if (__mode === 2) {
              const __cid = (msg && msg.chat && msg.chat.id) || (update.callback_query && update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id) || null;
              const rec = getUserRecord(__uid);
              const nowMs = Date.now();
              if (!rec || !rec._lastNotice || (nowMs - rec._lastNotice > 5 * 60 * 1000)) {
                setUserRecord(__uid, { _lastNotice: nowMs });
                if (__cid) await tgSend(env, __cid, BAN_NOTICE_TEXT, { skipBlockCheck: true, skipLog: true });
                if (update.callback_query && update.callback_query.id) {
                  await tgFetchWithTimeout(TG(env) + "/answerCallbackQuery", {
                    method: "POST", headers: CTH,
                    body: JSON.stringify({ callback_query_id: update.callback_query.id, text: BAN_NOTICE_TEXT, show_alert: true })
                  }, 6000);
                }
              }
              return ok("blocked_notice");
            }
          }
        } catch (_) {}

        // Early abort if newer click arrived while checking blocked status
        if (isCq && isObsoleteClick(chat_id, thisUpdateId)) return ok("obsolete_after_block");

        // 4. Sync user profile (Text messages & /start only; D1/RAM, no KV)
        if (!isCq) {
          const syncP = d1SyncUserProfile(env, from, msg, counters, ctx);
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(syncP);
          } else {
            await syncP;
          }
        }

        // 5. Load content tree.
        // IMPORTANT: regular users NEVER fall back to D1 snapshot reconstruction.
        // Admin/internal flows may still use the authoritative D1-backed loader.
        let db = null;
        try {
          const t_db_start = performance.now();
          db = await loadUserContentCacheOnly(env, ctx, counters);
          // Admin/user content display is cache-only. Never reconstruct the full
          // content tree from D1 because a content-cache miss is handled as a
          // temporary published-cache condition. D1 is reserved for explicit
          // admin Save/Force Save and other authoritative admin operations.
          if (!db && isAdmin) {
            db = null;
          }
          perf.db = performance.now() - t_db_start;
        } catch (loadErr) {
          console.error("content load error:", loadErr);
        }
        if (!db) {
          if (isAdmin) {
            try { db = await __contentGetAdminViewDb(env, from.id); } catch (_) { db = null; }
          }
          if (!db) {
            if (chat_id) await tgSend(env, chat_id, "⚠️ Bot content cache is temporarily unavailable. Please try again shortly.");
            return ok("content_cache_unavailable");
          }
        }

        // Early abort if newer click arrived while loading content tree
        if (isCq && isObsoleteClick(chat_id, thisUpdateId)) return ok("obsolete_after_db");


        // Monitoring is handled centrally before membership/block/content gates.

        // ADMIN COMMANDS continue below for other admin-only text commands.
        
        if (isAdmin) {
          const lower = (text || "").toLowerCase();

          if (text === "/backup") {
            try {
              const snap = await __contentLoadSnapshotFromD1(env);
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const ok = await tgSendDocumentBuffer(env, chat_id, `backup_${stamp}.json`, JSON.stringify(snap, null, 2), "📦 Official content database backup (D1 Snapshot). Keep it safe.");
              if (!ok) await tgSend(env, chat_id, "⚠️ Failed to send backup. Please try again.");
            } catch (err) {
              await tgSend(env, chat_id, "⚠️ Unable to create backup: " + (err && err.message || err));
            }
            return json({ ok: true });
          }

          // /sync : rebuild the published snapshot from D1 and write it to KV immediately.
          if (lower === "/sync" || lower === "/sync_kv" || lower === "/publish_cache") {
            await tgSend(env, chat_id, "⏳ Syncing KV from D1...");
            const sr = await adminSyncKvFromD1(env);
            await tgSend(env, chat_id, sr.text);
            return json({ ok: true });
          }

          // Disaster Recovery: /restore
          if (lower.startsWith("/restore")) {
            let docFileId = null;
            if (msg.reply_to_message && msg.reply_to_message.document) {
              docFileId = msg.reply_to_message.document.file_id;
            }
            if (!docFileId) {
              await tgSend(env, chat_id, "🔄 To restore: Reply to the backup file (backup_*.json) with /restore.");
              return json({ ok: true });
            }
            await tgSend(env, chat_id, "⏳ Verifying backup file and restoring content database...");
            try {
              const infoRes = await fetch(TG(env) + "/getFile?file_id=" + encodeURIComponent(docFileId));
              const info = await infoRes.json().catch(() => null);
              if (!info || !info.ok || !info.result || !info.result.file_path) {
                await tgSend(env, chat_id, "⚠️ Unable to download backup file from Telegram.");
                return json({ ok: true });
              }
              const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
              if (!fileRes.ok) {
                await tgSend(env, chat_id, "⚠️ Unable to download backup file from Telegram (HTTP " + fileRes.status + ").");
                return json({ ok: true });
              }
              const backupText = await fileRes.text();
              if (backupText.length > 8 * 1024 * 1024) {
                await tgSend(env, chat_id, "⚠️ Backup file is too large (max 8 MB).");
                return json({ ok: true });
              }
              const backupJson = JSON.parse(backupText);
              const restResult = await contentRestoreFromBackup(env, chat_id, backupJson);
              if (restResult.ok) {
                const cacheNote = restResult.cacheSynchronized
                  ? "D1 updated and KV cache synchronized."
                  : "D1 restored successfully. KV/Edge cache refresh will self-heal automatically.";
                await tgSend(env, chat_id, `✅ Content restored successfully!\nNew Version: ${restResult.version}\n${cacheNote}`);
                await showAdminNode(env, chat_id, restResult.snapshot || null);
              } else {
                await tgSend(env, chat_id, "⚠️ Restore failed: " + restResult.error);
              }
            } catch (err) {
              await tgSend(env, chat_id, "⚠️ Error processing restore file: " + (err && err.message || err));
            }
            return json({ ok: true });
          }

          if (text === "/kvstat") {
            const s = KV_CACHE_STATS.snapshot();
            const d1 = D1_CACHE_STATS();
            await tgSend(env, chat_id, `KV Cache: hits=${s.db_hits}, misses=${s.db_misses}\nD1 Cache: paths=${d1.paths.size}`);
            return json({ ok: true });
          }

          if (text === "/latency") {
            const timings = {};
            let t0 = Date.now();
            try { await env.DB.get(DB_KEY); timings.kv_ms = Date.now() - t0; } catch (e) { timings.kv_ms = "err: " + e.message; }
            t0 = Date.now();
            try { await env.SQL.prepare("SELECT 1 AS ok").first(); timings.d1_ms = Date.now() - t0; } catch (e) { timings.d1_ms = "err: " + e.message; }
            t0 = Date.now();
            try { await fetch(TG(env) + "/getMe"); timings.tg_ms = Date.now() - t0; } catch (e) { timings.tg_ms = "err: " + e.message; }
            await tgSend(env, chat_id, `⏱ Response Latency:\n• KV: ${timings.kv_ms}ms\n• D1: ${timings.d1_ms}ms\n• Telegram: ${timings.tg_ms}ms`);
            return json({ ok: true });
          }

          if (lower === "/reset_data" || lower === "/factory_reset" || lower === "/reset_all") {
            await tgSend(env, chat_id, "🛑 This will DELETE ALL CONTENT (menus, files, welcome). Users are kept.\nTake a /backup first, then send exactly:\n<code>" + lower.split(/\s+/)[0] + " CONFIRM</code>", { parse_mode: "HTML" });
            return json({ ok: true });
          }
          if (/^\/(reset_data|factory_reset|reset_all)\s+confirm$/.test(lower)) {
            await tgSend(env, chat_id, "⚠️ Resetting content data (users and metrics will not be deleted)...");
            const rr = await resetBotData(env);
            if (rr && rr.ok) await tgSend(env, chat_id, "✅ Reset completed. Content database is empty and re-published (version " + rr.version + ").");
            else await tgSend(env, chat_id, "❌ Reset finished with errors:\n" + ((rr && rr.errors) || ["unknown"]).slice(0, 5).join("\n") + "\nCheck the state with /admin and retry if needed.");
            return json({ ok: true });
          }

          if (lower === "/monitor" || lower === "/monitor_status") {
            const mId = getMonitorAdminId(env);
            await tgSend(env, chat_id, `📊 Monitoring Status: ${isMonitorEnabled(env) ? "Enabled ✅" : "Disabled ❌"}\nRecipient ID: ${mId > 0 ? mId : "Not set"}`);
            return json({ ok: true });
          }

          // Broadcast commands — broadcast state lives in its own D1 job row,
          // completely separated from content-edit sessions.
          if (lower === "/broadcast") {
            await showBroadcastMenu(env, chat_id);
            return json({ ok: true });
          }
          if (lower === "/broadcast_send") {
            const r = await __withAdminSessionLock(env, from.id, () => startBroadcastJob(env, from.id));
            await tgSend(env, chat_id, formatBroadcastResult(r));
            return json({ ok: true });
          }
          if (lower === "/broadcast_tick") {
            const r = await __withAdminSessionLock(env, from.id, () => resumeAndRunBroadcastBatch(env, from.id, BROADCAST_BATCH_SIZE));
            await tgSend(env, chat_id, formatBroadcastResult(r));
            return json({ ok: true });
          }
          if (lower === "/broadcast_pause") {
            const r = await __withAdminSessionLock(env, from.id, () => pauseBroadcastJob(env, from.id));
            await tgSend(env, chat_id, r.ok ? "⏸️ Broadcast paused. Use /broadcast_tick or Resume to continue." : `⚠️ ${r.reason || "Nothing to pause."}`);
            return json({ ok: true });
          }
          if (lower === "/broadcast_resume") {
            const r = await __withAdminSessionLock(env, from.id, () => resumeAndRunBroadcastBatch(env, from.id, BROADCAST_BATCH_SIZE));
            await tgSend(env, chat_id, formatBroadcastResult(r));
            return json({ ok: true });
          }
          if (lower === "/broadcast_status") {
            const job = await d1BroadcastGet(env, from.id);
            await tgSend(env, chat_id, formatBroadcastStatus(job));
            return json({ ok: true });
          }
          if (lower === "/broadcast_cancel") {
            await __withAdminSessionLock(env, from.id, async () => {
              await d1BroadcastClear(env, from.id);
              await tgSend(env, chat_id, "🛑 Broadcast cancelled and cleared.");
            });
            return json({ ok: true });
          }


          // Dedicated broadcast message capture. Broadcast no longer shares
          // content_sessions.state_json, so a content edit can never overwrite
          // a running broadcast or its pending source message.
          const broadcastJob = await d1BroadcastGet(env, chat_id);
          if (broadcastJob && broadcastJob.status === "awaiting_message") {
            if (lower === "/cancel" || lower === "/broadcast_cancel") {
              await d1BroadcastClear(env, chat_id);
              await tgSend(env, chat_id, "🛑 Broadcast message setup cancelled.");
              return json({ ok: true });
            }
            const captured = await captureBroadcastMessage(env, chat_id, msg);
            await tgSend(env, chat_id, captured.ok ? "✅ Broadcast message saved." : `⚠️ ${captured.reason || "Could not save broadcast message."}`);
            if (captured.ok) await showBroadcastMenu(env, chat_id);
            return json({ ok: true });
          }

          // Pending message flow for admins (ADD, REN, ATTACH_MULTI, etc.)
          const pendingSession = await __contentSessionGet(env, chat_id);
          const pend = pendingSession && pendingSession.state ? (pendingSession.state.pending || null) : null;
          if (pend) {
            if (lower === "/done") {
              try {
                return await __withAdminSessionLock(env, chat_id, async () =>
                  await __withAdminScope(env, chat_id, { mid: __panelMid(chat_id) || null }, async () => {
                    await __adminFinishPendingLocked(env, chat_id);
                    return json({ ok: true });
                  }));
              } catch (e) {
                if (e && e.message === "ADMIN_OPERATION_BUSY") {
                  await tgSend(env, chat_id, "⏳ Another admin operation is still running. Please try again in a moment.", { skipBlockCheck: true });
                  return json({ ok: true });
                }
                throw e;
              }
            }
            const pendHandled = await adminHandlePending(env, msg, pend, { counters, ctx, session: pendingSession });
            // Keep the chat short: the text the admin just typed (a name / caption / welcome text) is
            // now shown inside the panel, so remove the typed message. Set ADMIN_KEEP_INPUT=1 to disable.
            try {
              if (pendHandled && msg && typeof msg.text === "string" && !msg.text.trim().startsWith("/") &&
                  env.ADMIN_KEEP_INPUT !== "1" && __CLEAN_INPUT_MODES.has(pend.mode) && ctx && typeof ctx.waitUntil === "function") {
                ctx.waitUntil(tgFetchWithTimeout(TG(env) + "/deleteMessage", { method: "POST", headers: CTH,
                  body: JSON.stringify({ chat_id, message_id: msg.message_id }) }, 5000).catch(() => {}));
              }
            } catch (_) {}
            return json({ ok: true });
          }
        }

        // ====================================================================
        // CALLBACK QUERIES (Inline buttons)
        // ====================================================================
        if (update.callback_query) {
          const cq = update.callback_query;
          const cqData = String(cq.data || "");

          // 2. Media Viewer Navigation (C|PREV/NEXT only)
          // NOTE: Content messages no longer expose a Back/Delete button.
          if (cqData.startsWith("C|")) {
            // Content-media navigation is also cache-only. It must never call
            // reconstruct the entire content tree from D1.
            try {
              const ackP = tgFetchWithTimeout(TG(env) + "/answerCallbackQuery", { method: "POST", headers: CTH, body: JSON.stringify({ callback_query_id: cq.id }) }, 3000).catch(() => {});
              if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(ackP);

              const cqChatId = cq.message && cq.message.chat ? cq.message.chat.id : chat_id;
              const cqMsgId = cq.message ? cq.message.message_id : null;
              const parts = cqData.split("|");
              const action = parts[1];
              if (action !== "PREV" && action !== "NEXT") return json({ ok: true });

              let contentDb = await loadUserContentCacheOnly(env, ctx, counters);
              if (!contentDb) return json({ ok: true });

              const nodeId = parts[2];
              let idx = Number(parts[3]) || 0;
              let node = contentDb.nodes && contentDb.nodes[String(nodeId)];
              let files = node && Array.isArray(node.files) ? node.files : [];
              if (!files.length) {
                const fresh = await loadUserContentCacheOnly(env, ctx, counters, { forceRefresh: true });
                if (fresh) {
                  contentDb = fresh;
                  node = contentDb.nodes && contentDb.nodes[String(nodeId)];
                  files = node && Array.isArray(node.files) ? node.files : [];
                }
              }
              if (!files.length) return json({ ok: true });

              idx = action === "NEXT" ? (idx + 1) % files.length : (idx - 1 + files.length) % files.length;
              const kb = contentNavKb(nodeId, idx, files.length);
              const work = (async () => {
                await editMediaItem(env, cqChatId, cqMsgId, files[idx], { reply_markup: kb });
              })().catch(e => console.error("CONTENT_NAV_ERROR:", e && e.message ? e.message : String(e)));
              if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
              else await work;
            } catch (e) {
              console.error("CONTENT_CALLBACK_ERROR:", e && e.message ? e.message : String(e));
            }
            return json({ ok: true });
          }

        }

        // ====================================================================
        // USER TEXT NAVIGATION (Private Chat / Groups)
        // ====================================================================
        const upathKey = "path:user:" + chat_id;
        const isPrivateChat = Number(chat_id) > 0;

        // Built-in Lightweight Calculator. A real Reply Keyboard button always
        // carries replyButtonMeta, so labels such as "1-2" are treated as buttons,
        // not as calculator expressions.
        if (!replyButtonMeta.target && text && text.length <= 100) {
          const calcResult = tryEvaluateCalculator(text);
          if (calcResult !== null) {
            await tgSend(env, chat_id, calcResult, { skipBlockCheck: true });
            return json({ ok: true });
          }
        }

        if (!replyButtonMeta.target && (text === "Home" || text === "🏠 Home")) {
          d1SetPath(env, upathKey, [db.root_id], counters, ctx);
          const n = db.nodes[String(db.root_id)];
          await tgSend(env, chat_id, "Please choose from the menu:", isPrivateChat ? { reply_markup: replyKbFromNode(db, n, false), skipBlockCheck: true } : { skipBlockCheck: true });
          await sendAllContents(env, chat_id, n);
          return json({ ok: true });
        }

        // Never let an older concurrent message continue into path resolution.
        if (thisUpdateId != null && isObsoleteClick(chat_id, thisUpdateId)) return ok("obsolete_text_navigation");

        // If this was a real Reply Keyboard button, the button itself carries
        // the parent + child IDs. Use them directly and reconstruct the path from
        // the current content tree. This removes duplicate-name ambiguity and
        // avoids a D1 path read on normal button presses.
        let upath = null;
        let unode = null;
        let targetChild = null;
        let targetParent = null;

        let shouldRefreshReplyKeyboard = false;
        if (replyButtonMeta.target) {
          const resolveReplyTarget = currentDb => {
            const parentId = Number(replyButtonMeta.target.parentId);
            const childId = Number(replyButtonMeta.target.childId);
            const parentNode = currentDb.nodes && currentDb.nodes[String(parentId)];
            const childNode = currentDb.nodes && currentDb.nodes[String(childId)];
            const parentRows = parentNode && Array.isArray(parentNode.children_rows) ? parentNode.children_rows : [];
            const valid = !!(parentNode && childNode && parentRows.some(row =>
              Array.isArray(row) && row.some(cid => Number(cid) === childId)
            ) && !isHidden(parentNode, childId));
            return valid ? { parentId, childId, parentNode, childNode } : null;
          };

          let resolved = resolveReplyTarget(db);
          const buttonVersion = Number.isFinite(replyButtonMeta.version) ? Number(replyButtonMeta.version) : null;
          const cacheVersion = Number(db && db._v) || 0;

          if (!resolved || buttonVersion == null || buttonVersion !== cacheVersion) {
            shouldRefreshReplyKeyboard = true;
            // Only hit KV again when our cache may be BEHIND the button (or the target is unresolved).
            // An older keyboard on a newer cache just gets a fresh keyboard: no extra KV read per user per publish.
            const needFresh = !resolved || buttonVersion == null || buttonVersion > cacheVersion;
            const fresh = needFresh ? await loadUserContentCacheOnly(env, ctx, counters, { forceRefresh: true }) : null;
            if (fresh) {
              db = fresh;
              resolved = resolveReplyTarget(db);
            }
          }

          if (resolved) {
            targetChild = resolved.childNode;
            targetParent = resolved.parentNode;
            upath = buildPathToNode(db, resolved.parentId);
            if (!Array.isArray(upath) || !upath.length || Number(upath[upath.length - 1]) !== resolved.parentId) {
              upath = [db.root_id];
            }
            unode = resolved.parentNode;
          } else {
            const currentPath = await d1GetPath(env, upathKey, db.root_id, counters);
            const safePath = Array.isArray(currentPath) && currentPath.length ? currentPath : [db.root_id];
            const currentNode = db.nodes[String(safePath[safePath.length - 1])] || db.nodes[String(db.root_id)];
            await tgSend(env, chat_id, "🔄 The menu was updated. Here is the current menu:", {
              reply_markup: isPrivateChat ? replyKbFromNode(db, currentNode, safePath.length === 2) : undefined,
              skipBlockCheck: true
            });
            return json({ ok: true });
          }
        } else {
          // Manual text input / legacy buttons: preserve the existing path-based
          // resolver, including its safe duplicate-name rules.
          upath = await d1GetPath(env, upathKey, db.root_id, counters);
          if (thisUpdateId != null && isObsoleteClick(chat_id, thisUpdateId)) return ok("obsolete_text_after_path");
          // d1GetPath returns a private copy, so pop()/push() below cannot mutate shared cache state.
          unode = db.nodes[String(upath[upath.length - 1])];

          // DEFENSIVE GUARD: If stored path points to a deleted node, reset to root!
          if (!unode) {
            upath = [db.root_id];
            d1SetPath(env, upathKey, upath, counters, ctx);
            unode = db.nodes[String(db.root_id)];
          }
        }

        if (!replyButtonMeta.target && (text === "Back" || text === "⬅️ Back")) {
          if (upath.length > 1) {
            upath.pop();
            d1SetPath(env, upathKey, upath, counters, ctx);
          }
          let n = db.nodes[String(upath[upath.length - 1])];
          if (!n) { upath = [db.root_id]; n = db.nodes[String(db.root_id)]; d1SetPath(env, upathKey, upath, counters, ctx); }
          const atRoot = Number(n.id) === Number(db.root_id);
          const title = atRoot ? null : ((n.name || "").trim() || null);

          await tgSend(
            env, chat_id,
            atRoot ? "Please choose from the menu:" : (title || getWelcome(db)),
            isPrivateChat ? { reply_markup: replyKbFromNode(db, n, upath.length === 2), skipBlockCheck: true } : { skipBlockCheck: true }
          );
          if (!atRoot) await sendAllContents(env, chat_id, n);
          return json({ ok: true });
        }

        // Resilient Button Matching & Leaf Node Handling.
        // For a tokenized Reply Keyboard press, targetChild/targetParent are already
        // resolved above; the legacy text resolver is only used for manually typed text.
        if (!targetChild) {
          targetParent = unode;

        // 1. Search inside current unode.children_rows (STRICT LOCAL SCOPE)
        const cr = unode && unode.children_rows ? unode.children_rows : [];
        for (const row of cr) {
          if (!Array.isArray(row)) continue;
          for (const cid of row) {
            const c = db.nodes && db.nodes[String(cid)];
            if (c && c.name && c.name.trim() === text && !isHidden(unode, cid)) {
              targetChild = c;
              targetParent = unode;
              break;
            }
          }
          if (targetChild) break;
        }

        // 2. Check if text matches any button in the user's path ancestry (e.g. parent or sibling level)
        if (!targetChild && Array.isArray(upath) && upath.length > 1) {
          for (let pi = upath.length - 2; pi >= 0; pi--) {
            const ancestorNode = db.nodes && db.nodes[String(upath[pi])];
            const ancCr = ancestorNode && ancestorNode.children_rows ? ancestorNode.children_rows : [];
            for (const row of ancCr) {
              if (!Array.isArray(row)) continue;
              for (const cid of row) {
                const c = db.nodes && db.nodes[String(cid)];
                if (c && c.name && c.name.trim() === text && !isHidden(ancestorNode, cid)) {
                  targetChild = c;
                  targetParent = ancestorNode;
                  upath = upath.slice(0, pi + 1); // Truncate path to this ancestor
                  break;
                }
              }
              if (targetChild) break;
            }
            if (targetChild) break;
          }
        }

        // 3. If not found, check if text matches a top-level button in the ROOT node
        if (!targetChild && Number(unode.id) !== Number(db.root_id)) {
          const rootNode = db.nodes && db.nodes[String(db.root_id)];
          const rootCr = rootNode && rootNode.children_rows ? rootNode.children_rows : [];
          for (const row of rootCr) {
            if (!Array.isArray(row)) continue;
            for (const cid of row) {
              const c = db.nodes && db.nodes[String(cid)];
              if (c && c.name && c.name.trim() === text && !isHidden(rootNode, cid)) {
                targetChild = c;
                targetParent = rootNode;
                upath = [db.root_id]; // Reset to root
                break;
              }
            }
            if (targetChild) break;
          }
        }

        // 4. Global search: ONLY if the node name is GLOBALLY UNIQUE in the entire database!
        //    (Prevents duplicate names like "Semester 1", "Lec 1", etc. from jumping across branches!)
        if (!targetChild) {
          const matchingNodes = [];
          for (const n of Object.values(db.nodes || {})) {
            if (n && n.name && n.name.trim() === text && !n.deleted_at && __pathIsVisible(db, n.id)) {
              matchingNodes.push(n);
            }
          }
          if (matchingNodes.length === 1) {
            // Exactly ONE node has this name in the entire bot -> Safe to jump to it!
            const n = matchingNodes[0];
            targetChild = n;
            targetParent = findParentNode(db, n.id) || db.nodes[String(db.root_id)];
            upath = buildPathToNode(db, targetParent.id);
          } else if (matchingNodes.length > 1) {
            // MULTIPLE nodes have this name (like "Semester 1" in Level 3 and Level 4)!
            // Only match if one candidate belongs to the current branch (when not at root):
            let branchMatch = null;
            if (Number(unode.id) !== Number(db.root_id)) {
              for (const candidate of matchingNodes) {
                const candPath = buildPathToNode(db, candidate.id);
                if (candPath.includes(Number(unode.id))) {
                  branchMatch = candidate;
                  break;
                }
              }
            }
            if (branchMatch) {
              targetChild = branchMatch;
              targetParent = findParentNode(db, branchMatch.id) || unode;
              upath = buildPathToNode(db, targetParent.id);
            }
            // If ambiguous and at root or outside current branch: targetChild remains null (safe, no hijack!)
          }
        }

        }

        if (targetChild) {
          const hasKids = hasVisibleChildren(db, targetChild);
          const title = targetChild.id === db.root_id ? null : ((targetChild.name || "").trim() || null);

          if (hasKids) {
            // Folder node: Navigate into sub-menu
            upath.push(targetChild.id);
            d1SetPath(env, upathKey, upath, counters, ctx);
            await tgSend(
              env, chat_id,
              title || getWelcome(db),
              isPrivateChat ? { reply_markup: replyKbFromNode(db, targetChild, upath.length === 2), skipBlockCheck: true } : { skipBlockCheck: true }
            );
            await sendAllContents(env, chat_id, targetChild);
          } else {
            // Leaf node: DO NOT enter a new menu! Keep existing keyboard intact!
            d1SetPath(env, upathKey, upath, counters, ctx);

            const hasFiles = targetChild.files && targetChild.files.length > 0;
            const hasUrls  = targetChild.urls && targetChild.urls.length > 0;
            const hasNotes = targetChild.notes && targetChild.notes.length > 0;
            const hasContent = hasFiles || hasUrls || hasNotes;

            const refreshKeyboard = shouldRefreshReplyKeyboard && isPrivateChat
              ? replyKbFromNode(db, db.nodes[String(targetParent && targetParent.id)] || db.nodes[String(db.root_id)], upath.length === 2)
              : null;

            if (hasContent) {
              // Deliver all content items in order. When a stale reply keyboard
              // is detected, its replacement is attached to the first actual
              // response message instead of sending a separate notice.
              await sendAllContents(env, chat_id, targetChild, { reply_markup: refreshKeyboard });
            } else {
              await tgSend(env, chat_id, "— No content available in this section currently —", {
                ...(refreshKeyboard ? { reply_markup: refreshKeyboard } : {}),
                skipBlockCheck: true
              });
            }

          }
          return json({ ok: true });
        }

        // Invalid expressions fall through to the normal text nudge.
        // Stray text nudge
        await tgSend(env, chat_id, "Use the menu buttons to navigate, or send /start.");
        return json({ ok: true });
      }

      return new Response("ok");
    } catch (e) {
      console.error("CRITICAL TOP-LEVEL UNCAUGHT ERROR:", e);
      return json({ ok: true });
    }
  },

  // Scheduled Cron Handler (Broadcast continuations + hourly content self-healing)
  async scheduled(event, env, ctx) {
    // Keep a hard safety margin under Cloudflare's external subrequest ceiling.
    // Broadcast is the only repeating Telegram workload in the scheduler.
    const CRON_TELEGRAM_BUDGET = 40;
    const CRON_MAX_BROADCAST_USERS_PER_TICK = 20;
    const BROADCAST_EXTERNAL_COST_PER_USER = 2; // send/copy + HTML fallback reserve
    let remainingTelegramBudget = CRON_TELEGRAM_BUDGET;

    // 1. Content self-healing: run only once per hour.
    // Cron itself runs every 20 minutes, so only the :00 UTC tick performs the check.
    const __cronMin = new Date((event && event.scheduledTime) || Date.now()).getUTCMinutes();
    try {
      const contentDb = env.SQL;
      if (contentDb && env.DB && __cronMin === 0) {
        const meta = await __contentMeta(env, { fresh: true });
        let rawKv = await env.DB.get(DB_KEY);
        let kvVersion = 0;
        if (rawKv) { const mm = /"_v":(\d+)/.exec(rawKv); kvVersion = mm ? Number(mm[1]) : 0; }
        if (!rawKv || kvVersion !== meta.version) {
          console.log(`Self-healing triggered: D1 version ${meta.version} != KV version ${kvVersion}. Resyncing...`);
          await __withContentMutationLock(env, async () => {
            const freshMeta = await __contentMeta(env);
            const freshRawKv = await env.DB.get(DB_KEY);
            let freshKvVersion = 0;
            if (freshRawKv) { const m2 = /"_v":(\d+)/.exec(freshRawKv); freshKvVersion = m2 ? Number(m2[1]) : 0; }
            if (!freshRawKv || freshKvVersion !== freshMeta.version) {
              const snap = await __contentLoadSnapshotFromD1(env);
              const json = JSON.stringify(snap);
              await env.DB.put(DB_KEY, json);
              if (contentCacheIntegrity(snap)) { try { await env.DB.put("db:backup:last", json); } catch (_) {} }
              setPublishedRamCache(snap);
              await edgeDbPut(env, snap);
            }
          });
        }
      }
    } catch (err) {
      console.error("Scheduled reconciliation error:", err);
    }

    // 2. Scheduled Broadcast continuation.
    // One broadcast owner per tick; with no poll/sweep reservation, the budget allows
    // up to 20 recipients (40 reserved Telegram calls / 2 calls per recipient).
    try {
      const rows = await env.SQL.prepare(`
        SELECT admin_id,status,paused_until
        FROM broadcast_jobs
        WHERE status IN ('running','paused')
        ORDER BY updated_at ASC
        LIMIT 10
      `).all();

      for (const job of (rows.results || [])) {
        const adminId = Number(job.admin_id || 0);
        if (!adminId) continue;

        const budgetedBatch = Math.min(
          BROADCAST_BATCH_SIZE,
          CRON_MAX_BROADCAST_USERS_PER_TICK,
          Math.floor(remainingTelegramBudget / BROADCAST_EXTERNAL_COST_PER_USER)
        );
        if (budgetedBatch < 1) break;

        try {
          const nowSec = Math.floor(Date.now() / 1000);
          let result = null;
          if (job.status === 'running') {
            result = await __withAdminSessionLock(env, adminId, () => processBroadcastBatch(env, adminId, budgetedBatch));
          } else if (Number(job.paused_until || 0) > 0 && Number(job.paused_until || 0) <= nowSec) {
            result = await __withAdminSessionLock(env, adminId, () => resumeAndRunBroadcastBatch(env, adminId, budgetedBatch));
          }
          if (result) remainingTelegramBudget -= budgetedBatch * BROADCAST_EXTERNAL_COST_PER_USER;
        } catch (_) {}

        // Deliberately process at most one broadcast owner per tick.
        break;
      }
    } catch (_) {}
  }

};

/* ============================================================================
   TELEGRAM COMMUNICATION & MEDIA HELPERS
   ============================================================================ */
const TG = (env) => "https://api.telegram.org/bot" + env.BOT_TOKEN;
const CTH = { "content-type": "application/json" };

async function tgFetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs || 8000);
  let onExternalAbort = null;
  if (options && options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    onExternalAbort = () => { try { ctrl.abort(); } catch (_) {} };
    options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
    if (options && options.signal && onExternalAbort) {
      try { options.signal.removeEventListener("abort", onExternalAbort); } catch (_) {}
    }
  }
}

async function tgEditMessageText(env, chat_id, message_id, text, extra) {
  if (chat_id == null || message_id == null) return false;
  try {
    const payload = Object.assign({ chat_id, message_id, text: String(text || "") }, extra || {});
    const res = await tgFetchWithTimeout(TG(env) + "/editMessageText", {
      method: "POST",
      headers: CTH,
      body: JSON.stringify(payload),
    }, 6000);
    const j = await res.json().catch(() => null);
    return !!(j && j.ok);
  } catch (_) {
    return false;
  }
}

async function answerCallbackQuery(env, callback_query_id, text, showAlert = false) {
  try {
    await tgFetchWithTimeout(TG(env) + "/answerCallbackQuery", {
      method: "POST", headers: CTH,
      body: JSON.stringify({ callback_query_id, text: String(text || ""), show_alert: showAlert })
    }, 6000);
  } catch (_) {}
}

async function tgSend(env, chat_id, text, extra) {
  extra = extra || {};
  // Admin UI messages are already behind the strict admin authorization guard.
  // Do not perform a D1 block-state lookup just to send an admin-panel message.
  const __chatIsAdmin = (() => {
    try { return parseAdmins(env).includes(Number(chat_id)); } catch (_) { return false; }
  })();
  if (!extra.skipBlockCheck && !__chatIsAdmin) {
    try {
      if (chat_id) {
        const __m = await getBlockedModeCached(env, chat_id);
        if (__m === 1) return null; // Silent drop
      }
    } catch (_) {}
  }
  // Live admin panel: while an admin interaction is running, screens (messages with an inline
  // keyboard) edit the panel message in place and plain notices are folded into it.
  if (__chatIsAdmin && !extra.noScope) {
    try {
      const sc = ADMIN_SCOPES.get(String(chat_id));
      if (sc && !sc.passthrough) {
        const handled = await __adminScopedSend(env, chat_id, text, extra, sc);
        if (handled) return handled;
      }
    } catch (_) {}
  }
  try {
    const payload = Object.assign({ chat_id, text }, extra);
    // Any personalized inline user mention must be parsed as HTML.
    // This protects future callers even if they forget to pass parse_mode explicitly.
    if (!payload.parse_mode && typeof text === "string" && text.includes('<a href="tg://user?id=')) {
      payload.parse_mode = "HTML";
    }
    const skipMonitor = !!payload.skipMonitor;
    delete payload.skipBlockCheck;
    delete payload.noScope;
    delete payload.skipMonitor;
    const res = await tgFetchWithTimeout(TG(env) + "/sendMessage", { method: "POST", headers: CTH, body: JSON.stringify(payload) }, 10000);
    let j = await res.json().catch(() => null);
    if (__chatIsAdmin && j && j.ok && j.result && payload.reply_markup && payload.reply_markup.inline_keyboard) {
      ADMIN_LAST_PANEL.set(String(chat_id), j.result.message_id);
    }
    if (j && j.ok === false && payload.parse_mode === "HTML" && /parse entities|can't parse/i.test(String(j.description || ""))) {
      // Admin text broke the HTML parser: deliver it as plain text instead of losing the message.
      const plain = Object.assign({}, payload, { text: stripTelegramHtml(payload.text) });
      delete plain.parse_mode;
      const res2 = await tgFetchWithTimeout(TG(env) + "/sendMessage", { method: "POST", headers: CTH, body: JSON.stringify(plain) }, 10000);
      j = await res2.json().catch(() => null);
    }
    if (!skipMonitor && !__chatIsAdmin && j && j.ok && j.result && j.result.message_id) {
      await monitorOutgoingMessages(env, chat_id, [j.result.message_id]);
    }
    return j;
  } catch (_) { return null; }
}

async function sendLegacyMedia(env, chat_id, endpoint, field, file_id, caption, extra) {
  try {
    const payload = Object.assign({ chat_id }, extra || {});
    payload[field] = file_id;
    if (caption != null && field !== "sticker") payload.caption = caption;
    const skipMonitor = !!payload.skipMonitor;
    delete payload.skipBlockCheck;
    delete payload.skipLog;
    delete payload.skipMonitor;
    const res = await tgFetchWithTimeout(TG(env) + "/" + endpoint, { method: "POST", headers: CTH, body: JSON.stringify(payload) }, 10000);
    const j = await res.json().catch(() => null);
    if (!skipMonitor && j && j.ok && j.result && j.result.message_id && !parseAdmins(env).includes(Number(chat_id))) {
      await monitorOutgoingMessages(env, chat_id, [j.result.message_id]);
    }
    return j;
  } catch (_) { return null; }
}
async function sendDocument(env, chat_id, file_id, caption, extra) { return await sendLegacyMedia(env, chat_id, "sendDocument", "document", file_id, caption, extra); }
async function sendPhoto(env, chat_id, file_id, caption, extra)     { return await sendLegacyMedia(env, chat_id, "sendPhoto", "photo", file_id, caption, extra); }
async function sendVideo(env, chat_id, file_id, caption, extra)     { return await sendLegacyMedia(env, chat_id, "sendVideo", "video", file_id, caption, extra); }
async function sendAudio(env, chat_id, file_id, caption, extra)     { return await sendLegacyMedia(env, chat_id, "sendAudio", "audio", file_id, caption, extra); }
async function sendVoice(env, chat_id, file_id, caption, extra)     { return await sendLegacyMedia(env, chat_id, "sendVoice", "voice", file_id, caption, extra); }
async function sendSticker(env, chat_id, file_id, caption, extra)   { return await sendLegacyMedia(env, chat_id, "sendSticker", "sticker", file_id, caption, extra); }

async function tgSendDocumentBuffer(env, chat_id, filename, textContent, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chat_id));
    if (caption) form.append("caption", caption);
    const blob = new Blob([textContent], { type: "application/json" });
    form.append("document", blob, filename);
    const res = await fetch(TG(env) + "/sendDocument", { method: "POST", body: form });
    const j = await res.json().catch(() => null);
    return !!(j && j.ok);
  } catch (_) { return false; }
}

function tgMediaTypeFor(t) {
  if (t === "photo") return "photo";
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  return "document";
}

function mediaGroupCategory(f) {
  if (!f || !f.id) return null;
  if (f.type === "photo" || f.type === "video") return "pv";
  if (f.type === "document") return "doc";
  if (f.type === "audio") return "audio";
  return null;
}

function planMediaGroups(order, filesArr) {
  const steps = [];
  let i = 0;
  while (i < order.length) {
    const tag = order[i];
    const [k, s] = String(tag).split(":");
    if (k !== "F") { steps.push({ kind: "tag", tag }); i++; continue; }
    const idx = parseInt(s || "0", 10);
    const f = (filesArr || [])[idx];
    const cat = mediaGroupCategory(f);
    if (!cat) { steps.push({ kind: "tag", tag }); i++; continue; }
    const run = [tag];
    let j = i + 1;
    while (j < order.length && run.length < 10) {
      const [k2, s2] = String(order[j]).split(":");
      if (k2 !== "F") break;
      const idx2 = parseInt(s2 || "0", 10);
      const f2 = (filesArr || [])[idx2];
      if (mediaGroupCategory(f2) !== cat) break;
      run.push(order[j]);
      j++;
    }
    if (run.length >= 2) { steps.push({ kind: "group", tags: run }); i = j; }
    else { steps.push({ kind: "tag", tag }); i++; }
  }
  return steps;
}

// Telegram flood-limit helper: waits (wall-clock, no CPU cost) and retries ONCE when the
// wait is short. Longer waits are not blocked on; the caller falls back instead.
const MEDIA_RETRY_MAX_WAIT_SEC = 5;

async function tgPostMedia(env, endpoint, body, timeoutMs, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let j = null;
    try {
      const res = await tgFetchWithTimeout(TG(env) + "/" + endpoint, { method: "POST", headers: CTH, body: JSON.stringify(body) }, timeoutMs);
      j = await res.json().catch(() => null);
    } catch (e) {
      console.error(label + "_FETCH_ERROR", e && e.message ? e.message : String(e));
      return null;
    }
    if (j && j.ok) return j;
    const ra = Number(j && j.parameters && j.parameters.retry_after) || 0;
    if (attempt === 0 && ra > 0 && ra <= MEDIA_RETRY_MAX_WAIT_SEC) {
      await new Promise((r) => setTimeout(r, ra * 1000 + 100));
      continue;
    }
    console.error(label + "_FAILED", "chat=" + body.chat_id, "code=" + (j && j.error_code), (j && j.description) || "no response");
    return j;
  }
  return null;
}

async function tgSendMediaGroup(env, chat_id, files) {
  try {
    if (!files || files.length < 2) return false;
    const media = files.map(f => {
      const item = { type: tgMediaTypeFor(f.type), media: f.id };
      if (f.caption) item.caption = f.caption;
      return item;
    });
    const j = await tgPostMedia(env, "sendMediaGroup", { chat_id, media }, 15000, "MEDIA_GROUP");
    if (!(j && j.ok)) return false;
    const ids = Array.isArray(j.result) ? j.result.map(x => Number(x && x.message_id)).filter(Boolean) : [];
    if (ids.length && !parseAdmins(env).includes(Number(chat_id))) {
      await monitorOutgoingMessages(env, chat_id, ids);
    }
    return true;
  } catch (e) {
    console.error("MEDIA_GROUP_ERROR", e && e.message ? e.message : String(e));
    return false;
  }
}

async function sendMediaItem(env, chat_id, f, extra) {
  try {
    const kind = f.type === "photo" ? "photo" : f.type === "video" ? "video" : f.type === "audio" ? "audio" : f.type === "voice" ? "voice" : f.type === "sticker" ? "sticker" : "document";
    const p = Object.assign({ chat_id }, extra || {});
    p[kind] = f.id;
    if (kind !== "sticker" && f.caption) p.caption = f.caption;
    const skipMonitor = !!p.skipMonitor;
    delete p.skipBlockCheck;
    delete p.skipLog;
    delete p.skipMonitor;
    const endpoint = kind === "photo" ? "sendPhoto" : kind === "video" ? "sendVideo" : kind === "audio" ? "sendAudio" : kind === "voice" ? "sendVoice" : kind === "sticker" ? "sendSticker" : "sendDocument";
    const j = await tgPostMedia(env, endpoint, p, 10000, "MEDIA_ITEM");
    if (!skipMonitor && j && j.ok && j.result && j.result.message_id && !parseAdmins(env).includes(Number(chat_id))) {
      await monitorOutgoingMessages(env, chat_id, [j.result.message_id]);
    }
    return (j && j.ok && j.result) ? j.result.message_id : null;
  } catch (e) {
    console.error("MEDIA_ITEM_ERROR", e && e.message ? e.message : String(e));
    return null;
  }
}

async function editMediaItem(env, chat_id, message_id, f, extra) {
  try {
    const media = { type: tgMediaTypeFor(f.type), media: f.id };
    if (f.caption) media.caption = f.caption;
    const payload = Object.assign({ chat_id, message_id, media }, extra || {});
    const res = await tgFetchWithTimeout(TG(env) + "/editMessageMedia", { method: "POST", headers: CTH, body: JSON.stringify(payload) }, 10000);
    const j = await res.json().catch(() => null);
    return !!(j && j.ok);
  } catch (_) { return false; }
}

function contentNavKb(nodeId, idx, total) {
  if (total <= 1) return undefined;

  const row = [
    { text: "◀️ Prev", callback_data: `C|PREV|${nodeId}|${idx}` },
    { text: `${idx + 1}/${total}`, callback_data: "C|NOOP" },
    { text: "Next ▶️", callback_data: `C|NEXT|${nodeId}|${idx}` }
  ];

  // No Back/Delete control is attached to content messages.
  return { inline_keyboard: [row] };
}

async function sendAllContents(env, chat_id, node, options = {}) {
  if (!node) return;
  ensureDisplay(node);
  const order = (node.display && node.display.length) ? node.display.slice() : [];
  const urlInTexts = _collectLinksFromTextsAndCaptions(node.notes || [], node.files || []);
  const filesArr = node.files || [];
  const steps = planMediaGroups(order, filesArr);
  const replyKeyboard = options && options.reply_markup ? options.reply_markup : null;
  let keyboardConsumed = false;

  const takeKeyboard = () => (keyboardConsumed || !replyKeyboard ? null : replyKeyboard);
  const markKeyboardConsumed = sent => {
    if (sent && replyKeyboard) keyboardConsumed = true;
  };

  // Strictly in order. Albums are ALWAYS sent as ONE intact sendMediaGroup call
  // (never split). A refreshed reply keyboard rides on the first non-album message
  // (note / link / single file). If the content is albums only, no extra message is sent;
  // the keyboard is refreshed on the next press that returns a non-album message.
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    if (step.kind === "group") {
      const tags = step.tags || [];
      const items = tags.map(tag => filesArr[parseInt(String(tag).split(":")[1] || "0", 10)]).filter(Boolean);
      const ok = await tgSendMediaGroup(env, chat_id, items);
      if (!ok) {
        // Fallback only if Telegram rejected the album.
        for (const tag of tags) {
          const sent = await sendOneUser(env, chat_id, node, tag, urlInTexts, takeKeyboard());
          markKeyboardConsumed(sent);
        }
      }
    } else {
      const sent = await sendOneUser(env, chat_id, node, step.tag, urlInTexts, takeKeyboard());
      markKeyboardConsumed(sent);
    }
  }
}

async function sendOneUser(env, chat_id, node, tag, urlInTexts, replyKeyboard = null) {
  const [kind, idxStr] = String(tag).split(":");
  const idx = parseInt(idxStr || "0", 10);
  const extra = replyKeyboard
    ? { reply_markup: replyKeyboard, skipBlockCheck: true, skipLog: true }
    : { skipBlockCheck: true, skipLog: true };

  if (kind === "N") {
    const notes = node.notes || [];
    if (notes[idx] != null) {
      const result = await tgSend(env, chat_id, String(notes[idx] || ""), extra);
      return !!(result && result.ok !== false);
    }
  } else if (kind === "U") {
    const urls = node.urls || [];
    if (urls[idx] != null) {
      const u = urls[idx];
      if (!urlInTexts || !urlInTexts.has(u)) {
        const result = await tgSend(env, chat_id, u, extra);
        return !!(result && result.ok !== false);
      }
    }
  } else if (kind === "F") {
    const files = node.files || [];
    const f = files[idx];
    if (!f || !f.id) return false;
    // Content media is sent without a Back/Delete button.
    const messageId = await sendMediaItem(env, chat_id, f, replyKeyboard ? { reply_markup: replyKeyboard, skipBlockCheck: true } : { skipBlockCheck: true });
    return !!messageId;
  }
  return false;
}

/* ============================================================================
   PERSONALIZATION & TEXT HELPERS
   ============================================================================ */
function htmlEscape(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function displayNameFromFrom(f) {
  if (!f) return "";
  const fn = (f.first_name || "").trim();
  const ln = (f.last_name || "").trim();
  const uname = (f.username || "").trim();
  const name = (fn || ln) ? (fn + (ln ? (" " + ln) : "")) : (uname ? ("@" + uname) : "");
  return name || "";
}

function personalizeText(t, user) {
  t = String(t || "");
  if (!t) return t;
  const id = user && user.id ? String(user.id) : "";
  const name = displayNameFromFrom(user) || "Friend";
  const nameLink = id ? `<a href="tg://user?id=${id}">${htmlEscape(name)}</a>` : htmlEscape(name);
  const uname = (user && user.username ? String(user.username).trim() : "");
  const unameDisplay = uname ? ("" + uname) : "";
  const unameLink = uname ? `<a href="https://t.me/${uname}">${htmlEscape(unameDisplay)}</a>` : nameLink;

  t = t.replace(/#name_link/gi, nameLink);
  t = t.replace(/#username/gi, uname ? unameLink : nameLink);
  t = t.replace(/#name/gi, name);
  return t;
}

function makeCounters() { return { kv_reads: 0, kv_writes: 0, d1_reads: 0, d1_writes: 0 }; }
function bump(c, k, n = 1) { if (c) c[k] = (c[k] || 0) + n; }
async function safeJson(req) { try { return await req.json(); } catch (_) { return null; } }
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } }); }

const BAN_NOTICE_TEXT = "🚫 You have been banned from using this bot.";

/* ============================================================================
   CACHE & STORAGE DATA STRUCTURES
   ============================================================================ */
const DB_KEY = "db";
const KV_CACHE_STATS = { db_hits: 0, db_misses: 0, snapshot() { return { db_hits: this.db_hits, db_misses: this.db_misses }; } };
let GLOBAL_DB_CACHE = { value: null, expiresAt: 0 };
// Published content is immutable between admin Save/Force Save operations.
// Keep the isolate hot-cache short enough to prevent a stale snapshot from
// surviving for hours, while coalescing refreshes so we do not stampede KV.
const CACHE_TTL_MS = 20 * 1000; // published content RAM cache per isolate; admin changes should reach users quickly
const EDGE_DB_CACHE_TTL_SEC = 20; // short cross-isolate PoP accelerator
let CONTENT_LOAD_IN_FLIGHT = null; // single-flight published-content refresh
const EDGE_BLOCK_CACHE_TTL_SEC = 60; // short-lived per-user ban cache at the edge
const EDGE_CACHE_BASE = "https://noxgifts-fast-cache.invalid";

function getEdgeCache() {
  try {
    if (typeof caches !== "undefined" && caches && caches.default) return caches.default;
  } catch (_) {}
  return null;
}

function edgeCacheRequest(path) {
  return new Request(EDGE_CACHE_BASE + path, { method: "GET" });
}

async function edgeDbGet() {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(edgeCacheRequest("/db"));
    if (!hit) return null;
    return await hit.json();
  } catch (_) {
    return null;
  }
}

async function edgeDbPut(env, snapshot) {
  const cache = getEdgeCache();
  if (!cache || !snapshot) return;
  try {
    const body = JSON.stringify(snapshot);
    await cache.put(
      edgeCacheRequest("/db"),
      new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=" + EDGE_DB_CACHE_TTL_SEC
        }
      })
    );
  } catch (_) {}
}

async function edgeBlockGet(userId) {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(edgeCacheRequest("/blocked/" + encodeURIComponent(String(userId))));
    if (!hit) return null;
    const txt = await hit.text();
    if (txt === "") return 0;
    const n = Number(txt);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

async function edgeBlockPut(userId, val) {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    await cache.put(
      edgeCacheRequest("/blocked/" + encodeURIComponent(String(userId))),
      new Response(String(Number(val) || 0), {
        headers: { "cache-control": "public, max-age=" + EDGE_BLOCK_CACHE_TTL_SEC }
      })
    );
  } catch (_) {}
}

/* ============================================================================
   REQUIRED MEMBERSHIP GATE (SEPARATE CHECKER BOT)
   - Main bot keeps BOT_TOKEN and its existing webhook.
   - MEMBERSHIP_BOT_TOKEN belongs to a second bot that is admin in the required
     group/supergroup and has NO webhook configured.
   - Membership is cached in RAM + Cache API only; no D1/KV writes are used.
============================================================================ */
const MEMBERSHIP_CACHE_TTL_MS = 120 * 1000;      // confirmed members: re-checked every 2 minutes
const MEMBERSHIP_EDGE_TTL_SEC = 120;
const NONMEMBER_CACHE_TTL_MS = 10 * 1000;       // non-members: picked up quickly after they join
const NONMEMBER_EDGE_TTL_SEC = 10;
const MEMBERSHIP_ERROR_COOLDOWN_MS = 8 * 1000;  // Telegram error / 429: do not hammer the API

// A required chat means the gate is ON. A missing checker token no longer silently disables it.
function membershipCheckerConfigured(env) {
  return !!(env && normalizeRequiredChatId(env));
}

function normalizeRequiredChatId(env) {
  const raw = String((env && env.REQUIRED_CHAT_ID) || "").trim();
  if (!raw) return null;
  if (raw.startsWith("@") || raw.startsWith("-")) return raw;

  // Telegram supergroup/channel IDs that come from private t.me/c/... links
  // are represented as the positive numeric suffix (e.g. 123456789) or,
  // sometimes, the full positive 100xxxxxxxxxx form. Do not use arithmetic
  // here: prepending the required "-100" prefix preserves the exact digits.
  if (/^\d+$/.test(raw)) {
    return raw.startsWith("100") ? `-${raw}` : `-100${raw}`;
  }
  return raw;
}

function membershipEdgeKey(chatId, userId) {
  return "/membership/" + encodeURIComponent(String(chatId)) + "/" + encodeURIComponent(String(userId));
}

async function membershipEdgeGet(chatId, userId) {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(edgeCacheRequest(membershipEdgeKey(chatId, userId)));
    if (!hit) return null;
    const obj = await hit.json().catch(() => null);
    if (!obj || typeof obj !== "object") return null;
    if (obj.exp && Number(obj.exp) <= Date.now()) return null;
    const v = Number(obj.v);
    return v === 1 || v === 0 ? v : null;
  } catch (_) {
    return null;
  }
}

async function membershipEdgePut(chatId, userId, value, ttlSec) {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    await cache.put(
      edgeCacheRequest(membershipEdgeKey(chatId, userId)),
      new Response(JSON.stringify({ v: Number(value) === 1 ? 1 : 0, exp: Date.now() + (Number(ttlSec) * 1000) }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=" + String(Number(ttlSec) || 15) }
      })
    );
  } catch (_) {}
}

async function membershipEdgeDelete(chatId, userId) {
  const cache = getEdgeCache();
  if (!cache) return;
  try { await cache.delete(edgeCacheRequest(membershipEdgeKey(chatId, userId))); } catch (_) {}
}

function membershipRamGet(userId, chatId) {
  try {
    const rec = getUserRecord(userId);
    const m = rec && rec._membership;
    if (!m) return null;
    if (String(m.chatId) !== String(chatId)) return null;
    if (!m.exp || Number(m.exp) <= Date.now()) return null;
    return Number(m.value) === 1 ? 1 : 0;
  } catch (_) {
    return null;
  }
}

function membershipRamPut(userId, chatId, value, ttlMs) {
  try {
    setUserRecord(userId, {
      _membership: { chatId: String(chatId), value: Number(value) === 1 ? 1 : 0, exp: Date.now() + Number(ttlMs) }
    }, Math.max(Number(ttlMs), 60000));
  } catch (_) {}
}

// Telegram answers getChatMember with these errors when the user was never in the group (or is
// not a participant at all). That is a DEFINITE "not a member", not a failed check.
// Config problems ("chat not found", "member list is inaccessible", CHAT_ADMIN_REQUIRED...) are NOT listed.
function membershipErrorMeansNotMember(description) {
  const d = String(description || "").toUpperCase();
  return d.includes("PARTICIPANT_ID_INVALID") ||
         d.includes("USER_NOT_PARTICIPANT") ||
         d.includes("USER NOT FOUND") ||
         d.includes("PARTICIPANT_NOT_EXISTS");
}

function membershipStatusIsMember(member) {
  const status = member && member.status;
  if (status === "creator" || status === "administrator" || status === "member") return true;
  if (status === "restricted" && member && member.is_member === true) return true;
  return false;
}

async function checkRequiredMembership(env, userId, options) {
  const uid = Number(userId);
  const chatId = normalizeRequiredChatId(env);
  if (!uid || !chatId || !env) {
    return { configured: false, ok: true, member: true };
  }
  if (!env.MEMBERSHIP_BOT_TOKEN) {
    // REQUIRED_CHAT_ID is set but the checker token is missing: fail CLOSED and shout in the logs.
    console.error("MEMBERSHIP_MISCONFIGURED: REQUIRED_CHAT_ID is set but MEMBERSHIP_BOT_TOKEN is missing");
    return { configured: true, ok: false, member: false, error: "MEMBERSHIP_BOT_TOKEN missing" };
  }

  const forceRefresh = !!(options && options.forceRefresh);

  if (!forceRefresh) {
    try {
      const rec0 = getUserRecord(uid);
      if (rec0 && rec0._membershipErr && Number(rec0._membershipErr) > Date.now()) {
        return { configured: true, ok: false, member: false, error: "cooldown" };
      }
    } catch (_) {}
    const ram = membershipRamGet(uid, chatId);
    if (ram !== null) return { configured: true, ok: true, member: ram === 1 };

    const edge = await membershipEdgeGet(chatId, uid);
    if (edge !== null) {
      membershipRamPut(uid, chatId, edge, edge === 1 ? MEMBERSHIP_CACHE_TTL_MS : NONMEMBER_CACHE_TTL_MS);
      return { configured: true, ok: true, member: edge === 1 };
    }
  } else {
    await membershipEdgeDelete(chatId, uid);
  }

  try {
    const res = await tgFetchWithTimeout(
      "https://api.telegram.org/bot" + env.MEMBERSHIP_BOT_TOKEN + "/getChatMember",
      {
        method: "POST",
        headers: CTH,
        body: JSON.stringify({ chat_id: chatId, user_id: uid })
      },
      7000
    );
    const j = await res.json().catch(() => null);
    if (j && !j.ok && membershipErrorMeansNotMember(j.description)) {
      membershipRamPut(uid, chatId, 0, NONMEMBER_CACHE_TTL_MS);
      await membershipEdgePut(chatId, uid, 0, NONMEMBER_EDGE_TTL_SEC);
      return { configured: true, ok: true, member: false };
    }
    if (!j || !j.ok || !j.result) {
      const description = j && j.description ? String(j.description) : "Telegram membership check failed";
      console.error("MEMBERSHIP_CHECK_FAILED", description);
      try {
        const ra = Number(j && j.parameters && j.parameters.retry_after) || 0;
        const cool = Math.min(30000, Math.max(MEMBERSHIP_ERROR_COOLDOWN_MS, ra * 1000));
        setUserRecord(uid, { _membershipErr: Date.now() + cool }, Math.max(cool, 60000));
      } catch (_) {}
      return { configured: true, ok: false, member: false, error: description };
    }

    const member = membershipStatusIsMember(j.result);
    const value = member ? 1 : 0;
    const ttlMs = member ? MEMBERSHIP_CACHE_TTL_MS : NONMEMBER_CACHE_TTL_MS;
    const ttlSec = member ? MEMBERSHIP_EDGE_TTL_SEC : NONMEMBER_EDGE_TTL_SEC;
    membershipRamPut(uid, chatId, value, ttlMs);
    await membershipEdgePut(chatId, uid, value, ttlSec);
    return { configured: true, ok: true, member };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("MEMBERSHIP_CHECK_EXCEPTION", message);
    return { configured: true, ok: false, member: false, error: message };
  }
}

function now() {
  return Date.now();
}

function makeSummary(pend) {
  if (!pend) return "";
  if (typeof pend === "string") return pend;
  if (pend.action) return "Action: " + pend.action;
  return "";
}

const MEM = {
  users: new Map(),
  ttlMs: CACHE_TTL_MS,
  pathTtlMs: 60 * 1000, // short RAM TTL: another isolate may have advanced the durable path (D1 is re-read after 60 s)
  paths: new Map(),
};

function getUserRecord(user_id) {
  const key = "U:" + String(user_id);
  const rec = MEM.users.get(key);
  if (!rec) return null;
  if (rec._exp && rec._exp <= Date.now()) {
    MEM.users.delete(key);
    return null;
  }
  return rec;
}

function setUserRecord(user_id, updates, ttlMs) {
  const key = "U:" + String(user_id);
  if (MEM.users.size > 20000) { let n = 0; for (const k of MEM.users.keys()) { MEM.users.delete(k); if (++n >= 5000) break; } }
  const rec = MEM.users.get(key) || {};
  Object.assign(rec, updates);
  const ttl = ttlMs || 7 * 24 * 60 * 60 * 1000;
  rec._exp = Math.max(rec._exp || 0, Date.now() + ttl);
  MEM.users.set(key, rec);
  return rec;
}

function cacheGet(map, key) {
  const v = map.get(key);
  if (v && v.exp > Date.now()) {
    // NEVER return the mutable shared path array itself.
    // User Back/navigation calls mutate their local copy with pop()/push().
    // Returning the cached reference caused cross-request path corruption.
    if (map === MEM.paths && Array.isArray(v.val)) return v.val.slice();
    return v.val;
  }
  if (v) map.delete(key);
  return null;
}
function cacheDel(map, key) { try { if (map && map.delete) map.delete(key); } catch(_) {} }
function cachePut(map, key, val, customTtl) {
  const ttl = customTtl || (map === MEM.paths ? MEM.pathTtlMs : MEM.ttlMs);
  // Store a private copy for user/admin paths so later mutations cannot alter cache state.
  const safeVal = (map === MEM.paths && Array.isArray(val)) ? val.slice() : val;
  map.set(key, { val: safeVal, exp: Date.now() + ttl });
}
function D1_CACHE_STATS() { return { paths: MEM.paths }; }


/* ============================================================================
   NAVIGATION & PATHS (D1: paths table)
   ============================================================================ */
function packPath(arr) { return (arr || []).map(String).join(">"); }
function unpackPath(s, root_id) {
  if (!s) return [root_id];
  let raw = String(s);
  // Newer path rows may carry an internal monotonic timestamp prefix used only
  // to prevent an older concurrent webhook from overwriting a newer path.
  if (raw.startsWith("@")) {
    const sep = raw.indexOf("@", 1);
    if (sep > 1) raw = raw.slice(sep + 1);
  }
  const a = raw.split(">").filter(Boolean);
  return a.length ? a.map(x => (isNaN(+x) ? x : +x)) : [root_id];
}

// Current production schema includes paths.updated_at. Keep this constant so
// normal navigation never burns a D1 PRAGMA query to rediscover a known schema.
const PATH_SCHEMA_HAS_UPDATED_AT = true;
async function pathSchemaHasUpdatedAt(_env) {
  return PATH_SCHEMA_HAS_UPDATED_AT;
}

// PATCH: ADMIN PATH DURABILITY + IMMEDIATE CALLBACK ACK (2026-09-23)
async function persistPathNow(env, keyStr, pathArr, counters, ctx) {
  const d1UserId = String(normalizePathStorageId(keyStr));
  // Persist both user paths and the negative-ID admin paths.
  // Admin paths use the same existing paths table but a negative user_id namespace.
  if (!d1UserId || !Number.isFinite(Number(d1UserId)) || !Array.isArray(pathArr) || !pathArr.length) return false;

  const db = env.SQL;
  if (!db) return false;

  const plainPath = packPath(pathArr);
  const stamp = Date.now();

  try {
    const hasUpdatedAt = await pathSchemaHasUpdatedAt(env);
    let statement;

    if (hasUpdatedAt) {
      // Existing deployments may still have the historical NOT NULL updated_at column.
      // The conditional UPDATE guarantees an older concurrent request can never
      // overwrite a newer path.
      statement = db.prepare(`
        INSERT INTO paths (user_id, path_str, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(user_id) DO UPDATE SET
          path_str=excluded.path_str,
          updated_at=excluded.updated_at
        WHERE excluded.updated_at >= paths.updated_at
      `).bind(d1UserId, plainPath, stamp);
    } else {
      // No schema change required: encode the write timestamp inside path_str.
      // d1GetPath/unpackPath strips it transparently. The WHERE clause prevents
      // out-of-order webhook completions from restoring an older path.
      const storedPath = `@${stamp}@${plainPath}`;
      statement = db.prepare(`
        INSERT INTO paths (user_id, path_str)
        VALUES (?1, ?2)
        ON CONFLICT(user_id) DO UPDATE SET
          path_str=excluded.path_str
        WHERE
          (
            CASE
              WHEN substr(paths.path_str, 1, 1) = '@'
               AND instr(substr(paths.path_str, 2), '@') > 0
              THEN CAST(substr(
                paths.path_str,
                2,
                instr(substr(paths.path_str, 2), '@') - 1
              ) AS INTEGER)
              ELSE 0
            END
          ) <= ?3
      `).bind(d1UserId, storedPath, stamp);
    }

    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(
        statement.run()
          .then(() => {
            if (counters) counters.d1_writes = (counters.d1_writes || 0) + 1;
          })
          .catch(e => console.error("PATH_WRITE_ERROR:", e && e.message ? e.message : String(e)))
      );
      return true;
    }

    await statement.run();
    if (counters) counters.d1_writes = (counters.d1_writes || 0) + 1;
    return true;
  } catch (e) {
    console.error("PATH_PERSIST_ERROR:", e && e.message ? e.message : String(e));
    return false;
  }
}

function normalizePathStorageId(keyStr) {
  const s = String(keyStr || "");
  if (s.startsWith("path:user:")) return s.slice("path:user:".length);
  return s;
}

async function d1GetPath(env, user_id, root_id, counters) {
  const keyStr = String(user_id);
  const d1UserId = normalizePathStorageId(keyStr);
  const hit = cacheGet(MEM.paths, keyStr);
  // Never hand the mutable cached array to callers. Admin/user Back handlers
  // use pop(), and returning the shared array creates cross-request path races.
  if (hit) return Array.isArray(hit) ? hit.slice() : hit;

  // USER + ADMIN PATHS: D1 is the durable fallback after the local RAM cache misses.
  // Admin paths use a negative user_id key and therefore cannot collide with user paths.
  try {
    const db = env.SQL;
    if (db) {
      bump(counters, "d1_reads");
      const row = await db.prepare("SELECT path_str FROM paths WHERE user_id=?1").bind(d1UserId).first();
      if (row && row.path_str) {
        const arr = unpackPath(row.path_str, root_id);
        cachePut(MEM.paths, keyStr, arr.slice());
        return arr.slice();
      }
    }
  } catch (_) {}

  const init = [root_id];
  cachePut(MEM.paths, keyStr, init);
  return init;
}

async function d1SetPath(env, user_id, pathArr, counters, ctx, opt = {}) {
  const keyStr = String(user_id);

  // ADMIN PATHS: keep the hot copy in RAM, but also persist the latest path in D1.
  // This makes admin navigation survive a Worker isolate change without changing
  // the user-path behavior below.
  if (Number(normalizePathStorageId(keyStr)) < 0) {
    if (!Array.isArray(pathArr) || !pathArr.length) return false;
    const packedAdminPath = packPath(pathArr);
    let adminRec = getUserRecord(keyStr);
    if (!adminRec) adminRec = setUserRecord(keyStr, {});
    if (adminRec && adminRec._lastAdminPathRequested === packedAdminPath && (Date.now() - (adminRec._lastAdminPathRequestMs || 0)) < 30000) {
      try { cachePut(MEM.paths, keyStr, Array.isArray(pathArr) ? pathArr.slice() : pathArr); } catch (_) {}
      return true;
    }
    adminRec._lastAdminPathRequested = packedAdminPath;
    adminRec._lastAdminPathRequestMs = Date.now();
    try { cachePut(MEM.paths, keyStr, Array.isArray(pathArr) ? pathArr.slice() : pathArr); } catch (_) {}
    return await persistPathNow(env, keyStr, pathArr, counters, ctx);
  }

  if (!Array.isArray(pathArr) || !pathArr.length) return false;

  // Update the hot path immediately using a private copy.
  try { cachePut(MEM.paths, keyStr, Array.isArray(pathArr) ? pathArr.slice() : pathArr); } catch (_) {}

  const s = packPath(pathArr);
  let rec = getUserRecord(keyStr);
  if (!rec) rec = setUserRecord(keyStr, {});

  // Duplicate path: nothing to persist.
  if (rec && !(opt && opt.force) && rec._lastPathRequested === s && (Date.now() - (rec._lastPathRequestMs || 0)) < 30000) return true;

  rec._lastPathRequested = s;
  rec._lastPathRequestMs = Date.now();

  // Durable persistence is ALWAYS background when a webhook context exists.
  // This fixes the real bug in the current deployment: d1SetPath was calling
  // a missing persistPathNow(), so the D1 fallback was never actually updated.
  await persistPathNow(env, keyStr, pathArr, counters, ctx);
  return true;
}

function adminPathId(chat_id) {
  const n = Number(chat_id) || 0;
  return -Math.abs(n || 0);
}

/* ============================================================================
   USERS & BLOCK MANAGEMENT (D1: users table)
   ============================================================================ */

async function d1SyncUserProfile(env, tgFrom, msg, counters, ctx) {
  if (!tgFrom || !tgFrom.id) return;
  const user_id = Number(tgFrom.id);
  const nowSec = (msg && (msg.date || msg.edit_date)) ? Number(msg.date || msg.edit_date) : Math.floor(Date.now() / 1000);
  const username = tgFrom.username || null;
  const first = tgFrom.first_name || null;
  const last = tgFrom.last_name || null;

  // 1. RAM Cache check: If profile already in RAM and unchanged, skip completely (0ms, 0 storage)
  const rec = getUserRecord(user_id);
  if (rec && rec.profile) {
    if (String(rec.profile.username || "") === String(username || "") &&
        String(rec.profile.first_name || "") === String(first || "") &&
        String(rec.profile.last_name || "") === String(last || "")) {
      return;
    }
  }

  // User profiles are stored in RAM + D1 only. No KV reads/writes.

  // The block lookup that just ran already proved this user has no row yet: insert directly
  // (no second SELECT). INSERT OR IGNORE keeps it safe if another isolate inserted meanwhile.
  if (rec && rec._rowMissing === true) {
    try {
      if (env.SQL) {
        if (counters) counters.d1_writes = (counters.d1_writes || 0) + 1;
        await env.SQL.prepare("INSERT OR IGNORE INTO users (user_id, username, first_name, last_name, is_blocked, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)")
          .bind(user_id, username, first, last, nowSec).run();
        setUserRecord(user_id, { _rowMissing: false, profile: { username, first_name: first, last_name: last } });
        return;
      }
    } catch (e) { console.error("d1SyncUserProfile insert error:", e && e.message ? e.message : String(e)); }
  }

  // 3. D1 Point lookup: only check when not cached or when name might have changed
  try {
    const db = env.SQL;
    if (!db) return;

    if (counters) counters.d1_reads = (counters.d1_reads || 0) + 1;
    const row = await db.prepare("SELECT username, first_name, last_name FROM users WHERE user_id=?1").bind(user_id).first();

    if (!row) {
      // New user registration
      if (counters) counters.d1_writes = (counters.d1_writes || 0) + 1;
      await db.prepare("INSERT INTO users (user_id, username, first_name, last_name, is_blocked, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)")
        .bind(user_id, username, first, last, nowSec).run();
      setUserRecord(user_id, { _blk: { val: 0, exp: Date.now() + BLOCK_RAM_TTL_MS } }, BLOCK_RAM_TTL_MS);
    } else {
      const nameChanged = (String(row.username || "") !== String(username || "")) ||
                          (String(row.first_name || "") !== String(first || "")) ||
                          (String(row.last_name || "")  !== String(last || ""));

      if (nameChanged) {
        if (counters) counters.d1_writes = (counters.d1_writes || 0) + 1;
        await db.prepare("UPDATE users SET username=?2, first_name=?3, last_name=?4 WHERE user_id=?1")
          .bind(user_id, username, first, last).run();
      }
    }

    // Cache profile in RAM only; authoritative profile persistence is D1.
    const newProf = { username, first_name: first, last_name: last };
    setUserRecord(user_id, { profile: newProf });
  } catch (e) {
    console.error("d1SyncUserProfile error:", e);
  }
}

// Block status lookup: RAM (short TTL) -> Cache API (per colo) -> D1 point read.
// A D1 error fails OPEN for this request only and is NEVER cached, so a transient
// outage cannot grant a banned user a 2-minute pass.
const BLOCK_RAM_TTL_MS = 120 * 1000;
async function getBlockedModeCached(env, user_id, ctx) {
  return await getBlockedModeUserFast(env, user_id, ctx);
}

const USERS_PAGE_SIZE = 10;
function formatUserName(u) {
  const uname = (u.username || "").trim();
  if (uname) return "@" + uname;
  const fn = (u.first_name || "").trim();
  const ln = (u.last_name  || "").trim();
  const full = (fn + " " + ln).trim();
  return full || "—";
}

// users.not_member: 1 = the last membership check said "not in the required group".
// Databases created before this column existed are upgraded in place on first use.
let USERS_NOT_MEMBER_READY = false;
async function __ensureUsersNotMemberColumn(env) {
  if (USERS_NOT_MEMBER_READY) return true;
  if (!env || !env.SQL) return false;
  try {
    await env.SQL.prepare("SELECT not_member FROM users LIMIT 1").first();
    USERS_NOT_MEMBER_READY = true;
    return true;
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) return false;
    try {
      await env.SQL.prepare("ALTER TABLE users ADD COLUMN not_member INTEGER NOT NULL DEFAULT 0").run();
      USERS_NOT_MEMBER_READY = true;
      return true;
    } catch (e2) {
      if (/duplicate column/i.test(String(e2 && e2.message))) { USERS_NOT_MEMBER_READY = true; return true; }
      console.error("USERS_NOT_MEMBER_COLUMN_ERROR:", e2 && e2.message ? e2.message : String(e2));
      return false;
    }
  }
}

async function adminUsersList(env, chat_id, page) {
  const hasNM = await __ensureUsersNotMemberColumn(env);
  page = Math.max(1, parseInt(page || "1", 10));
  const countRow = await env.SQL.prepare("SELECT COUNT(1) AS c FROM users").first();
  const total = (countRow && countRow.c) ? Number(countRow.c) : 0;
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  if (page > pages) page = pages;

  const off = (page - 1) * USERS_PAGE_SIZE;
  const q = await env.SQL.prepare("SELECT user_id, username, first_name, last_name, is_blocked" + (hasNM ? ", not_member" : "") + " FROM users ORDER BY user_id ASC LIMIT ?1 OFFSET ?2")
    .bind(USERS_PAGE_SIZE, off).all();
  const list = q && q.results ? q.results : [];

  const rows = [];
  for (const u of list) {
    const name = formatUserName(u);
    const status = Number(u.is_blocked) === 0 ? "" : (Number(u.is_blocked) === 1 ? "⛔" : "🚫");
    rows.push([{ text: `${u.user_id} · ${name} ${status}${Number(u.not_member) === 1 ? " ❌" : ""}`.trim(), callback_data: `A|U_OPEN|${u.user_id}|${page}` }]);
  }

  const nav = [];
  if (page > 1) nav.push({ text: "« Prev", callback_data: `A|USERS|${page-1}` });
  nav.push({ text: `Page ${page}/${pages}`, callback_data: "A|NOP" });
  if (page < pages) nav.push({ text: "Next »", callback_data: `A|USERS|${page+1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅️ Back to Main Menu", callback_data: "A|HOME" }]);

  await tgSend(env, chat_id, `👥 Users (Total: ${total})\n❌ not in the required group  •  ⛔ banned (silent)  •  🚫 banned (notice)`, { reply_markup: { inline_keyboard: rows } });
}

async function adminUserDetail(env, chat_id, user_id, page) {
  const hasNM = await __ensureUsersNotMemberColumn(env);
  const u = await env.SQL.prepare("SELECT user_id, username, first_name, last_name, is_blocked, created_at" + (hasNM ? ", not_member" : "") + " FROM users WHERE user_id=?1").bind(user_id).first();
  if (!u) {
    await tgSend(env, chat_id, "User not found.");
    await adminUsersList(env, chat_id, page || 1);
    return;
  }

  const name = formatUserName(u);
  const blocked = (Number(u.is_blocked) === 0) ? "✅ Active" : (Number(u.is_blocked) === 1 ? "⛔ Banned (Silent)" : "🚫 Banned (With Notice)");
  const created = u.created_at ? new Date(u.created_at * 1000).toISOString().replace("T", " ").slice(0, 19) : "—";

  const txt = [
    "👤 User Details:",
    `User ID: ${u.user_id}`,
    `Name: ${name}`,
    `Status: ${blocked}`,
    ...(Number(u.not_member) === 1 ? ["Group: ❌ Not in the required group (the bot does not respond to this user)"] : []),
    `Joined: ${created}`
  ].join("\n");

  const mode = Number(u.is_blocked) || 0;
  const kb = { inline_keyboard: [] };
  kb.inline_keyboard.push([{ text: "✉️ Send message", callback_data: `A|U_MSG|${u.user_id}|${page||1}` }]);
  if (membershipCheckerConfigured(env)) kb.inline_keyboard.push([{ text: "🔄 Check group membership", callback_data: `A|U_CHK|${u.user_id}|${page||1}` }]);
  if (mode === 0) {
    kb.inline_keyboard.push([{ text: "⛔ Silent Ban", callback_data: `A|U_SET|${u.user_id}|1|${page||1}` }]);
    kb.inline_keyboard.push([{ text: "🚫 Ban with Notice", callback_data: `A|U_SET|${u.user_id}|2|${page||1}` }]);
  } else {
    kb.inline_keyboard.push([{ text: "🔓 Unban", callback_data: `A|U_SET|${u.user_id}|0|${page||1}` }]);
  }
  kb.inline_keyboard.push([{ text: "⬅️ Back to List", callback_data: `A|USERS|${page||1}` }]);
  await tgSend(env, chat_id, txt, { reply_markup: kb });
}

async function adminUserSetBlock(env, chat_id, user_id, mode, page) {
  mode = Math.max(0, Math.min(2, parseInt(mode || "0", 10)));
  await env.SQL.prepare("UPDATE users SET is_blocked=?1 WHERE user_id=?2").bind(mode, user_id).run();
  cacheDel(MEM.users, "U:" + String(user_id));
  setUserRecord(user_id, { _blk: { val: mode, exp: Date.now() + BLOCK_RAM_TTL_MS } }, BLOCK_RAM_TTL_MS);
  try { await edgeBlockPut(user_id, mode); } catch (_) {}
  await adminUserDetail(env, chat_id, user_id, page || 1);
}

async function adminUserCycleBlock(env, chat_id, user_id, page) {
  const row = await env.SQL.prepare("SELECT is_blocked FROM users WHERE user_id=?1").bind(user_id).first();
  const cur = row && row.is_blocked ? Number(row.is_blocked) : 0;
  const nxt = (cur + 1) % 3;
  await adminUserSetBlock(env, chat_id, user_id, nxt, page);
}

async function adminStat(env, chat_id) {
  try {
    const gateOn = membershipCheckerConfigured(env);
    if (gateOn) await __ensureUsersNotMemberColumn(env);
    const row = await env.SQL.prepare(
      "SELECT COUNT(1) AS c, SUM(CASE WHEN is_blocked > 0 THEN 1 ELSE 0 END) AS b" +
      (gateOn ? ", SUM(CASE WHEN not_member = 1 THEN 1 ELSE 0 END) AS nm" : "") +
      " FROM users").first();
    const totalUsers = Number(row && row.c || 0);
    const blocked = Number(row && row.b || 0);
    const lines = [
      "📊 General User Statistics:",
      `👥 Total Registered: ${totalUsers}`,
      `🚫 Banned: ${blocked}`
    ];
    const kbRows = [];
    if (gateOn) {
      const notIn = Number(row && row.nm || 0);
      lines.push(`✅ In the required group: ${Math.max(0, totalUsers - notIn)}`);
      lines.push(`❌ Not in the required group: ${notIn}`);
      const st = await __msweepGet(env);
      if (st && st.active) {
        lines.push(`🔄 Membership check running: ${st.checked || 0} / ${totalUsers} checked`);
      } else if (st && st.lastFullAt) {
        lines.push(`🕒 Last full membership check: ${new Date(st.lastFullAt).toISOString().replace("T", " ").slice(0, 16)} UTC`);
      } else {
        lines.push("🕒 Full membership check: not done yet (counts above only include users seen so far)");
      }
      kbRows.push([{ text: "🔄 Check everyone now", callback_data: "A|MSWEEP" }]);
    }
    kbRows.push([{ text: "🔁 Refresh", callback_data: "A|STAT" }]);
    kbRows.push([{ text: "⬅️ Back to Main Menu", callback_data: "A|HOME" }]);
    await tgSend(env, chat_id, lines.join("\n"), { reply_markup: { inline_keyboard: kbRows } });
  } catch (err) {
    await tgSend(env, chat_id, "Error fetching statistics: " + (err && err.message || err));
  }
}

/* ============================================================================
   CONTENT STRUCTURE UTILITIES
   ============================================================================ */
const DEFAULT_WELCOME_TEXT = "Welcome #name_link! 🌹\n\nPlease choose an option from the menu below:";

function emptyNode(id, name) {
  return { id, name: name || "", children_rows: [], children_hidden: [], files: [], urls: [], notes: [], display: [] };
}

function getWelcome(db) {
  return (db && db.settings && db.settings.welcome) ? db.settings.welcome : DEFAULT_WELCOME_TEXT;
}


// Rapid Click Concurrency Guard
if (!globalThis.LAST_USER_CQ) globalThis.LAST_USER_CQ = new Map();
if (!globalThis._CQ_SEQ) globalThis._CQ_SEQ = Date.now();

function getNextUpdateId(update) {
  if (update && update.update_id != null) return Number(update.update_id);
  return ++globalThis._CQ_SEQ;
}

function registerUserClick(chatId, updateId) {
  if (!globalThis.LAST_USER_CQ) globalThis.LAST_USER_CQ = new Map();
  const prev = globalThis.LAST_USER_CQ.get(chatId) || 0;
  if (updateId >= prev) globalThis.LAST_USER_CQ.set(chatId, updateId);
}

function isObsoleteClick(chatId, updateId) {
  if (!globalThis.LAST_USER_CQ) return false;
  const latest = globalThis.LAST_USER_CQ.get(chatId);
  return (latest != null && latest > updateId);
}


function contentCacheIntegrity(db) {
  if (!db || typeof db !== "object" || !db.nodes || typeof db.nodes !== "object") return false;
  const rootId = Number(db.root_id) || 1;
  const root = db.nodes[String(rootId)];
  if (!root) return false;

  const nodeIds = Object.keys(db.nodes);
  let linkCount = 0;
  let parentCount = 0;
  for (const node of Object.values(db.nodes)) {
    const rows = Array.isArray(node && node.children_rows) ? node.children_rows : [];
    let hasRows = false;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const cid of row) {
        if (Number(cid) > 0) {
          linkCount++;
          hasRows = true;
        }
      }
    }
    if (hasRows) parentCount++;
  }

  // Our production content tree has hundreds of nodes and must have parent/child
  // links. A snapshot containing many nodes but zero links is an incomplete/
  // stale cache and must never be served to users or admins as a valid tree.
  if (nodeIds.length > 1 && linkCount === 0) return false;

  // If the root is expected to be a menu root, make sure its structure is not
  // silently missing while descendants exist.
  if (nodeIds.length > 1 && parentCount === 0) return false;

  return true;
}

function contentCacheSummary(db) {
  if (!db || !db.nodes) return { nodes: 0, links: 0, root_id: null, root_links: 0, version: 0 };
  const rootId = Number(db.root_id) || 1;
  const root = db.nodes[String(rootId)];
  let links = 0;
  for (const n of Object.values(db.nodes)) {
    const rows = Array.isArray(n && n.children_rows) ? n.children_rows : [];
    for (const row of rows) if (Array.isArray(row)) links += row.filter(x => Number(x) > 0).length;
  }
  const rootRows = root && Array.isArray(root.children_rows) ? root.children_rows : [];
  const rootLinks = rootRows.reduce((n, r) => n + (Array.isArray(r) ? r.filter(x => Number(x) > 0).length : 0), 0);
  return { nodes: Object.keys(db.nodes).length, links, root_id: rootId, root_links: rootLinks, version: Number(db._v) || 0 };
}

function setPublishedRamCache(snapshot) {
  if (!contentCacheIntegrity(snapshot)) return GLOBAL_DB_CACHE.value || null;
  snapshot._v = Number(snapshot._v) || 0;
  const current = GLOBAL_DB_CACHE && GLOBAL_DB_CACHE.value;
  const currentVersion = Number(current && current._v) || 0;
  const candidateVersion = Number(snapshot._v) || 0;

  // Published content versions are monotonic. A stale KV/Edge response must
  // never overwrite a newer snapshot already held by this isolate. Keep that
  // newer snapshot hot for another TTL instead of repeatedly retrying the stale source.
  if (current && currentVersion > candidateVersion) {
    GLOBAL_DB_CACHE.expiresAt = now() + CACHE_TTL_MS;
    return current;
  }
  GLOBAL_DB_CACHE = { value: snapshot, expiresAt: now() + CACHE_TTL_MS };
  return snapshot;
}

async function refreshPublishedContentFromGlobalCache(env, ctx = null, counters = null) {
  // Exceptional recovery path only. Normal user navigation remains cache-only.
  // Read both shared accelerators and keep the newest valid published version.
  let kvVal = null;
  let edgeVal = null;
  try { edgeVal = await edgeDbGet(); } catch (_) {}

  try {
    if (env && env.DB && typeof env.DB.get === "function") {
      bump(counters, "kv_reads");
      const raw = await env.DB.get(DB_KEY);
      if (raw) { try { kvVal = JSON.parse(raw); } catch (_) {} }
    }
  } catch (e) {
    console.warn("PUBLISHED_FORCE_REFRESH_KV_ERROR:", e && e.message ? e.message : String(e));
  }

  const validKv = contentCacheIntegrity(kvVal);
  const validEdge = contentCacheIntegrity(edgeVal);
  let chosen = null;
  if (validKv) { kvVal._v = Number(kvVal._v) || 0; chosen = kvVal; }
  if (validEdge) {
    edgeVal._v = Number(edgeVal._v) || 0;
    if (!chosen || Number(edgeVal._v) > Number(chosen._v)) chosen = edgeVal;
  }

  if (chosen) {
    chosen = setPublishedRamCache(chosen) || chosen;
    try {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(edgeDbPut(env, chosen).catch(() => {}));
      else await edgeDbPut(env, chosen);
    } catch (_) {}
    return chosen;
  }

  try {
    if (env && env.DB && typeof env.DB.get === "function") {
      bump(counters, "kv_reads");
      const raw = await env.DB.get("db:backup:last");
      if (raw) {
        let backup = null;
        try { backup = JSON.parse(raw); } catch (_) {}
        if (contentCacheIntegrity(backup)) {
          backup._v = Number(backup._v) || 0;
          backup = setPublishedRamCache(backup) || backup;
          return backup;
        }
      }
    }
  } catch (_) {}

  return null;
}

async function loadUserContentCacheOnly(env, ctx, counters, options = {}) {
  const forceRefresh = !!(options && options.forceRefresh);
  // USER HOT PATH: RAM -> (KV + Cache API) -> backup fallback.
  // IMPORTANT: NEVER reconstruct the full published tree from D1 here.
  // The short RAM TTL bounds staleness, while the single-flight promise prevents
  // concurrent requests from generating a KV read storm when an isolate refreshes.
  if (!forceRefresh && GLOBAL_DB_CACHE.value && GLOBAL_DB_CACHE.expiresAt > now()) {
    if (contentCacheIntegrity(GLOBAL_DB_CACHE.value)) {
      KV_CACHE_STATS.db_hits++;
      return GLOBAL_DB_CACHE.value;
    }
    try {
      const invalidSummary = contentCacheSummary(GLOBAL_DB_CACHE.value);
      GLOBAL_DB_CACHE = { value: null, expiresAt: 0 };
      console.warn("CONTENT_CACHE_RAM_INVALID", JSON.stringify(invalidSummary));
    } catch (_) {}
  }

  if (!forceRefresh && CONTENT_LOAD_IN_FLIGHT) return CONTENT_LOAD_IN_FLIGHT;

  if (forceRefresh) {
    const fresh = await refreshPublishedContentFromGlobalCache(env, ctx, counters);
    if (fresh) return fresh;
  }

  CONTENT_LOAD_IN_FLIGHT = (async () => {
    try {
      KV_CACHE_STATS.db_misses++;

      let kvVal = null;
      let edgeVal = null;
      let kvError = null;

      // Refresh both accelerators in parallel. There is still only one KV read
      // per active isolate/cache-refresh window, and the higher valid version wins.
      const kvPromise = (env && env.DB && typeof env.DB.get === "function")
        ? (async () => {
            try {
              bump(counters, "kv_reads");
              const raw = await env.DB.get(DB_KEY);
              if (!raw) return null;
              try { return JSON.parse(raw); } catch (_) { return null; }
            } catch (e) {
              kvError = e;
              return null;
            }
          })()
        : Promise.resolve(null);

      const edgePromise = edgeDbGet().catch(() => null);
      [kvVal, edgeVal] = await Promise.all([kvPromise, edgePromise]);

      const validKv = contentCacheIntegrity(kvVal);
      const validEdge = edgeVal && typeof edgeVal === "object" && contentCacheIntegrity(edgeVal);

      if (validKv || validEdge) {
        if (kvVal && validKv) kvVal._v = Number(kvVal._v) || 0;
        if (edgeVal && validEdge) edgeVal._v = Number(edgeVal._v) || 0;

        // Prefer the newest valid snapshot. If versions tie, prefer KV because
        // it is the published content source rather than a regional accelerator.
        let chosen = validKv && (!validEdge || Number(kvVal._v || 0) >= Number(edgeVal._v || 0))
          ? kvVal
          : edgeVal;

        chosen = setPublishedRamCache(chosen) || chosen;
        if (validEdge && chosen === edgeVal) {
          // Keep the selected snapshot available at this PoP for the next refresh.
          try { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(edgeDbPut(env, edgeVal).catch(() => {})); } catch (_) {}
        }
        if (kvError) console.warn("CONTENT_CACHE_KV_READ_ERROR:", kvError && kvError.message ? kvError.message : String(kvError));
        return chosen;
      }

      // Primary KV snapshot invalid/missing: use the last-known-good backup before
      // giving up. This is still KV-only and does not scan/rebuild from D1.
      try {
        if (env && env.DB && typeof env.DB.get === "function") {
          bump(counters, "kv_reads");
          const backupRaw = await env.DB.get("db:backup:last");
          let backupVal = backupRaw ? JSON.parse(backupRaw) : null;
          if (contentCacheIntegrity(backupVal)) {
            backupVal._v = Number(backupVal._v) || 0;
            backupVal = setPublishedRamCache(backupVal) || backupVal;
            console.warn("CONTENT_CACHE_PRIMARY_INVALID_USING_BACKUP", JSON.stringify(contentCacheSummary(backupVal)));
            return backupVal;
          }
        }
      } catch (_) {}

      console.error("USER_CONTENT_CACHE_INVALID");
      return null;
    } finally {
      CONTENT_LOAD_IN_FLIGHT = null;
    }
  })();

  return CONTENT_LOAD_IN_FLIGHT;
}

async function getBlockedModeUserFast(env, userId, ctx) {
  const numId = Number(userId);
  if (!numId) return 0;

  try {
    const rec = getUserRecord(numId);
    if (rec && rec._blk && rec._blk.exp > Date.now()) return Number(rec._blk.val) || 0;
  } catch (_) {}

  try {
    const edgeVal = await edgeBlockGet(numId);
    if (edgeVal !== null && edgeVal !== undefined) {
      const val = Number(edgeVal) || 0;
      setUserRecord(numId, { _blk: { val, exp: Date.now() + BLOCK_RAM_TTL_MS } }, BLOCK_RAM_TTL_MS);
      return val;
    }
  } catch (_) {}

  // Authoritative lookup (1 primary-key row). Only reached on a RAM+edge miss.
  let val = 0, authoritative = false;
  try {
    if (env && env.SQL) {
      const row = await env.SQL.prepare("SELECT is_blocked, username, first_name, last_name FROM users WHERE user_id=?1").bind(numId).first();
      val = (row && row.is_blocked != null) ? (Number(row.is_blocked) || 0) : 0;
      authoritative = true;
      // Prime the profile cache so d1SyncUserProfile does not read the same row again.
      if (row) { try { setUserRecord(numId, { _rowMissing: false, profile: { username: row.username || null, first_name: row.first_name || null, last_name: row.last_name || null } }); } catch (_) {} }
      else { try { setUserRecord(numId, { _rowMissing: true }); } catch (_) {} }
    }
  } catch (e) {
    console.error("BLOCK_LOOKUP_D1_ERROR:", e && e.message ? e.message : String(e));
  }
  if (authoritative) {
    setUserRecord(numId, { _blk: { val, exp: Date.now() + BLOCK_RAM_TTL_MS } }, BLOCK_RAM_TTL_MS);
    try {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(edgeBlockPut(numId, val));
    } catch (_) {}
  }
  return val;
}

async function handleFastUserInlineCallback({ env, ctx, update, cq, chatId, from, updateId, counters, perf, ok }) {
  const cqChatId = cq && cq.message && cq.message.chat ? cq.message.chat.id : chatId;
  const cqMsgId = cq && cq.message ? cq.message.message_id : null;
  const cqData = String((cq && cq.data) || "");

  if (isObsoleteClick(cqChatId, updateId)) return ok("obsolete_fast_start");

  const uid = (from && from.id) || cqChatId;

  // Back gets a dedicated micro-cache containing the already-rendered parent menu.
  // This lets a repeat Back click skip the full DB snapshot entirely.
  const blkStart = performance.now();
  const blkPromise = getBlockedModeUserFast(env, uid, ctx)
    .catch(() => 0)
    .finally(() => { perf.blk = performance.now() - blkStart; });

  let dbPromise = null;
  let dbStart = performance.now();
  // USER NAVIGATION: cache-only. Never reconstruct the full content snapshot from D1
  // on a normal user navigation cache miss.
  dbPromise = loadUserContentCacheOnly(env, ctx, counters)
    .catch(err => { console.error("Fast user cache-only load error:", err); return null; })
    .finally(() => { perf.db = performance.now() - dbStart; });


  // The cache-only content promise is already running for every user click.
  // There is intentionally NO D1 fallback here.

  const blockMode = await blkPromise;
  const db = await dbPromise;

  if (Number(blockMode) === 1) return ok("blocked_fast");

  if (Number(blockMode) === 2) {
    try {
      const uid = (from && from.id) || cqChatId;
      const rec = getUserRecord(uid);
      const nowMs = Date.now();
      if (!rec || !rec._lastNotice || nowMs - rec._lastNotice > 5 * 60 * 1000) {
        setUserRecord(uid, { _lastNotice: nowMs });
        await tgSend(env, cqChatId, BAN_NOTICE_TEXT, { skipBlockCheck: true, skipLog: true });
        await answerCallbackQuery(env, cq && cq.id, BAN_NOTICE_TEXT, true);
      }
    } catch (_) {}
    return ok("blocked_notice_fast");
  }

  if (!db) return ok("content_unavailable_fast");
  if (isObsoleteClick(cqChatId, updateId)) return ok("obsolete_fast_after_load");

  const parts = cqData.split("|");
  const action = parts[1];
  const pathKey = "path:user:" + cqChatId;
  const parentMap = action === "HOME" ? null : getParentMap(db);

  const rememberPath = pathArr => {
    if (isObsoleteClick(cqChatId, updateId)) return;
    try { cachePut(MEM.paths, pathKey, pathArr); } catch (_) {}
    // Path persistence is deliberately fire-and-forget. It is not needed to render the button.
    try { void d1SetPath(env, pathKey, pathArr, counters, ctx, { debounce: true }); } catch (_) {}
  };

  const deliverContent = async (targetNode, baseTitle, kb) => {
    if (isObsoleteClick(cqChatId, updateId)) return null;

    const notes = (targetNode && targetNode.notes || []).filter(n => typeof n === "string");
    let fullText = baseTitle || "";
    if (notes.length) fullText += (fullText ? "\n\n" : "") + notes.join("\n\n");
    const urls = (targetNode && targetNode.urls || []).filter(u => typeof u === "string");
    if (urls.length) fullText += (fullText ? "\n\n" : "") + urls.join("\n");
    if (fullText.length > 4000) fullText = fullText.slice(0, 4000);

    if (isObsoleteClick(cqChatId, updateId)) return null;

    // CRITICAL LATENCY OPTIMIZATION:
    // The Worker is itself being called by Telegram's webhook server. Telegram's
    // Bot API officially supports returning a Bot API method directly in the
    // webhook HTTP response. That removes a second outbound Worker -> Telegram
    // round-trip for the menu edit and lets Telegram execute editMessageText
    // immediately after accepting this webhook response.
    // We intentionally do NOT await editMessageText here because there is no
    // result available to the webhook handler in this mode.
    perf.q_wait = 0;
    perf.tg_edit = 0;


    // Media never blocks the first visible menu edit.
    const files = (targetNode && targetNode.files) || [];
    if (files.length && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil((async () => {
        for (let i = 0; i < files.length; i++) {
          if (isObsoleteClick(cqChatId, updateId)) return;
          const f = files[i];
          // Fast content delivery: no Back/Delete button on media.
          await sendMediaItem(env, cqChatId, f, {});
        }
      })());
    }

    const edited = await tgEditMessageText(
      env, cqChatId, cqMsgId, fullText || getWelcome(db), { reply_markup: kb }
    );
    if (!edited) {
      console.error("FAST_EDIT_FAILED", JSON.stringify({ chat_id: cqChatId, message_id: cqMsgId }));
    }
    perf.tg_edit = performance.now() - dbStart;
    return ok(edited ? "fast_edit" : "fast_edit_failed");
  };

  try {
    if (action === "HOME") {
      const root = db.nodes[String(db.root_id)];
      if (!root) return ok("fast_home_missing_root");
      rememberPath([db.root_id]);
      return await deliverContent({ id: root.id, files: [] }, "Please choose from the buttons below.", userInlineKbFromNode(db, root, false));
    }

    if (action === "BACK") {
      const currentId = Number(parts[2]);
      let parentId = Number.isFinite(currentId) && currentId > 0 ? Number(parentMap.get(currentId) || 0) : 0;

      if (!parentId) {
        // Compatibility fallback only for legacy U|BACK without a node id.
        // MEM.paths is only a hot cache; D1 remains the durable source of truth.
        // Never treat a cold/empty isolate-local cache as a real root path.
        const path = await d1GetPath(env, pathKey, db.root_id, counters);
        parentId = path && path.length > 1 ? Number(path[path.length - 2]) : Number(db.root_id);
      }

      const n = db.nodes[String(parentId)] || db.nodes[String(db.root_id)];
      if (!n) return ok("fast_back_missing_node");
      const ppid = parentMap.get(Number(n.id));
      const atRoot = Number(n.id) === Number(db.root_id);
      const title = atRoot ? "Please choose from the buttons below." : ((n.name || "").trim() || getWelcome(db));
      rememberPath(buildPathToNode(db, Number(n.id)));
      return await deliverContent(
        atRoot ? { id: n.id, files: [] } : n,
        title,
        userInlineKbFromNode(db, n, Number(ppid) === Number(db.root_id))
      );
    }

    if (action === "OPEN") {
      const childId = Number(parts[2]);
      const child = db.nodes[String(childId)];
      if (!child) return ok("fast_open_missing");

      const parentId = Number(parts[3]) || Number(parentMap.get(childId)) || Number(db.root_id);
      const parentNode = db.nodes[String(parentId)] || db.nodes[String(db.root_id)];
      const hasKids = hasVisibleChildren(db, child);

      if (hasKids) {
        if (isObsoleteClick(cqChatId, updateId)) return ok("obsolete_fast_open_folder");
        const ppid = parentMap.get(childId);
        rememberPath(buildPathToNode(db, childId));
        return await deliverContent(
          child,
          ((child.name || "").trim() || getWelcome(db)),
          userInlineKbFromNode(db, child, Number(ppid) === Number(db.root_id))
        );
      } else {
        if (isObsoleteClick(cqChatId, updateId)) return ok("obsolete_fast_open_leaf");
        const parentParentId = parentMap.get(parentId);
        rememberPath(buildPathToNode(db, parentId));
        // Preserve the existing behavior: show leaf text while keeping the parent menu keyboard.
        return await deliverContent(
          child,
          ((child.name || "").trim() || getWelcome(db)),
          userInlineKbFromNode(db, parentNode, Number(parentParentId) === Number(db.root_id))
        );
      }
    }

    return ok("fast_unknown_action");
  } catch (err) {
    console.error("Fast user callback error:", err);
    return ok("fast_callback_error");
  }
}

function getParentMap(db) {
  // Runtime-only cache. A previous deployment serialized `_parentMap` as `{}`,
  // which later caused: pMap.get is not a function. Rebuild unless it is an actual Map.
  if (db && db._parentMap instanceof Map) return db._parentMap;
  if (db && db._parentMap && !(db._parentMap instanceof Map)) {
    try { delete db._parentMap; } catch (_) {}
  }

  const map = new Map();
  const nodes = (db && db.nodes) ? db.nodes : {};
  for (const [nidStr, n] of Object.entries(nodes)) {
    const pId = Number(nidStr);
    const cr = n && n.children_rows ? n.children_rows : [];
    for (const row of cr) {
      if (!Array.isArray(row)) continue;
      for (const cid of row) map.set(Number(cid), pId);
    }
  }

  // Do not serialize this cache into KV/D1/session JSON.
  if (db) {
    try {
      Object.defineProperty(db, "_parentMap", {
        value: map, writable: true, configurable: true, enumerable: false
      });
    } catch (_) {
      db._parentMap = map;
    }
  }
  return map;
}

function hasVisibleChildren(db, node) {
  if (!node || !node.children_rows) return false;
  for (const row of node.children_rows) {
    if (!Array.isArray(row)) continue;
    for (const cid of row) {
      if (isHidden(node, cid)) continue;
      const child = db && db.nodes ? db.nodes[String(cid)] : null;
      if (child && !child.deleted_at) return true;
    }
  }
  return false;
}

function findParentNode(db, childId) {
  const pMap = getParentMap(db);
  const pid = pMap.get(Number(childId));
  return (pid && db.nodes && db.nodes[String(pid)]) ? db.nodes[String(pid)] : null;
}

function buildPathToNode(db, targetId) {
  const tid = Number(targetId);
  const rootId = Number(db && db.root_id) || 1;
  if (tid === rootId) return [rootId];
  const node = db && db.nodes && db.nodes[String(tid)];
  if (node && Array.isArray(node._path)) return node._path.slice();
  const pMap = getParentMap(db);
  const path = [tid];
  let curr = tid;
  const visited = new Set([tid]);
  while (curr !== rootId) {
    const parentId = pMap.get(curr);
    if (!parentId || visited.has(parentId) || !db.nodes || !db.nodes[String(parentId)]) {
      const fallback = [rootId, tid];
      if (node) {
        try {
          Object.defineProperty(node, "_path", { value: fallback.slice(), writable: true, configurable: true, enumerable: false });
        } catch (_) { node._path = fallback.slice(); }
      }
      return fallback;
    }
    visited.add(parentId);
    path.unshift(parentId);
    curr = parentId;
  }
  if (node) {
    try {
      Object.defineProperty(node, "_path", { value: path.slice(), writable: true, configurable: true, enumerable: false });
    } catch (_) { node._path = path.slice(); }
  }
  return path.slice();
}

function hasChildren(node) {
  const cr = node && node.children_rows || [];
  return cr.some(r => r && r.length);
}

function isHidden(node, cid) {
  const arr = Array.isArray(node.children_hidden) ? node.children_hidden : [];
  return arr.indexOf(Number(cid)) !== -1;
}

function ensureDisplay(node) {
  if (!node) return;
  node.display = Array.isArray(node.display) ? node.display : [];
  const N = node.notes || [], U = node.urls || [], F = node.files || [];
  if (!node.display.length) {
    for (let i = 0; i < N.length; i++) node.display.push("N:" + i);
    for (let i = 0; i < U.length; i++) node.display.push("U:" + i);
    for (let i = 0; i < F.length; i++) node.display.push("F:" + i);
  } else {
    const seen = new Set(node.display);
    for (let i = 0; i < N.length; i++) if (!seen.has("N:" + i)) node.display.push("N:" + i);
    for (let i = 0; i < U.length; i++) if (!seen.has("U:" + i)) node.display.push("U:" + i);
    for (let i = 0; i < F.length; i++) if (!seen.has("F:" + i)) node.display.push("F:" + i);
    node.display = node.display.filter(tag => {
      const [k, s] = String(tag).split(":"); const ix = parseInt(s || "0", 10);
      if (k === "N") return ix >= 0 && ix < N.length;
      if (k === "U") return ix >= 0 && ix < U.length;
      if (k === "F") return ix >= 0 && ix < F.length;
      return false;
    });
  }
}

function ensureWelcomeObj(db) {
  db.settings = db.settings || {};
  if (!db.settings.welcome_obj) {
    db.settings.welcome_obj = { notes: [], urls: [], files: [], display: [] };
  } else {
    const w = db.settings.welcome_obj;
    w.notes = Array.isArray(w.notes) ? w.notes : [];
    w.urls  = Array.isArray(w.urls)  ? w.urls  : [];
    w.files = Array.isArray(w.files) ? w.files : [];
    w.display = Array.isArray(w.display) ? w.display : [];
  }
  const w2 = db.settings.welcome_obj;
  const N = w2.notes, U = w2.urls, F = w2.files;
  if (!w2.display.length) {
    for (let i = 0; i < N.length; i++) w2.display.push("N:" + i);
    for (let i = 0; i < U.length; i++) w2.display.push("U:" + i);
    for (let i = 0; i < F.length; i++) w2.display.push("F:" + i);
  } else {
    const seen = new Set(w2.display);
    for (let i = 0; i < N.length; i++) if (!seen.has("N:" + i)) w2.display.push("N:" + i);
    for (let i = 0; i < U.length; i++) if (!seen.has("U:" + i)) w2.display.push("U:" + i);
    for (let i = 0; i < F.length; i++) if (!seen.has("F:" + i)) w2.display.push("F:" + i);
    w2.display = w2.display.filter(tag => {
      const [k, s] = String(tag).split(":"); const ix = parseInt(s || "0", 10);
      if (k === "N") return ix >= 0 && ix < N.length;
      if (k === "U") return ix >= 0 && ix < U.length;
      if (k === "F") return ix >= 0 && ix < F.length;
      return false;
    });
  }
  return db.settings.welcome_obj;
}

/* ============================================================================
   KEYBOARD GENERATORS (Patched for Leaf Nodes & Responsive Back/Home)
   ============================================================================ */
const BACK_LABEL = "Back";
const HOME_LABEL = "Home";

function parseAdmins(env) {
  const raw = (env.ADMIN_IDS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => parseInt(s.trim(), 10)).filter(Boolean);
}

// Private Reply Keyboard buttons carry invisible node context. Telegram sends
// back the exact button text, so this lets us deterministically identify the
// intended child without exposing an ID to the user and without adding a D1 read.
// If a user types the visible label manually, no token is present and the legacy
// context-aware text resolver remains available as a fallback.
const REPLY_META_START = "\u2063\u2060";
const REPLY_META_SEP = "\u2063\u2062";
const REPLY_META_END = "\u2063\u2061";
const REPLY_META_ZW = ["\u200b", "\u200c", "\u200d", "\u2060"];

function encodeReplyMetaNumber(value) {
  const digits = String(Math.max(0, Number(value) || 0));
  return digits.split("").map(ch => {
    const n = Number(ch);
    return REPLY_META_ZW[n & 1] + REPLY_META_ZW[(n >> 1) & 1] + REPLY_META_ZW[(n >> 2) & 1] + REPLY_META_ZW[(n >> 3) & 1];
  }).join("");
}

function decodeReplyMetaNumber(encoded) {
  const s = String(encoded || "");
  if (!s || s.length % 4 !== 0) return null;
  const reverse = new Map(REPLY_META_ZW.map((ch, i) => [ch, i]));
  let out = "";
  for (let i = 0; i < s.length; i += 4) {
    const a = reverse.get(s[i]);
    const b = reverse.get(s[i + 1]);
    const c = reverse.get(s[i + 2]);
    const d = reverse.get(s[i + 3]);
    if ([a, b, c, d].some(v => v == null)) return null;
    const n = a | (b << 1) | (c << 2) | (d << 3);
    if (n > 9) return null;
    out += String(n);
  }
  const num = Number(out);
  return Number.isFinite(num) ? num : null;
}

function encodeReplyButtonText(label, parentId, childId, version = 0) {
  return String(label || "").trim() + REPLY_META_START +
    encodeReplyMetaNumber(parentId) + REPLY_META_SEP +
    encodeReplyMetaNumber(childId) + REPLY_META_SEP +
    encodeReplyMetaNumber(version) + REPLY_META_END;
}

function decodeReplyButtonText(rawText) {
  const raw = String(rawText || "");
  const start = raw.lastIndexOf(REPLY_META_START);
  if (start < 0) return { label: raw.trim(), target: null };
  const end = raw.indexOf(REPLY_META_END, start + REPLY_META_START.length);
  if (end < 0) return { label: raw.trim(), target: null };

  const payload = raw.slice(start + REPLY_META_START.length, end);
  const fields = payload.split(REPLY_META_SEP);
  if (fields.length < 2) return { label: raw.slice(0, start).trim(), target: null };

  const parentId = decodeReplyMetaNumber(fields[0]);
  const childId = decodeReplyMetaNumber(fields[1]);
  const version = fields.length >= 3 ? decodeReplyMetaNumber(fields[2]) : null;
  if (!Number.isFinite(parentId) || !Number.isFinite(childId) || parentId <= 0 || childId <= 0) {
    return { label: raw.slice(0, start).trim(), target: null };
  }
  return {
    label: raw.slice(0, start).trim(),
    target: { parentId, childId },
    version: Number.isFinite(version) ? version : null
  };
}

// User Inline Keyboard: Back/Home controls apply to navigation menus only; content messages have no Back/Delete control.
function userInlineKbFromNode(db, node, isDirectChildHint) {
  if (!node) return undefined;
  const directKey = isDirectChildHint === true ? "_kbDirect" : "_kbNormal";
  if (node[directKey] !== undefined) {
    return node[directKey];
  }
  const baseRows = [];
  const cr = node && node.children_rows ? node.children_rows : [];
  for (let i = 0; i < cr.length; i++) {
    const r = cr[i] || [];
    const mapped = [];
    for (let j = 0; j < r.length; j++) {
      const cid = r[j];
      if (isHidden(node, cid)) continue;
      const child = db.nodes && db.nodes[String(cid)];
      if (!child) continue;
      const nm = String(child.name || "").trim();
      if (!nm) continue;
      mapped.push({ text: nm, callback_data: "U|OPEN|" + cid });
    }
    if (mapped.length) baseRows.push(mapped);
  }

  // If node has NO children, return undefined (do NOT create Back/Home only menu)
  if (!baseRows.length) {
    node[directKey] = undefined;
    return undefined;
  }

  const atRoot = Number(node && node.id) === Number(db && db.root_id);

  if (!atRoot) {
    const backData = node && node.id ? ("U|BACK|" + node.id) : "U|BACK";
    if (isDirectChildHint === true) {
      baseRows.push([{ text: "⬅️ " + BACK_LABEL, callback_data: backData }]);
    } else {
      baseRows.push([
        { text: "⬅️ " + BACK_LABEL, callback_data: backData },
        { text: "🏠 " + HOME_LABEL, callback_data: "U|HOME" }
      ]);
    }
  }

  const result = { inline_keyboard: baseRows };
  node[directKey] = result;
  return result;
}

// User Reply Keyboard: Back/Home controls apply to navigation menus only.
function replyKbFromNode(db, node, isDirectChildHint) {
  if (!node) return undefined;
  const directKey = isDirectChildHint === true ? "_rkbV2Direct" : "_rkbV2Normal";
  if (node[directKey] !== undefined) {
    return node[directKey];
  }
  const baseRows = [];
  const cr = node && node.children_rows ? node.children_rows : [];
  for (let i = 0; i < cr.length; i++) {
    const r = cr[i] || [];
    const mapped = [];
    for (let j = 0; j < r.length; j++) {
      const cid = r[j];
      if (isHidden(node, cid)) continue;
      const child = db.nodes && db.nodes[String(cid)];
      if (!child) continue;
      const nm = String(child.name || "").trim();
      if (!nm) continue;
      mapped.push({ text: encodeReplyButtonText(nm, Number(node.id), Number(cid), Number(db && db._v) || 0) });
    }
    if (mapped.length) baseRows.push(mapped);
  }

  // If node has NO children, return undefined (do NOT create Back/Home only menu)
  if (!baseRows.length) {
    node[directKey] = undefined;
    return undefined;
  }

  const atRoot = Number(node && node.id) === Number(db && db.root_id);

  if (!atRoot) {
    if (isDirectChildHint === true) {
      baseRows.push([{ text: BACK_LABEL }]);
    } else {
      baseRows.push([{ text: BACK_LABEL }, { text: HOME_LABEL }]);
    }
  }
  const result = {
    keyboard: atRoot
      ? baseRows.map(row => row.filter(btn => btn && btn.text !== BACK_LABEL && btn.text !== HOME_LABEL)).filter(r => r.length > 0)
      : baseRows,
    resize_keyboard: true,
    one_time_keyboard: false
  };
  node[directKey] = result;
  return result;
}

function mockInlineFromReplyKb(db, node) {
  const rk = replyKbFromNode(db, node);
  const ik = [];
  const rows = (rk && rk.keyboard) ? rk.keyboard : [];
  for (const r of rows) {
    const line = [];
    for (const b of r) {
      if (b && b.text) line.push({ text: b.text, callback_data: "A|NOP" });
    }
    if (line.length) ik.push(line);
  }
  return { inline_keyboard: ik.length ? ik : [[{ text: "— Empty Section —", callback_data: "A|NOP" }]] };
}

// Admin Keyboard Generator with Contextual Action Banners


const __CONTENT_DEFAULT_WELCOME = "Welcome #name_link! 🌹\n\nPlease choose an option from the menu below:";

function __contentJson(v) {
  // Defensive clone: never call JSON.parse(undefined).
  // Undefined session fields are normalized to null instead of crashing admin flows.
  if (v === undefined) return null;
  if (v === null) return null;
  const raw = JSON.stringify(v);
  if (raw === undefined) return null;
  return JSON.parse(raw);
}

function __contentJsonString(v, fallback) {
  try {
    const raw = JSON.stringify(v);
    return raw === undefined ? (fallback !== undefined ? fallback : "null") : raw;
  } catch (_) {
    return fallback !== undefined ? fallback : "null";
  }
}

// --- Authoritative Metadata & Snapshot ---
const CONTENT_META_READ_CACHE_TTL_MS = 5000;
let CONTENT_META_READ_CACHE = null;
function __contentMetaCacheInvalidate() { CONTENT_META_READ_CACHE = null; }

async function __contentMeta(env, options = {}) {
  const fresh = !!options.fresh;
  if (!fresh && CONTENT_META_READ_CACHE && CONTENT_META_READ_CACHE.expiresAt > Date.now()) {
    return CONTENT_META_READ_CACHE.value;
  }
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding (SQL) is missing");
  let row = await db.prepare("SELECT version, root_id, next_id, welcome_text FROM content_meta WHERE id=1").first();
  if (!row) {
    const nowSec = Math.floor(Date.now() / 1000);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO content_meta(id,version,root_id,next_id,welcome_text,updated_at) VALUES(1,1,1,2,?,?)").bind(__CONTENT_DEFAULT_WELCOME, nowSec),
      db.prepare("INSERT OR IGNORE INTO nodes(id,name,version,created_at,updated_at,deleted_at) VALUES(1,'',1,?,?,NULL)").bind(nowSec, nowSec)
    ]);
    row = await db.prepare("SELECT version, root_id, next_id, welcome_text FROM content_meta WHERE id=1").first();
  }
  if (!row) throw new Error("content_meta row is missing");
  const value = {
    version: Number(row.version) || 1,
    root_id: Number(row.root_id) || 1,
    next_id: Number(row.next_id) || 2,
    welcome_text: String(row.welcome_text || __CONTENT_DEFAULT_WELCOME)
  };
  CONTENT_META_READ_CACHE = { value, expiresAt: Date.now() + CONTENT_META_READ_CACHE_TTL_MS };
  return value;
}

// ---------------------------------------------------------------------------
// GLOBAL NODE ID ALLOCATOR
// ---------------------------------------------------------------------------
// Drafts are isolated per admin, so draft-local `next_id` cannot be the source
// of globally unique node IDs.  We keep a tiny authoritative D1 sequence row
// instead.  Allocation is atomic at the SQL row level, while draft `next_id`
// remains only a local/published metadata value. Gaps are expected when an
// admin allocates an ID and later cancels/discards the draft.
async function __allocateContentNodeId(env) {
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding (SQL) is missing");
  await __contentMeta(env);   // guarantees the singleton content_meta row exists

  // ONE atomic UPDATE owns the allocation. content_meta.next_id is the single global allocator;
  // it self-heals against a stale value or a restore that contained higher IDs, and it is never
  // lowered by a Save (the commit writes MAX(next_id, draft.next_id)).
  const row = await db.prepare(`
    UPDATE content_meta
       SET next_id = MAX(next_id, COALESCE((SELECT MAX(id) + 1 FROM nodes), 2), 2) + 1
     WHERE id = 1
    RETURNING next_id - 1 AS node_id
  `).first();

  const nodeId = Number(row && row.node_id);
  if (!Number.isInteger(nodeId) || nodeId < 2) {
    throw new Error("Failed to allocate a valid global node ID");
  }
  return nodeId;
}

async function __contentBootstrapPublishedKvIfD1Empty(env, ctx = null) {
  // BOOTSTRAP-ONLY PATH:
  // - If a valid published snapshot already exists in KV/cache, NEVER rebuild from D1.
  // - If KV is missing, D1 is inspected only to determine whether this is a truly
  //   brand-new empty content database.
  // - Only the brand-new empty state may be reconstructed from D1 and published to KV.
  // - If D1 already contains real content and KV is missing/invalid, return null so
  //   callers fail closed instead of silently rebuilding over the published-cache contract.
  if (globalThis.__CONTENT_BOOTSTRAP_IN_FLIGHT) {
    try { return await globalThis.__CONTENT_BOOTSTRAP_IN_FLIGHT; } catch (_) { return null; }
  }

  globalThis.__CONTENT_BOOTSTRAP_IN_FLIGHT = (async () => {
    const db = env.SQL;
    if (!db || !env || !env.DB || typeof env.DB.get !== "function" || typeof env.DB.put !== "function") {
      return null;
    }

    // Re-check KV first. Another request may have completed bootstrap while this
    // request was waiting for the D1 checks.
    try {
      const raw = await env.DB.get(DB_KEY);
      if (raw) {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        if (contentCacheIntegrity(parsed)) {
          parsed._v = Number(parsed._v) || 0;
          setPublishedRamCache(parsed);
          try { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(edgeDbPut(env, parsed).catch(() => {})); } catch (_) {}
          return parsed;
        }

        // A non-empty/invalid KV key is NOT treated as a first-run state.
        // Do not reconstruct from D1 behind an existing published-cache contract.
        console.error("CONTENT_BOOTSTRAP_KV_INVALID_FAIL_CLOSED", JSON.stringify(contentCacheSummary(parsed)));
        return null;
      }
    } catch (e) {
      console.error("CONTENT_BOOTSTRAP_KV_READ_ERROR:", e && e.message ? e.message : String(e));
      return null;
    }

    // This call is allowed to create the root metadata/node for a brand-new D1.
    const meta = await __contentMeta(env);
    const rootId = Number(meta.root_id) || 1;

    // Determine whether D1 is genuinely empty. Root metadata/root node alone is the
    // expected initial state. Any real child, relationship, item, or custom welcome
    // means content already exists and D1 must NOT be used as a KV replacement.
    const [otherNodes, childLinks, nodeItems, welcomeItems, rootRow] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE deleted_at IS NULL AND id <> ?1").bind(rootId).first(),
      db.prepare("SELECT COUNT(*) AS c FROM node_children").first(),
      db.prepare("SELECT COUNT(*) AS c FROM node_items").first(),
      db.prepare("SELECT COUNT(*) AS c FROM welcome_items").first(),
      db.prepare("SELECT name FROM nodes WHERE id=?1 AND deleted_at IS NULL").bind(rootId).first()
    ]);

    const otherNodeCount = Number(otherNodes && otherNodes.c) || 0;
    const childLinkCount = Number(childLinks && childLinks.c) || 0;
    const nodeItemCount = Number(nodeItems && nodeItems.c) || 0;
    const welcomeItemCount = Number(welcomeItems && welcomeItems.c) || 0;
    const rootName = String((rootRow && rootRow.name) || "").trim();
    const customWelcome = String(meta.welcome_text || __CONTENT_DEFAULT_WELCOME) !== __CONTENT_DEFAULT_WELCOME;

    const d1IsEmpty = (
      otherNodeCount === 0 &&
      childLinkCount === 0 &&
      nodeItemCount === 0 &&
      welcomeItemCount === 0 &&
      !rootName &&
      !customWelcome
    );

    if (!d1IsEmpty) {
      console.error("CONTENT_BOOTSTRAP_BLOCKED_D1_HAS_CONTENT", JSON.stringify({
        other_nodes: otherNodeCount,
        child_links: childLinkCount,
        node_items: nodeItemCount,
        welcome_items: welcomeItemCount,
        root_name: rootName,
        custom_welcome: customWelcome,
        version: Number(meta.version) || 1
      }));
      return null;
    }

    // Brand-new database: build the empty root snapshot once, then publish it to KV.
    const snap = await __contentLoadSnapshotFromD1(env);
    if (!contentCacheIntegrity(snap)) {
      console.error("CONTENT_BOOTSTRAP_SNAPSHOT_INVALID", JSON.stringify(contentCacheSummary(snap)));
      return null;
    }

    snap._v = Number(meta.version) || Number(snap._v) || 1;
    await env.DB.put(DB_KEY, JSON.stringify(snap));
    setPublishedRamCache(snap);
    try {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(edgeDbPut(env, snap).catch(() => {}));
      else await edgeDbPut(env, snap);
    } catch (_) {}

    return snap;
  })();

  try {
    return await globalThis.__CONTENT_BOOTSTRAP_IN_FLIGHT;
  } finally {
    globalThis.__CONTENT_BOOTSTRAP_IN_FLIGHT = null;
  }
}

// The CAS guard column lives on content_meta (it used to be a separate table). Databases created
// before this change are upgraded in place the first time a commit runs.
let CONTENT_GUARD_COLUMN_READY = false;
async function __contentEnsureGuard(env) {
  if (CONTENT_GUARD_COLUMN_READY) return;
  const db = env.SQL;
  if (!db) return;
  try {
    await db.prepare("SELECT guard_ok FROM content_meta LIMIT 1").first();
  } catch (e) {
    if (/no such column/i.test(String(e && e.message))) {
      try { await db.prepare("ALTER TABLE content_meta ADD COLUMN guard_ok INTEGER NOT NULL DEFAULT 1").run(); }
      catch (e2) { if (!/duplicate column/i.test(String(e2 && e2.message))) throw e2; }
    } else { throw e; }
  }
  CONTENT_GUARD_COLUMN_READY = true;
}

// ============================================================================
// Structured search metadata (search_name / search_meta)
//   Stored per PLACEMENT of a file (table node_items, next to `caption`), NOT per Telegram file:
//   the same Telegram file can legitimately live in several folders with different identities
//   (e.g. the same slides under "Lec 1" and "Lec 2", or one exam under two subjects).
//     search_name  TEXT  raw text the admin typed, e.g. "[MA].s [Lec].t [2].n"
//     search_meta  TEXT  normalized JSON, e.g. {"s":"MA","t":"LEC","n":2}
//   Both are OPTIONAL. Files without them behave exactly as before and are simply not part of
//   the structured search. The original file_name / caption are never touched.
//   The columns are added lazily ONLY if they are missing (see migrations/0001_search_meta.sql
//   for the manual way), so the normal request path pays nothing.
// ============================================================================
let SEARCH_COLS_STATE = null;   // null = unknown, true = columns exist, false = could not be created
const __SEARCH_COL_ERR = /no such column|has no column named|search_name|search_meta/i;

async function __ensureSearchColumns(env) {
  if (SEARCH_COLS_STATE === true) return true;
  const db = env && env.SQL;
  if (!db) return false;
  for (const col of ["search_name", "search_meta"]) {
    try { await db.prepare(`ALTER TABLE node_items ADD COLUMN ${col} TEXT`).run(); }
    catch (e) {
      if (!/duplicate column/i.test(String(e && e.message || e))) console.error("SEARCH_COLUMN_ADD_ERROR:", col, String(e && e.message || e).slice(0, 160));
    }
  }
  try {
    await db.prepare("SELECT search_name, search_meta FROM node_items LIMIT 1").first();
    SEARCH_COLS_STATE = true;
    return true;
  } catch (e) {
    SEARCH_COLS_STATE = false;
    console.error("SEARCH_COLUMNS_UNAVAILABLE:", String(e && e.message || e).slice(0, 160));
    return false;
  }
}

// Canonical JSON text for a meta object (stable key order => no phantom diffs).
// Field-agnostic: every field survives; the registry only decides the ORDER and how values normalize.
function __searchMetaJson(meta) {
  return serializeSearchMeta(meta);
}
function __searchMetaParse(text) {
  if (text == null || text === "") return null;
  try { return normalizeSearchMeta(typeof text === "string" ? JSON.parse(text) : text); } catch (_) { return null; }
}
// Only present when set => legacy files stay byte-identical (no spurious "changed" signatures/hashes).
function __searchFieldsOf(f) {
  const out = {};
  if (!f) return out;
  const name = f.search_name != null && String(f.search_name).trim() ? String(f.search_name).trim().slice(0, 200) : null;
  const meta = normalizeSearchMeta(f.search_meta);
  if (name) out.search_name = name;
  if (meta) out.search_meta = meta;
  return out;
}

async function __contentLoadSnapshotFromD1(env) {
  const dbBinding = env.SQL;
  if (!dbBinding) throw new Error("D1 Database binding missing");

  // IMPORTANT: Build the entire content snapshot inside ONE D1 batch.
  // D1 batch() executes the statements as a single SQL transaction, so all
  // SELECTs observe one consistent database state instead of potentially
  // mixing results from different moments during a concurrent Save/Restore.
  // This keeps backups, restores, force-saves, bootstrap, and self-healing
  // snapshots internally consistent without changing the schema or write flow.
  const snapshotStatements = (withSearch) => [
    dbBinding.prepare("SELECT version, root_id, next_id, welcome_text FROM content_meta WHERE id=1"),
    dbBinding.prepare("SELECT id, name FROM nodes WHERE deleted_at IS NULL ORDER BY id"),
    dbBinding.prepare("SELECT parent_id, child_id, row_index, position, hidden FROM node_children ORDER BY parent_id, row_index, position"),
    dbBinding.prepare("SELECT id, telegram_file_id, type, file_name, file_size FROM telegram_files ORDER BY id"),
    dbBinding.prepare(withSearch
      ? "SELECT node_id, position, item_type, file_id, text_content, url, caption, search_name, search_meta FROM node_items ORDER BY node_id, position, id"
      : "SELECT node_id, position, item_type, file_id, text_content, url, caption FROM node_items ORDER BY node_id, position, id"),
    dbBinding.prepare("SELECT position, item_type, file_id, text_content, url, caption FROM welcome_items ORDER BY position, id")
  ];
  let batchResults;
  try {
    batchResults = await dbBinding.batch(snapshotStatements(SEARCH_COLS_STATE !== false));
  } catch (e) {
    // First run after deploy on a database that has no search columns yet: add them, retry once.
    // If they cannot be added, fall back to the legacy query so the bot never goes down.
    if (SEARCH_COLS_STATE === false || !__SEARCH_COL_ERR.test(String(e && e.message || e))) throw e;
    const ok = await __ensureSearchColumns(env);
    batchResults = await dbBinding.batch(snapshotStatements(ok));
  }

  const meta = (batchResults[0] && batchResults[0].results && batchResults[0].results[0]) || null;
  const nodesRes = batchResults[1] || { results: [] };
  const childrenRes = batchResults[2] || { results: [] };
  const filesRes = batchResults[3] || { results: [] };
  const itemsRes = batchResults[4] || { results: [] };
  const welcomeRes = batchResults[5] || { results: [] };

  if (!meta) throw new Error("content_meta row is missing");

  const db = {
    next_id: Number(meta.next_id) || 2,
    root_id: Number(meta.root_id) || 1,
    nodes: {},
    settings: {
      welcome: String(meta.welcome_text || __CONTENT_DEFAULT_WELCOME),
      welcome_obj: { notes: [], urls: [], files: [], display: [] }
    },
    _v: Number(meta.version) || 1
  };

  const nodeRows = (nodesRes && nodesRes.results) || [];
  for (const r of nodeRows) {
    db.nodes[String(r.id)] = emptyNode(Number(r.id), String(r.name || ""));
  }

  const childRows = (childrenRes && childrenRes.results) || [];
  for (const r of childRows) {
    const parent = db.nodes[String(r.parent_id)];
    if (!parent) continue;
    if (!Array.isArray(parent.children_rows)) parent.children_rows = [];
    const rowIndex = Math.max(0, Number(r.row_index) || 0);
    while (parent.children_rows.length <= rowIndex) parent.children_rows.push([]);
    parent.children_rows[rowIndex][Math.max(0, Number(r.position) || 0)] = Number(r.child_id);
    parent.children_hidden = Array.isArray(parent.children_hidden) ? parent.children_hidden : [];
    if (Number(r.hidden) === 1 && parent.children_hidden.indexOf(Number(r.child_id)) === -1) {
      parent.children_hidden.push(Number(r.child_id));
    }
  }

  // Filter out any holes in children_rows
  for (const n of Object.values(db.nodes)) {
    if (Array.isArray(n.children_rows)) {
      n.children_rows = n.children_rows.map(r => Array.isArray(r) ? r.filter(Boolean) : []).filter(r => r.length > 0);
    }
  }

  const fileMap = new Map();
  const fileRows = (filesRes && filesRes.results) || [];
  for (const f of fileRows) {
    fileMap.set(Number(f.id), {
      id: String(f.telegram_file_id),
      type: String(f.type || "document"),
      file_name: f.file_name != null ? String(f.file_name) : null,
      file_size: f.file_size != null ? Number(f.file_size) : null
    });
  }

  const nodeItemRows = (itemsRes && itemsRes.results) || [];
  for (const it of nodeItemRows) {
    const node = db.nodes[String(it.node_id)];
    if (!node) continue;
    ensureDisplay(node);
    if (it.item_type === "note" && it.text_content != null) {
      node.notes.push(String(it.text_content));
      node.display.push("N:" + (node.notes.length - 1));
    } else if (it.item_type === "url" && it.url != null) {
      node.urls.push(String(it.url));
      node.display.push("U:" + (node.urls.length - 1));
    } else if (it.item_type === "file" && it.file_id != null) {
      const f = fileMap.get(Number(it.file_id));
      if (f) {
        node.files.push({
          id: f.id,
          type: f.type,
          file_name: f.file_name != null ? f.file_name : null,
          file_size: f.file_size != null ? f.file_size : null,
          caption: it.caption ? String(it.caption) : null,
          ...__searchFieldsOf({ search_name: it.search_name, search_meta: __searchMetaParse(it.search_meta) })
        });
        node.display.push("F:" + (node.files.length - 1));
      }
    }
  }

  const wObj = db.settings.welcome_obj;
  const wItemRows = (welcomeRes && welcomeRes.results) || [];
  for (const it of wItemRows) {
    if (it.item_type === "note" && it.text_content != null) {
      wObj.notes.push(String(it.text_content));
      wObj.display.push("N:" + (wObj.notes.length - 1));
    } else if (it.item_type === "url" && it.url != null) {
      wObj.urls.push(String(it.url));
      wObj.display.push("U:" + (wObj.urls.length - 1));
    } else if (it.item_type === "file" && it.file_id != null) {
      const f = fileMap.get(Number(it.file_id));
      if (f) {
        wObj.files.push({
          id: f.id,
          type: f.type,
          file_name: f.file_name != null ? f.file_name : null,
          file_size: f.file_size != null ? f.file_size : null,
          caption: it.caption ? String(it.caption) : null
        });
        wObj.display.push("F:" + (wObj.files.length - 1));
      }
    }
  }

  return db;
}

// --- Session & Draft Persistence (content_sessions) ---
// Older deployments may already have content_sessions without base_json.
// The CREATE TABLE IF NOT EXISTS migration cannot add a missing column, so
// repair that one legacy column lazily before session reads/writes.
let CONTENT_SESSION_SCHEMA_READY = false;
let CONTENT_SESSION_SCHEMA_IN_FLIGHT = null;

// Cross-isolate durable locking. The old Map mutex only protected requests that
// happened to land in the same Worker isolate. D1 is the shared coordination
// point, so admin/content locks live in D1 with a short lease and an owner token.
let ADMIN_LOCK_SCHEMA_READY = false;
let ADMIN_LOCK_SCHEMA_IN_FLIGHT = null;
const ADMIN_LOCK_WAIT_MS = 8000;
const ADMIN_LOCK_LEASE_SEC = 120;

async function __ensureAdminLockSchema(env) {
  if (env && env.SCHEMA_MANAGED === "1") ADMIN_LOCK_SCHEMA_READY = true;
  if (ADMIN_LOCK_SCHEMA_READY) return true;
  if (ADMIN_LOCK_SCHEMA_IN_FLIGHT) return await ADMIN_LOCK_SCHEMA_IN_FLIGHT;

  ADMIN_LOCK_SCHEMA_IN_FLIGHT = (async () => {
    const db = env.SQL;
    if (!db) return false;
    try {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS admin_operation_locks (
          lock_key TEXT PRIMARY KEY,
          lock_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT
      `).run();
      ADMIN_LOCK_SCHEMA_READY = true;
      return true;
    } catch (e) {
      console.error("ADMIN_LOCK_SCHEMA_ERROR:", e && e.message ? e.message : String(e));
      return false;
    } finally {
      ADMIN_LOCK_SCHEMA_IN_FLIGHT = null;
    }
  })();

  return await ADMIN_LOCK_SCHEMA_IN_FLIGHT;
}

function __adminLockToken() {
  try { return crypto.randomUUID(); } catch (_) {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

function __sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function __acquireDistributedLock(env, lockKey, waitMs = ADMIN_LOCK_WAIT_MS, leaseSec = ADMIN_LOCK_LEASE_SEC) {
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding missing");
  if (!await __ensureAdminLockSchema(env)) throw new Error("ADMIN_LOCK_SCHEMA_UNAVAILABLE");

  const key = String(lockKey);
  const token = __adminLockToken();
  const started = Date.now();
  let backoffMs = 200;
  let firstAttempt = true;

  // Free-plan optimization: only issue a D1 write when the lock appears to be
  // available. While another holder owns the lease, use cheap point reads with
  // exponential backoff instead of hammering the same row with UPDATE attempts.
  // The first attempt remains write-based so an absent lock can be acquired
  // atomically without a read-then-write race.
  while (true) {
    const nowSec = Math.floor(Date.now() / 1000);
    let shouldAttemptWrite = firstAttempt;

    if (!firstAttempt) {
      try {
        const current = await db.prepare(
          "SELECT expires_at FROM admin_operation_locks WHERE lock_key=?1 LIMIT 1"
        ).bind(key).first();
        shouldAttemptWrite = !current || Number(current.expires_at || 0) <= nowSec;
      } catch (e) {
        // If the cheap probe fails, fall back to the atomic acquisition attempt
        // rather than falsely declaring the lock unavailable.
        shouldAttemptWrite = true;
      }
    }

    if (shouldAttemptWrite) {
      const expiresAt = nowSec + Math.max(10, Number(leaseSec) || ADMIN_LOCK_LEASE_SEC);
      try {
        const res = await db.prepare(`
          INSERT INTO admin_operation_locks(lock_key, lock_token, expires_at)
          VALUES (?1, ?2, ?3)
          ON CONFLICT(lock_key) DO UPDATE SET
            lock_token=excluded.lock_token,
            expires_at=excluded.expires_at
          WHERE admin_operation_locks.expires_at <= ?4
        `).bind(key, token, expiresAt, nowSec).run();

        const changes = Number(res && res.meta && res.meta.changes || 0);
        if (changes === 1) return { key, token, expiresAt };
      } catch (e) {
        console.error("ADMIN_LOCK_ACQUIRE_ERROR:", JSON.stringify({
          lock_key: key,
          error: e && e.message ? e.message : String(e)
        }));
        throw e;
      }
    }

    firstAttempt = false;
    if (Date.now() - started >= waitMs) {
      const err = new Error("ADMIN_OPERATION_BUSY");
      err.lockKey = key;
      throw err;
    }

    const remaining = Math.max(1, waitMs - (Date.now() - started));
    const jitter = Math.floor(Math.random() * Math.max(25, Math.min(120, backoffMs * 0.15)));
    await __sleepMs(Math.min(remaining, backoffMs + jitter));
    backoffMs = Math.min(800, backoffMs * 2);
  }
}

async function __releaseDistributedLock(env, lock) {
  if (!lock || !env.SQL) return;
  try {
    await env.SQL.prepare(`
      DELETE FROM admin_operation_locks
      WHERE lock_key=?1 AND lock_token=?2
    `).bind(lock.key, lock.token).run();
  } catch (e) {
    console.error("ADMIN_LOCK_RELEASE_ERROR:", JSON.stringify({
      lock_key: lock.key,
      error: e && e.message ? e.message : String(e)
    }));
  }
}

async function __withDistributedLock(env, lockKey, fn, options = {}) {
  const lock = await __acquireDistributedLock(
    env,
    lockKey,
    Number(options.waitMs) || ADMIN_LOCK_WAIT_MS,
    Number(options.leaseSec) || ADMIN_LOCK_LEASE_SEC
  );
  try {
    return await fn();
  } finally {
    await __releaseDistributedLock(env, lock);
  }
}

async function __withContentMutationLock(env, fn) {
  return await __withDistributedLock(env, "content:global", fn, { waitMs: 15000, leaseSec: 180 });
}

async function __ensureContentSessionSchema(env) {
  if (env && env.SCHEMA_MANAGED === "1") CONTENT_SESSION_SCHEMA_READY = true;
  if (CONTENT_SESSION_SCHEMA_READY) return true;
  if (CONTENT_SESSION_SCHEMA_IN_FLIGHT) return await CONTENT_SESSION_SCHEMA_IN_FLIGHT;

  CONTENT_SESSION_SCHEMA_IN_FLIGHT = (async () => {
    const db = env.SQL;
    if (!db) return false;
    try {
      const row = await db.prepare(
        "SELECT 1 AS ok FROM pragma_table_info('content_sessions') WHERE name='base_json' LIMIT 1"
      ).first();
      if (!row) {
        await db.prepare("ALTER TABLE content_sessions ADD COLUMN base_json TEXT").run();
      }
      CONTENT_SESSION_SCHEMA_READY = true;
      return true;
    } catch (e) {
      // Another isolate/admin may have added it concurrently. Verify once more.
      try {
        const row2 = await db.prepare(
          "SELECT 1 AS ok FROM pragma_table_info('content_sessions') WHERE name='base_json' LIMIT 1"
        ).first();
        CONTENT_SESSION_SCHEMA_READY = !!row2;
        return !!row2;
      } catch (_) {
        return false;
      }
    } finally {
      CONTENT_SESSION_SCHEMA_IN_FLIGHT = null;
    }
  })();

  return await CONTENT_SESSION_SCHEMA_IN_FLIGHT;
}

const CONTENT_SESSION_READ_CACHE_TTL_MS = 1000;
const CONTENT_SESSION_READ_CACHE = new Map();
function __contentSessionCacheSet(adminId, session) {
  const key = String(Number(adminId) || 0);
  if (!session) { CONTENT_SESSION_READ_CACHE.delete(key); return; }
  CONTENT_SESSION_READ_CACHE.set(key, { value: session, expiresAt: Date.now() + CONTENT_SESSION_READ_CACHE_TTL_MS });
}
function __contentSessionCacheInvalidate(adminId) {
  CONTENT_SESSION_READ_CACHE.delete(String(Number(adminId) || 0));
}

async function __contentSessionRawGet(env, admin_id) {
  // ADMIN SESSION SOURCE OF TRUTH: D1.
  // The previous RAM + Cache API session could become stale when Telegram requests
  // hit different Worker isolates / PoPs. That caused missing buttons, lost pending
  // state, and old drafts to reappear. RAM remains only as an optional local hot copy;
  // this function intentionally reads the durable row every time.
  const db = env.SQL;
  if (!db) return null;

  try {
    await __ensureContentSessionSchema(env);
    const row = await db.prepare(`
      SELECT admin_id, base_version, base_json, draft_json, draft_active,
             state_json, revision, updated_at
      FROM content_sessions
      WHERE admin_id=?1
      LIMIT 1
    `).bind(Number(admin_id)).first();

    if (!row) return null;

    // base_json is a legacy column kept for backward-compatible schema upgrades.
    // The current draft model does not read or write a full base snapshot.
    let base = null;
    let draft = null;
    let state = {};

    try {
      if (Number(row.draft_active) === 1 && row.draft_json !== null && row.draft_json !== undefined && String(row.draft_json) !== "") {
        draft = JSON.parse(String(row.draft_json));
      }
    } catch (e) {
      console.error("ADMIN_SESSION_DRAFT_JSON_INVALID:", e && e.message ? e.message : String(e));
      draft = null;
    }

    try {
      if (row.state_json !== null && row.state_json !== undefined && String(row.state_json) !== "") {
        const parsedState = JSON.parse(String(row.state_json));
        state = parsedState && typeof parsedState === "object" ? parsedState : {};
      }
    } catch (e) {
      console.error("ADMIN_SESSION_STATE_JSON_INVALID:", e && e.message ? e.message : String(e));
      state = {};
    }

    return {
      admin_id: Number(row.admin_id) || Number(admin_id) || 0,
      base_version: Number(row.base_version) || 1,
      base,
      draft,
      draft_active: Number(row.draft_active) === 1 && !!draft,
      state,
      revision: Number(row.revision) || 1,
      updated_at: Number(row.updated_at) || 0
    };
  } catch (e) {
    console.error("ADMIN_SESSION_D1_READ_ERROR:", e && e.message ? e.message : String(e));
    return null;
  }
}

async function __adminSessionRead(env, admin_id) {
  return await __contentSessionRawGet(env, admin_id);
}

async function __contentSessionStatePut(env, admin_id, state, options = {}) {
  const db = env.SQL;
  if (!db) return { ok: false, revision: 0 };

  await __ensureContentSessionSchema(env);
  const aid = Number(admin_id) || 0;
  const payloadState = (state && typeof state === "object") ? state : {};
  const nowSec = Math.floor(Date.now() / 1000);
  const stateJson = __contentJsonString(payloadState, "{}");
  __contentSessionCacheInvalidate(aid);

  try {
    const existing = options.existingSession || await __contentSessionRawGet(env, aid);
    if (!existing) {
      const versionRow = await db.prepare("SELECT version FROM content_meta WHERE id=1").first().catch(() => null);
      const baseVersion = Number(versionRow && versionRow.version) || 1;
      await db.prepare(`
        INSERT INTO content_sessions
          (admin_id, base_version, base_json, draft_json, draft_active, state_json, revision, updated_at)
        VALUES (?1, ?2, NULL, '{}', 0, ?3, 1, ?4)
      `).bind(aid, baseVersion, stateJson, nowSec).run();
      __contentSessionCacheInvalidate(aid);
      return { ok: true, revision: 1 };
    }

    const oldRevision = Number(existing.revision) || 1;
    const result = await db.prepare(`
      UPDATE content_sessions
      SET state_json=?2, revision=revision+1, updated_at=?3
      WHERE admin_id=?1 AND revision=?4
    `).bind(aid, stateJson, nowSec, oldRevision).run();

    if (!result || Number(result.meta && result.meta.changes || 0) !== 1) {
      // One safe retry using the latest durable row. This prevents a stale isolate
      // from silently replacing a newer admin state.
      const latest = await __contentSessionRawGet(env, aid);
      if (!latest) return { ok: false, revision: 0, concurrent: true };
      const retryRev = Number(latest.revision) || 1;
      // Apply ONLY the keys this caller actually changed (relative to what it read) on top of
      // the latest durable state, so a stale writer can never clobber someone else's keys.
      const seen = (existing && existing.state && typeof existing.state === "object") ? existing.state : {};
      const merged = { ...(latest.state || {}) };
      for (const k of new Set([...Object.keys(seen), ...Object.keys(payloadState)])) {
        const before = JSON.stringify(seen[k]), after = JSON.stringify(payloadState[k]);
        if (before === after) continue;
        if (payloadState[k] === undefined) delete merged[k]; else merged[k] = payloadState[k];
      }
      const retry = await db.prepare(`
        UPDATE content_sessions
        SET state_json=?2, revision=revision+1, updated_at=?3
        WHERE admin_id=?1 AND revision=?4
      `).bind(aid, __contentJsonString(merged, "{}"), nowSec, retryRev).run();
      if (!retry || Number(retry.meta && retry.meta.changes || 0) !== 1) {
        return { ok: false, revision: retryRev, concurrent: true };
      }
      __contentSessionCacheInvalidate(aid);
      return { ok: true, revision: retryRev + 1, concurrent: true };
    }

    __contentSessionCacheInvalidate(aid);
    return { ok: true, revision: oldRevision + 1 };
  } catch (e) {
    console.error("ADMIN_SESSION_D1_STATE_WRITE_ERROR:", e && e.message ? e.message : String(e));
    throw e;
  }
}

async function __contentSessionGet(env, admin_id) {
  const key = String(Number(admin_id) || 0);
  const hit = CONTENT_SESSION_READ_CACHE.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) CONTENT_SESSION_READ_CACHE.delete(key);
  const value = await __adminSessionRead(env, admin_id);
  if (value) __contentSessionCacheSet(admin_id, value);
  return value;
}

async function __contentSessionPut(env, admin_id, base_version, draft, baseDb = null, options = {}) {
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding missing");

  await __ensureContentSessionSchema(env);
  const aid = Number(admin_id) || 0;
  const existing = options.existingSession || await __contentSessionRawGet(env, aid);
  const nowSec = Math.floor(Date.now() / 1000);

  if (draft === undefined || draft === null) {
    throw new Error("ADMIN_SESSION_DRAFT_MISSING");
  }

  const state = options.state !== undefined
    ? ((options.state && typeof options.state === "object") ? options.state : {})
    : ((existing && existing.state && typeof existing.state === "object") ? existing.state : {});

  // Simplified draft model:
  // - D1 stores only the durable draft + its starting published version + UI state.
  // - The legacy base_json column remains NULL. The active draft is stored only
  //   in draft_json/state_json to avoid duplicating the published snapshot.
  const active = options.forceActive === false ? false : true;
  const draftJson = active ? __contentJsonString(draft, "{}") : "{}";
  const stateJson = __contentJsonString(state, "{}");
  const bv = Number(base_version)
    || Number(existing && existing.base_version)
    || Number(draft && draft._v)
    || 1;
  __contentSessionCacheInvalidate(aid);

  try {
    if (!existing) {
      await db.prepare(`
        INSERT INTO content_sessions
          (admin_id, base_version, base_json, draft_json, draft_active, state_json, revision, updated_at)
        VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1, ?6)
      `).bind(aid, bv, draftJson, active ? 1 : 0, stateJson, nowSec).run();
      __contentSessionCacheInvalidate(aid);
      return { ok: true, revision: 1 };
    }

    const expectedRevision = Number(existing.revision) || 1;
    const result = await db.prepare(`
      UPDATE content_sessions
      SET base_version=?2,
          base_json=NULL,
          draft_json=?3,
          draft_active=?4,
          state_json=?5,
          revision=revision+1,
          updated_at=?6
      WHERE admin_id=?1 AND revision=?7
    `).bind(aid, bv, draftJson, active ? 1 : 0, stateJson, nowSec, expectedRevision).run();

    if (!result || Number(result.meta && result.meta.changes || 0) !== 1) {
      throw new Error("ADMIN_SESSION_CONCURRENT_UPDATE");
    }

    __contentSessionCacheInvalidate(aid);
    return { ok: true, revision: expectedRevision + 1 };
  } catch (e) {
    console.error("ADMIN_SESSION_D1_WRITE_ERROR:", e && e.message ? e.message : String(e));
    throw e;
  }
}

function __contentClearContentPending(state) {
  const out = { ...(state || {}) };
  delete out.pending;
  return out;
}

async function __contentSessionClear(env, admin_id, expectedRevision = null) {
  const db = env.SQL;
  if (!db) return { ok: false, cleared: false };

  await __ensureContentSessionSchema(env);
  const aid = Number(admin_id) || 0;

  try {
    __contentSessionCacheInvalidate(aid);
    if (expectedRevision != null) {
      const result = await db.prepare(`
        DELETE FROM content_sessions
        WHERE admin_id=?1 AND revision=?2
      `).bind(aid, Number(expectedRevision)).run();

      const changes = Number(result && result.meta && result.meta.changes || 0);
      if (changes === 0) {
        const current = await __contentSessionRawGet(env, aid);
        return { ok: false, cleared: false, concurrent: !!current };
      }
    } else {
      await db.prepare("DELETE FROM content_sessions WHERE admin_id=?1").bind(aid).run();
    }

    return { ok: true, cleared: true, concurrent: false };
  } catch (e) {
    console.error("ADMIN_SESSION_D1_DELETE_ERROR:", e && e.message ? e.message : String(e));
    return { ok: false, cleared: false, concurrent: false, error: String(e && e.message || e) };
  }
}

// --- Admin Draft Retrievals (never auto-purge stale drafts) ---

async function __contentGetAdminViewDb(env, admin_id) {
  // Read-only admin views use the published cache first. Full D1 nodes/items
  // reconstruction is retained only as a fail-safe when the published cache is unavailable.
  let live = null;
  try {
    live = await loadUserContentCacheOnly(env, null, null);
    if (live) {
      // Verify the published cache version once for the admin view. This is a
      // single-row metadata read instead of rebuilding nodes/items from D1.
      const meta = await __contentMeta(env, { fresh: true });
      if (Number(meta.version) !== Number(live._v || 0)) live = null;
    }
  } catch (_) {
    live = null;
  }

  if (!live) {
    try {
      live = await __contentLoadSnapshotFromD1(env);
      if (live) setPublishedRamCache(live);
    } catch (e) {
      console.error("ADMIN_AUTHORITATIVE_VIEW_FALLBACK_ERROR:", e && e.message ? e.message : String(e));
    }
  }

  if (!live) return null;

  const session = await __contentSessionGet(env, admin_id);
  if (session && session.draft_active && session.draft) {
    if (Number(session.base_version) !== Number(live._v || 0)) {
      session.draft._stale = true;
      session.isStale = true;
    }
    return { db: session.draft, session };
  }
  return { db: live, session };
}

async function __contentSafeAdminPath(env, admin_id, db) {
  const rootId = Number(db && db.root_id) || 1;
  const key = String(adminPathId(admin_id));

  // MEM.paths is only the hot cache. A cold isolate must reconstruct the
  // durable admin path from D1 instead of silently treating the admin as being
  // at root. d1GetPath also repopulates MEM.paths after the read.
  let path = await d1GetPath(env, key, rootId, null);
  if (!Array.isArray(path) || !path.length || Number(path[0]) !== rootId) {
    path = [rootId];
  }

  const valid = [rootId];
  for (let i = 1; i < path.length; i++) {
    const id = Number(path[i]);
    const parentId = Number(valid[valid.length - 1]);
    const parent = db.nodes && db.nodes[String(parentId)];
    const child = db.nodes && db.nodes[String(id)];
    if (!parent || !child) break;
    const rows = Array.isArray(parent.children_rows) ? parent.children_rows : [];
    const isRealChild = rows.some(row => Array.isArray(row) && row.some(cid => Number(cid) === id));
    if (!isRealChild) break;
    valid.push(id);
  }

  if (valid.length !== path.length) {
    try { cachePut(MEM.paths, key, valid); } catch (_) {}
    // Keep D1 aligned with the validated navigation path.
    try { void d1SetPath(env, key, valid, null, null); } catch (_) {}
  }
  return valid;
}

async function __contentGetWorkingDraft(env, admin_id, options = {}) {
  const fresh = !!options.fresh;
  const existing = fresh ? await __contentSessionRawGet(env, admin_id) : await __contentSessionGet(env, admin_id);

  // Once a durable draft exists, do not reconstruct the entire live tree on every
  // admin click. Only the authoritative content version is needed to detect staleness.
  if (existing && existing.draft_active && existing.draft) {
    let liveVersion = Number(existing.base_version) || 1;
    try {
      const meta = await __contentMeta(env, { fresh });
      liveVersion = Number(meta && meta.version) || liveVersion;
    } catch (e) {
      console.error("ADMIN_WORKING_DRAFT_VERSION_READ_ERROR:", e && e.message ? e.message : String(e));
    }
    return {
      db: existing.draft,
      base_version: Number(existing.base_version) || liveVersion,
      base_db: null,
      existing: true,
      stale: Number(existing.base_version) !== liveVersion,
      session: existing
    };
  }

  // No draft yet. Read-only views can use the published cache directly; a
  // mutating operation (fresh=true) still takes the authoritative D1 snapshot.
  let live = null;
  try {
    if (!fresh) {
      live = await loadUserContentCacheOnly(env, null, null);
    }
    if (!live) {
      await __contentMeta(env, { fresh });
      live = await __contentLoadSnapshotFromD1(env);
      if (live && !fresh) setPublishedRamCache(live);
    }
  } catch (e) {
    console.error("ADMIN_WORKING_DRAFT_LIVE_READ_ERROR:", e && e.message ? e.message : String(e));
  }
  if (!live) throw new Error("PUBLISHED_CONTENT_D1_UNAVAILABLE");
  const liveVersion = Number(live._v) || 1;

  // A mutating operation (fresh=true) always works on a PRIVATE D1-built object.
  // Record per-node fingerprints of what this draft started from, so Save can do a
  // real per-node 3-way merge instead of overwriting whatever another admin published.
  if (fresh) {
    live.__draft_meta = {
      ...(live.__draft_meta && typeof live.__draft_meta === "object" ? live.__draft_meta : {}),
      base_hashes: __computeBaseHashes(live)
    };
  }

  return {
    db: live,
    base_version: liveVersion,
    base_db: live,
    existing: false,
    stale: false,
    session: existing || null
  };
}

async function __contentHasDraft(env, admin_id) {
  const s = await __contentSessionRawGet(env, admin_id);
  return !!(s && s.draft_active && s.draft);
}

// --- D1 Serialization & Diff Utilities ---

function __contentNodeSig(node) {
  if (!node) return "";
  ensureDisplay(node);
  return JSON.stringify({
    name: String(node.name || ""),
    display: node.display || [],
    notes: node.notes || [],
    urls: node.urls || [],
    files: (node.files || []).map(f => ({
      id: String(f.id),
      type: String(f.type || "document"),
      file_name: f.file_name != null ? String(f.file_name) : null,
      file_size: f.file_size != null ? Number(f.file_size) : null,
      caption: f.caption ? String(f.caption) : null,
      ...__searchFieldsOf(f)
    }))
  });
}

function __contentWelcomeSig(db) {
  const w = ensureWelcomeObj(db);
  return JSON.stringify({
    text: getWelcome(db),
    display: w.display || [],
    notes: w.notes || [],
    urls: w.urls || [],
    files: (w.files || []).map(f => ({
      id: String(f.id),
      type: String(f.type || "document"),
      file_name: f.file_name != null ? String(f.file_name) : null,
      file_size: f.file_size != null ? Number(f.file_size) : null,
      caption: f.caption ? String(f.caption) : null,
      ...__searchFieldsOf(f)
    }))
  });
}

function __contentCollectFiles(db) {
  const out = [];
  const seen = new Set();
  const pushFile = (f) => {
    if (!f || !f.id) return;
    const sid = String(f.id);
    const nextType = String(f.type || "document");
    const nextName = f.file_name != null ? String(f.file_name) : null;
    const nextSize = f.file_size != null && Number.isFinite(Number(f.file_size)) ? Number(f.file_size) : null;
    const nextCaption = f.caption ? String(f.caption) : null;

    if (seen.has(sid)) {
      const existing = out.find(x => x.id === sid);
      if (existing) {
        if (!existing.file_name && nextName) existing.file_name = nextName;
        if (existing.file_size == null && nextSize != null) existing.file_size = nextSize;
        if (!existing.caption && nextCaption) existing.caption = nextCaption;
        if (!existing.type && nextType) existing.type = nextType;
      }
      return;
    }

    seen.add(sid);
    out.push({
      id: sid,
      type: nextType,
      file_name: nextName,
      file_size: nextSize,
      caption: nextCaption
    });
  };
  for (const n of Object.values((db && db.nodes) || {})) {
    if (!n || !Array.isArray(n.files)) continue;
    for (const f of n.files) pushFile(f);
  }
  const w = db && db.settings && db.settings.welcome_obj;
  if (w && Array.isArray(w.files)) {
    for (const f of w.files) pushFile(f);
  }
  return out;
}

function __contentItemsFromNode(node) {
  if (!node) return [];
  ensureDisplay(node);
  const items = [];
  for (let i = 0; i < node.display.length; i++) {
    const tag = String(node.display[i]);
    const [k, s] = tag.split(":");
    const ix = parseInt(s || "0", 10);
    if (k === "N" && node.notes && node.notes[ix] != null) {
      items.push({ position: i, item_type: "note", text_content: String(node.notes[ix]), file_id: null, url: null, caption: null });
    } else if (k === "U" && node.urls && node.urls[ix] != null) {
      items.push({ position: i, item_type: "url", url: String(node.urls[ix]), file_id: null, text_content: null, caption: null });
    } else if (k === "F" && node.files && node.files[ix] != null) {
      const f = node.files[ix];
      const sf = __searchFieldsOf(f);
      items.push({
        position: i,
        item_type: "file",
        file_telegram_id: String(f.id),
        file_type: String(f.type || "document"),
        file_name: f.file_name != null ? String(f.file_name) : null,
        file_size: f.file_size != null ? Number(f.file_size) : null,
        caption: f.caption ? String(f.caption) : null,
        ...(sf.search_meta ? { search_name: sf.search_name || null, search_meta: __searchMetaJson(sf.search_meta) } : {})
      });
    }
  }
  return items;
}

function __contentNormalizeIds(db) {
  const out = __contentJson(db || {});
  out.next_id = Number(out.next_id) || 2;
  out.root_id = Number(out.root_id) || 1;
  out.nodes = out.nodes || {};
  for (const [id, node] of Object.entries(out.nodes)) {
    if (!node) continue;
    node.id = Number(node.id || id);
    if (Array.isArray(node.children_rows)) {
      node.children_rows = node.children_rows.map(r => Array.isArray(r) ? r.map(Number).filter(Boolean) : []).filter(r => r.length > 0);
    }
    if (Array.isArray(node.children_hidden)) {
      node.children_hidden = node.children_hidden.map(Number).filter(Boolean);
    }
    ensureDisplay(node);
  }
  return out;
}

function __contentNodeInsertStatementRows(node, batch, db) {
  const nowSec = Math.floor(Date.now() / 1000);
  batch.push({
    sql: "INSERT INTO nodes(id,name,version,created_at,updated_at,deleted_at) VALUES (?,?,1,?,?,NULL)",
    args: [Number(node.id), String(node.name || ""), nowSec, nowSec]
  });
}

function __contentBuildItemInsertStatements(table, nodeId, items, batch) {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const it of items) {
    if (it.item_type === "file" && table === "node_items" && it.search_meta) {
      // File placement that carries structured search metadata (the legacy statement below is
      // used for every other file, so databases without the columns are never touched).
      batch.push({
        sql: `INSERT INTO node_items(node_id, position, item_type, file_id, text_content, url, caption, created_at, updated_at, search_name, search_meta)
              SELECT ?1, ?2, 'file', id, NULL, NULL, ?3, ?4, ?4, ?6, ?7 FROM telegram_files WHERE telegram_file_id=?5 LIMIT 1`,
        args: [Number(nodeId), Number(it.position), it.caption || null, nowSec, String(it.file_telegram_id), it.search_name || null, it.search_meta]
      });
    } else if (it.item_type === "file") {
      batch.push({
        sql: `INSERT INTO ${table}(node_id, position, item_type, file_id, text_content, url, caption, created_at, updated_at)
              SELECT ?1, ?2, 'file', id, NULL, NULL, ?3, ?4, ?4 FROM telegram_files WHERE telegram_file_id=?5 LIMIT 1`,
        args: [Number(nodeId), Number(it.position), it.caption || null, nowSec, String(it.file_telegram_id)]
      });
    } else {
      batch.push({
        sql: `INSERT INTO ${table}(node_id, position, item_type, file_id, text_content, url, caption, created_at, updated_at)
              VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8)`,
        args: [Number(nodeId), Number(it.position), it.item_type, it.text_content || null, it.url || null, it.caption || null, nowSec, nowSec]
      });
    }
  }
}

function __contentBuildWelcomeInsertStatements(items, batch) {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const it of items) {
    if (it.item_type === "file") {
      batch.push({
        sql: `INSERT INTO welcome_items(position, item_type, file_id, text_content, url, caption, created_at, updated_at)
              SELECT ?1, 'file', id, NULL, NULL, ?2, ?3, ?3 FROM telegram_files WHERE telegram_file_id=?4 LIMIT 1`,
        args: [Number(it.position), it.caption || null, nowSec, String(it.file_telegram_id)]
      });
    } else {
      batch.push({
        sql: `INSERT INTO welcome_items(position, item_type, file_id, text_content, url, caption, created_at, updated_at)
              VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)`,
        args: [Number(it.position), it.item_type, it.text_content || null, it.url || null, it.caption || null, nowSec, nowSec]
      });
    }
  }
}

// --- Draft comparison helpers ---
// An admin draft is anchored to the published version it started from. Save
// commits only when that version is still live; otherwise the draft is preserved.

function __contentDeepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function __contentMaxNodeId(db) {
  let m = 1;
  for (const k of Object.keys((db && db.nodes) || {})) {
    const n = Number(k);
    if (Number.isInteger(n) && n > m) m = n;
  }
  return m;
}

// Draft-only mutation metadata. This stays inside the durable draft JSON and
// is never published to D1/KV as part of the live content snapshot.
// Deletions are EXPLICIT: a missing node in the draft is not, by itself, a
// deletion request.
function __contentDraftDeletedNodeIds(db) {
  const meta = db && db.__draft_meta;
  const ids = meta && Array.isArray(meta.deleted_node_ids) ? meta.deleted_node_ids : [];
  return [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

function __contentAddDraftDeletedNodeId(db, nodeId) {
  const out = db && typeof db === "object" ? db : {};
  const ids = new Set(__contentDraftDeletedNodeIds(out));
  const n = Number(nodeId);
  if (Number.isInteger(n) && n > 0) ids.add(n);
  out.__draft_meta = {
    ...(out.__draft_meta && typeof out.__draft_meta === "object" ? out.__draft_meta : {}),
    deleted_node_ids: [...ids].sort((a, b) => a - b)
  };
  return out;
}

// --- Atomic Commits to D1 & KV Sync ---

async function __contentCommitDraftUnlocked(env, admin_id, draftDb, baseVersion, explicitBaseDb = null) {
  await __contentEnsureGuard(env);
  const dbBinding = env.SQL;
  if (!dbBinding) throw new Error("D1 Database binding missing");

  // Simplified concurrency model:
  // 1) Every admin draft remembers only the published version it started from.
  // 2) Save succeeds only when that version is still live.
  // 3) If another admin has already published a newer version, we stop with a
  //    clear conflict and keep this admin's draft intact.
  // 4) Force Save is the explicit escape hatch and calls this function with the
  //    CURRENT live version, applying this draft's actual changes plus any
  //    explicitly recorded deletions without inferring deletions from absence.
  const expectedVersion = Number(baseVersion) || 1;
  const current = await __contentLoadSnapshotFromD1(env);
  const currentVersion = Number(current && current._v) || 1;

  if (currentVersion !== expectedVersion) {
    return {
      ok: false,
      conflict: true,
      reason: "concurrent-save",
      liveVersion: currentVersion
    };
  }

  const db = __contentNormalizeIds(draftDb);
  db.next_id = Math.max(
    Number(db.next_id) || 2,
    Number(current.next_id) || 2,
    __contentMaxNodeId(db) + 1
  );

  // IMPORTANT: deletion intent is stored explicitly in the draft. A node that
  // exists in CURRENT but is absent from this draft is NOT considered deleted.
  // This is what makes Force Save safe when another admin added content after
  // this draft was created.
  const explicitDeletedIds = new Set(__contentDraftDeletedNodeIds(db));

  // Draft-only metadata must never become part of the published content
  // snapshot or the canonical content comparison.
  if (db.__draft_meta) delete db.__draft_meta;

  const currentCanonical = __contentJson(current);
  delete currentCanonical._v;
  const draftCanonical = __contentJson(db);
  delete draftCanonical._v;

  // Saving without changes AND without an explicit deletion request is a no-op;
  // do not create a new content version.
  if (__contentDeepEqual(currentCanonical, draftCanonical) && explicitDeletedIds.size === 0) {
    return {
      ok: true,
      conflict: false,
      version: currentVersion,
      snapshotOk: true,
      db: current
    };
  }

  const newVersion = currentVersion + 1;
  const batch = [];

  // D1-side CAS guard: the commit transaction itself must still see the exact
  // version that was read above. This protects against writers outside the
  // in-isolate mutex / distributed content lock.
  // guard_ok is NOT NULL: a version mismatch writes NULL, the constraint aborts the whole batch.
  batch.push({
    sql: "UPDATE content_meta SET guard_ok = CASE WHEN version=?1 THEN 1 ELSE NULL END WHERE id=1",
    args: [currentVersion]
  });

  const currentNodes = current.nodes || {};
  const draftNodes = db.nodes || {};
  const allIds = new Set([...Object.keys(currentNodes), ...Object.keys(draftNodes)]);
  const added = [], changedChildren = [], changedItems = [], renamed = [];

  for (const id of allIds) {
    const a = currentNodes[id], b = draftNodes[id];
    const numericId = Number(id);

    // Explicit deletion wins over normal add/change processing. If an admin
    // explicitly deleted a node, the commit must honor that intent even during
    // Force Save. If the node is not in CURRENT anymore, there is simply nothing
    // to delete.
    if (explicitDeletedIds.has(numericId)) continue;

    // IMPORTANT: there is deliberately NO `a && !b => deleted` branch here.
    // Absence from the draft only means "this admin did not touch that node".
    if (!a && b) { added.push(b); continue; }
    if (!a || !b) continue;
    if (String(a.name || "") !== String(b.name || "")) renamed.push(b);
    const ca = JSON.stringify({
      children_rows: a.children_rows || [],
      hidden: (a.children_hidden || []).map(Number).sort((x, y) => x - y)
    });
    const cb = JSON.stringify({
      children_rows: b.children_rows || [],
      hidden: (b.children_hidden || []).map(Number).sort((x, y) => x - y)
    });
    if (ca !== cb) changedChildren.push(b);
    if (__contentNodeSig(a) !== __contentNodeSig(b)) changedItems.push(b);
  }

  // Only nodes explicitly marked as deleted by this draft may be removed.
  // Missing-from-draft nodes are intentionally preserved.
  const deletedIds = [...explicitDeletedIds]
    .filter(id => id !== Number(current.root_id) && !!currentNodes[String(id)])
    .map(Number);

  // D1 allows at most 100 bound parameters per statement: delete in chunks.
  for (let di = 0; di < deletedIds.length; di += 40) {
    const chunk = deletedIds.slice(di, di + 40);
    const ph = chunk.map(() => "?").join(",");
    batch.push({ sql: `DELETE FROM node_items WHERE node_id IN (${ph})`, args: chunk });
    batch.push({ sql: `DELETE FROM node_children WHERE parent_id IN (${ph}) OR child_id IN (${ph})`, args: [...chunk, ...chunk] });
    batch.push({ sql: `DELETE FROM nodes WHERE id IN (${ph})`, args: chunk });
  }

  for (const n of added) __contentNodeInsertStatementRows(n, batch, db);
  for (const n of renamed) {
    batch.push({
      sql: "UPDATE nodes SET name=?, version=version+1, updated_at=? WHERE id=?",
      args: [String(n.name || ""), Math.floor(Date.now() / 1000), Number(n.id)]
    });
  }

  for (const n of changedChildren.concat(added)) {
    const isAdded = added.indexOf(n) !== -1;
    if (!isAdded) batch.push({ sql: "DELETE FROM node_children WHERE parent_id=?1", args: [Number(n.id)] });
    const rows = Array.isArray(n.children_rows) ? n.children_rows : [];
    const hidden = Array.isArray(n.children_hidden) ? n.children_hidden.map(Number) : [];
    let chunks = [], args = [], count = 0;
    const flush = () => {
      if (!chunks.length) return;
      batch.push({
        sql: `INSERT INTO node_children(parent_id,child_id,row_index,position,hidden) VALUES ${chunks.join(",")}`,
        args
      });
      chunks = [];
      args = [];
      count = 0;
    };
    for (let ri = 0; ri < rows.length; ri++) {
      const row = Array.isArray(rows[ri]) ? rows[ri] : [];
      for (let pi = 0; pi < row.length; pi++) {
        const cid = Number(row[pi]);
        const h = hidden.indexOf(cid) >= 0 ? 1 : 0;
        if (count + 5 > 90) flush();
        chunks.push("(?,?,?,?,?)");
        args.push(Number(n.id), cid, ri, pi, h);
        count += 5;
      }
    }
    flush();
  }

  const allDbFiles = __contentCollectFiles(db);
  const currentFileMap = new Map(__contentCollectFiles(current).map(f => [String(f.id), f]));

  // Update metadata on known Telegram file IDs without attempting duplicate INSERTs.
  for (const f of allDbFiles) {
    const fid = String(f.id);
    const currentFile = currentFileMap.get(fid);
    if (!currentFile) continue;

    const nextType = String(f.type || "document");
    const nextName = f.file_name != null ? String(f.file_name) : null;
    const nextSize = f.file_size != null && Number.isFinite(Number(f.file_size)) ? Number(f.file_size) : null;
    const currType = String(currentFile.type || "document");
    const currName = currentFile.file_name != null ? String(currentFile.file_name) : null;
    const currSize = currentFile.file_size != null && Number.isFinite(Number(currentFile.file_size)) ? Number(currentFile.file_size) : null;

    const typeChanged = nextType !== currType;
    const nameChanged = nextName != null && nextName !== currName;
    const sizeChanged = nextSize != null && nextSize !== currSize;
    if (!typeChanged && !nameChanged && !sizeChanged) continue;

    batch.push({
      sql: `UPDATE telegram_files SET type=?, file_name=COALESCE(?,file_name), file_size=COALESCE(?,file_size)
            WHERE telegram_file_id=?
              AND (type IS NOT ? OR (? IS NOT NULL AND file_name IS NOT ?) OR (? IS NOT NULL AND file_size IS NOT ?))`,
      args: [nextType, nextName, nextSize, fid, nextType, nextName, nextName, nextSize, nextSize]
    });
  }

  // Insert only genuinely new Telegram file IDs.
  // NOTE: D1 caps a compound SELECT (UNION ALL) at 5 terms, which caused
  // "too many terms in compound SELECT". A multi-row VALUES list has no such cap, and
  // ON CONFLICT DO NOTHING (telegram_file_id is UNIQUE) keeps it idempotent.
  // 5 params per row, max 90 params per statement => 18 rows per statement.
  let fparts = [], fargs = [];
  const flushFiles = () => {
    if (!fparts.length) return;
    batch.push({
      sql: `INSERT INTO telegram_files(telegram_file_id,type,file_name,file_size,created_at) VALUES ${fparts.join(",")} ON CONFLICT(telegram_file_id) DO NOTHING`,
      args: fargs
    });
    fparts = [];
    fargs = [];
  };
  const __fileNowSec = Math.floor(Date.now() / 1000);
  const __seenNewFiles = new Set();
  for (const f of allDbFiles) {
    const fid = String(f.id);
    if (currentFileMap.has(fid) || __seenNewFiles.has(fid)) continue;
    __seenNewFiles.add(fid);
    if (fparts.length >= 18) flushFiles();
    const ftype = String(f.type || "document");
    const fname = f.file_name != null ? String(f.file_name) : null;
    const fsize = f.file_size != null && Number.isFinite(Number(f.file_size)) ? Number(f.file_size) : null;
    fparts.push("(?,?,?,?,?)");
    fargs.push(fid, ftype, fname, fsize, __fileNowSec);
  }
  flushFiles();

  const itemNodeIds = new Set(changedItems.map(n => Number(n.id)));
  for (const n of added) itemNodeIds.add(Number(n.id));
  for (const nodeId of itemNodeIds) {
    if (added.every(n => Number(n.id) !== nodeId)) {
      batch.push({ sql: "DELETE FROM node_items WHERE node_id=?1", args: [nodeId] });
    }
    __contentBuildItemInsertStatements("node_items", nodeId, __contentItemsFromNode(draftNodes[String(nodeId)]), batch);
  }

  if (__contentWelcomeSig(current) !== __contentWelcomeSig(db)) {
    batch.push({ sql: "DELETE FROM welcome_items", args: [] });
    const w = ensureWelcomeObj(db);
    __contentBuildWelcomeInsertStatements(
      __contentItemsFromNode({ display: w.display, notes: w.notes, urls: w.urls, files: w.files }),
      batch
    );
  }

  batch.push({
    sql: "UPDATE content_meta SET version=?, root_id=?, next_id=MAX(next_id, ?), welcome_text=?, updated_at=? WHERE id=1",
    args: [newVersion, Number(db.root_id), Number(db.next_id), getWelcome(db), Math.floor(Date.now() / 1000)]
  });

  try {
    try {
      await dbBinding.batch(batch.map(x => dbBinding.prepare(x.sql).bind(...x.args)));
    } catch (e0) {
      // The batch is atomic, so a failure here changed nothing. If it failed only because the
      // search columns do not exist yet, create them and run the very same batch again.
      if (!batch.some(x => /search_name|search_meta/.test(x.sql)) || !__SEARCH_COL_ERR.test(String(e0 && e0.message || e0))) throw e0;
      if (!await __ensureSearchColumns(env)) throw e0;
      await dbBinding.batch(batch.map(x => dbBinding.prepare(x.sql).bind(...x.args)));
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    // Only the CAS guard row means "another writer committed first". Any other
    // SQL/constraint failure is a real error and must be reported as such.
    if (/guard_ok/i.test(msg)) {
      const live = await __contentLoadSnapshotFromD1(env).catch(() => null);
      return {
        ok: false,
        conflict: true,
        reason: "concurrent-save",
        liveVersion: Number(live && live._v) || (currentVersion + 1)
      };
    }
    throw e;
  }

  __contentMetaCacheInvalidate();
  // LOW-COST: do NOT re-read the whole content tree from D1 after every Save (that billed
  // thousands of "rows read"). The batch just committed atomically, so the committed draft IS
  // the new snapshot. The cron self-heal (below) still verifies the version against D1.
  let snapshot = __contentJson(db);
  snapshot._v = newVersion;
  // Draft-only bookkeeping must never leak into the published snapshot / caches.
  delete snapshot.__draft_meta;
  try {
    if (!contentCacheIntegrity(snapshot)) throw new Error("draft snapshot failed integrity");
  } catch (e) {
    // Safety net: only in this rare case pay for the full D1 read.
    try { snapshot = await __contentLoadSnapshotFromD1(env); }
    catch (e2) { console.error("POST_COMMIT_D1_SNAPSHOT_READ_ERROR:", e2 && e2.message ? e2.message : String(e2)); }
  }
  let snapshotOk = false, snapshotErr = null;
  const snapshotJson = JSON.stringify(snapshot);
  for (let k = 0; k < 3; k++) {
    try {
      await env.DB.put(DB_KEY, snapshotJson);
      snapshotOk = true;
      break;
    } catch (e) {
      snapshotErr = e;
      if (k < 2) await new Promise(r => setTimeout(r, 150 * (k + 1)));
    }
  }
  if (snapshotOk) {
    // LOW-COST: the backup copy is refreshed at most once per 30 min per isolate (halves KV writes).
    const __bnow = Date.now();
    if (!globalThis.__lastBackupPutAt || __bnow - globalThis.__lastBackupPutAt > 30 * 60 * 1000) {
      try { await env.DB.put("db:backup:last", snapshotJson); globalThis.__lastBackupPutAt = __bnow; } catch (_) {}
    }
  }
  snapshot = setPublishedRamCache(snapshot) || snapshot;
  await edgeDbPut(env, snapshot);
  if (!snapshotOk) console.error("D1 commit succeeded but KV snapshot sync failed:", snapshotErr);

  return {
    ok: true,
    conflict: false,
    version: newVersion,
    snapshotOk,
    snapshotError: snapshotErr && String(snapshotErr.message || snapshotErr),
    db: snapshot
  };
}

async function __contentCommitDraft(env, admin_id, draftDb, baseVersion, explicitBaseDb = null) {
  return await __withContentMutationLock(env, () =>
    __contentCommitDraftUnlocked(env, admin_id, draftDb, baseVersion, explicitBaseDb)
  );
}

async function __contentSaveForAdmin(env, admin_id) {
  const session = await __contentSessionRawGet(env, admin_id);
  if (!session || !session.draft_active || !session.draft) return { ok: false, reason: "no-draft" };
  const result = await __contentSaveMerged(env, admin_id, session.draft, session.base_version, { preferDraft: false });
  if (result.ok) {
    const clearResult = await __contentSessionClear(env, admin_id, session.revision);
    if (clearResult && clearResult.concurrent) {
      result.sessionPreserved = true;
      result.concurrentEdit = true;
    }
  }
  return result;
}

// Commit a draft. If the live version moved on, do a per-node 3-way merge under the
// same distributed content lock (so nothing can slip in between the read and the write).
async function __contentSaveMerged(env, admin_id, draft, baseVersion, opts = {}) {
  return await __withContentMutationLock(env, async () => {
    const first = await __contentCommitDraftUnlocked(env, admin_id, draft, baseVersion);
    if (first.ok || !first.conflict) return first;

    const live = await __contentLoadSnapshotFromD1(env);
    const merge = __contentMergeDraft(draft, live, { preferDraft: !!opts.preferDraft });
    if (merge.legacy) {
      return { ok: false, conflict: true, legacy: true, reason: "legacy-draft", liveVersion: Number(live._v) || 1 };
    }
    if (!merge.ok) {
      return { ok: false, conflict: true, reason: "merge-conflict", conflicts: merge.conflicts, liveVersion: Number(live._v) || 1 };
    }
    const res = await __contentCommitDraftUnlocked(env, admin_id, merge.merged, Number(live._v) || 1, live);
    if (res.ok) {
      res.merged = true;
      res.mergeInfo = { applied: merge.applied, conflicts: merge.conflicts, pruned: merge.pruned };
    }
    return res;
  });
}

function __contentDraftConflictKb() {
  return {
    inline_keyboard: [
      [{ text: "⚡ Keep my version of the conflicting items", callback_data: "A|CONTENT_FORCE_SAVE" }],
      [{ text: "🗑️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]
    ]
  };
}

function __contentConflictText(result) {
  if (result && result.legacy) {
    return "⚠️ Another admin published changes and this draft was created by an older bot version, so it cannot be merged safely.\n" +
      "Your draft was NOT applied. Please discard it and redo your edits on the current version.";
  }
  const list = (result && Array.isArray(result.conflicts)) ? result.conflicts : [];
  const why = { "edited-by-both": "edited by both of you", "deleted-by-other": "deleted by another admin", "edited-by-other-deleted-by-you": "you deleted it but another admin edited it", "id-collision": "ID collision", "welcome": "welcome settings edited by both", "dangling-child": "points to a removed button" };
  const lines = list.slice(0, 8).map(c => "• " + (String(c.name || "").trim() || "Unnamed") + " (#" + c.id + ") — " + (why[c.reason] || c.reason));
  return "⚠️ Another admin published changes (Live Version: " + (result && result.liveVersion) + ").\n" +
    "Everything that does not overlap was merged automatically; only these items conflict:\n" + lines.join("\n") +
    (list.length > 8 ? "\n… and " + (list.length - 8) + " more" : "") +
    "\n\n✅ Your draft is preserved. Choose: keep your version of these items (everything else stays as published), or discard.";
}



async function __contentAdminSave(env, admin_id) {
  try {
    const result = await __contentSaveForAdmin(env, admin_id);
    if (!result.ok && result.reason === "no-draft") {
      await tgSend(env, admin_id, "No unsaved changes.");
      return null;
    }
    if (!result.ok && result.conflict) {
      await tgSend(env, admin_id, __contentConflictText(result), { reply_markup: result.legacy ? { inline_keyboard: [[{ text: "🗑️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]] } : __contentDraftConflictKb() });
      return result;
    }

    if (result.ok) {
      if (result.snapshotOk) {
        await tgSend(env, admin_id, `✅ All changes saved successfully.${result.merged ? "\n🔀 Merged automatically with changes another admin published meanwhile." : ""}\nNew Version: ${result.version}`);
      } else {
        await tgSend(env, admin_id, `✅ Changes saved to database (D1).\n⚠️ The public cache (KV) could not be updated yet — users may see the previous version for a short while. It is re-published automatically by the scheduled sync; you can also press Reload.`);
      }
      return result;
    } else {
      if (result.d1Committed) {
        await tgSend(env, admin_id, `⚠️ Changes were committed to D1 (version ${result.version}), but the published cache could not be confirmed. Refresh the admin panel before making another edit.`);
      } else {
        await tgSend(env, admin_id, `⚠️ Save failed: ${result.reason || "Unknown error"}. Your draft is still preserved.`);
      }
      return result;
    }
  } catch (err) {
    console.error("ADMIN_SAVE_ERROR:", err);
    const message = String(err && err.message || err || "Unknown error");
    await tgSend(env, admin_id, `❌ Database error while saving: ${message}\nYour draft is preserved in session.`);
    return { ok: false, reason: message, error: message };
  }
}

async function __contentAdminDiscard(env, admin_id) {
  const had = await __contentHasDraft(env, admin_id);
  await __contentSessionClear(env, admin_id);
  if (had) await tgSend(env, admin_id, "↩️ Draft discarded. Reverted to live version.");
  else await tgSend(env, admin_id, "No active draft to discard.");
}

async function __contentAdminReload(env, admin_id) {
  // Reload is a reset/view operation. Serialize only the authoritative read +
  // cache/session reset against Save/Restore; Telegram UI delivery happens after
  // the global content lock is released.
  let live = null;
  await __withContentMutationLock(env, async () => {
    try {
      await __contentMeta(env);
      live = await __contentLoadSnapshotFromD1(env);
    } catch (e) {
      console.error("ADMIN_RELOAD_D1_ERROR:", e && e.message ? e.message : String(e));
    }
    if (!live) return;
    __contentMetaCacheInvalidate();
    try { if (env.DB && typeof env.DB.put === "function") await env.DB.put(DB_KEY, JSON.stringify(live)); } catch (_) {}
    live = setPublishedRamCache(live) || live;
    try { await edgeDbPut(env, live); } catch (_) {}
    await __contentSessionClear(env, admin_id);
    try { await d1SetPath(env, adminPathId(admin_id), [live.root_id], { d1_writes: 0 }); } catch (_) {}
  });

  if (!live) {
    await tgSend(env, admin_id, "⚠️ Published content database is temporarily unavailable.");
    return;
  }
  await tgSend(env, admin_id, "🔄 Current published version loaded. Any existing draft was discarded.");
  await showAdminNode(env, admin_id, live);
}

// --- Disaster Recovery: /restore handler ---

let RESTORE_STAGE_SCHEMA_READY = false;
let RESTORE_STAGE_SCHEMA_IN_FLIGHT = null;

async function __ensureRestoreStageSchema(env) {
  if (env && env.SCHEMA_MANAGED === "1") RESTORE_STAGE_SCHEMA_READY = true;
  if (RESTORE_STAGE_SCHEMA_READY) return true;
  if (RESTORE_STAGE_SCHEMA_IN_FLIGHT) return await RESTORE_STAGE_SCHEMA_IN_FLIGHT;

  RESTORE_STAGE_SCHEMA_IN_FLIGHT = (async () => {
    const db = env.SQL;
    if (!db) return false;
    try {
      await db.prepare(`CREATE TABLE IF NOT EXISTS restore_stage (
        restore_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        n1 INTEGER, n2 INTEGER, n3 INTEGER, n4 INTEGER, n5 INTEGER,
        s1 TEXT, s2 TEXT, s3 TEXT, s4 TEXT, s5 TEXT
      ) STRICT`).run();
      RESTORE_STAGE_SCHEMA_READY = true;
      return true;
    } catch (e) {
      console.error("RESTORE_STAGE_SCHEMA_ERROR:", e && e.message ? e.message : String(e));
      return false;
    } finally {
      RESTORE_STAGE_SCHEMA_IN_FLIGHT = null;
    }
  })();

  return await RESTORE_STAGE_SCHEMA_IN_FLIGHT;
}

async function __clearRestoreStage(env, restoreId = null) {
  const db = env.SQL;
  if (!db) return;
  const rid = restoreId == null ? null : String(restoreId);
  const where = rid ? " WHERE restore_id=?1" : "";
  const args = rid ? [rid] : [];
  try {
    await db.prepare(`DELETE FROM restore_stage${where}`).bind(...args).run();
  } catch (e) {
    console.error("RESTORE_STAGE_CLEANUP_ERROR:", e && e.message ? e.message : String(e));
  }
}

async function __stageRestoreRows(env, table, columns, rows, restoreId) {
  const db = env.SQL;
  if (!db || !rows.length) return;

  // D1 currently allows at most 100 bound parameters per individual query.
  // Eight rows keeps even the widest staging row well below that ceiling.
  const ROWS_PER_STATEMENT = 8;
  const STATEMENTS_PER_BATCH = 20;
  const statements = [];
  const flush = async () => {
    if (!statements.length) return;
    const copy = statements.splice(0, statements.length);
    await db.batch(copy);
  };

  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const args = [];
    for (const row of chunk) args.push(...row);
    statements.push(db.prepare(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`
    ).bind(...args));
    if (statements.length >= STATEMENTS_PER_BATCH) await flush();
  }
  await flush();
}

function __restoreCollectItemRows(normalized) {
  const nodeItems = [];
  for (const node of Object.values(normalized.nodes || {})) {
    const items = __contentItemsFromNode(node);
    for (const it of items) {
      nodeItems.push({ node_id: Number(node.id), ...it });
    }
  }
  const w = ensureWelcomeObj(normalized);
  const welcomeItems = __contentItemsFromNode({
    display: w.display || [], notes: w.notes || [], urls: w.urls || [], files: w.files || []
  });
  return { nodeItems, welcomeItems };
}

function __restoreValidateNormalized(normalized) {
  const allNodes = Object.values(normalized.nodes || {});
  const nodeIds = new Set(allNodes.map(n => Number(n.id)));
  const rootId = Number(normalized.root_id) || 1;
  if (!nodeIds.has(rootId)) return "Backup root_id does not exist in the nodes list.";

  for (const node of allNodes) {
    const rows = Array.isArray(node.children_rows) ? node.children_rows : [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const childId of row) {
        if (!nodeIds.has(Number(childId))) {
          return `Backup contains child ${childId} whose node does not exist.`;
        }
      }
    }
  }

  // The tree must be acyclic (iterative DFS from the root, 3-colour marking).
  {
    const byId = new Map(allNodes.map(n => [Number(n.id), n]));
    const color = new Map();
    const stack = [[rootId, 0]];
    color.set(rootId, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = byId.get(top[0]);
      const kids = [];
      for (const row of (node && Array.isArray(node.children_rows) ? node.children_rows : [])) {
        if (Array.isArray(row)) for (const c of row) kids.push(Number(c));
      }
      if (top[1] < kids.length) {
        const c = kids[top[1]++];
        const st = color.get(c) || 0;
        if (st === 1) return "Backup contains a cycle in the menu tree (node " + c + " is its own ancestor).";
        if (st === 0) { color.set(c, 1); stack.push([c, 0]); }
      } else {
        color.set(top[0], 2);
        stack.pop();
      }
    }
  }

  const files = __contentCollectFiles(normalized);
  const fileIds = new Set(files.map(f => String(f.id)));
  const { nodeItems, welcomeItems } = __restoreCollectItemRows(normalized);
  for (const it of nodeItems.concat(welcomeItems)) {
    if (it.item_type === "file" && !fileIds.has(String(it.file_telegram_id))) {
      return `Backup references missing Telegram file ID ${it.file_telegram_id}.`;
    }
  }

  return null;
}

async function contentRestoreFromBackupUnlocked(env, chat_id, backupJson) {
  let restoreId = null;
  try {
    if (!backupJson || typeof backupJson !== "object" || !backupJson.nodes || !backupJson.root_id) {
      return { ok: false, error: "Invalid backup file structure (missing nodes or root_id)." };
    }

    const dbBinding = env.SQL;
    if (!dbBinding) return { ok: false, error: "D1 database not connected." };

    const normalized = __contentNormalizeIds(backupJson);
    const validationError = __restoreValidateNormalized(normalized);
    if (validationError) return { ok: false, error: validationError };

    const allNodes = Object.values(normalized.nodes || {});
    const files = __contentCollectFiles(normalized);
    const { nodeItems, welcomeItems } = __restoreCollectItemRows(normalized);
    const nowSec = Math.floor(Date.now() / 1000);
    // NEVER guess the live version: a wrong (lower) version would make every isolate that
    // already holds a newer snapshot reject the restored content. A failed read aborts the restore.
    const meta = await __contentMeta(env, { fresh: true });
    const ramV = Number(GLOBAL_DB_CACHE && GLOBAL_DB_CACHE.value && GLOBAL_DB_CACHE.value._v) || 0;
    const newVersion = Math.max(Number(meta.version) || 1, ramV) + 1;
    restoreId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    if (!await __ensureRestoreStageSchema(env)) {
      return { ok: false, error: "Restore staging schema is unavailable." };
    }
    // IDs are never re-issued: keep the allocator at least as high as anything already handed out.
    normalized.next_id = Math.max(
      Number(normalized.next_id) || 2,
      Number(meta.next_id) || 2,
      __contentMaxNodeId(normalized) + 1
    );

    // Staging is disposable. Clear any abandoned staging data from older failed
    // restore attempts before loading the new backup. The live content tables are
    // NOT touched here.
    await __clearRestoreStage(env);

    const stageNodes = allNodes.map(n => [restoreId, Number(n.id), String(n.name || "")]);
    const stageChildren = [];
    for (const node of allNodes) {
      const rows = Array.isArray(node.children_rows) ? node.children_rows : [];
      const hidden = Array.isArray(node.children_hidden) ? node.children_hidden.map(Number) : [];
      for (let ri = 0; ri < rows.length; ri++) {
        const row = Array.isArray(rows[ri]) ? rows[ri] : [];
        for (let pi = 0; pi < row.length; pi++) {
          const cid = Number(row[pi]);
          stageChildren.push([restoreId, Number(node.id), cid, ri, pi, hidden.includes(cid) ? 1 : 0]);
        }
      }
    }

    const stageFiles = files.map(f => [
      restoreId,
      String(f.id),
      String(f.type || "document"),
      f.file_name != null ? String(f.file_name) : null,
      f.file_size != null && Number.isFinite(Number(f.file_size)) ? Number(f.file_size) : null,
      nowSec
    ]);

    // Search metadata (per file placement) is restored only when the backup has some AND the
    // node_items columns exist (or can be created).
    const restoreHasSearch = nodeItems.some(it => it.item_type === "file" && it.search_meta);
    const restoreSearchOk = restoreHasSearch ? await __ensureSearchColumns(env) : (SEARCH_COLS_STATE === true);
    if (restoreHasSearch && !restoreSearchOk) console.error("RESTORE_SEARCH_META_SKIPPED: search columns unavailable");

    const stageItems = nodeItems.map(it => [
      restoreId,
      Number(it.node_id),
      Number(it.position),
      String(it.item_type),
      it.item_type === "file" ? String(it.file_telegram_id) : null,
      it.text_content != null ? String(it.text_content) : null,
      it.url != null ? String(it.url) : null,
      it.caption != null ? String(it.caption) : null,
      nowSec,
      nowSec
    ]);

    // Search metadata travels in its own staging rows (the generic staging table has no spare text columns).
    const stageItemSearch = restoreSearchOk
      ? nodeItems.filter(it => it.item_type === "file" && it.search_meta)
          .map(it => [restoreId, Number(it.node_id), Number(it.position), it.search_name != null ? String(it.search_name) : null, String(it.search_meta)])
      : [];

    const stageWelcomeItems = welcomeItems.map(it => [
      restoreId,
      Number(it.position),
      String(it.item_type),
      it.item_type === "file" ? String(it.file_telegram_id) : null,
      it.text_content != null ? String(it.text_content) : null,
      it.url != null ? String(it.url) : null,
      it.caption != null ? String(it.caption) : null,
      nowSec,
      nowSec
    ]);

    // Load the backup into staging in small, bounded batches. Even an enormous
    // backup can be staged without approaching D1's per-query parameter limit.
    // One generic staging table; `kind` selects the row type (columns are mapped per kind below).
    const withKind = (kind, rows) => rows.map(r => [r[0], kind, ...r.slice(1)]);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","n1","s1"], withKind("node", stageNodes), restoreId);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","n1","n2","n3","n4","n5"], withKind("child", stageChildren), restoreId);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","s1","s2","s3","n1","n2"], withKind("file", stageFiles), restoreId);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","n1","n2","s1","s2","s3","s4","s5","n3","n4"], withKind("item", stageItems), restoreId);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","n1","s1","s2","s3","s4","s5","n3","n4"], withKind("welcome", stageWelcomeItems), restoreId);
    await __stageRestoreRows(env, "restore_stage", ["restore_id","kind","n1","n2","s1","s2"], withKind("isrch", stageItemSearch), restoreId);

    // FINAL CUTOVER: this is the ONLY point where the live content is touched.
    // D1 batch() is transactional; if any statement fails, the whole cutover
    // rolls back, so the old database remains intact.
    await dbBinding.batch([
      dbBinding.prepare("DELETE FROM node_items"),
      dbBinding.prepare("DELETE FROM welcome_items"),
      dbBinding.prepare("DELETE FROM node_children"),
      dbBinding.prepare("DELETE FROM nodes"),
      dbBinding.prepare("DELETE FROM telegram_files"),
      dbBinding.prepare("DELETE FROM content_sessions"),
      dbBinding.prepare("DELETE FROM paths"),

      dbBinding.prepare(`
        INSERT INTO nodes(id,name,version,created_at,updated_at,deleted_at)
        SELECT n1,s1,1,?1,?1,NULL
        FROM restore_stage
        WHERE restore_id=?2 AND kind='node'
      `).bind(nowSec, restoreId),

      dbBinding.prepare(`
        INSERT INTO telegram_files(telegram_file_id,type,file_name,file_size,created_at)
        SELECT s1,s2,s3,n1,n2
        FROM restore_stage
        WHERE restore_id=?1 AND kind='file'
      `).bind(restoreId),

      dbBinding.prepare(`
        INSERT INTO node_children(parent_id,child_id,row_index,position,hidden)
        SELECT n1,n2,n3,n4,n5
        FROM restore_stage
        WHERE restore_id=?1 AND kind='child'
        ORDER BY n1,n3,n4
      `).bind(restoreId),

      dbBinding.prepare(`
        INSERT INTO node_items(node_id,position,item_type,file_id,text_content,url,caption,created_at,updated_at)
        SELECT s.n1,s.n2,s.s1,
               tf.id,s.s3,s.s4,s.s5,s.n3,s.n4
        FROM restore_stage s
        LEFT JOIN telegram_files tf
          ON s.s2 IS NOT NULL
         AND tf.telegram_file_id=s.s2
        WHERE s.restore_id=?1 AND s.kind='item'
          AND (s.s1 <> 'file' OR tf.id IS NOT NULL)
        ORDER BY s.n1,s.n2
      `).bind(restoreId),

      ...(stageItemSearch.length ? [dbBinding.prepare(`
        UPDATE node_items SET
          search_name=(SELECT r.s1 FROM restore_stage r WHERE r.restore_id=?1 AND r.kind='isrch' AND r.n1=node_items.node_id AND r.n2=node_items.position),
          search_meta=(SELECT r.s2 FROM restore_stage r WHERE r.restore_id=?1 AND r.kind='isrch' AND r.n1=node_items.node_id AND r.n2=node_items.position)
        WHERE EXISTS (SELECT 1 FROM restore_stage r WHERE r.restore_id=?1 AND r.kind='isrch' AND r.n1=node_items.node_id AND r.n2=node_items.position)
      `).bind(restoreId)] : []),

      dbBinding.prepare(`
        INSERT INTO welcome_items(position,item_type,file_id,text_content,url,caption,created_at,updated_at)
        SELECT s.n1,s.s1,
               tf.id,s.s3,s.s4,s.s5,s.n3,s.n4
        FROM restore_stage s
        LEFT JOIN telegram_files tf
          ON s.s2 IS NOT NULL
         AND tf.telegram_file_id=s.s2
        WHERE s.restore_id=?1 AND s.kind='welcome'
          AND (s.s1 <> 'file' OR tf.id IS NOT NULL)
        ORDER BY s.n1
      `).bind(restoreId),

      dbBinding.prepare(`
        INSERT INTO content_meta(id,version,root_id,next_id,welcome_text,updated_at)
        VALUES(1,?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET
          version=excluded.version,
          root_id=excluded.root_id,
          next_id=MAX(content_meta.next_id, excluded.next_id),
          welcome_text=excluded.welcome_text,
          updated_at=excluded.updated_at
      `).bind(
        newVersion,
        Number(normalized.root_id),
        Number(normalized.next_id),
        getWelcome(normalized),
        nowSec
      ),

      // The allocator is content_meta.next_id (upserted above with MAX, so a restore can never
      // make it go backwards and IDs are never re-issued).

      dbBinding.prepare("DELETE FROM restore_stage WHERE restore_id=?1").bind(restoreId)
    ]);

    __contentMetaCacheInvalidate();
    try { CONTENT_SESSION_READ_CACHE.clear(); } catch (_) {}
    try { MEM.paths.clear(); } catch (_) {}

    // Publish only after the durable cutover succeeds. If KV/Edge publishing
    // fails, D1 remains safely restored and the scheduled reconciler can repair
    // the cache later.
    let cacheSynchronized = true;
    try {
      normalized._v = newVersion;
      if (!env.DB || typeof env.DB.put !== "function") throw new Error("KV binding missing");
      await env.DB.put(DB_KEY, JSON.stringify(normalized));
      setPublishedRamCache(normalized);
      await edgeDbPut(env, normalized);
    } catch (cacheErr) {
      cacheSynchronized = false;
      console.error("RESTORE_CACHE_SYNC_ERROR:", cacheErr && cacheErr.message ? cacheErr.message : String(cacheErr));
    }

    return {
      ok: true,
      version: newVersion,
      cacheSynchronized,
      snapshot: normalized
    };
  } catch (err) {
    console.error("CONTENT_RESTORE_ERROR:", err && err.message ? err.message : String(err));
    if (restoreId) await __clearRestoreStage(env, restoreId);
    return { ok: false, error: err && err.message || String(err) };
  }
}

async function contentRestoreFromBackup(env, chat_id, backupJson) {
  return await __withContentMutationLock(env, () =>
    contentRestoreFromBackupUnlocked(env, chat_id, backupJson)
  );
}

async function resetBotDataUnlocked(env) {
  const errors = [];
  // The content version must keep growing across a reset. Restarting at 1 would make every
  // isolate that still holds vN (N>1) reject all new snapshots and keep serving deleted content.
  let prevVersion = 1, prevNextId = 2;
  try {
    const m = await __contentMeta(env, { fresh: true });
    prevVersion = Number(m && m.version) || 1;
    prevNextId = Number(m && m.next_id) || 2;
  } catch (e) { errors.push("read-version: " + (e && e.message || e)); }
  try {
    const cur = GLOBAL_DB_CACHE && GLOBAL_DB_CACHE.value;
    prevVersion = Math.max(prevVersion, Number(cur && cur._v) || 0);
  } catch (_) {}

  try {
    if (env.SQL) await env.SQL.prepare("DELETE FROM paths").run();
  } catch (e) { errors.push("paths: " + (e && e.message || e)); }

  try {
    const contentDb = env.SQL;
    if (contentDb) {
      await __contentEnsureGuard(env);
      await contentDb.batch([
        contentDb.prepare("DELETE FROM content_sessions"),
        contentDb.prepare("DELETE FROM node_items"),
        contentDb.prepare("DELETE FROM welcome_items"),
        contentDb.prepare("DELETE FROM node_children"),
        contentDb.prepare("DELETE FROM nodes"),
        contentDb.prepare("DELETE FROM telegram_files"),
        contentDb.prepare("DELETE FROM content_meta")
      ]);
      __contentMetaCacheInvalidate();
      await __contentMeta(env, { fresh: true });           // recreates the default root + meta row
      // Keep the node-ID allocator: IDs handed out before the reset must never be re-issued.
      await contentDb.prepare("UPDATE content_meta SET version=?1, next_id=MAX(next_id, ?2) WHERE id=1").bind(prevVersion + 1, prevNextId).run();
      __contentMetaCacheInvalidate();
    }
  } catch (e) { errors.push("content: " + (e && e.message || e)); }

  // Re-publish the (empty) content right away so users never see a missing snapshot,
  // and so every isolate accepts it (its version is higher than anything they hold).
  try {
    const snap = await __contentLoadSnapshotFromD1(env);
    if (snap) {
      await env.DB.put(DB_KEY, JSON.stringify(snap));
      GLOBAL_DB_CACHE = { value: null, expiresAt: 0 };
      setPublishedRamCache(snap);
      await edgeDbPut(env, snap);
    }
  } catch (e) { errors.push("republish: " + (e && e.message || e)); }
  try { CONTENT_SESSION_READ_CACHE.clear(); MEM.paths.clear(); } catch (_) {}

  if (errors.length) console.error("RESET_ERRORS:", errors.join(" | "));
  return { ok: errors.length === 0, errors, version: prevVersion + 1 };
}

/* ============================================================================
   ADMIN UI, CALLS & PENDING INPUTS
   ============================================================================ */

async function resetBotData(env) {
  return await __withContentMutationLock(env, () => resetBotDataUnlocked(env));
}


// --- Admin Keyboard & Display Helpers ---

function __contentAdminMenuKb(db, node, hasDraft, hasConflict = false) {
  const rows = [];
  const cr = node && Array.isArray(node.children_rows) ? node.children_rows : [];
  const childButtons = [];

  for (let i = 0; i < cr.length; i++) {
    const r = Array.isArray(cr[i]) ? cr[i] : [];
    for (let j = 0; j < r.length; j++) {
      const cid = r[j];
      const child = db && db.nodes ? db.nodes[String(cid)] : null;
      if (!child) continue;
      const nm = String(child.name || "").trim() || "Unnamed";
      childButtons.push({ text: nm, callback_data: "A|OPEN|" + cid });
    }
  }

  for (let i = 0; i < childButtons.length; i += 2) {
    const pair = [childButtons[i]];
    if (childButtons[i + 1]) pair.push(childButtons[i + 1]);
    rows.push(pair);
  }

  const nid = Number(node && node.id) || Number(db && db.root_id) || 1;
  const atRoot = Number(node && node.id) === Number(db && db.root_id);
  const hasKids = hasChildren(node);

  if (childButtons.length) rows.push([{ text: "────────────", callback_data: "A|SEP" }]);
  rows.push([
    { text: "➕ Add Button", callback_data: "A|ADD|" + nid },
    { text: "✏️ Rename", callback_data: "A|REN|" + nid }
  ]);

  if (hasKids) {
    rows.push([
      { text: "🗑️ Delete", callback_data: "A|DEL|" + nid },
      { text: "🧩 Layout & Order", callback_data: "A|LAYOUT|" + nid }
    ]);
  } else if (!atRoot) {
    const parent = findParentNode(db, nid);
    const parentId = parent ? parent.id : db.root_id;
    rows.push([
      { text: "🗑️ Delete", callback_data: "A|DEL|" + nid },
      { text: "🧩 Arrange in Parent Section", callback_data: "A|LAYOUT|" + parentId }
    ]);
  } else {
    rows.push([
      { text: "🗑️ Delete", callback_data: "A|DEL|" + nid }
    ]);
  }

  if (!atRoot) {
    rows.push([{ text: "⬅️ Back", callback_data: "A|BACK|" + nid }]);
  }
  rows.push([
    { text: "👁 Manage & View Content", callback_data: "A|MANAGE|" + nid },
    { text: "📎 Attach Files/Texts", callback_data: "A|ATTACH_MULTI|" + nid }
  ]);

  if (atRoot) {
    rows.push([{ text: "👥 Users", callback_data: "A|USERS|1" }]);
    rows.push([{ text: "📈 Statistics", callback_data: "A|STAT" }]);
    rows.push([{ text: "📊 Polls", callback_data: "A|POLL_LIST|1" }]);
    rows.push([{ text: "⚙️ Welcome Settings", callback_data: "A|WELCOME" }]);
    rows.push([{ text: "📣 Broadcast", callback_data: "A|BC_MENU" }]);
  }

  // Conflict state options:
  if (hasConflict) {
    rows.push([
      { text: "⚡ Force Save Changes", callback_data: "A|CONTENT_FORCE_SAVE" },
      { text: "🗑️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }
    ]);
  } else if (hasDraft) {
    rows.push([
      { text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" },
      { text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }
    ]);
  }

  return { inline_keyboard: rows };
}

async function showAdminNode(env, chat_id, db = null, targetNodeId = null, sessionHint = null) {
  let viewDb = db;
  let hasDraft = false;
  let stale = false;
  let hasConflict = false;

  try {
    const session = sessionHint || await __contentSessionGet(env, chat_id);
    if (session && session.draft_active && session.draft) {
      hasDraft = true;
      const live = await loadUserContentCacheOnly(env, null, null).catch(() => null);
      stale = !!(live && Number(session.base_version) !== Number(live._v || 0));
      hasConflict = !!(session.state && session.state.hasConflict);
      if (!viewDb) viewDb = session.draft;
    } else if (!viewDb) {
      viewDb = await loadUserContentCacheOnly(env, null, null);
      if (!viewDb) {
        try { viewDb = await __contentBootstrapPublishedKvIfD1Empty(env, null); } catch (_) { viewDb = null; }
      }
    }
  } catch (_) {}

  if (!viewDb) {
    await tgSend(env, chat_id, "⚠️ Published content cache is temporarily unavailable.");
    return;
  }

  let currentId = Number(targetNodeId);
  if (!currentId || !viewDb.nodes || !viewDb.nodes[String(currentId)]) {
    const path = await __contentSafeAdminPath(env, chat_id, viewDb);
    currentId = path[path.length - 1];
  } else {
    const canonical = buildPathToNode(viewDb, currentId);
    await d1SetPath(env, adminPathId(chat_id), canonical, { d1_writes: 0 });
  }

  const node = viewDb.nodes[String(currentId)] || viewDb.nodes[String(viewDb.root_id)];
  ensureDisplay(node);

  const filesCount = node.files && node.files.length ? node.files.length : 0;
  const urlsCount = node.urls && node.urls.length ? node.urls.length : 0;
  const notesCount = node.notes && node.notes.length ? node.notes.length : 0;
  const parts = [];
  if (filesCount) parts.push("Files: " + filesCount);
  if (urlsCount) parts.push("Links: " + urlsCount);
  if (notesCount) parts.push("Texts: " + notesCount);
  const tagLine = parts.length ? parts.join(" | ") : "No content";

  let head = "Admin Control Panel ⚙️";
  if (hasConflict) {
    head = "⚠️ Sync Conflict — Your draft was preserved. Choose Force Save or Discard.\n📝 Admin Panel — Conflicted Draft";
  } else if (stale) {
    head = "⚠️ Newer changes saved by another admin — Your draft is preserved.\n📝 Admin Panel — Outdated Draft";
  } else if (hasDraft) {
    head = "📝 Admin Panel — Unsaved Draft";
  }

  const kb = __contentAdminMenuKb(viewDb, node, hasDraft, hasConflict);
  await tgSend(env, chat_id, head + "\n" + (node.name || "—") + "\n" + tagLine, { reply_markup: kb });
}

/* ============ Layout & Item Management UI ============ */


async function showLayout(env, chat_id, targetNodeId = null, db = null, opts = {}) {
  if (!db) {
    try { db = (await __contentGetWorkingDraft(env, chat_id)).db; }
    catch (e) { throw e; }
  }

  let targetId = Number(targetNodeId);
  if (!targetId || !db.nodes || !db.nodes[String(targetId)]) {
    const path = await __contentSafeAdminPath(env, chat_id, db);
    targetId = Number(path[path.length - 1]) || Number(db.root_id);
  }

  const canonical = buildPathToNode(db, targetId);
  await d1SetPath(env, adminPathId(chat_id), canonical, { d1_writes: 0 });

  const node = db.nodes[String(targetId)] || db.nodes[String(db.root_id)];
  const nodeName = (node && node.name ? String(node.name).trim() : "") || (Number(node.id) === Number(db.root_id) ? "Main Menu" : "Unnamed");
  const cr = node.children_rows || [];
  const hasKids = cr.some(r => Array.isArray(r) && r.length > 0);

  if (!hasKids) {
    const parent = findParentNode(db, node.id);
    const parentKb = {
      inline_keyboard: [
        parent ? [{ text: "🧩 Arrange this button in (" + (parent.name || "Parent") + ")", callback_data: "A|LAYOUT|" + parent.id }] : [],
        [{ text: "➕ Add Buttons to Section", callback_data: "A|ADD|" + node.id }],
        [{ text: "⬅️ Back to Section", callback_data: "A|OPEN|" + node.id }]
      ].filter(r => r.length > 0)
    };
    await tgSend(env, chat_id, "⚠️ Section [ " + nodeName + " ] has no sub-buttons to arrange.\n\nYou can add buttons to it first, or arrange this button in its parent section:", { reply_markup: parentKb });
    return;
  }

  // ONE message: the real button grid IS the preview. Tap a button to select it, then move it;
  // the same message is edited after every change (no new messages, no scrolling).
  const selId = Number(opts && opts.selected) || 0;
  const MAX_BUTTONS = 80;
  const rows = [];
  let shown = 0, total = 0, selPos = null;
  for (let i = 0; i < cr.length; i++) {
    const rowIds = (cr[i] || []).filter(cid => db.nodes[String(cid)]);
    for (let k = 0; k < rowIds.length; k += 4) {
      const line = [];
      for (const cid of rowIds.slice(k, k + 4)) {
        total++;
        if (shown >= MAX_BUTTONS) continue;
        const child = db.nodes[String(cid)];
        const hidden = isHidden(node, cid);
        let label = (hidden ? "🚫 " : "") + (String(child.name || "").trim() || "Unnamed");
        if (Number(cid) === selId) { label = "🔸 " + label + " 🔸"; selPos = { row: i + 1, col: (cr[i] || []).indexOf(cid) + 1, hidden, name: String(child.name || "").trim() || "Unnamed" }; }
        line.push({ text: label.slice(0, 38), callback_data: "A|L_SEL|" + cid + "|" + node.id });
        shown++;
      }
      if (line.length) rows.push(line);
    }
  }
  if (selPos) {
    rows.push([
      { text: "◀️", callback_data: "A|L_ML|" + selId + "|" + node.id },
      { text: "▶️", callback_data: "A|L_MR|" + selId + "|" + node.id },
      { text: "⬆️", callback_data: "A|L_MU|" + selId + "|" + node.id },
      { text: "⬇️", callback_data: "A|L_MD|" + selId + "|" + node.id }
    ]);
    rows.push([{ text: selPos.hidden ? "👁️ Show to users" : "🚫 Hide from users", callback_data: "A|L_TOG|" + selId + "|" + node.id }]);
  }
  rows.push([{ text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" }, { text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]);
  rows.push([{ text: "👀 User view", callback_data: "A|L_PREV|" + node.id }, { text: "⬅️ Back to Section", callback_data: "A|OPEN|" + node.id }]);

  const head = "🧩 Arrange [ " + nodeName + " ] — not live until saved\n";
  const help = selPos
    ? "Selected: " + selPos.name + " (row " + selPos.row + ", position " + selPos.col + ")" + (selPos.hidden ? " — hidden" : "") + "\nUse the arrows to move it."
    : "Tap a button to select it, then move it with the arrows.";
  await tgSend(env, chat_id, head + help + (total > shown ? "\n⚠️ Showing the first " + shown + " of " + total + " buttons." : ""), { reply_markup: { inline_keyboard: rows } });
}

function kbForManageIndex(idx, isFile, nodeId, rev) {
  const nid = Number(nodeId) || 0;
  // suffix = |<nodeId>|r<draftRevision>|f : a button rendered before the last item change is rejected;
  // "f" marks the full (media) view so its buttons answer with NEW messages instead of editing the item.
  const suffix = "|" + nid + "|r" + (Number(rev) || 0) + "|f";
  const row1 = [
    { text: "⬆️", callback_data: "A|UP|" + idx + suffix },
    { text: "⬇️", callback_data: "A|DOWN|" + idx + suffix },
    { text: "🗑", callback_data: "A|DEL_ITEM|" + idx + suffix }
  ];
  const rows = [row1];
  if (isFile) rows.push([
    { text: "✏️ Caption", callback_data: "A|CAP|" + idx + suffix },
    { text: "🚫 Remove Caption", callback_data: "A|CAP_CLR|" + idx + suffix }
  ]);
  if (isFile) rows.push([
    { text: "🔎 Search name", callback_data: "A|SRCH|" + idx + suffix },
    { text: "🚫 Remove Search name", callback_data: "A|SRCH_CLR|" + idx + suffix }
  ]);
  return { inline_keyboard: rows };
}

function manageFooterKb() {
  return {
    inline_keyboard: [
      [{ text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" }, { text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]
    ]
  };
}

function describeTag(node, tag) {
  const [k, s] = String(tag).split(":");
  const ix = parseInt(s || "0", 10);
  if (k === "N") {
    const t = (node.notes && node.notes[ix]) || "";
    return "Text #" + ix + ": " + trimMid(t, 60);
  }
  if (k === "U") {
    const t = (node.urls && node.urls[ix]) || "";
    return "Link #" + ix + ": " + trimMid(t, 60);
  }
  if (k === "F") {
    const f = (node.files && node.files[ix]) || null;
    if (!f) return "File #" + ix;
    const cap = f.caption ? (" — cap: " + trimMid(f.caption, 30)) : "";
    return "File #" + ix + " (" + (f.type || "doc") + ")" + cap;
  }
  return String(tag);
}

// Telegram rejects (HTTP 400) any text containing a LONE UTF-16 surrogate. Cutting a string with
// slice() in the middle of an emoji (e.g. 🅰 🖼 🎬) creates exactly that, which made the whole
// "Manage content" screen silently fail to appear. Cut by code points and drop stray surrogates.
function __stripLoneSurrogates(t) {
  return String(t == null ? "" : t).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
function trimMid(s, max) {
  s = __stripLoneSurrogates(s || "");
  const cp = Array.from(s);
  if (cp.length <= max) return s;
  const a = Math.floor(max / 2), b = Math.ceil(max / 2);
  return cp.slice(0, a).join("") + " … " + cp.slice(cp.length - b).join("");
}

async function showManageListFull(env, chat_id, db = null) {
  if (!db) {
    try { db = (await __contentGetWorkingDraft(env, chat_id)).db; }
    catch (e) { throw e; }
  }
  const path = await __contentSafeAdminPath(env, chat_id, db);
  const node = db.nodes[String(path[path.length - 1])] || db.nodes[String(db.root_id)];
  ensureDisplay(node);
  await tgSend(env, chat_id, "Manage/View Content (Draft):");
  for (let i = 0; i < node.display.length; i++) {
    const tag = node.display[i];
    const [k, s] = String(tag).split(":");
    const ix = parseInt(s || "0", 10);
    const isFile = k === "F";
    if (k === "N") {
      const txt = (node.notes && node.notes[ix]) || "";
      await tgSend(env, chat_id, txt || "(Empty text)", { reply_markup: kbForManageIndex(i, false, node.id, __draftRev(db)) });
    } else if (k === "U") {
      const url = (node.urls && node.urls[ix]) || "";
      await tgSend(env, chat_id, url || "(Empty link)", { reply_markup: kbForManageIndex(i, false, node.id, __draftRev(db)) });
    } else if (k === "F") {
      const f = (node.files && node.files[ix]) || null;
      if (!f) await tgSend(env, chat_id, "(Missing file)", { reply_markup: kbForManageIndex(i, false, node.id, __draftRev(db)) });
      else {
        const cap = f.caption || undefined;
        const extra = { reply_markup: kbForManageIndex(i, true, node.id, __draftRev(db)) };
        if (f.type === "photo") await sendPhoto(env, chat_id, f.id, cap, extra);
        else if (f.type === "video") await sendVideo(env, chat_id, f.id, cap, extra);
        else if (f.type === "audio") await sendAudio(env, chat_id, f.id, cap, extra);
        else if (f.type === "voice") await sendVoice(env, chat_id, f.id, cap, extra);
        else if (f.type === "sticker") await sendSticker(env, chat_id, f.id, extra);
        else await sendDocument(env, chat_id, f.id, cap, extra);
      }
    } else {
      await tgSend(env, chat_id, describeTag(node, tag), { reply_markup: kbForManageIndex(i, isFile, node.id, __draftRev(db)) });
    }
  }
  await tgSend(env, chat_id, "— End of items. All changes remain in draft —", { reply_markup: manageFooterKb() });
}

async function showWelcomeManageListFull(env, chat_id, db = null) {
  if (!db) {
    try { db = (await __contentGetWorkingDraft(env, chat_id)).db; }
    catch (e) { throw e; }
  }
  ensureWelcomeObj(db);
  const w = db.settings.welcome_obj;
  await tgSend(env, chat_id, "Manage Welcome Content (Draft):");
  for (let i = 0; i < w.display.length; i++) {
    const tag = w.display[i];
    const [k, s] = String(tag).split(":");
    const ix = parseInt(s || "0", 10);
    const isFile = k === "F";
    const kb = {
      inline_keyboard: [[
        { text: "⬆️", callback_data: "A|W_UP|" + i + "|r" + __draftRev(db) + "|f" },
        { text: "⬇️", callback_data: "A|W_DOWN|" + i + "|r" + __draftRev(db) + "|f" },
        { text: "🗑", callback_data: "A|W_DEL_ITEM|" + i + "|r" + __draftRev(db) }
      ]]
    };
    if (isFile) {
      kb.inline_keyboard.push([
        { text: "✏️ Caption", callback_data: "A|W_CAP|" + i + "|f" },
        { text: "🚫 Remove Caption", callback_data: "A|W_CAP_CLR|" + i + "|f" }
      ]);
    }
    if (k === "N") {
      const txt = (w.notes && w.notes[ix]) || "";
      await tgSend(env, chat_id, txt || "(Empty text)", { reply_markup: kb });
    } else if (k === "U") {
      const url = (w.urls && w.urls[ix]) || "";
      await tgSend(env, chat_id, url || "(Empty link)", { reply_markup: kb });
    } else if (k === "F") {
      const f = (w.files && w.files[ix]) || null;
      if (!f) await tgSend(env, chat_id, "(Missing file)", { reply_markup: kb });
      else {
        const cap = f.caption || undefined;
        const extra = { reply_markup: kb };
        if (f.type === "photo") await sendPhoto(env, chat_id, f.id, cap, extra);
        else if (f.type === "video") await sendVideo(env, chat_id, f.id, cap, extra);
        else if (f.type === "audio") await sendAudio(env, chat_id, f.id, cap, extra);
        else if (f.type === "voice") await sendVoice(env, chat_id, f.id, cap, extra);
        else if (f.type === "sticker") await sendSticker(env, chat_id, f.id, extra);
        else await sendDocument(env, chat_id, f.id, cap, extra);
      }
    }
  }
  await tgSend(env, chat_id, "— End of items. All changes remain in draft —", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" }],
        [{ text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]
      ]
    }
  });
}


// --- Media & String Extraction Utilities ---

function extractLinks(text) {
  const re = /(https?:\/\/[^\s]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function _collectLinksFromTextsAndCaptions(notesArr, filesArr) {
  const set = new Set();
  const N = Array.isArray(notesArr) ? notesArr : [];
  for (let i = 0; i < N.length; i++) {
    const t = String(N[i] || "");
    const links = extractLinks(t);
    for (let j = 0; j < links.length; j++) set.add(links[j]);
  }
  const F = Array.isArray(filesArr) ? filesArr : [];
  for (let i = 0; i < F.length; i++) {
    const cap = String((F[i] && F[i].caption) || "");
    if (!cap) continue;
    const links = extractLinks(cap);
    for (let j = 0; j < links.length; j++) set.add(links[j]);
  }
  return set;
}

function getFileIdAndType(m) {
  if (!m) return null;

  if (m.document) {
    return {
      id: m.document.file_id,
      type: "document",
      file_name: m.document.file_name || null,
      file_size: Number.isFinite(Number(m.document.file_size)) ? Number(m.document.file_size) : null,
      caption: m.caption || null
    };
  }

  if (m.video) {
    return {
      id: m.video.file_id,
      type: "video",
      file_name: m.video.file_name || null,
      file_size: Number.isFinite(Number(m.video.file_size)) ? Number(m.video.file_size) : null,
      caption: m.caption || null
    };
  }

  if (m.audio) {
    return {
      id: m.audio.file_id,
      type: "audio",
      file_name: m.audio.file_name || null,
      file_size: Number.isFinite(Number(m.audio.file_size)) ? Number(m.audio.file_size) : null,
      caption: m.caption || null
    };
  }

  if (m.voice) {
    return {
      id: m.voice.file_id,
      type: "voice",
      file_name: null,
      file_size: Number.isFinite(Number(m.voice.file_size)) ? Number(m.voice.file_size) : null,
      caption: m.caption || null
    };
  }

  if (m.photo && m.photo.length) {
    const photo = m.photo[m.photo.length - 1];
    return {
      id: photo.file_id,
      type: "photo",
      file_name: null,
      file_size: Number.isFinite(Number(photo.file_size)) ? Number(photo.file_size) : null,
      caption: m.caption || null
    };
  }

  if (m.sticker) {
    return {
      id: m.sticker.file_id,
      type: "sticker",
      file_name: null,
      file_size: Number.isFinite(Number(m.sticker.file_size)) ? Number(m.sticker.file_size) : null,
      caption: null
    };
  }

  return null;
}

async function addAllMediaFromMessage(node, m) {
  let added = 0;
  const one = getFileIdAndType(m);
  if (one && one.id) {
    node.files = node.files || [];
    let exists = false;
    for (let i = 0; i < node.files.length; i++) {
      if (node.files[i].id === one.id) { exists = true; break; }
    }
    if (!exists) {
      node.files.push({
        id: one.id,
        caption: one.caption || null,
        type: one.type,
        file_name: one.file_name != null ? String(one.file_name) : null,
        file_size: one.file_size != null ? Number(one.file_size) : null
      });
      added++;
    }
  }
  return added;
}

// --- Operational broadcast state is isolated in broadcast_jobs below ---

// --- Session Concurrency Mutex ---

const __ADMIN_SESSION_LOCKS = new Map();
async function __withAdminSessionLock(env, adminId, fn, options = {}) {
  const key = String(Number(adminId) || 0);
  const previous = __ADMIN_SESSION_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  __ADMIN_SESSION_LOCKS.set(key, current);
  await previous;

  let durableLock = null;
  const useDurable = options.durable !== false;
  try {
    if (useDurable) durableLock = await __acquireDistributedLock(env, `admin:${key}`);
    return await fn();
  } finally {
    if (durableLock) await __releaseDistributedLock(env, durableLock);
    release();
    if (__ADMIN_SESSION_LOCKS.get(key) === current) __ADMIN_SESSION_LOCKS.delete(key);
  }
}

// Admin callbacks that only render/read data do not need a cross-isolate D1 lock.
// Mutating callbacks continue to use the durable lock exactly as before.
const ADMIN_READ_ONLY_CALLBACKS = new Set([
  // These callbacks only read/render state. They do not acquire the durable
  // cross-isolate D1 lock; the per-isolate mutex still prevents same-admin
  // overlap locally.
  "SEP", "NOP", "USERS", "U_OPEN", "STAT", "SQ_HELP",
  "MANAGE", "MANAGE_FULL", "W_MANAGE_FULL",
  "WELCOME", "W_MANAGE",
  "POLL_LIST", "POLL_HELP", "POLL_DETAILS", "POLL_STATUS",
  "BC_MENU", "BC_STATUS"
]);

// ============================================================================
// STRICT AUTH ADMIN CALLBACK DISPATCHER
// ============================================================================

async function handleAdminCallback(env, q, bag) {
  const adminId = Number(q && q.from && q.from.id || 0);
  const admins = parseAdmins(env);

  // Strict authorization guard.
  // Any callback with prefix A| from an unauthorized user is immediately rejected.
  if (!admins.includes(adminId)) {
    await answerCallbackQuery(env, q.id, "⛔ You are not authorized to use these buttons.");
    return true;
  }

  const rawData = String(q && q.data || "");
  const parts = rawData.split("|");
  const op = parts.length > 1 ? parts[1] : "NOP";
  const chat_id = (q && q.message && q.message.chat && q.message.chat.id) || adminId;
  const isReadOnlyCallback = ADMIN_READ_ONLY_CALLBACKS.has(op);

  return await __withAdminSessionLock(
    env,
    adminId,
    async () => await __withAdminScope(env, chat_id, __scopeInitFromQuery(q), async () => {

    // Fast ack separator
    if (op === "SEP" || op === "NOP") {
      return true;
    }

    // --- Users panel ---
    // Message mode is a one-shot: any other admin button cancels it, so a later text can never be sent to a user by mistake.
    if (op !== "U_MSG" && op !== "U_MSG_CANCEL") {
      try {
        const s0 = await __contentSessionRawGet(env, adminId);
        if (s0 && s0.state && s0.state.pending && s0.state.pending.mode === "USER_MSG") {
          await __contentSessionStatePut(env, adminId, __contentClearContentPending(s0.state), { existingSession: s0 });
        }
      } catch (_) {}
    }

    // --- Pending-input buttons (✅ Done / ✖ Cancel under every "send me ..." prompt) ---
    if (op === "SQ_SKIP") {
      const sq = await __contentSessionRawGet(env, adminId);
      const pendQ = sq && sq.state && sq.state.pending;
      if (!pendQ || pendQ.mode !== "SEARCH_NAME_Q") {
        await tgSend(env, chat_id, "ℹ️ Nothing is waiting for input anymore.", { noScope: true });
        return true;
      }
      await __adminHandlePendingLocked(env, { chat: { id: chat_id }, from: { id: adminId }, text: "/skip", message_id: 0 }, pendQ, {});
      return true;
    }
    if (op === "SQ_HELP") {
      await tgSend(env, chat_id,
        "🔎 Search name help\n\nFormat — any parts, any order, any field:\n[value].field  e.g.  " + __SEARCH_SYNTAX_HINT + "  or  [SCHEDULE].t [3].l [1].sem\nRanges work too: [1-3].n or [1,3,5].n\nPlain words also work: ma lec 2\nA part you leave out means “any”.\nA field that is not in the list below is still stored as custom text.\n\n" + codesHelpText(),
        { noScope: true });
      return true;
    }

    if (op === "PDONE" || op === "PCANCEL") {
      const s = await __contentSessionRawGet(env, adminId);
      const pend0 = s && s.state && s.state.pending;
      if (!pend0) {
        await tgSend(env, chat_id, "ℹ️ Nothing is waiting for input anymore.");
        await showAdminNode(env, adminId);
        return true;
      }
      if (op === "PDONE") {
        await __adminFinishPendingLocked(env, adminId);
      } else {
        await __adminHandlePendingLocked(env, { chat: { id: chat_id }, from: { id: adminId }, text: "/cancel", message_id: 0 }, pend0, {});
        const sc0 = ADMIN_SCOPES.get(String(chat_id));
        if (sc0 && !sc0.shown) await showAdminNode(env, adminId);
      }
      return true;
    }

    if (op === "USERS" || op === "U_OPEN" || op === "U_TOGGLE" || op === "U_SET" || op === "U_MSG" || op === "U_MSG_CANCEL" || op === "U_CHK") {
      if (op === "U_CHK") {
        const uid = parseInt(parts[2] || "0", 10);
        const page = parseInt(parts[3] || "1", 10) || 1;
        if (!uid) { await tgSend(env, chat_id, "Invalid User ID."); return true; }
        if (!membershipCheckerConfigured(env)) { await tgSend(env, chat_id, "ℹ️ No required group is configured."); await adminUserDetail(env, chat_id, uid, page); return true; }
        const mres = await checkRequiredMembership(env, uid, { forceRefresh: true });
        if (!mres.ok) {
          await tgSend(env, chat_id, "⚠️ Could not check right now (" + String(mres.error || "Telegram error").slice(0, 80) + "). Try again in a moment.");
        } else {
          await __setUserNotMember(env, uid, !mres.member);
          await tgSend(env, chat_id, mres.member ? "✅ This user IS in the required group." : "❌ This user is NOT in the required group.");
        }
        await adminUserDetail(env, chat_id, uid, page);
        return true;
      }
      if (op === "U_MSG") {
        const uid = parseInt(parts[2] || "0", 10);
        const page = parseInt(parts[3] || "1", 10) || 1;
        if (!uid) { await tgSend(env, chat_id, "Invalid User ID."); return true; }
        const u = await env.SQL.prepare("SELECT user_id, username, first_name, last_name FROM users WHERE user_id=?1").bind(uid).first();
        if (!u) { await tgSend(env, chat_id, "User not found."); await adminUsersList(env, chat_id, page); return true; }
        const sess = await __contentSessionRawGet(env, adminId);
        const nextState = { ...((sess && sess.state) || {}), pending: { panel_mid: __panelMid(adminId), mode: "USER_MSG", target_user_id: uid, page, ts: Date.now() } };
        const wr = await __contentSessionStatePut(env, adminId, nextState, { existingSession: sess });
        if (!wr || !wr.ok) { await tgSend(env, chat_id, "⚠️ Could not start message mode (your session changed). Please try again."); return true; }
        await tgSend(env, chat_id,
          `✉️ Send ONE message to ${formatUserName(u)} (ID ${u.user_id}) now.\n` +
          "Text, photo, video, file, voice… anything is delivered exactly as you send it, from the bot.\n" +
          `This mode expires in ${Math.round(USER_DM_TTL_MS / 60000)} minutes.`,
          { reply_markup: { inline_keyboard: [[{ text: "✖️ Cancel", callback_data: `A|U_MSG_CANCEL|${u.user_id}|${page}` }]] } });
        return true;
      }
      if (op === "U_MSG_CANCEL") {
        const uid = parseInt(parts[2] || "0", 10);
        const page = parseInt(parts[3] || "1", 10) || 1;
        const s1 = await __contentSessionRawGet(env, adminId);
        if (s1 && s1.state && s1.state.pending && s1.state.pending.mode === "USER_MSG") {
          await __contentSessionStatePut(env, adminId, __contentClearContentPending(s1.state), { existingSession: s1 });
        }
        if (uid) await adminUserDetail(env, chat_id, uid, page); else await adminUsersList(env, chat_id, page);
        return true;
      }
      if (op === "USERS") {
        const page = parseInt(parts[2] || "1", 10);
        await adminUsersList(env, chat_id, page);
        return true;
      }
      if (op === "U_OPEN") {
        const uid = parseInt(parts[2] || "0", 10);
        const page = parseInt(parts[3] || "1", 10);
        if (!uid) { await tgSend(env, chat_id, "Invalid User ID."); return true; }
        await adminUserDetail(env, chat_id, uid, page);
        return true;
      }
      if (op === "U_TOGGLE") {
        const uid = parseInt(parts[2] || "0", 10);
        const page = parseInt(parts[3] || "1", 10);
        if (!uid) { await tgSend(env, chat_id, "Invalid User ID."); return true; }
        await adminUserCycleBlock(env, chat_id, uid, page);
        return true;
      }
      if (op === "U_SET") {
        const uid = parseInt(parts[2] || "0", 10);
        const mode = parseInt(parts[3] || "0", 10);
        const page = parseInt(parts[4] || "1", 10);
        if (!uid || isNaN(mode)) { await tgSend(env, chat_id, "Invalid input."); return true; }
        await adminUserSetBlock(env, chat_id, uid, mode, page);
        return true;
      }
    }

    // --- Stats ---
    if (op === "STAT") {
      await adminStat(env, chat_id);
      return true;
    }
    if (op === "MSWEEP") {
      if (!membershipCheckerConfigured(env) || !env.MEMBERSHIP_BOT_TOKEN) {
        await tgSend(env, chat_id, "ℹ️ No required group / checker bot is configured.");
        await adminStat(env, chat_id);
        return true;
      }
      await membershipSweepStart(env);
      await membershipSweepStep(env);   // first batch right now; cron continues every 5 minutes
      await adminStat(env, chat_id);
      return true;
    }

    // --- Save / Force Save / Discard / Reload Content Draft ---
    if (op === "CONTENT_SAVE") {
      const res = await __contentAdminSave(env, adminId);
      if (res && res.db) {
        await showAdminNode(env, adminId, res.db);
      } else {
        await showAdminNode(env, adminId);
      }
      return true;
    }
    if (op === "CONTENT_FORCE_SAVE") {
      const session = await __contentSessionRawGet(env, adminId);
      if (!session || !session.draft_active || !session.draft) {
        await tgSend(env, adminId, "No active draft to force save.");
        await showAdminNode(env, adminId);
        return true;
      }
      // Force Save = "on items where we both edited, keep MY version". Everything the other
      // admin changed elsewhere is preserved (this used to overwrite the whole tree with a stale draft).
      const res = await __contentSaveMerged(env, adminId, session.draft, session.base_version, { preferDraft: true });
      if (res.ok) {
        const cleared = await __contentSessionClear(env, adminId, session.revision);
        const mi = res.mergeInfo || {};
        const mine = (mi.conflicts || []).filter(c => c.resolved === "mine").length;
        const theirs = (mi.conflicts || []).filter(c => c.resolved === "theirs");
        await tgSend(env, adminId, `⚡ Saved as version ${res.version}.` +
          (mine ? `\nKept your version of ${mine} conflicting item(s); everything else the other admin changed was preserved.` : "") +
          (theirs.length ? `\n⚠️ ${theirs.length} item(s) you edited had been deleted by another admin and were NOT restored: ${theirs.slice(0, 5).map(c => (String(c.name || "").trim() || "Unnamed")).join(", ")}` : "") +
          (cleared && cleared.concurrent ? "\n⚠️ Your draft changed while saving, so it was kept." : ""));
        await showAdminNode(env, adminId, res.db);
      } else if (res.legacy || res.conflict) {
        await tgSend(env, adminId, __contentConflictText(res), { reply_markup: { inline_keyboard: [[{ text: "🗑️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }]] } });
      } else {
        await tgSend(env, adminId, "⚠️ Force save failed: " + (res.reason || res.error || "unknown error") + ". Your draft is preserved.");
      }
      return true;
    }
    if (op === "CONTENT_DISCARD") {
      await __contentAdminDiscard(env, adminId);
      await showAdminNode(env, adminId);
      return true;
    }
    if (op === "CONTENT_RELOAD" || op === "ADMIN_ROOT") {
      await __contentAdminReload(env, adminId);
      return true;
    }

    // --- Navigation within Admin Tree ---
    if (op === "OPEN") {
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: false });
      const db = dbState.db;
      const cid = parseInt(parts[2] || "0", 10);
      if (cid && db.nodes && db.nodes[String(cid)]) {
        const canonical = buildPathToNode(db, cid);
        await d1SetPath(env, adminPathId(adminId), canonical, { d1_writes: 0 });
      }
      await showAdminNode(env, adminId, db, cid);
      return true;
    }
    if (op === "BACK") {
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: false });
      const db = dbState.db;
      const currentId = Number(parts[2] || 0);
      let path = await __contentSafeAdminPath(env, adminId, db);
      if (currentId && db.nodes && db.nodes[String(currentId)]) {
        path = buildPathToNode(db, currentId);
      }
      if (path.length > 1) {
        path.pop();
        await d1SetPath(env, adminPathId(adminId), path, { d1_writes: 0 });
        const parentId = path[path.length - 1];
        await showAdminNode(env, adminId, db, parentId);
      } else {
        await d1SetPath(env, adminPathId(adminId), [db.root_id], { d1_writes: 0 });
        await showAdminNode(env, adminId, db, db.root_id);
      }
      return true;
    }
    if (op === "HOME") {
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: false });
      const db = dbState.db;
      await d1SetPath(env, adminPathId(adminId), [db.root_id], { d1_writes: 0 });
      await showAdminNode(env, adminId, db, db.root_id);
      return true;
    }

    // --- Node Mutators (Add, Rename, Delete, Attach Multi) ---
    if (op === "ADD") {
      const targetId = Number(parts[2] || 0);
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const sessionHint = dbState.session;
      let p = await __contentSafeAdminPath(env, adminId, dbState.db);
      if (targetId && dbState.db.nodes && dbState.db.nodes[String(targetId)]) {
        p = buildPathToNode(dbState.db, targetId);
        await d1SetPath(env, adminPathId(adminId), p, { d1_writes: 0 });
      }
      const nextState = { ...(sessionHint && sessionHint.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "ADD", target_node_id: p[p.length - 1] } };
      await __contentSessionPut(env, adminId, dbState.base_version, dbState.db, dbState.base_db, { state: nextState, forceActive: true, existingSession: sessionHint });
      if (sessionHint) { sessionHint.state = nextState; sessionHint.draft = dbState.db; sessionHint.draft_active = true; sessionHint.revision = Number(sessionHint.revision || 0) + 1; }
      await tgSend(env, adminId, "➕ Enter the new button name:", { reply_markup: __pendingKb(false) });
      return true;
    }
    if (op === "REN") {
      const targetId = Number(parts[2] || 0);
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const sessionHint = dbState.session;
      let p = await __contentSafeAdminPath(env, adminId, dbState.db);
      if (targetId && dbState.db.nodes && dbState.db.nodes[String(targetId)]) {
        p = buildPathToNode(dbState.db, targetId);
        await d1SetPath(env, adminPathId(adminId), p, { d1_writes: 0 });
      }
      const nextState = { ...(sessionHint && sessionHint.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "REN", target_node_id: p[p.length - 1] } };
      await __contentSessionPut(env, adminId, dbState.base_version, dbState.db, dbState.base_db, { state: nextState, forceActive: true, existingSession: sessionHint });
      if (sessionHint) { sessionHint.state = nextState; sessionHint.draft = dbState.db; sessionHint.draft_active = true; sessionHint.revision = Number(sessionHint.revision || 0) + 1; }
      await tgSend(env, adminId, "✏️ Enter the new section name:", { reply_markup: __pendingKb(false) });
      return true;
    }
    if (op === "DEL") {
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const db = dbState.db;
      const targetId = Number(parts[2] || 0);
      if (targetId && !(db.nodes && db.nodes[String(targetId)])) {
        // Stale / double-tapped button: the node is already gone. Never fall back to "current node".
        await tgSend(env, adminId, "ℹ️ That section was already deleted in your draft.");
        await showAdminNode(env, adminId, db, undefined, dbState.session);
        return true;
      }
      let p = await __contentSafeAdminPath(env, adminId, db);
      if (targetId && db.nodes && db.nodes[String(targetId)]) {
        p = buildPathToNode(db, targetId);
      }
      const node = db.nodes[String(p[p.length - 1])] || db.nodes[String(db.root_id)];
      if (Number(node.id) === Number(db.root_id)) {
        await tgSend(env, adminId, "Cannot delete Root section.");
        return true;
      }
      if (hasChildren(node)) {
        await tgSend(env, adminId, "Delete sub-buttons first before deleting this section.");
        return true;
      }
      const parent = findParentNode(db, node.id) || db.nodes[String(p[p.length - 2])];
      if (!parent) {
        await tgSend(env, adminId, "Parent section not found.");
        return true;
      }
      const nid = Number(node.id);
      for (const other of Object.values(db.nodes || {})) {
        if (!other || Number(other.id) === nid) continue;
        if (Array.isArray(other.children_rows)) {
          other.children_rows = other.children_rows.map(row => Array.isArray(row) ? row.filter(cid => Number(cid) !== nid) : []).filter(row => row.length);
        }
        if (Array.isArray(other.children_hidden)) {
          other.children_hidden = other.children_hidden.filter(cid => Number(cid) !== nid);
        }
      }
      // Record deletion intent explicitly in the durable draft. The commit
      // layer must never infer deletion merely because a node is absent.
      __contentAddDraftDeletedNodeId(db, nid);
      delete db.nodes[String(nid)];
      const parentCanonical = buildPathToNode(db, parent.id);
      await d1SetPath(env, adminPathId(adminId), parentCanonical, { d1_writes: 0 });
      await __contentSessionPut(env, adminId, dbState.base_version, db, dbState.base_db, { existingSession: dbState.session, forceActive: true });
      if (dbState.session) { dbState.session.draft = db; dbState.session.draft_active = true; dbState.session.revision = Number(dbState.session.revision || 0) + 1; }
      await tgSend(env, adminId, "🗑️ Deleted in draft only. Click 💾 Save to apply.");
      await showAdminNode(env, adminId, db, parent.id, dbState.session);
      return true;
    }
    if (op === "ATTACH_MULTI") {
      const targetId = Number(parts[2] || 0);
      const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const sessionHint = dbState.session;
      let p = await __contentSafeAdminPath(env, adminId, dbState.db);
      if (targetId && dbState.db.nodes && dbState.db.nodes[String(targetId)]) {
        p = buildPathToNode(dbState.db, targetId);
        await d1SetPath(env, adminPathId(adminId), p, { d1_writes: 0 });
      }
      const nextState = { ...(sessionHint && sessionHint.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "ATTACH_MULTI", target_node_id: p[p.length - 1], count: { files: 0, notes: 0, urls: 0 } } };
      await __contentSessionPut(env, adminId, dbState.base_version, dbState.db, dbState.base_db, { state: nextState, forceActive: true, existingSession: sessionHint });
      if (sessionHint) { sessionHint.state = nextState; sessionHint.draft = dbState.db; sessionHint.draft_active = true; sessionHint.revision = Number(sessionHint.revision || 0) + 1; }
      await tgSend(env, adminId, "📎 Send files, photos, texts or links now. Press ✅ Done when finished:", { reply_markup: __pendingKb(true) });
      return true;
    }

    // --- Layout Actions ---
    if (op === "LAYOUT" || op === "L_PREV" || op === "L_SEL" || op === "L_TOG" || op === "L_ML" || op === "L_MR" || op === "L_MU" || op === "L_MD") {
      if (op === "LAYOUT") {
        const targetId = parseInt(parts[2] || "0", 10);
        await showLayout(env, adminId, targetId);
        return true;
      }
      let state = await __contentGetWorkingDraft(env, adminId, { fresh: op !== "L_PREV" && op !== "L_SEL" });
      let db = state.db;
      if (op === "L_SEL") {
        const selId = Number(parts[2] || 0), parentId = Number(parts[3] || 0);
        await showLayout(env, adminId, parentId || null, db, { selected: selId });
        return true;
      }
      if (op === "L_PREV") {
        const targetId = parseInt(parts[2] || "0", 10);
        const p = await __contentSafeAdminPath(env, adminId, db);
        const node = (targetId && db.nodes && db.nodes[String(targetId)]) || db.nodes[String(p[p.length - 1])] || db.nodes[String(db.root_id)];
        const pv = mockInlineFromReplyKb(db, node);
        pv.inline_keyboard.push([{ text: "⬅️ Back to arrange", callback_data: "A|LAYOUT|" + node.id }]);
        await tgSend(env, adminId, "👀 User view inside [ " + (node.name || "Section") + " ]\n(buttons exactly as users will see them)", { reply_markup: pv });
        return true;
      }
      const cid = Number(parts[2] || 0);
      const passedParentId = Number(parts[3] || 0);
      if (!cid) { await tgSend(env, adminId, "Invalid cid"); return true; }

      const parentNode = (passedParentId && db.nodes && db.nodes[String(passedParentId)])
        || findParentNode(db, cid)
        || db.nodes[String((await __contentSafeAdminPath(env, adminId, db)).slice(-1)[0])]
        || db.nodes[String(db.root_id)];

      const node = parentNode;
      node.children_hidden = Array.isArray(node.children_hidden) ? node.children_hidden : [];
      const cr = node.children_rows || [];
      const findPos = () => {
        for (let i = 0; i < cr.length; i++) {
          const row = cr[i] || [];
          const j = row.indexOf(cid);
          if (j !== -1) return { i, j };
        }
        return null;
      };

      if (op === "L_TOG") {
        const i = node.children_hidden.indexOf(cid);
        if (i === -1) node.children_hidden.push(cid);
        else node.children_hidden.splice(i, 1);
      } else {
        const pos = findPos();
        if (!pos) { await tgSend(env, adminId, "Button not found in this section."); return true; }
        if (op === "L_ML" || op === "L_MR") {
          const row = cr[pos.i];
          const to = pos.j + (op === "L_ML" ? -1 : 1);
          if (to >= 0 && to < row.length) [row[to], row[pos.j]] = [row[pos.j], row[to]];
        } else {
          if (op === "L_MU" && pos.i === 0) {
            const item = cr[0].splice(pos.j, 1)[0];
            cr.unshift([item]);
          } else {
            const from = pos.i;
            const to = from + (op === "L_MU" ? -1 : 1);
            if (to === cr.length) cr.push([]);
            if (to >= 0 && to < cr.length) {
              const item = cr[from].splice(pos.j, 1)[0];
              cr[to].push(item);
            }
          }
          node.children_rows = cr.filter(r => r && r.length);
        }
      }
      await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { existingSession: state.session, forceActive: true });
      if (state.session) { state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
      await showLayout(env, adminId, node.id, db, { selected: cid });
      return true;
    }

    // --- Content Items Management ---
    if (op === "MANAGE_FULL" || op === "W_MANAGE_FULL") {
      // The full view deliberately sends one real message per item (media, files, texts).
      const scF = ADMIN_SCOPES.get(String(chat_id));
      if (scF) scF.passthrough = true;
      if (op === "MANAGE_FULL") await showManageListFull(env, adminId); else await showWelcomeManageListFull(env, adminId);
      return true;
    }
    if (op === "MANAGE") {
      const targetId = Number(parts[2] || 0);
      try {
        let mdb = null;
        if (targetId) {
          const dbState = await __contentGetWorkingDraft(env, adminId, { fresh: false });
          mdb = dbState.db;
          const canonical = buildPathToNode(mdb, targetId);
          await d1SetPath(env, adminPathId(adminId), canonical, { d1_writes: 0 });
        }
        await showManageList(env, adminId, mdb, { page: parseInt(parts[3] || "0", 10) || 0 });
      } catch (e) {
        const em = e && e.message ? e.message : String(e);
        console.error("MANAGE_VIEW_ERROR:", e && e.stack ? e.stack : em);
        await tgSend(env, adminId, "❌ Manage content failed: " + em.slice(0, 300) + "\nPress ⬅️ Back and try again.", { noScope: true });
      }
      return true;
    }
    if (op === "UP" || op === "DOWN" || op === "DEL_ITEM" || op === "CAP" || op === "CAP_CLR" || op === "SRCH" || op === "SRCH_CLR") {
      if (parts[5] === "f") { const scf = ADMIN_SCOPES.get(String(chat_id)); if (scf) scf.mid = null; }
      const state = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const db = state.db;
      const explicitNodeId = Number(parts[3] || 0);
      const p = explicitNodeId && db.nodes && db.nodes[String(explicitNodeId)]
        ? buildPathToNode(db, explicitNodeId)
        : await __contentSafeAdminPath(env, adminId, db);
      if (explicitNodeId && db.nodes && db.nodes[String(explicitNodeId)]) {
        try { await d1SetPath(env, adminPathId(adminId), p, { d1_writes: 0 }); } catch (_) {}
      }
      const node = db.nodes[String(p[p.length - 1])] || db.nodes[String(db.root_id)];
      ensureDisplay(node);
      const idx = parseInt(parts[2] || "-1", 10);
      const __cbRev = /^r(\d+)$/.exec(String(parts[4] || ""));
      if (__cbRev && Number(__cbRev[1]) !== __draftRev(db)) {
        await tgSend(env, adminId, "⚠️ That list is outdated (content changed). Here is the current list:");
        await showManageList(env, adminId, db);
        return true;
      }
      if (isNaN(idx) || idx < 0 || idx >= node.display.length) {
        await tgSend(env, adminId, "Invalid index.");
        return true;
      }
      if (op === "UP" && idx > 0) {
        [node.display[idx - 1], node.display[idx]] = [node.display[idx], node.display[idx - 1]];
        __bumpDraftRev(db);
      } else if (op === "DOWN" && idx < node.display.length - 1) {
        [node.display[idx + 1], node.display[idx]] = [node.display[idx], node.display[idx + 1]];
        __bumpDraftRev(db);
      } else if (op === "DEL_ITEM") {
        __removeDisplayItem(node, idx);
        __bumpDraftRev(db);
      } else if (op === "CAP") {
        const [k, s] = String(node.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        if (k !== "F") { await tgSend(env, adminId, "Captions are only for files."); return true; }
        const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "EDIT_CAP_DRAFT", target: { fileIndex: ix } } };
        await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, adminId, "✏️ Send the new caption:", { reply_markup: __pendingKb(false) });
        return true;
      } else if (op === "CAP_CLR") {
        const [k, s] = String(node.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        if (k !== "F") { await tgSend(env, adminId, "Captions not supported for this item type."); return true; }
        if (node.files && node.files[ix]) node.files[ix].caption = null;
        __bumpDraftRev(db);
      } else if (op === "SRCH") {
        const [k, s] = String(node.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        const sf = node.files && node.files[ix];
        if (k !== "F" || !sf) { await tgSend(env, adminId, "Search names are only for files."); return true; }
        const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "SEARCH_NAME_DRAFT", target_node_id: node.id, target: { fileIndex: ix } } };
        await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, adminId,
          "🔎 Send the search name for this file:\n" + __searchFileLabel(sf) +
          (sf.search_name ? "\nCurrent: " + sf.search_name : "") +
          "\n\nExample: " + __SEARCH_SYNTAX_HINT + "  (or: ma lec 2)\nSend - to remove it.", { reply_markup: __pendingKb(false) });
        return true;
      } else if (op === "SRCH_CLR") {
        const [k, s] = String(node.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        const sf = node.files && node.files[ix];
        if (k !== "F" || !sf) { await tgSend(env, adminId, "Search names are only for files."); return true; }
        __setFileSearch(sf, null, null);
        __bumpDraftRev(db);
      }
      await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { existingSession: state.session, forceActive: true });
      if (state.session) { state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
      await showManageList(env, adminId, db, { focusIdx: op === "UP" ? Math.max(0, idx - 1) : (op === "DOWN" ? idx + 1 : idx) });
      return true;
    }

    // --- Welcome Management ---
    if (op === "WELCOME") {
      const kb = {
        inline_keyboard: [
          [{ text: "✏️ Edit Welcome Text", callback_data: "A|W_TEXT" }],
          [{ text: "📎 Add Welcome Media & Notes", callback_data: "A|W_ATTACH_MULTI" }],
          [{ text: "👁️ Manage Welcome Content", callback_data: "A|W_MANAGE" }],
          [{ text: "⬅️ Back to Main Menu", callback_data: "A|HOME" }]
        ]
      };
      await tgSend(env, adminId, "⚙️ Welcome Settings:", { reply_markup: kb });
      return true;
    }
    if (op === "W_TEXT") {
      const state = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "WELCOME_TEXT" } };
      await __contentSessionPut(env, adminId, state.base_version, state.db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
      if (state.session) { state.session.state = nextState; state.session.draft = state.db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
      await tgSend(env, adminId, "✏️ Send the new welcome text:", { reply_markup: __pendingKb(false) });
      return true;
    }
    if (op === "W_ATTACH_MULTI") {
      const state = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "W_ATTACH_MULTI", count: { files: 0, notes: 0, urls: 0 } } };
      await __contentSessionPut(env, adminId, state.base_version, state.db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
      if (state.session) { state.session.state = nextState; state.session.draft = state.db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
      await tgSend(env, adminId, "📎 Send welcome files or notes now. Press ✅ Done when finished:", { reply_markup: __pendingKb(true) });
      return true;
    }
    if (op === "W_MANAGE") {
      await showWelcomeManageList(env, adminId, null, { page: parseInt(parts[2] || "0", 10) || 0 });
      return true;
    }
    if (op === "W_UP" || op === "W_DOWN" || op === "W_DEL_ITEM" || op === "W_CAP" || op === "W_CAP_CLR") {
      if (parts[4] === "f" || parts[3] === "f") { const scw = ADMIN_SCOPES.get(String(chat_id)); if (scw) scw.mid = null; }
      const state = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      const db = state.db;
      ensureWelcomeObj(db);
      const w = db.settings.welcome_obj;
      const idx = parseInt(parts[2] || "-1", 10);
      const __wRev = /^r(\d+)$/.exec(String(parts[3] || ""));
      if (__wRev && Number(__wRev[1]) !== __draftRev(db)) {
        await tgSend(env, adminId, "⚠️ That list is outdated (content changed). Here is the current list:");
        await showWelcomeManageList(env, adminId, db);
        return true;
      }
      if (isNaN(idx) || idx < 0 || idx >= w.display.length) {
        await tgSend(env, adminId, "Invalid index.");
        return true;
      }
      if (op === "W_UP" && idx > 0) { [w.display[idx - 1], w.display[idx]] = [w.display[idx], w.display[idx - 1]]; __bumpDraftRev(db); }
      else if (op === "W_DOWN" && idx < w.display.length - 1) { [w.display[idx + 1], w.display[idx]] = [w.display[idx], w.display[idx + 1]]; __bumpDraftRev(db); }
      else if (op === "W_DEL_ITEM") {
        __removeDisplayItem(w, idx);
        ensureWelcomeObj(db);
        __bumpDraftRev(db);
      } else if (op === "W_CAP") {
        const [k, s] = String(w.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        if (k !== "F") { await tgSend(env, adminId, "Captions are only for files."); return true; }
        const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: __panelMid(adminId), mode: "W_EDIT_CAP_DRAFT", target: { fileIndex: ix } } };
        await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, adminId, "✏️ Send the new caption:", { reply_markup: __pendingKb(false) });
        return true;
      } else if (op === "W_CAP_CLR") {
        const [k, s] = String(w.display[idx]).split(":");
        const ix = parseInt(s || "0", 10);
        if (k !== "F") { await tgSend(env, adminId, "Captions not supported for this item type."); return true; }
        if (w.files && w.files[ix]) w.files[ix].caption = null;
      }
      await __contentSessionPut(env, adminId, state.base_version, db, state.base_db, { existingSession: state.session, forceActive: true });
      if (state.session) { state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
      await showWelcomeManageList(env, adminId, db);
      return true;
    }

    // --- Poll Management ---
    // handleAdminCallback() already holds the per-admin session lock, so these
    // helpers intentionally do not acquire that same lock again.
    if (op === "POLL_LIST") {
      const page = Math.max(1, parseInt(parts[2] || "1", 10) || 1);
      await showManagedPollList(env, chat_id, page);
      return true;
    }
    if (op === "POLL_HELP") {
      await tgSend(env, chat_id,
        "📊 <b>Create a trackable poll</b>\n\n" +
        "<code>/poll Question | Option 1 | Option 2 | Option 3</code>\n\n" +
        "Optional: <code>#multi</code> or <code>#quiz</code>.\n" +
        "The poll is non-anonymous so I can record <b>who chose what</b>.\n" +
        "It is delivered privately to every active user saved in D1.",
        { parse_mode: "HTML", skipBlockCheck: true });
      return true;
    }
    if (op === "POLL_DETAILS") {
      const campaignId = String(parts[2] || "").trim();
      const page = Math.max(1, parseInt(parts[3] || "1", 10) || 1);
      if (!campaignId) { await tgSend(env, chat_id, "Invalid poll campaign ID."); return true; }
      await showManagedPollDetails(env, chat_id, campaignId, page);
      return true;
    }
    if (op === "POLL_TICK") {
      const campaignId = String(parts[2] || "").trim();
      if (!campaignId) { await tgSend(env, chat_id, "Invalid poll campaign ID."); return true; }
      const r = await processPollCampaignBatch(env, campaignId, POLL_BATCH_SIZE);
      await tgSend(env, chat_id, formatPollCampaignResult(r), { skipBlockCheck: true });
      return true;
    }
    if (op === "POLL_STATUS") {
      const campaignId = String(parts[2] || "").trim();
      const c = await d1PollCampaignGet(env, campaignId);
      if (!c) { await tgSend(env, chat_id, "⚠️ Poll campaign not found."); return true; }
      await tgSend(env, chat_id,
        `📊 Poll status\n\nQuestion: ${htmlEscape(String(c.question || ""))}\n` +
        `State: ${htmlEscape(String(c.status || ""))}\n` +
        `Sent: ${Number(c.sent) || 0}/${Number(c.total_users) || 0}\n` +
        `Skipped: ${Number(c.skipped) || 0}\n` +
        `${c.failed_user_id ? `Waiting on user: ${Number(c.failed_user_id)}\n` : ""}` +
        `${Number(c.paused_until) > Math.floor(Date.now()/1000) ? `Retry in: ${Math.max(1, Number(c.paused_until)-Math.floor(Date.now()/1000))}s` : ""}`,
        { skipBlockCheck: true });
      return true;
    }
    if (op === "POLL_PAUSE") {
      const campaignId = String(parts[2] || "").trim();
      const r = await pollCampaignPause(env, campaignId);
      await tgSend(env, chat_id, r.ok ? "⏸️ Poll delivery paused." : `⚠️ ${r.reason || "Nothing to pause."}`, { skipBlockCheck: true });
      return true;
    }
    if (op === "POLL_RESUME") {
      const campaignId = String(parts[2] || "").trim();
      const r = await pollCampaignResume(env, campaignId);
      await tgSend(env, chat_id, formatPollCampaignResult(r), { skipBlockCheck: true });
      return true;
    }
    if (op === "POLL_STOP") {
      const campaignId = String(parts[2] || "").trim();
      if (!campaignId) { await tgSend(env, chat_id, "Invalid poll campaign ID."); return true; }
      const r = await stopManagedPoll(env, campaignId);
      await tgSend(env, chat_id, r.ok ? "🛑 Poll campaign closed. No more delivery will continue." : `⚠️ ${r.reason || "Could not close poll campaign."}`);
      await showManagedPollDetails(env, chat_id, campaignId, 1);
      return true;
    }

    // --- Broadcast Controls ---
    // IMPORTANT: handleAdminCallback() already holds the per-admin distributed
    // session lock. Broadcast callbacks must NOT acquire the same lock again
    // (the lock is intentionally non-reentrant).
    if (op === "BC_MENU") { await showBroadcastMenu(env, chat_id); return true; }
    if (op === "BC_HOME") {
      // Leaving while the bot is waiting for the broadcast message would make the NEXT thing you type
      // become the broadcast, so that armed state is cleared. Your content draft is never touched.
      const bj = await d1BroadcastGet(env, chat_id);
      if (bj && bj.status === "awaiting_message") {
        await d1BroadcastClear(env, chat_id);
        await tgSend(env, chat_id, "ℹ️ Broadcast message mode cancelled.");
      }
      const dbH = (await __contentGetWorkingDraft(env, adminId, { fresh: false })).db;
      await d1SetPath(env, adminPathId(adminId), [dbH.root_id], { d1_writes: 0 });
      await showAdminNode(env, adminId, dbH, dbH.root_id);
      return true;
    }
    if (op === "BC_ARM") {
      const r = await armBroadcastMessage(env, chat_id);
      await tgSend(env, chat_id, r.ok ? "📥 Send the message/media you want to broadcast now.\nUse /cancel to stop." : `⚠️ ${r.reason || "Cannot prepare broadcast."}`);
      return true;
    }
    if (op === "BC_SEND" || op === "BC_RESUME") {
      const r = await startBroadcastJob(env, chat_id);
      await tgSend(env, chat_id, formatBroadcastResult(r));
      return true;
    }
    if (op === "BC_TICK") {
      const r = await resumeAndRunBroadcastBatch(env, chat_id, BROADCAST_BATCH_SIZE);
      await tgSend(env, chat_id, formatBroadcastResult(r));
      return true;
    }
    if (op === "BC_PAUSE") {
      const r = await pauseBroadcastJob(env, chat_id);
      await tgSend(env, chat_id, r.ok ? "⏸️ Broadcast paused." : `⚠️ ${r.reason || "Nothing to pause."}`);
      return true;
    }
    if (op === "BC_STATUS") {
      const job = await d1BroadcastGet(env, chat_id);
      await tgSend(env, chat_id, formatBroadcastStatus(job));
      return true;
    }
    if (op === "BC_CANCEL") {
      await d1BroadcastClear(env, chat_id);
      await tgSend(env, chat_id, "🛑 Broadcast cancelled and cleared.");
      return true;
    }


    return false;
  }), { durable: !isReadOnlyCallback });
}

// ============================================================================
// ADMIN PENDING INPUT DISPATCHER
// ============================================================================

async function adminHandlePending(env, m, pend, bag) {
  const chat_id = m.chat.id;
  const adminId = Number(m && m.from && m.from.id || chat_id);
  const admins = parseAdmins(env);

  if (!admins.includes(adminId)) return false;

  return await __withAdminSessionLock(env, adminId, async () =>
    await __withAdminScope(env, chat_id, { mid: __panelMid(chat_id) || null }, async () =>
      await __adminHandlePendingLocked(env, m, pend, bag)));
}

// Same logic as before; the caller already holds the admin lock (so buttons can reuse it).
async function __adminHandlePendingLocked(env, m, pend, bag) {
  const chat_id = m.chat.id;
  const adminId = Number(m && m.from && m.from.id || chat_id);
  {
    try {
      // Read the durable admin session once for this update. Session writes use the
      // revision CAS guard; published content conflicts are handled by base_version.
      const durableSession = await __contentSessionRawGet(env, adminId);
      const durablePend = durableSession && durableSession.state && durableSession.state.pending;
      if (durablePend) pend = durablePend;
      try {
        const scx = ADMIN_SCOPES.get(String(chat_id));
        if (scx && durablePend && durablePend.panel_mid) scx.mid = Number(durablePend.panel_mid);
      } catch (_) {}

      // Direct message to a user (from the Users panel). Handled before any draft is loaded.
      if (durablePend && durablePend.mode === "USER_MSG") return await __adminSendUserMessage(env, m, durablePend, durableSession);
      if (!durablePend && pend && pend.mode === "USER_MSG") return true;   // a concurrent update already consumed it

      let state;
      if (durableSession && durableSession.draft_active && durableSession.draft) {
        let liveVersion = Number(durableSession.base_version) || 1;
        try {
          const meta = await __contentMeta(env, { fresh: true });
          liveVersion = Number(meta && meta.version) || liveVersion;
        } catch (_) {}
        state = {
          db: durableSession.draft,
          base_version: Number(durableSession.base_version) || liveVersion,
          base_db: null,
          existing: true,
          stale: Number(durableSession.base_version) !== liveVersion,
          session: durableSession
        };
      } else {
        state = await __contentGetWorkingDraft(env, adminId, { fresh: true });
      }
      const db = state.db;
      const pathKey = adminPathId(chat_id);
      const path = await __contentSafeAdminPath(env, chat_id, db);
      const targetId = Number(pend.target_node_id || path[path.length - 1] || db.root_id);
      let effectivePath = path;
      if (targetId && (!path.includes(targetId) || Number(path[0]) !== Number(db.root_id))) {
        effectivePath = buildPathToNode(db, targetId);
        await d1SetPath(env, pathKey, effectivePath, { d1_writes: 0 });
      }
      const node = (targetId && db.nodes && db.nodes[String(targetId)]) ? db.nodes[String(targetId)] : (db.nodes[String(effectivePath[effectivePath.length - 1])] || db.nodes[String(db.root_id)]);

      if (pend.mode === "ADD") {
        const name = (m.text && m.text.trim()) || (m.caption && m.caption.trim()) || "";
        if (!name || (name.toLowerCase() === "/done" || name.toLowerCase() === "/cancel")) {
          const nextState = __contentClearContentPending(state.session && state.session.state || {});
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
          await tgSend(env, chat_id, "Cancelled.");
          await showAdminNode(env, chat_id, db, null, state.session);
          return true;
        }
        // Node IDs are globally allocated from D1, never from the admin's
        // draft-local `next_id`. This prevents two admins from creating the
        // same ID concurrently. `db.next_id` is only kept in sync locally so
        // the draft/published metadata remains monotonic.
        const nid = await __allocateContentNodeId(env);
        db.next_id = Math.max(Number(db.next_id) || 2, nid + 1);
        db.nodes[String(nid)] = emptyNode(nid, name);
        if (!node.children_rows || !node.children_rows.length) node.children_rows = [[]];
        node.children_rows[node.children_rows.length - 1].push(nid);
        ensureDisplay(node);
        const nextState = __contentClearContentPending(state.session && state.session.state || {});
        await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, chat_id, "✅ Button added in draft. Click Save to apply.");
        await showAdminNode(env, chat_id, db, null, state.session);
        return true;
      }

      if (pend.mode === "REN") {
        const newName = (m.text && m.text.trim()) || (m.caption && m.caption.trim()) || "";
        if (!newName || (newName.toLowerCase() === "/done" || newName.toLowerCase() === "/cancel")) {
          const nextState = __contentClearContentPending(state.session && state.session.state || {});
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
          await tgSend(env, chat_id, "Cancelled.");
          await showAdminNode(env, chat_id, db, null, state.session);
          return true;
        }
        node.name = newName;
        const nextState = __contentClearContentPending(state.session && state.session.state || {});
        await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, chat_id, "✅ Name updated in draft. Click Save to apply.");
        await showAdminNode(env, chat_id, db, null, state.session);
        return true;
      }

      if (pend.mode === "WELCOME_TEXT") {
        const txt = (m.text && m.text.trim()) || "";
        if (!txt || txt.toLowerCase() === "/done" || txt.toLowerCase() === "/cancel") {
          const nextState = __contentClearContentPending(state.session && state.session.state || {});
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
          await tgSend(env, chat_id, "Cancelled.");
          await showAdminNode(env, chat_id, db, null, state.session);
          return true;
        }
        db.settings = db.settings || {};
        db.settings.welcome = txt;
        const nextState = __contentClearContentPending(state.session && state.session.state || {});
        await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, chat_id, "✅ Welcome text updated in draft. Click Save to apply.");
        await showAdminNode(env, chat_id, db, null, state.session);
        return true;
      }

      if (pend.mode === "ATTACH_MULTI" || pend.mode === "W_ATTACH_MULTI") {
        const isWelcome = pend.mode === "W_ATTACH_MULTI";
        if (isWelcome) ensureWelcomeObj(db);
        const target = isWelcome ? db.settings.welcome_obj : node;
        const counts = pend.count || { files: 0, notes: 0, urls: 0 };
        const newIds = Array.isArray(pend.new_ids) ? pend.new_ids.slice(0, 80) : [];
        let changed = 0;

        if (m.text && m.text.trim().toLowerCase() === "/done" && !isWelcome && newIds.length) {
          await __adminFinishPendingLocked(env, chat_id);   // asks the search name of the new files
          return true;
        }
        if (m.text && (m.text.trim().toLowerCase() === "/done" || m.text.trim().toLowerCase() === "/cancel")) {
          const nextState = __contentClearContentPending(state.session && state.session.state || {});
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
          await tgSend(env, chat_id, `✅ Content attached in draft (${counts.files} files, ${counts.notes} texts, ${counts.urls} links). Click 💾 Save to apply.`);
          if (isWelcome) await showWelcomeManageList(env, chat_id, db);
          else await showAdminNode(env, chat_id, db, null, state.session);
          return true;
        }

        const added = await addAllMediaFromMessage(target, m);
          if (added > 0) {
            counts.files = (counts.files || 0) + added; changed += added;
            if (!isWelcome && target.files && target.files.length) {
              const nid = String(target.files[target.files.length - 1].id);
              if (!newIds.includes(nid) && newIds.length < 80) newIds.push(nid);
            }
          }
          if (m.text && m.text.trim()) {
            const t = m.text.trim();
            target.notes = target.notes || [];
            if (target.notes.indexOf(t) === -1) {
              target.notes.push(t);
              counts.notes = (counts.notes || 0) + 1;
              changed++;
            }
            const links = extractLinks(t);
            if (links.length) {
              target.urls = target.urls || [];
              for (const link of links) {
                if (target.urls.indexOf(link) === -1) {
                  target.urls.push(link);
                  counts.urls = (counts.urls || 0) + 1;
                  changed++;
                }
              }
            }
          }
          ensureDisplay(target);

        // Keep the control panel BELOW the files the admin just sent: a fresh panel is posted under the
        // newest file and the old one is removed. Updates arriving within 2.5 s (albums, bursts) just
        // edit that panel in place, so a batch of files never floods the chat.
        const progressText = changed > 0
          ? `📥 Attached to draft (files: ${counts.files}, notes: ${counts.notes}, urls: ${counts.urls}).\nSend more, or press ✅ Done.`
          : "⚠️ Unrecognized content. Send a file, text or link, or press ✅ Done.";
        let panelMid = Number(pend.panel_mid || __panelMid(chat_id)) || 0;
        let panelTs = Number(pend.panel_ts) || 0;
        let editInPlace = true;
        if (!panelMid || (Date.now() - panelTs) >= 2500) {
          const fresh = await tgSend(env, chat_id, progressText, { reply_markup: __pendingKb(true), noScope: true });
          if (fresh && fresh.ok && fresh.result && fresh.result.message_id) {
            const oldMid = panelMid;
            panelMid = Number(fresh.result.message_id); panelTs = Date.now(); editInPlace = false;
            const sc2 = ADMIN_SCOPES.get(String(chat_id)); if (sc2) { sc2.mid = panelMid; sc2.shown = true; }
            ADMIN_LAST_PANEL.set(String(chat_id), panelMid);
            if (oldMid) __deleteMessageBg(env, bag, chat_id, oldMid);
          }
        }
        const nextState = { ...(state.session && state.session.state || {}), pending: { panel_mid: panelMid || undefined, panel_ts: panelTs || undefined, mode: pend.mode, count: counts, target_node_id: pend.target_node_id, new_ids: isWelcome ? undefined : newIds } };
        await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        if (editInPlace) await tgSend(env, chat_id, progressText, { reply_markup: __pendingKb(true) });
        return true;
      }

      if (pend.mode === "EDIT_CAP_DRAFT" || pend.mode === "W_EDIT_CAP_DRAFT") {
        const t = (m.text || "").trim();
        if (!t || (t.toLowerCase() === "/done" || t.toLowerCase() === "/cancel")) {
          const nextState = __contentClearContentPending(state.session && state.session.state || {});
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
          await tgSend(env, chat_id, "Cancelled.");
          if (pend.mode === "W_EDIT_CAP_DRAFT") await showWelcomeManageList(env, chat_id, db);
          else await showManageList(env, chat_id, db);
          return true;
        }
        const tgt = pend.target || {};
        const idx = Number(tgt.fileIndex);
        const files = (pend.mode === "W_EDIT_CAP_DRAFT" ? db.settings.welcome_obj.files : node.files);
        if (!Array.isArray(files) || !files[idx]) {
          await tgSend(env, chat_id, "Unable to find file.");
          return true;
        }
        files[idx].caption = t;
        const nextState = __contentClearContentPending(state.session && state.session.state || {});
        await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
        if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        await tgSend(env, chat_id, "✅ Caption updated in draft. Click Save to apply.");
        if (pend.mode === "W_EDIT_CAP_DRAFT") await showWelcomeManageList(env, chat_id, db);
        else await showManageList(env, chat_id, db);
        return true;
      }

      if (pend.mode === "SEARCH_NAME_Q" || pend.mode === "SEARCH_NAME_DRAFT") {
        const isQ = pend.mode === "SEARCH_NAME_Q";
        const raw = (m.text || "").trim();
        const low = raw.toLowerCase();
        const persist = async (nextState) => {
          await __contentSessionPut(env, chat_id, state.base_version, db, state.base_db, { state: nextState, forceActive: true, existingSession: state.session });
          if (state.session) { state.session.state = nextState; state.session.draft = db; state.session.draft_active = true; state.session.revision = Number(state.session.revision || 0) + 1; }
        };
        const clearedState = () => __contentClearContentPending(state.session && state.session.state || {});
        const errText = (why) => "⚠️ " + why + "\n\nExample: " + __SEARCH_SYNTAX_HINT + "  (or: ma lec 2)\nTap ❓ for the list of codes.";

        if (isQ) {
          const queue = Array.isArray(pend.queue) ? pend.queue : [];
          const pos = Math.max(0, Number(pend.pos) || 0);
          const doneBefore = Number(pend.done) || 0;
          const fileId = queue[pos];
          const finish = async (doneN, prefix) => {
            await persist(clearedState());
            await tgSend(env, chat_id, (prefix ? prefix + "\n" : "") + "✅ Search names: " + doneN + " set, " + (queue.length - doneN) + " without.\nClick 💾 Save All Changes to apply.");
            await showAdminNode(env, chat_id, db, null, state.session);
            return true;
          };
          if (low === "/done" || low === "/cancel") return await finish(doneBefore, "");

          let prefix = "", setNow = false;
          if (low === "/skip") prefix = "⏭ Skipped.";
          else if (!raw) {
            await tgSend(env, chat_id, "⚠️ Please send the search name as text, or tap ⏭ Skip.", { reply_markup: __searchPromptKb(), noScope: true });
            return true;
          } else {
            const r = parseAdminSearchInput(raw);
            if (!r.ok) { await tgSend(env, chat_id, errText(r.error), { reply_markup: __searchPromptKb(), noScope: true }); return true; }
            const qf = fileId ? (node.files || []).find(x => String(x.id) === String(fileId)) : null;
            if (qf) { __setFileSearch(qf, r.name, r.meta); __bumpDraftRev(db); setNow = true; }
            prefix = "✅ " + describeMeta(r.meta) + (r.warnings && r.warnings.length ? "\n⚠️ " + r.warnings.join("\n⚠️ ") : "");
          }
          const doneN = doneBefore + (setNow ? 1 : 0);
          const nextPos = pos + 1;
          if (nextPos >= queue.length) return await finish(doneN, prefix);
          const nextState = { ...(state.session && state.session.state || {}), pending: { ...pend, pos: nextPos, done: doneN } };
          await persist(nextState);
          await __searchPromptSend(env, chat_id, node, queue[nextPos], nextPos + 1, queue.length, prefix);
          return true;
        }

        // SEARCH_NAME_DRAFT: edit one existing file from 🗂 Manage content
        const idx = Number((pend.target || {}).fileIndex);
        const f = Array.isArray(node.files) ? node.files[idx] : null;
        if (!raw || low === "/cancel" || low === "/done") {
          await persist(clearedState());
          await tgSend(env, chat_id, "Cancelled.");
          await showManageList(env, chat_id, db);
          return true;
        }
        if (!f) { await tgSend(env, chat_id, "Unable to find file."); return true; }
        if (raw === "-" || low === "/clear") {
          __setFileSearch(f, null, null); __bumpDraftRev(db);
          await persist(clearedState());
          await tgSend(env, chat_id, "🧹 Search name removed in draft. Click Save to apply.");
          await showManageList(env, chat_id, db);
          return true;
        }
        const r = parseAdminSearchInput(raw);
        if (!r.ok) { await tgSend(env, chat_id, errText(r.error), { reply_markup: __pendingKb(false), noScope: true }); return true; }
        __setFileSearch(f, r.name, r.meta); __bumpDraftRev(db);
        await persist(clearedState());
        await tgSend(env, chat_id, "✅ Search name set in draft: " + describeMeta(r.meta) + (r.warnings && r.warnings.length ? "\n⚠️ " + r.warnings.join("\n⚠️ ") : "") + "\nClick Save to apply.");
        await showManageList(env, chat_id, db);
        return true;
      }

      return false;
    } catch (err) {
      console.error("ADMIN_PENDING_ERROR:", err);
      await tgSend(env, chat_id, "⚠️ Error processing input. Please try again.");
      return true;
    }
  }
}

/* ============================================================================
   MANAGED TELEGRAM POLL CAMPAIGNS
   ============================================================================
   Design:
     - /poll creates ONE logical campaign for the bot audience.
     - Telegram sendPoll must be called once per private user, so every user
       receives a real interactive native poll in their own chat.
     - Every delivery gets its own Telegram poll_id and is ONE row in bot_polls
       (campaign_id + recipient_user_id + the recipient's answer).
     - poll_answer updates are stored on that row, then the admin UI aggregates
       them by campaign.
     - REQUIRED_CHAT_ID is completely unrelated to poll delivery.
     - POLL_CHAT_ID is intentionally ignored here; polls are delivered to the
       users table (non-blocked bot users).
     - Delivery is batched to stay within Worker/Telegram request limits.
============================================================================ */
let MANAGED_POLL_SCHEMA_READY = false;
let MANAGED_POLL_SCHEMA_IN_FLIGHT = null;

const POLL_BATCH_SIZE = 15;
const POLL_SEND_DELAY_MS = 150;
const POLL_TRANSIENT_BACKOFF_SEC = 60;

async function ensureManagedPollSchema(env) {
  if (env && env.SCHEMA_MANAGED === "1") MANAGED_POLL_SCHEMA_READY = true;
  if (MANAGED_POLL_SCHEMA_READY) return;
  if (MANAGED_POLL_SCHEMA_IN_FLIGHT) return MANAGED_POLL_SCHEMA_IN_FLIGHT;
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding missing");

  MANAGED_POLL_SCHEMA_IN_FLIGHT = (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS bot_poll_campaigns (
        campaign_id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'regular',
        allows_multiple_answers INTEGER NOT NULL DEFAULT 0,
        correct_option_ids_json TEXT NOT NULL DEFAULT '[]',
        created_by INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('running','paused','done','closed')),
        last_user_id INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        total_users INTEGER NOT NULL DEFAULT 0,
        failed_user_id INTEGER,
        paused_until INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      ) STRICT
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS bot_polls (
        poll_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        recipient_user_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'regular',
        allows_multiple_answers INTEGER NOT NULL DEFAULT 0,
        allows_revoting INTEGER NOT NULL DEFAULT 1,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        is_closed INTEGER NOT NULL DEFAULT 0,
        answer_json TEXT,
        answered_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (campaign_id) REFERENCES bot_poll_campaigns(campaign_id) ON DELETE CASCADE
      ) STRICT
    `).run();

    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_polls_campaign_user ON bot_polls(campaign_id, recipient_user_id)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_bot_poll_campaigns_created ON bot_poll_campaigns(created_at DESC)`).run();

    MANAGED_POLL_SCHEMA_READY = true;
  })();
  try { await MANAGED_POLL_SCHEMA_IN_FLIGHT; }
  finally { MANAGED_POLL_SCHEMA_IN_FLIGHT = null; }
}

function parseManagedPollCommand(rawText) {
  let raw = String(rawText || "").trim();
  raw = raw.replace(/^\/poll(?:@[^\s]+)?\s*/i, "");
  if (!raw) return null;

  const pieces = raw.split("|").map(s => s.trim());
  if (pieces.length < 3) return null;

  const question = pieces.shift();
  const flags = new Set();
  let correctIds = [];
  const options = [];

  for (const p0 of pieces) {
    const p = String(p0 || "").trim();
    if (!p) continue;
    if (/^#multi$/i.test(p)) { flags.add("multi"); continue; }
    if (/^#quiz$/i.test(p)) { flags.add("quiz"); continue; }
    const m = p.match(/^#correct\s*=\s*([0-9,\s]+)$/i);
    if (m) {
      correctIds = String(m[1]).split(",").map(x => parseInt(x.trim(), 10)).filter(Number.isInteger);
      continue;
    }
    options.push(p);
  }

  if (!question || question.length > 300) return null;
  if (options.length < 2 || options.length > 12) return null;
  if (options.some(x => x.length < 1 || x.length > 100)) return null;

  const quiz = flags.has("quiz");
  const multi = flags.has("multi");
  const normalizedCorrect = [...new Set(correctIds.map(i => i - 1))]
    .filter(i => i >= 0 && i < options.length)
    .sort((a,b) => a-b);
  if (quiz && !normalizedCorrect.length) return null;

  return {
    question,
    options,
    type: quiz ? "quiz" : "regular",
    allowsMultiple: multi,
    correctOptionIds: normalizedCorrect
  };
}

function newPollCampaignId() {
  return "pc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

async function d1PollCampaignGet(env, campaignId) {
  await ensureManagedPollSchema(env);
  return await env.SQL.prepare("SELECT * FROM bot_poll_campaigns WHERE campaign_id=?1 LIMIT 1").bind(String(campaignId)).first();
}

async function d1PollCampaignUpdate(env, campaignId, mutateFn) {
  await ensureManagedPollSchema(env);
  const cid = String(campaignId || "");
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.SQL.prepare("SELECT * FROM bot_poll_campaigns WHERE campaign_id=?1 LIMIT 1").bind(cid).first();
    if (!row) return null;
    const next = await mutateFn({ ...row });
    if (!next) return null;
    const now = Math.floor(Date.now() / 1000);
    const expected = Number(row.revision) || 1;
    const upd = await env.SQL.prepare(`
      UPDATE bot_poll_campaigns
      SET status=?2,last_user_id=?3,sent=?4,skipped=?5,total_users=?6,failed_user_id=?7,
          paused_until=?8,error_text=?9,updated_at=?10,revision=revision+1
      WHERE campaign_id=?1 AND revision=?11
    `).bind(
      cid, String(next.status || row.status || "running"), Number(next.last_user_id) || 0,
      Number(next.sent) || 0, Number(next.skipped) || 0, Number(next.total_users) || 0,
      Number(next.failed_user_id) || null, Number(next.paused_until) || 0,
      next.error_text ?? null, now, expected
    ).run();
    if (Number(upd?.meta?.changes || 0) === 1) {
      return {
        ...row,
        status: String(next.status || row.status || "running"),
        last_user_id: Number(next.last_user_id) || 0,
        sent: Number(next.sent) || 0,
        skipped: Number(next.skipped) || 0,
        total_users: Number(next.total_users) || 0,
        failed_user_id: Number(next.failed_user_id) || null,
        paused_until: Number(next.paused_until) || 0,
        error_text: next.error_text ?? null,
        updated_at: now,
        revision: expected + 1
      };
    }
  }
  throw new Error("POLL_CAMPAIGN_CONCURRENT_STATE_UPDATE");
}

async function d1PollCampaignCountUsers(env) {
  const row = await env.SQL.prepare("SELECT COUNT(*) AS total FROM users WHERE is_blocked=0").first();
  return Number(row?.total) || 0;
}

async function d1ListPollCampaignUsers(env, afterId, limit) {
  const lim = Math.max(1, Math.min(POLL_BATCH_SIZE, Number(limit) || POLL_BATCH_SIZE));
  const aid = Number(afterId) || 0;
  const { results } = await env.SQL.prepare(`
    SELECT user_id,username,first_name,last_name
    FROM users
    WHERE is_blocked=0 AND user_id>?1
    ORDER BY user_id ASC
    LIMIT ?2
  `).bind(aid, lim).all();
  return results || [];
}

async function pollTelegramCall(env, payload) {
  try {
    const res = await tgFetchWithTimeout(TG(env) + "/sendPoll", {
      method: "POST",
      headers: CTH,
      body: JSON.stringify(payload)
    }, 10000);
    const data = await res.json().catch(() => null);
    const errorCode = Number(data?.error_code || 0);
    const retryAfter = Number(data?.parameters?.retry_after || 0);
    if (res.ok && data?.ok && data?.result?.poll?.id) {
      return { ok: true, data, status: res.status };
    }
    const permanent = errorCode === 400 || errorCode === 403;
    return {
      ok: false,
      retryable: !permanent,
      status: res.status,
      errorCode,
      retryAfter,
      reason: String(data?.description || `Telegram ${res.status}`)
    };
  } catch (e) {
    return { ok: false, retryable: true, reason: String(e?.message || e || "Network error") };
  }
}

async function deliverPollToUser(env, campaign, user) {
  const uid = Number(user?.user_id) || 0;
  if (!uid) return { ok: false, retryable: false, reason: "invalid-user-id" };

  let options = [];
  try { options = JSON.parse(String(campaign.options_json || "[]")); } catch (_) { options = []; }
  if (!Array.isArray(options) || options.length < 2) {
    return { ok: false, retryable: false, reason: "invalid-poll-options" };
  }

  let correctOptionIds = [];
  try { correctOptionIds = JSON.parse(String(campaign.correct_option_ids_json || "[]")); } catch (_) { correctOptionIds = []; }
  if (!Array.isArray(correctOptionIds)) correctOptionIds = [];

  const payload = {
    chat_id: uid,
    question: String(campaign.question || ""),
    options: options.map(text => ({ text: String(text) })),
    is_anonymous: false,
    type: String(campaign.type || "regular"),
    allows_multiple_answers: Number(campaign.allows_multiple_answers) === 1,
    allows_revoting: String(campaign.type || "regular") === "quiz" ? false : true
  };
  if (payload.type === "quiz") payload.correct_option_ids = correctOptionIds;

  // Idempotency: if this recipient already has a poll for this campaign (e.g. a previous batch
  // crashed before its checkpoint), do not send a second poll.
  try {
    const existing = await env.SQL.prepare("SELECT 1 AS x FROM bot_polls WHERE campaign_id=?1 AND recipient_user_id=?2 LIMIT 1")
      .bind(String(campaign.campaign_id), uid).first();
    if (existing) return { ok: true, duplicate: true };
  } catch (_) {}

  const result = await pollTelegramCall(env, payload);
  if (!result.ok) return result;

  const telegramMessage = result.data && result.data.result;
  const poll = telegramMessage && telegramMessage.poll;
  const messageId = Number(telegramMessage && telegramMessage.message_id) || 0;
  if (!poll || !poll.id || !messageId) {
    return { ok: false, retryable: true, reason: "Telegram sendPoll returned an unexpected response shape." };
  }
  const now = Math.floor(Date.now() / 1000);

  // The poll IS delivered at this point. A bookkeeping failure must not abort the whole batch
  // (which would re-send polls on retry); it only means answers to this one poll are not tracked.
  try {
  await env.SQL.prepare(`
    INSERT OR IGNORE INTO bot_polls
      (poll_id,campaign_id,recipient_user_id,question,options_json,type,allows_multiple_answers,allows_revoting,message_id,created_at,is_closed,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?10)
  `).bind(
    String(poll.id),
    String(campaign.campaign_id),
    uid,
    String(poll.question || campaign.question || ""),
    JSON.stringify(options),
    String(campaign.type || "regular"),
    Number(campaign.allows_multiple_answers) === 1 ? 1 : 0,
    poll.allows_revoting === false ? 0 : 1,
    messageId,
    now,
    poll.is_closed ? 1 : 0
  ).run();
  } catch (e) {
    console.error("POLL_BOOKKEEPING_ERROR:", e && e.message ? e.message : String(e));
    return { ok: true, untracked: true };
  }

  return { ok: true };
}

async function createManagedPollFromCommand(env, rawText, adminId) {
  const spec = parseManagedPollCommand(rawText);
  if (!spec) {
    return {
      message: "⚠️ Invalid format.\n\n/poll Question | Option 1 | Option 2 | ... [#multi] [#quiz] [#correct=1,3]",
      parse_mode: undefined
    };
  }

  await ensureManagedPollSchema(env);
  const total = await d1PollCampaignCountUsers(env);
  if (!total) {
    return { message: "⚠️ No active users are available for poll delivery yet." };
  }

  const campaignId = newPollCampaignId();
  const now = Math.floor(Date.now() / 1000);
  await env.SQL.prepare(`
    INSERT INTO bot_poll_campaigns
      (campaign_id,question,options_json,type,allows_multiple_answers,correct_option_ids_json,created_by,status,last_user_id,sent,skipped,total_users,failed_user_id,paused_until,error_text,created_at,updated_at,revision)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'running',0,0,0,?8,NULL,0,NULL,?9,?9,1)
  `).bind(
    campaignId,
    spec.question,
    JSON.stringify(spec.options),
    spec.type,
    spec.allowsMultiple ? 1 : 0,
    JSON.stringify(spec.correctOptionIds),
    Number(adminId) || 0,
    total,
    now
  ).run();

  await processPollCampaignBatch(env, campaignId, POLL_BATCH_SIZE);
  const fresh = await d1PollCampaignGet(env, campaignId);
  return {
    message:
      `✅ <b>Poll campaign created.</b>\n\n` +
      `Question: ${htmlEscape(spec.question)}\n` +
      `👥 Audience: <b>${total}</b>\n` +
      `📨 Sent: <b>${Number(fresh?.sent) || 0}</b>\n` +
      `↪️ Skipped: <b>${Number(fresh?.skipped) || 0}</b>\n` +
      `📌 Status: <b>${String(fresh?.status || "running")}</b>\n\n` +
      `The bot sends a separate native poll to each active user so I can know exactly who chose what.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 View Responses", callback_data: `A|POLL_DETAILS|${campaignId}|1` }],
        [{ text: "⏩ Run Next", callback_data: `A|POLL_TICK|${campaignId}` }, { text: "📌 Status", callback_data: `A|POLL_STATUS|${campaignId}` }]
      ]
    }
  };
}

async function processPollCampaignBatch(env, campaignId, perBatch = POLL_BATCH_SIZE) {
  const campaign = await d1PollCampaignGet(env, campaignId);
  if (!campaign) return { ok: false, reason: "Poll campaign not found." };
  const nowSec = Math.floor(Date.now() / 1000);
  if (campaign.status === "paused" && Number(campaign.paused_until) > nowSec) {
    return { ok: false, paused: true, reason: `Retry in ${Number(campaign.paused_until) - nowSec}s.`, totalSent: Number(campaign.sent) || 0, totalSkipped: Number(campaign.skipped) || 0 };
  }
  if (campaign.status !== "running") return { ok: false, reason: `Poll campaign is ${campaign.status}.` };

  const batchSize = Math.max(1, Math.min(POLL_BATCH_SIZE, Number(perBatch) || POLL_BATCH_SIZE));
  const users = await d1ListPollCampaignUsers(env, campaign.last_user_id || 0, batchSize);
  if (!users.length) {
    const done = await d1PollCampaignUpdate(env, campaignId, current => ({ ...current, status: "done", paused_until: 0, failed_user_id: null, error_text: null }));
    return { ok: true, done: true, totalSent: Number(done?.sent) || 0, totalSkipped: Number(done?.skipped) || 0 };
  }

  let sentNow = 0;
  let skippedNow = 0;
  let lastProcessed = Number(campaign.last_user_id) || 0;
  let sinceCheckpoint = 0, sysFailStreak = 0, sysFailReason = "", brokeEarly = false;
  const batchStart = Date.now();

  const checkpoint = async () => {
    if (!sinceCheckpoint) return null;
    const s = sentNow, k = skippedNow, last = lastProcessed;
    const upd = await d1PollCampaignUpdate(env, campaignId, current => ({
      ...current, status: "running", last_user_id: last,
      sent: Number(current.sent || 0) + s, skipped: Number(current.skipped || 0) + k,
      failed_user_id: null, paused_until: 0, error_text: null
    }));
    sentNow = 0; skippedNow = 0; sinceCheckpoint = 0;
    return upd;
  };

  for (const user of users) {
    if (Date.now() - batchStart > 60 * 1000) { brokeEarly = true; break; }
    const result = await deliverPollToUser(env, campaign, user);
    if (result.ok) {
      sentNow++; sinceCheckpoint++; sysFailStreak = 0;
      lastProcessed = Number(user.user_id);
    } else if (!result.retryable) {
      // A failure that is not about this particular user must stop the campaign, not skip everyone.
      const userSpecific = Number(result.errorCode) === 403 || /chat not found|user is deactivated|bot was blocked|PEER_ID_INVALID|not enough rights|can't initiate|have no rights|kicked/i.test(String(result.reason || ""));
      if (!userSpecific) {
        sysFailStreak = (sysFailReason === result.reason) ? sysFailStreak + 1 : 1;
        sysFailReason = String(result.reason || "");
        if (sysFailStreak >= 3) {
          await checkpoint();
          const stopped = await d1PollCampaignUpdate(env, campaignId, current => ({
            ...current, status: "paused", paused_until: 0, failed_user_id: Number(user.user_id),
            error_text: ("Stopped: Telegram rejects this poll for every user — " + sysFailReason).slice(0, 300)
          }));
          return { ok: false, paused: true, reason: "Stopped automatically: " + sysFailReason, totalSent: Number(stopped?.sent) || 0, totalSkipped: Number(stopped?.skipped) || 0 };
        }
      } else { sysFailStreak = 0; }
      skippedNow++; sinceCheckpoint++;
      lastProcessed = Number(user.user_id);
    } else {
      const retryAfter = Math.max(POLL_TRANSIENT_BACKOFF_SEC, Number(result.retryAfter) || 0);
      const paused = await d1PollCampaignUpdate(env, campaignId, current => ({
        ...current,
        status: "paused",
        last_user_id: lastProcessed,
        sent: Number(current.sent || 0) + sentNow,
        skipped: Number(current.skipped || 0) + skippedNow,
        failed_user_id: Number(user.user_id),
        paused_until: Math.floor(Date.now() / 1000) + retryAfter,
        error_text: result.reason || "Retryable Telegram error"
      }));
      return { ok: false, paused: true, reason: result.reason || "Retryable Telegram error", totalSent: Number(paused?.sent) || 0, totalSkipped: Number(paused?.skipped) || 0 };
    }
    if (sinceCheckpoint >= 5) await checkpoint();
    if (POLL_SEND_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, POLL_SEND_DELAY_MS));
  }

  const sentBefore = sentNow;
  let next = (await checkpoint()) || await d1PollCampaignGet(env, campaignId);
  if (!brokeEarly && users.length < batchSize) {
    next = await d1PollCampaignUpdate(env, campaignId, current => ({ ...current, status: "done", paused_until: 0, failed_user_id: null, error_text: null }));
    return { ok: true, done: true, sentNow: sentBefore, totalSent: Number(next?.sent) || 0, totalSkipped: Number(next?.skipped) || 0 };
  }
  return { ok: true, done: false, sentNow: sentBefore, totalSent: Number(next?.sent) || 0, totalSkipped: Number(next?.skipped) || 0 };
}

async function handleManagedPollAnswer(env, answer) {
  if (!answer || !answer.poll_id || !answer.user?.id) return false;
  await ensureManagedPollSchema(env);
  const pollId = String(answer.poll_id);
  const uid = Number(answer.user.id) || 0;
  if (!uid) return false;
  const optionIds = Array.isArray(answer.option_ids)
    ? [...new Set(answer.option_ids.map(v => Number(v)).filter(v => Number.isInteger(v) && v >= 0))]
    : [];
  const now = Math.floor(Date.now() / 1000);

  // One UPDATE: only the recipient of this poll can answer it, and only polls we created exist here.
  const res = await env.SQL.prepare(`
    UPDATE bot_polls
       SET answer_json = ?3, answered_at = ?4, updated_at = ?5
     WHERE poll_id = ?1 AND recipient_user_id = ?2
  `).bind(pollId, uid, optionIds.length ? JSON.stringify(optionIds) : null, optionIds.length ? now : null, now).run();
  return Number(res?.meta?.changes || 0) === 1;
}

async function handleManagedPollState(env, poll) {
  if (!poll?.id) return false;
  await ensureManagedPollSchema(env);
  const now = Math.floor(Date.now() / 1000);
  await env.SQL.prepare(`
    UPDATE bot_polls
    SET question=?2, options_json=?3, is_closed=?4, updated_at=?5
    WHERE poll_id=?1
  `).bind(
    String(poll.id),
    String(poll.question || ""),
    JSON.stringify((poll.options || []).map(o => String(o.text || ""))),
    poll.is_closed ? 1 : 0,
    now
  ).run();
  return true;
}

function managedPollName(vote) {
  const first = String(vote?.first_name || "").trim();
  const last = String(vote?.last_name || "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full || (vote?.username ? `@${String(vote.username).trim()}` : `User ${vote?.user_id || "?"}`);
}

function managedPollUserHtml(vote) {
  const name = htmlEscape(managedPollName(vote));
  const uid = Number(vote?.user_id) || 0;
  const username = String(vote?.username || "").trim();
  const label = uid ? `<a href="tg://user?id=${uid}">${name}</a>` : name;
  return username ? `${label} <code>@${htmlEscape(username)}</code>` : label;
}

function formatPollCampaignResult(r) {
  if (!r) return "⚠️ Poll operation failed.";
  if (r.done) return `✅ Poll delivery completed.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}`;
  if (r.paused) return `⏸️ Poll delivery paused.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}\n${r.reason || "A retryable Telegram error occurred."}`;
  if (!r.ok) return `⚠️ ${r.reason || "Poll operation failed."}`;
  return `🚀 Poll batch complete.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}`;
}

async function showManagedPollList(env, chatId, page = 1) {
  await ensureManagedPollSchema(env);
  const perPage = 8;
  const currentPage = Math.max(1, Number(page) || 1);
  const totalRow = await env.SQL.prepare("SELECT COUNT(*) AS c FROM bot_poll_campaigns").first();
  const total = Number(totalRow?.c) || 0;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(currentPage, pages);
  const { results } = await env.SQL.prepare(`
    SELECT c.campaign_id,c.question,c.status,c.sent,c.skipped,c.total_users,c.created_at,
           (SELECT COUNT(*) FROM bot_polls p
             WHERE p.campaign_id=c.campaign_id AND p.answer_json IS NOT NULL) AS voters
    FROM bot_poll_campaigns c
    ORDER BY c.created_at DESC
    LIMIT ?1 OFFSET ?2
  `).bind(perPage, (safePage - 1) * perPage).all();

  const rows = [];
  for (const c of results || []) {
    const state = c.status === "done" ? "✅" : (c.status === "paused" ? "⏸️" : (c.status === "closed" ? "🛑" : "🟢"));
    const question = String(c.question || "Untitled");
    rows.push([{ text: `${state} ${question.slice(0, 38)} · ${Number(c.voters) || 0}`, callback_data: `A|POLL_DETAILS|${String(c.campaign_id)}|1` }]);
  }
  if (safePage > 1 || safePage < pages) {
    const nav = [];
    if (safePage > 1) nav.push({ text: "« Prev", callback_data: `A|POLL_LIST|${safePage - 1}` });
    if (safePage < pages) nav.push({ text: "Next »", callback_data: `A|POLL_LIST|${safePage + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: "➕ Create Poll", callback_data: "A|POLL_HELP" }]);
  rows.push([{ text: "⬅️ Back to Main Menu", callback_data: "A|HOME" }]);
  const text = `📊 <b>Poll Campaigns</b>\n\n${total ? `Page ${safePage}/${pages}` : "No poll campaigns yet."}`;
  await tgSend(env, chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows }, skipBlockCheck: true });
}

async function showManagedPollDetails(env, chatId, campaignId, page = 1) {
  await ensureManagedPollSchema(env);
  const campaign = await d1PollCampaignGet(env, campaignId);
  if (!campaign) {
    await tgSend(env, chatId, "⚠️ Poll campaign not found.", { skipBlockCheck: true });
    return;
  }

  let options = [];
  try { options = JSON.parse(String(campaign.options_json || "[]")); } catch (_) { options = []; }
  if (!Array.isArray(options)) options = [];

  const totalVoterRow = await env.SQL.prepare(`
    SELECT COUNT(*) AS c
    FROM bot_polls
    WHERE campaign_id=?1 AND answer_json IS NOT NULL
  `).bind(String(campaignId)).first();
  const totalVoters = Number(totalVoterRow?.c) || 0;
  const perPage = 12;
  const pages = Math.max(1, Math.ceil(totalVoters / perPage));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);

  const { results } = await env.SQL.prepare(`
    SELECT p.recipient_user_id AS user_id, u.username, u.first_name, u.last_name,
           p.answer_json AS option_ids_json, p.answered_at AS updated_at
    FROM bot_polls p
    LEFT JOIN users u ON u.user_id = p.recipient_user_id
    WHERE p.campaign_id=?1 AND p.answer_json IS NOT NULL
    ORDER BY p.answered_at DESC, p.recipient_user_id ASC
    LIMIT ?2 OFFSET ?3
  `).bind(String(campaignId), perPage, (safePage - 1) * perPage).all();

  const processed = (Number(campaign.sent) || 0) + (Number(campaign.skipped) || 0);
  const progress = Number(campaign.total_users) > 0 ? `${processed}/${Number(campaign.total_users)}` : `${processed}`;
  const lines = [
    "📊 <b>Poll Responses</b>",
    "",
    `❓ ${htmlEscape(String(campaign.question || ""))}`,
    `📨 Delivery: <b>${progress}</b>`,
    `✅ Sent: <b>${Number(campaign.sent) || 0}</b>`,
    `↪️ Skipped: <b>${Number(campaign.skipped) || 0}</b>`,
    `👥 Voters: <b>${totalVoters}</b>`,
    `📌 Status: <b>${htmlEscape(String(campaign.status || "running"))}</b>`,
    ""
  ];

  for (const vote of (results || [])) {
    let ids = [];
    try { ids = JSON.parse(String(vote.option_ids_json || "[]")); } catch (_) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    const labels = ids.map(i => options[Number(i)]).filter(Boolean).map(htmlEscape);
    const answerLabel = labels.length ? labels.join(" + ") : "—";
    lines.push(`• ${managedPollUserHtml(vote)} → <b>${answerLabel}</b>`);
  }
  if (!results?.length && totalVoters === 0) lines.push("No one has answered yet.");
  lines.push("", `Page ${safePage}/${pages}`);

  const nav = [];
  if (safePage > 1) nav.push({ text: "« Prev", callback_data: `A|POLL_DETAILS|${String(campaignId)}|${safePage - 1}` });
  if (safePage < pages) nav.push({ text: "Next »", callback_data: `A|POLL_DETAILS|${String(campaignId)}|${safePage + 1}` });
  const rows = [];
  if (nav.length) rows.push(nav);
  const actionRow = [];
  if (campaign.status === "running") actionRow.push({ text: "⏸️ Pause", callback_data: `A|POLL_PAUSE|${String(campaignId)}` });
  if (campaign.status === "paused") actionRow.push({ text: "▶️ Resume", callback_data: `A|POLL_RESUME|${String(campaignId)}` });
  if (campaign.status === "running" || campaign.status === "paused") actionRow.push({ text: "⏩ Run Next", callback_data: `A|POLL_TICK|${String(campaignId)}` });
  if (actionRow.length) rows.push(actionRow);
  rows.push([{ text: "🔄 Refresh", callback_data: `A|POLL_DETAILS|${String(campaignId)}|${safePage}` }, { text: "📊 All Polls", callback_data: "A|POLL_LIST|1" }]);
  rows.push([{ text: "⬅️ Back to Main Menu", callback_data: "A|HOME" }]);

  await tgSend(env, chatId, lines.join("\n"), { parse_mode: "HTML", reply_markup: { inline_keyboard: rows }, skipBlockCheck: true });
}

async function stopManagedPoll(env, campaignId) {
  await ensureManagedPollSchema(env);
  const campaign = await d1PollCampaignGet(env, campaignId);
  if (!campaign) return { ok: false, reason: "Poll campaign not found." };
  if (campaign.status === "closed") return { ok: true };
  // Closing delivery state is intentionally local: stopping thousands of
  // individual Telegram polls would consume a large number of external calls.
  await env.SQL.prepare("UPDATE bot_poll_campaigns SET status='closed',updated_at=?2,revision=revision+1 WHERE campaign_id=?1")
    .bind(String(campaignId), Math.floor(Date.now() / 1000)).run();
  return { ok: true };
}

async function pollCampaignPause(env, campaignId) {
  const c = await d1PollCampaignGet(env, campaignId);
  if (!c || c.status !== "running") return { ok: false, reason: "Poll campaign is not running." };
  await d1PollCampaignUpdate(env, campaignId, current => ({ ...current, status: "paused", paused_until: 0, error_text: "Paused by admin." }));
  return { ok: true };
}

async function pollCampaignResume(env, campaignId, perBatch = POLL_BATCH_SIZE) {
  const c = await d1PollCampaignGet(env, campaignId);
  if (!c || c.status === "closed" || c.status === "done") return { ok: false, reason: "Poll campaign cannot be resumed." };
  const now = Math.floor(Date.now() / 1000);
  if (c.status === "paused" && Number(c.paused_until) > now) return { ok: false, paused: true, reason: `Retry window has not expired yet (${Number(c.paused_until) - now}s).` };
  await d1PollCampaignUpdate(env, campaignId, current => ({ ...current, status: "running", paused_until: 0, error_text: null }));
  return await processPollCampaignBatch(env, campaignId, perBatch);
}

/* ============================================================================
   BROADCAST & SINGLE-USER MESSAGING HELPERS
   ============================================================================ */
// One D1 job row controls the whole broadcast lifecycle. The Worker sends
// sequentially in conservative batches so the free plan stays well below the
// 50-external-subrequest limit while Telegram receives a gentle send rate.
const BROADCAST_BATCH_SIZE = 20;
const BROADCAST_SEND_DELAY_MS = 120;
const BROADCAST_TRANSIENT_BACKOFF_SEC = 60;
let BROADCAST_SCHEMA_READY = false;
let BROADCAST_SCHEMA_IN_FLIGHT = null;

async function ensureBroadcastSchema(env) {
  if (env && env.SCHEMA_MANAGED === "1") BROADCAST_SCHEMA_READY = true;
  if (BROADCAST_SCHEMA_READY) return;
  if (BROADCAST_SCHEMA_IN_FLIGHT) return BROADCAST_SCHEMA_IN_FLIGHT;
  const db = env.SQL;
  if (!db) throw new Error("D1 Database binding missing");
  BROADCAST_SCHEMA_IN_FLIGHT = (async () => {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS broadcast_jobs (
        admin_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('awaiting_message','ready','running','paused','done')),
        from_chat_id TEXT,
        message_id INTEGER,
        src_text TEXT,
        src_caption TEXT,
        last_user_id INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        total_users INTEGER NOT NULL DEFAULT 0,
        failed_user_id INTEGER,
        paused_until INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      ) STRICT
    `).run();
    BROADCAST_SCHEMA_READY = true;
  })();
  try { await BROADCAST_SCHEMA_IN_FLIGHT; } finally { BROADCAST_SCHEMA_IN_FLIGHT = null; }
}

const BROADCAST_JOB_READ_CACHE = new Map();
const BROADCAST_JOB_CACHE_TTL_MS = 1200;
function broadcastJobCacheKey(adminId) { return String(Number(adminId) || 0); }
function broadcastJobCacheGet(adminId) {
  const k = broadcastJobCacheKey(adminId);
  const hit = BROADCAST_JOB_READ_CACHE.get(k);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { BROADCAST_JOB_READ_CACHE.delete(k); return null; }
  return hit.value;
}
function broadcastJobCacheSet(adminId, value) {
  BROADCAST_JOB_READ_CACHE.set(broadcastJobCacheKey(adminId), { value, expiresAt: Date.now() + BROADCAST_JOB_CACHE_TTL_MS });
  return value;
}
function broadcastJobCacheInvalidate(adminId) { BROADCAST_JOB_READ_CACHE.delete(broadcastJobCacheKey(adminId)); }

async function d1BroadcastGet(env, admin_id) {
  await ensureBroadcastSchema(env);
  const aid = Number(admin_id) || 0;
  const cached = broadcastJobCacheGet(aid);
  if (cached !== null) return cached;
  const row = await env.SQL.prepare("SELECT * FROM broadcast_jobs WHERE admin_id=?1 LIMIT 1").bind(aid).first();
  if (row) return broadcastJobCacheSet(aid, row);
  if (row) return row;

  // One-time compatibility migration for the old broadcast state that used to
  // live inside content_sessions.state_json. New broadcast operations never use
  // that shared state again.
  try {
    const legacyRow = await env.SQL.prepare("SELECT state_json FROM content_sessions WHERE admin_id=?1 LIMIT 1").bind(aid).first();
    if (!legacyRow?.state_json) return null;
    let legacy = {};
    try { legacy = JSON.parse(String(legacyRow.state_json)) || {}; } catch (_) { legacy = {}; }
    const old = legacy.broadcast || null;
    const pending = legacy.pending && legacy.pending.kind === "broadcast";
    if (!old && !pending) return null;

    const status = pending
      ? "awaiting_message"
      : (old.done ? "done" : (old.running ? "running" : "ready"));
    const total = Number(old?.total_users) || 0;
    const migrated = {
      admin_id: aid,
      status,
      from_chat_id: old?.from_chat_id ?? old?.msg_chat_id ?? null,
      message_id: Number(old?.message_id || old?.msg_id || 0) || null,
      src_text: old?.src_text ?? null,
      src_caption: old?.src_caption ?? null,
      last_user_id: Number(old?.last_user_id) || 0,
      sent: Number(old?.sent) || 0,
      skipped: Number(old?.skipped) || 0,
      total_users: total,
      failed_user_id: null,
      paused_until: 0,
      error_text: null,
      started_at: Number(old?.started_at) || null
    };
    const nowSec = Math.floor(Date.now() / 1000);
    await env.SQL.prepare(`
      INSERT INTO broadcast_jobs
        (admin_id,status,from_chat_id,message_id,src_text,src_caption,last_user_id,sent,skipped,total_users,failed_user_id,paused_until,error_text,started_at,updated_at,revision)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,0,NULL,?11,?12,1)
      ON CONFLICT(admin_id) DO NOTHING
    `).bind(
      aid, migrated.status, migrated.from_chat_id, migrated.message_id, migrated.src_text, migrated.src_caption,
      migrated.last_user_id, migrated.sent, migrated.skipped, migrated.total_users, migrated.started_at, nowSec
    ).run();
    return broadcastJobCacheSet(aid, await env.SQL.prepare("SELECT * FROM broadcast_jobs WHERE admin_id=?1 LIMIT 1").bind(aid).first());
  } catch (_) {
    return null;
  }
}

async function d1BroadcastUpdate(env, admin_id, mutateFn) {
  await ensureBroadcastSchema(env);
  const aid = Number(admin_id) || 0;
  broadcastJobCacheInvalidate(aid);
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.SQL.prepare("SELECT * FROM broadcast_jobs WHERE admin_id=?1 LIMIT 1").bind(aid).first();
    const current = row || { admin_id: aid, status: "ready", last_user_id: 0, sent: 0, skipped: 0, total_users: 0, paused_until: 0, revision: 1 };
    const next = await mutateFn({ ...current });
    if (!next) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!row) {
      const ins = await env.SQL.prepare(`
        INSERT INTO broadcast_jobs
          (admin_id,status,from_chat_id,message_id,src_text,src_caption,last_user_id,sent,skipped,total_users,failed_user_id,paused_until,error_text,started_at,updated_at,revision)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)
        ON CONFLICT(admin_id) DO NOTHING
      `).bind(
        aid, String(next.status || "ready"), next.from_chat_id ?? null, Number(next.message_id) || null,
        next.src_text ?? null, next.src_caption ?? null, Number(next.last_user_id) || 0, Number(next.sent) || 0,
        Number(next.skipped) || 0, Number(next.total_users) || 0, Number(next.failed_user_id) || null,
        Number(next.paused_until) || 0, next.error_text ?? null, Number(next.started_at) || null, nowSec
      ).run();
      if (Number(ins?.meta?.changes || 0) === 1) return broadcastJobCacheSet(aid, next);
      continue;
    }
    const expected = Number(row.revision) || 1;
    const upd = await env.SQL.prepare(`
      UPDATE broadcast_jobs
      SET status=?2, from_chat_id=?3, message_id=?4, src_text=?5, src_caption=?6, last_user_id=?7,
          sent=?8, skipped=?9, total_users=?10, failed_user_id=?11, paused_until=?12, error_text=?13,
          started_at=?14, updated_at=?15, revision=revision+1
      WHERE admin_id=?1 AND revision=?16
    `).bind(
      aid, String(next.status || "ready"), next.from_chat_id ?? null, Number(next.message_id) || null,
      next.src_text ?? null, next.src_caption ?? null, Number(next.last_user_id) || 0, Number(next.sent) || 0,
      Number(next.skipped) || 0, Number(next.total_users) || 0, Number(next.failed_user_id) || null,
      Number(next.paused_until) || 0, next.error_text ?? null, Number(next.started_at) || null, nowSec, expected
    ).run();
    if (Number(upd?.meta?.changes || 0) === 1) return next;
  }
  throw new Error("BROADCAST_CONCURRENT_STATE_UPDATE");
}

async function d1BroadcastClear(env, admin_id) {
  await ensureBroadcastSchema(env);
  const aid = Number(admin_id) || 0;
  broadcastJobCacheInvalidate(aid);
  await env.SQL.prepare("DELETE FROM broadcast_jobs WHERE admin_id=?1").bind(aid).run();
  broadcastJobCacheInvalidate(aid);
}

async function d1BroadcastCountUsers(env) {
  const row = await env.SQL.prepare("SELECT COUNT(*) AS total FROM users WHERE is_blocked=0").first();
  return Number(row?.total) || 0;
}

async function d1ListBroadcastUsers(env, afterId, limit) {
  const lim = Math.max(1, Math.min(BROADCAST_BATCH_SIZE, Number(limit) || BROADCAST_BATCH_SIZE));
  const aid = Number(afterId) || 0;
  const { results } = await env.SQL.prepare(`
    SELECT user_id, username, first_name, last_name
    FROM users
    WHERE is_blocked=0 AND user_id>?1
    ORDER BY user_id ASC
    LIMIT ?2
  `).bind(aid, lim).all();
  return results || [];
}

function broadcastUsesPersonalization(text) {
  return /#(?:name_link|username|name)\b/i.test(String(text || ""));
}

async function broadcastTelegramCall(env, method, payload) {
  try {
    const res = await tgFetchWithTimeout(TG(env) + "/" + method, { method: "POST", headers: CTH, body: JSON.stringify(payload) }, 10000);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    const errorCode = Number(data?.error_code || 0);
    const retryAfter = Number(data?.parameters?.retry_after || 0);
    if (res.ok && data?.ok !== false) return { ok: true, status: res.status };
    const permanent = errorCode === 400 || errorCode === 403;
    return {
      ok: false,
      status: res.status,
      errorCode,
      retryAfter,
      retryable: !permanent,
      reason: String(data?.description || `Telegram ${res.status}`)
    };
  } catch (e) {
    return { ok: false, retryable: true, reason: String(e?.message || e || "Network error") };
  }
}

async function bcSendOne(env, user, bc) {
  const uid = Number(user?.user_id) || 0;
  if (!uid || !bc?.from_chat_id || !bc?.message_id) return { ok: false, retryable: false, reason: "invalid-broadcast-source" };
  const needsPersonalization = !!(
    (bc.src_text && broadcastUsesPersonalization(bc.src_text)) ||
    (bc.src_caption && broadcastUsesPersonalization(bc.src_caption))
  );

  const fakeFrom = {
    id: uid,
    username: user?.username || "",
    first_name: user?.first_name || "",
    last_name: user?.last_name || ""
  };

  if (needsPersonalization) {
    // Profile data is already present in the users batch query. Never issue a
    // second SELECT users WHERE user_id=? for ordinary broadcasts.
    if (bc.src_text && broadcastUsesPersonalization(bc.src_text)) {
      const html = safeTelegramHtml(personalizeText(bc.src_text, fakeFrom));
      let r = await broadcastTelegramCall(env, "sendMessage", { chat_id: uid, text: html, parse_mode: "HTML" });
      if (!r.ok && /parse entities|can't parse/i.test(String(r.reason || ""))) {
        r = await broadcastTelegramCall(env, "sendMessage", { chat_id: uid, text: stripTelegramHtml(html) });
      }
      return r;
    }

    if (bc.src_caption && broadcastUsesPersonalization(bc.src_caption)) {
      const cap = safeTelegramHtml(personalizeText(bc.src_caption, fakeFrom));
      let r = await broadcastTelegramCall(env, "copyMessage", {
        chat_id: uid, from_chat_id: bc.from_chat_id, message_id: bc.message_id, caption: cap, parse_mode: "HTML"
      });
      if (!r.ok && /parse entities|can't parse/i.test(String(r.reason || ""))) {
        r = await broadcastTelegramCall(env, "copyMessage", {
          chat_id: uid, from_chat_id: bc.from_chat_id, message_id: bc.message_id, caption: stripTelegramHtml(cap)
        });
      }
      return r;
    }
  }

  return await broadcastTelegramCall(env, "copyMessage", {
    chat_id: uid,
    from_chat_id: bc.from_chat_id,
    message_id: bc.message_id
  });
}

function buildBroadcastKb(job) {
  const kb = __buildBroadcastKbCore(job);
  kb.inline_keyboard.push([{ text: "🏠 Main menu", callback_data: "A|BC_HOME" }]);
  return kb;
}

function __buildBroadcastKbCore(job) {
  const status = job?.status || "ready";
  if (status === "awaiting_message") {
    return { inline_keyboard: [[{ text: "🛑 Cancel", callback_data: "A|BC_CANCEL" }]] };
  }
  if (status === "running") {
    return { inline_keyboard: [
      [{ text: "⏸️ Pause", callback_data: "A|BC_PAUSE" }, { text: "⏩ Run Next", callback_data: "A|BC_TICK" }],
      [{ text: "📊 Status", callback_data: "A|BC_STATUS" }, { text: "🛑 Cancel", callback_data: "A|BC_CANCEL" }]
    ] };
  }
  if (status === "paused") {
    return { inline_keyboard: [
      [{ text: "▶️ Resume", callback_data: "A|BC_RESUME" }, { text: "⏩ Run Next", callback_data: "A|BC_TICK" }],
      [{ text: "📊 Status", callback_data: "A|BC_STATUS" }, { text: "🛑 Cancel", callback_data: "A|BC_CANCEL" }]
    ] };
  }
  if (status === "done") {
    return { inline_keyboard: [
      [{ text: "📥 New Message", callback_data: "A|BC_ARM" }],
      [{ text: "📊 Status", callback_data: "A|BC_STATUS" }, { text: "🗑️ Clear", callback_data: "A|BC_CANCEL" }]
    ] };
  }
  return { inline_keyboard: [
    [{ text: "📥 Set Message", callback_data: "A|BC_ARM" }],
    [{ text: "🚀 Start Broadcast", callback_data: "A|BC_SEND" }],
    [{ text: "📊 Status", callback_data: "A|BC_STATUS" }, { text: "🛑 Clear", callback_data: "A|BC_CANCEL" }]
  ] };
}

function formatBroadcastStatus(job) {
  if (!job) return "📣 Broadcast\n\nNo broadcast is configured.";
  const status = String(job.status || "ready");
  const processed = (Number(job.sent) || 0) + (Number(job.skipped) || 0);
  const total = Number(job.total_users) || 0;
  const pct = total > 0 ? Math.min(100, (processed / total) * 100).toFixed(1) : "0.0";
  const lines = [
    "📣 Broadcast Status",
    "",
    `State: ${status}`,
    `Progress: ${processed}/${total || "?"} (${pct}%)`,
    `✅ Sent: ${Number(job.sent) || 0}`,
    `↪️ Skipped: ${Number(job.skipped) || 0}`
  ];
  if (job.failed_user_id) lines.push(`⚠️ Waiting on user: ${job.failed_user_id}`);
  if (Number(job.paused_until) > Math.floor(Date.now() / 1000)) {
    const left = Number(job.paused_until) - Math.floor(Date.now() / 1000);
    lines.push(`⏳ Retry in about ${Math.max(1, left)}s`);
  }
  if (job.error_text) lines.push(`Reason: ${String(job.error_text).slice(0, 180)}`);
  return lines.join("\n");
}

function formatBroadcastResult(r) {
  if (!r) return "⚠️ Broadcast operation failed.";
  if (r.done) return `✅ Broadcast completed.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}`;
  if (r.paused) return `⏸️ Broadcast paused.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}\n${r.reason || "A retryable Telegram error occurred."}`;
  if (!r.ok) return `⚠️ ${r.reason || "Broadcast operation failed."}`;
  return `🚀 Batch complete.\nSent: ${r.totalSent || 0}\nSkipped: ${r.totalSkipped || 0}`;
}

async function showBroadcastMenu(env, chat_id) {
  const job = await d1BroadcastGet(env, chat_id);
  const status = job?.status || "ready";
  const prompt = status === "awaiting_message"
    ? "📣 Send the message/media now."
    : `${formatBroadcastStatus(job)}\n\nChoose an action:`;
  await tgSend(env, chat_id, prompt, { reply_markup: buildBroadcastKb(job) });
}

async function armBroadcastMessage(env, admin_id) {
  const current = await d1BroadcastGet(env, admin_id);
  if (current && current.status === "running") return { ok: false, reason: "Pause the current broadcast before replacing its message." };
  await d1BroadcastUpdate(env, admin_id, job => ({
    ...job,
    status: "awaiting_message",
    from_chat_id: null, message_id: null, src_text: null, src_caption: null,
    last_user_id: 0, sent: 0, skipped: 0, total_users: 0, failed_user_id: null,
    paused_until: 0, error_text: null, started_at: null
  }));
  return { ok: true };
}

async function captureBroadcastMessage(env, admin_id, msg) {
  if (!msg || !msg.message_id || !msg.chat?.id) return { ok: false, reason: "The message was not valid." };
  const text = msg.text != null ? String(msg.text) : null;
  const caption = msg.caption != null ? String(msg.caption) : null;
  const total = await d1BroadcastCountUsers(env);
  await d1BroadcastUpdate(env, admin_id, job => ({
    ...job,
    status: "ready",
    from_chat_id: String(msg.chat.id),
    message_id: Number(msg.message_id),
    src_text: text,
    src_caption: caption,
    last_user_id: 0, sent: 0, skipped: 0, total_users: total,
    failed_user_id: null, paused_until: 0, error_text: null,
    started_at: null
  }));
  return { ok: true };
}

async function startBroadcastJob(env, admin_id) {
  const job = await d1BroadcastGet(env, admin_id);
  if (!job) return { ok: false, reason: "Set a broadcast message first." };
  if (job.status === "awaiting_message") return { ok: false, reason: "Send the broadcast message first." };
  if (job.status === "done") return { ok: false, reason: "This broadcast is already finished. Set a new message to start another one." };
  const nowSec = Math.floor(Date.now() / 1000);
  await d1BroadcastUpdate(env, admin_id, current => ({
    ...current,
    status: "running",
    paused_until: 0,
    error_text: null,
    failed_user_id: null,
    started_at: Number(current.started_at) || nowSec
  }));
  return await processBroadcastBatch(env, admin_id, BROADCAST_BATCH_SIZE);
}

async function pauseBroadcastJob(env, admin_id) {
  const job = await d1BroadcastGet(env, admin_id);
  if (!job || job.status !== "running") return { ok: false, reason: "Broadcast is not running." };
  await d1BroadcastUpdate(env, admin_id, current => ({ ...current, status: "paused", paused_until: 0, error_text: "Paused by admin." }));
  return { ok: true };
}

async function resumeAndRunBroadcastBatch(env, admin_id, perBatch) {
  const job = await d1BroadcastGet(env, admin_id);
  if (!job) return { ok: false, reason: "Set a broadcast message first." };
  if (job.status === "done") return { ok: false, reason: "Broadcast is already complete." };
  const nowSec = Math.floor(Date.now() / 1000);
  if (job.status === "paused" && Number(job.paused_until) > nowSec) {
    return { ok: false, paused: true, reason: `Retry window has not expired yet (${Number(job.paused_until) - nowSec}s).` };
  }
  await d1BroadcastUpdate(env, admin_id, current => ({ ...current, status: "running", paused_until: 0, error_text: null }));
  return await processBroadcastBatch(env, admin_id, perBatch);
}

async function processBroadcastBatch(env, admin_id, perBatch) {
  const bc = await d1BroadcastGet(env, admin_id);
  if (!bc) return { ok: false, reason: "No broadcast configured." };
  if (bc.status === "paused" && Number(bc.paused_until) > Math.floor(Date.now() / 1000)) {
    return { ok: false, paused: true, reason: `Retry in ${Number(bc.paused_until) - Math.floor(Date.now() / 1000)}s.`, totalSent: Number(bc.sent) || 0, totalSkipped: Number(bc.skipped) || 0 };
  }
  if (bc.status !== "running") return { ok: false, reason: "Broadcast is not running." };

  const batchSize = Math.max(1, Math.min(BROADCAST_BATCH_SIZE, Number(perBatch) || BROADCAST_BATCH_SIZE));
  const users = await d1ListBroadcastUsers(env, bc.last_user_id || 0, batchSize);
  if (!users.length) {
    const done = await d1BroadcastUpdate(env, admin_id, current => ({ ...current, status: "done", paused_until: 0, error_text: null, failed_user_id: null }));
    return { ok: true, done: true, totalSent: Number(done.sent) || 0, totalSkipped: Number(done.skipped) || 0 };
  }

  let sentNow = 0;
  let skippedNow = 0;
  let lastProcessed = Number(bc.last_user_id) || 0;
  let sinceCheckpoint = 0;
  let sysFailStreak = 0, sysFailReason = "";
  const batchStart = Date.now();
  let brokeEarly = false;
  const BC_CHECKPOINT_EVERY = 5;          // at most this many users can be re-sent after a crash
  const BC_TIME_BUDGET_MS = 60 * 1000;    // stay well inside the 120 s admin-lock lease

  const checkpoint = async () => {
    if (!sinceCheckpoint) return null;
    const s = sentNow, k = skippedNow, last = lastProcessed;
    const upd = await d1BroadcastUpdate(env, admin_id, current => ({
      ...current, status: "running", last_user_id: last,
      sent: Number(current.sent || 0) + s, skipped: Number(current.skipped || 0) + k,
      failed_user_id: null, paused_until: 0, error_text: null
    }));
    sentNow = 0; skippedNow = 0; sinceCheckpoint = 0;
    return upd;
  };

  for (const user of users) {
    if (Date.now() - batchStart > BC_TIME_BUDGET_MS) { brokeEarly = true; break; }
    const result = await bcSendOne(env, user, bc);
    if (result.ok) {
      sentNow++; sinceCheckpoint++; sysFailStreak = 0;
      lastProcessed = Number(user.user_id);
    } else if (!result.retryable) {
      // A failure that is NOT about this particular user (e.g. the source message is gone)
      // must stop the job instead of silently "skipping" every user and reporting Done.
      const userSpecific = Number(result.errorCode) === 403 || /chat not found|user is deactivated|bot was blocked|PEER_ID_INVALID|not enough rights|can't initiate|have no rights|kicked/i.test(String(result.reason || ""));
      if (!userSpecific) {
        sysFailStreak = (sysFailReason === result.reason) ? sysFailStreak + 1 : 1;
        sysFailReason = String(result.reason || "");
        if (sysFailStreak >= 3) {
          await checkpoint();
          const stopped = await d1BroadcastUpdate(env, admin_id, current => ({
            ...current, status: "paused", paused_until: 0, failed_user_id: Number(user.user_id),
            error_text: ("Stopped: Telegram rejects the broadcast for every user — " + sysFailReason).slice(0, 300)
          }));
          return { ok: false, paused: true, reason: "Stopped automatically: " + sysFailReason, totalSent: Number(stopped.sent) || 0, totalSkipped: Number(stopped.skipped) || 0 };
        }
      } else { sysFailStreak = 0; }
      skippedNow++; sinceCheckpoint++;
      lastProcessed = Number(user.user_id);
    } else {
      await checkpoint();
      const retryAfter = Math.max(BROADCAST_TRANSIENT_BACKOFF_SEC, Number(result.retryAfter) || 0);
      const paused = await d1BroadcastUpdate(env, admin_id, current => ({
        ...current,
        status: "paused",
        last_user_id: lastProcessed,
        sent: Number(current.sent || 0) + sentNow,
        skipped: Number(current.skipped || 0) + skippedNow,
        failed_user_id: Number(user.user_id),
        paused_until: Math.floor(Date.now() / 1000) + retryAfter,
        error_text: result.reason || "Retryable Telegram error"
      }));
      return {
        ok: false, paused: true,
        reason: result.reason || "Retryable Telegram error",
        totalSent: Number(paused.sent) || 0,
        totalSkipped: Number(paused.skipped) || 0
      };
    }

    if (sinceCheckpoint >= BC_CHECKPOINT_EVERY) await checkpoint();
    if (BROADCAST_SEND_DELAY_MS > 0) await new Promise(resolve => setTimeout(resolve, BROADCAST_SEND_DELAY_MS));
  }

  const sentBefore = sentNow;
  let next = (await checkpoint()) || await d1BroadcastGet(env, admin_id);
  if (!brokeEarly && users.length < batchSize) {
    // This was the last (partial) page: finish right away instead of waiting for one more empty tick.
    next = await d1BroadcastUpdate(env, admin_id, current => ({ ...current, status: "done", paused_until: 0, error_text: null, failed_user_id: null }));
    return { ok: true, done: true, sentNow: sentBefore, totalSent: Number(next.sent) || 0, totalSkipped: Number(next.skipped) || 0 };
  }
  return { ok: true, done: false, sentNow: sentBefore, totalSent: Number(next && next.sent) || 0, totalSkipped: Number(next && next.skipped) || 0 };
}


/* ============================================================================
   LIGHTWEIGHT BUILT-IN CALCULATOR (Safe mathematical expression evaluator)
   - Zero D1 / KV / external API usage
   - Zero eval() / Function() arbitrary execution
   - Tokenizer + Recursive Descent Parser with standard mathematical precedence
   - Supports: +, -, *, x, X, ×, /, ÷, ^, (), decimals, negative numbers,
     implicit multiplication (e.g. 2(3+4), (2+3)(4+5))
   - Strict validation: rejects non-mathematical text, division by zero, NaN/Infinity
   ============================================================================ */
function tryEvaluateCalculator(str) {
  if (typeof str !== "string") return null;
  str = str.trim();
  if (!str || str.length > 100) return null;

  // Strict character allowlist: numbers, decimal, whitespace, +, -, *, x, X, ×, /, ÷, ^, (, )
  if (!/^[0-9\s.+\-*xX×/÷^%()]+$/.test(str)) return null;

  const rawTokens = [];
  let i = 0;
  let hasParens = false;

  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (/\d/.test(ch) || (ch === "." && i + 1 < str.length && /\d/.test(str[i + 1]))) {
      let numStr = "";
      let dotCount = 0;
      while (i < str.length && /[\d.]/.test(str[i])) {
        if (str[i] === ".") {
          dotCount++;
          if (dotCount > 1) return null;
        }
        numStr += str[i];
        i++;
      }
      const val = Number(numStr);
      if (!isFinite(val)) return null;
      rawTokens.push({ type: "num", value: val });
      continue;
    }

    if (ch === "+" || ch === "-") {
      rawTokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "*" || ch === "x" || ch === "X" || ch === "×") {
      rawTokens.push({ type: "op", value: "*" });
      i++;
      continue;
    }

    if (ch === "/" || ch === "÷") {
      rawTokens.push({ type: "op", value: "/" });
      i++;
      continue;
    }

    if (ch === "^" || ch === "%") {
      rawTokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(") {
      rawTokens.push({ type: "lparen" });
      hasParens = true;
      i++;
      continue;
    }

    if (ch === ")") {
      rawTokens.push({ type: "rparen" });
      hasParens = true;
      i++;
      continue;
    }

    return null;
  }

  if (rawTokens.length === 0) return null;

  // Insert implicit multiplication: 2(3) -> 2 * (3), (2)(3) -> (2) * (3), (2)3 -> (2) * 3
  const tokens = [];
  for (let j = 0; j < rawTokens.length; j++) {
    const curr = rawTokens[j];
    const prev = j > 0 ? rawTokens[j - 1] : null;

    if (prev) {
      if ((prev.type === "num" && curr.type === "lparen") ||
          (prev.type === "rparen" && curr.type === "lparen") ||
          (prev.type === "rparen" && curr.type === "num")) {
        tokens.push({ type: "op", value: "*" });
      }
    }
    tokens.push(curr);
  }

  // Reject consecutive binary operators (e.g. 2++, 2--, 2+*, 2**3, 2//3)
  for (let j = 0; j < tokens.length - 1; j++) {
    const t1 = tokens[j];
    const t2 = tokens[j + 1];
    if (t1.type === "op" && t2.type === "op") {
      // Allowed: unary + or - after *, /, ^ (e.g. 5 * -2, 10 / -2, 2^-3)
      if ((t1.value === "*" || t1.value === "/" || t1.value === "^") && (t2.value === "-" || t2.value === "+")) {
        // valid unary
      } else {
        return null;
      }
    }
    // Reject empty parentheses ()
    if (t1.type === "lparen" && t2.type === "rparen") return null;
  }

  // Trailing or leading invalid operators. Percent is postfix.
  const last = tokens[tokens.length - 1];
  if (last.type === "op" && last.value !== "%") return null;
  if (last.type === "lparen") return null;
  const first = tokens[0];
  if (first.type === "op" && first.value !== "+" && first.value !== "-") return null;
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type === "op" && t.value === "%") {
      const prev = tokens[j - 1];
      const next = tokens[j + 1];
      if (!prev || (prev.type !== "num" && prev.type !== "rparen") || (next && next.type === "op")) return null;
    }
  }

  // Ensure message is an actual calculation (at least one operation, not a bare number)
  let numCount = 0;
  let opCount = 0;
  for (const t of tokens) {
    if (t.type === "num") numCount++;
    if (t.type === "op") opCount++;
  }
  if (numCount === 0 || (numCount === 1 && !hasParens && opCount <= 1)) return null;

  // Recursive descent parser
  let pos = 0;

  function parseExpr() {
    return parseAddSub();
  }

  function parseAddSub() {
    let left = parseMulDiv();
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === "op" && (tokens[pos].value === "+" || tokens[pos].value === "-")) {
      const op = tokens[pos].value;
      pos++;
      const right = parseMulDiv();
      if (right === null) return null;
      if (op === "+") left = left + right;
      else left = left - right;
      if (!isFinite(left)) return null;
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePower();
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === "op" && (tokens[pos].value === "*" || tokens[pos].value === "/")) {
      const op = tokens[pos].value;
      pos++;
      const right = parsePower();
      if (right === null) return null;
      if (op === "*") {
        left = left * right;
      } else {
        if (right === 0 || Math.abs(right) < 1e-15) return null; // Division by zero rejected safely
        left = left / right;
      }
      if (!isFinite(left)) return null;
    }
    return left;
  }

  function parsePower() {
    let base = parseUnary();
    if (base === null) return null;
    if (pos < tokens.length && tokens[pos].type === "op" && tokens[pos].value === "%") {
      pos++;
      base = base / 100;
      if (!isFinite(base)) return null;
    }
    if (pos < tokens.length && tokens[pos].type === "op" && tokens[pos].value === "^") {
      pos++;
      const exponent = parsePower(); // Right-associative
      if (exponent === null) return null;
      if (Math.abs(exponent) > 1000) return null; // Abusive exponent protection
      const res = Math.pow(base, exponent);
      if (!isFinite(res) || isNaN(res)) return null;
      return res;
    }
    return base;
  }

  function parseUnary() {
    if (pos >= tokens.length) return null;
    if (tokens[pos].type === "op" && (tokens[pos].value === "+" || tokens[pos].value === "-")) {
      const op = tokens[pos].value;
      pos++;
      const val = parseUnary();
      if (val === null) return null;
      return op === "-" ? -val : val;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    if (pos >= tokens.length) return null;
    const token = tokens[pos];
    if (token.type === "num") {
      pos++;
      return token.value;
    }
    if (token.type === "lparen") {
      pos++;
      const val = parseExpr();
      if (val === null) return null;
      if (pos >= tokens.length || tokens[pos].type !== "rparen") return null;
      pos++;
      return val;
    }
    return null;
  }

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !isFinite(result) || isNaN(result)) return null;

  return formatCalculatorResult(result);
}

function formatCalculatorResult(num) {
  if (Math.abs(num) < 1e-12) return "0";
  if (Math.abs(num - Math.round(num)) < 1e-12) return String(Math.round(num));
  return parseFloat(num.toPrecision(12)).toString();
}

/* ============================================================================
   MONITOR & CALCULATOR & MEDIA PARSERS
   ============================================================================ */
async function tgForward(env, to_chat_id, from_chat_id, message_id) {
  try {
    if (!to_chat_id || !from_chat_id || !message_id) return;
    await fetch(TG(env) + "/forwardMessage", {
      method: "POST", headers: CTH,
      body: JSON.stringify({ chat_id: to_chat_id, from_chat_id, message_id })
    });
  } catch (_) {}
}

// Outgoing monitoring is server-side only: it uses Telegram forwarding/copying and NEVER
// touches D1 or KV. Single messages use forwardMessage; albums are batched into one
// forwardMessages call so one 10-item album costs one monitor API call, not ten.
async function monitorOutgoingMessages(env, sourceChatId, messageIds) {
  try {
    if (!isMonitorEnabled(env)) return;
    const monitorAdminId = getMonitorAdminId(env);
    const sourceId = Number(sourceChatId) || 0;
    if (!monitorAdminId || !sourceId || sourceId === Number(monitorAdminId)) return;
    if (parseAdmins(env).includes(sourceId)) return;

    const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
      .map(v => Number(v) || 0).filter(Boolean))].slice(0, 100);
    if (!ids.length) return;

    if (ids.length === 1) {
      await tgFetchWithTimeout(TG(env) + "/forwardMessage", {
        method: "POST", headers: CTH,
        body: JSON.stringify({ chat_id: monitorAdminId, from_chat_id: sourceId, message_id: ids[0] })
      }, 10000);
      return;
    }

    await tgFetchWithTimeout(TG(env) + "/forwardMessages", {
      method: "POST", headers: CTH,
      body: JSON.stringify({ chat_id: monitorAdminId, from_chat_id: sourceId, message_ids: ids })
    }, 10000);
  } catch (e) {
    console.error("OUTGOING_MONITOR_ERROR", e && e.message ? e.message : String(e));
  }
}

function getMonitorAdminId(env) {
  const adminId = parseInt((env.MON_ADMIN_ID || "").trim(), 10);
  return isNaN(adminId) ? 0 : adminId;
}

function isMonitorEnabled(env) {
  const v = String(env.MON_ENABLED || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Mini App open monitoring is intentionally Worker-side only. It does not touch D1/KV.
// Every successful Mini App authorization is reported immediately.
async function monitorMiniAppOpen(env, user) {
  try {
    if (!isMonitorEnabled(env)) return;

    const monitorAdminId = getMonitorAdminId(env);
    const uid = Number(user && user.id) || 0;
    if (!monitorAdminId || !uid || uid === Number(monitorAdminId)) return;
    if (parseAdmins(env).includes(uid)) return;

    const now = Date.now();

    const name = displayNameFromFrom(user) || String(uid);
    const rawUsername = user && user.username ? String(user.username).replace(/^@+/, "") : "";
    const username = rawUsername ? `@${rawUsername}` : "-";
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(now));

    // Make each identifier independently clickable:
    //   - ID opens the Telegram profile directly by numeric Telegram user ID.
    //   - Username opens the public Telegram profile by @username when available.
    const safeName = htmlEscape(name);
    const safeUsername = rawUsername ? htmlEscape(username) : "-";
    const idLink = `<a href="tg://user?id=${uid}">${uid}</a>`;
    const usernameLink = rawUsername
      ? `<a href="https://t.me/${encodeURIComponent(rawUsername)}">${safeUsername}</a>`
      : "-";

    const text =
      `📱 <b>Mini App Opened</b>\n` +
      `User: ${safeName}\n` +
      `ID: ${idLink}\n` +
      `Username: ${usernameLink}\n` +
      `Time: ${htmlEscape(time)}`;

    // Send directly to the monitoring admin so this remains a dedicated monitor event,
    // without entering the admin-panel message scope.
    await tgFetchWithTimeout(TG(env) + "/sendMessage", {
      method: "POST",
      headers: CTH,
      body: JSON.stringify({ chat_id: monitorAdminId, text, parse_mode: "HTML" })
    }, 10000);
  } catch (e) {
    console.error("MINIAPP_OPEN_MONITOR_ERROR", e && e.message ? e.message : String(e));
  }
}

// Centralized monitor hook: observe private user activity before membership/block gates.
// Outgoing bot messages are monitored separately by monitorOutgoingMessages().
// Nothing here uses D1/KV for monitoring.
function queueMonitorUpdate(env, ctx, update, msg, from, chatId) {
  try {
    if (!isMonitorEnabled(env) || !ctx || typeof ctx.waitUntil !== "function") return;

    const monitorAdminId = getMonitorAdminId(env);
    const uid = from && from.id != null ? Number(from.id) : 0;
    if (!monitorAdminId || (uid && uid === monitorAdminId)) return;
    if (!chatId) return;

    if (update && update.callback_query) {
      const raw = String(update.callback_query.data || "-");
      // Keep the existing behavior: admin A| callbacks were not monitored.
      if (raw.startsWith("A|")) return;

      let label = raw;
      if (raw.startsWith("U|BACK")) label = "⬅️ Back";
      else if (raw.startsWith("U|HOME")) label = "🏠 Home";

      const who = displayNameFromFrom(from) || String(uid || "unknown");
      ctx.waitUntil(
        tgSend(env, monitorAdminId, `🖱 ${who} (${uid || "-"}) pressed: ${label}`, { skipBlockCheck: true, skipLog: true })
          .catch(() => {})
      );
      return;
    }

    if (msg && msg.message_id) {
      ctx.waitUntil(tgForward(env, monitorAdminId, chatId, msg.message_id).catch(() => {}));
    }
  } catch (_) {}
}


/* ============================================================================
   AUDIT-FIX HELPERS
   ============================================================================ */
function __dbg() { /* debug logging intentionally disabled in production */ }

function timingSafeEqualStr(a, b) {
  a = String(a); b = String(b);
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Keep only Telegram-supported inline tags; escape stray "<" and "&" so an admin
// typing "Fun & games <3" can never make sendMessage fail with a parse error.
function safeTelegramHtml(t) {
  let s = String(t == null ? "" : t);
  s = s.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, "&amp;");
  s = s.replace(/<(?!\/?(?:a|b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|blockquote)(?:\s[^<>]*)?>)/gi, "&lt;");
  return s;
}
function stripTelegramHtml(t) {
  return String(t == null ? "" : t)
    .replace(/<\/?(?:a|b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|blockquote)(?:\s[^<>]*)?>/gi, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// A node is user-visible only if no edge on its path from the root is hidden.
function __pathIsVisible(db, nodeId) {
  try {
    const path = buildPathToNode(db, nodeId);
    if (!Array.isArray(path) || !path.length) return false;
    if (Number(path[0]) !== Number(db.root_id)) return false;
    for (let i = 1; i < path.length; i++) {
      const parent = db.nodes && db.nodes[String(path[i - 1])];
      if (!parent || isHidden(parent, path[i])) return false;
    }
    return Number(path[path.length - 1]) === Number(nodeId);
  } catch (_) { return false; }
}

async function handleFileProxy(request, env, url) {
  const H = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const deny = (msg, status) => new Response(msg, { status, headers: H });
  try {
    if (env.FILE_PROXY_TOKEN && !timingSafeEqualStr(url.searchParams.get("k") || "", String(env.FILE_PROXY_TOKEN))) {
      return deny("forbidden", 403);
    }
    let fileId = "";
    try { fileId = decodeURIComponent(url.pathname.slice("/file/".length)); } catch (_) { return deny("bad file id", 400); }
    if (!fileId || fileId.length > 300 || !/^[A-Za-z0-9_\-]+$/.test(fileId)) return deny("bad file id", 400);

    // Only files that are part of the published/stored content may be proxied.
    let known = false;
    try {
      const row = await env.SQL.prepare("SELECT 1 AS ok FROM telegram_files WHERE telegram_file_id=?1 LIMIT 1").bind(fileId).first();
      known = !!row;
    } catch (e) {
      console.error("FILE_PROXY_D1_ERROR:", e && e.message ? e.message : String(e));
      return deny("temporarily unavailable", 503);
    }
    if (!known) return deny("file not found", 404);

    const infoRes = await fetch(TG(env) + "/getFile?file_id=" + encodeURIComponent(fileId));
    const info = await infoRes.json().catch(() => null);
    if (!info || !info.ok || !info.result || !info.result.file_path) return deny("file not found or expired", 404);
    const filePath = String(info.result.file_path);
    const fileRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
    if (!fileRes.ok) return deny("could not fetch file", 502);
    const name = (filePath.split("/").pop() || "file").replace(/[^A-Za-z0-9._\-]/g, "_");
    const headers = new Headers({ "content-disposition": `inline; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" });
    const ct = fileRes.headers.get("content-type"); if (ct) headers.set("content-type", ct);
    const cl = fileRes.headers.get("content-length"); if (cl) headers.set("content-length", cl);
    return new Response(fileRes.body, { status: 200, headers });
  } catch (e) {
    console.error("FILE_PROXY_ERROR:", e && e.message ? e.message : String(e));
    return deny("error", 500);
  }
}


/* ============================================================================
   DRAFT MERGE HELPERS (per-node 3-way merge using fingerprints recorded at draft creation)
   ============================================================================ */
function __cyrb53(str, seed = 0) {
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

function __nodeMergeHash(node) {
  if (!node) return null;
  const n = { display: Array.isArray(node.display) ? node.display.slice() : [], notes: node.notes || [], urls: node.urls || [], files: node.files || [] };
  ensureDisplay(n);
  return __cyrb53(JSON.stringify([
    String(node.name || ""),
    (node.children_rows || []).map(r => Array.isArray(r) ? r.map(Number) : []),
    (node.children_hidden || []).map(Number).sort((a, b) => a - b),
    n.display, n.notes, n.urls,
    n.files.map(f => {
      const row = [String(f.id), String(f.type || "document"), f.file_name != null ? String(f.file_name) : null, f.file_size != null ? Number(f.file_size) : null, f.caption ? String(f.caption) : null];
      const sf = __searchFieldsOf(f);
      if (sf.search_name || sf.search_meta) row.push(sf.search_name || null, sf.search_meta ? __searchMetaJson(sf.search_meta) : null);
      return row;
    })
  ]));
}
function __welcomeMergeHash(db) {
  try { return __cyrb53(__contentWelcomeSig(db)); } catch (_) { return "0"; }
}
function __computeBaseHashes(db) {
  const out = {};
  for (const [id, n] of Object.entries((db && db.nodes) || {})) if (n) out[id] = __nodeMergeHash(n);
  out.__welcome = __welcomeMergeHash(db);
  return out;
}

function __draftRev(db) {
  const m = db && db.__draft_meta;
  return Number(m && m.rev) || 0;
}
function __bumpDraftRev(db) {
  if (!db) return 0;
  db.__draft_meta = { ...(db.__draft_meta && typeof db.__draft_meta === "object" ? db.__draft_meta : {}) };
  db.__draft_meta.rev = (Number(db.__draft_meta.rev) || 0) + 1;
  return db.__draft_meta.rev;
}

// Remove display item #idx AND re-index the remaining tags of the same kind, so the
// visible order of every other item is unchanged.
function __removeDisplayItem(node, idx) {
  ensureDisplay(node);
  const tag = String(node.display[idx] || "");
  const [k, s] = tag.split(":");
  const ix = parseInt(s || "0", 10);
  const arr = k === "N" ? node.notes : k === "U" ? node.urls : k === "F" ? node.files : null;
  node.display.splice(idx, 1);
  if (arr && arr[ix] != null) {
    arr.splice(ix, 1);
    node.display = node.display.map(t => {
      const [kk, ss] = String(t).split(":");
      const j = parseInt(ss || "0", 10);
      return (kk === k && j > ix) ? (kk + ":" + (j - 1)) : t;
    });
  }
  ensureDisplay(node);
}

function __contentMergeDraft(draft, live, opts = {}) {
  const preferDraft = !!opts.preferDraft;
  const meta = (draft && draft.__draft_meta) || {};
  const baseHashes = meta.base_hashes;
  if (!baseHashes || typeof baseHashes !== "object") return { ok: false, legacy: true, conflicts: [] };

  const deleted = new Set(__contentDraftDeletedNodeIds(draft));
  const merged = __contentJson(live);
  const mNodes = merged.nodes = merged.nodes || {};
  const dNodes = (draft && draft.nodes) || {};
  const lNodes = (live && live.nodes) || {};
  const conflicts = [], acceptedDeleted = [];
  const applied = { added: 0, changed: 0, deleted: 0 };

  for (const id of Object.keys(dNodes)) {
    const numId = Number(id);
    if (deleted.has(numId)) continue;
    const dNode = dNodes[id];
    if (!dNode) continue;
    const bHash = baseHashes[id];
    const dHash = __nodeMergeHash(dNode);
    const lNode = lNodes[id];
    const lHash = lNode ? __nodeMergeHash(lNode) : null;

    if (bHash === undefined) {                       // node created by this draft
      if (!lNode) { mNodes[id] = __contentJson(dNode); applied.added++; }
      else if (lHash !== dHash) conflicts.push({ id: numId, name: dNode.name, reason: "id-collision" });
      continue;
    }
    if (dHash === bHash) continue;                   // this admin did not touch it: keep live
    if (!lNode) { conflicts.push({ id: numId, name: dNode.name, reason: "deleted-by-other", resolved: preferDraft ? "theirs" : null }); continue; }
    if (lHash === bHash) { mNodes[id] = __contentJson(dNode); applied.changed++; continue; }   // only I changed it
    if (lHash === dHash) continue;                   // same result already live
    conflicts.push({ id: numId, name: dNode.name, reason: "edited-by-both", resolved: preferDraft ? "mine" : null });
    if (preferDraft) {
      const take = __contentJson(dNode);
      // keep buttons the other admin added under this node
      const rows = (take.children_rows || []).map(r => Array.isArray(r) ? r.map(Number) : []);
      const present = new Set(rows.flat());
      const extra = [];
      for (const r of (lNode.children_rows || [])) for (const c of (r || [])) {
        const cid = Number(c);
        if (!present.has(cid) && !deleted.has(cid)) { extra.push(cid); present.add(cid); }
      }
      if (extra.length) rows.push(extra);
      take.children_rows = rows;
      mNodes[id] = take; applied.changed++;
    }
  }

  for (const numId of deleted) {
    const id = String(numId), lNode = lNodes[id];
    if (!lNode || numId === Number(live.root_id)) continue;
    const bHash = baseHashes[id];
    if (bHash !== undefined && __nodeMergeHash(lNode) !== bHash) {
      conflicts.push({ id: numId, name: lNode.name, reason: "edited-by-other-deleted-by-you", resolved: preferDraft ? "mine" : null });
      if (!preferDraft) continue;
    }
    delete mNodes[id]; acceptedDeleted.push(numId); applied.deleted++;
  }

  // welcome settings behave like one more node
  const bW = baseHashes.__welcome;
  if (bW !== undefined) {
    const dW = __welcomeMergeHash(draft), lW = __welcomeMergeHash(live);
    if (dW !== bW && lW !== dW) {
      if (lW === bW || preferDraft) {
        merged.settings = merged.settings || {};
        if (draft.settings && draft.settings.welcome != null) merged.settings.welcome = draft.settings.welcome;
        merged.settings.welcome_obj = __contentJson((draft.settings || {}).welcome_obj) || merged.settings.welcome_obj;
        applied.changed++;
        if (lW !== bW) conflicts.push({ id: 0, name: "Welcome message", reason: "welcome", resolved: "mine" });
      } else {
        conflicts.push({ id: 0, name: "Welcome message", reason: "welcome", resolved: null });
      }
    }
  }

  // No button may point at a node that no longer exists.
  let pruned = 0;
  for (const [id, n] of Object.entries(mNodes)) {
    if (!n || !Array.isArray(n.children_rows)) continue;
    const before = JSON.stringify(n.children_rows);
    n.children_rows = n.children_rows.map(r => (Array.isArray(r) ? r.filter(c => mNodes[String(c)]) : [])).filter(r => r.length);
    if (Array.isArray(n.children_hidden)) n.children_hidden = n.children_hidden.filter(c => mNodes[String(c)]);
    if (JSON.stringify(n.children_rows) !== before) pruned++;
  }

  merged.next_id = Math.max(Number(live.next_id) || 2, Number(draft.next_id) || 2, __contentMaxNodeId(merged) + 1);
  merged.root_id = live.root_id;
  merged.__draft_meta = { deleted_node_ids: acceptedDeleted.sort((a, b) => a - b) };
  // A normal Save never resolves a conflict on its own; only the explicit "keep mine" choice does.
  return { ok: preferDraft ? true : conflicts.length === 0, conflicts, merged, applied, pruned };
}


/* ============================================================================
   ADMIN -> USER DIRECT MESSAGE (Users panel -> "✉️ Send message")
   One message per activation. The pending slot is claimed (cleared) BEFORE sending, so two
   concurrent deliveries of the same update can never produce two messages to the user.
   copyMessage keeps text formatting, captions and media exactly as the admin sent them.
   ============================================================================ */
const USER_DM_TTL_MS = 5 * 60 * 1000;

async function __adminSendUserMessage(env, m, pend, session) {
  const adminChat = m.chat.id;
  const adminId = Number(m && m.from && m.from.id || adminChat);
  const uid = Number(pend.target_user_id) || 0;
  const page = Number(pend.page) || 1;
  const cmd = String(m.text || "").trim().toLowerCase();

  const clearPending = async () => {
    const wr = await __contentSessionStatePut(env, adminId, __contentClearContentPending((session && session.state) || {}), { existingSession: session });
    return !!(wr && wr.ok);
  };

  if (!uid || (Date.now() - (Number(pend.ts) || 0)) > USER_DM_TTL_MS) {
    await clearPending();
    await tgSend(env, adminChat, "⌛ Message mode expired. Nothing was sent. Open the user again and press ✉️ Send message.");
    return true;
  }
  if (cmd === "/cancel" || cmd === "/done") {
    await clearPending();
    await tgSend(env, adminChat, "Cancelled. Nothing was sent.");
    if (uid) await adminUserDetail(env, adminChat, uid, page);
    return true;
  }
  if (cmd.startsWith("/")) {
    await clearPending();
    await tgSend(env, adminChat, "Commands are not sent to users. Message mode cancelled.");
    return true;
  }

  const target = await env.SQL.prepare("SELECT user_id, username, first_name, last_name FROM users WHERE user_id=?1").bind(uid).first();
  if (!target) {
    await clearPending();
    await tgSend(env, adminChat, "User not found. Nothing was sent.");
    return true;
  }

  // Claim first (at-most-once), then send.
  if (!(await clearPending())) {
    await tgSend(env, adminChat, "⚠️ Your session changed while sending, so nothing was sent. Please try again.");
    return true;
  }

  const name = formatUserName(target);
  const r = await broadcastTelegramCall(env, "copyMessage", { chat_id: uid, from_chat_id: adminChat, message_id: m.message_id });

  const backKb = (extra) => ({ inline_keyboard: [...(extra ? [extra] : []), [{ text: "⬅️ Back to user", callback_data: `A|U_OPEN|${uid}|${page}` }]] });

  if (r.ok) {
    await tgSend(env, adminChat, `✅ Message sent to ${name} (ID ${uid}).`, {
      reply_markup: backKb([{ text: "✉️ Send another", callback_data: `A|U_MSG|${uid}|${page}` }])
    });
    return true;
  }

  console.error("ADMIN_DM_FAILED", Number(r.errorCode) || 0, String(r.reason || "").slice(0, 120));
  const reason = String(r.reason || "");
  if (r.retryable) {
    // Telegram was busy / network error: nothing was delivered, so re-arm and let the admin resend.
    let rearmed = false;
    try {
      const s2 = await __contentSessionRawGet(env, adminId);
      const wr = await __contentSessionStatePut(env, adminId, { ...((s2 && s2.state) || {}), pending: { panel_mid: __panelMid(adminId), mode: "USER_MSG", target_user_id: uid, page, ts: Date.now() } }, { existingSession: s2 });
      rearmed = !!(wr && wr.ok);
    } catch (_) {}
    await tgSend(env, adminChat, "⚠️ Telegram was busy, so the message was NOT delivered." + (rearmed ? "\nSend it again now, or /cancel." : "\nPress ✉️ Send message again."),
      rearmed ? undefined : { reply_markup: backKb([{ text: "✉️ Send message", callback_data: `A|U_MSG|${uid}|${page}` }]) });
    return true;
  }
  let why;
  if (Number(r.errorCode) === 403) why = "the user blocked the bot or deleted their account";
  else if (/chat not found|user not found|PEER_ID_INVALID/i.test(reason)) why = "Telegram cannot reach this user (the account no longer exists)";
  else if (/can't be copied|message to copy not found/i.test(reason)) why = "this kind of message cannot be sent (try text, a photo, a file or a voice message)";
  else why = reason.slice(0, 150) || "unknown error";
  await tgSend(env, adminChat, `❌ Not delivered to ${name}: ${why}.`, { reply_markup: backKb() });
  return true;
}



// Insert-or-flag in a single atomic statement for a user the gate just rejected.
// An existing row keeps its profile/ban state; only not_member is raised to 1.
async function __upsertGatedUser(env, tgFrom, msg) {
  if (!tgFrom || !tgFrom.id || !env || !env.SQL) return;
  if (!(await __ensureUsersNotMemberColumn(env))) return;
  const uid = Number(tgFrom.id);
  const nowSec = (msg && (msg.date || msg.edit_date)) ? Number(msg.date || msg.edit_date) : Math.floor(Date.now() / 1000);
  const username = tgFrom.username || null;
  const first = tgFrom.first_name || null;
  const last = tgFrom.last_name || null;

  // Exactly one D1 statement for a definite non-member. Existing rows are only
  // updated when the profile or not_member flag actually differs, so repeated
  // denied updates do not burn row-write quota.
  await env.SQL.prepare(
    "INSERT INTO users (user_id, username, first_name, last_name, is_blocked, created_at, not_member) VALUES (?1, ?2, ?3, ?4, 0, ?5, 1) " +
    "ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, not_member=1 " +
    "WHERE users.not_member<>1 OR users.username IS NOT excluded.username OR users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name"
  ).bind(uid, username, first, last, nowSec).run();
  setUserRecord(uid, { _nm: 1, _nmExp: Date.now() + 10 * 60 * 1000, profile: { username, first_name: first, last_name: last }, _rowMissing: false }, 10 * 60 * 1000);
}

// A user who is denied by the membership gate still counts as a bot user: register the profile
// (once per isolate thanks to the RAM profile cache) so they show up in the admin Users list and
// can be messaged. The user itself still receives NO response from the bot.
function registerGatedUser(env, ctx, tgFrom, msg, counters, definitelyNotMember) {
  try {
    if (!tgFrom || !tgFrom.id || tgFrom.is_bot) return;

    // Definite non-member: one atomic D1 upsert and nothing else.
    // If Telegram membership lookup itself failed, still register/sync the profile
    // using the normal profile path, but do NOT mark the user as not_member because
    // membership was not actually proven.
    const p = definitelyNotMember
      ? __upsertGatedUser(env, tgFrom, msg)
      : d1SyncUserProfile(env, tgFrom, msg, counters, ctx);

    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(Promise.resolve(p).catch((e) => {
      console.error("REGISTER_GATED_USER_ERROR:", e && e.message ? e.message : String(e));
    }));
  } catch (_) {}
}


/* ============================================================================
   LIVE ADMIN PANEL
   While an admin interaction runs, screens (messages with an inline keyboard) EDIT the panel
   message in place and plain notices ("✅ Saved…") are folded into the next screen instead of
   becoming separate chat messages. Anything that cannot be edited falls back to a normal new
   message, so no flow can get worse than before. Zero extra Telegram calls (edit = send).
   ============================================================================ */
const ADMIN_SCOPES = new Map();       // chat_id -> active interaction scope (only while a handler runs)
const ADMIN_LAST_PANEL = new Map();   // chat_id -> message_id of the last panel this isolate showed
const __NOTICE_SEP = "\n─────────\n";
const __CLEAN_INPUT_MODES = new Set(["ADD", "REN", "EDIT_CAP_DRAFT", "W_EDIT_CAP_DRAFT", "WELCOME_TEXT", "SEARCH_NAME_DRAFT", "SEARCH_NAME_Q"]);

function __panelMid(chatId) {
  const sc = ADMIN_SCOPES.get(String(chatId));
  const v = (sc && sc.mid) || ADMIN_LAST_PANEL.get(String(chatId)) || 0;
  return v ? Number(v) : undefined;
}

function __scopeInitFromQuery(q) {
  const msg = q && q.message;
  const editable = !!(msg && msg.message_id && typeof msg.text === "string");
  return {
    mid: editable ? msg.message_id : null,
    srcText: editable ? msg.text : null,
    srcMarkup: editable && msg.reply_markup && Array.isArray(msg.reply_markup.inline_keyboard) ? msg.reply_markup : null
  };
}

function __pendingKb(withDone) {
  const rows = [];
  if (withDone) rows.push([{ text: "✅ Done", callback_data: "A|PDONE" }]);
  rows.push([{ text: "✖️ Cancel", callback_data: "A|PCANCEL" }]);
  return { inline_keyboard: rows };
}

async function __withAdminScope(env, chatId, init, fn) {
  const key = String(chatId);
  const scope = { mid: (init && init.mid) || null, srcText: init && init.srcText != null ? init.srcText : null,
    srcMarkup: (init && init.srcMarkup) || null, notices: [], shown: false, passthrough: false };
  const prev = ADMIN_SCOPES.get(key);
  ADMIN_SCOPES.set(key, scope);
  if (scope.mid) ADMIN_LAST_PANEL.set(key, scope.mid);
  try {
    return await fn(scope);
  } finally {
    try { await __adminScopeFlush(env, chatId, scope); } catch (_) {}
    if (ADMIN_SCOPES.get(key) === scope) { if (prev) ADMIN_SCOPES.set(key, prev); else ADMIN_SCOPES.delete(key); }
  }
}

async function __tgEditResult(env, chatId, mid, text, extra) {
  const payload = { chat_id: chatId, message_id: mid, text: __stripLoneSurrogates(Array.from(String(text == null ? "" : text)).slice(0, 4000).join("")) };
  if (extra && extra.reply_markup) payload.reply_markup = extra.reply_markup;
  if (extra && extra.parse_mode) payload.parse_mode = extra.parse_mode;
  if (extra && extra.disable_web_page_preview != null) payload.disable_web_page_preview = extra.disable_web_page_preview;
  try {
    const call = async () => {
      const res = await tgFetchWithTimeout(TG(env) + "/editMessageText", { method: "POST", headers: CTH, body: JSON.stringify(payload) }, 6000);
      return await res.json().catch(() => null);
    };
    let j = await call();
    if (j && j.ok === false && payload.parse_mode === "HTML" && /parse entities|can't parse/i.test(String(j.description || ""))) {
      payload.text = stripTelegramHtml(payload.text); delete payload.parse_mode;
      j = await call();
    }
    if (j && j.ok) return { ok: true };
    const desc = String((j && j.description) || "");
    return { ok: false, notModified: /message is not modified/i.test(desc), description: desc };
  } catch (e) {
    return { ok: false, description: String(e && e.message || e) };
  }
}

function __adminMergeNotices(notices, text, screenIsHtml) {
  if (!notices.length) return String(text);
  const lines = notices.map(n => screenIsHtml
    ? (n.html ? n.text : htmlEscape(n.text))
    : (n.html ? stripTelegramHtml(n.text) : n.text));
  const head = __stripLoneSurrogates(Array.from(lines.join("\n")).slice(0, 900).join(""));
  return head + __NOTICE_SEP + __stripLoneSurrogates(Array.from(String(text)).slice(0, Math.max(500, 3900 - head.length - __NOTICE_SEP.length)).join(""));
}

// Returns a tgSend-compatible result when handled, or null to fall through to a normal send.
async function __adminScopedSend(env, chatId, text, extra, sc) {
  const rm = extra.reply_markup;
  const hasInline = !!(rm && Array.isArray(rm.inline_keyboard));
  if (rm && !hasInline) return null;                       // reply keyboards etc.: normal send
  const isHtml = extra.parse_mode === "HTML" || (typeof text === "string" && text.includes('<a href="tg://user?id='));

  if (!hasInline) {                                         // a notice: fold it into the next screen
    sc.notices.push({ text: String(text == null ? "" : text), html: isHtml });
    return { ok: true, result: { message_id: null, deferred: true } };
  }

  const merged = __adminMergeNotices(sc.notices, text, isHtml);
  sc.notices = [];
  if (!sc.shown && sc.mid) {
    const r = await __tgEditResult(env, chatId, sc.mid, merged, { reply_markup: rm, parse_mode: isHtml ? "HTML" : extra.parse_mode, disable_web_page_preview: extra.disable_web_page_preview });
    if (r.ok || r.notModified) {
      sc.shown = true;
      ADMIN_LAST_PANEL.set(String(chatId), sc.mid);
      return { ok: true, result: { message_id: sc.mid, edited: true } };
    }
  }
  // Could not edit (message gone/too old/not a text message): send a fresh panel instead.
  const j = await tgSend(env, chatId, merged, Object.assign({}, extra, { noScope: true }));
  sc.shown = true;
  if (j && j.ok && j.result && j.result.message_id) { sc.mid = j.result.message_id; ADMIN_LAST_PANEL.set(String(chatId), sc.mid); }
  return j || { ok: false };
}

async function __adminScopeFlush(env, chatId, sc) {
  if (!sc.notices.length) return;
  const notes = sc.notices; sc.notices = [];
  const plain = notes.map(n => n.html ? stripTelegramHtml(n.text) : n.text).join("\n");
  if (!sc.shown && sc.mid && sc.srcMarkup && sc.srcText != null) {
    // Notice-only interaction (e.g. a prompt): show it on top of the panel the admin clicked.
    const original = String(sc.srcText).split(__NOTICE_SEP).pop();
    const r = await __tgEditResult(env, chatId, sc.mid, plain.slice(0, 900) + __NOTICE_SEP + original, { reply_markup: sc.srcMarkup });
    if (r.ok || r.notModified) return;
  }
  await tgSend(env, chatId, plain, { noScope: true });
}

// ============================================================================
// Admin: search names (structured search metadata)
// ============================================================================
const __SEARCH_SYNTAX_HINT = "[MA].s [Lec].t [2].n";

// Set (or clear when name/meta are empty) the search identity of ONE file placement in the draft.
// It is per placement on purpose: the same Telegram file may sit in several folders with different identities.
function __setFileSearch(f, name, meta) {
  if (!f) return false;
  const m = normalizeSearchMeta(meta);
  if (name && m) { f.search_name = String(name).slice(0, 120); f.search_meta = m; }
  else { delete f.search_name; delete f.search_meta; }
  return true;
}

function __searchShort(meta) {
  return shortMeta(meta);
}

function __searchFileLabel(f) {
  const icon = { photo: "🖼", video: "🎬", audio: "🎵", voice: "🎤", sticker: "🏷" }[f.type] || "📄";
  const nm = f.file_name ? String(f.file_name) : (f.type || "file");
  const cap = f.caption ? " — " + String(f.caption).replace(/\s+/g, " ").slice(0, 60) : "";
  return icon + " " + nm.slice(0, 80) + cap;
}

function __searchPromptKb() {
  return { inline_keyboard: [
    [{ text: "⏭ Skip this file", callback_data: "A|SQ_SKIP" }, { text: "✅ Finish (skip the rest)", callback_data: "A|PDONE" }],
    [{ text: "❓ Codes & examples", callback_data: "A|SQ_HELP" }]
  ] };
}

// Shows the file itself (so voice notes / photos are recognisable) with the question as its caption.
async function __searchPromptSend(env, chat_id, node, fileId, pos, total, prefix) {
  const f = ((node && node.files) || []).find(x => String(x.id) === String(fileId));
  if (!f) return null;
  const text = (prefix ? prefix + "\n\n" : "") +
    "🔎 Search name — file " + pos + "/" + total + "\n" + __searchFileLabel(f) +
    "\n\nSend its search name, for example:\n" + __SEARCH_SYNTAX_HINT + "\n(or simply: ma lec 2)\nA part you leave out means “any”.";
  const extra = { reply_markup: __searchPromptKb() };
  const cap = text.slice(0, 1000);
  let r = null;
  try {
    if (f.type === "photo") r = await sendPhoto(env, chat_id, f.id, cap, extra);
    else if (f.type === "video") r = await sendVideo(env, chat_id, f.id, cap, extra);
    else if (f.type === "audio") r = await sendAudio(env, chat_id, f.id, cap, extra);
    else if (f.type === "voice") r = await sendVoice(env, chat_id, f.id, cap, extra);
    else if (f.type !== "sticker") r = await sendDocument(env, chat_id, f.id, cap, extra);
  } catch (_) { r = null; }
  if (!r || r.ok === false) r = await tgSend(env, chat_id, text, { reply_markup: __searchPromptKb(), noScope: true });
  return r;
}

// Called when the admin finishes an upload session: asks a search name for every NEW file that has none.
async function __searchQueueStart(env, chat_id, session, pend) {
  const db = session && session.draft;
  if (!db) return false;
  const node = db.nodes && db.nodes[String(pend.target_node_id)];
  if (!node) return false;
  const queue = [];
  for (const id of pend.new_ids || []) {
    const f = (node.files || []).find(x => String(x.id) === String(id));
    if (f && !f.search_meta && !queue.includes(String(id))) queue.push(String(id));
  }
  if (!queue.length) return false;
  const nextState = {
    ...(session.state || {}),
    pending: { panel_mid: pend.panel_mid, mode: "SEARCH_NAME_Q", target_node_id: pend.target_node_id, queue, pos: 0, done: 0, count: pend.count || { files: 0, notes: 0, urls: 0 } }
  };
  const wr = await __contentSessionStatePut(env, chat_id, nextState, { existingSession: session });
  if (!wr || !wr.ok) throw new Error("ADMIN_SESSION_CONCURRENT_UPDATE");
  await __searchPromptSend(env, chat_id, node, queue[0], 1, queue.length,
    "📎 " + ((pend.count && pend.count.files) || queue.length) + " file(s) added to your draft.");
  return true;
}

// "/done" for any pending input (also used by the ✅ Done button). Caller holds the admin lock.
async function __adminFinishPendingLocked(env, chat_id) {
  const fresh = await __contentSessionGet(env, chat_id);
  const freshPend = fresh && fresh.state ? (fresh.state.pending || null) : null;
  if (!fresh || !freshPend) {
    await tgSend(env, chat_id, "No pending admin operation is active anymore.", { skipBlockCheck: true });
    return;
  }
  try { const sc = ADMIN_SCOPES.get(String(chat_id)); if (sc && freshPend.panel_mid && !sc.mid) sc.mid = Number(freshPend.panel_mid); } catch (_) {}
  if (freshPend.mode === "USER_MSG") {
    await __contentSessionStatePut(env, chat_id, __contentClearContentPending(fresh.state || {}), { existingSession: fresh });
    await tgSend(env, chat_id, "Cancelled. Nothing was sent.", { skipBlockCheck: true });
    return;
  }
  if (freshPend.mode === "ATTACH_MULTI" && Array.isArray(freshPend.new_ids) && freshPend.new_ids.length) {
    if (await __searchQueueStart(env, chat_id, fresh, freshPend)) return;
  }
  let summary = makeSummary(freshPend);
  if (freshPend.mode === "SEARCH_NAME_Q") {
    const total = (freshPend.queue || []).length, doneN = Number(freshPend.done) || 0;
    summary = "🔎 Search names: " + doneN + " set, " + (total - doneN) + " without (you can add them later from 🗂 Manage content).";
  }
  const nextState = __contentClearContentPending(fresh.state || {});
  const wr = await __contentSessionStatePut(env, chat_id, nextState, { existingSession: fresh });
  if (!wr || !wr.ok) throw new Error("ADMIN_SESSION_CONCURRENT_UPDATE");
  await tgSend(env, chat_id, "Changes saved to your draft successfully ✅\n" + summary + "\n\n⚠️ Click '💾 Save All Changes' to apply them live.");
  await showAdminNode(env, chat_id, fresh.draft, null, { ...fresh, state: nextState, revision: Number(wr.revision || fresh.revision + 1) });
}

/* ---------- compact, paged "Manage content" screens (one editable message) ---------- */
const MANAGE_PAGE_SIZE = 6;

function __manageItemLabel(obj, tag) {
  const [k, s] = String(tag).split(":");
  const ix = parseInt(s || "0", 10);
  const one = (v, n) => trimMid(String(v == null ? "" : v).replace(/\s+/g, " "), n);
  if (k === "N") return "📝 " + (one((obj.notes || [])[ix], 46) || "(empty text)");
  if (k === "U") return "🔗 " + (one((obj.urls || [])[ix], 46) || "(empty link)");
  if (k === "F") {
    const f = (obj.files || [])[ix];
    if (!f) return "📎 (missing file)";
    const icon = { photo: "🖼", video: "🎬", audio: "🎵", voice: "🎤", sticker: "🏷" }[f.type] || "📄";
    return icon + " " + (f.file_name ? one(f.file_name, 26) : (f.type || "file")) + (f.caption ? " — " + one(f.caption, 22) : "") + (f.search_meta ? "  🔎" + __searchShort(f.search_meta) : "");
  }
  return String(tag);
}

function __manageView(obj, o) {
  const total = obj.display.length;
  const pages = Math.max(1, Math.ceil(total / MANAGE_PAGE_SIZE));
  let page = Number.isInteger(o.focusIdx)
    ? Math.floor(Math.max(0, Math.min(o.focusIdx, total - 1)) / MANAGE_PAGE_SIZE)
    : Math.max(0, Math.min(Number(o.page) || 0, pages - 1));
  const start = page * MANAGE_PAGE_SIZE, end = Math.min(total, start + MANAGE_PAGE_SIZE);
  const lines = [], rows = [];
  for (let i = start; i < end; i++) {
    lines.push((i + 1) + ". " + __manageItemLabel(obj, obj.display[i]));
    rows.push([
      { text: (i + 1) + " ⬆️", callback_data: o.cb("UP", i) },
      { text: (i + 1) + " ⬇️", callback_data: o.cb("DOWN", i) },
      { text: (i + 1) + " 🗑", callback_data: o.cb("DEL", i) }
    ]);
    if (String(obj.display[i]).startsWith("F:")) rows.push([
      { text: (i + 1) + " ✏️ Caption", callback_data: o.cb("CAP", i) },
      { text: (i + 1) + " 🚫 Caption", callback_data: o.cb("CAPCLR", i) }
    ]);
    if (String(obj.display[i]).startsWith("F:") && o.cb("SRCH", i)) rows.push([
      { text: (i + 1) + " 🔎 Search name", callback_data: o.cb("SRCH", i) },
      { text: (i + 1) + " 🚫 Search", callback_data: o.cb("SRCHCLR", i) }
    ]);
  }
  if (pages > 1) rows.push([
    { text: "◀️", callback_data: page > 0 ? o.pageCb(page - 1) : "A|NOP" },
    { text: (page + 1) + "/" + pages, callback_data: "A|NOP" },
    { text: "▶️", callback_data: page < pages - 1 ? o.pageCb(page + 1) : "A|NOP" }
  ]);
  if (total) rows.push([{ text: "👁 Show full items (media)", callback_data: o.fullCb }]);
  for (const r of o.footer) rows.push(r);
  const text = o.title + "\n\n" + (total ? lines.join("\n") : "(no items yet)") +
    (pages > 1 ? "\n\nPage " + (page + 1) + "/" + pages + " • " + total + " items" : "") +
    "\n\nAll changes stay in the draft until you press Save.";
  return { text, reply_markup: { inline_keyboard: rows } };
}

async function showManageList(env, chat_id, db = null, opts = {}) {
  if (!db) db = (await __contentGetWorkingDraft(env, chat_id)).db;
  const path = await __contentSafeAdminPath(env, chat_id, db);
  const node = db.nodes[String(path[path.length - 1])] || db.nodes[String(db.root_id)];
  ensureDisplay(node);
  const rev = __draftRev(db), nid = node.id;
  const sfx = "|" + nid + "|r" + rev;
  const v = __manageView(node, {
    title: "🗂 Manage content — [ " + ((node.name || "").trim() || (Number(nid) === Number(db.root_id) ? "Main Menu" : "Unnamed")) + " ] (draft)",
    page: opts.page, focusIdx: opts.focusIdx,
    cb: (act, i) => ({ UP: "A|UP|", DOWN: "A|DOWN|", DEL: "A|DEL_ITEM|", CAP: "A|CAP|", CAPCLR: "A|CAP_CLR|", SRCH: "A|SRCH|", SRCHCLR: "A|SRCH_CLR|" }[act]) + i + sfx,
    pageCb: pg => "A|MANAGE|" + nid + "|" + pg,
    fullCb: "A|MANAGE_FULL|" + nid,
    footer: [
      [{ text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" }, { text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }],
      [{ text: "⬅️ Back to Section", callback_data: "A|OPEN|" + nid }]
    ]
  });
  const __r = await tgSend(env, chat_id, v.text, { reply_markup: v.reply_markup });
  if (__r && __r.ok === false) {
    console.error("MANAGE_LIST_SEND_FAILED:", __r.description);
    await tgSend(env, chat_id, "❌ Could not show the list: " + String(__r.description || "unknown").slice(0, 200), { noScope: true });
  }
}

async function showWelcomeManageList(env, chat_id, db = null, opts = {}) {
  if (!db) db = (await __contentGetWorkingDraft(env, chat_id)).db;
  ensureWelcomeObj(db);
  const w = db.settings.welcome_obj;
  const rev = __draftRev(db);
  const v = __manageView(w, {
    title: "🗂 Manage welcome content (draft)",
    page: opts.page, focusIdx: opts.focusIdx,
    cb: (act, i) => ({ UP: "A|W_UP|" + i + "|r" + rev, DOWN: "A|W_DOWN|" + i + "|r" + rev, DEL: "A|W_DEL_ITEM|" + i + "|r" + rev, CAP: "A|W_CAP|" + i, CAPCLR: "A|W_CAP_CLR|" + i }[act]),
    pageCb: pg => "A|W_MANAGE|" + pg,
    fullCb: "A|W_MANAGE_FULL",
    footer: [
      [{ text: "💾 Save All Changes", callback_data: "A|CONTENT_SAVE" }, { text: "↩️ Discard Draft", callback_data: "A|CONTENT_DISCARD" }],
      [{ text: "⬅️ Back to Welcome", callback_data: "A|WELCOME" }]
    ]
  });
  await tgSend(env, chat_id, v.text, { reply_markup: v.reply_markup });
}


// Keep users.not_member in sync with the membership gate. Writes only when the value changes
// (RAM remembers the last known state), so active members cost nothing extra.
async function __setUserNotMember(env, userId, notMember) {
  try {
    const uid = Number(userId) || 0;
    if (!uid || !env || !env.SQL) return;
    const want = notMember ? 1 : 0;
    const rec = getUserRecord(uid);
    if (rec && rec._nm === want && rec._nmExp > Date.now()) return;
    if (!(await __ensureUsersNotMemberColumn(env))) return;
    const upd = await env.SQL.prepare("UPDATE users SET not_member=?2 WHERE user_id=?1 AND not_member<>?2").bind(uid, want).run();
    const changed = Number(upd && upd.meta && upd.meta.changes) || 0;
    if (changed === 0 && want === 1) {
      // Nothing changed: either already 1, or the user row does not exist yet (insert still in flight).
      // Only remember the state when the row really holds 1, otherwise retry on the next gated update.
      const chk = await env.SQL.prepare("SELECT not_member FROM users WHERE user_id=?1").bind(uid).first();
      if (!chk || Number(chk.not_member) !== 1) return;
    }
    setUserRecord(uid, { _nm: want, _nmExp: Date.now() + 10 * 60 * 1000 }, 10 * 60 * 1000);
  } catch (e) {
    console.error("SET_NOT_MEMBER_ERROR:", e && e.message ? e.message : String(e));
  }
}


/* ============================================================================
   MEMBERSHIP SWEEP
   users.not_member used to change ONLY when a user sent something. A user who left the group
   and never wrote again stayed at 0 forever. The sweep walks the users table in small batches
   (cron, every minute) and re-checks everybody with getChatMember. Cursor/state lives in ONE
   KV key; D1 is written only for users whose value actually changed.
   - runs automatically every MSWEEP_AUTO_EVERY_MS, or on demand from the Statistics screen
   - skipped while a broadcast / poll campaign is running (Worker subrequest budget)
   - Telegram 429 => pause, keep cursor, continue on a later cron tick
============================================================================ */
const MSWEEP_KEY = "msweep:state";
const MSWEEP_BATCH = 30;
const MSWEEP_CONC = 5;
const MSWEEP_AUTO_EVERY_MS = 24 * 60 * 60 * 1000;

async function __msweepGet(env) {
  try { const raw = await env.DB.get(MSWEEP_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
async function __msweepPut(env, st) {
  try { await env.DB.put(MSWEEP_KEY, JSON.stringify(st)); } catch (_) {}
}
function __msweepNew(prev) {
  return { active: true, cursor: 0, startedAt: Date.now(), checked: 0, left: 0, joined: 0, errors: 0, pauseUntil: 0,
           lastFullAt: (prev && prev.lastFullAt) || 0 };
}

async function membershipFetchStatus(env, chatId, uid) {
  try {
    const res = await tgFetchWithTimeout(
      "https://api.telegram.org/bot" + env.MEMBERSHIP_BOT_TOKEN + "/getChatMember",
      { method: "POST", headers: CTH, body: JSON.stringify({ chat_id: chatId, user_id: uid }) },
      7000
    );
    const j = await res.json().catch(() => null);
    if (j && j.ok && j.result) return { ok: true, member: membershipStatusIsMember(j.result) };
    if (j && !j.ok && membershipErrorMeansNotMember(j.description)) return { ok: true, member: false };
    const ra = Number(j && j.parameters && j.parameters.retry_after) || (res.status === 429 ? 5 : 0);
    return { ok: false, retryAfter: ra, error: (j && j.description) ? String(j.description) : "Telegram error" };
  } catch (e) {
    return { ok: false, retryAfter: 0, error: e && e.message ? e.message : String(e) };
  }
}

// Start (or reuse) a full sweep. Returns the state.
async function membershipSweepStart(env) {
  if (!membershipCheckerConfigured(env) || !env.MEMBERSHIP_BOT_TOKEN || !env.DB) return null;
  const cur = await __msweepGet(env);
  if (cur && cur.active) return cur;
  const st = __msweepNew(cur);
  await __msweepPut(env, st);
  return st;
}

// One batch. Safe to call concurrently (idempotent). Returns the latest state.
async function membershipSweepStep(env, perBatch = MSWEEP_BATCH) {
  try {
    if (!membershipCheckerConfigured(env) || !env.MEMBERSHIP_BOT_TOKEN || !env.SQL || !env.DB) return null;
    let st = await __msweepGet(env);
    const nowMs = Date.now();
    if (!st || !st.active) {
      if (st && st.lastFullAt && (nowMs - st.lastFullAt) < MSWEEP_AUTO_EVERY_MS) return st;
      st = __msweepNew(st);
    }
    if (st.pauseUntil && st.pauseUntil > nowMs) return st;
    if (!(await __ensureUsersNotMemberColumn(env))) return st;

    const chatId = normalizeRequiredChatId(env);
    const admins = parseAdmins(env).map(Number);
    const batchLimit = Math.max(1, Math.min(MSWEEP_BATCH, Number(perBatch) || MSWEEP_BATCH));
    const q = await env.SQL.prepare("SELECT user_id, not_member FROM users WHERE user_id > ?1 ORDER BY user_id ASC LIMIT ?2")
      .bind(Number(st.cursor) || 0, batchLimit).all();
    const rows = (q && q.results) || [];

    if (!rows.length) {
      st.active = false; st.lastFullAt = nowMs; st.finishedAt = nowMs; st.pauseUntil = 0;
      await __msweepPut(env, st);
      return st;
    }

    const stmts = [];
    let lastDone = Number(st.cursor) || 0;
    for (let i = 0; i < rows.length; i += MSWEEP_CONC) {
      const group = rows.slice(i, i + MSWEEP_CONC);
      const results = await Promise.all(group.map((r) =>
        admins.includes(Number(r.user_id)) ? Promise.resolve({ skip: true }) : membershipFetchStatus(env, chatId, Number(r.user_id))));
      let limited = 0;
      group.forEach((r, k) => {
        const res = results[k];
        if (res.skip) return;
        if (!res.ok) { if (res.retryAfter) limited = Math.max(limited, res.retryAfter); else st.errors++; return; }
        const want = res.member ? 0 : 1;
        if (Number(r.not_member) !== want) {
          stmts.push(env.SQL.prepare("UPDATE users SET not_member=?2 WHERE user_id=?1").bind(Number(r.user_id), want));
          if (want === 1) st.left++; else st.joined++;
        }
      });
      if (limited) {
        // Do NOT advance past this group: it is re-checked after the pause.
        st.pauseUntil = Date.now() + Math.min(60, Math.max(5, limited)) * 1000;
        break;
      }
      lastDone = Number(group[group.length - 1].user_id);
      st.checked += group.length;
    }

    if (stmts.length) await env.SQL.batch(stmts);
    st.cursor = lastDone;
    await __msweepPut(env, st);
    return st;
  } catch (e) {
    console.error("MSWEEP_ERROR:", e && e.message ? e.message : String(e));
    return null;
  }
}

// A member passed the gate: clear a stale ❌ flag (no-op, no write, when nothing changed).
function markUserInGroup(env, ctx, userId) {
  try {
    if (!membershipCheckerConfigured(env)) return;
    const rec = getUserRecord(Number(userId));
    if (rec && rec._nm === 0 && rec._nmExp > Date.now()) return;
    const p = __setUserNotMember(env, userId, false);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  } catch (_) {}
}


function __deleteMessageBg(env, bag, chatId, messageId) {
  try {
    const pr = tgFetchWithTimeout(TG(env) + "/deleteMessage", { method: "POST", headers: CTH, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) }, 5000).catch(() => {});
    const ctx = bag && bag.ctx;
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(pr);
  } catch (_) {}
}


/* /sync — take a fresh snapshot of the authoritative content in D1 and publish it to KV right now
   (plus this isolate's RAM cache and this colo's edge cache). Runs under the global content lock,
   so it can never publish half of a Save. Other locations pick it up within the cache TTL (~20 s). */
async function adminSyncKvFromD1(env) {
  try {
    return await __withContentMutationLock(env, async () => {
      if (!env.DB || typeof env.DB.put !== "function") return { ok: false, text: "❌ KV binding (DB) is missing." };

      let kvBefore = null;
      try {
        const raw = await env.DB.get(DB_KEY);
        if (raw) { const mm = /"_v":(\d+)/.exec(raw); kvBefore = mm ? Number(mm[1]) : 0; }
      } catch (_) {}

      __contentMetaCacheInvalidate();
      await __contentMeta(env, { fresh: true });
      const snap = await __contentLoadSnapshotFromD1(env);
      if (!snap || !contentCacheIntegrity(snap)) {
        return { ok: false, text: "❌ The D1 snapshot failed its integrity check, so KV was NOT changed.\nUse /restore with a backup if the content is damaged." };
      }

      const json = JSON.stringify(snap);
      let wrote = false, lastErr = null;
      for (let i = 0; i < 3 && !wrote; i++) {
        try { await env.DB.put(DB_KEY, json); wrote = true; }
        catch (e) { lastErr = e; if (i < 2) await new Promise(r => setTimeout(r, 150 * (i + 1))); }
      }
      if (!wrote) {
        return { ok: false, text: "❌ D1 snapshot is fine (v" + snap._v + ") but writing to KV failed: " + String(lastErr && lastErr.message || lastErr).slice(0, 120) + "\nTry /sync again." };
      }
      try { await env.DB.put("db:backup:last", json); } catch (_) {}

      GLOBAL_DB_CACHE = { value: null, expiresAt: 0 };   // this is an explicit "D1 wins" action
      setPublishedRamCache(snap);
      try { await edgeDbPut(env, snap); } catch (_) {}

      const nodes = Object.keys(snap.nodes || {}).length;
      const change = kvBefore == null ? "KV was empty" : (kvBefore === Number(snap._v) ? "KV already matched D1 (refreshed anyway)" : "KV was behind: v" + kvBefore + " → v" + snap._v);
      return { ok: true, text: "✅ KV is now in sync with D1.\n" + change + "\nVersion: " + snap._v + "\nSections: " + nodes + "\nSize: " + Math.round(json.length / 1024) + " KB\n\nUsers worldwide pick it up within about 20 seconds." };
    });
  } catch (e) {
    if (e && e.message === "ADMIN_OPERATION_BUSY") return { ok: false, text: "⏳ Another content operation (Save/Restore) is running. Try /sync again in a few seconds." };
    console.error("ADMIN_SYNC_ERROR:", e && e.message ? e.message : String(e));
    return { ok: false, text: "❌ Sync failed: " + String(e && e.message || e).slice(0, 150) };
  }
}
