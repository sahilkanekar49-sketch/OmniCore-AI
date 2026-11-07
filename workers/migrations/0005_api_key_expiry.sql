ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(expires_at, revoked_at);
