import { createHash, timingSafeEqual } from "node:crypto";

export function canvasExternalApiUser(request: Request): string | null {
    const expected = process.env.DREAMYO_CANVAS_EXTERNAL_API_KEY?.trim() || "";
    const userId = process.env.DREAMYO_CANVAS_EXTERNAL_API_USER_ID?.trim() || "";
    const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    if (!userId || expected.length < 32 || !supplied) return null;
    const left = createHash("sha256").update(expected).digest();
    const right = createHash("sha256").update(supplied).digest();
    return timingSafeEqual(left, right) ? userId : null;
}
