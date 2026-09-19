import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("homepage Agent hero", () => {
    it("opens real Skill, model and mode pickers without adding a second prompt focus border", () => {
        const component = readFileSync(new URL("./home-agent-hero.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("./home-agent-hero.module.css", import.meta.url), "utf8");

        expect(component).toContain('data-testid="home-skill-picker"');
        expect(component).toContain('<ModelPicker');
        expect(component).toContain('listAgentSkills("all")');
        expect(component).toContain("modelIds: selectedModelId ? [selectedModelId] : []");
        expect(component).not.toContain('onClick={() => openProtectedPath("/create")}');
        expect(component).toContain('data-home-credit-cost');
        expect(styles).toContain(".composer textarea:focus-visible");
        expect(styles).toContain("border: 0 !important");
        expect(styles).toContain("box-shadow: none !important");
    });

    it("centers the aurora hero copy and keeps the mode picker dropdown structure", () => {
        const component = readFileSync(new URL("./home-agent-hero.tsx", import.meta.url), "utf8");
        const styles = readFileSync(new URL("./home-agent-hero.module.css", import.meta.url), "utf8");
        const aurora = styles.slice(styles.indexOf('[data-home-design="aurora"]'));

        expect(aurora).toMatch(/\.heroContent\s*\{[\s\S]*?text-align:\s*center;/);
        expect(aurora).toMatch(/\.heroTitle\s*\{[\s\S]*?text-align:\s*center;/);
        expect(component).not.toContain("styles.modeGroup");
        expect(component).not.toContain("styles.heroStats");
        expect(component).not.toContain("styles.heroAside");
    });
});
