from __future__ import annotations


BROWSER_INIT_SCRIPT = r"""
(() => {
  const brands = [{ brand: "Not-A.Brand", version: "24" }, { brand: "Chromium", version: "146" }];
  const fullVersionList = [{ brand: "Not-A.Brand", version: "24.0.0.0" }, { brand: "Chromium", version: "146.0.0.0" }];
  const userAgentData = {
    brands, mobile: false, platform: "Windows",
    getHighEntropyValues: async (hints = []) => {
      const values = { brands, mobile: false, platform: "Windows" };
      const map = { architecture: "x86", bitness: "64", fullVersionList, model: "", platformVersion: "10.0.0", uaFullVersion: "146.0.0.0", wow64: false };
      for (const hint of hints) if (Object.prototype.hasOwnProperty.call(map, hint)) values[hint] = map[hint];
      return values;
    },
    toJSON: () => ({ brands, mobile: false, platform: "Windows" })
  };
  const define = (target, name, value) => { try { Object.defineProperty(target, name, { get: () => value, configurable: true }); } catch (_) {} };
  define(Navigator.prototype, "platform", "Win32");
  define(Navigator.prototype, "userAgentData", userAgentData);
})();
"""


PREPARE_UPLOAD_SCRIPT = r"""
async ({body}) => {
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; const v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    });
  }
  function hex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2)); crypto.getRandomValues(bytes);
    return Array.from(bytes, item => item.toString(16).padStart(2, "0")).join("").slice(0, length);
  }
  function cookieValue(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }
  function storageFind(regex) {
    for (const store of [localStorage, sessionStorage]) for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index); const value = store.getItem(key) || "";
      if (regex.test(key) && value && value.length < 100) return value;
    }
    return "";
  }
  function query() {
    const fp = cookieValue("s_v_web_id") || storageFind(/s_v_web_id|fp|verify/i) || `verify_${Date.now()}`;
    const webId = storageFind(/web_id|tea_uuid/i).replace(/\D/g, "").slice(0, 20) || `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
    const deviceId = storageFind(/device_id|inner_did/i).replace(/\D/g, "").slice(0, 20) || webId;
    const region = cookieValue("flow_user_country") || "JP";
    const params = new URLSearchParams({ aid: "495671", channel: "g", device_id: deviceId, device_platform: "web", doubao_device_platform: "web", doubao_pc_version: "3.25.1", fp, language: "zh", pc_version: "3.25.1", pkg_type: "release_version", real_aid: "495671", region, samantha_web: "1", sys_region: region, tea_uuid: webId, tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo", "use-olympus-account": "1", version_code: "20800", web_id: webId, web_platform: "browser", web_tab_id: uuid() });
    const msToken = cookieValue("msToken") || storageFind(/mstoken/i); if (msToken) params.set("msToken", msToken);
    return params;
  }
  function sign(url) {
    for (const signer of [window.byted_acrawler, window.bytedAcrawler, window.__acrawler, window.ABogus].filter(Boolean)) {
      try {
        if (typeof signer.sign !== "function") continue;
        const result = signer.sign({ url });
        if (typeof result === "string" && result) return result;
        if (result && typeof result === "object") return result.a_bogus || result.aBogus || new URL(result.url || "", location.origin).searchParams.get("a_bogus") || "";
      } catch (_) {}
    }
    return "";
  }
  const params = query();
  let url = `${location.origin}/alice/resource/prepare_upload?${params.toString()}`;
  const aBogus = sign(url); if (aBogus) { params.set("a_bogus", aBogus); url = `${location.origin}/alice/resource/prepare_upload?${params.toString()}`; }
  const response = await fetch(url, { method: "POST", credentials: "include", headers: { accept: "application/json, text/plain, */*", "accept-language": "zh-CN,zh;q=0.9", "agw-js-conv": "str", "content-type": "application/json", "x-flow-trace": `04-${hex(32)}-${hex(16)}-01` }, body: JSON.stringify(body) });
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", responseBytes: text.length, json };
}
"""


