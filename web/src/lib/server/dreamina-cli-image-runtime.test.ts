import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { buildDreaminaCliSubmitArgs } from "./dreamina-cli-catalog";
import { buildDreaminaCliSeedreamImageSubmission, readSafeImageOutput } from "./dreamina-cli-image-runtime";

type Fixture = Parameters<typeof buildDreaminaCliSeedreamImageSubmission>[0];

function fixture(input: Partial<Fixture> & { config: Fixture["config"] }): Fixture {
    return {
        config: input.config,
        prompt: input.prompt || "一张测试图片",
        references: input.references || [],
    };
}

describe("Dreamina Seedream image runtime fixtures", () => {
    it("maps a text-only exact canvas size to CLI width and height", () => {
        const input = buildDreaminaCliSeedreamImageSubmission(
            fixture({
                config: { channelId: "dreamina-cli", model: "dreamina-seedream-5-0", quality: "high", size: "2048x2048" } as Fixture["config"],
                prompt: "一张商业海报",
            }),
            [],
        );

        expect(input).toMatchObject({ command: "text2image", modelId: "dreamina-seedream-5-0", resolutionType: "4k", width: 2048, height: 2048 });
        expect(buildDreaminaCliSubmitArgs(input)).toEqual(["text2image", "--prompt=一张商业海报", "--width=2048", "--height=2048", "--resolution_type=4k", "--model_version=5.0", "--poll=0"]);
    });

    it("maps one to ten staged references to image2image and preserves all output candidates", () => {
        const task = fixture({
            config: { channelId: "dreamina-cli", model: "dreamina-seedream-5-0-pro", quality: "unsupported", size: "3:4" } as Fixture["config"],
            prompt: "改成水彩风格",
            references: [{ dataUrl: "/api/reference-assets/first.png" }, { dataUrl: "/api/generation-log-assets/second.png" }],
        });
        const input = buildDreaminaCliSeedreamImageSubmission(task, ["/sandbox/input-1.png", "/sandbox/input-2.png"]);

        expect(input).toMatchObject({ command: "image2image", resolutionType: "2k", ratio: "3:4", images: ["/sandbox/input-1.png", "/sandbox/input-2.png"] });
        expect(buildDreaminaCliSubmitArgs(input)).toEqual(["image2image", "--images=/sandbox/input-1.png,/sandbox/input-2.png", "--prompt=改成水彩风格", "--ratio=3:4", "--resolution_type=2k", "--model_version=5.0Pro", "--poll=0"]);
    });

    it("uses supported quality tiers only and rejects incompatible commands before spawn", () => {
        const text = buildDreaminaCliSeedreamImageSubmission(fixture({ config: { channelId: "dreamina-cli", model: "dreamina-seedream-3-0", quality: "low", size: "auto" } as Fixture["config"] }), []);
        expect(text).toMatchObject({ command: "text2image", resolutionType: "1k" });
        expect(text.ratio).toBeUndefined(); // CLI documents omitted ratio as its 16:9 default.
        const pro = buildDreaminaCliSeedreamImageSubmission(fixture({ config: { channelId: "dreamina-cli", model: "dreamina-seedream-5-0-pro", quality: "low", size: "16:9" } as Fixture["config"] }), []);
        expect(pro).toMatchObject({ command: "text2image", resolutionType: "1.5k" });

        expect(() =>
            buildDreaminaCliSeedreamImageSubmission(
                fixture({
                    config: { channelId: "dreamina-cli", model: "dreamina-seedream-3-0", quality: "2k", size: "1:1" } as Fixture["config"],
                    references: [{ dataUrl: "/api/reference-assets/source.png" }],
                }),
                ["/sandbox/input-1.png"],
            ),
        ).toThrow("不支持当前生成方式");
        expect(() => buildDreaminaCliSeedreamImageSubmission(fixture({ config: { channelId: "dreamina-cli", model: "dreamina-seedream-5-0", size: "5:4" } as Fixture["config"] }), [])).toThrow("官方比例或精确宽x高");
    });

    it("losslessly repacks an oversized upscale PNG without changing its dimensions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "dreamina-upscale-fixture-"));
        try {
            const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#41536b" } })
                .png()
                .toBuffer();
            const file = join(directory, "upscale.png");
            await writeFile(file, Buffer.concat([png, Buffer.alloc(21 * 1024 * 1024)]));

            const result = await readSafeImageOutput(file, directory, true);

            expect(result).toMatchObject({ mimeType: "image/webp", width: 64, height: 48 });
            expect(result.bytes).toBeLessThan(20 * 1024 * 1024);
            const output = Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(",") + 1), "base64");
            await expect(sharp(output).metadata()).resolves.toMatchObject({ format: "webp", width: 64, height: 48 });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
