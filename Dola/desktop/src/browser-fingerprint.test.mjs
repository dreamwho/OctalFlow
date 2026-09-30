import assert from "node:assert/strict";
import test from "node:test";
import { baseUserAgent, defaultFingerprintParams, fingerprintEnvironment, fingerprintOptions, mergeMissingFingerprint, randomFingerprint } from "./browser-fingerprint.mjs";

test("default fingerprint params exclude user agent for Google login safety", () => {
  assert.deepEqual(defaultFingerprintParams(), ["languages", "timezone", "hardwareConcurrency", "deviceMemory", "screen", "canvasAudio", "webgl", "voices", "battery", "doNotTrack"]);
  assert.equal(fingerprintOptions.find((item) => item.key === "userAgent").default, false);
});

test("random fingerprints only include selected parameters", () => {
  const minimal = randomFingerprint(["deviceMemory"]);
  assert.ok([4, 8, 16].includes(minimal.deviceMemory));
  assert.equal(minimal.userAgent, undefined);
  assert.equal(minimal.timezone, undefined);
  assert.equal(Object.keys(randomFingerprint([])).length, 0);
});

test("base user agent strips Electron tokens and keeps the real platform", () => {
  const ua = baseUserAgent();
  assert.match(ua, new RegExp(`^Mozilla/5\\.0 \\(${fingerprintEnvironment.osToken.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\) AppleWebKit/537\\.36 \\(KHTML, like Gecko\\) Chrome/${fingerprintEnvironment.chromeMajor}\\.0\\.0\\.0 Safari/537\\.36$`));
  assert.ok(!ua.includes("Electron") && !ua.includes("dola-desktop"));
});

test("user agent profiles stay on the real platform and Chromium major version", () => {
  for (let index = 0; index < 50; index += 1) {
    const fingerprint = randomFingerprint(fingerprintOptions.map((item) => item.key));
    const major = fingerprintEnvironment.chromeMajor;
    assert.match(fingerprint.userAgent, new RegExp(`^Mozilla/5\\.0 \\(${fingerprintEnvironment.osToken.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\) AppleWebKit/537\\.36 \\(KHTML, like Gecko\\) Chrome/${major}\\.\\d+\\.\\d+\\.\\d+ Safari/537\\.36$`));
    assert.equal(fingerprint.platform, fingerprintEnvironment.platform);
    assert.equal(fingerprint.uaPlatform, fingerprintEnvironment.uaPlatform);
    assert.equal(fingerprint.chromeVersion, major);
    assert.ok(fingerprint.fullVersion.startsWith(`${major}.`));
    assert.match(fingerprint.languages, /^(en-US|en-GB|zh-CN)/);
    assert.ok(Array.isArray(fingerprint.navigatorLanguages) && fingerprint.navigatorLanguages.length >= 2);
    assert.match(fingerprint.timezone.timeZone, /^[\w/-]+$/);
    assert.ok([4, 6, 8, 12, 16, 20].includes(fingerprint.hardwareConcurrency));
    assert.ok(fingerprint.screen.width >= 1366 && fingerprint.screen.height >= 768 && fingerprint.screen.availHeight < fingerprint.screen.height);
    assert.ok([1, 1.25, 2].includes(fingerprint.screen.devicePixelRatio));
    assert.ok(Number.isFinite(fingerprint.canvasSeed) && fingerprint.canvasSeed >= 1 && fingerprint.canvasSeed <= 2147483646);
    assert.ok(Number.isFinite(fingerprint.audioSeed) && fingerprint.audioSeed !== fingerprint.canvasSeed);
    assert.ok(fingerprint.webgl.vendor.length > 0 && fingerprint.webgl.renderer.length > 0);
    if (fingerprintEnvironment.uaPlatform === "macOS") assert.equal(fingerprint.webgl.vendor, "Apple");
    assert.ok(Number.isFinite(fingerprint.voicesSeed));
    assert.ok(typeof fingerprint.battery.charging === "boolean" && fingerprint.battery.level > 0 && fingerprint.battery.level <= 1);
    assert.ok(fingerprint.doNotTrack === null || fingerprint.doNotTrack === "1");
  }
});

test("fingerprint options stay a stable, fully-selectable set", () => {
  assert.deepEqual(fingerprintOptions.map((item) => item.key), ["userAgent", "languages", "timezone", "hardwareConcurrency", "deviceMemory", "screen", "canvasAudio", "webgl", "voices", "battery", "doNotTrack"]);
  const optionField = { userAgent: "userAgent", languages: "languages", timezone: "timezone", hardwareConcurrency: "hardwareConcurrency", deviceMemory: "deviceMemory", screen: "screen", canvasAudio: "canvasSeed", webgl: "webgl", voices: "voicesSeed", battery: "battery", doNotTrack: "doNotTrack" };
  const full = randomFingerprint();
  for (const item of fingerprintOptions) assert.notEqual(full[optionField[item.key]], undefined, `${item.key} missing from default fingerprint`);
});

test("mergeMissingFingerprint backfills absent params without touching stored values", () => {
  const legacy = { languages: "zh-CN,zh;q=0.9,en;q=0.8", navigatorLanguages: ["zh-CN", "zh", "en"], timezone: { timeZone: "Asia/Shanghai", offsetMinutes: -480 }, screen: { width: 1920, height: 1080, availHeight: 1040 } };
  const merged = mergeMissingFingerprint(legacy);
  assert.equal(merged.languages, legacy.languages);
  assert.equal(merged.timezone.timeZone, legacy.timezone.timeZone);
  assert.equal(merged.screen.width, legacy.screen.width);
  assert.ok(Number.isFinite(merged.screen.devicePixelRatio));
  assert.ok(Number.isFinite(merged.hardwareConcurrency));
  assert.ok(Number.isFinite(merged.canvasSeed) && Number.isFinite(merged.audioSeed));
  assert.ok(merged.webgl && merged.webgl.renderer);
  assert.ok(Number.isFinite(merged.voicesSeed));
  assert.ok(merged.battery && typeof merged.battery.charging === "boolean");
  assert.ok(merged.doNotTrack === null || merged.doNotTrack === "1");
  // 再次合并为幂等操作，取值保持稳定。
  assert.deepEqual(mergeMissingFingerprint(merged), merged);
  // 没有指纹的账号会补齐全量默认参数。
  const fresh = mergeMissingFingerprint(undefined);
  assert.ok(Object.keys(fresh).length >= defaultFingerprintParams().length);
  assert.equal(fresh.userAgent, undefined);
});
