import { describe, expect, it } from "vitest";
import { labelWorkbenchReferences, workbenchAssetReference, workbenchMediaKind, workbenchVideoReferences } from "./image-video-workbench-references";

describe("workbench mixed reference snapshots", () => {
    it("preserves first and last frame roles when restoring video references", () => {
        const references = [
            { id: "first", kind: "image" as const, role: "first_frame" as const, name: "first.png", mimeType: "image/png", url: "/first.png" },
            { id: "last", kind: "image" as const, role: "last_frame" as const, name: "last.png", mimeType: "image/png", url: "/last.png" },
        ];
        expect(workbenchVideoReferences(JSON.parse(JSON.stringify(references))).images.map((item) => item.videoRole)).toEqual(["first_frame", "last_frame"]);
    });

    it("retains stable media identity across JSON history and replay without uploading copies", () => {
        const references = ["image", "video", "audio"].map((kind) => ({ id: kind, kind, name: `${kind}.fixture`, mimeType: `${kind}/fixture`, url: `/api/reference-assets/permanent/${kind}`, storageKey: `permanent/${kind}` }));
        const replay = workbenchVideoReferences(JSON.parse(JSON.stringify(references)));
        expect(replay.images).toMatchObject([{ id: "image", storageKey: "permanent/image" }]);
        expect(replay.videos).toMatchObject([{ id: "video", url: references[1].url, storageKey: "permanent/video" }]);
        expect(replay.audios).toMatchObject([{ id: "audio", url: references[2].url, storageKey: "permanent/audio" }]);
    });
    it("keeps typed reference numbering independent after removal", () => {
        const references = ["video", "audio", "video"].map((kind, index) => ({ id: String(index), nodeId: String(index), kind, title: kind, label: "", active: true }));
        expect(labelWorkbenchReferences(references as never).map((item) => item.label)).toEqual(["视频1", "音频1", "视频2"]);
        expect(labelWorkbenchReferences(references.slice(1) as never).map((item) => item.label)).toEqual(["音频1", "视频1"]);
    });
    it("reuses the library source URL and detects only supported media types", () => {
        expect(workbenchAssetReference({ id: "audio", kind: "audio", title: "声音", data: { url: "/api/generation-log-assets/permanent/song.mp3", storageKey: "permanent/song.mp3", mimeType: "audio/mpeg", durationMs: 2000 } } as never)).toMatchObject({ kind: "audio", storageKey: "permanent/song.mp3", durationMs: 2000 });
        expect(workbenchMediaKind("audio/mpeg")).toBe("audio");
        expect(workbenchMediaKind("application/pdf")).toBeUndefined();
    });
});
