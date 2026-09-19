import { jsonrepair } from "jsonrepair";

export function strictJsonObjectText(value: unknown) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() || "";
    const candidate = text.startsWith("{") && text.endsWith("}") ? text : fenced.startsWith("{") && fenced.endsWith("}") ? fenced : "";
    if (!candidate) return "";
    try {
        const normalized = JSON.parse(candidate);
        return isObject(normalized) ? JSON.stringify(normalized) : "";
    } catch {
        try {
            const normalized = JSON.parse(jsonrepair(candidate));
            return isObject(normalized) ? JSON.stringify(normalized) : "";
        } catch {
            return "";
        }
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
