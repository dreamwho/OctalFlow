import test from "node:test";
import assert from "node:assert/strict";
import { referenceLabel, nextReferenceLabel, normalizePictureTags, referencedIds, mentionAtCursor, replaceMention, replaceReferenceToken, deleteReferenceAtCaret } from "./prompt-references.mjs";

const references = [{ id: "one", label: "图片1" }, { id: "two", label: "图片2" }];

test("numbering follows additions without reusing a removed image label", () => {
  assert.equal(referenceLabel(0), "图片1");
  assert.equal(nextReferenceLabel(references), "图片3");
  assert.equal(nextReferenceLabel(references.slice(1)), "图片3");
});

test("pasted canvas references resolve only current added images", () => {
  assert.equal(normalizePictureTags("<Picture 1> 与 <Picture 3>", references), "@图片1 与 <Picture 3>");
  assert.deepEqual([...referencedIds("参考 @图片1，再参考＠图片2，忽略 @图片20", references)], ["one", "two"]);
});

test("mention replacement keeps surrounding prompt and caret", () => {
  const value = "前景 @图 后景";
  const mention = mentionAtCursor(value, 5);
  assert.deepEqual(mention, { start: 3, end: 5, query: "图" });
  assert.deepEqual(replaceMention(value, mention, "图片1"), { value: "前景 @图片1  后景", cursor: 8 });
  assert.deepEqual(replaceReferenceToken("前景 @图片1 后景", 3, 7, "图片2"), { value: "前景 @图片2 后景", cursor: 7 });
  assert.deepEqual(mentionAtCursor("参考 ＠", 4), { start: 3, end: 4, query: "" });
});

test("backspace and delete remove a whole reference without affecting selected text", () => {
  assert.deepEqual(deleteReferenceAtCaret("参考 @图片1 后景", 7, "Backspace", ["图片1"]), { value: "参考 后景", cursor: 3 });
  assert.deepEqual(deleteReferenceAtCaret("参考 @图片1 后景", 3, "Delete", ["图片1"]), { value: "参考 后景", cursor: 3 });
  assert.deepEqual(deleteReferenceAtCaret("@图片1 和 @图片1 后景", 11, "Backspace", ["图片1"]), { value: "@图片1 和 后景", cursor: 7 });
  assert.equal(deleteReferenceAtCaret("参考 景色", 3, "Backspace", ["图片1"]), null);
});
