import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    authorizeDolaApiKey,
    createDolaApiKey,
    deleteDolaApiKey,
    getDolaGatewaySettings,
    listDolaApiKeys,
    updateDolaApiKey,
    updateDolaGatewaySettings,
} from "./gateway-store";

describe("Dola gateway store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dreamyo-dola-gateway-"));
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "c".repeat(64));
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("encrypts API key on disk while returning plain key for admin listing", async () => {
        const future = new Date(Date.now() + 60_000).toISOString();
        const created = await createDolaApiKey({ name: "Dola外部调用", expiresAt: future, allowedIps: ["192.168.1.5"] });
        const raw = await readFile(join(directory, "dola", "gateway.json"), "utf8");

        expect(created.rawKey).toMatch(/^oct_dola_/);
        expect(raw).not.toContain(created.rawKey);

        const keys = await listDolaApiKeys();
        expect(keys).toEqual([
            expect.objectContaining({
                id: created.key.id,
                name: "Dola外部调用",
                prefix: created.rawKey.slice(0, 16),
                key: created.rawKey,
                status: "active",
            }),
        ]);

        await expect(authorizeDolaApiKey(created.rawKey, "192.168.1.5")).resolves.toMatchObject({ id: created.key.id, requestCount: 1 });
        await expect(authorizeDolaApiKey(created.rawKey, "10.0.0.1")).resolves.toBeNull();
        await expect(authorizeDolaApiKey("invalid-key", "192.168.1.5")).resolves.toBeNull();

        await updateDolaApiKey(created.key.id, { status: "disabled" });
        await expect(authorizeDolaApiKey(created.rawKey, "192.168.1.5")).resolves.toBeNull();

        await deleteDolaApiKey(created.key.id);
        await expect(listDolaApiKeys()).resolves.toHaveLength(0);
    });

    it("manages gateway settings", async () => {
        const initial = await getDolaGatewaySettings();
        expect(initial).toMatchObject({ enabled: false, rotationLimit: 2 });

        const updated = await updateDolaGatewaySettings({ enabled: true, rotationLimit: 3, dispatchGroups: ["分组A"] });
        expect(updated).toMatchObject({ enabled: true, rotationLimit: 3, dispatchGroups: ["分组A"] });
    });
});
