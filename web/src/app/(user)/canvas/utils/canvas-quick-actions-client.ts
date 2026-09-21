"use client";

import { useEffect, useState } from "react";

import type { CanvasQuickActionItem } from "@/lib/canvas-quick-actions";

export type CanvasQuickActionEntry = CanvasQuickActionItem & { groupId: string; groupName: string };

let cache: CanvasQuickActionEntry[] | null = null;
let inflight: Promise<CanvasQuickActionEntry[]> | null = null;

async function loadCanvasQuickActions(): Promise<CanvasQuickActionEntry[]> {
    const response = await fetch("/api/canvas-quick-actions", { cache: "no-store" });
    if (!response.ok) return [];
    const payload = (await response.json().catch(() => null)) as { groups?: Array<{ id?: string; name?: string; actions?: Array<Record<string, unknown>> }> } | null;
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    return groups.flatMap((group) => {
        const groupId = group.id || "";
        const groupName = group.name || "";
        return (group.actions || []).map((action) => ({
            ...(action as unknown as CanvasQuickActionItem),
            id: String(action.id || ""),
            name: String(action.name || ""),
            prompt: String(action.prompt || ""),
            groupId,
            groupName,
        }));
    });
}

/** 画布功能菜单数据：登录后拉取一次并做模块级缓存，后台改动下次进入画布生效。 */
export function useCanvasQuickActions(enabled = true): CanvasQuickActionEntry[] {
    const [actions, setActions] = useState<CanvasQuickActionEntry[] | null>(cache);
    useEffect(() => {
        if (!enabled || cache) {
            if (cache && enabled) setActions(cache);
            return;
        }
        if (!inflight) {
            inflight = loadCanvasQuickActions()
                .then((list) => {
                    cache = list;
                    return list;
                })
                .catch(() => [] as CanvasQuickActionEntry[]);
        }
        void inflight.then(setActions);
    }, [enabled]);
    return actions ?? [];
}
