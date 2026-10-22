-- A delivered onboarding row is also the durable prewarm record. Preserve its
-- delivery availability before reusing available_at as a native, indexable
-- prewarm ready time / claim-expiry deadline. This also repairs metadata from
-- an earlier draft if present; stop old prewarm workers before this transition.
UPDATE telemetry.ml_outbox
SET response_payload=jsonb_set(response_payload,'{backend_onboarding_prewarm}',
      (response_payload->'backend_onboarding_prewarm') || jsonb_build_object(
        'delivery_available_at',COALESCE(
          response_payload #> '{backend_onboarding_prewarm,delivery_available_at}',
          to_jsonb(available_at)
        )
      )),
    available_at=CASE
      WHEN response_payload #>> '{backend_onboarding_prewarm,status}'='claimed'
        THEN COALESCE((response_payload #>> '{backend_onboarding_prewarm,claimed_at}')::timestamptz,
          delivered_at,now())+interval '5 minutes'
      ELSE COALESCE((response_payload #>> '{backend_onboarding_prewarm,available_at}')::timestamptz,
        delivered_at,now())
    END
WHERE job_type='onboard' AND status='delivered'
  AND response_payload #>> '{backend_onboarding_prewarm,status}' IN ('pending','claimed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ml_outbox_onboarding_prewarm_ready_idx
ON telemetry.ml_outbox (available_at,outbox_id)
WHERE job_type='onboard' AND status='delivered'
  AND response_payload #>> '{backend_onboarding_prewarm,status}' IN ('pending','claimed');
