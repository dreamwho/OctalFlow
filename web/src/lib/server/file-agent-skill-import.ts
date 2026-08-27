import { createHash } from "node:crypto";
import { basename, extname, posix } from "node:path";

import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { nanoid } from "nanoid";
import { parseDocument } from "yaml";

import {
    AGENT_SKILL_ARCHIVE_MAX_BYTES,
    AGENT_SKILL_EXTRACTION_SOURCE_LENGTH,
    type AgentSkillImportCandidate,
    type AgentSkillImportResult,
    type ImportedAgentSkill,
} from "@/lib/agent-skill-import-types";
import type { AgentSkillWorkspace } from "@/lib/auth/store-types";

const MAX_ARCHIVE_ENTRIES = 4_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_TEXT_TOTAL_BYTES = 6_000_000;
const MAX_SKILL_CANDIDATES = 100;
const MAIN_SKILL_SOURCE_BUDGET = 16_000;
const WORKSPACES: AgentSkillWorkspace[] = ["image", "video", "canvas", "drama"];

type SkillFrontmatter = {
    name?: unknown;
    description?: unknown;
    version?: unknown;
    license?: unknown;
    keywords?: unknown;
    workspaces?: unknown;
    action?: unknown;
    requiresReference?: unknown;
    defaultConfig?: unknown;
    metadata?: unknown;
};

type SkillSource = {
    values: SkillFrontmatter;
    body: string;
};

const globalRarImport = globalThis as typeof globalThis & { __octalaicanvasRarSkillImportQueue?: Promise<void> };

export class FileAgentSkillImportError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "FileAgentSkillImportError";
    }
}

export async function importAgentSkillFromFile(params: { fileName: string; fileBuffer: Buffer; selectedPath?: string }): Promise<AgentSkillImportResult> {
    const fileName = basename(params.fileName.trim() || "skill.zip").slice(0, 180);
    const extension = extname(fileName).toLowerCase();
    if (!fileName || ![".zip", ".rar", ".md", ".markdown"].includes(extension)) {
        throw new FileAgentSkillImportError("只支持 .zip、.rar、.md 或 .markdown Skill 文件", 415);
    }
    if (!params.fileBuffer.length) throw new FileAgentSkillImportError("上传的 Skill 文件为空");
    if (params.fileBuffer.length > AGENT_SKILL_ARCHIVE_MAX_BYTES) {
        throw new FileAgentSkillImportError(`Skill 文件不能超过 ${Math.floor(AGENT_SKILL_ARCHIVE_MAX_BYTES / 1024 / 1024)}MB`, 413);
    }

    if (extension === ".md" || extension === ".markdown") {
        const markdown = decodeUtf8(params.fileBuffer, fileName);
        return {
            repository: fileName,
            ref: "local-file",
            candidates: [],
            skill: parseLocalSkillMarkdown(markdown, { fileName, sourcePath: fileName }),
        };
    }

    const entries = extension === ".zip" ? readZipTextEntries(params.fileBuffer) : await readRarTextEntries(params.fileBuffer);
    const candidates = localSkillCandidates(entries);
    if (!candidates.length) throw new FileAgentSkillImportError("压缩包中没有找到 SKILL.md", 422);

    const selectedPath = params.selectedPath ? normalizeArchivePath(params.selectedPath) : candidates.length === 1 ? candidates[0].path : "";
    if (!selectedPath) return { repository: fileName, ref: "local-archive", candidates };
    if (!candidates.some((candidate) => candidate.path === selectedPath)) throw new FileAgentSkillImportError("所选 SKILL.md 不属于当前压缩包");

    const markdown = entries.get(selectedPath);
    if (!markdown) throw new FileAgentSkillImportError("无法读取所选 SKILL.md", 422);
    const sourceBundle = buildSkillSourceBundle(entries, selectedPath, markdown);
    return {
        repository: fileName,
        ref: "local-archive",
        candidates: candidates.length > 1 ? candidates : [],
        skill: parseLocalSkillMarkdown(markdown, { fileName, sourcePath: selectedPath, sourceBundle, archiveEntries: entries }),
    };
}

