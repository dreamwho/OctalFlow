import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAuthSettings } from "@/lib/auth/store";
import { classifyMiniMaxVoice, normalizeMiniMaxBaseUrl, type MiniMaxVoiceCategory } from "@/lib/minimax-audio";
import { ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

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
    category: MiniMaxVoiceCategory;
    voiceType: "system" | "voice_cloning" | "voice_generation";
    visible: boolean;
    createdAt: string;
    updatedAt: string;
};

export type MiniMaxVoiceCatalogItem = Omit<MiniMaxVoice, "id" | "userId" | "provider" | "visible" | "createdAt" | "updatedAt">;

export type MiniMaxRequestLog = {
    id: string;
    userId?: string;
    provider: "minimax" | "aliyun-bailian" | "tencent-tokenhub";
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

export type MiniMaxMusicRecord = {
    id: string;
    userId: string;
    name: string;
    model: string;
    prompt: string;
    lyrics: string;
    resultUrl?: string;
    status: "pending" | "success" | "failed";
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export type BailianAudioRecord = {
    id: string;
    taskId: string;
    userId: string;
    model: string;
    audioMode: string;
    prompt: string;
    textContent: string;
    voice?: string;
    format?: string;
    sampleRate?: string;
    resultUrl?: string;
    mimeType?: string;
    status: "pending" | "success" | "failed";
    error?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export type BailianAudioRecordInput = Omit<BailianAudioRecord, "id" | "createdAt" | "updatedAt">;

type MiniMaxLocalState = { voices: MiniMaxVoice[]; logs: MiniMaxRequestLog[]; music: MiniMaxMusicRecord[]; audio: BailianAudioRecord[] };
type MiniMaxChannel = { baseUrl: string; apiKey: string };

const localStatePath = path.join(process.env.OCTALAICANVAS_DATA_DIR?.trim() || path.join(process.cwd(), ".data"), "minimax-audio.json");
let localStatePromise: Promise<MiniMaxLocalState> | undefined;
let localWriteQueue = Promise.resolve();

export async function getMiniMaxChannel(): Promise<MiniMaxChannel> {
    const settings = await getAuthSettings();
    const channel = settings.systemChannels.find((item) => item.enabled && (item.id === "minimax-audio" || item.advancedConfig?.protocol === "minimax-audio"));
    if (!channel?.apiKey?.trim()) throw new Error("尚未配置启用的 MiniMax 音频渠道或 API Key");
    return { baseUrl: normalizeMiniMaxBaseUrl(channel.baseUrl), apiKey: channel.apiKey.trim() };
}

export async function isMiniMaxVoiceFeatureEnabled(mode: "voice-clone" | "voice-design") {
    const settings = await getAuthSettings();
    const channel = settings.systemChannels.find((item) => item.enabled && (item.id === "minimax-audio" || item.advancedConfig?.protocol === "minimax-audio"));
    return mode === "voice-clone" ? channel?.advancedConfig?.minimaxVoiceCloneEnabled !== false : channel?.advancedConfig?.minimaxVoiceDesignEnabled !== false;
}

export async function requestMiniMax(pathname: string, init: RequestInit = {}) {
    const channel = await getMiniMaxChannel();
    const url = `${channel.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${channel.apiKey}`);
    if (!(init.body instanceof FormData)) headers.set("content-type", headers.get("content-type") || "application/json");
    return fetchSafeOutbound(url, { ...init, headers }, { allowProxyFakeIpSpace: true });
}

export async function fetchMiniMaxVoiceCatalog(userId = "") {
    const log = await appendMiniMaxRequestLog({
        userId,
        capability: "voice",
        method: "POST",
        path: "/v1/get_voice",
        model: "voice-catalog",
        statusCode: 0,
        durationMs: 0,
        phase: "queued",
        requestPreview: JSON.stringify({ mode: "voice-catalog" }),
        lifecycle: [{ at: new Date().toISOString(), phase: "queued", message: "音色目录同步已提交" }],
    }).catch(() => undefined);
    const startedAt = Date.now();
    let responseStatus = 0;
    let settled = false;
    if (log) await updateMiniMaxRequestLog(log.id, { statusCode: 0, durationMs: 0, phase: "running", lifecycle: [{ at: new Date().toISOString(), phase: "running", message: "正在获取 MiniMax 音色目录" }] }).catch(() => undefined);
    try {
        const response = await requestMiniMax("/v1/get_voice", { method: "POST", body: JSON.stringify({ voice_type: "all" }) });
        responseStatus = response.status;
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const code = Number((payload.base_resp as Record<string, unknown> | undefined)?.status_code || 0);
        const error = String((payload.base_resp as Record<string, unknown> | undefined)?.status_msg || `MiniMax 音色查询失败（${response.status || 502}）`);
        if (!response.ok || code !== 0) {
            settled = true;
            if (log) await updateMiniMaxRequestLog(log.id, { statusCode: response.status, durationMs: Date.now() - startedAt, phase: "failed", error, lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error }] }).catch(() => undefined);
            throw new Error(error);
        }
        settled = true;
        if (log) await updateMiniMaxRequestLog(log.id, { statusCode: response.status, durationMs: Date.now() - startedAt, phase: "success", responsePreview: "MiniMax 音色目录已同步", lifecycle: [{ at: new Date().toISOString(), phase: "success", message: "MiniMax 音色目录同步完成" }] }).catch(() => undefined);
        return {
            system: mapRemoteVoiceCatalog(payload.system_voice, "system"),
            cloning: mapRemoteVoiceCatalog(payload.voice_cloning, "voice_cloning"),
            generation: mapRemoteVoiceCatalog(payload.voice_generation, "voice_generation"),
        };
    } catch (error) {
        if (!settled && log) await updateMiniMaxRequestLog(log.id, { statusCode: responseStatus, durationMs: Date.now() - startedAt, phase: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "MiniMax 音色查询失败", lifecycle: [{ at: new Date().toISOString(), phase: "failed", message: error instanceof Error ? error.message.slice(0, 200) : "MiniMax 音色查询失败" }] }).catch(() => undefined);
        throw error;
    }
}

