import test from "node:test";
import assert from "node:assert/strict";
import { testProxyNodes } from "./proxy-batch-test.mjs";

test("batch tests every node in order and reports live results", async () => {
  const events = [];
  const visited = [];
  let active = 0;
  const summary = await testProxyNodes([{ id: "a" }, { id: "b" }, { id: "c" }], async (item) => {
    active += 1;
    assert.equal(active, 1);
    visited.push(item.id);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (item.id === "b") throw new Error("offline");
    return { connected: true, latencyMs: 12 };
  }, (event) => events.push(event));
  assert.deepEqual(visited, ["a", "b", "c"]);
  assert.deepEqual(events.map((event) => event.type), ["testing", "result", "testing", "result", "testing", "result"]);
  assert.equal(events[3].result.error, "offline");
  assert.deepEqual(summary, { completed: 3, total: 3, connected: 2, failed: 1, cancelled: false });
});

test("batch stops before the next node after cancellation", async () => {
  let cancelled = false;
  const visited = [];
  const summary = await testProxyNodes([{ id: "a" }, { id: "b" }], async (item) => {
    visited.push(item.id);
    cancelled = true;
    return { connected: false };
  }, () => {}, () => cancelled);
  assert.deepEqual(visited, ["a"]);
  assert.deepEqual(summary, { completed: 1, total: 2, connected: 0, failed: 1, cancelled: true });
});
