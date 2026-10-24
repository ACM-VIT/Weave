import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { act } from "react";
import { deferred, type Viewer, startup } from "./support/startup-harness";

test('confirming one rapid like preserves the other queued count across refreshes', async () => {
  const viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true, likes_given_count: 0 };
  const app = startup({ viewer });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
    await act(async () => {
      app.auth.adjustLikesGivenCount('first', 1);
      app.auth.adjustLikesGivenCount('second', 1);
    });
    assert.equal(app.auth.user?.likes_given_count, 2);
    await act(async () => { app.auth.settleLikesGivenCountAdjustments(['first']); });
    app.setProfileRequest(Promise.resolve({ ...viewer, likes_given_count: 1 }));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    assert.equal(app.auth.user?.likes_given_count, 2, 'first confirmation must not consume the queued second like');
    // A repeated confirmation must not advance the baseline twice.
    await act(async () => {
      app.auth.settleLikesGivenCountAdjustments(['first']);
      await app.auth.checkOnboardingStatus();
    });
    assert.equal(app.auth.user?.likes_given_count, 2);
    // A profile can observe the second commit before its upload response.
    app.setProfileRequest(Promise.resolve({ ...viewer, likes_given_count: 2 }));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    assert.equal(app.auth.user?.likes_given_count, 2);
    await act(async () => {
      app.auth.settleLikesGivenCountAdjustments(['second']);
      await app.auth.checkOnboardingStatus();
    });
    assert.equal(app.auth.user?.likes_given_count, 2);
  } finally { await app.unmount(); }
});

test('a delayed profile read cannot consume a queued unlike or overwrite a later count', async () => {
  const viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true, likes_given_count: 10 };
  const app = startup({ viewer });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
    const old = deferred<Viewer>();
    app.setProfileRequest(old.promise);
    let oldRead!: Promise<void>;
    await act(async () => { oldRead = app.auth.checkOnboardingStatus(); });
    await act(async () => {
      app.auth.adjustLikesGivenCount('like', 1);
      app.auth.adjustLikesGivenCount('unlike', -1);
      app.auth.settleLikesGivenCountAdjustments(['like']);
    });
    await act(async () => { old.resolve(viewer); await oldRead; });
    app.setProfileRequest(Promise.resolve({ ...viewer, likes_given_count: 11 }));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    assert.equal(app.auth.user?.likes_given_count, 10, 'queued unlike must survive an old response');
    const older = deferred<Viewer>();
    app.setProfileRequest(older.promise);
    await act(async () => { oldRead = app.auth.checkOnboardingStatus(); });
    await act(async () => { app.auth.settleLikesGivenCountAdjustments(['unlike']); });
    app.setProfileRequest(Promise.resolve(viewer));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    await act(async () => { older.resolve({ ...viewer, likes_given_count: 11 }); await oldRead; });
    assert.equal(app.auth.user?.likes_given_count, 10, 'late response must not replace the settled count');
  } finally { await app.unmount(); }
});

test('a newer failed read cannot block a successful count refresh after reactions settle', async () => {
  const viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true, likes_given_count: 10 };
  const app = startup({ viewer });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
    await act(async () => {
      app.auth.adjustLikesGivenCount('stale-like', 1);
      app.auth.settleLikesGivenCountAdjustments(['stale-like']);
    });
    assert.equal(app.auth.user?.likes_given_count, 11);
    const first = deferred<Viewer>();
    const second = deferred<Viewer>();
    let firstRead!: Promise<void>;
    let secondRead!: Promise<void>;
    app.setProfileRequest(first.promise);
    await act(async () => { firstRead = app.auth.checkOnboardingStatus(); });
    app.setProfileRequest(second.promise);
    await act(async () => { secondRead = app.auth.checkOnboardingStatus(); });
    // The first response succeeds while the newer request remains in flight.
    await act(async () => { first.resolve(viewer); await firstRead; });
    assert.equal(app.auth.user?.likes_given_count, 10);
    await act(async () => {
      const rejected = assert.rejects(secondRead, /offline/);
      second.reject(new Error('offline'));
      await rejected;
    });
    assert.equal(app.auth.user?.likes_given_count, 10);
  } finally { await app.unmount(); }
});

test('accepted no-op likes do not fabricate count changes or retire another queued event', async () => {
  const viewer = { user_id: 'alice', username: 'alice', onboarding_completed: true, likes_given_count: 10 };
  const app = startup({ viewer });
  await app.mount();
  try {
    await act(async () => { app.session.resolve('stored-token'); app.fonts.resolve(); });
    await act(async () => {
      app.auth.adjustLikesGivenCount('stale-like', 1);
      app.auth.adjustLikesGivenCount('unlike', -1);
      app.auth.settleLikesGivenCountAdjustments(['stale-like']);
      await app.auth.checkOnboardingStatus();
    });
    // The aggregate count gives no evidence of which event changed a reaction.
    // It must not clear the outstanding unlike while the queue is still active.
    app.setProfileRequest(Promise.resolve({ ...viewer, likes_given_count: 11 }));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    assert.equal(app.auth.user?.likes_given_count, 10);
    await act(async () => { app.auth.settleLikesGivenCountAdjustments(['unlike']); });
    app.setProfileRequest(Promise.resolve({ ...viewer, likes_given_count: 9 }));
    await act(async () => { await app.auth.checkOnboardingStatus(); });
    assert.equal(app.auth.user?.likes_given_count, 9, 'settled server count corrects a stale feed estimate');
  } finally { await app.unmount(); }
});
