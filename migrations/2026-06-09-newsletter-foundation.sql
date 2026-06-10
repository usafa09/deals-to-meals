-- Newsletter pipeline foundation
-- Run manually in Supabase SQL Editor. Do not auto-execute.

-- 1. Add unsubscribe column to email_subscribers
ALTER TABLE email_subscribers
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ NULL;

-- Partial index speeds up the WHERE unsubscribed_at IS NULL filter used at send time
CREATE INDEX IF NOT EXISTS idx_email_subscribers_active
  ON email_subscribers (id)
  WHERE unsubscribed_at IS NULL;

-- 2. Create sent_emails audit table
CREATE TABLE IF NOT EXISTS sent_emails (
  id BIGSERIAL PRIMARY KEY,
  subscriber_id UUID NOT NULL REFERENCES email_subscribers(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  resend_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sent_emails_subscriber ON sent_emails (subscriber_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_sent_at_desc ON sent_emails (sent_at DESC);

-- 3. Lock down sent_emails. service_role bypasses RLS automatically; no policies needed.
ALTER TABLE sent_emails ENABLE ROW LEVEL SECURITY;
