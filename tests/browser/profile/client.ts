const items = Array.from({ length: 137 }, (_, i) => ({ repo_id: String(i), full_name: `weave/Repo ${i}`, description: 'Browser fixture repository', star_count: i }));
let failed = false;
export async function apiV2(path: string) {
    const url = new URL(path, 'http://fixture.invalid');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    (window as any).repositoryRequests.push(offset);
    if (offset === 40 && !failed) {
        failed = true;
        throw new Error('Fixture page failure');
    }
    return { items: items.slice(offset, offset + limit) };
}
