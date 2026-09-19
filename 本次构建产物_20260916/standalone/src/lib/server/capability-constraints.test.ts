import { describe, expect, it } from "vitest";

import { assertCapabilityConstraints } from "./capability-constraints";

describe("capability constraints", () => {
    it("rejects unsupported reference count, duration, batch and ratio", () => {
        const profile = { maxReferenceImages: 2, maxDurationSeconds: 8, maxBatchSize: 2, aspectRatios: ["16:9"], qualityOptions: ["720p"] };
        expect(() => assertCapabilityConstraints(profile, { capability: "video", referenceCount: 3 })).toThrow("最多支持 2 张参考图");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", durationSeconds: 9 })).toThrow("最长视频时长");
        expect(() => assertCapabilityConstraints(profile, { capability: "image", batchSize: 3 })).toThrow("批量生成");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", aspectRatio: "9:16" })).toThrow("不支持 9:16 比例");
        expect(() => assertCapabilityConstraints(profile, { capability: "video", quality: "1080p" })).toThrow("不支持 1080p 清晰度");
    });
});
