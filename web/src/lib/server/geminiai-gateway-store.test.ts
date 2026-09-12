import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeGeminiAiApiKey, createGeminiAiApiKey, deleteGeminiAiApiKey, getGeminiAiGatewaySettings, listGeminiAiApiKeys, updateGeminiAiApiKey, updateGeminiAiGatewaySettings } from "./geminiai-gateway-store";

describe("GeminiAIStudio gateway store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "octal-geminiai-gateway-"));
        vi.stubEnv("OCTALAICANVAS_DATABASE_PROVIDER", "file");
        vi.stubEnv("OCTALAICANVAS_DATA_DIR", directory);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("stores only an API key hash and enforces status, expiry and IP ranges", async () => {
        const future = new Date(Date.now() + 60_000).toISOString();
        const created = await createGeminiAiApiKey({ name: "外部网站", expiresAt: future, allowedIps: ["10.8.0.0/16", "invalid", "2001:db8::/64"] });
        const raw = await readFile(join(directory, "geminiai-gateway.json"), "utf8");

        expect(created.rawKey).toMatch(/^oct_gai_/);
        expect(raw).not.toContain(created.rawKey);
        await expect(authorizeGeminiAiApiKey(created.rawKey, "10.8.2.4")).resolves.toMatchObject({ id: created.key.id, requestCount: 1, allowedIps: ["10.8.0.0/16"] });
        await expect(authorizeGeminiAiApiKey(created.rawKey, "10.9.2.4")).resolves.toBeNull();
        await expect(authorizeGeminiAiApiKey("wrong-key", "10.8.2.4")).resolves.toBeNull();

        await updateGeminiAiApiKey(created.key.id, { status: "disabled" });
        await expect(authorizeGeminiAiApiKey(created.rawKey, "10.8.2.4")).resolves.toBeNull();
        await expect(listGeminiAiApiKeys()).resolves.toEqual([expect.objectContaining({ status: "disabled", requestCount: 1 })]);
    });

    it("rejects expired keys and deletes them permanently", async () => {
        const expired = await createGeminiAiApiKey({ name: "过期", expiresAt: new Date(Date.now() - 1_000).toISOString() });
        await expect(authorizeGeminiAiApiKey(expired.rawKey, "203.0.113.9")).resolves.toBeNull();

        const active = await createGeminiAiApiKey({ name: "有效" });
        await expect(deleteGeminiAiApiKey(active.key.id)).resolves.toBe(true);
        await expect(authorizeGeminiAiApiKey(active.rawKey, "203.0.113.9")).resolves.toBeNull();
        await expect(listGeminiAiApiKeys()).resolves.toHaveLength(1);
    });

    it("persists the gateway enabled toggle", async () => {
        await expect(getGeminiAiGatewaySettings()).resolves.toEqual({ enabled: true });
        await expect(updateGeminiAiGatewaySettings({ enabled: false })).resolves.toEqual({ enabled: false });
        await expect(getGeminiAiGatewaySettings()).resolves.toEqual({ enabled: false });
        await expect(updateGeminiAiGatewaySettings({})).resolves.toEqual({ enabled: false });
    });
});
