import { describe, expect, it } from "vitest";

import type { AuthSettings } from "@/lib/auth/store";
import { DEFAULT_USER_ROLE } from "@/lib/user-roles";
import { configuredModelFallback } from "./model-fallback";

function settings(): Pick<AuthSettings, "logicalModels" | "systemChannels" | "userRoles"> {
    return {
        userRoles: [structuredClone(DEFAULT_USER_ROLE)],
        systemChannels: [{ id: "channel", name: "渠道", enabled: true, apiFormat: "openai", baseUrl: "https://example.com/v1", apiKey: "fixture-key", models: ["gpt-image-2"] }],
        logicalModels: [
            { id: "primary", name: "主模型", enabled: true, capability: "image", fallbackModelId: "backup", bindings: [{ id: "one", channelId: "channel", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
            { id: "backup", name: "备用模型", enabled: true, capability: "image", bindings: [{ id: "two", channelId: "channel", upstreamModel: "gpt-image-2", enabled: true, priority: 1 }] },
        ],
    };
}

describe("configured model fallback offer", () => {
    it("returns only the configured public identity without credentials", () => {
        expect(configuredModelFallback(settings(), "user", "primary", "image")).toEqual({ id: "backup", name: "备用模型", sourceName: "主模型" });
    });

    it("does not offer a model forbidden to an ordinary role", () => {
        const input = settings();
        input.userRoles[0].modelAccess = { all: false, capabilities: [], modelIds: ["primary"], excludedModelIds: [] };
        expect(configuredModelFallback(input, "user", "primary", "image")).toBeNull();
        expect(configuredModelFallback(input, "admin", "primary", "image")?.id).toBe("backup");
        input.userRoles[0].modelAccess.modelIds = ["backup"];
        expect(configuredModelFallback(input, "user", "primary", "image")).toBeNull();
    });

    it("requires the current enabled same-capability resolvable target", () => {
        for (const mutate of [
            (value: ReturnType<typeof settings>) => { value.logicalModels[1].enabled = false; },
            (value: ReturnType<typeof settings>) => { value.logicalModels[1].capability = "video"; },
            (value: ReturnType<typeof settings>) => { value.systemChannels[0].enabled = false; },
            (value: ReturnType<typeof settings>) => { value.logicalModels[0].fallbackModelId = "primary"; },
            (value: ReturnType<typeof settings>) => { value.logicalModels[0].fallbackModelId = "missing"; },
        ]) {
            const input = settings();
            mutate(input);
            expect(configuredModelFallback(input, "user", "primary", "image")).toBeNull();
        }
    });
});
