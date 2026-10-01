import { NextResponse } from "next/server";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { normalizeTrafficDisplayUnit } from "@/lib/traffic-format";
import { parseTrafficFilter } from "@/lib/server/traffic-filter";
import { queryGlobalTraffic } from "@/lib/server/traffic-meter-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(user, "analytics.read") && !hasAdminPermission(user, "upstream.manage")) return NextResponse.json({ code: 403, data: null, msg: "需要流量统计管理权限" }, { status: 403 });
    let filter;
    try {
        filter = parseTrafficFilter(new URL(request.url).searchParams);
    } catch (error) {
        return NextResponse.json({ code: 400, data: null, msg: error instanceof Error ? error.message : "流量筛选条件无效" }, { status: 400 });
    }
    try {
        const [data, settings] = await Promise.all([queryGlobalTraffic(filter), getFreshAuthSettings()]);
        const channels = new Map(settings.systemChannels.map((channel) => [channel.id, channel.name]));
        data.items = data.items.map((item) => ({ ...item, channelName: channels.get(item.channelId) || item.channelName || item.channelId }));
        data.options.channels = data.options.channels.map((item) => ({ ...item, name: channels.get(item.id) || item.name || item.id }));
        data.coverage = [
            { source: "Web 渠道", status: "ok", message: "文本、图片、视频、音频渠道按实际请求记录；统计从接入计量后开始。" },
            { source: "DOLA / GPT API", status: "ok", message: "提交、上传、查询和下载按模型计量，DOLA 浏览器后台流量单列共享，GPT 令牌刷新单列账号维护；内部转发不重复计数。" },
            { source: "GeminiAI", status: "ok", message: "持久浏览器按共享渠道、共享浏览器流量和实际端口统计；模型、渠道别名与可变代理模式无法精确拆分。" },
            { source: "Dreamina CLI", status: "available", message: "通过进程专用 HTTP(S) 代理接入计量；真实生成仍需部署后验收。" },
            { source: "统计边界", status: "ok", message: "人工 OAuth 登录窗口属于管理控制面，不计入生成渠道流量；TCP 统计不等于运营商账单。" },
        ];
        data.displayUnit = normalizeTrafficDisplayUnit(settings.trafficUnit);
        return NextResponse.json({ code: 0, data, msg: "OK" });
    } catch (error) {
        return NextResponse.json({ code: 503, data: null, msg: error instanceof Error ? error.message : "读取全局流量失败" }, { status: 503 });
    }
}
