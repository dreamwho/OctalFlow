import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    extract: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/canvas-video-frame-service", () => ({ extractCanvasVideoFrames: mocks.extract }));

import { POST } from "./route";

describe("Canvas video frame route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "owner-one" });
        mocks.extract.mockResolvedValue({ frame: { storageKey: "permanent/frame.jpg", serverUrl: "/api/reference-assets/permanent/frame.jpg", mimeType: "image/jpeg", bytes: 4, atMs: 1200 } });
    });

    it("requires an authenticated owner and forwards only a stable storage key", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-frames", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ storageKey: "permanent/source.mp4", mode: "current", timeMs: 1200 }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.extract).toHaveBeenCalledWith({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "current", timeMs: 1200 });
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { frame: { storageKey: "permanent/frame.jpg" } } });
    });

    it("rejects a missing storage key before opening media", async () => {
        const response = await POST(
            new Request("http://localhost/api/canvas/video-frames", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "both" }),
            }),
        );

        expect(response.status).toBe(400);
        expect(mocks.extract).not.toHaveBeenCalled();
    });

    it("accepts seconds mode and returns the persisted frame collection", async () => {
        mocks.extract.mockResolvedValue({
            frames: [
                { storageKey: "permanent/frame-0.jpg", serverUrl: "/api/reference-assets/permanent/frame-0.jpg", mimeType: "image/jpeg", bytes: 4, width: 854, height: 480, atMs: 0 },
                { storageKey: "permanent/frame-1.jpg", serverUrl: "/api/reference-assets/permanent/frame-1.jpg", mimeType: "image/jpeg", bytes: 4, width: 854, height: 480, atMs: 1000 },
            ],
        });
        const response = await POST(
            new Request("http://localhost/api/canvas/video-frames", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ storageKey: "permanent/source.mp4", mode: "seconds" }),
            }),
        );

        expect(response.status).toBe(200);
        expect(mocks.extract).toHaveBeenCalledWith({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "seconds", timeMs: undefined });
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { frames: [expect.objectContaining({ atMs: 0 }), expect.objectContaining({ atMs: 1000 })] } });
    });
});
