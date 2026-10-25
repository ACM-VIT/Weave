import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { openRepositoryOnGitHub } from '../src/services/repositoryGithubOpen';
import { loadActionComponent, repository } from './fixtures/repository-action-components';
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryShareContent, buildRepositoryWebUrl, normalizePublicWebUrl, normalizeGitHubRepositoryUrl, parseRepositoryIdFromLink, repositoryHref, repositoryHrefFromLink, repositoryPath, resolveRepositoryShareUrl } from "../src/utils/repository-links";
import { shareResultConfirmsCompletion } from "../src/utils/share-feedback";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("repository links", () => {
  test('repository routes keep the raw parameter separate from the encoded path', () => {
    assert.equal(repositoryPath(' repo id '), '/repository/repo%20id');
    assert.deepEqual(repositoryHref(' repo id '), {
      pathname: '/repository/[repoId]',
      params: { repoId: 'repo id' },
    });
    assert.throws(() => repositoryPath('  '), /Repository ID is required/);
  });

  test('public web URL accepts a secure origin and rejects placeholders or path prefixes', () => {
    assert.equal(normalizePublicWebUrl('https://weave.example.com/'), 'https://weave.example.com');
    assert.equal(normalizePublicWebUrl('http://localhost:8081/'), 'http://localhost:8081');
    assert.equal(normalizePublicWebUrl('https://your-web-frontend.example'), null);
    assert.equal(normalizePublicWebUrl('http://weave.example.com'), null);
    assert.equal(normalizePublicWebUrl('https://weave.example.com/app'), null);
    assert.equal(normalizePublicWebUrl('https://weave.example.com/?from=test'), null);
    assert.equal(normalizePublicWebUrl(undefined), null);
  });

  test('configured web origin builds the canonical repository URL', () => {
    assert.equal(
      buildRepositoryWebUrl('7be6d88f', 'https://weave.example.com/'),
      'https://weave.example.com/repository/7be6d88f',
    );
    assert.equal(
      buildRepositoryWebUrl('7be6d88f', 'https://your-web-frontend.example'),
      null,
    );
  });

  test('relative, custom-scheme, Expo Go, and configured HTTPS links resolve one route', () => {
    const repoId = '7be6d88f';
    const webBaseUrl = 'https://weave.example.com';
    assert.equal(parseRepositoryIdFromLink(`/repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`ghsocial://repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`ghsocial:///repository/${repoId}`), repoId);
    assert.equal(parseRepositoryIdFromLink(`exp://127.0.0.1:8081/--/repository/${repoId}`), repoId);
    assert.equal(
      parseRepositoryIdFromLink(`${webBaseUrl}/repository/${repoId}`, webBaseUrl),
      repoId,
    );
    assert.deepEqual(repositoryHrefFromLink(`ghsocial://repository/${repoId}`), {
      pathname: '/repository/[repoId]',
      params: { repoId },
    });
  });

  test('repository link parser rejects foreign, malformed, and unconfigured web links', () => {
    assert.equal(parseRepositoryIdFromLink('https://github.com/acme/project'), null);
    assert.equal(
      parseRepositoryIdFromLink(
        'https://other.example.com/repository/7be6d88f',
        'https://weave.example.com',
      ),
      null,
    );
    assert.equal(parseRepositoryIdFromLink('https://weave.example.com/repository/7be6d88f'), null);
    assert.equal(parseRepositoryIdFromLink('ghsocial://other/repository/7be6d88f'), null);
    assert.equal(parseRepositoryIdFromLink('/repository/owner%2Frepo'), null);
    assert.equal(parseRepositoryIdFromLink('/repository/'), null);
  });

  test('share URL prefers configured web origin and otherwise requires the matching native route', () => {
    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'https://weave.example.com',
      nativeUrl: 'ghsocial://repository/7be6d88f',
    }), 'https://weave.example.com/repository/7be6d88f');

    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'https://your-web-frontend.example',
      nativeUrl: 'ghsocial://repository/7be6d88f',
    }), 'ghsocial://repository/7be6d88f');

    assert.equal(resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      webBaseUrl: 'http://localhost:8096',
      nativeUrl: 'http://localhost:8096/repository/7be6d88f',
    }), 'http://localhost:8096/repository/7be6d88f');

    assert.throws(() => resolveRepositoryShareUrl({
      repoId: '7be6d88f',
      nativeUrl: 'https://github.com/acme/project',
    }), /valid native Weave repository link/);
  });

  test('share content names Weave and uses the canonical Weave URL', () => {
    const url = 'ghsocial://repository/7be6d88f';
    assert.deepEqual(buildRepositoryShareContent('acme/project', url), {
      title: 'acme/project on Weave',
      message: `View acme/project on Weave:\n${url}`,
      url,
    });
  });
});

