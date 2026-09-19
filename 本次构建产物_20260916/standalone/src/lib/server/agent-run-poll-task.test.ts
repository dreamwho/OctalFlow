import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetchInternalApi: vi.fn(),
    getAgentRun: vi.fn(),
}));

vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/agent-run-store", () => ({
    getAgentRun: mocks.getAgentRun,
    updateAgentRunById: vi.fn(),
    updateAgentRunTaskById: vi.fn(),
}));

import { pollTask } from "./agent-run-execution";

describe("pollTask", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAgentRun.mockResolvedValue({ id: "run", status: "running", executionId: "execution" });
    });

    it("turns a review-only upstream submission into a retryable terminal failure", async () => {
        mocks.fetchInternalApi.mockResolvedValue(
            new Response(JSON.stringify({ task: { status: "running", needsReview: true } }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(pollTask("http://internal", "/api/image-tasks", "child", "", "run", "image", "execution")).rejects.toThrow("系统已停止等待以避免重复生成和扣费，请单独重试此任务");
    });
});