SUBMIT_SCRIPT = r"""
async ({prompt, ratio, duration, model, attachments}) => {
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; const v = c === "x" ? r : (r & 0x3 | 0x8); return v.toString(16);
    });
  }
  function randomDigits(len) { let out = ""; for (let i = 0; i < len; i += 1) out += String(Math.floor(Math.random() * 10)); return out.replace(/^0/, "1"); }
  function randomHex(len) { const bytes = new Uint8Array(Math.ceil(len / 2)); crypto.getRandomValues(bytes); return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").slice(0, len); }
  function cookieValue(name) { const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`)); return match ? decodeURIComponent(match[1]) : ""; }
  function storageFind(regex) { for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i += 1) { const key = store.key(i); const value = store.getItem(key) || ""; if (regex.test(key) && value && value.length < 100) return value; } return ""; }
  function flowTrace() { return `04-${randomHex(32)}-${randomHex(16)}-01`; }
  function buildQuery() {
    const fp = cookieValue("s_v_web_id") || storageFind(/s_v_web_id|fp|verify/i) || `verify_${randomDigits(12)}`;
    const webId = storageFind(/web_id|tea_uuid/i).replace(/\D/g, "").slice(0, 20) || `${Date.now()}${randomDigits(6)}`;
    const deviceId = storageFind(/device_id|inner_did/i).replace(/\D/g, "").slice(0, 20) || webId;
    const region = cookieValue("flow_user_country") || "JP";
    const params = new URLSearchParams({ aid: "495671", channel: "g", device_id: deviceId, device_platform: "web", doubao_device_platform: "web", doubao_pc_version: "3.25.1", fp, language: "zh", pc_version: "3.25.1", pkg_type: "release_version", real_aid: "495671", region, samantha_web: "1", sys_region: region, tea_uuid: webId, tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo", "use-olympus-account": "1", version_code: "20800", web_id: webId, web_platform: "browser", web_tab_id: uuid() });
    const msToken = cookieValue("msToken") || storageFind(/mstoken/i); if (msToken) params.set("msToken", msToken); return params;
  }
  function trySign(url) {
    for (const signer of [window.byted_acrawler, window.bytedAcrawler, window.__acrawler, window.ABogus].filter(Boolean)) {
      try {
        if (typeof signer.sign !== "function") continue;
        const signed = signer.sign({ url });
        if (typeof signed === "string" && signed) return signed;
        if (signed && typeof signed === "object") return signed.a_bogus || signed.aBogus || new URL(signed.url || "", location.origin).searchParams.get("a_bogus") || "";
      } catch (_) {}
    }
    return "";
  }
  function parseJsonCandidate(value) {
    if (typeof value !== "string") return value;
    let current = value.trim();
    if (!current || current.length > 500000) return value;
    for (let index = 0; index < 3; index += 1) {
      if (!(current.startsWith("{") || current.startsWith("["))) return value;
      try { current = JSON.parse(current); } catch (_) { return value; }
      if (typeof current !== "string") return current;
      current = current.trim();
    }
    return current;
  }
  function walkJson(value, visit, depth = 0) {
    if (depth > 40 || value == null) return false;
    const parsed = typeof value === "string" ? parseJsonCandidate(value) : value;
    if (parsed !== value) return walkJson(parsed, visit, depth + 1);
    if (visit(value) === true) return true;
    if (Array.isArray(value)) {
      for (const item of value) if (walkJson(item, visit, depth + 1)) return true;
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) if (walkJson(item, visit, depth + 1)) return true;
    }
    return false;
  }
  function normalizedConversationId(value) {
    if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
    if (typeof value !== "string") return "";
    const candidate = value.trim();
    return /^\d{12,32}$/.test(candidate) && !/^0+$/.test(candidate) ? candidate : "";
  }
  function parseSseData(text) {
    const values = [];
    const normalized = String(text || "").replace(/\r\n?/g, "\n");
    for (const block of normalized.split(/\n\n+/)) {
      if (!block.trim()) continue;
      let event = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (!dataLines.length) continue;
      const raw = dataLines.join("\n");
      let data = raw;
      try { data = JSON.parse(raw); } catch (_) {}
      values.push({ event, data });
    }
    return values;
  }
  function extractConversationIdFromValue(value) {
    let found = "";
    walkJson(value, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return false;
      for (const key of ["conversation_id", "conversationId"]) {
        const candidate = normalizedConversationId(node[key]);
        if (candidate) { found = candidate; return true; }
      }
      return false;
    });
    return found;
  }
  function extractConversationId(text) {
    for (const item of parseSseData(text)) {
      const found = extractConversationIdFromValue(item.data);
      if (found) return found;
    }
    for (const pattern of [/"conversation_id"\s*:\s*"(\d{12,32})"/, /conversation_id(?:\\?"|)\s*[:=]\s*(?:\\?")?(\d{12,32})/, /\/chat\/(\d{12,32})(?:\D|$)/]) { const match = text.match(pattern); const found = match && normalizedConversationId(match[1]); if (found) return found; }
    return "";
  }
  function isAckValue(value) {
    let found = false;
    walkJson(value, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return false;
      for (const key of ["event", "event_type", "eventType", "type", "name"]) {
        if (typeof node[key] === "string" && node[key].trim().toUpperCase() === "SSE_ACK") { found = true; return true; }
      }
      return false;
    });
    return found;
  }
  function extractVideoUrlFromValue(value) {
    let found = "";
    const preferred = ["download_url", "video_url", "videoUrl", "play_url", "playUrl"];
    walkJson(value, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return false;
      const block = node.creation_block;
      if (!block || typeof block !== "object" || !Array.isArray(block.creations)) return false;
      for (const creation of block.creations) {
        if (!creation || typeof creation !== "object" || String(creation.type || "") !== "2") continue;
        const video = creation.video;
        if (!video || typeof video !== "object") continue;
        for (const key of preferred) {
          const candidate = video[key];
          if (typeof candidate === "string" && /^https?:\/\//i.test(candidate.trim())) { found = candidate.trim(); return true; }
        }
      }
      return false;
    });
    if (found) return found;
    walkJson(value, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return false;
      for (const key of preferred) {
        const candidate = node[key];
        const directVideoKey = key === "video_url" || key === "videoUrl";
        if (typeof candidate === "string" && /^https?:\/\//i.test(candidate.trim()) && (directVideoKey || node.video || node.creation_block || node.creations)) { found = candidate.trim(); return true; }
      }
      return false;
    });
    return found;
  }
  function extractVideoUrl(text) {
    for (const item of parseSseData(text)) {
      const found = extractVideoUrlFromValue(item.data);
      if (found) return found;
    }
    return "";
  }
  function extractVerificationDecision(text) {
    for (const item of parseSseData(text)) {
      let decision = null;
      walkJson(item.data, (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return false;
        const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
        const subtype = typeof node.subtype === "string" ? node.subtype.toLowerCase() : "";
        if (type !== "verify" && type !== "verification" && subtype !== "slide") return false;
        decision = { type: type === "verification" ? "verification" : "verify", subtype: subtype === "slide" ? "slide" : "unknown", ...(typeof node.code === "string" && /^\d{3,}$/.test(node.code) ? { code: node.code.slice(0, 32) } : {}) };
        return true;
      });
      if (decision) return decision;
    }
    const explicitSignal = /(?:captcha|verification_required|verify[_-]?(?:code|type|url|token)|security[_-]?(?:check|verification)|risk[_-]?control|slide(?:r)?[_-]?(?:captcha|verify)|verify\s+you\s+are\s+human|人机验证|验证码|滑块(?:验证)?|安全验证)/i.test(text);
    if (!explicitSignal) return null;
    const type = text.match(/["']type["']\s*[:=]\s*["'](verify|verification)["']/i)?.[1] || "verify";
    const subtype = text.match(/["']subtype["']\s*[:=]\s*["']([a-z_-]+)["']/i)?.[1] || (/(?:slide|slider|滑块)/i.test(text) ? "slide" : "unknown");
    const code = text.match(/["']code["']\s*[:=]\s*["'](\d{3,})["']/i)?.[1] || "";
    return { type, subtype, ...(code ? { code } : {}) };
  }
  function attachmentMessage(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return [{ local_message_id: uuid(), content_block: [{ block_type: 10052, content: { attachment_block: { attachments: items.map(item => ({ type: 1, identifier: item.identifier || uuid(), image: { name: item.name || "image.png", uri: item.uri || item.url || "", image_ori: { url: "", width: Number(item.width || 0), height: Number(item.height || 0), format: "", url_formats: {} } }, parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: "" })) }, pc_event_block: "" }, block_id: uuid(), parent_id: "", meta_info: [], append_fields: [] }], message_status: 0 }];
  }
  const localConversationId = `local_${randomDigits(16)}`;
  const params = buildQuery();
  const collectionId = attachments.length ? uuid() : "";
  const messages = [...attachmentMessage(attachments), { local_message_id: uuid(), content_block: [{ block_type: 10000, content: { text_block: { text: `生成视频：${[prompt, ratio].filter(Boolean).join("，")}`, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" }, block_id: uuid(), parent_id: "", meta_info: [], append_fields: [] }], message_status: 0 }];
  const body = { client_meta: { local_conversation_id: localConversationId, conversation_id: "", bot_id: "7339470689562525703", last_section_id: "", last_message_index: null }, messages, option: { send_message_scene: "", create_time_ms: Date.now(), collect_id: collectionId, is_audio: false, answer_with_suggest: false, tts_switch: false, need_deep_think: 0, click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false, is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false, select_text_action: "", is_select_text: false, resend_for_regen: false, scene_type: 0, unique_key: uuid(), start_seq: 0, need_create_conversation: true, conversation_init_option: { need_ack_conversation: true }, regen_query_id: [], edit_query_id: [], regen_instruction: "", no_replace_for_regen: false, message_from: 0, shared_app_name: "", shared_app_id: "", sse_recv_event_options: { support_chunk_delta: true }, is_ai_playground: false, is_old_user: false, recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 }, message_storage_type: 0 }, chat_ability: { ability_type: 17, ability_param: JSON.stringify({ ratio, model, duration: Number(duration) }) }, user_context: [], ext: { answer_with_suggest: "0", fp: cookieValue("s_v_web_id") || "", sub_conv_firstmet_type: "1", collection_id: collectionId, conversation_init_option: JSON.stringify({ need_ack_conversation: true }), commerce_credit_config_enable: "0" } };
  body.client_meta.local_permissions = [{ permission_name: "ACCESS_COARSE_LOCATION", status: 3 }, { permission_name: "ACCESS_FINE_LOCATION", status: 3 }, { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 3 }];
  body.option.related_deleted_message_ids = {};
  body.option.connector_info_list = [];
  body.option.model_config = { model_item_key: "", model_extra_params: {} };
  body.option.aggregate_params = { conversation_mode: "", mode_id: "", model_item_key: "", agent_mode: "", reasoning_effort: "", provider_id: "" };
  body.chat_ability.ability_param = JSON.stringify({ ratio, model, duration: Number(duration), camera_movement: "fixed", input_box_content: { user_input_content: [prompt, ratio].filter(Boolean).join("，"), reply_message_format: "生成视频：%s" } });
  body.ext.is_finish = "1";
  history.pushState({}, "", `/chat/${localConversationId}`);
  let url = `${location.origin}/chat/completion?${params.toString()}`; const aBogus = trySign(url); if (aBogus) { params.set("a_bogus", aBogus); url = `${location.origin}/chat/completion?${params.toString()}`; }
  const response = await fetch(url, { method: "POST", credentials: "include", headers: { accept: "*/*", "accept-language": "zh-CN,zh;q=0.9", "agw-js-conv": "str, str", "content-type": "application/json", "last-event-id": "undefined", "x-flow-trace": flowTrace() }, body: JSON.stringify(body) });
  let text = ""; const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (reader) { const decoder = new TextDecoder("utf-8"); const deadline = Date.now() + 45000; while (Date.now() < deadline) { const result = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))]); if (result.timeout) break; if (result.done) break; text += decoder.decode(result.value, { stream: true }); } try { await reader.cancel(); } catch (_) {} text += decoder.decode(); } else text = await response.text();
  const restricted = text.includes("country restricted") || location.href.includes("region-restricted");
  const verificationDecision = extractVerificationDecision(text);
  const events = parseSseData(text);
  const ackReceived = events.some((item) => item.event.toUpperCase() === "SSE_ACK" || isAckValue(item.data) || Boolean(extractConversationIdFromValue(item.data)));
  const conversationId = extractConversationId(text) || extractConversationId(location.href);
  return { status: response.status, contentType: response.headers.get("content-type") || "", responseBytes: text.length, conversationId, videoUrl: extractVideoUrl(text), ackReceived, deviceId: params.get("device_id") || "", webId: params.get("web_id") || "", teaUuid: params.get("tea_uuid") || "", region: params.get("region") || "", sysRegion: params.get("sys_region") || "", webTabId: params.get("web_tab_id") || "", timedOut: !text, restricted, verificationRequired: Boolean(verificationDecision), verificationDecision, serviceFrequent: text.includes("710022002") || text.includes("服务访问频繁"), preview: text.slice(0, 4000) };
}
"""