function readZipTextEntries(buffer: Buffer) {
    const entries = new Map<string, string>();
    let entryCount = 0;
    let totalTextBytes = 0;
    let failure: unknown;
    const unzip = new Unzip((file) => {
        if (failure) return;
        try {
            entryCount += 1;
            if (entryCount > MAX_ARCHIVE_ENTRIES) throw new FileAgentSkillImportError("压缩包文件数量过多", 413);
            if (file.name.endsWith("/")) return;
            const path = normalizeArchivePath(file.name);
            if (!isSkillTextPath(path)) return;
            if (file.originalSize !== undefined && file.originalSize > MAX_TEXT_FILE_BYTES) throw new FileAgentSkillImportError(`文本文件过大：${path}`, 413);
            const chunks: Uint8Array[] = [];
            let size = 0;
            file.ondata = (error, chunk, final) => {
                if (failure) return;
                try {
                    if (error) throw error;
                    size += chunk.length;
                    if (size > MAX_TEXT_FILE_BYTES || totalTextBytes + size > MAX_TEXT_TOTAL_BYTES) throw new FileAgentSkillImportError("压缩包中的文本内容过大", 413);
                    chunks.push(chunk);
                    if (!final) return;
                    totalTextBytes += size;
                    entries.set(path, decodeUtf8(Buffer.concat(chunks.map((item) => Buffer.from(item))), path));
                } catch (error) {
                    failure = error;
                    file.terminate();
                }
            };
            file.start();
        } catch (error) {
            failure = error;
            file.terminate();
        }
    });
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);
    try {
        unzip.push(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), true);
    } catch (error) {
        failure ||= error;
    }
    if (failure) {
        if (failure instanceof FileAgentSkillImportError) throw failure;
        throw new FileAgentSkillImportError("ZIP 文件损坏或使用了不支持的压缩方式", 422);
    }
    return entries;
}

async function readRarTextEntries(buffer: Buffer) {
    return withRarImportLock(async () => {
        try {
            const { createExtractorFromData } = await import("node-unrar-js");
            const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
            const extractor = await createExtractorFromData({ data });
            const list = extractor.getFileList();
            const headers = [...list.fileHeaders];
            if (list.arcHeader.flags.headerEncrypted) throw new FileAgentSkillImportError("不支持加密的 RAR Skill 包", 422);
            if (headers.length > MAX_ARCHIVE_ENTRIES) throw new FileAgentSkillImportError("压缩包文件数量过多", 413);
            const selectedPaths: string[] = [];
            let totalTextBytes = 0;
            for (const header of headers) {
                if (header.flags.directory) continue;
                if (header.flags.encrypted) throw new FileAgentSkillImportError("不支持包含加密文件的 RAR Skill 包", 422);
                const path = normalizeArchivePath(header.name);
                if (!isSkillTextPath(path)) continue;
                if (header.unpSize > MAX_TEXT_FILE_BYTES) throw new FileAgentSkillImportError(`文本文件过大：${path}`, 413);
                totalTextBytes += header.unpSize;
                if (totalTextBytes > MAX_TEXT_TOTAL_BYTES) throw new FileAgentSkillImportError("压缩包中的文本内容过大", 413);
                selectedPaths.push(header.name);
            }
            const entries = new Map<string, string>();
            if (!selectedPaths.length) return entries;
            const extracted = extractor.extract({ files: selectedPaths });
            let extractedTextBytes = 0;
            for (const file of extracted.files) {
                if (!file.extraction) continue;
                const path = normalizeArchivePath(file.fileHeader.name);
                if (file.extraction.byteLength > MAX_TEXT_FILE_BYTES) throw new FileAgentSkillImportError(`文本文件过大：${path}`, 413);
                extractedTextBytes += file.extraction.byteLength;
                if (extractedTextBytes > MAX_TEXT_TOTAL_BYTES) throw new FileAgentSkillImportError("压缩包中的文本内容过大", 413);
                entries.set(path, decodeUtf8(file.extraction, path));
            }
            return entries;
        } catch (error) {
            if (error instanceof FileAgentSkillImportError) throw error;
            throw new FileAgentSkillImportError("RAR 文件损坏、被加密或无法解析", 422);
        }
    });
}

function withRarImportLock<T>(callback: () => Promise<T>) {
    const previous = globalRarImport.__octalaicanvasRarSkillImportQueue || Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    globalRarImport.__octalaicanvasRarSkillImportQueue = current.then(
        () => undefined,
        () => undefined,
    );
    return current;
}

