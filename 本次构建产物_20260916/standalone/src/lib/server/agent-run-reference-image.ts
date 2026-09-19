import sharp from "sharp";

import { fetchInternalApi } from "@/lib/server/internal-origin";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 48_000_000;
// /api/text-tasks accepts a 4 MiB JSON body. Keep each base64 vision part small
// enough for prompts and multiple references to share that documented budget.
const MAX_INLINE_BYTES = 700 * 1024;

export async function inlineAgentReferenceImage(value: string, origin: string, cookie: string, signal?: AbortSignal) {
    const source = await readAgentReferenceImage(value.trim(), origin, cookie, signal);
    if (!source.length) throw new Error("参考图片内容为空");
    const attempts = [
        { width: 1280, quality: 78 },
        { width: 1024, quality: 68 },
        { width: 768, quality: 60 },
    ];
    for (const attempt of attempts) {
        const bytes = await sharp(source, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({ width: attempt.width, height: attempt.width, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: attempt.quality, mozjpeg: true })
            .toBuffer();
        if (bytes.length <= MAX_INLINE_BYTES) return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
    throw new Error("参考图片压缩后仍超过视觉理解请求大小");
}

async function readAgentReferenceImage(value: string, origin: string, cookie: string, signal?: AbortSignal) {
    const data = value.match(/^data:image\/[^;,]+;base64,(.+)$/is);
    if (data) {
        const bytes = Buffer.from(data[1].replace(/\s/g, ""), "base64");
        if (bytes.length > MAX_SOURCE_BYTES) throw new Error("参考图片超过大小限制");
        return bytes;
    }
    const response = value.startsWith("/api/")
        ? await fetchInternalApi(`${origin}${value}`, { headers: cookie ? { cookie } : undefined, cache: "no-store", signal })
        : /^https:\/\//i.test(value)
          ? await fetchSafeOutbound(value, { redirect: "follow", signal })
          : null;
    if (!response?.ok || !response.body) throw new Error(`参考图片读取失败${response ? `（HTTP ${response.status}）` : ""}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("image/")) throw new Error("参考素材不是有效图片");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) throw new Error("参考图片超过大小限制");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        total += chunk.byteLength;
        if (total > MAX_SOURCE_BYTES) {
            await reader.cancel("Reference image is too large");
            throw new Error("参考图片超过大小限制");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
