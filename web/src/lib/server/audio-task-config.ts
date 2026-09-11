export function resolveAudioTaskOptions(
    config: {
        voice?: unknown;
        audioMode?: unknown;
        format?: unknown;
        speed?: unknown;
        volume?: unknown;
        pitch?: unknown;
        emotion?: unknown;
        languageBoost?: unknown;
        sampleRate?: unknown;
        bitrate?: unknown;
        channel?: unknown;
        lyrics?: unknown;
        isInstrumental?: unknown;
        lyricsOptimizer?: unknown;
    } | undefined,
    defaults: { audioVoice: string; audioFormat: string },
) {
    const audioMode = ["tts", "voice-design", "voice-clone", "music"].includes(String(config?.audioMode))
        ? (String(config?.audioMode) as "tts" | "voice-design" | "voice-clone" | "music")
        : "tts";
    return {
        voice: audioMode === "tts" ? clean(config?.voice, 80) || defaults.audioVoice : clean(config?.voice, 80),
        audioMode,
        format: clean(config?.format, 16) || defaults.audioFormat,
        speed: clean(config?.speed, 16) || "1",
        volume: clean(config?.volume, 16) || "1",
        pitch: clean(config?.pitch, 16) || "0",
        emotion: clean(config?.emotion, 32),
        languageBoost: clean(config?.languageBoost, 32),
        sampleRate: clean(config?.sampleRate, 16) || "32000",
        bitrate: clean(config?.bitrate, 16) || "128000",
        channel: clean(config?.channel, 8) || "1",
        lyrics: clean(config?.lyrics, 20_000),
        isInstrumental: config?.isInstrumental === true,
        lyricsOptimizer: config?.lyricsOptimizer !== false,
    };
}

const QWEN_AUDIO_SAMPLE_RATES = new Set(["8000", "16000", "22050", "24000", "44100", "48000"]);

export function resolveAudioSampleRate(value: unknown, protocol?: string) {
    const sampleRate = clean(value, 16);
    if (protocol === "aliyun-bailian-audio") return QWEN_AUDIO_SAMPLE_RATES.has(sampleRate) ? sampleRate : "24000";
    return sampleRate || "32000";
}

function clean(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}
