import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { visibleGeminiToolsQuotas } from "./admin-gemini-tools-section";

describe("visibleGeminiToolsQuotas", () => {
    it("keeps only three quotas and prioritizes recently active models", () => {
        const quotas = [
            { model: "model-a", displayName: "A", remainingPercent: 90 },
            { model: "model-b", displayName: "B", remainingPercent: 80 },
            { model: "model-c", displayName: "C", remainingPercent: 70 },
            { model: "model-d", displayName: "D", remainingPercent: 60 },
        ];
        expect(visibleGeminiToolsQuotas(quotas, ["model-d", "model-b"]).map((quota) => quota.model)).toEqual(["model-d", "model-b", "model-a"]);
    });

    it("keeps request logs in a dedicated tab and loads them when selected", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain('useState<"overview" | "logs">("overview")');
        expect(source).toContain('{ key: "overview", label: "账号与渠道" }');
        expect(source).toContain('if (next === "logs") void loadLogs()');
        expect(source).toContain('activeTab === "logs" ? (');
    });

    it("opens a detail drawer when a request log row is clicked", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("selectedLog");
        expect(source).toContain("onClick={() => setSelectedLog(log)}");
        expect(source).toContain('title="请求日志详情"');
        expect(source).toContain("requestPreview");
        expect(source).toContain("responsePreview");
    });

    it("offers explicit latest-model fetch and opt-in enable actions while marking unavailable saved choices", () => {
        const source = readFileSync(new URL("./admin-gemini-tools-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("syncGeminiToolsModels");
        expect(source).toContain("获取最新模型");
        expect(source).toContain("获取并启用新模型");
        expect(source).toContain("当前渠道选择未改动");
        expect(source).toContain("上游当前未返回");
        expect(source).toContain("filter((model) => model.available)");
        expect(source).toContain("const availableModels = useMemo");
        expect(source).toContain("disabled={!availableModels.length}");
        expect(source).toContain("value={String(availableModels.length)}");
    });
});
