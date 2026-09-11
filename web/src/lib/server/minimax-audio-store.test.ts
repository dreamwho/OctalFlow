import { describe, expect, it } from "vitest";

import { mergeMiniMaxVoiceCatalog, normalizeProviderCreatedTime } from "./minimax-audio-store";

describe("normalizeProviderCreatedTime", () => {
    it("does not turn a missing provider timestamp into the Unix epoch", () => {
        expect(normalizeProviderCreatedTime(0)).toBe("");
        expect(normalizeProviderCreatedTime("0")).toBe("");
        expect(normalizeProviderCreatedTime("1970-01-01T00:00:00.000Z")).toBe("");
    });

    it("preserves a valid provider timestamp", () => {
        expect(normalizeProviderCreatedTime(1710000000)).toBe(new Date(1710000000 * 1000).toISOString());
    });

    it("keeps stored descriptions when the live catalog omits them", () => {
        const result = mergeMiniMaxVoiceCatalog(
            [{ remoteVoiceId: "male-qn-qingse", name: "青涩青年音色", voiceName: "青涩青年音色", description: "", providerCreatedTime: "", category: "其他", voiceType: "system" }],
            [{ id: "internal-id", remoteVoiceId: "male-qn-qingse", name: "青涩青年音色", voiceName: "青涩青年音色", description: "官方青年男声", providerCreatedTime: "", category: "男性", voiceType: "system", provider: "minimax", visible: true, createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" }],
        );
        expect(result).toEqual([{ remoteVoiceId: "male-qn-qingse", name: "青涩青年音色", voiceName: "青涩青年音色", description: "官方青年男声", providerCreatedTime: "", category: "其他", voiceType: "system" }]);
    });
});
