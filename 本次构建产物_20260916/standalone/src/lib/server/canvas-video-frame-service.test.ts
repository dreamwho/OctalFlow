import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    mkdtemp: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    runFfmpeg: vi.fn(),
    authorize: vi.fn(),
    materialize: vi.fn(),
    normalize: vi.fn(),
    probe: vi.fn(),
    writeAsset: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, readdir: mocks.readdir, rm: mocks.rm }));
vi.mock("@/lib/server/ffmpeg", () => ({ runFfmpeg: mocks.runFfmpeg }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writeReferenceMediaFile: mocks.writeAsset }));
vi.mock("@/lib/server/canvas-video-source-service", () => ({
    authorizeCanvasVideoSource: mocks.authorize,
    materializeCanvasVideoSource: mocks.materialize,
    normalizeCanvasVideoStorageKey: mocks.normalize,
    probeCanvasVideoSource: mocks.probe,
}));

import { extractCanvasVideoFrames } from "./canvas-video-frame-service";

describe("Canvas video frame extraction", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mkdtemp.mockResolvedValue("/tmp/canvas-frame");
        mocks.readdir.mockResolvedValue(["frame-second-00000001.jpg", "frame-second-00000002.jpg", "frame-second-00000003.jpg", "frame-second-00000004.jpg", "frame-second-00000005.jpg"]);
        mocks.rm.mockResolvedValue(undefined);
        mocks.normalize.mockImplementation((value: string) => value.trim());
        mocks.authorize.mockResolvedValue({ storageKey: "permanent/source.mp4", registration: { originalName: "source.mp4", conversationId: "conversation-one" } });
        mocks.materialize.mockResolvedValue("/data/reference-assets/permanent/source.mp4");
        mocks.probe.mockResolvedValue({ durationMs: 5_000, width: 1280, height: 720, audio: { present: true } });
        mocks.runFfmpeg.mockResolvedValue({ stdout: "", stderr: "" });
        let index = 0;
        mocks.writeAsset.mockImplementation(async () => ({ token: `permanent/frame-${++index}.jpg`, bytes: 10 + index, mimeType: "image/jpeg" }));
    });

    it("writes persistent first and final frames for a video owned by the active user", async () => {
        const [result, duplicate] = await Promise.all([
            extractCanvasVideoFrames({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "both" }),
            extractCanvasVideoFrames({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "both" }),
        ]);

        expect(result).toMatchObject({
            firstFrame: { storageKey: "permanent/frame-1.jpg", serverUrl: "/api/reference-assets/permanent/frame-1.jpg", atMs: 0, width: 1280, height: 720 },
            lastFrame: { storageKey: "permanent/frame-2.jpg", serverUrl: "/api/reference-assets/permanent/frame-2.jpg", atMs: 4999, width: 1280, height: 720 },
        });
        expect(duplicate).toEqual(result);
        expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
        expect(mocks.runFfmpeg.mock.calls.map(([args]) => args)).toEqual(expect.arrayContaining([expect.arrayContaining(["-ss", "0.000"]), expect.arrayContaining(["-sseof", "-1", "-update", "1"])]));
        expect(mocks.writeAsset).toHaveBeenCalledWith(expect.stringContaining("frame-first-0.jpg"), "image", "image/jpeg", true, expect.objectContaining({ ownerUserId: "owner-one", source: "canvas-video-frame", conversationId: "conversation-one" }));
    });

    it("does not reveal another user's video", async () => {
        mocks.authorize.mockRejectedValue(new Error("视频素材不存在或无权操作"));

        await expect(extractCanvasVideoFrames({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "both" })).rejects.toThrow("视频素材不存在或无权操作");
        expect(mocks.runFfmpeg).not.toHaveBeenCalled();
    });

    it("captures the actual final frame when the preview cursor is at the video end", async () => {
        const result = await extractCanvasVideoFrames({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "current", timeMs: 5_000 });

        expect(result.frame).toMatchObject({ storageKey: "permanent/frame-1.jpg", atMs: 4999 });
        expect(mocks.runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-sseof", "-1", "-update", "1"]), expect.any(Object));
    });

    it("captures and persists one frame at every integer second without replacing first or last behavior", async () => {
        const result = await extractCanvasVideoFrames({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4", mode: "seconds" });

        expect(result.frames?.map((frame) => frame.atMs)).toEqual([0, 1000, 2000, 3000, 4000]);
        expect(result.frames?.every((frame) => frame.width === 1280 && frame.height === 720 && frame.serverUrl.startsWith("/api/reference-assets/"))).toBe(true);
        expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
        expect(mocks.runFfmpeg).toHaveBeenCalledWith(expect.arrayContaining(["-vf", "fps=1:start_time=0:round=up"]), expect.any(Object));
        expect(mocks.writeAsset).toHaveBeenCalledTimes(5);
    });
});
