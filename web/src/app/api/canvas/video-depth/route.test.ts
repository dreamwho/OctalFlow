import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    extract: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/canvas-video-depth-task", () => ({ runCanvasVideoDepthTask: mocks.extract }));

import { POST } from "./route";

describe("Canvas video depth route", () => {
    it("streams progress before the result and serializes execution failures", async () => {
        mocks.extract.mockImplementationOnce(async (_input, progress) => { progress({ stage: "深度推理", percent: 25 }); throw new Error("inference failed"); });
        const response = await POST(new Request("http://localhost/api/canvas/video-depth", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ storageKey: "source.mp4" }) }));
        expect(response.headers.get("content-type")).toBe("application/x-ndjson");
        const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
        expect(events).toEqual([{ progress: { stage: "深度推理", percent: 25 } }, { code: 502, msg: "inference failed" }]);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "owner-one" });
        mocks.extract.mockResolvedValue({
            video: { storageKey: "permanent/depth.mp4", serverUrl: "/api/reference-assets/permanent/depth.mp4", mimeType: "video/mp4", bytes: 101, width: 854, height: 480, durationMs: 7750 },
        });
    });

    it("returns the persisted depth video under data.video", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-depth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ storageKey: "permanent/source.mp4" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.extract).toHaveBeenCalledWith({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4" });
        await expect(response.json()).resolves.toEqual({ code: 0, data: { video: expect.objectContaining({ storageKey: "permanent/depth.mp4", width: 854, height: 480, durationMs: 7750 }) }, msg: "视频深度图已保存" });
    });

    it("rejects a missing video storage key before invoking inference", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-depth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.extract).not.toHaveBeenCalled();
    });
});
