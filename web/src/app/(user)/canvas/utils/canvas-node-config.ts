import { MINIMAX_MUSIC_MODELS, MINIMAX_SPEECH_MODELS, TOKENHUB_MUSIC_MODELS } from "@/lib/minimax-audio";
import { audioVoiceOptions } from "@/lib/audio-generation";
import { QWEN_AUDIO_MODELS, QWEN_AUDIO_TTS_MODELS, QWEN_AUDIO_VOICE_CLONE_MODELS, QWEN_AUDIO_VOICE_DESIGN_MODELS, isQwenAudioModel, qwenDefaultAudioVoice } from "@/lib/qwen-audio";
import { defaultConfig, modelOptionName, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { CanvasAudioSettingKey } from "../components/canvas-audio-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData } from "../types";

export function buildCanvasNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode, model: string): AiConfig {
    const audioMode = node.metadata?.audioMode || globalConfig.audioMode || defaultConfig.audioMode;
    const upstreamModel = modelOptionName(resolveModelRequestConfig(globalConfig, model).model).trim();
    const hasNodeAudioVoice = Boolean(node.metadata && Object.prototype.hasOwnProperty.call(node.metadata, "audioVoice"));
    const configuredAudioVoice = hasNodeAudioVoice ? node.metadata?.audioVoice || "" : globalConfig.audioVoice || defaultConfig.audioVoice;
    const isMiniMaxAudioModel = MINIMAX_SPEECH_MODELS.includes(upstreamModel as (typeof MINIMAX_SPEECH_MODELS)[number]) || MINIMAX_MUSIC_MODELS.includes(upstreamModel as (typeof MINIMAX_MUSIC_MODELS)[number]);
    return {
        ...globalConfig,
        model,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioMode,
        audioVoice: isQwenAudioModel(upstreamModel) && audioVoiceOptions.some((option) => option.value === configuredAudioVoice) ? qwenDefaultAudioVoice(upstreamModel) : isMiniMaxAudioModel && audioVoiceOptions.some((option) => option.value === configuredAudioVoice) ? "" : configuredAudioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioVolume: node.metadata?.audioVolume || globalConfig.audioVolume || defaultConfig.audioVolume,
        audioPitch: node.metadata?.audioPitch || globalConfig.audioPitch || defaultConfig.audioPitch,
        audioEmotion: node.metadata?.audioEmotion || globalConfig.audioEmotion || defaultConfig.audioEmotion,
        audioLanguageBoost: node.metadata?.audioLanguageBoost || globalConfig.audioLanguageBoost || defaultConfig.audioLanguageBoost,
        audioSampleRate: node.metadata?.audioSampleRate || globalConfig.audioSampleRate || defaultConfig.audioSampleRate,
        audioBitrate: node.metadata?.audioBitrate || globalConfig.audioBitrate || defaultConfig.audioBitrate,
        audioChannel: node.metadata?.audioChannel || globalConfig.audioChannel || defaultConfig.audioChannel,
        audioLyrics: node.metadata?.audioLyrics || globalConfig.audioLyrics || defaultConfig.audioLyrics,
        audioIsInstrumental: node.metadata?.audioIsInstrumental ?? globalConfig.audioIsInstrumental ?? defaultConfig.audioIsInstrumental,
        audioLyricsOptimizer: node.metadata?.audioLyricsOptimizer ?? globalConfig.audioLyricsOptimizer ?? defaultConfig.audioLyricsOptimizer,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

export function resolveCanvasGenerationModel(config: AiConfig, mode: CanvasGenerationMode, currentModel = "") {
    const models = selectableModelsByCapability(config, mode);
    const current = findModelOption(models, currentModel);
    if (current) return current;
    const preferred = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : mode === "audio" ? config.audioModel : config.textModel;
    return findModelOption(models, preferred) || models[0] || "";
}

export function selectableCanvasAudioModels(config: AiConfig, audioMode: AiConfig["audioMode"]) {
    let minimaxSpecialAdded = false;
    const models = selectableModelsByCapability(config, "audio").filter((model) => {
        const request = resolveModelRequestConfig(config, model);
        const protocol = request.advancedConfig?.protocol;
        const upstreamModel = modelOptionName(request.model).trim();
        if (MINIMAX_MUSIC_MODELS.includes(upstreamModel as (typeof MINIMAX_MUSIC_MODELS)[number])) return audioMode === "music" && request.advancedConfig?.minimaxMusicEnabled !== false;
        if (TOKENHUB_MUSIC_MODELS.includes(upstreamModel as (typeof TOKENHUB_MUSIC_MODELS)[number])) return audioMode === "music";
        if (MINIMAX_SPEECH_MODELS.includes(upstreamModel as (typeof MINIMAX_SPEECH_MODELS)[number])) {
            if (audioMode === "music") return false;
            if (audioMode === "voice-clone" || audioMode === "voice-design") {
                const enabled = audioMode === "voice-clone" ? request.advancedConfig?.minimaxVoiceCloneEnabled !== false : request.advancedConfig?.minimaxVoiceDesignEnabled !== false;
                if (!enabled || minimaxSpecialAdded) return false;
                minimaxSpecialAdded = true;
            }
            return true;
        }
        if (MINIMAX_MUSIC_MODELS.includes(upstreamModel as (typeof MINIMAX_MUSIC_MODELS)[number])) {
            return audioMode === "music" && request.advancedConfig?.minimaxMusicEnabled !== false;
        }
        if (QWEN_AUDIO_TTS_MODELS.includes(upstreamModel as (typeof QWEN_AUDIO_TTS_MODELS)[number])) {
            if (audioMode === "tts") return true;
            if (audioMode === "voice-clone") return QWEN_AUDIO_VOICE_CLONE_MODELS.includes(upstreamModel as (typeof QWEN_AUDIO_VOICE_CLONE_MODELS)[number]);
            if (audioMode === "voice-design") return QWEN_AUDIO_VOICE_DESIGN_MODELS.includes(upstreamModel as (typeof QWEN_AUDIO_VOICE_DESIGN_MODELS)[number]);
            return false;
        }
        if (protocol === "minimax-audio") return audioMode !== "music";
        if (protocol === "aliyun-bailian-audio") return audioMode === "tts" && QWEN_AUDIO_MODELS.includes(upstreamModel as (typeof QWEN_AUDIO_MODELS)[number]);
        if (protocol === "tencent-tokenhub-music") return false;
        if (audioMode === "music") return /music/i.test(upstreamModel);
        return !/^(?:music-)/i.test(upstreamModel);
    });
    if (audioMode !== "tts") return models;
    return models
        .map((model, index) => {
            const request = resolveModelRequestConfig(config, model);
            const upstreamModel = modelOptionName(request.model).trim();
            const protocol = request.advancedConfig?.protocol;
            const isMiniMax = protocol === "minimax-audio" || MINIMAX_SPEECH_MODELS.includes(upstreamModel as (typeof MINIMAX_SPEECH_MODELS)[number]);
            return { model, index, rank: isMiniMax ? 0 : 1 };
        })
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ model }) => model);
}

function findModelOption(options: string[], value: string) {
    const normalized = modelOptionName(value).trim().toLowerCase();
    return normalized ? options.find((option) => modelOptionName(option).trim().toLowerCase() === normalized) || "" : "";
}

export function canvasVideoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

export function canvasAudioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioMode") return { audioMode: value as AiConfig["audioMode"] };
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioVolume") return { audioVolume: value };
    if (key === "audioPitch") return { audioPitch: value };
    if (key === "audioEmotion") return { audioEmotion: value };
    if (key === "audioLanguageBoost") return { audioLanguageBoost: value };
    if (key === "audioSampleRate") return { audioSampleRate: value };
    if (key === "audioBitrate") return { audioBitrate: value };
    if (key === "audioChannel") return { audioChannel: value };
    if (key === "audioLyrics") return { audioLyrics: value };
    return { audioInstructions: value };
}
