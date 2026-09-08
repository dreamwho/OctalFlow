import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("RunningHub admin navigation", () => {
    it("renders each tab icon exactly once through its label", () => {
        const source = readFileSync(new URL("./admin-runninghub-section.tsx", import.meta.url), "utf8");

        expect(source).toContain("<RunningHubTabLabel icon={CircleDollarSign}>账户统计</RunningHubTabLabel>");
        expect(source).toContain("<Tabs items={tabs} />");
        expect(source).not.toContain("{ ...tab, label:");
    });
});
