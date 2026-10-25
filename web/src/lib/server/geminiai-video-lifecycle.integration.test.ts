import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/magic-proxy-service", () => ({ ensureMagicProxyProvider: vi.fn().mockResolvedValue({ enabled: false }), MagicProxyError: class extends Error {} }));
vi.mock("@/lib/server/geminiai-gateway-store", () => ({ getGeminiAiGatewaySettings: vi.fn().mockResolvedValue({ enabled: true, rotationLimit: 2 }) }));

import { geminiAiRuntimeRequest } from "./geminiai-provider";
import { listGeminiAiRequestLogs } from "./geminiai-request-log-store";

describe("GeminiAI video task lifecycle over local TCP", () => {
    let server: Server;
    let directory: string;
    let status: string;
    let stage: string;
    let omitVideo: boolean;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "omni-lifecycle-"));
        status = "processing";
        stage = "queued";
        omitVideo = false;
        server = createServer((request, response) => {
            request.resume();
            request.on("end", () => {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ id: "vt_fixture", model: "gemini-omni-1.1-flash", prompt: "不得出现在响应摘要中的提示词", cookie: "private-cookie", status, execution_stage: stage, account_id: stage === "queued" ? null : "actual-account", account_email: stage === "queued" ? null : "fixture@example.com", ...(status === "succeeded" && !omitVideo ? { video_url: "/v1/videos/vt_fixture/content" } : {}), ...(status === "failed" ? { error: "fixture generation failed" } : {}) }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing fixture port");
        vi.stubEnv("DREAMYO_GEMINIAI_URL", `http://127.0.0.1:${address.port}`);
        vi.stubEnv("DREAMYO_GEMINIAI_API_KEY", "fixture-key");
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    const submit = () => geminiAiRuntimeRequest("/v1/videos", { method: "POST", body: JSON.stringify({ model: "gemini-omni-1.1-flash", prompt: "用户原文" }) });
    const poll = () => geminiAiRuntimeRequest("/v1/videos/vt_fixture", { method: "GET" });

    it.each(["succeeded", "failed"])("updates the original acceptance to %s without duplicate polling rows", async (terminal) => {
        await submit();
        const accepted = await listGeminiAiRequestLogs();
        expect(accepted).toMatchObject({ total: 1, stats: { success: 0, failed: 0 } });
        expect(accepted.items[0]).toMatchObject({ phase: "running", taskId: "vt_fixture", method: "POST", requestPreview: "用户原文" });
        expect(accepted.items[0].responsePreview).not.toContain("不得出现在");
        expect(accepted.items[0].responsePreview).not.toContain("private-cookie");
        expect((await listGeminiAiRequestLogs({ status: "success" })).total).toBe(0);

        stage = "generating";
        await poll();
        const running = await listGeminiAiRequestLogs();
        const stageCount = running.items[0].lifecycle?.length;
        await poll();
        expect((await listGeminiAiRequestLogs()).items[0].lifecycle).toHaveLength(stageCount!);
        status = terminal;
        await poll();
        const completed = await listGeminiAiRequestLogs();
        expect(completed.total).toBe(1);
        expect(completed.items[0]).toMatchObject({ id: accepted.items[0].id, method: "POST", path: "/v1/videos", phase: terminal === "succeeded" ? "success" : "failed", accountId: "actual-account", accountEmail: "fixture@example.com" });
        expect(completed.items[0].durationMs).toBeGreaterThanOrEqual(accepted.items[0].durationMs);
        expect(completed.stats).toMatchObject({ success: terminal === "succeeded" ? 1 : 0, failed: terminal === "failed" ? 1 : 0 });
        status = "processing";
        await poll();
        expect((await listGeminiAiRequestLogs()).items[0]).toEqual(completed.items[0]);
    });

    it("rejects success without a video address", async () => {
        await submit();
        status = "succeeded";
        omitVideo = true;
        await poll();
        expect((await listGeminiAiRequestLogs()).items[0]).toMatchObject({ phase: "failed", error: "视频任务返回成功状态，但缺少视频地址" });
    });
});