describe("share feedback", () => {
  test('share feedback is recorded only when iOS can distinguish completion from dismissal', () => {
    assert.equal(shareResultConfirmsCompletion('ios', 'sharedAction', 'sharedAction'), true);
    assert.equal(shareResultConfirmsCompletion('ios', 'dismissedAction', 'sharedAction'), false);
    assert.equal(shareResultConfirmsCompletion('android', 'sharedAction', 'sharedAction'), false);
    assert.equal(shareResultConfirmsCompletion('web', 'sharedAction', 'sharedAction'), false);
  });
});


test('successful GitHub opens enqueue exactly one event before flushing', async () => {
  const calls: unknown[] = [];
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    open: async url => { calls.push(url); }, token: async () => 'token',
    outbox: { enqueue: async event => { calls.push(event); }, flush: async token => { calls.push(token); } },
  }), true);
  assert.deepEqual(calls, ['https://github.com/owner/repo', { repo_id: 'repo', action: 'github_open' }, 'token']);
});

test('rejected GitHub opens never record feedback', async () => {
  const unexpected = async () => { assert.fail('No feedback or token access expected'); };
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    open: async () => { throw new Error('Rejected'); }, token: unexpected,
    outbox: { enqueue: unexpected, flush: unexpected },
  }), false);
});

test('offline feedback delivery preserves a successful open and the queued event', async () => {
  let queued = false;
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    open: async () => {}, token: async () => 'token',
    outbox: { enqueue: async () => { queued = true; }, flush: async () => { throw new Error('Offline'); } },
  }), true);
  assert.equal(queued, true);
});

test('invalid and foreign destinations never reach the opener or feedback', async () => {
  for (const url of ['url', 'javascript:alert(1)', 'http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://user@github.com/owner/repo', 'https://github.com/']) {
    let calls = 0;
    const unexpected = async () => { calls++; };
    assert.equal(await openRepositoryOnGitHub('repo', url, {
      open: unexpected, token: async () => { calls++; return 'token'; },
      outbox: { enqueue: unexpected, flush: unexpected },
    }), false, url);
    assert.equal(calls, 0, `${url} must be rejected before side effects`);
  }
});

test('the attributed completion callback waits for opening and cannot turn a successful open into failure', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const pending = openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    open: () => new Promise<void>(resolve => { finish = resolve; }),
    onOpened: async () => { calls.push('attributed'); throw new Error('Storage unavailable'); },
  });
  assert.deepEqual(calls, []);
  finish();
  assert.equal(await pending, true);
  assert.deepEqual(calls, ['attributed']);
});

test('blocked web popups expose failure and never record successful activity', async () => {
  let feedback = 0;
  let nativeCalls = 0;
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    platform: 'web', browser: { open: () => null },
    open: async () => { nativeCalls++; },
    onOpened: () => { feedback++; },
  }), false);
  assert.equal(feedback, 0);
  assert.equal(nativeCalls, 0, 'Web must not use RN Web Linking, which ignores popup failure');
});

test('web opens synchronously isolate the new tab before navigating and acknowledging it', async () => {
  const calls: string[] = [];
  const tab = {
    set opener(value: unknown) { assert.equal(value, null); calls.push('isolated'); },
    location: { replace: (url: string) => { calls.push(url); } },
    close: () => { calls.push('closed'); },
  };
  const pending = openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    platform: 'web', browser: { open: (url: string, target: string) => {
      assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); calls.push('opened'); return tab;
    } },
    open: async () => assert.fail('Native opener not expected'),
    onOpened: () => { calls.push('feedback'); },
  });
  assert.deepEqual(calls.slice(0, 3), ['opened', 'isolated', 'https://github.com/owner/repo']);
  assert.equal(await pending, true);
  assert.deepEqual(calls, ['opened', 'isolated', 'https://github.com/owner/repo', 'feedback']);
});

