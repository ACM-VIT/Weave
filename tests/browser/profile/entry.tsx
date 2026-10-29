import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ProfileContentLists } from '../../../src/components/profile/ProfileContentLists';
import { ProfileHeader } from '../../../src/components/profile/ProfileHeader';
import { ProfileRepositoryList } from '../../../src/components/profile-repository-list';
import { profileSectionQueries } from '../../../src/api/profile-section-queries';
import { mapLegacyBoardList } from '../../../src/models/list';
const started = performance.now();
(window as any).repositoryRequests = [];
(window as any).repositoryNavigations = [];
const boards = Array.from({ length: 10000 }, (_, i) => mapLegacyBoardList({ board_id: String(i), name: `Board ${String(i).padStart(5, '0')}`, description: null, repo_count: i }));
let release!: (value: []) => void;
const heldCollections = new Promise<[]>(resolve => { release = resolve; });
const loaders = { boards: async () => boards, collections: () => heldCollections };
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const actions: string[] = [];
function Fixture() {
    const [sheet, setSheet] = useState(false);
    const [avatar, setAvatar] = useState(photo);
    useEffect(() => { (window as any).showRepositorySheet = setSheet; }, []);
    useEffect(() => { (window as any).setProfilePhoto = setAvatar; }, []);
    const options = profileSectionQueries('fixture-viewer', loaders);
    const boardQuery = useQuery(options.boards), collectionQuery = useQuery(options.collections);
    return <><button onClick={() => setSheet(current => !current)}>Fixture: toggle saved repositories</button><View style={{ height: 600, width: '100%', maxWidth: 820, backgroundColor: '#000' }}>
   <View style={{ flex: 1, display: sheet ? 'none' : 'flex' }}><ProfileContentLists viewer="fixture-viewer" header={<View testID="profile-header-fixture"><ProfileHeader
       username="krishang-zinzuwadia-05782-long-username" name="Krishang Zinzuwadia" job="Building open source projects with multiple teams."
       avatarUrl={avatar} isCompact isTablet={false} stats={['likes given', 'saved', 'followers', 'following'].map(label => ({ label, value: '10.2K', onPress: () => actions.push(label) }))}
       onEdit={() => actions.push('edit')} onLogout={() => actions.push('logout')} /></View>} compact horizontalPadding={24} maxWidth={760} paddingTop={10} paddingBottom={20} boards={boardQuery} collections={collectionQuery} pinned={{ data: [], isPending: false, isError: false, refetch: () => { } }} openList={() => { }}/></View>
   <View style={{ flex: 1, display: sheet ? 'flex' : 'none' }}><ProfileRepositoryList active={sheet} type="saved" userId="fixture-viewer" onRepositoryPress={(href) => (window as any).repositoryNavigations.push(href)}/></View>
 </View></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(ok: unknown, message: string) { if (!ok)
    throw new Error(message); }
async function until(fn: () => boolean) { for (let n = 0; n < 80; n++) {
    if (fn())
        return;
    await wait(100);
} throw new Error('Browser fixture timed out'); }
function output(status: string, data: any) { const el = document.createElement('pre'); el.id = 'profile-check-result'; el.style.whiteSpace = 'pre-wrap'; el.style.overflowWrap = 'anywhere'; el.style.maxWidth = '390px'; el.dataset.status = status; el.textContent = JSON.stringify(data); document.body.append(el); }
async function run() {
    const list = () => document.querySelector('[data-testid="profile-lists"]') as HTMLElement;
    const sheet = () => document.querySelector('[data-testid="profile-stat-repositories"]') as HTMLElement;
    await until(() => !!document.querySelector('[data-testid="profile-list-legacy-board:0"]'));
    const firstReadyMs = performance.now() - started;
    const boardRows = list().querySelectorAll('[data-testid^="profile-list-legacy-board:"]').length;
    const header = document.querySelector('[data-testid="profile-header-fixture"]') as HTMLElement;
    await until(() => !!header.querySelector('img')?.complete && Boolean(header.querySelector('img')?.naturalWidth));
    (window as any).setProfilePhoto('/missing-avatar.png');
    await until(() => !header.querySelector('img') && header.innerText.includes('K'));
    (window as any).setProfilePhoto(photo);
    await until(() => Boolean(header.querySelector('img')?.naturalWidth));
    const textScale = Number(new URLSearchParams(location.search).get('textScale') ?? '1');
    if (textScale > 1) {
        // Browser text-enlargement stress, not proof of native fontScale behavior.
        for (const node of header.querySelectorAll<HTMLElement>('[dir="auto"]')) {
            const computed = getComputedStyle(node);
            node.style.fontSize = `${parseFloat(computed.fontSize) * textScale}px`;
            node.style.lineHeight = `${parseFloat(computed.lineHeight) * textScale}px`;
        }
        await wait(100);
    }
    const edit = header.querySelector('[aria-label="Edit profile"]') as HTMLElement;
    const lastStat = header.querySelector('[aria-label="10.2K following"]') as HTMLElement;
    assert(edit.innerText === 'Edit Profile', 'Edit Profile is visibly labeled');
    assert(edit.getBoundingClientRect().top >= lastStat.getBoundingClientRect().bottom, 'Edit Profile is below the stats row');
    assert(edit.getBoundingClientRect().height >= 48, 'Edit Profile retains its touch target');
    assert(header.scrollWidth <= header.clientWidth + 1, 'Profile identity spills outside the available width');
    edit.click();
    assert(actions.join(',') === 'edit', 'Edit Profile does not invoke a neighboring stat or logout');
    assert(!!list().querySelector('[role="progressbar"][aria-label="Loading Lists"]'), 'Slow collections retain a loading placeholder alongside ready Lists');
    assert(boardRows < 150, `Expected bounded Lists rows, got ${boardRows}`);
    assert((window as any).repositoryRequests.length === 0, 'Hidden stats sheet fetched eagerly');
    assert(queryClient.getQueryState(['profile-content', 'fixture-viewer', 'collections'])?.status === 'pending', 'Lists waited for a slow collection');
    for (let n = 0; n < 3; n++) {
        list().scrollTop = 2500;
        list().dispatchEvent(new Event('scroll'));
        await wait(400);
    }
    const scrollBefore = list().scrollTop;
    assert(scrollBefore > 0, 'Fixture did not scroll');
    (window as any).showRepositorySheet(true);
    await until(() => !!document.querySelector('[aria-label="Open weave/Repo 0"]'));
    const button = (label: string) => [...sheet().querySelectorAll('[role="button"]')].find(e => e.textContent === label) as HTMLElement | undefined;
    // Exercise the actual footer, retaining page one while page two fails.
    button('Load more repositories')?.click();
    await until(() => !!button('Retry repositories'));
    sheet().scrollTop = 0;
    sheet().dispatchEvent(new Event('scroll'));
    await wait(400);
    assert(!!document.querySelector('[aria-label="Open weave/Repo 0"]'), 'Failed next page removed loaded cards');
    const failedRequests = (window as any).repositoryRequests.length;
    await wait(400);
    assert((window as any).repositoryRequests.length === failedRequests, 'Error triggered an automatic page loop');
    button('Retry repositories')!.click();
    await until(() => window.location.hash === '#rejected'
      ? (window as any).repositoryRequests.filter((offset: number) => offset === 0).length === 2 && !!button('Load more repositories')
      : (window as any).repositoryRequests.filter((offset: number) => offset === 40).length === 2);
    for (let n = 0; n < 10 && !(window as any).repositoryRequests.includes(120); n++) {
        const more = [...sheet().querySelectorAll('[role="button"]')].find(e => e.textContent === 'Load more repositories') as HTMLElement;
        more?.click();
        sheet().scrollTop = sheet().scrollHeight;
        sheet().dispatchEvent(new Event('scroll'));
        await wait(500);
    }
    await until(() => (window as any).repositoryRequests.includes(120));
    for (let n = 0; n < 15 && !document.querySelector('[aria-label="Open weave/Repo 136"]'); n++) {
        sheet().scrollTop = sheet().scrollHeight;
        sheet().dispatchEvent(new Event('scroll'));
        await wait(300);
    }
    assert(!!document.querySelector('[aria-label="Open weave/Repo 136"]'), 'Final saved repository was unreachable');
    const expectedCursors = window.location.hash === '#rejected'
      ? [null, 'fixture-40', null, 'fixture-40', 'fixture-80', 'fixture-120']
      : [null, 'fixture-40', 'fixture-40', 'fixture-80', 'fixture-120'];
    assert(JSON.stringify((window as any).repositoryCursors) === JSON.stringify(expectedCursors), 'The UI did not recover with the expected opaque cursors');
    const savedRows = sheet().querySelectorAll('[aria-label^="Open weave/Repo "]').length;
    assert(savedRows < 100, `Saved grid was not bounded: ${savedRows}`);
    (window as any).showRepositorySheet(false);
    await wait(700);
    assert(Math.abs(list().scrollTop - scrollBefore) < 10, `Profile position changed: ${scrollBefore} -> ${list().scrollTop}`);
    const scrollAfterSheet = list().scrollTop;
    release([]);
    await wait(200);
    output('passed', { firstReadyMs, initialListRows: boardRows, totalLists: 10000, renderedSavedRows: savedRows, totalSaved: 137, offsets: (window as any).repositoryRequests, cursors: (window as any).repositoryCursors, scrollBefore, scrollAfterSheet, scrollAfter: list().scrollTop });
}
setTimeout(() => run().catch(error => output('failed', { message: String(error), requests: (window as any).repositoryRequests, dom: document.body.innerText.slice(0, 1200) })), 100);
