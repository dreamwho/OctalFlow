export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasSelectionFlowColors = {
    start: "#67e8f9",
    middle: "#818cf8",
    end: "#c084fc",
} as const;

export const canvasSelectionGradient = `linear-gradient(90deg, ${canvasSelectionFlowColors.start} 0%, ${canvasSelectionFlowColors.middle} 48%, ${canvasSelectionFlowColors.end} 100%)`;
export const canvasSelectionGlow = "0 0 18px rgba(129,140,248,.3), 0 0 32px rgba(192,132,252,.16)";

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
            background: "#fbfbfd",
            backdrop: "#fbfbfd",
            dot: "rgba(91,92,226,.16)",
            line: "rgba(91,92,226,.08)",
            glow: "radial-gradient(ellipse 56% 52% at 5% 14%, rgba(56,189,248,.17), transparent 72%), radial-gradient(ellipse 48% 44% at 92% 90%, rgba(139,92,246,.13), transparent 74%)",
            selectionStroke: "#5b5ce2",
            selectionFill: "rgba(91,92,226,.09)",
        },
        node: {
            label: "#525866",
            fill: "#f6f7fb",
            panel: "#ffffff",
            stroke: "#e2e5ef",
            activeStroke: "#5b5ce2",
            placeholder: "#9aa1b1",
            text: "#202532",
            muted: "#6d7482",
            faint: "#9aa1b1",
            subtleSurface: "#f8f8fb",
            subtleBorder: "#e2e5ef",
            subtleText: "#525866",
            infoSurface: "#f1f2ff",
            infoBorder: "#cfd2ff",
            infoText: "#5052cc",
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
            action: "#5b5ce2",
            actionText: "#ffffff",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(255,255,255,.97)",
            border: "#e2e5ef",
            item: "#525866",
            itemHover: "#f1f2ff",
            activeBg: "#eeefff",
            activeText: "#4d4fd0",
        },
    },
    dark: {
        canvas: {
            background: "#090b10",
            backdrop: "#090b10",
            dot: "rgba(248,250,252,.18)",
            line: "rgba(248,250,252,.08)",
            glow: "radial-gradient(ellipse 58% 54% at 4% 12%, rgba(14,116,174,.28), transparent 72%), radial-gradient(ellipse 50% 46% at 92% 91%, rgba(104,76,190,.24), transparent 74%)",
            selectionStroke: "#ffffff",
            selectionFill: "rgba(255,255,255,.10)",
        },
        node: {
            label: "#e5e7eb",
            fill: "#111318",
            panel: "#0f1115",
            stroke: "#303642",
            activeStroke: "#ffffff",
            placeholder: "#94a3b8",
            text: "#f8fafc",
            muted: "#cbd5e1",
            faint: "#64748b",
            subtleSurface: "#1a1f27",
            subtleBorder: "#303642",
            subtleText: "#cbd5e1",
            infoSurface: "rgba(8,145,178,.16)",
            infoBorder: "rgba(34,211,238,.36)",
            infoText: "#67e8f9",
            successSurface: "rgba(5,150,105,.16)",
            successBorder: "rgba(52,211,153,.34)",
            successText: "#6ee7b7",
            warningSurface: "rgba(217,119,6,.16)",
            warningBorder: "rgba(251,191,36,.34)",
            warningText: "#fcd34d",
            danger: "#f87171",
            dangerSurface: "#2a1215",
            dangerBorder: "#7f1d1d",
            removeSurface: "rgba(15,23,42,.88)",
            removeBorder: "rgba(255,255,255,.20)",
            removeText: "#f8fafc",
            action: "#f8fafc",
            actionText: "#0f172a",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(23,26,32,.98)",
            border: "#303642",
            item: "#e5e7eb",
            itemHover: "#1f2937",
            activeBg: "#f8fafc",
            activeText: "#0f172a",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