# Executes in the page MAIN world via add_script_tag. The request goes through
# the page's bdms-patched XMLHttpRequest, which appends the a_bogus signature
# that /chat/completion requires. Results are delivered through the DOM so the
# isolated-world controller can read them.
MAIN_WORLD_SUBMIT_SCRIPT = r"""
(() => {
  const cfg = window.__DOLA_SUBMIT_CONFIG__ || {};
  const previous = document.getElementById("__dola_submit_result__");
  if (previous) previous.remove();
  const el = document.createElement("textarea");
  el.id = "__dola_submit_result__";
  el.style.display = "none";
  document.documentElement.appendChild(el);
  const done = (info) => { try { el.value = JSON.stringify(info); } catch (_) { el.value = JSON.stringify({ fatal: "result_serialize_failed" }); } };
  try {
    const completionKeys = new Set([
      "aid", "device_id", "device_platform", "doubao_device_platform",
      "doubao_pc_version", "fp", "language", "pc_version", "pkg_type",
      "real_aid", "region", "samantha_web", "sys_region", "tea_uuid",
      "tz_name", "use-olympus-account", "version_code", "web_id",
      "web_platform", "web_tab_id"
    ]);
    const liveRequest = () => {
      const resources = performance.getEntriesByType("resource");
      let best = null;
      let bestScore = -1;
      for (let index = resources.length - 1; index >= 0; index -= 1) {
        try {
          const candidate = new URL(resources[index].name, location.origin);
          if (candidate.origin !== location.origin) continue;
          const identityScore = ["device_id", "web_id", "tea_uuid", "web_tab_id", "fp"].reduce((total, key) => total + (candidate.searchParams.get(key) ? 1 : 0), 0);
          if (identityScore <= bestScore || !candidate.searchParams.get("device_id") || !candidate.searchParams.get("web_id")) continue;
          best = candidate;
          bestScore = identityScore;
          if (identityScore >= 5) break;
        } catch (_) {}
      }
      if (!best) return null;
      const params = new URLSearchParams();
      for (const [key, value] of best.searchParams.entries()) if (completionKeys.has(key) && value) params.set(key, value);
      const identity = Object.fromEntries(["device_id", "web_id", "tea_uuid", "region", "sys_region", "web_tab_id", "tz_name"].map((key) => [key, params.get(key) || ""]));
      return { url: `${location.origin}/chat/completion?${params.toString()}`, identity, identitySource: best.pathname };
    };
    const fallbackRequest = () => {
      if (!cfg.fallbackQuery) return null;
      const params = new URLSearchParams(String(cfg.fallbackQuery));
      if (!params.get("device_id") || !params.get("web_id")) return null;
      const identity = Object.fromEntries(["device_id", "web_id", "tea_uuid", "region", "sys_region", "web_tab_id", "tz_name"].map((key) => [key, params.get(key) || ""]));
      return { url: `${location.origin}/chat/completion?${params.toString()}`, identity, identitySource: "provider_fresh_identity" };
    };
    const send = (request) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", request.url);
      xhr.setRequestHeader("accept", "*/*");
      xhr.setRequestHeader("accept-language", "zh-CN,zh;q=0.9");
      xhr.setRequestHeader("agw-js-conv", "str, str");
      xhr.setRequestHeader("content-type", "application/json");
      xhr.setRequestHeader("last-event-id", "undefined");
      let settled = false;
      let settleTimer = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        let text = "";
        try { text = xhr.responseText || ""; } catch (_) {}
        let signed = false;
        try { signed = new URL(xhr.responseURL || request.url, location.origin).searchParams.has("a_bogus"); } catch (_) {}
        done({ status: xhr.status, contentType: (xhr.getResponseHeader && xhr.getResponseHeader("content-type")) || "", responseBytes: text.length, text: text.slice(0, 262144), identity: request.identity, identitySource: request.identitySource, signed });
      };
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 3 && /event:\s*SSE_REPLY_END/.test(xhr.responseText || "")) {
          settleTimer = setTimeout(finish, 800);
        } else if (xhr.readyState === 4) {
          settleTimer = setTimeout(finish, 200);
        }
      };
      xhr.onerror = () => { settleTimer = setTimeout(finish, 200); };
      xhr.send(cfg.body);
      setTimeout(finish, cfg.timeoutMs || 60000);
    };
    const waitReady = () => {
      const signerReady = typeof window.bdms === "object";
      const deadlineReached = Date.now() >= (cfg.hookDeadline || 0);
      const request = liveRequest() || (deadlineReached ? fallbackRequest() : null);
      if (request && (signerReady || deadlineReached)) return send(request);
      if (deadlineReached) return done({ fatal: "page_identity_unavailable", pageUrl: location.href, pageTitle: document.title || "" });
      return setTimeout(waitReady, 250);
    };
    waitReady();
  } catch (e) {
    done({ fatal: String(e && e.message || e).slice(0, 300) });
  }
})();
"""


