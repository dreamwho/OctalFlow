import assert from "node:assert/strict";
import test from "node:test";

import { resolveEdition } from "./edition.mjs";

test("commercial shell marks unfinished cloud features while keeping local providers", () => {
    assert.deepEqual(resolveEdition("commercial"), {
        id: "commercial",
        appId: "com.dreamyo.desktop",
        productName: "Dreamyo",
        windowTitle: "Dreamyo",
        requiresLogin: true,
        cloudFeatures: false,
        cloudSync: false,
        localProviders: true,
        localProviderBilling: "free",
        startPath: "/login?next=/canvas",
        implementationStage: "foundation",
    });
});

test("administrator edition is local and does not require login", () => {
    const edition = resolveEdition("admin");
    assert.equal(edition.requiresLogin, false);
    assert.equal(edition.cloudFeatures, false);
    assert.equal(edition.cloudSync, false);
    assert.equal(edition.startPath, "/api/desktop/bootstrap?next=/canvas");
});

test("unknown editions fail closed", () => {
    assert.throws(() => resolveEdition("web"), /Unsupported desktop edition/);
});
