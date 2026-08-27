import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SITE_SETTINGS } from "@/lib/auth/store";

describe("default infinite-evolution brand assets", () => {
    it("uses the built-in infinite-evolution logo for every default brand entry", () => {
        expect(DEFAULT_SITE_SETTINGS.logoUrl).toBe("/brand/octaflow-mark.png");
        expect(DEFAULT_SITE_SETTINGS.iconUrl).toBe("/brand/octaflow-icon.png");
    });

    it("ships the OctalFlow raster mark for the web app, browser icon and docs", async () => {
        const [logo, icon, docsLogo] = await Promise.all([
            readFile(resolve(process.cwd(), "public/brand/octaflow-mark.png")),
            readFile(resolve(process.cwd(), "public/brand/octaflow-icon.png")),
            readFile(resolve(process.cwd(), "../docs/public/brand/octaflow-mark.png")),
        ]);

        expect(logo.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(docsLogo).toEqual(logo);
    });
});
