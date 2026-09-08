import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { restorePrivateFiles, verifyPrivateSnapshot } from "./restore-private-files.mjs";

const roots = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "octal-private-restore-"));
    roots.push(root);
    const directory = path.join(root, "snapshot");
    const files = { "private.env": "OCTALAICANVAS_ENCRYPTION_KEY='fixture'", "data/auth.json": "{}", "data/generation-assets/a.png": "image", "geminiai-accounts/account.json": "{}" };
    const manifest = { version: 1, id: "fixture", files: [] };
    for (const [name, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), content);
        manifest.files.push({ path: name, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
    }
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    return { root, directory, manifest, dataDirectory: path.join(root, "data"), accountsDirectory: path.join(root, "accounts"), ownership: false };
}
it("verifies checksums, restores media and provider state, and supports identical reruns", async () => {
    const input = await fixture();
    expect((await verifyPrivateSnapshot(input.directory)).id).toBe("fixture");
    expect(await restorePrivateFiles(input)).toEqual({ copiedFiles: 2 });
    expect(await restorePrivateFiles(input)).toEqual({ copiedFiles: 2 });
    expect(await readFile(path.join(input.dataDirectory, "generation-assets/a.png"), "utf8")).toBe("image");
    await expect(readFile(path.join(input.dataDirectory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses changed checksums and undeclared files", async () => {
    const input = await fixture();
    await writeFile(path.join(input.directory, "unexpected"), "x");
    await expect(verifyPrivateSnapshot(input.directory)).rejects.toThrow("未登记");
    await rm(path.join(input.directory, "unexpected"));
    await writeFile(path.join(input.directory, "data/auth.json"), "tampered");
    await expect(verifyPrivateSnapshot(input.directory)).rejects.toThrow("校验失败");
});
it("refuses target conflicts before copying other files", async () => {
    const input = await fixture();
    await mkdir(input.accountsDirectory);
    await writeFile(path.join(input.accountsDirectory, "account.json"), "keep");
    await expect(restorePrivateFiles(input)).rejects.toThrow("未覆盖");
    await expect(readFile(path.join(input.dataDirectory, "generation-assets/a.png"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects source and target symlinks", async () => {
    const input = await fixture();
    await mkdir(input.dataDirectory);
    await symlink(input.root, path.join(input.dataDirectory, "generation-assets"));
    await expect(restorePrivateFiles(input)).rejects.toThrow("符号链接");
    await symlink(input.root, path.join(input.directory, "escape"));
    await expect(verifyPrivateSnapshot(input.directory)).rejects.toThrow("符号链接");
});
