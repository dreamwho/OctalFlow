import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    auditAction: vi.fn(),
    auditFailure: vi.fn(),
    routeError: vi.fn((error: Error) => new Response(JSON.stringify({ code: 500, data: null, msg: error.message }), { status: 500, headers: { "content-type": "application/json" } })),
    text: vi.fn(),
    search: vi.fn(),
    image: vi.fn(),
    createVideo: vi.fn(),
    refreshVideo: vi.fn(),
}));

vi.mock("@/lib/server/geminiai-admin", () => ({
    requireGeminiAiAdmin: mocks.requireAdmin,
    auditGeminiAiAdminAction: mocks.auditAction,
    auditGeminiAiAdminFailure: mocks.auditFailure,
    geminiAiRouteError: mocks.routeError,
}));
vi.mock("@/lib/server/geminiai-service", () => ({
    runGeminiAiTextTest: mocks.text,
    runGeminiAiSearchTest: mocks.search,
    runGeminiAiImageTest: mocks.image,
}));
vi.mock("@/lib/server/geminiai-test-service", () => ({ createGeminiAiVideoTest: mocks.createVideo, refreshGeminiAiVideoTest: mocks.refreshVideo }));

import { GET, POST } from "./route";

function request(body: unknown) {
    return new Request("http://localhost/api/admin/geminiai/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("GeminiAI model test route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.text.mockResolvedValue({ model: "gemini-2.5-pro", text: "文本结果" });
        mocks.search.mockResolvedValue({ model: "gemini-2.5-pro", text: "搜索结果", citations: [{ url: "https://example.com" }] });
        mocks.image.mockResolvedValue({ model: "gemini-2.5-flash-image", images: ["/media/local-image.webp"] });
        mocks.createVideo.mockResolvedValue({ status: "running", model: "veo-3.1", taskId: "task-one", channelId: "saved-gemini", statusUrl: "/api/admin/geminiai/test?taskId=task-one&channelId=saved-gemini", elapsedMs: 1 });
        mocks.refreshVideo.mockResolvedValue({
            status: "succeeded",
            model: "veo-3.1",
            taskId: "task-one",
            channelId: "saved-gemini",
            statusUrl: "/api/admin/geminiai/test?taskId=task-one&channelId=saved-gemini",
            elapsedMs: 12,
            videoUrl: "/media/local-video.mp4",
        });
    });

    it("uses the native Search runner for an explicit text Google Search request", async () => {
        const response = (await POST(request({ capability: "text", model: "gemini-2.5-pro", prompt: "查今天新闻", options: { googleSearch: true } })))!;

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { status: "succeeded", model: "gemini-2.5-pro", text: "搜索结果", citations: [{ url: "https://example.com" }] } });
        expect(mocks.search).toHaveBeenCalledWith({ model: "gemini-2.5-pro", prompt: "查今天新闻" });
        expect(mocks.text).not.toHaveBeenCalled();
    });

    it("returns only persisted image paths from the image test contract", async () => {
        const response = (await POST(request({ capability: "image", model: "gemini-2.5-flash-image", prompt: "测试图", options: { aspectRatio: "9:16", imageSize: "4K" } })))!;

        expect(await response.json()).toMatchObject({ code: 0, data: { status: "succeeded", images: ["/media/local-image.webp"] } });
        expect(mocks.image).toHaveBeenCalledWith({ userId: "admin-one", model: "gemini-2.5-flash-image", prompt: "测试图", aspectRatio: "9:16", imageSize: "4K" });
    });

    it("delegates video only through a supplied saved Gemini/Veo channel and returns manual status data", async () => {
        const response = (await POST(request({ capability: "video", model: "veo-3.1", prompt: "一只猫", options: { channelId: "saved-gemini" } })))!;

        expect(await response.json()).toMatchObject({ code: 0, data: { status: "running", taskId: "task-one", channelId: "saved-gemini", statusUrl: expect.stringContaining("taskId=task-one") } });
        expect(mocks.createVideo).toHaveBeenCalledWith(expect.any(Request), user, expect.objectContaining({ channelId: "saved-gemini", model: "veo-3.1" }));
    });

    it("refreshes video only when the UI supplies both task and saved channel identifiers", async () => {
        const response = (await GET(new Request("http://localhost/api/admin/geminiai/test?taskId=task-one&channelId=saved-gemini")))!;

        expect(await response.json()).toMatchObject({ code: 0, data: { status: "succeeded", videoUrl: "/media/local-video.mp4", channelId: "saved-gemini" } });
        expect(mocks.refreshVideo).toHaveBeenCalledWith(expect.any(Request), user, "task-one", "saved-gemini");
    });

    it("keeps upstream test failures inside the normal envelope for the UI", async () => {
        const { GeminiAiProviderError } = await import("@/lib/server/geminiai-provider");
        mocks.image.mockRejectedValue(new GeminiAiProviderError("GeminiAI 服务暂时不可用", 502));

        const response = (await POST(request({ capability: "image", model: "gemini-2.5-flash-image", prompt: "测试图" })))!;

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { status: "failed", model: "gemini-2.5-flash-image", error: "GeminiAI 服务暂时不可用" } });
    });
});
