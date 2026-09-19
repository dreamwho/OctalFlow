import { describe, expect, it } from "vitest";

import { generationOperationStatusTagClass, generationOperationThemeClasses } from "./generation-operations-theme";

describe("generation operations theme", () => {
    it("uses explicit readable light and dark states for tags and review controls", () => {
        expect(generationOperationThemeClasses.selectedAction).toContain("admin-generation-selected-action");
        expect(generationOperationThemeClasses.idleAction).toContain("admin-generation-idle-action");
        expect(generationOperationStatusTagClass("running")).toContain("admin-generation-status-running");
        expect(generationOperationStatusTagClass("success")).toContain("admin-generation-status-success");
        expect(generationOperationStatusTagClass("error")).toContain("admin-generation-status-error");
        expect(generationOperationStatusTagClass("cancelled")).toBe(generationOperationThemeClasses.neutralTag);
    });
});
