import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { extractReadmePreviewImage, renderReadmeMarkdown, resolveReadmeImageUrl, type ReadmeImageContext } from "../src/utils/readme-images";
import { extractReadmeVideos } from "../src/utils/readme-videos";
import { readmePopupBlocks } from "../src/utils/readme-popup-content";

describe("readme images", () => {
  const context: ReadmeImageContext = {
    fullName: 'ACM-VIT/weave',
    githubUrl: 'https://github.com/ACM-VIT/weave',
    readmeSourcePath: 'docs/README.md',
    readmeDefaultBranch: 'main',
    readmeBaseUrl: 'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/',
  };

  test('relative README images resolve against the README directory and branch', () => {
    assert.equal(
      resolveReadmeImageUrl('./images/demo.png', context),
      'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/images/demo.png',
    );
    assert.equal(
      resolveReadmeImageUrl('../assets/hero.png', context),
      'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/assets/hero.png',
    );
    assert.equal(
      resolveReadmeImageUrl('/assets/root.png', context),
      'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/assets/root.png',
    );
  });

  test('README images reject unsafe schemes, private hosts, credentials and traversal', () => {
    for (const source of [
      'http://images.example.com/demo.png',
      'data:image/png;base64,AAAA',
      'file:///tmp/demo.png',
      'javascript:alert(1)',
      '//images.example.com/demo.png',
      'https://127.0.0.1/demo.png',
      'https://10.0.0.4/demo.png',
      'https://localhost./demo.png',
      'https://printer.local./demo.png',
      'https://service.internal./demo.png',
      'https://user:secret@images.example.com/demo.png',
      '../../../../../../another-repository/private.png',
    ]) {
      assert.equal(resolveReadmeImageUrl(source, context), null, source);
    }
    assert.equal(
      resolveReadmeImageUrl('https://cdn.example.com/public/demo.png', context),
      'https://cdn.example.com/public/demo.png',
    );
  });

  test('preview selection skips badges and prefers a meaningful product image', () => {
    const markdown = [
      '![build status](https://img.shields.io/badge/build-passing-green)',
      '![logo](./images/logo.png)',
      '![App screenshot](./images/screenshot.png)',
    ].join('\n');

    assert.deepEqual(extractReadmePreviewImage(markdown, context), {
      alt: 'App screenshot',
      url: 'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/images/screenshot.png',
    });
  });

  test('full README rendering keeps safe images and strips unsafe image attributes', () => {
    const html = renderReadmeMarkdown([
      '# Weave',
      '![Screenshot](./images/demo.png)',
      '<img src="https://cdn.example.com/hero.png" alt="Hero" onerror="alert(1)">',
      '<img src="http://localhost/private.png" alt="Private">',
    ].join('\n\n'), context);

    assert.match(html, /raw\.githubusercontent\.com\/ACM-VIT\/weave\/refs\/heads\/main\/docs\/images\/demo\.png/);
    assert.match(html, /https:\/\/cdn\.example\.com\/hero\.png/);
    assert.doesNotMatch(html, /onerror/i);
    assert.doesNotMatch(html, /http:\/\/localhost/);
    assert.match(html, />Private<\/span>/);
  });

  test('commit-pinned README images retain the source revision for relative and root paths', () => {
    const commit = '9006287f27e720000cc8763ae4cd150789b8571d';
    const root = `https://raw.githubusercontent.com/ACM-VIT/weave/${commit}/`;
    const pinned = { ...context, readmeBaseUrl: `${root}docs/` };
    assert.equal(resolveReadmeImageUrl('./images/demo.png', pinned), `${root}docs/images/demo.png`);
    assert.equal(resolveReadmeImageUrl('../assets/demo.png', pinned), `${root}assets/demo.png`);
    assert.equal(resolveReadmeImageUrl('/assets/demo.png', pinned), `${root}assets/demo.png`);
    assert.equal(resolveReadmeImageUrl('../../other-repo/demo.png', pinned), null);
    assert.equal(resolveReadmeImageUrl('./demo.png', { ...pinned,
      readmeBaseUrl: `https://raw.githubusercontent.com/other/repo/${commit}/docs/` }),
      'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/demo.png');
  });

  test('summary media keeps real screenshots and GIFs while excluding badges and code examples', async () => {
    const {extractReadmeSummaryImages}=await import('../src/utils/readme-images');
    const markdown='![build](https://img.shields.io/badge/build-green)\n'
      +'![Screenshot](./images/screen.png)\n<img src="./demo.gif" alt="Demo">\n'
      +'```md\n![Example](https://cdn.example.com/fake.png)\n```\n'
      +'![duplicate](./images/screen.png)';
    assert.deepEqual(extractReadmeSummaryImages(markdown,context),[
      {alt:'Screenshot',url:'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/images/screen.png'},
      {alt:'Demo',url:'https://raw.githubusercontent.com/ACM-VIT/weave/refs/heads/main/docs/demo.gif'},
    ]);
  });
});

