// Explicit, local Docker acceptance harness. Uses only a disposable database and a local AI Studio fixture.
import { constants } from "node:fs";
import { chmod, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const packageDirectory = process.argv[2];
if (!packageDirectory) throw new Error("Pass the completed private package directory");
const directory = await mkdtemp("/private/tmp/octal-private-acceptance-");
await chmod(directory, 0o700);
await cp(path.resolve(packageDirectory), directory, { recursive: true, mode: constants.COPYFILE_FICLONE });
await writeFile(
    path.join(directory, ".env"),
    ["COMPOSE_PROJECT_NAME=octal-private-acceptance", "PORT=8866", "DATABASE_URL=postgres://migration_test:migration_fixture_only@127.0.0.1:55439/migration_docker", "NEXT_PUBLIC_SITE_URL=http://127.0.0.1:8866"].join("\n") + "\n",
    { mode: 0o600 },
);
console.log(`Acceptance workspace: ${directory}`);
execFileSync("docker", ["exec", "octal-migration-test-pg-20260908", "createdb", "-U", "migration_test", "migration_docker"], { stdio: "inherit" });
// Do not warm up real Google accounts during deployment tests. Use the unchanged
// provider image, but replace its API command only in this disposable test copy.
const composeName = "docker-compose.offline-external-db.yml";
const compose = parse(await readFile(path.join(directory, composeName), "utf8"));
compose.services.geminiai.command = [
    "python",
    "-c",
    "from http.server import HTTPServer,BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'{}')\nHTTPServer(('127.0.0.1',8080),Handler).serve_forever()",
];
const composeText = stringify(compose);
await writeFile(path.join(directory, composeName), composeText);
const sum = createHash("sha256").update(composeText).digest("hex");
const sums = (await readFile(path.join(directory, "SHA256SUMS"), "utf8"))
    .split("\n")
    .map((line) => (line.endsWith(`  ${composeName}`) ? `${sum}  ${composeName}` : line))
    .join("\n");
await writeFile(path.join(directory, "SHA256SUMS"), sums);
for (const pass of ["initial", "repeat"]) {
    console.log(`Deployment pass: ${pass}`);
    const child = spawn(
        "docker",
        [
            "run",
            "--rm",
            "--network",
            "host",
            "-e",
            "OCTALAICANVAS_ALLOW_PLATFORM_EMULATION=1",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "-v",
            `${directory}:${directory}`,
            "-w",
            directory,
            "docker:cli",
            "sh",
            "-c",
            "apk add --no-cache bash >/dev/null && bash ./一键部署.sh",
        ],
        { cwd: project, stdio: "inherit" },
    );
    const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
    if (status !== 0) throw new Error(`Deployment acceptance failed: ${pass}`);
}
console.log("Initial and repeat private deployments passed. Test services remain available for browser checks.");
