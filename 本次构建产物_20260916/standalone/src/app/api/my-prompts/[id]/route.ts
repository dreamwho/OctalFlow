import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { RequestBodyTooLargeError } from "@/lib/server/request-body-limit";
import { readUserPromptMutationRequest, UserPromptRequestError } from "@/lib/server/user-prompt-request";
import { deleteUserPrompt, updateUserPrompt, UserPromptServiceError } from "@/lib/server/user-prompt-service";

export const runtime = "nodejs";

type RouteContext = {
    params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    try {
        const { id } = await context.params;
        const body = await readUserPromptMutationRequest(request);
        const prompt = await updateUserPrompt(currentUser.id, id, body.input, body.cover);
        return NextResponse.json({ prompt });
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "图片文件不能超过 20MB" }, { status: error.status });
        if (error instanceof UserPromptRequestError || error instanceof UserPromptServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Update user prompt failed", error);
        return NextResponse.json({ error: "更新提示词失败" }, { status: 500 });
    }
}

export async function DELETE(_request: Request, context: RouteContext) {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    try {
        const { id } = await context.params;
        await deleteUserPrompt(currentUser.id, id);
        return NextResponse.json({ ok: true });
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Delete user prompt failed", error);
        return NextResponse.json({ error: "删除提示词失败" }, { status: 500 });
    }
}
