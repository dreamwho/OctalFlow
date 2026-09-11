import { describe, expect, it } from "vitest";

import { qwenVoiceCloneError } from "./qwen-audio-service";

describe("qwenVoiceCloneError", () => {
    it("explains that enrollment audio must be publicly readable", () => {
        expect(qwenVoiceCloneError({ code: "BadRequest.InputDownloadFailed", message: "download audio failed" }, 400)).toContain("公网");
        expect(qwenVoiceCloneError({ code: "BadRequest.InputDownloadFailed", message: "download audio failed" }, 400)).toContain("OSS");
    });

    it("keeps unrelated provider errors intact", () => {
        expect(qwenVoiceCloneError({ code: "InvalidParameter", message: "voice is invalid" }, 400)).toBe("InvalidParameter: voice is invalid");
    });
});
