import { NextResponse } from "next/server";

import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { listMiniMaxMusicRecords, listMiniMaxRequestLogs } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    const page = Math.max(1, Number(new URL(request.url).searchParams.get("page") || 1));
    const [settings, music, logs] = await Promise.all([getFreshAuthSettings(), listMiniMaxMusicRecords("tencent-tokenhub"), listMiniMaxRequestLogs(page, 20, "tencent-tokenhub")]);
    return NextResponse.json({
        channels: settings.systemChannels
            .filter((channel) => channel.id === "tencent-tokenhub-music" || channel.advancedConfig?.protocol === "tencent-tokenhub-music")
            .map(({ apiKey: _apiKey, ...channel }) => ({ ...channel, hasApiKey: Boolean(_apiKey) })),
        music,
        logs,
    });
}
