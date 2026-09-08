import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { id: "admin-one", username: "admin", displayName: "管理员", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
const overview = {
    configured: true,
    runtimeAvailable: true,
    lastUpdatedAt: "2026-09-07T08:00:00.000Z",
    nodeCount: 1,
    nodes: [{ name: "Tokyo-01", type: "ss", alive: true, delay: 42 }],
    groups: [
        { name: "OctalFlow-GeminiAIStudio", type: "Selector", now: "DIRECT", all: ["DIRECT", "Tokyo-01"] },
        { name: "OctalFlow-GeminiTools", type: "Selector", now: "Tokyo-01", all: ["DIRECT", "Tokyo-01"] },
    ],
    bindings: { geminiai: { enabled: false }, geminiTools: { enabled: true, node: "Tokyo-01" } },
};
const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    auditAction: vi.fn(),
    auditFailure: vi.fn(),
    routeError: vi.fn((error: Error) => Response.json({ code: 500, data: null, msg: error.message }, { status: 500 })),
    readJson: vi.fn(),
    subscriptionBodyBytes: vi.fn(() => 4 * 1024 * 1024),
    getOverview: vi.fn(),
    updateBinding: vi.fn(),
    importSubscription: vi.fn(),
}));

vi.mock("@/lib/server/magic-proxy-admin", () => ({
    requireMagicProxyAdmin: mocks.requireAdmin,
    auditMagicProxyAction: mocks.auditAction,
    auditMagicProxyFailure: mocks.auditFailure,
    magicProxyRouteError: mocks.routeError,
    readMagicProxyAdminJson: mocks.readJson,
    magicProxySubscriptionRequestBodyBytes: mocks.subscriptionBodyBytes,
}));
vi.mock("@/lib/server/magic-proxy-service", () => ({
    getMagicProxyOverview: mocks.getOverview,
    updateMagicProxyBinding: mocks.updateBinding,
    importMagicProxySubscription: mocks.importSubscription,
}));

import { GET, PATCH } from "./route";
import { POST } from "./subscription/route";

describe("magic proxy admin routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireAdmin.mockResolvedValue({ user });
        mocks.getOverview.mockResolvedValue(overview);
        mocks.updateBinding.mockResolvedValue({ provider: "geminiTools", binding: { enabled: true, node: "Tokyo-01" } });
        mocks.importSubscription.mockResolvedValue({ nodeCount: 1, nodes: [{ name: "Tokyo-01", type: "ss" }], bindings: overview.bindings, lastUpdatedAt: overview.lastUpdatedAt });
    });

    it("returns the full public overview from GET", async () => {
        const response = await GET(new Request("http://localhost/api/admin/magic-proxy"));

        expect(await response!.json()).toEqual({ code: 0, data: overview, msg: "OK" });
    });

    it("returns the same full overview shape after a binding mutation while auditing only mutation metadata", async () => {
        mocks.readJson.mockResolvedValue({ provider: "geminiTools", enabled: true, node: "Tokyo-01" });
        const getResponse = await GET(new Request("http://localhost/api/admin/magic-proxy"));
        const patchResponse = await PATCH(new Request("http://localhost/api/admin/magic-proxy", { method: "PATCH", body: "{}" }));
        const getPayload = await getResponse!.json();
        const patchPayload = await patchResponse!.json();

        expect(patchPayload.data).toEqual(getPayload.data);
        expect(patchPayload.data).toEqual(overview);
        expect(patchPayload.data.groups.every((group: { now: unknown }) => typeof group.now === "string")).toBe(true);
        expect(mocks.auditAction).toHaveBeenLastCalledWith(expect.any(Request), user, "admin.magic_proxy.binding.update", { type: "magic_proxy_binding", id: "geminiTools" }, { enabled: true, nodeConfigured: true });
    });

    it("returns the same full overview shape after an import mutation while auditing only import metadata", async () => {
        mocks.readJson.mockResolvedValue({ url: "https://subscription.example/clash.yaml" });
        const getResponse = await GET(new Request("http://localhost/api/admin/magic-proxy"));
        const postResponse = await POST(new Request("http://localhost/api/admin/magic-proxy/subscription", { method: "POST", body: "{}" }));
        const getPayload = await getResponse!.json();
        const postPayload = await postResponse!.json();

        expect(postPayload.data).toEqual(getPayload.data);
        expect(postPayload.data).toEqual(overview);
        expect(postPayload.data.groups.every((group: { now: unknown }) => typeof group.now === "string")).toBe(true);
        expect(mocks.auditAction).toHaveBeenLastCalledWith(expect.any(Request), user, "admin.magic_proxy.subscription.import", { type: "magic_proxy_subscription", id: "default" }, { nodeCount: 1 });
    });

    it("accepts local subscription content with the larger request-body limit and audits it separately", async () => {
        const content = "proxies:\n  - name: Local-01\n    type: http\n    server: proxy.example\n    port: 443\n";
        mocks.readJson.mockResolvedValue({ content });
        await POST(new Request("http://localhost/api/admin/magic-proxy/subscription", { method: "POST", body: JSON.stringify({ content }) }));

        expect(mocks.readJson).toHaveBeenCalledWith(expect.any(Request), 4 * 1024 * 1024);
        expect(mocks.importSubscription).toHaveBeenCalledWith({ content });
        expect(mocks.auditAction).toHaveBeenLastCalledWith(expect.any(Request), user, "admin.magic_proxy.subscription.file_import", { type: "magic_proxy_subscription", id: "default" }, { nodeCount: 1 });
    });
});
