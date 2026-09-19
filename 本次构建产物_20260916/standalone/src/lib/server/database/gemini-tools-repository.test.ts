import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { GeminiToolsRepository } from "./gemini-tools-repository";

function repositoryWith(query: ReturnType<typeof vi.fn>) {
    return new GeminiToolsRepository({ query } as unknown as QueryExecutor);
}

describe("GeminiToolsRepository", () => {
    it("consumes an OAuth state atomically with DELETE RETURNING", async () => {
        const createdAt = new Date();
        const query = vi.fn().mockResolvedValue({
            rows: [{ state: "state-1", redirect_uri: "https://app.example/callback", opener_origin: "https://app.example", created_at: createdAt }],
            rowCount: 1,
        });

        await expect(repositoryWith(query).consumeOAuthSession("state-1")).resolves.toMatchObject({ state: "state-1", createdAt: createdAt.getTime() });
        expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM gemini_tools_oauth_sessions"), ["state-1"]);
        expect(query.mock.calls[0]?.[0]).toContain("RETURNING *");
    });

    it("loads one account through a targeted id predicate", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

        await expect(repositoryWith(query).getAccount("account-1")).resolves.toBeNull();
        expect(query).toHaveBeenCalledWith("SELECT * FROM gemini_tools_accounts WHERE id = $1", ["account-1"]);
    });

    it("filters and paginates request logs in SQL", async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ total: 7 }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await expect(repositoryWith(query).listLogs({ page: 2, pageSize: 20, keyword: "gemini_%", status: "failed" })).resolves.toEqual({ items: [], total: 7, page: 2, pageSize: 20 });
        expect(query.mock.calls[0]?.[0]).toContain("status_code >= 400");
        expect(query.mock.calls[0]?.[0]).toContain("LIKE $1");
        expect(query.mock.calls[0]?.[1]).toEqual(["%gemini\\_\\%%"]);
        expect(query.mock.calls[1]?.[0]).toContain("ORDER BY created_at DESC LIMIT $2 OFFSET $3");
        expect(query.mock.calls[1]?.[1]).toEqual(["%gemini\\_\\%%", 20, 20]);
    });
});
