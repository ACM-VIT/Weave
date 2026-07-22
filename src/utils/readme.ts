export const README_MAX_CHARACTERS = 50_000;
export const README_PREVIEW_MAX_CHARACTERS = 720;
export const README_COMPACT_PREVIEW_MAX_CHARACTERS = 420;

const README_FALLBACK = 'No README content is available for this repository.';
const README_SUMMARY_FALLBACK = 'No summary available.';

export type PreparedReadmePreview = {
  isTruncated: boolean;
  markdown: string;
};

function normalizedContent(value?: string | null): string {
  return value?.trim() ?? '';
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

export function prepareReadmeForDisplay(readmeText?: string | null): string {
  const content = normalizedContent(readmeText) || README_FALLBACK;
  if (content.length <= README_MAX_CHARACTERS) return content;
  return truncateMarkdown(
    content,
    README_MAX_CHARACTERS,
    '[README truncated for safe display]',
  );
}

export function prepareReadmePreview(
  readmeSummary?: string | null,
  readmeFull?: string | null,
  maximumCharacters = README_PREVIEW_MAX_CHARACTERS,
): PreparedReadmePreview {
  const content =
    normalizedContent(readmeSummary) ||
    normalizedContent(readmeFull) ||
    README_SUMMARY_FALLBACK;
  const safeMaximum = Math.max(Math.floor(maximumCharacters), 1);

  if (content.length <= safeMaximum) {
    return { isTruncated: false, markdown: content };
  }

  return {
    isTruncated: true,
    markdown: truncateMarkdown(content, safeMaximum, '\u2026'),
  };
}
