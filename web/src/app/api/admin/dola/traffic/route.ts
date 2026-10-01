import { apiSuccess } from "@/app/api/_shared/api-response";
import { dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { dolaRuntimeRequest } from "@/lib/server/dola/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const access = await requireDolaAdmin();
    if (access.error) return access.error;
    try {
        const input = new URL(request.url).searchParams;
        const start = input.get("start") || "";
        const end = input.get("end") || "";
        if (!/^\d{4}-.*(?:Z|[+-]\d{2}:\d{2})$/.test(start) || !/^\d{4}-.*(?:Z|[+-]\d{2}:\d{2})$/.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new Error("请选择有效的开始和结束时间");
        const params = new URLSearchParams({ start, end });
        const port = input.get("port");
        if (port !== null) {
            if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("代理端口无效");
            params.set("port", port);
        }
        const response = await dolaRuntimeRequest(`/v1/traffic?${params}`);
        if (!response.ok) throw new Error("读取 DOLA 出口流量失败");
        return apiSuccess(await response.json());
    } catch (error) {
        return dolaRouteError(error, "读取 DOLA 流量失败");
    }
}
