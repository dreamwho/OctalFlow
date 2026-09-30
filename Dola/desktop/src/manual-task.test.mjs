import { test } from "node:test";
import assert from "node:assert/strict";
import { completionRequestShape, parseManualSubmit } from "./manual-task.mjs";

test("browser submit parser keeps the prompt and model for a new Dola conversation", () => {
  const body = JSON.stringify({
    option: { need_create_conversation: true },
    chat_ability: { ability_type: 17, ability_param: JSON.stringify({ model: "seedance_v2.5", duration: 30, ratio: "9:16", input_box_content: { user_input_content: "重新装修房屋" } }) },
    messages: [{ content_block: [{ content: { attachment_block: { attachments: [{ image: { name: "客厅.png", image_ori: { url: "https://v16-dola.dola.com/reference.png" } } }] } } }] }],
  });
  const parsed = parseManualSubmit("https://www.dola.com/chat/completion?device_id=abc&region=JP", body);
  assert.equal(parsed?.prompt, "重新装修房屋");
  assert.equal(parsed?.model, "dola-seedance-2-5");
  assert.equal(parsed?.duration, 30);
  assert.deepEqual(parsed?.references, [{ name: "客厅.png", role: "reference", url: "https://v16-dola.dola.com/reference.png" }]);
  assert.equal(parsed?.identity.device_id, "abc");
  assert.equal(parseManualSubmit("https://www.dola.com/chat/completion", JSON.stringify({ ...JSON.parse(body), option: { need_create_conversation: false } })), null);
  assert.equal(parseManualSubmit("https://www.dola.com/chat/completion", JSON.stringify({ ...JSON.parse(body), chat_ability: { ability_type: 3, ability_param: JSON.stringify({ ability_type: 1, ability_param: { model: "Seedream 4.5", input_box_content: { user_input_content: "画一间客厅" } } }) } }))?.model, "dola-seedream-4-5");
});

test("request shape omits prompts, cookies, and device identifiers", () => {
  const shape = completionRequestShape({ client_meta: { local_conversation_id: "local_1234567890123456", device_id: "private-device" }, option: { need_create_conversation: true, collect_id: "private-id" }, chat_ability: { ability_type: 17, ability_param: JSON.stringify({ model: "seedance_v2.5", input_box_content: { user_input_content: "private-prompt" } }) }, messages: [{ content_block: [{ block_type: 10000 }] }], ext: { fp: "private-fingerprint" } });
  assert.equal(shape.localConversationIdLength, 22);
  assert.equal(shape.hasFingerprint, true);
  assert.equal(shape.hasCollectionId, true);
  assert.ok(!JSON.stringify(shape).includes("private-"));
});