test('web navigation rejection closes the blank tab without acknowledging success', async () => {
  const calls: string[] = [];
  assert.equal(await openRepositoryOnGitHub('repo', 'https://github.com/owner/repo', {
    platform: 'web', browser: { open: () => ({ opener: null,
      location: { replace: () => { throw new Error('Navigation blocked'); } },
      close: () => { calls.push('closed'); },
    }) },
    open: async () => assert.fail('Native opener not expected'),
    onOpened: () => assert.fail('Failed navigation must not record activity'),
  }), false);
  assert.deepEqual(calls, ['closed']);
});

for (const surface of ['feed', 'detail', 'share'] as const) {
  test(`${surface} shows an opening error without feedback, then clears it on successful retry`, async () => {
    let recorded = 0, opens = 0;
    let reject = true;
    const overrides = {
      native: { Linking: { openURL: async () => { opens++; if (reject) throw new Error('OS refused'); } } },
      '@/services/activityOutboxClient': { queueActivityForViewer: async () => { recorded++; } },
    };
    const path = surface === 'feed' ? 'src/components/home/RepositoryScreen.tsx'
      : surface === 'detail' ? 'src/components/repository-detail-screen.tsx'
        : 'src/components/home/share-repository-sheet.tsx';
    const exports = loadActionComponent(path, overrides);
    const Component = exports.RepositoryScreen ?? exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
    const props = surface === 'feed'
      ? { repository, pageWidth: 320, pageHeight: 568, onReadFullPress() {}, onSavePress() {}, onSharePress() {}, onCommentPress() {}, onQueueActivity: () => { recorded++; } }
      : surface === 'detail' ? { repositoryId: 'repo' }
        : { repositoryId: 'repo', repositoryDetails: repository, isVisible: true, onClose() {}, onGithubOpened: () => { recorded++; } };
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Component, props)); });
    try {
      await act(async () => {
        root.root.findAllByType('Pressable').find(node => /Open.*GitHub/.test(node.props.accessibilityLabel ?? ''))!.props.onPress();
        await new Promise(resolve => setImmediate(resolve));
      });
      assert.equal(opens, 1);
      assert.equal(recorded, 0);
      const alerts = root.root.findAll(node => node.props.accessibilityRole === 'alert');
      assert.equal(alerts.length, 1, 'opening failure must be visible on web as well as native');
      assert.match(alerts[0].findAllByType('Text').map(node => node.children.join('')).join(' ') || alerts[0].children.join(' '), /Unable to open GitHub/);
      reject = false;
      await act(async () => {
        root.root.findAllByType('Pressable').find(node => /Open.*GitHub/.test(node.props.accessibilityLabel ?? ''))!.props.onPress();
        await new Promise(resolve => setImmediate(resolve));
      });
      assert.equal(opens, 2);
      assert.equal(recorded, 1);
      assert.equal(root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 0, 'a successful retry clears the prior failure');
    } finally { await act(async () => root.unmount()); }
  });
}

