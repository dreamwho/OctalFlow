import { describe, expect, it } from "vitest";

import { chatGptProxyRuntimeInput, chatGptProxyRuntimeStatus } from "./use-chatgpt-proxy-runtime";

const manualRuntime = { enabled: false, mode: "native" as const, native_source: "manual" as const, magicConfigured: false, ipwoConfigured: false };

describe("ChatGPT 代理总控选择", () => {
    it("only writes the complete persisted selection and preserves the inactive management source for magic", () => {
        expect(chatGptProxyRuntimeInput("manual", true, manualRuntime)).toEqual({ enabled: true, mode: "native", native_source: "manual" });
        expect(chatGptProxyRuntimeInput("ipwo", true, manualRuntime)).toEqual({ enabled: true, mode: "native", native_source: "ipwo" });
        expect(chatGptProxyRuntimeInput("magic", true, { ...manualRuntime, native_source: "ipwo" })).toEqual({ enabled: true, mode: "magic", native_source: "ipwo" });
        expect(chatGptProxyRuntimeInput("chained", true, { ...manualRuntime, native_source: "ipwo" })).toEqual({
            enabled: true,
            mode: "chained",
            native_source: "ipwo",
            chained_config: {
                hop_magic_node_name: "",
                landing_generic_node_id: "",
            },
        });
        expect(chatGptProxyRuntimeInput("ipwo", false, manualRuntime)).toEqual({ enabled: false, mode: "native", native_source: "ipwo" });
    });

    it("reports direct-off and unavailable selected sources without inventing a fallback", () => {
        expect(chatGptProxyRuntimeStatus(manualRuntime)).toBe("全局代理已关闭：所有请求均不使用代理。");
        expect(chatGptProxyRuntimeStatus({ ...manualRuntime, enabled: true, mode: "magic" })).toContain("运行时会拒绝请求");
        expect(chatGptProxyRuntimeStatus({ ...manualRuntime, enabled: true, mode: "chained" })).toContain("跳板或落地节点尚未选择完毕");
        expect(chatGptProxyRuntimeStatus({ ...manualRuntime, enabled: true, mode: "chained", chained_config: { hop_magic_node_name: "HK", landing_generic_node_id: "node1" } })).toContain("当前使用链式代理");
        expect(chatGptProxyRuntimeStatus({ ...manualRuntime, enabled: true, native_source: "ipwo" })).toContain("运行时会拒绝请求");
        expect(chatGptProxyRuntimeStatus({ ...manualRuntime, enabled: true, native_source: "ipwo", ipwoConfigured: true })).toBe("当前使用代理管理中的 IPWO 来源。");
    });
});
