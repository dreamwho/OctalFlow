import { ALL_PROMPTS_OPTION, type Prompt, type PromptListResponse } from "./prompts";

export type MyPromptMutationInput = { title: string; prompt: string; category?: string; tags?: string[]; coverUrl?: string; preview?: string };

export function listMyPrompts(input: { page: number; pageSize?: number; category?: string; keyword?: string; includeFacets?: boolean }) {
    const query = new URLSearchParams({
        page: String(input.page),
        ...(input.pageSize ? { pageSize: String(input.pageSize) } : {}),
        ...(input.category && input.category !== ALL_PROMPTS_OPTION ? { category: input.category } : {}),
        ...(input.keyword?.trim() ? { keyword: input.keyword.trim() } : {}),
        ...(input.includeFacets === false ? { includeFacets: "0" } : {}),
    });
    return request<PromptListResponse>(`/api/my-prompts?${query}`, { cache: "no-store" });
}

export function createMyPrompt(input: MyPromptMutationInput, cover?: File | null) {
    return request<{ prompt: Prompt }>("/api/my-prompts", {
        method: "POST",
        body: promptMutationBody(input, cover),
    }).then((data) => data.prompt);
}

export function updateMyPrompt(id: string, input: MyPromptMutationInput, cover?: File | null) {
    return request<{ prompt: Prompt }>(`/api/my-prompts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: promptMutationBody(input, cover),
    }).then((data) => data.prompt);
}

export function deleteMyPrompt(id: string) {
    return request<{ ok: boolean }>(`/api/my-prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

function promptMutationBody(input: MyPromptMutationInput, cover?: File | null) {
    const body = new FormData();
    body.set("payload", JSON.stringify(input));
    if (cover) body.set("cover", cover);
    return body;
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "提示词请求失败");
    return payload;
}
