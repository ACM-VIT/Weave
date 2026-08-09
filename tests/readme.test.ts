import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeOptionalRepositoryText,
  prepareReadmeForDisplay,
  prepareReadmePreview,
  README_MAX_CHARACTERS,
  README_SUMMARY_PENDING,
} from '../src/utils/readme';

test('README display uses a safe fallback for empty input', () => {
  assert.equal(
    prepareReadmeForDisplay('  '),
    'No README content is available for this repository.',
  );
  assert.equal(
    prepareReadmeForDisplay('No readme available.'),
    'No README content is available for this repository.',
  );
});

test('README display bounds untrusted repository content', () => {
  const prepared = prepareReadmeForDisplay('x'.repeat(README_MAX_CHARACTERS + 100));
  assert.equal(prepared.startsWith('x'.repeat(README_MAX_CHARACTERS)), true);
  assert.equal(prepared.endsWith('[README truncated for safe display]'), true);
});

test('repository text normalization rejects legacy placeholder sentinels', () => {
  for (const placeholder of [
    'No summary available.',
    ' NO README AVAILABLE ',
    'Summary unavailable',
    'Summary is being generated',
    'N/A',
  ]) {
    assert.equal(normalizeOptionalRepositoryText(placeholder), null);
  }

  assert.equal(
    normalizeOptionalRepositoryText('  A real repository summary.  '),
    'A real repository summary.',
  );
  assert.equal(normalizeOptionalRepositoryText({ summary: 'not text' }), null);
});

test('README preview prefers a concise active summary and trims it', () => {
  assert.deepEqual(
    prepareReadmePreview({
      summary: '  **Focused summary**  ',
      description: 'Repository description',
      fullReadme: 'Full README',
    }),
    {
      isTruncated: false,
      markdown: '**Focused summary**',
      source: 'summary',
    },
  );
});

test('a substantial generated README summary stays distinct and is bounded for the card', () => {
  const generatedSummary = [
    'This project helps teams build reliable applications with a focused development workflow.',
    'It combines reusable modules, clear configuration, and practical tooling for daily work.',
    'The architecture keeps product concerns separate while preserving an approachable contributor experience.',
  ].join(' ').repeat(4);
  const prepared = prepareReadmePreview({
    summary: generatedSummary,
    description: 'A one-line repository subtitle.',
    fullReadme: '# Complete README\n\nThe complete document remains available only in the detail view.',
  });

  assert.equal(generatedSummary.length > 720, true);
  assert.equal(prepared.source, 'summary');
  assert.equal(prepared.isTruncated, true);
  assert.equal(prepared.markdown.startsWith('This project helps teams'), true);
  assert.equal(prepared.markdown.endsWith('...'), true);
  assert.equal(prepared.markdown.includes('one-line repository subtitle'), false);
  assert.equal(prepared.markdown.includes('Complete README'), false);
});

test('README preview falls back to description and never to full README', () => {
  assert.deepEqual(
    prepareReadmePreview({
      summary: ' ',
      description: '  Repository description  ',
      fullReadme: '# Complete README\n\nDo not show this on the card.',
    }),
    {
      isTruncated: false,
      markdown: 'Repository description',
      source: 'description',
    },
  );
  assert.deepEqual(
    prepareReadmePreview({
      summary: null,
      description: undefined,
      fullReadme: '# Complete README\n\nStill not a card summary.',
    }),
    {
      isTruncated: false,
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
    },
  );
});

test('legacy summary placeholders remain missing until description fallback runs', () => {
  assert.deepEqual(
    prepareReadmePreview({
      summary: 'No summary available.',
      description: 'An honest repository description.',
      fullReadme: '# README',
    }),
    {
      isTruncated: false,
      markdown: 'An honest repository description.',
      source: 'description',
    },
  );

  assert.deepEqual(
    prepareReadmePreview({
      summary: 'Summary is being generated',
      description: 'N/A',
      fullReadme: '# README',
    }),
    {
      isTruncated: false,
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
    },
  );
});

test('full README content cannot masquerade as the card summary', () => {
  const fullReadme = '# Build useful apps\n\n**Fast**, accessible, and reliable.';

  assert.deepEqual(
    prepareReadmePreview({
      summary: 'BUILD useful apps fast accessible and reliable',
      description: 'A bounded repository description.',
      fullReadme,
    }),
    {
      isTruncated: false,
      markdown: 'A bounded repository description.',
      source: 'description',
    },
  );
});

test('long README-shaped content is rejected instead of truncated as a summary', () => {
  const completeReadme = `# Complete README\n\n${'Installation, configuration, and usage details. '.repeat(30)}`;
  const prepared = prepareReadmePreview({
    summary: completeReadme,
    description: 'Concise repository description.',
    fullReadme: null,
  });

  assert.deepEqual(prepared, {
    isTruncated: false,
    markdown: 'Concise repository description.',
    source: 'description',
  });
  assert.equal(prepared.markdown.includes('Installation'), false);

  assert.deepEqual(
    prepareReadmePreview({ summary: completeReadme, fullReadme: completeReadme }),
    {
      isTruncated: false,
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
    },
  );
});

test('README preview truncates at a natural boundary and reports overflow', () => {
  const prepared = prepareReadmePreview({
    summary: 'A polished introduction with useful context. A second sentence should not be split awkwardly. Extra detail follows here.',
    maximumCharacters: 100,
  });

  assert.equal(prepared.isTruncated, true);
  assert.equal(prepared.source, 'summary');
  assert.equal(prepared.markdown.endsWith('...'), true);
  assert.equal(prepared.markdown.includes('awkwardly'), true);
  assert.equal(prepared.markdown.includes('Extra detail'), false);
});

test('README preview closes a truncated fenced code block', () => {
  const prepared = prepareReadmePreview({
    summary: `\`\`\`ts\n${'const value = example();\n'.repeat(10)}\`\`\``,
    maximumCharacters: 90,
  });
  const fences = prepared.markdown.match(/^\`\`\`/gm) ?? [];

  assert.equal(prepared.isTruncated, true);
  assert.equal(fences.length, 2);
  assert.equal(prepared.markdown.endsWith('\n\n...'), true);
});

test('README preview never leaves a dangling emoji surrogate', () => {
  const prepared = prepareReadmePreview({
    summary: `abcd\ud83d\ude80 more content`,
    maximumCharacters: 5,
  });
  const contentBeforeMarker = prepared.markdown.slice(0, -3);
  const finalCodeUnit = contentBeforeMarker.charCodeAt(contentBeforeMarker.length - 1);

  assert.equal(finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff, false);
});

test('description fallback is bounded through the same preview path', () => {
  const prepared = prepareReadmePreview({
    summary: null,
    description: 'A useful repository description. Additional context should be bounded for the card layout.',
    fullReadme: '# README that must remain separate',
    maximumCharacters: 55,
  });

  assert.equal(prepared.source, 'description');
  assert.equal(prepared.isTruncated, true);
  assert.equal(prepared.markdown.endsWith('...'), true);
  assert.equal(prepared.markdown.includes('README that must remain separate'), false);
});
