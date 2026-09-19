import { describe, expect, it } from "vitest";

import { readUserPromptMutationRequest } from "./user-prompt-request";

describe("readUserPromptMutationRequest", () => {
    it("reads prompt fields and a cover from multipart form data", async () => {
        const body = new FormData();
        body.set("payload", JSON.stringify({ title: "标题", prompt: "内容", tags: ["海报"] }));
        body.set("cover", new File(["image"], "cover.png", { type: "image/png" }));

        const result = await readUserPromptMutationRequest(new Request("http://localhost/api/my-prompts", { method: "POST", body }));

        expect(result.input).toMatchObject({ title: "标题", prompt: "内容", tags: ["海报"] });
        expect(result.cover).toMatchObject({ mimeType: "image/png", originalName: "cover.png" });
        expect(result.cover?.bytes).toEqual(new Uint8Array(Buffer.from("image")));
    });

    it("rejects multipart form data without a JSON payload", async () => {
        const body = new FormData();
        body.set("cover", new File(["image"], "cover.png", { type: "image/png" }));

        await expect(readUserPromptMutationRequest(new Request("http://localhost/api/my-prompts", { method: "POST", body }))).rejects.toThrow("提示词请求格式不正确");
    });
});
