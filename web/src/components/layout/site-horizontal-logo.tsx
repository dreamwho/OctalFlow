"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

const HORIZONTAL_LOGO_SRC = "/brand/dreamyo/logo-horizontal.png";

/**
 * 横向组合标（图形 + dreamyo + IDEAS LIVE BRIGHTER 标语）。
 * 素材为透明底白字：深色主题原样显示，浅色主题反色为深色保证可读；
 * 图片加载失败时回退为站点名称文字。
 */
export function SiteHorizontalLogo({ title = "dreamyo", className }: { title?: string; className?: string }) {
    const [failed, setFailed] = useState(false);

    if (failed) {
        return (
            <span className={cn("inline-flex items-baseline gap-2", className)} aria-label={title}>
                <span className="text-2xl font-extrabold tracking-tight text-current">{title}</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.3em] text-current opacity-60">Ideas Live Brighter</span>
            </span>
        );
    }

    return <img src={HORIZONTAL_LOGO_SRC} alt={title} className={cn("block h-12 w-auto object-contain invert dark:invert-0", className)} onError={() => setFailed(true)} />;
}
