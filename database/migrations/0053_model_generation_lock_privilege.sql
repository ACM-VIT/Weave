-- PostgreSQL row-locking SELECT requires UPDATE on at least one column.
-- Permit only inert creation metadata, not context, expiry, ownership or IDs.
GRANT UPDATE(created_at) ON telemetry.feed_model_generations TO ghsocial_backend;
