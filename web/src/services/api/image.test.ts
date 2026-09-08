import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(), syncUserPointsFromHeaders: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({ resolveModelRequestConfig: vi.fn((config: Record<string, unknown>, model: string) => ({ ...config, model })) }));

import { ImageGenerationTaskTerminalError, createImageGenerationTask, getDreaminaStatus, waitForImageGenerationTask } from "./image";
import type { AiConfig } from "@/stores/use-config-store";

describe("图片任务轮询", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("uses the server error message when a restored task has expired", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ error: "图片任务不存在" }, { status: 404 })),
        );

        await expect(waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "expired-task", kind: "generation", model: "image-model" })).rejects.toThrow("图片任务不存在");
    });

    it("sends the stable request identity in both the body and fast lookup headers", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { id: "image-task", kind: "generation", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "生成图片", [], undefined, {
            clientRequestId: "image-workbench:conversation:slot",
            attemptNo: 3,
        });

        const init = fetchMock.mock.calls[0]?.[1];
        expect(init).toBeDefined();
        if (!init) throw new Error("缺少图片任务请求参数");
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body)) as { context?: { clientRequestId?: string; attemptNo?: number } };
        expect(headers.get("x-octalaicanvas-client-request-id")).toBe("image-workbench:conversation:slot");
        expect(headers.get("x-octalaicanvas-attempt-no")).toBe("3");
        expect(body.context).toMatchObject({ clientRequestId: "image-workbench:conversation:slot", attemptNo: 3 });
    });

    it("submits a public prompt separately from the provider execution prompt", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { id: "image-task", kind: "edit", model: "gemini-image" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "gemini-image", imageModel: "gemini-image" } as AiConfig, '{"摄影参数":{"相机":"Hasselblad"}}', [], undefined, {
            logSource: "canvas",
            logTitle: "SU直出摄影级照片",
            publicPrompt: "SU直出摄影级照片",
        });

        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { prompt: string; publicPrompt?: string; title?: string };
        expect(body).toMatchObject({
            prompt: '{"摄影参数":{"相机":"Hasselblad"}}',
            publicPrompt: "SU直出摄影级照片",
            title: "SU直出摄影级照片",
        });
    });

    it("submits Dreamina CLI upscale options without changing the normal image task shape", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { id: "upscale-task", kind: "upscale", model: "dreamina-image-upscale" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask(
            { apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig,
            "",
            [
                {
                    id: "source-node",
                    name: "source.png",
                    type: "image/png",
                    dataUrl: "/api/reference-assets/source.png",
                    serverUrl: "/api/reference-assets/source.png",
                    width: 1024,
                    height: 768,
                },
            ],
            undefined,
            {
                kind: "upscale",
                model: "dreamina-image-upscale",
                channelId: "dreamina-cli",
                upscale: { resolutionType: "4k", sourceNodeId: "source-node" },
            },
        );

        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
            kind: string;
            config: { apiSource?: string; model?: string; channelId?: string };
            prompt: string;
            references: Array<{ id?: string; serverUrl?: string }>;
            upscale?: { resolutionType: string; sourceNodeId?: string };
        };
        expect(body).toMatchObject({
            kind: "upscale",
            config: { apiSource: "system", model: "dreamina-image-upscale", channelId: "dreamina-cli" },
            prompt: "",
            upscale: { resolutionType: "4k", sourceNodeId: "source-node" },
        });
        expect(body.references).toEqual([expect.objectContaining({ id: "source-node", serverUrl: "/api/reference-assets/source.png" })]);
    });

    it("reads the persisted Dreamina CLI status without applying VIP assumptions", async () => {
        const fetchMock = vi.fn(async () => Response.json({ enabled: true, authorized: true, vipLevel: "", checkedAt: "2026-08-31T10:00:00.000Z" }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getDreaminaStatus()).resolves.toEqual({ enabled: true, authorized: true, vipLevel: "", checkedAt: "2026-08-31T10:00:00.000Z" });
        expect(fetchMock).toHaveBeenCalledWith("/api/dreamina/status", { cache: "no-store", signal: undefined });
    });

    it("reuses a permanent server reference without downloading it before task creation", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { id: "image-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "基于参考图生成", [
            {
                id: "reference",
                name: "reference.png",
                type: "image/png",
                dataUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
                serverUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
                storageKey: "permanent/2026/08/04/images/reference.png",
                width: 1024,
                height: 1024,
            },
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/image-tasks");
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { references: Array<{ dataUrl: string; serverUrl?: string }> };
        expect(body.references[0]).toMatchObject({
            dataUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
            serverUrl: "/api/reference-assets/permanent/2026/08/04/images/reference.png",
        });
    });

    it("keeps inline base64 references for providers that require inline images", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { id: "image-task", kind: "edit", model: "image-model" } }));
        vi.stubGlobal("fetch", fetchMock);
        const inlineImage = "data:image/png;base64,AA==";

        await createImageGenerationTask({ apiSource: "system", model: "image-model", imageModel: "image-model" } as AiConfig, "基于参考图生成", [{ id: "inline", name: "inline.png", type: "image/png", dataUrl: inlineImage, width: 1, height: 1 }]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { references: Array<{ dataUrl: string }> };
        expect(body.references[0]?.dataUrl).toBe(inlineImage);
    });

    it("stops polling when the upstream submission needs manual review", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "review-task", kind: "generation", model: "image-model", status: "running", needsReview: true, reviewReason: "渠道未返回可查询任务 ID" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "review-task", kind: "generation", model: "image-model" })).rejects.toThrow("渠道未返回可查询任务 ID");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps polling the same task after a temporary query failure", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ error: "服务暂不可用" }, { status: 503 }))
            .mockResolvedValueOnce(Response.json({ task: { id: "image-task", kind: "generation", model: "image-model", status: "success", result: { dataUrl: "data:image/png;base64,AA==" } } }));
        vi.stubGlobal("fetch", fetchMock);

        const result = waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "image-task", kind: "generation", model: "image-model" });
        await vi.advanceTimersByTimeAsync(1800);

        await expect(result).resolves.toMatchObject({ dataUrl: "data:image/png;base64,AA==" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("marks only an explicit upstream terminal error as retryable", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ task: { id: "failed-task", kind: "generation", model: "image-model", status: "error", error: "上游生成失败", canRetry: true } })),
        );

        const error = await waitForImageGenerationTask({ apiSource: "system" } as AiConfig, { id: "failed-task", kind: "generation", model: "image-model" }).catch((reason) => reason);

        expect(error).toBeInstanceOf(ImageGenerationTaskTerminalError);
        expect(error).toMatchObject({ message: "上游生成失败", canRetry: true });
    });
});
