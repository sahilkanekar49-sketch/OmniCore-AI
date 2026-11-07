CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(revoked_at, key_hash);

CREATE TABLE IF NOT EXISTS provider_circuits (
  provider TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL DEFAULT 0,
  opened_until INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
