import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("image and video workbench routes", () => {
    it("uses /create as the shared image and video workspace", async () => {
        const create = await readFile(resolve(process.cwd(), "src/app/(user)/create/page.tsx"), "utf8");
        const page = await readFile(resolve(process.cwd(), "src/app/(user)/image/page.tsx"), "utf8");
        expect(create).toContain("ImageVideoWorkbench");
        expect(page).toContain('redirect("/create?mode=image")');
    });

    it("keeps /video as a shortcut into video mode", async () => {
        const page = await readFile(resolve(process.cwd(), "src/app/(user)/video/page.tsx"), "utf8");

        expect(page).toContain('redirect("/create?mode=video")');
    });
});
