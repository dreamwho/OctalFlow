import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultConfig } from "@/stores/use-config-store";
import { CanvasStoryboardDialogContent } from "./canvas-storyboard-dialog";

describe("CanvasStoryboardDialogContent", () => {
    it("renders backend quick actions with capability-aware model choice and no fixed output defaults", () => {
        const markup = renderToStaticMarkup(
            <CanvasStoryboardDialogContent
                dataUrl="/api/reference-assets/source.png"
                config={{ ...defaultConfig, model: "logical-image", imageModel: "logical-image", models: ["logical-image"], imageModels: ["logical-image"] }}
                actions={[
                    {
                        id: "character-three-view",
                        groupId: "storyboard",
                        groupName: "分镜大师",
                        name: "人物三视图",
                        prompt: "根据参考图生成角色资产三视图",
                        capability: "image",
                        enabled: true,
                        defaults: {},
                    },
                ]}
                selectedId="character-three-view"
                model="logical-image"
                onModelChange={() => undefined}
                onSelect={() => undefined}
                onMissingConfig={() => undefined}
                onClose={() => undefined}
                onConfirm={() => undefined}
            />,
        );

        expect(markup).toContain("人物三视图");
        expect(markup).toContain("分镜大师");
        expect(markup).toContain("图片逻辑模型");
        expect(markup).toContain("确认生成");
        expect(markup).not.toContain("16:9");
        expect(markup).not.toContain("4K");
    });
});
