const items = Array.from({ length: 137 }, (_, i) => ({ repo_id: String(i), full_name: `weave/Repo ${i}`, description: 'Browser fixture repository', star_count: i }));
let failed = false;
export async function apiV2(path: string) {
    const url = new URL(path, 'http://fixture.invalid');
    if (url.searchParams.get('pagination') !== 'keyset') throw new Error('Fixture requires keyset pagination');
    const cursor = url.searchParams.get('cursor');
    const offset = cursor ? Number(cursor.replace('fixture-', '')) : 0;
    ((window as any).repositoryCursors ??= []).push(cursor);
    const limit = Number(url.searchParams.get('limit'));
    (window as any).repositoryRequests.push(offset);
    if (offset === 40 && !failed) {
        failed = true;
        throw Object.assign(new Error('Fixture page failure'), { status: window.location.hash === '#rejected' ? 400 : 503 });
    }
    const has_more = offset + limit < items.length;
    return { items: items.slice(offset, offset + limit), has_more, next_cursor: has_more ? `fixture-${offset+limit}` : null };
}
