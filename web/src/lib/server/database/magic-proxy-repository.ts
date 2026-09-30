import type { QueryExecutor } from "./postgres";

export type MagicProxyProvider = "geminiai" | "geminiTools" | "chatgptApi" | "dola" | "dolaUpload";

export type MagicProxyChainedConfig = {
    hop_node: string;
    landing_node_id: string;
    /** 跳板失联时由内核 fallback 组接管的备用跳板节点。 */
    hop_fallback_node?: string;
};

export type MagicProxyBinding = {
    enabled: boolean;
    node?: string;
    /** 兜底节点：主节点拨号失败时由内核 fallback 组自动接管（仅 magic 模式）。 */
    fallback_node?: string;
    mode?: "magic" | "chained";
    chained_config?: MagicProxyChainedConfig;
};

export type MagicProxyBindings = {
    geminiai: MagicProxyBinding;
    geminiTools: MagicProxyBinding;
    chatgptApi: MagicProxyBinding;
    /** Dola is optional in legacy file snapshots; new saves always materialize it. */
    dola?: MagicProxyBinding;
    dolaUpload?: MagicProxyBinding;
};

export type MagicProxySubscriptionGroup = {
    name: string;
    type?: string;
    proxies: string[];
};

export type MagicProxySubscriptionRecord = {
    id: string;
    name: string;
    url: string;
    type: "remote" | "file";
    enabled: boolean;
    nodes: Array<Record<string, unknown> & { name: string; type: string }>;
    groups?: MagicProxySubscriptionGroup[];
    /** 订阅自带的 Clash dns 配置（如 proxy-server-nameserver），透传进动态 Mihomo 配置 */
    dns?: Record<string, unknown>;
    nodeCount: number;
    updatedAt: string;
    lastTestedAt?: string;
};

export type MagicProxyNodeDelayRecord = {
    delay?: number;
    alive?: boolean;
    testedAt: string;
};

