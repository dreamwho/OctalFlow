import { describe, expect, it } from "vitest";

import type { GeminiAiModel } from "@/services/api/geminiai";

import { geminiAiAccountHealthText, geminiAiAccountUsage, geminiAiModelCapabilities, geminiAiModelsForCapability, geminiAiSelectableModels, geminiAiSelectedModelIds, geminiAiTestTabs } from "./geminiai-view-model";

describe("GeminiAI admin view model", () => {
    it.each([["ready", "登录正常"], ["login_required", "需重新授权"], ["unavailable", "连接异常"], ["error", "页面异常"], [undefined, "未检测"]] as const)("maps health status %s", (status, label) => {
        expect(geminiAiAccountHealthText(status)).toBe(label);
    });
    const models: GeminiAiModel[] = [
        { id: "gemini-text", capabilities: ["text", "search"], enabled: true, source: "geminiai" },
        { id: "gemini-image", capabilities: ["image"], enabled: false, source: "geminiai" },
        { id: "gemini-unconfigured", capabilities: ["text"], source: "geminiai" },
        { id: "veo-official", capabilities: ["video"], channelId: "official-veo", source: "gemini", enabled: true },
        { id: "disabled-video", capabilities: ["video"], enabled: false },
    ];

    it("keeps all requested capability tabs, including official-only video", () => {
        expect(geminiAiTestTabs.map((tab) => tab.capability)).toEqual(["text", "image", "video", "search"]);
    });

    it("filters models strictly by server-declared capability and enabled state", () => {
        expect(geminiAiModelsForCapability(models, "text").map((model) => model.id)).toEqual(["gemini-text", "gemini-unconfigured"]);
        expect(geminiAiModelsForCapability(models, "search").map((model) => model.id)).toEqual(["gemini-text"]);
        expect(geminiAiModelsForCapability(models, "video").map((model) => model.id)).toEqual(["veo-official"]);
    });

    it("adds search only when the server explicitly declares it", () => {
        expect(geminiAiModelCapabilities({ id: "one", capabilities: ["text"], supportsSearch: true })).toEqual(["text", "search"]);
        expect(geminiAiModelCapabilities({ id: "two", capabilities: ["text"] })).toEqual(["text"]);
    });

    it("only allows GeminiAI-source models to be selected for the GeminiAI channel", () => {
        expect(geminiAiSelectableModels(models).map((model) => model.id)).toEqual(["gemini-text", "gemini-image", "gemini-unconfigured"]);
        expect(geminiAiSelectedModelIds(models)).toEqual(["gemini-text"]);
    });

    it("renders account usage without exposing credential fields", () => {
        expect(geminiAiAccountUsage({ id: "one", usage: { used: 1, limit: 10 } })).toBe("1/10");
        expect(geminiAiAccountUsage({ id: "two" })).toBe("—");
    });
});
