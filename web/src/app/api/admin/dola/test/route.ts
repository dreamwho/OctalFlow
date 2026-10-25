import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { auditDolaAdminAction, auditDolaAdminFailure, dolaRouteError, requireDolaAdmin } from "@/lib/server/dola/admin";
import { testDolaVideo } from "@/lib/server/dola/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
    const access = await requireDolaAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<{
        model?: unknown;
        prompt?: unknown;
        duration?: unknown;
        ratio?: unknown;
        references?: unknown;
        headless?: unknown;
        customCookie?: unknown;
        accountId?: unknown;
    }>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    if (typeof parsed.data.model !== "string" || typeof parsed.data.prompt !== "string") return apiCompatError(400, "模型和提示词不能为空");
    let references: Array<{ type?: "image" | "video" | "audio"; dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }>;
    try {
        references = normalizeTestReferences(parsed.data.references, parsed.data.model);
    } catch (error) {
        return apiCompatError(400, error instanceof Error ? error.message : "测试参考素材格式无效");
    }
    const headless = typeof parsed.data.headless === "boolean" ? parsed.data.headless : undefined;
    const customCookie = typeof parsed.data.customCookie === "string" && parsed.data.customCookie.trim() ? parsed.data.customCookie.trim() : undefined;
    const accountId = typeof parsed.data.accountId === "string" && parsed.data.accountId.trim() ? parsed.data.accountId.trim() : undefined;

    try {
        const result = await testDolaVideo({
            model: parsed.data.model,
            prompt: parsed.data.prompt,
            duration: Number(parsed.data.duration),
            ratio: typeof parsed.data.ratio === "string" ? parsed.data.ratio : "16:9",
            references,
            headless,
            customCookie,
            accountId,
        });
        await auditDolaAdminAction(request, access.user, "admin.dola.test", { type: "dola_test", id: result.taskId || parsed.data.model });
        return apiSuccess(result, "Dola 测试请求已提交");
    } catch (error) {
        await auditDolaAdminFailure(request, access.user, "admin.dola.test", { type: "dola_test", id: parsed.data.model });
        return dolaRouteError(error, "Dola 测试请求失败");
    }
}

function normalizeTestReferences(value: unknown, model: string) {
    if (value === undefined) return [] as Array<{ type?: "image" | "video" | "audio"; dataUrl?: string; url?: string; role?: string; name?: string; mime?: string }>;
    if (!Array.isArray(value) || value.length > 4) throw new Error("测试参考素材最多 4 份");
    return value.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("测试参考素材格式无效");
        const record = item as Record<string, unknown>;
        const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl.trim() : "";
        const url = typeof record.url === "string" ? record.url.trim() : "";
        if (!dataUrl && !url) throw new Error("测试参考素材缺少地址");
        if (!dataUrl && url) throw new Error("测试窗口参考素材必须通过上传进入");
        const kind = /^data:(image|video|audio)\//.exec(dataUrl)?.[1] as "image" | "video" | "audio" | undefined;
        if (!kind || dataUrl.length > 3_000_000) throw new Error("测试参考素材必须是 3MB 以内的图片、视频或音频");
        if (kind !== "image" && model !== "dola-seedance-2-5") throw new Error("音视频参考仅支持 Seedance 2.5");
        if (record.type && record.type !== kind) throw new Error("参考素材类型与文件不一致");
        if (typeof record.mime === "string" && record.mime.split("/", 1)[0] !== kind) throw new Error("参考素材类型与文件不一致");
        return {
            type: kind,
            dataUrl,
            ...(typeof record.role === "string" ? { role: record.role.slice(0, 40) } : {}),
            ...(typeof record.name === "string" ? { name: record.name.slice(0, 160) } : {}),
            ...(typeof record.mime === "string" ? { mime: record.mime.slice(0, 80) } : {}),
        };
    });
}
