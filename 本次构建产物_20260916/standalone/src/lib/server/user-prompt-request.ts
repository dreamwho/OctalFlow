import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { readJsonBody } from "@/lib/auth/request";
import type { PromptInput } from "@/lib/prompts/store";
import { readRequestBodyBytes } from "@/lib/server/request-body-limit";
import type { PromptCoverUpload } from "@/lib/server/user-prompt-service";

export const USER_PROMPT_MULTIPART_MAX_BYTES = CREATIVE_UPLOAD_MAX_BYTES + 1024 * 1024;

export async function readUserPromptMutationRequest(request: Request): Promise<{ input: PromptInput; cover?: PromptCoverUpload }> {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return { input: await readJsonBody<PromptInput>(request) };

    const bytes = await readRequestBodyBytes(request, USER_PROMPT_MULTIPART_MAX_BYTES);
    const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
    const rawPayload = form.get("payload");
    if (typeof rawPayload !== "string") throw new UserPromptRequestError("提示词请求格式不正确");
    let input: PromptInput;
    try {
        input = JSON.parse(rawPayload) as PromptInput;
    } catch {
        throw new UserPromptRequestError("提示词请求格式不正确");
    }
    const file = form.get("cover");
    return {
        input,
        ...(file instanceof File
            ? {
                  cover: {
                      bytes: new Uint8Array(await file.arrayBuffer()),
                      mimeType: file.type,
                      originalName: file.name,
                  },
              }
            : {}),
    };
}

export class UserPromptRequestError extends Error {
    status = 400;
}