for (const surface of ['feed', 'detail', 'share'] as const) {
  test(`${surface} preserves the native Linking receiver and records only after it resolves`, async () => {
    const calls: string[] = [];
    const overrides = {
      native: { Linking: { marker: 'linking', async openURL(this: { marker?: string }) {
        if (this.marker !== 'linking') throw new Error('Native Linking lost its receiver');
        calls.push('opened');
      } } },
      '@/services/activityOutboxClient': { queueActivityForViewer: async () => { calls.push('recorded'); } },
    };
    const path = surface === 'feed' ? 'src/components/home/RepositoryScreen.tsx'
      : surface === 'detail' ? 'src/components/repository-detail-screen.tsx'
        : 'src/components/home/share-repository-sheet.tsx';
    const exports = loadActionComponent(path, overrides);
    const Component = exports.RepositoryScreen ?? exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
    const props = surface === 'feed'
      ? { repository, pageWidth: 320, pageHeight: 568, onReadFullPress() {}, onSavePress() {}, onSharePress() {}, onCommentPress() {}, onQueueActivity: () => { calls.push('recorded'); } }
      : surface === 'detail' ? { repositoryId: 'repo' }
        : { repositoryId: 'repo', repositoryDetails: repository, isVisible: true, onClose() {}, onGithubOpened: () => { calls.push('recorded'); } };
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Component, props)); });
    try {
      await act(async () => {
        root.root.findAllByType('Pressable').find(node => /Open.*GitHub/.test(node.props.accessibilityLabel ?? ''))!.props.onPress();
        await new Promise(resolve => setImmediate(resolve));
      });
      assert.deepEqual(calls, ['opened', 'recorded']);
    } finally { await act(async () => root.unmount()); }
  });
}

test('all external-action surfaces expose blocked web popups without using native Linking', async () => {
  const previous = (globalThis as any).window;
  let nativeOpens = 0, feedback = 0, popupAttempts = 0;
  (globalThis as any).window = { location: { origin: 'https://weave.test' }, open: () => { popupAttempts++; return null; } };
  try {
    for (const surface of ['feed', 'detail', 'share'] as const) {
      const exports = loadActionComponent(surface === 'feed' ? 'src/components/home/RepositoryScreen.tsx'
        : surface === 'detail' ? 'src/components/repository-detail-screen.tsx' : 'src/components/home/share-repository-sheet.tsx', {
        native: { Platform: { OS: 'web' }, Linking: { openURL: async () => { nativeOpens++; } } },
        '@/services/activityOutboxClient': { queueActivityForViewer: async () => { feedback++; } },
      });
      const Component = exports.RepositoryScreen ?? exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
      const props = surface === 'feed'
        ? { repository, pageWidth: 320, pageHeight: 568, onReadFullPress() {}, onSavePress() {}, onSharePress() {}, onCommentPress() {}, onQueueActivity: () => { feedback++; } }
        : surface === 'detail' ? { repositoryId: 'repo' }
          : { repositoryId: 'repo', repositoryDetails: repository, isVisible: true, onClose() {}, onGithubOpened: () => { feedback++; } };
      let root!: ReturnType<typeof create>;
      await act(async () => { root = create(React.createElement(Component, props)); });
      try {
        await act(async () => {
          root.root.findAllByType('Pressable').find(node => /Open.*GitHub/.test(node.props.accessibilityLabel ?? ''))!.props.onPress();
          await new Promise(resolve => setImmediate(resolve));
        });
        assert.equal(root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 1, surface);
      } finally { await act(async () => root.unmount()); }
    }
    assert.equal(popupAttempts, 3);
    assert.equal(nativeOpens, 0);
    assert.equal(feedback, 0);
  } finally {
    if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous;
  }
});

test('feed opening failure uses an active-row modal with dismiss and retry instead of the covered page header', async () => {
  let reject = true, recorded = 0;
  const { RepositoryScreen } = loadActionComponent('src/components/home/RepositoryScreen.tsx', {
    native: { Linking: { openURL: async () => { if (reject) throw new Error('OS refused'); } } },
  });
  const props = { repository, pageWidth: 320, pageHeight: 568, isActive: true,
    onReadFullPress() {}, onSavePress() {}, onSharePress() {}, onCommentPress() {}, onQueueActivity: () => { recorded++; } };
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(RepositoryScreen, props)); });
  const press = async (label: string) => act(async () => {
    root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!.props.onPress();
    await new Promise(resolve => setImmediate(resolve));
  });
  try {
    await press('Open repository on GitHub');
    const modal = root.root.findAllByType('Modal');
    assert.equal(modal.length, 1, 'error needs an app-level surface, not the row beneath FeedHeader');
    assert.equal(modal[0].findAll(node => node.props.accessibilityRole === 'alert').length, 1);
    await act(async () => modal[0].props.onRequestClose());
    assert.equal(root.root.findAllByType('Modal').length, 0);
    await press('Open repository on GitHub');
    await act(async () => root.update(React.createElement(RepositoryScreen, { ...props, isActive: false })));
    assert.equal(root.root.findAllByType('Modal').length, 0, 'an offscreen feed row must not own an app modal');
    await act(async () => root.update(React.createElement(RepositoryScreen, props)));
    reject = false;
    await press('Retry opening GitHub');
    assert.equal(root.root.findAllByType('Modal').length, 0);
    assert.equal(recorded, 1);
  } finally { await act(async () => root.unmount()); }
});


