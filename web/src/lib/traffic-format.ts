export type TrafficDisplayUnit = "MB" | "GB";

export const DEFAULT_TRAFFIC_DISPLAY_UNIT: TrafficDisplayUnit = "MB";

const TRAFFIC_UNIT_BYTES: Record<TrafficDisplayUnit, number> = {
    MB: 1_000_000,
    GB: 1_000_000_000,
};

const TRAFFIC_UNIT_FRACTION_DIGITS: Record<TrafficDisplayUnit, number> = {
    MB: 6,
    GB: 9,
};

export function normalizeTrafficDisplayUnit(value: unknown): TrafficDisplayUnit {
    return value === "GB" ? "GB" : DEFAULT_TRAFFIC_DISPLAY_UNIT;
}

export function formatTrafficBytes(bytes: number, unit: TrafficDisplayUnit): { value: string; unit: TrafficDisplayUnit } {
    const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    const value = new Intl.NumberFormat("zh-CN", {
        maximumFractionDigits: TRAFFIC_UNIT_FRACTION_DIGITS[unit],
        useGrouping: false,
    }).format(safeBytes / TRAFFIC_UNIT_BYTES[unit]);
    return { value, unit };
}
