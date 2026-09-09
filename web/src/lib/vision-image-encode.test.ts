import { describe, expect, it } from "vitest";

import { downscaleDataUrlForVision } from "./vision-image-encode";

// 1x1 红色像素 PNG（data:image/png;base64,…）
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("downscaleDataUrlForVision", () => {
    it("keeps small data urls untouched without re-encoding", async () => {
        await expect(downscaleDataUrlForVision(TINY_PNG)).resolves.toBe(TINY_PNG);
    });

    it("passes non-data references through as-is", async () => {
        await expect(downscaleDataUrlForVision("https://example.com/photo.jpg")).resolves.toBe("https://example.com/photo.jpg");
        await expect(downscaleDataUrlForVision("/api/generation-log-assets/x")).resolves.toBe("/api/generation-log-assets/x");
        await expect(downscaleDataUrlForVision("")).resolves.toBe("");
    });

    it("respects an explicit byte budget for tiny payloads", async () => {
        // maxBytes=1 强制走压缩分支；jsdom 无 2D 画布时工具必须原样回退，不能抛错
        await expect(downscaleDataUrlForVision(TINY_PNG, { maxBytes: 1 })).resolves.toBe(TINY_PNG);
    });
});
