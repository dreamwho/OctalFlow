import { describe, expect, it } from "vitest";

import { CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT, CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH, MIN_CANVAS_AGENT_PANEL_WIDTH, canvasAgentExpandedComposerSize, canvasAgentPanelMaxWidth, clampCanvasAgentPanelWidth } from "./canvas-agent-panel-layout";

describe("Canvas Agent panel layout", () => {
    it("allows the Agent panel to expand across the full desktop viewport", () => {
        expect(canvasAgentPanelMaxWidth(769)).toBe(769);
        expect(canvasAgentPanelMaxWidth(1024)).toBe(1024);
    });

    it("caps width only at the actual viewport edge", () => {
        expect(canvasAgentPanelMaxWidth(1440)).toBe(1440);
        expect(clampCanvasAgentPanelWidth(2000, 1440)).toBe(1440);
    });

    it("never makes the interactive desktop panel narrower than its minimum", () => {
        expect(clampCanvasAgentPanelWidth(120, 800)).toBe(MIN_CANVAS_AGENT_PANEL_WIDTH);
    });

    it("keeps the expanded composer centered and bounded instead of filling the viewport", () => {
        expect(canvasAgentExpandedComposerSize(2048, 549)).toEqual({ width: CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH, height: CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT });
        expect(canvasAgentExpandedComposerSize(390, 500)).toEqual({ width: 358, height: CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT });
        expect(canvasAgentExpandedComposerSize(1440, 300)).toEqual({ width: CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH, height: 236 });
    });
});
