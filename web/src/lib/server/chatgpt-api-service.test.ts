import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
const magic = vi.hoisted(() => {
    class FixtureMagicProxyError extends Error {
        constructor(message: string, readonly status = 502) {
            super(message);
        }
    }
    return { ensure: vi.fn(), MagicProxyError: FixtureMagicProxyError };
});
vi.mock("@/lib/server/magic-proxy-service", () => ({ ensureMagicProxyProvider: magic.ensure, MagicProxyError: magic.MagicProxyError }));
import { chatGptRuntimeJson, chatGptRuntimeRequest, readChatGptSignedMedia, rewriteChatGptMedia, rewriteChatGptStream, sanitizeChatGptAdminResult, syncChatGptMagicProxy, updateChatGptProxySelection } from "./chatgpt-api-service";
import { resolveSafeOutboundTarget } from "./outbound-url-security";

let server: Server | undefined;
afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
    }
});
async function fixture() {
    const seen: Array<{ url: string; key: string; authorization: string; body: string }> = [];
    server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
            seen.push({ url: request.url || "", key: String(request.headers["x-octal-runtime-key"]), authorization: request.headers.authorization || "", body: Buffer.concat(chunks).toString("utf8") });
        if (request.url === "/images/result.png") {
            if (request.headers["x-octal-internal-dispatch"] !== "1" || request.headers.authorization !== `Bearer ${request.headers["x-octal-runtime-key"]}`) {
                response.writeHead(503);
                response.end("public gateway disabled");
                return;
            }
            response.writeHead(200, { "content-type": "image/png" });
            response.end("fixture-image");
        } else if (request.url === "/failure") {
            response.writeHead(403, { "content-type": "application/json" });
            response.end('{"detail":{"error":"Bearer leakedcredential denied"}}');
        } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
        }
        });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture unavailable");
    vi.stubEnv("OCTALAICANVAS_CHATGPT_API_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("OCTALAICANVAS_CHATGPT_API_KEY", "fixture-private-runtime-key-32-characters");
    return seen;
}
describe("ChatGPT internal transport", () => {
    it("keeps runtime authentication private while forwarding a distinct external key", async () => {
        const seen = await fixture();
        expect(await chatGptRuntimeJson("/integration/health")).toEqual({ ok: true });
        const response = await chatGptRuntimeRequest("/v1/models", {}, "fixture-client-key");
        await response.text();
        expect(seen[0].authorization).toBe(`Bearer ${seen[0].key}`);
        expect(seen[1].authorization).toBe("Bearer fixture-client-key");
        expect(seen[1].key).toBe(seen[0].key);
        await expect(chatGptRuntimeRequest("//other-host/private")).rejects.toThrow("路径无效");
    });
    it("preserves native HTTP status while stripping secrets from errors and administration results", async () => {
        await fixture();
        await expect(chatGptRuntimeJson("/failure")).rejects.toMatchObject({ status: 403, message: "Bearer [redacted] denied" });
        expect(sanitizeChatGptAdminResult({ items: [{ access_token: "private", refresh_token: "private", status: "ok" }], raw_key: "secret" })).toEqual({ items: [{ status: "ok" }] });
        expect(sanitizeChatGptAdminResult({ raw_key: "created-once" }, true)).toEqual({ raw_key: "created-once" });
        expect(
            sanitizeChatGptAdminResult({
                items: [{ id: "log-1", proxy: { address: "secret" }, proxy_egress: { mode: "generic", address: "us.ipwo.net:7878" } }],
            }),
        ).toEqual({ items: [{ id: "log-1", proxy_egress: { mode: "generic", address: "us.ipwo.net:7878" } }] });
        expect(sanitizeChatGptAdminResult({ message: 'upstream {"refresh_token":"private secret"}' })).not.toEqual(expect.objectContaining({ message: expect.stringContaining("private secret") }));
    });
    it("skips Magic outside an active Magic selection and validates selection before preparation", async () => {
        const seen = await fixture();
        magic.ensure.mockResolvedValue({ enabled: true, proxyUrl: "http://magic-listener.test:17892" });
        await syncChatGptMagicProxy();
        expect(magic.ensure).not.toHaveBeenCalled();
        await expect(updateChatGptProxySelection(null)).rejects.toMatchObject({ status: 400 });
        await expect(updateChatGptProxySelection({ enabled: true, mode: "magic", native_source: "manual", extra: true })).rejects.toMatchObject({ status: 400 });
        await expect(updateChatGptProxySelection({ enabled: true, mode: "invalid", native_source: "manual" })).rejects.toMatchObject({ status: 400 });
        expect(magic.ensure).not.toHaveBeenCalled();
        expect(seen).toHaveLength(1);
        await updateChatGptProxySelection({ enabled: true, mode: "magic", native_source: "manual" });
        expect(magic.ensure).toHaveBeenCalledTimes(1);
        expect(seen.slice(1).map((item) => [item.url, item.body])).toEqual([
            ["/integration/proxy", '{"proxyUrl":"http://magic-listener.test:17892"}'],
            ["/integration/proxy-selection", '{"enabled":true,"mode":"magic","native_source":"manual"}'],
        ]);
    });
    it("rejects enabling Magic without a saved binding and skips the runtime push", async () => {
        const seen = await fixture();
        magic.ensure.mockResolvedValue({ enabled: false });
        await expect(updateChatGptProxySelection({ enabled: true, mode: "magic", native_source: "manual" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("保存魔法节点") });
        expect(magic.ensure).toHaveBeenCalledTimes(1);
        expect(seen.filter((item) => item.url === "/integration/proxy")).toHaveLength(0);
    });
    it("rewrites internal media into signed bounded links, rejects tampering and expires links", async () => {
        const seen = await fixture();
        const rewritten = rewriteChatGptMedia({ data: [{ url: "http://runtime:80/images/result.png" }] }, "https://canvas.example") as { data: Array<{ url: string }> };
        const url = new URL(rewritten.data[0].url);
        expect(url.origin).toBe("https://canvas.example");
        const response = await readChatGptSignedMedia("/images/result.png", url, new AbortController().signal);
        expect(await response.text()).toBe("fixture-image");
        url.searchParams.set("signature", "invalid");
        await expect(readChatGptSignedMedia("/images/result.png", url, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
        expect(seen).toHaveLength(1);
        url.searchParams.set("expires", "1");
        await expect(readChatGptSignedMedia("/images/result.png", url, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    });
    it("keeps SSE boundaries and DONE while rewriting URLs split across chunks", async () => {
        await fixture();
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"url":"http://runtime/images/res'));
                controller.enqueue(encoder.encode('ult.png"}\n\ndata: [DONE]\n\n'));
                controller.close();
            },
        });
        const result = await new Response(rewriteChatGptStream(body, "https://canvas.example")).text();
        expect(result).toContain("https://canvas.example/api/chatgpt-api/media/images/result.png?");
        expect(result).toContain("\n\ndata: [DONE]\n\n");
    });
    it("rejects reference URLs in the administrator private-upstream allowlist when public-only is requested", async () => {
        vi.stubEnv("OCTALAICANVAS_ALLOW_PRIVATE_UPSTREAMS", "1");
        vi.stubEnv("OCTALAICANVAS_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
        expect(await resolveSafeOutboundTarget("http://127.0.0.1:3000/secret")).not.toBeNull();
        expect(await resolveSafeOutboundTarget("http://127.0.0.1:3000/secret", { publicOnly: true })).toBeNull();
    });
});