# Performs a read-only request through the exact page signer and identity used
# by video submission. It is used for account validation and signed result
# polling; paths and bodies are supplied only by the provider implementation.
MAIN_WORLD_JSON_REQUEST_SCRIPT = r"""
(() => {
  const cfg = window.__DOLA_JSON_REQUEST_CONFIG__ || {};
  const resultId = String(cfg.resultId || "__dola_json_request_result__");
  const previous = document.getElementById(resultId);
  if (previous) previous.remove();
  const el = document.createElement("textarea");
  el.id = resultId;
  el.style.display = "none";
  document.documentElement.appendChild(el);
  const done = (value) => { try { el.value = JSON.stringify(value); } catch (_) { el.value = JSON.stringify({ fatal: "result_serialize_failed" }); } };
  try {
    const identityKeys = new Set([
      "aid", "device_id", "device_platform", "doubao_device_platform",
      "doubao_pc_version", "fp", "language", "pc_version", "pkg_type",
      "real_aid", "region", "samantha_web", "sys_region", "tea_uuid",
      "tz_name", "use-olympus-account", "version_code", "web_id",
      "web_platform", "web_tab_id"
    ]);
    const liveRequest = () => {
      const resources = performance.getEntriesByType("resource");
      let best = null;
      let bestScore = -1;
      for (let index = resources.length - 1; index >= 0; index -= 1) {
        try {
          const candidate = new URL(resources[index].name, location.origin);
          if (candidate.origin !== location.origin) continue;
          const identityScore = ["device_id", "web_id", "tea_uuid", "web_tab_id", "fp"].reduce((total, key) => total + (candidate.searchParams.get(key) ? 1 : 0), 0);
          const pathScore = candidate.pathname === "/chat/completion" ? 50 : candidate.pathname.includes("/samantha/user/") ? 40 : candidate.pathname.includes("/im/chain/") ? 30 : candidate.pathname.includes("/alice/") ? 20 : candidate.pathname === "/im/project/list" ? 0 : 10;
          const score = identityScore * 100 + pathScore;
          if (score <= bestScore || !candidate.searchParams.get("device_id") || !candidate.searchParams.get("web_id")) continue;
          best = candidate;
          bestScore = score;
        } catch (_) {}
      }
      if (!best) return null;
      const params = new URLSearchParams();
      for (const [key, value] of best.searchParams.entries()) if (identityKeys.has(key) && value) params.set(key, value);
      const identity = Object.fromEntries(["device_id", "web_id", "tea_uuid", "region", "sys_region", "web_tab_id", "tz_name"].map((key) => [key, params.get(key) || ""]));
      return { url: `${location.origin}${cfg.path}?${params.toString()}`, identity, identitySource: best.pathname };
    };
    const send = (request) => {
      const xhr = new XMLHttpRequest();
      xhr.open(String(cfg.method || "POST"), request.url);
      xhr.setRequestHeader("accept", "application/json, text/plain, */*");
      xhr.setRequestHeader("accept-language", "zh-CN,zh;q=0.9");
      xhr.setRequestHeader("agw-js-conv", "str");
      xhr.setRequestHeader("content-type", "application/json; encoding=utf-8");
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        let text = "";
        try { text = xhr.responseText || ""; } catch (_) {}
        let signed = false;
        try { signed = new URL(xhr.responseURL || request.url, location.origin).searchParams.has("a_bogus"); } catch (_) {}
        done({ status: xhr.status, contentType: (xhr.getResponseHeader && xhr.getResponseHeader("content-type")) || "", responseBytes: text.length, text: text.slice(0, 524288), identity: request.identity, identitySource: request.identitySource, signed });
      };
      xhr.onloadend = finish;
      xhr.onerror = finish;
      xhr.send(String(cfg.body || "{}"));
      setTimeout(finish, cfg.timeoutMs || 30000);
    };
    const waitReady = () => {
      const request = liveRequest();
      const signerReady = typeof window.bdms === "object";
      const deadlineReached = Date.now() >= (cfg.hookDeadline || 0);
      if (request && (signerReady || deadlineReached)) return send(request);
      if (deadlineReached) return done({ fatal: "page_identity_unavailable", signerReady, pageUrl: location.href, pageTitle: document.title || "" });
      setTimeout(waitReady, 250);
    };
    waitReady();
  } catch (e) {
    done({ fatal: String(e && e.message || e).slice(0, 300) });
  }
})();
"""


