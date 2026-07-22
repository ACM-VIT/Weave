ALTER TABLE telemetry.ml_outbox
DROP CONSTRAINT IF EXISTS ml_outbox_status_check;
--> statement-breakpoint
ALTER TABLE telemetry.ml_outbox
ADD CONSTRAINT ml_outbox_status_check
CHECK (status IN ('pending','claimed','delivered','dead','superseded')) NOT VALID;
--> statement-breakpoint
ALTER TABLE telemetry.ml_outbox
VALIDATE CONSTRAINT ml_outbox_status_check;
