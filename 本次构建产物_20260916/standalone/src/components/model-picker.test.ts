import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { resolveModelIcon } from "./model-picker";

describe("model picker brand icons", () => {
    it.each([
        ["MiniMax Hailuo 02", "/icons/minimax.svg"],
        ["speech-2.8-hd", "/icons/minimax.svg"],
        ["music-3.0", "/icons/minimax.svg"],
        ["cosyvoice-v3-plus", "/icons/qwen.svg"],
        ["seedance2.0fast", "/icons/jimeng.svg"],
        ["Seedream 5.0 Pro", "/icons/jimeng.svg"],
    ])("maps %s to its brand icon", (model, icon) => {
        expect(resolveModelIcon(model)).toBe(icon);
    });

    it("keeps the Seedance icon colored in dark canvas surfaces", () => {
        const source = readFileSync(new URL("./model-picker.tsx", import.meta.url), "utf8");
        const icon = readFileSync(new URL("../../public/icons/jimeng.svg", import.meta.url), "utf8");

        expect(source).toContain('icon === "/icons/jimeng.svg" || icon === "/icons/minimax.svg" || icon === "/icons/qwen.svg"');
        expect(icon).toContain("linearGradient");
        expect(icon).toContain("#7BF3E2");
        expect(icon).toContain('viewBox="16 16 32 36"');
        expect(icon).not.toContain("<rect");
        expect(icon).not.toContain("#080B10");
        expect(icon).not.toContain("currentColor");
    });

    it("keeps MiniMax and Bailian icons transparent and colored", () => {
        const source = readFileSync(new URL("../../public/icons/minimax.svg", import.meta.url), "utf8");
        const qwen = readFileSync(new URL("../../public/icons/qwen.svg", import.meta.url), "utf8");

        expect(source).toContain("linearGradient");
        expect(source).not.toContain("<rect");
        expect(source).not.toContain("currentColor");
        expect(qwen).toContain("linearGradient");
        expect(qwen).not.toContain("<rect");
    });
});
