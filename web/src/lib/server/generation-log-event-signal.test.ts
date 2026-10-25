import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    notify: undefined as ((payload: string) => void) | undefined,
    subscribe: vi.fn(async (_channel: string, listener: (payload: string) => void) => {
        mocks.notify = listener;
        return () => undefined;
    }),
}));

vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: vi.fn(() => "postgres"),
    getPostgresConnectionString: vi.fn(() => "postgres://fixture"),
    subscribePostgresNotification: mocks.subscribe,
}));

import { notifyGenerationLogChanged, waitForGenerationLogChange } from "./generation-log-event-signal";

describe("generation log event signal", () => {
    it("wakes a waiting SSE loop immediately when the owner log changes", async () => {
        const waiting = waitForGenerationLogChange("user-one", 10_000);
        notifyGenerationLogChanged("user-one");
        await expect(waiting).resolves.toBe(true);
    });

    it("does not wake another user and releases aborted listeners", async () => {
        const abort = new AbortController();
        const waiting = waitForGenerationLogChange("other-user", 10_000, abort.signal);
        notifyGenerationLogChanged("user-one");
        abort.abort();
        await expect(waiting).resolves.toBe(false);
        notifyGenerationLogChanged("other-user");
    });

    it("keeps a timeout fallback for changes from another process", async () => {
        vi.useFakeTimers();
        const waiting = waitForGenerationLogChange("user-timeout", 2_500);
        await vi.advanceTimersByTimeAsync(2_500);
        await expect(waiting).resolves.toBe(false);
        vi.useRealTimers();
    });

    it("wakes the local SSE waiter from a PostgreSQL notification", async () => {
        const waiting = waitForGenerationLogChange("user-remote", 10_000);
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("dreamyo_generation_logs", expect.any(Function)));
        mocks.notify?.("user-remote");
        await expect(waiting).resolves.toBe(true);
    });
});
