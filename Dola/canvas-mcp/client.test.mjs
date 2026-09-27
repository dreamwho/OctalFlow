import assert from "node:assert/strict";
import test from "node:test";
import { canvasApiClient } from "./client.mjs";

test("MCP client keeps the external key in Authorization and reuses the request ID", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ code: 0, data: { run: { id: "run-1" } }, msg: "OK" });
  };
  try {
    const client = canvasApiClient({ baseUrl: "http://127.0.0.1:3000", key: "secret" });
    await client.createCanvas({ clientRequestId: "same-id", prompt: "分镜脚本" });
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
    assert.equal(JSON.parse(calls[0].init.body).clientRequestId, "same-id");
    await client.getRun("run-1");
    assert.ok(calls[1].url.includes("runId=run-1"));
    assert.ok(!calls[1].url.includes("secret"));
  } finally { globalThis.fetch = original; }
});
