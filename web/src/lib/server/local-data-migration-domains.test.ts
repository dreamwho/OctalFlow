import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "@/lib/server/database";

import { importMigrationDomains } from "./local-data-migration-domains";

const createdAt = "2026-09-08T00:00:00.000Z";
const updatedAt = "2026-09-08T00:01:00.000Z";

describe("importMigrationDomains", () => {
    it("maps every scoped FILE-provider domain without mutating the supplied snapshot", async () => {
        const files = fixture();
        const before = structuredClone(files);
        const query = vi.fn().mockResolvedValue({ rows: [] });

        const counts = await importMigrationDomains({ query } as unknown as QueryExecutor, files);

        expect(counts).toEqual({
            canvasProjects: 1,
            creativeConversations: 1,
            creativeMessages: 1,
            creativeAssets: 2,
            creativeRunEvents: 1,
            dramaProjects: 1,
            dramaProjectVersions: 1,
            libraryAssets: 1,
            localMediaAssets: 1,
            auditLogs: 1,
        });
        expect(files).toEqual(before);

        const statements = query.mock.calls.map(([statement]) => String(statement));
        for (const table of [
            "canvas_projects",
            "creative_conversations",
            "creative_messages",
            "creative_assets",
            "creative_run_events",
            "drama_projects",
            "drama_project_versions",
            "library_assets",
            "local_media_assets",
            "audit_logs",
        ]) {
            expect(statements.some((statement) => statement.includes(`INSERT INTO ${table}`))).toBe(true);
        }
        expect(statements.some((statement) => statement.startsWith("UPDATE creative_assets SET parent_asset_id"))).toBe(true);
        expect(statements.some((statement) => statement.includes("setval(pg_get_serial_sequence"))).toBe(true);
        expect(statements.some((statement) => /\b(?:DELETE|TRUNCATE)\b/.test(statement))).toBe(false);

        const localMediaCall = query.mock.calls.find(([statement]) => String(statement).includes("INSERT INTO local_media_assets"));
        expect(localMediaCall?.[1]).toContain("object");
        expect(localMediaCall?.[1]).toContain("external-key");

        const auditCall = query.mock.calls.find(([statement]) => String(statement).includes("INSERT INTO audit_logs"));
        expect(auditCall?.[1]).toContain(JSON.stringify({ ciphertext: "octalaicanvas-secret:v1:fixture" }));
    });
});

function fixture(): Record<string, unknown> {
    return {
        "canvas-projects.json": {
            version: 1,
            projects: [{ userId: "user-1", project: { id: "canvas-1", title: "Canvas", createdAt, updatedAt, nodes: [], connections: [], opaque: { preserved: true } } }],
        },
        "creative-runtime.json": {
            version: 1,
            nextEventId: 8,
            conversations: [
                {
                    id: "conversation-1",
                    userId: "user-1",
                    surface: "chat",
                    source: "agent",
                    title: "Conversation",
                    status: "active",
                    contextSummary: "",
                    contextSummaryThroughSequence: 0,
                    createdAt: 1_725_753_600_000,
                    updatedAt: 1_725_753_660_000,
                    lastMessageAt: 1_725_753_660_000,
                },
            ],
            messages: [
                {
                    id: "message-1",
                    conversationId: "conversation-1",
                    sequence: 1,
                    role: "user",
                    status: "completed",
                    content: "fixture",
                    metadata: { public: true },
                    createdAt: 1_725_753_600_000,
                    updatedAt: 1_725_753_660_000,
                },
            ],
            assets: [
                {
                    id: "asset-parent",
                    userId: "user-1",
                    conversationId: "conversation-1",
                    ordinal: 1,
                    type: "image",
                    status: "ready",
                    title: "Parent asset",
                    metadata: {},
                    createdAt: 1_725_753_600_000,
                    updatedAt: 1_725_753_660_000,
                },
                {
                    id: "asset-1",
                    userId: "user-1",
                    conversationId: "conversation-1",
                    messageId: "message-1",
                    sourceRunId: "run-1",
                    sourceTaskId: "task-1",
                    parentAssetId: "asset-parent",
                    ordinal: 0,
                    type: "image",
                    status: "ready",
                    title: "Asset",
                    storageKind: "object",
                    storageKey: "asset-key",
                    mimeType: "image/png",
                    width: 10,
                    height: 20,
                    bytes: 30,
                    metadata: { preserved: true },
                    createdAt: 1_725_753_600_000,
                    updatedAt: 1_725_753_660_000,
                },
            ],
            events: [{ id: "7", runId: "run-1", type: "run.completed", data: { preserved: true }, createdAt: 1_725_753_660_000 }],
        },
        "drama-projects.json": {
            version: 1,
            projects: [{ userId: "user-1", project: { id: "drama-1", title: "Drama", status: "active", createdAt, updatedAt, episodes: [] } }],
        },
        "drama-project-versions.json": {
            version: 1,
            items: [{ id: "drama-version-1", projectId: "drama-1", userId: "user-1", version: 1, reason: "fixture", snapshot: { id: "drama-1" }, createdAt }],
        },
        "library-assets.json": {
            version: 1,
            assets: [{ userId: "user-1", asset: { id: "library-1", kind: "image", title: "Library", createdAt, updatedAt, tags: [], data: { mimeType: "image/png" } } }],
        },
        "local-media-assets.json": {
            version: 1,
            assets: [
                {
                    storageKey: "media-1",
                    scope: "generation",
                    storageClass: "permanent",
                    type: "image",
                    ownerUserId: "user-1",
                    source: "fixture",
                    mimeType: "image/png",
                    bytes: 12,
                    storageProvider: "object",
                    externalStorageId: "storage-1",
                    externalObjectKey: "external-key",
                    externalSyncedAt: updatedAt,
                    createdAt,
                },
            ],
        },
        "audit-logs.json": {
            version: 1,
            logs: [
                {
                    id: "audit-1",
                    action: "fixture.action",
                    status: "success",
                    actor: { id: "user-1", username: "fixture", role: "admin", ip: "127.0.0.1", userAgent: "vitest" },
                    target: { type: "fixture", id: "target-1", label: "Target" },
                    metadata: { ciphertext: "octalaicanvas-secret:v1:fixture" },
                    createdAt,
                },
            ],
        },
    };
}
