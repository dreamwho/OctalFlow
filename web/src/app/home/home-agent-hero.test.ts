import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("homepage Agent hero", () => {
    it("opens real Skill and model pickers without adding a second prompt focus border", () => {
        const component = readFileSync(new URL("./home-agent-hero.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("./home-agent-hero.module.css", import.meta.url), "utf8");

        expect(component).toContain('data-testid="home-skill-picker"');
        expect(component).toContain('data-testid="home-model-picker"');
        expect(component).toContain('listAgentSkills("all")');
        expect(component).toContain("modelIds: selectedModelId ? [selectedModelId] : []");
        expect(component).not.toContain('onClick={() => openProtectedPath("/create")}');
        expect(styles).toContain(".composer textarea:focus-visible");
        expect(styles).toContain("border: 0 !important");
        expect(styles).toContain("box-shadow: none !important");
    });
});
