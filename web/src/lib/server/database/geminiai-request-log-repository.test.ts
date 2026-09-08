import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { GeminiAiRequestLogRepository } from "./geminiai-request-log-repository";

describe("GeminiAiRequestLogRepository", () => {
    it("uses targeted filters, pagination and a database aggregate", async () => {
        const query = vi.fn()
            .mockResolvedValueOnce({ rows: [{ total: 2 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ total: 8, success: 6, failed: 2, average_duration_ms: 1350 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const repository = new GeminiAiRequestLogRepository({ query } as unknown as QueryExecutor);

        await expect(repository.list({ page: 2, pageSize: 20, keyword: "gemini_%", status: "failed", capability: "image" })).resolves.toEqual({
            items: [], total: 2, page: 2, pageSize: 20, stats: { total: 8, success: 6, failed: 2, averageDurationMs: 1350 },
        });
        expect(query.mock.calls[0]?.[0]).toContain("status_code >= 400");
        expect(query.mock.calls[0]?.[0]).toContain("capability = $1");
        expect(query.mock.calls[0]?.[1]).toEqual(["image", "%gemini\\_\\%%"]);
        expect(query.mock.calls[2]?.[0]).toContain("ORDER BY created_at DESC LIMIT $3 OFFSET $4");
        expect(query.mock.calls[2]?.[1]).toEqual(["image", "%gemini\\_\\%%", 20, 20]);
    });
});
