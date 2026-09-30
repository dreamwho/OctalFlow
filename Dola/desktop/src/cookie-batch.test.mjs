import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieImportItems } from "./cookie-batch.mjs";

test("multiple Cookie TXT files and pasted lines retain source and order", () => {
  assert.deepEqual(cookieImportItems({ files: [{ name: "A.txt", text: "Cookie: a=1\n\nb=2" }, { name: "B.txt", text: "c=3\n" }], text: "d=4" }), [
    { file: "A.txt", line: 1, cookie: "Cookie: a=1" },
    { file: "A.txt", line: 3, cookie: "b=2" },
    { file: "B.txt", line: 1, cookie: "c=3" },
    { file: "粘贴内容", line: 1, cookie: "d=4" },
  ]);
});
