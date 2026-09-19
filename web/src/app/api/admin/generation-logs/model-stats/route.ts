import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { hasAdminPermission } from "@/lib/admin-permissions";
import { listGenerationLogs } from "@/lib/server/generation-log-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 3;
const MAX_SAMPLES_PER_MODEL = 20;

export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (!hasAdminPermission(currentUser, "generation.read")) return NextResponse.json({ error: "当前管理员没有查看生成记录的职责权限" }, { status: 403 });

    const durationsByModel = new Map<string, number[]>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await listGenerationLogs({ page, pageSize: 100, status: "success" });
        for (const log of result.items) {
            if (!log.model || !(log.durationMs > 0)) continue;
            const durations = durationsByModel.get(log.model) || [];
            if (durations.length >= MAX_SAMPLES_PER_MODEL) continue;
            durations.push(log.durationMs);
            durationsByModel.set(log.model, durations);
        }
        if (page * 100 >= result.total) break;
    }

    const data = Object.fromEntries(
        Array.from(durationsByModel.entries()).map(([model, durations]) => [
            model,
            { avgDurationMs: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(0)), samples: durations.length },
        ]),
    );
    return NextResponse.json({ data });
}
