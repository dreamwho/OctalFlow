import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@/lib/auth/store";

const mocks = vi.hoisted(() => ({
    getAuthSettings: vi.fn(),
    startAttempt: vi.fn(),
    toChannel: vi.fn(),
    resolveBinding: vi.fn(),
    createUpstream: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    transitionTask: vi.fn(),
    queryUpstream: vi.fn(),
    persistResult: vi.fn(),
    failTask: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/generation-attempt", () => ({ startGenerationAttempt: mocks.startAttempt }));
vi.mock("@/lib/server/generation-channel", () => ({ toSystemGenerationChannel: mocks.toChannel }));
vi.mock("@/lib/server/geminiai-service", () => ({ resolveSavedGeminiVideoBinding: mocks.resolveBinding }));
vi.mock("@/app/api/video-generation-tasks/video-generation-route", () => ({ createUpstream: mocks.createUpstream }));
vi.mock("@/lib/server/gemini-video-provider", () => ({ geminiVideoCreatePath: () => "/v1beta/models/veo:predictLongRunning" }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: (origin: string) => origin }));
vi.mock("@/lib/server/generation-errors", () => ({ toSafeGenerationErrorMessage: () => "已脱敏失败" }));
vi.mock("@/lib/server/video-task-runtime", () => ({ failVideoTaskFromWorker: mocks.failTask, persistVideoTaskResult: mocks.persistResult, queryVideoTaskUpstream: mocks.queryUpstream }));
vi.mock("@/lib/server/video-task-store", () => ({
    createVideoTask: mocks.createTask,
    getVideoTask: mocks.getTask,
    transitionVideoTask: mocks.transitionTask,
    updateVideoTask: mocks.updateTask,
}));

import { createGeminiAiVideoTest, refreshGeminiAiVideoTest } from "./geminiai-test-service";

const user: PublicUser = {
    id: "admin-one",
    accountId: "0001",
    username: "admin",
    displayName: "管理员",
    bio: "",
    role: "admin",
    adminPermissions: ["upstream.manage"],
    status: "active",
    planId: "",
    planName: "",
    hasActivePlan: true,
    pointsBalance: 0,
    permanentPointsBalance: 0,
    dailyPointsBalance: 0,
    dailyPointsExpiresAt: "",
    mfaEnabled: false,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
};
const channel = { channelId: "saved-gemini", model: "veo-3.1", advancedConfig: { protocol: "gemini" } };
const task = {
    id: "task-one",
    userId: "admin-one",
    source: "geminiai-admin-test",
    status: "running",
    createdAt: Date.now() - 10,
    config: channel,
    upstream: { id: "" },
    attempts: [],
};

describe("GeminiAI delegated video test service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthSettings.mockResolvedValue({ generationDefaults: { videoQuality: "standard", videoSeconds: 8 }, generationPointMultipliers: {} });
        mocks.resolveBinding.mockReturnValue({ logicalModelId: "veo", upstreamModel: "veo-3.1", channelId: "saved-gemini", channel: { id: "saved-gemini" } });
        mocks.toChannel.mockReturnValue(channel);
        mocks.startAttempt.mockReturnValue({ attempts: [] });
        mocks.createTask.mockResolvedValue(task);
        mocks.createUpstream.mockResolvedValue({ id: "upstream-one" });
        mocks.updateTask.mockResolvedValue(task);
    });

    it("refuses a video model unless the exact saved Gemini channel owns that model", async () => {
        mocks.resolveBinding.mockReturnValue(null);

        await expect(createGeminiAiVideoTest(new Request("http://localhost/api/admin/geminiai/test"), user, { model: "veo-3.1", prompt: "一只猫", channelId: "other-channel" })).rejects.toMatchObject({ status: 422 });
        expect(mocks.createTask).not.toHaveBeenCalled();
        expect(mocks.createUpstream).not.toHaveBeenCalled();
    });

    it("returns a same-origin manual status URL after creating through an allowed saved Gemini/Veo binding", async () => {
        const result = await createGeminiAiVideoTest(new Request("http://localhost/api/admin/geminiai/test", { headers: { cookie: "session=internal" } }), user, { model: "veo-3.1", prompt: "一只猫", channelId: "saved-gemini" });

        expect(mocks.resolveBinding).toHaveBeenCalledWith(expect.anything(), "veo-3.1", "saved-gemini");
        expect(mocks.createUpstream).toHaveBeenCalledWith("admin-one", "http://localhost", "session=internal", channel, "一只猫", expect.any(Object), [], {}, "geminiai-admin-test:task-one");
        expect(result).toMatchObject({ status: "running", taskId: "task-one", channelId: "saved-gemini", statusUrl: "/api/admin/geminiai/test?taskId=task-one&channelId=saved-gemini" });
    });

    it("does not query a task when its requested channel differs from the persisted Gemini channel", async () => {
        mocks.getTask.mockResolvedValue(task);

        await expect(refreshGeminiAiVideoTest(new Request("http://localhost/api/admin/geminiai/test"), user, "task-one", "other-channel")).rejects.toMatchObject({ status: 403 });
        expect(mocks.queryUpstream).not.toHaveBeenCalled();
    });
});
