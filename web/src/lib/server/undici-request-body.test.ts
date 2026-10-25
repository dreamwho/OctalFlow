import { createServer } from "node:http";
import type { File } from "node:buffer";
import { fetch as undiciFetch, FormData as UndiciFormData } from "undici";
import { expect, it } from "vitest";
import { toUndiciRequestBody } from "./undici-request-body";

it("delivers UTF-8 JSON bytes unchanged to a real local HTTP upstream", async () => {
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        response.end(Buffer.concat(chunks));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
        const payload = JSON.stringify({ model: "gemini-omni-1.1-flash", prompt: "参考卧室图片生成视频" });
        const response = await undiciFetch(`http://127.0.0.1:${address.port}`, { method: "POST", body: await toUndiciRequestBody(new TextEncoder().encode(payload)) });
        expect(await response.text()).toBe(payload);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

it.each([FormData, UndiciFormData])("retains multipart text and files from %s", async (Form) => {
    const input = new Form();
    input.append("prompt", "保留参考图片");
    input.append("image", new Blob(["fixture"], { type: "image/png" }), "image.png");
    const output = await toUndiciRequestBody(input as FormData) as UndiciFormData;
    expect(output.get("prompt")).toBe("保留参考图片");
    const file = output.get("image") as File;
    expect(file.name).toBe("image.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("fixture");
});
