import { afterEach, describe, expect, it, vi } from "vitest";

import { syncGeminiToolsModels } from "./gemini-tools";

describe("GeminiTools admin API client", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("uses the explicit sync endpoint and sends the opt-in enable flag only when requested", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            Response.json({
                code: 0,
                data: {
                    accountResults: [{ id: "account-one", ok: true }],
                    discoveredModels: [{ id: "provider-new-model", name: "Provider New Model" }],
                    newModels: [{ id: "provider-new-model", name: "Provider New Model" }],
                    enabledNewModelIds: ["provider-new-model"],
                    overview: { configured: true, healthy: true, accounts: [], apiKeys: [], gateway: { enabled: true, strategy: "round_robin", sessionStickiness: false }, logs: { items: [], total: 0, page: 1, pageSize: 8 }, models: [] },
                },
                msg: "OK",
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(syncGeminiToolsModels({ enableNewModels: true })).resolves.toMatchObject({ enabledNewModelIds: ["provider-new-model"] });

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/gemini-tools/models/sync", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify({ enableNewModels: true }) }));
    });
});
