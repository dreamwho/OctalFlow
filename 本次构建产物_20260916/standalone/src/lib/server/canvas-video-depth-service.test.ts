import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class OperationError extends Error {
        constructor(
            message: string,
            readonly status = 400,
        ) {
            super(message);
        }
    }
    return {
        OperationError,
        spawn: vi.fn(),
        mkdir: vi.fn(),
        mkdtemp: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
        stat: vi.fn(),
        runFfmpeg: vi.fn(),
        authorize: vi.fn(),
        materialize: vi.fn(),
        probe: vi.fn(),
        writeAsset: vi.fn(),
    };
});

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, mkdtemp: mocks.mkdtemp, readdir: mocks.readdir, rm: mocks.rm, stat: mocks.stat }));
vi.mock("@/lib/server/ffmpeg", () => ({ runFfmpeg: mocks.runFfmpeg }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writeReferenceMediaFile: mocks.writeAsset }));
vi.mock("@/lib/server/canvas-video-source-service", () => ({
    CanvasVideoOperationError: mocks.OperationError,
    authorizeCanvasVideoSource: mocks.authorize,
    materializeCanvasVideoSource: mocks.materialize,
    probeCanvasVideoSource: mocks.probe,
}));

import { extractCanvasVideoDepth, runCanvasVideoDepthInference } from "./canvas-video-depth-service";

describe("Canvas video depth extraction", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mkdtemp.mockResolvedValue("/tmp/canvas-depth");
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.rm.mockResolvedValue(undefined);
        mocks.readdir.mockImplementation(async (directory: string) => (directory.endsWith("decoded-frames") ? ["frame-00000001.png", "frame-00000002.png", "frame-00000003.png"] : ["frame-00000001.png", "frame-00000002.png", "frame-00000003.png"]));
        mocks.authorize.mockResolvedValue({
            storageKey: "permanent/2026/09/08/videos/source.mp4",
            registration: { scope: "generation", originalName: "source.mp4", conversationId: "conversation-one", runId: "run-one", taskId: "task-one", projectId: "project-one" },
        });
        mocks.materialize.mockResolvedValue("/data/generation-assets/permanent/2026/09/08/videos/source.mp4");
        mocks.probe.mockResolvedValue({ durationMs: 7750, width: 854, height: 480, frameRate: "24/1", audio: { present: true } });
        mocks.runFfmpeg.mockResolvedValue({ stdout: "", stderr: "" });
        mocks.writeAsset.mockResolvedValue({ token: "permanent/2026/09/08/videos/depth.mp4", mimeType: "video/mp4", bytes: 321 });
    });

    it("runs the injected depth runner over every decoded frame and persists an owned H.264 reference video", async () => {
        const runner = vi.fn().mockResolvedValue(undefined);

        const result = await extractCanvasVideoDepth({ ownerUserId: "owner-one", storageKey: "permanent/2026/09/08/videos/source.mp4" }, { runner });

        expect(runner).toHaveBeenCalledWith(
            expect.objectContaining({
                interpreter: expect.stringMatching(/services\/video-depth\/\.venv\/(?:bin\/python|Scripts\/python\.exe)$/),
                scriptPath: expect.stringMatching(/services\/video-depth\/infer_depth_frames\.py$/),
                modelDir: expect.stringMatching(/services\/video-depth\/models\/depth-anything-v2-small-hf$/),
                inputDir: "/tmp/canvas-depth/decoded-frames",
                outputDir: "/tmp/canvas-depth/depth-frames",
            }),
        );
        expect(mocks.runFfmpeg.mock.calls.map(([args]) => args)).toEqual(
            expect.arrayContaining([
                expect.arrayContaining(["-map", "0:v:0", "-fps_mode", "passthrough", "/tmp/canvas-depth/decoded-frames/frame-%08d.png"]),
                expect.arrayContaining(["-framerate", "24/1", "-map", "1:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24/1", "-c:a", "aac"]),
            ]),
        );
        expect(mocks.writeAsset).toHaveBeenCalledWith(
            "/tmp/canvas-depth/depth-video.mp4",
            "video",
            "video/mp4",
            true,
            expect.objectContaining({ ownerUserId: "owner-one", source: "canvas-video-depth", conversationId: "conversation-one", runId: "run-one", taskId: "task-one", projectId: "project-one" }),
        );
        expect(result).toEqual({
            video: {
                storageKey: "permanent/2026/09/08/videos/depth.mp4",
                serverUrl: "/api/reference-assets/permanent/2026/09/08/videos/depth.mp4",
                mimeType: "video/mp4",
                bytes: 321,
                width: 854,
                height: 480,
                durationMs: 7750,
            },
        });
    });

    it("fails before encoding when the runner does not return a depth PNG for every source frame", async () => {
        mocks.readdir.mockImplementation(async (directory: string) => (directory.endsWith("decoded-frames") ? ["frame-00000001.png", "frame-00000002.png"] : ["frame-00000001.png"]));

        await expect(extractCanvasVideoDepth({ ownerUserId: "owner-one", storageKey: "permanent/source.mp4" }, { runner: vi.fn().mockResolvedValue(undefined) })).rejects.toMatchObject({ message: "深度推理没有为全部源视频帧生成深度图", status: 502 });
        expect(mocks.writeAsset).not.toHaveBeenCalled();
    });

    it("uses the fixed shell-free Python command", async () => {
        const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: new PassThrough() });
        mocks.stat
            .mockResolvedValueOnce({ isFile: () => true })
            .mockResolvedValueOnce({ isFile: () => true })
            .mockResolvedValueOnce({ isDirectory: () => true });
        mocks.spawn.mockReturnValue(child);
        const onProgress = vi.fn().mockResolvedValue(undefined);
        const running = runCanvasVideoDepthInference({ interpreter: "/opt/runtime/python", scriptPath: "/app/video-depth/infer_depth_frames.py", modelDir: "/app/models/depth", inputDir: "/tmp/decoded", outputDir: "/tmp/depth", onProgress });
        await vi.waitFor(() =>
            expect(mocks.spawn).toHaveBeenCalledWith(
                "/opt/runtime/python",
                ["/app/video-depth/infer_depth_frames.py", "--input-dir", "/tmp/decoded", "--output-dir", "/tmp/depth", "--model-dir", "/app/models/depth"],
                expect.objectContaining({ shell: false }),
            ),
        );
        child.stdout.write('{"completed":1,');
        child.stdout.end('"total":4}\n{"completed":4,"total":4}\n');
        child.emit("close", 0);
        await expect(running).resolves.toBeUndefined();
        expect(onProgress.mock.calls.map(([value]) => value.percent)).toEqual([25, 100]);
    });

    it("returns an actionable 503 only when the configured depth runtime is absent", async () => {
        mocks.stat.mockRejectedValue(new Error("missing"));

        await expect(runCanvasVideoDepthInference({ interpreter: "python3", scriptPath: "/missing/script.py", modelDir: "/missing/model", inputDir: "/tmp/decoded", outputDir: "/tmp/depth" })).rejects.toMatchObject({
            status: 503,
            message: expect.stringContaining("setup_runtime.sh"),
        });
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
