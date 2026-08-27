import type { AgentSkill } from "./auth/store-types";

export const AGENT_SKILL_EXTRACTION_SOURCE_LENGTH = 24_000;
export const AGENT_SKILL_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;

export type AgentSkillImportCandidate = {
    path: string;
    name: string;
};

export type ImportedAgentSkill = AgentSkill & {
    repository: string;
    sourcePath: string;
    sourceCommit: string;
    sourceContentHash: string;
    license?: string;
};

export type AgentSkillImportResult = {
    repository: string;
    ref: string;
    candidates: AgentSkillImportCandidate[];
    skill?: ImportedAgentSkill;
};