export function mergeMiniMaxVoiceCatalog(remote: MiniMaxVoiceCatalogItem[], stored: MiniMaxVoice[]) {
    const result = new Map<string, MiniMaxVoiceCatalogItem>();
    for (const voice of stored.filter((item) => item.voiceType === "system" && !item.userId).map(({ id: _id, userId: _userId, provider: _provider, visible: _visible, createdAt: _createdAt, updatedAt: _updatedAt, ...item }) => item).concat(remote)) {
        const previous = result.get(voice.remoteVoiceId);
        result.set(voice.remoteVoiceId, {
            ...previous,
            ...voice,
            description: voice.description || previous?.description || "",
            providerCreatedTime: voice.providerCreatedTime || previous?.providerCreatedTime || "",
        });
    }
    return Array.from(result.values());
}

export async function listMiniMaxVoices(userId?: string) {
    const personal = userId ? await listStoredVoices(userId) : [];
    return { personal };
}

export async function listStoredVoices(userId: string, provider: MiniMaxVoice["provider"] = "minimax") {
    if (!isPostgresDatabaseEnabled()) return (await readLocalState()).voices.filter((voice) => voice.userId === userId && (voice.provider || "minimax") === provider && voice.visible).map(enrichStoredVoice);
    await ensurePostgresSchema();
    const result = await postgresQuery("SELECT * FROM minimax_voices WHERE user_id = $1 AND provider = $2 AND visible = true ORDER BY updated_at DESC", [userId, provider]);
    return result.rows.map(mapVoice);
}

export async function listAllStoredVoices(provider: MiniMaxVoice["provider"] = "minimax") {
    if (!isPostgresDatabaseEnabled()) return (await readLocalState()).voices.filter((voice) => (voice.provider || "minimax") === provider).map(enrichStoredVoice);
    await ensurePostgresSchema();
    const result = await postgresQuery("SELECT * FROM minimax_voices WHERE provider = $1 ORDER BY updated_at DESC", [provider]);
    return result.rows.map(mapVoice);
}

