import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreTaskDraft } from "./task-draft.mjs";

test("completed task restores prompt, settings and its original images in order", async () => {
  const seen = [];
  const draft = await restoreTaskDraft({ status: "completed", model: "dola-seedance-2-5", prompt: "打开房门", duration: 30, ratio: "9:16", references: [{ id: "first", role: "first_frame" }, { id: "last", role: "last_frame" }] }, async (id) => {
    seen.push(id);
    return { id, name: id, dataUrl: `data:image/png;base64,${id}` };
  });
  assert.deepEqual(seen, ["first", "last"]);
  assert.equal(draft.prompt, "打开房门");
  assert.equal(draft.duration, 30);
  assert.deepEqual(draft.references.map((item) => item.role), ["first_frame", "last_frame"]);
});

test("failed task restores its original references for another submission", async () => {
  const draft = await restoreTaskDraft({ status: "failed", model: "dola-seedance-2-5", prompt: "再次拍摄", duration: 30, ratio: "9:16", references: [{ id: "image-1", role: "reference" }] }, async (id) => ({ id, name: "原图.png", dataUrl: "data:image/png;base64,AAAA" }));
  assert.equal(draft.prompt, "再次拍摄");
  assert.equal(draft.references[0].id, "image-1");
});

test("running task cannot be restored as a new draft", async () => {
  await assert.rejects(restoreTaskDraft({ status: "running" }, async () => {}), /已完成或失败/);
});

test("a historical task can recover a unique original image by name", async () => {
  const draft = await restoreTaskDraft({ status: "completed", prompt: "原提示词", references: [{ name: "唯一图片.png", role: "reference" }] }, async (id) => ({ id, dataUrl: "data:image/png;base64,AAAA" }), [{ id: "old-image", name: "唯一图片.png", kind: "uploaded", mime: "image/png" }]);
  assert.equal(draft.references[0].id, "old-image");
});

test("a historical task with duplicate image names cannot silently pick the wrong image", async () => {
  await assert.rejects(restoreTaskDraft({ status: "completed", prompt: "原提示词", references: [{ name: "同名图片.png" }] }, async () => { throw new Error("must not read"); }, [{ id: "one", name: "同名图片.png", mime: "image/png" }, { id: "two", name: "同名图片.png", mime: "image/png" }]), /同名文件/);
});

test("a browser task never substitutes a same-name local image for a missing original", async () => {
  await assert.rejects(restoreTaskDraft({ source: "browser", status: "completed", prompt: "原提示词", references: [{ name: "参考图.png" }] }, async () => { throw new Error("must not read"); }, [{ id: "unrelated", name: "参考图.png", mime: "image/png" }]), /没有可用原图/);
});

test("missing input is never turned into an undefined draft", async () => {
  await assert.rejects(restoreTaskDraft({ status: "completed" }, async () => {}), /缺少原始提示词/);
});
