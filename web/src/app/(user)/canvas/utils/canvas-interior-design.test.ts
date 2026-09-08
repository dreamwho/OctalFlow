import { describe, expect, it } from "vitest";

import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CANVAS_NODE_GAP } from "./canvas-surface-geometry";
import { INTERIOR_DESIGN_NODE_SIZE, INTERIOR_DESIGN_TABS, compileInteriorDesignPrompt, createInteriorDesignConfigNode, createInteriorDesignSettings, interiorDesignModels, interiorDesignNodePatch, isInteriorDesignModel } from "./canvas-interior-design";

describe("Canvas interior design", () => {
    it("keeps output ratio controls inside the generation tab", () => {
        expect(INTERIOR_DESIGN_TABS.map((tab) => tab.label)).toEqual(["生图模式", "场景", "光影氛围", "摄影设备", "AI约束"]);
    });

    it("builds scene-specific defaults without sharing mutable techniques", () => {
        const interior = createInteriorDesignSettings("interior");
        const light = createInteriorDesignSettings("interior-light");
        const exterior = createInteriorDesignSettings("exterior");
        const enclosed = createInteriorDesignSettings("enclosed");

        expect(interior).toMatchObject({ scene: "interior", season: "夏季", weather: "晴天", time: "上午9点", mainLight: true, artificialLight: false, resolution: "8K" });
        expect(light).toMatchObject({ curtain: "单层纱帘（关闭）", sunlight: "纱帘光影" });
        expect(exterior).toMatchObject({ scene: "exterior", season: "自动", mainLight: false, sunlight: "室外晴天树影", shutter: "5s" });
        expect(enclosed).toMatchObject({ scene: "enclosed", location: "封闭空间", time: "晚上19点", artificialLight: true, indoorLight: "封闭空间人工照明" });
        exterior.techniques.push("HDR包围曝光");
        expect(interior.techniques).toEqual(["单张直出"]);
    });

    it("compiles stable JSON values while omitting disabled switches and empty multi-selects", () => {
        const settings = { ...createInteriorDesignSettings(), mainLight: false, artificialLight: false, techniques: [] };
        const parsed = JSON.parse(compileInteriorDesignPrompt(settings));

        expect(Object.keys(parsed)).toEqual(["生图模式", "场景设计", "光影氛围", "摄影参数", "核心约束", "出图参数"]);
        expect(parsed["生图模式"]["图生图任务"]).toContain("SU模型截图");
        expect(parsed["光影氛围"]).not.toHaveProperty("主进光口控制");
        expect(parsed["光影氛围"]).not.toHaveProperty("人工主光源");
        expect(parsed["摄影参数"]).not.toHaveProperty("摄影技法");
        expect(parsed["出图参数"]).toEqual({ 画面比例: "100%保持原图比例", 目标精度: "8K" });
    });

    it("keeps the public title separate from the JSON execution prompt in persisted metadata", () => {
        const patch = interiorDesignNodePatch(createInteriorDesignSettings(), "interior-image");
        const restored = JSON.parse(JSON.stringify(patch));

        expect(restored).toMatchObject({ configKind: "interior-design", generationMode: "image", model: "interior-image", sourcePrompt: "SU直出摄影级照片", size: "auto", quality: "high", count: 1 });
        expect(JSON.parse(restored.executionPrompt)["核心约束"]["几何保真"]).toContain("强制几何保真");
        expect(restored.sourcePrompt).not.toContain("图生图任务");
    });

    it("preserves actual model parameters when photography settings are edited", () => {
        const patch = interiorDesignNodePatch(createInteriorDesignSettings(), "interior-image", {
            size: "9:16",
            sizeUserSelected: true,
            quality: "medium",
            count: 2,
        });

        expect(patch).toMatchObject({ size: "9:16", sizeUserSelected: true, quality: "medium", count: 2 });
    });

    it("creates a persisted Config node to the source image's right with a stable connection", () => {
        const source: CanvasNodeData = { id: "source-image", type: CanvasNodeType.Image, title: "原图", position: { x: 40, y: 80 }, width: 300, height: 240, metadata: { content: "https://example.com/source.webp" } };
        const created = createInteriorDesignConfigNode({ source, nodes: [source], settings: createInteriorDesignSettings(), model: "interior-image", nodeId: "interior-config", connectionId: "source-to-interior" });

        expect(created.node).toMatchObject({
            id: "interior-config",
            type: CanvasNodeType.Config,
            title: "室内设计",
            width: INTERIOR_DESIGN_NODE_SIZE.width,
            height: INTERIOR_DESIGN_NODE_SIZE.height,
            position: { x: source.position.x + source.width + CANVAS_NODE_GAP },
            metadata: { configKind: "interior-design", model: "interior-image" },
        });
        expect(created.connection).toEqual({ id: "source-to-interior", fromNodeId: source.id, toNodeId: created.node.id });
        expect(JSON.parse(JSON.stringify(created))).toEqual(created);
    });

    it("only exposes Nano Banana or Gemini image models routed through GeminiAI", () => {
        const config: AiConfig = {
            ...defaultConfig,
            apiSource: "system",
            models: ["interior-image", "other-image", "wrong-gemini-image", "generic-image"],
            imageModels: ["interior-image", "other-image", "wrong-gemini-image", "generic-image"],
            channels: [channel("geminiai", "geminiai", ["gemini-2.5-flash-image", "flux-image"]), channel("openai", "openai", ["gemini-image-pro", "gpt-image-2"])],
            logicalModels: [logical("interior-image", "geminiai", "gemini-2.5-flash-image"), logical("other-image", "geminiai", "flux-image"), logical("wrong-gemini-image", "openai", "gemini-image-pro"), logical("generic-image", "openai", "gpt-image-2")],
        };

        expect(interiorDesignModels(config)).toEqual(["interior-image"]);
        expect(isInteriorDesignModel(config, "interior-image")).toBe(true);
        expect(isInteriorDesignModel(config, "wrong-gemini-image")).toBe(false);
    });
});

function channel(id: string, protocol: "geminiai" | "openai", models: string[]) {
    return {
        id,
        name: id,
        baseUrl: `/api/ai/system/${id}`,
        apiKey: "system",
        apiFormat: "openai" as const,
        models,
        advancedConfig: {
            protocol,
            textModel: "",
            imageModel: models[0] || "",
            videoModel: "",
            createPath: "",
            queryPath: "",
            requestTemplate: "",
            resultField: "",
            statusField: "",
            durationRange: "",
            referenceRule: "",
            supportsReferenceImage: true,
            supportsReferenceVideo: false,
            supportsReferenceAudio: false,
        },
    };
}

function logical(id: string, channelId: string, upstreamModel: string) {
    return { id, name: id, capability: "image" as const, enabled: true, bindings: [{ id: `${id}-binding`, channelId, upstreamModel, enabled: true, priority: 1 }] };
}
