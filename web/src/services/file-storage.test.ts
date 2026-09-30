import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ uploadServerMedia: vi.fn(async () => ({ url: "/api/reference-assets/permanent/video.mp4", storageKey: "permanent/video.mp4", bytes: 128, mimeType: "video/mp4" })) }));
vi.mock("@/services/server-media-storage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/services/server-media-storage")>()), uploadServerMedia: mocks.uploadServerMedia }));

import { readStoredMediaFile, uploadGeneratedMediaFile, uploadMediaFile } from "./file-storage";

describe("stored video completion", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns persisted video metadata without waiting for browser media decoding", async () => {
        vi.stubGlobal("document", { createElement: () => { throw new Error("media decoder should not be needed"); } });
        const stored = await readStoredMediaFile("/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4?download=original", "video", "video/mp4");
        const uploaded = await uploadGeneratedMediaFile(new Blob(["video"], { type: "video/mp4" }), "video");
        expect(stored).toEqual({ url: "/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4", serverUrl: "/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4", storageKey: "permanent/2026/07/27/videos/result.mp4", bytes: 0, mimeType: "video/mp4" });
        expect(uploaded).toMatchObject({ storageKey: "permanent/video.mp4", bytes: 128 });
    });

    it("uses local upload metadata when ready and never waits for a stalled decoder", async () => {
        let loadMetadata = true;
        vi.stubGlobal("document", { createElement: () => ({
            videoWidth: 1920, videoHeight: 1080, duration: 5,
            onloadedmetadata: null as (() => void) | null,
            onerror: null as (() => void) | null,
            set src(_url: string) { if (loadMetadata) this.onloadedmetadata?.(); },
        }) });
        const ready = await uploadMediaFile("data:video/mp4;base64,dmlkZW8=", "video");
        expect(ready).toMatchObject({ width: 1920, height: 1080, durationMs: 5000 });
        loadMetadata = false;
        const stalled = await uploadMediaFile("data:video/mp4;base64,dmlkZW8=", "video");
        expect(stalled).not.toHaveProperty("durationMs");
    });
});
