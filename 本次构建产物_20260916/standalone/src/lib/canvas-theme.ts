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
            background: "#080f20",
            backdrop: "#080f20",
            dot: "rgba(53,204,225,.2)",
            line: "rgba(53,204,225,.09)",
            glow: "radial-gradient(ellipse 58% 54% at 4% 12%, rgba(94,127,241,.24), transparent 72%), radial-gradient(ellipse 50% 46% at 92% 91%, rgba(53,204,225,.17), transparent 74%)",
            selectionStroke: "#35cce1",
            selectionFill: "rgba(53,204,225,.12)",
        },
        node: {
            label: "#e5e7eb",
            fill: "#0e1c3a",
            panel: "#0c1a36",
            stroke: "#2b4c7f",
            activeStroke: "#35cce1",
            placeholder: "#94a3b8",
            text: "#eef6ff",
            muted: "#b8cbe4",
            faint: "#7b93b4",
            subtleSurface: "#142953",
            subtleBorder: "#2b4c7f",
            subtleText: "#b8cbe4",
            infoSurface: "rgba(112,217,255,.14)",
            infoBorder: "rgba(112,217,255,.4)",
            infoText: "#9ae9ff",
            successSurface: "rgba(5,150,105,.16)",
            successBorder: "rgba(52,211,153,.34)",
            successText: "#6ee7b7",
            warningSurface: "rgba(217,119,6,.16)",
            warningBorder: "rgba(251,191,36,.34)",
            warningText: "#fcd34d",
            danger: "#f87171",
            dangerSurface: "#2a1215",
            dangerBorder: "#7f1d1d",
            removeSurface: "rgba(8,24,49,.92)",
            removeBorder: "rgba(255,255,255,.20)",
            removeText: "#f8fafc",
            action: "#35cce1",
            actionText: "#071224",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(10,22,47,.98)",
            border: "#2b4c7f",
            item: "#e5e7eb",
            itemHover: "#1a3567",
            activeBg: "#00c2ff",
            activeText: "#071224",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
