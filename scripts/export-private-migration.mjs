#!/usr/bin/env node

import { randomUUID, createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const FORMAT_VERSION = 1;
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_SOURCE = path.join(REPO_ROOT, "web", ".data");
const EXCLUDED_NAMES = new Set([
  ".DS_Store",
  "cache",
  "restore-backups",
  "RunningChromeVersion",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
]);
const PRIVATE_ENV_KEYS = [
  "OCTALAICANVAS_ENCRYPTION_KEY",
  "GEMINI_TOOLS_OAUTH_CLIENT_ID",
  "GEMINI_TOOLS_OAUTH_CLIENT_SECRET",
  "GEMINI_TOOLS_OAUTH_REDIRECT_URI",
];
const DREAMINA_RUNTIME_FILES = new Set([
  "version.json",
  "tasks.db",
  "tasks.db-wal",
  "tasks.db-shm",
]);
const DREAMINA_RUNTIME_DIRECTORIES = new Set(["dreamina", "logs", "locks"]);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.confirmOffline)
    throw new Error("请先停止 App 与 Worker，并在命令中加入 --confirm-offline");
  if (!options.output)
    throw new Error(
      "用法：node --env-file=web/.env.local scripts/export-private-migration.mjs --output <新目录> --confirm-offline [--source <测试目录>]",
    );

  const encryptionKey = process.env.OCTALAICANVAS_ENCRYPTION_KEY?.trim() || "";
  if (!encryptionKey)
    throw new Error(
      "缺少 OCTALAICANVAS_ENCRYPTION_KEY；请使用 node --env-file=web/.env.local 运行",
    );
  if (!isValidEncryptionKey(encryptionKey))
    throw new Error(
      "OCTALAICANVAS_ENCRYPTION_KEY 必须是 64 位十六进制或 32 字节 Base64",
    );

  const source = path.resolve(options.source || DEFAULT_SOURCE);
  const output = path.resolve(options.output);
  await assertDirectory(source, "源数据目录");
  assertOutside(source, output, "输出目录不能位于源数据目录内");
  await assertMissing(output);
  await ensureOutputParent(path.dirname(output));

  const sourceRealPath = await realpath(source);
  const outputParentRealPath = await realpath(path.dirname(output));
  const resolvedOutput = path.join(outputParentRealPath, path.basename(output));
  assertOutside(sourceRealPath, resolvedOutput, "输出目录不能位于源数据目录内");
  await assertMissing(output);

  let stagingDirectory = await mkdtemp(
    path.join(outputParentRealPath, ".private-migration-"),
  );
  try {
    await chmod(stagingDirectory, 0o700);
    const collector = new ManifestCollector(stagingDirectory);
    await copySourceSnapshot({ source, stagingDirectory, collector });
    await collector.writeText(
      "private.env",
      buildPrivateEnv(encryptionKey),
      "privateEnv",
    );

    const manifest = collector.manifest(`private-migration-${randomUUID()}`);
    await writePrivateText(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await assertMissing(output);
    await rename(stagingDirectory, output);
    stagingDirectory = "";
    await chmod(output, 0o700);
    process.stdout.write(
      `私有迁移快照已创建：${output}\n快照 ID：${manifest.id}\n已校验文件：${manifest.files.length}\n即梦登录态未导出：目标环境需要重新执行 dreamina login。\n`,
    );
  } finally {
    if (stagingDirectory)
      await rm(stagingDirectory, { force: true, recursive: true });
  }
}

class ManifestCollector {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.files = [];
  }

  async copy(source, relativeDestination, category) {
    const destination = resolveDestination(
      this.rootDirectory,
      relativeDestination,
    );
    await createPrivateDirectory(path.dirname(destination));
    const digest = await copyPrivateFile(source, destination);
    this.add(relativeDestination, digest, category);
  }

  async writeText(relativeDestination, content, category) {
    const destination = resolveDestination(
      this.rootDirectory,
      relativeDestination,
    );
    await createPrivateDirectory(path.dirname(destination));
    const digest = await writePrivateText(destination, content);
    this.add(relativeDestination, digest, category);
  }

  add(relativeDestination, digest, category) {
    if (!category) throw new Error("快照文件分类无效");
    this.files.push({
      path: toManifestPath(relativeDestination),
      size: digest.size,
      sha256: digest.sha256,
    });
  }

  manifest(id) {
    const files = [...this.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    return { version: FORMAT_VERSION, id, files };
  }
}

