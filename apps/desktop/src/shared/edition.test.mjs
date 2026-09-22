import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
        cloudProjectBackups: true,
        localProviders: true,
        localProviderBilling: "free",
        startPath: "/desktop/connect",
        implementationStage: "foundation",
    });
});

test("administrator edition is local and does not require login", () => {
    const edition = resolveEdition("admin");
    assert.equal(edition.requiresLogin, false);
    assert.equal(edition.cloudFeatures, false);
    assert.equal(edition.cloudSync, false);
    assert.equal(edition.cloudProjectBackups, false);
    assert.equal(edition.startPath, "/api/desktop/bootstrap?next=/canvas");
});

test("unknown editions fail closed", () => {
    assert.throws(() => resolveEdition("web"), /Unsupported desktop edition/);
});

test("packaged Electron reads the manifest bundled with its own resources", async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), "dreamyo-editions-"));
    const previous = process.resourcesPath;
    try {
        await writeFile(path.join(resources, "desktop-edition-manifest.json"), JSON.stringify({
            commercial: { ...resolveEdition("commercial"), productName: "Packaged Dreamyo" },
            admin: resolveEdition("admin"),
        }));
        process.resourcesPath = resources;
        const packaged = await import(`./edition.mjs?packaged-test=${Date.now()}`);
        assert.equal(packaged.resolveEdition("commercial").productName, "Packaged Dreamyo");
    } finally {
        process.resourcesPath = previous;
        await rm(resources, { recursive: true, force: true });
    }
});

test("Electron packaging includes the shared edition manifest", async () => {
    const previous = process.env.DREAMYO_DESKTOP_EDITION;
    try {
        process.env.DREAMYO_DESKTOP_EDITION = "admin";
        const { default: config } = await import("../../electron-builder.config.mjs");
        assert.ok(config.extraResources.some(({ from, to }) => from === "../../web/src/lib/desktop-edition-manifest.json" && to === "desktop-edition-manifest.json"));
        const macIcon = await readFile(path.resolve(import.meta.dirname, "../../", config.mac.icon));
        const winIcon = await readFile(path.resolve(import.meta.dirname, "../../", config.win.icon));
        assert.equal(macIcon.toString("ascii", 0, 4), "icns");
        assert.equal(winIcon.readUInt16LE(0), 0);
        assert.equal(winIcon.readUInt16LE(2), 1);
        assert.ok(winIcon.readUInt16LE(4) >= 7);
    } finally {
        if (previous === undefined) delete process.env.DREAMYO_DESKTOP_EDITION;
        else process.env.DREAMYO_DESKTOP_EDITION = previous;
    }
});
