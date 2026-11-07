CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start
  ON rate_limit_windows(window_start);
