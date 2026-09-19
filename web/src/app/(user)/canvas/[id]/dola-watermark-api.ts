export async function resolveCanvasDolaWatermark(input: { storageKey: string; payload: unknown }) {
    const response = await fetch("/api/canvas/dola-watermark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const payload = (await response.json().catch(() => null)) as { data?: { downloadUrl?: string; resolverRevision?: string; variant?: { width?: number; height?: number; duration?: number } }; msg?: string } | null;
    if (!response.ok || !payload?.data?.downloadUrl) throw new Error(payload?.msg || "Dola 去水印失败");
    return payload.data;
}
