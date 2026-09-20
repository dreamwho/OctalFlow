import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { computeModelDurationStats } from "@/lib/server/model-duration-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* 仅返回各模型平均生成耗时的聚合数据（不含任何用户内容），登录用户可读，供模型选择弹层展示。 */
export async function GET() {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    return NextResponse.json({ data: await computeModelDurationStats() });
}
