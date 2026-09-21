import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveEdition } from "../src/shared/edition.mjs";
import { prepareRuntime } from "./prepare-runtime.mjs";

const edition = resolveEdition(process.argv[2]);
const target = process.argv[3];
if (target !== "mac" && target !== "win") throw new Error("Build target must be mac or win");
if ((target === "win") !== (process.platform === "win32")) throw new Error("桌面安装包必须在目标系统原生构建，以匹配 Sharp、Provider 和浏览器二进制");
if (target === "mac" && process.platform !== "darwin") throw new Error("macOS 安装包必须在 macOS 构建");

const buildDir = path.resolve(import.meta.dirname, "../build");
await mkdir(buildDir, { recursive: true });
await writeFile(path.join(buildDir, "edition.json"), `${JSON.stringify({ edition: edition.id })}\n`, "utf8");
await prepareRuntime({ edition: edition.id });

const builder = path.resolve(import.meta.dirname, "../node_modules/.bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
const child = spawn(builder, [`--${target}`, "--config", "electron-builder.config.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, DREAMYO_DESKTOP_EDITION: edition.id },
    stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code || 0));