export async function getMiniMaxVoiceRecord(id: string) {
    if (!isPostgresDatabaseEnabled()) {
        const voice = (await readLocalState()).voices.find((item) => item.id === id);
        return voice ? enrichStoredVoice(voice) : null;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery("SELECT * FROM minimax_voices WHERE id = $1", [id]);
    return result.rows[0] ? mapVoice(result.rows[0]) : null;
}

export async function saveMiniMaxVoice(input: Omit<MiniMaxVoice, "id" | "createdAt" | "updatedAt" | "provider"> & { provider?: MiniMaxVoice["provider"] }) {
    const now = new Date().toISOString();
    const voice = { provider: "minimax" as const, ...input, id: randomUUID(), createdAt: now, updatedAt: now } satisfies MiniMaxVoice;
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        state.voices = [voice, ...state.voices.filter((item) => !((item.provider || "minimax") === voice.provider && item.userId === voice.userId && item.remoteVoiceId === voice.remoteVoiceId))];
        await writeLocalState(state);
        return voice;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery(
        `INSERT INTO minimax_voices (id, user_id, provider, remote_voice_id, model, name, voice_name, description, provider_created_time, scene, voice_param, feature, age, gender, language, preview_url, category, voice_type, visible, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
         ON CONFLICT (coalesce(user_id, ''), remote_voice_id) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, name = EXCLUDED.name, voice_name = EXCLUDED.voice_name, description = EXCLUDED.description, provider_created_time = EXCLUDED.provider_created_time, scene = EXCLUDED.scene, voice_param = EXCLUDED.voice_param, feature = EXCLUDED.feature, age = EXCLUDED.age, gender = EXCLUDED.gender, language = EXCLUDED.language, preview_url = EXCLUDED.preview_url, category = EXCLUDED.category, visible = EXCLUDED.visible, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [voice.id, voice.userId || null, voice.provider, voice.remoteVoiceId, voice.model || "", voice.name, voice.voiceName, voice.description, voice.providerCreatedTime, voice.scene || "", voice.voiceParam || "", voice.feature || "", voice.age || "", voice.gender || "", voice.language || "", voice.previewUrl || "", voice.category, voice.voiceType, voice.visible, now],
    );
    return mapVoice(result.rows[0]);
}

export async function updateMiniMaxVoice(id: string, userId: string | undefined, patch: { name?: string; category?: MiniMaxVoiceCategory; visible?: boolean }) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const voice = state.voices.find((item) => item.id === id && item.userId === userId);
        if (!voice) return null;
        Object.assign(voice, patch, { updatedAt: new Date().toISOString() });
        await writeLocalState(state);
        return voice;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery(
        `UPDATE minimax_voices SET name = coalesce($3, name), category = coalesce($4, category), visible = coalesce($5, visible), updated_at = now()
         WHERE id = $1 AND ($2::text IS NULL OR user_id = $2) RETURNING *`,
        [id, userId, patch.name || null, patch.category || null, patch.visible ?? null],
    );
    return result.rows[0] ? mapVoice(result.rows[0]) : null;
}

export async function deleteMiniMaxVoiceRecord(id: string, userId?: string) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const before = state.voices.length;
        state.voices = state.voices.filter((item) => !(item.id === id && (!userId || item.userId === userId)));
        await writeLocalState(state);
        return before !== state.voices.length;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery("DELETE FROM minimax_voices WHERE id = $1 AND ($2::text IS NULL OR user_id = $2) RETURNING id", [id, userId || null]);
    return Boolean(result.rowCount);
}

export async function saveMiniMaxMusicRecord(input: Omit<MiniMaxMusicRecord, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const record = { ...input, id: randomUUID(), createdAt: now, updatedAt: now } satisfies MiniMaxMusicRecord;
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        state.music = [record, ...state.music];
        await writeLocalState(state);
        return record;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery(
        `INSERT INTO minimax_music_records (id,user_id,name,model,prompt,lyrics,result_url,status,metadata,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [record.id, record.userId, record.name, record.model, record.prompt, record.lyrics, record.resultUrl || null, record.status, JSON.stringify(record.metadata), now],
    );
    return mapMusic(result.rows[0]);
}

export async function listMiniMaxMusicRecords(provider?: "minimax" | "tencent-tokenhub") {
    const matchesProvider = (record: MiniMaxMusicRecord) => !provider || String(record.metadata?.provider || "minimax") === provider;
    if (!isPostgresDatabaseEnabled()) return (await readLocalState()).music.filter(matchesProvider);
    await ensurePostgresSchema();
    const result = await postgresQuery("SELECT * FROM minimax_music_records WHERE ($1::text IS NULL OR coalesce(metadata->>'provider', 'minimax') = $1::text) ORDER BY created_at DESC LIMIT 200", [provider || null]);
    return result.rows.map(mapMusic);
}

export async function updateMiniMaxMusicRecord(id: string, patch: { name?: string; status?: MiniMaxMusicRecord["status"] }) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const record = state.music.find((item) => item.id === id);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: new Date().toISOString() });
        await writeLocalState(state);
        return record;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery("UPDATE minimax_music_records SET name=coalesce($2,name), status=coalesce($3,status), updated_at=now() WHERE id=$1 RETURNING *", [id, patch.name || null, patch.status || null]);
    return result.rows[0] ? mapMusic(result.rows[0]) : null;
}

