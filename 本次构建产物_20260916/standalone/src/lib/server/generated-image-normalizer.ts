import sharp, { type Metadata } from "sharp";

// Keep the decode guard aligned with the existing local/object-media boundary.
// This covers official 8K outputs without turning the limit into a model-size rule.
export const MAX_GENERATED_IMAGE_INPUT_PIXELS = 100_000_000;

type NormalizedGeneratedImage = {
    bytes: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
};

// 上游返回的图片原样落盘，不做自动放大、缩小或裁切；需要超清放大时由用户显式操作。
export async function normalizeGeneratedImageBytes(bytes: Buffer, mimeType: string): Promise<NormalizedGeneratedImage> {
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_GENERATED_IMAGE_INPUT_PIXELS }).metadata();
    return { bytes, mimeType: imageMimeType(metadata.format, mimeType), ...orientedDimensions(metadata) };
}

// 仅用于 GPTAPI“中/高画质”的显式导出放大：Lanczos 放大到目标长边，不裁切、不改变宽高比；
// 上游结果已不小于目标长边时原样保留。
export async function upscaleGeneratedImageBytes(bytes: Buffer, mimeType: string, longEdge: number): Promise<NormalizedGeneratedImage> {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_GENERATED_IMAGE_INPUT_PIXELS });
    const metadata = await image.metadata();
    const currentLongEdge = Math.max(metadata.width || 0, metadata.height || 0);
    if (!currentLongEdge || currentLongEdge >= longEdge) return { bytes, mimeType: imageMimeType(metadata.format, mimeType), ...orientedDimensions(metadata) };
    const scale = longEdge / currentLongEdge;
    const width = Math.max(1, Math.round((metadata.width || 1) * scale));
    const height = Math.max(1, Math.round((metadata.height || 1) * scale));
    const result = await image.clone().resize(width, height, { kernel: "lanczos3" }).toBuffer({ resolveWithObject: true });
    return { bytes: result.data, mimeType: imageMimeType(result.info.format, mimeType), width, height };
}

function orientedDimensions(metadata: Metadata) {
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    return {
        width: Number.isFinite(width) && Number(width) > 0 ? Number(width) : undefined,
        height: Number.isFinite(height) && Number(height) > 0 ? Number(height) : undefined,
    };
}

function imageMimeType(format: string | undefined, fallback: string) {
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png" || format === "webp" || format === "gif" || format === "avif" || format === "tiff") return `image/${format}`;
    return fallback;
}
