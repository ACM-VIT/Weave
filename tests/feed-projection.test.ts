import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { createFeedItemMapper, mapBackendToFrontend } from "../src/utils/feed-items";
import { type FeedRepositoryPayload } from "../src/api/feed";
import { getFeedItemIdentity, mapFeedRepository, patchFeedReaction, patchFeedSaved, reconcileFeedItemSavedState } from "../src/utils/feed-repository";
import { prepareReadmePreview, README_SUMMARY_PENDING } from "../src/utils/readme";

describe("feed items", () => {
  function item(id: string, fields: Record<string, unknown> = {}) {
    return { repo_id: id, full_name: `owner/${id}`, serve_id: 'serve-1', position: 0, ...fields };
  }

  test('appending one page only maps new objects and retains existing cards', () => {
    let mapped = 0;
    const project = createFeedItemMapper(value => { mapped++; return mapBackendToFrontend(value); });
    const pages = Array.from({ length: 100 }, (_, page) => ({
      items: Array.from({ length: 24 }, (_, row) => item(`${page}-${row}`, { position: row })),
    }));
    const before = project(pages);
    assert.equal(mapped, 2_400);
    const after = project([...pages, { items: Array.from({ length: 24 }, (_, row) => item(`new-${row}`)) }]);
    assert.equal(mapped, 2_424);
    assert.equal(after.length, 2_424);
    before.forEach((entry, index) => assert.strictEqual(after[index], entry));
    assert.strictEqual(project([...pages]), project(pages));
  });

  test('mutation updates only the changed entry and keeps its serve attribution', () => {
    let mapped = 0;
    const project = createFeedItemMapper(value => { mapped++; return mapBackendToFrontend(value); });
    const first = item('first');
    const second = item('second', { position: 1 });
    const before = project([{ items: [first, second] }]);
    const after = project([{ items: [first, { ...second, viewer_reaction: 'like', viewer_saved: true }] }]);
    assert.equal(mapped, 3);
    assert.strictEqual(after[0], before[0]);
    assert.notStrictEqual(after[1], before[1]);
    assert.equal(after[1].feedId, before[1].feedId, 'Reactions and saves must not remount the card');
    assert.equal(after[1].repository.viewerReaction, 'like');
    assert.equal(after[1].repository.viewerSaved, true);
    assert.equal(after[1].repository.serveId, 'serve-1');
    assert.equal(after[1].repository.feedPosition, 1);
  });

  test('duplicate repositories preserve source order and distinct serve positions', () => {
    const project = createFeedItemMapper();
    const one = item('duplicate', { serve_id: 'serve-a', position: 5 });
    const two = item('duplicate', { serve_id: 'serve-b', position: 0 });
    const result = project([{ items: [one, item('middle')] }, { items: [two] }]);
    assert.deepEqual(result.map(entry => [entry.repository.id, entry.repository.serveId, entry.repository.feedPosition]), [
      ['duplicate', 'serve-a', 5], ['middle', 'serve-1', 0], ['duplicate', 'serve-b', 0],
    ]);
    assert.equal(new Set(result.map(entry => entry.feedId)).size, 3);
  });

  test('reset and reordered refresh drop old cards and filter invalid records without offset drift', () => {
    const project = createFeedItemMapper();
    const first = item('first');
    const second = item('second');
    const invalid = item('invalid', { full_name: 'invalid' });
    project([{ items: [first, second] }]);
    assert.deepEqual(project(undefined), []);
    const refreshed = project([{ items: [invalid, second, first] }]);
    assert.deepEqual(refreshed.map(entry => entry.repository.id), ['second', 'first']);
    assert.equal(refreshed[0].feedId, 'serve-1:second:0');
    assert.equal(refreshed[1].feedId, 'serve-1:first:0');
    const otherViewer = createFeedItemMapper();
    assert.notStrictEqual(otherViewer([{ items: [first] }])[0].repository, project([{ items: [first] }])[0].repository);
  });

  test('memoized discovery pages suppress overlap while retaining unchanged cards', () => {
    const project = createFeedItemMapper();
    const first = {mode: 'discovery' as const, items: [item('first')]};
    const before = project([first]);
    const after = project([first, {mode: 'discovery', items: [item('first'), item('second')]}]);
    assert.deepEqual(after.map(entry => entry.repository.id), ['first', 'second']);
    assert.strictEqual(after[0], before[0]);
  });

  test('decoded feed rows retain their request session rather than generic app attribution',async()=>{
    const {decodeFeedPage}=await import('../src/api/feed-data');
    const session='00000000-0000-4000-8000-000000000010';
    const page=decodeFeedPage({serve_id:'00000000-0000-4000-8000-000000000011',feed_version:'1',next_cursor:null,
      items:[{repo_id:'00000000-0000-4000-8000-000000000012',position:0,repository:{full_name:'fixture/project'}}]},session);
    const mapped=createFeedItemMapper()([page]);
    assert.equal(mapped[0].repository.feedSessionId,session);
  });

  test('decoded feed rows preserve canonical README bytes separately from README digest identity',async()=>{
    const {decodeFeedPage}=await import('../src/api/feed-data');
    const session='00000000-0000-4000-8000-000000000010';
    const digest={summary_id:'00000000-0000-4000-8000-000000000013',content_version:6,content_hash:'digest-hash-v6',
      prompt_version:'digest-v1',format_version:'readme-digest-json-v1',model_version:'fixture',source:'generated',
      generated_at:'2026-10-27T00:00:00.000Z',overview:'Digest for the prior source version.',
      capabilities:['First capability.','Second capability.'],use_cases:['A valid use case.'],considerations:[]};
    const page=decodeFeedPage({serve_id:'00000000-0000-4000-8000-000000000011',feed_version:'1',next_cursor:null,
      items:[{repo_id:'00000000-0000-4000-8000-000000000012',position:0,repository:{
        repo_id:'00000000-0000-4000-8000-000000000012',full_name:'fixture/project',url:'https://github.com/fixture/project',
        content_version:7,content_hash:'body-hash-v7',readme_available:true,readme_md:'  # Canonical body\n\n',readme_digest:digest,
      }}]},session);
    const mapped=createFeedItemMapper()([page])[0].repository;
    assert.equal(mapped.contentVersion,7);
    assert.equal(mapped.contentHash,'body-hash-v7');
    assert.equal(mapped.hasReadme,true);
    assert.equal(mapped.readmeFull,'  # Canonical body\n\n');
    assert.equal(mapped.readmeDigest?.content_version,6);
    assert.equal(mapped.readmeDigest?.content_hash,'digest-hash-v6');
  });

  test('omitted README availability remains unknown when neither availability nor body was projected',()=>{
    const mapped=mapFeedRepository({repo_id:'repo',full_name:'fixture/project',readme_md:null});
    assert.ok(mapped);
    assert.equal(mapped.hasReadme,undefined);
  });
});

