import type { CanvasAssistantSession } from "../types";
import type { CreativeAgentRun } from "@/services/api/creative";
import type { CanvasAgentRunStage } from "./canvas-agent-progress";

export type CanvasAssistantRunState = {
    runId?: string;
    assistantMessageId: string;
    paused: boolean;
    stage: CanvasAgentRunStage;
    startedAt?: number;
    completedAt?: number;
    tasks?: CreativeAgentRun["tasks"];
    status?: Extract<CreativeAgentRun["status"], "completed" | "failed" | "cancelled">;
};

export type CanvasAssistantRunStates = Record<string, CanvasAssistantRunState[]>;

export function setCanvasAssistantRun(states: CanvasAssistantRunStates, sessionId: string, run: CanvasAssistantRunState) {
    const current = states[sessionId] || [];
    const index = current.findIndex((item) => sameCanvasAssistantRun(item, run));
    const next = index < 0 ? [...current, run] : current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...run, ...(run.status ? {} : { status: undefined, completedAt: undefined }) } : item));
    return { ...states, [sessionId]: next };
}

export function patchCanvasAssistantRun(states: CanvasAssistantRunStates, sessionId: string, runId: string, patch: Partial<CanvasAssistantRunState>) {
    const current = states[sessionId];
    const index = current?.findIndex((item) => item.runId === runId) ?? -1;
    return index < 0 || !current ? states : { ...states, [sessionId]: current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) };
}

export function clearCanvasAssistantRun(states: CanvasAssistantRunStates, sessionId: string, identity: string) {
    const current = states[sessionId];
    const remaining = current?.filter((item) => (item.runId !== identity && item.assistantMessageId !== identity) || Boolean(item.status));
    if (!current || !remaining || remaining.length === current.length) return states;
    if (remaining.length) return { ...states, [sessionId]: remaining };
    const nextStates = { ...states };
    delete nextStates[sessionId];
    return nextStates;
}

export function canvasAssistantRunsForSession(states: CanvasAssistantRunStates, sessionId?: string | null) {
    return sessionId ? states[sessionId] || [] : [];
}

export function activeCanvasAssistantRun(states: CanvasAssistantRunStates, sessionId?: string | null) {
    return [...canvasAssistantRunsForSession(states, sessionId)].reverse().find((item) => !item.status);
}

export function terminalCanvasAssistantRuns(states: CanvasAssistantRunStates, sessionId?: string | null) {
    return canvasAssistantRunsForSession(states, sessionId).filter((item) => Boolean(item.status));
}

export function hasActiveCanvasAssistantRun(states: CanvasAssistantRunStates, sessionId?: string | null) {
    return Boolean(activeCanvasAssistantRun(states, sessionId));
}

export function findCanvasAssistantRunSession(sessions: CanvasAssistantSession[], runId: string, conversationId?: string) {
    return sessions.find((session) => session.messages.some((item) => item.runId === runId)) || (conversationId ? sessions.find((session) => session.conversationId === conversationId) : undefined);
}

function sameCanvasAssistantRun(current: CanvasAssistantRunState, next: CanvasAssistantRunState) {
    if (current.runId && next.runId) return current.runId === next.runId;
    return current.assistantMessageId === next.assistantMessageId;
}
