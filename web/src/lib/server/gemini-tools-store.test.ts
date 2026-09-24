import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    authorizeGeminiToolsApiKey,
    createGeminiToolsApiKey,
    createGeminiToolsOAuthSession,
    consumeGeminiToolsOAuthSession,
    getGeminiToolsPrivateAccount,
    listGeminiToolsApiKeys,
    recordGeminiToolsApiKeyTokens,
    upsertGeminiToolsAccount,
} from "./gemini-tools-store";

describe("GeminiTools store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dreamyo-gemini-tools-"));
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
        vi.stubEnv("DREAMYO_ENCRYPTION_KEY", "a".repeat(64));
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("stores Google tokens encrypted while restoring them only for server-side requests", async () => {
        const account = await upsertGeminiToolsAccount({ email: "admin@example.com", name: "Admin", accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 60_000, projectId: "real-project", quotas: [] });
        const raw = await readFile(join(directory, "gemini-tools.json"), "utf8");

        expect(raw).not.toContain("access-secret");
        expect(raw).not.toContain("refresh-secret");
        await expect(getGeminiToolsPrivateAccount(account.id)).resolves.toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret", projectId: "real-project" });
    });

    it("transparently reads historical accounts encrypted with legacy octalaicanvas prefix", async () => {
        const account = await upsertGeminiToolsAccount({ email: "legacy@example.com", name: "Legacy", accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 60_000, projectId: "legacy-project", quotas: [] });
        const filePath = join(directory, "gemini-tools.json");
        const raw = await readFile(filePath, "utf8");
        const legacyRaw = raw.replaceAll("dreamyo-secret:v1:", "octalaicanvas-secret:v1:");
        await writeFile(filePath, legacyRaw, "utf8");

        await expect(getGeminiToolsPrivateAccount(account.id)).resolves.toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret", projectId: "legacy-project" });
    });

    it("stores only an API key hash and enforces status, IP ranges and token accounting", async () => {
        const created = await createGeminiToolsApiKey({ name: "CLI", allowedIps: ["10.8.0.0/16", "invalid", "2001:db8::/64"] });
        const raw = await readFile(join(directory, "gemini-tools.json"), "utf8");

        expect(raw).not.toContain(created.rawKey);
        await expect(authorizeGeminiToolsApiKey(created.rawKey, "10.8.2.4")).resolves.toMatchObject({ id: created.key.id, allowedIps: ["10.8.0.0/16"] });
        await expect(authorizeGeminiToolsApiKey(created.rawKey, "10.9.2.4")).resolves.toBeNull();
        await expect(authorizeGeminiToolsApiKey("wrong-key", "10.8.2.4")).resolves.toBeNull();

        await recordGeminiToolsApiKeyTokens(created.key.id, 42);
        await expect(listGeminiToolsApiKeys()).resolves.toEqual([expect.objectContaining({ requestCount: 1, totalTokens: 42, key: created.rawKey })]);
    });

    it("consumes every OAuth state once so repeated account additions cannot reuse a previous success", async () => {
        const first = await createGeminiToolsOAuthSession("https://app.example.com/callback", "https://app.example.com");
        const second = await createGeminiToolsOAuthSession("https://app.example.com/callback", "https://app.example.com");

        expect(first).not.toBe(second);
        await expect(consumeGeminiToolsOAuthSession(first)).resolves.toMatchObject({ state: first });
        await expect(consumeGeminiToolsOAuthSession(first)).resolves.toBeNull();
        await expect(consumeGeminiToolsOAuthSession(second)).resolves.toMatchObject({ state: second });
    });
});
