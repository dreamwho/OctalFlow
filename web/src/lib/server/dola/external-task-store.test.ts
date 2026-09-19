import { describe, expect, it, vi } from "vitest";

const state = new Map<string, unknown>();

vi.mock("@/lib/server/data-adapter", () => {
    return {
        readJsonDataFile: vi.fn(async (file: string, fallback: unknown) => (state.has(file) ? structuredClone(state.get(file)) : structuredClone(fallback))),
        withJsonDataFileLock: vi.fn(async (_file: string, callback: () => Promise<void>) => callback()),
        writeJsonDataFile: vi.fn(async (file: string, value: unknown) => {
            state.set(file, structuredClone(value));
        }),
    };
});

import { bindDolaExternalTask, getDolaExternalTask, releaseDolaExternalTask } from "./external-task-store";

describe("Dola external task ownership", () => {
    it("binds a task to the issuing API key and rejects another key", async () => {
        const record = await bindDolaExternalTask({ taskId: "task-1", apiKeyId: "key-a", accountId: "account-a" });
        expect(record.taskId).toBe("task-1");
        await expect(getDolaExternalTask("task-1", "key-a")).resolves.toMatchObject({ accountId: "account-a" });
        await expect(getDolaExternalTask("task-1", "key-b")).resolves.toBeNull();
        await expect(releaseDolaExternalTask("task-1", "key-a")).resolves.toBe("account-a");
        await expect(releaseDolaExternalTask("task-1", "key-a")).resolves.toBe("");
    });
});
