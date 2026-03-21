-- Run this in Supabase SQL Editor (supabase.com → your project → SQL Editor)

CREATE TABLE IF NOT EXISTS deal_cache (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,
  data JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_deal_cache_key ON deal_cache (cache_key);
CREATE INDEX IF NOT EXISTS idx_deal_cache_fetched ON deal_cache (fetched_at);

-- Allow the service key to read/write
ALTER TABLE deal_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON deal_cache
  FOR ALL USING (true) WITH CHECK (true);
