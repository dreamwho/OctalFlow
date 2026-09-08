import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CanvasNodeUpscalePanel, resolveDreaminaUpscaleSubmitStyle } from "./canvas-node-upscale-panel";

const sourceNode: CanvasNodeData = {
    id: "source",
    type: CanvasNodeType.Image,
    title: "原图",
    position: { x: 0, y: 0 },
    width: 1360,
    height: 1024,
    metadata: { content: "/api/reference-assets/original.png", naturalWidth: 1360, naturalHeight: 1024 },
};

const resultNode: CanvasNodeData = {
    ...sourceNode,
    id: "upscaled",
    title: "即梦 CLI 图片超清",
    metadata: {
        content: "/api/reference-assets/upscaled.png",
        upscaleTask: { id: "upscale-task", provider: "dreamina-cli", model: "dreamina-image-upscale", resolutionType: "4k", sourceNodeId: "source" },
    },
};

function renderPanel() {
    return renderToStaticMarkup(<CanvasNodeUpscalePanel node={resultNode} sourceNode={sourceNode} onClose={() => undefined} onConfirm={() => undefined} />);
}

describe("CanvasNodeUpscalePanel", () => {
    beforeEach(() => useThemeStore.setState({ theme: "light" }));

    it("uses a readable foreground for the light theme re-upscale action", () => {
        expect(renderPanel()).toContain("background:#5b5ce2;border-color:#5b5ce2;color:#ffffff");
    });

    it("switches the re-upscale action foreground for the dark theme", () => {
        expect(resolveDreaminaUpscaleSubmitStyle(canvasThemes.dark)).toEqual({ background: "#ffffff", borderColor: "#ffffff", color: "#0f172a" });
    });
});
