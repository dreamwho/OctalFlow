import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    analyze: vi.fn(),
    origin: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/canvas-video-analysis-service", () => ({ analyzeCanvasVideo: mocks.analyze }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: mocks.origin }));

import { POST } from "./route";

describe("Canvas video analysis route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "owner-one" });
        mocks.origin.mockReturnValue("http://127.0.0.1:3000");
        mocks.analyze.mockResolvedValue({ analysisText: "【一、视频结构摘要】\n内容", model: "configured-video-analysis", pointsRemaining: 66 });
    });

    it("returns only the configured server-side analysis result and ignores a client model override", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-analysis", {
                method: "POST",
                headers: { "Content-Type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ storageKey: "permanent/source.mp4", requestId: "request-one", model: "client-forged-model" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.analyze).toHaveBeenCalledWith({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", requestId: "request-one", origin: "http://127.0.0.1:3000", cookie: "session=test" });
        await expect(response.json()).resolves.toEqual({ code: 0, data: { analysisText: "【一、视频结构摘要】\n内容", model: "configured-video-analysis" }, msg: "视频分析已完成" });
        expect(response.headers.get("x-octalaicanvas-points-remaining")).toBe("66");
    });

    it("rejects a missing stable request identifier", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-analysis", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ storageKey: "permanent/source.mp4" }),
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
});
