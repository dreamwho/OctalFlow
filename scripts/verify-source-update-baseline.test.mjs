import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync as readSource } from "node:fs";
import test from "node:test";

const verifier = readSource(new URL("./verify-source-update-baseline.cjs", import.meta.url), "utf8");
const expectedImageId = "sha256:app-image-fixture";
const expectedBuildId = "fixture-build-2026";
const baselineContent = "export const ready = true;\n";

function digest(content) {
    return createHash("sha256").update(content).digest("hex");
}

function snapshotTree(root) {
    const result = new Map();
    const visit = (directory) => {
        for (const name of readdirSync(directory)) {
            const absolute = path.join(directory, name);
            const relative = path.relative(root, absolute);
            if (statSync(absolute).isDirectory()) visit(absolute);
            else result.set(relative, readFileSync(absolute));
        }
    };
    visit(root);
    return result;
}

function runScenario({ manifestChanges = {}, runtimeImageId = expectedImageId, codeChanges, omitCode = false } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "source-update-baseline-"));
    try {
        mkdirSync(path.join(root, ".next"), { recursive: true });
        writeFileSync(path.join(root, ".next/BUILD_ID"), `${expectedBuildId}\n`);
        mkdirSync(path.join(root, "server"), { recursive: true });
        if (!omitCode) writeFileSync(path.join(root, "server/runtime.js"), codeChanges ?? baselineContent);
        const manifest = {
            schemaVersion: 1,
            buildId: expectedBuildId,
            imageId: expectedImageId,
            files: { "server/runtime.js": digest(baselineContent) },
            ...manifestChanges,
        };
        const before = snapshotTree(root);
        const result = spawnSync(process.execPath, ["-e", verifier, root, runtimeImageId], {
            encoding: "utf8",
            input: JSON.stringify(manifest),
        });
        const after = snapshotTree(root);
        assert.deepEqual(after, before, "verifier must not modify any runtime files");
        return { result, rootFiles: [...after.keys()] };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("accepts matching image, Build ID and file hashes", () => {
    const { result } = runScenario();
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.imageMatches, true);
    assert.equal(report.buildId, expectedBuildId);
    assert.equal(report.expectedFiles, 1);
    assert.equal(report.matchedFiles, 1);
    assert.deepEqual(report.changedFiles, []);
    assert.deepEqual(report.missingFiles, []);
});

test("rejects changed source even when the Build ID still matches", () => {
    const { result } = runScenario({ codeChanges: "export const ready = false;\n" });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).changedFiles, ["server/runtime.js"]);
});

test("rejects missing source files", () => {
    const { result } = runScenario({ omitCode: true });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).missingFiles, ["server/runtime.js"]);
});

test("rejects an image ID mismatch", () => {
    const { result } = runScenario({ runtimeImageId: "sha256:other-image" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).imageMatches, false);
});

test("rejects a Build ID mismatch", () => {
    const { result } = runScenario({ manifestChanges: { buildId: "another-build" } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).expectedBuildId, "another-build");
});

test("rejects an empty file manifest", () => {
    const { result } = runScenario({ manifestChanges: { files: {} } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /运行基线清单无效/);
});

test("rejects directory traversal paths", () => {
    const { result } = runScenario({ manifestChanges: { files: { "../runtime.js": digest(baselineContent) } } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /运行基线清单包含无效文件或哈希/);
});

test("rejects non-SHA-256 digests", () => {
    const { result } = runScenario({ manifestChanges: { files: { "server/runtime.js": "abc123" } } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /运行基线清单包含无效文件或哈希/);
});
