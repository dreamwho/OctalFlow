import { createHash, timingSafeEqual } from "node:crypto";

export type DesktopEdition = "commercial" | "admin";

export type DesktopRuntimeInfo = {
    edition: DesktopEdition;
    requiresLogin: boolean;
    cloudFeatures: boolean;
    localProviders: boolean;
    localProviderBilling: "free";
    localData: boolean;
    cloudSync: boolean;
    implementationStage: "foundation";
};

export function getDesktopEdition(environment = process.env): DesktopEdition | null {
    const edition = environment.DREAMYO_DESKTOP_EDITION?.trim().toLowerCase();
    return edition === "commercial" || edition === "admin" ? edition : null;
}

export function getDesktopRuntimeInfo(environment = process.env): DesktopRuntimeInfo | null {
    const edition = getDesktopEdition(environment);
    if (!edition) return null;
    return {
        edition,
        requiresLogin: edition === "commercial",
        cloudFeatures: false,
        localProviders: true,
        localProviderBilling: "free",
        localData: true,
        cloudSync: false,
        implementationStage: "foundation",
    };
}

export function isTrustedDesktopRequest(request: Request, environment = process.env) {
    if (!getDesktopEdition(environment)) return false;
    const expected = normalizeToken(environment.DREAMYO_DESKTOP_SESSION_TOKEN);
    const actual = normalizeToken(request.headers.get("x-dreamyo-desktop-token"));
    if (!expected || !actual || !timingSafeEqual(digest(expected), digest(actual))) return false;
    try {
        const hostname = new URL(request.url).hostname.toLowerCase();
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
    } catch {
        return false;
    }
}

export function safeDesktopNextPath(value: string | null, fallback = "/canvas") {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
    return value;
}


function normalizeToken(value: unknown) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length >= 32 && normalized.length <= 512 ? normalized : null;
}

function digest(value: string) {
    return createHash("sha256").update(value, "utf8").digest();
}
