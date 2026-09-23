import assert from "node:assert/strict";
import test from "node:test";

import { macSigningOptions, validateMacReleaseEnvironment } from "./macos-release.mjs";

const identity = "Developer ID Application: Dreamyo (ABCDE12345)";
const signingEnv = {
    DREAMYO_MAC_SIGN_IDENTITY: identity,
    APPLE_KEYCHAIN_PROFILE: "Dreamyo-Notary",
};

test("signed macOS builds require an explicit Developer ID identity and notarization auth", () => {
    assert.equal(validateMacReleaseEnvironment({ env: signingEnv, identities: `1) ABC ${JSON.stringify(identity)}` }), identity);
    assert.throws(() => validateMacReleaseEnvironment({ env: {}, identities: "" }), /Developer ID Application/);
    assert.throws(() => validateMacReleaseEnvironment({ env: { ...signingEnv, APPLE_KEYCHAIN_PROFILE: "" }, identities: JSON.stringify(identity) }), /公证凭据/);
});

test("certificate file can be imported by electron-builder while other local identities are rejected", () => {
    assert.equal(validateMacReleaseEnvironment({ env: { ...signingEnv, CSC_LINK: "/secure/Dreamyo.p12" }, identities: "" }), identity);
    assert.throws(() => validateMacReleaseEnvironment({ env: signingEnv, identities: '"weflow Local Code Signing"' }), /找不到有效的签名身份/);
});

test("unsigned local test builds explicitly disable production signing and notarization", () => {
    const env = { DREAMYO_DESKTOP_UNSIGNED_TEST: "1" };
    assert.equal(validateMacReleaseEnvironment({ env }), null);
    assert.deepEqual(macSigningOptions(env), { identity: null, hardenedRuntime: false, notarize: false });
});

test("release builds use hardened runtime, entitlements, and built-in notarization", () => {
    assert.deepEqual(macSigningOptions(signingEnv), {
        identity,
        hardenedRuntime: true,
        entitlements: "resources/entitlements.mac.plist",
        entitlementsInherit: "resources/entitlements.mac.plist",
        notarize: true,
    });
});
