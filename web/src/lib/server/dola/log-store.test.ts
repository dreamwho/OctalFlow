import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceDolaTaskLog, appendDolaRequestLog, clearDolaRequestLogs, dolaTaskLogPhase, findDolaTaskLogIdByTaskId, listDolaRequestLogs, markDolaRequestLogRunning, openDolaRequestLog, settleDolaRequestLog } from "./log-store";

describe("Dola request log store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "dreamyo-dola-logs-"));
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_DATA_DIR", directory);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("keeps lifecycle, safe previews, filters and aggregate counters", async () => {
        const logId = await openDolaRequestLog({ source: "admin-test", capability: "video", method: "POST", path: "/v1/videos", model: "dola-seedance-2-5", accountId: "dola-account-1", accountName: "测试账号", requestedDuration: 5, ratio: "16:9", requestPreview: JSON.stringify({ model: "dola-seedance-2-5", cookie: "never-log" }), headers: { authorization: "secret", "content-type": "application/json" } });
        await markDolaRequestLogRunning(logId, { phase: "upstream", message: "发送到 Provider" });
        await settleDolaRequestLog(logId, { statusCode: 200, durationMs: 1_250, phase: "needs_review", verificationId: "verification-1", responsePreview: JSON.stringify({ status: "submission_unknown", cookie: "never-log" }), responseBytes: 128, lifecycle: [{ time: new Date().toISOString(), phase: "queued", message: "排队" }, { time: new Date().toISOString(), phase: "needs_review", message: "等待人工确认" }] });
        await appendDolaRequestLog({ source: "runtime", capability: "video", method: "GET", path: "/v1/models", model: "", statusCode: 200, durationMs: 250, phase: "success" });
        await appendDolaRequestLog({ source: "external", capability: "video", method: "POST", path: "/v1/videos", model: "dola-seedance-2-0-fast", statusCode: 502, durationMs: 500, phase: "failed", error: "上游不可用" });

        await expect(listDolaRequestLogs({ keyword: "verification-1" })).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ phase: "needs_review", verificationId: "verification-1", lifecycle: expect.any(Array) })], stats: { total: 3, success: 1, failed: 1, needsReview: 1, pending: 0, averageDurationMs: 667 } });
        const page = await listDolaRequestLogs({ status: "needs_review", phase: "needs_review" });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.headers).toEqual({ "content-type": "application/json" });
        expect(page.items[0]?.requestPreview).not.toContain("never-log");
        await expect(clearDolaRequestLogs()).resolves.toBe(3);
    });

    it("tracks one task log across create + polls instead of marking submission as success", async () => {
        expect(dolaTaskLogPhase("queued")).toBe("submitted");
        expect(dolaTaskLogPhase("accepted")).toBe("generating");
        expect(dolaTaskLogPhase("running")).toBe("generating");
        expect(dolaTaskLogPhase("completed")).toBe("success");
        expect(dolaTaskLogPhase("failed")).toBe("failed");
        expect(dolaTaskLogPhase("", true)).toBe("needs_review");

        const logId = await openDolaRequestLog({ source: "runtime", capability: "image", method: "POST", path: "/v1/images", model: "dola-seedream-4-5", requestedDuration: 0, ratio: "9:16" });
        await settleDolaRequestLog(logId, { statusCode: 200, durationMs: 800, phase: dolaTaskLogPhase("queued"), taskId: "dola-task-lifecycle", responsePreview: JSON.stringify({ taskId: "dola-task-lifecycle", status: "queued" }), lifecycle: [{ time: new Date().toISOString(), phase: "queued", message: "等待执行" }, { time: new Date().toISOString(), phase: "submitted", message: "已提交到 Dola 上游，任务排队中" }] });
        await expect(findDolaTaskLogIdByTaskId("dola-task-lifecycle", "runtime")).resolves.toBe(logId);
        await expect(findDolaTaskLogIdByTaskId("dola-task-lifecycle", "external")).resolves.toBe("");
        await expect(findDolaTaskLogIdByTaskId("", "runtime")).resolves.toBe("");

        // Repeated queued polls must not append lifecycle entries.
        await advanceDolaTaskLog(logId, { phase: "submitted", message: "Dola 上游排队中，等待生成", statusCode: 200, responsePreview: JSON.stringify({ status: "queued" }) });
        await advanceDolaTaskLog(logId, { phase: "generating", message: "Dola 上游已受理，生成中", statusCode: 200, responsePreview: JSON.stringify({ status: "accepted" }) });
        await advanceDolaTaskLog(logId, { phase: "generating", message: "Dola 上游已受理，生成中", statusCode: 200, responsePreview: JSON.stringify({ status: "running" }) });
        await advanceDolaTaskLog(logId, { phase: "success", message: "生成完成，最终结果已返回", detail: "结果地址: https://lf-email-ic.byteintlapi.com/ok.png", statusCode: 200, responsePreview: JSON.stringify({ status: "completed", imageUrls: ["https://lf-email-ic.byteintlapi.com/ok.png"] }) });

        const page = await listDolaRequestLogs({ keyword: "dola-task-lifecycle" });
        expect(page.items).toHaveLength(1);
        const log = page.items[0]!;
        expect(log.phase).toBe("success");
        expect(log.capability).toBe("image");
        expect(log.statusCode).toBe(200);
        expect(log.durationMs).toBeGreaterThanOrEqual(0);
        expect(log.responsePreview).toContain("https://lf-email-ic.byteintlapi.com/ok.png");
        expect(log.lifecycle?.map((entry) => entry.phase)).toEqual(["queued", "submitted", "generating", "success"]);
        expect(log.lifecycle?.[3]?.detail).toContain("byteintlapi.com");
    });

    it("closes a failed task with total duration and keeps pending counters for in-flight tasks", async () => {
        const logId = await openDolaRequestLog({ source: "external", capability: "video", method: "POST", path: "/v1/videos", model: "dola-seedance-2-5" });
        await settleDolaRequestLog(logId, { statusCode: 200, durationMs: 900, phase: "submitted", taskId: "dola-task-fail" });
        await advanceDolaTaskLog(logId, { phase: "generating", message: "Dola 上游已受理，生成中", statusCode: 200 });
        await expect(listDolaRequestLogs({ status: "pending", keyword: "dola-task-fail" })).resolves.toMatchObject({ total: 1 });
        await advanceDolaTaskLog(logId, { phase: "failed", message: "生成失败：视频生成失败", statusCode: 200, error: "upstream_generation_failed" });
        const page = await listDolaRequestLogs({ keyword: "dola-task-fail" });
        expect(page.items[0]?.phase).toBe("failed");
        expect(page.items[0]?.error).toBe("upstream_generation_failed");
        expect(page.stats.pending).toBe(0);
    });
});
