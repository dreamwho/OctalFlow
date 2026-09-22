import { describe, expect, it } from "vitest";

import { getDesktopRuntimeInfo, isTrustedDesktopMainRequest, isTrustedDesktopRequest, safeDesktopNextPath } from "./desktop-runtime";
import editionManifest from "@/lib/desktop-edition-manifest.json";
import { isAdminLocalSectionEnabled } from "@/lib/desktop-edition-policy";

const token = "a".repeat(64);

describe("desktop runtime contract", () => {
    it("keeps web mode disabled without an explicit immutable edition", () => {
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "" })).toBeNull();
    });

    it("separates commercial and administrator capabilities", () => {
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "commercial" })).toMatchObject({ edition: "commercial", requiresLogin: true, cloudFeatures: false, cloudSync: false, cloudProjectBackups: true, implementationStage: "foundation", localProviderBilling: "free" });
        expect(getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: "admin" })).toMatchObject({ edition: "admin", requiresLogin: false, cloudFeatures: false, cloudSync: false, cloudProjectBackups: false, localProviderBilling: "free" });
    });

    it("reports the same capabilities that Electron packages for both editions", () => {
        for (const edition of ["commercial", "admin"] as const) {
            const info = getDesktopRuntimeInfo({ ...process.env, DREAMYO_DESKTOP_EDITION: edition });
            for (const key of ["requiresLogin", "cloudFeatures", "cloudSync", "cloudProjectBackups", "localProviders", "localProviderBilling", "implementationStage"] as const) {
                expect(info?.[key]).toBe(editionManifest[edition][key]);
            }
        }
    });

    it("accepts the runtime token only on a loopback request", () => {
        const environment = { ...process.env, DREAMYO_DESKTOP_EDITION: "admin", DREAMYO_DESKTOP_SESSION_TOKEN: token };
        expect(isTrustedDesktopRequest(new Request("http://127.0.0.1:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": token } }), environment)).toBe(true);
        expect(isTrustedDesktopRequest(new Request("https://example.com/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": token } }), environment)).toBe(false);
        expect(isTrustedDesktopRequest(new Request("http://127.0.0.1:3333/api/desktop/bootstrap", { headers: { "x-dreamyo-desktop-token": "b".repeat(64) } }), environment)).toBe(false);
    });

    it("reserves identity bootstrap for Electron Main, not renderer requests", () => {
        const mainToken = "m".repeat(64);
        const environment = { ...process.env, DREAMYO_DESKTOP_EDITION: "commercial", DREAMYO_DESKTOP_SESSION_TOKEN: token, DREAMYO_DESKTOP_MAIN_TOKEN: mainToken };
        const url = "http://127.0.0.1:3333/api/desktop/cloud-bootstrap";
        expect(isTrustedDesktopMainRequest(new Request(url, { headers: { "x-dreamyo-desktop-token": token } }), environment)).toBe(false);
        expect(isTrustedDesktopMainRequest(new Request(url, { headers: { "x-dreamyo-desktop-token": token, "x-dreamyo-desktop-main-token": mainToken } }), environment)).toBe(true);
        expect(isTrustedDesktopMainRequest(new Request(url, { headers: { "x-dreamyo-desktop-token": token, "x-dreamyo-desktop-main-token": "x".repeat(64) } }), environment)).toBe(false);
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
