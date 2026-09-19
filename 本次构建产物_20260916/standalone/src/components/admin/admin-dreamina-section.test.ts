import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { dreaminaModelGroup } from "./admin-dreamina-section";

describe("Dreamina CLI admin section", () => {
    it("groups the documented image, video, and upscale capabilities", () => {
        expect(dreaminaModelGroup({ id: "seedream", upstreamModel: "seedream-5", displayName: "Seedream", command: "seedream", capability: "image" })).toBe("Seedream");
        expect(dreaminaModelGroup({ id: "seedance", upstreamModel: "seedance-2", displayName: "Seedance", command: "seedance", capability: "video" })).toBe("Seedance");
        expect(dreaminaModelGroup({ id: "image-upscale", upstreamModel: "image_upscale", displayName: "图片超清", command: "image_upscale", capability: "image" })).toBe("图片超清");
    });

    it("keeps account/model and request logs as the only tabs without a paid test action", () => {
        const source = readFileSync(new URL("./admin-dreamina-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('{ key: "overview", label: "账号与模型" }');
        expect(source).toContain("请求日志");
        expect(source).toContain("saveDreaminaModels");
        expect(source).toContain("官方 credit_count");
        expect(source).toContain('{ value: "all", label: "总计" }');
        expect(source).toContain('{ value: "week", label: "本周" }');
        expect(source).toContain('{ value: "month", label: "本月" }');
        expect(source).toContain('{ value: "year", label: "本年" }');
        expect(source).toContain('aria-label="积分统计时间范围"');
        expect(source).toContain("stats?.officialCredits");
        expect(source).toContain("每个提交 ID 只保留一条任务生命周期日志");
        expect(source).toContain("任务成功时间");
        expect(source).toContain("任务失败时间");
        expect(source).toContain("提交返回值");
        expect(source).toContain("成功返回值");
        expect(source).toContain("失败返回值");
        expect(source).not.toContain("文本实测");
    });
});
