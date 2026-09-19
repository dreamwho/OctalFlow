"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const WORDMARK_SRC = "/brand/dreamyo/wordmark.png";

/**
 * 站点文字品牌（dreamyo 字标）。原始素材为深蓝色透明底 PNG：
 * 浅色主题直接使用，深色主题通过 brightness-0 + invert 反白保证可读。
 * 图片加载失败时回退为站点标题文字。
 */
export function SiteWordmark({ title = "dreamyo", className }: { title?: string; className?: string }) {
    const [failed, setFailed] = useState(false);

    if (failed) {
        return <span className={cn("font-extrabold tracking-tight text-current", className?.split(" ").find((item) => item.startsWith("h-")) || "h-4", "leading-none")}>{title}</span>;
    }

    return (
        <img
            src={WORDMARK_SRC}
            alt={title}
            className={cn("block h-4 w-auto object-contain dark:brightness-0 dark:invert", className)}
            onError={() => setFailed(true)}
        />
    );
}
