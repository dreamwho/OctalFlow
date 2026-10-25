import { describe, expect, it } from "vitest";

import type { StoredGenerationLog } from "@/lib/server/generation-log-types";
import { restoreWorkbenchDraft } from "./image-video-workbench-draft";

describe("restoreWorkbenchDraft", () => {
    it.each(["success", "failed", "pending"] as const)("restores the public request and settings for %s results", (status) => {
        const log = {
            id: "video-workbench:record-one",
            userId: "user-one",
            kind: "video",
            source: "video-workbench",
            status: "pending",
            title: "原始描述",
            prompt: "内部改写后的执行提示词",
            model: "video-model",
            assets: [],
            createdAt: "2026-10-21T00:00:00.000Z",
            durationMs: 0,
            requestSnapshot: {
                version: 1,
                userPrompt: "原始描述",
                parameters: { size: "16:9", quality: "high", seconds: "8", count: "2", generateAudio: "off", watermark: "on", runningHubAppId: "rh-original" },
                interiorDesign: { appId: "rh-original", appName: "Interior", settings: { roomType: "bedroom", style: "minimal" } },
                references: [
                    { id: "first", kind: "image", role: "first_frame", name: "first.png", mimeType: "image/png", url: "/first.png" },
                    { id: "last", kind: "image", role: "last_frame", name: "last.png", mimeType: "image/png", url: "/last.png" },
                ],
                slots: [],
            },
        } as unknown as StoredGenerationLog;
        const draft = restoreWorkbenchDraft(log, { id: "slot-one", index: 0, status, prompt: "内部单槽执行提示词", taskModel: "actual-video-model", parameters: { size: "1:1" }, referenceIds: ["last"] });
        expect(draft).toMatchObject({ prompt: "原始描述", model: "actual-video-model", kind: "video", size: "1:1", quality: "high", seconds: "8", count: "2", generateAudio: "off", watermark: "on", runningHubAppId: "rh-original", interiorDesign: { appId: "rh-original", settings: { roomType: "bedroom", style: "minimal" } } });
        expect(draft.references.map((reference) => reference.role)).toEqual(["last_frame"]);
        expect(draft.prompt).not.toContain("内部改写");
    });
});
