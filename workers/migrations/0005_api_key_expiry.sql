ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
UPDATE api_keys SET expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(expires_at, revoked_at);
