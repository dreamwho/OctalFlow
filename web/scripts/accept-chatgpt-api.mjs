// Explicit, isolated integration acceptance. Never point this at an existing installation.
import assert from "node:assert/strict";

const origin = process.env.CHATGPT_ACCEPTANCE_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("CHATGPT_ACCEPTANCE_ORIGIN must name an explicitly isolated loopback test application");
const credentials = { username: "chatgpt_acceptance", displayName: "ChatGPT 验收夹具", password: "FixtureOnly!2026", installToken: "fixture-chatgpt-install-token-32characters" };
const cookies = new Map();
async function request(path, body, method = body ? "POST" : "GET", headers = {}) {
    const response = await fetch(new URL(path, origin), { method, headers: { "content-type": "application/json", ...(cookies.size ? { cookie: [...cookies.values()].join("; ") } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0];
        const name = pair.split("=", 1)[0];
        if (/max-age=0/i.test(value)) cookies.delete(name);
        else cookies.set(name, pair);
    }
    const payload = await response.json();
    return { status: response.status, data: payload.data ?? payload };
}
async function ok(path, body, method) {
    const result = await request(path, body, method);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.data)}`);
    return result.data;
}
const admin = "/api/admin/chatgpt-api/";
if (process.argv.includes("--verify-only")) {
    await ok("/api/auth/login", credentials);
    const selected = await ok(`${admin}models`);
    assert.ok(selected.models.length > 0);
    assert.equal((await ok(`${admin}gateway`)).enabled, false);
    assert.equal((await ok(`${admin}keys`)).items.length, 0);
    const selection = await ok(`${admin}proxy-selection`);
    assert.equal(selection.enabled, false);
    assert.equal(selection.mode, "native");
    assert.equal(selection.native_source, "manual");
    assert.equal(selection.ipwoConfigured, true);
    console.log("PASS: application models, encrypted provider user keys and disabled gateway survive process restart");
} else {
    assert.equal((await request(`${admin}accounts`)).status, 401);
    await ok(process.argv.includes("--continue") ? "/api/auth/login" : "/api/auth/register", credentials);
    assert.equal((await ok(`${admin}accounts`)).total, 0);
    assert.equal((await ok(`${admin}health`)).storage.encrypted, true);
    assert.equal((await request(`${admin}accounts/export`)).status, 404);
    const created = await ok(`${admin}keys`, { name: "Temporary acceptance key" });
    assert.ok(created.raw_key);
    const headers = { authorization: `Bearer ${created.raw_key}` };
    await ok(`${admin}gateway`, { enabled: true }, "PATCH");
    assert.equal((await request("/api/chatgpt-api/v1/models", null, "GET", headers)).status, 200);
    const catalog = await ok(`${admin}model-catalog`);
    const models = [catalog.chat_models[0], catalog.image_models[0]];
    await ok(`${admin}models`, { models }, "PUT");
    assert.deepEqual((await ok(`${admin}models`)).models, models);
    const settings = await ok("/api/admin/settings");
    const channel = settings.settings.systemChannels.find((item) => item.id === "chatgpt-api");
    assert.equal(channel.advancedConfig.protocol, "chatgpt-api");
    assert.deepEqual(channel.models, models);
    await ok(`${admin}keys/${created.item.id}`, { enabled: false });
    assert.equal((await request("/api/chatgpt-api/v1/models", null, "GET", headers)).status, 401);
    await ok(`${admin}keys/${created.item.id}`, { enabled: true });
    await ok(`${admin}gateway`, { enabled: false }, "PATCH");
    assert.equal((await request("/api/chatgpt-api/v1/models", null, "GET", headers)).status, 503);
    assert.equal((await request("/api/ai/system/chatgpt-api/models")).status, 200);
    const statistics = await ok(`${admin}statistics?time_range=7d`);
    assert.equal(statistics.time_range, "7d");
    assert.equal(statistics.totals.total, 0);
    const initialProxies = await ok(`${admin}proxies`);
    assert.equal(initialProxies.groups.length, 0);
    const initialSelection = await ok(`${admin}proxy-selection`);
    assert.equal(initialSelection.enabled, false);
    await ok(`${admin}proxy-selection`, { enabled: true, mode: "native", native_source: "manual" }, "PATCH");
    assert.equal((await ok(`${admin}proxy-selection`)).enabled, true);
    await ok(`${admin}proxy-selection`, { enabled: false, mode: "native", native_source: "manual" }, "PATCH");
    assert.equal((await ok(`${admin}proxy-selection`)).enabled, false);
    const ipwo = await ok(`${admin}ipwo`);
    assert.equal(ipwo.has_api_url, false);
    const savedIpwo = await ok(`${admin}ipwo`, { api_url: "https://www.ipwo.net/api/proxy/get_proxy_ip?regions=US", protocol: "http", regions: "US", timeout_seconds: 30 }, "PATCH");
    assert.equal(savedIpwo.has_api_url, true);
    assert.ok(!JSON.stringify(savedIpwo).includes("https://"));
    assert.equal((await ok(`${admin}proxy-selection`)).enabled, false);
    const proxySecret = "http://fixture:acceptance-private-password@127.0.0.1:8123";
    const imported = await ok(`${admin}proxies/nodes/import`, { text: `${proxySecret} 30` });
    assert.equal(imported.nodes.length, 1);
    const groupResult = await ok(`${admin}proxies/groups`, { name: "Acceptance proxy group", create_only: true, nodes: [{ name: "Fixture node", ...imported.nodes[0] }] });
    const groupId = groupResult.group.id;
    let proxyView = await ok(`${admin}proxies`);
    assert.equal(proxyView.groups[0].name, "Acceptance proxy group");
    assert.ok(!JSON.stringify(proxyView).includes("acceptance-private-password"));
    const proxyNode = proxyView.groups[0].nodes[0];
    await ok(`${admin}proxies/groups`, { id: groupId, name: "Acceptance edited group", nodes: [{ id: proxyNode.id, name: "Edited node", url: "", enabled: true, image_concurrency_limit: 12, notes: "" }] });
    await ok(`${admin}proxies/defaults`, { default_reference: { mode: "group", group_id: groupId }, fallback_reference: { mode: "direct" } });
    proxyView = await ok(`${admin}proxies`);
    assert.equal(proxyView.default_reference.group_id, groupId);
    assert.equal(proxyView.groups[0].nodes[0].image_concurrency_limit, 12);
    await ok(`${admin}proxies/defaults`, { default_reference: { mode: "direct" }, fallback_reference: null });
    await ok(`${admin}proxies/groups/${groupId}`, null, "DELETE");
    assert.equal((await ok(`${admin}proxies`)).groups.length, 0);
    await ok(`${admin}keys/${created.item.id}`, null, "DELETE");
    assert.equal(
        (await ok(`${admin}keys`)).items.some((item) => item.id === created.item.id),
        false,
    );
    console.log("PASS: real Next/Python HTTP authorization, keys, managed channel independent of public gateway, logical models, statistics and proxy CRUD; no real account or paid generation used");
}
