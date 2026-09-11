import { describe, expect, it } from "vitest";

import { qwenVoiceCloneError, qwenVoiceOperation } from "./qwen-audio-service";

describe("qwenVoiceOperation", () => {
    it("lets cosyvoice-v3.5-plus run both voice cloning and voice design", () => {
        expect(qwenVoiceOperation("cosyvoice-v3.5-plus", "clone")).toBe("enrollment");
        expect(qwenVoiceOperation("cosyvoice-v3.5-plus", "design")).toBe("enrollment");
    });

    it("keeps single-capability models restricted to their documented operation", () => {
        expect(qwenVoiceOperation("cosyvoice-v3-plus", "clone")).toBe("enrollment");
        expect(() => qwenVoiceOperation("cosyvoice-v3-plus", "design")).toThrow("该模型不支持音色设计");
        expect(() => qwenVoiceOperation("qwen3-tts-vd-2026-01-26", "clone")).toThrow("该模型不支持音色复刻");
    });
});

describe("qwenVoiceCloneError", () => {
    it("explains that enrollment audio must be publicly readable", () => {
        expect(qwenVoiceCloneError({ code: "BadRequest.InputDownloadFailed", message: "download audio failed" }, 400)).toContain("公网");
        expect(qwenVoiceCloneError({ code: "BadRequest.InputDownloadFailed", message: "download audio failed" }, 400)).toContain("OSS");
    });

    it("keeps unrelated provider errors intact", () => {
        expect(qwenVoiceCloneError({ code: "InvalidParameter", message: "voice is invalid" }, 400)).toBe("InvalidParameter: voice is invalid");
    });
});
