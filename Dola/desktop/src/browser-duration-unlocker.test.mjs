import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("Dola page config exposes 15 and 30 seconds while keeping unrelated responses intact", async () => {
  const script = await readFile(new URL("./browser-duration-unlocker.cjs", import.meta.url), "utf8");
  const config = { action_bar: [{ label: "视频时长", option_list: [{ id: 1, option_key: "5", display_text: "5s" }, { id: 2, option_key: "10", display_text: "10s" }] }] };
  function FakeXHR() {}
  FakeXHR.prototype.open = () => {};
  FakeXHR.prototype.send = () => {};
  const context = { location: { hostname: "www.dola.com" }, Response, XMLHttpRequest: FakeXHR, window: { fetch: async () => new Response(JSON.stringify(config), { status: 200, headers: { "content-type": "application/json" } }) } };
  vm.runInNewContext(script, context);
  const patched = await (await context.window.fetch("https://www.dola.com/api/action_bar_v3/get_item_conf")).json();
  assert.deepEqual(patched.action_bar[0].option_list.map((item) => item.option_key), ["5", "10", "15", "30"]);
  const untouched = await (await context.window.fetch("https://www.dola.com/api/chat/completion")).json();
  assert.deepEqual(untouched.action_bar[0].option_list.map((item) => item.option_key), ["5", "10"]);
});

test("fingerprint arguments patch navigator, timezone and screen values", async () => {
  const script = await readFile(new URL("./browser-duration-unlocker.cjs", import.meta.url), "utf8");
  const fingerprint = { userAgent: "UA", platform: "Win32", uaPlatform: "Windows", platformVersion: "15.0.0", chromeVersion: "146", navigatorLanguages: ["en-US", "en"], timezone: { timeZone: "Asia/Tokyo", offsetMinutes: -540 }, hardwareConcurrency: 12, deviceMemory: 8, screen: { width: 1920, height: 1080, availHeight: 1040 } };
  const originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  const sandbox = { location: { hostname: "www.dola.com" }, process: { argv: ["electron", "--dola-fingerprint", JSON.stringify(fingerprint)] }, Date, Intl, Response, XMLHttpRequest: function () {}, window: { fetch: async () => new Response("{}", { status: 200 }) } };
  const context = vm.createContext(sandbox);
  vm.runInNewContext("this.Navigator = class Navigator {}; this.Screen = class Screen {};", context);
  sandbox.navigator = new sandbox.Navigator();
  sandbox.screen = new sandbox.Screen();
  try {
    vm.runInNewContext(script, context);
    const navigator = sandbox.navigator;
    const screen = sandbox.screen;
    assert.equal(navigator.platform, "Win32");
    assert.equal(navigator.hardwareConcurrency, 12);
    assert.equal(navigator.deviceMemory, 8);
    assert.deepEqual(JSON.stringify(navigator.languages), JSON.stringify(["en-US", "en"]));
    assert.equal(navigator.language, "en-US");
    assert.equal(navigator.userAgentData.platform, "Windows");
    assert.deepEqual(JSON.stringify((await navigator.userAgentData.getHighEntropyValues(["platformVersion", "fullVersionList"])).fullVersionList[1]), JSON.stringify({ brand: "Chromium", version: "146.0.0.0" }));
    assert.equal(new Date("2026-01-01T00:00:00Z").getTimezoneOffset(), -540);
    assert.equal(screen.width, 1920);
    assert.equal(screen.availHeight, 1040);
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Tokyo");
  } finally {
    Intl.DateTimeFormat.prototype.resolvedOptions = originalResolved;
  }
});