export type MagicProxySettings = {
    subscriptionUrlCiphertext: string;
    nodesCiphertext: string;
    subscriptionsCiphertext?: string;
    nodeDelaysCiphertext?: string;
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
                id,subscription_url_ciphertext,nodes_ciphertext,subscriptions_ciphertext,node_delays_ciphertext,
                geminiai_enabled,geminiai_node,geminiai_mode,geminiai_fallback_node,geminiai_chained_config,
                gemini_tools_enabled,gemini_tools_node,gemini_tools_mode,gemini_tools_fallback_node,gemini_tools_chained_config,
                chatgpt_api_enabled,chatgpt_api_node,chatgpt_api_mode,chatgpt_api_fallback_node,chatgpt_api_chained_config,
                dola_enabled,dola_node,dola_mode,dola_fallback_node,dola_chained_config,
                dola_upload_enabled,dola_upload_node,dola_upload_mode,dola_upload_fallback_node,dola_upload_chained_config,
                updated_at
             ) VALUES ('default',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
             ON CONFLICT (id) DO UPDATE SET
                subscription_url_ciphertext=EXCLUDED.subscription_url_ciphertext,
                nodes_ciphertext=EXCLUDED.nodes_ciphertext,
                subscriptions_ciphertext=EXCLUDED.subscriptions_ciphertext,
                node_delays_ciphertext=EXCLUDED.node_delays_ciphertext,
                geminiai_enabled=EXCLUDED.geminiai_enabled,
                geminiai_node=EXCLUDED.geminiai_node,
                geminiai_mode=EXCLUDED.geminiai_mode,
                geminiai_fallback_node=EXCLUDED.geminiai_fallback_node,
                geminiai_chained_config=EXCLUDED.geminiai_chained_config,
                gemini_tools_enabled=EXCLUDED.gemini_tools_enabled,
                gemini_tools_node=EXCLUDED.gemini_tools_node,
                gemini_tools_mode=EXCLUDED.gemini_tools_mode,
                gemini_tools_fallback_node=EXCLUDED.gemini_tools_fallback_node,
                gemini_tools_chained_config=EXCLUDED.gemini_tools_chained_config,
                chatgpt_api_enabled=EXCLUDED.chatgpt_api_enabled,
                chatgpt_api_node=EXCLUDED.chatgpt_api_node,
                chatgpt_api_mode=EXCLUDED.chatgpt_api_mode,
                chatgpt_api_fallback_node=EXCLUDED.chatgpt_api_fallback_node,
                chatgpt_api_chained_config=EXCLUDED.chatgpt_api_chained_config,
                dola_enabled=EXCLUDED.dola_enabled,
                dola_node=EXCLUDED.dola_node,
                dola_mode=EXCLUDED.dola_mode,
                dola_fallback_node=EXCLUDED.dola_fallback_node,
                dola_chained_config=EXCLUDED.dola_chained_config,
                dola_upload_enabled=EXCLUDED.dola_upload_enabled,
                dola_upload_node=EXCLUDED.dola_upload_node,
                dola_upload_mode=EXCLUDED.dola_upload_mode,
                dola_upload_fallback_node=EXCLUDED.dola_upload_fallback_node,
                dola_upload_chained_config=EXCLUDED.dola_upload_chained_config,
                updated_at=EXCLUDED.updated_at
             RETURNING *`,
            [
                settings.subscriptionUrlCiphertext,
                settings.nodesCiphertext,
                settings.subscriptionsCiphertext || "",
                settings.nodeDelaysCiphertext || "",
                settings.bindings.geminiai.enabled,
                settings.bindings.geminiai.node || null,
                settings.bindings.geminiai.mode || "magic",
                settings.bindings.geminiai.fallback_node || null,
                settings.bindings.geminiai.chained_config ? JSON.stringify(settings.bindings.geminiai.chained_config) : null,
                settings.bindings.geminiTools.enabled,
                settings.bindings.geminiTools.node || null,
                settings.bindings.geminiTools.mode || "magic",
                settings.bindings.geminiTools.fallback_node || null,
                settings.bindings.geminiTools.chained_config ? JSON.stringify(settings.bindings.geminiTools.chained_config) : null,
                settings.bindings.chatgptApi.enabled,
                settings.bindings.chatgptApi.node || null,
                settings.bindings.chatgptApi.mode || "magic",
                settings.bindings.chatgptApi.fallback_node || null,
                settings.bindings.chatgptApi.chained_config ? JSON.stringify(settings.bindings.chatgptApi.chained_config) : null,
                settings.bindings.dola?.enabled === true,
                settings.bindings.dola?.node || null,
                settings.bindings.dola?.mode || "magic",
                settings.bindings.dola?.fallback_node || null,
                settings.bindings.dola?.chained_config ? JSON.stringify(settings.bindings.dola.chained_config) : null,
                settings.bindings.dolaUpload?.enabled === true,
                settings.bindings.dolaUpload?.node || null,
                settings.bindings.dolaUpload?.mode || "magic",
                settings.bindings.dolaUpload?.fallback_node || null,
                settings.bindings.dolaUpload?.chained_config ? JSON.stringify(settings.bindings.dolaUpload.chained_config) : null,
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
        subscriptionsCiphertext: text(row.subscriptions_ciphertext),
        nodeDelaysCiphertext: text(row.node_delays_ciphertext),
        bindings: {
            geminiai: binding(row.geminiai_enabled, row.geminiai_node, row.geminiai_mode, row.geminiai_fallback_node, row.geminiai_chained_config),
            geminiTools: binding(row.gemini_tools_enabled, row.gemini_tools_node, row.gemini_tools_mode, row.gemini_tools_fallback_node, row.gemini_tools_chained_config),
            chatgptApi: binding(row.chatgpt_api_enabled, row.chatgpt_api_node, row.chatgpt_api_mode, row.chatgpt_api_fallback_node, row.chatgpt_api_chained_config),
            dola: binding(row.dola_enabled, row.dola_node, row.dola_mode, row.dola_fallback_node, row.dola_chained_config),
            dolaUpload: binding(row.dola_upload_enabled, row.dola_upload_node, row.dola_upload_mode, row.dola_upload_fallback_node, row.dola_upload_chained_config),
        },
        updatedAt,
    };
}

function binding(enabled: unknown, node: unknown, mode: unknown, fallbackNode: unknown, chainedConfig: unknown): MagicProxyBinding {
    const selected = text(node);
    const fallback = text(fallbackNode);
    const isChained = mode === "chained";
    const cfg = chainedConfig && typeof chainedConfig === "object" && !Array.isArray(chainedConfig) ? (chainedConfig as Record<string, unknown>) : {};
    const hop = text(cfg.hop_node);
    const landing = text(cfg.landing_node_id);
    const hopFallback = text(cfg.hop_fallback_node);
    return {
        enabled: enabled === true,
        ...(isChained ? { mode: "chained" as const } : {}),
        ...(selected ? { node: selected } : {}),
        ...(!isChained && selected && fallback && fallback !== selected ? { fallback_node: fallback } : {}),
        // 链式跳板兜底也要读回：此前只重建 hop_node/landing_node_id，保存后读回为空。
        ...(hop || landing ? { chained_config: { hop_node: hop, landing_node_id: landing, ...(hopFallback ? { hop_fallback_node: hopFallback } : {}) } } : {}),
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
