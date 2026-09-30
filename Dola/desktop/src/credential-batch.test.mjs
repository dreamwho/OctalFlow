import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialImportItems } from "./credential-batch.mjs";

test("credential files and pasted text retain order and source without changing passwords", () => {
  assert.deepEqual(credentialImportItems({ files: [{ name: "a.txt", text: "first@example.test|a b\n" }], text: "second@example.test|secret" }), [
    { file: "a.txt", line: 1, email: "first@example.test", password: "a b" },
    { file: "粘贴内容", line: 1, email: "second@example.test", password: "secret" },
  ]);
});

test("invalid and repeated emails reject the complete import without exposing passwords", () => {
  assert.throws(() => credentialImportItems({ text: "first@example.test|secret\nwrong|secret" }), /第 2 行：请使用/);
  assert.throws(() => credentialImportItems({ text: "first@example.test|secret\nFIRST@example.test|other" }), /第 2 行：邮箱重复/);
});

test("full-width separator is accepted and password whitespace is preserved", () => {
  assert.deepEqual(credentialImportItems({ text: "person@example.test｜ leading space " })[0], { file: "粘贴内容", line: 1, email: "person@example.test", password: " leading space " });
});
