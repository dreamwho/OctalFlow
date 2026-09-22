export const POSTGRESQL_DESKTOP_DEVICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS desktop_device_requests (
    id text PRIMARY KEY,
    device_code_hash text NOT NULL UNIQUE,
    user_code text NOT NULL UNIQUE,
    device_label text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    approved_user_id text REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    consumed_at timestamptz,
    CONSTRAINT desktop_device_requests_status CHECK (status IN ('pending', 'approved', 'consumed'))
);
CREATE INDEX IF NOT EXISTS desktop_device_requests_expiry_idx ON desktop_device_requests (expires_at);

CREATE TABLE IF NOT EXISTS desktop_device_sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label text NOT NULL,
    access_hash text NOT NULL UNIQUE,
    refresh_hash text NOT NULL UNIQUE,
    access_expires_at timestamptz NOT NULL,
    refresh_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS desktop_device_sessions_user_idx ON desktop_device_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS desktop_device_sessions_refresh_expiry_idx ON desktop_device_sessions (refresh_expires_at) WHERE revoked_at IS NULL;
`;
