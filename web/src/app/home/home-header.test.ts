import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("home header", () => {
    it("uses floating edge controls instead of a full-width navigation surface", async () => {
        const [component, css] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/home/home-header.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/home/home.module.css"), "utf8"),
        ]);

        expect(component).toContain('aria-label="首页导航菜单"');
        expect(component).toContain("styles.navMenuButton");
        expect(component).not.toContain("styles.desktopNav");
        expect(css).toMatch(/\.header\s*\{[\s\S]*?background:\s*transparent;/);
        expect(css).toMatch(/\.header\s*\{[\s\S]*?position:\s*absolute;/);
        expect(css).not.toContain("--home-nav-glass");
    });
});
