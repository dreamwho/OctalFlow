type PointsResponseValue = {
    pointsBalance?: unknown;
    permanentPointsBalance?: unknown;
    dailyPointsBalance?: unknown;
    dailyPointsExpiresAt?: unknown;
};

export function pointsResponseHeaders(value: unknown) {
    const headers = new Headers();
    const points = typeof value === "object" && value ? (value as PointsResponseValue) : { pointsBalance: value };
    setNumberHeader(headers, "x-octalaicanvas-points-remaining", points.pointsBalance);
    setNumberHeader(headers, "x-octalaicanvas-points-permanent", points.permanentPointsBalance);
    setNumberHeader(headers, "x-octalaicanvas-points-daily", points.dailyPointsBalance);
    if (typeof points.dailyPointsExpiresAt === "string" && points.dailyPointsExpiresAt) headers.set("x-octalaicanvas-points-daily-expires-at", points.dailyPointsExpiresAt);
    return headers;
}

function setNumberHeader(headers: Headers, name: string, value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) headers.set(name, String(value));
}
