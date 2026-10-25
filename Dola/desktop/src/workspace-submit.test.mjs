import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { completionRequestShape } from "./manual-task.mjs";

const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
const source = main.slice(main.indexOf("async function submitTask("), main.indexOf("async function replayTask("));

function harness({ rejected = false, busy = false, preparationError = false } = {}) {
  const calls = [];
  const executions = [];
  const polls = [];
  const account = { id: "fixture-account", credentialVersion: 1, cookieCiphertext: "fixture", cookieFingerprint: "fixture" };
  const store = { state: { accounts: [account], tasks: [], settings: {} }, cookie: () => "sessionid=fixture", fingerprint: () => "fixture", save: async () => {} };
  let finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  const view = { webContents: {
    isDestroyed: () => false,
    getURL: () => "https://www.dola.com/chat",
    session: { cookies: { get: async () => [{ name: "sessionid", value: "fixture" }] } },
    executeJavaScript: async (script) => {
      executions.push(script);
      if (script.includes("window.__DOLA_SUBMIT_CONFIG__")) {
        const config = vm.runInNewContext(script, { window: {} });
        assert.equal(JSON.parse(config.body).chat_ability.ability_type, 17);
        assert.equal(config.ruleBody, "");
      } else return JSON.stringify({ status: 200, signed: true, text: "fixture ACK" });
    },
  } };
  const context = vm.createContext({
    randomUUID, store, browserView: view, activeAccountId: account.id,
    workspaceSubmissionView: busy ? view : undefined,
    completionRequestShape, Date, setTimeout,
    window: { webContents: { send: (_event, payload) => { if (["accepted", "failed"].includes(payload.task?.status)) finish(payload.task); } } },
    resolveAccountProxy: async () => ({ url: "http://fixture-submit", name: "fixture-proxy", source: "fixture" }),
    resolveProxy: async () => ({ url: "http://fixture-upload" }),
    accountIdentity: async () => ({ device_id: "fixture-device" }),
    observeTaskInBrowser: async () => {},
    scheduleTaskPoll: (id) => polls.push(id),
    providerJson: async (route, options) => {
      const request = options?.body ? JSON.parse(options.body) : {};
      calls.push({ route, request });
      if (route.endsWith("/upload-script")) return { body: {}, script: "async () => ({ok:true,json:{code:0,data:{fixture:true}}})" };
      if (route.endsWith("/prepare")) {
        if (preparationError) throw new Error("fixture_prepare_failed");
        return {
          body: { chat_ability: { ability_type: 17, ability_param: JSON.stringify({ model: "seedance_v2.5", duration: request.duration, ratio: request.ratio }) } },
          script: "window.__DOLA_SUBMIT_CONFIG__", referenceCount: request.references.length,
          resolvedReferences: request.references.map((item) => ({ uri: "imagex://fixture", role: item.role, name: item.name })),
        };
      }
      if (route.endsWith("/parse")) return rejected ? { status: "failed", error: "fixture_upstream_rejected" } : { status: "accepted", conversationId: "38418048283899153", identity: { device_id: "fixture-device" } };
      return { taskId: "provider-fixture-task", status: route.endsWith("/adopt-browser") ? "accepted" : "queued" };
    },
  });
  // Upload authorization also executes in the current account page.
  const execute = view.webContents.executeJavaScript;
  view.webContents.executeJavaScript = async (script) => script.includes("async () => ({ok:true") ? vm.runInNewContext(script) : execute(script);
  vm.runInContext(source, context);
  return { context, calls, executions, polls, store, settled, submit: (input, workspace = true) => context.submitTask({ accountId: account.id, model: "dola-seedance-2-5", prompt: "云朵飘过山顶", duration: 30, ratio: "9:16", ...input }, workspace) };
}

for (const duration of [5, 15, 20, 30]) test(`workspace ${duration}s uses the active page and adopts the same task`, async () => {
  const fixture = harness();
  const task = await fixture.submit({ duration });
  await fixture.settled;
  assert.equal(task.source, "workspace-browser");
  assert.equal(task.duration, duration);
  assert.equal(task.status, "accepted");
  assert.equal(task.conversationId, "38418048283899153");
  assert.equal(fixture.store.state.tasks.length, 1);
  assert.equal(fixture.calls.some(({ route }) => route.endsWith("/videos")), false);
  const prepared = fixture.calls.find(({ route }) => route.endsWith("/prepare")).request;
  assert.equal(prepared.duration, duration);
  assert.equal(prepared.cookie, "sessionid=fixture");
  assert.equal(prepared.proxyUrl, "http://fixture-submit");
  assert.equal(fixture.calls.at(-1).request.taskId, task.id);
  assert.deepEqual(fixture.polls, [task.id]);
});

test("30s reference submission retains roles, independent upload egress and duration", async () => {
  const fixture = harness();
  const references = ["first_frame", "last_frame"].map((role) => ({ id: role, name: `${role}.png`, role, dataUrl: "data:image/png;base64,AAAA" }));
  const task = await fixture.submit({ references });
  await fixture.settled;
  const preparations = fixture.calls.filter(({ route }) => route.endsWith("/prepare"));
  assert.equal(preparations.length, 3);
  assert.equal(preparations.every(({ request }) => request.duration === 30 && request.imagexProxyUrl === "http://fixture-upload"), true);
  assert.deepEqual(preparations.at(-1).request.references.map((item) => item.role), ["first_frame", "last_frame"]);
  assert.deepEqual(Array.from(task.references, (item) => item.id), ["first_frame", "last_frame"]);
});

test("30s obeys the same browser submission lock and never creates a second task", async () => {
  const fixture = harness({ busy: true });
  await assert.rejects(fixture.submit(), /当前浏览器已有任务正在提交/);
  assert.equal(fixture.store.state.tasks.length, 0);
  assert.equal(fixture.calls.length, 0);
});

test("30s requires the currently selected account page", async () => {
  const fixture = harness();
  fixture.context.activeAccountId = "other-account";
  await assert.rejects(fixture.submit(), /请先在中间浏览器打开此账号/);
  assert.equal(fixture.calls.length, 0);
});

for (const options of [{ rejected: true }, { preparationError: true }]) test(`30s failure stays on the original task without protocol fallback: ${JSON.stringify(options)}`, async () => {
  const fixture = harness(options);
  const task = await fixture.submit();
  await fixture.settled;
  assert.equal(task.status, "failed");
  assert.match(task.error, /fixture_/);
  assert.equal(task.conversationId, "");
  assert.equal(fixture.store.state.tasks.length, 1);
  assert.equal(fixture.calls.some(({ route }) => route.endsWith("/videos") || route.endsWith("/adopt-browser")), false);
  assert.equal(fixture.polls.length, 0);
});

test("external API submission keeps its Provider protocol path", async () => {
  const fixture = harness();
  const task = await fixture.submit({}, false);
  assert.equal(task.source, "provider-protocol");
  assert.equal(task.duration, 30);
  assert.equal(fixture.calls[0].route, "/internal/runtime/v1/videos");
  assert.equal(fixture.executions.length, 0);
});
