import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), transition: vi.fn(), extract: vi.fn(), authorize: vi.fn() }));
vi.mock("./generation-task-store", () => ({ createStoredGenerationTask: mocks.create, transitionStoredGenerationTask: mocks.transition }));
vi.mock("./canvas-video-depth-service", () => ({ extractCanvasVideoDepth: mocks.extract }));
vi.mock("./canvas-video-source-service", () => ({ authorizeCanvasVideoSource: mocks.authorize }));
import { runCanvasVideoDepthTask } from "./canvas-video-depth-task";
describe("depth task observability", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockResolvedValue({ registration: { projectId: "project-one" } });
        mocks.create.mockImplementation(async (_type, task) => task);
        mocks.transition.mockResolvedValue({});
    });
    it("registers the task and persists real progress and the successful result", async () => {
        const result = { video: { storageKey: "depth.mp4" } };
        mocks.extract.mockImplementation(async ({ onProgress }) => {
            await onProgress({ stage: "深度推理 1/4 帧", percent: 25 });
            return result;
        });
        const progress = vi.fn();
        await expect(runCanvasVideoDepthTask({ ownerUserId: "owner", storageKey: "source.mp4" }, progress)).resolves.toEqual(result);
        expect(mocks.create).toHaveBeenCalledWith("render", expect.objectContaining({ userId: "owner", surface: "canvas", projectId: "project-one", prompt: "深度提取" }), expect.any(Number));
        expect(progress).toHaveBeenCalledWith({ stage: "深度推理 1/4 帧", percent: 25 });
        expect(mocks.transition.mock.calls.at(-1)?.[4]).toEqual({ status: "success", result });
    });
    it("records the exact failure and rejects rather than reporting success", async () => {
        mocks.extract.mockRejectedValue(new Error("model unavailable"));
        await expect(runCanvasVideoDepthTask({ ownerUserId: "owner", storageKey: "source.mp4" })).rejects.toThrow("model unavailable");
        expect(mocks.transition.mock.calls.at(-1)?.[4]).toEqual({ status: "error", error: "model unavailable" });
    });
});
