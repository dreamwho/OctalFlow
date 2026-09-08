import type { QueryExecutor } from "./postgres";

export type MagicProxyProvider = "geminiai" | "geminiTools";

export type MagicProxyBinding = {
    enabled: boolean;
    node?: string;
};

export type MagicProxyBindings = {
    geminiai: MagicProxyBinding;
    geminiTools: MagicProxyBinding;
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
                id,subscription_url_ciphertext,nodes_ciphertext,geminiai_enabled,geminiai_node,gemini_tools_enabled,gemini_tools_node,updated_at
             ) VALUES ('default',$1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO UPDATE SET
                subscription_url_ciphertext=EXCLUDED.subscription_url_ciphertext,
                nodes_ciphertext=EXCLUDED.nodes_ciphertext,
                geminiai_enabled=EXCLUDED.geminiai_enabled,
                geminiai_node=EXCLUDED.geminiai_node,
                gemini_tools_enabled=EXCLUDED.gemini_tools_enabled,
                gemini_tools_node=EXCLUDED.gemini_tools_node,
                updated_at=EXCLUDED.updated_at
             RETURNING *`,
            [
                settings.subscriptionUrlCiphertext,
                settings.nodesCiphertext,
                settings.bindings.geminiai.enabled,
                settings.bindings.geminiai.node || null,
                settings.bindings.geminiTools.enabled,
                settings.bindings.geminiTools.node || null,
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
            geminiai: binding(row.geminiai_enabled, row.geminiai_node),
            geminiTools: binding(row.gemini_tools_enabled, row.gemini_tools_node),
        },
        updatedAt,
    };
}

function binding(enabled: unknown, node: unknown): MagicProxyBinding {
    const selected = text(node);
    return { enabled: enabled === true, ...(selected ? { node: selected } : {}) };
}

function text(value: unknown) {
    return typeof value === "string" ? value : "";
}

function date(value: unknown) {
    if (!value) return "";
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}
