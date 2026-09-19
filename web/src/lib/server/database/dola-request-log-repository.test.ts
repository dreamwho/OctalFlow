import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { DolaRequestLogRepository } from "./dola-request-log-repository";

describe("DolaRequestLogRepository", () => {
    it("uses targeted status, proxy and keyword filters with pagination", async () => {
        const query = vi.fn()
            .mockResolvedValueOnce({ rows: [{ total: 2 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ total: 7, success: 4, failed: 1, needs_review: 2, pending: 0, average_duration_ms: 900 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const repository = new DolaRequestLogRepository({ query } as unknown as QueryExecutor);

        await expect(repository.list({ page: 2, pageSize: 20, keyword: "seedance_%", status: "needs_review", source: "admin-test", proxyMode: "generic" })).resolves.toEqual({ items: [], total: 2, page: 2, pageSize: 20, stats: { total: 7, success: 4, failed: 1, needsReview: 2, pending: 0, averageDurationMs: 900 } });
        expect(query.mock.calls[0]?.[0]).toContain("phase='needs_review'");
        expect(query.mock.calls[0]?.[0]).toContain("source=$1");
        expect(query.mock.calls[0]?.[0]).toContain("proxy_egress->>'mode'");
        expect(query.mock.calls[2]?.[0]).toContain("ORDER BY created_at DESC LIMIT $4 OFFSET $5");
        expect(query.mock.calls[2]?.[1]).toEqual(["admin-test", "generic", "%seedance\\_\\%%", 20, 20]);
    });
});
