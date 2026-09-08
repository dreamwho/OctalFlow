import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    writeFile: vi.fn(),
    realpath: vi.fn(),
    stat: vi.fn(),
    available: vi.fn(),
    probe: vi.fn(),
    registration: vi.fn(),
    dataDir: vi.fn(),
    config: vi.fn(),
    assertConfig: vi.fn(),
    objectBytes: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath, stat: mocks.stat, writeFile: mocks.writeFile }));
vi.mock("@/lib/server/ffmpeg", () => ({ ffmpegAvailable: mocks.available, runFfprobe: mocks.probe }));
vi.mock("@/lib/server/data-dir", () => ({ getServerDataDir: mocks.dataDir }));
vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistration: mocks.registration }));
vi.mock("@/lib/server/object-storage-config", () => ({ getObjectStorageRuntimeConfig: mocks.config, assertObjectStorageConfigured: mocks.assertConfig }));
vi.mock("@/lib/server/object-storage-client", () => ({ getObjectBytes: mocks.objectBytes }));

import { CanvasVideoOperationError, authorizeCanvasVideoSource, materializeCanvasVideoSource, probeCanvasVideoSource } from "./canvas-video-source-service";

describe("Canvas video source service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.registration.mockResolvedValue({ storageKey: "permanent/source.mp4", scope: "reference", type: "video", ownerUserId: "owner-one", storageProvider: "local", mimeType: "video/mp4", bytes: 10, source: "canvas" });
        mocks.dataDir.mockReturnValue("/data");
        mocks.realpath.mockImplementation(async (value: string) => value);
        mocks.stat.mockResolvedValue({ isFile: () => true });
        mocks.available.mockResolvedValue(true);
        mocks.probe.mockResolvedValue({
            stdout: JSON.stringify({
                streams: [
                    { codec_type: "video", codec_name: "h264", width: 854, height: 480, avg_frame_rate: "25/1" },
                    { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
                ],
                format: { duration: "7.75" },
            }),
        });
    });

    it("authorizes only an owned persistent reference video and exposes its real media probe", async () => {
        const source = await authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: " permanent\\source.mp4 " });
        const path = await materializeCanvasVideoSource(source, "/tmp/work");
        const probe = await probeCanvasVideoSource(path);

        expect(source.storageKey).toBe("permanent/source.mp4");
        expect(path).toBe("/data/reference-assets/permanent/source.mp4");
        expect(probe).toEqual({ durationMs: 7750, width: 854, height: 480, frameRate: "25/1", audio: { present: true, codec: "aac", channels: 2, sampleRate: 48000 } });
    });

    it("authorizes and safely materializes a generated video owned by the active user", async () => {
        mocks.registration.mockResolvedValue({ storageKey: "permanent/2026/09/08/videos/generated.mp4", scope: "generation", type: "video", ownerUserId: "owner-one", storageProvider: "local", mimeType: "video/mp4", bytes: 10, source: "video-generation" });

        const source = await authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: "permanent/2026/09/08/videos/generated.mp4" });
        await expect(materializeCanvasVideoSource(source, "/tmp/work")).resolves.toBe("/data/generation-assets/permanent/2026/09/08/videos/generated.mp4");
    });

    it("does not resolve a registered local media key outside its scoped media root", async () => {
        mocks.registration.mockResolvedValue({ storageKey: "../outside.mp4", scope: "generation", type: "video", ownerUserId: "owner-one", storageProvider: "local", mimeType: "video/mp4", bytes: 10, source: "video-generation" });

        const source = await authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: "../outside.mp4" });
        await expect(materializeCanvasVideoSource(source, "/tmp/work")).rejects.toMatchObject({ message: "视频素材文件不存在或已过期", status: 404 } satisfies Partial<CanvasVideoOperationError>);
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.realpath).not.toHaveBeenCalled();
    });

    it("does not follow a generated-video symlink outside the generation media root", async () => {
        mocks.registration.mockResolvedValue({ storageKey: "permanent/generated.mp4", scope: "generation", type: "video", ownerUserId: "owner-one", storageProvider: "local", mimeType: "video/mp4", bytes: 10, source: "video-generation" });
        mocks.realpath.mockResolvedValueOnce("/data/generation-assets").mockResolvedValueOnce("/private/outside.mp4");

        const source = await authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: "permanent/generated.mp4" });
        await expect(materializeCanvasVideoSource(source, "/tmp/work")).rejects.toMatchObject({ message: "视频素材文件不存在或已过期", status: 404 } satisfies Partial<CanvasVideoOperationError>);
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it("does not disclose media registered to another user", async () => {
        mocks.registration.mockResolvedValue({ storageKey: "permanent/source.mp4", scope: "reference", type: "video", ownerUserId: "other-user" });

        await expect(authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4" })).rejects.toMatchObject({ message: "视频素材不存在或无权操作", status: 400 } satisfies Partial<CanvasVideoOperationError>);
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it("returns an actionable unavailable error when the configured external storage no longer matches the asset", async () => {
        mocks.registration.mockResolvedValue({ storageKey: "permanent/source.mp4", scope: "generation", type: "video", ownerUserId: "owner-one", storageProvider: "object", externalStorageId: "old-storage", externalObjectKey: "source.mp4" });
        mocks.config.mockResolvedValue({ id: "new-storage" });

        const source = await authorizeCanvasVideoSource({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4" });
        await expect(materializeCanvasVideoSource(source, "/tmp/work")).rejects.toMatchObject({ message: "视频所在外部存储不可用", status: 503 } satisfies Partial<CanvasVideoOperationError>);
        expect(mocks.objectBytes).not.toHaveBeenCalled();
    });
});
