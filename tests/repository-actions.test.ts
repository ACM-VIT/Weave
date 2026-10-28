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

for (const surface of ['detail', 'share'] as const) {
  test(`${surface} shows an opening error without feedback, then clears it on successful retry`, async () => {
    let recorded = 0, opens = 0;
    let reject = true;
    const overrides = {
      native: { Linking: { openURL: async () => { opens++; if (reject) throw new Error('OS refused'); } } },
      '@/services/activityOutboxClient': { queueActivityForViewer: async () => { recorded++; } },
    };
    const path = surface === 'detail' ? 'src/components/repository-detail-screen.tsx'
        : 'src/components/home/share-repository-sheet.tsx';
    const exports = loadActionComponent(path, overrides);
    const Component = exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
    const props = surface === 'detail' ? { repositoryId: 'repo' }
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

for (const surface of ['detail', 'share'] as const) {
  test(`${surface} preserves the native Linking receiver and records only after it resolves`, async () => {
    const calls: string[] = [];
    const overrides = {
      native: { Linking: { marker: 'linking', async openURL(this: { marker?: string }) {
        if (this.marker !== 'linking') throw new Error('Native Linking lost its receiver');
        calls.push('opened');
      } } },
      '@/services/activityOutboxClient': { queueActivityForViewer: async () => { calls.push('recorded'); } },
    };
    const path = surface === 'detail' ? 'src/components/repository-detail-screen.tsx'
        : 'src/components/home/share-repository-sheet.tsx';
    const exports = loadActionComponent(path, overrides);
    const Component = exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
    const props = surface === 'detail' ? { repositoryId: 'repo' }
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
    for (const surface of ['detail', 'share'] as const) {
      const exports = loadActionComponent(surface === 'detail' ? 'src/components/repository-detail-screen.tsx' : 'src/components/home/share-repository-sheet.tsx', {
        native: { Platform: { OS: 'web' }, Linking: { openURL: async () => { nativeOpens++; } } },
        '@/services/activityOutboxClient': { queueActivityForViewer: async () => { feedback++; } },
      });
      const Component = exports.RepositoryDetailScreen ?? exports.ShareRepositorySheet;
      const props = surface === 'detail' ? { repositoryId: 'repo' }
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
    assert.equal(popupAttempts, 2);
    assert.equal(nativeOpens, 0);
    assert.equal(feedback, 0);
  } finally {
    if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous;
  }
});

test('feed actions retain share, comments and swipe saving without redundant Save or GitHub buttons',async()=>{
  const {RepositoryScreen}=loadActionComponent('src/components/home/RepositoryScreen.tsx');
  let shared=0;
  let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(RepositoryScreen,{repository,pageWidth:390,pageHeight:800,
    onReadFullPress(){},onSavePress(){},onSharePress(){shared++;},onCommentPress(){}}));});
  try {
    const labels=root.root.findAllByType('Pressable').map(node=>node.props.accessibilityLabel);
    assert.ok(!labels.includes('Save repository'));
    assert.ok(!labels.includes('Open repository on GitHub'));
    assert.ok(labels.includes('Open comments'));
    await act(async()=>root.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel==='Share repository')!.props.onPress());
    assert.equal(shared,1);
    assert.equal(root.root.findAllByProps({testID:'recommendation-reason'}).length,0);
  }finally{await act(async()=>root.unmount());}
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

test('repository previews show immediately without marking incomplete details fresh or leaking attribution/accounts', async () => {
  const {QueryClient,QueryObserver}=await import('@tanstack/react-query');
  const {rememberRepositoryPreview,repositoryPreview}=await import('../src/services/repositoryPreview');
  const {mapRepositoryDetail}=await import('../src/utils/repository-mapper');
  const {repositoryDetailQueryKey}=await import('../src/models/repository');
  const client=new QueryClient();
  const card=mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',name:'repo',owner:'owner',status:'active',url:'https://github.com/owner/repo',serve_id:'serve',position:2});
  assert.ok(card);
  rememberRepositoryPreview(client,'alice',card);
  assert.equal(repositoryPreview(client,'bob','repo'),undefined);
  assert.equal(repositoryPreview(client,'alice','repo')?.serveId,null);
  assert.equal(repositoryPreview(client,'alice','repo')?.feedPosition,null);
  let resolve!: (value:typeof card)=>void;
  const pending=new Promise<typeof card>(done=>{resolve=done;});
  const key=repositoryDetailQueryKey('repo','alice');
  const observer=new QueryObserver(client,{queryKey:key,queryFn:()=>pending,
    placeholderData:()=>repositoryPreview(client,'alice','repo'),retry:false});
  const unsubscribe=observer.subscribe(()=>{});
  try {
    assert.equal(observer.getCurrentResult().isPlaceholderData,true);
    assert.equal(observer.getCurrentResult().data?.name,'repo');
    assert.equal(client.getQueryData(key),undefined,'Partial card is not persisted as a complete detail response');
    resolve({...card,description:'fresh detail',viewerSaved:true});
    await pending; await new Promise(done=>setTimeout(done,0));
    assert.equal(observer.getCurrentResult().isPlaceholderData,false);
    assert.equal(observer.getCurrentResult().data?.description,'fresh detail');
    rememberRepositoryPreview(client,'alice',card);
    assert.equal(observer.getCurrentResult().data?.viewerSaved,true,'Old card cannot overwrite authoritative detail');
    for(let i=0;i<110;i++) rememberRepositoryPreview(client,'alice',{...card,id:String(i)});
    assert.equal(client.getQueryCache().findAll({queryKey:['repository-preview','alice']}).length,100);
    client.clear();
    assert.equal(repositoryPreview(client,'alice','109'),undefined);
  } finally {unsubscribe();client.clear();}
});

for (const saved of [true, false]) test(`confirmed preview membership ${saved} survives a delayed pre-save detail without crossing accounts`, async () => {
  const React=await import('react');
  const {act}=React;
  const {create}=await import('react-test-renderer');
  const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
  const {loadSource}=await import('./support/startup-harness');
  const {rememberRepositoryPreview}=await import('../src/services/repositoryPreview');
  const {mapRepositoryDetail}=await import('../src/utils/repository-mapper');
  const {repositoryMetadataQueryKey:repositoryDetailQueryKey}=await import('../src/models/repository');
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  let viewer='alice';
  const card=mapRepositoryDetail({repo_id:'repo',full_name:'owner/repo',name:'repo',status:'active',url:'https://github.com/owner/repo'});
  assert.ok(card);rememberRepositoryPreview(client,viewer,card);rememberRepositoryPreview(client,'bob',card);
  let finish!:(value:typeof card)=>void;
  const pending=new Promise<typeof card>(resolve=>{finish=resolve;});
  let finishBob!:(value:typeof card)=>void;
  const bobPending=new Promise<typeof card>(resolve=>{finishBob=resolve;});
  let aliceRequests=0;
  const icon=()=>null;
  const {RepositoryDetailScreen}=loadSource('src/components/repository-detail-screen.tsx',{
    '@tanstack/react-query':await import('@tanstack/react-query'),
    'react-native':{ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',
      StyleSheet:{create:(value:unknown)=>value},useWindowDimensions:()=>({width:400})},
    'expo-router':{router:{}},'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
    'lucide-react-native':new Proxy({},{get:()=>icon}),
    '@/constants/theme':{REFERENCE_THEME:{}},'@/store/AuthContext':{useAuth:()=>({user:{user_id:viewer},isLoading:false})},
    '@/api/repositories':{repositoryDetailQueryKey,repositoryMetadataQueryKey:repositoryDetailQueryKey,fetchRepositoryMetadata:()=>viewer==='alice'?(aliceRequests++===0?pending:Promise.resolve({...card,viewerSaved:!saved,selectedListIds:[]})):bobPending},
    '@/utils/storage':{getStorageItem:async()=> 'token'},
    '@/components/home/ReadmePopup':{ReadmePopup:()=>null},
    '@/components/home/save-popup':{SavePopup:(props:any)=>React.createElement('SavePopup',props)},
    '@/components/home/share-repository-sheet':{ShareRepositorySheet:()=>null},
    '@/hooks/use-repository-readme':{useRepositoryReadme:()=>({})},
    '@/hooks/use-repository-readme-summary':{useRepositoryReadmeSummary:()=>({})},
    '@/services/repositoryGithubOpen':{openRepositoryOnGitHub:async()=>false},
    '@/services/activityOutboxClient':{},
  });
  let root!:ReturnType<typeof create>;
  const render=()=>React.createElement(QueryClientProvider,{client},React.createElement(RepositoryDetailScreen,{repositoryId:'repo'}));
  await act(async()=>{root=create(render());});
  try {
    const callback=root.root.findByType('SavePopup').props.onListMembershipsChanged;
    await act(async()=>{callback(saved?['list-a']:[],saved);});
    const label=saved?'Manage saved Lists':'Save repository to Lists';
    assert.equal(root.root.findAllByProps({accessibilityLabel:label}).length>0,true);
    assert.equal(client.getQueryData(repositoryDetailQueryKey('repo','alice')),undefined);
    await act(async()=>{finish({...card,viewerSaved:!saved,selectedListIds:saved?[]:['old-list'],readmeFull:null,hasReadme:true});await pending;});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(root.root.findAllByProps({accessibilityLabel:label}).length>0,true,'Pre-save detail cannot undo confirmed membership');
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.viewerSaved,saved);
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.readmeFull,null);
    await act(async()=>{await client.invalidateQueries({queryKey:repositoryDetailQueryKey('repo','alice'),exact:true});});
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','alice'))?.viewerSaved,!saved,'A fetch started after confirmation remains authoritative');
    await act(async()=>{viewer='bob';root.update(render());});
    await act(async()=>{callback(['alice-only'],true);});
    assert.equal(root.root.findAllByProps({accessibilityLabel:'Save repository to Lists'}).length>0,true);
    assert.equal(client.getQueryData(repositoryDetailQueryKey('repo','bob')),undefined);
    await act(async()=>{finishBob({...card,description:'complete README',readmeFull:null,hasReadme:true});await bobPending;});
    assert.equal(client.getQueryData<any>(repositoryDetailQueryKey('repo','bob'))?.readmeFull,null);
  } finally {await act(async()=>root.unmount());client.clear();}
});

