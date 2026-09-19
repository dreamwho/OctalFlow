import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["src/lib/server/local-data-migration-cli.ts"],
    outfile: "scripts/local-data-migration.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["sharp", "pg-native"],
    banner: { js: 'import { createRequire as migrationCreateRequire } from "node:module"; const require = migrationCreateRequire(import.meta.url);' },
    logLevel: "warning",
});