function text(root: ReturnType<typeof create>) {
  return root.root.findAllByType('Text').map(node => node.children.join('')).join('\n');
}

async function shareFixture(platform: string, share: () => Promise<unknown>, clipboard = async () => true) {
  const { ShareRepositorySheet } = loadActionComponent('src/components/home/share-repository-sheet.tsx', {
    native: { Platform: { OS: platform }, Share: { share, sharedAction: 'sharedAction' } },
    'expo-clipboard': { setStringAsync: clipboard },
  });
  let shared = 0;
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(ShareRepositorySheet, {
    isVisible: true, onClose() {}, repositoryId: 'repo', repositoryDetails: repository,
    onShared: () => { shared++; },
  })); });
  return { root, shared: () => shared, press: async (label: string) => {
    await act(async () => {
      root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label)!.props.onPress();
      await new Promise(resolve => setImmediate(resolve));
    });
  }, close: async () => {
    await act(async () => root.unmount());
  } };
}

test('web share resolving without an action is not an error or confirmed share', async () => {
  const fixture = await shareFixture('web', async () => undefined);
  try {
    await fixture.press('Share Weave repository link');
    assert.equal(fixture.shared(), 0);
    assert.doesNotMatch(text(fixture.root), /Cannot read|Unable to share/);
    assert.equal(fixture.root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 0);
  } finally { await fixture.close(); }
});

test('web share cancellation is quiet and does not acknowledge a share', async () => {
  const fixture = await shareFixture('web', async () => { throw Object.assign(new Error('User canceled share'), { name: 'AbortError' }); });
  try {
    await fixture.press('Share Weave repository link');
    assert.equal(fixture.shared(), 0);
    assert.doesNotMatch(text(fixture.root), /User canceled share|Unable to share/);
  } finally { await fixture.close(); }
});

test('iOS completion alone acknowledges sharing; dismissal and Android chooser never do', async () => {
  for (const [platform, action, expected] of [['ios', 'sharedAction', 1], ['ios', 'dismissedAction', 0], ['android', 'sharedAction', 0]] as const) {
    const fixture = await shareFixture(platform, async () => ({ action }));
    try { await fixture.press('Share Weave repository link'); assert.equal(fixture.shared(), expected); }
    finally { await fixture.close(); }
  }
});

test('share retry clears an earlier failure without falsely confirming dismissal', async () => {
  for (const [platform, outcome, expectedShares] of [
    ['ios', 'sharedAction', 1], ['ios', 'dismissedAction', 0], ['web', 'cancel', 0],
  ] as const) {
    let attempts = 0, finish!: () => void;
    const fixture = await shareFixture(platform, async () => {
      attempts++;
      if (attempts === 1) throw new Error('Unable to share the Weave link.');
      await new Promise<void>(resolve => { finish = resolve; });
      if (outcome === 'cancel') throw Object.assign(new Error('User canceled share'), { name: 'AbortError' });
      return { action: outcome };
    });
    try {
      await fixture.press('Share Weave repository link');
      assert.match(text(fixture.root), /Unable to share the Weave link/);
      assert.equal(fixture.shared(), 0);
      await fixture.press('Share Weave repository link');
      assert.equal(fixture.root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 0,
        'the old failure is cleared as soon as an explicit retry starts');
      await act(async () => { finish(); });
      assert.equal(fixture.shared(), expectedShares);
      assert.doesNotMatch(text(fixture.root), /Unable to share|User canceled share/);
    } finally { await fixture.close(); }
  }
});