function localSkillCandidates(entries: Map<string, string>): AgentSkillImportCandidate[] {
    const candidates = [...entries.entries()]
        .filter(([path]) => basename(path).toLowerCase() === "skill.md")
        .map(([path, markdown]) => {
            const source = readFrontmatter(markdown);
            const metadata = isRecord(source.values.metadata) ? source.values.metadata : {};
            return { path, name: firstText(source.values.name, metadata.name) || skillNameFromPath(path) };
        })
        .sort((left, right) => candidateRank(left.path) - candidateRank(right.path) || left.path.localeCompare(right.path, "zh-CN"));
    if (candidates.length > MAX_SKILL_CANDIDATES) throw new FileAgentSkillImportError(`压缩包中的 SKILL.md 不能超过 ${MAX_SKILL_CANDIDATES} 个`, 413);
    return candidates;
}

function candidateRank(path: string) {
    return path.split("/").length * 10 + (path.toLowerCase().includes("/skills/") ? 2 : 0);
}

function parseLocalSkillMarkdown(
    markdown: string,
    source: { fileName: string; sourcePath: string; sourceBundle?: string; archiveEntries?: Map<string, string> },
): ImportedAgentSkill {
    const parsed = readFrontmatter(markdown);
    const metadata = isRecord(parsed.values.metadata) ? parsed.values.metadata : {};
    const name = firstText(parsed.values.name, metadata.name) || headingName(parsed.body) || skillNameFromPath(source.sourcePath);
    const description = firstText(parsed.values.description, metadata.description) || firstParagraph(parsed.body) || `来自 ${source.fileName} 的 Agent Skill`;
    const instructions = (source.sourceBundle || parsed.body).trim();
    if (instructions.length < 10) throw new FileAgentSkillImportError("SKILL.md 内容过短，无法作为执行规则", 422);
    const sourceContentHash = createHash("sha256").update(source.sourceBundle || markdown, "utf8").digest("hex");
    const license = firstText(parsed.values.license, metadata.license, detectArchiveLicense(source.archiveEntries));
    const sourceVersion = firstText(parsed.values.version, metadata.version) || "local";
    const idStem = `${source.fileName}-${source.sourcePath}`
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
    return {
        id: `local-${idStem || nanoid(10)}`.slice(0, 120),
        name: name.slice(0, 60),
        description: description.replace(/\s+/g, " ").trim().slice(0, 240),
        plannerSummary: description.replace(/\s+/g, " ").trim().slice(0, 240),
        instructions: instructions.slice(0, AGENT_SKILL_EXTRACTION_SOURCE_LENGTH),
        enabled: false,
        keywords: parseKeywords(parsed.values.keywords ?? metadata.keywords).slice(0, 30),
        workspaces: parseWorkspaces(parsed.values.workspaces ?? metadata.workspaces),
        action: firstText(parsed.values.action, metadata.action) === "edit" ? "edit" : "generate",
        requiresReference: Boolean(parsed.values.requiresReference ?? metadata.requiresReference),
        defaultConfig: parseDefaultConfig(parsed.values.defaultConfig ?? metadata.defaultConfig),
        sourceRepository: source.fileName,
        sourcePath: source.sourcePath,
        sourceVersion,
        sourceCommit: sourceContentHash.slice(0, 40),
        sourceContentHash,
        ...(license ? { license: license.slice(0, 120) } : {}),
        repository: source.fileName,
    };
}

