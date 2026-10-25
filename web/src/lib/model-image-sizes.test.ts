import { describe, expect, it } from "vitest";
import { configuredModelImageSizes, hasOnlyFixedImageSizes } from "./model-image-sizes";
import { applyPublicSystemSettings, defaultConfig } from "@/stores/use-config-store";

function fixture() {
    return applyPublicSystemSettings(structuredClone(defaultConfig), {
        systemChannels: [{ id: "newapi", name: "New API", baseUrl: "/api/ai/system/newapi", apiKey: "system", apiFormat: "openai", models: ["gpt-image-2.5"], enabled: true, hasApiKey: true }],
        logicalModels: [{ id: "image", name: "Image", capability: "image", enabled: true, bindings: [{ id: "b", channelId: "newapi", upstreamModel: "gpt-image-2.5", enabled: true, priority: 1, capabilityProfile: { aspectRatios: ["1024x1024", "1536x1024"] } }] }],
    });
}

describe("configured image size choices", () => {
    it("retains exact pixel values through public config hydration and renders proportional icons", () => {
        const options = configuredModelImageSizes(fixture(), "image");
        expect(options?.map((item) => item.value)).toEqual(["1024x1024", "1536x1024"]);
        expect(options?.[1].label).toBe("1536×1024");
        expect(options![1].width / options![1].height).toBeCloseTo(1.5);
        expect(hasOnlyFixedImageSizes(options)).toBe(true);
    });

    it("uses the selected binding, excluding disabled or lower-priority bindings", () => {
        const config = fixture();
        config.logicalModels[0].bindings.unshift({ id: "disabled", channelId: "newapi", upstreamModel: "gpt-image-2.5", enabled: false, priority: 0, capabilityProfile: { aspectRatios: ["16:9"] } });
        config.logicalModels[0].bindings.push({ id: "other", channelId: "newapi", upstreamModel: "gpt-image-2.5", enabled: true, priority: 2, capabilityProfile: { aspectRatios: ["9:16"] } });
        expect(configuredModelImageSizes(config, "image")?.map((item) => item.value)).toEqual(["1024x1024", "1536x1024"]);
    });

    it("keeps ratios distinct from fixed pixels and restores defaults when cleared", () => {
        const config = fixture();
        config.logicalModels[0].bindings[0].capabilityProfile = { aspectRatios: ["16:9", "1:1"] };
        expect(hasOnlyFixedImageSizes(configuredModelImageSizes(config, "image"))).toBe(false);
        config.logicalModels[0].bindings[0].capabilityProfile = { aspectRatios: [] };
        expect(configuredModelImageSizes(config, "image")).toBeUndefined();
    });
});
