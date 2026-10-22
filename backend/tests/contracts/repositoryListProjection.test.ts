import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const controllerSource = readFileSync(
  new URL('../../controllers/productV2Controller.ts', import.meta.url),
  'utf8',
);

function controllerFunction(name: string): string {
  const startMarker = `export async function ${name}`;
  const start = controllerSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${name} must remain exported`);
  const next = controllerSource.indexOf('\nexport ', start + startMarker.length);
  return controllerSource.slice(start, next === -1 ? controllerSource.length : next);
}

const repositoryListHandlers = [
  'listRepositories',
  'listSaved',
  'listLikesGiven',
  'listCollectionRepos',
  'listBoardRepos',
] as const;

test('every authenticated repository list projects real viewer state and repository content', () => {
  for (const handler of repositoryListHandlers) {
    const source = controllerFunction(handler);
    assert.match(source, /userId\(req, res\)/, `${handler} must resolve the authenticated viewer`);
    assert.match(source, /AS viewer_reaction/, `${handler} must project the viewer reaction`);
    assert.match(source, /AS viewer_saved/, `${handler} must project the saved union`);
    assert.match(source, /AS selected_list_ids/, `${handler} must project all selected Lists`);
    assert.match(source, /'collection:'/, `${handler} must namespace Collection memberships`);
    assert.match(source, /'legacy-board:'/, `${handler} must include legacy Board memberships`);
    assert.match(source, /AS readme_md/, `${handler} must keep full README separate`);
    assert.match(source, /summary/, `${handler} must include the active concise summary`);
    assert.ok(
      /languages/.test(source)
        || (source.includes('${repoProjection}')
          && /const repoProjection = `[\s\S]*?languages[\s\S]*?`/.test(controllerSource)),
      `${handler} must include languages`,
    );
    assert.match(source, /topics/, `${handler} must include topics`);
  }
});

test('legacy endpoint aliases remain alongside the canonical repository fields', () => {
  const liked = controllerFunction('listLikesGiven');
  assert.match(liked, /AS github_repo_url/);
  assert.match(liked, /AS owner_id/);
  assert.match(liked, /AS repo_name/);
  assert.match(liked, /AS language_used/);
  assert.match(liked, /AS forks_count/);

  assert.match(controllerFunction('listSaved'), /s\.created_at/);
  assert.match(controllerFunction('listCollectionRepos'), /cr\.added_at/);
  assert.match(controllerFunction('listBoardRepos'), /br\.added_at/);
});

test('Trending retains public repository content while viewer state stays outside the shared cache', () => {
  const source=readFileSync(new URL('../../controllers/trendingController.ts', import.meta.url),'utf8');
  assert.match(controllerSource,/export \{ listTrending \} from '.\/trendingController.js'/);
  const publicSource=source.slice(source.indexOf('export function createTrendingSnapshotSource'),source.indexOf('export const trendingSnapshotSource'));
  for(const field of ['summary_prompt_version','summary_source','languages','topics']) assert.match(publicSource,new RegExp(field));
  assert.match(publicSource,/x.content_version=c.content_version/);
  assert.doesNotMatch(publicSource,/viewer_reaction|viewer_saved|selected_list_ids|readme_md/);
  const privateSource=source.slice(source.indexOf('export const loadTrendingViewerState'),source.indexOf('export function createTrendingHandler'));
  for(const field of ['viewer_reaction','viewer_saved','selected_list_ids',"'collection:'","'legacy-board:'"]) assert.ok(privateSource.includes(field));
});
