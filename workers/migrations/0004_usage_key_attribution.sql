ALTER TABLE usage_events ADD COLUMN api_key_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_events_api_key_created
  ON usage_events(api_key_id, created_at);
