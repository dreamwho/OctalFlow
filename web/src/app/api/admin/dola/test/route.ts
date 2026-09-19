import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { testDolaVideo } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{ model?: unknown; prompt?: unknown; duration?: unknown; ratio?: unknown; references?: unknown }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    if (typeof parsed.data.model !== "string" || typeof parsed.data.prompt !== "string") return apiCompatError(400, "模型和提示词不能为空");
    let references: Array<{ dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }>;
    try {
        references = normalizeTestReferences(parsed.data.references);
    } catch (error) {
        return apiCompatError(400, error instanceof Error ? error.message : "测试参考图格式无效");
    }
    try {
        const result = await testDolaVideo({ model: parsed.data.model, prompt: parsed.data.prompt, duration: Number(parsed.data.duration), ratio: typeof parsed.data.ratio === "string" ? parsed.data.ratio : "16:9", references });
        await auditDolaAdminAction(request, access.user, "admin.dola.test", { type: "dola_test", id: result.taskId || parsed.data.model });
        return apiSuccess(result, "Dola 测试请求已提交");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.test", { type: "dola_test", id: parsed.data.model });
        return dolaRouteError(error, "Dola 测试请求失败");
    }
}

function normalizeTestReferences(value: unknown) {
    if (value === undefined) return [] as Array<{ dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }>;
    if (!Array.isArray(value) || value.length > 4) throw new Error("测试参考图最多 4 张");
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("测试参考图格式无效");
        const record = item as Record<string, unknown>;
        const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl.trim() : "";
        const url = typeof record.url === "string" ? record.url.trim() : "";
        if (!dataUrl && !url) throw new Error("测试参考图缺少地址");
        if (!dataUrl && url) throw new Error("测试窗口参考图必须通过上传进入");
        if (dataUrl && (!dataUrl.startsWith("data:image/") || dataUrl.length > 3_000_000)) throw new Error("测试参考图必须是 3MB 以内的图片");
        return {
            ...(dataUrl ? { dataUrl } : { url }),
            ...(typeof record.role === "string" ? { role: record.role.slice(0, 40) } : {}),
            ...(typeof record.name === "string" ? { name: record.name.slice(0, 160) } : {}),
            ...(typeof record.mime === "string" ? { mime: record.mime.slice(0, 80) } : {}),
        };
    });
}