# Reads Dola's commerce credit balance through the same live page identity and
# signed main-world XHR path as the web app. This endpoint is read only.
MAIN_WORLD_CREDIT_SCRIPT = r"""
(() => {
  const cfg = window.__DOLA_CREDIT_CONFIG__ || {};
  const previous = document.getElementById("__dola_credit_result__");
  if (previous) previous.remove();
  const el = document.createElement("textarea");
  el.id = "__dola_credit_result__";
  el.style.display = "none";
  document.documentElement.appendChild(el);
  const done = (value) => { try { el.value = JSON.stringify(value); } catch (_) { el.value = JSON.stringify({ fatal: "result_serialize_failed" }); } };
  const routerMarkup = Array.from(document.scripts).map((script) => script.textContent || "").find((text) => text.includes("enableCommerceCredit")) || "";
  const creditEnabled = /["']enableCommerceCredit["']\s*:\s*["'](?:1|true)["']/i.test(routerMarkup);
  if (!creditEnabled) {
    done({ fatal: "upstream_quota_not_exposed", pageUrl: location.href, pageTitle: document.title || "" });
    return;
  }
  const completionKeys = new Set([
    "aid", "device_id", "device_platform", "doubao_device_platform",
    "doubao_pc_version", "fp", "language", "pc_version", "pkg_type",
    "real_aid", "region", "samantha_web", "sys_region", "tea_uuid",
    "tz_name", "use-olympus-account", "version_code", "web_id",
    "web_platform", "web_tab_id"
  ]);
  const liveRequest = () => {
    const resources = performance.getEntriesByType("resource");
    let best = null;
    let bestScore = -1;
    for (let index = resources.length - 1; index >= 0; index -= 1) {
      try {
        const candidate = new URL(resources[index].name, location.origin);
        if (candidate.origin !== location.origin) continue;
        const score = ["device_id", "web_id", "tea_uuid", "web_tab_id", "fp"].reduce((total, key) => total + (candidate.searchParams.get(key) ? 1 : 0), 0);
        if (score <= bestScore || !candidate.searchParams.get("device_id") || !candidate.searchParams.get("web_id")) continue;
        best = candidate;
        bestScore = score;
        if (score >= 5) break;
      } catch (_) {}
    }
    if (!best) return null;
    const params = new URLSearchParams();
    for (const [key, value] of best.searchParams.entries()) if (completionKeys.has(key) && value) params.set(key, value);
    return { url: `${location.origin}/commerce/benefit_supply/credit/get_credit_num_optional_tasks?${params.toString()}`, identitySource: best.pathname };
  };
  const send = (request) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", request.url);
    xhr.setRequestHeader("accept", "application/json, text/plain, */*");
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("agw-js-conv", "str");
    xhr.withCredentials = true;
    xhr.onloadend = () => {
      let text = "";
      try { text = xhr.responseText || ""; } catch (_) {}
      let signed = false;
      try { signed = new URL(xhr.responseURL || request.url, location.origin).searchParams.has("a_bogus"); } catch (_) {}
      done({ status: xhr.status, contentType: (xhr.getResponseHeader && xhr.getResponseHeader("content-type")) || "", responseBytes: text.length, text: text.slice(0, 131072), identitySource: request.identitySource, signed });
    };
    xhr.send(JSON.stringify({ need_tasks: true }));
  };
  const waitReady = () => {
    const request = liveRequest();
    const signerReady = typeof window.bdms === "object";
    const deadlineReached = Date.now() >= (cfg.hookDeadline || 0);
    if (request && (signerReady || deadlineReached)) return send(request);
    if (deadlineReached) return done({ fatal: "page_identity_unavailable" });
    setTimeout(waitReady, 250);
  };
  waitReady();
})();
"""


