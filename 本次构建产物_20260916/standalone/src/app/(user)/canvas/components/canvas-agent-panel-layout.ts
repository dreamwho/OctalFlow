export const DEFAULT_CANVAS_AGENT_PANEL_WIDTH = 584;
export const MIN_CANVAS_AGENT_PANEL_WIDTH = 380;
export const CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH = 896;
export const CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT = 368;

const EXPANDED_COMPOSER_HORIZONTAL_GUTTER = 32;
const EXPANDED_COMPOSER_VERTICAL_GUTTER = 64;

export function canvasAgentPanelMaxWidth(viewportWidth: number) {
    const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : DEFAULT_CANVAS_AGENT_PANEL_WIDTH;
    return Math.max(MIN_CANVAS_AGENT_PANEL_WIDTH, safeViewportWidth);
}

export function clampCanvasAgentPanelWidth(width: number, viewportWidth: number) {
    return Math.min(canvasAgentPanelMaxWidth(viewportWidth), Math.max(MIN_CANVAS_AGENT_PANEL_WIDTH, width));
}

export function canvasAgentExpandedComposerSize(viewportWidth: number, viewportHeight: number) {
    const safeWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH;
    const safeHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT;
    return {
        width: Math.max(0, Math.min(CANVAS_AGENT_EXPANDED_COMPOSER_MAX_WIDTH, safeWidth - EXPANDED_COMPOSER_HORIZONTAL_GUTTER)),
        height: Math.max(0, Math.min(CANVAS_AGENT_EXPANDED_COMPOSER_MAX_HEIGHT, safeHeight - EXPANDED_COMPOSER_VERTICAL_GUTTER)),
    };
}
