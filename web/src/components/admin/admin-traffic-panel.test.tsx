import dayjs from "dayjs";
import { describe, expect, it } from "vitest";

import { buildTrafficFilter, trafficConnectionModeLabel, trafficCoverageLabel, trafficModelLabel } from "./admin-traffic-panel";

describe("AdminTrafficPanel filter contract", () => {
    it("preserves the selected date-time range and an explicit port 0", () => {
        const start = dayjs("2026-10-01T08:09:10+08:00");
        const end = dayjs("2026-10-01T18:19:20+08:00");
        const filter = buildTrafficFilter([start, end], undefined, "dreamina-cli", "seedance", "direct", 0);

        expect(filter.start).toBe(start.toISOString());
        expect(filter.end).toBe(end.toISOString());
        expect(filter.port).toBe(0);
    });

    it("keeps shared browser and connection mode labels truthful", () => {
        expect(trafficModelLabel("__shared_browser__")).toBe("共享浏览器流量");
        expect(trafficModelLabel("__unattributed__")).toBe("未归属模型");
        expect(trafficModelLabel("")).toBe("未归属模型");
        expect(trafficConnectionModeLabel("direct")).toBe("直连");
        expect(trafficConnectionModeLabel("generic")).toBe("通用代理");
        expect(trafficConnectionModeLabel("magic")).toBe("魔法代理");
        expect(trafficConnectionModeLabel("chained")).toBe("链式代理");
        expect(trafficConnectionModeLabel("unknown")).toBe("未标记");
        expect(trafficConnectionModeLabel("magic-proxy")).toBe("未标记");
        expect(trafficCoverageLabel({ source: "CLI", status: "unknown", message: "" })).toBe("未知");
        expect(trafficCoverageLabel({ source: "CLI", status: "missing", message: "" })).toBe("未接入");
    });
});
