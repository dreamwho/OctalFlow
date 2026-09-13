export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasSelectionFlowColors = {
    start: "#67e8f9",
    middle: "#5f85ff",
    end: "#8b7dff",
} as const;

export const canvasSelectionGradient = `linear-gradient(90deg, ${canvasSelectionFlowColors.start} 0%, ${canvasSelectionFlowColors.middle} 48%, ${canvasSelectionFlowColors.end} 100%)`;
export const canvasSelectionGlow = "0 0 18px rgba(47,111,255,.28), 0 0 32px rgba(61,216,232,.16)";

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
            background: "#f5f8ff",
            backdrop: "#f5f8ff",
            dot: "rgba(47,111,255,.16)",
            line: "rgba(47,111,255,.08)",
            glow: "radial-gradient(ellipse 56% 52% at 5% 14%, rgba(61,216,232,.16), transparent 72%), radial-gradient(ellipse 48% 44% at 92% 90%, rgba(47,111,255,.12), transparent 74%)",
            selectionStroke: "#2f6fff",
            selectionFill: "rgba(47,111,255,.09)",
        },
        node: {
            label: "#525866",
            fill: "#f8fbff",
            panel: "#ffffff",
            stroke: "#dfe7f3",
            activeStroke: "#2f6fff",
            placeholder: "#9aa1b1",
            text: "#13203b",
            muted: "#687894",
            faint: "#8fa0bb",
            subtleSurface: "#f1f6ff",
            subtleBorder: "#dfe7f3",
            subtleText: "#405575",
            infoSurface: "#eef5ff",
            infoBorder: "#b8c9ee",
            infoText: "#245bd0",
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
            action: "#2f6fff",
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
            background: "#061326",
            backdrop: "#061326",
            dot: "rgba(112,217,255,.2)",
            line: "rgba(112,217,255,.08)",
            glow: "radial-gradient(ellipse 58% 54% at 4% 12%, rgba(47,111,255,.22), transparent 72%), radial-gradient(ellipse 50% 46% at 92% 91%, rgba(61,216,232,.16), transparent 74%)",
            selectionStroke: "#70d9ff",
            selectionFill: "rgba(112,217,255,.12)",
        },
        node: {
            label: "#e5e7eb",
            fill: "#0d1b33",
            panel: "#0c1f3c",
            stroke: "#254b75",
            activeStroke: "#70d9ff",
            placeholder: "#94a3b8",
            text: "#eef6ff",
            muted: "#b8cbe4",
            faint: "#7b93b4",
            subtleSurface: "#102748",
            subtleBorder: "#254b75",
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
            action: "#70d9ff",
            actionText: "#04142b",
            actionDangerText: "#ffffff",
        },
        toolbar: {
            panel: "rgba(9,27,54,.98)",
            border: "#303642",
            item: "#e5e7eb",
            itemHover: "#163258",
            activeBg: "#70d9ff",
            activeText: "#04142b",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
