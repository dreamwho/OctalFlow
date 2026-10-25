import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    byRequest: vi.fn(),
    schedule: vi.fn(),
    getImage: vi.fn(),
    transitionImage: vi.fn(),
    getVideo: vi.fn(),
    transitionVideo: vi.fn(),
    getLog: vi.fn(),
}));

vi.mock("@/lib/server/generation-task-store", () => ({ getStoredGenerationTaskByRequest: mocks.byRequest, getStoredGenerationTaskRecord: mocks.schedule }));
vi.mock("@/lib/server/image-task-store", () => ({ getImageTask: mocks.getImage, transitionImageTask: mocks.transitionImage }));
vi.mock("@/lib/server/video-task-store", () => ({ getVideoTask: mocks.getVideo, transitionVideoTask: mocks.transitionVideo }));
vi.mock("@/lib/server/generation-log-store", () => ({ getGenerationLogForUser: mocks.getLog }));

import { cancelActiveGenerationLogSlots, isActiveGenerationLogSlot } from "./generation-log-cancellation";

describe("cancelActiveGenerationLogSlots", () => {
    beforeEach(() => vi.clearAllMocks());

    it("cancels only selected pending slots that resolve to an active task owned by the user", async () => {
        mocks.byRequest.mockResolvedValue({ id: "task-one" });
        mocks.getImage.mockResolvedValue({ id: "task-one", userId: "user-one", status: "running", config: { baseUrl: "https://provider.test", apiKey: "key", apiFormat: "openai", model: "image-model" } });
        mocks.schedule.mockResolvedValue({ executionPhase: "polling" });
        mocks.transitionImage.mockResolvedValue({ id: "task-one" });
        const log = {
            id: "record-one", kind: "image",
            requestSnapshot: { slots: [
                { id: "selected", index: 0, status: "pending", clientRequestId: "request-one" },
                { id: "unselected", index: 1, status: "pending", clientRequestId: "request-two" },
                { id: "terminal", index: 2, status: "success", clientRequestId: "request-three" },
            ] },
        } as never;

        const cancelled = await cancelActiveGenerationLogSlots("user-one", [log], new Map([["record-one", new Set(["selected"])] ]));

        expect(cancelled).toEqual([{ type: "image", id: "task-one" }]);
        expect(mocks.byRequest).toHaveBeenCalledTimes(1);
        expect(mocks.transitionImage).toHaveBeenCalledWith(expect.objectContaining({ id: "task-one" }), ["pending", "running"], expect.objectContaining({ status: "cancelled" }), expect.objectContaining({ executionPhase: "cancel_requested" }));
    });

    it("does not cancel a task owned by someone else", async () => {
        mocks.byRequest.mockResolvedValue({ id: "task-one" });
        mocks.getImage.mockResolvedValue({ id: "task-one", userId: "other-user", status: "running" });
        const log = { id: "record-one", kind: "image", requestSnapshot: { slots: [{ id: "slot-one", status: "pending", clientRequestId: "request-one" }] } } as never;

        expect(await cancelActiveGenerationLogSlots("user-one", [log])).toEqual([]);
        expect(mocks.transitionImage).not.toHaveBeenCalled();
    });
});

describe("isActiveGenerationLogSlot", () => {
    beforeEach(() => vi.clearAllMocks());

    it("requires the user's exact pending workbench slot and request identity", async () => {
        mocks.getLog.mockResolvedValue({
            id: "log-one", userId: "user-one", kind: "video", source: "video-workbench",
            requestSnapshot: { slots: [{ id: "slot-one", clientRequestId: "request-one", status: "pending" }] },
        });
        await expect(isActiveGenerationLogSlot("user-one", "log-one", "slot-one", "request-one", "video")).resolves.toBe(true);
        await expect(isActiveGenerationLogSlot("user-one", "log-one", "slot-one", "other-request", "video")).resolves.toBe(false);
        await expect(isActiveGenerationLogSlot("user-one", "log-one", "slot-one", "request-one", "image")).resolves.toBe(false);
        expect(mocks.getLog).toHaveBeenCalledWith("user-one", "log-one");
    });
});
