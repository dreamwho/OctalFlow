import { describe, expect, it } from "vitest";

import { flattenPublicCapabilityModels, resolvePublicCapabilityModels } from "./public-model-catalog";

describe("resolvePublicCapabilityModels", () => {
    const fallback = { image: ["image-upstream"], video: ["video-upstream"], text: ["text-upstream"], audio: ["audio-upstream"] };

    it("uses logical models only for capabilities that define them", () => {
        const result = resolvePublicCapabilityModels([{ id: "text-logical", capability: "text" }], fallback);

        expect(result).toEqual({ image: ["image-upstream"], video: ["video-upstream"], text: ["text-logical"], audio: ["audio-upstream"] });
    });

    it("uses the complete logical catalog when every capability defines models", () => {
        const result = resolvePublicCapabilityModels(
            [
                { id: "image-logical", capability: "image" },
                { id: "video-logical", capability: "video" },
                { id: "text-logical", capability: "text" },
                { id: "audio-logical", capability: "audio" },
            ],
            fallback,
        );

        expect(flattenPublicCapabilityModels(result)).toEqual(["image-logical", "video-logical", "text-logical", "audio-logical"]);
    });

    it("preserves logical ordering and returns an empty picker when a configured capability is fully hidden", () => {
        const result = resolvePublicCapabilityModels(
            [
                { id: "image-second", capability: "image" as const },
                { id: "image-first", capability: "image" as const, pickerVisible: false },
                { id: "video-hidden", capability: "video" as const, pickerVisible: false },
            ],
            fallback,
        );

        expect(result.image).toEqual(["image-second"]);
        expect(result.video).toEqual([]);
        expect(result.text).toEqual(["text-upstream"]);
    });
});
