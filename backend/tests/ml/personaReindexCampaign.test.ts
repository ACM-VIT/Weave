import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePersonaReindexOptions,
  personaCampaignIdempotencyKey,
} from '../../scripts/reindex-user-personas.js';

test('persona reindex campaigns are dry-run by default and require an explicit valid scope', () => {
  assert.deepEqual(parsePersonaReindexOptions(['--campaign=persona-repair-20260802']), {
    campaignId: 'persona-repair-20260802', execute: false, batchSize: 100,
  });
  assert.deepEqual(parsePersonaReindexOptions([
    '--campaign=persona-repair-20260802', '--batch-size=25', '--execute',
  ]), {
    campaignId: 'persona-repair-20260802', execute: true, batchSize: 25,
  });
  assert.throws(() => parsePersonaReindexOptions(['--execute']), /campaign/);
  assert.throws(
    () => parsePersonaReindexOptions(['--campaign=persona-repair-20260802', '--batch-size=0']),
    /batch-size/,
  );
});

test('persona campaign keys are scoped to user and profile version', () => {
  assert.equal(
    personaCampaignIdempotencyKey(
      'persona-repair-20260802',
      '00000000-0000-4000-8000-000000000001',
      7,
    ),
    'onboard:00000000-0000-4000-8000-000000000001:7:campaign:persona-repair-20260802',
  );
});
