import { describe, expect, it } from "vitest";

import { safeRandomUUID } from "./uuid";

describe("safeRandomUUID", () => {
    it("returns a valid UUID v4 in every environment", () => {
        for (let index = 0; index < 50; index += 1) {
            expect(safeRandomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        }
    });

    it("does not return the same value twice", () => {
        expect(safeRandomUUID()).not.toBe(safeRandomUUID());
    });

    it("falls back to getRandomValues when randomUUID is missing", () => {
        const original = globalThis.crypto;
        Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (bytes: Uint8Array) => original.getRandomValues(bytes) }, configurable: true });
        try {
            expect(safeRandomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        } finally {
            Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
        }
    });
});
