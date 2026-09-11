import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { deleteMiniMaxMusicRecord, updateMiniMaxMusicRecord } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const parsed = await readJsonBodyResult<{ name?: string; status?: "pending" | "success" | "failed" }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    const record = await updateMiniMaxMusicRecord((await context.params).id, { name: body.name?.trim().slice(0, 80), status: body.status });
    return record ? NextResponse.json({ record }) : NextResponse.json({ error: "音乐记录不存在" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    return NextResponse.json({ ok: await deleteMiniMaxMusicRecord((await context.params).id) });
}
