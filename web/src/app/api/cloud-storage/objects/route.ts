import { NextResponse } from "next/server";

import { getCloudStorageUserId } from "@/lib/server/cloud-storage-user";
import { CloudStorageError, type CloudStorageSource } from "@/lib/server/cloud-storage-service";
import { uploadCloudStorageObject } from "@/lib/server/cloud-storage-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const userId = await getCloudStorageUserId(request);
    if (!userId) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        if (!request.body) throw new CloudStorageError("上传文件为空", 400);
        const source = request.headers.get("x-dreamyo-source") as CloudStorageSource;
        let backup: { projectId: string; title: string } | undefined;
        if (source === "backup") {
            if (!request.headers.has("x-dreamyo-project-id") || !request.headers.has("x-dreamyo-project-title")) throw new CloudStorageError("缺少项目备份信息", 400);
            try { backup = { projectId: request.headers.get("x-dreamyo-project-id") || "", title: decodeURIComponent(request.headers.get("x-dreamyo-project-title") || "") }; }
            catch { throw new CloudStorageError("项目备份标题无效", 400); }
        }
        const data = await uploadCloudStorageObject({
            userId,
            source,
            bytes: Number(request.headers.get("x-dreamyo-content-bytes")),
            checksumSha256: request.headers.get("x-dreamyo-sha256") || "",
            contentType: request.headers.get("content-type") || "application/octet-stream",
            body: request.body,
            backup,
        });
        return NextResponse.json({ code: 0, data, msg: data.deduplicated ? "文件已存在" : "文件已上传" }, { status: data.deduplicated ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CloudStorageError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("Cloud storage upload failed", error);
        return NextResponse.json({ code: 502, data: null, msg: "云端文件上传失败" }, { status: 502 });
    }
}
