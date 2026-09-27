import { NextResponse } from "next/server";

import { readJsonBodyResult } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { getFreshAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { MINIMAX_H3_DEFAULT_BASE_URL, MINIMAX_H3_MODEL_METAS, MINIMAX_H3_MODELS } from "@/lib/minimax-h3";
import { isLogicalModelResolvable, resolveLogicalModelConfig } from "@/lib/model-routing-config";
import { listGenerationLogs } from "@/lib/server/generation-log-store";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    const searchParams = new URL(request.url).searchParams;
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get("pageSize") || 20)));
    const statusFilter = searchParams.get("status") || undefined;
    const modelFilter = searchParams.get("model") || undefined;

    const [settings, logsResult] = await Promise.all([
        getFreshAuthSettings(),
        listGenerationLogs({
            page,
            pageSize,
            kind: "video",
            keyword: modelFilter || "minimax-h3",
            status: statusFilter as never,
        }),
    ]);

    const channel = settings.systemChannels.find(
        (item) => item.id === "easyframe-minimax-h3" || item.advancedConfig?.protocol === "minimax-h3",
    );

    const userIds = Array.from(new Set(logsResult.items.map((item) => item.userId).filter(Boolean)));
    const users = await getPublicUsersByIds(userIds);
    const usersById = new Map(users.map((item) => [item.id, item]));

    const enrichedTasks = logsResult.items.map((item) => {
        const owner = usersById.get(item.userId);
        return {
            ...item,
            username: owner?.username || item.username || "已删除用户",
            displayName: owner?.displayName || owner?.username || item.displayName || "已删除用户",
            accountId: owner?.accountId || "",
        };
    });

    const logicalModelsStatus = MINIMAX_H3_MODELS.map((modelId) => {
        const logical = settings.logicalModels.find((m) => m.id.toLowerCase() === modelId.toLowerCase() && m.capability === "video");
        const resolvable = isLogicalModelResolvable(settings.logicalModels, settings.systemChannels, "video", modelId);
        const resolved = resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, "video", modelId);
        const isBoundToChannel = Boolean(channel && logical?.bindings.some((b) => b.enabled && b.channelId === channel.id));
        return {
            id: modelId,
            name: logical?.name || modelId,
            capability: "video",
            enabled: logical ? logical.enabled : false,
            resolvable,
            resolvedChannel: resolved ? { id: resolved.channel.id, name: resolved.channel.name } : null,
            isBoundToChannel,
            bindingsCount: logical?.bindings.length || 0,
        };
    });

    return NextResponse.json({
        channel: channel
            ? {
                  ...channel,
                  apiKey: "",
                  hasApiKey: Boolean(channel.apiKey),
              }
            : null,
        defaultBaseUrl: MINIMAX_H3_DEFAULT_BASE_URL,
        logicalModels: logicalModelsStatus,
        modelMetas: MINIMAX_H3_MODEL_METAS,
        videoTasks: {
            items: enrichedTasks,
            total: logsResult.total,
            page,
            pageSize,
        },
    });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAnyAdminPermission(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

    const parsed = await readJsonBodyResult<{ action?: string; baseUrl?: string; apiKey?: string; channelId?: string }>(request);
    if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: parsed.status });

    const { action, baseUrl, apiKey, channelId } = parsed.data;
    if (action === "test") {
        const settings = await getFreshAuthSettings();
        const existingChannel = settings.systemChannels.find(
            (item) => item.id === (channelId || "easyframe-minimax-h3") || item.advancedConfig?.protocol === "minimax-h3",
        );
        const targetUrl = (baseUrl || existingChannel?.baseUrl || MINIMAX_H3_DEFAULT_BASE_URL).trim();
        const targetKey = (apiKey || existingChannel?.apiKey || "").trim();

        if (!targetUrl) return NextResponse.json({ error: "Base URL 不能为空" }, { status: 400 });
        if (!targetKey) return NextResponse.json({ error: "API Key 不能为空，请先填写密钥" }, { status: 400 });

        const startedAt = Date.now();
        try {
            const probeUrl = `${targetUrl.replace(/\/+$/, "")}/v1/models`;
            const response = await fetchSafeOutbound(probeUrl, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${targetKey}`,
                    Accept: "application/json",
                },
                signal: AbortSignal.timeout(10_000),
            });
            const latencyMs = Date.now() - startedAt;
            const textBody = await response.text();
            let parsedData: Record<string, unknown> | null = null;
            try {
                parsedData = JSON.parse(textBody) as Record<string, unknown>;
            } catch {}

            if (response.ok) {
                const modelList = Array.isArray(parsedData?.data)
                    ? (parsedData.data as Array<Record<string, unknown>>).map((item) => String(item.id || "")).filter(Boolean)
                    : [];
                return NextResponse.json({
                    ok: true,
                    status: response.status,
                    latencyMs,
                    message: `连通性测试通过（耗时 ${latencyMs} ms）`,
                    models: modelList,
                });
            } else if (response.status === 401 || response.status === 403) {
                return NextResponse.json({
                    ok: false,
                    status: response.status,
                    latencyMs,
                    message: `鉴权失败（HTTP ${response.status}）：API Key 无效或未授权`,
                });
            } else {
                return NextResponse.json({
                    ok: false,
                    status: response.status,
                    latencyMs,
                    message: `上游返回 HTTP ${response.status}：${textBody.slice(0, 160)}`,
                });
            }
        } catch (error) {
            const latencyMs = Date.now() - startedAt;
            return NextResponse.json({
                ok: false,
                status: 0,
                latencyMs,
                message: `网络拨号异常：${error instanceof Error ? error.message : "请求超时或无法建立连接"}`,
            });
        }
    }

    return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}
