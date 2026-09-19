import { afterEach, describe, expect, it, vi } from "vitest";
import { getIpwoSettings, saveIpwoSettings, testIpwoConnection } from "./chatgpt-ipwo";

afterEach(() => vi.unstubAllGlobals());
const event = { stage: "出口检测", status: "success", message: "连接成功", elapsed_ms: 150, done: true, exit_ip: "203.0.113.10" };
function stream(chunks: string[]) {
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
    );
}
describe("IPWO administration transport", () => {
    it("uses authenticated same-origin settings API without returning credentials", async () => {
        const settings = { configured: true, has_api_url: true, protocol: "http", regions: "US", timeout_seconds: 30 };
        const fetcher = vi.fn(async () => Response.json({ code: 0, data: settings }));
        vi.stubGlobal("fetch", fetcher);
        expect(await getIpwoSettings()).toEqual(settings);
        expect(await saveIpwoSettings({ protocol: "http", regions: "US", timeout_seconds: 30 })).toEqual(settings);
        expect(fetcher.mock.calls[1]).toEqual(["/api/admin/chatgpt-api/ipwo", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ protocol: "http", regions: "US", timeout_seconds: 30 }) })]);
    });
    it("streams split log lines and accepts a final line without newline", async () => {
        const text = JSON.stringify(event);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => stream([text.slice(0, 12), text.slice(12)])),
        );
        const received = vi.fn();
        await testIpwoConnection(received, new AbortController().signal);
        expect(received).toHaveBeenCalledExactlyOnceWith(event);
    });
    it("does not call an incomplete stream a successful test", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => stream([JSON.stringify({ ...event, done: false }) + "\n"])),
        );
        await expect(testIpwoConnection(() => undefined, new AbortController().signal)).rejects.toThrow("尚未收到最终结果");
    });
    it("surfaces API failures and rejects malformed logs", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ code: 403, msg: "需要上游配置管理权限" }, { status: 403 })),
        );
        await expect(testIpwoConnection(() => undefined, new AbortController().signal)).rejects.toThrow("需要上游配置管理权限");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => stream([JSON.stringify({ ...event, elapsed_ms: null })])),
        );
        await expect(testIpwoConnection(() => undefined, new AbortController().signal)).rejects.toThrow("测试日志格式无效");
    });
    it("preserves the supplied cancellation signal and never retries tests", async () => {
        const controller = new AbortController();
        const fetcher = vi.fn(async () => {
            throw new DOMException("Aborted", "AbortError");
        });
        vi.stubGlobal("fetch", fetcher);
        controller.abort();
        await expect(testIpwoConnection(() => undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledWith("/api/admin/chatgpt-api/ipwo/test", expect.objectContaining({ signal: controller.signal }));
    });
});
