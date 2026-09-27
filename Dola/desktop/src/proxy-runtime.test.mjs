import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { buildMihomoConfig, fetchMagicSubscription, fetchMagicSubscriptionUsing, genericMihomoNode, normalizeGenericProxyUrl, parseGenericProxyGroups, parseMagicSubscription, subscriptionUrls } from "./proxy-runtime.mjs";

test("imports enabled generic groups and preserves node credentials for encryption", () => {
  const nodes = parseGenericProxyGroups(JSON.stringify({ proxy_groups: [
    { name: "台湾", nodes: [{ name: "落地", url: "socks5://user:secret@proxy.example:1080", enabled: true }, { name: "禁用", url: "http://other:8080", enabled: false }] },
  ] }));
  assert.deepEqual(nodes, [{ name: "落地", group: "台湾", url: "socks5://user:secret@proxy.example:1080" }]);
});

test("imports Clash nodes without evaluating unrelated subscription rules", () => {
  const parsed = parseMagicSubscription("proxies:\n  - name: 台湾\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: test\nrules:\n  - MATCH,DIRECT", "sub");
  assert.equal(parsed.nodes[0].id, "magic:sub:0");
  assert.equal(parsed.raw[0].password, "test");
  assert.equal(parsed.raw.length, 1);
});

test("chain configuration dials landing node through hop", () => {
  const generic = genericMihomoNode({ url: "http://user:pass@proxy.example:8080" }, "generic");
  const config = YAML.parse(buildMihomoConfig(generic, { type: "ss", server: "landing.example", port: 443, cipher: "aes-128-gcm", password: "test" }, 12345));
  assert.equal(config.proxies[1]["dialer-proxy"], "DOLA-HOP");
  assert.equal(config.proxies[0].username, "user");
  assert.equal(config.rules[0], "MATCH,DOLA-OUT");
  assert.equal(config["bind-address"], "127.0.0.1");
});

test("accepts four-part authenticated generic proxy without exposing credentials in UI URL", () => {
  const url = new URL(normalizeGenericProxyUrl("proxy.example:7878:zone_user:secret"));
  assert.equal(url.hostname, "proxy.example");
  assert.equal(url.port, "7878");
  assert.equal(url.username, "zone_user");
  assert.equal(url.password, "secret");
});

test("imports base64 encoded subscription URI list", () => {
  const uri = "trojan://password@proxy.example:443?sni=proxy.example#Taiwan";
  const encoded = Buffer.from(uri).toString("base64");
  const parsed = parseMagicSubscription(encoded, "sub");
  assert.equal(parsed.nodes[0].name, "Taiwan");
  assert.equal(parsed.raw[0].type, "trojan");
});

test("tries Clash client identities when a subscription first returns an HTML page", async () => {
  const calls = [];
  const yaml = "proxies:\n  - { name: Taipei, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: test }";
  const imported = await fetchMagicSubscription("https://subscription.example/config", "sub", async (_url, options) => {
    calls.push(options.headers["user-agent"]);
    return calls.length === 1 ? new Response("<html>verification</html>", { headers: { "content-type": "text/html" } }) : new Response(yaml, { headers: { "content-type": "text/yaml" } });
  });
  assert.equal(imported.parsed.nodes[0].name, "Taipei");
  assert.deepEqual(calls, ["clash.meta", "ClashforWindows/0.20.39"]);
});

test("requests Clash format for airport links and falls back to the original link", async () => {
  const source = "https://subscription.example/api/v1/client/subscribe?token=example";
  assert.equal(subscriptionUrls(source).length, 2);
  const requests = [];
  const imported = await fetchMagicSubscription(source, "sub", async (url) => {
    requests.push(url);
    return new Response(url.includes("flag=clash") ? "<html>unavailable</html>" : "proxies:\n  - { name: Tokyo, type: trojan, server: example.com, port: 443, password: test }", { headers: { "content-type": url.includes("flag=clash") ? "text/html" : "text/yaml" } });
  });
  assert.equal(imported.parsed.nodes[0].name, "Tokyo");
  assert.equal(requests.length, 4);
  assert.equal(imported.url, source);
});

test("reports a verification page without saving it as a proxy subscription", async () => {
  await assert.rejects(fetchMagicSubscription("https://subscription.example/config", "sub", async () => new Response("<html>verify</html>", { headers: { "content-type": "text/html" } })), /网页或验证页/);
});

test("reports the subscription provider's activation window without retrying an expired link", async () => {
  let calls = 0;
  await assert.rejects(fetchMagicSubscriptionUsing("https://subscription.example/config", "sub", [async () => { calls++; return new Response("请登录系统网站后台，或在系统网站后台的订阅页面开启订阅获取。每次开启后，订阅可获取有效时间为：10 分钟", { headers: { "content-type": "text/html" } }); }, async () => { calls++; throw new Error("fallback should not run"); }]), /重新开启.*10 分钟/);
  assert.equal(calls, 1);
});

test("prefers a valid direct response before using the desktop network fallback", async () => {
  const yaml = "proxies:\n  - { name: Taipei, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: test }";
  let fallbackCalls = 0;
  const imported = await fetchMagicSubscriptionUsing("https://subscription.example/?opaque-token=", "sub", [async () => new Response(yaml), async () => { fallbackCalls++; return new Response("<html>challenge</html>"); }]);
  assert.equal(imported.parsed.nodes.length, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(subscriptionUrls("https://subscription.example/?opaque-token="), ["https://subscription.example/?opaque-token="]);
});

test("uses the desktop network when the direct request cannot connect", async () => {
  const yaml = "proxies:\n  - { name: Taipei, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: test }";
  const imported = await fetchMagicSubscriptionUsing("https://subscription.example/config", "sub", [async () => { throw new Error("network unavailable"); }, async () => new Response(yaml)]);
  assert.equal(imported.parsed.nodes[0].name, "Taipei");
});
