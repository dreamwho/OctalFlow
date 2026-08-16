export type VersionCheckResult = { available: true; version: string; changelog: string } | { available: false };

export async function fetchVersionCheck(): Promise<VersionCheckResult | null> {
    try {
        const response = await fetch("/api/version-check");
        if (!response.ok) return null;
        const payload = (await response.json()) as { code: number; data: VersionCheckResult | null };
        return payload.code === 0 ? payload.data : null;
    } catch {
        return null;
    }
}
