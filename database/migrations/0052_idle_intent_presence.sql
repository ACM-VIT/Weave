-- Give existing tabs a full registered idle interval after this upgrade.
-- This is backend presence, not a renewal of ML learned-intent lifetime.
ALTER TABLE telemetry.feed_intent_sessions ADD COLUMN last_presence_ms bigint NOT NULL
 DEFAULT floor(extract(epoch FROM clock_timestamp())*1000)::bigint CHECK(last_presence_ms>=0);
