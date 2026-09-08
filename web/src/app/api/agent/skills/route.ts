import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";
import type { AgentSkillWorkspace } from "@/lib/auth/store-types";
import { agentSkillPromptHint, agentSkillPromptMode } from "@/lib/agent-skill-presentation";
import { agentSkillSupportsNodeMode } from "@/lib/agent-skill-node-policy";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const searchParams = new URL(request.url).searchParams;
    const workspace = searchParams.get("workspace") || "image";
    const requestedNodeMode = searchParams.get("nodeMode");
    const nodeMode = requestedNodeMode === "image" || requestedNodeMode === "video" ? requestedNodeMode : undefined;
    const settings = await getAuthSettings();
    const allWorkspaces = workspace === "all" || workspace === "chat";
    const skills = settings.agentSkills
        .filter((skill) => skill.enabled && (nodeMode ? agentSkillSupportsNodeMode(skill, nodeMode) : allWorkspaces || (skill.workspaces || ["image"]).includes(workspace as AgentSkillWorkspace)))
        .map(({ instructions: _instructions, ...skill }) => {
            const promptMode = agentSkillPromptMode(skill);
            return { ...skill, promptMode, promptHint: agentSkillPromptHint(skill, promptMode) };
        });
    return NextResponse.json({ code: 0, data: { skills }, msg: "OK" });
}
