import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { normalizeTrafficDisplayUnit } from "@/lib/traffic-format";
import { parseTrafficFilter } from "@/lib/server/traffic-filter";
import { queryTaskTraffic } from "@/lib/server/traffic-meter-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "analytics.read") && !hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要流量统计管理权限" }, { status: 403 });
    let filter;
    try {
        const params = new URL(request.url).searchParams;
        const page = Number(params.get("page") || 1);
        const pageSize = Number(params.get("pageSize") || 20);
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("任务分页参数无效");
        const identities: { requestId?: string; taskId?: string; attemptId?: string } = {};
        for (const key of ["requestId", "taskId", "attemptId"] as const) {
            const value = params.get(key);
            if (value !== null) {
                if (!value.trim() || value.length > 200) throw new Error("任务流量身份无效");
                identities[key] = value;
            }
        }
        filter = { ...parseTrafficFilter(params), ...identities, page, pageSize };
    } catch (error) {
        return NextResponse.json({ code: 400, data: null, msg: error instanceof Error ? error.message : "任务流量筛选无效" }, { status: 400 });
    }
    try {
        const [data, settings] = await Promise.all([queryTaskTraffic(filter), getFreshAuthSettings()]);
        const channels = new Map(settings.systemChannels.map((channel) => [channel.id, channel.name]));
        data.items = data.items.map((task) => ({ ...task, items: task.items.map((item) => ({ ...item, channelName: channels.get(item.channelId) || item.channelName || item.channelId })) }));
        data.displayUnit = normalizeTrafficDisplayUnit(settings.trafficUnit);
        return NextResponse.json({ code: 0, data, msg: "OK" });
    } catch (error) {
        return NextResponse.json({ code: 503, data: null, msg: error instanceof Error ? error.message : "读取任务流量失败" }, { status: 503 });
    }
}
