import { basename, dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

const PROVIDER_FILE = "/runtime/mihomo/subscription.yaml";
const PROVIDER_ENDPOINT = "/providers/proxies/dreamyo-Subscription";
const GEMINIAI_GROUP = "dreamyo-GeminiAIStudio";
const GEMINI_TOOLS_GROUP = "dreamyo-GeminiTools";
const CHATGPT_API_GROUP = "dreamyo-ChatGPTAPI";
const DOLA_GROUP = "dreamyo-DolaAPI";

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
    lookup: vi.fn(),
    connect: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
    chmod: mocks.chmod,
    mkdir: mocks.mkdir,
    rename: mocks.rename,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));
// 失败诊断会做真实 DNS/TCP 探测，测试必须注入假实现，否则会依赖外网且结果不确定。
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
// 只替身 connect：isIP 等其余实现必须保留真实行为，整体替身会让未列出的导出变成 undefined。
vi.mock("node:net", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:net")>();
    return { ...actual, connect: mocks.connect };
});
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

const chatGptServiceMocks = vi.hoisted(() => ({
    resolveGenericProxyNodeUrl: vi.fn(async (..._args: unknown[]) => ""),
    syncChatGptApiRuntimeProxy: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@/lib/server/chatgpt-api-service", () => ({
    resolveGenericProxyNodeUrl: (...args: unknown[]) => chatGptServiceMocks.resolveGenericProxyNodeUrl(...(args as [])),
    syncChatGptApiRuntimeProxy: (...args: unknown[]) => chatGptServiceMocks.syncChatGptApiRuntimeProxy(...(args as [])),
}));

