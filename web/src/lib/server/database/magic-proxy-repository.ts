import type { QueryExecutor } from "./postgres";

export type MagicProxyProvider = "geminiai" | "geminiTools" | "chatgptApi";

export type MagicProxyChainedConfig = {
    hop_node: string;
    landing_node_id: string;
};

export type MagicProxyBinding = {
    enabled: boolean;
    node?: string;
    mode?: "magic" | "chained";
    chained_config?: MagicProxyChainedConfig;
};

export type MagicProxyBindings = {
    geminiai: MagicProxyBinding;
    geminiTools: MagicProxyBinding;
    chatgptApi: MagicProxyBinding;
};

export type MagicProxySettings = {
    subscriptionUrlCiphertext: string;
    nodesCiphertext: string;
    bindings: MagicProxyBindings;
    updatedAt: string;
};

export class MagicProxyRepository {
    constructor(private readonly db: QueryExecutor) {}

    async get() {
        const result = await this.db.query("SELECT * FROM magic_proxy_settings WHERE id = 'default'");
        return result.rows[0] ? mapSettings(result.rows[0]) : null;
    }

    async save(settings: MagicProxySettings) {
        const result = await this.db.query(
            `INSERT INTO magic_proxy_settings (
                id,subscription_url_ciphertext,nodes_ciphertext,
                geminiai_enabled,geminiai_node,geminiai_mode,geminiai_chained_config,
                gemini_tools_enabled,gemini_tools_node,gemini_tools_mode,gemini_tools_chained_config,
                chatgpt_api_enabled,chatgpt_api_node,chatgpt_api_mode,chatgpt_api_chained_config,
                updated_at
             ) VALUES ('default',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (id) DO UPDATE SET
                subscription_url_ciphertext=EXCLUDED.subscription_url_ciphertext,
                nodes_ciphertext=EXCLUDED.nodes_ciphertext,
                geminiai_enabled=EXCLUDED.geminiai_enabled,
                geminiai_node=EXCLUDED.geminiai_node,
                geminiai_mode=EXCLUDED.geminiai_mode,
                geminiai_chained_config=EXCLUDED.geminiai_chained_config,
                gemini_tools_enabled=EXCLUDED.gemini_tools_enabled,
                gemini_tools_node=EXCLUDED.gemini_tools_node,
                gemini_tools_mode=EXCLUDED.gemini_tools_mode,
                gemini_tools_chained_config=EXCLUDED.gemini_tools_chained_config,
                chatgpt_api_enabled=EXCLUDED.chatgpt_api_enabled,
                chatgpt_api_node=EXCLUDED.chatgpt_api_node,
                chatgpt_api_mode=EXCLUDED.chatgpt_api_mode,
                chatgpt_api_chained_config=EXCLUDED.chatgpt_api_chained_config,
                updated_at=EXCLUDED.updated_at
             RETURNING *`,
            [
                settings.subscriptionUrlCiphertext,
                settings.nodesCiphertext,
                settings.bindings.geminiai.enabled,
                settings.bindings.geminiai.node || null,
                settings.bindings.geminiai.mode || "magic",
                settings.bindings.geminiai.chained_config ? JSON.stringify(settings.bindings.geminiai.chained_config) : null,
                settings.bindings.geminiTools.enabled,
                settings.bindings.geminiTools.node || null,
                settings.bindings.geminiTools.mode || "magic",
                settings.bindings.geminiTools.chained_config ? JSON.stringify(settings.bindings.geminiTools.chained_config) : null,
                settings.bindings.chatgptApi.enabled,
                settings.bindings.chatgptApi.node || null,
                settings.bindings.chatgptApi.mode || "magic",
                settings.bindings.chatgptApi.chained_config ? JSON.stringify(settings.bindings.chatgptApi.chained_config) : null,
                new Date(settings.updatedAt),
            ],
        );
        return mapSettings(result.rows[0]);
    }
}

function mapSettings(row: Record<string, unknown>): MagicProxySettings {
    const updatedAt = date(row.updated_at) || new Date().toISOString();
    return {
        subscriptionUrlCiphertext: text(row.subscription_url_ciphertext),
        nodesCiphertext: text(row.nodes_ciphertext),
        bindings: {
            geminiai: binding(row.geminiai_enabled, row.geminiai_node, row.geminiai_mode, row.geminiai_chained_config),
            geminiTools: binding(row.gemini_tools_enabled, row.gemini_tools_node, row.gemini_tools_mode, row.gemini_tools_chained_config),
            chatgptApi: binding(row.chatgpt_api_enabled, row.chatgpt_api_node, row.chatgpt_api_mode, row.chatgpt_api_chained_config),
        },
        updatedAt,
    };
}

function binding(enabled: unknown, node: unknown, mode?: unknown, chainedConfig?: unknown): MagicProxyBinding {
    const selected = text(node);
    const isChained = mode === "chained";
    const cfg = chainedConfig && typeof chainedConfig === "object" && !Array.isArray(chainedConfig)
        ? (chainedConfig as Record<string, unknown>)
        : {};
    const hop = text(cfg.hop_node);
    const landing = text(cfg.landing_node_id);
    return {
        enabled: enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(selected ? { node: selected } : {}),
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing } } : {}),
    };
}

function text(value: unknown) {
    return typeof value === "string" ? value : "";
}

function date(value: unknown) {
    if (!value) return "";
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}