function buildSkillSourceBundle(entries: Map<string, string>, selectedPath: string, markdown: string) {
    const selected = readFrontmatter(markdown);
    const main = selected.body.trim().slice(0, MAIN_SKILL_SOURCE_BUDGET);
    const references = referencedSkillPaths(selected.body, selectedPath, entries);
    const referenceDirectory = `${posix.dirname(selectedPath)}/references/`.replace(/^\.\//, "");
    for (const path of entries.keys()) {
        if (path.startsWith(referenceDirectory) && isMarkdownOrText(path) && !references.includes(path)) references.push(path);
    }
    let bundle = main;
    for (const path of references) {
        const content = entries.get(path)?.trim();
        if (!content) continue;
        const heading = `\n\n[参考资料：${path}]\n`;
        const remaining = AGENT_SKILL_EXTRACTION_SOURCE_LENGTH - bundle.length - heading.length;
        if (remaining <= 200) break;
        bundle += `${heading}${content.slice(0, remaining)}`;
    }
    return bundle.slice(0, AGENT_SKILL_EXTRACTION_SOURCE_LENGTH);
}

function referencedSkillPaths(body: string, selectedPath: string, entries: Map<string, string>) {
    const paths: string[] = [];
    const matches = body.matchAll(/(?:\]\(|`|\s)((?:\.\.\/|\.\/)?(?:references|docs)\/[\w./ -]+\.(?:md|markdown|txt))(?:[#?)`\s]|$)/gi);
    for (const match of matches) {
        const raw = match[1]?.trim();
        if (!raw) continue;
        let decoded = raw;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            continue;
        }
        const resolved = normalizeArchivePath(posix.join(posix.dirname(selectedPath), decoded));
        if (entries.has(resolved) && !paths.includes(resolved)) paths.push(resolved);
    }
    return paths;
}

function readFrontmatter(markdown: string): SkillSource {
    const normalized = markdown.replace(/^\uFEFF/, "").trim();
    if (!normalized.startsWith("---")) return { values: {}, body: normalized };
    const end = normalized.indexOf("\n---", 3);
    if (end < 0) return { values: {}, body: normalized };
    try {
        const values = parseDocument(normalized.slice(3, end).trim()).toJS() as unknown;
        return { values: isRecord(values) ? (values as SkillFrontmatter) : {}, body: normalized.slice(end + 4).replace(/^\r?\n/, "") };
    } catch {
        throw new FileAgentSkillImportError("SKILL.md 的 YAML 头信息无法解析", 422);
    }
}

function normalizeArchivePath(value: string) {
    const replaced = value.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!replaced || replaced.length > 800 || replaced.includes("\0") || replaced.startsWith("/") || /^[a-z]:\//i.test(replaced)) {
        throw new FileAgentSkillImportError("压缩包包含无效路径", 422);
    }
    const parts = replaced.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) throw new FileAgentSkillImportError("压缩包包含不安全路径", 422);
    return parts.join("/");
}

function isSkillTextPath(path: string) {
    const name = basename(path).toLowerCase();
    return isMarkdownOrText(path) || ["license", "notice", "copying"].includes(name);
}

function isMarkdownOrText(path: string) {
    return [".md", ".markdown", ".txt"].includes(extname(path).toLowerCase());
}

function decodeUtf8(value: Uint8Array, path: string) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value).replace(/^\uFEFF/, "");
    } catch {
        throw new FileAgentSkillImportError(`文本文件不是有效 UTF-8：${path}`, 422);
    }
}

function detectArchiveLicense(entries?: Map<string, string>) {
    if (!entries) return undefined;
    const license = [...entries.entries()].find(([path]) => ["license", "license.md", "license.txt", "copying"].includes(basename(path).toLowerCase()))?.[1] || "";
    if (/apache license[\s\S]{0,80}version 2\.0/i.test(license)) return "Apache-2.0";
    if (/mit license/i.test(license)) return "MIT";
    if (/gnu (?:general public|lesser general public) license/i.test(license)) return "GPL";
    return undefined;
}

function skillNameFromPath(path: string) {
    return (path.split("/").at(-2) || path.split("/").at(-1) || "本地 Skill").replace(/[-_]+/g, " ");
}

function headingName(body: string) {
    return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function firstParagraph(body: string) {
    return body
        .replace(/^#.*$/gm, "")
        .split(/\n\s*\n/)
        .map((item) => item.replace(/[`*_>#-]/g, "").trim())
        .find(Boolean);
}

function firstText(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function parseKeywords(value: unknown) {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return typeof value === "string" ? value.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean) : [];
}

function parseWorkspaces(value: unknown): AgentSkillWorkspace[] {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[、,，\s]+/) : [];
    const workspaces = values.filter((item): item is AgentSkillWorkspace => typeof item === "string" && WORKSPACES.includes(item as AgentSkillWorkspace));
    return workspaces.length ? [...new Set(workspaces)] : ["image"];
}

function parseDefaultConfig(value: unknown): Record<string, string | number | boolean> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))) as Record<string, string | number | boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
