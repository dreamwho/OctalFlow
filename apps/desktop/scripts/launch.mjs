import { spawn } from "node:child_process";
import path from "node:path";

import { resolveEdition } from "../src/shared/edition.mjs";

const edition = resolveEdition(process.argv[2]);
const electron = path.resolve(import.meta.dirname, "../node_modules/electron/cli.js");
const child = spawn(process.execPath, [electron, path.resolve(import.meta.dirname, "..")], {
    env: { ...process.env, DREAMYO_DESKTOP_EDITION: edition.id },
    stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code || 0));
