import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), getAuthSettings: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings }));

import { GET } from "./route";

const skills = [
    skill("image-only", "图片单节点", ["image", "canvas"], ["image"]),
    skill("local-realistic-image", "真人感出图", ["image", "canvas"], []),
    skill("video-only", "视频单节点", ["video", "canvas"], ["video"]),
    skill("combo", "组合导演", ["image", "video", "canvas", "drama"], []),
    skill("ecommerce-image", "电商生图", ["image", "canvas"], []),
    skill("disabled", "已停用", ["image"], ["image"], false),
];

describe("GET /api/agent/skills", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one", role: "user" });
        mocks.getAuthSettings.mockResolvedValue({ agentSkills: skills });
    });

    it("returns only pure image skills to an image node", async () => {
        const response = await GET(new Request("http://localhost/api/agent/skills?workspace=all&nodeMode=image"));
        const payload = await response.json();

        expect(payload.data.skills.map((item: { name: string }) => item.name)).toEqual(["图片单节点", "真人感出图"]);
    });

    it("returns only pure video skills to a video node while preserving combined skills for Agent", async () => {
        const videoResponse = await GET(new Request("http://localhost/api/agent/skills?workspace=all&nodeMode=video"));
        const agentResponse = await GET(new Request("http://localhost/api/agent/skills?workspace=all"));
        const videoPayload = await videoResponse.json();
        const agentPayload = await agentResponse.json();

        expect(videoPayload.data.skills.map((item: { name: string }) => item.name)).toEqual(["视频单节点"]);
        expect(agentPayload.data.skills.map((item: { name: string }) => item.name)).toEqual(["图片单节点", "真人感出图", "视频单节点", "组合导演", "电商生图"]);
    });

    it("keeps safe workflow metadata public while withholding execution instructions", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            agentSkills: [
                {
                    ...skill("h3", "手绘实拍融合", ["video"], ["video"]),
                    modelConstraints: { capability: "video", requiredModelFamilies: ["minimax-h3"] },
                    requiredAssetRoles: [{ id: "scene-reference", label: "场景参考", required: false, acceptedAssetTypes: ["image"] }],
                    stages: [{ id: "generation", label: "视频生成", description: "生成连续镜头" }],
                },
            ],
        });

        const response = await GET(new Request("http://localhost/api/agent/skills?workspace=video"));
        const payload = await response.json();

        expect(payload.data.skills[0]).toMatchObject({
            modelConstraints: { requiredModelFamilies: ["minimax-h3"] },
            requiredAssetRoles: [{ id: "scene-reference" }],
            stages: [{ id: "generation" }],
        });
        expect(payload.data.skills[0].instructions).toBeUndefined();
    });
});

function skill(id: string, name: string, workspaces: Array<"image" | "video" | "canvas" | "drama">, nodeModes: Array<"image" | "video">, enabled = true) {
    return { id, name, description: `${name}说明`, instructions: `${name}规则`, enabled, keywords: [], workspaces, nodeModes };
}
