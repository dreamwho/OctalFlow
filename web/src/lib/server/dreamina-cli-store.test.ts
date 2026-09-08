import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    acquireDreaminaCliSubmitLease,
    appendDreaminaCliRequestLog,
    clearDreaminaCliRequestLogs,
    dreaminaCliRequestStats,
    dreaminaCliStatsWindow,
    finalizeDreaminaCliRequestLog,
    getDreaminaCliAccountState,
    listDreaminaCliRequestLogs,
    requestStats,
    releaseDreaminaCliSubmitLease,
    updateDreaminaCliAccountState,
} from "./dreamina-cli-store";

describe("Dreamina CLI account and request log store", () => {
    let directory = "";

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "octal-dreamina-store-"));
        vi.stubEnv("OCTALAICANVAS_DATABASE_PROVIDER", "file");
        vi.stubEnv("OCTALAICANVAS_DATA_DIR", directory);
        vi.stubEnv("OCTALAICANVAS_TIME_ZONE", "Asia/Shanghai");
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("stores only a server-side account snapshot and preserves it through a lease", async () => {
        await updateDreaminaCliAccountState({ status: "authorized", userId: "remote-user", vipLevel: "maestro", totalCredit: 5401, lastCreditCheckedAt: "2026-08-31T00:00:00.000Z" });
        const lease = await acquireDreaminaCliSubmitLease({ owner: "worker-a", taskId: "task-a", leaseUntil: new Date(Date.now() + 60_000) });
        expect(lease?.account).toMatchObject({ status: "authorized", userId: "remote-user", totalCredit: 5401, submitLeaseOwner: "worker-a" });
        await expect(acquireDreaminaCliSubmitLease({ owner: "worker-b", taskId: "task-b", leaseUntil: new Date(Date.now() + 60_000) })).resolves.toBeNull();
        await releaseDreaminaCliSubmitLease("worker-a");
        await expect(getDreaminaCliAccountState()).resolves.toMatchObject({ status: "authorized", totalCredit: 5401 });
    });

    it("records safe credit observations and removes forbidden log fields", async () => {
        await appendDreaminaCliRequestLog({
            command: "image_upscale",
            phase: "submit",
            capability: "image",
            model: "dreamina-image-upscale",
            status: "success",
            beforeCredit: 5401,
            afterCredit: 5391,
            observedCreditDelta: 10,
            creditObservation: "observed",
            requestSummary: { resolutionType: "4k", prompt: "不能保存", filePath: "/private/tmp/source.png" },
            resultSummary: { resultCount: 1, stdout: "不能保存" },
        });
        await appendDreaminaCliRequestLog({ command: "query_result", phase: "query", status: "needs_review", creditObservation: "unavailable", error: "unknown /private/tmp/output.mp4 token=secret" });

        await expect(listDreaminaCliRequestLogs({ command: "image_upscale" })).resolves.toMatchObject({
            total: 1,
            items: [expect.objectContaining({ requestSummary: { resolutionType: "4k" }, resultSummary: { resultCount: 1 } })],
        });
        await expect(dreaminaCliRequestStats()).resolves.toMatchObject({ range: "all", total: 1, success: 1, failed: 0, needsReview: 0, officialCredits: 0, observedCredits: 10 });
        await expect(clearDreaminaCliRequestLogs()).resolves.toBe(2);
    });

    it("excludes historic polling entries from task statistics", async () => {
        for (const phase of ["submit", "query"] as const) {
            await appendDreaminaCliRequestLog({
                command: phase === "submit" ? "text2image" : "query_result",
                phase,
                status: "success",
                submissionId: "same-submit",
                observedCreditDelta: 6,
                creditObservation: "official",
            });
        }
        await expect(dreaminaCliRequestStats()).resolves.toMatchObject({ total: 1, officialCredits: 6, observedCredits: 6 });
    });

    it("keeps a submitted task in one lifecycle log and records only the final CLI response", async () => {
        const submitted = await appendDreaminaCliRequestLog({
            command: "image_upscale",
            phase: "submit",
            capability: "image",
            model: "dreamina-image-upscale",
            status: "started",
            submissionId: "upscale-one",
            observedCreditDelta: 4,
            creditObservation: "official",
            submissionSummary: { accepted: true, submitId: "upscale-one", officialCreditCost: 4 },
        });

        await finalizeDreaminaCliRequestLog({
            submissionId: "upscale-one",
            status: "success",
            finishedAt: new Date(Date.parse(submitted.createdAt) + 12_345).toISOString(),
            resultSummary: { state: "succeeded", status: "completed", outputCount: 1 },
        });

        await expect(listDreaminaCliRequestLogs()).resolves.toMatchObject({
            total: 1,
            items: [
                expect.objectContaining({
                    id: submitted.id,
                    status: "success",
                    durationMs: 12_345,
                    succeededAt: new Date(Date.parse(submitted.createdAt) + 12_345).toISOString(),
                    submissionSummary: { accepted: true, submitId: "upscale-one", officialCreditCost: 4 },
                    resultSummary: { state: "succeeded", status: "completed", outputCount: 1 },
                }),
            ],
        });
    });

    it("filters calendar ranges and assigns a duplicated official cost to its first task timestamp", () => {
        const logs = [
            statsLog("submit", "2026-08-31T01:00:00.000Z", "same-submit", 6),
            statsLog("query", "2026-09-05T01:00:00.000Z", "same-submit", 6),
            statsLog("submit", "2026-08-20T01:00:00.000Z", "prior-submit", 4),
            statsLog("submit", "2026-08-30T16:00:00.000Z", "week-boundary", 2),
            { ...statsLog("submit", "2026-09-02T01:00:00.000Z", "legacy-observed", 9), creditObservation: "observed" as const },
        ];
        const now = new Date("2026-09-06T04:00:00.000Z");
        const week = dreaminaCliStatsWindow("week", now);

        expect(week).toMatchObject({ range: "week", startAt: "2026-08-30T16:00:00.000Z", timeZone: "Asia/Shanghai" });
        expect(requestStats(logs, week)).toMatchObject({ total: 3, success: 3, officialCredits: 8, observedCredits: 17 });
        expect(requestStats(logs, dreaminaCliStatsWindow("all", now))).toMatchObject({ total: 4, success: 4, officialCredits: 12, observedCredits: 21 });
    });
});

function statsLog(phase: "submit" | "query", createdAt: string, submissionId: string, observedCreditDelta: number) {
    return {
        id: `${submissionId}-${phase}`,
        createdAt,
        updatedAt: createdAt,
        command: phase === "submit" ? ("text2image" as const) : ("query_result" as const),
        phase,
        status: "success" as const,
        submissionId,
        observedCreditDelta,
        creditObservation: "official" as const,
        requestSummary: {},
        submissionSummary: {},
        resultSummary: {},
    };
}
