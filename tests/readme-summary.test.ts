import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { parseReadmeDigest, readmeSummaryQueryKey, readmeDigestMarkdown, resolveReadmeDigest, type ReadmeDigest } from "../src/models/readme-digest";
import { prepareReadmePreview, prepareReadmeSummaryDocument, normalizeOptionalRepositoryText, normalizeRepositoryCardSummary, prepareReadmeForDisplay, readmePreviewLineCount, README_CARD_SUMMARY_MAX_CHARACTERS, README_MAX_CHARACTERS, README_SUMMARY_PENDING } from "../src/utils/readme";
import { mapRepositoryDetail } from "../src/utils/repository-mapper";
import { readFileSync } from "node:fs";

describe("readme digest", () => {
  const digest:ReadmeDigest={
    summary_id:'00000000-0000-4000-8000-000000000001',content_version:4,content_hash:'source-v4',
    prompt_version:'readme-digest-v1',format_version:'readme-digest-json-v1',model_version:'real-provider-model',
    source:'generated',generated_at:'2026-10-21T06:00:00.000Z',
    overview:'A structured explanation of the repository purpose and how its main parts work together. '.repeat(4).trim(),
    capabilities:['Reusable task execution adapters support different processing implementations.','Shared progress events keep application state and interfaces consistent.'],
    use_cases:['Developers can coordinate visible document processing and import workflows.'],
    considerations:['Background task execution requires an available worker process.'],
  };

  test('V2 digest decoding rejects incomplete, wrong-version and malformed provider artifacts',()=>{
    assert.deepEqual(parseReadmeDigest(digest),digest);
    for(const value of [null,{...digest,source:'description_fallback'},{...digest,format_version:'old-format'},
      {...digest,capabilities:'JSON string, not an array'},{...digest,content_version:0},{...digest,generated_at:'not-a-date'}]){
      assert.equal(parseReadmeDigest(value),null);
    }
  });

  test('structured README preview is independent of the subtitle and keeps more than 360 characters for measured line clipping',()=>{
    const preview=prepareReadmePreview({digest,description:'The one-line subtitle.',fullReadme:'# The full README',maximumCharacters:20});
    assert.equal(preview.source,'summary');
    assert.ok(preview.markdown.length>360);
    assert.ok(preview.markdown.startsWith(digest.overview));
    assert.ok(!preview.markdown.includes('one-line subtitle'));
    assert.ok(!preview.markdown.includes('The full README'));
  });

  test('Read more presents the complete structured digest including caveats, without raw README substitution',()=>{
    const markdown=prepareReadmeSummaryDocument({readmeDigest:digest,readmeSummary:null,description:'Subtitle',readmeFull:'# Raw source\n'.repeat(100)});
    assert.equal(markdown,readmeDigestMarkdown(digest));
    for(const section of ['Key capabilities','Use cases','Things to know'])assert.ok(markdown?.includes(section));
    assert.ok(markdown?.includes(digest.considerations[0]));
    assert.ok(!markdown?.includes('Raw source'));
  });

  test('canonical mapping keeps a V2 digest, short summary, subtitle and raw README as distinct values',()=>{
    const mapped=mapRepositoryDetail({repo_id:'repo-1',full_name:'team/project',description:'Short subtitle.',
      summary:'A concise discovery card summary.',readme_digest:digest,readme_md:'# Full documentation'});
    assert.ok(mapped);
    assert.equal(mapped.readmeDigest?.overview,digest.overview);
    assert.equal(mapped.readmeSummary,'A concise discovery card summary.');
    assert.equal(mapped.description,'Short subtitle.');
    assert.equal(mapped.readmeFull,'# Full documentation');
  });

  test('async digest refresh preserves useful cached content and excludes a newer README version without an artifact',()=>{
    assert.equal(resolveReadmeDigest(digest,undefined),digest);
    assert.equal(resolveReadmeDigest(digest,{content_version:3,summary:null}),digest);
    assert.equal(resolveReadmeDigest(digest,{content_version:4,summary:null}),digest);
    assert.equal(resolveReadmeDigest(digest,{content_version:5,summary:null}),null);
    const refreshed={...digest,summary_id:'new-regeneration'};
    assert.equal(resolveReadmeDigest(digest,{content_version:4,summary:refreshed}),refreshed);
    const popup=prepareReadmeSummaryDocument({readmeSummary:null,readmeFull:'# Raw source',description:'Subtitle',readmeDigest:refreshed});
    assert.ok(popup?.includes(refreshed.overview));
  });

  test('a newer canonical README excludes cached old digests even before its fetch returns',()=>{
    assert.equal(resolveReadmeDigest(null,{content_version:4,summary:digest},5),null);
    assert.equal(resolveReadmeDigest(digest,undefined,5),null);
    assert.equal(resolveReadmeDigest(digest,{content_version:3,summary:null},4),digest);
    const newer={...digest,content_version:5,content_hash:'hash-v5'};
    assert.equal(resolveReadmeDigest(null,{content_version:5,summary:newer},5),newer);
  });

  test('digest query caches separate canonical content versions and accounts',()=>{
    assert.notDeepEqual(readmeSummaryQueryKey('viewer','repo',4),readmeSummaryQueryKey('viewer','repo',5));
    assert.notDeepEqual(readmeSummaryQueryKey('viewer','repo',4),readmeSummaryQueryKey('other','repo',4));
  });
});

