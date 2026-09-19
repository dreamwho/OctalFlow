import { describe, expect, it } from "vitest";

import { DREAMINA_UPSCALE_RESOLUTION_OPTIONS, canUseDreaminaUpscale, resolveDreaminaUpscaleSize } from "./canvas-node-upscale-dialog";

describe("Canvas 图片超清选项", () => {
    it("exposes 2K, 4K VIP and 8K VIP resolution types", () => {
        expect(DREAMINA_UPSCALE_RESOLUTION_OPTIONS).toEqual([
            { label: "2K", value: "2k", pixels: 2048, vip: false },
            { label: "4K · VIP", value: "4k", pixels: 4096, vip: true },
            { label: "8K · VIP", value: "8k", pixels: 8192, vip: true },
        ]);
    });

    it("lets the server decide VIP eligibility when authorization is known", () => {
        const status = { enabled: true, authorized: true, vipLevel: "", checkedAt: "2026-08-31T10:00:00.000Z" };
        expect(canUseDreaminaUpscale(status, 1024, "4k")).toBe(true);
        expect(canUseDreaminaUpscale(null, 1024, "4k")).toBe(false);
        expect(canUseDreaminaUpscale({ ...status, authorized: false }, 1024, "2k")).toBe(false);
        expect(canUseDreaminaUpscale({ ...status, enabled: false }, 1024, "2k")).toBe(false);
    });

    it("calculates an 8K pending node size without the local 4K cap", () => {
        expect(resolveDreaminaUpscaleSize(1024, 768, "8k")).toEqual({ width: 8192, height: 6144 });
    });
});
