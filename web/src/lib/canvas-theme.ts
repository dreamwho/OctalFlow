export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasSelectionFlowColors = {
    start: "#35cce1",
    middle: "#5e7ff1",
    end: "#b9b3f7",
} as const;

export const canvasSelectionGradient = `linear-gradient(90deg, ${canvasSelectionFlowColors.start} 0%, ${canvasSelectionFlowColors.middle} 48%, ${canvasSelectionFlowColors.end} 100%)`;
export const canvasSelectionGlow = "0 0 18px rgba(99,102,241,.28), 0 0 32px rgba(0,194,255,.16)";

export function canvasSelectionBorderStyle(panelBackground: string) {
    return {
        border: "1px solid transparent",
        background: `linear-gradient(${panelBackground}, ${panelBackground}) padding-box, ${canvasSelectionGradient} border-box`,
        boxShadow: canvasSelectionGlow,
    };
}

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f8ff",
            backdrop: "#f4f8ff",
            dot: "rgba(94,127,241,.16)",
            line: "rgba(53,204,225,.09)",
            glow: "radial-gradient(ellipse 56% 52% at 5% 14%, rgba(53,204,225,.14), transparent 72%), radial-gradient(ellipse 48% 44% at 92% 90%, rgba(185,179,247,.16), transparent 74%)",
            selectionStroke: "#5e7ff1",
            selectionFill: "rgba(94,127,241,.09)",
        },
        node: {
            label: "#525866",
            fill: "#f8fbff",
            panel: "#ffffff",
            stroke: "#d8e2f2",
            activeStroke: "#5e7ff1",
            placeholder: "#9aa1b1",
            text: "#13203b",
            muted: "#687894",
            faint: "#8fa0bb",
            subtleSurface: "#f1f6ff",
            subtleBorder: "#d8e2f2",
            subtleText: "#405575",
            infoSurface: "#eef5ff",
            infoBorder: "#b7c3f2",
            infoText: "#3856b2",
            successSurface: "#ecfdf5",
            successBorder: "#a7f3d0",
            successText: "#047857",
            warningSurface: "#fffbeb",
            warningBorder: "#fde68a",
            warningText: "#a16207",
            danger: "#dc2626",
            dangerSurface: "#fff1f2",
            dangerBorder: "#fecdd3",
            removeSurface: "rgba(255,255,255,.94)",
            removeBorder: "rgba(32,37,50,.14)",
            removeText: "#525866",
            action: "#5e7ff1",
            actionText: "#ffffff",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(255,255,255,.97)",
            border: "#dfe7f3",
            item: "#525866",
            itemHover: "#edf5ff",
            activeBg: "rgba(47,111,255,.12)",
            activeText: "#1e4db7",
        },
    },
    dark: {
        canvas: {
            background: "#060913",
            backdrop: "#060913",
            dot: "rgba(129, 140, 248, 0.22)",
            line: "rgba(99, 102, 241, 0.12)",
            glow: "radial-gradient(ellipse 65% 58% at 6% 10%, rgba(99, 102, 241, 0.22), transparent 72%), radial-gradient(ellipse 55% 50% at 94% 92%, rgba(168, 85, 247, 0.18), transparent 74%)",
            selectionStroke: "#818cf8",
            selectionFill: "rgba(99, 102, 241, 0.14)",
        },
        node: {
            label: "#f1f5f9",
            fill: "#0e1324",
            panel: "#11182c",
            stroke: "rgba(129, 140, 248, 0.28)",
            activeStroke: "#a855f7",
            placeholder: "#94a3b8",
            text: "#f8fafc",
            muted: "#94a3b8",
            faint: "#64748b",
            subtleSurface: "#151d34",
            subtleBorder: "rgba(129, 140, 248, 0.32)",
            subtleText: "#cbd5e1",
            infoSurface: "rgba(99, 102, 241, 0.16)",
            infoBorder: "rgba(129, 140, 248, 0.45)",
            infoText: "#c7d2fe",
            successSurface: "rgba(16, 185, 129, 0.16)",
            successBorder: "rgba(52, 211, 153, 0.4)",
            successText: "#6ee7b7",
            warningSurface: "rgba(245, 158, 11, 0.16)",
            warningBorder: "rgba(251, 191, 36, 0.4)",
            warningText: "#fcd34d",
            danger: "#f87171",
            dangerSurface: "#2d1217",
            dangerBorder: "#991b1b",
            removeSurface: "rgba(15, 21, 38, 0.95)",
            removeBorder: "rgba(255, 255, 255, 0.22)",
            removeText: "#f8fafc",
            action: "#6366f1",
            actionText: "#ffffff",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(14, 19, 36, 0.92)",
            border: "rgba(129, 140, 248, 0.28)",
            item: "#f1f5f9",
            itemHover: "rgba(99, 102, 241, 0.22)",
            activeBg: "#6366f1",
            activeText: "#ffffff",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
