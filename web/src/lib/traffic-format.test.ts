import { describe, expect, it } from "vitest";

import { DEFAULT_TRAFFIC_DISPLAY_UNIT, formatTrafficBytes, normalizeTrafficDisplayUnit } from "./traffic-format";

describe("traffic display formatting", () => {
    it("defaults unknown settings to decimal MB", () => {
        expect(DEFAULT_TRAFFIC_DISPLAY_UNIT).toBe("MB");
        expect(normalizeTrafficDisplayUnit(undefined)).toBe("MB");
        expect(normalizeTrafficDisplayUnit("KiB")).toBe("MB");
        expect(normalizeTrafficDisplayUnit("GB")).toBe("GB");
    });

    it("keeps small byte counts visible in the configured decimal unit", () => {
        expect(formatTrafficBytes(896, "MB")).toEqual({ value: "0.000896", unit: "MB" });
        expect(formatTrafficBytes(896, "GB")).toEqual({ value: "0.000000896", unit: "GB" });
        expect(formatTrafficBytes(Number.NaN, "MB")).toEqual({ value: "0", unit: "MB" });
    });

    it("limits display precision without changing the source byte count", () => {
        expect(formatTrafficBytes(1_234_567.8912345, "MB")).toEqual({ value: "1.234568", unit: "MB" });
        expect(formatTrafficBytes(1_234_567_891.2345678, "GB")).toEqual({ value: "1.234567891", unit: "GB" });
    });
});
