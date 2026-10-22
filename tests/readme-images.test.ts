import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractReadmePreviewImage,
  renderReadmeMarkdown,
  resolveReadmeImageUrl,
  type ReadmeImageContext,
} from '../src/utils/readme-images';

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
