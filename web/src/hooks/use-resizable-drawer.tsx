"use client";

import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export type ResizableDrawerWidth = {
    width: number;
    resizing: boolean;
    onHandlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

// 请求日志详情抽屉的拖宽：抓住左缘手柄向左拖动即可加宽，范围限制在视口内。
export function useResizableDrawerWidth(options?: { defaultWidth?: number; minWidth?: number }): ResizableDrawerWidth {
    const defaultWidth = options?.defaultWidth ?? 640;
    const minWidth = options?.minWidth ?? 420;
    const [width, setWidth] = useState(defaultWidth);
    const [resizing, setResizing] = useState(false);
    const start = useRef({ x: 0, width: defaultWidth });

    const onHandlePointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            start.current = { x: event.clientX, width };
            setResizing(true);
            const previousUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = "none";
            const onMove = (moveEvent: PointerEvent) => {
                const maxWidth = Math.max(minWidth, window.innerWidth - 48);
                setWidth(Math.min(maxWidth, Math.max(minWidth, start.current.width + (start.current.x - moveEvent.clientX))));
            };
            const onUp = () => {
                document.body.style.userSelect = previousUserSelect;
                setResizing(false);
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
        [minWidth, width],
    );

    return { width, resizing, onHandlePointerDown };
}

export function LogDetailResizeHandle({ resizing, onPointerDown }: { resizing: boolean; onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void }) {
    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整侧边栏宽度"
            title="左右拖动调整宽度"
            onPointerDown={onPointerDown}
            className={"absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize transition-colors hover:bg-cyan-400/30" + (resizing ? " bg-cyan-400/40" : "")}
        />
    );
}
