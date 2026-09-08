import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    assertRegularFile: vi.fn(),
    download: vi.fn(),
    query: vi.fn(),
    submit: vi.fn(),
    withTemp: vi.fn(),
    workerHeaders: vi.fn(),
    write: vi.fn(),
}));

vi.mock("@/lib/server/media-download", () => ({ downloadMediaToFile: mocks.download }));
vi.mock("@/lib/server/maintenance-auth", () => ({ maintenanceWorkerContextHeaders: mocks.workerHeaders }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writeReferenceMediaFile: mocks.write }));
vi.mock("@/lib/server/dreamina-cli-service", () => ({
    isDreaminaCliConfig: vi.fn(() => true),
    submitDreaminaCliTaskWithCreditObservation: mocks.submit,
}));
vi.mock("@/lib/server/dreamina-cli-provider", () => ({
    DreaminaCliProviderError: class DreaminaCliProviderError extends Error {
        constructor(
            message: string,
            readonly status = 502,
            readonly submissionState: "not_started" | "safe_failure" | "unknown" = "safe_failure",
        ) {
            super(message);
        }
    },
    assertDreaminaCliRegularFile: mocks.assertRegularFile,
    queryDreaminaCliTask: mocks.query,
    withDreaminaCliTempDirectory: mocks.withTemp,
}));

import { DreaminaCliProviderError } from "@/lib/server/dreamina-cli-provider";
import { dreaminaCliVideoCommand, createDreaminaCliVideoUpstream, isDreaminaCliPersistedResultUrl, queryDreaminaCliVideoTask } from "./dreamina-cli-video-task";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";
import type { VideoTask } from "./video-task-store";

