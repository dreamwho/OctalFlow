import { describe, expect, it } from "vitest";

import { normalizeGenerationDefaults } from "@/lib/auth/store-normalizers";
import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";

describe("生成媒体下载出网方式设置", () => {
    it("默认跟随服务器代理，保持历史行为", () => {
        expect(DEFAULT_SETTINGS.generationDefaults.mediaDownloadEgress).toBe("server-proxy");
        expect(normalizeGenerationDefaults(undefined).mediaDownloadEgress).toBe("server-proxy");
    });

    it("接受 direct 并拒绝未知取值", () => {
        expect(normalizeGenerationDefaults({ mediaDownloadEgress: "direct" }).mediaDownloadEgress).toBe("direct");
        expect(normalizeGenerationDefaults({ mediaDownloadEgress: "server-proxy" }).mediaDownloadEgress).toBe("server-proxy");
        expect(normalizeGenerationDefaults({ mediaDownloadEgress: "garbage" as never }).mediaDownloadEgress).toBe("server-proxy");
    });
});
