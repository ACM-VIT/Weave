import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ProfileContentLists } from '../../../src/components/profile/ProfileContentLists';
import { ProfileRepositoryList } from '../../../src/components/profile-repository-list';
import { profileSectionQueries } from '../../../src/api/profile-section-queries';
import { mapLegacyBoardList } from '../../../src/models/list';
const started = performance.now();
(window as any).repositoryRequests = [];
const boards = Array.from({ length: 10000 }, (_, i) => mapLegacyBoardList({ board_id: String(i), name: `Board ${String(i).padStart(5, '0')}`, description: null, repo_count: i }));
let release!: (value: []) => void;
const heldCollections = new Promise<[]>(resolve => { release = resolve; });
const loaders = { boards: async () => boards, collections: () => heldCollections };
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
    const [sheet, setSheet] = useState(false);
    useEffect(() => { (window as any).showRepositorySheet = setSheet; }, []);
    const options = profileSectionQueries('fixture-viewer', loaders);
    const boardQuery = useQuery(options.boards), collectionQuery = useQuery(options.collections);
    return <><button onClick={() => setSheet(current => !current)}>Fixture: toggle saved repositories</button><View style={{ height: 600, width: '100%', maxWidth: 390, backgroundColor: '#000' }}>
   <View style={{ flex: 1, display: sheet ? 'none' : 'flex' }}><ProfileContentLists viewer="fixture-viewer" header={<View style={{ height: 100 }}><Text>Profile Lists</Text></View>} compact horizontalPadding={24} maxWidth={600} paddingTop={10} paddingBottom={20} boards={boardQuery} collections={collectionQuery} pinned={{ data: [], isPending: false, isError: false, refetch: () => { } }} openList={() => { }}/></View>
   <View style={{ flex: 1, display: sheet ? 'flex' : 'none' }}><ProfileRepositoryList active={sheet} type="saved" userId="fixture-viewer"/></View>
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
