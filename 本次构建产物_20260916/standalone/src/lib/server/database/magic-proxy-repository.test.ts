import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "./postgres";
import { MagicProxyRepository } from "./magic-proxy-repository";

const updatedAt = "2026-09-07T08:00:00.000Z";
const row = {
    subscription_url_ciphertext: "cipher:subscription",
    nodes_ciphertext: "cipher:nodes",
    geminiai_enabled: false,
    geminiai_node: null,
    gemini_tools_enabled: true,
    gemini_tools_node: "Tokyo-01",
    chatgpt_api_enabled: false,
    chatgpt_api_node: null,
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
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: true, node: "Tokyo-01" }, chatgptApi: { enabled: false } },
            updatedAt,
        });
        expect(query).toHaveBeenCalledWith("SELECT * FROM magic_proxy_settings WHERE id = 'default'");
    });

    it("persists encrypted payloads and bindings through parameterized singleton upsert", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });

        await repositoryWith(query).save({
            subscriptionUrlCiphertext: "cipher:subscription",
            nodesCiphertext: "cipher:nodes",
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: true, node: "Tokyo-01" }, chatgptApi: { enabled: false } },
            updatedAt,
        });

        expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO magic_proxy_settings");
        expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (id) DO UPDATE");
        expect(query.mock.calls[0]?.[1]).toEqual(["cipher:subscription", "cipher:nodes", false, null, "magic", null, true, "Tokyo-01", "magic", null, false, null, "magic", null, new Date(updatedAt)]);
    });
});
