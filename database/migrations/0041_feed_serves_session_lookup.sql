-- Delivery membership and final overlap checks must seek one viewer/session,
-- rather than filtering every historical serve for that viewer on each page.
-- This transactional build can block writes; apply before the new read path rolls out.
CREATE INDEX IF NOT EXISTS feed_serves_user_session_idx
  ON telemetry.feed_serves (user_id, session_id);
