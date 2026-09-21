import { describe, expect, it } from "vitest";

import { isDolaPublicRuntimePath, isDolaRuntimePath, validateDolaVideoRequest } from "./provider";
import { dolaProviderProxyMode } from "./proxy";

describe("Dola provider paths", () => {
    it("keeps internal account inspection out of the public gateway", () => {
        expect(isDolaRuntimePath("/v1/accounts/inspect")).toBe(true);
        expect(isDolaRuntimePath("/v1/accounts/verify")).toBe(true);
        expect(isDolaRuntimePath("/v1/verifications/dola-verification-1/open")).toBe(true);
        expect(isDolaPublicRuntimePath("/v1/accounts/inspect")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/accounts/verify")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/verifications/dola-verification-1/open")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/chat/completions")).toBe(false);
        expect(isDolaPublicRuntimePath("/v1/videos/task-1/content")).toBe(true);
    });

    it("accepts the two model duration contracts independently", () => {
        expect(validateDolaVideoRequest({ model: "dola-seedance-2-5", duration: 30, ratio: "21:9" }).profile.id).toBe("dola-seedance-2-5");
        expect(() => validateDolaVideoRequest({ model: "dola-seedance-2-0-fast", duration: 30, ratio: "16:9" })).toThrow(/仅支持/);
    });

    it("maps a generic proxy binding to the provider managed mode", () => {
        expect(dolaProviderProxyMode({ mode: "direct" })).toBe("direct");
        expect(dolaProviderProxyMode({ mode: "generic", target: "node:tw" })).toBe("managed");
        expect(dolaProviderProxyMode({ mode: "magic", nodeName: "Tokyo-01" })).toBe("managed");
        expect(dolaProviderProxyMode({ mode: "chained", nodeName: "jump ➔ landing" })).toBe("managed");
    });
});
