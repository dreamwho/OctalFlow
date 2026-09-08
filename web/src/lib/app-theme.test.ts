import { describe, expect, it } from "vitest";

import { getAntThemeConfig } from "./app-theme";

describe("app selection theme", () => {
    it.each([false, true])("uses the shared luminous selected surface (dark=%s)", (dark) => {
        const config = getAntThemeConfig(dark);
        const select = config.components?.Select;
        const segmented = config.components?.Segmented;
        const slider = config.components?.Slider;
        const tabs = config.components?.Tabs;

        expect(select?.optionSelectedBg).not.toBe("transparent");
        expect(select?.optionSelectedFontWeight).toBe(400);
        expect(select?.controlItemBgActiveHover).toBe(select?.optionSelectedBg);
        expect(select?.activeBorderColor).not.toBe(dark ? "#fafafa" : "#171717");
        expect(segmented?.itemSelectedBg).toBe(select?.optionSelectedBg);
        expect(segmented?.itemSelectedColor).toBe(select?.optionSelectedColor);
        expect(slider?.trackBg).toBeTruthy();
        expect(tabs?.inkBarColor).toBeTruthy();
    });
});
