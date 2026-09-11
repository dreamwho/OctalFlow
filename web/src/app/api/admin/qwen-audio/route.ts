import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { qwenAudioSystemVoices } from "@/lib/qwen-audio";
import { listBailianAudioRecords, listMiniMaxRequestLogs, listStoredVoices } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const page = Number(new URL(request.url).searchParams.get("page") || 1);
    const [settings, voices, logs, audio] = await Promise.all([getFreshAuthSettings(), listStoredVoices(user.id, "aliyun-bailian"), listMiniMaxRequestLogs(page, 20, "aliyun-bailian"), listBailianAudioRecords(page, 25)]);
    const users = await getPublicUsersByIds(audio.items.map((record) => record.userId));
    const usersById = new Map(users.map((item) => [item.id, item]));
    const system = qwenAudioSystemVoices().map((voice) => ({
        id: `qwen-system:${voice.model}:${voice.voiceParam}`,
        provider: "aliyun-bailian" as const,
        remoteVoiceId: voice.voiceParam,
        model: voice.model,
        name: voice.voiceName,
        voiceName: voice.voiceName,
        description: voice.feature,
        providerCreatedTime: "",
        scene: voice.scene,
        voiceParam: voice.voiceParam,
        feature: voice.feature,
        age: voice.age,
        gender: voice.gender,
        language: voice.language,
        ...(voice.previewUrl ? { previewUrl: voice.previewUrl } : {}),
        category: voice.feature,
        voiceType: "system" as const,
        visible: true,
        createdAt: "",
        updatedAt: "",
    }));
    return NextResponse.json({
        channels: settings.systemChannels.filter((channel) => channel.id === "aliyun-bailian-audio" || channel.advancedConfig?.protocol === "aliyun-bailian-audio").map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, hasApiKey: Boolean(_apiKey) })),
        system,
        voices,
        logs,
        audio: {
            ...audio,
            items: audio.items.map((record) => {
                const owner = usersById.get(record.userId);
                return { ...record, username: owner?.username || "已删除用户", displayName: owner?.displayName || owner?.username || "已删除用户", accountId: owner?.accountId || "" };
            }),
        },
    });
}
