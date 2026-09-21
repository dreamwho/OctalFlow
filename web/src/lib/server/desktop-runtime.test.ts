import { describe, expect, it } from "vitest";

import { getDesktopRuntimeInfo, isTrustedDesktopRequest, safeDesktopNextPath } from "./desktop-runtime";
import { isAdminLocalSectionEnabled } from "@/lib/desktop-edition-policy";

const token = "a".repeat(64);

describe("desktop runtime contract", () => {
    it("keeps web mode disabled without an explicit immutable edition", () => {
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "" })).toBeNull();
    });

    it("separates commercial and administrator capabilities", () => {
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "commercial" })).toMatchObject({ edition: "commercial", requiresLogin: true, cloudFeatures: false, cloudSync: false, implementationStage: "foundation", localProviderBilling: "free" });
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "admin" })).toMatchObject({ edition: "admin", requiresLogin: false, cloudFeatures: false, cloudSync: false, localProviderBilling: "free" });
    });

    it("accepts the runtime token only on a loopback request", () => {
        const environment = { ...process.env, DREAMYO_DESKTOP_EDITION: "admin", DREAMYO_DESKTOP_SESSION_TOKEN: token };
        expect(isTrustedDesktopRequest(new Request("http://127.0.0.1:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": token } }), environment)).toBe(true);
        expect(isTrustedDesktopRequest(new Request("https://example.com/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": token } }), environment)).toBe(false);
        expect(isTrustedDesktopRequest(new Request("http://127.0.0.1:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": "b".repeat(64) } }), environment)).toBe(false);
    });

    it("allows only application-relative redirect targets", () => {
        expect(safeDesktopNextPath("/admin?section=dola-api")).toBe("/admin?section=dola-api");
        expect(safeDesktopNextPath("//example.com")).toBe("/canvas");
        expect(safeDesktopNextPath("https://example.com")).toBe("/canvas");
    });

    it("hides cloud administration only for the local administrator edition", () => {
        expect(isAdminLocalSectionEnabled("users", "admin")).toBe(false);
        expect(isAdminLocalSectionEnabled("dolaApi", "admin")).toBe(true);
        expect(isAdminLocalSectionEnabled("users", "commercial")).toBe(true);
    });
});
