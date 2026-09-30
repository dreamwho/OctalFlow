import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { MagicProxyRepository } from "./magic-proxy-repository";

const updatedAt = "2026-09-07T08:00:00.000Z";
const row = {
    subscription_url_ciphertext: "cipher:subscription",
    nodes_ciphertext: "cipher:nodes",
    subscriptions_ciphertext: "cipher:subscriptions",
    node_delays_ciphertext: "cipher:delays",
    geminiai_enabled: false,
    geminiai_node: null,
    gemini_tools_enabled: true,
    gemini_tools_node: "Tokyo-01",
    gemini_tools_fallback_node: "Osaka-02",
    chatgpt_api_enabled: false,
    chatgpt_api_node: null,
    chatgpt_api_mode: "chained",
    chatgpt_api_chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-1", hop_fallback_node: "Osaka-02" },
    dola_enabled: false,
    dola_node: null,
    dola_upload_enabled: true,
    dola_upload_node: "Upload-01",
    updated_at: new Date(updatedAt),
};

function repositoryWith(query: ReturnType<typeof vi.fn>) {
    return new MagicProxyRepository({ query } as unknown as QueryExecutor);
}

describe("MagicProxyRepository", () => {
    it("loads only the singleton encrypted settings row", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });

        await expect(repositoryWith(query).get()).resolves.toEqual({
            subscriptionUrlCiphertext: "cipher:subscription",
            nodesCiphertext: "cipher:nodes",
            subscriptionsCiphertext: "cipher:subscriptions",
            nodeDelaysCiphertext: "cipher:delays",
            // 兜底节点必须从 PostgreSQL 列读回：缺列会让保存“成功”后读回为空（界面表现为内容消失）。
            bindings: {
                geminiai: { enabled: false },
                geminiTools: { enabled: true, node: "Tokyo-01", fallback_node: "Osaka-02" },
                // 链式跳板兜底必须从 JSONB 读回，缺字段会让保存后界面为空
                chatgptApi: { enabled: false, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-1", hop_fallback_node: "Osaka-02" } },
                dola: { enabled: false },
                dolaUpload: { enabled: true, node: "Upload-01" },
            },
            updatedAt,
        });
        expect(query).toHaveBeenCalledWith("SELECT * FROM magic_proxy_settings WHERE id = 'default'");
    });

    it("persists encrypted payloads and bindings through parameterized singleton upsert", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });

        await repositoryWith(query).save({
            subscriptionUrlCiphertext: "cipher:subscription",
            nodesCiphertext: "cipher:nodes",
            subscriptionsCiphertext: "cipher:subscriptions",
            nodeDelaysCiphertext: "cipher:delays",
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: true, node: "Tokyo-01", fallback_node: "Osaka-02" }, chatgptApi: { enabled: false }, dola: { enabled: false }, dolaUpload: { enabled: true, node: "Upload-01" } },
            updatedAt,
        });

        expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO magic_proxy_settings");
        expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (id) DO UPDATE");
        expect(query.mock.calls[0]?.[0]).toContain("gemini_tools_fallback_node=EXCLUDED.gemini_tools_fallback_node");
        expect(query.mock.calls[0]?.[1]).toEqual(["cipher:subscription", "cipher:nodes", "cipher:subscriptions", "cipher:delays", false, null, "magic", null, null, true, "Tokyo-01", "magic", "Osaka-02", null, false, null, "magic", null, null, false, null, "magic", null, null, true, "Upload-01", "magic", null, null, new Date(updatedAt)]);
    });
});
