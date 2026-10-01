import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    agents: [] as Array<{ options: Record<string, unknown>; close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
    fetch: vi.fn(),
    resolve: vi.fn(),
    isPublic: vi.fn(() => true),
    isProxyFakeIp: vi.fn(() => false),
    proxyUrl: vi.fn(() => ""),
    lease: vi.fn(),
}));
vi.mock("undici", () => ({
    Agent: class {
        close = vi.fn(async () => undefined);
        destroy = vi.fn(async () => undefined);
        constructor(public options: Record<string, unknown>) {
            mocks.agents.push(this);
        }
    },
    ProxyAgent: class {
        close = vi.fn(async () => undefined);
        destroy = vi.fn(async () => undefined);
        constructor(public options: Record<string, unknown>) {
            mocks.agents.push(this);
        }
    },
    fetch: mocks.fetch,
}));
vi.mock("@/lib/server/outbound-url-security", () => ({
    isPublicIpAddress: mocks.isPublic,
    isProxyFakeIpAddress: mocks.isProxyFakeIp,
    resolveSafeOutboundTarget: mocks.resolve,
}));
vi.mock("@/lib/server/proxy-dispatcher", () => ({ resolveServerProxyUrl: mocks.proxyUrl }));

vi.mock("@/lib/server/traffic-meter-client", () => ({ createTrafficLease: mocks.lease }));

import { fetchSafeOutbound, UnsafeOutboundUrlError } from "./safe-outbound-fetch";
import { GENERATION_TRANSPORT_TIMEOUT_MS } from "./generation-http-lifecycle";

describe("safe outbound fetch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.agents.length = 0;
        mocks.resolve.mockReset();
        mocks.lease.mockReset().mockResolvedValue(null);
        mocks.isPublic.mockReturnValue(true);
        mocks.proxyUrl.mockReturnValue("");
        mocks.fetch.mockResolvedValue(Response.json({ ok: true }));
    });

    it("connects to the validated IP while preserving the original Host and TLS identity", async () => {
        mocks.resolve.mockResolvedValue({ url: new URL("https://provider.example:8443/v1/models?cursor=one"), address: "8.8.8.8", family: 4 });

        await fetchSafeOutbound("https://provider.example:8443/v1/models?cursor=one", { headers: { accept: "application/json" } });

        const [requestUrl, init] = mocks.fetch.mock.calls[0];
        expect(String(requestUrl)).toBe("https://provider.example:8443/v1/models?cursor=one");
        expect(new Headers(init?.headers).get("host")).toBeNull();
        expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeTruthy();
        expect(mocks.agents[0]?.options).toMatchObject({
            headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
            bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
        });

        const connect = mocks.agents[0]?.options.connect as { servername?: string; lookup?: (hostname: string, options: { all?: boolean }, callback: (error: Error | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void) => void };
        expect(connect.servername).toBe("provider.example");
        let resolved: Array<{ address: string; family: 4 | 6 }> = [];
        connect.lookup?.("provider.example", { all: true }, (_error, addresses) => {
            resolved = addresses;
        });
        expect(resolved).toEqual([{ address: "8.8.8.8", family: 4 }]);
    });

    it("fails before opening a connection when resolution is unsafe", async () => {
        mocks.resolve.mockResolvedValue(null);
        await expect(fetchSafeOutbound("http://127.0.0.1/private")).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it("connects directly to an explicitly allowed private address", async () => {
        mocks.resolve.mockResolvedValue({ url: new URL("http://private-provider.test/v1/models"), address: "127.0.0.1", family: 4 });
        mocks.isPublic.mockReturnValue(false);
        mocks.proxyUrl.mockReturnValue("http://proxy.test:8080");

        await fetchSafeOutbound("http://private-provider.test/v1/models");

        expect(mocks.proxyUrl).not.toHaveBeenCalled();
        expect(mocks.agents[0]?.options.connect).toBeTruthy();
    });

    it("keeps the same long response timeout when an outbound proxy is used", async () => {
        mocks.resolve.mockResolvedValue({ url: new URL("https://provider.example/v1/images/generations"), address: "8.8.8.8", family: 4 });
        mocks.proxyUrl.mockReturnValue("http://proxy.test:8080");

        await fetchSafeOutbound("https://provider.example/v1/images/generations");

        expect(mocks.agents[0]?.options).toMatchObject({
            uri: "http://proxy.test:8080",
            headersTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
            bodyTimeout: GENERATION_TRANSPORT_TIMEOUT_MS,
        });
    });

    it("uses an explicit request-scoped proxy override without consulting the process proxy", async () => {
        mocks.resolve.mockResolvedValue({ url: new URL("https://google.example/v1internal:generateContent"), address: "8.8.4.4", family: 4 });
        mocks.proxyUrl.mockReturnValue("http://process-proxy.test:8080");

        await fetchSafeOutbound("https://google.example/v1internal:generateContent", {}, { proxyUrl: "http://mihomo-listener.test:17891" });

        expect(mocks.proxyUrl).not.toHaveBeenCalled();
        expect(mocks.agents.at(-1)?.options).toMatchObject({ uri: "http://mihomo-listener.test:17891/" });
    });
    it("pins metered DNS and releases the per-request lease after the response is consumed", async () => {
        const release = vi.fn(async () => undefined);
        mocks.resolve.mockResolvedValue({ url: new URL("https://provider.example/image"), address: "8.8.4.4", family: 4 });
        mocks.lease.mockResolvedValue({ proxyUrl: "http://meter.test:10001", release });
        const response = await fetchSafeOutbound(
            "https://provider.example/image",
            { method: "POST", body: "image" },
            {
                trafficContext: { channelId: "channel-a", channelName: "渠道 A", model: "image-a", protocol: "openai" },
            },
        );
        expect(mocks.lease).toHaveBeenCalledWith("", expect.objectContaining({ channelId: "channel-a", model: "image-a", role: "submit", connectionMode: "direct" }), [{ hostname: "provider.example", address: "8.8.4.4" }], undefined);
        expect(mocks.agents.at(-1)?.options).toMatchObject({ uri: "http://meter.test:10001", requestTls: { servername: "provider.example" } });
        expect(release).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ ok: true });
        expect(release).toHaveBeenCalledTimes(1);
        expect(mocks.agents.at(-1)?.destroy).toHaveBeenCalledTimes(1);
    });

    it("releases streamed leases on cancellation and failed requests without pooling model contexts", async () => {
        const releases = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
        mocks.resolve.mockResolvedValue({ url: new URL("https://provider.example/stream"), address: "8.8.8.8", family: 4 });
        mocks.lease.mockResolvedValueOnce({ proxyUrl: "http://meter.test:10002", release: releases[0] }).mockResolvedValueOnce({ proxyUrl: "http://meter.test:10003", release: releases[1] });
        mocks.fetch
            .mockResolvedValueOnce(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array([1]));
                        },
                    }),
                ),
            )
            .mockRejectedValueOnce(new Error("upstream disconnected"));
        const context = { channelId: "channel-a", channelName: "渠道 A", model: "model-a", protocol: "openai" };
        const response = await fetchSafeOutbound("https://provider.example/stream", {}, { trafficContext: context });
        await response.body?.cancel();
        await expect(fetchSafeOutbound("https://provider.example/stream", {}, { trafficContext: { ...context, model: "model-b" } })).rejects.toThrow("upstream disconnected");
        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(releases[1]).toHaveBeenCalledTimes(1);
        expect(mocks.agents.at(-2)).not.toBe(mocks.agents.at(-1));
        expect(mocks.lease.mock.calls.map((call) => call[1].model)).toEqual(["model-a", "model-b"]);
    });
});
