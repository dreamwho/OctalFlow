import { describe, expect, it } from "vitest";
import { parseTrafficFilter } from "./traffic-filter";

describe("traffic query range and dimensions", () => {
    const range = { start: "2026-10-01T00:00:00+08:00", end: "2026-10-02T00:00:00+08:00" };
    it("preserves independent channel, model and connection filters, including direct port zero", () => {
        expect(parseTrafficFilter(new URLSearchParams({ ...range, channelId: "channel-1", model: "模型甲", protocol: "openai", connectionMode: "direct", port: "0" }))).toEqual({
            ...range,
            channelId: "channel-1",
            model: "模型甲",
            protocol: "openai",
            connectionMode: "direct",
            port: 0,
        });
    });
    it.each([
        { ...range, start: "2026-10-01T00:00:00" },
        { ...range, end: range.start },
        { ...range, start: range.end, end: range.start },
        { ...range, port: "65536" },
        { ...range, port: "-1" },
        { ...range, port: "12.3" },
        { ...range, port: "NaN" },
    ])("rejects invalid dimensions %j", (input) => {
        expect(() => parseTrafficFilter(new URLSearchParams(input))).toThrow();
    });
});
