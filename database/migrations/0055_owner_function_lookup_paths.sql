-- Resolve built-in relation/type names before any caller-owned temporary
-- namespace. Keep prior migration bytes and the immutable journals intact.
ALTER FUNCTION telemetry.prune_runtime_history(integer,integer)
  SET search_path=pg_catalog,pg_temp;
--> statement-breakpoint
ALTER FUNCTION telemetry.prune_model_transients(integer)
  SET search_path=pg_catalog,pg_temp;
--> statement-breakpoint
ALTER FUNCTION private_scoring.purge_scoring_private(integer)
  SET search_path=pg_catalog,pg_temp;
--> statement-breakpoint
-- The capture/export functions share the same owner-run lookup boundary.
ALTER FUNCTION private_scoring.persist_generation(text)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.validate_feed_item_provenance()
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.record_generation_witness(uuid,uuid,text)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.reconcile_publication_witnesses(uuid[],integer)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.enforce_subject_capture_barrier()
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.create_export_snapshot(uuid,uuid,timestamptz,timestamptz,text)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.seal_export_labels(uuid,uuid,text,text)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.read_export_snapshot(uuid,uuid,text,integer,integer)
  SET search_path=pg_catalog,pg_temp;
ALTER FUNCTION private_scoring.revoke_subject_capture(uuid,uuid,text)
  SET search_path=pg_catalog,pg_temp;
