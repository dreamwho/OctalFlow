export const POSTGRESQL_CLOUD_STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cloud_storage_settings (
    id text PRIMARY KEY DEFAULT 'default',
    default_bytes bigint NOT NULL DEFAULT 1073741824,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cloud_storage_settings_singleton CHECK (id = 'default'),
    CONSTRAINT cloud_storage_settings_default_bytes CHECK (default_bytes >= 0)
);
INSERT INTO cloud_storage_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cloud_storage_accounts (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    base_bytes bigint NOT NULL,
    bonus_bytes bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cloud_storage_accounts_base CHECK (base_bytes >= 0 AND bonus_bytes >= 0)
);

INSERT INTO cloud_storage_accounts (user_id, base_bytes)
SELECT users.id, cloud_storage_settings.default_bytes
FROM users CROSS JOIN cloud_storage_settings
WHERE cloud_storage_settings.id = 'default'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION cloud_storage_create_account() RETURNS trigger AS $$
BEGIN
    INSERT INTO cloud_storage_accounts (user_id, base_bytes)
    SELECT NEW.id, default_bytes FROM cloud_storage_settings WHERE id = 'default';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_cloud_storage_account ON users;
CREATE TRIGGER users_cloud_storage_account AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION cloud_storage_create_account();

CREATE TABLE IF NOT EXISTS cloud_storage_grants (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bytes bigint NOT NULL,
    source_order_id text REFERENCES billing_orders(id),
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cloud_storage_grants_bytes CHECK (bytes > 0),
    CONSTRAINT cloud_storage_grants_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_storage_grants_order_idx ON cloud_storage_grants (source_order_id) WHERE source_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cloud_storage_grants_user_period_idx ON cloud_storage_grants (user_id, starts_at, ends_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_storage_reservations (
    id text NOT NULL,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_key text NOT NULL,
    bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    source text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    CONSTRAINT cloud_storage_reservations_bytes CHECK (bytes > 0),
    CONSTRAINT cloud_storage_reservations_checksum CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cloud_storage_reservations_source CHECK (source IN ('asset', 'project', 'backup', 'work')),
    CONSTRAINT cloud_storage_reservations_expiry CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS cloud_storage_reservations_user_expiry_idx ON cloud_storage_reservations (user_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_storage_reservations_user_checksum_idx ON cloud_storage_reservations (user_id, checksum_sha256);

CREATE TABLE IF NOT EXISTS cloud_storage_objects (
    object_key text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    recycled_at timestamptz,
    CONSTRAINT cloud_storage_objects_bytes CHECK (bytes >= 0),
    CONSTRAINT cloud_storage_objects_checksum CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cloud_storage_objects_source CHECK (source IN ('asset', 'project', 'backup', 'work'))
);
CREATE INDEX IF NOT EXISTS cloud_storage_objects_user_source_idx ON cloud_storage_objects (user_id, source, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_storage_objects_user_checksum_idx ON cloud_storage_objects (user_id, checksum_sha256);

CREATE TABLE IF NOT EXISTS cloud_storage_object_refs (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_key text NOT NULL REFERENCES cloud_storage_objects(object_key) ON DELETE CASCADE,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cloud_storage_object_refs_source CHECK (source IN ('asset', 'project', 'backup', 'work'))
);
CREATE INDEX IF NOT EXISTS cloud_storage_object_refs_user_object_idx ON cloud_storage_object_refs (user_id, object_key, created_at);

CREATE TABLE IF NOT EXISTS cloud_storage_project_backups (
    reference_id text PRIMARY KEY REFERENCES cloud_storage_object_refs(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id text NOT NULL,
    title text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cloud_storage_project_backups_project CHECK (length(project_id) BETWEEN 1 AND 160),
    CONSTRAINT cloud_storage_project_backups_title CHECK (length(title) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS cloud_storage_project_backups_user_time_idx ON cloud_storage_project_backups (user_id, created_at DESC, reference_id DESC);
`;
