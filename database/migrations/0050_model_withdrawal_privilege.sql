-- The product role may attest consent withdrawal without rewriting frozen
-- accepted operation bytes or their identity/digests.
GRANT UPDATE(withdrawal_json) ON telemetry.ml_outbox TO ghsocial_backend;
