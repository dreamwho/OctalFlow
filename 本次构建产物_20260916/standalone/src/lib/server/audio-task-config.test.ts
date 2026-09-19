import { describe, expect, it } from "vitest";

import { resolveAudioSampleRate, resolveAudioTaskOptions } from "./audio-task-config";

describe("resolveAudioTaskOptions", () => {
    const defaults = { audioVoice: "nova", audioFormat: "wav" };
    const defaultOptions = {
        voice: "nova",
        audioMode: "tts",
        format: "wav",
        speed: "1",
        volume: "1",
        pitch: "0",
        emotion: "",
        languageBoost: "",
        sampleRate: "32000",
        bitrate: "128000",
        channel: "1",
        lyrics: "",
        isInstrumental: false,
        lyricsOptimizer: true,
    };

    it("uses backend generation defaults when request parameters are missing", () => {
        expect(resolveAudioTaskOptions(undefined, defaults)).toEqual(defaultOptions);
    });

    it("keeps explicit request parameters", () => {
        expect(resolveAudioTaskOptions({ voice: "alloy", format: "mp3", speed: "1.25" }, defaults)).toEqual({ ...defaultOptions, voice: "alloy", format: "mp3", speed: "1.25" });
    });

    it("treats blank request parameters as missing", () => {
        expect(resolveAudioTaskOptions({ voice: " ", format: "", speed: " " }, defaults)).toEqual(defaultOptions);
    });

    it("does not invent a voice for voice creation modes", () => {
        expect(resolveAudioTaskOptions({ audioMode: "voice-clone", voice: " " }, defaults)).toMatchObject({ audioMode: "voice-clone", voice: "" });
        expect(resolveAudioTaskOptions({ audioMode: "voice-design", voice: " " }, defaults)).toMatchObject({ audioMode: "voice-design", voice: "" });
    });

    it("normalizes an invalid Qwen sample rate to the documented default", () => {
        expect(resolveAudioSampleRate("32000", "aliyun-bailian-audio")).toBe("24000");
        expect(resolveAudioSampleRate("44100", "aliyun-bailian-audio")).toBe("44100");
        expect(resolveAudioSampleRate("32000", "minimax-audio")).toBe("32000");
    });
});
