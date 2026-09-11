import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { sanitizeProviderMessage } from "@/lib/server/admin-channel-config";
import { fetchMiniMaxVoiceCatalog, listAllStoredVoices, listMiniMaxMusicRecords, listMiniMaxRequestLogs, saveMiniMaxVoice } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") || 1);
    const [settings, voices, music, logs] = await Promise.all([getFreshAuthSettings(), listAllStoredVoices(), listMiniMaxMusicRecords("minimax"), listMiniMaxRequestLogs(page)]);
    return NextResponse.json({
        channels: settings.systemChannels.filter((channel) => channel.id === "minimax-audio" || channel.advancedConfig?.protocol === "minimax-audio").map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, hasApiKey: Boolean(_apiKey) })),
        voices,
        music,
        logs,
    });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const parsed = await readJsonBodyResult<{ action?: string }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    if (body.action !== "sync-voices") return NextResponse.json({ error: "不支持的 MiniMax 管理操作" }, { status: 400 });
    try {
        const catalog = await fetchMiniMaxVoiceCatalog(user.id);
        for (const voice of [...catalog.system, ...catalog.cloning, ...catalog.generation]) await saveMiniMaxVoice({ ...voice, visible: true });
        return NextResponse.json({ catalog, voices: await listAllStoredVoices() });
    } catch (error) {
        return NextResponse.json({ error: sanitizeProviderMessage(error) || "MiniMax 音色同步失败" }, { status: 502 });
    }
}
