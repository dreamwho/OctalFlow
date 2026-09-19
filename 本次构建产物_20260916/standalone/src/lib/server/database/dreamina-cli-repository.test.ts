import { describe, expect, it, vi } from "vitest";

import { DreaminaCliRepository } from "./dreamina-cli-repository";
import type { QueryExecutor } from "./postgres";

describe("Dreamina CLI request statistics repository", () => {
    it("aggregates a bounded range in PostgreSQL and deduplicates official submit costs", async () => {
        const query = vi.fn().mockResolvedValue({
            rows: [{ total: 4, success: 3, failed: 1, needs_review: 0, official_credits: "18", observed_credits: "18" }],
            rowCount: 1,
        });
        const repository = new DreaminaCliRepository({ query } as unknown as QueryExecutor);
        const window = {
            range: "week" as const,
            startAt: "2026-08-24T16:00:00.000Z",
            endAt: "2026-08-31T04:00:00.000Z",
            timeZone: "Asia/Shanghai",
        };

        await expect(repository.requestStats(window)).resolves.toEqual({ ...window, total: 4, success: 3, failed: 1, needsReview: 0, officialCredits: 18, observedCredits: 18 });

        const [sql, values] = query.mock.calls[0];
        expect(sql).toContain("created_at >= $1::timestamptz");
        expect(sql).toContain("created_at < $2::timestamptz");
        expect(sql).toContain("min(created_at) AS spent_at");
        expect(sql).toContain("GROUP BY coalesce(nullif(submit_id, ''), nullif(generation_task_id, ''), id)");
        expect(values).toEqual([new Date(window.startAt), new Date(window.endAt)]);
    });

    it("updates the original submit row with its terminal lifecycle result", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        const repository = new DreaminaCliRepository({ query } as unknown as QueryExecutor);

        await repository.finalizeRequestLogBySubmissionId({
            submissionId: "submit-upscale",
            status: "success",
            finishedAt: "2026-09-01T00:10:00.000Z",
            observedCreditDelta: 4,
            creditObservation: "official",
            resultSummary: { state: "succeeded", status: "completed", outputCount: 1 },
        });

        const [sql, values] = query.mock.calls[0];
        expect(sql).toContain("WHERE submit_id=$1 AND phase='submit'");
        expect(sql).toContain("succeeded_at=CASE WHEN $2 = 'success'");
        expect(sql).toContain("result_summary=$8::jsonb");
        expect(values.slice(0, 5)).toEqual(["submit-upscale", "success", expect.any(Date), 4, "official"]);
        expect(values[7]).toBe('{"state":"succeeded","status":"completed","outputCount":1}');
    });
});
