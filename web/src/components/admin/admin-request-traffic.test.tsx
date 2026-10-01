import { describe, expect, it } from "vitest";

import type { TrafficItem } from "@/lib/admin-traffic-types";
import { collectRequestIds, collectTaskIds, dedupeTrafficSummarySelections, getRequestTrafficSummary, getTaskTrafficSummary, selectRequestTaskTrafficSummary, trafficConnectionModeLabel, trafficEndpointLabel, trafficRequestId, trafficRoleLabel, trafficTaskId } from "./admin-request-traffic";

describe("admin request traffic identity helpers", () => {
    it("prefers persisted request identity and de-duplicates a visible page", () => {
        const values = [{ id: "log-1", requestId: "req-1" }, { id: "log-2", request_id: "req-2" }, { id: "req-1" }, { id: "" }];
        expect(trafficRequestId(values[0])).toBe("req-1");
        expect(trafficRequestId(values[1])).toBe("req-2");
        expect(collectRequestIds(values)).toEqual(["req-1", "req-2"]);
    });

    it("recognizes provider task fallback IDs without changing request IDs", () => {
        expect(trafficTaskId({ taskId: "upstream-1", serverTaskId: "stable-1" })).toBe("stable-1");
        expect(trafficTaskId({ server_task_id: "server-2" })).toBe("server-2");
        expect(trafficTaskId({ id: "log-1" })).toBe("");
    });

    it("keeps role, endpoint, and decimal unit values explicit", () => {
        expect(trafficRoleLabel("upload")).toBe("上传");
        expect(trafficRoleLabel("download")).toBe("下载");
        expect(trafficRoleLabel("query")).toBe("查询");
        expect(trafficConnectionModeLabel("magic")).toBe("魔法代理");
        expect(trafficConnectionModeLabel("unknown")).toBe("未标记");
        const item: TrafficItem = { channelId: "channel", channelName: "渠道", model: "model", protocol: "openai", connectionMode: "magic", role: "upload", address: "10.0.0.8", port: 18083, uploadBytes: 896, downloadBytes: 0, totalBytes: 896 };
        expect(trafficEndpointLabel(item)).toBe("10.0.0.8:18083");
    });

    it("indexes task groups by either request or task identity", () => {
        const summary = { requestId: "req-1", taskId: "task-1", uploadBytes: 1, downloadBytes: 2, totalBytes: 3, firstSeenAt: "", lastSeenAt: "", items: [] };
        expect(getRequestTrafficSummary([summary], "req-1")).toBe(summary);
        expect(getRequestTrafficSummary([summary], "task-1")).toBe(summary);
        expect(getRequestTrafficSummary([summary], "missing")).toBeUndefined();
    });

    it("finds a task group even when its generation slot has no protocol trace", () => {
        const taskSummary = { taskId: "dreamina-task", uploadBytes: 4, downloadBytes: 6, totalBytes: 10, firstSeenAt: "", lastSeenAt: "", items: [] };
        expect(collectTaskIds([{ serverTaskId: "dreamina-task" }])).toEqual(["dreamina-task"]);
        expect(getTaskTrafficSummary([taskSummary], "dreamina-task")).toBe(taskSummary);
        expect(selectRequestTaskTrafficSummary({ taskId: "dreamina-task", requestItems: [], taskItems: [taskSummary] })).toBe(taskSummary);
    });

    it("prefers the exact task group when a trace request ID is unmatched", () => {
        const requestFallback = { requestId: "gateway-request", uploadBytes: 1, downloadBytes: 1, totalBytes: 2, firstSeenAt: "", lastSeenAt: "", items: [] };
        const taskSummary = { requestId: "python-call", taskId: "stable-task", uploadBytes: 8, downloadBytes: 9, totalBytes: 17, firstSeenAt: "", lastSeenAt: "", items: [] };
        expect(selectRequestTaskTrafficSummary({ requestId: "gateway-request", taskId: "stable-task", requestItems: [requestFallback], taskItems: [taskSummary] })).toBe(taskSummary);
    });

    it("does not select a request group when an exact task group is available", () => {
        const requestSummary = { requestId: "request-1", taskId: "task-1", uploadBytes: 2, downloadBytes: 3, totalBytes: 5, firstSeenAt: "", lastSeenAt: "", items: [] };
        const taskSummary = { requestId: "request-1", taskId: "task-1", uploadBytes: 20, downloadBytes: 30, totalBytes: 50, firstSeenAt: "", lastSeenAt: "", items: [] };
        expect(selectRequestTaskTrafficSummary({ requestId: "request-1", taskId: "task-1", requestItems: [requestSummary], taskItems: [taskSummary] })).toBe(taskSummary);
    });

    it("deduplicates request and task selections into one task group", () => {
        const requestSummary = { requestId: "request-1", taskId: "task-1", uploadBytes: 2, downloadBytes: 3, totalBytes: 5, firstSeenAt: "", lastSeenAt: "", items: [] };
        const taskSummary = { requestId: "request-1", taskId: "task-1", uploadBytes: 20, downloadBytes: 30, totalBytes: 50, firstSeenAt: "", lastSeenAt: "", items: [] };
        expect(dedupeTrafficSummarySelections([{ requestId: "request-1", taskId: "task-1", summary: requestSummary }, { requestId: "request-1", taskId: "task-1", summary: taskSummary }])).toEqual([taskSummary]);
    });
});
