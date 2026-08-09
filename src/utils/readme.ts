export const README_MAX_CHARACTERS = 50_000;
export const README_PREVIEW_MAX_CHARACTERS = 250;
export const README_COMPACT_PREVIEW_MAX_CHARACTERS = 160;
// Generated summaries may be richer than the visible card. Accept the complete
// generated field first, then bound only its presentation in the card viewport.
export const README_CARD_SUMMARY_MAX_CHARACTERS = 1_200;
export const README_SUMMARY_PENDING = 'Summary is being generated';

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
  'summary is being generated',
  'summary not available',
  'summary unavailable',
  'undefined',
]);

export type PreparedReadmePreview = {
  isTruncated: boolean;
  markdown: string;
  source: 'summary' | 'description' | 'pending';
};

export type PrepareReadmePreviewOptions = {
  summary?: string | null;
  description?: string | null;
  fullReadme?: string | null;
  maximumCharacters?: number;
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

function isUsableSummary(summary: string, fullReadme: string): boolean {
  if (!summary || summary.length > README_CARD_SUMMARY_MAX_CHARACTERS) return false;
  if (!fullReadme) return true;

  return comparableMarkdownText(summary) !== comparableMarkdownText(fullReadme);
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

function findOpenMarkdownFence(content: string): string | null {
  let openFence: string | null = null;

  for (const line of content.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;

    const fence = match[1];
    if (!openFence) {
      openFence = fence;
    } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
      openFence = null;
    }
  }

  return openFence;
}

function truncateMarkdown(
  content: string,
  maximumCharacters: number,
  marker: string,
): string {
  const end = safeSliceEnd(content, maximumCharacters);
  const preview = content.slice(0, end).trimEnd();
  const openFence = findOpenMarkdownFence(preview);
  const fenceClosure = openFence ? `\n${openFence}` : '';
  return `${preview}${fenceClosure}\n\n${marker}`;
}

function truncateCardPreview(content: string, maximumCharacters: number): string {
  const end = safeSliceEnd(content, maximumCharacters);
  const preview = content.slice(0, end).trimEnd();
  const openFence = findOpenMarkdownFence(preview);
  if (openFence) return `${preview}\n${openFence}\n\n...`;

  return `${preview.replace(/[.!?]+$/u, '')}...`;
}

export function prepareReadmeForDisplay(readmeText?: string | null): string {
  const content = normalizedContent(readmeText) || README_FALLBACK;
  if (content.length <= README_MAX_CHARACTERS) return content;
  return truncateMarkdown(
    content,
    README_MAX_CHARACTERS,
    '[README truncated for safe display]',
  );
}

export function prepareReadmePreview({
  summary,
  description,
  fullReadme,
  maximumCharacters = README_PREVIEW_MAX_CHARACTERS,
}: PrepareReadmePreviewOptions): PreparedReadmePreview {
  const normalizedSummary = normalizedContent(summary);
  const normalizedDescription = normalizedContent(description);
  const normalizedFullReadme = normalizedContent(fullReadme);
  const hasUsableSummary = isUsableSummary(
    normalizedSummary,
    normalizedFullReadme,
  );
  const source = hasUsableSummary
    ? 'summary'
    : normalizedDescription
      ? 'description'
      : 'pending';
  const content = source === 'summary'
    ? normalizedSummary
    : source === 'description'
      ? normalizedDescription
      : README_SUMMARY_PENDING;
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