async function copySourceSnapshot({ source, stagingDirectory, collector }) {
  const dataDirectory = path.join(stagingDirectory, "data");
  await Promise.all([
    createPrivateDirectory(dataDirectory),
    createPrivateDirectory(path.join(dataDirectory, "reference-assets")),
    createPrivateDirectory(path.join(dataDirectory, "generation-assets")),
    createPrivateDirectory(path.join(dataDirectory, "dreamina")),
    createPrivateDirectory(path.join(stagingDirectory, "geminiai-accounts")),
  ]);
  let hasAuthJson = false;

  for (const entry of await safeEntries(source, "源数据目录")) {
    if (isExcluded(entry.name)) continue;
    const entryPath = path.join(source, entry.name);
    const details = await safeLstat(entryPath, `源数据目录中的 ${entry.name}`);

    if (details.isFile() && entry.name.endsWith(".json")) {
      await collector.copy(
        entryPath,
        path.posix.join("data", entry.name),
        "rootJson",
      );
      if (entry.name === "auth.json") hasAuthJson = true;
      continue;
    }
    if (!details.isDirectory())
      throw new Error(`源数据目录包含不支持的条目：${entry.name}`);

    if (entry.name === "reference-assets") {
      await copyTree({
        source: entryPath,
        destination: path.join(dataDirectory, entry.name),
        manifestPrefix: `data/${entry.name}`,
        collector,
        category: "referenceAssets",
      });
      continue;
    }
    if (entry.name === "generation-assets") {
      await copyTree({
        source: entryPath,
        destination: path.join(dataDirectory, entry.name),
        manifestPrefix: `data/${entry.name}`,
        collector,
        category: "generationAssets",
      });
      continue;
    }
    if (entry.name === "geminiai") {
      await copyGeminiAccounts(
        entryPath,
        path.join(stagingDirectory, "geminiai-accounts"),
        collector,
      );
      continue;
    }
    if (entry.name === "dreamina") {
      await validateDreaminaRuntimeState(entryPath);
      continue;
    }
    throw new Error(`源数据目录包含未知目录，拒绝遗漏：${entry.name}`);
  }
  if (!hasAuthJson)
    throw new Error("源数据目录缺少 auth.json，无法生成可恢复的迁移包");
}

async function copyGeminiAccounts(source, destination, collector) {
  for (const entry of await safeEntries(source, "GeminiAI 数据目录")) {
    if (isExcluded(entry.name)) continue;
    const entryPath = path.join(source, entry.name);
    const details = await safeLstat(
      entryPath,
      `GeminiAI 数据目录中的 ${entry.name}`,
    );
    if (entry.name !== "accounts" || !details.isDirectory())
      throw new Error(`GeminiAI 数据目录包含未知条目，拒绝遗漏：${entry.name}`);
    await copyTree({
      source: entryPath,
      destination,
      manifestPrefix: "geminiai-accounts",
      collector,
      category: "geminiAccounts",
    });
  }
}

/**
 * The native runner inherits its service account HOME and does not point the
 * CLI at a project-local credential file. The observed macOS directory only
 * contains CLI documentation, logs, task SQLite state, locks, and version
 * metadata. None prove a portable login credential, so retain an empty
 * data/dreamina directory and force a target-side login instead of guessing.
 */
async function validateDreaminaRuntimeState(source) {
  for (const entry of await safeEntries(source, "即梦登录状态目录")) {
    if (isExcluded(entry.name)) continue;
    const entryPath = path.join(source, entry.name);
    const details = await safeLstat(
      entryPath,
      `即梦登录状态目录中的 ${entry.name}`,
    );
    if (details.isFile() && DREAMINA_RUNTIME_FILES.has(entry.name)) continue;
    if (details.isDirectory() && DREAMINA_RUNTIME_DIRECTORIES.has(entry.name))
      continue;
    throw new Error(
      `即梦登录状态目录包含未知条目，无法证明其可迁移性：${entry.name}`,
    );
  }
}