import { cleanNodeName, ensureMagicProxyProvider, getMagicProxyOverview, importMagicProxySubscription, repairMagicProxyRuntimeConfig, resolveHopNodeName, testMagicProxyAllNodes, testMagicProxyDolaAccess, testMagicProxyGoogleAccess, testMagicProxyNodeDelay, updateMagicProxyBinding } from "./magic-proxy-service";
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
        mocks.lookup.mockReset();
        mocks.connect.mockReset();
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
        vi.stubEnv("DREAMYO_DATABASE_PROVIDER", "file");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CONTROLLER_URL", "http://mihomo-controller.test:9090");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_SECRET", "controller-secret-at-least-thirty-two-characters");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_PROVIDER_FILE", PROVIDER_FILE);
        vi.stubEnv("DREAMYO_MAGIC_PROXY_LISTEN_HOST", "127.0.0.1");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_GEMINIAI_PORT", "17890");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_GEMINI_TOOLS_PORT", "17891");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_GEMINIAI_URL", "http://mihomo-listener.test:17890");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_GEMINI_TOOLS_URL", "http://mihomo-listener.test:17891");
        mocks.safeFetch.mockImplementation(async () => new Response(SUBSCRIPTION_YAML, { status: 200 }));
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => controllerResponse(String(input), init));
        vi.stubGlobal("fetch", mocks.controllerFetch);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("encrypts settings, atomically refreshes the static file provider, and redacts provider-backed overview status", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_LISTEN_HOST", "0.0.0.0");
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
        expect(selectionFor(CHATGPT_API_GROUP)).toBeUndefined();

        const overview = await getMagicProxyOverview();

        expect(overview).toMatchObject({
            configured: true,
            runtimeAvailable: true,
            nodeCount: 1,
            nodes: [{ name: "Tokyo-01", type: "ss", alive: true, delay: 42 }],
            groups: expect.arrayContaining([expect.objectContaining({ name: GEMINIAI_GROUP, now: "DIRECT" }), expect.objectContaining({ name: GEMINI_TOOLS_GROUP, now: "DIRECT" }), expect.objectContaining({ name: CHATGPT_API_GROUP, now: "" })]),
            bindings: { geminiai: { enabled: false }, geminiTools: { enabled: false }, chatgptApi: { enabled: false } },
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

        expect(resolved).toEqual({ enabled: true, proxyUrl: "http://mihomo-listener.test:17891/", egress: { mode: "magic", node_name: "Tokyo-01" } });
        expect(providerRefreshCalls()).toHaveLength(0);
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("Tokyo-01");
        expect(selectionFor(GEMINIAI_GROUP)).toBeUndefined();
    });

    it("imports local Clash YAML content without fetching a URL and requires a new file for refresh", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.safeFetch.mockClear();

        const result = await importMagicProxySubscription({ content: SUBSCRIPTION_YAML, replace: true });

        expect(result.nodes).toEqual([{ name: "Tokyo-01", type: "ss" }]);
        expect(mocks.safeFetch).not.toHaveBeenCalled();
        expect((await getMagicProxyOverview()).configured).toBe(true);
        await expect(importMagicProxySubscription({})).rejects.toMatchObject({ status: 409, message: expect.stringContaining("本地文件") });
    });

    it("recovers unreadable saved settings through an explicit YAML re-import", async () => {
        mocks.files.set("magic-proxy.json", {
            subscriptionUrlCiphertext: "unreadable-url-ciphertext",
            nodesCiphertext: "unreadable-nodes-ciphertext",
            bindings: { geminiai: { enabled: true, node: "Tokyo-01" } },
            updatedAt: "2026-09-22T00:00:00.000Z",
        });

        await expect(importMagicProxySubscription({ content: SUBSCRIPTION_YAML })).resolves.toMatchObject({
            nodes: [{ name: "Tokyo-01", type: "ss" }],
        });

        const saved = mocks.files.get("magic-proxy.json") as { bindings: { geminiai: { enabled: boolean; node?: string } } };
        expect(saved.bindings.geminiai).toEqual({ enabled: true, node: "Tokyo-01" });
        expect((await getMagicProxyOverview()).configured).toBe(true);
    });

    it("keeps legacy providers usable without ChatGPTAPI listener settings and rejects ChatGPTAPI enablement clearly", async () => {
        expect(controllerResponse(`http://mihomo-controller.test:9090/proxies/${encodeURIComponent(CHATGPT_API_GROUP)}`, { method: "PUT" }).status).toBe(404);
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        await updateMagicProxyBinding({ provider: "geminiTools", enabled: true, node: "Tokyo-01" });

        expect(controllerCalls(`/proxies/${encodeURIComponent(CHATGPT_API_GROUP)}`, "PUT")).toHaveLength(0);
        await expect(ensureMagicProxyProvider("geminiTools")).resolves.toEqual({ enabled: true, proxyUrl: "http://mihomo-listener.test:17891/", egress: { mode: "magic", node_name: "Tokyo-01" } });
        await expect(updateMagicProxyBinding({ provider: "chatgptApi", enabled: true, node: "Tokyo-01" })).rejects.toMatchObject({
            status: 503,
            message: expect.stringContaining("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT"),
        });
    });

    it("fails explicitly instead of PUTing an unavailable ChatGPTAPI group after its enabled runtime config is removed", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "17892");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "http://mihomo-listener.test:17892");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        await updateMagicProxyBinding({ provider: "chatgptApi", enabled: true, node: "Tokyo-01" });

        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "");
        mocks.controllerFetch.mockClear();

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({
            status: 503,
            message: expect.stringContaining("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT"),
        });
        expect(controllerCalls(`/proxies/${encodeURIComponent(CHATGPT_API_GROUP)}`, "PUT")).toHaveLength(0);
    });

    it("returns ChatGPTAPI's dedicated outbound listener URL without changing other provider selections", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "17892");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "http://mihomo-listener.test:17892");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.controllerFetch.mockClear();

        await updateMagicProxyBinding({ provider: "chatgptApi", enabled: true, node: "Tokyo-01" });
        const resolved = await ensureMagicProxyProvider("chatgptApi");

        expect(resolved).toEqual({ enabled: true, proxyUrl: "http://mihomo-listener.test:17892/", egress: { mode: "magic", node_name: "Tokyo-01" } });
        expect(providerRefreshCalls()).toHaveLength(0);
        expect(selectionFor(CHATGPT_API_GROUP)).toBe("Tokyo-01");
        expect(selectionFor(GEMINIAI_GROUP)).toBeUndefined();
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBeUndefined();
    });

    it("resolves Dola magic egress through its dedicated listener and probes the Dola origin", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_DOLA_PORT", "17893");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_DOLA_URL", "http://mihomo-listener.test:17893");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        await updateMagicProxyBinding({ provider: "dola", enabled: true, node: "Tokyo-01" });
        const resolved = await ensureMagicProxyProvider("dola");
        expect(resolved).toEqual({ enabled: true, proxyUrl: "http://mihomo-listener.test:17893/", egress: { mode: "magic", node_name: "Tokyo-01" } });
        expect(selectionFor(DOLA_GROUP)).toBe("Tokyo-01");

        const report = await testMagicProxyDolaAccess();
        expect(report.targetUrl).toBe("https://www.dola.com/chat/");
        expect(report.items).toEqual([expect.objectContaining({ service: "dola", group: DOLA_GROUP, activeNode: "Tokyo-01", enabled: true, ok: true, delay: 88 })]);
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
        expect(selectionFor(CHATGPT_API_GROUP)).toBeUndefined();
        expect(mocks.files.has("magic-proxy.json")).toBe(false);
    });

    it("uses an empty string for a group current selection that the controller does not report", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
            if (new URL(String(input)).pathname === "/proxies" && init?.method === "GET") return jsonResponse({ proxies: {} });
            return controllerResponse(String(input), init);
        });

        const overview = await getMagicProxyOverview();

        expect(overview.groups.map((group) => group.now)).toEqual(["", "", "", ""]);
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
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CONTROLLER_URL", "http://mihomo-controller.test");

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("requires an absolute subscription.yaml provider file path", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_PROVIDER_FILE", "runtime/mihomo/subscription.yaml");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();

        vi.stubEnv("DREAMYO_MAGIC_PROXY_PROVIDER_FILE", "/runtime/mihomo/other.yaml");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("requires a long controller secret and a loopback-or-all listener host", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_SECRET", "too-short");
        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 503 });
        expect(mocks.controllerFetch).not.toHaveBeenCalled();

        vi.stubEnv("DREAMYO_MAGIC_PROXY_SECRET", "controller-secret-at-least-thirty-two-characters");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_LISTEN_HOST", "10.0.0.7");
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
        vi.stubEnv("DREAMYO_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES", "64");
        mocks.safeFetch.mockResolvedValueOnce(
            new Response(SUBSCRIPTION_YAML, {
                status: 200,
                headers: { "content-type": "application/yaml", "content-length": "4096" },
            }),
        );

        await expect(importMagicProxySubscription({ url: SUBSCRIPTION_URL })).rejects.toMatchObject({ status: 413 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
    });

    it("rejects oversized local files before writing the provider", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES", "64");

        await expect(importMagicProxySubscription({ content: SUBSCRIPTION_YAML })).rejects.toMatchObject({ status: 413 });

        expect(mocks.controllerFetch).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it("enforces the subscription stream byte limit when Content-Length is absent", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_MAX_SUBSCRIPTION_BYTES", "64");
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

    it("keeps a chained GPTAPI exit alive across subscription refreshes and upgrades https landings to tls", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "17892");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "http://mihomo-listener.test:17892");
        chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("https://landing.private.example:8443");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        await updateMagicProxyBinding({
            provider: "chatgptApi",
            enabled: true,
            mode: "chained",
            chained_config: { hop_node: "Tokyo-01", landing_node_id: "fixture-landing" },
        });

        expect(providerFileConfig()).toMatchObject({
            proxies: expect.arrayContaining([
                expect.objectContaining({ name: "Tokyo-01", type: "ss" }),
                expect.objectContaining({ name: "dreamyo-Chained-Exit", type: "http", server: "landing.private.example", port: 8443, tls: true, "dialer-proxy": "dreamyo-Chained-Hop-ChatGPTAPI" }),
            ]),
        });
        expect(selectionFor(CHATGPT_API_GROUP)).toBe("dreamyo-Chained-Exit");

        mocks.safeFetch.mockResolvedValueOnce(new Response("proxies:\n  - name: Tokyo-01\n    type: ss\n    server: refreshed.private.example\n    port: 443\n    cipher: aes-256-gcm\n    password: node-password\n", { status: 200 }));
        const refreshed = await importMagicProxySubscription({});

        expect(refreshed.bindings.chatgptApi).toMatchObject({ enabled: true, mode: "chained" });
        expect(providerFileConfig()).toMatchObject({
            proxies: expect.arrayContaining([expect.objectContaining({ name: "dreamyo-Chained-Exit", type: "http", server: "landing.private.example", port: 8443, tls: true, "dialer-proxy": "dreamyo-Chained-Hop-ChatGPTAPI" })]),
        });
        expect(selectionFor(CHATGPT_API_GROUP)).toBe("dreamyo-Chained-Exit");
        expect(chatGptServiceMocks.resolveGenericProxyNodeUrl).toHaveBeenCalledWith("fixture-landing");
    });

    it("preserves other providers' chained exits when one provider rewrites its own", async () => {
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "17892");
        vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "http://mihomo-listener.test:17892");
        chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("http://landing.private.example:8080");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-g" } });
        await updateMagicProxyBinding({ provider: "chatgptApi", enabled: true, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-c" } });

        expect(providerFileConfig()).toMatchObject({
            proxies: expect.arrayContaining([
                expect.objectContaining({ name: "dreamyo-Chained-Exit-geminiai", server: "landing.private.example", port: 8080 }),
                expect.objectContaining({ name: "dreamyo-Chained-Exit", server: "landing.private.example", port: 8080 }),
            ]),
        });

        // 再次触发单 Provider 的链式同步（自愈路径）不得清除另一个 Provider 的出口。
        await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-g" } });

        const exitNames = (providerFileConfig().proxies as Array<{ name: string }>).map((node) => node.name);
        expect(exitNames).toContain("dreamyo-Chained-Exit");
        expect(exitNames).toContain("dreamyo-Chained-Exit-geminiai");
        expect(selectionFor(CHATGPT_API_GROUP)).toBe("dreamyo-Chained-Exit");
        expect(selectionFor(GEMINIAI_GROUP)).toBe("dreamyo-Chained-Exit-geminiai");
    });

    it("probes a single node through the provider healthcheck endpoint without ever falling back to group delays", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        // 单节点测速优先走 provider 健康检查端点（mock 返回 77），避免全组并发拨号资源竞争。
        const single = await testMagicProxyNodeDelay({ node: "Tokyo-01" });
        expect(single).toEqual({ name: "Tokyo-01", delay: 77 });

        // 端点返回无效延迟时如实上报，绝不回退组级测速：组级端点会带动组内全部节点并发拨号，
        // 批量测速的并发通道会因此互相拖垮，把正常节点也一起判为失败。
        const invalid = await testMagicProxyNodeDelay({ node: "Osaka-99" });
        expect(invalid).toEqual({ name: "Osaka-99", error: "节点测速未返回有效延迟，请重试" });
        expect(groupDelayCalls()).toHaveLength(0);

        const all = await testMagicProxyAllNodes();
        expect(all.results).toEqual([{ name: "Tokyo-01", delay: 88 }]);
        // 只有显式的整组测速才允许调用组级端点。
        expect(groupDelayCalls()).toHaveLength(1);

        // 逐节点 /proxies/<name>/delay 对 provider 节点一律 404，不允许再走该端点。
        expect(
            mocks.controllerFetch.mock.calls.some(([url, init]) => {
                const parsed = new URL(String(url));
                return parsed.pathname.startsWith("/proxies/") && parsed.pathname.endsWith("/delay") && (init as RequestInit | undefined)?.method === "GET";
            }),
        ).toBe(false);
    });

    it("keeps an inconclusive timeout out of the persisted alive flag so working nodes are not hidden", async () => {
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
        // 内核 504 表示「本次没在时限内测出」，并发压力下正常节点也会偶发；不能据此把节点标记为不可用。
        mocks.lookup.mockResolvedValue([]);
        const original = mocks.controllerFetch.getMockImplementation();
        mocks.controllerFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.endsWith("/healthcheck")) return jsonResponse({ message: "context deadline exceeded" }, 504);
            return original ? original(url, init) : controllerResponse(url, init);
        });

        const timeout = await testMagicProxyNodeDelay({ node: "Tokyo-01" });
        expect(timeout.error).toContain("节点测速超时未出结果");

        // 不写 alive:false，节点在下拉里继续可选
        const overview = await getMagicProxyOverview();
        const record = (mocks.files.get("magic-proxy.json") as { nodeDelays?: Record<string, { alive?: boolean }> } | undefined)?.nodeDelays?.["Tokyo-01"];
        expect(record?.alive).not.toBe(false);
        expect(overview.nodes.find((item) => item.name === "Tokyo-01")?.alive).not.toBe(false);
    });

    it("locates the failing stage of a dead node instead of repeating the kernel's generic message", async () => {
        await importMagicProxySubscription({
            content: `proxies:
  - name: HK-01
    type: ss
    server: hk.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
`,
        });

        // 节点域名无法解析：常见于机场要求专用 DoH 解析而容器系统 DNS 不认。
        mocks.lookup.mockResolvedValueOnce([]);
        expect((await testMagicProxyNodeDelay({ node: "HK-01" })).error).toContain("应用侧无法用系统 DNS 解析节点域名 hk.private.example");

        // 域名可解析但端口不可达：节点已下线或被封锁。
        mocks.lookup.mockResolvedValueOnce([{ address: "203.0.113.9", family: 4 }]);
        mocks.connect.mockImplementationOnce(() => fakeSocket("timeout"));
        expect((await testMagicProxyNodeDelay({ node: "HK-01" })).error).toContain("TCP 443 均不可达");

        // TCP 可达仍未通过健康检查：问题在代理协议握手阶段，与网络可达性无关。
        mocks.lookup.mockResolvedValueOnce([{ address: "203.0.113.9", family: 4 }]);
        mocks.connect.mockImplementationOnce(() => fakeSocket("connect"));
        expect((await testMagicProxyNodeDelay({ node: "HK-01" })).error).toContain("失败发生在 mihomo 拨号阶段");

        // 三类失败都必须只拨当前节点，不得触发全组重拨。
        expect(groupDelayCalls()).toHaveLength(0);
    });

    it("falls back to the bound magic node when a chained landing cannot be rebuilt instead of leaving a stale exit selected", async () => {
        chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("http://landing.private.example:8080");
        await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

        await updateMagicProxyBinding({ provider: "geminiTools", enabled: true, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-g" } });
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("dreamyo-Chained-Exit-geminiTools");

        // 落地解析失败（如节点被删）触发订阅刷新：出口从文件移除，分组必须回退到绑定的魔法节点。
        chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("");
        mocks.safeFetch.mockResolvedValueOnce(new Response("proxies:\n  - name: Tokyo-01\n    type: ss\n    server: node.private.example\n    port: 443\n    cipher: aes-256-gcm\n    password: node-password\n", { status: 200 }));
        await importMagicProxySubscription({});

        expect((providerFileConfig().proxies as Array<{ name: string }>).some((node) => node.name === "dreamyo-Chained-Exit-geminiTools")).toBe(false);
        expect(selectionFor(GEMINI_TOOLS_GROUP)).toBe("DIRECT");
    });

    describe("resolveHopNodeName and cleanNodeName", () => {
        it("strips emojis, regional indicator flags, and special brackets", () => {
            expect(cleanNodeName("🇭🇰 香港 01")).toBe("香港 01");
            expect(cleanNodeName("🇯🇵 日本 02 [专线]")).toBe("日本 02 专线");
            expect(cleanNodeName("🇺🇸 美国 01 【高防】")).toBe("美国 01 高防");
            expect(cleanNodeName("  Singapore 01  ")).toBe("Singapore 01");
        });

        it("resolves exact matches", () => {
            const nodes = [{ name: "香港 01" }, { name: "日本 01" }];
            expect(resolveHopNodeName("香港 01", nodes)).toBe("香港 01");
            expect(resolveHopNodeName("日本 01", nodes)).toBe("日本 01");
        });

        it("resolves hop node names with emoji flags to clean node names", () => {
            const nodes = [{ name: "香港 01" }, { name: "日本 01" }];
            expect(resolveHopNodeName("🇭🇰 香港 01", nodes)).toBe("香港 01");
            expect(resolveHopNodeName("🇯🇵 日本 01", nodes)).toBe("日本 01");
        });

        it("resolves clean hop node names to candidate node names that include emoji flags", () => {
            const nodes = [{ name: "🇭🇰 香港 01" }, { name: "🇯🇵 日本 01" }];
            expect(resolveHopNodeName("香港 01", nodes)).toBe("🇭🇰 香港 01");
            expect(resolveHopNodeName("日本 01", nodes)).toBe("🇯🇵 日本 01");
        });

        it("resolves substring and bracket variants", () => {
            const nodes = [{ name: "香港 01 [专线]" }];
            expect(resolveHopNodeName("香港 01", nodes)).toBe("香港 01 [专线]");
            expect(resolveHopNodeName("🇭🇰 香港 01", nodes)).toBe("香港 01 [专线]");
        });

        it("returns null when no candidate node matches", () => {
            const nodes = [{ name: "香港 01" }];
            expect(resolveHopNodeName("台湾 01", nodes)).toBeNull();
            expect(resolveHopNodeName("", nodes)).toBeNull();
        });
    });

    describe("airport subscription normalization and multi-protocol parsing", () => {
        it("automatically appends flag=clash to airport subscription URLs", async () => {
            const airportUrl = "https://sub2.smallstrawberry.com/api/v1/client/subscribe?token=dcdaac6fa5317015940704b4c29cef29&name=%E4%B8%80%E5%85%83%E6%9C%BA%E5%9C%BA";
            await importMagicProxySubscription({ url: airportUrl });

            expect(mocks.safeFetch).toHaveBeenCalled();
            const calledUrl = mocks.safeFetch.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain("flag=clash");
            expect(calledUrl).toContain("sub2.smallstrawberry.com/api/v1/client/subscribe");
        });

        it("unpacks clash:// deep links and appends flag=clash", async () => {
            const deepLink = "clash://install-config?url=https%3A%2F%2Fsub.example.com%2Fapi%2Fv1%2Fclient%2Fsubscribe%3Ftoken%3Dabc123";
            await importMagicProxySubscription({ url: deepLink });

            expect(mocks.safeFetch).toHaveBeenCalled();
            const calledUrl = mocks.safeFetch.mock.calls[0]?.[0] as string;
            expect(calledUrl).toBe("https://sub.example.com/api/v1/client/subscribe?token=abc123&flag=clash");
        });

        it("accepts application/octet-stream response content-type", async () => {
            mocks.safeFetch.mockResolvedValueOnce(
                new Response(SUBSCRIPTION_YAML, {
                    status: 200,
                    headers: { "content-type": "application/octet-stream" },
                }),
            );

            const result = await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
            expect(result.nodeCount).toBe(1);
            expect(result.nodes[0]?.name).toBe("Tokyo-01");
        });

        it("disambiguates duplicate node names automatically", async () => {
            const duplicateYaml = `proxies:
  - name: HK-01
    type: ss
    server: 1.1.1.1
    port: 443
    cipher: aes-256-gcm
    password: pass
  - name: HK-01
    type: ss
    server: 2.2.2.2
    port: 443
    cipher: aes-256-gcm
    password: pass
`;
            const result = await importMagicProxySubscription({ content: duplicateYaml });
            expect(result.nodeCount).toBe(2);
            expect(result.nodes[0]?.name).toBe("HK-01");
            expect(result.nodes[1]?.name).toBe("HK-01 (2)");
        });

        it("parses Base64 encoded node subscriptions with SS, Trojan, VLESS, VMess", async () => {
            const ssUri = "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@1.2.3.4:8388#%E9%A6%99%E6%B8%AF-SS";
            const trojanUri = "trojan://trojanpass@5.6.7.8:443?sni=trojan.example.com&allowInsecure=1#%E6%97%A5%E6%9C%AC-Trojan";
            const vlessUri = "vless://d3b07384-d113-494b-8e2b-4d4361543169@9.10.11.12:443?security=reality&sni=vless.example.com&pbk=fakekey#%E7%BE%8E%E5%9B%BD-VLESS";
            const vmessJson = {
                v: "2",
                ps: "新加坡-VMess",
                add: "13.14.15.16",
                port: 443,
                id: "d3b07384-d113-494b-8e2b-4d4361543169",
                aid: 0,
                scy: "auto",
                net: "ws",
                type: "none",
                host: "vmess.example.com",
                path: "/ws",
                tls: "tls",
                sni: "vmess.example.com",
            };
            const vmessUri = `vmess://${Buffer.from(JSON.stringify(vmessJson)).toString("base64")}`;

            const rawList = [ssUri, trojanUri, vlessUri, vmessUri].join("\n");
            const base64Content = Buffer.from(rawList).toString("base64");

            const result = await importMagicProxySubscription({ content: base64Content });
            expect(result.nodeCount).toBe(4);
            expect(result.nodes.map((n) => n.name)).toEqual(["香港-SS", "日本-Trojan", "美国-VLESS", "新加坡-VMess"]);
            expect(result.nodes.map((n) => n.type)).toEqual(["ss", "trojan", "vless", "vmess"]);
        });
    });

    describe("fallback node and per-node healthcheck", () => {
        const TWO_NODE_YAML = `proxies:
  - name: Tokyo-01
    type: ss
    server: node.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
  - name: HK-01
    type: ss
    server: hk.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
`;

        it("startup repair rewrites the dynamic config with mihomo-side paths and hot reloads", async () => {
            await importMagicProxySubscription({ content: TWO_NODE_YAML });
            // 模拟旧版本写入的坏配置：provider 路径指向 App 侧目录
            mocks.providerFiles.set("/runtime/mihomo/config.yaml", `proxy-providers:\n  dreamyo-Subscription:\n    type: file\n    path: /app/web/.magic-proxy-runtime/subscription.yaml\n`);
            mocks.controllerFetch.mockClear();

            await repairMagicProxyRuntimeConfig();

            const dynamicConfig = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            expect(dynamicConfig["proxy-providers"]["dreamyo-Subscription"].path).toBe("/root/.config/mihomo/runtime/subscription.yaml");
            expect(dynamicConfig["proxy-groups"]).toEqual(expect.arrayContaining([expect.objectContaining({ name: GEMINIAI_GROUP })]));
            const reloadCalls = mocks.controllerFetch.mock.calls.filter(([url, init]) => {
                const parsed = new URL(String(url));
                return parsed.pathname === "/configs" && parsed.searchParams.get("force") === "true" && (init as RequestInit | undefined)?.method === "PUT";
            });
            expect(reloadCalls).toHaveLength(1);
        });

        it("generates a kernel fallback group and selects it as the service egress when a fallback node is set", async () => {
            await importMagicProxySubscription({ content: TWO_NODE_YAML });

            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "Tokyo-01", fallback_node: "HK-01" });

            const dynamicConfig = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            // 兜底成员经独立 failover provider 文件引入，保证「主节点优先」顺序（组员顺序跟随文件顺序）。
            expect(dynamicConfig["proxy-providers"]["dreamyo-Failover-Src-geminiai"]).toEqual({ type: "file", path: "/root/.config/mihomo/runtime/failover/geminiai.yaml" });
            expect(dynamicConfig["proxy-groups"]).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "dreamyo-Failover-GeminiAIStudio", type: "fallback", use: ["dreamyo-Failover-Src-geminiai"], url: "https://www.gstatic.com/generate_204", interval: 300, lazy: true }),
                    expect.objectContaining({ name: GEMINIAI_GROUP, proxies: expect.arrayContaining(["dreamyo-Failover-GeminiAIStudio"]) }),
                ]),
            );
            const failoverFile = parseDocument(mocks.providerFiles.get("/runtime/mihomo/failover/geminiai.yaml") || "").toJS();
            expect(failoverFile.proxies.map((node: { name: string }) => node.name)).toEqual(["Tokyo-01", "HK-01"]);
            expect(selectionFor(GEMINIAI_GROUP)).toBe("dreamyo-Failover-GeminiAIStudio");

            const overview = await getMagicProxyOverview();
            expect(overview.bindings.geminiai).toMatchObject({ enabled: true, node: "Tokyo-01", fallback_node: "HK-01" });

            // 清空兜底后回退到普通节点选中。
            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "Tokyo-01", fallback_node: "" });
            expect(selectionFor(GEMINIAI_GROUP)).toBe("Tokyo-01");
        });

        it("resolves the provider egress without queueing behind a long magic-proxy operation", async () => {
            await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "magic", node: "Tokyo-01" });

            // 用一个不会立刻返回的订阅刷新占住魔法代理运行锁
            let releaseSlow!: () => void;
            mocks.safeFetch.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        releaseSlow = () => resolve(new Response(SUBSCRIPTION_YAML, { status: 200 }));
                    }),
            );
            const slow = importMagicProxySubscription({ url: "https://subscription.example/slow.yaml" });
            await new Promise((resolve) => setTimeout(resolve, 0));

            // 生成请求解析出口必须立即返回，不能被慢操作堵在「排队中」
            const started = Date.now();
            const egress = await ensureMagicProxyProvider("geminiai");
            expect(Date.now() - started).toBeLessThan(1000);
            expect(egress).toMatchObject({ enabled: true, egress: { mode: "magic", node_name: "Tokyo-01" } });

            releaseSlow();
            await slow;
        });

        it("keeps the fallback node when the main node is saved first (user's two-step order)", async () => {
            await importMagicProxySubscription({ content: TWO_NODE_YAML });
            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "magic", node: "Tokyo-01" });
            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "magic", node: "Tokyo-01", fallback_node: "HK-01" });

            const overview = await getMagicProxyOverview();
            expect(overview.bindings.geminiai).toMatchObject({ enabled: true, node: "Tokyo-01", fallback_node: "HK-01" });
        });

        it("wires a hop fallback group for the chained dialer when a hop fallback is configured", async () => {
            vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT", "17892");
            vi.stubEnv("DREAMYO_MAGIC_PROXY_CHATGPT_API_URL", "http://mihomo-listener.test:17892");
            chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("http://landing.private.example:8080");
            await importMagicProxySubscription({ content: TWO_NODE_YAML });

            await updateMagicProxyBinding({
                provider: "chatgptApi",
                enabled: true,
                mode: "chained",
                chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-1", hop_fallback_node: "HK-01" },
            });

            // 跳板兜底写入独立 provider 文件，成员顺序 = [跳板, 兜底]（内核按文件顺序决定 fallback 优先级）
            const hopProviderFile = [...mocks.providerFiles.entries()].find(([path]) => path.includes("failover/hop-chatgptApi.yaml"));
            expect(hopProviderFile).toBeTruthy();
            expect(parseDocument(hopProviderFile![1]).toJS()).toMatchObject({ proxies: [{ name: "Tokyo-01" }, { name: "HK-01" }] });

            // 动态配置里声明 fallback 组与对应 provider
            const dynamicConfig = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            expect(dynamicConfig["proxy-providers"]["dreamyo-Failover-Hop-chatgptApi"]).toBeTruthy();
            expect(dynamicConfig["proxy-groups"]).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "dreamyo-Chained-Hop-Failover-ChatGPTAPI", type: "fallback", use: ["dreamyo-Failover-Hop-chatgptApi"] })]),
            );

            // dialer-proxy 指向兜底组，跳板失联由内核自动切换
            const exitNode = parseDocument(mocks.providerFiles.get("/runtime/mihomo/subscription.yaml") || "").toJS();
            expect(exitNode.proxies).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "dreamyo-Chained-Exit", "dialer-proxy": "dreamyo-Chained-Hop-Failover-ChatGPTAPI" })]),
            );

            // 兜底与跳板相同必须被拒绝
            await expect(
                updateMagicProxyBinding({
                    provider: "chatgptApi",
                    enabled: true,
                    mode: "chained",
                    chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-1", hop_fallback_node: "Tokyo-01" },
                }),
            ).rejects.toThrow("跳板兜底节点不能与跳板节点相同");
        });

        it("rejects a fallback node outside the subscription and forbids a policy group as fallback", async () => {
            await importMagicProxySubscription({ content: TWO_NODE_YAML });

            await expect(updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "Tokyo-01", fallback_node: "不存在的节点" })).rejects.toThrow("兜底节点不在当前订阅中");
        });

        it("probes a single node through the provider healthcheck endpoint without a group-wide dial", async () => {
            await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

            const single = await testMagicProxyNodeDelay({ node: "Tokyo-01" });
            expect(single).toEqual({ name: "Tokyo-01", delay: 77 });
            expect(
                mocks.controllerFetch.mock.calls.filter(([url]) => String(url).includes("/providers/proxies/dreamyo-Subscription/Tokyo-01/healthcheck")),
            ).toHaveLength(1);
            // 健康检查命中后不再发起组级全量拨号。
            expect(
                mocks.controllerFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith("/group/")),
            ).toHaveLength(0);
        });
    });

    describe("subscription policy groups and dynamic config", () => {
        const POLICY_GROUP_YAML = `proxies:
  - name: 日本3|电信
    type: vless
    server: jp3.private.example
    port: 443
    uuid: uuid-jp3
    udp: true
  - name: 香港1|三网
    type: vless
    server: hk1.private.example
    port: 443
    uuid: uuid-hk1
    udp: true
proxy-groups:
  - name: 红茶云
    type: select
    proxies:
      - 自动选择
      - 日本3|电信
  - name: 自动选择
    type: url-test
    proxies:
      - 日本3|电信
      - 香港1|三网
`;

        it("scopes each subscription's private DoH to its own node hostnames instead of applying it globally", async () => {
            // 实测 mihomo：proxy-server-nameserver 是解析代理服务器域名的唯一权威且不回退，
            // 设成全局值会让其他机场的节点域名全部解析失败，因此必须按订阅绑定到各自节点域名。
            // 机场常把 DoH 地址误写进 default-nameserver；内核要求该键必须是纯 IP，否则整份配置被拒绝。
            const dnsYaml = `dns:
  proxy-server-nameserver:
    - "https://panel-doh.example:9088/dns-query/c"
  default-nameserver:
    - "https://panel-doh.example:9088/dns-query/c"
    - 223.5.5.5
proxies:
  - name: Tokyo-01
    type: ss
    server: node.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
  - name: Direct-IP-01
    type: ss
    server: 203.0.113.7
    port: 443
    cipher: aes-256-gcm
    password: node-password
`;
            const otherAirportYaml = `proxies:
  - name: Other-01
    type: ss
    server: other.airport.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
`;
            await importMagicProxySubscription({ content: dnsYaml });
            await importMagicProxySubscription({ content: otherAirportYaml });

            const dynamicConfig = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            // 不设全局 proxy-server-nameserver：那会接管其他订阅的节点域名解析。
            expect(dynamicConfig.dns["proxy-server-nameserver"]).toBeUndefined();
            // 全局 nameserver 兜底公共 DNS，避免未命中策略的域名（如通用代理落地节点）无法解析
            expect(dynamicConfig.dns.nameserver).toEqual(["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"]);
            expect(dynamicConfig.dns.enable).toBe(true);
            // 只绑定该订阅自己的节点域名；IP 直连节点与其他订阅的域名都不进入策略。
            expect(dynamicConfig.dns["nameserver-policy"]).toEqual({
                "node.private.example": ["https://panel-doh.example:9088/dns-query/c"],
            });
            // default-nameserver 只保留纯 IP，DoH 地址被丢弃（否则内核拒绝整份配置）
            expect(dynamicConfig.dns["default-nameserver"]).toEqual(["223.5.5.5"]);

            // 替换导入（无 dns 段）后 dns 配置整体移除
            await importMagicProxySubscription({ content: SUBSCRIPTION_YAML, replace: true });
            const refreshed = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            expect(refreshed.dns).toBeUndefined();
        });

        it("drops loopback resolvers the container cannot use and keeps those node hostnames on system DNS", async () => {
            // 真实机场写法：proxy-server-nameserver 指向它自己客户端的本机 DNS。
            // 在 mihomo 容器里 127.0.0.1:7874 没有任何服务，绑上去会让该订阅全部节点极速解析失败。
            const loopbackDnsYaml = `dns:
  proxy-server-nameserver:
    - "udp://127.0.0.1:7874"
proxies:
  - name: HK-01
    type: anytls
    server: 086d67b3-9a39-4363-a0dd-f3da531a4db1.ro7xtkti5v.sbs
    port: 8327
    password: node-password
    sni: cache-v1.edge.example.cn
`;
            // 另一个订阅用真正可用的 DoH，仍应按订阅绑定。
            const usableDnsYaml = `dns:
  proxy-server-nameserver:
    - "https://panel-doh.example:9088/dns-query/c"
proxies:
  - name: JP-01
    type: ss
    server: jp.private.example
    port: 443
    cipher: aes-256-gcm
    password: node-password
`;
            await importMagicProxySubscription({ content: loopbackDnsYaml });
            await importMagicProxySubscription({ content: usableDnsYaml });

            const dynamicConfig = parseDocument(mocks.providerFiles.get("/runtime/mihomo/config.yaml") || "").toJS();
            const policy = dynamicConfig.dns["nameserver-policy"];
            // loopback 解析器不产生策略条目，该域名回落系统 DNS（服务器实测可正常解析）
            expect(policy["086d67b3-9a39-4363-a0dd-f3da531a4db1.ro7xtkti5v.sbs"]).toBeUndefined();
            expect(policy["jp.private.example"]).toEqual(["https://panel-doh.example:9088/dns-query/c"]);
        });

        it("prefers persisted test results over stale mihomo provider history in the overview", async () => {
            await importMagicProxySubscription({ url: SUBSCRIPTION_URL });

            // 单节点测速持久化 77ms；mock 的 provider 历史固定为 42ms
            const single = await testMagicProxyNodeDelay({ node: "Tokyo-01" });
            expect(single.delay).toBe(77);
            // persistNodeDelays 为异步落盘，等待写完成后断言
            await new Promise((resolve) => setTimeout(resolve, 100));

            const overview = await getMagicProxyOverview();
            expect(overview.nodes[0]?.delay).toBe(77);
        });

        it("generates the dynamic config with mihomo-side provider paths, policy groups, and a hot reload", async () => {
            await importMagicProxySubscription({ content: POLICY_GROUP_YAML });

            const configFile = "/runtime/mihomo/config.yaml";
            expect(mocks.providerFiles.has(configFile)).toBe(true);
            const dynamicConfig = parseDocument(mocks.providerFiles.get(configFile) || "").toJS();
            expect(dynamicConfig.profile).toEqual({ "store-selected": true });
            expect(dynamicConfig["proxy-providers"]["dreamyo-Subscription"]).toEqual({ type: "file", path: "/root/.config/mihomo/runtime/subscription.yaml" });
            // 内核不允许组 proxies 直接引用 provider 节点名：策略组必须 use + 组级 filter 圈定成员。
            expect(dynamicConfig["proxy-groups"]).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: GEMINIAI_GROUP, type: "select", proxies: expect.arrayContaining(["DIRECT", "自动选择"]) }),
                    expect.objectContaining({ name: "自动选择", type: "url-test", use: ["dreamyo-Subscription"], filter: "^(?:日本3\\|电信|香港1\\|三网)$", url: "https://www.gstatic.com/generate_204", interval: 300, lazy: true }),
                ]),
            );
            // 订阅内引用其他组的「红茶云」选择器成员被剔除后不足以成组，不得生成非法组实体。
            expect((dynamicConfig["proxy-groups"] as Array<Record<string, unknown>>).some((grp) => grp.name === "红茶云")).toBe(false);

            const reloadCalls = mocks.controllerFetch.mock.calls.filter(([url, init]) => {
                const parsed = new URL(String(url));
                return parsed.pathname === "/configs" && parsed.searchParams.get("force") === "true" && (init as RequestInit | undefined)?.method === "PUT";
            });
            expect(reloadCalls).toHaveLength(1);
            expect(JSON.parse(String((reloadCalls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({ path: "/root/.config/mihomo/runtime/config.yaml" });

            const overview = await getMagicProxyOverview();
            expect(overview.subscriptionGroups).toEqual([expect.objectContaining({ name: "自动选择", type: "url-test", subName: "本地文件订阅", proxies: ["日本3|电信", "香港1|三网"] })]);
        });

        it("allows binding a service to a subscription policy group like 自动选择", async () => {
            await importMagicProxySubscription({ content: POLICY_GROUP_YAML });

            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, node: "自动选择" });
            expect(selectionFor(GEMINIAI_GROUP)).toBe("自动选择");

            const overview = await getMagicProxyOverview();
            expect(overview.bindings.geminiai).toMatchObject({ enabled: true, node: "自动选择" });

            await expect(updateMagicProxyBinding({ provider: "geminiTools", enabled: true, node: "不存在的组" })).rejects.toThrow("所选节点不在当前订阅中");
        });

        it("diagnoses a geminiai chained exit failure as hop-to-landing instead of a dead node", async () => {
            chatGptServiceMocks.resolveGenericProxyNodeUrl.mockResolvedValue("http://landing.private.example:8080");
            await importMagicProxySubscription({ url: SUBSCRIPTION_URL });
            await updateMagicProxyBinding({ provider: "geminiai", enabled: true, mode: "chained", chained_config: { hop_node: "Tokyo-01", landing_node_id: "landing-g" } });

            const previousImplementation = mocks.controllerFetch.getMockImplementation();
            mocks.controllerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
                const parsed = new URL(String(input));
                if (parsed.pathname === `/proxies/${encodeURIComponent(GEMINIAI_GROUP)}` && init?.method === "GET") {
                    return jsonResponse({ name: GEMINIAI_GROUP, type: "Selector", now: "dreamyo-Chained-Exit-geminiai" });
                }
                // 复刻真实故障：跳板节点本身可达（延迟 88ms），但链式出口访问 Google 失败。
                if (parsed.pathname.startsWith("/group/") && parsed.pathname.endsWith("/delay") && parsed.searchParams.get("url")?.includes("google")) {
                    return jsonResponse({ DIRECT: 60, "Tokyo-01": 88 });
                }
                return controllerResponse(String(input), init);
            });

            try {
                const report = await testMagicProxyGoogleAccess();
                const geminiaiItem = report.items.find((item) => item.service === "geminiai");
                expect(geminiaiItem?.activeNode).toBe("dreamyo-Chained-Exit-geminiai");
                expect(geminiaiItem?.error).toContain("跳板 Tokyo-01 正常（88ms）");
                expect(geminiaiItem?.error).toContain("跳板→落地→目标 链路访问 Google 失败");
                expect(geminiaiItem?.error).not.toContain("节点可能已失效或被墙");
            } finally {
                if (previousImplementation) mocks.controllerFetch.mockImplementation(previousImplementation);
            }
        });
    });
});

