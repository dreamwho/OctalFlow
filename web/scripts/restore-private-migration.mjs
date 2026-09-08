import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { restorePrivateFiles, verifyPrivateSnapshot } from "./restore-private-files.mjs";

try {
    const directory = process.env.OCTALAICANVAS_MIGRATION_DIR || "/migration";
    const manifest = await verifyPrivateSnapshot(directory);
    const privateEnv = parseEnv(await readFile(path.join(directory, "private.env"), "utf8"));
    if (!privateEnv.OCTALAICANVAS_ENCRYPTION_KEY || privateEnv.OCTALAICANVAS_ENCRYPTION_KEY !== process.env.OCTALAICANVAS_ENCRYPTION_KEY) throw new Error("迁移必须使用本地原加密密钥，当前部署密钥不一致");
    const cli = fileURLToPath(new URL("./local-data-migration.mjs", import.meta.url));
    const args = [cli, "--input", path.join(directory, "data"), "--source-id", manifest.id];
    // The CLI checks target emptiness and transactional receipt before any runtime file is copied.
    const preflightOutput = execFileSync(process.execPath, [...args, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const preflight = JSON.parse(preflightOutput.trim().split("\n").at(-1));
    if (preflight.status === "alreadyImported") {
        // Browser profiles and media may have legitimately changed since first deployment.
        console.log(JSON.stringify({ migration: "alreadyImported", counts: preflight.counts }));
    } else {
        const files = await restorePrivateFiles({ directory, manifest, dataDirectory: "/app/web/.data", accountsDirectory: "/migration-geminiai" });
        execFileSync(process.execPath, args, { stdio: "inherit" });
        console.log(JSON.stringify({ migration: "complete", ...files }));
    }
} catch (error) {
    // Avoid printing child process arguments, environment, or raw PostgreSQL errors.
    console.error(error?.status ? "数据导入未完成，服务不会启动，请检查上方脱敏诊断。" : error.message);
    process.exitCode = 1;
}
