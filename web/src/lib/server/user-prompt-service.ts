import sharp from "sharp";

import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { createPrompt, deletePrompt, getPrompt, updatePrompt, type PromptInput } from "@/lib/prompts/store";
import { deleteUserLocalMediaAssets } from "@/lib/server/local-media-storage";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";
import { writePersistentMediaDataUrl } from "@/lib/server/reference-asset-store";

const PROMPT_COVER_INPUT_PIXELS = 48_000_000;

export type PromptCoverUpload = {
    bytes: Uint8Array;
    mimeType: string;
    originalName?: string;
};

export class UserPromptServiceError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "UserPromptServiceError";
    }
}

export async function createUserPrompt(userId: string, input: PromptInput, cover?: PromptCoverUpload) {
    const stored = cover ? await persistPromptCover(userId, cover) : null;
    try {
        return await createPrompt("user", stored ? { ...input, coverUrl: stored.url } : input, userId);
    } catch (error) {
        if (stored) await deleteUserLocalMediaAssets(userId, [stored.token]).catch(() => undefined);
        throw error;
    }
}

export async function updateUserPrompt(userId: string, id: string, input: PromptInput, cover?: PromptCoverUpload) {
    const previous = await getPrompt(id, { scope: "user", ownerUserId: userId });
    const stored = cover ? await persistPromptCover(userId, cover) : null;
    try {
        const updated = await updatePrompt(id, stored ? { ...input, coverUrl: stored.url } : input, { scope: "user", ownerUserId: userId });
        await removeReplacedCover(userId, previous.coverUrl, updated.coverUrl);
        return updated;
    } catch (error) {
        if (stored) await deleteUserLocalMediaAssets(userId, [stored.token]).catch(() => undefined);
        throw error;
    }
}

export async function deleteUserPrompt(userId: string, id: string) {
    const prompt = await getPrompt(id, { scope: "user", ownerUserId: userId });
    const result = await deletePrompt(id, { scope: "user", ownerUserId: userId });
    await removeReplacedCover(userId, prompt.coverUrl, "");
    return result;
}

async function persistPromptCover(userId: string, input: PromptCoverUpload) {
    if (!/^image\/(?:png|jpe?g|webp)$/i.test(input.mimeType)) throw new UserPromptServiceError("仅支持 PNG、JPG 或 WebP 图片");
    if (!input.bytes.length) throw new UserPromptServiceError("图片文件不能为空");
    if (input.bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new UserPromptServiceError("图片文件不能超过 20MB", 413);

    let webp: Buffer;
    try {
        webp = await sharp(input.bytes, { failOn: "error", limitInputPixels: PROMPT_COVER_INPUT_PIXELS }).rotate().webp({ quality: 86, effort: 4 }).toBuffer();
    } catch {
        throw new UserPromptServiceError("图片无法读取或尺寸过大");
    }

    const stored = await writePersistentMediaDataUrl(`data:image/webp;base64,${webp.toString("base64")}`, "image", {
        ownerUserId: userId,
        source: "user-prompt-cover",
        originalName: promptCoverName(input.originalName),
        maxBytes: CREATIVE_UPLOAD_MAX_BYTES,
    });
    return { token: stored.token, url: `/api/reference-assets/${stored.token.split("/").map(encodeURIComponent).join("/")}` };
}

async function removeReplacedCover(userId: string, previousUrl: string, nextUrl: string) {
    const previousKey = localMediaStorageKeyFromValue(previousUrl);
    if (!previousKey || previousKey === localMediaStorageKeyFromValue(nextUrl)) return;
    await deleteUserLocalMediaAssets(userId, [previousKey]).catch(() => undefined);
}

function promptCoverName(value?: string) {
    const base =
        (value || "prompt-cover")
            .trim()
            .replace(/^.*[\\/]/, "")
            .replace(/\.[^.]+$/, "")
            .slice(0, 240) || "prompt-cover";
    return `${base}.webp`;
}
