import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { magicProxyBindingValidationMessage, magicProxyNodeOption } from "./magic-proxy-binding-card";

describe("magic proxy provider binding card", () => {
    it("requires a node before enabling and allows disabling without one", () => {
        expect(magicProxyBindingValidationMessage(true)).toBe("启用魔法代理前请选择代理节点");
        expect(magicProxyBindingValidationMessage(true, "  ")).toBe("启用魔法代理前请选择代理节点");
        expect(magicProxyBindingValidationMessage(true, "节点 A")).toBe("");
        expect(magicProxyBindingValidationMessage(false)).toBe("");
    });

    it("uses the node name and type for the select option", () => {
        expect(magicProxyNodeOption({ name: "节点 A", type: "url-test" })).toEqual({ value: "节点 A", label: "节点 A · url-test" });
    });

    it("keeps provider binding controls on provider pages and preserves account proxy wording", () => {
        const source = readFileSync(new URL("./magic-proxy-binding-card.tsx", import.meta.url), "utf8");

        expect(source).toContain("title={`${providerLabels[provider]} · 魔法代理`}");
        expect(source).toContain('chatgptApi: "GPTAPI"');
        expect(source).toContain("使用魔法代理");
        expect(source).toContain("代理节点");
        expect(source).toContain("onChange={(checked) => void persist(checked, node)}");
        expect(source).toContain("onChange={(value: string) => void persist(enabled, value)}");
        expect(source).toContain("GeminiTools 账号列表中的账号启用开关仍保持原有含义");
        expect(source).toContain('provider === "geminiTools"');
        expect(source).toContain("启用魔法代理前请选择代理节点");
        expect(source).not.toContain("proxyEnabled");
    });
});
