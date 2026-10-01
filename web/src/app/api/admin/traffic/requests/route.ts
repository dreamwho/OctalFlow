import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { readJsonBody } from "@/lib/auth/request";
import { normalizeTrafficDisplayUnit } from "@/lib/traffic-format";
import { queryRequestTraffic } from "@/lib/server/traffic-meter-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "analytics.read") && !hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要流量统计管理权限" }, { status: 403 });
    const body = await readJsonBody<{ requestIds?: unknown; taskIds?: unknown }>(request);
    const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string" && Boolean(id.trim()) && id.length <= 200);
    if (!body || !validIds(body.requestIds) || (body.taskIds !== undefined && !validIds(body.taskIds)) || (!body.requestIds.length && !(Array.isArray(body.taskIds) && body.taskIds.length))) return NextResponse.json({ code: 400, data: null, msg: "请求日志 ID 无效" }, { status: 400 });
    try {
        const [data, settings] = await Promise.all([queryRequestTraffic([...new Set(body.requestIds)], [...new Set((body.taskIds || []) as string[])]), getFreshAuthSettings()]);
        const channels = new Map(settings.systemChannels.map((channel) => [channel.id, channel.name]));
        data.items = data.items.map((summary) => ({ ...summary, items: summary.items.map((item) => ({ ...item, channelName: channels.get(item.channelId) || item.channelName || item.channelId })) }));
        if (data.tasks) data.tasks = data.tasks.map((summary) => ({ ...summary, items: summary.items.map((item) => ({ ...item, channelName: channels.get(item.channelId) || item.channelName || item.channelId })) }));
        data.displayUnit = normalizeTrafficDisplayUnit(settings.trafficUnit);
        return NextResponse.json({ code: 0, data, msg: "OK" });
    } catch (error) {
        return NextResponse.json({ code: 503, data: null, msg: error instanceof Error ? error.message : "读取请求流量失败" }, { status: 503 });
    }
}
