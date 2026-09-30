import { describe, expect, it } from "vitest";
import { DEFAULT_GENERATION_PROMPT_RULES } from "@/lib/generation-prompt-rules";
import type { ImageTask } from "@/lib/server/image-task-store";
import { buildJsonImageEditBodies, buildResponsesImageBodies } from "./image-task-openai";
import { buildImageEditFormData } from "./image-task-support";

function task(): ImageTask {
    return { id: "prompt-test", userId: "user", kind: "edit", prompt: "换装", references: [{ dataUrl: "data:image/png;base64,aGVsbG8=" }], config: { apiFormat: "openai", baseUrl: "https://example.com", apiKey: "fixture", model: "test", promptRules: structuredClone(DEFAULT_GENERATION_PROMPT_RULES) } } as ImageTask;
}

describe("upstream image prompt rule payloads", () => {
    it("disables the prefix in multipart, Responses and JSON requests while retaining references", async () => {
        const input = task();
        input.config.promptRules!.imageReference.enabled = false;
        const form = await buildImageEditFormData(input, undefined, undefined, "http://localhost", "", "url");
        expect(form.get("prompt")).toBe("换装");
        expect(form.get("image")).toBeTruthy();
        const responses = buildResponsesImageBodies(input, "http://localhost");
        expect(responses[0].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "换装" }, { type: "input_image", image_url: input.references[0].dataUrl }] }]);
        const bodies = await buildJsonImageEditBodies(input, undefined, undefined, "url", "http://localhost", "http://localhost");
        expect(bodies.every((body) => body.prompt === "换装")).toBe(true);
    });
    it("uses the Sub2API override and generic rule once, preserving actual image_urls", async () => {
        const input = task();
        input.config.promptRules!.sub2ApiImageReference = { enabled: true, content: "沿用 {{referenceField}} 的脸，允许换装" };
        input.config.promptRules!.image = { enabled: true, content: "忠于用户要求" };
        const bodies = await buildJsonImageEditBodies(input, undefined, undefined, "url", "http://localhost", "http://localhost", false, true);
        expect(bodies[0]).toMatchObject({ prompt: "忠于用户要求\n\n沿用 image_urls[0] 的脸，允许换装\n\n换装", image_urls: [input.references[0].dataUrl] });
        input.config.promptRules!.sub2ApiImageReference.enabled = false;
        expect((await buildJsonImageEditBodies(input, undefined, undefined, "url", "http://localhost", "http://localhost", false, true))[0].prompt).toBe("忠于用户要求\n\n换装");
    });
});
