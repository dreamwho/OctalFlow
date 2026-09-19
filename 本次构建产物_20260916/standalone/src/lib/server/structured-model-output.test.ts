import { describe, expect, it } from "vitest";

import { strictJsonObjectText } from "./structured-model-output";

describe("strictJsonObjectText", () => {
    it("accepts plain or fenced JSON objects", () => {
        expect(strictJsonObjectText('{"ok":true}')).toBe('{"ok":true}');
        expect(strictJsonObjectText('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    });

    it("repairs an otherwise isolated model JSON object", () => {
        expect(strictJsonObjectText('{"shots":[{"shotId":"shot-one",}],}')).toBe('{"shots":[{"shotId":"shot-one"}]}');
        expect(strictJsonObjectText('{"prompt":"第一行\n第二行"}')).toBe('{"prompt":"第一行\\n第二行"}');
    });

    it("rejects prose and JSON arrays", () => {
        expect(strictJsonObjectText('Use this plan: {"ok":true}')).toBe("");
        expect(strictJsonObjectText("[]")).toBe("");
        expect(strictJsonObjectText('{"ok":')).toBe("");
    });
});
