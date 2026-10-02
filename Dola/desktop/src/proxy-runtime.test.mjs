import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { accountProxyId, configuredProxyId, buildMihomoConfig, genericMihomoNode, normalizeGenericProxyUrl, parseGenericProxyGroups } from "./proxy-runtime.mjs";

test("account overrides, group inheritance and direct default resolve independently", () => {
  const state = { accountGroupProxies: { 团队: "generic-node-a", 另一组: "generic-node-b" } };
  assert.equal(accountProxyId({ group: "未分组" }, state), "direct");
  assert.equal(accountProxyId({ group: "团队", proxyId: "" }, state), "generic-node-a");
  assert.equal(accountProxyId({ group: "团队", proxyId: "direct" }, state), "direct");
  assert.equal(accountProxyId({ group: "团队", proxyId: "generic-node-c" }, state), "generic-node-c");
  assert.equal(accountProxyId({ group: "另一组", proxyId: "" }, state), "generic-node-b");
  state.accountGroupProxies.团队 = "generic-node-d";
  assert.equal(accountProxyId({ group: "团队", proxyId: "" }, state), "generic-node-d");
  assert.equal(accountProxyId({ group: "toString" }, state), "direct");
});

test("removed managed modes fall back to direct and generic ids pass through", () => {
  assert.equal(configuredProxyId(""), "");
  assert.equal(configuredProxyId("direct"), "");
  assert.equal(configuredProxyId("magic"), "");
  assert.equal(configuredProxyId("chained"), "");
  assert.equal(configuredProxyId("generic-node"), "generic-node");
});

test("imports enabled generic groups and preserves node credentials for encryption", () => {
  const nodes = parseGenericProxyGroups(JSON.stringify({ proxy_groups: [
    { name: "台湾", nodes: [{ name: "落地", url: "socks5://user:secret@proxy.example:1080", enabled: true }, { name: "禁用", url: "http://other:8080", enabled: false }] },
  ] }));
  assert.deepEqual(nodes, [{ name: "落地", group: "台湾", url: "socks5://user:secret@proxy.example:1080" }]);
});

test("accepts four-part authenticated generic proxy without exposing credentials in UI URL", () => {
  const url = normalizeGenericProxyUrl("proxy.example:1080:user:secret");
  assert.equal(new URL(url).username, "user");
  assert.equal(new URL(url).password, "secret");
  assert.equal(new URL(url).hostname, "proxy.example");
  assert.throws(() => normalizeGenericProxyUrl("ftp://proxy.example:21"), /通用代理/);
});

test("builds a single-outbound mihomo config for a generic node", () => {
  const node = genericMihomoNode({ url: "socks5://user:secret@proxy.example:1080" }, "台湾落地");
  const config = YAML.parse(buildMihomoConfig(node, 18471));
  assert.equal(config.port, 18471);
  assert.equal(config["allow-lan"], false);
  assert.deepEqual(config.proxies, [{ name: "DOLA-OUT", type: "socks5", server: "proxy.example", port: 1080, username: "user", password: "secret" }]);
  assert.deepEqual(config.rules, ["MATCH,DOLA-GROUP"]);
  assert.equal(config["bind-address"], "127.0.0.1");
});

test("generic mihomo node keeps https tls flag and rejects unknown schemes", () => {
  assert.equal(genericMihomoNode({ url: "https://proxy.example:8443" }, "节点").tls, true);
  assert.throws(() => genericMihomoNode({ url: "ftp://proxy.example:21" }, "节点"), /通用节点地址无效/);
});