describe("feed repository", () => {
  function feedRepository(
    overrides: Partial<FeedRepositoryPayload> = {},
  ): FeedRepositoryPayload {
    return {
      repo_id: '10000000-0000-4000-8000-000000000001',
      full_name: 'acm-vit/weave',
      owner_user_id: null,
      owner_profile_id: null,
      owner_profile_claimed_user_id: null,
      owner_bio: null,
      description: 'A social repository discovery app.',
      languages: ['TypeScript'],
      star_count: 12,
      fork_count: 3,
      likes_count: 4,
      comments_count: 2,
      views_count: 20,
      open_issues_count: 1,
      summary: 'A concise active card summary.',
      readme_md: '# Weave\n\nThe complete document.',
      updated_at: '2026-08-01T00:00:00.000Z',
      viewer_reaction: null,
      viewer_saved: false,
      viewer_follows_owner: false,
      position: 7,
      serve_id: '20000000-0000-4000-8000-000000000001',
      feed_version: '4',
      ...overrides,
    };
  }

  test('feed mapping keeps the active summary and complete README in separate nullable fields', () => {
    const mapped = mapFeedRepository(feedRepository({
      summary: '  Active summary  ',
      readme_summary: 'Legacy summary',
      readme_md: '  # Full README\n\nComplete content.  ',
    }));

    assert.ok(mapped);
    assert.equal(mapped.readmeSummary, 'Active summary');
    assert.equal(mapped.readmeFull, '  # Full README\n\nComplete content.  ');
  });

  test('legacy placeholders map to missing content without borrowing from a long README', () => {
    const longReadme = `# Full project documentation\n\n${'Implementation detail. '.repeat(300)}`;
    const mapped = mapFeedRepository(feedRepository({
      summary: 'No summary available.',
      readme_summary: 'Summary unavailable',
      readme_md: longReadme,
    }));

    assert.ok(mapped);
    assert.equal(mapped.readmeSummary, null);
    assert.equal(mapped.readmeFull, longReadme);
    const preview = prepareReadmePreview({
      summary: mapped.readmeSummary,
      description: mapped.description,
      fullReadme: mapped.readmeFull,
    });
    assert.equal(preview.source, 'pending');
    assert.equal(preview.markdown, README_SUMMARY_PENDING);
    assert.equal(preview.markdown.includes('Implementation detail'), false);
  });

  test('mapped README-equivalent summaries resolve to the exact pending state', () => {
    const fullReadme = '# Complete README\n\nInstall, configure, and run the project.';
    const mapped = mapFeedRepository(feedRepository({
      summary: 'COMPLETE README install configure and run the project',
      description: 'No summary available.',
      readme_md: fullReadme,
    }));

    assert.ok(mapped);
    assert.deepEqual(prepareReadmePreview({
      summary: mapped.readmeSummary,
      description: mapped.description,
      fullReadme: mapped.readmeFull,
    }), {
      isTruncated: false,
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
    });
  });

  test('feed item identity is stable across optimistic reaction and save state changes', () => {
    const repository = mapFeedRepository(feedRepository());
    assert.ok(repository);
    const initialIdentity = getFeedItemIdentity(repository, 0);

    assert.equal(
      getFeedItemIdentity(
        { ...repository, viewerReaction: 'like', viewerSaved: true },
        0,
      ),
      initialIdentity,
    );
    assert.equal(
      initialIdentity,
      `${repository.serveId}:${repository.id}:${repository.feedPosition}`,
    );
  });

  test('optimistic reaction patches only the matching served position and maintains likes', () => {
    const target = feedRepository();
    const other = feedRepository({
      repo_id: '10000000-0000-4000-8000-000000000002',
      position: 8,
    });
    const cache = {
      pages: [{ items: [target, other], nextCursor: 'next' }],
      pageParams: [null],
    };
    const identity = {
      repoId: target.repo_id,
      serveId: target.serve_id,
      position: target.position,
    };

    const liked = patchFeedReaction(cache, identity, 'like');
    assert.notEqual(liked, cache);
    assert.equal(liked?.pages[0].items[0].viewer_reaction, 'like');
    assert.equal(liked?.pages[0].items[0].likes_count, 5);
    assert.equal(liked?.pages[0].items[1], other);

    const disliked = patchFeedReaction(liked, identity, 'dislike');
    assert.equal(disliked?.pages[0].items[0].viewer_reaction, 'dislike');
    assert.equal(disliked?.pages[0].items[0].likes_count, 4);

    const mismatchedUnlike = patchFeedReaction(disliked, identity, 'unlike');
    assert.equal(mismatchedUnlike, disliked);
    assert.equal(mismatchedUnlike?.pages[0].items[0].viewer_reaction, 'dislike');

    const undisliked = patchFeedReaction(disliked, identity, 'undislike');
    assert.equal(undisliked?.pages[0].items[0].viewer_reaction, null);
    assert.equal(undisliked?.pages[0].items[0].likes_count, 4);

    const reliked = patchFeedReaction(undisliked, identity, 'like');
    const mismatchedUndislike = patchFeedReaction(reliked, identity, 'undislike');
    assert.equal(mismatchedUndislike, reliked);
    assert.equal(mismatchedUndislike?.pages[0].items[0].viewer_reaction, 'like');

    const unliked = patchFeedReaction(reliked, identity, 'unlike');
    assert.equal(unliked?.pages[0].items[0].viewer_reaction, null);
    assert.equal(unliked?.pages[0].items[0].likes_count, 4);
  });

  test('saved state patches in place without changing the served item identity', () => {
    const target = feedRepository();
    const cache = {
      pages: [{ items: [target], nextCursor: null }],
      pageParams: [null],
    };
    const saved = patchFeedSaved(cache, {
      repoId: target.repo_id,
      serveId: target.serve_id,
      position: target.position,
    }, true);

    assert.equal(saved?.pages[0].items[0].viewer_saved, true);
    assert.equal(saved?.pages[0].items[0].repo_id, target.repo_id);
    assert.equal(saved?.pages[0].items[0].serve_id, target.serve_id);
    assert.equal(saved?.pages[0].items[0].position, target.position);
  });

  test('feed item local saved state follows changes from the same repository cache entry', () => {
    const repositoryId = '10000000-0000-4000-8000-000000000001';
    const optimistic = {
      repositoryId,
      serverSaved: false,
      saved: true,
    };

    const acknowledged = reconcileFeedItemSavedState(optimistic, repositoryId, true);
    assert.deepEqual(acknowledged, {
      repositoryId,
      serverSaved: true,
      saved: true,
    });

    const externallyRemoved = reconcileFeedItemSavedState(acknowledged, repositoryId, false);
    assert.deepEqual(externallyRemoved, {
      repositoryId,
      serverSaved: false,
      saved: false,
    });
  });

  test('feed displays the exact backend engagement count instead of sample or star counts', () => {
    for (const likes of [0, 1, 27, 9842]) {
      const repository = mapFeedRepository(feedRepository({ likes_count: likes, star_count: 654321 }));
      assert.ok(repository);
      assert.equal(repository.stats.likes, likes);
      assert.equal(repository.stats.stars, 654321);
    }
  });
});