export async function saveBailianAudioRecord(input: BailianAudioRecordInput) {
    const now = new Date().toISOString();
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const previous = state.audio.find((item) => item.taskId === input.taskId);
        const record = { ...input, id: previous?.id || randomUUID(), createdAt: previous?.createdAt || now, updatedAt: now } satisfies BailianAudioRecord;
        state.audio = [record, ...state.audio.filter((item) => item.taskId !== input.taskId)];
        await writeLocalState(state);
        return record;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery(
        `INSERT INTO aliyun_bailian_audio_records (id,task_id,user_id,model,audio_mode,prompt,text_content,voice,format,sample_rate,result_url,mime_type,status,error,metadata,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         ON CONFLICT (task_id) DO UPDATE SET model=EXCLUDED.model,audio_mode=EXCLUDED.audio_mode,prompt=EXCLUDED.prompt,text_content=EXCLUDED.text_content,voice=EXCLUDED.voice,format=EXCLUDED.format,sample_rate=EXCLUDED.sample_rate,result_url=EXCLUDED.result_url,mime_type=EXCLUDED.mime_type,status=EXCLUDED.status,error=EXCLUDED.error,metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [randomUUID(), input.taskId, input.userId, input.model, input.audioMode, input.prompt, input.textContent, input.voice || null, input.format || null, input.sampleRate || null, input.resultUrl || null, input.mimeType || null, input.status, input.error || null, JSON.stringify(input.metadata), now],
    );
    return mapBailianAudioRecord(result.rows[0]);
}

export async function updateBailianAudioRecord(taskId: string, patch: Partial<Pick<BailianAudioRecord, "resultUrl" | "mimeType" | "status" | "error" | "metadata">>) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const record = state.audio.find((item) => item.taskId === taskId);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: new Date().toISOString() });
        await writeLocalState(state);
        return record;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery(
        `UPDATE aliyun_bailian_audio_records SET result_url=coalesce($2,result_url),mime_type=coalesce($3,mime_type),status=coalesce($4,status),error=$5,metadata=coalesce($6::jsonb,metadata),updated_at=now() WHERE task_id=$1 RETURNING *`,
        [taskId, patch.resultUrl || null, patch.mimeType || null, patch.status || null, patch.error || null, patch.metadata ? JSON.stringify(patch.metadata) : null],
    );
    return result.rows[0] ? mapBailianAudioRecord(result.rows[0]) : null;
}

export async function listBailianAudioRecords(page = 1, pageSize = 25) {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    if (!isPostgresDatabaseEnabled()) {
        const records = (await readLocalState()).audio;
        return { items: records.slice((safePage - 1) * safeSize, safePage * safeSize), total: records.length, page: safePage, pageSize: safeSize };
    }
    await ensurePostgresSchema();
    const [count, rows] = await Promise.all([
        postgresQuery("SELECT count(*)::integer AS total FROM aliyun_bailian_audio_records", []),
        postgresQuery("SELECT * FROM aliyun_bailian_audio_records ORDER BY created_at DESC LIMIT $1 OFFSET $2", [safeSize, (safePage - 1) * safeSize]),
    ]);
    return { items: rows.rows.map(mapBailianAudioRecord), total: Number(count.rows[0]?.total || 0), page: safePage, pageSize: safeSize };
}

export async function deleteMiniMaxMusicRecord(id: string) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const before = state.music.length;
        state.music = state.music.filter((item) => item.id !== id);
        await writeLocalState(state);
        return before !== state.music.length;
    }
    await ensurePostgresSchema();
    const result = await postgresQuery("DELETE FROM minimax_music_records WHERE id=$1 RETURNING id", [id]);
    return Boolean(result.rowCount);
}

export async function appendMiniMaxRequestLog(log: Omit<MiniMaxRequestLog, "id" | "createdAt" | "provider"> & { provider?: MiniMaxRequestLog["provider"] }) {
    const record = { provider: "minimax" as const, ...log, id: randomUUID(), createdAt: new Date().toISOString() } satisfies MiniMaxRequestLog;
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        state.logs = [record, ...state.logs].slice(0, 2_000);
        await writeLocalState(state);
        return record;
    }
    await ensurePostgresSchema();
    await postgresQuery(
        `INSERT INTO minimax_request_logs (id,user_id,provider,created_at,capability,method,path,model,status_code,duration_ms,error,request_preview,response_preview,phase,lifecycle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [record.id, record.userId || null, record.provider, record.createdAt, record.capability, record.method, record.path, record.model, record.statusCode, record.durationMs, record.error || null, record.requestPreview || null, record.responsePreview || null, record.phase, JSON.stringify(record.lifecycle)],
    );
    return record;
}

export async function updateMiniMaxRequestLog(id: string, patch: Pick<MiniMaxRequestLog, "statusCode" | "durationMs" | "phase"> & Partial<Pick<MiniMaxRequestLog, "error" | "requestPreview" | "responsePreview" | "lifecycle">>) {
    if (!isPostgresDatabaseEnabled()) {
        const state = await readLocalState();
        const log = state.logs.find((item) => item.id === id);
        if (!log) return;
        Object.assign(log, patch, patch.lifecycle ? { lifecycle: [...log.lifecycle, ...patch.lifecycle] } : {});
        await writeLocalState(state);
        return;
    }
    await ensurePostgresSchema();
    await postgresQuery("UPDATE minimax_request_logs SET status_code=$2,duration_ms=$3,error=$4,response_preview=$5,phase=$6,lifecycle=coalesce(lifecycle,'[]'::jsonb) || coalesce($7::jsonb,'[]'::jsonb) WHERE id=$1", [id, patch.statusCode, patch.durationMs, patch.error || null, patch.responsePreview || null, patch.phase, patch.lifecycle ? JSON.stringify(patch.lifecycle) : null]);
}

export function isVoiceSubmissionUncertain(statusCode: number, responseOk = false) {
    return statusCode === 0 || statusCode >= 500 || responseOk;
}

export async function markVoiceSubmissionNeedsReview(logId: string | undefined, startedAt: number, message: string, statusCode = 0) {
    if (!logId) return;
    await updateMiniMaxRequestLog(logId, {
        statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        phase: "running",
        responsePreview: message,
        lifecycle: [{ at: new Date().toISOString(), phase: "running", message }],
    }).catch(() => undefined);
}

export async function listMiniMaxRequestLogs(page = 1, pageSize = 20, provider: MiniMaxRequestLog["provider"] = "minimax") {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    if (!isPostgresDatabaseEnabled()) {
        const logs = (await readLocalState()).logs.filter((log) => (log.provider || "minimax") === provider).map((log) => ({ ...log, provider: log.provider || "minimax" }));
        return { items: logs.slice((safePage - 1) * safeSize, safePage * safeSize), total: logs.length, page: safePage, pageSize: safeSize };
    }
    await ensurePostgresSchema();
    const [count, rows] = await Promise.all([
        postgresQuery("SELECT count(*)::integer AS total FROM minimax_request_logs WHERE provider = $1", [provider]),
        postgresQuery("SELECT * FROM minimax_request_logs WHERE provider = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [provider, safeSize, (safePage - 1) * safeSize]),
    ]);
    return { items: rows.rows.map(mapLog), total: Number(count.rows[0]?.total || 0), page: safePage, pageSize: safeSize };
}

async function readLocalState() {
    if (!localStatePromise) {
        localStatePromise = readFile(localStatePath, "utf8")
            .then((value) => {
                const parsed = JSON.parse(value) as Partial<MiniMaxLocalState>;
                return { voices: Array.isArray(parsed.voices) ? parsed.voices : [], logs: Array.isArray(parsed.logs) ? parsed.logs : [], music: Array.isArray(parsed.music) ? parsed.music : [], audio: Array.isArray(parsed.audio) ? parsed.audio : [] };
            })
            .catch(() => ({ voices: [], logs: [], music: [], audio: [] }));
    }
    return localStatePromise;
}

async function writeLocalState(state: MiniMaxLocalState) {
    localStatePromise = Promise.resolve(state);
    localWriteQueue = localWriteQueue.then(async () => {
        await mkdir(path.dirname(localStatePath), { recursive: true });
        await writeFile(localStatePath, JSON.stringify(state, null, 2), "utf8");
    });
    await localWriteQueue;
}

function enrichStoredVoice(voice: MiniMaxVoice): MiniMaxVoice {
    const voiceName = String((voice as Partial<MiniMaxVoice>).voiceName || voice.name || voice.remoteVoiceId);
    const description = String((voice as Partial<MiniMaxVoice>).description || "");
    return { ...voice, provider: voice.provider || "minimax", voiceName, description, providerCreatedTime: normalizeProviderCreatedTime((voice as Partial<MiniMaxVoice>).providerCreatedTime), category: voice.category || classifyMiniMaxVoice(voiceName, description) };
}

function mapVoice(row: Record<string, unknown>): MiniMaxVoice {
    const name = String(row.name || row.voice_name || row.remote_voice_id);
    const voiceName = String(row.voice_name || name);
    const description = String(row.description || "");
    return {
        id: String(row.id),
        provider: row.provider === "aliyun-bailian" ? "aliyun-bailian" : "minimax",
        ...(row.user_id ? { userId: String(row.user_id) } : {}),
        remoteVoiceId: String(row.remote_voice_id),
        ...(row.model ? { model: String(row.model) } : {}),
        name,
        voiceName,
        description,
        providerCreatedTime: normalizeProviderCreatedTime(row.provider_created_time),
        ...(row.scene ? { scene: String(row.scene) } : {}),
        ...(row.voice_param ? { voiceParam: String(row.voice_param) } : {}),
        ...(row.feature ? { feature: String(row.feature) } : {}),
        ...(row.age ? { age: String(row.age) } : {}),
        ...(row.gender ? { gender: String(row.gender) } : {}),
        ...(row.language ? { language: String(row.language) } : {}),
        ...(row.preview_url ? { previewUrl: String(row.preview_url) } : {}),
        category: (row.category as MiniMaxVoiceCategory) || classifyMiniMaxVoice(voiceName, description),
        voiceType: row.voice_type === "voice_cloning" || row.voice_type === "voice_generation" ? row.voice_type : "system",
        visible: row.visible !== false,
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
}

function mapRemoteVoiceCatalog(value: unknown, voiceType: MiniMaxVoice["voiceType"]): MiniMaxVoiceCatalogItem[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (typeof item === "string") return [{ remoteVoiceId: item, name: item, voiceName: item, description: "", providerCreatedTime: "", category: classifyMiniMaxVoice(item), voiceType }];
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const id = String(record.voice_id || record.voiceId || record.id || "").trim();
        const voiceName = String(record.voice_name || record.name || id);
        const descriptionValue = record.description;
        const description = Array.isArray(descriptionValue) ? descriptionValue.map((item) => String(item)).filter(Boolean).join("；") : String(descriptionValue || "");
        const providerCreatedTime = normalizeProviderCreatedTime(record.created_time ?? record.createdTime);
        const previewUrl = String(record.preview_url || record.previewUrl || record.audio_url || record.audioUrl || "").trim();
        return id ? [{ remoteVoiceId: id, name: voiceName, voiceName, description, providerCreatedTime, ...(previewUrl ? { previewUrl } : {}), category: classifyMiniMaxVoice(voiceName, description), voiceType }] : [];
    });
}

export function normalizeProviderCreatedTime(value: unknown) {
    if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
        const numeric = Number(value);
        if (numeric <= 0) return "";
        const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const date = new Date(milliseconds);
        return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
    }
    const text = String(value || "").trim();
    if (!text) return "";
    const date = new Date(text);
    return date.getTime() === 0 ? "" : text;
}

