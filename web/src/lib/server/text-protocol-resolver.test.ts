import { describe, expect, it } from "vitest";

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

import { resolveTextProtocol } from "./text-protocol-resolver";

describe("text protocol resolver", () => {
    it("routes a provider-managed GPTAPI model through the standard chat workbench contract", () => {
        const advancedConfig = {
            ...emptyAdvancedConfig(),
            protocol: "chatgpt-api" as const,
            authMode: "provider-managed" as const,
            modelConfigs: {
                "gpt-5.6": { capability: "text" as const, protocol: "chatgpt-api" as const, apiFormat: "openai" as const, createPath: "/chat/completions" },
            },
        };

        expect(resolveTextProtocol({ model: "gpt-5.6", apiFormat: "openai", advancedConfig })).toMatchObject({ kind: "chat", path: "/chat/completions" });
    });
});
