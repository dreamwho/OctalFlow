import { basename, dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

const PROVIDER_FILE = "/runtime/mihomo/subscription.yaml";
const PROVIDER_ENDPOINT = "/providers/proxies/OctalFlow-Subscription";
const GEMINIAI_GROUP = "OctalFlow-GeminiAIStudio";
const GEMINI_TOOLS_GROUP = "OctalFlow-GeminiTools";

const mocks = vi.hoisted(() => ({
    files: new Map<string, unknown>(),
    providerFiles: new Map<string, string>(),
    safeFetch: vi.fn(),
    controllerFetch: vi.fn(),
    chmod: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
    chmod: mocks.chmod,
    mkdir: mocks.mkdir,
    rename: mocks.rename,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (fileName: string, fallback: unknown) => structuredClone(mocks.files.get(fileName) ?? fallback)),
    writeJsonDataFile: vi.fn(async (fileName: string, value: unknown) => void mocks.files.set(fileName, structuredClone(value))),
    withJsonDataFileLock: vi.fn(async (_fileName: string, callback: () => Promise<unknown>) => callback()),
}));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({
    UnsafeOutboundUrlError: class UnsafeOutboundUrlError extends Error {},
    fetchSafeOutbound: mocks.safeFetch,
}));
vi.mock("@/lib/server/secret-crypto", () => ({
    encryptSecretValue: (value: string) => `enc:${Buffer.from(value).toString("base64url")}`,
    decryptSecretValue: (value: string) => (value.startsWith("enc:") ? Buffer.from(value.slice(4), "base64url").toString("utf8") : value),
}));

import { ensureMagicProxyProvider, getMagicProxyOverview, importMagicProxySubscription, updateMagicProxyBinding } from "./magic-proxy-service";
import { UnsafeOutboundUrlError } from "@/lib/server/safe-outbound-fetch";

const SUBSCRIPTION_URL = "https://subscription.example/clash.yaml?token=private-token";
const SUBSCRIPTION_YAML = `proxies:
  - name: Tokyo-01
    type: ss
    server: node.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
`;