describe("readme videos", () => {
  const context = { fullName: 'org/repo', readmeDefaultBranch: 'main', readmeSourcePath: 'docs/README.md' };

  test('finds HTML sources, markdown videos and extensionless GitHub attachments', () => {
    assert.deepEqual(extractReadmeVideos(`<video src="./demo.mp4" autoplay></video>
  <video><source src="https://cdn.example.com/clip.webm"></video>
  [Demo](https://github.com/user-attachments/assets/1234-abcd)
  https://cdn.example.com/movie.mp4
  [duplicate](./demo.mp4)`, context), [
      'https://raw.githubusercontent.com/org/repo/refs/heads/main/docs/demo.mp4',
      'https://cdn.example.com/clip.webm',
      'https://github.com/user-attachments/assets/1234-abcd',
    ]);
  });

  test('rejects private hosts, unsafe URLs, non-video attachments and code examples', () => {
    assert.deepEqual(extractReadmeVideos('```html\n<video src="https://cdn.example.com/fake.mp4"></video>\n```\n'
      + '`https://cdn.example.com/fake.mp4`\n'
      + '<video src="javascript:alert(1)"></video>\n'
      + '<video src="https://127.0.0.1/movie.mp4"></video>\n'
      + '[img](https://github.com/user-attachments/assets/image.png)\n'
      + '[page](https://youtube.com/watch?v=abc)', context), []);
  });

  test('preserves commit pinned relative paths and decodes HTML entities', () => {
    assert.deepEqual(extractReadmeVideos('<video src="../demo.mp4?x=1&amp;y=2"></video>', {
      ...context, readmeBaseUrl: `https://raw.githubusercontent.com/org/repo/${'a'.repeat(40)}/docs/`,
    }), [`https://raw.githubusercontent.com/org/repo/${'a'.repeat(40)}/demo.mp4?x=1&y=2`]);
  });

  test('GitHub file pages remain links rather than unplayable video previews', () => {
    const markdown = [
      '[file](https://github.com/org/repo/blob/main/demo.mp4)',
      '[directory](https://github.com/org/repo/tree/main/demo.webm)',
      '<video src="https://github.com/org/repo/blob/main/demo.mov?raw=true"></video>',
      '[raw](https://raw.githubusercontent.com/org/repo/main/demo.mp4)',
      '[attachment](https://github.com/user-attachments/assets/1234-abcd)',
      '[cdn](https://cdn.example.com/demo.webm)',
    ].join('\n');
    assert.deepEqual(extractReadmeVideos(markdown, context), [
      'https://raw.githubusercontent.com/org/repo/main/demo.mp4',
      'https://github.com/user-attachments/assets/1234-abcd',
      'https://cdn.example.com/demo.webm',
    ]);
  });

  test('GitHub raw and release downloads remain playable previews', () => {
    const downloads = [
      'https://github.com/org/repo/raw/refs/heads/main/demo.mp4',
      `https://github.com/org/repo/raw/${'a'.repeat(40)}/docs/demo.webm`,
      'https://github.com/org/repo/releases/download/v1.0/demo.mov',
    ];
    const markdown = [
      '[HTML page](https://github.com/org/repo/blob/main/demo.mp4)',
      `<video src="${downloads[0]}"></video>`,
      `<video><source src="${downloads[1]}"></video>`,
      `[release](${downloads[2]})`,
      '[duplicate](' + downloads[0] + ')',
      '[fourth](https://github.com/org/repo/raw/main/extra.mp4)',
    ].join('\n');
    assert.deepEqual(extractReadmeVideos(markdown, context), downloads);
  });

  test('GitHub pages outside known download routes do not become previews', () => {
    const pages = [
      'https://github.com/org/repo/tree/main/demo.mp4',
      'https://github.com/org/repo/issues/demo.mp4',
      'https://github.com/org/repo/releases/tag/demo.mp4',
      'https://github.com/org/repo/raw/demo.mp4',
      'https://github.com/org/repo/releases/download/demo.mp4',
    ];
    assert.deepEqual(extractReadmeVideos(pages.map(url => `[page](${url})`).join('\n'), context), []);
  });
});

describe("readme popup content", () => {
  test('keeps the entire summary and places videos between its sections', () => {
    const html='<p>Complete overview.</p>\n<h2>Capabilities</h2><ul><li>Every capability.</li></ul>\n<h2>Use cases</h2><p>Every use case.</p><h2>Things to know</h2><p>All caveats.</p>';
    const blocks=readmePopupBlocks(html,['https://cdn.example.com/demo.mp4'],true);
    assert.equal(blocks.filter(b=>b.kind==='html').map(b=>b.content).join(''),html);
    assert.deepEqual(blocks.map(b=>b.kind),['html','video','html','html','html']);
  });

  test('short summaries keep their text and append bounded media without duplicating it',()=>{
    assert.deepEqual(readmePopupBlocks('<p>Overview.</p>',['a','b','c','d'],true).map(b=>b.kind),['html','video','video','video']);
    assert.deepEqual(readmePopupBlocks('<h2>Original</h2><p>Source.</p>',['a'],false),[
      {kind:'html',content:'<h2>Original</h2><p>Source.</p>'},{kind:'video',url:'a'},
    ]);
  });

  test('summary images and videos appear between sections without losing any summary text',()=>{
    const html='<p>Overview.</p><h2>Features</h2><p>Features.</p><h2>Use</h2><p>Use.</p>';
    const blocks=readmePopupBlocks(html,['video.mp4'],true,[{url:'screen.png',alt:'Screenshot'}]);
    assert.deepEqual(blocks.map(block=>block.kind),['html','image','html','video','html']);
    assert.equal(blocks.filter(block=>block.kind==='html').map(block=>block.content).join(''),html);
  });
});