function mapLog(row: Record<string, unknown>): MiniMaxRequestLog {
    let lifecycle: MiniMaxRequestLog["lifecycle"] = [];
    try {
        lifecycle = Array.isArray(row.lifecycle) ? (row.lifecycle as MiniMaxRequestLog["lifecycle"]) : JSON.parse(String(row.lifecycle || "[]"));
    } catch {
        lifecycle = [];
    }
    return { id: String(row.id), provider: row.provider === "aliyun-bailian" ? "aliyun-bailian" : row.provider === "tencent-tokenhub" ? "tencent-tokenhub" : "minimax", ...(row.user_id ? { userId: String(row.user_id) } : {}), createdAt: new Date(String(row.created_at)).toISOString(), capability: row.capability === "music" || row.capability === "voice" ? row.capability : "speech", method: String(row.method), path: String(row.path), model: String(row.model), statusCode: Number(row.status_code || 0), durationMs: Number(row.duration_ms || 0), ...(row.error ? { error: String(row.error) } : {}), ...(row.request_preview ? { requestPreview: String(row.request_preview) } : {}), ...(row.response_preview ? { responsePreview: String(row.response_preview) } : {}), phase: row.phase === "queued" || row.phase === "running" || row.phase === "failed" ? row.phase : "success", lifecycle };
}

