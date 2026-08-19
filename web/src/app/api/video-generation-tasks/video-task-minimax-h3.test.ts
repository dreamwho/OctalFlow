import { beforeEach, describe, expect, it, vi } from "vitest";

const { imageReferenceToFile } = vi.hoisted(() => ({
    imageReferenceToFile: vi.fn(async (_reference: unknown, name: string) => new File([Buffer.from("image-bytes")], name, { type: "image/png" })),
}));

vi.mock("@/app/api/image-tasks/image-task-support", () => ({ imageReferenceToFile }));

import { buildMinimaxH3VideoFormData } from "./video-task-minimax-h3";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

const PUBLIC_IMAGE = "https://cdn.example.com/dog.png";
const LOCAL_IMAGE = "http://localhost:3000/api/reference-assets/token?purpose=provider-read&expires=1&signature=test";

function reference(overrides: Partial<VideoGenerationReference> = {}): VideoGenerationReference {
    return { type: "image", url: PUBLIC_IMAGE, ...overrides };
}

function build(references: VideoGenerationReference[], overrides: Partial<Parameters<typeof buildMinimaxH3VideoFormData>[0]> = {}) {
    return buildMinimaxH3VideoFormData({
        model: "minimax-h3-base",
        prompt: "a dog runs",
        resolution: "480p",
        aspectRatio: "16:9",
        duration: 5,
        references,
        origin: "http://localhost:3000",
        publicOrigin: "http://localhost:3000",
        cookie: "",
        ...overrides,
    });
}

describe("minimax-h3 multipart form", () => {
    beforeEach(() => {
        imageReferenceToFile.mockClear();
    });

    it("keeps the JSON path for t2va and for fully public media", async () => {
        expect(await build([])).toBeUndefined();
        expect(await build([reference(), reference({ type: "video", url: "https://cdn.example.com/dog.mp4" })])).toBeUndefined();
        expect(imageReferenceToFile).not.toHaveBeenCalled();
    });

    it("attaches the local first frame as a file field", async () => {
        const form = await build([reference({ role: "first_frame", url: LOCAL_IMAGE })]);
        expect(form).toBeInstanceOf(FormData);
        expect(form!.get("model")).toBe("minimax-h3-base");
        expect(form!.get("mode")).toBe("i2va");
        expect(form!.get("resolution")).toBe("480p");
        expect(form!.get("seconds")).toBe("5");
        expect(form!.get("prompt")).toBe("a dog runs");
        expect(form!.get("aspect_ratio")).toBe("16:9");
        const images = form!.getAll("images");
        expect(images).toHaveLength(1);
        expect(images[0]).toBeInstanceOf(File);
        expect((images[0] as File).name).toBe("reference-1.png");
        expect(imageReferenceToFile).toHaveBeenCalledWith({ dataUrl: "", url: "/api/reference-assets/token?purpose=provider-read&expires=1&signature=test" }, "reference-1.png", "http://localhost:3000", "");
    });

    it("keeps first and last frame order for fl2va", async () => {
        const form = await build([reference({ role: "first_frame", url: LOCAL_IMAGE }), reference({ role: "last_frame", url: `${LOCAL_IMAGE}&index=2` })]);
        expect(form!.get("mode")).toBe("fl2va");
        const images = form!.getAll("images");
        expect(images).toHaveLength(2);
        expect(images.every((item) => item instanceof File)).toBe(true);
        expect((images[0] as File).name).toBe("reference-1.png");
        expect((images[1] as File).name).toBe("reference-2.png");
    });

    it("mixes public URL media with local image files in ref2va", async () => {
        const form = await build([reference({ url: PUBLIC_IMAGE }), reference({ url: LOCAL_IMAGE }), reference({ type: "video", url: "https://cdn.example.com/dog.mp4" }), reference({ type: "audio", url: "https://cdn.example.com/bark.mp3" })]);
        expect(form!.get("mode")).toBe("ref2va");
        const images = form!.getAll("images");
        expect(images[0]).toBe(PUBLIC_IMAGE);
        expect(images[1]).toBeInstanceOf(File);
        expect(form!.getAll("videos")).toEqual(["https://cdn.example.com/dog.mp4"]);
        expect(form!.getAll("audios")).toEqual(["https://cdn.example.com/bark.mp3"]);
        expect(imageReferenceToFile).toHaveBeenCalledTimes(1);
    });
});