# Injects 15s / 30s options into Dola web interface action bars & intercepts chat completion
# Derived from doubaokit-main and dola-30s-unlocker-main
DOLA_30S_UNLOCKER_SCRIPT = r"""
(() => {
  if (window.__DOLA_30S_UNLOCKER_INJECTED__) return;
  window.__DOLA_30S_UNLOCKER_INJECTED__ = true;

  function matchUrl(rawInput, pattern) {
    if (!rawInput) return false;
    const rawStr = typeof rawInput === "string" ? rawInput : (rawInput.url || rawInput.href || String(rawInput || ""));
    if (rawStr.includes(pattern)) return true;
    try {
      const absUrl = new URL(rawStr, window.location.origin).href;
      return absUrl.includes(pattern);
    } catch (_) {
      return false;
    }
  }

  function patchAnyDuration(value, seen = new Set()) {
    if (value == null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    let changed = false;

    if (Array.isArray(value)) {
      for (const item of value) {
        changed = patchAnyDuration(item, seen) || changed;
      }
      return changed;
    }

    const label = String(value.label || value.name || value.title || value.show_name || value.value || "");
    const isDuration = label.includes("时长") || label.includes("鏃堕暱") || label.toLowerCase().includes("duration");

    if (Array.isArray(value.option_list)) {
      const hasDuration = isDuration || value.option_list.some((opt) => opt && (String(opt.option_key) === "5" || String(opt.option_key) === "10" || String(opt.display_text || "").toLowerCase().includes("5s")));
      if (hasDuration) {
        for (const d of ["15", "30"]) {
          if (!value.option_list.some((opt) => opt && (String(opt.option_key) === d || String(opt.value) === d || String(opt.display_text) === d + "s"))) {
            const maxId = value.option_list.reduce((max, opt) => {
              const id = Number(opt && opt.id);
              return Number.isFinite(id) ? Math.max(max, id) : max;
            }, 0);
            value.option_list.push({
              id: maxId + 1,
              display_text: d === "30" ? "30s" : "15s",
              show_name: d === "30" ? "30s" : "15s",
              message_text: "",
              option_key: d,
              value: d,
              is_default: false,
              sub_display: ""
            });
            changed = true;
          }
        }
      }
    }

    if (Array.isArray(value.options)) {
      const hasDuration = isDuration || value.options.some((opt) => opt && (String(opt.value) === "5" || String(opt.value) === "10" || String(opt.option_key) === "10" || String(opt.show_name || "").toLowerCase().includes("5s")));
      if (hasDuration) {
        for (const d of ["15", "30"]) {
          if (!value.options.some((opt) => opt && (String(opt.value) === d || String(opt.option_key) === d || String(opt.show_name) === d + "s"))) {
            value.options.push({
              show_name: d === "30" ? "30s" : "15s",
              display_text: d === "30" ? "30s" : "15s",
              value: d,
              option_key: d,
              is_default: false,
              sub_display: ""
            });
            changed = true;
          }
        }
      }
    }

    if (Array.isArray(value.supported_durations)) {
      for (const d of ["15", "30"]) {
        if (!value.supported_durations.includes(d) && !value.supported_durations.includes(Number(d))) {
          value.supported_durations.push(d);
          changed = true;
        }
      }
    }

    for (const k of Object.keys(value)) {
      const child = value[k];
      if (typeof child === "string") {
        const trimmed = child.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (patchAnyDuration(parsed, seen)) {
              value[k] = JSON.stringify(parsed);
              changed = true;
            }
          } catch (_) {}
        }
      } else {
        changed = patchAnyDuration(child, seen) || changed;
      }
    }
    return changed;
  }

  function patchResponseText(rawText) {
    if (!rawText || typeof rawText !== "string") return rawText;
    try {
      const json = JSON.parse(rawText);
      const changed = patchAnyDuration(json);
      return changed ? JSON.stringify(json) : rawText;
    } catch (_) {
      return rawText;
    }
  }

  function sanitizePromptText(text) {
    if (!text || typeof text !== "string") return text;
    let res = text;
    res = res.replace(/生成(?:一段|一个)?\s*(?:\d+(?:\s*[-~到至]\s*\d+)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*(?:的)?(?:短?视频|片断|片段|微电影)?\s*[:：]?/g, "");
    res = res.replace(/(?:视频)?时长\s*[:：=为是]?\s*(?:\d+(?:\s*[-~到至]\s*\d+)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\b/gi, "");
    res = res.replace(/\bduration\s*[:=]\s*\d+\s*s?\b/gi, "");
    res = res.replace(/(?:\d+(?:\s*[-~到至]\s*\d+)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)\s*(?:的)?(?:短?视频|片断|片段|微电影)/gi, "");
    res = res.replace(/(?:^|(?<=[\s,，、;:：]))(?:\d+(?:\s*[-~到至]\s*\d+)?|\d+)\s*(?:秒钟?|s(?:ec(?:onds?)?)?)(?=$|[\s,，、;:：])/gi, "");
    res = res.replace(/[,，、\s]+/g, (m) => m.includes("，") || m.includes(",") ? "，" : " ");
    res = res.replace(/^[，,、\s:：]+|[，,、\s:：]+$/g, "");
    if (res.startsWith("生成视频：") || res.startsWith("生成视频:")) {
      const rest = res.slice(5).trim();
      if (rest) res = rest;
    }
    return res.trim();
  }

  function patchCompletionRequestBody(bodyText) {
    if (!bodyText || typeof bodyText !== "string") return bodyText;
    try {
      const data = JSON.parse(bodyText);
      let changed = false;
      if (Array.isArray(data.content_block)) {
        for (const block of data.content_block) {
          if (block && block.content && block.content.text_block && typeof block.content.text_block.text === "string") {
            const cleaned = sanitizePromptText(block.content.text_block.text);
            if (cleaned !== block.content.text_block.text) {
              block.content.text_block.text = cleaned || "生成视频";
              changed = true;
            }
          }
        }
      }
      const ability = data.chat_ability || data.ability;
      if (ability && ability.ability_param && typeof ability.ability_param === "string") {
        try {
          const param = JSON.parse(ability.ability_param);
          let pChanged = false;
          if (!param.camera_movement) {
            param.camera_movement = "fixed";
            pChanged = true;
          }
          if (param.input_box_content && typeof param.input_box_content.user_input_content === "string") {
            const cleanedInput = sanitizePromptText(param.input_box_content.user_input_content);
            if (cleanedInput !== param.input_box_content.user_input_content) {
              param.input_box_content.user_input_content = cleanedInput || "生成视频";
              pChanged = true;
            }
          }
          if (pChanged) {
            ability.ability_param = JSON.stringify(param);
            changed = true;
          }
        } catch (_) {}
      }
      return changed ? JSON.stringify(data) : bodyText;
    } catch (_) {
      return bodyText;
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const isConfigApi =
      matchUrl(input, "samantha/skill/pack") ||
      matchUrl(input, "skill/pack") ||
      matchUrl(input, "action_bar_v3/get_item_conf") ||
      matchUrl(input, "get_item_conf") ||
      matchUrl(input, "slot/action_bar") ||
      matchUrl(input, "samantha/creation");

    let finalInit = init;
    if (matchUrl(input, "/chat/completion")) {
      const body = (init && init.body) || (input && input.body);
      if (typeof body === "string") {
        const patchedBody = patchCompletionRequestBody(body);
        if (patchedBody !== body) {
          finalInit = Object.assign({}, init, { body: patchedBody });
        }
      }
    }

    const response = await originalFetch.apply(this, [input, finalInit]);
    if (isConfigApi) {
      try {
        const rawText = await response.text();
        const patchedText = patchResponseText(rawText);
        return new Response(patchedText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (_) {
        return response;
      }
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const xhrUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function () {
    xhrUrls.set(this, arguments[1]);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = xhrUrls.get(this);
    let finalBody = body;
    if (url && typeof url === "string" && url.includes("/chat/completion") && typeof body === "string") {
      finalBody = patchCompletionRequestBody(body);
    }

    const isConfigApi = url && typeof url === "string" && (
      url.includes("samantha/skill/pack") ||
      url.includes("skill/pack") ||
      url.includes("action_bar_v3/get_item_conf") ||
      url.includes("get_item_conf") ||
      url.includes("slot/action_bar") ||
      url.includes("samantha/creation")
    );

    if (isConfigApi) {
      const self = this;
      this.addEventListener("readystatechange", function () {
        if (self.readyState === 4 && self.status === 200) {
          try {
            const patched = patchResponseText(self.responseText);
            Object.defineProperty(self, "responseText", { value: patched, configurable: true });
            Object.defineProperty(self, "response", { value: patched, configurable: true });
          } catch (_) {}
        }
      });
    }

    return origSend.apply(this, [finalBody]);
  };
})();
"""

