import { describe, expect, it } from "vitest";

import { creativeComposerToolButtonClass } from "@/components/creative-composer-styles";

describe("creativeComposerToolButtonClass", () => {
    it("only keeps the active palette while its popover is open", () => {
        const closedClass = creativeComposerToolButtonClass(false);
        const openClass = creativeComposerToolButtonClass(true);

        expect(closedClass).toContain("!bg-[#f4f8ff]");
        expect(closedClass).not.toContain("!bg-[#eef0ff]");
        expect(closedClass).toContain("focus:!bg-[#f4f8ff]");
        expect(closedClass).toContain("active:!bg-[#f4f8ff]");
        expect(openClass).toContain("!bg-[#eef0ff]");
        expect(openClass).toContain("focus:!bg-[#eef0ff]");
        expect(openClass).toContain("active:!bg-[#eef0ff]");
    });
});
