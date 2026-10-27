import { marked } from 'marked';
import { scanReadmeHtmlMediaCandidates } from '../../backend/contracts/readmeMedia.v2';
import { resolveReadmeImageUrl, type ReadmeImageContext } from './readme-images';

/** Resolve only the direct video files and GitHub attachments used by README previews. */
export function resolveReadmeVideoUrl(source: string | null | undefined, context: ReadmeImageContext): string | null {
  const url = resolveReadmeImageUrl(source, context);
  if (!url) return null;
  const parsed = new URL(url);
  const githubDownload = parsed.hostname === 'github.com'
    && /^\/[^/]+\/[^/]+\/(?:raw\/[^/]+\/.+|releases\/download\/[^/]+\/[^/]+)$/.test(parsed.pathname);
  const direct = (parsed.hostname !== 'github.com' || githubDownload)
    && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(parsed.pathname);
  const attachment = parsed.hostname === 'github.com'
    && /^\/user-attachments\/assets\/[a-z0-9-]+\/?$/i.test(parsed.pathname);
  return direct || attachment ? url : null;
}

/** Only direct media and GitHub's video attachments, never arbitrary embedded pages. */
export function extractReadmeVideos(markdown: string | null | undefined, context: ReadmeImageContext): string[] {
  const videos = new Set<string>();
  const add = (source: string) => {
    if (videos.size >= 3) return;
    const url = resolveReadmeVideoUrl(source, context);
    if (!url) return;
    videos.add(url);
  };
  marked.walkTokens(marked.lexer((markdown ?? '').slice(0, 1_000_000)), (token) => {
    if (token.type === 'link') add(token.href);
    if (token.type === 'html') for (const candidate of scanReadmeHtmlMediaCandidates(token.raw)) {
      if (candidate.kind === 'video') add(candidate.source);
    }
  });
  return [...videos];
}
