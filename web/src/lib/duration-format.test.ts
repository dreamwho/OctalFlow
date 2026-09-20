import { describe, expect, it } from "vitest";

import { formatDurationMinSec } from "./duration-format";

describe("formatDurationMinSec", () => {
    it("混合时长显示分钟+秒数", () => {
        expect(formatDurationMinSec(416_080)).toBe("6m56s");
        expect(formatDurationMinSec(102_000)).toBe("1m42s");
    });

    it("不满一分钟只显示秒", () => {
        expect(formatDurationMinSec(33_400)).toBe("33s");
        expect(formatDurationMinSec(44_000)).toBe("44s");
    });

    it("整分钟不显示秒", () => {
        expect(formatDurationMinSec(60_000)).toBe("1m");
        expect(formatDurationMinSec(600_000)).toBe("10m");
    });

    it("秒数进位后按整分/混合判断", () => {
        expect(formatDurationMinSec(61_500)).toBe("1m02s");
        expect(formatDurationMinSec(59_600)).toBe("1m");
    });

    it("非法或非正输入返回 -", () => {
        expect(formatDurationMinSec(0)).toBe("-");
        expect(formatDurationMinSec(-5)).toBe("-");
        expect(formatDurationMinSec(Number.NaN)).toBe("-");
    });
});
