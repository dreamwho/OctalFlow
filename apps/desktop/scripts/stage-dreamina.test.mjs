import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDreaminaTarget } from "./stage-dreamina.mjs";

test("official Dreamina CLI target selection is limited to supported desktop binaries", () => {
    assert.deepEqual(resolveDreaminaTarget("win32", "x64"), { filename: "dreamina_cli_windows_amd64.exe", executable: "dreamina.exe" });
    assert.deepEqual(resolveDreaminaTarget("darwin", "arm64"), { filename: "dreamina_cli_darwin_arm64", executable: "dreamina" });
    assert.deepEqual(resolveDreaminaTarget("darwin", "x64"), { filename: "dreamina_cli_darwin_amd64", executable: "dreamina" });
    assert.throws(() => resolveDreaminaTarget("win32", "arm64"), /不支持桌面目标平台/);
});

test("Dreamina staging records the release digest and rejects a wrong native executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dreamyo-stage-dreamina-"));
    const pe = Buffer.alloc(512);
    pe.write("MZ", 0);
    pe.writeUInt32LE(0x40, 0x3c);
    pe.write("PE\0\0", 0x40, "ascii");
    pe.writeUInt16LE(0x8664, 0x44);
    let calls = 0;
    const fetchImpl = async (url) => {
        calls += 1;
        if (url.endsWith("version.json")) return Response.json({ version: "1.4.18", release_date: "2026-09-10" });
        return new Response(pe);
    };
    try {
        const { stageDreamina } = await import("./stage-dreamina.mjs");
        const result = await stageDreamina({ platform: "win32", arch: "x64", outputRoot: root, fetchImpl });
        const manifest = JSON.parse(await readFile(path.join(root, "dreamina-release.json"), "utf8"));
        assert.equal(result.release.version, "1.4.18");
        assert.equal(manifest.sha256, result.release.sha256);
        assert.equal(calls, 2);

        await assert.rejects(stageDreamina({
            platform: "win32", arch: "x64", outputRoot: root,
            fetchImpl: async (url) => url.endsWith("version.json") ? Response.json({ version: "1.4.18" }) : new Response(Buffer.from("not a PE")),
        }), /架构不匹配/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
