import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedLoginUrl } from "./login-url.mjs";

test("Dola Facebook login link opens through the exact ByteDance link domain", () => {
  for (const url of ["https://sg-link.byteoversea.com/?target=facebook", "https://facebook.com/login", "https://www.facebook.com/dialog/oauth", "https://www.dola.com/chat", "https://accounts.google.com/signin"]) {
    assert.equal(isAllowedLoginUrl(url), true, url);
  }
  for (const url of ["https://sg-link.byteoversea.com.attacker.test/", "https://fakefacebook.com/", "http://sg-link.byteoversea.com/", "https://other.byteoversea.com/", "javascript:alert(1)"]) {
    assert.equal(isAllowedLoginUrl(url), false, url);
  }
});
