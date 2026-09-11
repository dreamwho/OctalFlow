export const MINIMAX_SPEECH_MODELS = [
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
] as const;

export const MINIMAX_MUSIC_MODELS = ["music-2.5+", "music-2.5"] as const;
export const TOKENHUB_MUSIC_MODELS = ["minimax-music-v3.0"] as const;

export const MINIMAX_AUDIO_MODELS = [...MINIMAX_SPEECH_MODELS, ...MINIMAX_MUSIC_MODELS] as const;

export function normalizeMiniMaxBaseUrl(value: string) {
    const baseUrl = value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    return /^(?:api\.minimax\.cn|api\.minimaxi\.cn)$/i.test(baseUrl.replace(/^https?:\/\//i, "")) ? "https://api.minimaxi.com" : baseUrl || "https://api.minimaxi.com";
}

export type MiniMaxAudioMode = "tts" | "voice-design" | "voice-clone" | "music";

export type MiniMaxVoiceCategory = "旁白播音" | "女性" | "男性" | "童声" | "温柔治愈" | "活力欢快" | "角色戏剧" | "沉稳专业" | "其他";
export const MINIMAX_VOICE_CATEGORIES: MiniMaxVoiceCategory[] = ["旁白播音", "女性", "男性", "童声", "温柔治愈", "活力欢快", "角色戏剧", "沉稳专业", "其他"];

const voiceCategoryRules: Array<[MiniMaxVoiceCategory, RegExp]> = [
    ["旁白播音", /旁白|播音|解说|纪录片|narrat|news|播报/i],
    ["童声", /童声|儿童|少年|小孩|child|kid|young/i],
    ["女性", /女性|女声|女生|女孩|woman|female|girl|女/i],
    ["男性", /男性|男声|男生|男人|man|male|boy|男/i],
    ["温柔治愈", /温柔|治愈|轻柔|甜美|柔和|温暖|gentle|warm|soft|sweet/i],
    ["活力欢快", /活泼|活力|欢快|元气|开朗|energetic|cheerful|bright|happy/i],
    ["角色戏剧", /角色|戏剧|反派|英雄|动漫|character|dramatic|cartoon|anime/i],
    ["沉稳专业", /沉稳|专业|成熟|严肃|正式|稳重|professional|mature|calm|serious/i],
];

export function classifyMiniMaxVoice(name: string, description = ""): MiniMaxVoiceCategory {
    const text = `${name} ${description}`.trim();
    return voiceCategoryRules.find(([, pattern]) => pattern.test(text))?.[0] || "其他";
}

export function isMiniMaxMusicModel(model: string) {
    return MINIMAX_MUSIC_MODELS.includes(model as (typeof MINIMAX_MUSIC_MODELS)[number]);
}

export function isTokenHubMusicModel(model: string) {
    return TOKENHUB_MUSIC_MODELS.includes(model as (typeof TOKENHUB_MUSIC_MODELS)[number]);
}

export function minimaxAudioModeForModel(model: string): MiniMaxAudioMode {
    return isMiniMaxMusicModel(model) ? "music" : "tts";
}
