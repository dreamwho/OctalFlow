import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ image: vi.fn(), media: vi.fn() }));
vi.mock("@/services/image-storage", () => ({ getImageBlob: mocks.image }));
vi.mock("@/services/file-storage", () => ({ getMediaBlob: mocks.media }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

import { readZip } from "@/lib/zip";
import type { CanvasProject } from "@/lib/canvas-project-contract";
import { createCanvasExportZip } from "./canvas-export";

const project = { id: "canvas-one", title: "项目", nodes: [{ id: "node-one", metadata: { storageKey: "permanent/images/one" } }], connections: [], chatSessions: [] } as unknown as CanvasProject;

describe("cloud-ready canvas package", () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.image.mockResolvedValue(new Blob(["image"], { type: "image/png" })); });

    it("keeps the project and every persistent media file in the same ZIP", async () => {
        const zip = await readZip(await createCanvasExportZip([project]));
        const manifest = JSON.parse(await zip.get("projects.json")!.text());
        expect(manifest).toMatchObject({ app: "dreamyo-canvas", version: 3, projects: [{ project: { id: "canvas-one" }, files: [{ storageKey: "permanent/images/one", bytes: 5 }] }] });
        expect(await zip.get(manifest.projects[0].files[0].path)?.text()).toBe("image");
    });

    it("refuses an incomplete backup when a referenced media file is missing", async () => {
        mocks.image.mockResolvedValue(null);
        await expect(createCanvasExportZip([project])).rejects.toThrow("无法读取");
    });
});