function mapMusic(row: Record<string, unknown>): MiniMaxMusicRecord {
    let metadata: Record<string, unknown> = {};
    try {
        metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : JSON.parse(String(row.metadata || "{}"));
    } catch {
        metadata = {};
    }
    return { id: String(row.id), userId: String(row.user_id), name: String(row.name), model: String(row.model), prompt: String(row.prompt || ""), lyrics: String(row.lyrics || ""), ...(row.result_url ? { resultUrl: String(row.result_url) } : {}), status: row.status === "pending" || row.status === "failed" ? row.status : "success", metadata, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}

function mapBailianAudioRecord(row: Record<string, unknown>): BailianAudioRecord {
    let metadata: Record<string, unknown> = {};
    try {
        metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : JSON.parse(String(row.metadata || "{}"));
    } catch {
        metadata = {};
    }
    return {
        id: String(row.id),
        taskId: String(row.task_id),
        userId: String(row.user_id),
        model: String(row.model || ""),
        audioMode: String(row.audio_mode || "tts"),
        prompt: String(row.prompt || ""),
        textContent: String(row.text_content || ""),
        ...(row.voice ? { voice: String(row.voice) } : {}),
        ...(row.format ? { format: String(row.format) } : {}),
        ...(row.sample_rate ? { sampleRate: String(row.sample_rate) } : {}),
        ...(row.result_url ? { resultUrl: String(row.result_url) } : {}),
        ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
        status: row.status === "pending" || row.status === "failed" ? row.status : "success",
        ...(row.error ? { error: String(row.error) } : {}),
        metadata,
        createdAt: new Date(String(row.created_at)).toISOString(),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
}
