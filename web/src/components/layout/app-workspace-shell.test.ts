import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isFullscreenWorkspacePath } from "./app-workspace-path";

describe("workspace sidebar", () => {
    it("starts expanded and keeps scrolling without a visible scrollbar", async () => {
        const [shell, sidebar, shellStyles, foundationStyles, mobileNav, adminNav] = await Promise.all([
            readFile(resolve(process.cwd(), "src/components/layout/app-workspace-shell.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/components/layout/app-sidebar.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/styles/global-app-shell.css"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/styles/global-foundation.css"), "utf8"),
            readFile(resolve(process.cwd(), "src/components/layout/mobile-nav-drawer.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/components/admin/admin-section-nav.tsx"), "utf8"),
        ]);

        expect(shell).toContain("const [sidebarExpanded, setSidebarExpanded] = useState(true)");
        expect(shell).toContain("expanded={sidebarExpanded}");
        expect(sidebar).toContain('expanded ? "w-[156px]" : "w-[60px]"');
        expect(sidebar).toContain("octaflow-selection-surface");
        expect(sidebar).toContain("hide-scrollbar min-h-0 flex-1 overflow-y-auto");
        expect(sidebar).not.toContain("thin-scrollbar min-h-0 flex-1 overflow-y-auto");
        expect(sidebar).toContain('<CircleHelp className="size-[17px] shrink-0" />');
        expect(sidebar).not.toContain("userAvatarFallback");
        expect(sidebar).not.toContain("workspaceUrl");
        expect(sidebar).not.toContain("window.location.host");
        expect(shellStyles).toContain(".app-sidebar-item:not(.is-active)");
        expect(shellStyles).toContain("color: #9bb7c7 !important");
        expect(foundationStyles).toContain("button:not(:disabled)");
        expect(foundationStyles).toContain("cursor: pointer");
        expect(foundationStyles).toContain("cursor: not-allowed");
        expect(sidebar).toContain("app-sidebar-item group relative flex h-9 cursor-pointer");
        expect(mobileNav).toContain("flex min-h-11 cursor-pointer");
        expect(adminNav).toContain("admin-section-nav-item relative flex h-9 w-full min-w-0 cursor-pointer");
        expect(shell).toContain("workspace-header relative z-30");
        expect(shell).toContain("workspace-main-column");
        expect(shell).not.toContain("{pageTitle}");
        expect(shell).not.toContain("border-b border-[#eaecf0] bg-white/96");
    });

    it("opens Canvas and drama project details as full-screen workspaces only", () => {
        expect(isFullscreenWorkspacePath("/canvas/canvas-one")).toBe(true);
        expect(isFullscreenWorkspacePath("/canvas/canvas-one/history")).toBe(true);
        expect(isFullscreenWorkspacePath("/drama/drama-one")).toBe(true);
        expect(isFullscreenWorkspacePath("/drama/drama-one/episode")).toBe(true);
        expect(isFullscreenWorkspacePath("/canvas")).toBe(false);
        expect(isFullscreenWorkspacePath("/drama")).toBe(false);
    });
});
