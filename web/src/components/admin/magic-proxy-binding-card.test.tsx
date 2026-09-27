import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { flatMagicProxyOptions, groupMagicProxyOptions, magicProxyBindingValidationMessage, magicProxyNodeOption } from "./magic-proxy-binding-card";
import type { MagicProxyNode } from "@/services/api/magic-proxy";

describe("magic proxy provider binding card", () => {
    it("requires a node before enabling and allows disabling without one", () => {
        expect(magicProxyBindingValidationMessage(true)).toBe("启用魔法代理前请选择代理节点");
        expect(magicProxyBindingValidationMessage(true, "  ")).toBe("启用魔法代理前请选择代理节点");
        expect(magicProxyBindingValidationMessage(true, "节点 A")).toBe("");
        expect(magicProxyBindingValidationMessage(false)).toBe("");
    });

    it("uses the node name and type for the select option", () => {
        expect(magicProxyNodeOption({ name: "节点 A", type: "url-test" })).toEqual({ value: "节点 A", label: "节点 A · url-test" });
        expect(magicProxyNodeOption({ name: "节点 B", type: "ss", delay: 156 })).toEqual({ value: "节点 B", label: "节点 B · ss (156ms)" });
        expect(magicProxyNodeOption({ name: "节点 C", type: "vmess", subscriptionName: "一元机场", delay: 88 })).toEqual({ value: "节点 C", label: "[一元机场] 节点 C · vmess (88ms)" });
        expect(magicProxyNodeOption({ name: "节点 D", type: "trojan", alive: false })).toEqual({ value: "节点 D", label: "节点 D · trojan (不可用)" });
    });

    it("groups node options by subscription so long lists stay selectable", () => {
        const nodes: MagicProxyNode[] = [
            { name: "日本 1", type: "vless", subscriptionName: "红茶云" },
            { name: "香港 1", type: "vless", subscriptionName: "红茶云" },
            { name: "IEPL 1", type: "ss", subscriptionName: "一元机场" },
            { name: "孤儿节点", type: "ss" },
        ];
        const groups = groupMagicProxyOptions(nodes, [{ label: "订阅策略组", options: [{ value: "自动选择", label: "自动选择 · url-test 自动选优" }] }]);
        expect(groups.map((grp) => grp.label)).toEqual(["订阅策略组", "红茶云", "一元机场", "未分组订阅"]);
        expect(flatMagicProxyOptions(groups).map((option) => option.value)).toEqual(["自动选择", "日本 1", "香港 1", "IEPL 1", "孤儿节点"]);
    });

    it("lists subscription policy groups as auto-select egress options", () => {
        const source = readFileSync(new URL("./magic-proxy-binding-card.tsx", import.meta.url), "utf8");
        expect(source).toContain("state?.subscriptionGroups");
        expect(source).toContain("自动选优");
    });

    it("hides unavailable nodes from the selectable options while keeping the current binding visible", () => {
        const source = readFileSync(new URL("./magic-proxy-binding-card.tsx", import.meta.url), "utf8");
        expect(source).toContain("nodes.filter((item) => item.alive !== false)");
        expect(source).toContain("当前绑定");
    });

    it("keeps provider binding controls on provider pages and preserves account proxy wording", () => {
        const source = readFileSync(new URL("./magic-proxy-binding-card.tsx", import.meta.url), "utf8");

        expect(source).toContain("title={`${providerLabels[provider]} · 代理管理`}");
        expect(source).toContain('chatgptApi: "GPTAPI"');
        expect(source).toContain('dola: "Dola API"');
        expect(source).toContain("testChatGptChain");
        expect(source).toContain('测试 {provider === "chatgptApi" ? "ChatGPT" : provider === "dola" ? "Dola" : "Google"} 连通性');
        expect(source).toContain("启用代理");
        expect(source).toContain("代理方式");
        expect(source).toContain("魔法节点");
        expect(source).toContain("代理管理出口（节点或整组）");
        expect(source).toContain("GeminiTools 账号列表中的账号启用开关仍保持原有含义");
        expect(source).toContain('provider === "geminiTools"');
        expect(source).toContain("启用魔法代理前请选择代理节点");
        expect(source).not.toContain("proxyEnabled");
    });
});
