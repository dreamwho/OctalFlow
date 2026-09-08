import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

describe("application proxy security", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("ignores spoofed forwarded origins unless a trusted proxy is configured", () => {
        const request = writeRequest({
            origin: "https://public.example.com",
            "x-forwarded-host": "public.example.com",
            "x-forwarded-proto": "https",
        });

        expect(proxy(request).status).toBe(403);
        vi.stubEnv("OCTALAICANVAS_TRUSTED_PROXY_HOPS", "1");
        expect(proxy(request).status).toBe(200);
    });

    it("uses a per-request script nonce and upgrades only HTTPS production requests", () => {
        vi.stubEnv("NODE_ENV", "production");

        const httpsPolicy = proxy(new NextRequest("https://app.example.com/create")).headers.get("content-security-policy") || "";
        const lanHttpPolicy = proxy(new NextRequest("http://192.168.100.223:8866/create")).headers.get("content-security-policy") || "";

        expect(httpsPolicy).toMatch(/script-src 'self' 'nonce-[a-f0-9]+' 'strict-dynamic'/);
        expect(httpsPolicy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(httpsPolicy).toContain("connect-src 'self' https:");
        expect(httpsPolicy).not.toContain("http://localhost:*");
        expect(httpsPolicy).toContain("upgrade-insecure-requests");
        expect(lanHttpPolicy).not.toContain("upgrade-insecure-requests");
    });

    it("uses forwarded HTTPS only when the existing trusted-proxy contract is configured", () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("OCTALAICANVAS_TRUSTED_PROXY_HOPS", "0");

        const request = new NextRequest("http://192.168.100.223:8866/create", { headers: { "x-forwarded-proto": "https" } });
        expect(proxy(request).headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");

        vi.stubEnv("OCTALAICANVAS_TRUSTED_PROXY_HOPS", "1");
        expect(proxy(request).headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
    });

    it("permits the token-gated local Canvas Agent bridge only from a local canvas host", () => {
        vi.stubEnv("NODE_ENV", "production");

        const policy = proxy(new NextRequest("http://localhost:3333/canvas/canvas-one")).headers.get("content-security-policy") || "";

        expect(policy).toContain("http://localhost:*");
        expect(policy).toContain("http://127.0.0.1:*");
        expect(policy).not.toContain("http://[::1]:*");
        expect(policy).not.toContain("upgrade-insecure-requests");
    });
});

function writeRequest(headers: Record<string, string>) {
    return new NextRequest("http://app.internal/api/auth/login", { method: "POST", headers });
}
