import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    appendRunningHubRequestLog: vi.fn(async (input: Record<string, unknown>) => input),
    getRunningHubApp: vi.fn(),
    getRunningHubPrivateSettings: vi.fn(),
    getRunningHubTask: vi.fn(),
    saveRunningHubTask: vi.fn(async (task: unknown) => task),
    upsertRunningHubApp: vi.fn(),
    fetchSafeOutbound: vi.fn(),
    currentTrafficContext: vi.fn(),
}));

vi.mock("./runninghub-store", () => ({
    appendRunningHubRequestLog: mocks.appendRunningHubRequestLog,
    getRunningHubApp: mocks.getRunningHubApp,
    getRunningHubPrivateSettings: mocks.getRunningHubPrivateSettings,
    getRunningHubTask: mocks.getRunningHubTask,
    saveRunningHubTask: mocks.saveRunningHubTask,
    upsertRunningHubApp: mocks.upsertRunningHubApp,
}));
vi.mock("./safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafeOutbound }));
vi.mock("./traffic-context", () => ({ currentTrafficContext: mocks.currentTrafficContext }));

import { extractRunningHubResultUrls, submitRunningHubImageTask } from "./runninghub-service";

function response(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("RunningHub traffic request correlation", () => {
    it("binds each upload and submit relay request to its persisted log ID", async () => {
        mocks.getRunningHubPrivateSettings.mockResolvedValue({ enabled: true, apiBaseUrl: "https://runninghub.example", apiKey: "fixture-key", instanceType: "standard" });
        mocks.getRunningHubApp.mockResolvedValue({
            id: "app-1",
            remoteId: "remote-app-1",
            kind: "ai-app",
            name: "Fixture app",
            description: "",
            thumbnailUrl: "",
            enabled: true,
            featureBindings: ["interior-design"],
            fields: [
                { nodeId: "image", fieldName: "image", label: "参考图", type: "image", defaultValue: "", options: [] },
                { nodeId: "prompt", fieldName: "prompt", label: "提示词", type: "text", defaultValue: "", options: [] },
            ],
            sortOrder: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        mocks.currentTrafficContext.mockReturnValue({ channelId: "generation-channel", channelName: "Generation", model: "fixture-model", protocol: "runninghub", connectionMode: "generic", taskId: "generation-task-1", attemptId: "attempt-1" });
        mocks.fetchSafeOutbound
            .mockResolvedValueOnce(response({ code: 0, data: { fileName: "input/reference.png" } }))
            .mockResolvedValueOnce(response({ code: 0, data: { taskId: "remote-task-1" } }));

        const task = await submitRunningHubImageTask({
            imageTaskId: "image-task-1",
            userId: "user-1",
            appId: "app-1",
            prompt: "fixture prompt",
            files: [new File(["fixture"], "reference.png", { type: "image/png" })],
        });

        expect(task.remoteTaskId).toBe("remote-task-1");
        expect(mocks.appendRunningHubRequestLog).toHaveBeenCalledTimes(2);
        const logs = mocks.appendRunningHubRequestLog.mock.calls.map(([log]) => log as Record<string, unknown>);
        const traffic = mocks.fetchSafeOutbound.mock.calls.map(([, , options]) => (options as { trafficContext: Record<string, string> }).trafficContext);
        expect(traffic).toHaveLength(2);
        expect(traffic.map((context) => context.requestId)).toEqual(logs.map((log) => log.id));
        expect(traffic.every((context) => context.taskId === "generation-task-1" && context.attemptId === "attempt-1")).toBe(true);
    });
});

describe("RunningHub result contract", () => {
    it("collects and de-duplicates image URLs across supported response shapes", () => {
        expect(
            extractRunningHubResultUrls({
                output: "https://cdn.example.com/result-a.png",
                outputs: [{ fileUrl: "https://cdn.example.com/result-b.webp" }],
                images: ["https://cdn.example.com/result-a.png"],
                ignored: "not-a-url",
            }),
        ).toEqual(["https://cdn.example.com/result-a.png", "https://cdn.example.com/result-b.webp"]);
    });

    it("ignores non-http values", () => {
        expect(extractRunningHubResultUrls({ fileName: "input/reference.png", output: "data:image/png;base64,abc" })).toEqual([]);
    });
});