describe("magic proxy service", () => {
    beforeEach(() => {
        mocks.files.clear();
        mocks.providerFiles.clear();
        mocks.safeFetch.mockReset();
        mocks.controllerFetch.mockReset();
        mocks.chmod.mockReset();
        mocks.mkdir.mockReset();
        mocks.writeFile.mockReset();
        mocks.rename.mockReset();
        mocks.unlink.mockReset();
        mocks.mkdir.mockResolvedValue(undefined);
        mocks.chmod.mockResolvedValue(undefined);
        mocks.writeFile.mockImplementation(async (path: string, content: string | Uint8Array) => void mocks.providerFiles.set(path, String(content)));
        mocks.rename.mockImplementation(async (source: string, target: string) => {
            const content = mocks.providerFiles.get(source);
            if (content === undefined) throw new Error("temporary provider file is missing");
            mocks.providerFiles.set(target, content);
            mocks.providerFiles.delete(source);
        });
        mocks.unlink.mockImplementation(async (path: string) => void mocks.providerFiles.delete(path));
        vi.unstubAllEnvs();
        vi.stubEnv("OCTALAICANVAS_DATABASE_PROVIDER", "file");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_CONTROLLER_URL", "http://mihomo-controller.test:9090");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_SECRET", "controller-secret-at-least-thirty-two-characters");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_PROVIDER_FILE", PROVIDER_FILE);
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST", "127.0.0.1");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_PORT", "17890");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_PORT", "17891");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_GEMINIAI_URL", "http://mihomo-listener.test:17890");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_GEMINI_TOOLS_URL", "http://mihomo-listener.test:17891");
        mocks.safeFetch.mockImplementation(async () => new Response(SUBSCRIPTION_YAML, { status: 200 }));
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => controllerResponse(String(input), init));
        vi.stubGlobal("fetch", mocks.controllerFetch);
    });

    afterEach(() => {
        expect(configCalls()).toHaveLength(0);
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("encrypts settings, atomically refreshes the static file provider, and redacts provider-backed overview status", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST", "0.0.0.0");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        expect(mocks.safeFetch).toHaveBeenCalledWith(SUBSCRIPTION_URL, expect.objectContaining({ redirect: "follow" }), { allowProxyFakeIpSpace: true });
        const stored = JSON.stringify(mocks.files.get("magic-proxy.json"));
        expect(stored).toContain("enc:");
        expect(stored).not.toContain("private-token");
        expect(stored).not.toContain("node-password");

        expect(mocks.mkdir).toHaveBeenCalledWith(dirname(PROVIDER_FILE), { recursive: true, mode: 0o700 });
        expect(mocks.chmod).toHaveBeenCalledWith(dirname(PROVIDER_FILE), 0o700);
        const [temporaryFile, yaml, options] = mocks.writeFile.mock.calls[0] as [string, string, { encoding: string; mode: number; flag: string }];
        expect(dirname(temporaryFile)).toBe(dirname(PROVIDER_FILE));
        expect(basename(temporaryFile)).toMatch(/^\.subscription\.yaml\.\d+\..+\.tmp$/);
        expect(options).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });
        expect(mocks.rename).toHaveBeenCalledWith(temporaryFile, PROVIDER_FILE);
        expect(mocks.chmod).toHaveBeenCalledWith(PROVIDER_FILE, 0o600);
        expect(mocks.unlink).toHaveBeenCalledWith(temporaryFile);
        expect(mocks.writeFile.mock.calls.every(([fileName]) => fileName !== PROVIDER_FILE)).toBe(true);
        expect(parseDocument(yaml).toJS()).toMatchObject({ proxies: [expect.objectContaining({ name: "Tokyo-01", password: "node-password" })] });
        expect(providerFileConfig()).toMatchObject({ proxies: [expect.objectContaining({ name: "Tokyo-01", type: "ss" })] });

        expect(providerRefreshCalls()).toHaveLength(1);
        expect(providerRefreshCalls()[0]?.[1]).toMatchObject({ method: "PUT", headers: { authorization: "Bearer controller-secret-at-least-thirty-two-characters" } });
        expect(providerGetCalls()).toHaveLength(1);
        expect(selectionFor(GEMINIAI_GROUP)).toBe("DIRECT");
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("DIRECT");

        const overview = await getMagicProxyOverview();

        expect(overview).toMatchObject({
            configured: true,
            runtimeAvailable: true,
            nodeCount: 1,
            nodes: [{ name: "Tokyo-01", type: "ss", alive: true, delay: 42 }],
            groups: expect.arrayContaining([expect.objectContaining({ name: GEMINIAI_GROUP, now: "DIRECT" }), expect.objectContaining({ name: GEMINI_TOOLS_GROUP, now: "DIRECT" })]),
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: false } },
        });
        expect(groupGetCalls()).toHaveLength(1);
        expect(providerGetCalls()).toHaveLength(2);
        expect(JSON.stringify(overview)).not.toContain("private-token");
        expect(JSON.stringify(overview)).not.toContain("node-password");
        expect(JSON.stringify(overview)).not.toContain("node.private.example");
        expect(overview.groups.every((group) => typeof group.now === "string")).toBe(true);
    });

    it("pins each provider to its own static group without refreshing an already loaded provider", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.controllerFetch.mockClear();

        await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "Tokyo-01" });

        expect(providerRefreshCalls()).toHaveLength(0);
        expect(selectionFor(GEMINIAI_GROUP)).toBe("Tokyo-01");
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBeUndefined();

        await updateMagicProxyBinding({ provider: "geminiTools", enabled: true, node: "Tokyo-01" });
        mocks.controllerFetch.mockClear();
        const resolved = await ensureMagicProxyProvider("geminiTools");

        expect(resolved).toEqual({ enabled: true, proxyUrl: "http://mihomo-listener.test:17891/" });
        expect(providerRefreshCalls()).toHaveLength(0);
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("Tokyo-01");
        expect(selectionFor(GEMINIAI_GROUP)).toBeUndefined();
    });

    it("refreshes the provider before selecting a binding whose static group is missing the expected node", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.controllerFetch.mockClear();
        let omitExpectedNode = true;
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (omitExpectedNode && url.pathname === "/proxies" && init?.method === "GET") {
                omitExpectedNode = false;
                return groupsResponse([]);
            }
            return controllerResponse(String(input), init);
        });

        await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "Tokyo-01" });

        expect(providerRefreshCalls()).toHaveLength(1);
        expect(providerGetCalls()).toHaveLength(1);
        expect(selectionFor(GEMINIAI_GROUP)).toBe("Tokyo-01");
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("DIRECT");
    });

    it("requires the refreshed provider node-name set to exactly match the imported subscription before persisting", async () => {
        let firstProviderRead = true;
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            if (firstProviderRead && new URL(String(input)).pathname === PROVIDER_ENDPOINT && init?.method === "GET") {
                firstProviderRead = false;
                return jsonResponse({ proxies: [...providerRuntimeNodes(), { name: "Stale-01", type: "ss" }] });
            }
            return controllerResponse(String(input), init);
        });

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 502 });

        expect(providerRefreshCalls()).toHaveLength(2);
        expect(providerGetCalls()).toHaveLength(2);
        expect(providerFileConfig()).toEqual({ proxies: [] });
        expect(selectionFor(GEMINIAI_GROUP)).toBe("DIRECT");
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("DIRECT");
        expect(mocks.files.has("magic-proxy.json")).toBe(false);
    });

    it("uses an empty string for a group current selection that the controller does not report", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            if (new URL(String(input)).pathname === "/proxies" && init?.method === "GET") return jsonResponse({ proxies: {} });
            return controllerResponse(String(input), init);
        });

        const overview = await getMagicProxyOverview();

        expect(overview.groups.map((group) => group.now)).toEqual(["", ""]);
    });

    it("rejects non-HTTPS or credential-bearing subscription URLs before any outbound request", async () => {
        await expect(importMagicProxySubscription({ url: "http://subscription.example/clash.yaml" })).rejects.toMatchObject({ status: 422 });
        await expect(importMagicProxySubscription({ url: "https://name:password@subscription.example/clash.yaml" })).rejects.toMatchObject({ status: 422 });

        expect(mocks.safeFetch).not.toHaveBeenCalled();
        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("maps safe outbound SSRF rejections without refreshing a provider", async () => {
        mocks.safeFetch.mockRejectedValueOnce(new UnsafeOutboundUrlError());

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 422 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("reports upstream access denial separately from an unsafe URL", async () => {
        mocks.safeFetch.mockResolvedValueOnce(new Response("blocked", { status: 403 }));

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 502, message: "订阅服务器拒绝访问（HTTP 403），请使用服务器可直接访问的 Clash YAML 直链，不能使用需要浏览器验证的网页链接" });
    });

    it("requires an explicitly ported controller URL before importing a subscription", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_CONTROLLER_URL", "http://mihomo-controller.test");

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("requires an absolute subscription.yaml provider file path", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_PROVIDER_FILE", "runtime/mihomo/subscription.yaml");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();

        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_PROVIDER_FILE", "/runtime/mihomo/other.yaml");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("requires a long controller secret and a loopback-or-all listener host", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_SECRET", "too-short");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();

        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_SECRET", "controller-secret-at-least-thirty-two-characters");
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_LISTEN_HOST", "10.0.0.7");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("cleans the failed temporary provider file and leaves the first import runtime empty", async () => {
        mocks.rename.mockRejectedValueOnce(new Error("rename failed"));

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });

        const temporaryFile = mocks.writeFile.mock.calls[0]?.[0] as string;
        expect(dirname(temporaryFile)).toBe(dirname(PROVIDER_FILE));
        expect(mocks.unlink).toHaveBeenCalledWith(temporaryFile);
        expect(mocks.providerFiles.has(temporaryFile)).toBe(false);
        expect(providerFileConfig()).toEqual({ proxies: [] });
        expect(providerRefreshCalls()).toHaveLength(1);
        expect(mocks.files.has("magic-proxy.json")).toBe(false);
    });

    it("rejects oversized subscriptions from Content-Length before parsing", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES", "64");
        mocks.safeFetch.mockResolvedValueOnce(
            new Response(SUBSCRIPTION_YAML, {
                status: 200,
                headers: { "content-type": "application/yaml", "content-length": "4096" },
            }),
        );

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 413 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("enforces the subscription stream byte limit when Content-Length is absent", async () => {
        vi.stubEnv("OCTALAICANVAS_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES", "64");
        mocks.safeFetch.mockResolvedValueOnce(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(SUBSCRIPTION_YAML));
                        controller.close();
                    },
                }),
                {
                    status: 200,
                    headers: { "content-type": "text/yaml" },
                },
            ),
        );

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 413 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("rejects a non-text subscription response before YAML parsing", async () => {
        mocks.safeFetch.mockResolvedValueOnce(new Response(SUBSCRIPTION_YAML, { status: 200, headers: { "content-type": "image/png" } }));

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 422 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("rejects invalid UTF-8 subscription bytes without replacement decoding", async () => {
        mocks.safeFetch.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200, headers: { "content-type": "text/yaml" } }));

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 422 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("disables and clears a removed selected node on refresh", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        await updateMagicProxyBinding({ provider: "geminiTools", enabled: true, node: "Tokyo-01" });
        mocks.safeFetch.mockResolvedValueOnce(new Response("proxies:\n  - name: Osaka-01\n    type: trojan\n    server: replacement.private.example\n    port: 443\n    password: replacement-password\n", { status: 200 }));

        const refreshed = await importMagicProxySubscription({});

        expect(refreshed.bindings.geminiTools).toEqual({ enabled: false });
        expect((await getMagicProxyOverview()).bindings.geminiTools).toEqual({ enabled: false });
    });

    it("restores the previous provider file and runtime before leaving failed subscription settings unsaved", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        const previousSettings = structuredClone(mocks.files.get("magic-proxy.json"));
        mocks.controllerFetch.mockClear();
        mocks.safeFetch.mockResolvedValueOnce(new Response("proxies:\n  - name: Osaka-01\n    type: trojan\n    server: replacement.private.example\n    port: 443\n    password: replacement-password\n", { status: 200 }));
        let failNewRefresh = true;
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            if (failNewRefresh && new URL(String(input)).pathname === PROVIDER_ENDPOINT && init?.method === "PUT") {
                failNewRefresh = false;
                return new Response(null, { status: 500 });
            }
            return controllerResponse(String(input), init);
        });

        await expect(importMagicProxySubscription({})).rejects.toMatchObject({ status: 502 });

        expect(providerRefreshCalls()).toHaveLength(2);
        expect(providerFileConfig()).toMatchObject({ proxies: [expect.objectContaining({ name: "Tokyo-01", type: "ss" })] });
        expect(JSON.stringify(providerFileConfig())).not.toContain("Osaka-01");
        expect(mocks.files.get("magic-proxy.json")).toEqual(previousSettings);
        expect((await getMagicProxyOverview()).nodes).toEqual([expect.objectContaining({ name: "Tokyo-01", type: "ss" })]);
    });

    it("serializes a provider refresh and binding update so neither change overwrites the other", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.safeFetch.mockResolvedValueOnce(new Response("proxies:\n  - name: Tokyo-01\n    type: trojan\n    server: refreshed.private.example\n    port: 443\n    password: refreshed-password\n", { status: 200 }));
        let signalRefreshStarted!: () => void;
        let releaseRefresh!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
            signalRefreshStarted = resolve;
        });
        const refreshReleased = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        let holdNextRefresh = true;
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            if (holdNextRefresh && new URL(String(input)).pathname === PROVIDER_ENDPOINT && init?.method === "PUT") {
                holdNextRefresh = false;
                signalRefreshStarted();
                await refreshReleased;
            }
            return controllerResponse(String(input), init);
        });

        const refresh = importMagicProxySubscription({});
        await refreshStarted;
        const binding = updateMagicProxyBinding({ provider: "geminiTools", enabled: true, node: "Tokyo-01" });
        releaseRefresh();
        await Promise.all([refresh, binding]);

        const overview = await getMagicProxyOverview();
        expect(overview.nodes).toEqual([expect.objectContaining({ name: "Tokyo-01", type: "trojan" })]);
        expect(overview.bindings.geminiTools).toEqual({ enabled: true, node: "Tokyo-01" });
    });
});

