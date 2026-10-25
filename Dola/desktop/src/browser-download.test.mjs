import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import vm from "node:vm";
import { fetchTrustedMedia, trustedMediaUrl } from "./media-url.mjs";
import { resolveDolaWatermarkUrlRemote } from "./watermark.mjs";

const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
const section = (start, end) => main.slice(main.indexOf(`async function ${start}(`), main.indexOf(`async function ${end}(`));
const runtimeSource = section("downloadCurrentBrowserVideo", "captureAccount")
  + section("queryTaskInBrowser", "mediaSession")
  + section("refreshTask", "observeTaskInBrowser")
  + section("downloadTaskAssets", "chooseDownloadDirectory");
const conversationId = "38418080062463249";
const videoUrl = "http://v16-dola.dola.com/final.mp4";
const unwatermarkedUrl = "https://v16-dola.dola.com/no-watermark.mp4?sig=fixture";
const vodPayload = { fallback_api: "https://vod-urls-mya.byteintlapi.com/video?sig=fixture" };

async function harness(t, { source = "provider-protocol", browserResult, currentConversation = conversationId, activeAccountId = "account", watermarkFails = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dola-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], mediaCalls = [], events = [], executions = [], navigations = [];
  const task = { id: "fixture-task", accountId: "account", model: "dola-seedance-2-5", conversationId, source, status: "failed", error: "upstream_unsupported_duration", rawError: "旧的时长限制回复", resultUrls: [] };
  const account = { id: "account", cookieCiphertext: "fixture" };
  const store = { root, state: { tasks: [task], accounts: [account], assets: [], settings: { autoRemoveWatermark: false, autoDownload: false } }, save: async () => {} };
  const view = { webContents: {
    isDestroyed: () => false,
    getURL: () => `https://www.dola.com/chat/${currentConversation}`,
    loadURL: async (url) => { navigations.push(url); currentConversation = url.split("/").at(-1); },
    executeJavaScript: async (script) => {
      executions.push(script);
      assert.ok(script.includes("/im/chain/single"));
      assert.ok(script.includes(conversationId));
      return { status: 200, text: JSON.stringify({ code: 0, downlink_body: { pull_singe_chain_downlink_body: { conversation_id: conversationId } } }) };
    },
  } };
  const context = vm.createContext({
    store, browserView: view, activeAccountId, registration: undefined, observedTaskId: "",
    window: { webContents: { send: (event, payload) => events.push({ event, payload }) } },
    randomUUID, Date, path, mkdir, copyFile, readFile, rename, rm, pipeline, Readable, createWriteStream,
    fetchTrustedMedia, trustedMediaUrl, resolveDolaWatermarkUrlRemote,
    mediaSession: async () => ({ fetch: async (url) => {
      mediaCalls.push(url);
      if (new URL(url).hostname === "vod-urls-mya.byteintlapi.com") {
        if (watermarkFails) return new Response("fixture rejected", { status: 503 });
        return Response.json({ data: { video_list: { hd: { main_url: Buffer.from(unwatermarkedUrl).toString("base64"), vwidth: 1080, vheight: 1920 } } } });
      }
      assert.equal(url, unwatermarkedUrl);
      return new Response("fixture-video-bytes", { headers: { "content-type": "video/mp4" } });
    } }),
    providerJson: async (route, options) => {
      calls.push({ route, body: options?.body ? JSON.parse(options.body) : null });
      if (route.endsWith("/browser-query")) return { path: "/im/chain/single", body: { conversation_id: conversationId }, script: "/* fixture */" };
      if (route.endsWith("/browser-result")) return browserResult || { status: "completed", videoUrl, vodPayload };
      return { status: "failed", error: "upstream_unsupported_duration", rawError: "旧的时长限制回复" };
    },
  });
  vm.runInContext(runtimeSource, context);
  return { context, store, task, calls, events, executions, navigations, mediaCalls };
}

for (const source of ["provider-protocol", "browser", "workspace-browser"]) test(`current ${source} conversation recovers stale failure and downloads the actual no-watermark file`, async (t) => {
  const fixture = await harness(t, { source });
  await fixture.context.downloadCurrentBrowserVideo();
  assert.equal(fixture.task.status, "completed");
  assert.equal(fixture.task.error, "");
  assert.equal(fixture.task.rawError, "");
  assert.deepEqual(Array.from(fixture.task.resultUrls), [videoUrl]);
  assert.equal(fixture.task.unwatermarkedUrl, unwatermarkedUrl);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].body.accountId, "account");
  assert.equal(fixture.calls[1].body.conversationId, conversationId);
  assert.equal(fixture.navigations.length, 0);
  const vod = new URL(fixture.mediaCalls[0]);
  assert.equal(vod.searchParams.get("logo_type"), "unwatermarked");
  assert.equal(vod.searchParams.get("channel"), "no");
  assert.equal(vod.searchParams.get("codec_type"), "8");
  assert.equal(fixture.mediaCalls[1], unwatermarkedUrl);
  const saved = fixture.store.state.assets[0];
  assert.equal(saved.sourceUrl, unwatermarkedUrl);
  assert.equal(await readFile(path.join(fixture.store.root, "downloads", "fixture-task-1.mp4"), "utf8"), "fixture-video-bytes");
  assert.equal(fixture.events.at(-1).payload.type, "download-complete");
});

test("a genuinely pending video is not downloaded or treated as completed", async (t) => {
  const fixture = await harness(t, { browserResult: { status: "accepted" } });
  await assert.rejects(fixture.context.downloadCurrentBrowserVideo(), /当前视频尚未生成完成/);
  assert.equal(fixture.task.status, "accepted");
  assert.equal(fixture.mediaCalls.length, 0);
  assert.equal(fixture.store.state.assets.length, 0);
});

test("a no-watermark resolution error never silently downloads the watermarked original", async (t) => {
  const fixture = await harness(t, { watermarkFails: true });
  await assert.rejects(fixture.context.downloadCurrentBrowserVideo(), /无水印 VOD 请求失败/);
  assert.equal(fixture.mediaCalls.length, 1);
  assert.equal(fixture.store.state.assets.length, 0);
  assert.equal(fixture.events.some(({ payload }) => payload.type === "download-complete"), false);
});

for (const options of [{ activeAccountId: "other-account" }, { currentConversation: "38418080062463250" }]) test(`download never selects another account or conversation: ${JSON.stringify(options)}`, async (t) => {
  const fixture = await harness(t, options);
  await assert.rejects(fixture.context.downloadCurrentBrowserVideo(), /当前会话尚未登记/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.mediaCalls.length, 0);
});

test("a Provider task in another conversation keeps its protocol query without browser navigation", async (t) => {
  const fixture = await harness(t, { currentConversation: "38418080062463250" });
  await fixture.context.refreshTask(fixture.task.id, true);
  assert.equal(fixture.calls[0].route, "/internal/runtime/v1/videos/fixture-task");
  assert.equal(fixture.executions.length, 0);
  assert.equal(fixture.navigations.length, 0);
});

test("background polling keeps the existing Provider query contract", async (t) => {
  const fixture = await harness(t);
  await fixture.context.refreshTask(fixture.task.id);
  assert.equal(fixture.calls[0].route, "/internal/runtime/v1/videos/fixture-task");
  assert.equal(fixture.executions.length, 0);
});