test('language composition keeps source rows and explicit primary while legacy shapes never become indexes',()=>{
  const rich=[{name:'Python',color:'#3572A5',size:300,percentage:30},{name:'Rust',color:null,size:200,percentage:20}];
  const mapped=mapFeedRepository({repo_id:'repo',full_name:'owner/repo',primary_language:null,languages:['Python','Rust'],language_breakdown:rich,language_total_size:1000,language_breakdown_complete:false});
  assert.ok(mapped);assert.deepEqual(mapped.languages,['Python','Rust']);assert.equal(mapped.primaryLanguage,null);
  assert.deepEqual(mapped.languageBreakdown,rich);assert.equal(mapped.languageTotalSize,1000);assert.equal(mapped.languageBreakdownComplete,false);
  for(const value of [{Python:'300',Rust:200},[{name:'Python',size:'300'},{name:'Rust',color:'bad'}]]){
    const repository=mapFeedRepository({repo_id:'repo',full_name:'owner/repo',languages:value});
    assert.ok(repository);assert.deepEqual(repository.languages,['Python','Rust']);assert.equal(repository.languageBreakdown,null);
  }
  for(const value of [rich,{Python:300,Rust:200},['Python','Rust'],null,[]]){
    const repository=mapFeedRepository({repo_id:'repo',full_name:'owner/repo',primary_language:'Rust',languages:value});
    assert.ok(repository);assert.equal(repository.primaryLanguage,'Rust');assert.ok(repository.languages.every(name=>!/^\d+$/.test(name)));
    assert.deepEqual(repository.languages,value===null||Array.isArray(value)&&!value.length?[]:['Python','Rust']);
  }
});
