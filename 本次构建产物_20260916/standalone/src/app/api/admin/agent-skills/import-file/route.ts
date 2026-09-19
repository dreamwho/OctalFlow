import { apiCompatError, apiSuccess } from "@/app/api/_shared/api-response";
import { AGENT_SKILL_ARCHIVE_MAX_BYTES } from "@/lib/agent-skill-import-types";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { AgentSkillRefinementError, refineImportedAgentSkill } from "@/lib/server/agent-skill-import-refiner";
import { FileAgentSkillImportError, importAgentSkillFromFile } from "@/lib/server/file-agent-skill-import";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function POST(request: Request) {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return apiCompatError(401, "请先登录");
    if (!hasAdminPermission(currentUser, "upstream.manage")) return apiCompatError(403, "需要管理员权限");

    try {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) return apiCompatError(400, "Skill 导入请求格式不正确");
        const bytes = await readRequestBodyBytes(request, AGENT_SKILL_ARCHIVE_MAX_BYTES + 1024 * 1024);
        const formData = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
        const file = formData.get("file");
        const selectedPath = formData.get("path");
        if (!(file instanceof File)) return apiCompatError(400, "请上传有效的 Skill 压缩包或 Markdown 文件");
        if (file.size > AGENT_SKILL_ARCHIVE_MAX_BYTES) return apiCompatError(413, `Skill 文件不能超过 ${Math.floor(AGENT_SKILL_ARCHIVE_MAX_BYTES / 1024 / 1024)}MB`);

        const imported = await importAgentSkillFromFile({
            fileName: file.name,
            fileBuffer: Buffer.from(await file.arrayBuffer()),
            selectedPath: typeof selectedPath === "string" ? selectedPath : undefined,
        });
        const result = imported.skill
            ? {
                  ...imported,
                  skill: await refineImportedAgentSkill({
                      skill: imported.skill,
                      requestUrl: request.url,
                      cookie: request.headers.get("cookie") || "",
                      userId: currentUser.id,
                  }),
              }
            : imported;
        return apiSuccess(result, result.skill ? "Skill 已由默认文本模型提取整理" : "请选择要提取的 Skill");
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return apiCompatError(413, `Skill 文件不能超过 ${Math.floor(AGENT_SKILL_ARCHIVE_MAX_BYTES / 1024 / 1024)}MB`);
        if (error instanceof FileAgentSkillImportError) return apiCompatError(error.status, error.message);
        if (error instanceof AgentSkillRefinementError) return apiCompatError(error.status, error.message);
        console.error("Admin local Skill import failed", error);
        return apiCompatError(500, "解析本地 Skill 文件失败");
    }
}
