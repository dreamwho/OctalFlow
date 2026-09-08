import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Agent Skill creation", () => {
    it("persists the matching single-media node mode for a newly created Skill", () => {
        const source = readFileSync(new URL("./agent-skill-create-modal.tsx", import.meta.url), "utf8");

        expect(source).toContain('import { inferAgentSkillNodeModes } from "@/lib/agent-skill-node-policy";');
        expect(source).toContain("nodeModes: inferAgentSkillNodeModes(values.workspaces),");
    });
});
