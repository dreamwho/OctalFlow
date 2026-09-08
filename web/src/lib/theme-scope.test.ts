import { describe, expect, it } from "vitest";

import { themeBroadcastChannel, themeScopeForPathname, themeStorageKey } from "./theme-scope";

describe("theme scope", () => {
    it("routes administrator pages to their independent theme preference", () => {
        expect(themeScopeForPathname("/admin")).toBe("admin");
        expect(themeScopeForPathname("/admin/billing")).toBe("admin");
        expect(themeScopeForPathname("/create")).toBe("frontend");
        expect(themeScopeForPathname(null)).toBe("frontend");
    });

    it("uses separate persistence and broadcast namespaces", () => {
        expect(themeStorageKey("frontend")).toBe("octalaicanvas:theme_store");
        expect(themeStorageKey("admin")).toBe("octalaicanvas:admin_theme_store");
        expect(themeBroadcastChannel("frontend")).toBe("octalaicanvas:theme_sync");
        expect(themeBroadcastChannel("admin")).toBe("octalaicanvas:admin_theme_sync");
    });
});
