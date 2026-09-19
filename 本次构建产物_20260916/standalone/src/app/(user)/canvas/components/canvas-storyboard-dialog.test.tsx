import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultConfig } from "@/stores/use-config-store";
import { CanvasStoryboardDialogContent } from "./canvas-storyboard-dialog";

describe("CanvasStoryboardDialog", () => {
    it("shows the image logical-model choice without exposing fixed output defaults", () => {
        const markup = renderToStaticMarkup(
            <CanvasStoryboardDialogContent
                dataUrl="/api/reference-assets/source.png"
                config={{ ...defaultConfig, model: "logical-image", imageModel: "logical-image", models: ["logical-image"], imageModels: ["logical-image"] }}
                model="logical-image"
                onModelChange={() => undefined}
                onMissingConfig={() => undefined}
                onClose={() => undefined}
                onConfirm={() => undefined}
            />,
        );

        expect(markup).toContain("人物三视图");
        expect(markup).toContain("图片逻辑模型");
        expect(markup).toContain("确认生成");
        expect(markup).not.toContain("16:9");
        expect(markup).not.toContain("4K");
    });
});
