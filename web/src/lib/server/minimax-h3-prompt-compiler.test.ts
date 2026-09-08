import { describe, expect, it } from "vitest";

import {
    compileMinimaxH3Prompt,
    createMinimaxH3ReferenceBindings,
    rebindMinimaxH3ReferenceUrls,
} from "./minimax-h3-prompt-compiler";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

const references: VideoGenerationReference[] = [
    { type: "image", url: "https://assets.example.com/portrait.png", role: "reference" },
    { type: "video", url: "https://assets.example.com/motion.mp4", role: "reference" },
    { type: "image", url: "https://assets.example.com/scene.png", role: "reference" },
];

const sourceReferences = [
    { ...references[0], assetId: "asset-portrait", alias: "图片1" },
    { ...references[1], assetId: "asset-motion", alias: "视频1" },
    { ...references[2], nodeId: "canvas-scene", alias: "图片2" },
];

describe("MiniMax H3 prompt compiler", () => {
    it("activates only for resolved H3 protocols and preserves a non-H3 prompt byte-for-byte", () => {
        const prompt = "  @图片1 保持人物，@图片2 改成夜景。  ";
        const compiled = compileMinimaxH3Prompt({ protocol: "seedance", prompt, references });

        expect(compiled).toMatchObject({ applied: false, prompt });
        expect(compiled.referenceBindings.map((binding) => binding.label)).toEqual(["<Picture 1>", "<Video 1>", "<Picture 2>"]);
    });

    it("keeps H3 Ref2VA asset identity, aliases, roles, types, and original array order locked", () => {
        const unsigned = references.map((reference) => ({ ...reference }));
        const signed = unsigned.map((reference, index) => ({ ...reference, url: `${reference.url}?provider-read=${index + 1}` }));
        const bindings = rebindMinimaxH3ReferenceUrls(createMinimaxH3ReferenceBindings(unsigned, sourceReferences), signed);
        const compiled = compileMinimaxH3Prompt({
            protocol: "minimax-h3-official",
            prompt: "@图片1 保持人物，@图片2 替换为傍晚场景；@视频1 只参考运动节奏。",
            durationSeconds: 7,
            references: signed,
            referenceBindings: bindings,
        });

        expect(unsigned).toEqual(references);
        expect(compiled).toMatchObject({ applied: true, mode: "ref2va" });
        expect(compiled.prompt).toContain("subject_definitions:");
        expect(compiled.prompt).toContain("@图片1");
        expect(compiled.prompt).toContain("@图片2");
        expect(compiled.prompt).toContain("7.00 seconds");
        expect(compiled.referenceBindings.map(({ referenceIndex, type, role, assetId, nodeId, alias, url }) => ({ referenceIndex, type, role, assetId, nodeId, alias, url }))).toEqual([
            { referenceIndex: 0, type: "image", role: "reference", assetId: "asset-portrait", nodeId: undefined, alias: "图片1", url: signed[0].url },
            { referenceIndex: 1, type: "video", role: "reference", assetId: "asset-motion", nodeId: undefined, alias: "视频1", url: signed[1].url },
            { referenceIndex: 2, type: "image", role: "reference", assetId: undefined, nodeId: "canvas-scene", alias: "图片2", url: signed[2].url },
        ]);
    });

    it.each([
        ["t2va", [], "t2va"],
        ["i2va", [{ type: "image", url: "https://assets.example.com/first.png", role: "first_frame" }], "i2va"],
        [
            "fl2va",
            [
                { type: "image", url: "https://assets.example.com/first.png", role: "first_frame" },
                { type: "image", url: "https://assets.example.com/last.png", role: "last_frame" },
            ],
            "fl2va",
        ],
        ["l2va", [{ type: "image", url: "https://assets.example.com/last.png", role: "last_frame" }], "l2va"],
    ] as const)("compiles %s without inventing a fixed duration", (_name, modeReferences, mode) => {
        const compiled = compileMinimaxH3Prompt({ protocol: "minimax-h3", prompt: "A continuous shot", durationSeconds: 8.5, references: modeReferences });

        expect(compiled).toMatchObject({ applied: true, mode });
        expect(compiled.prompt).toContain("integrated_multimodal_description:");
        if (mode === "fl2va" || mode === "l2va") expect(compiled.prompt).toContain("8.50 seconds");
        if (mode === "fl2va") expect(compiled.referenceBindings.map((binding) => binding.label)).toEqual(["<Picture 1>", "<Picture 2>"]);
        if (mode === "l2va") expect(compiled.referenceBindings.map((binding) => binding.label)).toEqual(["<Picture 1>"]);
        expect(compiled.prompt).not.toContain("15.00 seconds");
    });

    it("adds a lock to an existing H3 structured prompt instead of nesting another Ref2VA template", () => {
        const prompt = "subject_definitions:\n<Video 1> keeps timing.\n\nsummary:\nExisting prompt.\n\nretention_analysis:\nKeep continuity.\n\ndetailed_description:\nExisting shot.\n\noverall_soundscape:\nN/A.\n\nnon_diegetic_music:\nN/A.";
        const compiled = compileMinimaxH3Prompt({ protocol: "minimax-h3", prompt, references: [references[1]] });

        expect(compiled.mode).toBe("ref2va");
        expect(compiled.prompt.match(/^subject_definitions:/gm)).toHaveLength(1);
        expect(compiled.prompt).toContain("Reference binding lock:");
    });

    it("refuses ambiguous source identity metadata instead of silently rebinding a duplicate URL", () => {
        const duplicate: VideoGenerationReference[] = [{ type: "image", url: "https://assets.example.com/same.png", role: "reference" }];

        expect(() =>
            createMinimaxH3ReferenceBindings(duplicate, [
                { ...duplicate[0], assetId: "asset-one" },
                { ...duplicate[0], assetId: "asset-two" },
            ]),
        ).toThrow("无法安全绑定");
    });
});
