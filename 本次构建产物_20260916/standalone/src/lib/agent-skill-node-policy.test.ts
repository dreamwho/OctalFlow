import { describe, expect, it } from "vitest";

import { agentSkillSupportsNodeMode, defaultAgentSkillNodeModes, inferAgentSkillNodeModes } from "./agent-skill-node-policy";

describe("agent skill node policy", () => {
    it("routes built-in pure skills to exactly one node media type", () => {
        expect(defaultAgentSkillNodeModes("ecommerce-image")).toEqual(["image"]);
        expect(defaultAgentSkillNodeModes("skill-minimax-h3-prompt")).toEqual(["video"]);
        expect(agentSkillSupportsNodeMode({ id: "ecommerce-image" }, "image")).toBe(true);
        expect(agentSkillSupportsNodeMode({ id: "ecommerce-image" }, "video")).toBe(false);
        expect(agentSkillSupportsNodeMode({ id: "skill-minimax-h3-prompt" }, "video")).toBe(true);
    });

    it("keeps orchestration and combined skills Agent-only", () => {
        expect(defaultAgentSkillNodeModes("skill-drama-pipeline")).toEqual([]);
        expect(agentSkillSupportsNodeMode({ id: "skill-drama-pipeline" }, "image")).toBe(false);
        expect(agentSkillSupportsNodeMode({ id: "skill-real-vlog" }, "video")).toBe(false);
        expect(agentSkillSupportsNodeMode({ id: "custom-combo", nodeModes: ["image", "video"] }, "image")).toBe(false);
        expect(agentSkillSupportsNodeMode({ id: "ecommerce-image", nodeModes: [] }, "image")).toBe(false);
    });

    it("infers a node mode only for custom Skills with one media workspace", () => {
        expect(inferAgentSkillNodeModes(["image", "canvas"])).toEqual(["image"]);
        expect(inferAgentSkillNodeModes(["video", "canvas", "drama"])).toEqual(["video"]);
        expect(inferAgentSkillNodeModes(["image", "video", "canvas"])).toEqual([]);

        expect(agentSkillSupportsNodeMode({ id: "local-realistic-image", nodeModes: [], workspaces: ["image", "canvas"] }, "image")).toBe(true);
        expect(agentSkillSupportsNodeMode({ id: "local-combined-director", nodeModes: [], workspaces: ["image", "video", "canvas"] }, "image")).toBe(false);
        expect(agentSkillSupportsNodeMode({ id: "ecommerce-image", nodeModes: [], workspaces: ["image", "canvas"] }, "image")).toBe(false);
    });
});
