import { GET as handleGeminiToolsOAuthCallback } from "@/app/api/admin/gemini-tools/oauth/callback/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    return handleGeminiToolsOAuthCallback(request);
}
