import assert from 'node:assert/strict';
import test from 'node:test';

import type { InteractionEventV2 } from '../../contracts/interactions.v2.js';
import { isMembershipManagedSaveEvent } from '../../services/activityV2Service.js';
import {
  diffListMemberships,
  productListId,
} from '../../services/repositoryMembershipService.js';
import { hasAnyRepositoryMembership } from '../../services/savedRepositoryService.js';

test('List synchronization changes only the membership set difference', () => {
  assert.deepEqual(
    diffListMemberships(['list-a', 'list-b'], ['list-b', 'list-c']),
    { added: ['list-c'], removed: ['list-a'] },
  );
  assert.deepEqual(
    diffListMemberships(['list-a', 'list-b'], ['list-a', 'list-b']),
    { added: [], removed: [] },
  );
});

test('saved union survives partial List removal and clears after the final membership', () => {
  assert.equal(hasAnyRepositoryMembership(true, false), true);
  assert.equal(hasAnyRepositoryMembership(false, false), false);
});

test('legacy board membership remains part of the saved union', () => {
  assert.equal(hasAnyRepositoryMembership(false, true), true);
  assert.equal(hasAnyRepositoryMembership(false, false), false);
});

test('product List IDs preserve the backing membership source', () => {
  assert.equal(productListId('collection', 'list-a'), 'collection:list-a');
  assert.equal(productListId('legacy-board', 'list-a'), 'legacy-board:list-a');
});

test('membership-origin save telemetry is classified as state-neutral', () => {
  const base: InteractionEventV2 = {
    event_id: '00000000-0000-4000-8000-000000000001',
    schema_version: 2,
    session_id: '00000000-0000-4000-8000-000000000002',
    serve_id: null,
    repo_id: '00000000-0000-4000-8000-000000000003',
    position: null,
    event_type: 'save',
    dwell_ms: null,
    client_occurred_at: '2026-08-09T00:00:00.000Z',
    context: {},
  };

  assert.equal(isMembershipManagedSaveEvent(base), false);
  assert.equal(isMembershipManagedSaveEvent({
    ...base,
    context: { save_state_source: 'list_membership' },
  }), true);
  assert.equal(isMembershipManagedSaveEvent({
    ...base,
    event_type: 'like',
    context: { save_state_source: 'list_membership' },
  }), false);
});