test('copy rejection displays an error without success feedback', async () => {
  const fixture = await shareFixture('ios', async () => ({ action: 'dismissedAction' }), async () => false);
  try {
    await fixture.press('Copy Weave repository link');
    assert.equal(fixture.shared(), 0);
    assert.match(text(fixture.root), /Unable to copy the Weave link/);
    assert.equal(fixture.root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 1);
  } finally { await fixture.close(); }
});

test('LoginInput composes focus callbacks while presenting and clearing its focused state', async () => {
  const { default: LoginInput } = loadActionComponent('src/components/Auth/LoginInput.tsx');
  const calls: unknown[] = [];
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(LoginInput, {
    placeholder: 'Email', onFocus: (event: unknown) => calls.push(event), onBlur: (event: unknown) => calls.push(event),
  })); });
  try {
    const focus = { nativeEvent: { text: 'email' } }, blur = { nativeEvent: { text: 'email' } };
    const wrapper = () => root.root.findByType('View');
    const initial = JSON.stringify(wrapper().props.style);
    await act(async () => root.root.findByType('TextInput').props.onFocus(focus));
    assert.notEqual(JSON.stringify(wrapper().props.style), initial, 'focusing must visibly change the wrapper state');
    await act(async () => root.root.findByType('TextInput').props.onBlur(blur));
    assert.equal(JSON.stringify(wrapper().props.style), initial);
    assert.deepEqual(calls, [focus, blur]);
  } finally { await act(async () => root.unmount()); }
});

test('share failures stay available outside action scrolling until dismissed', async t => {
  const fixture = await shareFixture('ios', async () => ({ action: 'dismissedAction' }), async () => false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fixture.press('Copy Weave repository link');
    await act(async () => t.mock.timers.tick(3000));
    const alerts = fixture.root.root.findAll(node => node.props.accessibilityRole === 'alert');
    assert.equal(alerts.length, 1, 'failure must not disappear before a user can read it');
    assert.equal(fixture.root.root.findAllByType('ScrollView').some(scroll => scroll.findAll(node => node.props.accessibilityRole === 'alert').length > 0), false,
      'status must not be appended below offscreen actions');
    await fixture.press('Dismiss share status');
    assert.equal(fixture.root.root.findAll(node => node.props.accessibilityRole === 'alert').length, 0);
    assert.equal(fixture.shared(), 0);
  } finally { await fixture.close(); t.mock.timers.reset(); }
});


test('GitHub destinations require a secure exact host and a repository path', () => {
  assert.equal(normalizeGitHubRepositoryUrl(' https://GitHub.com/owner/repo '), 'https://github.com/owner/repo');
  assert.equal(normalizeGitHubRepositoryUrl('https://github.com/owner/repo?tab=readme-ov-file#readme'), 'https://github.com/owner/repo?tab=readme-ov-file#readme');
  for (const value of [undefined, '', '/owner/repo', 'https://github.com/', 'https://github.com/owner', 'http://github.com/owner/repo', 'javascript:alert(1)', 'https://github.com.evil.test/owner/repo', 'https://user:pass@github.com/owner/repo', 'https://github.com:8080/owner/repo', 'https://github.com/owner%2Frepo/other']) {
    assert.equal(normalizeGitHubRepositoryUrl(value), null, String(value));
  }
});


test('the visible repository Back control uses existing history and falls back only without it', async () => {
  const { loadActionComponent } = await import('./fixtures/repository-action-components');
  for (const hasHistory of [true, false]) {
    const calls: string[] = [];
    const { RepositoryDetailScreen } = loadActionComponent('src/components/repository-detail-screen.tsx', {
      'expo-router': { router: {
        canGoBack: () => hasHistory,
        back: () => calls.push('back'),
        replace: (route: string) => calls.push(`replace:${route}`),
      } },
    });
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(RepositoryDetailScreen, { repositoryId: 'repo' })); });
    try {
      await act(async () => root.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === 'Back')!.props.onPress());
      assert.deepEqual(calls, [hasHistory ? 'back' : 'replace:/(tabs)/home']);
    } finally { await act(async () => root.unmount()); }
  }
});
