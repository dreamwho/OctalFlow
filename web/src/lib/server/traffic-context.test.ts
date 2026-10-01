import { describe, expect, it } from "vitest";
import { currentTrafficContext, providerTrafficHeaders, updateTrafficContext, withTrafficContext } from "./traffic-context";

describe("immutable request ownership of traffic", () => {
    it("keeps interleaved channels and models isolated", async () => {
        let releaseA!: () => void;
        let releaseB!: () => void;
        const barrierA = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const barrierB = new Promise<void>((resolve) => {
            releaseB = resolve;
        });
        const a = withTrafficContext({ channelId: "a", model: "image-a", taskId: "task-a", requestId: "request-a" }, async () => {
            await barrierA;
            updateTrafficContext({ role: "upload" });
            releaseB();
            return { ...currentTrafficContext() };
        });
        const b = withTrafficContext({ channelId: "b", model: "text-b", taskId: "task-b", requestId: "request-b" }, async () => {
            releaseA();
            await barrierB;
            return { ...currentTrafficContext() };
        });
        expect(await Promise.all([a, b])).toEqual([
            { channelId: "a", model: "image-a", taskId: "task-a", requestId: "request-a", role: "upload" },
            { channelId: "b", model: "text-b", taskId: "task-b", requestId: "request-b" },
        ]);
        expect(currentTrafficContext()).toBeUndefined();
    });
    it("replaces client attribution headers with trusted server data", () => {
        const headers = new Headers({ "x-dreamyo-traffic-context": "client-spoof" });
        withTrafficContext({ channelId: "real-channel", model: "real-model" }, () => providerTrafficHeaders(headers, { channelId: "default", channelName: "默认", model: "", protocol: "openai" }));
        expect(JSON.parse(Buffer.from(headers.get("x-dreamyo-traffic-context")!, "base64url").toString())).toEqual({ channelId: "real-channel", channelName: "默认", model: "real-model", protocol: "openai" });
    });
});
