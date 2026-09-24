import { afterEach, expect, it, vi } from "vitest";

import { getGeminiAiLogImageResults, type GeminiAiRequestLog } from "./geminiai";

afterEach(() => vi.unstubAllGlobals());

const completedImageLog: GeminiAiRequestLog = {
    id: "log-1", createdAt: "2026-09-24T00:00:00.000Z", source: "runtime", capability: "image",
    method: "POST", path: "/v1/images/generations", model: "gemini-3-pro-image",
    statusCode: 200, durationMs: 1000, headers: { "idempotency-key": "image-task:task-123:attempt:1" },
};

it("resolves every stored image from a successful GeminiAI task request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task: { status: "success", result: {
        serverUrl: "/api/generation-log-assets/first.png",
        results: [
            { serverUrl: "/api/generation-log-assets/first.png" },
            { serverUrl: "/api/generation-log-assets/second.png" },
        ],
    } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGeminiAiLogImageResults(completedImageLog)).resolves.toEqual([
        "/api/generation-log-assets/first.png",
        "/api/generation-log-assets/second.png",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/image-tasks/task-123", { cache: "no-store" });
});

it("does not preview a request unless its image task has completed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ task: { status: "running" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGeminiAiLogImageResults(completedImageLog)).resolves.toEqual([]);
    await expect(getGeminiAiLogImageResults({ ...completedImageLog, statusCode: 500 })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
