import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Canvas Agent panel default state", () => {
    it("keeps the panel closed until the user opens it", () => {
        const source = readFileSync(new URL("./use-canvas-generation-actions.tsx", import.meta.url), "utf8");

        expect(source).toContain("const assistantOpen = assistantMounted && !assistantCollapsed;");
        expect(source).toContain("const openAgent = () => {");
        expect(source).not.toContain("autoOpenedAgentRef.current = true");
        expect(source).not.toContain("setAssistantMounted(true);\n            setAssistantClosing(false);\n            setAssistantCollapsed(false);\n        }\n    }, [projectLoaded]);");
    });
});
