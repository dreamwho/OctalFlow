import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import type { AiConfig } from "@/stores/use-config-store";
import { filterModelOptions, groupModelOptions, modelProviderLabel, resolveModelIcon, type ModelOption } from "./model-picker";

describe("model picker brand icons", () => {
    it.each([
        ["MiniMax Hailuo 02", "/icons/minimax.svg"],
        ["speech-2.8-hd", "/icons/minimax.svg"],
        ["music-3.0", "/icons/minimax.svg"],
        ["cosyvoice-v3-plus", "/icons/qwen.svg"],
        ["seedance2.0fast", "/icons/doubao.svg"],
        ["Seedream 5.0 Pro", "/icons/doubao.svg"],
    ])("maps %s to its brand icon", (model, icon) => {
        expect(resolveModelIcon(model)).toBe(icon);
    });

    it("uses Nano Banana for Gemini image models, Doubao for ByteDance media, and honors a custom icon", () => {
        expect(resolveModelIcon("gemini-3-pro-image", "image")).toBe("/icons/nanobanana.svg");
        expect(resolveModelIcon("gemini-2.5-flash", "text")).toBe("/icons/gemini.svg");
        expect(resolveModelIcon("opaque-image", "image", undefined, "ByteDance Studio")).toBe("/icons/doubao.svg");
        expect(resolveModelIcon("opaque-video", "video", undefined, "Seedance Provider")).toBe("/icons/doubao.svg");
        expect(resolveModelIcon("gemini-3-pro-image", "image", "openai")).toBe("/icons/openai.svg");
    });

    it("keeps branded image icons colored in dark canvas surfaces", () => {
        const source = readFileSync(new URL("./model-picker.tsx", import.meta.url), "utf8");
        const icon = readFileSync(new URL("../../public/icons/jimeng.svg", import.meta.url), "utf8");
        const nanobanana = readFileSync(new URL("../../public/icons/nanobanana.svg", import.meta.url), "utf8");
        const doubao = readFileSync(new URL("../../public/icons/doubao.svg", import.meta.url), "utf8");

        expect(source).toContain('icon === "/icons/nanobanana.svg"');
        expect(source).toContain('icon === "/icons/doubao.svg"');
        expect(icon).toContain("linearGradient");
        expect(icon).toContain("#7BF3E2");
        expect(icon).toContain('viewBox="16 16 32 36"');
        expect(icon).not.toContain("<rect");
        expect(icon).not.toContain("#080B10");
        expect(icon).not.toContain("currentColor");
        expect(nanobanana).toContain("<svg");
        expect(doubao).toContain("<svg");
    });

    it("keeps MiniMax and Bailian icons transparent and colored", () => {
        const source = readFileSync(new URL("../../public/icons/minimax.svg", import.meta.url), "utf8");
        const qwen = readFileSync(new URL("../../public/icons/qwen.svg", import.meta.url), "utf8");

        expect(source).toContain("linearGradient");
        expect(source).not.toContain("<rect");
        expect(source).not.toContain("currentColor");
        expect(qwen).toContain("linearGradient");
        expect(qwen).not.toContain("<rect");
    });
});

describe("model picker presentation helpers", () => {
    const options: ModelOption[] = [
        { id: "gemini-3-pro-image", label: "gemini-3-pro-image", modelName: "gemini-3-pro-image", provider: modelProviderLabel("gemini-3-pro-image") },
        { id: "Seedream 5.0", label: "Seedream 5.0", modelName: "Seedream 5.0", provider: modelProviderLabel("Seedream 5.0") },
        { id: "gpt-image-2", label: "OpenAI Image", modelName: "gpt-image-2", provider: modelProviderLabel("gpt-image-2") },
    ];

    it("uses the provider hierarchy shown in the model selection board", () => {
        expect(modelProviderLabel("gemini-3-pro-image")).toBe("Google Gemini");
        expect(modelProviderLabel("Seedream 5.0")).toBe("ByteDance Seedream");
        expect(modelProviderLabel("gpt-image-2")).toBe("OpenAI");
    });

    it("uses the administrator-configured logical model group in the picker", () => {
        const config = { logicalModels: [{ id: "gpt-image-2", name: "GPT Image 2", capability: "image", pickerGroup: "自定义图片模型", enabled: true, bindings: [] }] } as unknown as AiConfig;

        expect(modelProviderLabel("gpt-image-2", config)).toBe("自定义图片模型");
    });

    it("filters by the visible name, upstream model name, or provider without adding options", () => {
        expect(filterModelOptions(options, "openai").map((option) => option.id)).toEqual(["gpt-image-2"]);
        expect(filterModelOptions(options, "seedream").map((option) => option.id)).toEqual(["Seedream 5.0"]);
        expect(filterModelOptions(options, "missing")).toEqual([]);
    });

    it("preserves configured order inside vendor groups", () => {
        const groups = groupModelOptions(options);
        expect(Array.from(groups.keys())).toEqual(["Google Gemini", "ByteDance Seedream", "OpenAI"]);
        expect(groups.get("Google Gemini")?.map((option) => option.id)).toEqual(["gemini-3-pro-image"]);
    });

    it("keeps the searchable, grouped and selected states in the rendered picker", () => {
        const source = readFileSync(new URL("./model-picker.tsx", import.meta.url), "utf8");
        expect(source).toContain("data-model-picker-panel");
        expect(source).toContain('aria-label="搜索模型名称或厂商"');
        expect(source).toContain('title="最近使用"');
        expect(source).toContain('data-state={selected ? "selected" : ""}');
    });
});
