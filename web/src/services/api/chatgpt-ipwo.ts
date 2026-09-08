import { chatGptApiRequest } from "./chatgpt-api";

export type IpwoSettings = { configured: boolean; has_api_url: boolean; protocol: "http" | "socks5"; regions: string; timeout_seconds: number };
export type IpwoPatch = Pick<IpwoSettings, "protocol" | "regions" | "timeout_seconds"> & { api_url?: string };
export type IpwoTestEvent = { stage: string; status: "running" | "success" | "error"; message: string; elapsed_ms: number; done?: boolean; exit_ip?: string };
export const getIpwoSettings = (signal?: AbortSignal) => chatGptApiRequest<IpwoSettings>("ipwo", { signal });
export const saveIpwoSettings = (patch: IpwoPatch) => chatGptApiRequest<IpwoSettings>("ipwo", { method: "PATCH", body: JSON.stringify(patch) });

export async function testIpwoConnection(onEvent: (event: IpwoTestEvent) => void, signal: AbortSignal) {
    const response = await fetch("/api/admin/chatgpt-api/ipwo/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal, cache: "no-store" });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.msg || "无法开始 IPWO 连接测试");
    }
    if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("测试接口未返回过程日志");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as IpwoTestEvent;
        if (completed || !["running", "success", "error"].includes(event.status) || (event.done === true && event.status === "running") || typeof event.stage !== "string" || typeof event.message !== "string" || !Number.isFinite(event.elapsed_ms)) throw new Error("测试日志格式无效");
        onEvent(event);
        completed = event.done === true;
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) consume(line);
            if (done) break;
        }
        consume(buffer);
        if (!completed) throw new Error("测试连接已中断，尚未收到最终结果，请重新测试");
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
