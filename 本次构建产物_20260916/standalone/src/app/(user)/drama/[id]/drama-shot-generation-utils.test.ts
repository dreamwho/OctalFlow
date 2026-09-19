import { describe, expect, it } from "vitest";

import { shotReferenceImages, storyboardReferenceImages } from "./drama-shot-generation-utils";

describe("storyboardReferenceImages", () => {
    it("marks the storyboard start and end images as explicit video frames", () => {
        const references = storyboardReferenceImages({
            id: "shot-one",
            title: "雨夜相遇",
            storyboardFrameMode: "first_last",
            storyboardImageUrl: "/api/reference-assets/start.png",
            storyboardImageWidth: 1280,
            storyboardImageHeight: 720,
            storyboardEndImageUrl: "/api/reference-assets/end.png",
            storyboardEndImageWidth: 1280,
            storyboardEndImageHeight: 720,
        } as never);

        expect(references).toMatchObject([
            { id: "storyboard-start-shot-one", videoRole: "first_frame", serverUrl: "/api/reference-assets/start.png" },
            { id: "storyboard-end-shot-one", videoRole: "last_frame", serverUrl: "/api/reference-assets/end.png" },
        ]);
    });

    it("uses a single storyboard as a normal visual reference instead of an unsupported local first-frame upload", () => {
        const references = storyboardReferenceImages({
            id: "shot-two",
            title: "单帧分镜",
            storyboardFrameMode: "single",
            storyboardImageUrl: "https://cdn.example.com/start.png",
            storyboardEndImageUrl: "https://cdn.example.com/end.png",
        } as never);

        expect(references).toEqual([expect.objectContaining({ id: "storyboard-start-shot-two", remoteUrl: "https://cdn.example.com/start.png" })]);
        expect(references[0]).not.toHaveProperty("videoRole");
    });

    it("keeps an unspecified legacy single-frame storyboard in normal reference mode", () => {
        const references = storyboardReferenceImages({ id: "legacy", title: "旧分镜", storyboardImageUrl: "/api/generation-log-assets/start.png" } as never);

        expect(references[0]).toMatchObject({ id: "storyboard-start-legacy", serverUrl: "/api/generation-log-assets/start.png" });
        expect(references[0]).not.toHaveProperty("videoRole");
    });

    it("keeps every matching project reference instead of taking the first four", () => {
        const characters = Array.from({ length: 5 }, (_, index) => ({ id: `character-${index}`, name: `角色 ${index}`, references: [{ id: `reference-${index}`, url: `/api/reference-assets/${index}.png` }], primaryReferenceId: `reference-${index}` }));
        const references = shotReferenceImages({ characters, scenes: [], props: [], sourceAssets: [] } as never, { characterIds: characters.map((item) => item.id), propIds: [] } as never);

        expect(references).toHaveLength(5);
        expect(references.at(-1)).toMatchObject({ id: "character-4", serverUrl: "/api/reference-assets/4.png" });
    });
});
