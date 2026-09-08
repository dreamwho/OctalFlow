import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendGeminiAiRequestLog, clearGeminiAiRequestLogs, listGeminiAiRequestLogs } from "./geminiai-request-log-store";

describe("GeminiAIStudio request log store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "octal-geminiai-logs-"));
        vi.stubEnv("OCTALAICANVAS_DATABASE_PROVIDER", "file");
        vi.stubEnv("OCTALAICANVAS_DATA_DIR", directory);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("persists, filters and aggregates safe request records", async () => {
        await appendGeminiAiRequestLog({ source: "runtime", capability: "image", method: "POST", path: "/v1/images/generations", model: "gemini-3-pro-image", accountEmail: "owner@example.com", statusCode: 200, durationMs: 2400, requestPreview: "生成一张苹果图片", responsePreview: "已返回图片结果（图片内容未写入日志）" });
        await appendGeminiAiRequestLog({ source: "admin-test", capability: "text", method: "POST", path: "/v1/chat/completions", model: "gemini-2.5-pro", statusCode: 502, durationMs: 600, error: "上游不可用" });

        await expect(listGeminiAiRequestLogs({ keyword: "苹果", capability: "image" })).resolves.toMatchObject({
            total: 1,
            items: [expect.objectContaining({ model: "gemini-3-pro-image", accountEmail: "owner@example.com" })],
            stats: { total: 2, success: 1, failed: 1, averageDurationMs: 1500 },
        });
        await expect(clearGeminiAiRequestLogs()).resolves.toBe(2);
        await expect(listGeminiAiRequestLogs()).resolves.toMatchObject({ total: 0, items: [] });
    });
});