function controllerResponse(url: string, init?: RequestInit) {
    const parsed = new URL(url);
    if (parsed.pathname === PROVIDER_ENDPOINT && init?.method === "GET") return jsonResponse({ proxies: providerRuntimeNodes() });
    if (parsed.pathname === PROVIDER_ENDPOINT && init?.method === "PUT") return new Response(null, { status: 204 });
    const providerHealthcheck = parsed.pathname.match(/^\/providers\/proxies\/dreamyo-Subscription\/([^/]+)\/healthcheck$/);
    if (providerHealthcheck && init?.method === "GET") {
        const nodeName = decodeURIComponent(providerHealthcheck[1]);
        if (nodeName === "Tokyo-01") return jsonResponse({ delay: 77 });
        // 节点存在但拨号失败：mihomo 用 503 + 通用文案表达，不含任何原因。
        if (nodeName === "HK-01") return jsonResponse({ message: "An error occurred in the delay test" }, 503);
        return jsonResponse({ delay: 0 });
    }
    if (parsed.pathname === "/proxies" && parsed.search === "" && init?.method === "GET") return groupsResponse(providerRuntimeNodes().map((node) => node.name));
    // 组级测速：mihomo 对 provider 节点的 /proxies/<name>/delay 一律 404，只有组测速返回真实延迟。
    if (parsed.pathname.startsWith("/group/") && parsed.pathname.endsWith("/delay") && init?.method === "GET") {
        const target = parsed.searchParams.get("url") || "";
        const delays: Record<string, number> = target.includes("google") ? { DIRECT: 60 } : { DIRECT: 42, "Tokyo-01": 88 };
        return jsonResponse(delays);
    }
    if (parsed.pathname === `/proxies/${encodeURIComponent(CHATGPT_API_GROUP)}` && init?.method === "PUT" && !chatgptApiRuntimeConfigured()) return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
}

