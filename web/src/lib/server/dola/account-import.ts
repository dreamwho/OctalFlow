import { createHmac } from "node:crypto";

export type ParsedDolaCookie = { cookie: string; fingerprintInput: string };

export function parseDolaCookieHeader(value: unknown): ParsedDolaCookie {
    if (typeof value !== "string") throw new Error("Cookie 必须是文本");
    const source = value.trim().replace(/^Cookie\s*:\s*/i, "").trim();
    if (!source || /[\r\n\u0000-\u001f\u007f]/.test(source)) throw new Error("Cookie 为空或包含控制字符");
    const pairs = source.split(";").map((part) => part.trim()).filter(Boolean);
    if (!pairs.length) throw new Error("Cookie 未包含有效键值");
    const normalized: Array<[string, string]> = [];
    for (const part of pairs) {
        const index = part.indexOf("=");
        if (index <= 0) throw new Error("Cookie 键值格式无效");
        const name = part.slice(0, index).trim();
        const cookieValue = part.slice(index + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !cookieValue) throw new Error("Cookie 键值格式无效");
        normalized.push([name, cookieValue]);
    }
    const cookie = normalized.map(([name, cookieValue]) => `${name}=${cookieValue}`).join("; ");
    const fingerprintInput = [...normalized].sort(([left], [right]) => left.localeCompare(right)).map(([name, cookieValue]) => `${name}=${cookieValue}`).join(";");
    return { cookie, fingerprintInput };
}

export function dolaCookieFingerprint(input: string) {
    const key = process.env.DREAMYO_ENCRYPTION_KEY?.trim() || "dola-cookie-fingerprint";
    return createHmac("sha256", key).update(input).digest("hex");
}

export function splitDolaCookieFile(text: string, sourceFileName?: string) {
    return text
        .split(/\r?\n/)
        .map((line, index) => ({ line: line.trim(), ordinal: index + 1 }))
        .filter(({ line }) => Boolean(line))
        .map(({ line, ordinal }) => ({ cookie: line, sourceFileName, sourceOrdinal: ordinal }));
}

export function parseDolaImportInputs(inputs: Array<{ cookie: unknown; name?: unknown; email?: unknown; authType?: unknown; group?: unknown; sourceFileName?: unknown; sourceOrdinal?: unknown }>) {
    const results: Array<{ cookie: string; fingerprint: string; name?: string; email?: string; authType?: "cookie" | "google"; group?: string; sourceFileName?: string; sourceOrdinal?: number; error?: string }> = [];
    for (const input of inputs) {
        try {
            const parsed = parseDolaCookieHeader(input.cookie);
            results.push({
                cookie: parsed.cookie,
                fingerprint: dolaCookieFingerprint(parsed.fingerprintInput),
                ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim().slice(0, 120) } : {}),
                ...(typeof input.email === "string" && input.email.trim() ? { email: input.email.trim().slice(0, 320) } : {}),
                ...(input.authType === "google" ? { authType: "google" as const } : { authType: "cookie" as const }),
                group: typeof input.group === "string" ? input.group.trim().slice(0, 60) : "",
                ...(typeof input.sourceFileName === "string" && input.sourceFileName.trim() ? { sourceFileName: input.sourceFileName.trim().slice(0, 255) } : {}),
                ...(Number.isSafeInteger(input.sourceOrdinal) && Number(input.sourceOrdinal) > 0 ? { sourceOrdinal: Number(input.sourceOrdinal) } : {}),
            });
        } catch (error) {
            results.push({
                cookie: "",
                fingerprint: "",
                ...(typeof input.sourceFileName === "string" ? { sourceFileName: input.sourceFileName.trim().slice(0, 255) } : {}),
                ...(Number.isSafeInteger(input.sourceOrdinal) && Number(input.sourceOrdinal) > 0 ? { sourceOrdinal: Number(input.sourceOrdinal) } : {}),
                error: error instanceof Error ? error.message : "Cookie 格式无效",
            });
        }
    }
    return results;
}

