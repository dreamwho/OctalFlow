import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 画布功能菜单下发：仅登录用户可见，只返回启用的分组与条目。 */
export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const settings = await getAuthSettings();
    const groups = (settings.canvasQuickActions || [])
        .filter((group) => group.enabled && group.actions.length)
        .map((group) => ({
            id: group.id,
            name: group.name,
            actions: group.actions
                .filter((action) => action.enabled)
                .map((action) => ({ id: action.id, name: action.name, prompt: action.prompt, capability: action.capability, defaults: action.defaults })),
        }))
        .filter((group) => group.actions.length);
    return NextResponse.json({ groups });
}
