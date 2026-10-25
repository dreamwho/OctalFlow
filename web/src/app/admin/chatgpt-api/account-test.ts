import { chatGptApiRequest, type ChatGptAccountTestResult } from "@/services/api/chatgpt-api";

export async function submitChatGptAccountTest(input: { accountId: string; mode: "chat" | "image"; model: string; prompt: string; inFlight: { current: boolean } }) {
    if (input.inFlight.current || !input.model.trim() || !input.prompt.trim()) return null;
    input.inFlight.current = true;
    try {
        return await chatGptApiRequest<ChatGptAccountTestResult>(`accounts/${encodeURIComponent(input.accountId)}/test`, {
            method: "POST",
            body: JSON.stringify({ mode: input.mode, model: input.model, prompt: input.prompt.trim() }),
        });
    } finally {
        input.inFlight.current = false;
    }
}
