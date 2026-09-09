import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeGeneratedImageBytes } from "./generated-image-normalizer";

describe("generated image normalization", () => {
    it("keeps the upstream image bytes untouched regardless of the requested target size", async () => {
        const source = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#7c8da5" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png");

        expect(result).toMatchObject({ mimeType: "image/png", width: 1600, height: 900 });
        expect(result.bytes).toEqual(source);
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({ format: "png", width: 1600, height: 900 });
    });

    it("never upscales a small upstream image to a larger requested size", async () => {
        const source = await sharp({ create: { width: 672, height: 1008, channels: 3, background: "#9a6b4f" } })
            .png()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png");

        expect(result).toMatchObject({ mimeType: "image/png", width: 672, height: 1008 });
        expect(result.bytes).toEqual(source);
    });

    it("normalizes provider jpeg mime types from the decoded image format", async () => {
        const source = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#506070" } })
            .jpeg({ quality: 92 })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png");

        expect(result).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 720 });
        expect(result.bytes).toEqual(source);
    });

    it("reports decoded dimensions for provider webp images without altering bytes", async () => {
        const source = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#203040" } })
            .rotate(90)
            .webp()
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/webp");

        expect(result).toMatchObject({ width: 500, height: 800 });
        expect(result.bytes).toEqual(source);
    });

    it("accepts an official 8K upscale result without resizing it", async () => {
        const source = await sharp({ create: { width: 8192, height: 6178, channels: 3, background: "#27384c" } })
            .png({ compressionLevel: 9 })
            .toBuffer();
        const result = await normalizeGeneratedImageBytes(source, "image/png");

        expect(result).toMatchObject({ mimeType: "image/png", width: 8192, height: 6178 });
        expect(result.bytes).toEqual(source);
    });
});
