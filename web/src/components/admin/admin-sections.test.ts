import { describe, expect, it } from "vitest";

import { adminSectionHref, allowedAdminSections, canAccessAdminSection, parseAdminSection, resolveAdminSection } from "./admin-sections";

describe("admin sections", () => {
    it("parses a valid section and falls back to overview", () => {
        expect(parseAdminSection("channels")).toBe("channels");
        expect(parseAdminSection("magicProxy")).toBe("magicProxy");
        expect(parseAdminSection("geminiai")).toBe("geminiai");
        expect(parseAdminSection("geminiTools")).toBe("geminiTools");
        expect(parseAdminSection("dreamina")).toBe("dreamina");
        expect(parseAdminSection("runninghub")).toBe("runninghub");
        expect(parseAdminSection(["skills", "channels"])).toBe("skills");
        expect(parseAdminSection("missing")).toBe("overview");
    });

    it("keeps unrelated query parameters while updating the current section", () => {
        expect(adminSectionHref("channels", "https://example.com/admin?from=notice#top")).toBe("/admin?from=notice&section=channels#top");
        expect(adminSectionHref("overview", "https://example.com/admin?section=channels&from=notice#top")).toBe("/admin?from=notice#top");
    });

    it("shows only sections allowed by the administrator duties", () => {
        const auditor = { role: "admin", status: "active", adminPermissions: ["audit.read"] };
        const upstreamOperator = { role: "admin", status: "active", adminPermissions: ["upstream.manage"] };

        expect(canAccessAdminSection(auditor, "backup")).toBe(false);
        expect(canAccessAdminSection(auditor, "geminiai")).toBe(false);
        expect(canAccessAdminSection(auditor, "magicProxy")).toBe(false);
        expect(canAccessAdminSection(upstreamOperator, "magicProxy")).toBe(true);
        expect(canAccessAdminSection(upstreamOperator, "geminiai")).toBe(true);
        expect(canAccessAdminSection(upstreamOperator, "geminiTools")).toBe(true);
        expect(canAccessAdminSection(upstreamOperator, "dreamina")).toBe(true);
        expect(canAccessAdminSection(upstreamOperator, "runninghub")).toBe(true);
        expect(allowedAdminSections(upstreamOperator)).toContain("geminiai");
        expect(allowedAdminSections(upstreamOperator)).toContain("magicProxy");
        expect(allowedAdminSections(upstreamOperator)).toContain("geminiTools");
        expect(allowedAdminSections(upstreamOperator)).toContain("dreamina");
        expect(allowedAdminSections(upstreamOperator)).toContain("runninghub");
        expect(allowedAdminSections(auditor)).toEqual(["updates", "adminHelp"]);
        expect(resolveAdminSection(auditor, "backup")).toBe("updates");
    });
});
