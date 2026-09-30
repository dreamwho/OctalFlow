import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureMagicProxyProvider, getMagicProxyOverview, resolveGenericProxyNodeUrl } = vi.hoisted(() => ({
    ensureMagicProxyProvider: vi.fn(),
    getMagicProxyOverview: vi.fn(),
    resolveGenericProxyNodeUrl: vi.fn(),
}));

vi.mock("@/lib/server/magic-proxy-service", () => ({ ensureMagicProxyProvider, getMagicProxyOverview }));
vi.mock("@/lib/server/chatgpt-api-service", () => ({ resolveGenericProxyNodeUrl }));

import { dolaRequestHasReferences, resolveDolaImagexUploadEgress, resolveDolaLoginProxySelection } from "./proxy";

describe("Dola Google authorization proxy selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ensureMagicProxyProvider.mockResolvedValue({ enabled: true, proxyUrl: "http://127.0.0.1:17893", egress: { mode: "chained", node_name: "Hong Kong → Taiwan" } });
        getMagicProxyOverview.mockResolvedValue({ bindings: { dola: { enabled: true, mode: "chained", chained_config: { landing_node_id: "taiwan" } } } });
        resolveGenericProxyNodeUrl.mockResolvedValue("http://127.0.0.1:1080");
    });

    it("follows the saved Dola chain by default", async () => {
        expect(await resolveDolaLoginProxySelection()).toEqual({ proxyUrl: "http://127.0.0.1:17893", egress: { mode: "chained", target: "Hong Kong → Taiwan", nodeName: "Hong Kong → Taiwan", address: undefined } });
    });

    it("uses direct only for an explicit authorization override", async () => {
        expect(await resolveDolaLoginProxySelection({ mode: "direct" })).toEqual({ egress: { mode: "direct" } });
        expect(ensureMagicProxyProvider).not.toHaveBeenCalled();
    });

    it("resolves an explicit generic node without changing the Dola binding", async () => {
        expect(await resolveDolaLoginProxySelection({ mode: "generic", target: "node:tw" })).toEqual({ proxyUrl: "http://127.0.0.1:1080", egress: { mode: "generic", target: "node:tw" } });
        expect(resolveGenericProxyNodeUrl).toHaveBeenCalledWith("tw");
        expect(ensureMagicProxyProvider).not.toHaveBeenCalled();
    });

    it("rejects stale chain targets instead of silently switching egress", async () => {
        await expect(resolveDolaLoginProxySelection({ mode: "chained", target: "old" })).rejects.toThrow(/当前绑定不一致/);
        expect(ensureMagicProxyProvider).not.toHaveBeenCalled();
    });
});

describe("Dola ImageX upload proxy selection", () => {
    beforeEach(() => vi.clearAllMocks());

    it("does not require the upload configuration for text-only generation", async () => {
        ensureMagicProxyProvider.mockRejectedValue(new Error("Dola 上传出口配置暂时不可读取"));
        await expect(resolveDolaImagexUploadEgress(false)).resolves.toEqual({ mode: "direct", source: "direct" });
        expect(ensureMagicProxyProvider).not.toHaveBeenCalled();
        await expect(resolveDolaImagexUploadEgress(true)).rejects.toThrow("Dola 上传出口配置暂时不可读取");
        expect(dolaRequestHasReferences({ prompt: "生成一段视频" })).toBe(false);
        expect(dolaRequestHasReferences({ references: [{ url: "https://example.com/reference.png" }] })).toBe(true);
        expect(dolaRequestHasReferences({ first_frame: "https://example.com/first.png" })).toBe(true);
    });

    it("keeps uploads direct when the independent binding is disabled", async () => {
        ensureMagicProxyProvider.mockResolvedValue({ enabled: false });
        await expect(resolveDolaImagexUploadEgress()).resolves.toEqual({ mode: "direct", source: "direct" });
        expect(ensureMagicProxyProvider).toHaveBeenCalledWith("dolaUpload");
    });

    it.each(["magic", "generic", "chained"] as const)("routes uploads over its selected %s outlet", async (mode) => {
        const proxyUrl = mode === "generic" ? "http://generic.test:1080" : "http://127.0.0.1:17894/";
        ensureMagicProxyProvider.mockResolvedValue({ enabled: true, proxyUrl, egress: { mode } });
        await expect(resolveDolaImagexUploadEgress()).resolves.toEqual({ mode: "managed", proxyUrl, source: mode });
        expect(ensureMagicProxyProvider).toHaveBeenCalledWith("dolaUpload");
    });
});
