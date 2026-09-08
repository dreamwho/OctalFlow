import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { readJsonBodyResult } from "@/lib/auth/request";
import { GeminiAiProviderError } from "@/lib/server/geminiai-provider";
import { auditGeminiAiAdminAction, auditGeminiAiAdminFailure, geminiAiRouteError, requireGeminiAiAdmin } from "@/lib/server/geminiai-admin";
import { runGeminiAiImageTest, runGeminiAiSearchTest, runGeminiAiTextTest } from "@/lib/server/geminiai-service";
import { createGeminiAiVideoTest, refreshGeminiAiVideoTest } from "@/lib/server/geminiai-test-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TestBody = {
    capability?: unknown;
    model?: unknown;
    prompt?: unknown;
    options?: { size?: unknown; quality?: unknown; aspectRatio?: unknown; imageSize?: unknown; googleSearch?: unknown; channelId?: unknown };
};

export async function GET(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId") || "";
    const channelId = url.searchParams.get("channelId") || "";
    try {
        const data = await refreshGeminiAiVideoTest(request, access.user, taskId, channelId);
        await auditGeminiAiAdminAction(request, access.user, "admin.geminiai.test.video_status", { type: "geminiai_video_test", id: taskId }, { channelId: data.channelId, status: data.status });
        return apiSuccess(data);
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, "admin.geminiai.test.video_status", { type: "geminiai_video_test", id: taskId });
        return geminiAiRouteError(error, "读取 Gemini/Veo 视频测试状态失败");
    }
}

export async function POST(request: Request) {
    const access = await requireGeminiAiAdmin();
    if ("error" in access) return access.error;
    const parsed = await readJsonBodyResult<TestBody>(request);
    if (!parsed.ok) return apiCompatError(parsed.status, parsed.message);
    const body = parsed.data;
    const capability = typeof body.capability === "string" ? body.capability.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const startedAt = Date.now();
    try {
        const data =
            capability === "video"
                ? await createGeminiAiVideoTest(request, access.user, { model, prompt: body.prompt, channelId: body.options?.channelId, size: body.options?.size, quality: body.options?.quality })
                : capability === "image"
                  ? {
                        status: "succeeded" as const,
                        elapsedMs: 0,
                        ...(await runGeminiAiImageTest({ userId: access.user.id, model, prompt: body.prompt, aspectRatio: body.options?.aspectRatio, imageSize: body.options?.imageSize })),
                    }
                  : capability === "search" || (capability === "text" && body.options?.googleSearch === true)
                    ? { status: "succeeded" as const, elapsedMs: 0, ...(await runGeminiAiSearchTest({ model, prompt: body.prompt })) }
                    : capability === "text"
                      ? { status: "succeeded" as const, elapsedMs: 0, ...(await runGeminiAiTextTest({ model, prompt: body.prompt })) }
                      : null;
        if (!data) return apiCompatError(400, "测试能力无效");
        const result = { ...data, ...(capability === "video" ? {} : { elapsedMs: Date.now() - startedAt }) };
        const channelId = capability === "video" && "channelId" in result ? result.channelId : undefined;
        await auditGeminiAiAdminAction(request, access.user, `admin.geminiai.test.${capability}`, { type: "geminiai_model_test", id: model }, { capability, channelId, status: result.status });
        return apiSuccess(result, result.status === "failed" ? "模型测试失败" : "模型测试完成");
    } catch (error) {
        await auditGeminiAiAdminFailure(request, access.user, `admin.geminiai.test.${capability || "unknown"}`, { type: "geminiai_model_test", id: model });
        if (error instanceof GeminiAiProviderError && error.status >= 500) {
            return apiSuccess({ status: "failed", model, elapsedMs: Date.now() - startedAt, error: error.message }, "模型测试失败");
        }
        return geminiAiRouteError(error, "GeminiAI 模型测试失败");
    }
}
