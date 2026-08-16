import { NextResponse } from "next/server";

import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

const VERSION_URL = "https://raw.githubusercontent.com/dreamwho/OctalAICanvas/main/VERSION";
const CHANGELOG_URL = "https://raw.githubusercontent.com/dreamwho/OctalAICanvas/main/CHANGELOG.md";
const CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 5000;

export type VersionCheckPayload = { available: true; version: string; changelog: string } | { available: false };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cache: { at: number; payload: VersionCheckPayload } | null = null;

export async function GET() {
    if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
        cache = { at: Date.now(), payload: await loadPayload() };
    }
    return NextResponse.json({ code: 0, data: cache.payload, msg: "版本检查完成" }, { headers: { "cache-control": "no-store" } });
}

async function loadPayload(): Promise<VersionCheckPayload> {
    try {
        const [versionResponse, changelogResponse] = await Promise.all([
            fetchSafeOutbound(VERSION_URL, { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
            fetchSafeOutbound(CHANGELOG_URL, { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
        ]);
        if (!versionResponse.ok || !changelogResponse.ok) return { available: false };
        return { available: true, version: (await versionResponse.text()).trim(), changelog: await changelogResponse.text() };
    } catch {
        return { available: false };
    }
}
