import { getCurrentUser } from "@/lib/auth/session";
import { ensureGenerationLogEventBridge, waitForGenerationLogChange } from "@/lib/server/generation-log-event-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return new Response("请先登录", { status: 401 });
    const encoder = new TextEncoder();
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });
    if (request.signal.aborted) abort.abort();
    const body = new ReadableStream({
        async start(controller) {
            try {
                await ensureGenerationLogEventBridge();
                if (!abort.signal.aborted) controller.enqueue(encoder.encode("event: logs.changed\ndata: {}\n\n"));
                while (!abort.signal.aborted) {
                    // Use the existing SSE heartbeat window; no business data
                    // is polled or exposed on this notification stream.
                    const changed = await waitForGenerationLogChange(user.id, 15_000, abort.signal);
                    if (abort.signal.aborted) break;
                    controller.enqueue(encoder.encode(changed ? "event: logs.changed\ndata: {}\n\n" : "event: logs.sync\ndata: {}\n\n"));
                }
            } finally {
                try {
                    controller.close();
                } catch {
                    /* Client already disconnected. */
                }
            }
        },
        cancel() {
            abort.abort();
        },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