function groupsResponse(nodeNames: string[]) {
    const chatgptApiGroup = chatgptApiRuntimeConfigured() ? { [CHATGPT_API_GROUP]: { name: CHATGPT_API_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] } } : {};
    const dolaGroup = dolaRuntimeConfigured() ? { [DOLA_GROUP]: { name: DOLA_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] } } : {};
    return jsonResponse({
        proxies: {
            [GEMINIAI_GROUP]: { name: GEMINIAI_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] },
            [GEMINI_TOOLS_GROUP]: { name: GEMINI_TOOLS_GROUP, type: "Selector", now: "DIRECT", all: ["DIRECT", ...nodeNames] },
            ...chatgptApiGroup,
            ...dolaGroup,
        },
    });
}

function chatgptApiRuntimeConfigured() {
    return Boolean(process.env.DREAMYO_MAGIC_PROXY_CHATGPT_API_PORT && process.env.DREAMYO_MAGIC_PROXY_CHATGPT_API_URL);
}

function dolaRuntimeConfigured() {
    return Boolean(process.env.DREAMYO_MAGIC_PROXY_DOLA_PORT && process.env.DREAMYO_MAGIC_PROXY_DOLA_URL);
}

function jsonResponse(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function groupDelayCalls() {
    return mocks.controllerFetch.mock.calls.filter(([url, init]) => {
        const parsed = new URL(String(url));
        return parsed.pathname.startsWith("/group/") && parsed.pathname.endsWith("/delay") && (init as RequestInit | undefined)?.method === "GET";
    });
}

/** 假 socket：只触发诊断代码注册的期望事件，避免单元测试真的建 TCP 连接。 */
function fakeSocket(event: "connect" | "timeout" | "error") {
    const socket = {
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        once: vi.fn((name: string, callback: () => void) => {
            if (name === event) queueMicrotask(callback);
            return socket;
        }),
    };
    return socket;
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

function selectionFor(group: string) {
    const call = mocks.controllerFetch.mock.calls.findLast(([url, init]) => new URL(String(url)).pathname === `/proxies/${encodeURIComponent(group)}` && (init as RequestInit | undefined)?.method === "PUT");
    return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body || "{}"))?.name;
}