function controllerResponse(url: string, init?: RequestInit) {
    const parsed = new URL(url);
    if (parsed.pathname === PROVIDER_ENDPOINT && init?.method === "GET") return jsonResponse({ proxies: providerRuntimeNodes() });
    if (parsed.pathname === PROVIDER_ENDPOINT && init?.method === "PUT") return new Response(null, { status: 204 });
    if (parsed.pathname === "/proxies" && parsed.search === "" && init?.method === "GET") return groupsResponse(providerRuntimeNodes().map((node) => node.name));
    return new Response(null, { status: 204 });
}

function groupsResponse(nodeNames: string[]) {
    return jsonResponse({
        proxies: {
            [GEMINIAI_GROUP]: { name: GEMINIAI_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] },
            [GEMINI_TOOLS_GROUP]: { name: GEMINI_TOOLS_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] },
        },
    });
}

function jsonResponse(value: unknown) {
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function providerRuntimeNodes() {
    const config = providerFileConfig();
    const proxies = Array.isArray(config.proxies) ? config.proxies : [];
    return proxies.flatMap((proxy) => {
        if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return [];
        const node = proxy as Record<string, unknown>;
        const name = typeof node.name === "string" ? node.name : "";
        const type = typeof node.type === "string" ? node.type : "unknown";
        return name ? [{ name, type, alive: true, history: [{ delay: 42 }] }] : [];
    });
}

function providerFileConfig() {
    const parsed = parseDocument(mocks.providerFiles.get(PROVIDER_FILE) || "").toJS();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function controllerCalls(pathname: string, method?: string) {
    return mocks.controllerFetch.mock.calls.filter(([url, init]) => {
        const request = init as RequestInit | undefined;
        return new URL(String(url)).pathname === pathname && (!method || request?.method === method);
    });
}

function providerRefreshCalls() {
    return controllerCalls(PROVIDER_ENDPOINT, "PUT");
}

function providerGetCalls() {
    return controllerCalls(PROVIDER_ENDPOINT, "GET");
}

function groupGetCalls() {
    return controllerCalls("/proxies", "GET");
}

function configCalls() {
    return controllerCalls("/configs");
}

function selectionFor(group: string) {
    const call = mocks.controllerFetch.mock.calls.findLast(([url, init]) => new URL(String(url)).pathname === `/proxies/${encodeURIComponent(group)}` && (init as RequestInit | undefined)?.method === "PUT");
    return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body || "{}"))?.name;
}