async function copyTree({
  source,
  destination,
  manifestPrefix,
  collector,
  category,
}) {
  await assertDirectory(source, "待复制目录");
  await createPrivateDirectory(destination);
  for (const entry of await safeEntries(source, "待复制目录")) {
    if (isExcluded(entry.name)) continue;
    const entryPath = path.join(source, entry.name);
    const details = await safeLstat(entryPath, `待复制目录中的 ${entry.name}`);
    const childDestination = path.join(destination, entry.name);
    const childManifestPath = path.posix.join(manifestPrefix, entry.name);
    if (details.isDirectory()) {
      await copyTree({
        source: entryPath,
        destination: childDestination,
        manifestPrefix: childManifestPath,
        collector,
        category,
      });
      continue;
    }
    if (!details.isFile())
      throw new Error(`待复制目录包含不支持的条目：${entry.name}`);
    await collector.copy(entryPath, childManifestPath, category);
  }
}

function parseArguments(argumentsList) {
  const options = { confirmOffline: false, output: "", source: "" };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "--confirm-offline") {
      options.confirmOffline = true;
      continue;
    }
    const equalIndex = value.indexOf("=");
    const name = equalIndex === -1 ? value : value.slice(0, equalIndex);
    const inlineValue =
      equalIndex === -1 ? undefined : value.slice(equalIndex + 1);
    if (name !== "--output" && name !== "--source")
      throw new Error(`不支持的参数：${value}`);
    const optionValue =
      inlineValue === undefined ? argumentsList[++index] : inlineValue;
    if (!optionValue || optionValue.startsWith("--"))
      throw new Error(`${name} 需要目录参数`);
    if (name === "--output") options.output = optionValue;
    else options.source = optionValue;
  }
  return options;
}

function buildPrivateEnv(encryptionKey) {
  const lines = [
    "# 仅供本次 FILE -> PostgreSQL 私有数据迁移使用。",
    `OCTALAICANVAS_ENCRYPTION_KEY=${dotenvLiteral(encryptionKey)}`,
  ];
  for (const key of PRIVATE_ENV_KEYS.slice(1)) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim())
      lines.push(`${key}=${dotenvLiteral(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function dotenvLiteral(value) {
  if (/[\r\n\u0000]/u.test(value))
    throw new Error("私有环境变量不能包含换行或空字符");
  return `'${value.replaceAll("'", "\\'")}'`;
}

function isValidEncryptionKey(value) {
  if (/^[a-f0-9]{64}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

async function copyPrivateFile(source, destination) {
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("待复制条目不是普通文件");
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    await chmod(destination, 0o600);
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

async function writePrivateText(destination, content) {
  const bytes = Buffer.from(content, "utf8");
  await writeFile(destination, bytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(destination, 0o600);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

async function safeEntries(directory, label) {
  await assertDirectory(directory, label);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function safeLstat(target, label) {
  const details = await lstat(target);
  if (details.isSymbolicLink()) throw new Error(`${label} 不允许使用符号链接`);
  return details;
}

async function assertDirectory(directory, label) {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      throw new Error(`${label}不存在`);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory())
    throw new Error(`${label}必须是非符号链接目录`);
}

async function assertMissing(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("输出目录已存在，拒绝覆盖");
}

async function ensureOutputParent(parentDirectory) {
  const missing = [];
  let current = parentDirectory;
  while (true) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory())
        throw new Error("输出目录父路径必须是非符号链接目录");
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT"))
        throw error;
      const next = path.dirname(current);
      if (next === current) throw new Error("无法创建输出目录父路径");
      missing.push(current);
      current = next;
    }
  }
  for (const directory of missing.reverse())
    await createPrivateDirectory(directory);
}

async function createPrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

function resolveDestination(root, relativeDestination) {
  const target = path.resolve(root, relativeDestination);
  if (target === root || !target.startsWith(`${root}${path.sep}`))
    throw new Error("快照目标路径越界");
  return target;
}

function assertOutside(root, target, message) {
  const relative = path.relative(root, target);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error(message);
}

function isExcluded(name) {
  return EXCLUDED_NAMES.has(name);
}

function toManifestPath(value) {
  const normalized = value.split(path.sep).join("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  )
    throw new Error("清单路径无效");
  return normalized;
}

main().catch((error) => {
  process.stderr.write(
    `私有迁移快照导出失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
