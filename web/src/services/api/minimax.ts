export type MiniMaxVoice = {
    id: string;
    userId?: string;
    provider: "minimax" | "aliyun-bailian";
    remoteVoiceId: string;
    model?: string;
    name: string;
    voiceName: string;
    description: string;
    providerCreatedTime: string;
    scene?: string;
    voiceParam?: string;
    feature?: string;
    age?: string;
    gender?: string;
    language?: string;
    previewUrl?: string;
    category: string;
    voiceType: "system" | "voice_cloning" | "voice_generation";
    visible: boolean;
    createdAt: string;
    updatedAt: string;
};

export type MiniMaxRequestLog = {
    id: string;
    userId?: string;
    provider: "minimax" | "aliyun-bailian";
    createdAt: string;
    capability: "speech" | "music" | "voice";
    method: string;
    path: string;
    model: string;
    statusCode: number;
    durationMs: number;
    error?: string;
    requestPreview?: string;
    responsePreview?: string;
    phase: "queued" | "running" | "success" | "failed";
    lifecycle: Array<{ at: string; phase: string; message: string }>;
};

export type MiniMaxMusicRecord = { id: string; userId: string; name: string; model: string; prompt: string; lyrics: string; resultUrl?: string; status: "pending" | "success" | "failed"; metadata: Record<string, unknown>; createdAt: string; updatedAt: string };

export type MiniMaxAdminState = {
    channels: Array<{ id: string; name: string; baseUrl: string; models: string[]; enabled: boolean; hasApiKey?: boolean }>;
    voices: MiniMaxVoice[];
    music: MiniMaxMusicRecord[];
    logs: { items: MiniMaxRequestLog[]; total: number; page: number; pageSize: number };
};

export async function getMiniMaxAdminState(page = 1) {
    const response = await fetch(`/api/admin/minimax?page=${page}`, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as MiniMaxAdminState & { error?: string };
    if (!response.ok) throw new Error(payload.error || "读取 MiniMax 控制台失败");
    return payload;
}

export async function syncMiniMaxVoices() {
    const response = await fetch("/api/admin/minimax", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync-voices" }) });
    const payload = (await response.json().catch(() => ({}))) as { voices?: MiniMaxVoice[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "同步 MiniMax 音色失败");
    return payload.voices || [];
}
