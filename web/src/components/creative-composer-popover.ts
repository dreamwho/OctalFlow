import { useEffect, useState } from "react";

export type CreativeComposerPopoverPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

export type PopupViewportBounds = { top: number; right: number; bottom: number; left: number };

const viewportOverflow = { adjustX: 1, adjustY: 1 } as const;
const POPOVER_VIEWPORT_GUTTER = 24;

export function resolveCreativeComposerPopoverPlacement(placement: CreativeComposerPopoverPlacement, narrowViewport: boolean): CreativeComposerPopoverPlacement {
    if (!narrowViewport) return placement;
    return placement.startsWith("bottom") ? "bottom" : "top";
}

export function creativeComposerPopoverOverflow(_placement: CreativeComposerPopoverPlacement) {
    return viewportOverflow;
}

export function creativeComposerPopoverPanelMaxHeight(placement: CreativeComposerPopoverPlacement, trigger: Pick<DOMRect, "top" | "bottom">, viewport: { top: number; bottom: number }, maximum: number) {
    const available = placement.startsWith("bottom") ? viewport.bottom - trigger.bottom : trigger.top - viewport.top;
    return Math.max(0, Math.min(maximum, Math.floor(available - POPOVER_VIEWPORT_GUTTER)));
}

export function resolveCreativeComposerPopoverViewportLayout(
    preferredPlacement: CreativeComposerPopoverPlacement,
    trigger: Pick<DOMRect, "top" | "bottom">,
    viewport: Pick<PopupViewportBounds, "top" | "bottom">,
    desiredHeight: number,
    maximumHeight: number,
    viewportGutter = POPOVER_VIEWPORT_GUTTER,
) {
    const topHeight = Math.max(0, Math.min(maximumHeight, Math.floor(trigger.top - viewport.top - viewportGutter)));
    const bottomHeight = Math.max(0, Math.min(maximumHeight, Math.floor(viewport.bottom - trigger.bottom - viewportGutter)));
    const prefersBottom = preferredPlacement.startsWith("bottom");
    const preferredHeight = prefersBottom ? bottomHeight : topHeight;
    const oppositeHeight = prefersBottom ? topHeight : bottomHeight;
    const useBottom = preferredHeight >= desiredHeight ? prefersBottom : oppositeHeight >= desiredHeight ? !prefersBottom : bottomHeight > topHeight;
    const suffix = preferredPlacement.endsWith("Left") ? "Left" : preferredPlacement.endsWith("Right") ? "Right" : "";
    const placement = `${useBottom ? "bottom" : "top"}${suffix}` as CreativeComposerPopoverPlacement;

    return {
        placement,
        maxHeight: useBottom ? bottomHeight : topHeight,
        topHeight,
        bottomHeight,
    };
}

export function readVisualViewportBounds(): PopupViewportBounds {
    const visualViewport = window.visualViewport;
    const top = visualViewport?.offsetTop || 0;
    const left = visualViewport?.offsetLeft || 0;
    return {
        top,
        left,
        right: left + (visualViewport?.width || window.innerWidth),
        bottom: top + (visualViewport?.height || window.innerHeight),
    };
}

export function useCreativeComposerPopoverPlacement(placement: CreativeComposerPopoverPlacement) {
    const [narrowViewport, setNarrowViewport] = useState(false);

    useEffect(() => {
        const media = window.matchMedia("(max-width: 640px)");
        const update = () => setNarrowViewport(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    return resolveCreativeComposerPopoverPlacement(placement, narrowViewport);
}
