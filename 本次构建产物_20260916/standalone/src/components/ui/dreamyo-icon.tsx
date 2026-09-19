import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export const DREAMYO_ICON_SOURCES = {
    image: "/brand/dreamyo/icons/image.png",
    video: "/brand/dreamyo/icons/video.png",
    audio: "/brand/dreamyo/icons/audio.png",
    document: "/brand/dreamyo/icons/document.png",
    presentation: "/brand/dreamyo/icons/presentation.png",
    folder: "/brand/dreamyo/icons/folder.png",
    magic: "/brand/dreamyo/icons/magic.png",
    "agent-thinking": "/brand/dreamyo/icons/agent-thinking.png",
    success: "/brand/dreamyo/icons/success.png",
    warning: "/brand/dreamyo/icons/warning.png",
    empty: "/brand/dreamyo/icons/empty.png",
    loading: "/brand/dreamyo/icons/loading.png",
    "waiting-1": "/brand/dreamyo/icons/waiting-1.png",
    "waiting-2": "/brand/dreamyo/icons/waiting-2.png",
    "waiting-3": "/brand/dreamyo/icons/waiting-3.png",
    "waiting-4": "/brand/dreamyo/icons/waiting-4.png",
    "waiting-5": "/brand/dreamyo/icons/waiting-5.png",
    "waiting-6": "/brand/dreamyo/icons/waiting-6.png",
} as const;

export type DreamyoIconName = keyof typeof DREAMYO_ICON_SOURCES;

type DreamyoIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
    name: DreamyoIconName;
    size?: number;
    label?: string;
};

/** Small UI-safe wrapper for the transparent dreamyo design assets. */
export function DreamyoIcon({ name, size = 20, label, className, style, ...props }: DreamyoIconProps) {
    return (
        <span
            {...props}
            data-dreamyo-icon={name}
            aria-hidden={label ? undefined : true}
            aria-label={label}
            role={label ? "img" : undefined}
            className={cn("inline-grid shrink-0 place-items-center overflow-hidden", className)}
            style={{ width: size, height: size, ...style }}
        >
            <img src={DREAMYO_ICON_SOURCES[name]} alt={label || ""} className="block size-full object-contain" draggable={false} />
        </span>
    );
}

export function DreamyoWaitingIcon({ frame = 1, size = 28, className, label }: { frame?: number; size?: number; className?: string; label?: string }) {
    const safeFrame = Math.min(6, Math.max(1, Math.round(frame)));
    return <DreamyoIcon name={`waiting-${safeFrame}` as DreamyoIconName} size={size} className={cn("dreamyo-waiting-icon", className)} label={label} />;
}
