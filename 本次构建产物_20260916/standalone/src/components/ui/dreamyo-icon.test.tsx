import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DreamyoIcon, DreamyoWaitingIcon } from "./dreamyo-icon";

describe("DreamyoIcon", () => {
    it("renders the supplied transparent brand asset with an accessible label", () => {
        const markup = renderToStaticMarkup(<DreamyoIcon name="image" size={24} label="图片" />);

        expect(markup).toContain('data-dreamyo-icon="image"');
        expect(markup).toContain('src="/brand/dreamyo/icons/image.png"');
        expect(markup).toContain('aria-label="图片"');
    });

    it("clamps waiting animation frames to the available generated assets", () => {
        const markup = renderToStaticMarkup(<DreamyoWaitingIcon frame={99} />);

        expect(markup).toContain('data-dreamyo-icon="waiting-6"');
        expect(markup).toContain("/brand/dreamyo/icons/waiting-6.png");
    });
});
