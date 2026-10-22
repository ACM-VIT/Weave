import { readmeDigestMarkdown, type ReadmeDigest } from '../models/readme-digest';
export const README_MAX_CHARACTERS = 1_000_000;
export const README_PREVIEW_MAX_CHARACTERS = 360;
export const README_CARD_SUMMARY_MAX_CHARACTERS = 360;
export const README_SUMMARY_PENDING = 'README summary unavailable';

const README_FALLBACK = 'No README content is available for this repository.';

const LEGACY_MISSING_CONTENT_SENTINELS = new Set([
  'n a',
  'no readme available',
  'no readme content available',
  'no readme content is available',
  'no readme content is available for this repository',
  'no readme is available',
  'no summary available',
  'no summary is available',
  'none',
  'not available',
  'null',
  'readme is being generated',
  'readme not available',
  'readme unavailable',
  'readme summary unavailable',
  'summary is being generated',
  'summary not available',
  'summary unavailable',
  'undefined',
]);

export type PreparedReadmePreview = {
  isTruncated: boolean;
  markdown: string;
  source: 'summary' | 'pending';
};

export type PrepareReadmePreviewOptions = {
  digest?: ReadmeDigest | null;
  summary?: string | null;
  description?: string | null;
  fullReadme?: string | null;
  maximumCharacters?: number;
  summarySource?: 'generated' | 'description_fallback' | null;
};

function sentinelKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizeOptionalRepositoryText(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const content = value.trim();
  if (!content || LEGACY_MISSING_CONTENT_SENTINELS.has(sentinelKey(content))) {
    return null;
  }
  return content;
}

function normalizedContent(value?: string | null): string {
  return normalizeOptionalRepositoryText(value) ?? '';
}

