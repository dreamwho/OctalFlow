import { describe, expect, it } from "vitest";

import { parseDolaCookieHeader, parseDolaImportInputs, splitDolaCookieFile } from "./account-import";

describe("Dola Cookie import", () => {
    it("keeps semicolons inside one account and removes an optional header prefix", () => {
        const parsed = parseDolaCookieHeader("Cookie: sid=abc; token=def");
        expect(parsed.cookie).toBe("sid=abc; token=def");
        expect(parsed.fingerprintInput).toContain("sid=abc");
    });
    it("supports one file with multiple accounts and mixed inputs", () => {
        expect(splitDolaCookieFile("sid=a\n\nsid=b", "105.txt")).toHaveLength(2);
        const result = parseDolaImportInputs([{ cookie: "sid=a", sourceFileName: "one.txt", sourceOrdinal: 1 }, { cookie: "invalid", sourceFileName: "two.txt", sourceOrdinal: 1 }]);
        expect(result[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(result[1]?.error).toBeTruthy();
    });
});
