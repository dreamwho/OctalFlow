import { describe, expect, it } from "vitest";

import { extractRunningHubResultUrls } from "./runninghub-service";

describe("RunningHub result contract", () => {
    it("collects and de-duplicates image URLs across supported response shapes", () => {
        expect(
            extractRunningHubResultUrls({
                output: "https://cdn.example.com/result-a.png",
                outputs: [{ fileUrl: "https://cdn.example.com/result-b.webp" }],
                images: ["https://cdn.example.com/result-a.png"],
                ignored: "not-a-url",
            }),
        ).toEqual(["https://cdn.example.com/result-a.png", "https://cdn.example.com/result-b.webp"]);
    });

    it("ignores non-http values", () => {
        expect(extractRunningHubResultUrls({ fileName: "input/reference.png", output: "data:image/png;base64,abc" })).toEqual([]);
    });
});
