import { marked } from 'marked';
import { resolveReadmeImageUrl, type ReadmeImageContext } from './readme-images';

/** Only direct media and GitHub's video attachments, never arbitrary embedded pages. */
export function extractReadmeVideos(markdown: string | null | undefined, context: ReadmeImageContext): string[] {
  const videos = new Set<string>();
  const add = (source: string) => {
    if (videos.size >= 3) return;
    const url = resolveReadmeImageUrl(source, context);
    if (!url) return;
    const parsed = new URL(url);
    // GitHub HTML file pages are not media, but raw and release downloads
    // redirect to actual files. Keep their URLs intact, including the source ref.
    const githubDownload = parsed.hostname === 'github.com'
      && /^\/[^/]+\/[^/]+\/(?:raw\/[^/]+\/.+|releases\/download\/[^/]+\/[^/]+)$/.test(parsed.pathname);
    const direct = (parsed.hostname !== 'github.com' || githubDownload)
      && /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(parsed.pathname);
    const attachment = parsed.hostname === 'github.com'
      && /^\/user-attachments\/assets\/[a-z0-9-]+\/?$/i.test(parsed.pathname);
    if (direct || attachment) videos.add(url);
  };
  marked.walkTokens(marked.lexer((markdown ?? '').slice(0, 1_000_000)), (token) => {
    if (token.type === 'link') add(token.href);
    if (token.type === 'html') {
      for (const tag of token.raw.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').matchAll(/<(?:video|source)\b[^>]*>/gi)) {
        const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
        if (src) add(src[1] ?? src[2] ?? src[3]);
      }
    }
  });
  return [...videos];
}
