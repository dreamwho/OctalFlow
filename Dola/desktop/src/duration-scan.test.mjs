import assert from "node:assert/strict";
import { test } from "node:test";
import { scanLongDurations, stripLongDurations } from "./duration-scan.mjs";

test("flags duration mentions exceeding 10 seconds in both languages", () => {
  const texts = ["短片时长30秒，节奏紧凑", "短片时长约 28 秒，节奏紧凑", "时长大约30秒", "27.2-30秒收尾定格", "8.8-11.8秒转身", "生成30秒视频：海边日落", "一只猫 30 秒", "30s timelapse", "duration: 30s cinematic", "a 15-second shot of rain"];
  for (const text of texts) {
    assert.equal(scanLongDurations(text).length, 1, text);
    assert.ok(scanLongDurations(text)[0].seconds > 10, text);
  }
});

test("ignores durations within the official dialog policy and speech-rate numbers", () => {
  for (const text of ["0-2.5秒跟设计师走", "2.5-6秒转身", "10秒", "语速约每秒5.5字", "台词密度约5.4字/秒", "9:16 竖屏手持", "iPhone 18 Pro Max 手持实拍"]) {
    assert.deepEqual(scanLongDurations(text), [], text);
  }
});

test("overlapping mentions are reported once with the outermost expression", () => {
  assert.deepEqual(scanLongDurations("短片时长30秒").map((m) => m.text), ["时长30秒"]);
  assert.deepEqual(scanLongDurations("27.2-30秒收尾").map((m) => m.seconds), [30]);
});

test("one-click strip removes only the long mentions and keeps the script readable", () => {
  const prompt = "生成一条竖屏9:16第一人称生活流短片，时长30秒，手持实拍质感。\n\n0-2.5秒：\n初始状态：穿过入户门框。\n\n2.5-6秒：\n初始状态：转身面对镜头。\n\n8.8-11.8秒：\n主要事件：妈妈画外音提问。\n\n27.2-30秒：\n主要事件：收尾定格。\n\n语速约每秒5.5字，全程一镜到底。";
  const { value, removed } = stripLongDurations(prompt);
  assert.equal(removed.length, 3);
  assert.ok(!/时长30秒|8\.8-11\.8秒|27\.2-30秒/.test(value));
  assert.ok(value.includes("0-2.5秒"));
  assert.ok(value.includes("穿过入户门框"));
  assert.ok(value.includes("语速约每秒5.5字"));
  assert.ok(!value.includes("，，"));
});

test("strip tidies punctuation left behind by the removed mentions", () => {
  assert.equal(stripLongDurations("短片，时长30秒，超清画质").value, "短片，超清画质");
  assert.equal(stripLongDurations("海边日落，30秒").value, "海边日落");
  assert.equal(stripLongDurations("开头 0-2.5s walk, duration: 30s end").value, "开头 0-2.5s walk, end");
});

test("clean prompt strips to itself", () => {
  const prompt = "海边日落，超清画质，手持一镜到底。";
  assert.equal(stripLongDurations(prompt).value, prompt);
  assert.equal(stripLongDurations("").removed.length, 0);
});