describe("Dreamina CLI video task adapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerHeaders.mockReturnValue(null);
    });

    it.each([
        ["text2video", []],
        ["image2video", [{ type: "image", url: "https://cdn.test/one.png" }]],
        [
            "frames2video",
            [
                { type: "image", url: "https://cdn.test/first.png", role: "first_frame" },
                { type: "image", url: "https://cdn.test/last.png", role: "last_frame" },
            ],
        ],
        [
            "multiframe2video",
            [
                { type: "image", url: "https://cdn.test/one.png" },
                { type: "image", url: "https://cdn.test/two.png" },
            ],
        ],
        [
            "multimodal2video",
            [
                { type: "image", url: "https://cdn.test/one.png" },
                { type: "video", url: "https://cdn.test/ref.mp4" },
            ],
        ],
    ] satisfies Array<[string, VideoGenerationReference[]]>)("selects %s from the reference roles", (command, references) => {
        expect(dreaminaCliVideoCommand(references)).toBe(command);
    });

    it("uses ratio-aware multimodal generation for one reference when the selected model supports it", () => {
        expect(dreaminaCliVideoCommand([image("one")], { explicitRatio: true, supportsMultimodal: true })).toBe("multimodal2video");
        expect(dreaminaCliVideoCommand([image("one")], { explicitRatio: true, supportsMultimodal: false })).toBe("image2video");
    });

    it("keeps an explicit ratio in the single-reference Seedance submission", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));
        mocks.download.mockResolvedValue({ bytes: 12, mimeType: "image/png" });
        mocks.submit.mockResolvedValue({ submitId: "submit-ratio" });

        const upstream = await createDreaminaCliVideoUpstream({
            userId: "user-one",
            origin: "https://octalflow.test",
            channel: channel("dreamina-seedance-2-0-mini"),
            prompt: "竖版人物短片",
            raw: { size: "9:16", vquality: "720", videoSeconds: 5 },
            references: [image("one")],
        });

        expect(upstream.command).toBe("multimodal2video");
        expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ command: "multimodal2video", ratio: "9:16", images: ["/controlled/task/000-image.png"] }), expect.any(Object));
    });

    it("keeps a model-supported storyboard image batch in one multimodal Seedance submission", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));
        mocks.download.mockResolvedValue({ bytes: 12, mimeType: "image/png" });
        mocks.submit.mockResolvedValue({ submitId: "submit-video" });

        const upstream = await createDreaminaCliVideoUpstream({
            userId: "user-one",
            origin: "https://octalflow.test",
            channel: channel("dreamina-seedance-2-0"),
            prompt: "让镜头自然衔接",
            raw: { size: "16:9", vquality: "720", videoSeconds: 5 },
            references: [image("one"), image("two"), image("three")],
            taskId: "video-task",
            attemptNo: 2,
        });

        expect(upstream).toMatchObject({ id: "submit-video", provider: "dreamina-cli", command: "multimodal2video", model: "dreamina-seedance-2-0" });
        const [submission, context] = mocks.submit.mock.calls[0] as [{ command: string; modelId: string; images: string[]; duration: number }, { taskId: string; attemptNo: number; modelId: string }];
        expect(submission).toMatchObject({
            command: "multimodal2video",
            modelId: "dreamina-seedance-2-0",
            images: ["/controlled/task/000-image.png", "/controlled/task/001-image.png", "/controlled/task/002-image.png"],
            duration: 5,
        });
        expect(context).toMatchObject({ taskId: "video-task", attemptNo: 2, modelId: "dreamina-seedance-2-0" });
    });

    it("applies the resolved Seedance Mini contract before CLI submission", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));
        mocks.submit.mockResolvedValue({ submitId: "submit-mini" });

        await createDreaminaCliVideoUpstream({
            userId: "user-one",
            origin: "https://octalflow.test",
            channel: channel("dreamina-seedance-2-0-mini"),
            prompt: "城市夜景",
            raw: { size: "16:9", vquality: "1080", videoSeconds: 60 },
            references: [],
            taskId: "video-mini",
            attemptNo: 1,
        });

        expect(mocks.submit).toHaveBeenCalledWith(
            expect.objectContaining({ modelId: "dreamina-seedance-2-0-mini", videoResolution: "720p", duration: 15 }),
            expect.objectContaining({ taskId: "video-mini", attemptNo: 1, modelId: "dreamina-seedance-2-0-mini" }),
        );
    });

    it("rejects local paths before invoking the CLI", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));

        await expect(
            createDreaminaCliVideoUpstream({
                userId: "user-one",
                origin: "https://octalflow.test",
                channel: channel("dreamina-seedance-2-0"),
                prompt: "测试",
                raw: { size: "16:9", vquality: "720", videoSeconds: 5 },
                references: [{ type: "image", url: "/Users/dream/reference.png", role: "reference" }],
            }),
        ).rejects.toThrow("不接受客户端本地路径");
        expect(mocks.submit).not.toHaveBeenCalled();
    });

    it("stages an authenticated generation result instead of treating it as a client path", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));
        mocks.download.mockResolvedValue({ bytes: 12, mimeType: "image/png" });
        mocks.submit.mockResolvedValue({ submitId: "submit-video" });

        await createDreaminaCliVideoUpstream({
            userId: "user-one",
            origin: "https://octalflow.test",
            channel: channel("dreamina-seedance-2-0"),
            prompt: "让镜头自然衔接",
            raw: { size: "16:9", vquality: "720", videoSeconds: 5 },
            references: [{ type: "image", url: "/api/generation-log-assets/permanent/2026/09/02/images/source.png", role: "reference" }],
        });

        expect(mocks.download).toHaveBeenCalledWith("/api/generation-log-assets/permanent/2026/09/02/images/source.png", "/controlled/task/000-image.png", expect.objectContaining({ origin: "https://octalflow.test" }));
        expect(mocks.submit).toHaveBeenCalledOnce();
    });

    it("uses the signed Worker context only to read an owned generation result during staging", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/task"));
        mocks.workerHeaders.mockReturnValue({ authorization: "Bearer worker-token", "x-octalaicanvas-worker-user-id": "user-one" });
        mocks.download.mockResolvedValue({ bytes: 12, mimeType: "image/png" });
        mocks.submit.mockResolvedValue({ submitId: "submit-video" });

        await createDreaminaCliVideoUpstream({
            userId: "user-one",
            origin: "https://octalflow.test",
            cookie: "octalaicanvas-worker-v1.owned.signature",
            channel: channel("dreamina-seedance-2-0"),
            prompt: "保持人物一致",
            raw: { size: "9:16", vquality: "720", videoSeconds: 5 },
            references: [{ type: "image", url: "/api/generation-log-assets/permanent/2026/09/02/images/source.png", role: "reference" }],
        });

        expect(mocks.download).toHaveBeenCalledWith(
            "/api/generation-log-assets/permanent/2026/09/02/images/source.png",
            "/controlled/task/000-image.png",
            expect.objectContaining({ internalHeaders: { authorization: "Bearer worker-token", "x-octalaicanvas-worker-user-id": "user-one" } }),
        );
    });

    it("queries only query_result and persists a controlled video output", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/query"));
        mocks.query.mockResolvedValue({ state: "succeeded", status: "completed", files: ["/controlled/query/result.mp4"] });
        mocks.assertRegularFile.mockResolvedValue("/controlled/query/result.mp4");
        mocks.write.mockResolvedValue({ token: "permanent/2026/08/31/videos/result.mp4", bytes: 10, mimeType: "video/mp4", storage: "local" });

        const result = await queryDreaminaCliVideoTask(videoTask("submit-video"), { timeoutMs: 15_000 });

        expect(result).toEqual({ state: "result_ready", status: "completed", resultUrl: "/api/reference-assets/permanent/2026/08/31/videos/result.mp4" });
        expect(mocks.query).toHaveBeenCalledWith({ submitId: "submit-video", downloadDir: "/controlled/query" }, { timeoutMs: 15_000 });
        expect(mocks.write).toHaveBeenCalledWith("/controlled/query/result.mp4", "video", "video/mp4", true, expect.objectContaining({ ownerUserId: "user-one", taskId: "local-video" }));
    });

    it("marks persistence failure for review instead of claiming a retryable failure", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/query"));
        mocks.query.mockResolvedValue({ state: "succeeded", status: "completed", files: [] });

        await expect(queryDreaminaCliVideoTask(videoTask("submit-video"))).resolves.toEqual({
            state: "needs_review",
            status: "result_persistence_failed",
            error: "即梦 CLI 已结束，但未返回可安全持久化的视频文件",
        });
        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.submit).not.toHaveBeenCalled();
    });

    it("defers a read-only CLI query execution failure so the worker can poll again", async () => {
        mocks.withTemp.mockImplementation(async (callback: (directory: string) => Promise<unknown>) => callback("/controlled/query"));
        mocks.query.mockRejectedValue(new DreaminaCliProviderError("即梦 CLI 执行失败", 502, "unknown"));

        await expect(queryDreaminaCliVideoTask(videoTask("submit-video"))).rejects.toMatchObject({ submissionState: "unknown" });
        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.submit).not.toHaveBeenCalled();
    });

    it("recognizes only permanent video reference URLs as already persisted", () => {
        expect(isDreaminaCliPersistedResultUrl("/api/reference-assets/permanent/2026/08/31/videos/result.mp4")).toBe(true);
        expect(isDreaminaCliPersistedResultUrl("/api/reference-assets/temporary/2026/08/31/videos/result.mp4")).toBe(false);
    });
});

function channel(model: string): VideoTask["config"] {
    return {
        apiSource: "system",
        baseUrl: "/api/ai/system/dreamina-cli",
        apiKey: "system",
        apiFormat: "openai",
        model,
        channelId: "dreamina-cli",
        advancedConfig: { protocol: "dreamina-cli" } as NonNullable<VideoTask["config"]["advancedConfig"]>,
    };
}

function image(name: string): VideoGenerationReference {
    return { type: "image", url: `https://cdn.test/${name}.png`, role: "reference" };
}

function videoTask(id: string): VideoTask {
    return {
        id: "local-video",
        userId: "user-one",
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        config: channel("dreamina-seedance-2-0"),
        upstream: { id, provider: "dreamina-cli", model: "dreamina-seedance-2-0", command: "text2video", pollPath: "query_result", queryPath: "query_result" },
    };
}