function comparableMarkdownText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function summaryLooksLikeReadme(summary: string): boolean {
  return /(?:^|\n)\s{0,3}(?:#{1,6}\s|```|~~~|(?:installation|getting started|usage|license|contributing|table of contents)\s*:?$)/im.test(summary)
    || /(?:```|~~~|\b(?:npm|pnpm|yarn|pipx?|brew|cargo)\s+(?:install|add|run)\b)/i.test(summary)
    || summary.split(/\n{2,}/).length > 1;
}

function summaryCopiesReadme(summary: string, fullReadme: string): boolean {
  if (!fullReadme) return false;
  const comparableSummary = comparableMarkdownText(summary);
  const comparableReadme = comparableMarkdownText(fullReadme);
  if (!comparableSummary || !comparableReadme) return false;
  if (comparableSummary === comparableReadme) return true;
  if (comparableSummary.length >= 80 && comparableReadme.includes(comparableSummary)) {
    return true;
  }

  // A legacy row may wrap the complete README with a label or short suffix.
  // Reject that shape even when the wrapper prevents an exact equality match.
  if (comparableReadme.length >= 40 && comparableSummary.includes(comparableReadme)) {
    return true;
  }

  // Sample overlapping 80-character windows. With a 20-character stride,
  // every copied passage of at least 99 normalized characters contains a
  // complete sampled window, while keeping comparison work bounded for a
  // canonical README that can be up to one million characters.
  const copiedWindowLength = 80;
  const copiedWindowStride = 20;
  for (
    let start = 0;
    start + copiedWindowLength <= comparableSummary.length;
    start += copiedWindowStride
  ) {
    if (comparableReadme.includes(
      comparableSummary.slice(start, start + copiedWindowLength),
    )) {
      return true;
    }
  }

  const finalWindowStart = comparableSummary.length - copiedWindowLength;
  return finalWindowStart > 0 && comparableReadme.includes(
    comparableSummary.slice(finalWindowStart),
  );
}

export function normalizeRepositoryCardSummary(
  summary: unknown,
  fullReadme?: string | null,
): string | null {
  const normalizedSummary = normalizeOptionalRepositoryText(summary);
  const normalizedFullReadme = normalizedContent(fullReadme);
  if (
    !normalizedSummary
    || Array.from(normalizedSummary).length > README_CARD_SUMMARY_MAX_CHARACTERS
    || summaryLooksLikeReadme(normalizedSummary)
    || summaryCopiesReadme(normalizedSummary, normalizedFullReadme)
  ) {
    return null;
  }
  return normalizedSummary;
}

function safeSliceEnd(content: string, maximumCharacters: number): number {
  let limit = Math.min(Math.max(Math.floor(maximumCharacters), 1), content.length);

  // Do not leave a dangling UTF-16 high surrogate when the boundary meets emoji.
  const finalCodeUnit = content.charCodeAt(limit - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) limit -= 1;

  const candidate = content.slice(0, limit);
  const minimumNaturalBoundary = Math.floor(limit * 0.55);
  const paragraphBoundary = candidate.lastIndexOf('\n\n');
  if (paragraphBoundary >= minimumNaturalBoundary) return paragraphBoundary;

  const lineBoundary = candidate.lastIndexOf('\n');
  if (lineBoundary >= minimumNaturalBoundary) return lineBoundary;

  let sentenceBoundary = -1;
  const sentencePattern = /[.!?](?:["')\]]*)\s/g;
  for (const match of candidate.matchAll(sentencePattern)) {
    sentenceBoundary = (match.index ?? 0) + match[0].trimEnd().length;
  }
  if (sentenceBoundary >= minimumNaturalBoundary) return sentenceBoundary;

  const wordBoundary = Math.max(
    candidate.lastIndexOf(' '),
    candidate.lastIndexOf('\t'),
  );
  return wordBoundary >= minimumNaturalBoundary ? wordBoundary : limit;
}

function truncateCardPreview(content: string, maximumCharacters: number): string {
  const end = safeSliceEnd(content, maximumCharacters);
  const preview = content.slice(0, end).trimEnd();
  return `${preview.replace(/[.!?]+$/u, '')}...`;
}

export function prepareReadmeForDisplay(readmeText?: string | null): string {
  return normalizedContent(readmeText) || README_FALLBACK;
}

export function prepareReadmePreview({
  digest,
  summary,
  description,
  fullReadme,
  maximumCharacters = README_PREVIEW_MAX_CHARACTERS,
  summarySource,
}: PrepareReadmePreviewOptions): PreparedReadmePreview {
  if (digest) return {
    isTruncated: false,
    markdown: [digest.overview, ...digest.capabilities.map((item) => `• ${item}`), ...digest.use_cases.map((item) => `• ${item}`)].join('\n\n'),
    source: 'summary',
  };
  const normalizedDescription = normalizedContent(description);
  const normalizedFullReadme = normalizedContent(fullReadme);
  const normalizedSummary = normalizeRepositoryCardSummary(summary, normalizedFullReadme) ?? '';
  const hasUsableSummary = Boolean(normalizedSummary)
    && summarySource !== 'description_fallback'
    && comparableMarkdownText(normalizedSummary) !== comparableMarkdownText(normalizedDescription);
  const source = hasUsableSummary ? 'summary' : 'pending';
  const content = hasUsableSummary ? normalizedSummary : README_SUMMARY_PENDING;
  if (!hasUsableSummary) return { isTruncated: false, markdown: content, source };
  const safeMaximum = Math.max(
    Math.min(Math.floor(maximumCharacters), README_PREVIEW_MAX_CHARACTERS),
    1,
  );

  if (content.length <= safeMaximum) {
    return { isTruncated: false, markdown: content, source };
  }

  return {
    isTruncated: true,
    markdown: truncateCardPreview(content, safeMaximum),
    source,
  };
}

/** The feed preview and its popup always read the same summary artifact. */
export function prepareReadmeSummaryDocument(repository: {
  readmeSummary: string | null;
  readmeDigest?: ReadmeDigest | null;
  readmeFull: string | null;
  description: string;
  summarySource?: 'generated' | 'description_fallback' | null;
  summaryHighlights?: string[];
}): string | null {
  if (repository.readmeDigest) return readmeDigestMarkdown(repository.readmeDigest);
  const preview = prepareReadmePreview({
    summary: repository.readmeSummary,
    description: repository.description,
    fullReadme: repository.readmeFull,
    summarySource: repository.summarySource,
  });
  if (preview.source !== 'summary') return null;
  const highlights = (repository.summaryHighlights ?? [])
    .map(normalizeOptionalRepositoryText)
    .filter((item): item is string => item !== null && Array.from(item).length <= 96)
    .slice(0, 3);
  return [normalizeRepositoryCardSummary(repository.readmeSummary, repository.readmeFull), highlights.map((item) => `- ${item}`).join('\n')]
    .filter(Boolean).join('\n\n');
}

/** Reserve two text lines before the action, using the actual laid-out space. */
export function readmePreviewLineCount(viewportHeight: number, lineHeight: number, fontScale: number): number {
  return Math.max(1, Math.floor(viewportHeight / (lineHeight * Math.max(fontScale, 1))) - 2);
}
