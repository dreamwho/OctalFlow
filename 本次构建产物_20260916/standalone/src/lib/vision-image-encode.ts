const DEFAULT_VISION_MAX_LONG_EDGE = 2048;
// base64 膨胀约 1.37 倍；单图 1.2MB、多图总量 3.2MB 预算，低于系统代理与任务创建两处 4MB 上限
const DEFAULT_VISION_MAX_BYTES = 1_200_000;
const JPEG_QUALITY_STEPS = [0.85, 0.72, 0.6];

// 文本模型的视觉参考图在发送前降采样压缩：上游视觉编码只需要有限分辨率，
// 原图 base64 内联会击穿系统代理请求体上限（413 请求体过大）。
export async function downscaleDataUrlForVision(dataUrl: string, options?: { maxLongEdge?: number; maxBytes?: number }): Promise<string> {
    if (!dataUrl.startsWith("data:image/")) return dataUrl;
    if (typeof document === "undefined" || typeof Image === "undefined") return dataUrl;
    const maxLongEdge = options?.maxLongEdge ?? DEFAULT_VISION_MAX_LONG_EDGE;
    const maxBytes = options?.maxBytes ?? DEFAULT_VISION_MAX_BYTES;
    if (dataUrl.length <= maxBytes) return dataUrl;
    try {
        const image = await loadImageElement(dataUrl);
        const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
        const scale = Math.min(1, maxLongEdge / Math.max(1, longEdge));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return dataUrl;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        let encoded = "";
        for (const quality of JPEG_QUALITY_STEPS) {
            encoded = canvas.toDataURL("image/jpeg", quality);
            if (encoded.length <= maxBytes) return encoded;
        }
        return encoded || dataUrl;
    } catch {
        return dataUrl;
    }
}

function loadImageElement(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("参考图片解码失败"));
        image.src = src;
    });
}
