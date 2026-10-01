import { describe, expect, it } from "vitest";
import { readHomeLogin } from "./home-login";

describe("home login destination", () => {
    it("preserves the protected destination and already-decoded OAuth error", () => {
        expect(readHomeLogin({ next: ["/admin?section=dolaApi", "/canvas"], error: "微信登录失败：授权已过期" })).toEqual({ nextPath: "/admin?section=dolaApi", authError: "微信登录失败：授权已过期" });
    });
    it.each([undefined, "https://example.com", "//example.com", "/\\example.com", "/login?next=/admin", "/admin\n"])('rejects unsafe or looping destination %s', (next) => {
        expect(readHomeLogin({ next }).nextPath).toBe("/create");
    });
});
