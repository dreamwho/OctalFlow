// Invoked with: node -e "$(cat this-file)" /app/web IMAGE_ID < manifest.json
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = process.argv[1];
const imageId = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
if (!path.isAbsolute(root || "") || manifest.schemaVersion !== 1 || !manifest.buildId || !manifest.imageId || !manifest.files || Array.isArray(manifest.files) || !Object.keys(manifest.files).length) throw new Error("运行基线清单无效");
const changedFiles = [];
const missingFiles = [];
let matchedFiles = 0;
for (const [relative, expected] of Object.entries(manifest.files)) {
    if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("运行基线清单包含无效文件或哈希");
    try {
        const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
        if (actual === expected) matchedFiles += 1;
        else changedFiles.push(relative);
    } catch (error) {
        if (error.code === "ENOENT") missingFiles.push(relative);
        else throw error;
    }
}
const buildId = fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8").trim();
const report = { buildId, expectedBuildId: manifest.buildId, imageMatches: imageId === manifest.imageId, expectedFiles: Object.keys(manifest.files).length, matchedFiles, changedFiles, missingFiles };
console.log(JSON.stringify(report, null, 2));
if (buildId !== manifest.buildId || imageId !== manifest.imageId || changedFiles.length || missingFiles.length) process.exitCode = 1;
