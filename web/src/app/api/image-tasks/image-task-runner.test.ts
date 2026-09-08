import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/lib/server/generation-log-task-service", () => ({ recordGenerationTaskLogResult: mocks.record }));
vi.mock("@/lib/server/generation-channel", () => ({ generationModelId: vi.fn(() => "gemini-image") }));
vi.mock("./image-task-size", () => ({ resolveResultSize: vi.fn(() => undefined) }));

import { writeImageGenerationLog } from "./image-task-runner";
import type { ImageTask } from "@/lib/server/image-task-store";

describe("image task public generation log", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.record.mockResolvedValue({});
    });

    it("records the public prompt while retaining the execution prompt on the task", async () => {
        const task = {
            id: "interior-task",
            userId: "user-one",
            username: "user",
            displayName: "User",
            kind: "edit",
            source: "canvas",
            title: "",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
            config: { baseUrl: "/api/ai/system/geminiai", apiKey: "system", apiFormat: "gemini", model: "gemini-image" },
            prompt: '{"摄影参数":{"相机":"Hasselblad X2D 100C"}}',
            publicPrompt: "SU直出摄影级照片",
            references: [],
        } satisfies ImageTask;

        await writeImageGenerationLog(task, "success", "/api/generation-log-assets/interior.png", 1000);

        expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ title: "SU直出摄影级照片", prompt: "SU直出摄影级照片" }));
        expect(task.prompt).toContain("摄影参数");
    });
});
