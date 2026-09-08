import { describe, expect, it } from "vitest";

import type { CanvasAssistantSession } from "../types";
import { activeCanvasAssistantRun, clearCanvasAssistantRun, findCanvasAssistantRunSession, patchCanvasAssistantRun, setCanvasAssistantRun, terminalCanvasAssistantRuns } from "./canvas-assistant-run-state";

const planning = { key: "planning" as const, text: "正在规划" };

describe("Canvas assistant run state", () => {
    it("keeps independent runs bound to their own local sessions", () => {
        const first = setCanvasAssistantRun({}, "session-one", { runId: "run-one", assistantMessageId: "message-one", paused: false, stage: planning });
        const second = setCanvasAssistantRun(first, "session-two", { runId: "run-two", assistantMessageId: "message-two", paused: true, stage: { key: "paused", text: "已暂停" } });

        expect(activeCanvasAssistantRun(second, "session-one")?.runId).toBe("run-one");
        expect(activeCanvasAssistantRun(second, "session-two")?.runId).toBe("run-two");
        expect(activeCanvasAssistantRun(patchCanvasAssistantRun(second, "session-one", "run-one", { paused: true }), "session-one")?.paused).toBe(true);
        expect(clearCanvasAssistantRun(second, "session-one", "run-one")).toEqual({ "session-two": second["session-two"] });
    });

    it("does not let a late watcher clear a newer run in the same session", () => {
        const current = setCanvasAssistantRun({}, "session", { runId: "new-run", assistantMessageId: "new-message", paused: false, stage: planning });
        expect(clearCanvasAssistantRun(current, "session", "old-run")).toBe(current);
        expect(patchCanvasAssistantRun(current, "session", "old-run", { paused: true })).toBe(current);
    });

    it("retains completed, failed and cancelled runs by stable run id in one conversation", () => {
        const first = setCanvasAssistantRun({}, "session", { runId: "completed", assistantMessageId: "message-one", paused: false, stage: planning, status: "completed" });
        const second = setCanvasAssistantRun(first, "session", { runId: "failed", assistantMessageId: "message-two", paused: false, stage: planning, status: "failed", tasks: [{ id: "task", title: "分镜", status: "failed", error: "失败原因" }] });
        const third = setCanvasAssistantRun(second, "session", { runId: "cancelled", assistantMessageId: "message-three", paused: false, stage: planning, status: "cancelled" });

        expect(terminalCanvasAssistantRuns(third, "session").map((run) => run.runId)).toEqual(["completed", "failed", "cancelled"]);
        expect(clearCanvasAssistantRun(third, "session", "failed")).toBe(third);
    });

    it("reopens a retained failed run for a retry without dropping the other terminal records", () => {
        const failed = setCanvasAssistantRun({}, "session", { runId: "failed", assistantMessageId: "message-one", paused: false, stage: planning, status: "failed" });
        const completed = setCanvasAssistantRun(failed, "session", { runId: "completed", assistantMessageId: "message-two", paused: false, stage: planning, status: "completed" });
        const retrying = setCanvasAssistantRun(completed, "session", { runId: "failed", assistantMessageId: "message-one", paused: false, stage: { key: "executing", text: "正在重试" } });

        expect(activeCanvasAssistantRun(retrying, "session")?.runId).toBe("failed");
        expect(terminalCanvasAssistantRuns(retrying, "session").map((run) => run.runId)).toEqual(["completed"]);
    });

    it("restores a run only through its persisted stable id", () => {
        const sessions = [
            { ...session("one", [{ id: "message-one", runId: "run-one", role: "assistant", text: "结果" }]), conversationId: "conversation-one" },
            { ...session("two", [{ id: "message-two", role: "assistant", text: "相同提示词" }]), conversationId: "conversation-two" },
        ];
        expect(findCanvasAssistantRunSession(sessions, "run-one")?.id).toBe("one");
        expect(findCanvasAssistantRunSession(sessions, "missing", "conversation-two")?.id).toBe("two");
        expect(findCanvasAssistantRunSession(sessions, "missing")).toBeUndefined();
    });
});

function session(id: string, messages: CanvasAssistantSession["messages"]): CanvasAssistantSession {
    return { id, title: id, messages, createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z" };
}
