-- Publication repair probes immutable captured generation identity, including
-- generations with no completed attempt or serve of their own. Avoid rescanning
-- every older exposure belonging to the same user on each repair pass.
CREATE INDEX feed_item_provenance_generation_owner_idx
  ON telemetry.feed_item_provenance(generation_id,user_id)
  WHERE capture_status='captured';
