import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { localGeminiAiRuntime } from "./geminiai-local-runtime.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

describe("local GeminiAI runtime", () => {
    it("keeps an explicitly configured provider without starting a local process", () => {
        const result = localGeminiAiRuntime({
            repoRoot,
            webRoot,
            environment: { DREAMYO_GEMINIAI_URL: "http://geminiai:8080", DREAMYO_GEMINIAI_API_KEY: "configured-key" },
        });
        expect(result.service).toBeUndefined();
        expect(result.environment.DREAMYO_GEMINIAI_URL).toBe("http://geminiai:8080");
    });

    it("starts the bundled provider with persistent project-local account storage", () => {
        const isolatedWebRoot = mkdtempSync(path.join(tmpdir(), "dreamyo-geminiai-runtime-"));
        try {
            const result = localGeminiAiRuntime({
                repoRoot,
                webRoot: isolatedWebRoot,
                environment: { DREAMYO_GEMINIAI_STUDIO_URL: "https://aistudio.google.com/prompts/new_chat?project=test-project" },
                tokenFactory: () => "local-runtime-key-local-runtime-key",
            });
            expect(result.environment).toMatchObject({
                DREAMYO_GEMINIAI_URL: "http://127.0.0.1:18080",
                DREAMYO_GEMINIAI_API_KEY: "local-runtime-key-local-runtime-key",
            });
            expect(result.service).toMatchObject({
                name: "geminiai",
                cwd: path.join(repoRoot, "services", "geminiai"),
                environment: {
                    AISTUDIO_API_KEY: "local-runtime-key-local-runtime-key",
                    AISTUDIO_ACCOUNTS_DIR: path.join(isolatedWebRoot, ".data", "geminiai", "accounts"),
                    AISTUDIO_HOST: "127.0.0.1",
                    AISTUDIO_PORT: "18080",
                    AISTUDIO_STUDIO_URL: "https://aistudio.google.com/prompts/new_chat?project=test-project",
                },
            });
        } finally {
            rmSync(isolatedWebRoot, { recursive: true, force: true });
        }
    });

    it("rejects a partial provider configuration", () => {
        expect(() => localGeminiAiRuntime({ repoRoot, webRoot, environment: { DREAMYO_GEMINIAI_URL: "http://127.0.0.1:18080" } })).toThrow(/必须同时配置/);
    });
});
