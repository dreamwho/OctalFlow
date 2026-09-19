import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDolaUnwatermarkedUrl, decodeDolaVideoUrl, resolveDolaWatermarkUrl, resolveDolaWatermarkUrlRemote } from "./watermark-url";

const SALT = Buffer.from("4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58", "hex");

function fixtureToken(url: string, seed: Buffer) {
    const d1 = createHash("sha512").update(seed.subarray(0, 32)).digest();
    const d2 = createHash("sha512").update(Buffer.concat([d1, SALT])).digest();
    const cipher = createCipheriv("aes-128-cbc", d2.subarray(0, 16), d2.subarray(16, 32));
    return Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(Buffer.from(url)), cipher.final()]).toString("base64url");
}

describe("Dola URL watermark resolver", () => {
    it("preserves the signed fallback URL and applies the verified query contract", () => {
        const result = new URL(buildDolaUnwatermarkedUrl("https://vod-urls-mya.byteintlapi.com/video?foo=bar&sig=private"));
        expect(result.searchParams.get("foo")).toBe("bar");
        expect(result.searchParams.get("channel")).toBe("no");
        expect(result.searchParams.get("codec_type")).toBe("8");
        expect(result.searchParams.get("logo_type")).toBe("unwatermarked");
    });

    it("decodes the observed QAAB token without exposing token material", () => {
        const seed = randomBytes(32);
        const url = "https://v16-dola.dola.com/demo.mp4?sig=fixture";
        expect(decodeDolaVideoUrl(fixtureToken(url, seed), seed.toString("base64url"))).toBe(url);
    });

    it("resolves nested VOD payloads and rejects non-Dola media", () => {
        const seed = randomBytes(32);
        const payload = { video_info: { data: { key_seed: seed.toString("base64url"), video_list: { hd: { main_url: fixtureToken("https://v16-dola.dola.com/demo.mp4", seed), width: 1280, height: 720 } } } }, video_model: { fallback_api: "https://vod-urls-mya.byteintlapi.com/video?sig=fixture" } };
        const result = resolveDolaWatermarkUrl(payload);
        expect(result.variant.width).toBe(1280);
        expect(result.downloadUrl).toBe("https://v16-dola.dola.com/demo.mp4");
        expect(() => decodeDolaVideoUrl(fixtureToken("https://example.com/demo.mp4", seed), seed.toString("base64url"))).toThrow("不在允许范围");
    });

    it("fetches the verified no-watermark VOD response before decoding", async () => {
        const seed = randomBytes(32);
        const fallbackApi = "https://vod-urls-mya.byteintlapi.com/video?sig=fixture";
        let requestedUrl = "";
        const result = await resolveDolaWatermarkUrlRemote(
            { result: { fallback_api: fallbackApi }, key_seed: seed.toString("base64url") },
            {
                fetchJson: async (url) => {
                    requestedUrl = url;
                    return { data: { video_info: { data: { video_list: { hd: { main_url: fixtureToken("https://v16-dola.dola.com/no-watermark.mp4", seed), width: 1920, height: 1080 } } } } } };
                },
            },
        );
        const request = new URL(requestedUrl);
        expect(request.searchParams.get("channel")).toBe("no");
        expect(request.searchParams.get("codec_type")).toBe("8");
        expect(request.searchParams.get("logo_type")).toBe("unwatermarked");
        expect(result.downloadUrl).toBe("https://v16-dola.dola.com/no-watermark.mp4");
    });
});
