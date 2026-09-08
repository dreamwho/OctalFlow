import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createPrompt: vi.fn(),
    deletePrompt: vi.fn(),
    getPrompt: vi.fn(),
    updatePrompt: vi.fn(),
    deleteMedia: vi.fn(),
    writeMedia: vi.fn(),
    toBuffer: vi.fn(),
}));

vi.mock("sharp", () => ({
    default: vi.fn(() => {
        const pipeline = { rotate: vi.fn(), webp: vi.fn(), toBuffer: mocks.toBuffer };
        pipeline.rotate.mockReturnValue(pipeline);
        pipeline.webp.mockReturnValue(pipeline);
        return pipeline;
    }),
}));
vi.mock("@/lib/prompts/store", () => ({ createPrompt: mocks.createPrompt, deletePrompt: mocks.deletePrompt, getPrompt: mocks.getPrompt, updatePrompt: mocks.updatePrompt }));
vi.mock("@/lib/server/local-media-storage", () => ({ deleteUserLocalMediaAssets: mocks.deleteMedia }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writePersistentMediaDataUrl: mocks.writeMedia }));

import { createUserPrompt, deleteUserPrompt, updateUserPrompt, UserPromptServiceError } from "./user-prompt-service";

describe("user prompt service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.toBuffer.mockResolvedValue(Buffer.from("webp"));
        mocks.writeMedia.mockResolvedValue({ token: "permanent/2026/09/04/images/cover.webp" });
        mocks.deleteMedia.mockResolvedValue({ deletedFiles: 1, deletedBytes: 4, blocked: [] });
        mocks.createPrompt.mockImplementation(async (_scope, input) => ({ id: "prompt-one", ...input }));
        mocks.updatePrompt.mockImplementation(async (id, input) => ({ id, ...input }));
        mocks.deletePrompt.mockResolvedValue({ ok: true });
    });

    it("persists a validated cover together with a new prompt", async () => {
        const result = await createUserPrompt("user-one", { title: "标题", prompt: "内容" }, { bytes: new Uint8Array([1]), mimeType: "image/png", originalName: "cover.png" });

        expect(result.coverUrl).toBe("/api/reference-assets/permanent/2026/09/04/images/cover.webp");
        expect(mocks.writeMedia).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/webp;base64,/), "image", expect.objectContaining({ ownerUserId: "user-one", source: "user-prompt-cover", originalName: "cover.webp" }));
    });

    it("replaces and removes the prior owned cover after updating", async () => {
        mocks.getPrompt.mockResolvedValue({ id: "prompt-one", coverUrl: "/api/reference-assets/permanent/old.webp" });

        await updateUserPrompt("user-one", "prompt-one", { title: "新标题", prompt: "内容" }, { bytes: new Uint8Array([1]), mimeType: "image/jpeg", originalName: "new.jpg" });

        expect(mocks.deleteMedia).toHaveBeenCalledWith("user-one", ["permanent/old.webp"]);
    });

    it("removes an owned cover after deleting its prompt", async () => {
        mocks.getPrompt.mockResolvedValue({ id: "prompt-one", coverUrl: "/api/reference-assets/permanent/old.webp" });

        await deleteUserPrompt("user-one", "prompt-one");

        expect(mocks.deletePrompt).toHaveBeenCalledWith("prompt-one", { scope: "user", ownerUserId: "user-one" });
        expect(mocks.deleteMedia).toHaveBeenCalledWith("user-one", ["permanent/old.webp"]);
    });

    it("rejects unsupported cover files before persistence", async () => {
        await expect(createUserPrompt("user-one", { title: "标题", prompt: "内容" }, { bytes: new Uint8Array([1]), mimeType: "image/svg+xml" })).rejects.toBeInstanceOf(UserPromptServiceError);
        expect(mocks.writeMedia).not.toHaveBeenCalled();
    });
});
