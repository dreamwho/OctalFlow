import { NextResponse } from "next/server";

import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { MINIMAX_VOICE_CATEGORIES, type MiniMaxVoiceCategory } from "@/lib/minimax-audio";
import { readJsonBodyResult } from "@/lib/auth/request";
import { updateMiniMaxVoice } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const parsed = await readJsonBodyResult<{ name?: string; category?: string; visible?: boolean }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const category = MINIMAX_VOICE_CATEGORIES.includes(parsed.data.category as MiniMaxVoiceCategory) ? (parsed.data.category as MiniMaxVoiceCategory) : undefined;
    const voice = await updateMiniMaxVoice((await context.params).id, undefined, { name: parsed.data.name?.trim().slice(0, 80), category, visible: typeof parsed.data.visible === "boolean" ? parsed.data.visible : undefined });
    return voice ? NextResponse.json({ voice }) : NextResponse.json({ error: "阿里云百炼音色不存在" }, { status: 404 });
}
