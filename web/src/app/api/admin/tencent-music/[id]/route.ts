import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { deleteMiniMaxMusicRecord, listMiniMaxMusicRecords, updateMiniMaxMusicRecord } from "@/lib/server/minimax-audio-store";

export const runtime = "nodejs";

async function getTokenHubRecord(id: string) {
    return (await listMiniMaxMusicRecords("tencent-tokenhub")).find((record) => record.id === id) || null;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const parsed = await readJsonBodyResult<{ name?: string; status?: "pending" | "success" | "failed" }>(request, 16 * 1024);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });
    const id = (await context.params).id;
    if (!(await getTokenHubRecord(id))) return NextResponse.json({ error: "TokenHub 音乐记录不存在" }, { status: 404 });
    const record = await updateMiniMaxMusicRecord(id, { name: parsed.data.name?.trim().slice(0, 80), status: parsed.data.status });
    return record ? NextResponse.json({ record }) : NextResponse.json({ error: "TokenHub 音乐记录不存在" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user || !hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: user ? 403 : 401 });
    const id = (await context.params).id;
    if (!(await getTokenHubRecord(id))) return NextResponse.json({ error: "TokenHub 音乐记录不存在" }, { status: 404 });
    return NextResponse.json({ ok: await deleteMiniMaxMusicRecord(id) });
}