describe("readme", () => {
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

  test('README display preserves the complete canonical document', () => {
    const canonicalReadme = `# Complete README\n\n${'x'.repeat(README_MAX_CHARACTERS + 100)}`;
    assert.equal(prepareReadmeForDisplay(canonicalReadme), canonicalReadme);
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

  test('a concise generated discovery summary stays distinct and is bounded for the card', () => {
    const generatedSummary = [
      'This project helps product teams build reliable applications with a focused development workflow.',
      'It is designed for developers who want reusable modules and clear configuration.',
      'Its strongest differentiator is keeping product concerns separate without making contribution difficult.',
    ].join(' ');
    const prepared = prepareReadmePreview({
      summary: generatedSummary,
      description: 'A one-line repository subtitle.',
      fullReadme: '# Complete README\n\nThe complete document remains available only in the detail view.',
    });

    assert.equal(generatedSummary.length >= 220, true);
    assert.equal(generatedSummary.length <= 300, true);
    assert.equal(prepared.source, 'summary');
    assert.equal(prepared.isTruncated, false);
    assert.equal(prepared.markdown.startsWith('This project helps product teams'), true);
    assert.equal(prepared.markdown.includes('one-line repository subtitle'), false);
    assert.equal(prepared.markdown.includes('Complete README'), false);
  });

  test('missing summaries never borrow the description or full README', () => {
    assert.deepEqual(
      prepareReadmePreview({
        summary: ' ',
        description: '  Repository description  ',
        fullReadme: '# Complete README\n\nDo not show this on the card.',
      }),
      {
        isTruncated: false,
        markdown: README_SUMMARY_PENDING,
        source: 'pending',
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

  test('legacy summary placeholders remain explicitly unavailable', () => {
    assert.deepEqual(
      prepareReadmePreview({
        summary: 'No summary available.',
        description: 'An honest repository description.',
        fullReadme: '# README',
      }),
      {
        isTruncated: false,
        markdown: README_SUMMARY_PENDING,
        source: 'pending',
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
        markdown: README_SUMMARY_PENDING,
        source: 'pending',
      },
    );
  });

  test('a label cannot disguise a complete or long contiguous README copy', () => {
    const fullReadme = [
      '# Project overview',
      '',
      'This repository coordinates release evidence for product teams working across mobile and backend services.',
      'It keeps test results, ownership notes, and deployment checkpoints together so reviewers can understand a change before it ships.',
    ].join('\n');
    const copiedReadme = fullReadme
      .replace(/^#\s+/m, '')
      .replace(/\n+/g, ' ');

    const prepared = prepareReadmePreview({
      summary: `Project overview: ${copiedReadme} Available on GitHub.`,
      description: 'A safe repository description.',
      fullReadme,
    });

    assert.equal(prepared.source, 'pending');
    assert.equal(prepared.markdown, README_SUMMARY_PENDING);
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
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
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

  test('summaries over the hard V2 bound are rejected before presentation', () => {
    const overLimit = 'A'.repeat(README_CARD_SUMMARY_MAX_CHARACTERS + 1);
    assert.equal(normalizeRepositoryCardSummary(overLimit), null);
    assert.deepEqual(
      prepareReadmePreview({
        summary: overLimit,
        description: 'Bounded repository description.',
      }),
      {
        isTruncated: false,
        markdown: README_SUMMARY_PENDING,
        source: 'pending',
      },
    );
  });

  test('installation commands and copied README passages are rejected as summaries', () => {
    const fullReadme = [
      '# Project',
      '',
      'This exact source passage explains the project and repeats enough words to be an unsafe card summary copied directly from the canonical document.',
    ].join('\n');

    assert.equal(
      normalizeRepositoryCardSummary('Run npm install and npm run dev to start the project.'),
      null,
    );
    assert.equal(
      normalizeRepositoryCardSummary(
        'This exact source passage explains the project and repeats enough words to be an unsafe card summary copied directly from the canonical document.',
        fullReadme,
      ),
      null,
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

  test('README-shaped fenced code is never presented as a card summary', () => {
    const prepared = prepareReadmePreview({
      summary: `\`\`\`ts\n${'const value = example();\n'.repeat(10)}\`\`\``,
      description: 'A safe description fallback.',
      maximumCharacters: 90,
    });

    assert.deepEqual(prepared, {
      isTruncated: false,
      markdown: README_SUMMARY_PENDING,
      source: 'pending',
    });
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

  test('description fallback is not presented as a README summary', () => {
    const prepared = prepareReadmePreview({
      summary: null,
      description: 'A useful repository description. Additional context should be bounded for the card layout.',
      fullReadme: '# README that must remain separate',
      maximumCharacters: 55,
    });

    assert.equal(prepared.source, 'pending');
    assert.equal(prepared.isTruncated, false);
    assert.equal(prepared.markdown, README_SUMMARY_PENDING);
    assert.equal(prepared.markdown.includes('README that must remain separate'), false);
  });

  test('a one-line description duplicated in a summary artifact is never labelled a README summary', () => {
    const description = 'Official React components and examples for building with LiveKit.';
    assert.equal(prepareReadmePreview({ summary: description, description }).source, 'pending');
    assert.equal(prepareReadmePreview({ summary: '**' + description + '**', description }).source, 'pending');
    assert.equal(prepareReadmePreview({ summary: 'Different fallback text.', summarySource: 'description_fallback' }).source, 'pending');
  });

  test('Read more receives the complete summary artifact and highlights, never the raw README', () => {
    const summary = 'Reusable media controls cover audio and video rooms. Developers can compose conferencing interfaces while retaining control of application state.';
    const repository = {
      readmeSummary: summary,
      summarySource: 'generated' as const,
      summaryHighlights: ['Composable room controls', 'Audio and video state'],
      description: 'Official React components.',
      readmeFull: '# Full README\n\nRaw installation instructions must remain separate.',
    };
    const preview = prepareReadmePreview({ summary, description: repository.description, maximumCharacters: 60 });
    assert.equal(preview.isTruncated, true);
    const document = prepareReadmeSummaryDocument(repository);
    assert.equal(document, summary + '\n\n- Composable room controls\n- Audio and video state');
    assert.equal(document.includes('installation'), false);
    assert.equal(prepareReadmeSummaryDocument({ ...repository, readmeSummary: null }), null);
    assert.equal(prepareReadmeSummaryDocument({ ...repository, summarySource: 'description_fallback' }), null);
  });

  test('summary preview adapts to measured available height and larger text while reserving two lines', () => {
    assert.equal(readmePreviewLineCount(210, 21, 1), 8);
    assert.equal(readmePreviewLineCount(105, 21, 1), 3);
    assert.equal(readmePreviewLineCount(210, 21, 2), 3);
    assert.equal(readmePreviewLineCount(0, 17, 1), 1);
    assert.equal(readmePreviewLineCount(34, 17, 1), 1);
  });

  test('card summaries and highlights preserve shared Unicode codepoint limits', () => {
    const fixtures = JSON.parse(readFileSync(new URL('../backend/tests/fixtures/summary_compatibility.json', import.meta.url), 'utf8'));
    const valid = fixtures.find((row: { name: string }) => row.name === '360 codepoints');
    const invalid = fixtures.find((row: { name: string }) => row.name === '361 codepoints');
    assert.equal(Array.from(valid.summary).length, 360);
    assert.equal(normalizeRepositoryCardSummary(valid.summary), valid.summary);
    assert.equal(normalizeRepositoryCardSummary(invalid.summary), null);
    const highlight = '🚀' + 'a'.repeat(95);
    const document = prepareReadmeSummaryDocument({ readmeSummary: valid.summary,
      description: 'One-line subtitle.', summaryHighlights: [highlight, highlight + 'a'] });
    assert.ok(document?.startsWith(valid.summary), 'The popup must preserve all 360 Unicode codepoints');
    assert.ok(document?.includes(`- ${highlight}`));
    assert.ok(!document?.includes(`- ${highlight}a`));
  });
});
