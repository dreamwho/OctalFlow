import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { registrationAction, registrationStepDelay, registrationTargetScript } from "./registration-flow.mjs";

test("registration only fills credentials on the exact Google origin", () => {
  assert.equal(registrationAction({ origin: "https://accounts.google.com", email: true }).type, "email");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", password: true }).type, "password");
  assert.equal(registrationAction({ origin: "https://accounts.google.com.evil.test", password: true }).type, "approval");
  assert.equal(registrationAction({ origin: "http://accounts.google.com", password: true }).type, "approval");
});

test("every Google notice and Dola OAuth page advances automatically", () => {
  assert.equal(registrationAction({ origin: "https://accounts.google.com", notice: true, password: true }).type, "click-notice");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", allow: true, oauthForDola: true }).type, "click-allow");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", allow: true }).type, "approval");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", challenge: true }).type, "approval");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", insecureBrowser: true }).type, "error");
});

test("known Dola steps advance automatically and Google account errors stop the run", () => {
  assert.equal(registrationAction({ origin: "https://www.dola.com", login: true }).type, "click-login");
  assert.equal(registrationAction({ origin: "https://www.dola.com", googleLogin: true, login: true }).type, "click-google");
  assert.equal(registrationAction({ origin: "https://www.dola.com", ageConfirm: true }).type, "click-age");
  assert.equal(registrationAction({ origin: "https://www.dola.com", pageUnavailable: true }).type, "click-reload");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", blank: true }).type, "reload");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", deleted: true }).type, "error");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", invalidPassword: true, password: true }).type, "error");
  assert.equal(registrationAction({ origin: "https://accounts.google.com", serverError: true }).type, "error");
});

test("step delays stay between 50ms and 1500ms", () => {
  for (let index = 0; index < 500; index += 1) {
    const delay = registrationStepDelay();
    assert.ok(delay >= 50 && delay <= 1500, `delay out of range: ${delay}`);
  }
});

test("RPA scrolls a long notice into view and ignores hidden controls", () => {
  let top = 900;
  let scrolled = false;
  const button = {
    disabled: false, innerText: "我了解",
    getBoundingClientRect: () => ({ left: 180, top, width: 100, height: 30 }),
    scrollIntoView: () => { scrolled = true; top = 120; },
  };
  const hidden = { ...button, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
  const context = { location: { origin: "https://accounts.google.com" }, document: { querySelectorAll: () => [hidden, button] }, getComputedStyle: () => ({ visibility: "visible", display: "block" }), innerWidth: 500, innerHeight: 300 };
  assert.equal(runInNewContext(registrationTargetScript("https://accounts.google.com", "button", ["我了解"]), context).y, 915);
  assert.equal(scrolled, false);
  assert.equal(runInNewContext(registrationTargetScript("https://accounts.google.com", "button", ["我了解"], true), context).y, 135);
  assert.equal(scrolled, true);
  assert.equal(runInNewContext(registrationTargetScript("https://example.test", "button", ["我了解"], true), context), null);
});
