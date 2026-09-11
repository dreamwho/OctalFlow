import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
    return NextResponse.json({ code: 0, data: { status: "ok" }, msg: "服务正常" }, { headers: { "cache-control": "no-store" } });
}
