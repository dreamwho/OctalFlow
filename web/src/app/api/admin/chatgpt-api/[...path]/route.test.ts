import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as unknown, runtime: vi.fn(), runtimeRequest: vi.fn(), selection: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: () => state.user }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: () => ({ id: "fixture" }), safeRecordAuditLog: state.audit }));
vi.mock("@/lib/server/chatgpt-api-models", () => ({ getChatGptSavedModels: () => ({ models: [] }), saveChatGptModels: () => ({ models: [] }) }));
vi.mock("@/lib/server/chatgpt-api-service", async (original) => ({ ...(await original<typeof import("@/lib/server/chatgpt-api-service")>()), chatGptRuntimeJson: state.runtime, chatGptRuntimeRequest: state.runtimeRequest, syncChatGptMagicProxy: vi.fn(), updateChatGptProxySelection: state.selection }));
import { DELETE, GET, PATCH, POST } from "./route";
afterEach(() => {
    vi.clearAllMocks();
    state.user = null;
});
const context = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });
describe("ChatGPT management authorization", () => {
    it("exposes read-only log details with credentials and raw detail removed", async () => {
        const url = "http://canvas.test/api/admin/chatgpt-api/logs/fixture-log";
        expect((await GET(new Request(url), context("logs/fixture-log"))).status).toBe(401);
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        state.runtime.mockResolvedValue({ id: "fixture-log", display_status: "running", raw_detail: { secret: "hidden" }, access_token: "hidden" });
        const response = await GET(new Request(url), context("logs/fixture-log"));
        const body = await response.json();
        expect(body).toMatchObject({ data: { id: "fixture-log", display_status: "running" } });
        expect(JSON.stringify(body)).not.toContain("hidden");
        expect(state.runtime).toHaveBeenCalledWith("/api/logs/fixture-log", expect.objectContaining({ method: "GET" }));
        expect((await POST(new Request(url, { method: "POST" }), context("logs/fixture-log"))).status).toBe(404);
    });
    it("requires a session and the upstream responsibility before contacting runtime", async () => {
        expect((await GET(new Request("http://canvas.test/api/admin/chatgpt-api/accounts"), context("accounts"))).status).toBe(401);
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["audit.read"] };
        expect((await GET(new Request("http://canvas.test/api/admin/chatgpt-api/accounts"), context("accounts"))).status).toBe(403);
        expect(state.runtime).not.toHaveBeenCalled();
    });
    it("blocks credential export and arbitrary management routes", async () => {
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        for (const path of ["accounts/export", "accounts/fixture/access-token", "system/update", "../settings"]) {
            expect((await GET(new Request("http://canvas.test/api/admin/chatgpt-api/unknown"), context(path))).status).toBe(404);
        }
        expect(state.runtime).not.toHaveBeenCalled();
    });
    it("allows key creation but never includes the key or request body in audit", async () => {
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        state.runtime.mockResolvedValue({ item: { id: "key-fixture", enabled: true }, raw_key: "created-secret", refresh_token: "must-not-return" });
        const response = await POST(new Request("http://canvas.test/api/admin/chatgpt-api/keys", { method: "POST", body: '{"name":"private key"}' }), context("keys"));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: 0, data: { raw_key: "created-secret" } });
        expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/created-secret|private key|must-not-return/);
    });
    it("only exposes read-only statistics to authorized administrators", async () => {
        const url = "http://canvas.test/api/admin/chatgpt-api/statistics?time_range=7d";
        expect((await GET(new Request(url), context("statistics"))).status).toBe(401);
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        state.runtime.mockResolvedValue({ totals: { total: 3 } });
        expect((await GET(new Request(url), context("statistics"))).status).toBe(200);
        expect(state.runtime).toHaveBeenCalledWith("/integration/statistics?time_range=7d", expect.objectContaining({ method: "GET" }));
        expect((await POST(new Request(url, { method: "POST", body: "{}" }), context("statistics"))).status).toBe(404);
    });
    it("forwards explicit proxy management routes without logging private input", async () => {
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        state.runtime.mockResolvedValue({ revision: "fixture" });
        for (const path of ["proxies/defaults", "proxies/groups", "proxies/groups/test", "proxies/nodes/import"]) {
            const response = await POST(new Request(`http://canvas.test/api/admin/chatgpt-api/${path}`, { method: "POST", body: JSON.stringify({ text: "http://fixture:private-password@proxy.test:8123" }) }), context(path));
            expect(response.status).toBe(200);
            expect(state.runtime).toHaveBeenLastCalledWith(`/api/proxy/${path.slice("proxies/".length)}`, expect.objectContaining({ method: "POST" }));
        }
        expect((await DELETE(new Request("http://canvas.test/delete", { method: "DELETE" }), context("proxies/groups/fixture"))).status).toBe(200);
        expect(state.runtime).toHaveBeenLastCalledWith("/api/proxy/groups/fixture", expect.objectContaining({ method: "DELETE" }));
        expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/private-password|proxy.test/);
        expect((await POST(new Request("http://canvas.test/unknown", { method: "POST" }), context("proxies/clearance/test"))).status).toBe(404);
    });
    it("uses the explicit proxy-selection bridge and never treats IPWO as an arbitrary route", async () => {
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        state.runtime.mockResolvedValue({ enabled: false, mode: "native", native_source: "manual", magicConfigured: false, ipwoConfigured: false });
        state.selection.mockResolvedValue({ enabled: true, mode: "native", native_source: "ipwo", magicConfigured: false, ipwoConfigured: true });
        expect((await GET(new Request("http://canvas.test/api/admin/chatgpt-api/proxy-selection"), context("proxy-selection"))).status).toBe(200);
        expect(state.runtime).toHaveBeenLastCalledWith("/integration/proxy-selection", expect.objectContaining({ method: "GET" }));
        const patch = await PATCH(new Request("http://canvas.test/api/admin/chatgpt-api/proxy-selection", {
            method: "PATCH",
            body: JSON.stringify({ enabled: true, mode: "native", native_source: "ipwo" }),
        }), context("proxy-selection"));
        expect(patch.status).toBe(200);
        expect(state.selection).toHaveBeenCalledWith({ enabled: true, mode: "native", native_source: "ipwo" });
        expect((await POST(new Request("http://canvas.test/api/admin/chatgpt-api/ipwo/unknown", { method: "POST", body: "{}" }), context("ipwo/unknown"))).status).toBe(404);
    });
    it("forwards the IPWO diagnostic as an unbuffered NDJSON stream", async () => {
        state.user = { id: "fixture", role: "admin", status: "active", adminPermissions: ["upstream.manage"] };
        const encoder = new TextEncoder();
        state.runtimeRequest.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('{"status":"running"}\n'));
                controller.enqueue(encoder.encode('{"status":"success","done":true}\n'));
                controller.close();
            },
        }), { headers: { "content-type": "application/x-ndjson" } }));
        const response = await POST(new Request("http://canvas.test/api/admin/chatgpt-api/ipwo/test", { method: "POST", body: "{}" }), context("ipwo/test"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/x-ndjson");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        expect(await response.text()).toBe('{"status":"running"}\n{"status":"success","done":true}\n');
        expect(state.runtimeRequest).toHaveBeenCalledWith("/integration/ipwo/test", expect.objectContaining({ method: "POST" }));
        expect(state.runtime).not.toHaveBeenCalled();
    });
});