test('cold detail renders metadata before one lazy canonical body and reuses it without changing viewer state',async()=>{
  const React=await import('react');const {act}=React;const {create}=await import('react-test-renderer');
  const query=await import('@tanstack/react-query');const {loadSource}=await import('./support/startup-harness');
  const models=await import('../src/models/repository');const {authSessionLifecycle}=await import('../src/api/session-lifecycle');
  const requests:string[]=[];let finishMetadata!:(value:unknown)=>void,finishBody!:(value:unknown)=>void;
  const metadata=new Promise(resolve=>{finishMetadata=resolve;});const body=new Promise(resolve=>{finishBody=resolve;});
  const {waitForReadmeState}=await import('./support/feed-harness');
  const canonical='# Original README\n\n'+('Long canonical content.\n'.repeat(10000));
  const payload={repo_id:'repo',full_name:'owner/repo',name:'repo',url:'https://github.com/owner/repo',status:'active',description:'Metadata ready independently',
    content_version:7,content_hash:'canonical-hash',readme_available:true,readme:null,readme_md:null,primary_language:null,
    selected_list_ids:['confirmed-list'],viewer_saved:true,readme_source_path:'docs/README.md',readme_default_branch:'main',readme_base_url:'https://raw.githubusercontent.com/owner/repo/main/docs/'};
  const mocks:Record<string,any>={
    '@tanstack/react-query':query,'@/models/repository':models,'@/api/session-lifecycle':{authSessionLifecycle},
    '@/models/readme-digest':await import('../src/models/readme-digest'),'@/utils/repository-mapper':await import('../src/utils/repository-mapper'),
    '@/api/client':{apiV2:async(path:string)=>{requests.push(path);return path.includes('/readme?')?body:metadata;}},
    '@/store/AuthContext':{useAuth:()=>({user:{user_id:'alice'},isLoading:false})},'@/utils/storage':{getStorageItem:async()=> 'token'},
    'react-native':{ActivityIndicator:'ActivityIndicator',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',
      StyleSheet:{create:(value:unknown)=>value},useWindowDimensions:()=>({width:360})},
    'expo-router':{router:{}},'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0,bottom:0})},
    'lucide-react-native':new Proxy({},{get:()=>()=>null}),'@/constants/theme':{REFERENCE_THEME:{}},
    '@/components/home/ReadmePopup':{ReadmePopup:(props:any)=>React.createElement('ReadmePopup',props)},
    '@/components/home/save-popup':{SavePopup:()=>null},'@/components/home/share-repository-sheet':{ShareRepositorySheet:()=>null},
    '@/hooks/use-repository-readme-summary':{useRepositoryReadmeSummary:()=>({})},'@/services/repositoryGithubOpen':{openRepositoryOnGitHub:async()=>false},
    '@/services/activityOutboxClient':{},
  };
  mocks['@/api/repositories']=loadSource('src/api/repositories.ts',mocks);
  mocks['@/hooks/use-repository-readme']=loadSource('src/hooks/use-repository-readme.ts',mocks);
  const {RepositoryDetailScreen}=loadSource('src/components/repository-detail-screen.tsx',mocks);
  const client=new query.QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});let root!:ReturnType<typeof create>;
  await act(async()=>{root=create(React.createElement(query.QueryClientProvider,{client},React.createElement(RepositoryDetailScreen,{repositoryId:'repo'})));});
  try{
    assert.deepEqual(requests,['/repositories/repo?projection=metadata']);
    await act(async()=>{finishMetadata(payload);await metadata;await new Promise(resolve=>setTimeout(resolve,0));});
    await waitForReadmeState(()=>root.root.findAllByType('Text').some(node=>node.children.includes('Metadata ready independently')));
    assert.equal(requests.length,1,'Metadata never starts a full document transfer');
    const open=()=>root.root.findAllByType('Text').find(node=>node.children.includes('View README'))!.parent!.props.onPress();
    await act(async()=>{open();});assert.equal(requests.length,2);assert.equal(root.root.findByType('ReadmePopup').props.loading,true);
    await act(async()=>{finishBody({...payload,readme_md:canonical});await body;await new Promise(resolve=>setTimeout(resolve,0));});
    await waitForReadmeState(()=>root.root.findByType('ReadmePopup').props.readmeText===canonical);
    assert.equal(root.root.findByType('ReadmePopup').props.readmeText,canonical,'No trim, truncation, or summary substitution');
    await act(async()=>{root.root.findByType('ReadmePopup').props.onClose();});await act(async()=>{open();});
    assert.equal(requests.length,2,'Repeat open reuses the same version body');
    const key=models.repositoryMetadataQueryKey('repo','alice');assert.equal(client.getQueryData<any>(key)?.viewerSaved,true);
    assert.deepEqual(client.getQueryData<any>(key)?.selectedListIds,['confirmed-list']);
    assert.equal(client.getQueryData<any>(models.repositoryReadmeQueryKey('repo','alice',7))?.viewerSaved,undefined);
    assert.equal(client.getQueryData(models.repositoryDetailQueryKey('repo','alice')),undefined,'Metadata never replaces a legacy full cache entry');
  }finally{await act(async()=>root.unmount());client.clear();}
});
